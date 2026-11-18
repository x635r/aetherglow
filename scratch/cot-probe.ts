/** 核实 COT 门槛：朝霞方向 + 中纬秋冬 */
import { sunPosition } from '../src/engine/astro';

const cities: Array<[string, number, number]> = [
  ['上海', 31.23, 121.47],
  ['北京', 39.90, 116.41],
  ['哈尔滨', 45.80, 126.53],
  ['拉萨', 29.65, 91.14],
];

// 2026-11-18 各城市的日落/日出大致时刻（UTC）
const events: Array<[string, number]> = [
  ['上海日落', Date.UTC(2026, 10, 18, 9, 0)],
  ['北京日落', Date.UTC(2026, 10, 18, 9, 0)],
  ['哈尔滨日落', Date.UTC(2026, 10, 18, 8, 0)],
];

console.log('=== 晚霞：日落前 90min 的太阳高度角（当前代码用的参考时刻）===');
for (const [name, lat, lon] of cities) {
  const sunsetMs = Date.UTC(2026, 10, 18, 9, 0);
  const refMs = sunsetMs - 90 * 60000;
  const alt = sunPosition(refMs, lat, lon).altitude;
  console.log(`${name.padEnd(6)} lat=${lat}  refAlt=${alt.toFixed(2)}°  ${alt < 15 ? '❌ <15 失效' : '✅ 可用'}`);
}

console.log('\n=== 朝霞：日出前 90min（当前代码 eventMs - 90min）===');
for (const [name, lat] of cities) {
  const sunriseMs = Date.UTC(2026, 10, 18, 23, 0); // 上海日出约 06:20 本地 = 22:20 UTC 前一天
  const refMs = sunriseMs - 90 * 60000;
  const alt = sunPosition(refMs, lat, 121.47).altitude;
  console.log(`${name.padEnd(6)}  sunrise-90min 的 alt=${alt.toFixed(2)}°  ${alt < 15 ? '❌ <15 永久失效' : '✅ 可用'}`);
}
