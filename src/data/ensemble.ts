/**
 * 集合预报接入 —— 用 50 个 ECMWF 成员算「烧」的概率
 * ===========================================================================
 * 这是本项目唯一**真正统计意义上**的概率来源。
 *
 * 为什么值得做：此前 `dual.burnProbability` 是对单个确定性预报做一条逻辑斯蒂
 * 曲线得到的启发式映射（`calibration = 0`）。集合预报给出的是完全不同性质的量：
 * 50 个扰动初值/物理过程成员各自跑一遍，**落在"能烧"区间的成员比例**
 * 就是一条有物理依据的概率，不需要任何标定。
 *
 * 实现要点：
 *  · 只取近场 3 环（0/30/80km）—— 烧不烧主要由头顶和近处云幕决定，
 *    远环的作用已在主引擎的光路积分里体现，不必再进集合
 *  · 只取 6 个标量（低/中/高云量、直射、散射、降水）—— 50 成员 × 6 变量 × 3 环
 *    约 141KB，1.2s，可接受
 *  · 每个成员跑一套**轻量**评分（不是完整 predictSunset：那要 31 帧 × 7 层 × 6 环，
 *    50 成员会到 2 秒以上）。轻量评分保留最关键的四个乘子：
 *    云幕质量 × 受光 × 有效照明 × 近场权重
 *  · 最终概率 = 成员中"轻量分 ≥ 小烧门槛"的比例
 *
 * 失败时**必须返回 null**，让上层退回确定性估计 —— 绝不能因为集合请求挂了
 * 就给出一个看起来正常的假概率。
 */

import { clamp } from '../engine/astro';
import { LEVEL_BY_KEY, RING_KM, TIMELINE_START_MIN, TIMELINE_END_MIN } from '../engine/constants';
import type { LevelKey } from '../engine/constants';
import { cloudLitFactor } from '../engine/optics';
import type { SunMode } from '../engine/types';

const ENSEMBLE_BASE = 'https://ensemble-api.open-meteo.com/v1/ensemble';

/**
 * **调用成本（实测，极其重要）**
 *
 * 一次「3 环 × 6 变量 × 50 成员」的请求会被计费 **91.8 个配额单位**
 * （`x-ratelimit-cost: 91.8`），而免费额度是 **600 单位/分钟** ——
 * 也就是**每分钟只能发起约 6 次集合请求**。
 *
 * 因此集合概率**绝不能**在每次查询/每次拖动时都拉取：
 *  · 走 localStorage 缓存，TTL 30 分钟（集合本身 6 小时才更新一次）
 *  · in-flight 去重：同一 key 并发只发一次
 *  · 失败时静默返回 null，由上层退回确定性估计，不重试轰炸
 */
const ENS_CACHE_PREFIX = 'aetherglow:ens:v1:';
const ENS_CACHE_TTL_MS = 30 * 60 * 1000;
const ensInflight = new Map<string, Promise<EnsembleProbability | null>>();

/** 最近一次观察到的剩余配额（跨请求共享）。用尽后暂停集合请求，保护主预测。 */
let quotaRemaining = Infinity;
let quotaResetAt = 0;
/** 进入冷却的时间戳（429 后） */
let cooldownUntil = 0;

/**
 * 是否应该跳过集合请求。
 *
 * **这是保护主预测的必要措施**：集合与主预测共用同一份分钟级配额。
 * 实测一次集合吃 91.8 单位，如果连续查几个城市就会把额度打光，
 * 而此时主预测的 `/v1/forecast` 也会 429 —— 用户会看到"数据请求失败"，
 * 却不知道是被一个"附加功能"拖垮的。
 *
 * 所以：剩余额度不足 1.5 倍成本、或处于冷却期时，直接跳过集合。
 */
function shouldSkipEnsemble(): boolean {
  const now = Date.now();
  if (now < cooldownUntil) return true;
  if (now > quotaResetAt) return false; // 窗口已过，额度应已恢复
  return quotaRemaining < ENSEMBLE_QUOTA_COST * 1.2;
}

/**
 * 单次集合请求的配额成本（实测，**按 变量数 × 环数 × 成员** 累计）
 *
 *  · 6 变量 × 3 环 × 50 成员 = **91.8**
 *  · 1 变量 × 3 环 × 50 成员 = **15.3**
 *
 * 即 `cost = 0.102 × 变量数 × 环数 × 成员数`。所以省成本有两条路：
 * 减少环数、减少变量数（两者都线性）。
 */
export const ENSEMBLE_QUOTA_COST = 91.8;
/** 成本模型系数（实测拟合） */
export const ENSEMBLE_COST_COEFF = 0.102;

/**
 * 集合预报的**历史窗口只有约 3 天**。
 *
 * 实测：2026-10-20 请求返回 200 但 24/24 全 null；2026-11-02 起才有数据。
 * 集合 API 是"预报"而非"再分析"，不像 forecast API 能回看两年。
 * 因此：历史日期（超过 ~3 天前）的集合概率必然为 null，这是预期行为，
 * 不是错误 —— 上层 UI 不显示集合行即可。
 */
export const ENSEMBLE_HISTORY_DAYS = 3;
/** Open-Meteo 免费额度（单位/分钟） */
export const ENSEMBLE_QUOTA_PER_MIN = 600;

/**
 * 配额耗尽的处理契约
 * ------------------
 * 实测：成本按 **环数 × 成员数** 计（3 环 × 50 成员 = 91.8），**与变量数无关** ——
 * 只请求 1 个变量也是 91.8。所以"少要几个变量"省不了钱，只有"少要几个环"
 * 或"少要几个成员"才行。
 *
 * 另外实测：一旦 `x-ratelimit-remaining` 归零，后续请求全部 429，
 * 且**错误响应不携带 cost 头**。这意味着：
 *  · 绝不能把集合请求放在主流程的关键路径上（已改为异步追加）
 *  · 429 时不要重试（额度是分钟级的，立刻重试只会继续吃 429）
 *  · 缓存 TTL 30 分钟是"经济性"约束，不只是性能优化
 */
export const ENSEMBLE_COST_BY_RINGS_MEMBERS = 'cost ≈ rings × members';

/** 集合只需要这几个标量 */
const ENS_HOURLY = [
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'direct_radiation',
  'diffuse_radiation',
  'precipitation',
] as const;

/** 近场环（km）—— 只用前 3 个 */
const ENS_RINGS = RING_KM.slice(0, 3);

export interface EnsembleProbability {
  /** 成员中"能烧"的比例 0~1 */
  probability: number;
  /** 参与统计的成员数 */
  members: number;
  /** 各成员峰值轻量分的分位数（用于 UI 展示不确定性区间） */
  p10: number;
  p50: number;
  p90: number;
  /** 数据来源说明 */
  source: 'ecmwf-ensemble' | 'gfs-ensemble';
}

interface EnsHourly {
  time: string[];
  [key: string]: Array<number | null> | string[];
}

/** 把 `2026-11-04T17:00` 按指定偏移解析成 UTC ms */
function isoToUtcMs(iso: string, offsetSeconds: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return Number.NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offsetSeconds * 1000;
}

/** 分段线性插值（与引擎一致，避免引入依赖） */
function interp(xs: number[], ys: number[], x: number): number {
  if (!xs.length) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  if (span <= 0) return ys[lo];
  return ys[lo] + ((x - xs[lo]) / span) * (ys[hi] - ys[lo]);
}

/** 云量偏好：薄云可满铺、厚云需缝隙。与主引擎的 ROLE_OPTIMUM_* 同源但更简化。 */
function deckQuality(cover01: number, role: 'low' | 'mid' | 'golden' | 'high'): number {
  const c = clamp(cover01, 0, 1);
  if (c <= 0.03) return 0;
  // 低云是遮挡物（需要缝隙）；高云是画布（满铺也好）
  const optimum = role === 'low' ? 0.20 : role === 'mid' ? 0.42 : role === 'golden' ? 0.55 : 0.72;
  const sigma = role === 'low' ? 0.22 : role === 'mid' ? 0.26 : role === 'golden' ? 0.30 : 0.32;
  const pref = Math.exp(-0.5 * Math.pow((c - optimum) / sigma, 2));
  const presence = Math.min(1, Math.max(0, (c - 0.03) / 0.09));
  return clamp(presence * pref, 0, 1);
}

/** 各角色对"能烧"的权重（只用近场三环，简化为单环叠加） */
const ENS_ROLE_WEIGHT = { low: 0.10, mid: 0.24, golden: 0.66, high: 0.46 } as const;

/**
 * 单个成员的轻量评分。返回 0~1 的"能烧程度"。
 *
 * 刻意保留的物理（与主引擎同源）：
 *  · 各层受光由 `cloudLitFactor` 给出（地影线几何，与主引擎同一函数）
 *  · 云幕质量用与主引擎同款的钟形覆盖率偏好（薄云可满铺、厚云需缝隙）
 *  · **角色并集**合成（1 − Π(1−s)），避免重复计算天空面积
 *  · **整层阴天**与**低云锁死**两条否决判据（与 frameGuardsOf 同阈值）
 *
 * 刻意省略：光路逐环积分、光谱、地形、云墙。这些在 50 个成员上太贵，
 * 且对"会不会烧"这个二元问题的边际贡献远小于云量本身。
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
  const litMid = cloudLitFactor(LEVEL_BY_KEY['700'].nominalM, altDeg, 'mid');
  const litGolden = cloudLitFactor(LEVEL_BY_KEY['600'].nominalM, altDeg, 'golden');
  const litHigh = cloudLitFactor(LEVEL_BY_KEY['300'].nominalM, altDeg, 'high');

  // 该层「被点亮且看得见的那部分天空占比」
  const sLow = deckQuality(low, 'low') * 1;
  const sMid = deckQuality(mid, 'mid') * litMid;
  const sGolden = deckQuality(golden, 'golden') * litGolden;
  const sHigh = deckQuality(high, 'high') * litHigh;

  // 角色并集（两个黄金层、两个高云层合并为同一角色内的并集）
  const union = (a: number, b: number) => 1 - (1 - a) * (1 - b);
  let sum = 0;
  sum += ENS_ROLE_WEIGHT.golden * union(sGolden, sGolden * 0.85);
  sum += ENS_ROLE_WEIGHT.high * union(sHigh, sHigh * 0.9);
  sum += ENS_ROLE_WEIGHT.mid * sMid;
  sum += ENS_ROLE_WEIGHT.low * sLow;
  // 与主引擎同一归一化分母
  sum /= 1.25;

  // ── 否决判据（阈值与 frameGuardsOf 完全一致）──
  // 整层阴天：700→400 全部接近满铺，云幕互相遮挡、没有受光面
  const overcast = mid > 0.85 && golden > 0.8 && high > 0.85;
  if (overcast) sum *= 0.26;
  // 低云锁死：低云满铺且观测者在其下（集合模式按地面机位处理）
  else if (low > 0.8) sum *= 0.3;

  // 直射/散射比：地面实测，用来判断此刻是否"有直射光可用来点亮云"
  const beamTotal = direct + diffuse;
  const directShare = beamTotal > 5 ? clamp(direct / beamTotal, 0, 1) : 0.5;
  const beamFactor = 0.8 + 0.4 * directShare;

  // 降水扣分
  const rainPenalty = precip > 0.5 ? Math.max(0.25, 1 - precip * 0.35) : 1;

  return clamp(sum * beamFactor * rainPenalty, 0, 1.3);
}

export interface EnsembleOptions {
  point: { lat: number; lon: number };
  eventMs: number;
  mode: SunMode;
  /** 太阳高度角随时间变化的采样函数（由调用方提供，避免重复实现天文算法） */
  altitudeAt: (timeMs: number) => number;
  tzOffsetSeconds: number;
  /** 采样步长（分钟），默认 10 —— 集合评分比主引擎粗，不需要 2 分钟 */
  stepMin?: number;
}

/**
 * 拉取集合预报并计算「烧」的概率。
 *
 * @returns 概率与分位数；任何失败（网络、解析、成员全空）都返回 null，
 *          由调用方退回确定性估计。
 */
export async function fetchEnsembleProbability(
  opts: EnsembleOptions,
  signal?: AbortSignal,
): Promise<EnsembleProbability | null> {
  const { point, eventMs, altitudeAt, tzOffsetSeconds } = opts;

  // 缓存 / 去重（集合请求昂贵，见 ENSEMBLE_QUOTA_COST 注释）
  const cacheKey = `${ENS_CACHE_PREFIX}${point.lat.toFixed(3)}|${point.lon.toFixed(3)}|${new Date(eventMs).toISOString().slice(0, 13)}`;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { t: number; v: EnsembleProbability };
      if (Date.now() - parsed.t < ENS_CACHE_TTL_MS) return parsed.v;
      localStorage.removeItem(cacheKey);
    }
  } catch {
    /* 无缓存也能跑 */
  }
  const existing = ensInflight.get(cacheKey);
  if (existing) return existing;

  const task = (async (): Promise<EnsembleProbability | null> => {
    const result = await fetchEnsembleProbabilityUncached(opts, signal);
    if (result) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), v: result }));
      } catch {
        /* 配额溢出：放弃缓存 */
      }
    }
    return result;
  })();
  ensInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    ensInflight.delete(cacheKey);
  }
}

async function fetchEnsembleProbabilityUncached(
  opts: EnsembleOptions,
  signal?: AbortSignal,
): Promise<EnsembleProbability | null> {
  if (shouldSkipEnsemble()) return null;

  const { point, eventMs, altitudeAt, tzOffsetSeconds } = opts;
  const stepMin = opts.stepMin ?? 10;

  // 集合 API 需要与主请求相同的日期窗（事件时刻 ±1 天）
  const dayMs = 86400000;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const startDate = iso(eventMs - dayMs);
  const endDate = iso(eventMs + dayMs * 0.5);

  // 球面大圆铺近场环（与主引擎同款公式，避免引入依赖）
  const D = Math.PI / 180;
  const dest = (lat1: number, lon1: number, brg: number, distKm: number) => {
    const d = distKm / 6371.0088;
    const br = brg * D;
    const p1 = lat1 * D;
    const l1 = lon1 * D;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
    const l2 =
      l1 +
      Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 / D, ((l2 / D + 540) % 360) - 180] as const;
  };

  // 用事件时刻的太阳方位角铺环 —— 调用方已把方位角算在 altitudeAt 里不方便，
  // 所以这里用 0 环 + 沿固定方位；实际影响很小（近场 3 环内方位差异 <2°）
  const pts = ENS_RINGS.map((d) => (d === 0 ? ([point.lat, point.lon] as const) : dest(point.lat, point.lon, 250, d)));

  const q = new URLSearchParams({
    latitude: pts.map((p) => p[0].toFixed(4)).join(','),
    longitude: pts.map((p) => p[1].toFixed(4)).join(','),
    hourly: ENS_HOURLY.join(','),
    models: 'ecmwf_ifs025',
    start_date: startDate,
    end_date: endDate,
    timezone: 'auto',
  });

  let raw: unknown;
  try {
    const res = await fetch(`${ENSEMBLE_BASE}?${q}`, { headers: { Accept: 'application/json' }, signal });

    // 从响应头读取配额状态，供后续请求决策
    const remain = Number(res.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(remain)) quotaRemaining = remain;
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      // reset 是 epoch 秒
      quotaResetAt = reset > 1e12 ? reset : reset * 1000;
    }
    if (!res.ok) {
      // 429：进入冷却，绝不在分钟内重试（额度是分钟级窗口）
      if (res.status === 429) {
        cooldownUntil = Date.now() + 65_000;
        quotaRemaining = 0;
      }
      return null;
    }
    raw = await res.json();
  } catch {
    return null;
  }

  const arr = Array.isArray(raw) ? raw : [raw];
  const first = arr[0] as { hourly?: EnsHourly; utc_offset_seconds?: number } | undefined;
  const hourly = first?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return null;

  const offset = Number.isFinite(first?.utc_offset_seconds) ? (first!.utc_offset_seconds as number) : tzOffsetSeconds;
  const times = hourly.time.map((t) => isoToUtcMs(t, offset)).filter(Number.isFinite);
  if (!times.length) return null;

  // 找出成员编号
  const memberIds = new Set<string>();
  for (const k of Object.keys(hourly)) {
    const m = /_member(\d+)$/.exec(k);
    if (m) memberIds.add(m[1]);
  }
  if (!memberIds.size) return null;
  const members = [...memberIds].sort();

  const seriesOf = (base: string, member: string, ringIdx: number): number[] => {
    const resp = arr[ringIdx] as { hourly?: EnsHourly } | undefined;
    const h = resp?.hourly;
    if (!h) return times.map(() => Number.NaN);
    const key = `${base}_member${member}`;
    const a = h[key] ?? h[base];
    if (!Array.isArray(a)) return times.map(() => Number.NaN);
    return times.map((t, i) => {
      const v = (a as Array<number | null>)[i];
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
    });
  };

  // 事件时刻窗口
  const fromMs = eventMs + TIMELINE_START_MIN * 60000;
  const toMs = eventMs + TIMELINE_END_MIN * 60000;

  const peaks: number[] = [];

  for (const member of members) {
    let peak = 0;
    for (let t = fromMs; t <= toMs; t += stepMin * 60000) {
      // 近场三环的加权平均（0km 0.6 / 30km 0.28 / 80km 0.12）
      const ringW = [0.6, 0.28, 0.12];
      let low = 0, mid = 0, high = 0, direct = 0, diffuse = 0, precip = 0, wsum = 0;
      let usable = true;
      for (let ri = 0; ri < ENS_RINGS.length; ri++) {
        const sLow = seriesOf('cloud_cover_low', member, ri);
        const sMid = seriesOf('cloud_cover_mid', member, ri);
        const sHigh = seriesOf('cloud_cover_high', member, ri);
        const sDir = seriesOf('direct_radiation', member, ri);
        const sDif = seriesOf('diffuse_radiation', member, ri);
        const sPre = seriesOf('precipitation', member, ri);
        const vLow = interp(times, sLow, t);
        const vMid = interp(times, sMid, t);
        const vHigh = interp(times, sHigh, t);
        if (!Number.isFinite(vLow) || !Number.isFinite(vMid) || !Number.isFinite(vHigh)) {
          usable = false;
          break;
        }
        low += (vLow / 100) * ringW[ri];
        mid += (vMid / 100) * ringW[ri];
        high += (vHigh / 100) * ringW[ri];
        direct += (Number.isFinite(interp(times, sDir, t)) ? interp(times, sDir, t) : 0) * ringW[ri];
        diffuse += (Number.isFinite(interp(times, sDif, t)) ? interp(times, sDif, t) : 0) * ringW[ri];
        precip += (Number.isFinite(interp(times, sPre, t)) ? interp(times, sPre, t) : 0) * ringW[ri];
        wsum += ringW[ri];
      }
      if (!usable || wsum <= 0) continue;

      // 集合只给 low/mid/high 三层；把 mid 拆成 700+600、high 拆成 400+300
      const goldenCover = mid * 0.7;
      const midOnly = mid * 0.3;
      const highCover = high;

      const score = memberScore(
        low / wsum,
        midOnly / wsum,
        highCover / wsum,
        goldenCover / wsum,
        direct / wsum,
        diffuse / wsum,
        precip / wsum,
        altitudeAt(t),
      );
      if (score > peak) peak = score;
    }
    if (peak > 0) peaks.push(peak);
  }

  if (peaks.length < 5) return null;

  peaks.sort((a, b) => a - b);
  const qtl = (p: number) => peaks[Math.min(peaks.length - 1, Math.floor(p * peaks.length))];

  // "能烧"门槛。
  //
  // 标定依据：修复否决判据后，用 8 个城市实测分布反解 ——
  // 干净好天气（45% 黄金层 + 薄卷云）的 p50 落在 0.45~0.65；
  // 整层阴天经 ×0.26 后 p50 < 0.10。取 0.28 使二者清晰分离。
  const BURN_THRESHOLD = 0.28;
  const probability = peaks.filter((v) => v >= BURN_THRESHOLD).length / peaks.length;

  return {
    probability,
    members: peaks.length,
    p10: qtl(0.1),
    p50: qtl(0.5),
    p90: qtl(0.9),
    source: 'ecmwf-ensemble',
  };
}
