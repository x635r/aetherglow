/**
 * 验证指标的单元测试
 * ---------------------------------------------------------------------------
 * 这些指标是「准不准」这把尺子本身，必须先证明尺子是对的。
 * 每个测试用**手工可算**的小样本锁定定义。
 */

import { describe, expect, it } from 'vitest';
import {
  adjacentAccuracy,
  auc,
  bestTss,
  brier,
  brierSkill,
  confusionMatrix,
  normalizeObservedLabel,
  parseLabels,
  reliabilityTable,
  spearman,
  tss,
} from '../tools/validate';

describe('Brier score', () => {
  it('完美预报 = 0', () => {
    expect(brier([1, 0, 1, 0], [1, 0, 1, 0])).toBe(0);
  });

  it('完全反向预报 = 1', () => {
    expect(brier([0, 1, 0, 1], [1, 0, 1, 0])).toBe(1);
  });

  it('手算：[(0.9−1)² + (0.1−0)²]/2 = 0.01', () => {
    expect(brier([0.9, 0.1], [1, 0])).toBeCloseTo(0.01, 10);
  });

  it('基础率预报（全部输出 0.5）在均衡样本上 Brier = 0.25', () => {
    expect(brier([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBeCloseTo(0.25, 10);
  });
});

describe('Brier skill score', () => {
  it('基础率预报得分恰为 0（没有技能）', () => {
    // 基础率 0.5 → bsRef = 0.25，而基础率预报的 BS 也是 0.25
    expect(brierSkill([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('优于气候态时为正', () => {
    expect(brierSkill([0.9, 0.1, 0.85, 0.15], [1, 0, 1, 0])).toBeGreaterThan(0);
  });

  it('劣于气候态时为负', () => {
    // 观测基础率 50%，但预报系统性地"反着报"：给真值低概率、给假值高概率
    // BS = [(0.4−1)² + (0.6−0)² ×3] / 4 = (0.36 + 1.08)/4 = 0.36 > bsRef 0.25
    expect(brierSkill([0.4, 0.6, 0.6, 0.6], [1, 0, 0, 0])).toBeLessThan(0);
  });
});

describe('AUC', () => {
  it('完美排序 = 1', () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
  });

  it('完全反向 = 0', () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
  });

  it('全部并列 = 0.5（无分辨力）', () => {
    expect(auc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.5);
  });

  it('部分并列仍能正确计算', () => {
    // 正类 1 个（分数 0.5），负类 2 个（0.5 与 0.1）
    // 配对：(0.5,0.5)=0.5 分，(0.5,0.1)=1 分 → AUC = 0.75
    expect(auc([0.5, 0.5, 0.1], [1, 0, 0])).toBeCloseTo(0.75, 10);
  });
});

describe('TSS', () => {
  it('完美分类 = 1', () => {
    expect(tss([0.9, 0.9, 0.1, 0.1], [1, 1, 0, 0], 0.5)).toBe(1);
  });

  it('最差的"全报无烧"在基础率 50% 时 TSS = 0', () => {
    // 全报 0：TPR=0, FPR=0 → TSS=0
    expect(tss([0, 0, 0, 0], [1, 0, 1, 0], 0.5)).toBe(0);
  });

  it('全报有烧：TPR=1, FPR=1 → TSS=0', () => {
    expect(tss([1, 1, 1, 1], [1, 0, 1, 0], 0.5)).toBe(0);
  });

  it('bestTss 找到比 0.5 更好的阈值', () => {
    // 预测分数整体偏低，但排序完美 → 最优阈值应显著低于 0.5
    const preds = [0.30, 0.28, 0.10, 0.08];
    const obs = [1, 1, 0, 0];
    const best = bestTss(preds, obs);
    expect(best.tss).toBeGreaterThan(tss(preds, obs, 0.5));
    expect(best.threshold).toBeGreaterThan(0.1);
    expect(best.threshold).toBeLessThan(0.3);
  });
});

describe('Spearman', () => {
  it('完全一致 = 1', () => {
    expect(spearman([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 10);
  });

  it('完全反向 = −1', () => {
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
  });

  it('对单调非线性变换不变（这是它相对于 Pearson 的关键优势）', () => {
    const a = [1, 2, 3, 4, 5];
    const b = a.map((x) => x ** 3);
    expect(spearman(a, b)).toBeCloseTo(1, 10);
  });

  it('有并列时使用平均秩', () => {
    const r = spearman([1, 2, 2, 3], [1, 2, 3, 4]);
    expect(r).toBeGreaterThan(0.8);
    expect(r).toBeLessThan(1);
  });
});

describe('相邻档准确率', () => {
  it('±1 容忍把差一档都算对', () => {
    // 预测 [3,3,3]，实际 [3,4,5] → 前两个在 ±1 内，第三个差 2
    expect(adjacentAccuracy([3, 3, 3], [3, 4, 5], 1)).toBeCloseTo(2 / 3, 10);
  });

  it('±0 等同精确准确率', () => {
    expect(adjacentAccuracy([1, 2, 3], [1, 9, 3], 0)).toBeCloseTo(2 / 3, 10);
  });
});

describe('可靠度表', () => {
  it('分箱后的预测均值与观测率可对照', () => {
    // 4 个样本落在 [0.9,1.0) 箱，全为真 → predicted≈0.925, observed=1
    const rows = reliabilityTable([0.9, 0.92, 0.95, 0.99], [1, 1, 1, 1], 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(4);
    expect(rows[0].observed).toBe(1);
    expect(rows[0].predicted).toBeGreaterThan(0.9);
  });

  it('空箱不出现在结果里', () => {
    const rows = reliabilityTable([0.51], [1], 10);
    expect(rows).toHaveLength(1);
  });
});

describe('混淆矩阵', () => {
  it('行列归一化各自正确', () => {
    // 实际 0 预测 0 两次；实际 1 预测 0 一次、预测 1 一次
    const cm = confusionMatrix([0, 0, 0, 1], [0, 0, 1, 1], 2);
    expect(cm.raw[0][0]).toBe(2);
    expect(cm.raw[1][0]).toBe(1);
    expect(cm.raw[1][1]).toBe(1);
    // 列 0 归一化：2/(2+1), 1/(2+1)
    expect(cm.colNorm[0][0]).toBeCloseTo(2 / 3, 10);
    // 行 1 归一化：0.5 / 0.5
    expect(cm.rowNorm[1][0]).toBeCloseTo(0.5, 10);
  });
});

describe('CSV 解析', () => {
  it('读取标准四列', () => {
    const rows = parseLabels('date,lat,lon,label\n2026-06-24,31.23,121.47,major');
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('major');
    expect(rows[0].mode).toBe('sunset');
  });

  it('mode 列可选，忽略注释行', () => {
    const rows = parseLabels('# comment\ndate,lat,lon,mode,label\n2026-06-24,31.23,121.47,sunrise,小烧');
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('sunrise');
  });

  it('缺必需列时抛错', () => {
    expect(() => parseLabels('date,lat\n2026-06-24,31.23')).toThrow();
  });
});

describe('观测标签归一化', () => {
  it('接受 majorlow，并保留历史误拼 majordlow', () => {
    expect(normalizeObservedLabel('majorlow')).toEqual({ index: 4, ordinal: 4 });
    expect(normalizeObservedLabel('majordlow')).toEqual({ index: 4, ordinal: 4 });
  });

  it('连续标签保留 0–6 有序强度，同时映射到最近档位', () => {
    expect(normalizeObservedLabel('0.5')).toEqual({ index: 3, ordinal: 3 });
    expect(normalizeObservedLabel('0.75')).toEqual({ index: 5, ordinal: 4.5 });
  });

  it('拒绝空标签、非数值和超出 0–1 的连续标签', () => {
    expect(normalizeObservedLabel('')).toBeNull();
    expect(normalizeObservedLabel('unknown')).toBeNull();
    expect(normalizeObservedLabel('1.01')).toBeNull();
    expect(normalizeObservedLabel('-0.01')).toBeNull();
  });
});
