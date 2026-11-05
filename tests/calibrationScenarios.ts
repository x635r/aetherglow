/**
 * 场景校准工具：用合成剖面检验引擎输出是否落在行业直觉区间。
 * 运行：npx vitest run tests/calibration.test.ts
 *
 * 区间对照 SunsetBot 六档口径：
 *   无烧 <0.05 · 微微烧 0.05–0.2 · 小烧 0.2–0.4 · 中烧 0.4–0.6
 *   大烧 0.6–1.0 · 特大烧 1.0–1.5 · 世纪大烧 >1.5
 */
import type { ForecastBundle, HourlySample, ModelId } from '../src/engine/types';
import { LEVEL_KEYS } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import { predictSunset } from '../src/engine/SunsetPhysicsEngine';

const stdH: Record<LevelKey, number> = {
  '925': 780,
  '850': 1500,
  '700': 3000,
  '600': 4200,
  '500': 5500,
  '400': 7200,
  '300': 9200,
};

export interface Scenario {
  name: string;
  cover: Partial<Record<LevelKey, number>>;
  /** 低层云（925/850 覆盖） */
  precip?: number;
  visibilityM?: number;
  humidity?: number;
  aod?: number;
  pm25?: number;
  dust?: number;
  /** 沿途地形（6 环） */
  terrain?: number[];
  expect: [number, number];
}

function mkSample(t: number, sc: Scenario): HourlySample {
  const cloud = {} as Record<LevelKey, number>;
  const levelHeightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) {
    cloud[k] = (sc.cover[k] ?? 0) * 100;
    levelHeightM[k] = stdH[k];
  }
  return {
    timeMs: t,
    cloud,
    levelHeightM,
    levelTempC: {},
    cloudLow: (sc.cover['925'] ?? 0) * 100,
    cloudMid: (sc.cover['700'] ?? 0) * 100,
    cloudHigh: ((sc.cover['300'] ?? 0) + (sc.cover['400'] ?? 0)) * 50,
    cloudTotal: Math.max(...LEVEL_KEYS.map((k) => cloud[k])),
    precipitation: sc.precip ?? 0,
    humidity: sc.humidity ?? 55,
    visibilityM: sc.visibilityM ?? 25000,
    weatherCode: 0,
    windSpeed: 8,
    windDir: 250,
    dewPointC: 10,
    surfacePressureHpa: 1013,
  };
}

export function buildScenario(sc: Scenario, model: ModelId = 'ecmwf'): ForecastBundle {
  const base = Date.UTC(2026, 10, 3, 9, 5, 0); // 上海 11/03 日落附近
  const times: number[] = [];
  for (let h = -6; h <= 6; h++) times.push(base + h * 3600000);

  const ringKm = [0, 30, 80, 150, 280, 450];
  const rings = ringKm.map((d) => ({
    ringKm: d,
    point: { lat: 31.23, lon: 121.47 },
    samples: times.map((t) => mkSample(t, sc)),
  }));

  return {
    models: {
      [model]: {
        model,
        label: 'calib',
        rings,
        aerosol: ringKm.map((d) => ({
          ringKm: d,
          point: { lat: 31.23, lon: 121.47 },
          samples: times.map((t) => ({
            timeMs: t,
            aod: sc.aod ?? 0.12,
            pm25: sc.pm25 ?? 12,
            dust: sc.dust ?? 8,
            pm10: sc.pm25 ?? 18,
            humidity: sc.humidity ?? 55,
          })),
        })),
        gridLat: 31.23,
        gridLon: 121.47,
        gridElevationM: 4,
      },
    } as never,
    terrain: ringKm.map((d, i) => ({
      ringKm: d,
      point: { lat: 31.23, lon: 121.47 },
      elevationM: sc.terrain?.[i] ?? 4,
    })),
    localElevationM: 4,
    fetchedAt: Date.now(),
    apiCalls: 1,
    cached: true,
  };
}

export function run(sc: Scenario, observerHeightM = 0): number {
  const bundle = buildScenario(sc);
  const p = predictSunset({
    point: { lat: 31.23, lon: 121.47 },
    mode: 'sunset',
    observerHeightM,
    bundle,
    primaryModel: 'ecmwf',
    timezoneOffsetSeconds: 8 * 3600,
    timezone: 'Asia/Shanghai',
    locationLabel: 'calib',
    eventMs: Date.UTC(2026, 10, 3, 9, 5),
    daily: { sunriseMs: null, sunsetMs: Date.UTC(2026, 10, 3, 9, 5) },
    compareModels: ['ecmwf'],
  });
  return p.vividness;
}

export const SCENARIOS: Scenario[] = [
  {
    name: '洁净天空 · 45% 高积云黄金层',
    cover: { '600': 0.45, '500': 0.4 },
    aod: 0.1,
    visibilityM: 30000,
    // 大烧下沿：单层 45% 黄金层在洁净大气下的典型表现
    expect: [0.75, 1.1],
  },
  {
    name: '卷云+高积云双层 · 大烧典型',
    cover: { '600': 0.35, '500': 0.4, '400': 0.5, '300': 0.45 },
    aod: 0.1,
    visibilityM: 30000,
    expect: [0.85, 1.25],
  },
  {
    name: '纯净卷云满铺 · 紫霞型',
    cover: { '400': 0.7, '300': 0.75 },
    aod: 0.09,
    visibilityM: 32000,
    // 纯卷云没有黄金层支撑，顶不起大烧（与 SunsetBot 口径一致）
    expect: [0.3, 0.75],
  },
  {
    name: '全天无云 · 只有地平线渐变',
    cover: {},
    aod: 0.1,
    visibilityM: 30000,
    expect: [0.02, 0.2],
  },
  {
    name: '低云满铺 · 阴天锁死',
    cover: { '925': 0.95, '850': 1.0, '700': 0.6 },
    aod: 0.3,
    humidity: 92,
    expect: [0.0, 0.15],
  },
  {
    name: '整层阴天 600-400 全满',
    cover: { '700': 0.95, '600': 0.95, '500': 0.95, '400': 0.95 },
    aod: 0.3,
    expect: [0.0, 0.25],
  },
  {
    name: '雾霾浑浊 · 高 AOD 湿',
    cover: { '600': 0.45, '500': 0.4 },
    aod: 0.75,
    pm25: 130,
    humidity: 88,
    visibilityM: 4000,
    // 重霾 + 高湿：米氏散射洗白，鲜艳度被指数压制到近乎无烧
    expect: [0.0, 0.2],
  },
  {
    name: '水晶天 · 低 AOD 高能见度',
    cover: { '600': 0.45, '500': 0.45 },
    aod: 0.08,
    pm25: 6,
    dust: 4,
    visibilityM: 34000,
    humidity: 42,
    expect: [0.75, 1.25],
  },
  {
    name: '高原远山遮挡黄金层光路',
    cover: { '600': 0.5, '500': 0.45 },
    // 80km 处 3400m 高于 600hPa 光路的 3202m → 真实遮挡
    terrain: [4, 1500, 3400, 2800, 4200, 5000],
    aod: 0.12,
    expect: [0.0, 0.45],
  },
  {
    name: '远端 200-450km 低云墙封死天窗',
    cover: { '600': 0.5, '500': 0.45, '700': 0.9 },
    precip: 1.2,
    aod: 0.2,
    expect: [0.0, 0.25],
  },
  {
    name: '黄金层 + 满铺卷云 · 大烧天花板',
    cover: { '600': 0.45, '500': 0.4, '300': 0.9 },
    aod: 0.06,
    pm25: 5,
    visibilityM: 34000,
    humidity: 40,
    // 高积云被点燃 + 满铺卷云作第二画布，是本引擎可达到的最高档
    expect: [1.0, 1.5],
  },
];
