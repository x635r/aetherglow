/** 单层满铺的天花板效应：600hPa 单层 100% 密云是否被当成完美黄金层 */
import { SCENARIOS, run } from '../tests/calibrationScenarios';
const cases = [
  { name: '600hPa 单层 100% 满铺（纯阴天）', cover: { '600': 1.0 }, expect: [0, 0.25] as [number, number] },
  { name: '600hPa 单层 95% 满铺', cover: { '600': 0.95 }, expect: [0, 0.3] as [number, number] },
  { name: '600hPa 单层 45%（对照：好天气）', cover: { '600': 0.45 }, expect: [0.75, 1.1] as [number, number] },
  { name: '850hPa 单层 100% 满铺（低云）', cover: { '850': 1.0 }, expect: [0, 0.2] as [number, number] },
  { name: '300hPa 单层 100% 卷云满铺', cover: { '300': 1.0 }, expect: [0.3, 0.8] as [number, number] },
];
for (const c of cases) {
  const sc = { name: c.name, cover: c.cover, aod: 0.25, humidity: 85, expect: c.expect };
  const v = run(sc as never);
  const ok = v >= c.expect[0] && v <= c.expect[1];
  console.log(`${ok ? '✅' : '❌'} ${c.name.padEnd(30)} V=${v.toFixed(4)}  期望[${c.expect[0]}, ${c.expect[1]}]`);
}
