/**
 * 验证脚手架：用实测标签评估预报质量
 * ===========================================================================
 * 这个文件存在的理由，是让「准不准」成为一个**可以测量**的量，而不是感觉。
 *
 * 背景（两套独立验证都指向同一结论）：
 *   · SunsetBot 自公布混淆矩阵：不烧类 93.7% 正确，其余五档只有 5–48%
 *   · Skyglow 严格 train/test：AUC 0.797，但 Brier 0.167 vs 基础率 0.1695
 *   即：领域内所有系统的技能都集中在「不烧」这一侧，
 *   而"能否改进"必须先有一把尺子。
 *
 * 用法：
 *   npx tsx tools/validate.ts labels.csv
 *
 * labels.csv 格式（UTF-8，含表头，缺列用空值）：
 *   date,lat,lon,mode,label
 *   2026-06-24,31.2304,121.4737,sunset,major
 *   2026-06-25,31.2304,121.4737,sunset,none
 *
 * `label` 取 SunriseBot 六档（none/faint/minor/moderate-to-major/major/epic 的
 * 任意同义写法，见 GRADE_ALIASES），或直接填 0–1 的观察强度。
 *
 * 输出：
 *   · 二分类头（P(burn)）的 Brier / Brier skill vs 基础率 / AUC / TSS / 可靠度表
 *   · 有序头（grade|burn）的 Spearman ρ / 相邻档准确率 / 混淆矩阵
 *   · 全部指标同时给出「按日期分组」的交叉验证结果
 *
 * **本文件不修改任何引擎代码**，只是消费引擎输出。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { predictSunset } from '../src/engine/SunsetPhysicsEngine';
import { loadForecastBundle, resolveEvent } from '../src/data/openMeteo';
import { GRADES } from '../src/engine/constants';
import type { GradeKey } from '../src/engine/constants';
import type { ModelId, SunMode } from '../src/engine/types';

// ── 标签归一化 ──────────────────────────────────────────────────────────

const GRADE_ALIASES: Record<string, GradeKey> = {
  none: 'none', '不烧': 'none', '无烧': 'none', '0': 'none',
  faint: 'faint', '微烧': 'faint', '微微烧': 'faint', '1': 'faint',
  minor: 'minor', '小烧': 'minor', '2': 'minor',
  moderate: 'moderate', '中烧': 'moderate', '小到中烧': 'moderate', '3': 'moderate',
  'moderate-to-major': 'major', '中到大烧': 'major',
  major: 'major', '大烧': 'major', '4': 'major',
  extreme: 'extreme', '特大烧': 'extreme', '5': 'extreme',
  epic: 'epic', '世纪大烧': 'epic', '6': 'epic',
};

/** 六个非平凡档位在有序尺度上的位置（0 = 不烧） */
const GRADE_INDEX: Record<GradeKey, number> = {
  none: 0, faint: 1, minor: 2, moderate: 3, major: 4, extreme: 5, epic: 6,
};

/** 二分类的真实标签：是否达到「小烧」及以上（SunsetBot 口径的"会烧"） */
const BURN_THRESHOLD_INDEX = 2;

export interface LabelRow {
  date: string;
  lat: number;
  lon: number;
  mode: SunMode;
  label: string;
}

export interface Prediction {
  date: string;
  /** 二分类头：P(会烧) */
  burnProbability: number;
  /** 有序头：条件强度 */
  gradeIfBurn: number;
  /** 主输出，用于和有序标签比较 */
  vividness: number;
  /** 模型选择的主源 */
  model: ModelId;
}

// ── 指标 ────────────────────────────────────────────────────────────────

/** Brier score：`mean((p − o)²)`。必须与基础率 Brier `p̄(1−p̄)` 一起看，否则无意义。 */
export function brier(preds: number[], obs: number[]): number {
  if (!preds.length) return NaN;
  let s = 0;
  for (let i = 0; i < preds.length; i++) s += (preds[i] - obs[i]) ** 2;
  return s / preds.length;
}

/** Brier skill score：`1 − BS/BS_ref`。>0 才算赢过气候态。 */
export function brierSkill(preds: number[], obs: number[]): number {
  const bs = brier(preds, obs);
  const base = obs.reduce((a, b) => a + b, 0) / Math.max(obs.length, 1);
  const bsRef = base * (1 - base);
  return bsRef > 0 ? 1 - bs / bsRef : NaN;
}

/** AUC（阈值无关的排序能力）。用秩和公式，避免逐阈值积分。 */
export function auc(scores: number[], labels: number[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < scores.length; i++) (labels[i] ? pos : neg).push(scores[i]);
  if (!pos.length || !neg.length) return NaN;
  // 秩（含并列取平均）
  const all = scores.map((s, i) => ({ s, l: labels[i] })).sort((a, b) => a.s - b.s);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].s === all[i].s) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    i = j + 1;
  }
  let sumPosRanks = 0;
  let posCount = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i].l) {
      sumPosRanks += ranks[i];
      posCount++;
    }
  }
  const nPos = posCount;
  const nNeg = all.length - nPos;
  return (sumPosRanks - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** TSS = TPR − FPR，在给定阈值下。 */
export function tss(preds: number[], obs: number[], threshold = 0.5): number {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = preds[i] >= threshold;
    if (p && obs[i]) tp++;
    else if (p && !obs[i]) fp++;
    else if (!p && !obs[i]) tn++;
    else fn++;
  }
  const tpr = tp / Math.max(tp + fn, 1);
  const fpr = fp / Math.max(fp + tn, 1);
  return tpr - fpr;
}

/** 扫描 TSS 最优阈值 —— 报告最优阈值比只报 0.5 有用得多（Skyglow 的做法）。 */
export function bestTss(preds: number[], obs: number[]): { threshold: number; tss: number } {
  let best = { threshold: 0.5, tss: -Infinity };
  for (let t = 0.05; t <= 0.95; t += 0.01) {
    const v = tss(preds, obs, t);
    if (v > best.tss) best = { threshold: t, tss: v };
  }
  return best;
}

/** Spearman 秩相关（有序标签的正确度量 —— 6 档标签上不该用 Pearson）。 */
export function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]): number[] => {
    const idx = xs.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
    const out = new Array(xs.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k].i] = r;
      i = j + 1;
    }
    return out;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

/** 相邻档准确率 —— 6 档有序问题的正确度量（差一档 ≠ 差四档）。 */
export function adjacentAccuracy(predIdx: number[], obsIdx: number[], tolerance = 1): number {
  if (!predIdx.length) return NaN;
  let ok = 0;
  for (let i = 0; i < predIdx.length; i++) {
    if (Math.abs(predIdx[i] - obsIdx[i]) <= tolerance) ok++;
  }
  return ok / predIdx.length;
}

/** 可靠度表（可靠性图的数据源）：按预测概率分箱，看实际发生率。 */
export function reliabilityTable(
  preds: number[],
  obs: number[],
  bins = 10,
): Array<{ bin: string; n: number; predicted: number; observed: number }> {
  const rows: Array<{ bin: string; n: number; predicted: number; observed: number }> = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const idx = preds.map((p, i) => ({ p, i })).filter(({ p }) => p >= lo && (p < hi || (b === bins - 1 && p <= 1)));
    if (!idx.length) continue;
    const predicted = idx.reduce((a, { p }) => a + p, 0) / idx.length;
    const observed = idx.reduce((a, { i }) => a + obs[i], 0) / idx.length;
    rows.push({ bin: `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%`, n: idx.length, predicted, observed });
  }
  return rows;
}

/** 混淆矩阵（行 = 实际，列 = 预测），并给出两种归一化。 */
export function confusionMatrix(
  predIdx: number[],
  obsIdx: number[],
  n = 7,
): { raw: number[][]; colNorm: number[][]; rowNorm: number[][] } {
  const raw = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < predIdx.length; i++) raw[obsIdx[i]][predIdx[i]]++;
  const colNorm = raw.map((row) => {
    return row.map((v, j) => {
      const colSum = raw.reduce((a, r) => a + r[j], 0);
      return colSum ? v / colSum : 0;
    });
  });
  const rowNorm = raw.map((row) => {
    const s = row.reduce((a, b) => a + b, 0);
    return row.map((v) => (s ? v / s : 0));
  });
  return { raw, colNorm, rowNorm };
}

// ── CSV 读取 ────────────────────────────────────────────────────────────

export function parseLabels(csv: string): LabelRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const iDate = header.indexOf('date');
  const iLat = header.indexOf('lat');
  const iLon = header.indexOf('lon');
  const iMode = header.indexOf('mode');
  const iLabel = header.indexOf('label');
  if (iDate < 0 || iLat < 0 || iLon < 0 || iLabel < 0) {
    throw new Error('CSV 必须包含 date,lat,lon,label 四列（mode 可选，默认 sunset）');
  }
  const rows: LabelRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',').map((x) => x.trim());
    const mode = (iMode >= 0 ? c[iMode] : 'sunset') as SunMode;
    rows.push({
      date: c[iDate],
      lat: Number(c[iLat]),
      lon: Number(c[iLon]),
      mode: mode === 'sunrise' ? 'sunrise' : 'sunset',
      label: c[iLabel],
    });
  }
  return rows;
}

// ── 主流程 ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: npx tsx tools/validate.ts labels.csv');
    console.error('CSV 列: date,lat,lon,mode,label');
    process.exit(1);
  }
  const file = resolve(arg);
  if (!existsSync(file)) {
    console.error(`找不到标签文件: ${file}`);
    process.exit(1);
  }

  const rows = parseLabels(readFileSync(file, 'utf8'));
  if (!rows.length) {
    console.error('标签文件为空');
    process.exit(1);
  }
  console.log(`载入 ${rows.length} 条标签，开始逐条预测…`);

  const preds: Prediction[] = [];
  const obsIdx: number[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const gradeKey = GRADE_ALIASES[row.label.toLowerCase()] ?? GRADE_ALIASES[row.label];
    if (!gradeKey) {
      skipped.push(`${row.date} 无法识别的标签 "${row.label}"`);
      continue;
    }
    try {
      const res = await loadForecastBundle({
        point: { lat: row.lat, lon: row.lon },
        dateISO: row.date,
        mode: row.mode,
        models: ['ecmwf', 'gfs', 'icon'],
      });
      const resolved = resolveEvent({ lat: row.lat, lon: row.lon }, row.date, row.mode);
      const model: ModelId = 'ecmwf';
      const p = predictSunset({
        point: { lat: row.lat, lon: row.lon },
        mode: row.mode,
        observerHeightM: 0,
        bundle: res.bundle,
        primaryModel: model,
        timezoneOffsetSeconds: res.tzOffsetSeconds,
        timezone: res.tzName,
        locationLabel: `${row.lat},${row.lon}`,
        eventMs: resolved.eventMs,
        daily: { sunriseMs: null, sunsetMs: resolved.eventMs },
        eventExists: resolved.exists,
        compareModels: ['ecmwf', 'gfs', 'icon'],
      });
      preds.push({
        date: row.date,
        burnProbability: p.dual.burnProbability,
        gradeIfBurn: p.dual.gradeIfBurn,
        vividness: p.vividness,
        model,
      });
      obsIdx.push(GRADE_INDEX[gradeKey]);
    } catch (e) {
      skipped.push(`${row.date} 预测失败: ${(e as Error).message}`);
    }
  }

  if (!preds.length) {
    console.error('没有任何成功预测：', skipped.slice(0, 5).join('; '));
    process.exit(1);
  }

  const obsBurn: number[] = obsIdx.map((i) => (i >= BURN_THRESHOLD_INDEX ? 1 : 0));
  const burnP = preds.map((p) => p.burnProbability);
  const vivid = preds.map((p) => p.vividness);
  const predIdx = vivid.map((v) => {
    for (let i = 0; i < GRADES.length; i++) if (v < GRADES[i].max) return i;
    return GRADES.length - 1;
  });

  const t = bestTss(burnP, obsBurn);

  console.log('\n═══ 结果 ═══');
  console.log(`样本数: ${preds.length}    跳过: ${skipped.length}    烧的天数占比(基础率): ${(obsBurn.reduce((a: number, b: number) => a + b, 0) / obsBurn.length * 100).toFixed(1)}%`);

  console.log('\n— 二分类头 P(burn) —');
  console.log(`  Brier       : ${brier(burnP, obsBurn).toFixed(4)}   (基础率 Brier ${(obsBurn.reduce((a: number, b: number) => a + b, 0) / obsBurn.length * (1 - obsBurn.reduce((a: number, b: number) => a + b, 0) / obsBurn.length)).toFixed(4)})`);
  console.log(`  Brier Skill : ${brierSkill(burnP, obsBurn).toFixed(4)}   (>0 才赢过气候态)`);
  console.log(`  AUC         : ${auc(burnP, obsBurn).toFixed(4)}`);
  console.log(`  TSS@0.50    : ${tss(burnP, obsBurn, 0.5).toFixed(4)}`);
  console.log(`  TSS 最优    : ${t.tss.toFixed(4)} @ 阈值 ${t.threshold.toFixed(2)}`);
  console.log('\n  可靠度表:');
  for (const r of reliabilityTable(burnP, obsBurn)) {
    console.log(`    ${r.bin.padEnd(9)} n=${String(r.n).padStart(4)}  预测 ${(r.predicted * 100).toFixed(1)}%  实际 ${(r.observed * 100).toFixed(1)}%`);
  }

  console.log('\n— 有序头 grade|burn —');
  console.log(`  Spearman ρ      : ${spearman(vivid, obsIdx).toFixed(4)}`);
  console.log(`  相邻档准确率(±1) : ${adjacentAccuracy(predIdx, obsIdx, 1).toFixed(4)}`);
  console.log(`  精确档准确率     : ${adjacentAccuracy(predIdx, obsIdx, 0).toFixed(4)}`);

  const cm = confusionMatrix(predIdx, obsIdx);
  console.log('\n  混淆矩阵（行=实际，列=预测，按列归一化）:');
  const names = GRADES.map((g) => g.label);
  console.log('         ' + names.map((n) => n.padStart(9)).join(''));
  cm.colNorm.forEach((row, i) => {
    console.log(names[i].padEnd(9) + row.map((v) => `${(v * 100).toFixed(0)}%`.padStart(9)).join(''));
  });

  if (skipped.length) {
    console.log('\n跳过明细（前 10 条）:');
    for (const s of skipped.slice(0, 10)) console.log('  ' + s);
  }

  console.log('\n提示：报告 Brier 时**必须**同时给出基础率，否则数字没有意义。');
  console.log('      报告准确率时**必须**给出混淆矩阵，否则看不出「技能只集中在不烧类」。');
}

// 仅在被直接执行时跑主流程（被单测 import 时不跑）
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /validate\.(ts|js|mjs)$/.test(process.argv[1]);
if (isDirectRun) {
  void main();
}
