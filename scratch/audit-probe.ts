import { predictSunset } from '../src/engine/SunsetPhysicsEngine';
import { SCENARIOS, buildScenario } from '../tests/calibrationScenarios';
import { evaluateSpectral } from '../src/engine/spectral';

function predict(name: string) {
  const sc = SCENARIOS.find((s) => s.name.includes(name));
  if (!sc) throw new Error(name);
  const bundle = buildScenario(sc);
  return predictSunset({
    point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
    bundle, primaryModel: 'ecmwf', timezoneOffsetSeconds: 28800,
    timezone: 'Asia/Shanghai', locationLabel: 'probe', eventMs: Date.UTC(2026, 10, 3, 9, 5),
    daily: { sunriseMs: null, sunsetMs: Date.UTC(2026, 10, 3, 9, 5) }, compareModels: ['ecmwf'],
  });
}

for (const name of ['洁净天空', '高原远山', '黄金层 + 满铺卷云']) {
  const p = predict(name);
  console.log('\nSCENARIO', name, 'V=', p.vividness.toFixed(6), 'veto=', p.veto.kind,
    'peakOffset=', (p.timeline.peakMs - p.eventMs) / 60000, 'alt=', p.sunAltitudeDeg.toFixed(3));
  console.table(p.layers.filter((l) => l.cover > 0).map((l) => ({
    level: l.key, cover: l.cover.toFixed(1), q: l.quality.toFixed(3),
    T: l.transmittance.toFixed(4), contribution: l.contribution.toFixed(4), terrain: l.terrainBlocked,
  })));
  console.table(p.rings.map((r) => ({ km: r.ringKm, T: r.transmittance.toFixed(4), score: r.score.toFixed(4), terrain: r.terrainBlocked })));
}

for (const aod of [0, 0.179999, 0.18, 0.180001, 0.279999, 0.28, 0.280001, 0.5, 0.500001, 0.8, 0.800001]) {
  const s = evaluateSpectral(aod, 6, 4, 42, 32, true, 20);
  console.log('AOD', aod, 'sat=', s.saturationGain.toFixed(8), 'haze=', s.hazePenalty.toFixed(8), 'tone=', s.tone);
}
for (const rh of [79.999, 80, 80.001]) {
  const s = evaluateSpectral(0.65, 100, 8, rh, 20, true, 20);
  console.log('RH', rh, 'sat=', s.saturationGain.toFixed(8), 'haze=', s.hazePenalty.toFixed(8));
}
