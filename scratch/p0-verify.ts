/** 端到端验证 4 项 P0 修复是否真的生效 */
import { advectionLagMs } from '../src/engine/astro';
import { memberScore } from '../src/data/ensemble';
import { predictSunset } from '../src/engine/SunsetPhysicsEngine';
import { sunPosition } from '../src/engine/astro';
import { LEVEL_KEYS } from '../src/engine/constants';
import type { LevelKey } from '../src/engine/constants';
import type { ForecastBundle, HourlySample, ModelId } from '../src/engine/types';

console.log('════ P0-2 风场平流方向 ════');
for (const [label, from, sight, ring, want] of [
  ['西风 + 西向视线（云从环吹向本地）', 270, 270, 80, '>0'],
  ['东风 + 西向视线（云正在离开）', 90, 270, 80, '0'],
  ['0km 环（本地无相对环距）', 270, 270, 0, '0'],
] as Array<[string, number, number, number, string]>) {
  const lag = advectionLagMs(from, 60, sight, ring) / 60000;
  const ok = want === '>0' ? lag > 0 : lag === 0;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(32)} lag=${lag.toFixed(1)}min (期望 ${want})`);
}

console.log('\n════ P0-3 集合阴天否决 ════');
const cases: Array<[string, number, number, number]> = [
  ['100% 中高云满铺', 0, 1, 1],
  ['100% 三层满铺', 1, 1, 1],
  ['45% 黄金层（正常好天气）', 0, 0.45, 0],
];
for (const [label, low, mid, high] of cases) {
  const s = memberScore(low, mid, high, mid, 300, 100, 0, -2);
  console.log(`  ${label.padEnd(28)} score=${s.toFixed(4)}`);
}

console.log('\n════ P0-1 朝霞 COT 参考时刻 ════');
// 复现 cotRef 的搜索逻辑
const searchRef = (eventMs: number, mode: 'sunrise' | 'sunset', lat: number, lon: number) => {
  const sign = mode === 'sunrise' ? 1 : -1;
  let best = { ms: eventMs + sign * 90 * 60000, alt: -90 };
  for (const off of [60, 90, 120, 150, 180]) {
    const ms = eventMs + sign * off * 60000;
    const alt = sunPosition(ms, lat, lon).altitude;
    if (alt > best.alt) best = { ms, alt };
    if (alt >= 18) break;
  }
  return best;
};
const cities: Array<[string, number, number]> = [
  ['上海', 31.23, 121.47],
  ['北京', 39.9, 116.41],
  ['哈尔滨', 45.8, 126.53],
];
for (const [name, lat, lon] of cities) {
  const sunriseMs = Date.UTC(2026, 10, 18, 23, 0);
  const sunsetMs = Date.UTC(2026, 10, 18, 9, 0);
  const r = searchRef(sunriseMs, 'sunrise', lat, lon);
  const s = searchRef(sunsetMs, 'sunset', lat, lon);
  console.log(
    `  ${name.padEnd(4)} 朝霞 refAlt=${r.alt.toFixed(1).padStart(6)}° ${r.alt >= 10 ? '✅ 可反演' : '❌'}   ` +
      `晚霞 refAlt=${s.alt.toFixed(1).padStart(6)}° ${s.alt >= 10 ? '✅ 可反演' : '❌'}`,
  );
}

console.log('\n════ P0-4 高原地下等压面 ════');
const STD_H: Record<LevelKey, number> = {
  '1000': 110, '925': 780, '850': 1500, '700': 3000, '600': 4200,
  '500': 5500, '400': 7200, '300': 9200, '250': 10400, '200': 11800,
};
const EVENT = Date.UTC(2026, 10, 3, 9, 5, 0);
const RING = [0, 30, 80, 150, 280, 450];
const TIMES = (() => { const o: number[] = []; for (let h = -6; h <= 6; h++) o.push(EVENT + h * 3600000); return o; })();
const COVER: Partial<Record<LevelKey, number>> = { '1000': 0.9, '925': 0.9, '850': 0.9, '700': 0.9, '600': 0.5 };
function sample(t: number): HourlySample {
  const cloud = {} as Record<LevelKey, number>;
  const levelHeightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) { cloud[k] = (COVER[k] ?? 0) * 100; levelHeightM[k] = STD_H[k]; }
  return { timeMs: t, cloud, levelHeightM, levelTempC: {}, cloudLow: 0, cloudMid: 0, cloudHigh: 0, cloudTotal: 0, precipitation: 0, humidity: 50, visibilityM: 25000, surfacePressureHpa: 1013 };
}
const models = {} as ForecastBundle['models'];
models.ecmwf = { model: 'ecmwf' as ModelId, label: 'ecmwf', rings: RING.map((d) => ({ ringKm: d, point: { lat: 29.65, lon: 91.14 }, samples: TIMES.map(sample) })), aerosol: RING.map((d) => ({ ringKm: d, point: { lat: 29.65, lon: 91.14 }, samples: TIMES.map((t) => ({ timeMs: t, aod: 0.2, pm25: 10, dust: 6, pm10: 18, humidity: 50 })) })), gridLat: 29.65, gridLon: 91.14, gridElevationM: 3650 };
const lhasa: ForecastBundle = { models, terrain: RING.map((d) => ({ ringKm: d, point: { lat: 29.65, lon: 91.14 }, elevationM: 3650 }) ), localElevationM: 3650, fetchedAt: Date.now(), apiCalls: 1, cached: false };
const p = predictSunset({
  point: { lat: 29.65, lon: 91.14 }, mode: 'sunset', observerHeightM: 0,
  bundle: lhasa, primaryModel: 'ecmwf', timezoneOffsetSeconds: 28800,
  timezone: 'Asia/Shanghai', locationLabel: '拉萨', eventMs: EVENT,
  daily: { sunriseMs: null, sunsetMs: EVENT }, compareModels: ['ecmwf'],
});
console.log(`  拉萨地面 3650m：observerMsl=${p.observerHeightM}m  cloudBaseM=${Math.round(p.cloudBaseM)}m`);
console.log(`    ${p.cloudSeaReversal ? '❌ 误触发云海反转' : '✅ 未误触发云海反转'}`);
console.log(`    ${p.cloudBaseM > 3650 ? '✅ 云底在地面之上（地下层已过滤）' : '❌ 云底仍在地下'}`);
