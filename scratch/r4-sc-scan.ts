/** 扫描自遮挡系数（0 = 旧行为，1 = 全封闭）对四个关键场景的影响 */
import { predictSunset } from '../src/engine/SunsetPhysicsEngine';
import { buildScenario } from '../tests/calibrationScenarios';
import type { Scenario } from '../tests/calibrationScenarios';
import { readFileSync } from 'node:fs';

const CASES: Scenario[] = [
  { name: '洁净天空 45%', cover: { '600': 0.45, '500': 0.4 }, aod: 0.1, visibilityM: 30000, expect: [0.75, 1.1] },
  { name: '卷云+高积云', cover: { '600': 0.35, '500': 0.4, '400': 0.5, '300': 0.45 }, aod: 0.1, visibilityM: 30000, expect: [0.85, 1.25] },
  { name: '纯净卷云满铺', cover: { '400': 0.7, '300': 0.75 }, aod: 0.09, visibilityM: 32000, expect: [0.3, 0.75] },
  { name: '黄金层+满铺卷云', cover: { '600': 0.45, '500': 0.4, '300': 0.9 }, aod: 0.06, pm25: 5, visibilityM: 34000, humidity: 40, expect: [0.85, 1.3] },
  { name: '整层阴天', cover: { '700': 0.95, '600': 0.95, '500': 0.95, '400': 0.95 }, aod: 0.3, expect: [0, 0.25] },
  { name: '单层600满铺', cover: { '600': 1.0 }, aod: 0.25, humidity: 85, expect: [0, 0.25] },
];
const run = (sc: Scenario) => predictSunset({
  point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
  bundle: buildScenario(sc), primaryModel: 'ecmwf', timezoneOffsetSeconds: 8 * 3600,
  timezone: 'Asia/Shanghai', locationLabel: 'x', eventMs: Date.UTC(2026, 10, 3, 9, 5),
  daily: { sunriseMs: null, sunsetMs: Date.UTC(2026, 10, 3, 9, 5) }, compareModels: ['ecmwf'],
}).vividness;

console.log('场景'.padEnd(20), 'V');
for (const c of CASES) {
  const v = run(c);
  const ok = v >= c.expect[0] && v <= c.expect[1];
  console.log(`${ok ? '✅' : '❌'} ${c.name.padEnd(18)} ${v.toFixed(4)}  [${c.expect[0]},${c.expect[1]}]`);
}
