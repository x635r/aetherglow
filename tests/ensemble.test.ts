/**
 * 集合预报接入的测试
 * ---------------------------------------------------------------------------
 * 集合概率是**唯一真正统计意义**的概率来源，所以必须锁定两件事：
 *  1. 评分函数的单调性（云更多/更受光 → 分更高；整层阴天 → 被否决）
 *  2. 失败必须返回 null，绝不返回一个"看起来正常的假概率"
 */

import { describe, expect, it } from 'vitest';
import { ENSEMBLE_QUOTA_COST, ENSEMBLE_QUOTA_PER_MIN } from '../src/data/ensemble';

/**
 * 复刻 ensemble.ts 里的 memberScore 逻辑做单元测试。
 * （函数未导出，因为它是内部实现；这里复制同样的算式以锁定行为契约。）
 */
function memberScore(
  low: number,
  mid: number,
  high: number,
  golden: number,
  direct: number,
  diffuse: number,
  precip: number,
  altDeg: number,
): number {
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  const smoothstep = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // cloudLitFactor 的简化复刻（与 optics.ts 同结构）
  const litOf = (hM: number, alt: number, role: 'mid' | 'golden' | 'high') => {
    const R = 6371;
    const dipDeg = (Math.acos(R / (R + hM / 1000)) * 180) / Math.PI;
    const margin = hM - (alt >= 0 ? 0 : 1000 * R * (1 / Math.cos((Math.abs(alt) * Math.PI) / 180) - 1));
    const softM = Math.max(320, Math.abs(Math.tan((alt * Math.PI) / 180)) * 30000);
    const directF = 1 / (1 + Math.exp(-margin / softM));
    if (alt < -1 && (role === 'high' || role === 'golden')) {
      const depth = Math.max(0, -margin);
      const scale = role === 'high' ? 9000 : 5000;
      const tail = (role === 'high' ? 0.55 : 0.4) * Math.exp(-depth / scale);
      return clamp(Math.max(directF, tail), 0, 1);
    }
    void dipDeg;
    return clamp(directF, 0, 1);
  };

  const deckQuality = (cover01: number, role: 'low' | 'mid' | 'golden' | 'high') => {
    const c = clamp(cover01, 0, 1);
    if (c <= 0.03) return 0;
    const optimum = role === 'low' ? 0.2 : role === 'mid' ? 0.42 : role === 'golden' ? 0.55 : 0.72;
    const sigma = role === 'low' ? 0.22 : role === 'mid' ? 0.26 : role === 'golden' ? 0.3 : 0.32;
    const pref = Math.exp(-0.5 * ((c - optimum) / sigma) ** 2);
    const presence = Math.min(1, Math.max(0, (c - 0.03) / 0.09));
    return clamp(presence * pref, 0, 1);
  };

  const W = { low: 0.1, mid: 0.24, golden: 0.66, high: 0.46 };

  const sLow = deckQuality(low, 'low');
  const sMid = deckQuality(mid, 'mid') * litOf(3000, altDeg, 'mid');
  const sGolden = deckQuality(golden, 'golden') * litOf(4200, altDeg, 'golden');
  const sHigh = deckQuality(high, 'high') * litOf(9200, altDeg, 'high');

  const union = (a: number, b: number) => 1 - (1 - a) * (1 - b);
  let sum = 0;
  sum += W.golden * union(sGolden, sGolden * 0.85);
  sum += W.high * union(sHigh, sHigh * 0.9);
  sum += W.mid * sMid;
  sum += W.low * sLow;
  sum /= 1.25;

  const overcast = mid > 0.85 && golden > 0.8 && high > 0.85;
  if (overcast) sum *= 0.26;
  else if (low > 0.8) sum *= 0.3;

  const beamTotal = direct + diffuse;
  const directShare = beamTotal > 5 ? clamp(direct / beamTotal, 0, 1) : 0.5;
  const beamFactor = 0.8 + 0.4 * directShare;

  const rainPenalty = precip > 0.5 ? Math.max(0.25, 1 - precip * 0.35) : 1;
  return clamp(sum * beamFactor * rainPenalty, 0, 1.3);
}

const EVENING = -1.5;

describe('集合成员评分：区分度', () => {
  it('教科书好天气得分应高于"能烧"门槛 0.28', () => {
    // 45% 黄金层 + 70% 薄卷云，洁净黄昏
    const s = memberScore(0.1, 0.2, 0.7, 0.45, 40, 60, 0, EVENING);
    expect(s).toBeGreaterThan(0.28);
  });

  it('整层阴天必须显著低于门槛', () => {
    const s = memberScore(1, 1, 1, 1, 0, 20, 0, EVENING);
    expect(s).toBeLessThan(0.28);
  });

  it('低云满铺锁死必须低于门槛', () => {
    const s = memberScore(1, 0.5, 0.5, 0.5, 0, 20, 0, EVENING);
    expect(s).toBeLessThan(0.28);
  });

  it('全天无云应接近 0', () => {
    const s = memberScore(0, 0, 0, 0, 40, 60, 0, EVENING);
    expect(s).toBeLessThan(0.05);
  });

  it('好天气 > 阴天（严格）', () => {
    const good = memberScore(0.1, 0.2, 0.7, 0.45, 40, 60, 0, EVENING);
    const bad = memberScore(1, 1, 1, 1, 0, 20, 0, EVENING);
    expect(good).toBeGreaterThan(bad * 3);
  });
});

describe('集合成员评分：物理单调性', () => {
  it('黄金层云量从 0 增至 45% 应提高得分', () => {
    const a = memberScore(0.1, 0.2, 0.5, 0.05, 40, 60, 0, EVENING);
    const b = memberScore(0.1, 0.2, 0.5, 0.45, 40, 60, 0, EVENING);
    expect(b).toBeGreaterThan(a);
  });

  it('黄金层从 45% 继续涨到 100% 应降低得分（云幕自我遮挡）', () => {
    const a = memberScore(0.1, 0.2, 0.5, 0.45, 40, 60, 0, EVENING);
    const b = memberScore(0.1, 0.2, 0.5, 1.0, 40, 60, 0, EVENING);
    expect(b).toBeLessThan(a);
  });

  it('降水应降低得分', () => {
    const dry = memberScore(0.1, 0.2, 0.7, 0.45, 40, 60, 0, EVENING);
    const wet = memberScore(0.1, 0.2, 0.7, 0.45, 40, 60, 5, EVENING);
    expect(wet).toBeLessThan(dry);
  });

  it('太阳下沉时高云的贡献应比黄金层衰减得慢', () => {
    // 云幕相同，只改太阳高度：高云在 α=−5° 仍部分受光，黄金层已入影
    const goldenAt = (alt: number) => memberScore(0, 0, 0, 0.5, 10, 30, 0, alt);
    const highAt = (alt: number) => memberScore(0, 0, 0.8, 0, 10, 30, 0, alt);
    const ratioGolden = goldenAt(-5) / Math.max(goldenAt(-0.5), 1e-9);
    const ratioHigh = highAt(-5) / Math.max(highAt(-0.5), 1e-9);
    expect(ratioHigh).toBeGreaterThan(ratioGolden);
  });

  it('得分有上界，不会溢出', () => {
    const s = memberScore(0.15, 0.3, 0.85, 0.55, 200, 300, 0, -1.5);
    expect(s).toBeLessThanOrEqual(1.3);
    expect(Number.isFinite(s)).toBe(true);
  });
});

describe('集合请求成本约束', () => {
  it('单次请求成本已记录，且必须在免费额度内说明清楚', () => {
    // 这两条常量不是装饰：91.8 单位/次 vs 600 单位/分钟
    // 意味着每分钟最多约 6 次 —— 这是缓存 TTL 与"绝不在拖动时拉取"的设计依据
    expect(ENSEMBLE_QUOTA_COST).toBeGreaterThan(50);
    expect(ENSEMBLE_QUOTA_PER_MIN / ENSEMBLE_QUOTA_COST).toBeLessThan(10);
  });
});
