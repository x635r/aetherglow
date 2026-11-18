/** 诊断 NEW-01 对两个锚点场景的逐层透过率影响 */
import { predictSunset } from '../src/engine/SunsetPhysicsEngine';
import { buildScenario } from '../tests/calibrationScenarios';
import type { Scenario } from '../tests/calibrationScenarios';

const CASES: Scenario[] = [
  { name: '卷云+高积云双层', cover: { '600': 0.35, '500': 0.4, '400': 0.5, '300': 0.45 }, aod: 0.1, visibilityM: 30000, expect: [0.85, 1.25] },
  { name: '黄金层+满铺卷云', cover: { '600': 0.45, '500': 0.4, '300': 0.9 }, aod: 0.06, pm25: 5, visibilityM: 34000, humidity: 40, expect: [0.85, 1.3] },
];

for (const sc of CASES) {
  const p = predictSunset({
    point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
    bundle: buildScenario(sc), primaryModel: 'ecmwf', timezoneOffsetSeconds: 8 * 3600,
    timezone: 'Asia/Shanghai', locationLabel: 'calib', eventMs: Date.UTC(2026, 10, 3, 9, 5),
    daily: { sunriseMs: null, sunsetMs: Date.UTC(2026, 10, 3, 9, 5) }, compareModels: ['ecmwf'],
  });
  console.log(`\n── ${sc.name}  V=${p.vividness.toFixed(4)} ──`);
  for (const l of p.layers) {
    if (l.cover < 0.02) continue;
    console.log(`  ${l.key.padEnd(4)} ${l.role.padEnd(7)} cover=${l.cover.toFixed(2)} T=${l.transmittance.toFixed(4)} q=${l.quality.toFixed(3)} contrib=${l.contribution.toFixed(3)}`);
  }
}
