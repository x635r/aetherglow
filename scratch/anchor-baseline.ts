/** 记录改动前的校准锚点基线 */
import { SCENARIOS, run } from '../tests/calibrationScenarios';
for (const sc of SCENARIOS) {
  const v = run(sc);
  const ok = v >= sc.expect[0] && v <= sc.expect[1];
  console.log(`${ok ? '✅' : '❌'} ${sc.name.padEnd(28)} V=${v.toFixed(4)}  expect=[${sc.expect[0]}, ${sc.expect[1]}]`);
}
