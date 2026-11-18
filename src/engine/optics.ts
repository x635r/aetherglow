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

  // 切点落到地面以下：光束已被地球本体遮挡，但**不能返回常数**。
  //
  // 上一版 `if (tangentM <= 0) return 220` 在这里制造了 5.8 倍的硬台阶：
  // 4200m 云在 α=−1.90° 时 h_t=112m、m=37.5；α 再降 0.1° 到 −2.00°
  // 使 h_t=−330m，气柱质量瞬间跳到 220 —— 时间曲线上每隔一帧就出现一次
  // 「太阳更低、天空反而更亮」的锯齿，且整段暮光被压成同一个数。
  //
  // 正确做法：让切点高度继续下降（等效为光束在地面以下"虚拟"传播），
  // 指数式继续增长。用 |h_t| 作为衰减深度的度量，在 h_t=0 处恰好给出
  // 38·e⁰ = 38，与 α≥0 分支的 Kasten–Young 在 α=0 的 37.9 严格衔接。
  // 深度上限取 2 个标高，避免 α 很深时 exp 溢出成 Infinity。
  const depthKm = Math.min(-hKm, 2 * scaleHeightKm);
  if (tangentM <= 0) return 38 * Math.exp(depthKm / scaleHeightKm);

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
 * **按云属**给出的云块特征水平尺度 (km)。
 *
 * `CLOUD_ELEMENT_KM = 30` 是对流云（积云/层积云）的合理尺度，但把它套到
 * 卷云上是错的，且错得很严重：
 *
 *   卷云（400hPa 以上）沿风向组织成**长条/带**，水平长度 100–1000 km，
 *   宽度只有几 km。而光线在 α≈−1.5° 时穿过 300hPa 层带（厚 1.8km）
 *   要走 **67 km** ——
 *     · L=30km 时被判成"跨 2.2 个云块独立重采样"，30% 覆盖的薄卷云
 *       会把下层的黄金高积云挡掉 54%（0.7^2.2 = 0.46）
 *     · 但真实的薄卷云是**半透明薄纱**，30% 覆盖下光线几乎不受影响
 *   实测后果：任何构型只要加上卷云，总分必然下降 —— 与"黄金层 + 卷云
 *   是教科书级大烧"的行业共识完全相反。
 *
 * 取 L=120km 后：
 *   · 30% 卷云、67km 路径 → 走**单块分支**，T = 0.7 + 0.3·e^(−32) ≈ 0.70
 *     （薄卷云几乎不挡光，正确）
 *   · 90% 卷云 → T ≈ 0.10（厚卷云幕确实挡光，正确）
 *
 * 黄金层（高层云/高积云）的 60km 取自其典型水平尺度（中尺度云团），
 * 介于对流云与卷云之间。
 */
export const CLOUD_ELEMENT_BY_ROLE_KM: Record<'low' | 'mid' | 'golden' | 'high', number> = {
  low: 30,
  mid: 40,
  golden: 60,
  high: 120,
};

/**
 * 破碎云的**直接透射率**（含云隙）—— 全工程唯一的云遮挡口径。
 *
 * **问题**：均匀云量 c 的标准 Beer–Lambert 假设「整层是均匀灰雾」，
 * 掠射光路 τ = β·D 会线性增长到荒谬值（50% 覆盖、450km 掠射 → τ=2250）。
 * 真实破碎云里，掠射光走的是**云隙**。
 *
 * **模型**：把云看成特征尺度 L 的云块与云隙交替。路径长度 D 上有两种情况：
 *
 * ① **D ≤ L（单块内穿过）**：光线只有一次机会撞上云块，
 *
 *      T = (1 − c) + c·e^(−β·D)
 *
 *    此时用「每 L 独立重采样」会低估遮挡：D=10km、L=30km、c=0.5、β=10
 *    时重采样式给 (1−0.5+0.5·e^(−300))^(10/30) ≈ 0.79，但物理上单条光线
 *    撞进那个云块的概率仍是 0.5，期望透过率应接近 0.5。
 *
 * ② **D ≥ L（跨多个云块重采样）**：设单位长度的渐近衰减率
 *
 *      χ = −ln(1 − c(1 − e^(−β·L))) / L
 *
 *    则 T = e^(−χ·D)。χ 的物理含义是「每走 L 独立抽签一次：撞云（概率 c，
 *    透射 e^(−βL)）或走隙（概率 1−c）」。
 *
 * 两支在 D = L 处**严格相等**（因为 e^(−χL) = 1 − c(1 − e^(−βL))），
 * 所以是连续拼接而非经验混合。四个极限行为：
 *
 *   ① c→0   ⇒ T→1（无云）
 *   ② c→1   ⇒ T→e^(−βD)（穿过云块本体）
 *   ③ L→0   ⇒ χ→cβ ⇒ T→e^(−cβD)（云块无限小 = 均匀灰雾，退回经典 Beer–Lambert）
 *   ④ β→0   ⇒ T→1（无消光）
 *
 * @param cover01   该层覆盖率 0~1
 * @param pathKm    光路在该层内的路径长度
 * @param betaPerKm 云块内的消光系数（由 τ_full / 真实层厚给出）
 * @param elementKm 云块特征尺度
 */
export function cloudLayerDirectTransmittance(
  cover01: number,
  pathKm: number,
  betaPerKm: number,
  elementKm = CLOUD_ELEMENT_KM,
): number {
  const c = clamp(cover01, 0, 1);
  if (c <= 0 || betaPerKm <= 0) return 1;
  if (pathKm <= 0) return 1;
  if (c >= 1) return Math.exp(-betaPerKm * pathKm);

  const L = Math.max(elementKm, 1e-3);
  if (pathKm <= L) {
    // 单块内：只有一次撞击机会
    return clamp((1 - c) + c * Math.exp(-betaPerKm * pathKm), 1e-12, 1);
  }
  // 跨块重采样：渐近衰减率
  const chi = -Math.log(clamp(1 - c * (1 - Math.exp(-betaPerKm * L)), 1e-12, 1)) / L;
  return clamp(Math.exp(-chi * pathKm), 1e-12, 1);
}

/**
 * 破碎云层的等效光学厚度 τ = −ln T。
 *
 * 这是给「累乘型」评分代码用的形式（`tDirect *= exp(−τ)`）。
 * **调用方不得再乘 `1−c+c·e^(−τ)`** —— 那会构成双重计算，
 * 在 80% 覆盖 + 100km 路径下把透过率虚高 43 倍。
 */
export function cloudLayerTau(
  cover01: number,
  pathKm: number,
  betaPerKm: number,
  elementKm = CLOUD_ELEMENT_KM,
): number {
  return -Math.log(cloudLayerDirectTransmittance(cover01, pathKm, betaPerKm, elementKm));
}

/**
 * 由层定义给出云块内**体消光系数 per km**。
 *
 * LEVEL_MICROPHYSICS 给的是「整层垂直穿过时的 τ_full」，所以体消光系数
 * 必须是 τ_full / 真实层厚。上一版直接 `return τ_full`（等价于假设每层都
 * 恰好 1km 厚），使 1000hPa（0.4km）低估 2.5 倍、200hPa（2.2km）高估 2.2 倍。
 *
 * @param levelKey    等压面键
 * @param thicknessKm 该层真实厚度 (km)
 */
export function cloudBetaPerKm(levelKey: string, thicknessKm = 1): number {
  return Math.max(levelFullOpticalDepth(levelKey) / Math.max(thicknessKm, 0.05), 0.05);
}

// ── 云层垂直重叠（指数-随机重叠）────────────────────────────────────────

/**
 * 云层重叠的去相关长度 (km)。
 *
 * 云雷达观测表明：相邻云层在垂直间距 Δz < 1–2 km 时高度趋向**最大重叠**，
 * 随间距增大逐渐转向随机重叠。实测去相关长度
 * L_cf ≈ 1.43–2.58 km（[Cloud Overlap Features from Multi-Year Cloud Radar
 * Observations, Remote Sensing 2024, 16(2):218]）。
 *
 * 取下沿 1.43 km 是**保守选择**：更小的 L_cf 意味着更快转向随机重叠，
 * 即两层云更倾向"错开"，从而让更多天空同时可见 —— 对"会不会烧"
 * 这个问题给出更乐观的估计。取保守值可避免系统性高估霞光。
 */
export const CLOUD_OVERLAP_DECORR_KM = 1.43;

/**
 * 两层云的组合覆盖率 —— 气象学标准的**指数-随机重叠**。
 *
 * 传统上云重叠被当成两个极端之一：
 *   · 最大重叠（完全相关）：C = max(c₁, c₂)   ← 相邻层
 *   · 随机重叠（独立）：    C = c₁ + c₂ − c₁c₂ ← 远离层
 *
 * 真实大气在两者之间连续过渡，由去相关长度 L_cf 控制：
 *
 *      α = exp(−Δz / L_cf)
 *      C = α·max(c₁,c₂) + (1−α)·(c₁ + c₂ − c₁c₂)
 *
 * α→1（间距远小于 L_cf）退化为最大重叠，α→0（间距远大于 L_cf）退化为随机重叠。
 *
 * **为什么必须换掉"角色内独立并集"**：上一版把
 * `1 − Π(1−cᵢ)` 用在 400/300/250/200 四个高云层上，等价于假设它们
 * **完全随机重叠**。但那四层的垂直间距只有 1.2–2.6 km，与 L_cf 同量级，
 * 真实重叠度远高于随机 —— 于是旧式把"同一块卷云被四个等压面各描述一次"
 * 当成了四块独立的云，可见发光面积被高估。
 *
 * 本函数与"角色内并集"的另一处关键区别：它作用在**全部层**上而不是
 * 只在角色内，所以不再需要人为划分"角色内并集 vs 角色间相加"这套拼缝，
 * 未来扩到 21 层等压面时也保持垂直分辨率不变性。
 *
 * @param layers 各层的 {cover, heightKm}，顺序无关（内部按高度排序）
 * @returns 组合覆盖率 0~1
 */
export function combinedCloudCover(
  layers: Array<{ cover01: number; heightKm: number }>,
): number {
  const valid = layers
    .filter((l) => Number.isFinite(l.cover01) && Number.isFinite(l.heightKm))
    .map((l) => ({ c: clamp(l.cover01, 0, 1), z: l.heightKm }))
    .sort((a, b) => a.z - b.z);
  if (!valid.length) return 0;

  // 自下而上依次合成。相邻对的间距决定 α。
  let cTotal = valid[0].c;
  for (let i = 1; i < valid.length; i++) {
    const dz = Math.abs(valid[i].z - valid[i - 1].z);
    const alpha = Math.exp(-Math.max(dz, 0) / CLOUD_OVERLAP_DECORR_KM);
    const cNext = valid[i].c;
    const maxOverlap = Math.max(cTotal, cNext);
    const randomOverlap = cTotal + cNext - cTotal * cNext;
    cTotal = clamp(alpha * maxOverlap + (1 - alpha) * randomOverlap, 0, 1);
  }
  return cTotal;
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
  /** 观测点/云下地面高程 MSL (m)。缺省 0 = 海平面 */
  groundElevationM = 0,
): { rayleigh: number; aerosol: number; rangeKm: number } {
  const tangentM = beamTangentHeightM(cloudMslM, alphaDeg);
  // 光束几何可达的水平半程 L/2 = √(2·R_eff·h_t)；乘 2 得往返全程
  const reachKm = tangentM > 0 ? 2 * Math.sqrt(2 * R_EFF_KM * (tangentM / 1000)) : 0;
  // **气溶胶标高是相对地面的（AGL），不是海拔（MSL）**（第四轮 RES-09）。
  //
  // 瑞利散射由整层大气气压决定、臭氧在平流层，两者都以 MSL 为准；
  // 但气溶胶集中在贴地边界层，H_AEROSOL=1.5km 这个标高的基准面是**地面**。
  //
  // 上一版对气溶胶也传了 cloudMslM：拉萨（地面 3650m）的 4.2km 云，
  // 气溶胶气柱按 exp(−4.2/1.5)=0.062 算，而正确值应是
  // exp(−0.55/1.5)=0.69 —— **低估 11.4 倍消光**，高原晚霞被算得异常偏黄亮。
  const hAglM = Math.max(cloudMslM - groundElevationM, 0);
  return {
    rayleigh: beamAirmass(cloudMslM, alphaDeg, H_RAYLEIGH),
    aerosol: beamAirmass(hAglM, alphaDeg, H_AEROSOL),
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
  // 1000hPa 层：雾 / 层云。LWP 小（雾含水量 0.05 g/m³ × ~100m ≈ 5 g/m²），
  // r_eff 10µm → τ_full ≈ 0.75，是「薄灰幕」而非不透明层
  '1000': { lwpGm2: 8, reffUm: 10 },
  '925': { lwpGm2: 130, reffUm: 10 },
  '850': { lwpGm2: 120, reffUm: 10 },
  '700': { lwpGm2: 100, reffUm: 10 },
  '600': { lwpGm2: 80, reffUm: 12 },
  '500': { lwpGm2: 50, reffUm: 16 },
  '400': { lwpGm2: 25, reffUm: 22 },
  '300': { lwpGm2: 15, reffUm: 26 },
  // 250/200hPa：极端稀薄的卷云顶。LWP(IWP) 5–8 g/m²、冰晶 r_eff 30µm（ISCCP）
  '250': { lwpGm2: 8, reffUm: 30 },
  '200': { lwpGm2: 5, reffUm: 30 },
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
 * **以 550nm 精确归一到 1.0** —— 这一点必须与 `TAU_O3_550` 严格自洽：
 * 该常数是 300 DU 气柱在 **550nm** 的垂直光学厚度（σ₅₅₀ ≈ 2.6e−21 cm²），
 * 若归一化基准漂到别处，整条臭氧链就会被系统性弱化（旧实现 550nm 处只有
 * 0.749，等于把臭氧吸收低估了 25%）。
 *
 * 双峰形状本身与实测截面一致：603nm 峰 ≈ 1.87 × 550nm（实测 σ 比 1.98），
 * 465nm 处 ≈ 0（这就是"臭氧多 → 红被吃掉 → 暮光偏蓝紫"的物理来源）。
 */
export function ozoneExtinctionRel(nm: number): number {
  if (nm < 380 || nm > 720) return 0;
  // 双高斯叠加，峰值在 603nm；下方除以 550nm 处的值做精确归一
  // 400nm 与 700nm 处各加一个线性收窗，避免带外出现残余吸收。
  const g1 = Math.exp(-0.5 * Math.pow((nm - 575) / 27, 2));
  const g2 = Math.exp(-0.5 * Math.pow((nm - 603) / 30, 2));
  const tail = Math.min(1, Math.max(0, (nm - 400) / 30)) * Math.min(1, Math.max(0, (700 - nm) / 60));
  return ((0.86 * g1 + 0.9 * g2) * tail) / OZONE_REL_AT_550_NM;
}

/**
 * 未归一化的双高斯在 550nm 处的取值 —— 归一化分母。
 *
 * 由同一组常数算出，避免手写魔数与形状参数脱钩：
 * 0.86·exp(−½((550−575)/27)²) + 0.9·exp(−½((550−603)/30)²) ≈ 0.7483
 */
const OZONE_REL_AT_550_NM = (() => {
  const g1 = Math.exp(-0.5 * Math.pow((550 - 575) / 27, 2));
  const g2 = Math.exp(-0.5 * Math.pow((550 - 603) / 30, 2));
  return 0.86 * g1 + 0.9 * g2;
})();

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

/** 平流层臭氧主层的中心高度与半宽 (km) —— Chappuis 带集中在 20–25km */
export const OZONE_LAYER_CENTER_KM = 22;
export const OZONE_LAYER_HALF_KM = 5;

/**
 * 平流层臭氧球壳的**几何斜程放大因子**（相对垂直穿越）。
 *
 * 为什么不能用 Rayleigh 的气柱因子（P1 修复的关键）：
 * Rayleigh 消光的质量重心在 ~8km 标高柱内，掠射时几何放大可达 38；
 * 而臭氧 90% 集中在 20–25km 的薄壳里。掠射光线即使切点贴地，
 * 穿过这层壳的斜程也只被放大约 √(1/(1−sin²θ)) 的量级，上限约 14。
 *
 * 上一版把臭氧乘上了 `rayleigh`（38→280），在太阳低于 −1.5° 时
 * 把臭氧吸收高估 3–20 倍 —— 表现为深暮光过紫、蓝色通道被吃得过狠。
 *
 * @param tangentHeightM 光束切点高度（MSL）
 * @returns 斜程放大倍数，钳在 [1, 14]
 */
export function ozoneShellAirmass(tangentHeightM: number): number {
  const hTkm = Math.max(tangentHeightM, 0) / 1000;
  // 切点已在壳层之上：垂直光路（1×）
  if (hTkm >= OZONE_LAYER_CENTER_KM) return 1;
  // 球壳几何：sinθ = (R + h_t) / (R + z_O3)
  const sinZenith = (EARTH_RADIUS_KM + Math.min(hTkm, OZONE_LAYER_CENTER_KM)) /
    (EARTH_RADIUS_KM + OZONE_LAYER_CENTER_KM);
  return clamp(1 / Math.sqrt(Math.max(1 - sinZenith * sinZenith, 0.005)), 1, 14);
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
  /**
   * 云下地面高程 MSL (m)。气溶胶标高以地面为基准（AGL），
   * 高原站点的 Path 1 气溶胶消光靠它修正 —— 见 `directBeamAirmass`。
   */
  groundElevationM = 0,
): { rgb: RgbColor; rayleighAirmass: number; aerosolAirmass: number; rangeKm: number } {
  const { rayleigh, aerosol, rangeKm } = directBeamAirmass(cloudMslM, alphaDeg, 900, groundElevationM);
  const hygro = 1 + Math.pow(clamp((rh - 55) / 45, 0, 1), 2) * 1.15;
  const tauO3Vert = tauO3FromColumn(ozoneColumnDu);
  // 臭氧走**自己的**球壳几何，不跟 Rayleigh 共用气柱（P1 修复）。
  const tangentM = beamTangentHeightM(cloudMslM, alphaDeg);
  const o3Airmass = ozoneShellAirmass(tangentM);

  const rgb: RgbColor = { r: 0, g: 0, b: 0 };
  for (const ch of ['r', 'g', 'b'] as const) {
    const lam = LAMBDA[ch] / 550;
    const tauRay = TAU_R550 * Math.pow(lam, -4) * rayleigh;
    const tauAer = aod * hygro * Math.pow(lam, -angstrom) * aerosol;
    // 臭氧 Chappuis：与 Rayleigh 分开计算。
    //
    // **物理方向（别写反）**：Chappuis 带在 575–620nm（红黄区）吸收最强，
    // 在 465nm 几乎为零。所以臭氧增多吃掉的正是**红光**，使蓝紫相对占比升高、
    // r/b 变小。这与 Rayleigh 的"吃蓝"方向相反，所以两者在暮光里是竞争关系 ——
    // 也正是真实暮光在"金橙 ↔ 品红/蓝紫"两种色相间摆动的物理原因。
    const tauO3 = tauO3Vert * ozoneExtinctionRel(LAMBDA[ch]) * o3Airmass;
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

/**
 * **双路径模型 · Path 2**：云 → 观测者 的三通道视线消光。
 *
 * 此前引擎只算 Path 1（太阳 → 云），直接把云的 RGB 当成"眼睛看到的颜色"。
 * 但真实的晚霞颜色是**两步乘积**：
 *
 *   Path 1  太阳 → 云：Rayleigh + 气溶胶 + 臭氧，把白光染成金红
 *   云内散射（由 `cloudScreenQuality` 与 τ 刻画）
 *   Path 2  云 → 观测者：Rayleigh + 气溶胶 + 臭氧，**再次**染色
 *
 * 漏掉 Path 2 的后果是系统性的：
 *  · 云在 200km 外、仰角只有 2° 时，视线气柱达 30 倍垂直量 ——
 *    Path 2 的 Rayleigh 会把到达人眼的蓝光再抽掉一轮，实测色彩比
 *    只算 Path 1 更纯、更红
 *  · 天顶附近（仰角 60°）Path 2 几乎无影响
 * 于是"天边那一条最红、头顶那一片偏黄"这个真实观测特征，
 * 只有接上 Path 2 才能自然出现。
 *
 * 臭氧 Chappuis 同样沿视线放大 —— 这是**蓝调时刻**云呈蓝紫的
 * 物理来源：Path 1 把光红化，但臭氧在 Path 2 继续吃掉红黄，
 * 两者竞争的结果是暮光尾段转向蓝紫。
 *
 * @param distKm     观测者到该云的**水平**距离
 * @param cloudMslM  云海拔 m
 * @param observerM  观测者海拔 m
 * @param aod        550nm AOD
 * @param angstrom   Ångström 指数
 * @param rh         相对湿度 %
 * @param ozoneColumnDu 臭氧总柱量 DU
 * @returns 三通道透过率（0~1），以及视线仰角与气柱质量
 */
export function viewPathRgb(
  distKm: number,
  cloudMslM: number,
  observerM: number,
  aod: number,
  angstrom: number,
  rh = 55,
  ozoneColumnDu = OZONE_REFERENCE_DU,
): { rgb: RgbColor; elevationDeg: number; airmass: number } {
  // 视线仰角：**必须扣掉地球曲率下沉**，否则 280km 外会少算 5.3km 落差。
  //
  // 并且**保留负仰角**：上一版写 `Math.max(cloudMslM - observerM, 0)`，
  // 使 elevationDeg 恒 ≥ 0，负仰角分支成为 100% 死代码 —— 而负仰角正是
  // 高山俯视云海、航拍看脚下云层的真实几何。
  const dropM = curvatureDropM(distKm);
  const dhKm = (cloudMslM - dropM - observerM) / 1000;
  const elevationDeg = (Math.atan2(dhKm, Math.max(distKm, 1e-3)) * 180) / Math.PI;

  // 视线气柱：Kasten–Young 在仰角 ≥ 0 成立。
  //
  // **负仰角绝不能"衰减消光"**：仰角越负说明视线越往下扎进低层大气，
  // 气柱只会更长，不会更短。上一版写 `38 * exp(elev/3)` 让负仰角越深
  // 消光越小（越亮），方向反了，表现为"天边最远的云反而不红了"。
  // 这里把负仰角按地平线处理（气柱取 Kasten–Young 在 0° 的极限值 38），
  // 既保守又单调。真正的下方遮挡由 `isVisibleFromObserver` 的双地平线
  // 判据负责，不在这里用消光去近似。
  const slantFactor = kastenYoungAirmass(clamp(elevationDeg, 0, 90));

  // **只积分观测者与云层之间的真实子气柱**（P1 修复）。
  //
  // 上一版直接用整层斜程：头顶 1km 处的近云也会吃掉整条大气柱与
  // 22km 处的平流层臭氧，表现出"近云过暗、颜色过脏"。
  // 用两条指数柱的差值取子柱份额，并给两端设下限避免同高时除零。
  const z1 = Math.max(observerM, 0) / 1000;
  const z2 = Math.max(cloudMslM, 0) / 1000;
  const raySubCol = Math.max(
    Math.abs(Math.exp(-z1 / H_RAYLEIGH) - Math.exp(-z2 / H_RAYLEIGH)),
    0.05,
  );
  const aerSubCol = Math.max(
    Math.abs(Math.exp(-z1 / H_AEROSOL) - Math.exp(-z2 / H_AEROSOL)),
    0.08,
  );
  // 对流层内的云（<12km）到地面的视线**不穿过** 22km 的臭氧主层，
  // 只含约 10% 的对流层本底臭氧。把它按整层算会高估臭氧 3–20 倍。
  const o3SubCol = 0.1 * raySubCol;

  const airmass = slantFactor * raySubCol;

  const hygro = 1 + Math.pow(clamp((rh - 55) / 45, 0, 1), 2) * 1.15;
  const tauO3Vert = tauO3FromColumn(ozoneColumnDu);

  const rgb: RgbColor = { r: 0, g: 0, b: 0 };
  for (const ch of ['r', 'g', 'b'] as const) {
    const lam = LAMBDA[ch] / 550;
    const tauRay = TAU_R550 * Math.pow(lam, -4) * slantFactor * raySubCol;
    const tauAer = aod * hygro * Math.pow(lam, -angstrom) * slantFactor * aerSubCol;
    const tauO3 = tauO3Vert * ozoneExtinctionRel(LAMBDA[ch]) * slantFactor * o3SubCol;
    rgb[ch] = Math.exp(-(tauRay + tauAer + tauO3));
  }
  return { rgb, elevationDeg, airmass };
}

/**
 * 把 Path 1 × Path 2 合成**人眼看到的云色**。
 *
 * 两条路径的消光都是乘性的（各波段的透过率相乘），
 * 但 Path 2 的散射会把一部分直射光转成漫射 —— 观赏晚霞时，
 * 云是被"点亮"的发光体，其亮度正比于 Path 1 的直射份额，
 * 其**色相**由 Path 1 × Path 2 的联合透过率决定。
 *
 * 所以返回两个量：
 *  · `color`   —— 联合透过率的 RGB（用于色相/饱和度）
 *  · `intensity` —— 联合透过率的实际亮度（Path 1 × Path 2）
 *
 * 高云在很远的距离上时 `color` 会明显偏红，同时 Path 2 也会降低到达
 * 观测者的亮度。颜色与亮度使用同一份合成 RGB，避免显示颜色和评分各走一路。
 */
export function compositeCloudColor(
  sunRgb: RgbColor,
  viewRgb: RgbColor,
): { color: RgbColor; intensity: number } {
  const color: RgbColor = {
    r: sunRgb.r * viewRgb.r,
    g: sunRgb.g * viewRgb.g,
    b: sunRgb.b * viewRgb.b,
  };
  const intensity = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  return { color, intensity };
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

/**
 * 低层气溶胶对「掠射光束」的额外吞噬 —— **连续形式**，取代旧的静态掩膜。
 *
 * **旧实现的两处硬伤**（2026-11 审查确认）：
 *
 * ① **数学不连续**：旧代码是
 *
 *      effGroundM <= 0 ? 1 : sigmoid((heightM − effGroundM)/400)
 *
 *    AOD 从 0.080 增到 0.081 时 effGroundM 从 0 跳到 49.7m，
 *    `effGroundFactor(1000hPa, 110m)` 立刻从 **1.000 跌到 0.538**（−46%）。
 *    这是纯人工台阶，任何实测都不会有这种跳变。
 *
 * ② **物理概念混淆**：SunsetBot 的 z_eff 推导前提是光线**近水平掠射**
 *    （α≈0°）。太阳还高（α=+5°）时低云斜程很短，不该被静态掩膜砍掉 80%。
 *    而且 z_eff 是相对气溶胶源的**离地高度 (AGL)**，旧代码却拿 **MSL**
 *    海拔去比 —— 高原城市（地面 3650m）因此完全免疫该修正。
 *
 * **现在的做法**：不再用静态高度掩膜，而是把「气溶胶抬升地面」交给
 * *已经是连续量* 的切点气柱（`beamAirmass` / `directSunRgb`）统一表达 ——
 * 那里 β_aer 随 α 连续增长，α=0 时气柱最长，正是 z_eff 想描述的效果。
 *
 * 本函数只保留一条**平滑**的残余修正，用于处理「云本身就在气溶胶层内部」
 * 的情形（雾/层云被自身的米氏消光包住）。用 smoothstep 而非 sigmoid 拼接，
 * 且在 aod 低于门槛时以 0 斜率离开 0 —— 保证 C¹ 连续。
 *
 * @param cloudAglM  云的**离地高度** (m)（已扣除观测点地面高程，不是 MSL）
 * @param aod        550nm AOD
 * @param visM       地面能见度 (m)；0 表示缺测
 * @returns 0~1 的受光乘子（1 = 无额外削弱）
 */
export function aerosolImmersionFactor(cloudAglM: number, aod: number, visM: number): number {
  if (!Number.isFinite(aod) || aod <= 0) return 1;
  if (!Number.isFinite(cloudAglM)) return 1;

  // 只有「云位于气溶胶层内部」才削弱。气溶胶标高取 1.5km 的气候值，
  // 用 AOD 判断气溶胶层有多"厚"（AOD 越大，有效抬升越高）。
  const aerosolTopM = 1500 * Math.max(1, Math.log(Math.max(aod, 1e-3) / AEROSOL_VISIBILITY_CUTOFF_PER_KM / 1.5) + 1);
  if (cloudAglM >= aerosolTopM) return 1;

  // 位置项：越深入气溶胶层削弱越强（0 → 1）
  const depth01 = 1 - clamp(cloudAglM / Math.max(aerosolTopM, 1), 0, 1);

  // 强度项：**能见度与 AOD 必须取较差者**。
  //
  // 只看能见度会漏判：CAMS 给的 AOD 0.9（重度霾）而模式能见度仍是 20km
  // （很常见，因为两者来自不同子模式且更新节奏不同）时，纯能见度判据
  // 给出 severity=0，于是重度霾对低云完全没有削弱 —— 这是错的。
  // 取 max 让两路信号互为兜底，任一指向重霾就按重霾处理。
  const visKm = visM > 0 ? visM / 1000 : visibilityFromAodKm(aod);
  const severityVis = clamp((20 - visKm) / 18, 0, 1);
  // AOD 0.10（干净）→0；0.70（重霾）→1。与 spectral.ts 的 AOD 分档对齐。
  const severityAod = clamp((aod - 0.1) / 0.6, 0, 1);
  const severity = Math.max(severityVis, severityAod);

  // 平滑启动：AOD < 0.1 且能见度 >20km 时两项都为 0，因子恒为 1
  const raw = severity * depth01 * depth01;
  //
  // 上限 0.85，标定锚点（1.5km 低云）：
  //   AOD 0.10 / vis 25km → 1.00（无削弱）
  //   AOD 0.30 / vis 15km → 0.86（城市典型，低云仍被点亮）
  //   AOD 0.90 / vis 8km  → 0.49（重霾，低云只剩散射尾）
  //   AOD 2.00 / vis 2km  → 0.24（沙尘暴，几乎全暗）
  //
  // 为什么不用纯 Beer–Lambert 代入掠射气柱：AOD 0.3 在 1.5km 处
  // 掠射气柱达 14 倍垂直量（τ≈4.2），e^(−4.2)=0.015 —— 会把普通城市
  // 黄昏的低云判成全黑，而实测显然不是。真实光束沿路径持续抬升、
  // 且多次散射把相当份额重新注入，所以这里用**有界经验式**，
  // 并明确标注它是经验标定而非第一性原理。
  // 不能归零：雾天低云仍会被散射光照亮一部分，「低云 + 高空卷云」
  // 构型里的低云若被完全抹掉，会错判成"只剩高空卷云"的纯二烧。
  return 1 - 0.85 * raw;
}

/** 由 AOD 反演能见度 (km) —— 供 `aerosolImmersionFactor` 的内部兜底使用 */
function visibilityFromAodKm(aod: number): number {
  const sigmaExt = Math.max(aod, 1e-3) / 1.5; // km⁻¹，标高 1.5km
  return clamp(3.912 / sigmaExt, 0.3, 60);
}

// ── 云光学厚度反演（2026-11 新增：补上 COT 缺口）────────────────────────

/**
 * 由「地面短波 / 大气顶短波」反演**整层有效云光学厚度** τ_obs。
 *
 * **为什么这一项价值最高**：本引擎此前只有云覆盖率，没有云厚薄 ——
 * 所有「光学厚度」都来自气候态 LWP 表（层云 120 g/m²、卷云 25 g/m²…）。
 * 于是「薄纱卷云」和「厚重高层云」在覆盖率相同时得分完全一样，
 * 而实拍里二者是天壤之别。COT 无免费全球预报，但**可以反演**。
 *
 * **反演式**：保守散射（云在可见光几乎不吸收）的两流解给出
 *
 *      T = 1 / (1 + b·τ),     b = (1 − g)/2 ≈ 0.075   （g ≈ 0.85）
 *   ⇒  τ = (1/T − 1) / b
 *
 * 引用：Slingo (1989) 短波云辐射参数化；两流近似在 τ∈[1,50] 区间内
 * 对整层短波透射率的误差通常 <15%，足以区分「薄纱 / 中等 / 厚幕」。
 *
 * 为什么必须用这个形式而不是幂律 `τ = τ_ref·(T_ref/T)^γ`：
 * 幂律在 T→1 时给出**非零**的 τ（T=0.98 时仍有 2.7），于是晴空也会被
 * 判成"有薄云"，并把 cotFactor 推离 1。两流式在 T→1 时严格 τ→0。
 *
 * 三个必须的性质（全部由形式本身保证，不是补丁）：
 *   ① 单调：T 越低 τ 越大
 *   ② T→1 ⇒ τ→0（晴空无云）
 *   ③ T→0 ⇒ τ→∞，故需要上界截断（整层 COT > 60 已是不透明黑幕）
 *
 * **诚实标注**：这是**整层有效**光学厚度，不是逐层值 —— 单一 SW/TOA
 * 观测无法分解垂直分布。它能可靠给出「相对厚薄」的排序，
 * 绝对值会受地表反照率、气溶胶、太阳天顶角影响。
 * 所以调用方只把它当**乘子**（相对修正），不替换静态 LWP 表。
 *
 * @param shortwaveW  地面短波总辐射 W/m²
 * @param toaW        大气顶短波辐照 W/m²
 * @returns 反演的等效 τ_obs；输入不可用时返回 null（调用方跳过修正）
 */
/**
 * 晴空宽波段短波透射率 —— COT 反演的**基线**。
 *
 * **为什么必须有这一步**：`SW / TOA` 这个比值里包含了**晴空大气自身**的
 * 吸收与散射（Rayleigh + 气溶胶 + 水汽）。若直接把 `SW/TOA` 当作
 * "云透射率"，晴空会被反演出 τ≈12，于是 `cotFactor` 把整层云的消光
 * 凭空放大 2 倍。这个错误已在真实数据上实测确认
 * （T=0.515、云量 0% 却反演出 τ=12.5）。
 *
 * 正确做法：先算晴空基线 T_clear(α, AOD)，再剥离大气本底：
 *
 *      T_cloud = (SW / TOA) / T_clear
 *
 * **系数来自实测回归，不是教科书常数**：
 * 用 5 个城市 × 4 天 × 3 模型共 **442 个晴空样本**
 * （云量 ≤3%、太阳高度角 ≥8°）做线性回归，得到
 *
 *      τ_clear·m = 0.1302 + 0.0970 · AOD      (RMSE = 0.038, τ 范围 0.05–0.27)
 *
 * 这里有两个反直觉但被实测确认的结论：
 *  ① **宽带有效光学厚度远小于 550nm 单色值**。教科书常引的 0.23 是
 *     550nm 单色 Rayleigh，而 0.3–4µm 宽带里长波占能量主导、消光弱得多，
 *     实测截距只有 0.13
 *  ② **AOD 的系数只有 0.097（不是 1.0）**。因为 CAMS 的 AOD 是 550nm
 *     单色值，而换算到宽带要按 λ^(-Ångström) 加权平均 —— 长波端气溶胶
 *     消光弱得多，等效系数因此降到约 0.1
 *
 * 旧版本按"Rayleigh 0.17 + AOD×1.15 + 水汽 0.06"设系数，把晴空 τ 高估
 * 2.4 倍，导致 T_clear 在太阳 10° 时算成 0.05（实测 0.446）—— 于是
 * 大量本该反演出 τ 的有云时刻被判成"不可能"，COT 修正形同失效。
 *
 * @param sunAltitudeDeg 太阳高度角（度）
 * @param aod            550nm 气溶胶光学厚度
 * @returns 晴空短波透射率 0~1
 */
export function clearSkySwTransmittance(sunAltitudeDeg: number, aod: number): number {
  if (!Number.isFinite(sunAltitudeDeg)) return 1;
  // 太阳低于 5°：宽波段短波本身已弱到接近仪器/模式精度，比值不稳定 → 跳过
  if (sunAltitudeDeg < 5) return 1;
  const m = kastenYoungAirmass(sunAltitudeDeg);
  // 实测回归系数（442 个晴空样本）。AOD 上限截断到 2.5（超出后回归已无数据支撑）
  const tauClear = 0.1302 + 0.0970 * clamp(aod, 0, 2.5);
  return clamp(Math.exp(-tauClear * m), 0.05, 1);
}

/**
 * 由「地面短波 / 大气顶短波」反演**云**的整层有效光学厚度 τ_obs。
 *
 * 与 `inferCloudOpticalDepth` 的区别：本函数先除以**晴空基线**，
 * 所以结果只反映云的贡献。物理上必须这样 —— 否则晴空也会被算出
 * 十几的光学厚度（大气本底被误当云）。
 *
 * **太阳高度角下限 15°（实测确定的硬门槛）**：
 * 低太阳角时 SW/TOA 比值不可用，原因是双向的 ——
 *  ① 分母 TOA 趋 0，比值数值不稳定
 *  ② 更致命的是**晴空基线与模式的低角行为不匹配**：实测太阳 5.1°、AOD 0.5 时
 *     模式给 T_obs=0.128，而 `clearSkySwTransmittance` 给 T_clear=0.163，
 *     两者本该接近（晴空）却被比值放大成 T_cloud=0.78 → 反算出 τ=3.7，
 *     而同一帧静态表的 τ=27（云量很大）—— 差 7 倍，方向完全相反。
 *     实测后果：黄昏临界帧的 cotFactor 被压到 0.45 下限，
 *     把本该最亮时段的云消光砍掉 55%。
 *  ③ 这个时段恰好是日落前 30 分钟 —— 最关键的预报窗口
 *
 * 所以反演只在 α ≥ 15° 时启用。宁可整场不做 COT 修正（factor=1，
 * 退回气候态 LWP 表），也不要在关键时刻用一个错 7 倍的乘子。
 *
 * @param shortwaveW     地面短波总辐射 W/m²
 * @param toaW           大气顶短波辐照 W/m²
 * @param sunAltitudeDeg 太阳高度角（度），用于算晴空基线并做可行性门槛
 * @param aod            550nm AOD，用于算晴空基线
 * @returns 云的等效 τ；输入不可用、太阳太低、或晴空时返回 null
 */
export function inferCloudOpticalDepthFromRadiation(
  shortwaveW: number | undefined,
  toaW: number | undefined,
  sunAltitudeDeg: number,
  aod: number,
): number | null {
  // **低太阳角一律不反演**（见上面的 ①②③）
  if (!Number.isFinite(sunAltitudeDeg) || sunAltitudeDeg < COT_MIN_SUN_ALT_DEG) return null;

  const tau = inferCloudOpticalDepth(shortwaveW, toaW);
  if (tau == null) return null;
  const tClear = clearSkySwTransmittance(sunAltitudeDeg, aod);
  // 晴空基线为 1（不该发生，因为上面已卡 15°）时无法剥离，跳过
  if (tClear >= 0.999) return null;
  // 云透射率 = 观测比值 / 晴空基线。>1 说明观测比晴空还亮
  // （反射云 + 雪面 / 模式不一致），此时不可信。
  const Tobs = clamp(shortwaveW! / toaW!, 0.02, 1);
  const Tcloud = Tobs / tClear;
  if (Tcloud >= 1.0) return null;
  const B = 0.075;
  return clamp((1 / Math.max(Tcloud, 0.02) - 1) / B, 0, 60);
}

/**
 * COT 反演要求的最低太阳高度角。
 *
 * 依据（测得的，不是拍的）：实测 5.1° 时晴空基线与模式比值偏差达 27%
 * （0.163 vs 0.128），反算出的 τ 与静态表差 7 倍；而 **10.8° 时
 * （τ_obs=28.7 vs τ_static=26.8）两者相差仅 7%**，反演可信。
 *
 * 取 10°（贴着可信边界的下沿）而不是 15°：15° 会把中纬秋冬的整个晚霞
 * 判为不可反演 —— 实测 11 月 18 日北京日落前 90min 只有 13.19°、
 * 哈尔滨 3.73°，于是 COT 在这些地区整季失效（P0 修复）。
 * 调用方现在会主动搜索太阳最高的参考时刻，10° 只是最后一道保险。
 */
export const COT_MIN_SUN_ALT_DEG = 10;

export function inferCloudOpticalDepth(
  shortwaveW: number | undefined,
  toaW: number | undefined,
): number | null {
  if (shortwaveW == null || toaW == null) return null;
  if (!Number.isFinite(shortwaveW) || !Number.isFinite(toaW)) return null;
  // TOA 太小时比值没有物理意义（夜间 / 太阳贴地平线，分母趋 0）
  if (toaW < 80 || shortwaveW < 0) return null;
  // 地面辐射不可能显著超过 TOA（观测/模式误差留 5% 余量）
  if (shortwaveW > toaW * 1.05) return null;

  const T = clamp(shortwaveW / toaW, 0.02, 1);
  // b = (1 − g)/2，取 g ≈ 0.85（水云/冰云在可见光的典型不对称因子）
  const B = 0.075;
  const tau = (1 / T - 1) / B;
  // 物理上界：整层 COT 超过 60 已是不透明黑幕，再大没有区分意义
  return clamp(tau, 0, 60);
}

/**
 * 把反演的 τ_obs 转成「静态 LWP 表」的乘子。
 *
 * **围绕 1 中性，且有界 [0.6, 1.9]**（2026-11 收紧）。
 *
 * 上一版是 [0.45, 2.6]，实测发现两个问题：
 *  ① 下界 0.45 会在"反演偏低"时把云消光直接砍掉 55%，
 *     而偏低往往正是反演失效的表现（低太阳角、高地表反照率），
 *     不该让失效信号造成这么大影响
 *  ② 采信区间 0.1–10 太宽 —— 实测出现过 τ_obs/τ_static = 0.20
 *     （5.5 vs 27.2）仍被采信、压到下限 0.45 的情况
 *
 * 现在采信区间收紧到 **0.4–2.5**：超出即为"反演与静态表严重矛盾"，
 * 更可能是反演本身失效（雪面反射、模式 SW 与云量不一致、低角误差），
 * 此时退回中性 1.0 —— 保持气候态 LWP 表的行为，不做有害修正。
 *
 * 幂次从 0.6 提到 0.5：进一步压制乘子的幅度，让 COT 只做"温和的
 * 相对厚薄修正"，而不是主导消光。
 *
 * @param tauObs        反演得到的整层 τ
 * @param tauStaticSum  当前剖面按静态表算出的整层 τ（各层 τ_full 之和）
 * @returns 0.6~1.9 的乘子
 */
export function cotCalibrationFactor(tauObs: number | null, tauStaticSum: number): number {
  if (tauObs == null || !Number.isFinite(tauObs)) return 1;
  if (!Number.isFinite(tauStaticSum) || tauStaticSum <= 0.1) return 1;
  const ratio = tauObs / tauStaticSum;
  // 与静态表严重矛盾 → 反演不可信，不采信
  if (ratio > 2.5 || ratio < 0.4) return 1;
  return clamp(Math.pow(ratio, 0.5), 0.6, 1.9);
}
