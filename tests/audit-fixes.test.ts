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
