import { describe, expect, it } from 'vitest';
import {
  compassLabel,
  parseVerticalCloudProfile,
  predictSunset,
  rayMarchingTransmittance,
} from '../src/engine/SunsetPhysicsEngine';
import { evaluateSpectral } from '../src/engine/spectral';
import { LEVEL_KEYS } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import type { ForecastBundle, ModelId } from '../src/engine/types';
import { buildScenario, type Scenario } from './calibrationScenarios';

const EVENT = Date.UTC(2026, 10, 3, 9, 5);
const FLAT = [4, 4, 4, 4, 4, 4];
const scenario = (patch: Partial<Scenario>): Scenario => ({
  name: 'audit', cover: {}, expect: [0, 2], ...patch,
});

function predict(bundle: ForecastBundle, primaryModel: ModelId = 'ecmwf', compareModels: ModelId[] = ['ecmwf']) {
  return predictSunset({
    point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
    bundle, primaryModel, timezoneOffsetSeconds: 28800, timezone: 'Asia/Shanghai',
    locationLabel: 'audit', eventMs: EVENT,
    daily: { sunriseMs: null, sunsetMs: EVENT }, compareModels,
  });
}

describe('审查修复：光路生产不变量', () => {
  it('空环数据返回有限零结果、零完整度和零置信度', () => {
    const b = buildScenario(scenario({ cover: { '600': 0.5 } }));
    b.models.ecmwf.rings = [];
    const p = predict(b);
    expect(Number.isFinite(p.vividness)).toBe(true);
    expect(p.vividness).toBe(0);
    expect(p.rings).toEqual([]);
    expect(p.completeness).toBe(0);
    expect(p.confidence).toBe(0);
    expect(p.modelAgreement).toBe(0);
  });

  it('地形切断后所有逐层透过率都归零', () => {
    const b = buildScenario(scenario({
      cover: { '600': 0.5, '500': 0.45 },
      terrain: [4, 4000, 3400, 2800, 4200, 5000],
    }));
    const profile = parseVerticalCloudProfile(b, 'ecmwf', EVENT);
    // 固定 α，避免峰值前移改变测试几何：30km 光路约 3939m < 4000m。
    const ray = rayMarchingTransmittance(4200, -0.614, profile.rings, b.terrain.map((t) => t.elevationM));
    expect(ray.blockedAtKm).not.toBeNull();
    expect(ray.blockedAtKm!).toBeLessThanOrEqual(30);
    for (const k of LEVEL_KEYS) expect(ray.perLevelTransmittance[k]).toBe(0);
  });

  it('80km 云墙只遮挡其背阴侧光路，不影响更向阳的 150km 云块', () => {
    const clear = buildScenario(scenario({ cover: { '600': 0.5 } }));
    const wall = buildScenario(scenario({
      cover: { '600': 0.5 },
      coverAt: (i) => ({ '600': 0.5, ...(i === 2 ? { '700': 1 } : {}) }),
    }));
    const clearProfile = parseVerticalCloudProfile(clear, 'ecmwf', EVENT);
    const wallProfile = parseVerticalCloudProfile(wall, 'ecmwf', EVENT);
    const localClear = rayMarchingTransmittance(4200, -1.5, clearProfile.rings, FLAT);
    const localWall = rayMarchingTransmittance(4200, -1.5, wallProfile.rings, FLAT);
    expect(localWall.perLevelTransmittance['600']).toBeLessThan(localClear.perLevelTransmittance['600'] * 0.8);

    // 从 150km 云块重定基后，80km 墙位于观测者侧，不在太阳来光方向。
    const farClear = rayMarchingTransmittance(4200, -1.5, clearProfile.rings.slice(3), FLAT.slice(3));
    const farWall = rayMarchingTransmittance(4200, -1.5, wallProfile.rings.slice(3), FLAT.slice(3));
    expect(farWall.perLevelTransmittance['600']).toBeCloseTo(farClear.perLevelTransmittance['600'], 10);
  });

  it('自身消光采用云中点照明，include/exclude 对照严格符合 exp(-τ/2)', () => {
    const b = buildScenario(scenario({ cover: { '600': 1 } }));
    const profile = parseVerticalCloudProfile(b, 'ecmwf', EVENT);
    const withSelf = rayMarchingTransmittance(4200, 0, profile.rings, FLAT);
    const withoutSelf = rayMarchingTransmittance(4200, 0, profile.rings, FLAT, { includeSelfExtinction: false });
    expect(withSelf.opticalDepth).toBeGreaterThan(1);
    expect(withSelf.directTransmittance).toBeLessThan(withoutSelf.directTransmittance);
    expect(withSelf.directTransmittance).toBeCloseTo(
      withoutSelf.directTransmittance * Math.exp(-0.5 * withSelf.opticalDepth), 10,
    );
    expect(withSelf.transmittance).toBeGreaterThan(withSelf.directTransmittance);
  });
});

describe('审查修复：缺测与模型一致性', () => {
  it('全 null 云量不是晴空，完整度、置信度和模型一致性都为 0', () => {
    const b = buildScenario(scenario({ cover: { '600': 0.5 } }));
    for (const ring of b.models.ecmwf.rings) {
      for (const s of ring.samples) {
        const valid = {} as NonNullable<typeof s.cloudValid>;
        for (const k of LEVEL_KEYS) {
          s.cloud[k] = Number.NaN;
          valid[k] = false;
        }
        s.cloudValid = valid;
      }
    }
    const profile = parseVerticalCloudProfile(b, 'ecmwf', EVENT);
    const p = predict(b);
    expect(profile.clearSky).toBe(false);
    expect(p.completeness).toBe(0);
    expect(p.confidence).toBe(0);
    expect(p.modelAgreement).toBe(0);
    expect(Number.isFinite(p.vividness)).toBe(true);
  });

  it('只有一个合格模型时一致性为中性 0.5，而不是伪造 100%', () => {
    const p = predict(buildScenario(scenario({ cover: { '600': 0.5 } })));
    expect(p.modelAgreement).toBe(0.5);
  });

  it('含不同 COT 辐射场与地形时，切换主源不改变各模型自身峰值', () => {
    const a = buildScenario(scenario({
      cover: { '600': 0.45, '500': 0.4 }, terrain: [4, 6000, 3400, 2800, 4200, 5000],
    }), 'ecmwf');
    const g = buildScenario(scenario({
      cover: { '600': 0.7, '500': 0.6, '300': 0.5 }, terrain: [4, 6000, 3400, 2800, 4200, 5000],
    }), 'gfs');
    a.models.gfs = g.models.gfs;
    for (const [m, sw] of [['ecmwf', 240], ['gfs', 420]] as const) {
      for (const ring of a.models[m].rings) {
        for (const s of ring.samples) {
          s.shortwaveRadiation = sw;
          s.terrestrialRadiation = 800;
        }
      }
    }
    const asA = predict(a, 'ecmwf', ['ecmwf', 'gfs']);
    const asG = predict(a, 'gfs', ['ecmwf', 'gfs']);
    for (const m of ['ecmwf', 'gfs'] as const) {
      expect(asA.modelPeaks.find((x) => x.model === m)!.peakVividness).toBeCloseTo(
        asG.modelPeaks.find((x) => x.model === m)!.peakVividness, 10,
      );
    }
  });
});

describe('审查修复：线上实跑暴露的语义混用', () => {
  // 线上实测（上海 · 外滩 2026-11-15）：页面同时出现
  // 「仍在云底 10643m 之下」与「低云底约 811m」—— 同一卡片两个数字互相矛盾。
  // 根因：`cloudBaseM` 是「≥20% 覆盖的最低一层」，晴天只剩卷云时它是 10.6km，
  // 但被当成「低云底」用于模拟器状态提示。
  it('cloudBaseM 是任意层最低云底，不是低云底', () => {
    const b = buildScenario(scenario({ cover: { '250': 1.0 } }));
    const profile = parseVerticalCloudProfile(b, 'ecmwf', EVENT);
    // 只有 250hPa 卷云：cloudBaseM 等于卷云高度（约 10.4km）
    expect(profile.cloudBaseM).toBeGreaterThan(9000);
    // 低云（925/850）此时根本没有云 —— 两者语义必须能区分开
    expect(profile.local.cover['925']).toBe(0);
    expect(profile.local.cover['850']).toBe(0);
  });

  // 线上实测同一屏：页首环形图显示「置信度 74」，tooltip 却写
  // 「完整度 100% × (1 − 0.55·分歧 38%)」= 79%，两者反算不回去。
  // 根因：UI 把 `uncertainty`（= 0.8·分歧 + 0.6·数据缺失）当作分歧度展示，
  // 而置信度公式里乘的是纯分歧度。
  it('置信度必须能由 modelDisagreement 反算回来', () => {
    const a = buildScenario(scenario({ cover: { '600': 0.45, '500': 0.4 } }), 'ecmwf');
    const g = buildScenario(scenario({ cover: { '600': 0.95, '500': 0.9, '400': 0.9 } }), 'gfs');
    a.models.gfs = g.models.gfs;
    const p = predict(a, 'ecmwf', ['ecmwf', 'gfs']);

    // 综合不确定性 = 0.8·分歧 + 0.6·(1−完整度)，是另一种量
    expect(p.modelDisagreement).toBeGreaterThan(0.2);
    expect(p.uncertainty).not.toBeCloseTo(p.modelDisagreement, 3);
    // 置信度只由完整度与纯分歧决定
    expect(p.confidence).toBeCloseTo(
      Math.min(0.97, p.completeness * (1 - 0.55 * p.modelDisagreement)),
      10,
    );
    // 单模型场景：没有可比对象 → 分歧为 0，但一致性是中性的 0.5
    const solo = predict(buildScenario(scenario({ cover: { '600': 0.5 } })));
    expect(solo.modelDisagreement).toBe(0);
    expect(solo.modelAgreement).toBe(0.5);
  });

  // 模型不可比（云量完整度不足）时不得把缺测模型的峰值算进分歧 ——
  // 那是"没数据"，不是"模型打架"。
  it('云量完整度不足的模型不参与分歧统计', () => {
    const b = buildScenario(scenario({ cover: { '600': 0.45 } }));
    const g = buildScenario(scenario({ cover: { '600': 0.95, '500': 0.9 } }), 'gfs');
    b.models.gfs = g.models.gfs;
    for (const ring of b.models.gfs.rings) {
      for (const s of ring.samples) {
        const valid = {} as NonNullable<typeof s.cloudValid>;
        for (const k of LEVEL_KEYS) valid[k] = false;
        s.cloudValid = valid;
      }
    }
    const p = predict(b, 'ecmwf', ['ecmwf', 'gfs']);
    // 只剩一个可比模型 → 分歧 0（而不是把"gfs 全缺测"当成巨大分歧）
    expect(p.modelDisagreement).toBe(0);
    // 但完整度确实因为 gfs 缺测而下降
    expect(p.completeness).toBeLessThan(1);
  });
});

describe('审查修复：连续光谱与方位边界', () => {
  it('真实 AOD=0 是洁净数据而不是缺测或数值异常', () => {
    const s = evaluateSpectral(0, 6, 4, 42, 32, true, 20);
    expect(s.available).toBe(true);
    expect(s.crystal).toBe(true);
    expect(Number.isFinite(s.saturationGain)).toBe(true);
    expect(s.saturationGain).toBeGreaterThan(1);
  });

  it('AOD 0.18 / 0.28 / 0.8 与 RH80 两侧的数值输出连续', () => {
    for (const x of [0.18, 0.28, 0.8]) {
      const before = evaluateSpectral(x - 1e-6, 20, 8, 60, 20, true, 20);
      const after = evaluateSpectral(x + 1e-6, 20, 8, 60, 20, true, 20);
      expect(Math.abs(after.saturationGain - before.saturationGain)).toBeLessThan(1e-5);
      expect(Math.abs(after.hazePenalty - before.hazePenalty)).toBeLessThan(1e-5);
    }
    const before = evaluateSpectral(0.65, 100, 8, 80 - 1e-6, 20, true, 20);
    const after = evaluateSpectral(0.65, 100, 8, 80 + 1e-6, 20, true, 20);
    expect(Math.abs(after.saturationGain - before.saturationGain)).toBeLessThan(1e-5);
    expect(Math.abs(after.hazePenalty - before.hazePenalty)).toBeLessThan(1e-5);
  });

  it('359° 与 1° 都归入北向，不出现负索引或 NaN', () => {
    expect(compassLabel(359)).toMatch(/^北 /);
    expect(compassLabel(1)).toMatch(/^北 /);
    expect(compassLabel(359)).not.toContain('NaN');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 第四轮审查（针对 3fafd82）
// ═══════════════════════════════════════════════════════════════════════

describe('审查修复：NEW-01 散射天窗必须计入本层云幕', () => {
  /** 单层满铺：整条光路都被同一个云幕占据 */
  const singleDeck = (cover: number) => {
    const rings = [0, 30, 80, 150, 280, 450].map((ringKm) => {
      const c = {} as Record<LevelKey, number>;
      const h = {} as Record<LevelKey, number>;
      const vis = {} as Record<LevelKey, boolean>;
      const filler = {} as Record<LevelKey, number>;
      for (const k of LEVEL_KEYS) {
        c[k] = k === '600' ? cover : 0;
        h[k] = { '1000': 110, '925': 780, '850': 1500, '700': 3000, '600': 4200, '500': 5500, '400': 7200, '300': 9200, '250': 10400, '200': 11800 }[k];
        vis[k] = true;
        filler[k] = h[k];
      }
      return {
        ringKm, point: { lat: 31.23, lon: 121.47 },
        sample: {
          timeMs: EVENT, cloud: c, levelHeightM: filler, levelTempC: {},
          cloudLow: 0, cloudMid: 0, cloudHigh: 0, cloudTotal: 0,
          precipitation: 0, humidity: 60, visibilityM: 25000, surfacePressureHpa: 1013,
        },
        cover: Object.fromEntries(LEVEL_KEYS.map((k) => [k, k === '600' ? cover : 0])) as Record<LevelKey, number>,
        heightM: filler, tempC: {}, rh: {}, visible: vis,
      };
    });
    return rings;
  };

  it('100% 满铺密云的天窗必须闭合（不能靠散射把光原样补回）', () => {
    const r = rayMarchingTransmittance(4200, -1.5, singleDeck(1.0), FLAT);
    // 上一版：直射 τ≈20 已完全不透明，有效照明度却仍有 0.857
    expect(r.perLevelTransmittance['600']).toBeLessThan(0.2);
  });

  it('破碎黄金层（40%）仍应是一块明亮的画布', () => {
    const r = rayMarchingTransmittance(4200, -1.5, singleDeck(0.4), FLAT);
    expect(r.perLevelTransmittance['600']).toBeGreaterThan(0.8);
  });

  it('云幕封堵随覆盖率单调（满铺必然比破碎暗）', () => {
    const lo = rayMarchingTransmittance(4200, -1.5, singleDeck(0.6), FLAT).perLevelTransmittance['600'];
    const hi = rayMarchingTransmittance(4200, -1.5, singleDeck(0.95), FLAT).perLevelTransmittance['600'];
    expect(hi).toBeLessThan(lo);
  });

  it('上层的薄卷云不得被当成不透明遮板（原 `1−c` 的错误）', () => {
    // 黄金层 45% + 满铺卷云：卷云是画布，不该把黄金层压黑
    const a = predict(buildScenario(scenario({ cover: { '600': 0.45, '500': 0.4 } })));
    const b = predict(buildScenario(scenario({ cover: { '600': 0.45, '500': 0.4, '300': 0.9 } })));
    expect(b.vividness).toBeGreaterThan(a.vividness * 0.85);
  });
});

describe('审查修复：NEW-03 朝霞 COT 参考时刻必须用辐射窗口中点', () => {
  /**
   * 朝霞与晚霞在对称天气下应给出**对称**的 COT 标定。
   *
   * 上一版 `alt: Math.max(bestAlt, midAlt)` 在朝霞侧锁死偏高的 bestAlt
   * （实测高估 2.7–5.0°），使 T_clear 偏大、COT 偏大、透光的朝霞云被判成黑云。
   */
  const cotFor = (mode: 'sunrise' | 'sunset'): number => {
    const cover = { '600': 0.5, '500': 0.45 } as Partial<Record<LevelKey, number>>;
    const b = buildScenario(scenario({ cover }), 'ecmwf');
    // 同一片大气、同一 AOD 与辐射：把日出/日落事件放在对称时刻，
    // 引擎应按各自 mode 找到太阳高度角相近的参考时刻。
    const isSunrise = mode === 'sunrise';
    const eventMs = isSunrise ? Date.UTC(2026, 10, 3, 22, 40) : Date.UTC(2026, 10, 3, 9, 5);
    const p = predictSunset({
      point: { lat: 31.23, lon: 121.47 }, mode, observerHeightM: 0,
      bundle: b, primaryModel: 'ecmwf', timezoneOffsetSeconds: 28800, timezone: 'Asia/Shanghai',
      locationLabel: 'audit', eventMs,
      daily: isSunrise
        ? { sunriseMs: eventMs, sunsetMs: null }
        : { sunriseMs: null, sunsetMs: eventMs },
      compareModels: ['ecmwf'],
    });
    const golden = p.layers.find((l) => l.key === '600');
    return golden?.transmittance ?? -1;
  };

  it('朝霞的黄金层受光不被系统性判死', () => {
    // 上一版朝霞 COT 高估 ⇒ 黄金层透过率被压到远低于晚霞
    const rise = cotFor('sunrise');
    const set = cotFor('sunset');
    expect(rise).toBeGreaterThan(0);
    // 对称大气下两者应在同一量级（不要求相等：真实太阳路径并不对称）
    expect(rise).toBeGreaterThan(set * 0.5);
  });
});

describe('审查修复：NEW-02 远端外推的注释必须与实现一致', () => {
  it('末尾环的上游不会变成虚构晴空（环透过率随距离单调不增）', () => {
    const p = predict(buildScenario(scenario({ cover: { '700': 0.4, '600': 0.5 } })));
    const vis = p.rings.filter((r) => !r.terrainBlocked);
    for (let i = 1; i < vis.length; i++) {
      expect(vis[i].transmittance).toBeLessThanOrEqual(vis[i - 1].transmittance + 1e-9);
    }
  });
});
