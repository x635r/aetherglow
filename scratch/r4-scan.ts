import { SCENARIOS, run } from '../tests/calibrationScenarios';
const base = SCENARIOS.map((sc) => ({ sc, v: run(sc) }));
const worst = Math.max(...base.map(({ sc, v }) => v > 0 ? Math.max(0, Math.min(sc.expect[0] / v, 1.6 / v)) : 0));
console.log('当前值 / 需要的缩放 / 缩放后');
for (const { sc, v } of base) {
  const ok = v >= sc.expect[0] && v <= sc.expect[1];
  console.log(`${ok ? '✅' : '❌'} ${sc.name.padEnd(26)} V=${v.toFixed(4)}  区间=[${sc.expect[0]},${sc.expect[1]}]`);
}
// 求能把所有锚点带进区间的最小缩放
let lo = 1, hi = 2.5;
for (let i = 0; i < 60; i++) {
  const mid = (lo + hi) / 2;
  const allOk = base.every(({ sc, v }) => {
    const w = v * mid;
    return w >= sc.expect[0] && w <= sc.expect[1];
  });
  if (allOk) hi = mid; else lo = mid;
}
console.log(`\n最小可行缩放 = ${hi.toFixed(4)}`);
for (const { sc, v } of base) {
  const w = v * hi;
  const ok = w >= sc.expect[0] && w <= sc.expect[1];
  console.log(`  ${ok ? '✅' : '❌'} ${sc.name.padEnd(26)} ${v.toFixed(4)} → ${w.toFixed(4)}`);
}
