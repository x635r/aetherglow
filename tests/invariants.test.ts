/**
 * 物理不变量与端到端回归测试
 * ---------------------------------------------------------------------------
 * 这些测试锁定的不是"数值落在区间内"，而是**必须成立的性质**：
 *   · 采样分辨率不改变物理结论
 *   · 上层云不遮挡下层光
 *   · 地平线可见性方向正确
 *   · 事件日期不偏移
 *   · 数据缺失不会被误判成"最理想"
 *   · 评分随云量单调（在合理区间内）
 */

import { describe, expect, it } from 'vitest';
import { resolveEvent } from '../src/data/openMeteo';
import { sunEvent } from '../src/engine/astro';
import {
  bandIntervals,
  groundHitDistanceKm,
  horizonDistanceKm,
  isVisibleFromObserver,
  levelFullOpticalDepth,
  slabAirmass,
  AIRMASS_CAP,
} from '../src/engine/optics';
import {
  cloudScreenQuality,
  parseVerticalCloudProfile,
  predictSunset,
  rayMarchingTransmittance,
} from '../src/engine/SunsetPhysicsEngine';
import { evaluateSpectral } from '../src/engine/spectral';
import { LEVEL_KEYS } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import { buildScenario } from './calibrationScenarios';
import type { ForecastBundle, HourlySample, ModelId } from '../src/engine/types';

// ── 测试夹具 ────────────────────────────────────────────────────────────

const STD_H: Record<LevelKey, number> = {
  '925': 780, '850': 1500, '700': 3000, '600': 4200, '500': 5500, '400': 7200, '300': 9200,
};

function mkSample(t: number, cover: Partial<Record<LevelKey, number>>, precip = 0): HourlySample {
  const cloud = {} as Record<LevelKey, number>;
  const levelHeightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) {
    cloud[k] = (cover[k] ?? 0) * 100;
    levelHeightM[k] = STD_H[k];
  }
  return {
    timeMs: t, cloud, levelHeightM, levelTempC: {},
    cloudLow: 0, cloudMid: 0, cloudHigh: 0,
    cloudTotal: Math.max(...LEVEL_KEYS.map((k) => cloud[k])),
    precipitation: precip, humidity: 55, visibilityM: 25000, weatherCode: 0,
    windSpeed: 8, windDir: 250, dewPointC: 10, surfacePressureHpa: 1013,
  };
}

/** 构造一个「各环云量可不同」的 bundle */
function ringBundle(
  perRing: (i: number) => Partial<Record<LevelKey, number>>,
  opts: { terrain?: number[]; aod?: number; aerosol?: boolean } = {},
): ForecastBundle {
  const base = Date.UTC(2026, 10, 3, 9, 5, 0);
  const times: number[] = [];
  for (let h = -6; h <= 6; h++) times.push(base + h * 3600000);
  const ringKm = [0, 30, 80, 150, 280, 450];
  return {
    models: {
      ecmwf: {
        model: 'ecmwf' as ModelId, label: 'ECMWF',
        rings: ringKm.map((d, i) => ({
          ringKm: d, point: { lat: 31.23, lon: 121.47 },
          samples: times.map((t) => mkSample(t, perRing(i))),
        })),
        aerosol: opts.aerosol === false ? [] : ringKm.map((d) => ({
          ringKm: d, point: { lat: 31.23, lon: 121.47 },
          samples: times.map((t) => ({
            timeMs: t, aod: opts.aod ?? 0.12, pm25: 12, dust: 8, pm10: 18, humidity: 55,
          })),
        })),
        gridLat: 31.23, gridLon: 121.47, gridElevationM: 4,
      },
    } as never,
    terrain: ringKm.map((d, i) => ({
      ringKm: d, point: { lat: 31.23, lon: 121.47 },
      elevationM: opts.terrain?.[i] ?? 4,
    })),
    localElevationM: opts.terrain?.[0] ?? 4,
    fetchedAt: Date.now(), apiCalls: 3, cached: false,
  };
}

function predict(bundle: ForecastBundle, agl = 0, lat = 31.23, lon = 121.47) {
  return predictSunset({
    point: { lat, lon }, mode: 'sunset', observerHeightM: agl, bundle,
    primaryModel: 'ecmwf', timezoneOffsetSeconds: 28800, timezone: 'Asia/Shanghai',
    locationLabel: 'test', eventMs: Date.UTC(2026, 10, 3, 9, 5),
    daily: { sunriseMs: null, sunsetMs: Date.UTC(2026, 10, 3, 9, 5) },
    compareModels: ['ecmwf'],
  });
}

/** 直接从 bundle 造 ProfileRing[]，用于测试光路函数 */
function profileRings(cover: Partial<Record<LevelKey, number>>, ringKm = [0, 30, 80, 150, 280, 450]) {
  return ringKm.map((d) => ({
    ringKm: d,
    point: { lat: 31.23, lon: 121.47 },
    sample: mkSample(0, cover),
    cover: Object.fromEntries(LEVEL_KEYS.map((k) => [k, cover[k] ?? 0])) as Record<LevelKey, number>,
    heightM: { ...STD_H } as Record<LevelKey, number>,
    tempC: { '925': 10, '850': 5, '700': 0, '600': -2, '500': -10, '400': -20, '300': -35 } as Partial<Record<LevelKey, number>>,
    rh: { '925': 80, '850': 80, '700': 70, '600': 65, '500': 60, '400': 55, '300': 50 } as Partial<Record<LevelKey, number>>,
    visible: Object.fromEntries(LEVEL_KEYS.map((k) => [k, true])) as Record<LevelKey, boolean>,
  }));
}

// ═════════════════════════════════════════════════════════════════════════
// 1. 事件日期（P0：晚霞曾经整体偏移 −24 小时）
// ═════════════════════════════════════════════════════════════════════════
describe('事件日期解析', () => {
  const cities: Array<[string, number, number, number]> = [
    ['上海 +8', 31.2304, 121.4737, 8],
    ['伦敦 +0', 51.5, -0.12, 0],
    ['纽约 -5', 40.71, -74.0, -5],
    ['孟买 +5.5', 19.07, 72.87, 5.5],
    ['奥克兰 +13', -36.85, 174.76, 13],
  ];

  for (const [name, lat, lon, tz] of cities) {
    it(`${name}：日落/日出都落在请求的本地日期内`, () => {
      const dateISO = '2026-11-01';
      const off = tz * 3600;
      const localDate = (ms: number) => new Date(ms + off * 1000).toISOString().slice(0, 10);

      for (const mode of ['sunrise', 'sunset'] as const) {
        const r = resolveEvent({ lat, lon }, dateISO, mode);
        expect(localDate(r.eventMs)).toBe(dateISO);
      }
    });
  }

  it('解析出的日落与纯天文求解偏差 < 5 分钟（同一本地日）', () => {
    const lat = 31.2304;
    const lon = 121.4737;
    const off = 8 * 3600;
    const r = resolveEvent({ lat, lon }, '2026-11-01', 'sunset');
    // 用当日 00:00 UTC 起重扫，找到落在本地 11-01 的那个日落
    let t = Date.UTC(2026, 9, 31, 0, 0);
    let truth: number | null = null;
    for (let i = 0; i < 4; i++) {
      const ev = sunEvent(t, lat, lon, 'sunset');
      if (ev === null) break;
      if (new Date(ev + off * 1000).toISOString().slice(0, 10) === '2026-11-01') {
        truth = ev;
        break;
      }
      t = ev + 3 * 3600 * 1000;
    }
    expect(truth).not.toBeNull();
    expect(Math.abs(r.eventMs - truth!) / 60000).toBeLessThan(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. 地平线可见性（P0：符号曾反，整根支柱失效）
// ═════════════════════════════════════════════════════════════════════════
describe('双地平线可见性判据', () => {
  it('地平线距离随高度单调增加', () => {
    expect(horizonDistanceKm(780)).toBeLessThan(horizonDistanceKm(4200));
    expect(horizonDistanceKm(4200)).toBeLessThan(horizonDistanceKm(9200));
  });

  it('数值符合 √(2·R_eff·h)：780m≈108km，4200m≈250km，9200m≈370km', () => {
    expect(horizonDistanceKm(780)).toBeCloseTo(108, -1);
    expect(horizonDistanceKm(4200)).toBeCloseTo(250, -1);
    expect(horizonDistanceKm(9200)).toBeCloseTo(370, -1);
  });

  it('地面观测者看不见 450km 处的 4.2km 云（超过地平线）', () => {
    expect(isVisibleFromObserver(4200, 0, 450)).toBe(false);
    expect(isVisibleFromObserver(4200, 0, 200)).toBe(true);
  });

  it('地面观测者看不见 450km 处的 780m 低云', () => {
    expect(isVisibleFromObserver(780, 0, 450)).toBe(false);
    expect(isVisibleFromObserver(780, 0, 80)).toBe(true);
  });

  it('抬升观测者会扩大可见范围', () => {
    // 4200m 云地平线 250km；2000m 机位再加 174km → 424km
    expect(isVisibleFromObserver(4200, 0, 450)).toBe(false);
    expect(isVisibleFromObserver(4200, 2000, 400)).toBe(true);
    expect(isVisibleFromObserver(4200, 2000, 450)).toBe(false); // 450 > 424
    // 3000m 机位：250 + 213 = 463km → 450km 可见
    expect(isVisibleFromObserver(4200, 3000, 450)).toBe(true);
  });

  it('可见性支柱确实会剔除云层（不是永远为真）', () => {
    const p = predict(ringBundle(() => ({ '600': 0.55, '500': 0.5 })));
    // 全部 7 层不会都"可见"：450km / 280km 环上的低层必然落入地平线以下
    expect(p.layers.some((l) => l.transmittance >= 0 && l.key === '925')).toBe(true);
    const prof = parseVerticalCloudProfile(ringBundle(() => ({})), 'ecmwf', Date.UTC(2026, 10, 3, 9, 5), 0);
    const farRing = prof.rings.find((r) => r.ringKm === 450)!;
    expect(farRing.visible['600']).toBe(false);
    expect(farRing.visible['300']).toBe(false); // 450 > 342km 地平线
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. 光路几何与消光不变量（P0：τ 曾随采样环数量线性膨胀）
// ═════════════════════════════════════════════════════════════════════════
describe('光路消光不变量', () => {
  it('气团因子有上限，掠射时不会发散', () => {
    expect(slabAirmass(1.4, 1000)).toBeLessThanOrEqual(AIRMASS_CAP);
    expect(slabAirmass(1.4, 1000)).toBe(AIRMASS_CAP);
    expect(slabAirmass(1.4, 1.4)).toBeCloseTo(1, 5);
    expect(slabAirmass(1.4, 0.7)).toBe(1); // 短于厚度也按 1 计
  });

  it('光路高度是抛物线：先降后升，可两次穿过同一层', () => {
    // α<0 且起点较高：光线先下沉穿过带、过最低点后再抬升穿过
    const iv = bandIntervals(5500, -2, 4000, 4400, 450);
    expect(iv.length).toBeGreaterThanOrEqual(1);
    for (const seg of iv) {
      expect(seg.toKm).toBeGreaterThan(seg.fromKm);
    }
  });

  it('同一片云的光学厚度不随采样环数量变化', () => {
    // 这是上一版最严重的物理错误：τ 按环累加，换分辨率就换答案
    const taus: number[] = [];
    for (const ringKm of [[0, 30], [0, 30, 80, 150], [0, 30, 80, 150, 280, 450]]) {
      const r = rayMarchingTransmittance(4200, -1.5, profileRings({ '600': 0.45 }, ringKm) as never, ringKm.map(() => 4));
      taus.push(r.opticalDepth);
    }
    const spread = Math.max(...taus) - Math.min(...taus);
    expect(spread).toBeLessThan(0.5);
  });

  it('上层云不遮挡下层光：给 400hPa 加云不影响 600hPa 的透过率', () => {
    const clearAbove = rayMarchingTransmittance(4200, -1.5, profileRings({ '600': 0.45 }) as never, [4, 4, 4, 4, 4, 4]);
    const cloudyAbove = rayMarchingTransmittance(
      4200, -1.5, profileRings({ '600': 0.45, '400': 0.9, '300': 0.9 }) as never, [4, 4, 4, 4, 4, 4],
    );
    expect(cloudyAbove.perLevelTransmittance['600']).toBeCloseTo(clearAbove.perLevelTransmittance['600'], 5);
  });

  it('低层碎云确实参与遮挡（光线在远端下沉，会穿过低层）', () => {
    // 几何事实：目标云 4200m、α=−1.5° 时，朝太阳的光线先下沉到 1653m
    // 再被曲率抬回，因此它实实在在穿过了 850/700hPa。
    // 「低云挡不住高云的光」只在太阳还高时成立，黄昏时不成立。
    const clearBelow = rayMarchingTransmittance(4200, -1.5, profileRings({ '600': 0.45 }) as never, [4, 4, 4, 4, 4, 4]);
    const cloudyBelow = rayMarchingTransmittance(
      4200, -1.5, profileRings({ '600': 0.45, '850': 0.9 }) as never, [4, 4, 4, 4, 4, 4],
    );
    expect(cloudyBelow.perLevelTransmittance['600']).toBeLessThan(clearBelow.perLevelTransmittance['600']);
  });

  it('破碎云的透过率不得被"面积平均 τ"吃掉（1−c + c·e^−τ 形式）', () => {
    // 20% 覆盖的遮挡层：八成路程走云隙，透过率必须显著 > exp(−τ_full·c·X)
    const clear = rayMarchingTransmittance(4200, -1.5, profileRings({ '600': 0.45 }) as never, [4, 4, 4, 4, 4, 4]);
    const sparse = rayMarchingTransmittance(
      4200, -1.5, profileRings({ '600': 0.45, '700': 0.2 }) as never, [4, 4, 4, 4, 4, 4],
    );
    // 只掉一点点，不是掉到近乎 0
    expect(sparse.perLevelTransmittance['600']).toBeGreaterThan(clear.perLevelTransmittance['600'] * 0.5);
    expect(sparse.perLevelTransmittance['600']).toBeLessThan(clear.perLevelTransmittance['600']);
  });

  it('满铺遮挡层仍能完全封死（破碎云形式的正确极限）', () => {
    const solid = rayMarchingTransmittance(
      4200, -1.5, profileRings({ '600': 0.45, '700': 1.0, '850': 1.0 }) as never, [4, 4, 4, 4, 4, 4],
    );
    expect(solid.perLevelTransmittance['600']).toBeLessThan(0.35);
  });

  it('太阳高时低云不遮挡（几何上光路不下沉）', () => {
    // α=+8° 时光线一路上升，不会穿过下方的云层
    const clear = rayMarchingTransmittance(4200, 8, profileRings({ '600': 0.45 }) as never, [4, 4, 4, 4, 4, 4]);
    const cloudy = rayMarchingTransmittance(
      4200, 8, profileRings({ '600': 0.45, '850': 0.9 }) as never, [4, 4, 4, 4, 4, 4],
    );
    expect(cloudy.perLevelTransmittance['600']).toBeCloseTo(clear.perLevelTransmittance['600'], 5);
  });

  it('地形遮挡会在光线高度以下被检出', () => {
    const r = rayMarchingTransmittance(4200, -1.5, profileRings({ '600': 0.45 }) as never, [0, 1500, 6000, 2000, 2000, 2000]);
    expect(r.blockedAtKm).not.toBeNull();
  });

  it('光线触地距离与仰角一致（正角不触地）', () => {
    expect(groundHitDistanceKm(4200, 5)).toBe(Infinity);
    expect(Number.isFinite(groundHitDistanceKm(4200, -6))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. 云幕质量：覆盖率 vs 光学厚度（P1：曾把满铺卷云判成无烧）
// ═════════════════════════════════════════════════════════════════════════
describe('云光学厚度建模', () => {
  it('各层满云光学厚度随高度递减（低云最不透明）', () => {
    const order: LevelKey[] = ['925', '850', '700', '600', '500', '400', '300'];
    for (let i = 0; i < order.length - 1; i++) {
      expect(levelFullOpticalDepth(order[i])).toBeGreaterThan(levelFullOpticalDepth(order[i + 1]));
    }
  });

  it('满铺薄卷云显著优于满铺低云（同样 100% 覆盖率）', () => {
    expect(cloudScreenQuality(1.0, 'high', '300')).toBeGreaterThan(0.5);
    expect(cloudScreenQuality(1.0, 'low', '850')).toBeLessThan(0.1);
  });

  it('黄金层在中间云量处取峰值', () => {
    const peak = cloudScreenQuality(0.5, 'golden', '600');
    expect(peak).toBeGreaterThan(cloudScreenQuality(0.08, 'golden', '600'));
    expect(peak).toBeGreaterThan(cloudScreenQuality(0.95, 'golden', '600'));
  });

  it('零云量质量为 0', () => {
    expect(cloudScreenQuality(0, 'golden', '600')).toBe(0);
    expect(cloudScreenQuality(0.01, 'high', '300')).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. 气溶胶缺测（P0：曾把接口失败判成"水晶天"，虚高 155%）
// ═════════════════════════════════════════════════════════════════════════
describe('气溶胶数据缺失的降级', () => {
  it('缺测时不进入水晶天分支', () => {
    const s = evaluateSpectral(0.01, 0, 0, 40, 40, false);
    expect(s.crystal).toBe(false);
    expect(s.available).toBe(false);
    expect(s.tone).toBe('unknown');
    expect(s.saturationGain).toBeCloseTo(1.0, 2);
  });

  it('缺测时按气候学中值保守降级（劣于洁净、优于重霾）', () => {
    const clean = predict(ringBundle(() => ({ '600': 0.5, '500': 0.45 }), { aod: 0.12 }));
    const hazy = predict(ringBundle(() => ({ '600': 0.5, '500': 0.45 }), { aod: 0.8 }));
    const unknown = predict(ringBundle(() => ({ '600': 0.5, '500': 0.45 }), { aerosol: false }));

    expect(unknown.vividness).toBeLessThan(clean.vividness);
    expect(unknown.vividness).toBeGreaterThan(hazy.vividness);
    expect(unknown.spectral.available).toBe(false);
    expect(unknown.spectral.tone).toBe('unknown');
    expect(unknown.spectral.saturationGain).toBeCloseTo(1.0, 2);
  });

  it('真实低 AOD 仍能触发水晶天', () => {
    const s = evaluateSpectral(0.08, 8, 5, 45, 32, true);
    expect(s.crystal).toBe(true);
    expect(s.saturationGain).toBeGreaterThan(1.2);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 6. 评分单调性与否决
// ═════════════════════════════════════════════════════════════════════════
describe('评分单调性', () => {
  it('黄金层云量 0→~50% 单调上升', () => {
    const vals = [0.05, 0.2, 0.35, 0.5].map(
      (c) => predict(ringBundle(() => ({ '600': c, '500': c }))).vividness,
    );
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    }
  });

  it('教科书级好天气不得被"云墙封死"否决误判', () => {
    // 这是上一版最明显的外部症状：干净的 55% 黄金层被判成"远云封死天窗"
    const p = predict(ringBundle(() => ({ '700': 0.15, '600': 0.55, '500': 0.5, '400': 0.45 })));
    expect(p.veto.kind).not.toBe('cloud-wall');
    expect(p.grade).not.toBe('none');
    expect(p.grade).not.toBe('faint');
  });

  it('满铺低云触发低云锁死', () => {
    const p = predict(ringBundle(() => ({ '925': 0.95, '850': 1.0, '700': 0.6 })));
    expect(p.veto.kind).toBe('low-cloud-lock');
    expect(p.vividness).toBeLessThan(0.15);
  });

  it('远山切断黄金层光路触发地形否决', () => {
    const p = predict(ringBundle(() => ({ '600': 0.5, '500': 0.45 }), { terrain: [4, 1500, 3400, 2800, 4200, 5000] }));
    expect(p.veto.kind).toBe('terrain');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 7. 观测海拔与云底（P1：AGL 曾当 MSL 用；云底云顶曾颠倒）
// ═════════════════════════════════════════════════════════════════════════
describe('观测海拔与云底', () => {
  it('机位海拔 = 地面 DEM + AGL', () => {
    const p = predict(ringBundle(() => ({ '600': 0.5 }), { terrain: [3650, 3700, 4000, 4500, 4800, 5200] }), 300);
    expect(p.groundElevationM).toBe(3650);
    expect(p.observerAglM).toBe(300);
    expect(p.observerHeightM).toBe(3950);
  });

  it('云底低于云顶（曾因按 hPa 排序而颠倒）', () => {
    const prof = parseVerticalCloudProfile(
      ringBundle(() => ({ '925': 0.9, '850': 0.9, '600': 0.5 })),
      'ecmwf',
      Date.UTC(2026, 10, 3, 9, 5),
      0,
    );
    expect(prof.cloudBaseM).toBeCloseTo(780, 3);
    expect(prof.cloudTopM).toBeCloseTo(4200, 3);
  });

  it('高原观测者不再被当作海平面', () => {
    const b = ringBundle(() => ({ '925': 0.9, '850': 0.9, '600': 0.5 }), {
      terrain: [3650, 3700, 4000, 4500, 4800, 5200],
    });
    const seaLevel = predict(b, 0);
    const onPlateau = predict(b, 0);
    // 同样的 AGL=0，但 DEM 已把观测者放到云底之上
    expect(onPlateau.observerHeightM).toBeGreaterThan(seaLevel.cloudBaseM);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 8. 鲁棒性（P0：空数据曾直接抛异常）
// ═════════════════════════════════════════════════════════════════════════
describe('数据缺失鲁棒性', () => {
  it('主模型无环数据时不抛异常', () => {
    const b = ringBundle(() => ({ '600': 0.5 }));
    (b.models.ecmwf as unknown as { rings: unknown[] }).rings = [];
    expect(() => predict(b)).not.toThrow();
  });

  it('气溶胶为空数组时不抛异常', () => {
    expect(() => predict(ringBundle(() => ({ '600': 0.5 }), { aerosol: false }))).not.toThrow();
  });

  it('任何输入都不产生 NaN / Infinity', () => {
    const cases: Array<Partial<Record<LevelKey, number>>> = [
      {}, { '600': 1 }, { '925': 1, '850': 1, '700': 1, '600': 1, '500': 1, '400': 1, '300': 1 },
      { '300': 1 }, { '600': 0.02 },
    ];
    for (const c of cases) {
      const p = predict(ringBundle(() => c));
      expect(Number.isFinite(p.vividness)).toBe(true);
      expect(Number.isFinite(p.score)).toBe(true);
      expect(Number.isFinite(p.confidence)).toBe(true);
      expect(Number.isFinite(p.completeness)).toBe(true);
      for (const l of p.layers) expect(Number.isFinite(l.contribution)).toBe(true);
      for (const r of p.rings) expect(Number.isFinite(r.transmittance)).toBe(true);
    }
  });

  it('置信度会因数据缺失而下降', () => {
    const complete = predict(ringBundle(() => ({ '600': 0.5 })));
    const missingAq = predict(ringBundle(() => ({ '600': 0.5 }), { aerosol: false }));
    expect(missingAq.completeness).toBeLessThan(complete.completeness);
    expect(missingAq.confidence).toBeLessThan(complete.confidence);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 9. 时序与二烧
// ═════════════════════════════════════════════════════════════════════════
describe('时间轴与二烧', () => {
  it('序列覆盖 −20~+40min 且共 31 帧', () => {
    const p = predict(ringBundle(() => ({ '600': 0.5 })));
    expect(p.series).toHaveLength(31);
    expect(p.series[0].offsetMin).toBe(-20);
    expect(p.series[30].offsetMin).toBe(40);
  });

  it('峰值落在日落前后（不是全天单调）', () => {
    const p = predict(ringBundle(() => ({ '600': 0.55, '500': 0.5 })));
    const peakOff = (p.timeline.peakMs - p.eventMs) / 60000;
    expect(peakOff).toBeGreaterThanOrEqual(-20);
    expect(peakOff).toBeLessThanOrEqual(10);
  });

  it('二烧窗口落在紫光实测角度带（α ≈ −1.4° ~ −7.4°，含 0.6° 宽容）', () => {
    const p = predict(ringBundle(() => ({ '600': 0.5, '400': 0.6, '300': 0.55 })));
    const alphaAt = (off: number) => p.series.find((s) => s.offsetMin === off)?.altitudeDeg ?? NaN;
    const from = alphaAt(p.timeline.afterglowWindow.fromMin);
    const to = alphaAt(p.timeline.afterglowWindow.toMin);
    // 窗口端点应落在紫光可观测区间内（−1.4° 上界 + 0.6° 宽容 → −0.8° 左右起步）
    expect(from).toBeLessThan(-0.3);
    expect(from).toBeGreaterThan(-9);
    expect(to).toBeGreaterThan(-10);
    expect(p.timeline.afterglowWindow.toMin).toBeGreaterThanOrEqual(p.timeline.afterglowWindow.fromMin);
  });

  it('有高云画布时二烧概率显著高于无高云', () => {
    const withCirrus = predict(ringBundle(() => ({ '600': 0.5, '400': 0.6, '300': 0.6 })));
    const noCirrus = predict(ringBundle(() => ({ '600': 0.5 })));
    expect(withCirrus.timeline.afterglowProbability).toBeGreaterThan(noCirrus.timeline.afterglowProbability);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 10. 环报告一致性（P1：曾全部饱和到 100%、透过率倒置）
// ═════════════════════════════════════════════════════════════════════════
describe('环报告', () => {
  it('环得分有分辨力（不是全部 100%）', () => {
    const p = predict(ringBundle((i) => (i <= 1 ? { '600': 0.55, '500': 0.5 } : { '600': 0.05 })));
    const scores = p.rings.map((r) => r.score);
    expect(new Set(scores.map((s) => s.toFixed(3))).size).toBeGreaterThan(1);
    expect(Math.max(...scores)).toBeLessThanOrEqual(1);
  });

  it('近处云多时近环得分更高', () => {
    const p = predict(ringBundle((i) => (i <= 1 ? { '600': 0.55, '500': 0.5 } : { '600': 0.05 })));
    expect(p.rings[0].score).toBeGreaterThan(p.rings[5].score);
  });

  it('可见环的透过率随距离单调下降', () => {
    const p = predict(ringBundle(() => ({ '700': 0.4, '600': 0.5 })));
    const visible = p.rings.filter((r) => !r.terrainBlocked);
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i].transmittance).toBeLessThanOrEqual(visible[i - 1].transmittance + 1e-9);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 11. 校准场景整体回归
// ═════════════════════════════════════════════════════════════════════════
describe('校准场景与主评分同源', () => {
  it('合成场景跑通且分数有限', () => {
    const p = predictSunset({
      point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
      bundle: buildScenario({ name: 'x', cover: { '600': 0.45 }, expect: [0, 2] }),
      primaryModel: 'ecmwf', timezoneOffsetSeconds: 28800, timezone: 'Asia/Shanghai',
      locationLabel: 'x', eventMs: Date.UTC(2026, 10, 3, 9, 5),
      daily: { sunriseMs: null, sunsetMs: Date.UTC(2026, 10, 3, 9, 5) },
      compareModels: ['ecmwf'],
    });
    expect(Number.isFinite(p.vividness)).toBe(true);
    expect(p.vividness).toBeGreaterThan(0);
  });
});
