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
  moderateplus: 'moderatePlus',
  'moderate-to-major': 'majorLow',
  majorlow: 'majorLow',
  majordlow: 'majorLow', // 兼容历史误拼写
  '中到大烧': 'majorLow',
  major: 'major', '大烧': 'major', '4': 'major',
  extreme: 'extreme', '特大烧': 'extreme', '5': 'extreme',
  premium: 'premium',
  epic: 'epic', '世纪大烧': 'epic', '6': 'epic',
};

/** 六个非平凡档位在有序尺度上的位置（0 = 不烧） */
const GRADE_INDEX: Record<GradeKey, number> = {
  none: 0, faint: 1, minor: 2, moderate: 3,
  moderatePlus: 3, majorLow: 4, major: 4,
  extreme: 5, premium: 5, epic: 6,
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
  for (let i = 0; i < predIdx.length; i++) {
    const r = obsIdx[i];
    const c = predIdx[i];
    // 越界必须显式跳过而不是静默写入。JS 数组对 `raw[3][9]++` 不会报错，
    // 会把该行悄悄变成稀疏数组，后续 colNorm 的 reduce 求和就错了。
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    if (r < 0 || r >= n || c < 0 || c >= n) continue;
    raw[r][c]++;
  }
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

/** 终端对齐：CJK 字符占两个显示列，String.padStart 会把它们当 1 列 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return w;
}
function padStartDisplay(s: string, n: number): string {
  const d = n - displayWidth(s);
  return d > 0 ? ' '.repeat(d) + s : s;
}
function padEndDisplay(s: string, n: number): string {
  const d = n - displayWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

/**
 * 按**日期**分组的 k 折交叉验证（审查 P1）。
 *
 * 在全样本上选 TSS 最优阈值、再在全样本上报这个 TSS，是教科书式的
 * 过拟合 —— Skyglow 的教训正是"训练集 AUC 0.85、留出集 0.797"。
 *
 * 分组必须按日期：同一地点相邻日期的云场强相关，随机打散会把
 * "几乎同一天"同时放进训练折和测试折，留出误差虚低。
 *
 * @returns 每折一行（阈值在训练折上选、TSS 在两侧各报一次）；
 *          不同日期数 < 3 时返回 null（做不了交叉验证）。
 */
export function dateGroupedCV(
  dates: string[],
  preds: number[],
  obs: number[],
  k = 5,
): Array<{ fold: number; trainN: number; testN: number; threshold: number; tssTrain: number; tssTest: number }> | null {
  const uniq = [...new Set(dates)].sort();
  if (uniq.length < 3) return null;
  const kk = Math.min(k, uniq.length);
  // 按日期排序后**连续**切块（不打乱）：保留时间邻接结构，
  // 留出折始终是一段"未来的日子"。
  const foldOf = new Map(uniq.map((d, i) => [d, Math.floor((i * kk) / uniq.length)]));
  const rows: Array<{ fold: number; trainN: number; testN: number; threshold: number; tssTrain: number; tssTest: number }> = [];
  for (let f = 0; f < kk; f++) {
    const trP: number[] = [], trO: number[] = [], teP: number[] = [], teO: number[] = [];
    for (let i = 0; i < preds.length; i++) {
      if (foldOf.get(dates[i]) === f) { teP.push(preds[i]); teO.push(obs[i]); }
      else { trP.push(preds[i]); trO.push(obs[i]); }
    }
    if (!teP.length || !trP.length) continue;
    const bt = bestTss(trP, trO);
    rows.push({ fold: f, trainN: trP.length, testN: teP.length, threshold: bt.threshold, tssTrain: bt.tss, tssTest: tss(teP, teO, bt.threshold) });
  }
  return rows.length ? rows : null;
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

/** 把离散别名或 0–1 连续标签统一为有序尺度，同时保留连续值供 Spearman 使用。 */
export function normalizeObservedLabel(label: string): { index: number; ordinal: number } | null {
  const text = label.trim();
  if (!text) return null;
  const gradeKey = GRADE_ALIASES[text.toLowerCase()] ?? GRADE_ALIASES[text];
  if (gradeKey) {
    const index = GRADE_INDEX[gradeKey];
    return { index, ordinal: index };
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) return null;
  const ordinal = numeric * 6;
  return { index: Math.min(6, Math.max(0, Math.round(ordinal))), ordinal };
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
  // 秩相关保留连续观测强度；obsIdx 的离散副本只用于分类与混淆矩阵。
  const obsOrdinal: number[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const normalized = normalizeObservedLabel(row.label);
    if (!normalized) {
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
        // **必须按 mode 填对字段**（P2 修复）：上一版无论朝霞晚霞都写
        // `sunriseMs: null`，于是所有朝霞样本在引擎里都是"今日无日出"，
        // 走极昼/极夜兜底分支 —— 样本外校准的朝霞部分完全无效。
        daily:
          row.mode === 'sunrise'
            ? { sunriseMs: resolved.eventMs, sunsetMs: null }
            : { sunriseMs: null, sunsetMs: resolved.eventMs },
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
      obsIdx.push(normalized.index);
      obsOrdinal.push(normalized.ordinal);
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
  // **必须映射到 0..6 的有序档位（GRADE_INDEX 的值域），而不是 0..9 的
  // GRADES 数组下标**。上一版直接取 `GRADES` 下标（0..9），而真实标签只有
  // 7 档（GRADE_INDEX 把 moderatePlus→3、majorLow→4、premium→5 归并了），
  // `confusionMatrix(predIdx, obsIdx)` 默认 n=7 就会越界写：
  //   predIdx = 7（extreme）→ raw[obs][7] 虽然还在 7×7 外但 JS 数组不报错，
  //   实际是把 7×7 矩阵当成稀疏扩展，导致 colNorm 求和错误、出现 NaN；
  //   且 `adjacentAccuracy` 在 7 档与 10 档之间错位比较，准确率完全失真。
  const predIdx = vivid.map((v) => {
    for (let i = 0; i < GRADES.length; i++) if (v < GRADES[i].max) return GRADE_INDEX[GRADES[i].key];
    return GRADE_INDEX[GRADES[GRADES.length - 1].key];
  });

  const t = bestTss(burnP, obsBurn);

  console.log('\n═══ 结果 ═══');
  console.log(`样本数: ${preds.length}    跳过: ${skipped.length}    烧的天数占比(基础率): ${(obsBurn.reduce((a: number, b: number) => a + b, 0) / obsBurn.length * 100).toFixed(1)}%`);

  console.log('\n— 二分类头 P(burn) —');
  console.log(`  Brier       : ${brier(burnP, obsBurn).toFixed(4)}   (基础率 Brier ${(obsBurn.reduce((a: number, b: number) => a + b, 0) / obsBurn.length * (1 - obsBurn.reduce((a: number, b: number) => a + b, 0) / obsBurn.length)).toFixed(4)})`);
  console.log(`  Brier Skill : ${brierSkill(burnP, obsBurn).toFixed(4)}   (>0 才赢过气候态)`);
  console.log(`  AUC         : ${auc(burnP, obsBurn).toFixed(4)}`);
  console.log(`  TSS@0.50    : ${tss(burnP, obsBurn, 0.5).toFixed(4)}`);
  console.log(`  TSS 最优    : ${t.tss.toFixed(4)} @ 阈值 ${t.threshold.toFixed(2)}   (in-sample，偏乐观)`);

  // 按日期分组的交叉验证：阈值只在训练折上选，留出折上的 TSS 才是
  // 「明天再来一天新数据」时期望拿到的技能。两者差值即阈值过拟合幅度。
  const cv = dateGroupedCV(preds.map((p) => p.date), burnP, obsBurn);
  if (cv) {
    console.log('\n  交叉验证（按日期分组，阈值仅由训练折选出）:');
    console.log('    fold  trainN  testN  阈值    TSS(训练)  TSS(留出)');
    for (const r of cv) {
      console.log(
        `    ${String(r.fold).padEnd(5)} ${String(r.trainN).padStart(6)} ${String(r.testN).padStart(6)}  ${r.threshold.toFixed(2)}    ${r.tssTrain.toFixed(4)}     ${r.tssTest.toFixed(4)}`,
      );
    }
    const testTotal = cv.reduce((a, r) => a + r.testN, 0);
    const meanOut = cv.reduce((a, r) => a + r.tssTest * r.testN, 0) / Math.max(testTotal, 1);
    console.log(`    留出折合样本 TSS: ${meanOut.toFixed(4)}   (按 testN 加权；相对 in-sample 最优 ${t.tss.toFixed(4)} 的落差 = 过拟合)`);
  } else {
    console.log('\n  交叉验证：不同日期 < 3 天，无法分组，以上 TSS 均为 in-sample（偏乐观）。');
  }
  console.log('\n  可靠度表:');
  for (const r of reliabilityTable(burnP, obsBurn)) {
    console.log(`    ${r.bin.padEnd(9)} n=${String(r.n).padStart(4)}  预测 ${(r.predicted * 100).toFixed(1)}%  实际 ${(r.observed * 100).toFixed(1)}%`);
  }

  console.log('\n— 有序头 grade|burn —');
  console.log(`  Spearman ρ      : ${spearman(vivid, obsOrdinal).toFixed(4)}`);
  console.log(`  相邻档准确率(±1) : ${adjacentAccuracy(predIdx, obsIdx, 1).toFixed(4)}`);
  console.log(`  精确档准确率     : ${adjacentAccuracy(predIdx, obsIdx, 0).toFixed(4)}`);

  const cm = confusionMatrix(predIdx, obsIdx);
  console.log('\n  混淆矩阵（行=实际，列=预测，按列归一化）:');
  // 表头必须是 GRADE_INDEX 值域（0..6）的 7 个档名，不是 GRADES 的 10 个 ——
  // 矩阵本身只有 7×7（moderatePlus→3、majorLow→4、premium→5 已归并），
  // 用 10 个名字会让列与档错位（审查 P1）。
  const names = ['无烧', '微烧', '小烧', '中烧', '中到大烧', '特大烧', '世纪大烧'];
  console.log('         ' + names.map((n) => padStartDisplay(n, 9)).join(''));
  cm.colNorm.forEach((row, i) => {
    console.log(padEndDisplay(names[i], 9) + row.map((v) => `${(v * 100).toFixed(0)}%`.padStart(9)).join(''));
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
