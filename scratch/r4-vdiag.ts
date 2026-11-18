import { predictSunset } from '../src/engine/SunsetPhysicsEngine';
import { buildScenario } from '../tests/calibrationScenarios';
import type { Scenario } from '../tests/calibrationScenarios';

const sc: Scenario = { name: '黄金层+满铺卷云', cover: { '600': 0.45, '500': 0.4, '300': 0.9 }, aod: 0.06, pm25: 5, visibilityM: 34000, humidity: 40, expect: [0.85, 1.3] };
const p = predictSunset({
  point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
  bundle: buildScenario(sc), primaryModel: 'ecmwf', timezoneOffsetSeconds: 8 * 3600,
  timezone: 'Asia/Shanghai', locationLabel: 'x', eventMs: Date.UTC(2026, 10, 3, 9, 5),
  daily: { sunriseMs: null, sunsetMs: Date.UTC(2026, 10, 3, 9, 5) }, compareModels: ['ecmwf'],
});
console.log('V =', p.vividness.toFixed(4));
console.log('spectral =', JSON.stringify(p.spectral, null, 1));
console.log('factors =', JSON.stringify((p as unknown as { factors?: unknown }).factors ?? (p as unknown as { diagnostics?: unknown }).diagnostics, null, 1));
