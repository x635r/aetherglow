/**
 * 第四轮审查核对探针
 *
 * NEW-01：单层 100% 密云铺满 450km 时，本层有效透射率是否真的高达 94.9%
 * NEW-03：cotRef 在朝霞模式下 Math.max(bestAlt, midAlt) 的高估量
 */
import { rayMarchingTransmittance } from '../src/engine/SunsetPhysicsEngine';
import type { ProfileRing } from '../src/engine/SunsetPhysicsEngine';
import { sunPosition } from '../src/engine/astro';
import { LEVEL_KEYS } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import type { HourlySample } from '../src/engine/types';

const STD_H: Record<LevelKey, number> = {
  '1000': 110, '925': 780, '850': 1500, '700': 3000, '600': 4200,
  '500': 5500, '400': 7200, '300': 9200, '250': 10400, '200': 11800,
};
const RING = [0, 30, 80, 150, 280, 450];

function ringOf(ringKm: number, coverOf: Partial<Record<LevelKey, number>>): ProfileRing {
  const cloud = {} as Record<LevelKey, number>;
  const heightM = {} as Record<LevelKey, number>;
  const visible = {} as Record<LevelKey, boolean>;
  for (const k of LEVEL_KEYS) {
    cloud[k] = (coverOf[k] ?? 0) * 100;
    heightM[k] = STD_H[k];
    visible[k] = true;
  }
  const sample: HourlySample = {
    timeMs: Date.UTC(2026, 10, 18, 9, 0), cloud, levelHeightM: heightM, levelTempC: {},
    cloudLow: 0, cloudMid: 0, cloudHigh: 0, cloudTotal: 0,
    precipitation: 0, humidity: 60, visibilityM: 25000, surfacePressureHpa: 1013,
  };
  return { ringKm, point: { lat: 31.23, lon: 121.47 }, sample, cover: Object.fromEntries(LEVEL_KEYS.map((k) => [k, (coverOf[k] ?? 0)]) ) as Record<LevelKey, number>, heightM, tempC: {}, rh: {}, visible };
}

console.log('════ NEW-01：单层 100% 密云铺满 450km，本层有效透射率 ════');
for (const [label, cover, target] of [
  ['600hPa 100% 满铺（单层密云）', { '600': 1.0 }, '600' as LevelKey],
  ['600hPa 100% + 低层 100%（双层密室）', { '600': 1.0, '850': 1.0 }, '600' as LevelKey],
  ['600hPa 40%（破碎黄金层）', { '600': 0.4 }, '600' as LevelKey],
] as Array<[string, Partial<Record<LevelKey, number>>, LevelKey]>) {
  const rings = RING.map((d) => ringOf(d, cover));
  const terrain = RING.map(() => 4);
  // 太阳高度 −1.5°：典型黄昏
  const ray = rayMarchingTransmittance(STD_H[target], -1.5, rings, terrain, { cotFactor: 1 });
  const tEff = ray.perLevelTransmittance[target];
  const tau = ray.opticalDepth;
  console.log(`  ${label}`);
  console.log(`    本层有效透射率 t_eff = ${tEff.toFixed(4)}   totalTau = ${tau.toFixed(3)}`);
  console.log(`    逐层 pathKm 600=${ray.perLevelPathKm['600'].toFixed(1)} 850=${ray.perLevelPathKm['850'].toFixed(1)}`);
  const wantOpaque = Object.values(cover).some((c) => c >= 0.99);
  const good = wantOpaque ? tEff < 0.2 : tEff > 0.8;
  console.log(`    判定：${good ? '✅ 合理' : '❌ 不符合物理'}`);
}

console.log('\n════ NEW-03：朝霞 cotRef 的 Math.max(bestAlt, midAlt) 高估量 ════');
for (const [name, lat, lon] of [['上海', 31.23, 121.47], ['北京', 39.9, 116.41], ['哈尔滨', 45.8, 126.53]] as Array<[string, number, number]>) {
  const sunriseMs = Date.UTC(2026, 10, 18, 23, 0); // 本地 07:00
  const sunsetMs = Date.UTC(2026, 10, 18, 9, 0); // 本地 17:00
  for (const [modeLabel, eventMs, sign] of [['朝霞', sunriseMs, 1], ['晚霞', sunsetMs, -1]] as Array<[string, number, number]>) {
    let bestMs = eventMs + sign * 90 * 60000;
    let bestAlt = -90;
    for (const offMin of [60, 90, 120, 150, 180]) {
      const ms = eventMs + sign * offMin * 60000;
      const alt = sunPosition(ms, lat, lon).altitude;
      if (alt > bestAlt) { bestAlt = alt; bestMs = ms; }
      if (alt >= 18) break;
    }
    const midAlt = sunPosition(bestMs - 30 * 60000, lat, lon).altitude;
    const used = Math.max(bestAlt, midAlt);
    const over = used - midAlt;
    console.log(`  ${name.padEnd(4)} ${modeLabel}  bestAlt=${bestAlt.toFixed(2)}°  midAlt=${midAlt.toFixed(2)}°  实际采用=${used.toFixed(2)}°  高估=${over.toFixed(2)}°  ${over > 1 ? '❌ NEW-03 成立' : '✅'}`);
  }
}
