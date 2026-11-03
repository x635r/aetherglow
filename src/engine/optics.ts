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

/** 沿光路的相对气柱质量（垂直=1）。光线触地即停止积分。 */
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

/** 覆盖率相关的气团上限 */
export function airmassCapForCover(cover01: number): number {
  const c = clamp(cover01, 0, 1);
  return 1 + (AIRMASS_CAP - 1) * Math.pow(c, 1.5);
}

/**
 * 某高度带对掠射光路的等效气团因子（相对垂直）。
 *
 * 物理链条：
 *   τ_slab = τ_vert · X,   X = min(pathKm/thicknessKm, X_max(cover))
 *
 * @param thicknessKm 该层的总厚度 (km)
 * @param pathKm      光路在该层内的几何路径长度 (km)
 * @param cap         气团上限（由 `airmassCapForCover` 给出）
 */
export function slabAirmass(thicknessKm: number, pathKm: number, cap = AIRMASS_CAP): number {
  if (thicknessKm <= 0 || pathKm <= 0) return 1;
  return clamp(pathKm / thicknessKm, 1, cap);
}


/** 目标云层朝太阳方向的直射光气柱质量与有效光程 */
export function directBeamAirmass(
  cloudMslM: number,
  alphaDeg: number,
  maxDistKm = 450,
): { rayleigh: number; aerosol: number; rangeKm: number } {
  const hit = groundHitDistanceKm(cloudMslM, alphaDeg);
  const rangeKm = Math.min(hit, maxDistKm);
  const hAt = (d: number) => rayHeightM(cloudMslM, alphaDeg, d) / 1000;
  return {
    rayleigh: slantAirmass(hAt, rangeKm, H_RAYLEIGH, 2.5),
    aerosol: slantAirmass(hAt, rangeKm, H_AEROSOL, 2.5),
    rangeKm,
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
 * 直射太阳光到达目标云层后的 RGB 透过率（0~1）。
 * 三通道分开积分 → 色相与饱和度是算出来的，不是配出来的。
 */
export function directSunRgb(
  alphaDeg: number,
  cloudMslM: number,
  aod: number,
  angstrom: number,
  rh = 55,
): { rgb: RgbColor; rayleighAirmass: number; aerosolAirmass: number; rangeKm: number } {
  const { rayleigh, aerosol, rangeKm } = directBeamAirmass(cloudMslM, alphaDeg);
  const hygro = 1 + Math.pow(clamp((rh - 55) / 45, 0, 1), 2) * 1.15;

  const rgb: RgbColor = { r: 0, g: 0, b: 0 };
  for (const ch of ['r', 'g', 'b'] as const) {
    const lam = LAMBDA[ch] / 550;
    const tauRay = TAU_R550 * Math.pow(lam, -4) * rayleigh;
    const tauAer = aod * hygro * Math.pow(lam, -angstrom) * aerosol;
    // 臭氧 Chappuis 带（简化）：绿/蓝波段轻微额外吸收，抬升红色纯度
    const tauO3 = ch === 'g' ? 0.012 * Math.min(rayleigh, 12) : ch === 'b' ? 0.008 * Math.min(rayleigh, 12) : 0;
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
