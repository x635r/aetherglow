/**
 * 探针：量当前版本在「最优构型网格」上的鲜艳度实际上限。
 * 用于校正 UI/README 里「可达上限约 X」这类会随物理改动过期的文案。
 * 运行：npx tsx scratch/ceiling-probe.ts
 */
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
const TIMES = (() => {
  const out: number[] = [];
  for (let h = -6; h <= 6; h++) out.push(EVENT + h * 3600000);
  return out;
})();

function sample(t: number, cover: Partial<Record<LevelKey, number>>, vis: number, humidity: number): HourlySample {
  const cloud = {} as Record<LevelKey, number>;
  const levelHeightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) {
    cloud[k] = (cover[k] ?? 0) * 100;
    levelHeightM[k] = STD_H[k];
  }
  return {
    timeMs: t, cloud, levelHeightM, levelTempC: {},
    cloudLow: 0, cloudMid: 0, cloudHigh: 0, cloudTotal: 0,
    precipitation: 0, humidity, visibilityM: vis, surfacePressureHpa: 1013,
  };
}

function bundle(
  cover: Partial<Record<LevelKey, number>>,
  o: { aod: number; pm25: number; vis: number; humidity: number },
): ForecastBundle {
  const models = {} as ForecastBundle['models'];
  models.ecmwf = {
    model: 'ecmwf' as ModelId,
    label: 'ecmwf',
    rings: RING.map((d) => ({
      ringKm: d,
      point: { lat: 31.23, lon: 121.47 },
      samples: TIMES.map((t) => sample(t, cover, o.vis, o.humidity)),
    })),
    aerosol: RING.map((d) => ({
      ringKm: d,
      point: { lat: 31.23, lon: 121.47 },
      samples: TIMES.map((t) => ({
        timeMs: t, aod: o.aod, pm25: o.pm25, dust: 6, pm10: 18, humidity: o.humidity,
      })),
    })),
    gridLat: 31.23, gridLon: 121.47, gridElevationM: 4,
  };
  return {
    models,
    terrain: RING.map((d) => ({ ringKm: d, point: { lat: 31.23, lon: 121.47 }, elevationM: 4 })),
    localElevationM: 4,
    fetchedAt: Date.now(), apiCalls: 1, cached: false,
  };
}

const run = (cover: Partial<Record<LevelKey, number>>, o: { aod: number; pm25: number; vis: number; humidity: number }) =>
  predictSunset({
    point: { lat: 31.23, lon: 121.47 }, mode: 'sunset', observerHeightM: 0,
    bundle: bundle(cover, o), primaryModel: 'ecmwf', timezoneOffsetSeconds: 28800,
    timezone: 'Asia/Shanghai', locationLabel: 'probe', eventMs: EVENT,
    daily: { sunriseMs: null, sunsetMs: EVENT }, compareModels: ['ecmwf'],
  }).vividness;

let max = 0;
let best = '';
for (const g of [0.3, 0.35, 0.4, 0.45, 0.5, 0.56, 0.6]) {
  for (const h of [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    for (const aod of [0.01, 0.02, 0.03, 0.05]) {
      for (const vis of [30000, 38000, 50000]) {
        const v = run({ '600': g, '500': g, '300': h }, { aod, pm25: 4, vis, humidity: 35 });
        if (v > max) {
          max = v;
          best = `600/500=${g} 300=${h} aod=${aod} vis=${vis}`;
        }
      }
    }
  }
}
console.log('grid max V =', max.toFixed(4), '|', best);
