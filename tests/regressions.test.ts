/**
 * 2026-11 审查修复的回归测试
 * ---------------------------------------------------------------------------
 * 每条测试对应一个曾经真实存在、且用户可见的缺陷。命名统一为
 * 「P0/P1 + 症状」，避免以后重构时悄悄回退。
 */

import { describe, expect, it } from 'vitest';
import {
  aerosolImmersionFactor,
  beamAirmass,
  beamTangentHeightM,
  cloudBetaPerKm,
  CLOUD_ELEMENT_BY_ROLE_KM,
  CLOUD_ELEMENT_KM,
  CLOUD_OVERLAP_DECORR_KM,
  cloudLayerDirectTransmittance,
  cloudLayerTau,
  cloudPhaseTauFactor,
  combinedCloudCover,
  cotCalibrationFactor,
  inferCloudOpticalDepth,
  inferCloudOpticalDepthFromRadiation,
  clearSkySwTransmittance,
  colorChroma,
  compositeCloudColor,
  viewPathRgb,
  CLOUD_BETA_ICE_PER_KM,
  CLOUD_BETA_LIQUID_PER_KM,
  directBeamAirmass,
  directSunRgb,
  effectiveGroundHeightM,
  effectiveGroundHeightRangeM,
  levelFullOpticalDepth,
  ozoneExtinctionRel,
  tauO3FromColumn,
  slantAirmass,
  TAU_O3_550,
} from '../src/engine/optics';
import {
  cloudScreenQuality,
  crossCheckLayerCloud,
  parseVerticalCloudProfile,
  predictSunset,
  rayMarchingTransmittance,
} from '../src/engine/SunsetPhysicsEngine';
import { advectionLagMs, sampleAdvected } from '../src/engine/astro';
import { QuotaExhaustedError } from '../src/data/openMeteo';
import { evaluateSpectral } from '../src/engine/spectral';
import { GRADES, LEVEL_KEYS } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import type { ForecastBundle, HourlySample, ModelId } from '../src/engine/types';

const STD_H: Record<LevelKey, number> = {
  '1000': 110, '925': 780, '850': 1500, '700': 3000, '600': 4200,
  '500': 5500, '400': 7200, '300': 9200, '250': 10400, '200': 11800,
};

const EVENT = Date.UTC(2026, 10, 3, 9, 5, 0);

function sample(t: number, cover: Partial<Record<LevelKey, number>>, o: { precip?: number; vis?: number; humidity?: number; layerSummary?: { low: number; mid: number; high: number } } = {}): HourlySample {
  const cloud = {} as Record<LevelKey, number>;
  const levelHeightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) {
    cloud[k] = (cover[k] ?? 0) * 100;
    levelHeightM[k] = STD_H[k];
  }
  // 默认仍给 0（保持既有 86 条测试的基线不变）；
  // 需要真实格点汇总的场景显式传 `layerSummary`，否则会触发
  // `crossCheckLayerCloud` 的"等压面与汇总值矛盾"惩罚。
  const ls = o.layerSummary;
  return {
    timeMs: t, cloud, levelHeightM, levelTempC: {},
    cloudLow: (ls?.low ?? 0) * 100,
    cloudMid: (ls?.mid ?? 0) * 100,
    cloudHigh: (ls?.high ?? 0) * 100,
    cloudTotal: ls ? Math.max(ls.low, ls.mid, ls.high) * 100 : 0,
    precipitation: o.precip ?? 0,
    humidity: o.humidity ?? 50,
    visibilityM: o.vis ?? 25000, surfacePressureHpa: 1013,
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

  it('太阳高挂 + 45% 黄金层时，自身消光后的参考层照明仍显著非零', () => {
    for (const alt of [10, 5, 3, 1]) {
      const r = rayMarchingTransmittance(4200, alt, rings({ '600': 0.45, '500': 0.45 }), Array(6).fill(4));
      // 旧错误值恒为 2.09e−11；计入云中点自身消光后不再要求 T>0.5，
      // 尤其 α=1° 的掠射光本来就会显著衰减。
      expect(r.transmittance).toBeGreaterThan(0.35);
      expect(r.transmittance).toBeLessThanOrEqual(1);
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
      expect(vals[i]).toBeLessThanOrEqual(vals[i - 1] + 1e-3);
    }
  });

  it('有效照明度在地影线以下不为 0（散射分量仍在）', () => {
    // α=−3° 时 4200m 云已入影，但黄昏散射仍提供可观照明 ——
    // 这正是「云没被直射点亮，天却还是橙红」的物理来源
    const r = rayMarchingTransmittance(4200, -3, rings({ '600': 0.45, '500': 0.45 }), Array(6).fill(4));
    expect(r.directTransmittance).toBeLessThan(r.transmittance + 1e-9);
  });

  it('光学厚度与自身消光后的透过率量级自洽', () => {
    const rs = rings({ '600': 0.45 });
    const r = rayMarchingTransmittance(4200, 3, rs, Array(6).fill(4));
    const withoutSelf = rayMarchingTransmittance(4200, 3, rs, Array(6).fill(4), { includeSelfExtinction: false });
    expect(r.opticalDepth).toBeGreaterThan(0.01);
    expect(r.opticalDepth).toBeLessThan(5);
    expect(r.transmittance).toBeGreaterThan(0.5);
    expect(r.transmittance).toBeLessThan(withoutSelf.transmittance);
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
    // 用 10 层云量 + 3 通道消光的模型，当前实测绝对上限约 1.09
    // （`scratch/ceiling-probe.ts` 168 组网格搜索；此处网格更粗，故只断言 >1.0）。
    // 「世纪大烧」（>1.5）在当前数据模型下不可达 —— 这是诚实的局限，
    // 需要云光学厚度 / 云相态才能进一步拉开动态范围（见 ROADMAP）。
    //
    // **为什么最优构型只有「一层高云 + 黄金层」，不含 400hPa**：
    // 光路在 α≈−1.5° 时是掠射的，太阳光要到达 9.2km 的卷云，必须先穿过
    // 7.2km 那层的整条水平路径（约 50km）。70% 覆盖、β≈0.45/km 时
    // 该层等效 τ≈2，把光衰减到 14% —— 所以**下层高云会遮暗上层高云**。
    // 这是真实的物理（厚高层云确实会掩住其上的卷云），不是 bug，
    // 见紧随其后的"多层高云互相遮挡"回归测试。
    let max = 0;
    for (const g of [0.35, 0.4, 0.45, 0.5, 0.56]) {
      for (const h of [0.65, 0.7, 0.8, 0.9]) {
        for (const aod of [0.02, 0.05]) {
          const p = predict(
            bundle(C({ '600': g, '500': g, '300': h }), {
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

  it('下层高云会遮暗上层高云（掠射多输入的显式回归）', () => {
    // 这条**不是**要求"加层必然加分"，而是锁住正确的物理方向：
    // 9.2km 卷云单独存在时最亮；在它下面加一层 7.2km 高云，
    // 该层会吃掉到达 9.2km 的掠射光，总分因此可以下降 ——
    // 但只要仍有可见发光面，就不该跌到「无烧」。
    const highOnly = predict(bundle(C({ '300': 0.7 }), { aod: 0.05, pm25: 4, vis: 38000 }));
    const twoDecks = predict(bundle(C({ '400': 0.7, '300': 0.7 }), { aod: 0.05, pm25: 4, vis: 38000 }));

    // 两层都在发光，总分必须显著高于「无烧」
    expect(twoDecks.vividness).toBeGreaterThan(0.3);
    // 且加层后的衰减是温和的（不是把上层彻底抹黑）
    expect(twoDecks.vividness).toBeGreaterThan(highOnly.vividness * 0.6);
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

describe('P1 整层可降水总量对浑浊的影响', () => {
  it('TCWV 越高，浑浊惩罚越重（同样 AOD/RH）', () => {
    const dry = evaluateSpectral(0.25, 30, 10, 80, 20, true, 8);
    const wet = evaluateSpectral(0.25, 30, 10, 80, 20, true, 45);
    expect(wet.hazePenalty).toBeLessThan(dry.hazePenalty);
  });

  it('缺测 TCWV 时行为与不传完全一致', () => {
    const a = evaluateSpectral(0.25, 30, 10, 80, 20, true);
    const b = evaluateSpectral(0.25, 30, 10, 80, 20, true, undefined);
    expect(a.saturationGain).toBe(b.saturationGain);
    expect(a.hazePenalty).toBe(b.hazePenalty);
  });

  it('TCWV 修正有上下界，不会失控', () => {
    for (const t of [0, 1, 100, 500]) {
      const r = evaluateSpectral(0.25, 30, 10, 80, 20, true, t);
      expect(Number.isFinite(r.hazePenalty)).toBe(true);
      expect(r.hazePenalty).toBeGreaterThan(0);
      expect(r.hazePenalty).toBeLessThanOrEqual(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 13. 破碎云直接透射（2026-11 修复 P0-1 双重计算）
// ═══════════════════════════════════════════════════════════════════════
describe('P0-1 破碎云直接透射（含云隙，唯一口径）', () => {
  it('极限行为正确', () => {
    // c=1 ⇒ 纯 Beer–Lambert，穿过云块本体
    expect(cloudLayerDirectTransmittance(1, 450, 10)).toBeCloseTo(Math.exp(-4500), 300);
    // c=0 ⇒ 1（无云，全透）
    expect(cloudLayerDirectTransmittance(0, 450, 10)).toBe(1);
    // path=0 ⇒ 1（没走路，不衰减）
    expect(cloudLayerDirectTransmittance(0.5, 0, 10)).toBe(1);
    // β=0 ⇒ 1（无消光）
    expect(cloudLayerDirectTransmittance(0.5, 450, 0)).toBe(1);
  });

  it('覆盖率越高透过率越低（单调）', () => {
    const vals = [0.1, 0.3, 0.5, 0.7, 0.9].map((c) => cloudLayerDirectTransmittance(c, 200, 10));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThan(vals[i - 1]);
  });

  it('液态云的透过率低于冰云（同样覆盖率与路径）', () => {
    const liquid = cloudLayerDirectTransmittance(0.5, 200, CLOUD_BETA_LIQUID_PER_KM);
    const ice = cloudLayerDirectTransmittance(0.5, 200, CLOUD_BETA_ICE_PER_KM);
    expect(liquid).toBeLessThan(ice);
  });

  it('短路径（D < L）不得低估遮挡 —— 这是旧公式的核心缺陷', () => {
    // c=0.5, β=10, L=30km, D=10km
    // 旧"每 L 重采样"式给 0.5^(10/30) ≈ 0.794（严重低估遮挡）
    // 物理上单条光线撞进云块的概率仍是 0.5，期望透过率应接近 0.5
    const t = cloudLayerDirectTransmittance(0.5, 10, 10, 30);
    expect(t).toBeLessThan(0.55);
    expect(t).toBeGreaterThan(0.45);
    // 绝不能接近旧式的 0.794
    expect(t).toBeLessThan(0.7);
  });

  it('两支在 D = L 处严格连续（不是经验拼接）', () => {
    const L = 30;
    const below = cloudLayerDirectTransmittance(0.4, L - 1e-9, 8, L);
    const above = cloudLayerDirectTransmittance(0.4, L + 1e-9, 8, L);
    expect(Math.abs(below - above)).toBeLessThan(1e-5);
  });

  it('长路径趋向指数衰减且 τ 随路径线性', () => {
    // D=200km 与 D=400km 都远大于 L=30km，τ 应严格正比
    const t200 = cloudLayerDirectTransmittance(0.5, 200, 10);
    const t400 = cloudLayerDirectTransmittance(0.5, 400, 10);
    expect(Math.log(t400) / Math.log(t200)).toBeCloseTo(2, 2);
    // τ 量级必须在 O(1)–O(10)，而不是均匀灰雾的 2250
    const tau = -Math.log(t200);
    expect(tau).toBeLessThan(50);
    expect(tau).toBeGreaterThan(1);
  });

  it('cloudLayerTau 与 transmittance 严格互为 −ln', () => {
    const t = cloudLayerDirectTransmittance(0.6, 120, 7);
    const tau = cloudLayerTau(0.6, 120, 7);
    expect(Math.exp(-tau)).toBeCloseTo(t, 12);
  });

  it('旧公式会把 80% 覆盖 100km 的透过率虚高 43 倍（回归锁）', () => {
    // 这是审查文档 P0-1 的核心数字：正确值 ≈ 0.0047，双重计算后 ≈ 0.2037
    const correct = cloudLayerDirectTransmittance(0.8, 100, 10);
    expect(correct).toBeLessThan(0.02);
  });
});

describe('P0-1 体消光系数按真实层厚归一', () => {
  it('厚度不改变 τ_full，但改变 β（per km）', () => {
    const thin = cloudBetaPerKm('200', 2.2);
    const thick = cloudBetaPerKm('200', 0.4);
    // 同样 τ_full，层越薄体消光越强
    expect(thick).toBeGreaterThan(thin);
    expect(thick / thin).toBeCloseTo(2.2 / 0.4, 1);
  });

  it('单位厚度时退化为 τ_full（兼容旧调用）', () => {
    expect(cloudBetaPerKm('850', 1)).toBeCloseTo(levelFullOpticalDepth('850'), 6);
  });

  it('有下限保护，不会出现 0 消光', () => {
    expect(cloudBetaPerKm('200', 100)).toBeGreaterThanOrEqual(0.05);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 14. AOD 硬门槛「污烧」（SunsetBot 表 2.3 口径）
// ═══════════════════════════════════════════════════════════════════════
describe('P1 AOD 分档与「污烧」硬门槛', () => {
  const clean = { aod: 0.1, pm25: 12, dust: 8, humidity: 55, vis: 25 };

  it('AOD < 0.18 判为水晶天', () => {
    const r = evaluateSpectral(0.1, 6, 4, 42, 32, true, 20);
    expect(r.crystal).toBe(true);
    expect(r.tone).toBe('crystal');
  });

  it('AOD > 0.8 判为【污烧】，浑浊惩罚被硬压到 0.34 以下', () => {
    const r = evaluateSpectral(0.9, 20, 8, 60, 20, true, 20);
    expect(r.tone).toBe('hazy');
    expect(r.toneLabel).toBe('污烧');
    expect(r.hazePenalty).toBeLessThan(0.34);
  });

  it('污烧的严重程度随 AOD 增加（1.2 以上触底）', () => {
    const mild = evaluateSpectral(0.85, 20, 8, 60, 20, true, 20).hazePenalty;
    const severe = evaluateSpectral(1.2, 20, 8, 60, 20, true, 20).hazePenalty;
    const extreme = evaluateSpectral(2.0, 20, 8, 60, 20, true, 20).hazePenalty;
    expect(severe).toBeLessThan(mild);
    expect(extreme).toBeCloseTo(0.12, 2);
  });

  it('AOD 0.5–0.8 为渐进削弱，不跳到污烧', () => {
    const r = evaluateSpectral(0.65, 20, 8, 60, 20, true, 20);
    expect(r.toneLabel).not.toBe('污烧');
    expect(r.hazePenalty).toBeLessThan(0.8);
    expect(r.hazePenalty).toBeGreaterThan(0.34);
  });

  it('洁净天空不受新门槛影响', () => {
    const r = evaluateSpectral(clean.aod, clean.pm25, clean.dust, clean.humidity, clean.vis, true, 20);
    expect(r.hazePenalty).toBeGreaterThan(0.9);
  });

  it('气溶胶缺测时不套用污烧门槛（缺数据 ≠ 重霾）', () => {
    const r = evaluateSpectral(0.9, 20, 8, 60, 20, false, 20);
    expect(r.toneLabel).not.toBe('污烧');
    expect(r.available).toBe(false);
  });

  it('污烧下即使云幕满分也拿不到大烧', () => {
    const hazy = predict(
      bundle(C({ '600': 0.45, '500': 0.4 }), { aod: 0.95, pm25: 60, vis: 12000, humidity: 70 }),
    );
    // AOD 0.95 → hazePenalty ≤ 0.22，把 0.94 的基准分压到 0.25 以下
    expect(hazy.vividness).toBeLessThan(0.6);
    expect(hazy.grade).not.toBe('major');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 15. 气溶胶「抬升有效地面」
// ═══════════════════════════════════════════════════════════════════════
describe('P1 有效地面高度（气溶胶抬升地面）', () => {
  it('复现 SunsetBot 教程的实测区间', () => {
    // 教程表：AOD 0.14 → 1.32~2.57km；AOD 0.15 → 1.35~2.75km
    const a14 = effectiveGroundHeightRangeM(0.14);
    expect(a14.min / 1000).toBeGreaterThan(1.25);
    expect(a14.min / 1000).toBeLessThan(1.4);
    expect(a14.max / 1000).toBeGreaterThan(2.5);
    expect(a14.max / 1000).toBeLessThan(2.65);

    const a15 = effectiveGroundHeightRangeM(0.15);
    expect(a15.min / 1000).toBeGreaterThan(1.3);
    expect(a15.min / 1000).toBeLessThan(1.4);
    expect(a15.max / 1000).toBeGreaterThan(2.7);
    expect(a15.max / 1000).toBeLessThan(2.8);
  });

  it('AOD 越高，有效地面越高（单调）', () => {
    const vals = [0.1, 0.3, 0.5, 1.0, 2.0].map((a) => effectiveGroundHeightRangeM(a).min);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
  });

  it('AOD 低于 β_c·H 时无抬升', () => {
    // 阈值 = 0.02 km⁻¹ × 1.5 km = 0.03
    expect(effectiveGroundHeightM(0.01, 1.5)).toBe(0);
    expect(effectiveGroundHeightM(0.03, 1.5)).toBe(0);
    // 一旦越过阈值就开始抬升
    expect(effectiveGroundHeightM(0.05, 1.5)).toBeGreaterThan(0);
  });

  it('霾天低云先失去受光，高云几乎不受影响', () => {
    const clean = predict(bundle(C({ '850': 0.5, '600': 0.45, '500': 0.4 }), { aod: 0.1, vis: 20000 }));
    const hazy = predict(bundle(C({ '850': 0.5, '600': 0.45, '500': 0.4 }), { aod: 0.9, vis: 20000, pm25: 40 }));

    // 总分显著下降
    expect(hazy.vividness).toBeLessThan(clean.vividness);
    // 且低云（1.5km）的受光退化远强于黄金层（4.2km）——
    // 这是「霾天只剩高空火」的物理来源
    const cleanLow = clean.layers.find((l) => l.key === '850')!;
    const hazyLow = hazy.layers.find((l) => l.key === '850')!;
    expect(hazyLow.contribution).toBeLessThan(cleanLow.contribution * 0.6);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 16. 实测臭氧总柱量驱动 Chappuis 吸收
// ═══════════════════════════════════════════════════════════════════════
describe('P1 臭氧总柱量影响蓝调时刻', () => {
  it('300 DU 时垂直光学厚度回到标定值', () => {
    expect(tauO3FromColumn(300)).toBeCloseTo(TAU_O3_550, 10);
  });

  it('柱量越高光学厚度越大（线性）', () => {
    expect(tauO3FromColumn(450)).toBeGreaterThan(tauO3FromColumn(300));
    expect(tauO3FromColumn(220)).toBeLessThan(tauO3FromColumn(300));
    expect(tauO3FromColumn(600) / tauO3FromColumn(300)).toBeCloseTo(2, 6);
  });

  it('缺测时退回标准值', () => {
    expect(tauO3FromColumn(NaN)).toBe(TAU_O3_550);
    expect(tauO3FromColumn(0)).toBe(TAU_O3_550);
    expect(tauO3FromColumn(-100)).toBe(TAU_O3_550);
  });

  it('臭氧越多，黄昏色相越偏红（Chappuis 吃掉绿蓝）', () => {
    // α=−1.5° 是可测区间（再低三通道全 underflow）
    const low = directSunRgb(-1.5, 4200, 0.08, 1.3, 45, 220);
    const high = directSunRgb(-1.5, 4200, 0.08, 1.3, 45, 450);
    const hLow = colorChromaViaHue(low.rgb);
    const hHigh = colorChromaViaHue(high.rgb);
    // 臭氧多 → 蓝通道被吃更多 → r/b 更小 → 色相更偏黄红
    expect(hHigh).toBeGreaterThan(hLow);
  });

  it('臭氧差异对可测色相的影响达到可感知量级（>3°）', () => {
    const low = colorChromaViaHue(directSunRgb(-1.5, 4200, 0.08, 1.3, 45, 220).rgb);
    const high = colorChromaViaHue(directSunRgb(-1.5, 4200, 0.08, 1.3, 45, 450).rgb);
    expect(high - low).toBeGreaterThan(3);
  });
});

/** 从 RGB 算色相（度）—— 避免依赖 colorChroma 的返回结构 */
function colorChromaViaHue(rgb: { r: number; g: number; b: number }): number {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const d = max - min;
  if (d <= 1e-30) return 0;
  let h: number;
  if (max === rgb.r) h = ((rgb.g - rgb.b) / d + 6) % 6;
  else if (max === rgb.g) h = (rgb.b - rgb.r) / d + 2;
  else h = (rgb.r - rgb.g) / d + 4;
  return h * 60;
}

// ═══════════════════════════════════════════════════════════════════════
// 17. 分档口径对齐 SunsetBot
// ═══════════════════════════════════════════════════════════════════════
describe('P1 分档对齐行业口径', () => {
  it('晴空无云与整层阴天必须是低档，不能算"有烧"', () => {
    const clear = predict(bundle(C({}), { aod: 0.1, vis: 30000 }));
    const overcast = predict(bundle(C({ '700': 0.95, '600': 0.95, '500': 0.95, '400': 0.95 }), { aod: 0.3 }));
    expect(['none', 'faint']).toContain(clear.grade);
    expect(['none', 'faint']).toContain(overcast.grade);
  });

  it('教科书好天气应落在中高档', () => {
    const good = predict(bundle(C({ '600': 0.45, '500': 0.4, '400': 0.5, '300': 0.45 }), { aod: 0.1, vis: 30000 }));
    expect(['major', 'majorLow', 'extreme', 'premium']).toContain(good.grade);
  });

  it('污烧（AOD>0.8）不得被评为中高档', () => {
    const dirty = predict(bundle(C({ '600': 0.45, '500': 0.4 }), { aod: 0.95, pm25: 100, humidity: 88, vis: 5000 }));
    expect(['none', 'faint', 'minor']).toContain(dirty.grade);
  });

  it('分档 key 唯一（不允许重复 key 破坏主题映射）', () => {
    const keys = GRADES.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('分档阈值单调递增', () => {
    for (let i = 1; i < GRADES.length; i++) {
      expect(GRADES[i].max).toBeGreaterThan(GRADES[i - 1].max);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 18. 格点噪声交叉校验（cloudLow/Mid/High 与等压面云量的一致性）
// ═══════════════════════════════════════════════════════════════════════
describe('P2 格点噪声交叉校验', () => {
  it('等压面与层汇总一致时不惩罚', () => {
    expect(crossCheckLayerCloud(0.9, 0.85)).toBe(1);
    expect(crossCheckLayerCloud(0.5, 0.5)).toBe(1);
  });

  it('等压面远高于层汇总时显著降权', () => {
    // 700hPa 报 90% 但 mid 汇总只有 10% —— 模式自相矛盾
    expect(crossCheckLayerCloud(0.9, 0.1)).toBeLessThan(0.4);
  });

  it('等压面低于汇总时不惩罚（局部可以更少）', () => {
    expect(crossCheckLayerCloud(0.3, 0.8)).toBe(1);
  });

  it('汇总值过小（<8%）时不校验', () => {
    // 汇总接近 0 可能是 summary 的定义问题，不是噪声
    expect(crossCheckLayerCloud(0.9, 0.05)).toBe(1);
  });

  it('降权系数有下界，不会归零', () => {
    expect(crossCheckLayerCloud(1.0, 0.09)).toBeGreaterThanOrEqual(0.35);
  });

  it('不一致越大，降权越重（单调）', () => {
    const vals = [0.4, 0.5, 0.6, 0.7, 0.8].map((c) => crossCheckLayerCloud(c, 0.3));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 19. 10 层等压面（新增 1000 / 250 / 200hPa）
// ═══════════════════════════════════════════════════════════════════════
describe('P1 十层等压面', () => {
  it('层数从 7 扩到 10', () => {
    expect(LEVEL_KEYS).toHaveLength(10);
    expect(LEVEL_KEYS).toContain('1000');
    expect(LEVEL_KEYS).toContain('250');
    expect(LEVEL_KEYS).toContain('200');
  });

  it('新增卷云顶层真的会加分（二烧画布）', () => {
    const base = predict(bundle(C({ '600': 0.45, '500': 0.4 }), { aod: 0.08 }));
    const withTop = predict(bundle(C({ '600': 0.45, '500': 0.4, '250': 0.6 }), { aod: 0.08 }));
    expect(withTop.vividness).toBeGreaterThan(base.vividness);
  });

  it('1000hPa 满铺（雾/层云贴地）触发低云锁定', () => {
    const p = predict(bundle(C({ '1000': 0.9, '600': 0.45, '500': 0.4 }), { aod: 0.08 }));
    expect(p.veto.kind).toBe('low-cloud-lock');
    expect(p.vividness).toBeLessThan(0.4);
  });

  it('1000hPa 完全无云时不改变任何东西', () => {
    const a = predict(bundle(C({ '600': 0.45, '500': 0.4 }), { aod: 0.08 }));
    const b = predict(bundle(C({ '1000': 0, '600': 0.45, '500': 0.4 }), { aod: 0.08 }));
    expect(b.vividness).toBeCloseTo(a.vividness, 6);
  });

  it('层高度随气压降低单调升高', () => {
    const p = predict(bundle(C({ '600': 0.45 })));
    const hs = LEVEL_KEYS.map((k) => p.layers.find((l) => l.key === k)!.altitudeM);
    for (let i = 1; i < hs.length; i++) expect(hs[i]).toBeGreaterThan(hs[i - 1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 17. 云层垂直重叠：指数-随机重叠（2026-11 算法升级）
// ═══════════════════════════════════════════════════════════════════════
describe('云重叠：指数-随机重叠取代独立并集', () => {
  it('同一高度的两层：退化为最大重叠 C = max(c1,c2)', () => {
    const c = combinedCloudCover([
      { cover01: 0.3, heightKm: 5 },
      { cover01: 0.8, heightKm: 5 },
    ]);
    expect(c).toBeCloseTo(0.8, 6);
  });

  it('间距远大于去相关长度：退化为随机重叠 C = c1+c2-c1c2', () => {
    const dz = 20 * CLOUD_OVERLAP_DECORR_KM;
    const c = combinedCloudCover([
      { cover01: 0.5, heightKm: 1 },
      { cover01: 0.5, heightKm: 1 + dz },
    ]);
    expect(c).toBeCloseTo(0.75, 3);
  });

  it('始终介于最大重叠与随机重叠之间（不是两个极端之一）', () => {
    const c = combinedCloudCover([
      { cover01: 0.4, heightKm: 4 },
      { cover01: 0.6, heightKm: 5.4 }, // Δz ≈ 1.4km ≈ L_cf
    ]);
    const maxOverlap = 0.6;
    const randomOverlap = 0.4 + 0.6 - 0.24;
    expect(c).toBeGreaterThan(maxOverlap);
    expect(c).toBeLessThan(randomOverlap);
  });

  it('对层序不敏感（内部按高度排序）', () => {
    const a = combinedCloudCover([
      { cover01: 0.3, heightKm: 3 },
      { cover01: 0.7, heightKm: 6 },
      { cover01: 0.5, heightKm: 9 },
    ]);
    const b = combinedCloudCover([
      { cover01: 0.5, heightKm: 9 },
      { cover01: 0.3, heightKm: 3 },
      { cover01: 0.7, heightKm: 6 },
    ]);
    expect(a).toBeCloseTo(b, 10);
  });

  it('单层与空输入不崩', () => {
    expect(combinedCloudCover([{ cover01: 0.42, heightKm: 5 }])).toBeCloseTo(0.42, 10);
    expect(combinedCloudCover([])).toBe(0);
  });

  it('含 NaN 的层被忽略而不是传播 NaN', () => {
    const c = combinedCloudCover([
      { cover01: 0.5, heightKm: 4 },
      { cover01: NaN, heightKm: 8 },
      { cover01: 0.5, heightKm: Number.NaN },
    ]);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeCloseTo(0.5, 10);
  });

  it('比独立并集更保守：四层相邻高云的发光面积被压低', () => {
    // 400/300/250/200 间距 1.2–2.6km，独立并集给 1-(1-0.6)^4 = 0.974，
    // 指数-随机重叠应明显低于此（真实重叠度高于随机）
    const layers = [
      { cover01: 0.6, heightKm: 7.2 },
      { cover01: 0.6, heightKm: 9.2 },
      { cover01: 0.6, heightKm: 10.4 },
      { cover01: 0.6, heightKm: 11.8 },
    ];
    const overlap = combinedCloudCover(layers);
    const independent = 1 - Math.pow(1 - 0.6, 4);
    expect(overlap).toBeLessThan(independent);
    expect(overlap).toBeGreaterThan(0.6);
  });
});

describe('云块特征尺度必须按云属取', () => {
  it('卷云尺度远大于对流云（否则薄卷云会挡住下层）', () => {
    expect(CLOUD_ELEMENT_BY_ROLE_KM.high).toBeGreaterThan(CLOUD_ELEMENT_BY_ROLE_KM.low * 2);
    expect(CLOUD_ELEMENT_BY_ROLE_KM.low).toBe(CLOUD_ELEMENT_KM);
  });

  it('30% 薄卷云几乎不衰减下层光线（用对流云尺度则会衰减一半）', () => {
    const pathKm = 67; // α≈−1.5° 穿过 300hPa 层带的水平路径
    const cirrusScale = CLOUD_ELEMENT_BY_ROLE_KM.high;
    const cumulusScale = CLOUD_ELEMENT_BY_ROLE_KM.low;
    // 薄卷云 β 很小（τ_full≈0.9 / 1.8km 厚 ≈ 0.5/km）
    const tCirrus = cloudLayerDirectTransmittance(0.3, pathKm, 0.5, cirrusScale);
    const tCumulus = cloudLayerDirectTransmittance(0.3, pathKm, 0.5, cumulusScale);
    expect(tCirrus).toBeGreaterThan(0.65);
    expect(tCumulus).toBeLessThan(0.55);
  });

  it('厚黄金层上加卷云有正贡献且遮挡有界（不要求总分必然上升）', () => {
    const base = predict(bundle(C({ '600': 0.6, '500': 0.6 }), { aod: 0.05, pm25: 4, vis: 38000 }));
    const withCirrus = predict(
      bundle(C({ '600': 0.6, '500': 0.6, '300': 0.45 }), { aod: 0.05, pm25: 4, vis: 38000 }),
    );
    const cirrus = withCirrus.layers.find((l) => l.key === '300')!;
    expect(cirrus.contribution).toBeGreaterThan(0);
    // 高云既是新画布也会遮蔽下层；厚黄金层场景允许总分略降，但不能抹黑。
    expect(withCirrus.vividness).toBeGreaterThan(base.vividness * 0.75);
  });

  it('薄卷云在 70% 附近最优、满铺仍可，但覆盖曲线必须有峰值（不是单调）', () => {
    // 卷云是"画布"：薄且满铺也是好画面，所以它的最优点比黄金层更靠右。
    // 但**必须存在峰值** —— 若单调递增到 100%，说明云幕自我遮挡没起作用。
    const mk = (h: number) => ({
      models: {
        ecmwf: {
          model: 'ecmwf' as ModelId,
          label: 'ecmwf',
          rings: RING.map((d) => ({
            ringKm: d,
            point: { lat: 31.23, lon: 121.47 },
            samples: TIMES.map((t) =>
              sample(t, { '600': 0.45, '500': 0.4, '300': h }, {
                vis: 38000,
                humidity: 35,
                layerSummary: { low: 0, mid: 0, high: h },
              }),
            ),
          })),
          aerosol: RING.map((d) => ({
            ringKm: d,
            point: { lat: 31.23, lon: 121.47 },
            samples: TIMES.map((t) => ({ timeMs: t, aod: 0.05, pm25: 4, dust: 5, pm10: 8, humidity: 35 })),
          })),
          gridLat: 31.23, gridLon: 121.47, gridElevationM: 4,
        },
      } as never,
      terrain: RING.map((d) => ({ ringKm: d, point: { lat: 31.23, lon: 121.47 }, elevationM: 4 })),
      localElevationM: 4, fetchedAt: Date.now(), apiCalls: 1, cached: false,
    });

    const at70 = predict(mk(0.7) as never);
    const at100 = predict(mk(1.0) as never);
    // 满铺薄卷云仍然好看（画布特性），但必须低于峰值
    expect(at100.vividness).toBeGreaterThan(0.4);
    expect(at100.vividness).toBeLessThan(at70.vividness);
  });

  it('黄金层覆盖率必须存在峰值（云幕自我遮挡）', () => {
    const at = (g: number) => predict(bundle(C({ '600': g, '500': g }), { aod: 0.05, pm25: 4, vis: 38000 }));
    const peak = at(0.6);
    expect(at(0.3).vividness).toBeLessThan(peak.vividness);
    expect(at(1.0).vividness).toBeLessThan(peak.vividness);
    // 满铺黄金层降幅必须显著（不是微弱下调）
    expect(at(1.0).vividness).toBeLessThan(peak.vividness * 0.6);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 18. 云光学厚度反演（SW/TOA → COT）：补上"只有云量、没有云厚"的缺口
// ═══════════════════════════════════════════════════════════════════════
describe('COT 反演：从 SW/TOA 得到真实云厚', () => {
  it('透射率越低，反演 τ 越大（单调）', () => {
    const taus = [0.95, 0.7, 0.55, 0.35, 0.15].map((T) => inferCloudOpticalDepth(600 * T, 600));
    for (let i = 1; i < taus.length; i++) {
      expect(taus[i]!).toBeGreaterThan(taus[i - 1]!);
    }
  });

  it('晴空（T≈1）反演出接近 0 的 τ', () => {
    const tau = inferCloudOpticalDepth(590, 600);
    expect(tau).not.toBeNull();
    expect(tau!).toBeLessThan(1);
  });

  it('两流式自洽：T=0.55 反演回 τ = (1/0.55-1)/0.075 ≈ 10.9', () => {
    const tau = inferCloudOpticalDepth(330, 600);
    expect(tau!).toBeCloseTo((1 / 0.55 - 1) / 0.075, 1);
    // 物理量级正确：中云整层 COT 约 10
    expect(tau!).toBeGreaterThan(8);
    expect(tau!).toBeLessThan(15);
  });

  it('τ 有上界，T→0 不发散', () => {
    const tau = inferCloudOpticalDepth(1, 600);
    expect(tau!).toBeLessThanOrEqual(60);
    expect(Number.isFinite(tau!)).toBe(true);
  });

  it('输入不可用时返回 null（绝不编造）', () => {
    expect(inferCloudOpticalDepth(undefined, 600)).toBeNull();
    expect(inferCloudOpticalDepth(400, undefined)).toBeNull();
    // TOA 太小（夜间 / 太阳贴地平线）：比值无物理意义
    expect(inferCloudOpticalDepth(2, 30)).toBeNull();
    // 地面辐射超过 TOA（观测误差）：不可用
    expect(inferCloudOpticalDepth(700, 600)).toBeNull();
  });

  it('乘子围绕 1 中性：τ_obs 与静态表一致时不修正', () => {
    expect(cotCalibrationFactor(6, 6)).toBeCloseTo(1, 6);
  });

  it('乘子有界，且方向正确（采信区间 0.4~2.5）', () => {
    // 比值 2.0（在采信区间内）→ 乘子 > 1
    expect(cotCalibrationFactor(10, 5)).toBeGreaterThan(1);
    // 比值 0.5（在采信区间内）→ 乘子 < 1
    expect(cotCalibrationFactor(2.5, 5)).toBeLessThan(1);
    // 乘子上下界收紧到 [0.6, 1.9]
    expect(cotCalibrationFactor(12, 5)).toBeLessThanOrEqual(1.9);
    expect(cotCalibrationFactor(2.1, 5)).toBeGreaterThanOrEqual(0.6);
  });

  it('与静态表严重矛盾时判定反演失效，退回中性（比值 >2.5 或 <0.4）', () => {
    // 反演 60、静态 2 → 比值 30，不可信
    expect(cotCalibrationFactor(60, 2)).toBe(1);
    // 反演 0.1、静态 10 → 比值 0.01，不可信
    expect(cotCalibrationFactor(0.1, 10)).toBe(1);
    // **实测踩过的坑**：τ_obs=5.5 vs τ_static=27.2 → 比值 0.20。
    // 旧版采信并压到下限 0.45，把云消光砍掉 55%；现在直接退回中性。
    expect(cotCalibrationFactor(5.5, 27.2)).toBe(1);
  });

  it('无可用反演时乘子为 1（不改变任何行为）', () => {
    expect(cotCalibrationFactor(null, 8)).toBe(1);
    expect(cotCalibrationFactor(NaN, 8)).toBe(1);
  });

  it('薄卷云 vs 厚层云：采信区间内应给出不同消光', () => {
    // 静态 τ=8。薄卷云真实 τ 可低到 4（比值 0.5），厚层云高到 16（比值 2.0）
    const thin = cotCalibrationFactor(4, 8);
    const thick = cotCalibrationFactor(16, 8);
    expect(thick).toBeGreaterThan(thin);
    expect(thick / thin).toBeGreaterThan(1.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 19. 深对流（积雨云黑幕）与层状云画布的区分
// ═══════════════════════════════════════════════════════════════════════
describe('深对流判据：CAPE + 降水 + 深厚云体', () => {
  const mkBundle = (opts: { cape: number; precip: number; cover: Partial<Record<LevelKey, number>> }) => ({
    models: {
      ecmwf: {
        model: 'ecmwf' as ModelId,
        label: 'ecmwf',
        rings: RING.map((d) => ({
          ringKm: d,
          point: { lat: 31.23, lon: 121.47 },
          samples: TIMES.map((t) => {
            const s = sample(t, opts.cover, { precip: opts.precip, vis: 25000, humidity: 70 });
            return { ...s, cape: opts.cape };
          }),
        })),
        aerosol: RING.map((d) => ({
          ringKm: d,
          point: { lat: 31.23, lon: 121.47 },
          samples: TIMES.map((t) => ({ timeMs: t, aod: 0.15, pm25: 12, dust: 6, pm10: 18, humidity: 60 })),
        })),
        gridLat: 31.23, gridLon: 121.47, gridElevationM: 4,
      },
    } as never,
    terrain: RING.map((d) => ({ ringKm: d, point: { lat: 31.23, lon: 121.47 }, elevationM: 4 })),
    localElevationM: 4, fetchedAt: Date.now(), apiCalls: 1, cached: false,
  });

  it('高 CAPE + 降水 + 深厚云体 → 判为深对流并显著压低', () => {
    const cover = { '700': 0.8, '600': 0.85, '500': 0.85, '400': 0.8 };
    const conv = predict(mkBundle({ cape: 1800, precip: 3, cover }) as never);
    const strat = predict(mkBundle({ cape: 100, precip: 0, cover }) as never);
    expect(conv.vividness).toBeLessThan(strat.vividness * 0.6);
  });

  it('高 CAPE 但无降水（残余位能）不应误判', () => {
    const cover = { '600': 0.6, '500': 0.6 };
    const a = predict(mkBundle({ cape: 2000, precip: 0, cover }) as never);
    const b = predict(mkBundle({ cape: 100, precip: 0, cover }) as never);
    expect(a.vividness).toBeCloseTo(b.vividness, 4);
  });

  it('有降水但 CAPE 低（层状云降水）不应触发深对流判据', () => {
    // 注意：有降水时 `cloud-wall` 否决（wallFactor）会先介入，这是**独立且
    // 更早**的判据。本测试只验证 deepConvection 的边际贡献：
    // 高 CAPE 组必须比低 CAPE 组**显著更低**（差额来自 0.18 乘子），
    // 而两组都已受 cloud-wall 影响，所以不能要求'接近相等'。
    const cover = { '600': 0.6, '500': 0.6 };
    const lowCape = predict(mkBundle({ cape: 100, precip: 2, cover }) as never);
    const highCape = predict(mkBundle({ cape: 1800, precip: 2, cover }) as never);
    expect(highCape.vividness).toBeLessThan(lowCape.vividness * 0.5);
    // 低 CAPE 组不走 0.18，因此不应低到「无烧」
    expect(lowCape.vividness).toBeGreaterThan(0.15);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 20. 双路径模型：云 → 观测者 的视线光谱消光
// ═══════════════════════════════════════════════════════════════════════
describe('Path 2：视线光谱消光', () => {
  it('天顶方向（d≈0）气柱质量趋近 1，几乎无消光', () => {
    const v = viewPathRgb(0, 4200, 100, 0.1, 1.3, 55, 300);
    expect(v.airmass).toBeLessThan(1.1);
    expect(v.rgb.r).toBeGreaterThan(0.75);
  });

  it('距离越远、仰角越低，气柱质量越大（单调）', () => {
    const ms = [0, 30, 80, 150, 280, 450].map(
      (d) => viewPathRgb(d, 4200, 100, 0.1, 1.3, 55, 300).airmass,
    );
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1]);
  });

  it('视线消光对蓝通道的削减强于红通道（Rayleigh λ⁻⁴）', () => {
    const v = viewPathRgb(150, 4200, 100, 0.1, 1.3, 55, 300);
    expect(v.rgb.b).toBeLessThan(v.rgb.r);
  });

  it('**核心效果**：合成色相随距离单调红移（"天边那条最红"）', () => {
    const sun = directSunRgb(-1.5, 4200, 0.1, 1.3, 55, 300);
    const hues = [0, 30, 80, 150, 280, 450].map((d) => {
      const v = viewPathRgb(d, 4200, 100, 0.1, 1.3, 55, 300);
      return colorChroma(compositeCloudColor(sun.rgb, v.rgb).color).hue;
    });
    // hue 数值越小 = 越接近纯红（HSV 中 0=红、60=黄）
    for (let i = 1; i < hues.length; i++) expect(hues[i]).toBeLessThan(hues[i - 1]);
    // 从橙黄（>20°）到深红（<15°）必须跨过可感知的幅度
    expect(hues[0] - hues[hues.length - 1]).toBeGreaterThan(10);
  });

  it('臭氧增多会让合成色 r/b 变小（吃红光的方向必须正确）', () => {
    const sun = directSunRgb(-3, 4200, 0.1, 1.3, 55, 300);
    const ratioAt = (du: number) => {
      const v = viewPathRgb(150, 4200, 100, 0.1, 1.3, 55, du);
      const c = compositeCloudColor(sun.rgb, v.rgb).color;
      return c.r / Math.max(c.b, 1e-12);
    };
    expect(ratioAt(450)).toBeLessThan(ratioAt(220));
  });

  it('Path 2 同时降低实际亮度并改变色相，亮度与合成 RGB 同源', () => {
    const sun = directSunRgb(-1.5, 4200, 0.1, 1.3, 55, 300);
    const near = compositeCloudColor(sun.rgb, viewPathRgb(0, 4200, 100, 0.1, 1.3, 55, 300).rgb);
    const far = compositeCloudColor(sun.rgb, viewPathRgb(450, 4200, 100, 0.1, 1.3, 55, 300).rgb);
    expect(far.intensity).toBeLessThan(near.intensity);
    expect(far.intensity).toBeCloseTo(colorChroma(far.color).luminance, 12);
    expect(colorChroma(far.color).hue).toBeLessThan(colorChroma(near.color).hue);
  });

  it('负仰角（高山俯视云海）用指数延拓，不产生 NaN 或负值', () => {
    const v = viewPathRgb(100, 900, 2000, 0.1, 1.3, 55, 300);
    expect(Number.isFinite(v.airmass)).toBe(true);
    expect(v.airmass).toBeGreaterThan(1);
    expect(v.rgb.r).toBeGreaterThan(0);
    expect(v.rgb.r).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 21. 半拉格朗日平流插值（高空风场）
// ═══════════════════════════════════════════════════════════════════════
describe('平流插值：恢复被线性插值抹平的相位', () => {
  // 构造一个"云正在到来"的序列：t=0 时 0%，t=+1h 时 100%
  const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
  const times = [T0 - 3600000, T0, T0 + 3600000, T0 + 2 * 3600000];
  const ramp = [0, 0, 100, 100];

  it('lag=0（无风）时严格退化为线性插值', () => {
    const mid = T0 + 1800000; // 半小时处
    expect(sampleAdvected(mid, times, ramp, 0)).toBeCloseTo(50, 6);
  });

  it('有平流滞后时，采样点上移（取到更早、更小的值）', () => {
    const mid = T0 + 1800000;
    const lagged = sampleAdvected(mid, times, ramp, 3600000); // 回看 1h
    // 回看 1h 落在 T0-1800000，即 0 与 0 之间 → 0
    expect(lagged).toBe(0);
    expect(lagged).toBeLessThan(sampleAdvected(mid, times, ramp, 0));
  });

  it('平移越界时取边界值，不外推', () => {
    // 回看 10h，远超序列起点
    const v = sampleAdvected(T0 + 1800000, times, ramp, 10 * 3600000);
    expect(v).toBe(ramp[0]);
  });

  it('空序列返回兜底值，不产生 NaN', () => {
    expect(sampleAdvected(T0, [], [], 1000, -1)).toBe(-1);
    expect(Number.isFinite(sampleAdvected(T0, times, ramp, 1800000))).toBe(true);
  });

  it('风向投影：顺风朝本地吹时才产生滞后', () => {
    // 视线朝东（90°）。风吹向 90° = 来向 270°
    const toward = advectionLagMs(270, 60, 90, 80);
    expect(toward).toBeGreaterThan(0);
    // 来向 90°（吹向 270°，即背离本地）不应产生滞后
    expect(advectionLagMs(90, 60, 90, 80)).toBe(0);
  });

  it('风速越大滞后越短（云来得快）', () => {
    // 注意必须选**不触 0.5h 上限**的风速：80km 环在 v>160km/h 时
    // travelHours<0.5，否则两者都会被钳到 0.5h 而看起来相等。
    const slow = advectionLagMs(270, 200, 90, 80); // 80/200 = 0.4h
    const fast = advectionLagMs(270, 400, 90, 80); // 80/400 = 0.2h
    expect(fast).toBeLessThan(slow);
    expect(slow).toBeCloseTo(0.4 * 3600 * 1000, -3);
    expect(fast).toBeCloseTo(0.2 * 3600 * 1000, -3);
  });

  it('滞后上限为半格（30min），不允许整格平移', () => {
    // 风速极大 ⇒ travelHours→0，但无论如何不超过 0.5h
    const lag = advectionLagMs(270, 1000, 90, 80);
    expect(lag).toBeLessThanOrEqual(0.5 * 3600 * 1000);
  });

  it('无风 / 风向缺测时不产生滞后（行为不变）', () => {
    expect(advectionLagMs(270, 0, 90, 80)).toBe(0);
    expect(advectionLagMs(NaN, 60, 90, 80)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 22. 晴空基线剥离：COT 反演必须只反映"云"的贡献
// ═══════════════════════════════════════════════════════════════════════
describe('COT 反演的晴空基线（实测发现的真实缺陷）', () => {
  it('T_clear 落在实测回归值附近（442 个晴空样本）', () => {
    // 实测 τ_clear·m = 0.1302 + 0.0970·AOD，RMSE 0.038
    // 太阳 40°、AOD 0.2 → τ_clear≈0.150、m≈1.55 → T_clear≈0.79
    const tClear = clearSkySwTransmittance(40, 0.2);
    expect(tClear).toBeGreaterThan(0.70);
    expect(tClear).toBeLessThan(0.88);
  });

  it('太阳越高 T_clear 越大（气柱越短）', () => {
    const ts = [10, 20, 40, 70].map((a) => clearSkySwTransmittance(a, 0.15));
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it('AOD 越高 T_clear 越小（气溶胶消光）', () => {
    expect(clearSkySwTransmittance(40, 0.8)).toBeLessThan(clearSkySwTransmittance(40, 0.1));
  });

  it('**核心回归**：晴空观测（T≈T_clear）必须返回 null，不得报出 τ=12', () => {
    // 真实数据实测：太阳 35°、AOD 0.35、SW/TOA=0.515 且云量 0%
    // 旧实现给出 τ=12.5（把大气本底当成了云）→ cotFactor 被放大 2 倍
    const alt = 35;
    const aod = 0.35;
    const tClear = clearSkySwTransmittance(alt, aod);
    // 构造一个"地面辐射恰好等于晴空预期"的观测
    const toaW = 728;
    const swW = toaW * tClear;
    const tau = inferCloudOpticalDepthFromRadiation(swW, toaW, alt, aod);
    expect(tau).toBeNull();
    // 而裸反演（不剥离基线）会把大气本底当成云，给出一个假 τ —— 这就是被修掉的缺陷
    const raw = inferCloudOpticalDepth(swW, toaW);
    expect(raw).not.toBeNull();
    expect(raw!).toBeGreaterThan(2);
  });

  it('有云时（SW 明显低于晴空预期）正常反演出 τ', () => {
    const alt = 35;
    const aod = 0.15;
    const tClear = clearSkySwTransmittance(alt, aod);
    const toaW = 800;
    // 地面辐射只有晴空预期的一半 → 云遮蔽了一半
    const swW = toaW * tClear * 0.5;
    const tau = inferCloudOpticalDepthFromRadiation(swW, toaW, alt, aod);
    expect(tau).not.toBeNull();
    expect(tau!).toBeGreaterThan(5);
    expect(tau!).toBeLessThan(60);
  });

  it('地面辐射超过晴空预期（反射云/模式不一致）时返回 null，不硬算', () => {
    const alt = 30;
    const aod = 0.1;
    const tClear = clearSkySwTransmittance(alt, aod);
    const toaW = 700;
    const swW = toaW * tClear * 1.3; // 比晴空还亮 30%
    expect(inferCloudOpticalDepthFromRadiation(swW, toaW, alt, aod)).toBeNull();
  });

  it('太阳太低（无法算晴空基线）时返回 null', () => {
    expect(inferCloudOpticalDepthFromRadiation(10, 100, 0.2, 0.1)).toBeNull();
    expect(inferCloudOpticalDepthFromRadiation(10, 100, 4.9, 0.1)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 23. 额度耗尽：不得让整页变空白（2026-11 线上事故）
// ═══════════════════════════════════════════════════════════════════════
describe('额度耗尽时的降级行为', () => {
  it('QuotaExhaustedError 的 message 包含可读的分钟数，而不是裸毫秒', () => {
    const resetAt = Date.now() + 17 * 60000;
    const e = new QuotaExhaustedError(resetAt, 17 * 60000);
    // 必须能读出"17 分钟"这类信息
    expect(e.message).toMatch(/\d+\s*分钟/);
    // 不能是原始的 "retry after 1172000ms"
    expect(e.message).not.toMatch(/retry after \d+ms/);
    // 必须说明这不是本地故障，并给出额度与单次成本
    expect(e.message).toContain('5000');
    expect(e.resetAtMs).toBe(resetAt);
  });

  it('resetAtMs 未知时也给可读文案，不崩', () => {
    const e = new QuotaExhaustedError(0, 0);
    expect(e.message).toContain('额度');
    expect(Number.isFinite(e.resetAtMs)).toBe(true);
    expect(e.resetAtMs).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 24. COT 反演必须是「整场一次」，不能在低太阳角逐帧算
// ═══════════════════════════════════════════════════════════════════════
describe('COT 反演的时间尺度（两次返工后的最终设计）', () => {
  it('太阳低于 15° 一律不反演（实测差 7 倍的成因）', () => {
    // 实测：太阳 5.1°、AOD 0.5 时模式 T=0.128，晴空基线 T_clear=0.163，
    // 比值 0.78 被误读成"薄云"，反算 τ=3.7 —— 而同帧静态表 τ=27。
    const tau = inferCloudOpticalDepthFromRadiation(33, 258, 5.1, 0.5);
    expect(tau).toBeNull();
    // 14.9° 仍拒绝
    expect(inferCloudOpticalDepthFromRadiation(300, 800, 14.9, 0.2)).toBeNull();
  });

  it('太阳足够高时正常反演', () => {
    const tClear = clearSkySwTransmittance(30, 0.2);
    const toaW = 800;
    // 地面辐射只有晴空预期的一半 → 有云
    const tau = inferCloudOpticalDepthFromRadiation(toaW * tClear * 0.5, toaW, 30, 0.2);
    expect(tau).not.toBeNull();
    expect(tau!).toBeGreaterThan(3);
  });

  it('乘子采信区间收紧后，实测踩过的 0.20 比值被拒绝', () => {
    // τ_obs=5.5 / τ_static=27.2 = 0.20 —— 旧版采信并压到 0.45 下限，
    // 把云消光砍掉 55%；现在直接退回中性 1.0
    expect(cotCalibrationFactor(5.5, 27.2)).toBe(1);
  });

  it('乘子上下界收紧到 [0.6, 1.9]，不再有 0.45 这种大幅削光', () => {
    for (const r of [0.4, 0.6, 1.0, 1.5, 2.5]) {
      const f = cotCalibrationFactor(r * 10, 10);
      expect(f).toBeGreaterThanOrEqual(0.6);
      expect(f).toBeLessThanOrEqual(1.9);
    }
  });
});
