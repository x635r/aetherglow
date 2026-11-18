/** 诊断：整层阴天为何从 faint 升到 minor */
import { predictSunset } from '../src/engine/SunsetPhysicsEngine';
import { LEVEL_KEYS } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import type { ForecastBundle, HourlySample, ModelId } from '../src/engine/types';

const STD_H: Record<LevelKey, number> = {
  '1000': 110, '925': 780, '850': 1500, '700': 3000, '600': 4200,
  '500': 5500, '400': 7200, '300': 9200, '250': 10400, '200': 11800,
};
const EVENT = Date.UTC(2026, 10, 3, 9, 5, 0);
const RING = [0, 30, 80, 150, 280, 450];
const TIMES = (() => { const o: number[] = []; for (let h = -6; h <= 6; h++) o.push(EVENT + h * 3600000); return o; })();

function sample(t: number, cover: Partial<Record<LevelKey, number>>, aod: number): HourlySample {
  const cloud = {} as Record<LevelKey, number>;
  const levelHeightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) { cloud[k] = (cover[k] ?? 0) * 100; levelHeightM[k] = STD_H[k]; }
  return {
    timeMs: t, cloud, levelHeightM, levelTempC: {},
    cloudLow: 0, cloudMid: 0, cloudHigh: 0, cloudTotal: 0,
    precipitation: 0, humidity: 50, visibilityM: 25000, surfacePressureHpa: 1013,
  };
}

function bundle(cover: Partial<Record<LevelKey, number>>, aod: number): ForecastBundle {
  const models = {} as ForecastBundle['models'];
  models.ecmwf = {
    model: 'ecmwf' as ModelId, label: 'ecmwf',
    rings: RING.map((d) => ({ ringKm: d, point: { lat: 31.23, lon: 121.47 }, samples: TIMES.map((t) => sample(t, cover, aod)) })),
    aerosol: RING.map((d) => ({
      ringKm: d, point: { lat: 31.23, lon: 121.47 },
      samples: TIMES.map((t) => ({ timeMs: t, aod, pm25: 10, dust: 6, pm10: 18, humidity: 50 })),
    })),
    gridLat: 31.23, gridLon: 121.47, gridElevationM: 4,
  };
  return {
    models,
    terrain: RING.map((d) => ({ ringKm: d, point: { lat: 31.23, lon: 121.47 }, elevationM: 4 })),
    localElevationM: 4, fetchedAt: Date.now(), apiCalls: 1, cached: false,
  };
}

for (const [label, cover, aod] of [
  ['晴空无云', {}, 0.1],
  ['整层阴天 700-400 满铺', { '700': 0.95, '600': 0.95, '500': 0.95, '400': 0.95 }, 0.3],
] as const) {
  const p = predictSunset({
    point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
    bundle: bundle(cover, aod), primaryModel: 'ecmwf', timezoneOffsetSeconds: 28800,
    timezone: 'Asia/Shanghai', locationLabel: 'x', eventMs: EVENT,
    daily: { sunriseMs: null, sunsetMs: EVENT }, compareModels: ['ecmwf'],
  });
  console.log(`${label.padEnd(24)} V=${p.vividness.toFixed(4)} grade=${p.grade.padEnd(12)} veto=${p.veto.kind}`);
  for (const l of p.layers.filter((x) => x.cover > 1)) {
    console.log(`   ${l.key}hPa cover=${l.cover.toFixed(0)}% T=${l.transmittance.toFixed(3)} contrib=${l.contribution.toFixed(3)}`);
  }
}
