import { describe, expect, it } from 'vitest';
import { SCENARIOS, run } from './calibrationScenarios';

/**
 * 物理校准回归：确保引擎在各典型场景下落在行业直觉区间。
 * 区间是「宽而有界」的 —— 目的不是锁死数值，而是捕捉量级错误
 * （例如把晴朗高积云算成无烧，或把雾霾算成大烧）。
 */
describe('引擎校准', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name} → ${sc.expect[0]}~${sc.expect[1]}`, () => {
      const v = run(sc);
      expect(v).toBeGreaterThanOrEqual(sc.expect[0]);
      expect(v).toBeLessThanOrEqual(sc.expect[1]);
    });
  }

  it('云海反转：升至低云之上应提升得分', () => {
    const sc = SCENARIOS.find((x) => x.name.includes('低云满铺'))!;
    const ground = run(sc, 0);
    const above = run(sc, 1800);
    expect(above).toBeGreaterThan(ground);
  });

  it('总体单调性：黄金层云量从 0→45% 应显著提升鲜艳度', () => {
    const base = SCENARIOS.find((x) => x.name.includes('全天无云'))!;
    const cloudy = SCENARIOS.find((x) => x.name.includes('洁净天空'))!;
    expect(run(cloudy)).toBeGreaterThan(run(base) * 2);
  });
});
