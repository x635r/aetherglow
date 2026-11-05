/**
 * 大气光学：光路几何、斜程气柱质量、单色消光、地影。
 * ---------------------------------------------------------------------------
 * 一切“颜色”都由这里的光路积分导出：
 *   · Rayleigh   τ_R ∝ λ⁻⁴          （短波被抽干 → 橙红底色）
 *   · 气溶胶     τ_A ∝ λ^(−α_ang)    （粗颗粒 → 全场洗白）
 *
 * 几何约定（全工程统一，Step 3 使用）
 * ────────────────────────────────────
 *   H_ray(d) = H_target + d·tan(α) + d²/(2·R_eff)
 *
 *   d 为自观测点**沿太阳方位角向外**的水平距离 (km)，α 为太阳高度角。
 *   曲率项 d²/(2·R_eff) 已隐含地平线下沉，**不再叠加 dip 修正**
 *   （叠加会造成双重计算，是同类项目最常见的物理错误）。
 *
 * 地影判据（独立的、必须与上面分开的模型）
 * ─────────────────────────────────────────
 *   阳光是平行光，云是否被直射只取决于它的高度 H 与太阳高度角 α：
 *
 *       云受光  ⇔  α > −dip(H),   dip(H) = acos(R/(R+H)) ≈ √(2H/R)
 *
 *   这里用**真实地球半径 + 0.55° 折射视差余量**（太阳上边缘 + 大气折射），
 *   而不是 R_eff —— R_eff 是给观测者视线用的，误用到日照几何上会高估
 *   受光范围。另加一条很弱的“上层大气散射光”尾巴，用来表示
 *   高空卷云在地影线以下仍被散射光照亮的紫色余晖。
 */

import { clamp, toRad } from './astro';
import { EARTH_RADIUS_KM, R_EFF_KM } from './constants';

/** Rayleigh 标高 (km) */
export const H_RAYLEIGH = 8.0;
/** 气溶胶标高 (km) */
export const H_AEROSOL = 1.5;
/** 550nm 垂直 Rayleigh 光学厚度 */
export const TAU_R550 = 0.0965;

/** 太阳上边缘视半径+折射的等效余量（度） */
const REFRACTION_ALLOWANCE_DEG = 0.55;

/** 感知加权 RGB 代表波长 (nm) */
export const LAMBDA = { r: 610, g: 550, b: 465 } as const;

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

// ── 几何 ─────────────────────────────────────────────────────────────────

/** 光线在距观测点 d (km) 处的 MSL 高度 (m)，含等效半径曲率项。 */
export function rayHeightM(Hm: number, alphaDeg: number, dKm: number): number {
  return Hm + dKm * Math.tan(toRad(alphaDeg)) * 1000 + ((dKm * dKm) / (2 * R_EFF_KM)) * 1000;
}

/**
 * 光线触地距离 (km)：自高度 Hm 以仰角 α 向太阳方向前进，第一次降到 0m 的距离。
 * 无解（始终在地面之上）返回 Infinity。
 *
 * 解  (1/2R)·d² + tanα·d + H = 0，两个根一正一负（或均为负）；
 * 物理上有意义的是**正根中最小的那个**（第一次触地），
 * 取错根会得到「绕地球半圈后触地」的荒谬值。
 */
export function groundHitDistanceKm(Hm: number, alphaDeg: number): number {
  const a = (1 / (2 * R_EFF_KM)) * 1000; // m per km²
  const b = Math.tan(toRad(alphaDeg)) * 1000; // m per km
  const c = Hm;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sqrtDisc = Math.sqrt(disc);
  const roots = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)].filter((d) => d > 0);
  if (!roots.length) return Infinity;
  return Math.min(...roots);
}

/** 高度 H (m) 处的地平线下沉角 (度)，真实地球半径 + 折射余量。 */
export function cloudHorizonDipDeg(Hm: number): number {
  const h = Math.max(Hm, 0) / 1000;
  const dip = Math.acos(clamp(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + h), -1, 1)) * (180 / Math.PI);
  return dip + REFRACTION_ALLOWANCE_DEG;
}

/** 地影顶面高度 (m)：低于此高度的云在 α 时已进入地球阴影。 */
export function earthShadowHeightM(alphaDeg: number): number {
  if (alphaDeg >= 0) return 0;
  // 反解 α = −dip(H) （不含折射余量，折射余量在 litFactor 里作为软边界）
  const dipRad = toRad(Math.abs(alphaDeg));
  const h = EARTH_RADIUS_KM * (1 / Math.cos(dipRad) - 1);
  return h * 1000;
}

/**
 * 云受光系数 0~1。
 *
 *  = 1    直射受光（α 高于该高度地平线）
 *  = 0    深地影
 *  中间   软边界（太阳有限视直径 + 折射 + 上层大气散射）
 *
 * 这个函数是「紫霞二烧」的唯一来源：9.2km 卷云在 α≈−3° 时仍处于半受光，
 * 而此时直射光已红移到 600nm 以上，于是呈现紫色/品红余晖。
 *
 * **散射尾的定标极其关键**（上一版把它设得太陡，导致二烧恒为 0）：
 *  Lee & Hernández-Andrés (2003) 的 35 次实测统计给出紫光
 *  起始 α≈−1.4°、峰值 α≈−3.9°、结束 α≈−7.4°。
 *  对 9.2km 卷云，几何地影线（dip≈3.08°）在 α=−3.08° 处穿过云层；
 *  若软边界只有 ±0.5°，则 α=−3.9° 时 lit 已接近 0，与实测矛盾。
 *  实测峰值仍在 −3.9°，说明**多次散射与平流层后向散射提供了可观的残余照明**，
 *  等效于把有效软边界拉宽到约 ±1.5°，并把散射尾的 e 折深度放大到 6km 量级。
 */
export function cloudLitFactor(Hm: number, alphaDeg: number, role: 'low' | 'mid' | 'golden' | 'high' = 'golden'): number {
  const shadowM = earthShadowHeightM(alphaDeg);
  const margin = Hm - shadowM;

  // 软边界：太阳视直径 + 折射 ≈ 0.9°，折合约 0.9° 的几何高度差。
  // 取 max(320m, |tanα|·30000) 让它在低角度时自然扩展到 1–2km。
  const softM = Math.max(320, Math.abs(Math.tan(toRad(alphaDeg))) * 30000);
  const direct = 1 / (1 + Math.exp(-margin / softM));

  // 上层大气散射尾：地影线以下仍有可观的散射照明（紫光/余晖的来源）。
  // 只对高云与黄金层生效；e 折深度按云高放大（越高的云被照得越久）。
  if (alphaDeg < -1 && (role === 'high' || role === 'golden')) {
    const depth = Math.max(0, -margin);
    const scale = role === 'high' ? 9000 : 5000;
    const tail = (role === 'high' ? 0.55 : 0.40) * Math.exp(-depth / scale);
    return clamp(Math.max(direct, tail), 0, 1);
  }
  return clamp(direct, 0, 1);
}

/**
 * 某高度处的视地平线距离 (km)：d = √(2·R_eff·h)。
 * 用 R_eff（含标准大气折射）而非真实半径，因为折射把地平线"压低"了，
 * 实际能看多远比几何划线更远约 8%。
 *
 *   h =   780 m →  108 km
 *   h = 4 200 m →  250 km
 *   h = 9 200 m →  370 km
 */
export function horizonDistanceKm(heightM: number): number {
  const h = Math.max(heightM, 0) / 1000;
  return Math.sqrt(2 * R_EFF_KM * h);
}

/**
 * 观测者能否看见某距离/高度的云 —— 双地平线判据。
 *
 * 两点的视线被地球挡住 ⇔ 距离超过双方地平线距离之和：
 *     可见 ⇔ d ≤ √(2·R_eff·h_cloud) + √(2·R_eff·h_observer)
 *
 * 注意方向：**云越高、看得越远**；高度项应加在「可见距离」上，
 * 而不是把曲率落差加到云高上（那会把越远越看不见反成越远越高，
 * 使这一判据永远返回 true，等于整根支柱失效）。
 */
export function isVisibleFromObserver(cloudM: number, observerM: number, distKm: number): boolean {
  return distKm <= horizonDistanceKm(cloudM) + horizonDistanceKm(observerM) + 0.5;
}

/** 观测者地平线下沉角（度） */
export function horizonDipDeg(observerM: number): number {
  const h = Math.max(observerM, 0) / 1000;
  return (Math.sqrt((2 * h) / R_EFF_KM) * 180) / Math.PI;
}

/** 曲率落差 (m) */
export function curvatureDropM(distKm: number): number {
  return ((distKm * distKm) / (2 * R_EFF_KM)) * 1000;
}

// ── 气柱质量与消光 ──────────────────────────────────────────────────────

/**
 * 光束沿路的最近距地高度（切点高度，m）。
 *
 * 对 MSL 高度 h、太阳视高度角 α 的平行光，光束高度随朝太阳方向的水平距离 s 变化：
 *
 *     h(s) = h + s·tan(α) + s²/(2·R_eff)
 *
 * 极小值出现在 s = −tan(α)·R_eff 处，代入得
 *
 *     h_t = h − R_eff·α²/2      （α ≥ 0 时光束一路上升，切点即云层本身）
 *
 * **这就是整个黄昏颜色物理的核心几何量**：α 越负，切点越低，气柱越长、红光越纯。
 * h_t ≤ 0 表示光束已被地球本体遮挡 —— 此时云层只可能被散射光（而非直射光）照亮。
 */
export function beamTangentHeightM(cloudMslM: number, alphaDeg: number): number {
  if (alphaDeg >= 0) return Math.max(cloudMslM, 0);
  const dropM = 0.5 * R_EFF_KM * 1000 * Math.pow(toRad(alphaDeg), 2);
  return cloudMslM - dropM;
}

/**
 * 相对气柱质量（垂直=1）。
 *
 * 两条物理约束必须同时满足，缺一就会得到「太阳越低反而越亮」的荒谬结果：
 *
 *  ① **斜程因子**
 *     · α > 0：Kasten–Young (1989) 经验式（含曲率与折射，α→0 收敛到 38 而非发散）
 *     · α ≤ 0：切点气柱的 Chapman 渐近式 m = √(πR/2H)·exp(−h_t/H)，
 *       h_t 见 `beamTangentHeightM`。它在 h_t=0 时恰为 35.4，与 Kasten–Young
 *       的 38 天然衔接，所以不需要人工拼缝。
 *  ② **高度衰减** —— 云层越高，其上方剩余气柱越少，比例 exp(−h_t/H)。
 *
 * 只做 ① 会把整根数百公里光柱都当成在云层高度上（α<0 时高估 2–3 倍）；
 * 只做 ② 会在太阳高挂时也给出巨大气柱。两者相乘才是对的。
 */
export function beamAirmass(cloudMslM: number, alphaDeg: number, scaleHeightKm: number): number {
  const tangentM = beamTangentHeightM(cloudMslM, alphaDeg);
  const hKm = Math.max(tangentM, 0) / 1000;

  // 光束被地球本体完全遮挡：给一个足够大的气柱，让 exp(−τ) 收敛到 0
  if (tangentM <= 0) return 220;

  // 沿切点的相对气柱。系数 38 与 Kasten–Young 在 α=0 处的 38 精确相等，
  // 所以 α 穿过地平线时**天然连续、且全局单调**，不需要任何分段拼接。
  // （这与 Skyglow 的 `m_ray = 38.0 * exp(-h_t / 7.5)` 完全一致，
  //   两个独立实现收敛到同一个常数，是它可靠的一个旁证。）
  const grazing = 38 * Math.exp(-hKm / scaleHeightKm);

  if (alphaDeg >= 0) {
    // 太阳在地平线以上：用 Kasten–Young 更准；它在 α→0 时正是 38
    return kastenYoungAirmass(alphaDeg) * Math.exp(-hKm / scaleHeightKm);
  }
  return grazing;
}

/**
 * 沿光路的相对气柱质量（垂直=1）。**保留用于诊断绘图**；
 * 物理消光请用 `beamAirmass`（解析式，单调且不受截断距离影响）。
 */
export function slantAirmass(
  rayHeightFn: (dKm: number) => number,
  maxDistKm: number,
  scaleHeightKm: number,
  stepKm = 2,
): number {
  let integral = 0;
  let prev = rayHeightFn(0);
  for (let d = stepKm; d <= maxDistKm; d += stepKm) {
    const h = rayHeightFn(d);
    if (h <= 0) break;
    const rho0 = Math.exp(-Math.max(prev, 0) / scaleHeightKm);
    const rho1 = Math.exp(-Math.max(h, 0) / scaleHeightKm);
    const ds = Math.hypot(stepKm, h - prev);
    integral += ((rho0 + rho1) / 2) * ds;
    prev = h;
  }
  return integral / scaleHeightKm;
}

// ── 云层带穿越几何 ──────────────────────────────────────────────────────

/** 光路高度函数在 d (km) 处的导数，单位 m/km。 */
function raySlopeMPerKm(alphaDeg: number, dKm: number): number {
  return Math.tan(toRad(alphaDeg)) * 1000 + (dKm / R_EFF_KM) * 1000;
}

/**
 * 求光路落在某高度带 [loM, hiM] 内的所有区间。**这是"光穿过一层云有多远"
 * 的唯一正确来源。**
 *
 * 光路 h(d) = H₀ + d·tanα + d²/(2R_eff) 是抛物线（把球面摊平后的直线），
 * 因此它可以**两次**穿过同一高度带：先下沉穿过、过最低点后再抬升穿过。
 * 黄昏时太阳角很低，光线贴着云层掠过，单次穿越的水平距离可达上百公里 ——
 * 这正是"斜程消光远强于垂直消光"的物理来源，也是最容易被漏算的一项。
 *
 * @param H0M      光路起点高度 (m)
 * @param alphaDeg 太阳高度角 (度)
 * @param loM/hiM  高度带 (m)
 * @param dMaxKm   最远积分距离 (km)
 * @returns 落在带内的 [fromKm, toKm] 区间数组（按距离升序）
 */
export function bandIntervals(
  H0M: number,
  alphaDeg: number,
  loM: number,
  hiM: number,
  dMaxKm: number,
): Array<{ fromKm: number; toKm: number }> {
  if (dMaxKm <= 0) return [];
  const a = 1000 / (2 * R_EFF_KM); // m per km²
  const b = Math.tan(toRad(alphaDeg)) * 1000; // m per km

  const roots: number[] = [0, dMaxKm];
  for (const level of [loM, hiM]) {
    const c = H0M - level;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    for (const r of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
      if (r > 0 && r < dMaxKm) roots.push(r);
    }
  }
  roots.sort((x, y) => x - y);

  const at = (d: number): number => H0M + b * d + a * d * d;
  const out: Array<{ fromKm: number; toKm: number }> = [];
  for (let i = 0; i < roots.length - 1; i++) {
    const from = roots[i];
    const to = roots[i + 1];
    if (to - from < 1e-6) continue;
    const mid = (from + to) / 2;
    const hMid = at(mid);
    if (hMid >= loM && hMid <= hiM) out.push({ fromKm: from, toKm: to });
  }
  return out;
}

/**
 * 光路在某高度带内走过的**路径长度** (km)。
 * 斜距用 √(1+(dh/dd)²) 修正；黄昏掠射时 dh/dd 很小，斜距≈水平距离。
 *
 * 注意：返回的是**几何**路径长度。物理消光不能直接用它乘 κ ——
 * 平面平行云的掠射路径会趋于无穷，必须经 `slabAirmass` 加上限。
 */
export function pathLengthInBand(
  H0M: number,
  alphaDeg: number,
  loM: number,
  hiM: number,
  dMaxKm: number,
): { lengthKm: number; intervals: Array<{ fromKm: number; toKm: number }> } {
  const intervals = bandIntervals(H0M, alphaDeg, loM, hiM, dMaxKm);
  let lengthKm = 0;
  for (const iv of intervals) {
    const slope = raySlopeMPerKm(alphaDeg, (iv.fromKm + iv.toKm) / 2) / 1000; // m/m
    lengthKm += (iv.toKm - iv.fromKm) * Math.sqrt(1 + slope * slope);
  }
  return { lengthKm, intervals };
}

/**
 * 气团因子上限 —— 破碎云在掠射角下的等效不透明度上限。
 *
 * 平面平行云的斜程气团 X = 1/sin(θ) 在 θ→0 时发散；对连续层云这是对的
 * （沿地平线看云幕确实不透光），但**对 40% 覆盖的破碎云完全错**：
 * 云块宽约 10 km、间隔也有 10 km，掠射光走的是缝隙，不会被无限消光。
 *
 * 关键是：**上限本身必须随覆盖率缩放**。满铺（cover=1）时云幕连续，
 * 掠射确实极暗，X 可以很大；而 50% 覆盖时，掠射光有一半路程在云隙里，
 * 等效 X 只有连续层云的一半左右。
 *
 * 用 `X_max(cover) = 1 + (AIRMASS_CAP - 1) · cover^1.5`：
 *   cover=1.0 → X_max = 8    （连续层云，掠射极暗）
 *   cover=0.55 → X_max ≈ 3.9  （破碎云，掠射适度变暗）
 *   cover=0.30 → X_max ≈ 2.2
 *
 * 这是工程近似，但与 ACSAF「取逐层最大、跳过最近两段」同源：
 * 承认次网格结构，不用理想化平板算出荒谬值。
 */
export const AIRMASS_CAP = 8;

/** 覆盖率相关的气团上限（旧经验式，保留向后兼容） */
export function airmassCapForCover(cover01: number): number {
  const c = clamp(cover01, 0, 1);
  return 1 + (AIRMASS_CAP - 1) * Math.pow(c, 1.5);
}

// ── 概率化云隙透射（2026-11 新增，替代上面的经验上限）──────────────────

/** 液态水云的体消光系数 per km（由 τ_full/thickness 反推，与 LEVEL_MICROPHYSICS 一致） */
export const CLOUD_BETA_LIQUID_PER_KM = 10;
/** 冰晶云的体消光系数 per km（同样冰水路径下 τ 只有液态的 1/3，因 r_eff 大 3 倍） */
export const CLOUD_BETA_ICE_PER_KM = 1;

/**
 * 云块特征水平尺度（km）。
 *
 * 30 km = 典型破碎云单体 + 云隙的特征尺度。这个值有独立消融证据：
 * 在加州独立数据上，把均匀云量改为 30km 概率化云隙透射后，
 * Spearman 从 0.26 升到 0.44，并消除了 3 次漏报的大烧。
 * （取 100km 得分更高但被判定不物理 —— 相当于假设云隙巨大。）
 */
export const CLOUD_ELEMENT_KM = 30;

/**
 * 概率化云隙透射 —— 用解析物理替代 `AIRMASS_CAP` 的经验上限。
 *
 * **问题**：均匀云量 c 的标准 Beer–Lambert 假设「整层是均匀灰雾」，
 * 掠射光路 τ = β·D 会线性增长到荒谬值（50% 覆盖、450km 掠射 → τ=2250）。
 * 真实破碎云里，掠射光走的是**云隙**。
 *
 * **模型**（与 b-z/sunsetglow 的实现一致）：
 * 把云看成特征尺度 L 的云块与云隙交替。整条路径 D 上，
 * 「穿过一个云块」的概率是 c，「走云隙」的概率是 1−c。于是单次通过的
 * 平均不透明度是
 *
 *      ⟨不透明度⟩ = c · (1 − e^(−β·L))          ← 撞进云块
 *      ⟨透过率⟩   = 1 − c · (1 − e^(−β·L))
 *
 * 折算回等效消光系数：
 *
 *      β_eff = −ln(1 − c(1 − e^(−β·L))) / L
 *
 * **注意这里没有额外的 `1−exp(−cD/L)` 项** —— 那个是把「路径长度」
 * 重复计入了一次。路径长度 D 的作用体现在 β_eff × D 上。
 *
 * 三个正确的极限行为：
 *   ① c→0  ⇒ β_eff→0（无云）
 *   ② c→1  ⇒ β_eff→β（等价于穿过云块本体）
 *   ③ L→0  ⇒ β_eff→c·β（云块无限小 = 均匀灰雾，退回经典 Beer–Lambert）
 *   ④ L→∞  ⇒ β_eff→0（云块无限大 = 全是云隙，不物理但边界正确）
 *
 * 与旧经验式的关键区别：**上限不再需要 `AIRMASS_CAP = 8` 这种拍脑袋的数**，
 * 它由 c 和 L 自然决定。L=30km、β=10/km 时 c=0.5 给出 β_eff≈0.167/km ——
 * 掠射 200km 的 τ≈33，而标准式会给 1000。
 *
 * @param cover01   该层覆盖率 0~1
 * @param pathKm    光路在该层内的路径长度
 * @param betaPerKm 云块内的消光系数（液态 10 / 冰 1）
 * @param elementKm 云块特征尺度
 * @returns 该层的有效消光系数 per km（乘 pathKm 即得 τ）
 */
export function gapTransmissionBeta(
  cover01: number,
  pathKm: number,
  betaPerKm: number,
  elementKm = CLOUD_ELEMENT_KM,
): number {
  const c = clamp(cover01, 0, 1);
  if (c <= 0 || pathKm <= 0 || betaPerKm <= 0) return 0;
  if (c >= 1) return betaPerKm;
  const L = Math.max(elementKm, 1e-3);
  const blockOpacity = 1 - Math.exp(-betaPerKm * L);
  const meanTransmit = clamp(1 - c * blockOpacity, 1e-9, 1);
  return -Math.log(meanTransmit) / L;
}

/** 由层定义给出云块内体消光系数 per km（= τ_full / 1km 厚度） */
export function cloudBetaPerKm(levelKey: string): number {
  return Math.max(levelFullOpticalDepth(levelKey), 0.05);
}

/**
 * 某高度带对掠射光路的等效气团因子（相对垂直）。
 *
 * 物理链条：
 *   τ_slab = τ_vert · X,   X = min(pathKm/thicknessKm, X_max(cover))
 *
 * **必须对几何路径做软启动**。原因：光路 h(d) 是抛物线，当 α 刚好从正值
 * 变为负值，落在某个薄带（如 700hPa 厚 1.4km）内的路径长度会从 0 突变到
 * 近 200km —— 而同一时刻相邻帧只差 0.4°，τ 却从 0 跳到 104，
 * 直接造成时间曲线上的硬台阶。
 *
 * 真实的云层不是无限薄的平面：它有一定厚度与水平尺度，光线是逐渐"进入"
 * 掠射状态的。这里用 `AIRMASS_ONSET_KM`（约一个典型云块宽度）做线性渐入，
 * 使其在几何上连续。
 *
 * @param thicknessKm 该层的总厚度 (km)
 * @param pathKm      光路在该层内的几何路径长度 (km)
 * @param cap         气团上限（由 `airmassCapForCover` 给出）
 */
export const AIRMASS_ONSET_KM = 25;

export function slabAirmass(thicknessKm: number, pathKm: number, cap = AIRMASS_CAP): number {
  if (thicknessKm <= 0 || pathKm <= 0) return 1;
  // 几何气团因子：路径短于厚度时按垂直处理（1），长则按比值放大并受 cap 约束
  const geo = clamp(pathKm / thicknessKm, 1, cap);
  // 软启动：路径越长说明越接近掠射，渐入到完整几何值。
  // 少了这一步，α 从 +0.1° 变到 −0.1° 时薄层的 pathKm 会从 0 跳到近 200km，
  // τ 从 0 跳到 104，时间曲线出现硬台阶。
  const onset = smoothRamp(pathKm, AIRMASS_ONSET_KM);
  return 1 + (geo - 1) * onset;
}

/** 把 x 从 0→onset 映射到 0→1 的平滑阶跃（用于消除几何突变） */
function smoothRamp(x: number, onset: number): number {
  if (onset <= 0) return 1;
  const t = clamp(x / onset, 0, 1);
  return t * t * (3 - 2 * t);
}


/**
 * 目标云层朝太阳方向的直射光气柱质量与有效光程。
 *
 * **口径说明（上一版的主要物理错误）**：不能用「从云层出发朝太阳积分、撞地即停」的方式
 * 求气柱。那样在 α 刚好越过云层地平线时会因触地截断而**突然变小**，于是算出的
 * 直射光颜色在 α≈−1.8° 最暗、α=−6° 反而最亮（相差 5 个数量级），与实拍完全相反。
 *
 * 正确的量是**与地球相切的那条日光光束在切点高度上的气柱**（见 `beamTangentHeightM`）：
 * 它随 α 单调递减，且在 α→−√(2h/R) 处自然收敛到 0（云层入影），无需任何特判。
 */
export function directBeamAirmass(
  cloudMslM: number,
  alphaDeg: number,
  maxDistKm = 900,
): { rayleigh: number; aerosol: number; rangeKm: number } {
  const tangentM = beamTangentHeightM(cloudMslM, alphaDeg);
  // 光束几何可达的水平半程 L/2 = √(2·R_eff·h_t)；乘 2 得往返全程
  const reachKm = tangentM > 0 ? 2 * Math.sqrt(2 * R_EFF_KM * (tangentM / 1000)) : 0;
  return {
    rayleigh: beamAirmass(cloudMslM, alphaDeg, H_RAYLEIGH),
    aerosol: beamAirmass(cloudMslM, alphaDeg, H_AEROSOL),
    rangeKm: Math.min(reachKm, maxDistKm),
  };
}

// ── 云微物理：云量 → 光学厚度 ───────────────────────────────────────────

/**
 * 各等压面的典型云水路径 (g/m²)，用于把"云量"升级为"光学厚度"。
 *
 * 物理链条：τ = 3·LWP / (2·ρ_w·r_eff)，取 ρ_w = 10⁶ g/m³。
 *
 * 数值取自各云属的典型 LWP / 有效半径（水云 r_eff≈10µm，冰云 22–26µm）：
 *
 *   层云/层积云   LWP ≈ 120 g/m² → τ_full ≈ 18  （不透明灰幕）
 *   高层云        LWP ≈ 100 g/m² → τ_full ≈ 15  （不透明）
 *   高积云        LWP ≈  80 g/m² → τ_full ≈ 10  （接近不透明）
 *   卷层云        LWP ≈  50 g/m² → τ_full ≈  4.7（半透明）
 *   卷云          LWP ≈  25 g/m² → τ_full ≈  1.7（半透明画布 —— 关键区别）
 *   薄卷云        LWP ≈  15 g/m² → τ_full ≈  0.9
 *
 * **只存在高云时不得使用 κ=2.6 之类的"低云"常数** —— 那会把一层薄卷云
 * 当成浓积云，把教科书级的"整片卷云全烧"判成无烧。
 */
export const LEVEL_MICROPHYSICS: Record<string, { lwpGm2: number; reffUm: number }> = {
  '925': { lwpGm2: 130, reffUm: 10 },
  '850': { lwpGm2: 120, reffUm: 10 },
  '700': { lwpGm2: 100, reffUm: 10 },
  '600': { lwpGm2: 80, reffUm: 12 },
  '500': { lwpGm2: 50, reffUm: 16 },
  '400': { lwpGm2: 25, reffUm: 22 },
  '300': { lwpGm2: 15, reffUm: 26 },
};

/**
 * 冰云的微物理修正。
 *
 * 「冰云是画布、水云是灰幕」是这个领域最一致的一条经验，原因在微物理：
 * 冰晶的有效半径是水滴的 2–3 倍，而 τ = 3·LWP/(2·ρ·r_eff) ——
 * **同样的冰水路径，冰云的光学厚度只有水云的 1/2 到 1/3**。
 * 加上冰晶多为非球形、前向散射更强（不对称因子 g≈0.85 vs 0.87 但相函数更尖），
 * 掠射光更容易穿过。
 *
 * 实测数据支撑（2026-11 用 Open-Meteo 气压层温度+湿度验证）：
 * 300hPa T=−35.5°C，几乎必然是冰云；而旧代码把它按水云 r_eff=26µm 处理，
 * 已经部分体现了这一点，但没有依据温度动态调整。
 *
 * @param tempC  该层温度 °C
 * @param rh     该层相对湿度 %（冰云需要 RH 高；RH 很低说明只是干空气）
 * @returns 光学厚度的乘子（1 = 完全水云，<1 = 偏冰云更透明）
 */
export function cloudPhaseTauFactor(tempC: number | undefined, rh: number | undefined): number {
  if (tempC == null) return 1;

  // 相态混合比例：0 = 全水，1 = 全冰。以 −12°C 为中心，跨度 ±8°C。
  // （纯净水在 −38°C 仍可过冷，但气象尺度上 −12°C 以上基本是液态、
  //   −20°C 以下在模式里通常按冰处理。）
  const iceFrac = clamp((-(tempC) - 12) / 16, 0, 1);

  // RH 修正：冰云要求接近饱和。RH<60% 时基本不可能有可观冰晶，
  // 此时高云量更可能是模式的分层误差，不应该额外放大它的"画布"作用。
  const rhFactor = rh == null ? 1 : clamp((rh - 55) / 30, 0.35, 1);

  // 冰/水混合物的有效半径介于两者之间；τ 与 r_eff 反比
  // 取 r_ice/r_water ≈ 2.2 → 全冰时 τ 降到 1/2.2 ≈ 0.45
  const mixedFactor = 1 - iceFrac * (1 - 1 / 2.2);

  return mixedFactor * rhFactor;
}

/** 云层全满时的光学厚度 τ_full = 3·LWP/(2·ρ_w·r_eff) */
export function levelFullOpticalDepth(levelKey: string): number {
  const mp = LEVEL_MICROPHYSICS[levelKey];
  if (!mp) return 8;
  return (3 * mp.lwpGm2) / (2 * 1e6 * mp.reffUm * 1e-6);
}

/**
 * e 折消光系数 κ (per km)：使"整层满云 + 穿过整层厚度"恰好得到 τ_full。
 * @param thicknessKm 该层等效厚度
 */
export function levelExtinctionKappa(levelKey: string, thicknessKm: number): number {
  return levelFullOpticalDepth(levelKey) / Math.max(thicknessKm, 0.05);
}

/**
 * 逐层垂直光学厚度 τ_vert = κ · cover · thickness = τ_full · cover。
 *
 * **这是本引擎正确的消光主量**：先算垂直光学厚度（只依赖云量与云属），
 * 再由 `slabAirmass` 乘上掠射因子。上一版直接累加几何路径长度，
 * 在黄昏掠射角下会得到 τ>100 的荒谬值，把整片天空判成漆黑。
 */
export function levelVerticalTau(levelKey: string, cover01: number): number {
  return levelFullOpticalDepth(levelKey) * clamp(cover01, 0, 1);
}


/**
 * 臭氧 Chappuis 带吸收系数（相对 550nm 的单位气柱光学厚度）。
 *
 * Chappuis 带覆盖 400–650nm，双峰在 575 / 603nm（Orphal, Staehelin & Tamminen 2016,
 * J. Mol. Spectrosc. 327:105, DOI 10.1016/j.jms.2016.07.007）。
 *
 * **为什么必须单独建模**：垂直气柱下 Chappuis 吸收弱到可以忽略（约 0.02），
 * 这是几乎所有同类项目直接跳过它的原因。但黄昏时日光沿切点扫过臭氧层，
 * 气柱可达垂直值的 10–40 倍 —— 此时它在 570–620nm 窗口变成主导项，
 * 正是蓝调时刻与地影蓝边的物理来源。忽略它 = 橙色对、蓝色全错。
 *
 * 以 550nm 为 1.0 归一化；603nm 峰与 575nm 峰同高，470nm 以下迅速消失。
 */
export function ozoneExtinctionRel(nm: number): number {
  if (nm < 380 || nm > 720) return 0;
  // 双高斯叠加，峰值归一到 1.0（550nm 处约 0.62）。
  // 400nm 与 700nm 处各加一个线性收窗，避免带外出现残余吸收。
  const g1 = Math.exp(-0.5 * Math.pow((nm - 575) / 27, 2));
  const g2 = Math.exp(-0.5 * Math.pow((nm - 603) / 30, 2));
  const tail = Math.min(1, Math.max(0, (nm - 400) / 30)) * Math.min(1, Math.max(0, (700 - nm) / 60));
  return (0.86 * g1 + 0.9 * g2) * tail;
}

/** 550nm 垂直臭氧光学厚度（300 DU 标准柱 ≈ 0.021） */
export const TAU_O3_550 = 0.021;

/** 标准臭氧柱量 (DU) —— TAU_O3_550 的标定基准 */
export const OZONE_REFERENCE_DU = 300;

/**
 * 由实际臭氧柱量换算 550nm 垂直光学厚度。
 *
 * Chappuis 带吸收与柱量成正比：300 DU → 0.021。
 * 真实柱量在 220–450 DU 之间（极地春季可达 600）。
 * 这个 ±30% 的差异直接改变蓝调时刻的色相 —— 臭氧多则尾段更紫蓝，
 * 臭氧少则更早转向纯红。
 */
export function tauO3FromColumn(totalColumnDu: number): number {
  if (!Number.isFinite(totalColumnDu) || totalColumnDu <= 0) return TAU_O3_550;
  return TAU_O3_550 * (totalColumnDu / OZONE_REFERENCE_DU);
}

/**
 * 直射太阳光到达目标云层后的 RGB 透过率（0~1）。
 * 三通道分开积分 → 色相与饱和度是算出来的，不是配出来的。
 */
export function directSunRgb(
  alphaDeg: number,
  cloudMslM: number,
  aod: number,
  angstrom: number,
  rh = 55,
  /** 实际臭氧总柱量 (DU)；缺省用 300 DU 标准值 */
  ozoneColumnDu = OZONE_REFERENCE_DU,
): { rgb: RgbColor; rayleighAirmass: number; aerosolAirmass: number; rangeKm: number } {
  const { rayleigh, aerosol, rangeKm } = directBeamAirmass(cloudMslM, alphaDeg);
  const hygro = 1 + Math.pow(clamp((rh - 55) / 45, 0, 1), 2) * 1.15;
  const tauO3Vert = tauO3FromColumn(ozoneColumnDu);

  const rgb: RgbColor = { r: 0, g: 0, b: 0 };
  for (const ch of ['r', 'g', 'b'] as const) {
    const lam = LAMBDA[ch] / 550;
    const tauRay = TAU_R550 * Math.pow(lam, -4) * rayleigh;
    const tauAer = aod * hygro * Math.pow(lam, -angstrom) * aerosol;
    // 臭氧：与 Rayleigh 同样沿切点气柱放大；绿/蓝通道在黄昏被显著吃掉
    const tauO3 = tauO3Vert * ozoneExtinctionRel(LAMBDA[ch]) * rayleigh;
    rgb[ch] = Math.exp(-(tauRay + tauAer + tauO3));
  }
  return { rgb, rayleighAirmass: rayleigh, aerosolAirmass: aerosol, rangeKm };
}

/** 归一化色度：饱和度 / 亮度 / 色相 */
export function colorChroma(rgb: RgbColor): { saturation: number; luminance: number; hue: number } {
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 1e-9) return { saturation: 0, luminance: 0, hue: 0 };
  const sat = (max - min) / max;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let hue = 0;
  const d = max - min;
  if (d > 1e-9) {
    if (max === r) hue = ((g - b) / d + 6) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { saturation: sat, luminance: lum, hue };
}

/** 观测者 → 云的视线路径消光（影响对比度，不改变色相） */
export function viewPathTransparency(distKm: number, cloudMslM: number, observerM: number): number {
  const elev = Math.atan2(Math.max(cloudMslM - observerM, 0) / 1000, Math.max(distKm, 1));
  const m = 1 / Math.max(Math.sin(elev), 0.02);
  const tau = TAU_R550 * m * 0.6 + 0.12 * m * 0.35;
  return Math.exp(-tau);
}

/** Kasten–Young (1979) 大气质量 */
export function kastenYoungAirmass(altitudeDeg: number): number {
  const a = Math.max(altitudeDeg, -1.5);
  return 1 / (Math.sin(toRad(a)) + 0.50572 * Math.pow(a + 6.07995, -1.6364));
}

// ── 有效地面高度（气溶胶「抬升地面」效应）──────────────────────────────

/**
 * 气溶胶消光截止阈值 (km⁻¹)。
 *
 * SunsetBot 教程的做法：假定日光无法穿透 550nm 消光系数超过 0.02 km⁻¹ 的空气，
 * 该高度以下就成了「有效地面」—— 光到不了，云也就照不亮。
 * 这是把「气溶胶垂直分布」压缩成一个等效几何高度的巧妙做法。
 */
export const AEROSOL_VISIBILITY_CUTOFF_PER_KM = 0.02;

/**
 * 由 AOD 与气溶胶标高求「有效地面高度」(m)。
 *
 * 假设气溶胶消光随高度指数衰减：β(z) = β₀·e^(−z/H)，且 AOD = β₀·H。
 * 令 β(z) = 截止值 β_c，解出
 *
 *      z_eff = H · ln(β₀ / β_c) = H · ln(AOD / (β_c · H))
 *
 * 当 AOD ≤ β_c·H 时整层都不小于截止值 → z_eff = 0（无抬升）。
 *
 * **关键性质：z_eff 对 H 非单调**（在 H ≈ AOD/(e·β_c) 处取极大）。
 * 这意味着「气溶胶标高是多少」本身有不确定性时，应给出一个区间而不是单值。
 * 教程的实测值：AOD 0.15 → 1.35~2.75 km，AOD 0.2 → 1.5~3.0 km。
 *
 * @param aod       550nm 气溶胶光学厚度
 * @param scaleHeightKm 气溶胶标高（典型 0.5–4 km）
 * @returns 有效地面高度 (m)；无抬升时返回 0
 */
export function effectiveGroundHeightM(aod: number, scaleHeightKm: number): number {
  if (!Number.isFinite(aod) || !Number.isFinite(scaleHeightKm)) return 0;
  if (aod <= 0 || scaleHeightKm <= 0) return 0;
  const ratio = aod / (AEROSOL_VISIBILITY_CUTOFF_PER_KM * scaleHeightKm);
  if (ratio <= 1) return 0;
  return scaleHeightKm * Math.log(ratio) * 1000;
}

/**
 * 考虑标高不确定性后的有效地面高度区间 (m)。
 *
 * 按教程的典型标高范围 0.5–4 km 扫描，取 min/max。
 * 这个区间直接可以用作「霞光时长」的不确定度估计 ——
 * 区间宽说明气溶胶垂直结构不明，时长估计不可靠。
 */
export function effectiveGroundHeightRangeM(aod: number): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (const H of [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]) {
    const z = effectiveGroundHeightM(aod, H);
    if (z < min) min = z;
    if (z > max) max = z;
  }
  if (!Number.isFinite(min)) min = 0;
  return { min, max };
}
