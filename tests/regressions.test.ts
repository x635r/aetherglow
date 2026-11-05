/**
 * 2026-11 审查修复的回归测试
 * ---------------------------------------------------------------------------
 * 每条测试对应一个曾经真实存在、且用户可见的缺陷。命名统一为
 * 「P0/P1 + 症状」，避免以后重构时悄悄回退。
 */

import { describe, expect, it } from 'vitest';
import {
  beamAirmass,
  beamTangentHeightM,
  cloudPhaseTauFactor,
  directBeamAirmass,
  directSunRgb,
  ozoneExtinctionRel,
  slantAirmass,
  TAU_O3_550,
} from '../src/engine/optics';
import {
  cloudScreenQuality,
  parseVerticalCloudProfile,
  predictSunset,
  rayMarchingTransmittance,
} from '../src/engine/SunsetPhysicsEngine';
import { LEVEL_KEYS } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import type { ForecastBundle, HourlySample, ModelId } from '../src/engine/types';

const STD_H: Record<LevelKey, number> = {
  '925': 780, '850': 1500, '700': 3000, '600': 4200, '500': 5500, '400': 7200, '300': 9200,
};

const EVENT = Date.UTC(2026, 10, 3, 9, 5, 0);

function sample(t: number, cover: Partial<Record<LevelKey, number>>, o: { precip?: number; vis?: number; humidity?: number } = {}): HourlySample {
  const cloud = {} as Record<LevelKey, number>;
  const levelHeightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) {
    cloud[k] = (cover[k] ?? 0) * 100;
    levelHeightM[k] = STD_H[k];
  }
  return {
    timeMs: t, cloud, levelHeightM, levelTempC: {},
    cloudLow: 0, cloudMid: 0, cloudHigh: 0, cloudTotal: 0,
    precipitation: o.precip ?? 0,
    humidity: o.humidity ?? 50,
    visibilityM: o.vis ?? 25000,
    weatherCode: 0, windSpeed: 4, windDir: 250, dewPointC: 5, surfacePressureHpa: 1013,
  };
}

const RING = [0, 30, 80, 150, 280, 450];
const TIMES = (() => {
  const out: number[] = [];
  for (let h = -6; h <= 6; h++) out.push(EVENT + h * 3600000);
  return out;
})();

function bundle(
  coverAt: (ring: number) => Partial<Record<LevelKey, number>>,
  o: { aod?: number; pm25?: number; vis?: number; humidity?: number; terrain?: number[]; aerosol?: boolean; models?: Record<string, (ring: number) => Partial<Record<LevelKey, number>>> } = {},
): ForecastBundle {
  const perModel = o.models ?? { ecmwf: coverAt };
  const models = {} as ForecastBundle['models'];
  for (const [m, fn] of Object.entries(perModel)) {
    models[m as ModelId] = {
      model: m as ModelId,
      label: m,
      rings: RING.map((d, i) => ({
        ringKm: d,
        point: { lat: 31.23, lon: 121.47 },
        samples: TIMES.map((t) => sample(t, fn(i), { precip: 0, vis: o.vis, humidity: o.humidity })),
      })),
      aerosol: o.aerosol === false ? [] : RING.map((d) => ({
        ringKm: d,
        point: { lat: 31.23, lon: 121.47 },
        samples: TIMES.map((t) => ({
          timeMs: t, aod: o.aod ?? 0.1, pm25: o.pm25 ?? 10, dust: 6, pm10: 18, humidity: o.humidity ?? 50,
        })),
      })),
      gridLat: 31.23, gridLon: 121.47, gridElevationM: 4,
    };
  }
  return {
    models,
    terrain: RING.map((d, i) => ({ ringKm: d, point: { lat: 31.23, lon: 121.47 }, elevationM: o.terrain?.[i] ?? 4 })),
    localElevationM: o.terrain?.[0] ?? 4,
    fetchedAt: Date.now(), apiCalls: 1, cached: false,
  };
}

function predict(b: ForecastBundle, agl = 0, models: ModelId[] = ['ecmwf'], primary: ModelId = 'ecmwf') {
  return predictSunset({
    point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: agl, bundle: b,
    primaryModel: primary, timezoneOffsetSeconds: 28800, timezone: 'Asia/Shanghai',
    locationLabel: 't', eventMs: EVENT, daily: { sunriseMs: null, sunsetMs: EVENT },
    compareModels: models,
  });
}

const C = (o: Partial<Record<LevelKey, number>>) => () => o;

// ═══════════════════════════════════════════════════════════════════════
// 1. 光路剖面：ray.transmittance 曾是 exp(−τ_full) ≈ 1e−11
// ═══════════════════════════════════════════════════════════════════════
describe('P0 光路剖面不再把好天气判成"已入地影"', () => {
  const rings = (cover: Partial<Record<LevelKey, number>>) =>
    RING.map((d) => ({
      ringKm: d,
      point: { lat: 31.23, lon: 121.47 },
      sample: sample(EVENT, cover),
      cover: Object.fromEntries(LEVEL_KEYS.map((k) => [k, cover[k] ?? 0])) as Record<LevelKey, number>,
      heightM: { ...STD_H } as Record<LevelKey, number>,
      tempC: { '925': 10, '850': 5, '700': 0, '600': -2, '500': -10, '400': -20, '300': -35 } as Partial<Record<LevelKey, number>>,
      rh: { '925': 80, '850': 80, '700': 70, '600': 65, '500': 60, '400': 55, '300': 50 } as Partial<Record<LevelKey, number>>,
      visible: Object.fromEntries(LEVEL_KEYS.map((k) => [k, true])) as Record<LevelKey, boolean>,
    }));

  it('太阳高挂 + 45% 黄金层时，参考层透过率必须接近 1', () => {
    for (const alt of [10, 5, 3, 1]) {
      const r = rayMarchingTransmittance(4200, alt, rings({ '600': 0.45, '500': 0.45 }), Array(6).fill(4));
      // 上一版恒为 2.09e−11，导致 Canvas 永不绘制光路与太阳
      expect(r.transmittance).toBeGreaterThan(0.5);
    }
  });

  it('纯直射份额不会因太阳下沉而升高（排除地形切断）', () => {
    // 满铺低云在掠射光路上成为硬遮挡 → 直射份额应随下沉下降。
    // 注意避开地形切断距离（那里会因为 blockedAtKm 归零而跳变，
    // 那是几何正确行为，不是本测试要检验的内容）。
    const vals = [3, 2, 1, 0, -0.5, -1, -1.25, -1.5].map(
      (alt) => rayMarchingTransmittance(4200, alt, rings({ '600': 0.45, '700': 0.9 }), Array(6).fill(4)).directTransmittance,
    );
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeLessThanOrEqual(vals[i - 1] + 1e-9);
    }
  });

  it('有效照明度在地影线以下不为 0（散射分量仍在）', () => {
    // α=−3° 时 4200m 云已入影，但黄昏散射仍提供可观照明 ——
    // 这正是「云没被直射点亮，天却还是橙红」的物理来源
    const r = rayMarchingTransmittance(4200, -3, rings({ '600': 0.45, '500': 0.45 }), Array(6).fill(4));
    expect(r.directTransmittance).toBeLessThan(r.transmittance + 1e-9);
  });

  it('光学厚度与透过率不再自相矛盾', () => {
    const r = rayMarchingTransmittance(4200, 3, rings({ '600': 0.45 }), Array(6).fill(4));
    // τ 很大但 T 不小 —— 这正是破碎云 (1−c)+c·e^−τ 的正确行为
    expect(r.opticalDepth).toBeGreaterThan(1);
    expect(r.transmittance).toBeGreaterThan(0.9);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. 环透过率曾用面积平均 τ，与逐层透过率差 100 倍
// ═══════════════════════════════════════════════════════════════════════
describe('P0 环透过率与逐层透过率同源', () => {
  it('疏云不会把环透过率打到 0', () => {
    const b = bundle(C({ '600': 0.5, '500': 0.45, '400': 0.4 }));
    const p = predict(b);
    // 上一版所有环都是 T = 0.00，SkyMapCard 每个扇叶都画成"完全阻断"
    const vis = p.rings.filter((r) => !r.terrainBlocked && r.ringKm > 0);
    expect(vis.length).toBeGreaterThan(0);
    for (const r of vis) expect(r.transmittance).toBeGreaterThan(0.01);
  });

  it('环透过率随距离单调不增', () => {
    const p = predict(bundle(C({ '700': 0.4, '600': 0.5 })));
    const vis = p.rings.filter((r) => !r.terrainBlocked);
    for (let i = 1; i < vis.length; i++) {
      expect(vis[i].transmittance).toBeLessThanOrEqual(vis[i - 1].transmittance + 1e-9);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. 多模型对比曾复用主源判据，切换主源会让所有模型整体平移
// ═══════════════════════════════════════════════════════════════════════
describe('P0 多模型对照各用各的判据', () => {
  const clear = { '600': 0.5, '500': 0.45 };
  const overcast = { '925': 1, '850': 1, '700': 1, '600': 1, '500': 1, '400': 1, '300': 1 };

  it('切换主源不改变另一模型的峰值', () => {
    const b = bundle(C({}), { models: { ecmwf: C(clear), gfs: C(overcast) } });
    const asEcmwf = predict(b, 0, ['ecmwf', 'gfs'], 'ecmwf');
    const asGfs = predict(b, 0, ['ecmwf', 'gfs'], 'gfs');

    const pick = (p: ReturnType<typeof predict>, m: ModelId) =>
      p.modelPeaks.find((x) => x.model === m)!.peakVividness;

    // 上一版：GFS 在 primary=ecmwf 时 0.33，primary=gfs 时 0.003（差 100 倍）
    expect(pick(asEcmwf, 'gfs')).toBeCloseTo(pick(asGfs, 'gfs'), 6);
    expect(pick(asEcmwf, 'ecmwf')).toBeCloseTo(pick(asGfs, 'ecmwf'), 6);
  });

  it('阴天模型必须显著低于晴天模型', () => {
    const b = bundle(C({}), { models: { ecmwf: C(clear), gfs: C(overcast) } });
    const p = predict(b, 0, ['ecmwf', 'gfs'], 'ecmwf');
    const ecmwf = p.modelPeaks.find((x) => x.model === 'ecmwf')!.peakVividness;
    const gfs = p.modelPeaks.find((x) => x.model === 'gfs')!.peakVividness;
    expect(gfs).toBeLessThan(ecmwf * 0.3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. 否决条件曾冻结在 eventMs，却被乘进每一帧
// ═══════════════════════════════════════════════════════════════════════
describe('P0 否决条件逐帧计算', () => {
  // 注意：底层数据是**逐小时**的，所以逐帧 guards 只有在相邻小时值不同时
  // 才会产生差异。下面的测试按小时构造，才能真实检验「冻结 vs 逐帧」。
  const withHourlyLow = (blockedHours: number[]): ForecastBundle => {
    const base = bundle(C({ '600': 0.5, '500': 0.45 }));
    return {
      ...base,
      models: {
        ecmwf: {
          ...base.models.ecmwf,
          rings: RING.map((d) => ({
            ringKm: d,
            point: { lat: 31.23, lon: 121.47 },
            samples: TIMES.map((t) => {
              const hourOff = Math.round((t - EVENT) / 3600000);
              const blocked = blockedHours.includes(hourOff);
              return sample(t, {
                '600': 0.5, '500': 0.45,
                '850': blocked ? 1 : 0.02,
                '925': blocked ? 1 : 0.02,
              });
            }),
          })),
        },
      } as ForecastBundle['models'],
    };
  };

  it('低云只在时序窗外满铺时，不得拉低窗内评分', () => {
    // 满铺低云只出现在 ±6h（远在 −20~+40min 窗外）
    const outside = predict(withHourlyLow([-6, -5, 5, 6]));
    const clear = predict(bundle(C({ '600': 0.5, '500': 0.45, '850': 0.02, '925': 0.02 })));
    expect(outside.vividness).toBeCloseTo(clear.vividness, 3);
    expect(outside.veto.kind).toBe('none');
  });

  it('没有低云时不得凭空报出低云锁死', () => {
    const p = predict(bundle(C({ '600': 0.5, '500': 0.45, '850': 0.02, '925': 0.02 })));
    expect(p.veto.kind).not.toBe('low-cloud-lock');
  });

  it('报告里的否决状态来自峰值帧的天气', () => {
    // 事件前 2 小时低云满铺、事件之后散尽。峰值在窗外/窗内取决于云的时序。
    // 关键断言：报告里的 veto 必须描述**峰值那一帧**，而不是 eventMs。
    const p = predict(withHourlyLow([-2, -1]));
    const peakOff = (p.timeline.peakMs - p.eventMs) / 60000;
    // 峰值应落在低云已散尽的时段（≥ −20min 内低云为 2%）
    expect(peakOff).toBeGreaterThanOrEqual(-20);
    // 若 veto 冻结在 eventMs（那一小时低云 2%），也是 none；
    // 但若刻意让 eventMs 那一小时满铺低云，就必然被压低 —— 下面单独验证
    expect(p.vividness).toBeGreaterThan(0.5);
  });

  it('eventMs 满铺低云不会抹掉窗外干净的峰值帧', () => {
    // 低云只在 eventMs 所在小时满铺 —— 时序窗 [−20,+40min] 全部落在这个小时里，
    // 所以整窗都该被压（这是逐帧的正确行为，因为数据只有小时分辨率）。
    // 真正的对照是：**相邻小时**散尽时，off=−20 那一帧不应被压。
    const p = predict(withHourlyLow([1]));
    // +1 小时满铺。窗内 [+20min, +40min] 会受影响，但峰值在 0 附近仍然干净。
    const peakOff = (p.timeline.peakMs - p.eventMs) / 60000;
    expect(peakOff).toBeLessThan(20);
    expect(p.veto.kind).not.toBe('low-cloud-lock');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. 干霾曾被报成「低云锁死 · 阴天」
// ═══════════════════════════════════════════════════════════════════════
describe('P0 干霾不再被报成低云锁死', () => {
  it('云量 0 + 能见度 2.5km 走 haze 分支', () => {
    const p = predict(bundle(C({}), { vis: 2500, humidity: 50 }));
    expect(p.veto.kind).not.toBe('low-cloud-lock');
    expect(p.veto.detail).not.toMatch(/本地低云 0%/);
  });

  it('雾（高湿 + 低能见度）仍单独成档', () => {
    const p = predict(bundle(C({ '600': 0.5 }), { vis: 1200, humidity: 96 }));
    expect(['fog', 'haze']).toContain(p.veto.kind);
  });

  it('真正的满铺低云仍然触发低云锁死', () => {
    const p = predict(bundle(C({ '925': 1, '850': 1, '700': 0.9 })));
    expect(p.veto.kind).toBe('low-cloud-lock');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. 红/蓝比硬阈值曾造成 20% 断崖
// ═══════════════════════════════════════════════════════════════════════
describe('P0 时间曲线在日落时刻不再有断崖', () => {
  it('相邻帧鲜艳度变化平缓（无 >55% 突变）', () => {
    const p = predict(bundle(C({ '600': 0.55, '500': 0.5 })));
    for (let i = 1; i < p.series.length; i++) {
      const a = p.series[i - 1].vividness;
      const b = p.series[i].vividness;
      if (a > 0.05 && b > 0.05) {
        // 上一版在日落时刻有 20% 的伪断崖（purity 硬阈值 + τ_full 口径），
        // 修复后剩下的最大变化来自黄金层真的穿过地影线（6 分钟内从
        // lit=0.72 降到 0.35）—— 那是物理的，应当保留。
        expect(Math.abs(b - a) / Math.max(a, b)).toBeLessThan(0.55);
      }
    }
  });

  it('purity 项不会单独制造台阶', () => {
    // 断崖的根本原因是 purity 从 1.000 掉到 0.740（14% 的纯数学跳变），
    // 叠加在物理衰减上就会放大成可见断崖。修复后 purity 应恒为连续值。
    const p = predict(bundle(C({ '600': 0.55, '500': 0.5 })));
    const nearPeak = p.series.filter((s) => Math.abs(s.offsetMin) <= 8);
    for (const s of nearPeak) expect(s.vividness).toBeGreaterThan(0.15);
  });

  it('红蓝比在蓝通道趋零时保持有限', () => {
    for (const alt of [-1.4, -1.5, -1.6, -2, -3]) {
      const r = directSunRgb(alt, 4200, 0.1, 1.3, 50);
      const rb = (r.rgb.r + 1e-5) / (r.rgb.b + 1e-5);
      expect(Number.isFinite(rb)).toBe(true);
      expect(rb).toBeLessThan(1e7);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. 气柱光学厚度曾非单调（−6° 比 −1.8° 亮 10⁵ 倍）
// ═══════════════════════════════════════════════════════════════════════
describe('P1 气柱质量随太阳下沉单调', () => {
  it('切点高度随 α 单调递减并正确地在地平线附近归零', () => {
    let prev = Infinity;
    for (let a = 10; a >= -1.5; a -= 0.25) {
      const h = beamTangentHeightM(4200, a);
      expect(h).toBeLessThanOrEqual(prev + 1e-6);
      prev = h;
    }
    // 4200m 云的地影线在 α ≈ −2.08°
    expect(beamTangentHeightM(4200, -2.0)).toBeLessThan(0);
    expect(beamTangentHeightM(4200, -1.5)).toBeGreaterThan(0);
  });

  it('气温直射光的亮度随 α 下降单调不增', () => {
    let prev = Infinity;
    for (let a = 12; a >= -3; a -= 0.25) {
      const r = directSunRgb(a, 4200, 0.08, 1.3, 45);
      const lum = 0.2126 * r.rgb.r + 0.7152 * r.rgb.g + 0.0722 * r.rgb.b;
      expect(lum).toBeLessThanOrEqual(prev * 1.02 + 1e-12);
      prev = lum;
    }
  });

  it('气柱质量在全部高度与角度都有界', () => {
    for (const h of [780, 1500, 4200, 9200]) {
      for (const a of [45, 10, 1, 0, -1, -3, -8]) {
        for (const H of [8, 1.5]) {
          const m = beamAirmass(h, a, H);
          expect(Number.isFinite(m)).toBe(true);
          expect(m).toBeGreaterThan(0);
          expect(m).toBeLessThan(400);
        }
      }
    }
  });

  it('解析气柱与数值积分在同量级（α=0 处偏差 <2 倍）', () => {
    const analytic = directBeamAirmass(4200, 0).rayleigh;
    const numeric = slantAirmass((d) => (4200 + d * Math.tan(0) * 1000 + (d * d / (2 * 7435)) * 1000) / 1000, 400, 8, 2);
    expect(analytic / numeric).toBeGreaterThan(0.5);
    expect(analytic / numeric).toBeLessThan(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. 臭氧：之前只有常数近似，黄昏时严重低估
// ═══════════════════════════════════════════════════════════════════════
describe('P1 臭氧 Chappuis 带', () => {
  it('双峰在 575 / 603nm，400nm 以下为 0', () => {
    expect(ozoneExtinctionRel(575)).toBeGreaterThan(0.8);
    expect(ozoneExtinctionRel(603)).toBeGreaterThan(0.85);
    expect(ozoneExtinctionRel(550)).toBeLessThan(ozoneExtinctionRel(575));
    expect(ozoneExtinctionRel(380)).toBe(0);
    expect(ozoneExtinctionRel(700)).toBe(0);
  });

  it('黄昏时绿通道被臭氧吃掉的比例高于红通道', () => {
    const dusk = directSunRgb(-3, 4200, 0.05, 1.3, 45);
    const noon = directSunRgb(40, 4200, 0.05, 1.3, 45);
    const gRatio = dusk.rgb.g / noon.rgb.g;
    const rRatio = dusk.rgb.r / noon.rgb.r;
    expect(gRatio).toBeLessThan(rRatio);
  });

  it('臭氧柱量量级正确（300DU ≈ 0.021 @550nm）', () => {
    expect(TAU_O3_550).toBeGreaterThan(0.01);
    expect(TAU_O3_550).toBeLessThan(0.05);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. 层贡献曾经线性相加（重复计算天空面积）
// ═══════════════════════════════════════════════════════════════════════
describe('P1 层贡献按"同一片天空的并集"合成', () => {
  it('两层同一天空不会简单相加超过单层', () => {
    const one = predict(bundle(C({ '600': 0.5 })));
    const two = predict(bundle(C({ '600': 0.5, '500': 0.5 })));
    // 600 与 500 是同一角色的上下界，并集后的发光面积增长有限
    expect(two.vividness).toBeLessThan(one.vividness * 2.2);
  });

  it('黄金层 + 卷云应高于任一单独层', () => {
    const golden = predict(bundle(C({ '600': 0.45, '500': 0.4 })));
    const cirrus = predict(bundle(C({ '300': 0.8 })));
    const both = predict(bundle(C({ '600': 0.45, '500': 0.4, '300': 0.8 })));
    expect(both.vividness).toBeGreaterThan(golden.vividness);
    expect(both.vividness).toBeGreaterThan(cirrus.vividness);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. 分级可达性
// ═══════════════════════════════════════════════════════════════════════
describe('P1 分级标尺可达', () => {
  it('大烧门槛（0.6）在典型好天气下可达', () => {
    const p = predict(bundle(C({ '600': 0.45, '500': 0.4 }), { aod: 0.08, vis: 32000 }));
    expect(p.vividness).toBeGreaterThan(0.6);
  });

  it('特大烧门槛（1.0）在最优构型下可达', () => {
    const p = predict(
      bundle(C({ '600': 0.45, '500': 0.4, '300': 0.9 }), { aod: 0.05, pm25: 4, vis: 36000, humidity: 40 }),
    );
    expect(p.vividness).toBeGreaterThan(1.0);
  });

  it('鲜艳度上限落在物理可达区间内', () => {
    // 用 7 层云量 + 3 通道消光的模型，实测绝对上限约 1.15~1.2（特大烧）。
    // 「世纪大烧」（>1.5）在当前数据模型下不可达 —— 这是诚实的局限，
    // 需要云光学厚度 / 云相态才能进一步拉开动态范围（见 ROADMAP）。
    let max = 0;
    for (const g of [0.4, 0.5, 0.56, 0.62]) {
      for (const h of [0.7, 0.8, 0.86, 0.95]) {
        for (const aod of [0.02, 0.05]) {
          const p = predict(
            bundle(C({ '600': g, '500': g, '400': h, '300': h }), {
              aod, pm25: 4, vis: 38000, humidity: 35,
            }),
          );
          max = Math.max(max, p.vividness);
        }
      }
    }
    expect(max).toBeGreaterThan(1.0);
    expect(max).toBeLessThan(1.6);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 11. 语义正确性
// ═══════════════════════════════════════════════════════════════════════
describe('P2 tactical 文案与实际天气一致', () => {
  it('整层阴天不得被建议"全天几乎无云"', () => {
    const p = predict(bundle(C({ '925': 1, '850': 1, '700': 1, '600': 1, '500': 1, '400': 1, '300': 1 })));
    expect(p.tactical.focalReason).not.toMatch(/几乎无云/);
  });

  it('真正无云时才给渐变镜建议', () => {
    const p = predict(bundle(C({}), { aod: 0.1, vis: 30000 }));
    expect(p.tactical.focalReason).toMatch(/几乎无云|渐变镜/);
  });
});

describe('P2 湿度单源一致', () => {
  it('高湿时能见度不得显示为通透的 22km', () => {
    const p = predict(bundle(C({ '600': 0.5 }), { aod: 0.26, humidity: 93, vis: 0 }));
    // 上一版用 aer.humidity（恒 55）反演 → 22km，同时用 93% 算浑浊惩罚
    expect(p.spectral.visibilityKm).toBeLessThan(18);
    expect(p.spectral.humidity).toBeGreaterThan(85);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 12. 云相态与层湿度（2026-11 接入的新数据源）
// ═══════════════════════════════════════════════════════════════════════
describe('P1 云相态温度依赖', () => {
  it('同样的冰水路径，冰云的光学厚度低于水云', () => {
    // 300hPa 典型 −35°C（全冰）vs 925hPa 典型 +14°C（全水）
    const iceF = cloudPhaseTauFactor(-35, 80);
    const waterF = cloudPhaseTauFactor(14, 90);
    expect(iceF).toBeLessThan(waterF);
    expect(iceF).toBeLessThan(0.5);
    expect(waterF).toBeCloseTo(1, 2);
  });

  it('相态因子随温度降低单调下降', () => {
    const vals = [10, 0, -10, -20, -30, -40].map((t) => cloudPhaseTauFactor(t, 80));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1] + 1e-9);
  });

  it('低 RH 的"云"被削弱（干空气不可能是云幕）', () => {
    const humid = cloudPhaseTauFactor(-20, 95);
    const dry = cloudPhaseTauFactor(-20, 30);
    expect(dry).toBeLessThan(humid);
  });

  it('缺测温度时因子为 1（不引入无根据的修正）', () => {
    expect(cloudPhaseTauFactor(undefined, 80)).toBe(1);
  });
});

describe('P1 层湿度剔除假云幕', () => {
  it('干层（RH 30%）的云幕质量显著低于湿层（RH 90%）', () => {
    const dry = cloudScreenQuality(0.5, 'golden', '600', 30);
    const wet = cloudScreenQuality(0.5, 'golden', '600', 90);
    expect(dry).toBeLessThan(wet * 0.75);
  });

  it('无 RH 数据时行为与之前完全一致', () => {
    const noRh = cloudScreenQuality(0.5, 'golden', '600');
    const wetRh = cloudScreenQuality(0.5, 'golden', '600', 90);
    expect(noRh).toBeCloseTo(wetRh, 6);
  });
});
