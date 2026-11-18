import { predictSunset } from '../src/engine/SunsetPhysicsEngine';
import { buildScenario } from '../tests/calibrationScenarios';
import { SCENARIOS } from '../tests/calibrationScenarios';
const sc = SCENARIOS.find((s) => s.name.includes('洁净天空'))!;
const p = predictSunset({
  point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
  bundle: buildScenario(sc), primaryModel: 'ecmwf', timezoneOffsetSeconds: 8 * 3600,
  timezone: 'Asia/Shanghai', locationLabel: 'x', eventMs: Date.UTC(2026, 10, 3, 9, 5),
  daily: { sunriseMs: null, sunsetMs: Date.UTC(2026, 10, 3, 9, 5) }, compareModels: ['ecmwf'],
});
console.log('ringKm   T      blocked');
for (const r of p.rings) console.log(`${String(r.ringKm).padStart(5)}  ${r.transmittance.toFixed(4)}  ${r.terrainBlocked}`);
