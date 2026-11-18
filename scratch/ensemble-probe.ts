/** 核实 P0-3：ensemble 的 mid*0.3 是否让 overcast 永不触发 */
import { memberScore } from '../src/data/ensemble';

console.log('=== 生产调用链：midOnly = mid*0.3, golden = mid*0.7 ===');
const cases: Array<[string, number, number, number]> = [
  ['100% 中高云满铺（mid=1, high=1, low=0）', 0, 1, 1],
  ['100% 中云满铺（mid=1, high=0, low=0）', 0, 1, 0],
  ['100% 三层满铺', 1, 1, 1],
];
for (const [label, low, mid, high] of cases) {
  const midOnly = mid * 0.3;
  const golden = mid * 0.7;
  const s = memberScore(low, midOnly, high, golden, 300, 100, 0, -2);
  console.log(`${label.padEnd(36)} -> mid=${midOnly.toFixed(2)} golden=${golden.toFixed(2)} score=${s.toFixed(4)}`);
}

console.log('\n=== 直接传真实覆盖率（修复后应有 overcast）===');
for (const [label, low, mid, high] of cases) {
  const s = memberScore(low, mid, high, mid, 300, 100, 0, -2);
  console.log(`${label.padEnd(36)} -> score=${s.toFixed(4)}  overcast? ${mid > 0.85 && mid > 0.8 && high > 0.85}`);
}
