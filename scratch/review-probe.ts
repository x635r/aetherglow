/**
 * 审查复核探针：验证审查结论中可复现的数值断言。
 * 运行：npx tsx scratch/review-probe.ts
 */
import { rayMarchingTransmittance, type ProfileRing } from '../src/engine/SunsetPhysicsEngine';
import { evaluateSpectral } from '../src/engine/spectral';
import { LEVEL_KEYS, LEVEL_BY_KEY } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import type { HourlySample } from '../src/engine/types';

const mkCloud = (v: number) =>
  Object.fromEntries(LEVEL_KEYS.map((k) => [k, v])) as Record<LevelKey, number>;

function mkRing(ringKm: number, cloudCover: Record<LevelKey, number>): ProfileRing {
  const sample = {
    timeMs: 0,
    cloud: Object.fromEntries(LEVEL_KEYS.map((k) => [k, cloudCover[k] * 100])) as Record<LevelKey, number>,
    levelHeightM: Object.fromEntries(LEVEL_KEYS.map((k) => [k, LEVEL_BY_KEY[k].nominalM])) as Record<LevelKey, number>,
    levelTempC: {},
    cloudLow: 0, cloudMid: 0, cloudHigh: 0, cloudTotal: 0,
    precipitation: 0, humidity: 55, visibilityM: 25000, surfacePressureHpa: 1013.25,
  } as HourlySample;
  return {
    ringKm,
    point: { lat: 31, lon: 121 },
    sample,
    cover: cloudCover,
    heightM: Object.fromEntries(LEVEL_KEYS.map((k) => [k, LEVEL_BY_KEY[k].nominalM])) as Record<LevelKey, number>,
    tempC: {},
    rh: {},
    visible: Object.fromEntries(LEVEL_KEYS.map((k) => [k, true])) as Record<LevelKey, boolean>,
  };
}

// ── 探针 1（P0-2）：满铺 600hPa 云、α=0°，目标层自身 τ>0 但透过率=1 ──
{
  const cover = mkCloud(0);
  cover['600'] = 1;
  const rings = [0, 30, 80, 150, 280, 450].map((d) => mkRing(d, cover));
  const ray = rayMarchingTransmittance(4200, 0, rings, [0, 0, 0, 0, 0, 0]);
  console.log('[P0-2] 满铺600hPa α=0°:',
    'selfPathKm=', ray.perLevelPathKm['600'].toFixed(2),
    'opticalDepth=', ray.opticalDepth.toFixed(2),
    'T600=', ray.perLevelTransmittance['600'].toFixed(4),
    'directT=', ray.directTransmittance.toFixed(4));
}

// ── 探针 2（P1 光谱）：AOD 0.8 处硬跳变 ──
{
  const a = evaluateSpectral(0.8, 20, 10, 55, 22, true);
  const b = evaluateSpectral(0.800001, 20, 10, 55, 22, true);
  console.log('[P1-光谱] AOD 0.8→0.800001 hazePenalty:', a.hazePenalty.toFixed(6), '→', b.hazePenalty.toFixed(6));
  const c = evaluateSpectral(0, 20, 10, 55, 22, true);
  const d = evaluateSpectral(0.000001, 20, 10, 55, 22, true);
  console.log('[P1-光谱] AOD=0:', 'available=', c.available, 'haze=', c.hazePenalty.toFixed(4), 'satGain=', c.saturationGain.toFixed(4),
    '| AOD=1e-6:', 'available=', d.available, 'haze=', d.hazePenalty.toFixed(4), 'satGain=', d.saturationGain.toFixed(4));
}

// ── 探针 3（P0-1）：远端云墙 vs 本地云共用同一条光路 ──
// 构型 A：云只在本地（0km）；构型 B：云只在远端（450km）。
// 若两者 600hPa 的 perLevelTransmittance 相同，说明远端云环没有独立光路。
{
  const near = mkCloud(0); near['850'] = 0.9; // 本地低云
  const far = mkCloud(0); far['850'] = 0.9; // 远端低云
  const ringsA = [0, 30, 80, 150, 280, 450].map((d) => mkRing(d, d === 0 ? near : mkCloud(0)));
  const ringsB = [0, 30, 80, 150, 280, 450].map((d) => mkRing(d, d === 450 ? far : mkCloud(0)));
  const rayA = rayMarchingTransmittance(4200, -1.5, ringsA, [0, 0, 0, 0, 0, 0]);
  const rayB = rayMarchingTransmittance(4200, -1.5, ringsB, [0, 0, 0, 0, 0, 0]);
  console.log('[P0-1] 本地低云 T600=', rayA.perLevelTransmittance['600'].toFixed(4),
    '远端低云 T600=', rayB.perLevelTransmittance['600'].toFixed(4),
    '（主评分对两者用同一个值 → 无法区分）');
}
