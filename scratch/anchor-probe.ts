/**
 * 探针：打印每个校准场景当前的鲜艳度，用于校正代码注释里的「定标锚点」。
 * 注释里的锚点必须能由这个脚本复现，否则就是编的。
 * 运行：npx tsx scratch/anchor-probe.ts
 */
import { SCENARIOS, buildScenario } from '../tests/calibrationScenarios';
import { predictSunset } from '../src/engine/SunsetPhysicsEngine';

const EVENT = Date.UTC(2026, 10, 3, 9, 5);

for (const sc of SCENARIOS) {
  const p = predictSunset({
    point: { lat: 31.23, lon: 121.47 },
    mode: 'sunset',
    observerHeightM: 0,
    bundle: buildScenario(sc),
    primaryModel: 'ecmwf',
    timezoneOffsetSeconds: 28800,
    timezone: 'Asia/Shanghai',
    locationLabel: 'anchor',
    eventMs: EVENT,
    daily: { sunriseMs: null, sunsetMs: EVENT },
    compareModels: ['ecmwf'],
  });
  console.log(`${p.vividness.toFixed(4).padStart(7)}  ${p.grade.padEnd(13)}  ${sc.name}`);
}
