/**
 * AetherGlow · SunsetPhysicsEngine
 * ===========================================================================
 * 朝晚霞物理预测引擎 —— 五步管线
 *
 *  Step 1  generateLightPathGrid        天文几何 + 球面大圆光路采样网格
 *  Step 2  parseVerticalCloudProfile    等压面加密云层 + 黄金云层提取
 *  Step 3  rayMarchingTransmittance     曲率切线光追 + 地形/云墙否决
 *  Step 4  calculateSpectralExtinction  CAMS 气溶胶光谱消光
 *  Step 5  composePrediction            综合量化输出
 *
 * ── 物理约定（务必与 optics.ts 保持一致）────────────────────────────────
 *
 *  (a) 光路几何
 *        H_ray(d) = H_target + d·tan(α) + d²/(2·R_eff),  R_eff = 7435km
 *      曲率项已含地平线下沉，**不再叠加 dip**。
 *
 *  (b) 「烧」= 云幕被直射光点亮并被观测者看见。两者都必需：
 *        lit   = cloudLitFactor(H, α)      地影/晨昏线判据（逐层）
 *        T     = rayMarch(...)              光路大气+云+地形透过率
 *        seen  = isVisibleFromObserver(...)  观测者地平线下沉判据
 *      缺少任何一个，该层贡献归零 —— 这是消灭「高原虚标」「头顶烧而
 *      天边全黑」这类典型误判的关键。
 *
 *  (c) 紫霞二烧不是特判：9.2km 卷云在 α≈−3° 时 lit≈0.5，而此时直射光
 *      已红移到 600nm+ 并叠加高层散射尾，于是呈紫红。时序循环自动产生。
 */

import {
  clamp,
  destinationPoint,
  formatClock,
  lerp,
  samplePiecewise,
  smoothKnots,
  sunEvent,
  sunPosition,
} from './astro';
import { GRADE_THEME, GRADES, LEVEL_BY_KEY, LEVEL_KEYS, PRESSURE_LEVELS, RING_KM, STAGE_KNOTS, TIMELINE_END_MIN, TIMELINE_START_MIN } from './constants';
import type { GradeKey, LevelKey } from './constants';
import {
  AIRMASS_CAP,
  airmassCapForCover,
  cloudLitFactor,
  colorChroma,
  curvatureDropM,
  directSunRgb,
  earthShadowHeightM,
  groundHitDistanceKm,
  horizonDistanceKm,
  isVisibleFromObserver,
  levelExtinctionKappa,
  levelFullOpticalDepth,
  levelVerticalTau,
  pathLengthInBand,
  rayHeightM,
  slabAirmass,
} from './optics';
import { angstromFromAod, evaluateSpectral, visibilityFromAod } from './spectral';
import type {
  ForecastBundle,
  GeoPoint,
  HourlySample,
  LayerReport,
  ModelId,
  RingReport,
  SkyColorTheme,
  SpectralReport,
  SunMode,
  SunsetPredictionOutput,
  TacticalAdvice,
  TimeSample,
  TimelineReport,
  VetoFlag,
} from './types';

type Role = 'low' | 'mid' | 'golden' | 'high';

// ═══════════════════════════════════════════════════════════════════════════
// 通用小工具
// ═══════════════════════════════════════════════════════════════════════════

const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const ROLE_OF = (k: LevelKey): Role => LEVEL_BY_KEY[k].role;

/**
 * 各层对总分的基础权重。
 * 黄金层（600/500hPa）= 火烧云主战场；高云是"第二画布"但单独顶不起大烧
 * （实测里纯粹的紫霞很少同时是"世纪大烧"）；中低云只作辅助。
 */
const ROLE_WEIGHT: Record<Role, number> = { low: 0.10, mid: 0.24, golden: 1.0, high: 0.46 };

/**
 * 各层的代表性厚度（半厚度）。光线只有落在 `height ± half` 的厚度带内，
 * 才算真正“穿过该云幕”，而不是在两层的空隙里被虚假云量挡住。
 */
const LEVEL_THICKNESS_M: Record<LevelKey, number> = {
  '925': 350,
  '850': 500,
  '700': 700,
  '600': 700,
  '500': 800,
  '400': 850,
  '300': 900,
};

/**
 * 单体透明度容忍度：τ_full 超过此值，该层就趋近"不透光灰幕"。
 * 低云最小（本来就挡地平线），卷云最大（薄而透、满铺也是好画布）。
 */
const ROLE_TAU_TOLERANCE: Record<Role, number> = { low: 5.0, mid: 10.0, golden: 14.0, high: 22.0 };

/** 覆盖率偏好的最优值：不透明云（需要缝隙）vs 半透明云（可以满铺） */
const ROLE_OPTIMUM_OPAQUE: Record<Role, number> = { low: 0.15, mid: 0.35, golden: 0.45, high: 0.5 };
const ROLE_OPTIMUM_THIN: Record<Role, number> = { low: 0.35, mid: 0.55, golden: 0.65, high: 0.85 };
const ROLE_COVER_SIGMA: Record<Role, number> = { low: 0.2, mid: 0.26, golden: 0.3, high: 0.34 };

/**
 * 云幕质量 0~1 —— 「这层云被点亮后好不好看」。
 *
 * 必须是**两个独立因子**的乘积，混在一起是上一版最深的物理错误：
 *
 *  ① 覆盖率偏好 `coveragePreference(c)`
 *     云量决定"天空被填了多少"。不透明的云需要缝隙让光进来、也让
 *     观者有东西可看（最佳 ~45%）；半透明的卷云满铺也是一块好画布
 *     （最佳 ~85%，因为光线能直接穿透，且整片天空都在发光）。
 *     所以**最优覆盖率随云体透明度移动**。
 *
 *  ② 单体透明度 `elementQuality(τ_full)`
 *     同样 100% 覆盖，薄卷云（τ≈0.9）与浓层积云（τ≈18）的光学后果
 *     相差一个数量级：前者是被点亮的画布，后者是不透光的灰幕。
 *     云量百分比**完全不携带这个信息** —— 必须由云属/云水路径给出。
 *
 * 上一版只看云量、且用同一个钟形处理所有层，于是：
 *   · 满铺薄卷云（教科书级"全火烧"）→ 质量 0.008 → 判成无烧
 *   · 满铺低云（真正的阴天）        → 质量 0.74  → 与卷云无法区分
 *
 * @param cover01  云量 0~1
 * @param role     层角色
 * @param levelKey 等压面键（用于取该层的云水路径；缺省按中云估计）
 */
export function cloudScreenQuality(cover01: number, role: Role, levelKey?: LevelKey): number {
  const c = clamp(cover01, 0, 1);
  if (c <= 0.02) return 0;

  // τ_full = 该云属在 100% 覆盖时的光学厚度（由云水路径 + 有效半径决定）
  const tauFull = levelKey ? levelFullOpticalDepth(levelKey) : 9;
  if (tauFull <= 0) return 0;

  // ① 单体透明度：薄云 = 被点亮的画布；厚云 = 灰幕
  //    低云最吃亏（本来就要挡住地平线），卷云最受益
  const elementQuality = clamp(Math.exp(-Math.pow(tauFull / ROLE_TAU_TOLERANCE[role], 1.35)), 0, 1);

  // ② 覆盖率偏好：最优值随透明度上移（透明云可以满铺）
  const optimum = lerp(ROLE_OPTIMUM_OPAQUE[role], ROLE_OPTIMUM_THIN[role], clamp(elementQuality, 0, 1));
  const sigma = ROLE_COVER_SIGMA[role];
  const coveragePreference = Math.exp(-0.5 * Math.pow((c - optimum) / sigma, 2));

  // ③ 无云下限：覆盖率极低时确实没什么可烧
  const presence = smoothstep(0.02, 0.12, c);

  return clamp(presence * coveragePreference * (0.15 + 0.85 * elementQuality), 0, 1);
}

/** 沿等压面按高度插值云量（用于绘图/兼容，不做物理消光用） */
export function cloudAtHeightM(levels: Array<{ heightM: number; cover: number }>, heightM: number): number {
  const sorted = [...levels].sort((a, b) => a.heightM - b.heightM);
  if (heightM <= sorted[0].heightM) return sorted[0].cover;
  const last = sorted[sorted.length - 1];
  if (heightM >= last.heightM) return last.cover;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (heightM >= a.heightM && heightM <= b.heightM) {
      const t = (heightM - a.heightM) / Math.max(b.heightM - a.heightM, 1e-6);
      return lerp(a.cover, b.cover, t);
    }
  }
  return 0;
}

/** 在观测者距离 obsDistKm 处，按采样环线性插值某层云量 */
function coverAtObserverDistance(
  rings: ProfileRing[],
  key: LevelKey,
  obsDistKm: number,
): number {
  if (!rings.length) return 0;
  if (obsDistKm <= rings[0].ringKm) return rings[0].cover[key];
  const last = rings[rings.length - 1];
  // 超出数据范围：**持续性外推**（沿用最远已知值），而不是当成晴空。
  //
  // 这一点决定了「同一片大气，换采样分辨率得同一个答案」这个不变量能否成立：
  // 光路在目标层内可以走 80km，若数据只铺到 30km，把 30–80km 当晴空会让
  // 有效云量被稀释，于是 2 环和 6 环算出两个不同的 τ。改用持续性外推后，
  // 无论是 2 环还是 6 环，τ 都只有一个值。
  if (obsDistKm >= last.ringKm) return last.cover[key];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    if (obsDistKm >= a.ringKm && obsDistKm <= b.ringKm) {
      const t = (obsDistKm - a.ringKm) / Math.max(b.ringKm - a.ringKm, 1e-6);
      return lerp(a.cover[key], b.cover[key], t);
    }
  }
  return last.cover[key];
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 1 — 天文几何与光路采样网格
// ═══════════════════════════════════════════════════════════════════════════

export interface PathSample {
  offsetMin: number;
  timeMs: number;
  altitudeDeg: number;
  azimuthDeg: number;
  /** 太阳高度角 → 全天空辉光强度 0~1（broad twilight glow） */
  stage: number;
}

export interface LightPathPoint {
  ringKm: number;
  lat: number;
  lon: number;
}

export interface LightPathGrid {
  eventMs: number;
  mode: SunMode;
  eventAzimuthDeg: number;
  rings: LightPathPoint[];
  samples: PathSample[];
}

/**
 * Step 1：生成光路采样网格。
 *
 *  · 时间窗 [T0−20min, T0+40min]，步长 2min，共 31 帧。
 *  · 采样环 d ∈ {0, 30, 80, 150, 280, 450} km，沿**事件时刻**太阳方位角
 *    用球面大圆正解铺开（不是平面经纬度偏移，极区/高纬无畸变）。
 */
export function generateLightPathGrid(
  lat: number,
  lon: number,
  eventMs: number,
  mode: SunMode,
  stepMin = 2,
): LightPathGrid {
  const samples: PathSample[] = [];
  for (let off = TIMELINE_START_MIN; off <= TIMELINE_END_MIN; off += stepMin) {
    const t = eventMs + off * 60000;
    const sp = sunPosition(t, lat, lon);
    samples.push({
      offsetMin: off,
      timeMs: t,
      altitudeDeg: sp.altitude,
      azimuthDeg: sp.azimuth,
      stage: smoothKnots(STAGE_KNOTS, sp.altitude),
    });
  }

  const eventSun = sunPosition(eventMs, lat, lon);
  const rings: LightPathPoint[] = RING_KM.map((d) => {
    const p = destinationPoint(lat, lon, eventSun.azimuth, d);
    return { ringKm: d, lat: p.lat, lon: p.lon };
  });

  return { eventMs, mode, eventAzimuthDeg: eventSun.azimuth, rings, samples };
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 2 — 等压面云层解析与黄金云层提取
// ═══════════════════════════════════════════════════════════════════════════

export interface ProfileRing {
  ringKm: number;
  point: GeoPoint;
  sample: HourlySample;
  cover: Record<LevelKey, number>;
  heightM: Record<LevelKey, number>;
  /** 该环对观测者的视线是否被地平线切断（云太低太远） */
  visible: Record<LevelKey, boolean>;
}

export interface VerticalProfile {
  timeMs: number;
  rings: ProfileRing[];
  local: {
    cover: Record<LevelKey, number>;
    heightM: Record<LevelKey, number>;
    precipitation: number;
    humidity: number;
    visibilityM: number;
    weatherCode: number;
    cloudTotal: number;
    cloudLow: number;
    cloudMid: number;
    cloudHigh: number;
  };
  cloudBaseM: number | null;
  cloudTopM: number | null;
  goldenIndex: number;
  highIndex: number;
  clearSky: boolean;
}

/** 把小时序列线性插值到任意时刻 */
export function interpolateHourly(samples: HourlySample[], timeMs: number): HourlySample {
  const xs = samples.map((s) => s.timeMs);
  const pick = (fn: (s: HourlySample) => number): number => samplePiecewise(xs, samples.map(fn), timeMs);

  const cloud = {} as Record<LevelKey, number>;
  const levelHeightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) {
    cloud[k] = pick((s) => s.cloud[k]);
    levelHeightM[k] = pick((s) => s.levelHeightM[k]);
  }
  return {
    timeMs,
    cloud,
    levelHeightM,
    levelTempC: {},
    cloudLow: pick((s) => s.cloudLow),
    cloudMid: pick((s) => s.cloudMid),
    cloudHigh: pick((s) => s.cloudHigh),
    cloudTotal: pick((s) => s.cloudTotal),
    precipitation: pick((s) => s.precipitation),
    humidity: pick((s) => s.humidity),
    visibilityM: pick((s) => s.visibilityM),
    weatherCode: samples[0]?.weatherCode ?? 0,
    windSpeed: pick((s) => s.windSpeed),
    windDir: pick((s) => s.windDir),
    dewPointC: pick((s) => s.dewPointC),
    surfacePressureHpa: pick((s) => s.surfacePressureHpa),
  };
}

/**
 * Step 2：解析垂直云层剖面。
 *
 * 近场加权：0km 0.66、30km 0.34 —— 「头顶能不能烧起来」的主判据。
 * 更远的环只作为光路拦截体，不参与本地云幕评分。
 * 同时逐层判断观测者视线是否被地平线切断（isVisibleFromObserver）。
 */
export function parseVerticalCloudProfile(
  bundle: ForecastBundle,
  model: ModelId,
  timeMs: number,
  observerHeightM = 0,
): VerticalProfile {
  const ds = bundle.models[model];
  const rings: ProfileRing[] = ds.rings.map((r) => {
    const s = interpolateHourly(r.samples, timeMs);
    const cover = {} as Record<LevelKey, number>;
    const heightM = {} as Record<LevelKey, number>;
    const visible = {} as Record<LevelKey, boolean>;
    for (const k of LEVEL_KEYS) {
      cover[k] = clamp(s.cloud[k] / 100, 0, 1);
      heightM[k] = s.levelHeightM[k];
      visible[k] = isVisibleFromObserver(heightM[k], observerHeightM, r.ringKm);
    }
    return { ringKm: r.ringKm, point: r.point, sample: s, cover, heightM, visible };
  });

  const near = rings.filter((r) => r.ringKm <= 30);
  const weights = near.map((r) => (r.ringKm === 0 ? 0.66 : 0.34));
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;

  const cover = {} as Record<LevelKey, number>;
  const heightM = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) {
    cover[k] = near.reduce((acc, r, i) => acc + r.cover[k] * weights[i], 0) / wSum;
    heightM[k] = near.reduce((acc, r, i) => acc + r.heightM[k] * weights[i], 0) / wSum;
  }

  const wpick = (fn: (s: HourlySample) => number): number =>
    near.reduce((acc, r, i) => acc + fn(r.sample) * weights[i], 0) / wSum;

  // 云底/云顶：必须按**高度**排序，不能按 hPa 排序后再取首尾。
  // 门槛取 20%（而不是 50%）：只要有两成覆盖，那就是被摄影师看见的云底。
  const withCloud = LEVEL_KEYS.filter((k) => cover[k] >= 0.2)
    .map((k) => ({ key: k, heightM: heightM[k] }))
    .sort((a, b) => a.heightM - b.heightM);

  const goldenIndex = clamp(
    0.5 * cloudScreenQuality(cover['600'], 'golden', '600') +
      0.5 * cloudScreenQuality(cover['500'], 'golden', '500'),
    0,
    1,
  );
  const highIndex = clamp(
    0.45 * cloudScreenQuality(cover['400'], 'high', '400') +
      0.55 * cloudScreenQuality(cover['300'], 'high', '300'),
    0,
    1,
  );

  return {
    timeMs,
    rings,
    local: {
      cover,
      heightM,
      precipitation: wpick((s) => s.precipitation),
      humidity: wpick((s) => s.humidity),
      visibilityM: wpick((s) => s.visibilityM),
      weatherCode: near[0]?.sample.weatherCode ?? 0,
      cloudTotal: wpick((s) => s.cloudTotal),
      cloudLow: wpick((s) => s.cloudLow),
      cloudMid: wpick((s) => s.cloudMid),
      cloudHigh: wpick((s) => s.cloudHigh),
    },
    cloudBaseM: withCloud.length ? withCloud[0].heightM : null,
    cloudTopM: withCloud.length ? withCloud[withCloud.length - 1].heightM : null,
    goldenIndex,
    highIndex,
    clearSky: Math.max(...LEVEL_KEYS.map((k) => cover[k])) < 0.05,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 3 — 曲率切线光追与远方云墙一票否决
// ═══════════════════════════════════════════════════════════════════════════

export interface RayStation {
  ringKm: number;
  /** 光线在该环处的 MSL 海拔 m */
  rayHeightM: number;
  /** 该环真实地形海拔 m */
  terrainM: number;
  /** 该环可见地表（含曲率）的海拔 m */
  surfaceM: number;
  /** 光线是否被地形切断 */
  terrainBlocked: boolean;
  /** 该环在光线高度处的云量 0~1 */
  cloudAtRay: number;
  /** 该环降水 mm/h */
  precipitation: number;
  /** 累计光学厚度 */
  cumulativeTau: number;
  /** 累计透过率 */
  transmittance: number;
}

export interface RayMarchResult {
  stations: RayStation[];
  /** 最终透过率 0~1 */
  transmittance: number;
  /** 地形切断发生在哪一环（null = 未被切断） */
  blockedAtKm: number | null;
  /** 光线因地球曲率触地的距离（Infinity = 未触地） */
  groundHitKm: number;
  /** 累计光学厚度 */
  opticalDepth: number;
  /** 进光天窗是否被封死 */
  skyWindowClosed: boolean;
  /** 有效光程 km */
  effectiveRangeKm: number;
  /** 逐层朝太阳方向的透过率（含大气 + 沿途云 + 降水），按层键索引 */
  perLevelTransmittance: Record<LevelKey, number>;
  /** 逐层在自身厚度带内的累计穿越长度 (km)，用于诊断斜程放大 */
  perLevelPathKm: Record<LevelKey, number>;
}

export interface RayMarchOptions {
  /** 强制统一的云消光系数 (per km)，缺省按各层云水路径自算 */
  extinctionKappa?: number;
  /** 降水惩罚起始阈值 mm/h */
  precipThreshold?: number;
  /** 最大步进距离 */
  maxRangeKm?: number;
  /** 是否统计目标层自身厚度带内的消光（默认 true） */
  includeSelfExtinction?: boolean;
}

/**
 * 逐层朝太阳方向的直射光透过率 —— 引擎的核心积分。
 *
 * 几何：H_ray(d) = H₀ + d·tan(α) + d²/(2·R_eff)
 *
 * 对被照亮的某一层 L，光线从 L 出发朝太阳方向前进，依次：
 *   1. 穿越 L 自己的厚度带       → 自身消光（斜程！掠射时可达上百公里）
 *   2. 抬升到 L 之上             → 越过更高层（更高层的云不挡 L 的光）
 *   3. 下沉穿过各低层云的厚度带 → 真正的"云墙"遮挡
 *   4. 触地（晨昏线）或撞山      → 光路终止
 *
 * **关键修正（上一版的两处致命错误）：**
 *
 *  · 消光必须按**路径长度**积分：τ = ∫κ·cloud·ds，而不是在每个采样环上
 *    把该点整根垂直气柱的 τ 累加一次。后者会让同一片云的光学厚度随
 *    采样点数量线性膨胀 —— 换个环距就换一个答案，物理上不成立。
 *
 *  · 消光必须按**实际穿越的层**计，而不是"低于光线的云都算遮挡"。
 *    黄昏时曲率让光线在远端抬升到目标层之上，如果按后者，
 *    目标层自己在远端会被当成挡光的云墙再收一次 τ。
 *
 * 修正后：同一片大气无论用几个采样环、环距多少，τ 都只有一个答案。
 */
export function rayMarchingTransmittance(
  targetHeightM: number,
  sunAltitudeDeg: number,
  rings: ProfileRing[],
  terrainM: number[],
  options: RayMarchOptions = {},
): RayMarchResult {
  const precipTh = options.precipThreshold ?? 0.5;
  const maxRange = options.maxRangeKm ?? 450;
  const includeSelf = options.includeSelfExtinction ?? true;

  const emptyPerLevel = Object.fromEntries(LEVEL_KEYS.map((k) => [k, 1])) as Record<LevelKey, number>;
  const emptyPath = Object.fromEntries(LEVEL_KEYS.map((k) => [k, 0])) as Record<LevelKey, number>;

  if (!rings.length) {
    return {
      stations: [],
      transmittance: 0,
      blockedAtKm: null,
      groundHitKm: Infinity,
      opticalDepth: 0,
      skyWindowClosed: true,
      effectiveRangeKm: 0,
      perLevelTransmittance: emptyPerLevel,
      perLevelPathKm: emptyPath,
    };
  }

  // ── 1. 光路能走多远：触地 / 撞山 ──
  const groundHit = groundHitDistanceKm(targetHeightM, sunAltitudeDeg);
  let maxReach = Math.min(groundHit, maxRange);
  let blockedAtKm: number | null = null;

  // 地形用线性插值，而不是只看采样环所在点 —— 否则环距一改，遮挡结论就改
  const terrainAt = (d: number): number => {
    if (!terrainM.length) return 0;
    const ringKmArr = rings.map((r) => r.ringKm);
    if (d <= ringKmArr[0]) return terrainM[0] ?? 0;
    const lastIdx = ringKmArr.length - 1;
    if (d >= ringKmArr[lastIdx]) return terrainM[lastIdx] ?? 0;
    for (let i = 0; i < lastIdx; i++) {
      if (d >= ringKmArr[i] && d <= ringKmArr[i + 1]) {
        const t = (d - ringKmArr[i]) / Math.max(ringKmArr[i + 1] - ringKmArr[i], 1e-6);
        return lerp(terrainM[i] ?? 0, terrainM[i + 1] ?? 0, t);
      }
    }
    return 0;
  };

  const rayAt = (d: number): number => rayHeightM(targetHeightM, sunAltitudeDeg, d);

  // 地形遮挡：在 [0, maxReach] 内扫描，找第一次 ter > ray
  const scanStepKm = 1;
  for (let d = scanStepKm; d <= maxReach; d += scanStepKm) {
    if (terrainAt(d) > rayAt(d)) {
      blockedAtKm = d;
      maxReach = d;
      break;
    }
  }

  // ── 2. 云的光学厚度 ──
  //
  // 主量是**垂直光学厚度** τ_vert = τ_full · cover（只依赖云量与云属），
  // 再乘掠射气团因子 X = pathLength/thickness（上限 AIRMASS_CAP）。
  //
  // 为什么不能直接用几何路径长度乘 κ：平面平行云的掠射路径在 α→0 时
  // 发散，40% 覆盖的黄金层会算出 τ≈114，整片天空变漆黑 —— 而真实的
  // 破碎云有缝隙，掠射光走的是云隙。气团上限正是这个次网格修正。
  const perLevelTau: Record<LevelKey, number> = Object.fromEntries(LEVEL_KEYS.map((k) => [k, 0])) as never;
  const perLevelCover: Record<LevelKey, number> = Object.fromEntries(LEVEL_KEYS.map((k) => [k, 0])) as never;
  const perLevelPathKm: Record<LevelKey, number> = Object.fromEntries(LEVEL_KEYS.map((k) => [k, 0])) as never;
  const levelHeightOf = (k: LevelKey): number => rings[0]?.heightM?.[k] ?? LEVEL_BY_KEY[k].nominalM;

  for (const k of LEVEL_KEYS) {
    const halfM = LEVEL_THICKNESS_M[k];
    const levelH = levelHeightOf(k);
    const lo = Math.max(levelH - halfM, 0);
    const hi = levelH + halfM;

    const { lengthKm, intervals } = pathLengthInBand(targetHeightM, sunAltitudeDeg, lo, hi, maxReach);
    if (!lengthKm || !intervals.length) continue;

    // 用区间中点的云量做水平距离加权平均（不同环的云量不同）
    let coverAcc = 0;
    let horizKm = 0;
    for (const iv of intervals) {
      const dMid = (iv.fromKm + iv.toKm) / 2;
      const segHoriz = iv.toKm - iv.fromKm;
      coverAcc += coverAtObserverDistance(rings, k, dMid) * segHoriz;
      horizKm += segHoriz;
    }
    const coverEff = clamp(coverAcc / Math.max(horizKm, 1e-6), 0, 1);
    perLevelCover[k] = coverEff;
    perLevelPathKm[k] = lengthKm;
    if (coverEff <= 0.02) continue;

    const isSelfBand = lo <= targetHeightM && targetHeightM <= hi;
    if (isSelfBand && !includeSelf) continue;

    const thicknessKm = (2 * halfM) / 1000;

    // 目标层自身的消光：光打在云顶，穿一次（不反复穿越）。
    // 遮挡层则按掠射气团放大，上限随其覆盖率收缩（破碎云走云隙）。
    const cap = isSelfBand ? 1.0 : airmassCapForCover(coverEff);
    const X = slabAirmass(thicknessKm, lengthKm, cap);

    // **云块内部**的光学厚度（不含覆盖率）。覆盖率在外层以破碎云形式处理。
    perLevelTau[k] = levelFullOpticalDepth(k) * X;
  }

  // 降水：沿光路在最近 150km 的强降水额外叠加（用线性插值而非单环取值）
  let precipTau = 0;
  const precipProbeKm = [10, 30, 60, 100, 150, 220, 300, 400].filter((d) => d <= maxReach);
  for (const d of precipProbeKm) {
    const p = precipAtDistance(rings, d);
    if (p > precipTh) precipTau += (1.1 + Math.min(p, 8) * 0.75) * 0.12;
  }

  const totalTau = LEVEL_KEYS.reduce((a, k) => a + perLevelTau[k], 0) + precipTau;

  // ── 3. 逐层朝太阳方向的透过率 ──
  //
  // 光路几何的真相（别凭直觉）：对 4200m 的目标云、α=−1.5°，
  // 朝太阳方向的光线是**先下沉**（195km 处降到 1653m），再被地球曲率抬回，
  // 到 450km 时升到 6030m。所以这条光路**两端高、中间低**，
  // 它实实在在穿过了 850 / 700 / 500 / 600 四层。
  //
  // 结论：**所有被光路穿越的层都参与遮挡**，不能按"只算更高层"简化 ——
  // 那会把最常见的黄昏构型（低层有零散碎云）的遮挡整个漏掉。
  // 判定"是否穿过"完全由几何给出（perLevelPathKm > 0），不需要人工排序。
  //
  // 破碎云的透过率不能用"面积平均 τ"直接代入 Beer–Lambert：
  //
  //    错误：T = exp(−τ_full · c · X)      ← 等于假设整层是均匀雾
  //    正确：T = (1−c) + c · exp(−τ_full · X)
  //
  // 取 20% 覆盖的 700hPa 层、X=1.63：错误式给 T=0.0075（光几乎全被吃掉），
  // 正确式给 T=0.80（八成路程走云隙）。累乘四层后前者是 2.45e−7
  // （黄金层"完全没光"→ 判无烧），后者是 0.36（橙色余晖，符合实拍）。
  // 满铺时 c=1，两式退化一致 —— 这是破碎云的正确极限行为。
  const perLevelTransmittance = Object.fromEntries(LEVEL_KEYS.map((k) => [k, 1])) as Record<LevelKey, number>;

  /**
   * 逐层「有效照明度」—— 直接光束 + 散射分量。
   *
   * 为什么必须有散射分量（这是本引擎最容易被误判的一处物理）：
   *
   * α≈−1.5° 时，日光朝太阳方向要斜穿 450km（下沉到 1.6km 再被曲率抬回），
   * 沿途撞上 850/700/500/600 四层碎云。**直接光束**按 Beer–Lambert
   * 确实衰减到 ~1e−7 —— 这个数是对的，不是 bug。
   *
   * 但天空仍然橙红发亮。原因是此时打亮云层的**不是直射阳光，而是
   * 整个上半球天空的散射光**（多次散射 + 气溶胶前向散射）。Haber et al.
   * (2005) 明确指出黄昏色不能在单次散射或扩散极限下求解，必须计入
   * 有限次多重散射。直接光束接近零 ≠ 云没有被点亮。
   *
   * 散射分量的几何基础是**云隙连通性**：散射光来自广角，
   * 只要存在一条无云通路就能透过来，其概率是 Π(1−cᵢ)。
   * 太阳越低，散射光占比越大（直射光被抽干，天空辉光接管）。
   *
   *   T_eff = T_direct + w_diffuse(α) · Π(1−cᵢ)
   *
   * w_diffuse 在太阳接近地平线时趋近 1（几乎全是散射光），
   * 在高空太阳时趋近 0（直射为主）。
   */
  const diffuseWeight = (alphaDeg: number): number => {
    // α ≥ 8°：以直射为主（w=0.12）；α ≤ -4°：几乎全为散射（w=0.95）
    const t = clamp((8 - alphaDeg) / 12, 0, 1);
    return 0.12 + 0.83 * smoothstep(0, 1, t);
  };

  const effectiveIllumination = (target: LevelKey): number => {
    let tDirect = Math.exp(-precipTau);
    let skyOpening = 1;
    for (const other of LEVEL_KEYS) {
      if (other === target) continue;
      // 光路几何上没穿过这一层 → 不构成遮挡
      if (perLevelPathKm[other] <= 0) continue;
      const c = perLevelCover[other];
      if (c <= 0.02) continue;
      // 要么走云隙（1−c），要么撞进云块后被消光
      tDirect *= 1 - c + c * Math.exp(-perLevelTau[other]);
      // 云隙连通性：散射光只要能找到一条无云通路即可透射
      skyOpening *= 1 - c;
    }
    const w = diffuseWeight(sunAltitudeDeg);
    return clamp(tDirect + w * skyOpening * (1 - tDirect), 0, 1);
  };

  for (const k of LEVEL_KEYS) {
    perLevelTransmittance[k] = effectiveIllumination(k);
  }

  // ── 4. 采样站：给绘图用 ──
  const stations: RayStation[] = [];
  const ringKmArr = rings.map((r) => r.ringKm);
  for (const ring of rings) {
    const d = ring.ringKm;
    if (d > maxReach + 1e-6) {
      stations.push({
        ringKm: d,
        rayHeightM: rayAt(d),
        terrainM: terrainAt(d),
        surfaceM: terrainAt(d) - curvatureDropM(d),
        terrainBlocked: true,
        cloudAtRay: 0,
        precipitation: ring.sample?.precipitation ?? 0,
        cumulativeTau: Number.POSITIVE_INFINITY,
        transmittance: 0,
      });
      continue;
    }
    // 该环处光路所穿层的有效云量
    let cloudHere = 0;
    for (const k of LEVEL_KEYS) {
      const halfM = LEVEL_THICKNESS_M[k];
      const h = ring.heightM[k];
      if (rayAt(d) >= h - halfM && rayAt(d) <= h + halfM) {
        cloudHere = Math.max(cloudHere, ring.cover[k]);
      }
    }
    let tauToHere = 0;
    for (const k of LEVEL_KEYS) {
      const halfM = LEVEL_THICKNESS_M[k];
      const h = ring.heightM[k];
      const lo = Math.max(h - halfM, 0);
      const hi = h + halfM;
      const { lengthKm } = pathLengthInBand(targetHeightM, sunAltitudeDeg, lo, hi, d);
      if (lengthKm <= 0) continue;
      const thicknessKm = (2 * halfM) / 1000;
      const isSelf = lo <= targetHeightM && targetHeightM <= hi;
      tauToHere +=
        levelVerticalTau(k, ring.cover[k]) *
        slabAirmass(thicknessKm, lengthKm, isSelf ? 1.0 : airmassCapForCover(ring.cover[k]));
    }
    stations.push({
      ringKm: d,
      rayHeightM: rayAt(d),
      terrainM: terrainAt(d),
      surfaceM: terrainAt(d) - curvatureDropM(d),
      terrainBlocked: false,
      cloudAtRay: clamp(cloudHere, 0, 1),
      precipitation: ring.sample?.precipitation ?? 0,
      cumulativeTau: tauToHere,
      transmittance: Math.exp(-tauToHere),
    });
  }

  const transmittance = blockedAtKm !== null ? 0 : Math.exp(-(totalTau + precipTau));

  return {
    stations,
    transmittance,
    blockedAtKm,
    groundHitKm: groundHit,
    opticalDepth: totalTau + precipTau,
    skyWindowClosed: blockedAtKm !== null || groundHit < 40,
    effectiveRangeKm: maxReach,
    perLevelTransmittance,
    perLevelPathKm,
    // 保留 ringKmArr 供调试（未使用，避免 lint 报警）
  } as RayMarchResult;
}

/** 在观测者距离 d 处按采样环线性插值降水 */
function precipAtDistance(rings: ProfileRing[], d: number): number {
  if (!rings.length) return 0;
  if (d <= rings[0].ringKm) return rings[0].sample?.precipitation ?? 0;
  const last = rings[rings.length - 1];
  if (d >= last.ringKm) return last.sample?.precipitation ?? 0;
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    if (d >= a.ringKm && d <= b.ringKm) {
      const t = (d - a.ringKm) / Math.max(b.ringKm - a.ringKm, 1e-6);
      return lerp(a.sample?.precipitation ?? 0, b.sample?.precipitation ?? 0, t);
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 4 — CAMS 气溶胶光谱消光（委托 spectral.ts）
// ═══════════════════════════════════════════════════════════════════════════

export interface SpectralInput {
  aod: number;
  pm25: number;
  dust: number;
  humidity: number;
  visibilityKm: number;
  /** 气溶胶数据是否真实可用；缺省 true（直接调用视为有数据） */
  aerosolAvailable?: boolean;
}

export function calculateSpectralExtinction(input: SpectralInput): SpectralReport {
  const vis =
    Number.isFinite(input.visibilityKm) && input.visibilityKm > 0
      ? input.visibilityKm
      : visibilityFromAod(input.aod, input.humidity);
  return evaluateSpectral(
    input.aod,
    input.pm25,
    input.dust,
    input.humidity,
    vis,
    input.aerosolAvailable ?? true,
  );
}

/**
 * 近场加权采样气溶胶时序。
 *
 * `aerosolAvailable` 用来区分「真实取到 AOD=0.05」与「接口失败、数组为空」。
 * 上一版把两者都当 0 处理，导致空气质量的请求一失败，AOD 就被钳到下限
 * 0.01、命中「水晶天」分支，鲜艳度虚高 155% —— 数据越缺、预报越乐观。
 */
export function sampleAerosol(
  bundle: ForecastBundle,
  model: ModelId,
  timeMs: number,
): { aod: number; pm25: number; dust: number; pm10: number; humidity: number; aerosolAvailable: boolean } {
  const near = bundle.models[model].aerosol.filter((r) => r.ringKm <= 30);
  const list = near.length ? near : bundle.models[model].aerosol;
  const acc = { aod: 0, pm25: 0, dust: 0, pm10: 0, humidity: 0 };
  let wSum = 0;
  let sampled = 0;

  for (const r of list) {
    if (!r.samples.length) continue;
    const w = r.ringKm === 0 ? 0.66 : 0.34;
    const xs = r.samples.map((s) => s.timeMs);
    acc.aod += samplePiecewise(xs, r.samples.map((s) => s.aod), timeMs) * w;
    acc.pm25 += samplePiecewise(xs, r.samples.map((s) => s.pm25), timeMs) * w;
    acc.dust += samplePiecewise(xs, r.samples.map((s) => s.dust), timeMs) * w;
    acc.pm10 += samplePiecewise(xs, r.samples.map((s) => s.pm10), timeMs) * w;
    acc.humidity += samplePiecewise(xs, r.samples.map((s) => s.humidity), timeMs) * w;
    wSum += w;
    sampled++;
  }

  const aerosolAvailable = sampled > 0 && wSum > 0;
  wSum = wSum || 1;
  return {
    aod: acc.aod / wSum,
    pm25: acc.pm25 / wSum,
    dust: acc.dust / wSum,
    pm10: acc.pm10 / wSum,
    humidity: acc.humidity / wSum,
    aerosolAvailable,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 5 — 综合量化输出
// ═══════════════════════════════════════════════════════════════════════════

export interface EngineInput {
  point: GeoPoint;
  mode: SunMode;
  /** 机位高度 AGL (m) —— 离地高度，无人机/楼顶/高山都填这个 */
  observerHeightM: number;
  bundle: ForecastBundle;
  primaryModel: ModelId;
  timezoneOffsetSeconds: number;
  timezone: string;
  locationLabel: string;
  eventMs: number;
  daily: { sunriseMs: number | null; sunsetMs: number | null };
  compareModels?: ModelId[];
}

/** 单次评估的中间量（时序与静态诊断共用） */
interface LayerEval {
  key: LevelKey;
  label: string;
  role: Role;
  cover: number;
  heightM: number;
  quality: number;
  lit: number;
  transmittance: number;
  visible: number;
  contribution: number;
  terrainBlocked: boolean;
  opticalDepth: number;
  groundHitKm: number;
  /** 该层贡献最大的采样环 */
  bestRingKm: number;
  /** 光路在该层厚度带内的穿越长度 (km) —— 斜程放大诊断 */
  pathKm: number;
}

interface Snapshot {
  timeMs: number;
  layers: LayerEval[];
  sum: number;
  spectral: SpectralReport;
  hue: number;
  chroma: number;
  redBlue: number;
  profile: VerticalProfile;
  aer: { aod: number; pm25: number; dust: number; pm10: number; humidity: number; aerosolAvailable: boolean };
}

function gradeOf(v: number): { key: GradeKey; label: string; en: string } {
  for (const g of GRADES) if (v < g.max) return { key: g.key, label: g.label, en: g.en };
  const last = GRADES[GRADES.length - 1];
  return { key: last.key, label: last.label, en: last.en };
}

/**
 * 鲜艳度 → 百分制。
 * 标定：0.6（大烧门槛）≈67、1.0（大烧上限）≈84、1.5（世纪大烧）≈94，
 * 与 SunsetBot 分级口径一致。
 */
function scoreOf(v: number): number {
  return clamp(100 * (1 - Math.exp(-v * 1.85)), 0, 100);
}

/** 鲜艳度软压缩：1.8 以下线性，以上逐渐饱和，硬上限 2.75 */
function compressVividness(x: number): number {
  if (x <= 1.8) return Math.max(0, x);
  return Math.min(2.75, 1.8 + (x - 1.8) * 0.5);
}

/**
 * 单时刻评估 —— 引擎的原子操作。
 * 时序循环、静态诊断、多模型对比全部复用这一个函数，
 * 保证「图上和图上的数字」永远同源。
 */
/**
 * 单层光路评分 —— 逐环评估「光从远端穿到该环时，该环这层云有多好」。
 *
 * 为什么必须逐环：
 *   只算头顶（d=0）的光路时，日落低角度会让光线在近处贴着云层掠过，
 *   于是误判「头顶云被自己遮住」→ 全天无烧。但真实情况是光线在 450km
 *   外仍高高在上，只在最后几十公里才降到云层高度 —— **远处的同一层云是亮的**。
 *   这是「本地无云、天边大烧」「该带长焦」的物理来源。
 *
 *   T_to_ring(r) = exp(−(τ_total − τ(r)))，即光从最远受光点穿到 r 的剩余份额。
 */
/**
 * 近远权重：越近可见的云幕，对本地观感的贡献越大。
 * 但**不能**让最远环靠"τω 差值必然为 1"白拿分 —— 见 evaluateLayer。
 */
const RING_PROXIMITY: readonly number[] = [1.0, 0.94, 0.8, 0.63, 0.46, 0.34];

/**
 * 单层光路评分 —— 逐环评估「该环这层云此刻被点亮得如何」。
 *
 * 与上一版的本质区别：
 *
 *  · 透过率来自**解析的逐层光路积分**（`ray.perLevelTransmittance`），
 *    与环无关。同一层云在不同环上的受光条件只取决于「是否可见」与
 *    「离观测者多远」，而不是"τ 差值在最远环必然等于 1"这种伪量。
 *
 *  · 可见性用双地平线判据。4.2km 的云在地平线 231km 之外就看不见了，
 *    不会因为采样环铺到 450km 就凭空变可见。
 *
 *  · 因此「最远环必胜」的病态行为消失：均匀云场下最近环胜出，
 *    只有真正"近处云少、远处云多"的构型才会把最优环推向远处。
 */
function evaluateLayer(
  profile: VerticalProfile,
  levelKey: LevelKey,
  role: Role,
  sunAltitudeDeg: number,
  terrainM: number[],
  observerHeightM: number,
  cloudSea: { active: boolean; lowCover: number },
  rayCache?: Map<string, RayMarchResult>,
): {
  best: { ringKm: number; score: number; transmittance: number; cloudAtRing: number; lit: number; visible: number };
  terrainBlocked: boolean;
  opticalDepth: number;
  groundHitKm: number;
  pathKm: number;
} {
  const heightM = profile.local.heightM[levelKey];
  const cacheKey = `${levelKey}|${sunAltitudeDeg.toFixed(3)}`;
  let ray = rayCache?.get(cacheKey);
  if (!ray) {
    ray = rayMarchingTransmittance(heightM, sunAltitudeDeg, profile.rings, terrainM);
    rayCache?.set(cacheKey, ray);
  }

  const lit = cloudLitFactor(heightM, sunAltitudeDeg, role);
  const tauTotal = Number.isFinite(ray.opticalDepth) ? ray.opticalDepth : 1e6;

  let best = { ringKm: 0, score: 0, transmittance: 0, cloudAtRing: 0, lit, visible: 0 };

  for (let i = 0; i < profile.rings.length; i++) {
    const ring = profile.rings[i];

    // 视线是否被地平线切断（双地平线判据）
    const geometricVisible = ring.visible[levelKey];
    let visibleFactor: number;
    if (geometricVisible) visibleFactor = 1;
    else if (observerHeightM > heightM) visibleFactor = 1; // 站在云层之上，必见
    else visibleFactor = 0.05; // 在地平线以下：几乎不可见，仅留极弱余量

    let cover = clamp(ring.cover[levelKey], 0, 1);
    let litEff = lit;
    let w: number = RING_PROXIMITY[i] ?? 0.3;

    if (cloudSea.active && (levelKey === '925' || levelKey === '850')) {
      litEff = Math.max(lit, 0.5 * cloudSea.lowCover);
      w = Math.max(w, 0.55);
      cover = Math.max(cover, 0.35);
      visibleFactor = 1;
    }

    const quality = cloudScreenQuality(cover, role, levelKey);
    if (quality <= 0) continue;

    // 近远权重：最近环满权，最远环 0.34 —— 不再有 0.55 的保底
    const score = quality * litEff * visibleFactor * ray.perLevelTransmittance[levelKey] * w;

    if (score > best.score) {
      best = {
        ringKm: ring.ringKm,
        score,
        transmittance: ray.perLevelTransmittance[levelKey],
        cloudAtRing: cover,
        lit: litEff,
        visible: visibleFactor,
      };
    }
  }

  return {
    best,
    terrainBlocked: ray.blockedAtKm !== null,
    opticalDepth: Math.min(tauTotal, 60),
    groundHitKm: ray.groundHitKm,
    pathKm: ray.perLevelPathKm[levelKey] ?? 0,
  };
}

/**
 * 单时刻评估 —— 引擎的原子操作。
 * 时序循环、静态诊断、多模型对比全部复用这一个函数，
 * 保证「图上的数和图上的图」永远同源。
 *
 * @param observerMslM 观测者**海拔**（MSL m），已由调用方把 AGL + 地面高程合成
 */
function evaluateSnapshot(
  bundle: ForecastBundle,
  model: ModelId,
  terrainM: number[],
  timeMs: number,
  sunAltitudeDeg: number,
  observerMslM: number,
  cloudSea: { active: boolean; lowCover: number },
): Snapshot {
  const profile = parseVerticalCloudProfile(bundle, model, timeMs, observerMslM);
  const aer = sampleAerosol(bundle, model, timeMs);

  const visKm =
    profile.local.visibilityM > 0 ? profile.local.visibilityM / 1000 : visibilityFromAod(aer.aod, aer.humidity);
  const spectral = calculateSpectralExtinction({
    aod: aer.aod,
    pm25: aer.pm25,
    dust: aer.dust,
    humidity: Math.max(aer.humidity, profile.local.humidity),
    visibilityKm: visKm,
    aerosolAvailable: aer.aerosolAvailable,
  });

  const rayCache = new Map<string, RayMarchResult>();

  const layers: LayerEval[] = [];
  let sum = 0;

  for (const lk of LEVEL_KEYS) {
    const role = ROLE_OF(lk);
    const meta = LEVEL_BY_KEY[lk];
    const nearCover = profile.local.cover[lk];
    const heightM = profile.local.heightM[lk];

    const ev = evaluateLayer(profile, lk, role, sunAltitudeDeg, terrainM, observerMslM, cloudSea, rayCache);

    const contribution = ROLE_WEIGHT[role] * ev.best.score;
    sum += contribution;

    const repCover = ev.best.score > 0 ? ev.best.cloudAtRing : nearCover;

    layers.push({
      key: lk,
      label: meta.label,
      role,
      cover: repCover,
      heightM,
      quality: cloudScreenQuality(repCover, role, lk),
      lit: ev.best.lit,
      transmittance: ev.best.transmittance,
      visible: ev.best.visible,
      contribution,
      terrainBlocked: ev.terrainBlocked,
      opticalDepth: ev.opticalDepth,
      groundHitKm: ev.groundHitKm,
      bestRingKm: ev.best.ringKm,
      pathKm: ev.pathKm,
    });
  }

  const angstrom = angstromFromAod(aer.dust, aer.pm25);
  const goldenH = profile.local.heightM['600'];
  const beam = directSunRgb(sunAltitudeDeg, goldenH, aer.aod, angstrom, Math.max(aer.humidity, profile.local.humidity));
  const chroma = colorChroma(beam.rgb);
  const redBlue = beam.rgb.b > 1e-6 ? beam.rgb.r / beam.rgb.b : 1;

  return { timeMs, layers, sum, spectral, hue: chroma.hue, chroma: chroma.saturation, redBlue, profile, aer };
}

function vividnessOf(
  snap: Snapshot,
  stage: number,
  guards: {
    lowLock: boolean;
    fogLock: boolean;
    overcastLock: boolean;
    thickDeckLock: boolean;
    cloudSeaBonus: number;
    terrainFactor: number;
    wallFactor: number;
  },
): number {
  const { spectral, sum, redBlue } = snap;

  // 红/蓝比 → 纯度增益（实际光路算出来的，不是经验常数）
  const purity = 0.74 + 0.26 * clamp(Math.log10(Math.max(redBlue, 1)) / Math.log10(6), 0, 1);

  // 鲜艳度标定
  // ─────────────
  // VIVIDNESS_SCALE 是连接「物理量」与「SunsetBot 0–2.5 鲜艳度」的唯一常数。
  // 它没有物理含义，纯粹是行业刻度的换算系数。
  //
  // 定标锚点（用 calibrationScenarios 的十个典型场景反解）：
  //   · 洁净天空 · 45% 黄金层        → 目标 ~0.75（小到中烧）
  //   · 卷云+高积云双层 · 大烧典型    → 目标 ~0.95
  //   · 纯净卷云满铺 · 紫霞型        → 目标 ~0.60
  //   · 水晶天                       → 目标 ~0.90
  //   · 整层阴天                     → 目标 ~0.08
  //
  // 上一版取 1.5，但那时逐层透过率被"上层云也算遮挡"的 bug 压到近乎 0，
  // 于是高得出奇的系数反而给出了看似合理的低分。修好物理后必须重新定标。
  const VIVIDNESS_SCALE = 0.62;
  let v = VIVIDNESS_SCALE * sum * stage * spectral.saturationGain * spectral.hazePenalty * purity;

  if (guards.lowLock) v *= 0.30;
  if (guards.fogLock) v *= 0.5;
  if (guards.overcastLock) v *= 0.26;
  if (guards.thickDeckLock) v *= 0.58;
  v *= guards.terrainFactor * guards.wallFactor;

  v += guards.cloudSeaBonus * stage * spectral.saturationGain;

  // 无云天际渐变：上限锁死（天边只剩一条光带）
  if (snap.profile.clearSky) {
    const clearBase = (0.030 + 0.070 * stage) * spectral.saturationGain;
    v = Math.max(v, clearBase);
  }

  return compressVividness(Math.max(v, 0));
}

function skyTheme(spectral: SpectralReport, grade: GradeKey, meanHue: number): SkyColorTheme {
  const base = GRADE_THEME[grade];
  let toneName = '金橙';
  if (spectral.tone === 'hazy') toneName = '浑浊灰橙';
  else if (spectral.tone === 'dusty') toneName = '沙尘铜黄';
  else if (grade === 'none') toneName = '阴天灰';
  else if (grade === 'epic' || grade === 'extreme') toneName = meanHue < 18 ? '绯红烈焰' : '紫粉烈焰';
  else if (grade === 'faint' || grade === 'minor') toneName = '淡玫瑰金';

  return {
    key: grade,
    label: grade,
    gradient: [base.from, base.via, base.to],
    accent: base.accent,
    text: base.text,
    toneName,
  };
}

export function compassLabel(deg: number): string {
  const names = ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南', '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北'];
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return `${names[i]} ${deg.toFixed(0)}°`;
}

function buildTactical(p: {
  bestRingKm: number;
  goldenCover: number;
  highCover: number;
  lowCover: number;
  clearSky: boolean;
  spectral: SpectralReport;
  grade: GradeKey;
  sunAzimuth: number;
  godRay: number;
}): TacticalAdvice {
  const { bestRingKm, goldenCover, highCover, lowCover, spectral, grade } = p;

  let focalLength: string;
  let focalReason: string;

  if (p.clearSky) {
    focalLength = '24–70mm + 渐变镜';
    focalReason = '全天几乎无云，只有天边余晖渐变；压低地平线、用渐变镜平衡曝光。';
  } else if (bestRingKm >= 150) {
    focalLength = '70–200mm (长焦)';
    focalReason = `主要受光云幕位于 ${Math.round(bestRingKm)}km 外，长焦压缩能把天边火烧云拉满画面，避免天空占比过小。`;
  } else if (bestRingKm >= 80) {
    focalLength = '24–105mm (中焦)';
    focalReason = `有效云幕在 ${Math.round(bestRingKm)}km 处，中焦兼顾地面剪影与云带层次。`;
  } else if (goldenCover > 0.42 || highCover > 0.5) {
    focalLength = '16–35mm (广角)';
    focalReason = '头顶 600–300hPa 云幕充盈，广角才能容纳整片被点燃的云海与放射状霞光。';
  } else {
    focalLength = '24–70mm (标准)';
    focalReason = '云量稀疏，主体是天边渐变与地景，标准焦段最稳妥。';
  }

  const exposureHint =
    grade === 'none' || grade === 'faint'
      ? '以天空中央为测光基准 −0.7EV 保住高光，地面走剪影。'
      : grade === 'major' || grade === 'extreme' || grade === 'epic'
        ? '以最亮云斑测光后 −1.3EV，包围曝光 3 张合成，避免绯红过曝成白。'
        : '以中天云带测光 −1.0EV，保留暖调层次。';

  const compositionHint = lowCover > 0.6
    ? '近地层云量偏多，抬高机位越过云层，让云顶成为前景。'
    : goldenCover > 0.3 && highCover > 0.3
      ? '存在双层云幕：以高云为背景、黄金层为前景，形成纵深。'
      : '寻找水面/湿地/玻璃幕墙做反射面，扩大可拍色彩面积。';

  const isoHint = spectral.aod > 0.5
    ? `AOD ${spectral.aod.toFixed(2)} 偏高，画面偏灰：ISO 100 + 轻度去雾后期。`
    : `空气通透（AOD ${spectral.aod.toFixed(2)}），ISO 100 长曝 1–8s 可拉出丝绢云流。`;

  const godRayProbability = clamp(p.godRay, 0, 0.95);
  const godRayNote = godRayProbability > 0.55
    ? '中高云存在 25–60% 的缝隙，太阳斜射穿越形成丁达尔光（霞光道）概率高，用长焦对准缝隙。'
    : godRayProbability > 0.25
      ? '云隙尚可，偶发丁达尔光；对准云洞边缘连拍，+0.3EV 提亮光柱。'
      : '云层过于密实或过于稀疏，丁达尔光条件不足。';

  return {
    focalLength,
    focalReason,
    directionDeg: p.sunAzimuth,
    directionLabel: compassLabel(p.sunAzimuth),
    godRayProbability,
    godRayNote,
    exposureHint,
    compositionHint,
    isoHint,
  };
}

/**
 * 主预测入口。
 */
export function predictSunset(input: EngineInput): SunsetPredictionOutput {
  const { bundle, primaryModel, observerHeightM, point, eventMs } = input;
  const dataset = bundle.models[primaryModel];
  const grid = generateLightPathGrid(point.lat, point.lon, eventMs, input.mode);
  const terrainM = bundle.terrain.map((t) => t.elevationM);

  // ── 观测者海拔 (MSL) ──
  // 用户输入的 observerHeightM 是 AGL（离地高度）。所有光学判据（地影线、
  // 云底、双地平线可见性、云海反转）都必须在**海拔**坐标系里做，否则站在
  // 3650m 高原上的摄影师会被当成在 0m 海平面，云底遮挡判断全错。
  const groundM = Number.isFinite(bundle.localElevationM) ? Math.max(bundle.localElevationM, 0) : 0;
  const observerMslM = groundM + Math.max(observerHeightM, 0);

  // ── 事件时刻静态诊断 ──
  const eventProfile0 = parseVerticalCloudProfile(bundle, primaryModel, eventMs, observerMslM);

  const lowTopM = Math.max(eventProfile0.local.heightM['925'], eventProfile0.local.heightM['850']);
  const lowCoverLocal = Math.max(eventProfile0.local.cover['925'], eventProfile0.local.cover['850']);
  const cloudSeaActive = observerMslM > lowTopM + 120 && lowCoverLocal > 0.4;
  const cloudSea = { active: cloudSeaActive, lowCover: lowCoverLocal };

  // ── 锁死判据 ──
  const cloudBase = eventProfile0.cloudBaseM;
  const belowBase = cloudBase === null || observerMslM < cloudBase;
  const visM = eventProfile0.local.visibilityM;

  // 有效低层云幕：850hPa(≈1.5km) 与 925hPa 合并看，任一满铺即封死地面视线
  const lowDeck = Math.max(eventProfile0.local.cover['925'], eventProfile0.local.cover['850']);

  const lowLock =
    !cloudSeaActive &&
    belowBase &&
    (lowDeck > 0.8 ||
      (eventProfile0.local.cover['925'] > 0.75 && eventProfile0.local.cover['850'] > 0.55) ||
      (visM > 0 && visM < 3000) ||
      (visM === 0 &&
        visibilityFromAod(sampleAerosol(bundle, primaryModel, eventMs).aod, eventProfile0.local.humidity) < 3));

  const fogLock =
    !cloudSeaActive && visM > 0 && visM < 3000 && eventProfile0.local.humidity > 90;

  // 整层阴天：700→400hPa 全部接近满铺，各层云幕互相遮挡、没有受光面
  const overcastLock =
    !cloudSeaActive &&
    eventProfile0.local.cover['700'] > 0.85 &&
    eventProfile0.local.cover['600'] > 0.8 &&
    eventProfile0.local.cover['500'] > 0.8 &&
    eventProfile0.local.cover['400'] > 0.85;

  // 中高云整层厚铺（700→400 全部 >88%）：即使没到严格"整层阴天"，
  // 云幕也已互相遮挡、只剩顶部一层薄亮边 —— 需要显著衰减。
  const thickDeckLock =
    !cloudSeaActive &&
    !overcastLock &&
    eventProfile0.local.cover['600'] > 0.88 &&
    eventProfile0.local.cover['500'] > 0.88 &&
    eventProfile0.local.cover['400'] > 0.88;

  // ── 地形否决：黄金层光路被山体切断 ──
  // 判据：在该方向的事件时刻，600hPa 光线被地形截断，且切断距离在可视化范围内
  //      （最外环之外被截断只说明远处有山，头顶仍可能受光）。
  const eventGoldenRay = rayMarchingTransmittance(
    eventProfile0.local.heightM['600'],
    sunPosition(eventMs, point.lat, point.lon).altitude,
    eventProfile0.rings,
    terrainM,
  );
  const terrainBlockKm =
    eventGoldenRay.blockedAtKm !== null && eventGoldenRay.blockedAtKm < 280
      ? eventGoldenRay.blockedAtKm
      : null;

  // ── 云墙封死判据 ──
  //
  // 上一版把「黄金层光路累计 τ > ln10」当作云墙封死，结果**目标层自身的
  // 斜程消光也被算进去**：一片均匀 55% 的黄金层，光穿过它自己就要走
  // 上百公里（掠射），τ 自然 > 2.3。于是教科书级的好天气被判成"远云封死"。
  //
  // 正确判据只统计**真正的拦截体**：光在抵达目标层之前，被目标层**之下**
  // 的云幕消耗掉多少。同一层云不会挡住照到它自己的光。
  // 「云墙封死」必须与主评分**同源**，否则会出现"某层贡献 0.4 但整体判无烧"
  // 这种自相矛盾的界面。这里直接复用逐层有效照明度：
  //   · 不再自己重算 τ（上一版漏掉了光路下沉段穿过的 500hPa 等更高层）
  //   · 天然包含散射分量，不会把"直射光接近零"误判成"天窗全封"
  //
  // 真正的封死语义：**所有**被照亮的层都拿不到有效照明。
  const bestGoldenIllum = Math.max(
    eventGoldenRay.perLevelTransmittance['600'],
    eventGoldenRay.perLevelTransmittance['500'],
  );
  const bestHighIllum = Math.max(
    eventGoldenRay.perLevelTransmittance['400'],
    eventGoldenRay.perLevelTransmittance['300'],
  );
  const cloudWallClosed =
    terrainBlockKm === null &&
    bestGoldenIllum < 0.55 &&
    bestHighIllum < 0.55 &&
    // 真正的"封死"还需要物理上确实有厚云+降水在挡路，
    // 不能仅凭照明度偏低（那可能只是太阳位置低）
    (eventProfile0.local.precipitation > 0.5 ||
      Math.max(
        eventProfile0.local.cover['700'],
        eventProfile0.local.cover['850'],
        eventProfile0.local.cover['925'],
      ) > 0.75);
  // 惩罚按"最好的那层还剩多少照明"连续给出
  const bestIllum = Math.max(bestGoldenIllum, bestHighIllum);
  const wallFactor = cloudWallClosed ? clamp(0.12 + bestIllum * 0.9, 0.12, 0.62) : 1;
  const eventGoldenTau = -Math.log(Math.max(bestIllum, 1e-9));

  // ── 时序评分 ──
  const series: TimeSample[] = [];
  const snapshots: Snapshot[] = [];
  for (const s of grid.samples) {
    const snap = evaluateSnapshot(bundle, primaryModel, terrainM, s.timeMs, s.altitudeDeg, observerMslM, cloudSea);
    snapshots.push(snap);
    const v = vividnessOf(snap, s.stage, {
      lowLock,
      fogLock,
      overcastLock,
      thickDeckLock,
      cloudSeaBonus: cloudSeaActive ? 0.16 * lowCoverLocal : 0,
      terrainFactor: terrainBlockKm !== null ? 0.22 : 1,
      wallFactor,
    });
    series.push({
      offsetMin: s.offsetMin,
      timeMs: s.timeMs,
      altitudeDeg: s.altitudeDeg,
      azimuthDeg: s.azimuthDeg,
      stage: s.stage,
      vividness: v,
      score: scoreOf(v),
      grade: gradeOf(v).key,
    });
  }

  // ── 峰值 / 时间轴 ──
  const peakIdx = series.reduce((best, s, i) => (s.vividness > series[best].vividness ? i : best), 0);
  const peak = series[peakIdx];
  const peakSnap = snapshots[peakIdx];

  const threshold = Math.max(0.12, peak.vividness * 0.35);
  let onsetIdx: number | null = null;
  for (let i = 0; i <= peakIdx; i++) {
    if (series[i].vividness >= threshold) {
      onsetIdx = i;
      break;
    }
  }
  let endIdx: number | null = null;
  for (let i = peakIdx; i < series.length; i++) {
    if (series[i].vividness >= threshold) endIdx = i;
  }

  const onset = onsetIdx !== null ? series[onsetIdx] : null;
  const endS = endIdx !== null ? series[endIdx] : null;

  // ── 二烧（紫霞 / afterglow）──
  //
  // 力学依据（Lee & Hernández-Andrés 2003 的 35 次实测统计）：
  //   紫光起始 α ≈ −1.4°，峰值 α ≈ −3.9°，结束 α ≈ −7.4°
  // 窗口按**太阳高度角**选取，而不是写死分钟数 —— 不同纬度/季节的
  // 太阳角速度相差很大（赤道 0.25°/min，高纬可低至 0.13°/min），
  // 用固定分钟数会让高纬的二烧窗口整体错位。
  const AFTERGLOW_MIN_ALT = -7.4;
  const AFTERGLOW_MAX_ALT = -1.4;
  // 计入 ±0.6° 的边界宽容度（云顶高于代表性高度、以及实测统计的 σ）
  const AFTERGLOW_FEATHER = 0.6;

  let afterglowVivid = 0;
  let afterglowFromMin = 20;
  let afterglowToMin = 35;
  let afterglowSeen = false;
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    if (s.altitudeDeg > AFTERGLOW_MAX_ALT + AFTERGLOW_FEATHER) continue;
    if (s.altitudeDeg < AFTERGLOW_MIN_ALT - AFTERGLOW_FEATHER) continue;
    // 边界处线性淡出，避免窗口端点发生硬跳变
    const edgeFade =
      s.altitudeDeg > AFTERGLOW_MAX_ALT
        ? 1 - (s.altitudeDeg - AFTERGLOW_MAX_ALT) / AFTERGLOW_FEATHER
        : s.altitudeDeg < AFTERGLOW_MIN_ALT
          ? 1 - (AFTERGLOW_MIN_ALT - s.altitudeDeg) / AFTERGLOW_FEATHER
          : 1;
    const snap = snapshots[i];

    // 二烧只由**高云**贡献：此时黄金层已基本入影，只有 8km 以上的卷云还在亮
    let highSum = 0;
    for (const l of snap.layers) {
      if (l.role !== 'high' && l.role !== 'golden') continue;
      const roleW = l.role === 'high' ? ROLE_WEIGHT.high : ROLE_WEIGHT.golden * 0.12;
      highSum += roleW * l.quality * l.lit * l.transmittance * l.visible;
    }

    // 与主分数同源的锁死/否决（上一版遗漏了，导致阴天也可能报二烧）
    //
    // **不能**乘 s.stage：那是"一烧"的晨昏辉光权重，在 α<−3° 后按设计
    // 快速衰减到 0.02。二烧恰恰发生在这个区间，乘上去会把峰值硬生生拉回
    // 日落前 —— 上一版二烧概率恒为 0~2% 的根因之一。
    // 二烧用自己的包络：以 α≈−3.9°（实测紫光峰值）为中心的高斯窗。
    const altCenter = -3.9;
    const altSigma = 2.2;
    const afterglowEnvelope = Math.exp(
      -0.5 * Math.pow((s.altitudeDeg - altCenter) / altSigma, 2),
    );

    let v =
      0.62 *
      highSum *
      afterglowEnvelope *
      snap.spectral.saturationGain *
      snap.spectral.hazePenalty *
      edgeFade;
    if (lowLock) v *= 0.30;
    if (fogLock) v *= 0.5;
    if (overcastLock) v *= 0.26;
    v *= terrainBlockKm !== null ? 0.22 : 1;
    v *= wallFactor;

    if (v > afterglowVivid) {
      afterglowVivid = v;
      afterglowFromMin = s.offsetMin;
      afterglowToMin = s.offsetMin;
      afterglowSeen = true;
    }
  }
  // 窗口取「峰值 ± 6 min」，并收敛到真实采样格点
  if (afterglowSeen) {
    afterglowFromMin = Math.max(TIMELINE_START_MIN, Math.round((afterglowFromMin - 6) / 2) * 2);
    afterglowToMin = Math.min(TIMELINE_END_MIN, Math.round((afterglowToMin + 6) / 2) * 2);
  } else {
    // 完全没落进紫光角度带（例如极昼、或时序窗太短）：退回名义窗口
    afterglowFromMin = 20;
    afterglowToMin = 35;
  }
  const afterglowProbability = clamp(afterglowVivid / 0.62, 0, 0.92);

  const timeline: TimelineReport = {
    onsetMs: onset ? onset.timeMs : null,
    peakMs: peak.timeMs,
    endMs: endS ? endS.timeMs : null,
    durationMin: onset && endS ? Math.round((endS.timeMs - onset.timeMs) / 60000) + 2 : 0,
    peakVividness: peak.vividness,
    peakScore: peak.score,
    afterglowProbability,
    afterglowWindow: { fromMin: afterglowFromMin, toMin: afterglowToMin },
    afterglowPeakVividness: compressVividness(afterglowVivid),
  };

  // ── 否决标记 ──

  let veto: VetoFlag = {
    active: false,
    kind: 'none',
    title: '光路通畅',
    detail: '无地形或云墙遮挡，本地云幕与远端进光天窗均成立。',
    penalty: 1,
  };

  if (terrainBlockKm !== null) {
    const oku = eventGoldenRay.stations.find((st) => st.ringKm === terrainBlockKm);
    const rayH = oku ? Math.round(oku.rayHeightM) : null;
    const terrM = oku ? Math.round(oku.terrainM) : null;
    veto = {
      active: true,
      kind: 'terrain',
      title: '远山遮蔽 · 地形否决',
      detail: `观测点 ${compassLabel(grid.eventAzimuthDeg)} 方向 ${terrainBlockKm}km 处地形 ${
        terrM !== null ? `${terrM}m` : ''
      } 高于太阳光线的几何高度${rayH !== null ? `（光路仅 ${rayH}m）` : ''}，黄金层光路被山体切断。`,
      penalty: 0.22,
    };
  } else if (lowLock) {
    veto = {
      active: true,
      kind: 'low-cloud-lock',
      title: '低云锁死 · 阴天',
      detail: `观测海拔 ${Math.round(observerMslM)}m（地面 ${Math.round(groundM)}m + 机位 ${Math.round(
        observerHeightM,
      )}m）位于云底 ${cloudBase ? Math.round(cloudBase) : '—'}m 之下，本地低云 ${Math.round(
        lowDeck * 100,
      )}%，直射光无法抵达受光云幕。试试把机位升到云层之上。`,
      penalty: 0.3,
    };
  } else if (fogLock) {
    veto = {
      active: true,
      kind: 'fog',
      title: '晨雾 / 霾层锁死',
      detail: `能见度 ${(visM / 1000).toFixed(1)}km、湿度 ${eventProfile0.local.humidity.toFixed(0)}%，近地层米氏消光过强。`,
      penalty: 0.45,
    };
  } else if (overcastLock) {
    veto = {
      active: true,
      kind: 'overcast',
      title: '整层阴天封顶',
      detail: '700 / 600 / 500 / 400hPa 云量均超过 80%，云幕自身沉入阴影，没有受光面。',
      penalty: 0.26,
    };
  } else if (cloudWallClosed) {
    veto = {
      active: true,
      kind: 'cloud-wall',
      title: '下方云墙封死天窗',
      detail: `黄金层以下的低中云在路上累计光学厚度 τ=${eventGoldenTau.toFixed(
        2,
      )}（>ln10），直射光在抵达受光云幕前已被消耗 90% 以上。`,
      penalty: wallFactor,
    };
  }

  // ── 分层报告 ──
  const layers: LayerReport[] = peakSnap.layers.map((l) => ({
    key: l.key,
    label: l.label,
    cover: l.cover * 100,
    altitudeM: l.heightM,
    quality: l.quality,
    transmittance: l.transmittance,
    visible: l.visible,
    contribution: l.contribution,
    role: l.role,
    terrainBlocked: l.terrainBlocked,
  }));

  // 战术与丁达尔都需要「代表性层覆盖」（取最优受光环，而非只在头顶）
  const goldenLayerRep = peakSnap.layers.find((l) => l.key === '600')!;
  const highLayerRep = Math.max(
    peakSnap.layers.find((l) => l.key === '400')?.cover ?? 0,
    peakSnap.layers.find((l) => l.key === '300')?.cover ?? 0,
  );
  const midLayerRep = peakSnap.layers.find((l) => l.key === '700')?.cover ?? 0;
  const noBurnAtAll = peakSnap.sum < 0.06;

  // ── 环报告 ──
  //
  // 上一版这里有两个可见 bug：
  //  · score 用 `Σ quality×lit` 再 clamp 到 1 → 每环都是 100%，无分辨力
  //  · transmittance 用 exp(−(τ_total − τ_here)) → 0km 处读 0.00，即
  //    「本地一点光都到不了」，与预报的大烧自相矛盾
  //
  // 现在：score = 该环**自身可见**的受光云幕得分（与主评分同一个函数），
  // transmittance = 该环处光路**剩余**的透过率（越远越高，物理正确）。
  const goldenH600 = peakSnap.profile.local.heightM['600'];
  const ringRay = rayMarchingTransmittance(
    goldenH600,
    peak.altitudeDeg,
    peakSnap.profile.rings,
    terrainM,
  );

  const rings: RingReport[] = dataset.rings.map((r, i) => {
    const prof = peakSnap.profile.rings.find((p) => p.ringKm === r.ringKm);
    const coverTotal = prof ? Math.max(...LEVEL_KEYS.map((k) => prof.cover[k])) : 0;
    const st = ringRay.stations.find((x) => x.ringKm === r.ringKm);
    const rayAt600 = rayHeightM(goldenH600, peak.altitudeDeg, r.ringKm);
    const terr = bundle.terrain[i]?.elevationM ?? 0;
    const blocked = !!st?.terrainBlocked || (terr > rayAt600 && r.ringKm > 0);

    // 该环自身「可见的受光云幕」加权得分（0~1，不饱和）
    let score = 0;
    if (prof && !blocked) {
      for (const k of LEVEL_KEYS) {
        const role = ROLE_OF(k);
        const vis = prof.visible[k] ? 1 : 0.05;
        score +=
          ROLE_WEIGHT[role] *
          cloudScreenQuality(prof.cover[k], role, k) *
          cloudLitFactor(prof.heightM[k], peak.altitudeDeg, role) *
          vis;
      }
      // 归一到「全部 7 层都满配」的理论最大值
      const maxPossible = LEVEL_KEYS.reduce((a, k) => a + ROLE_WEIGHT[ROLE_OF(k)], 0);
      score = clamp(score / maxPossible, 0, 1);
      // 近处可见的云幕更重要
      score *= RING_PROXIMITY[i] ?? 0.3;
    }

    return {
      ringKm: r.ringKm,
      point: r.point,
      cloudCoverTotal: coverTotal * 100,
      transmittance: st && Number.isFinite(st.transmittance) && !st.terrainBlocked ? st.transmittance : 0,
      terrainBlocked: blocked,
      terrainElevationM: terr,
      rayHeightM: rayAt600,
      precipitation: prof?.sample?.precipitation ?? 0,
      score,
    };
  });

  // 无环数据时（上游 API 完全失败）不能让 reduce 拿到 undefined 初值
  const bestRing: RingReport = rings.length
    ? rings.reduce((b, r) => (r.score > b.score ? r : b), rings[0])
    : {
        ringKm: 0,
        point,
        cloudCoverTotal: 0,
        transmittance: 0,
        terrainBlocked: false,
        terrainElevationM: groundM,
        rayHeightM: 0,
        precipitation: 0,
        score: 0,
      };

  // ── 多模型对照 ──
  const compare = (input.compareModels ?? (['ecmwf', 'gfs', 'icon'] as ModelId[])).filter((m) => bundle.models[m]);
  const modelPeaks = compare.map((m) => {
    const vals = grid.samples.map((s) => {
      const snap = evaluateSnapshot(bundle, m, terrainM, s.timeMs, s.altitudeDeg, observerMslM, cloudSea);
      return vividnessOf(snap, s.stage, {
        lowLock,
        fogLock,
        overcastLock,
        thickDeckLock,
        cloudSeaBonus: cloudSeaActive ? 0.16 * lowCoverLocal : 0,
        terrainFactor: terrainBlockKm !== null ? 0.22 : 1,
        wallFactor,
      });
    });
    const pk = vals.length ? Math.max(...vals) : 0;
    return {
      model: m,
      label: bundle.models[m].label,
      peakVividness: pk,
      peakScore: scoreOf(pk),
      series: vals,
    };
  });

  const peaks = modelPeaks.map((m) => m.peakVividness);
  const spread = peaks.length > 1 ? Math.max(...peaks) - Math.min(...peaks) : 0;
  // 用固定参考尺度（0.55 鲜艳度单位）而非均值归一：
  // 均值接近 0 时（各源都说无烧）不该被判成「100% 分歧」。
  const agreement = clamp(spread / (spread + 0.55), 0, 0.95);

  // ── 数据完整度 ──
  // 置信度不能只衡量模型间分歧：如果某个模型的气压层云量整列缺测
  // （Open-Meteo 对该模型不提供），它会被解析成全 0，看起来像"模型说无烧"。
  // 那不是分歧，那是没数据。这里单独量化数据完整度，并从置信度中扣除。
  //
  // 注意：**"云量 = 0" 是合法观测值，不是缺测**。判据必须是
  // "有没有样本" + "该变量是否落进了数组"，而不是值是否大于 0。
  const completeness = (() => {
    let ringCount = 0;
    let ringsWithSamples = 0;
    for (const m of compare) {
      const ds = bundle.models[m];
      // 只统计**实际返回了环**的模型：comparison 里若有模型整体没数据，
      // 它不该把"用户实际使用的数据完整度"往下拉
      if (!ds.rings.length) continue;
      for (const ring of ds.rings) {
        ringCount++;
        if (ring.samples.length >= 2) ringsWithSamples++;
      }
    }
    // 主源必须有数据，否则完整度为 0
    const primaryHasData = (bundle.models[primaryModel]?.rings.length ?? 0) > 0;
    if (!ringCount || !primaryHasData) {
      return 0;
    }
    const ringCoverage = ringsWithSamples / ringCount;

    // 位势高度：是否拿到真实探空高度（而不是退回标称值）
    const sample = peakSnap.profile.rings[0]?.sample;
    const nominal: Record<LevelKey, number> = {
      '925': 780, '850': 1500, '700': 3000, '600': 4200, '500': 5500, '400': 7200, '300': 9200,
    };
    let heightReal = 0;
    let heightTotal = 0;
    if (sample) {
      for (const k of LEVEL_KEYS) {
        heightTotal++;
        if (Math.abs(sample.levelHeightM[k] - nominal[k]) > 1) heightReal++;
      }
    }
    const heightCoverage = heightTotal ? heightReal / heightTotal : 0;

    const aerOk = peakSnap.aer.aerosolAvailable ? 1 : 0;
    const visOk = peakSnap.profile.local.visibilityM > 0 ? 1 : 0;
    const terrainOk = bundle.terrain.some((t) => t.elevationM > 0) ? 1 : 0;

    return clamp(
      0.40 * ringCoverage + 0.18 * heightCoverage + 0.22 * aerOk + 0.12 * visOk + 0.08 * terrainOk,
      0,
      1,
    );
  })();

  // 置信度 = 模型一致性 × 数据完整度
  // 两个因子都要：三源一致但数据缺失 → 不能给高置信；
  // 数据齐全但三源打架 → 也不能给高置信。
  const uncertainty = clamp(agreement * 0.8 + (1 - completeness) * 0.6, 0, 0.95);
  const confidence = clamp(completeness * (1 - 0.55 * agreement), 0.12, 0.97);

  // ── 丁达尔 ──
  // 丁达尔需要「有云可挡、也有缝可透」：中云 10%~70% 的过渡带最理想。
  // 用近场 + 代表性环的较大值，避免只有头顶无云时被误判为 0。
  const midCover = Math.max(peakSnap.profile.local.cover['700'], midLayerRep * 0.75);
  const gapPotential = smoothstep(0.08, 0.28, midCover) * (1 - smoothstep(0.6, 0.88, midCover));
  const godRay = clamp(
    gapPotential *
      (0.42 + 0.58 * Math.max(peakSnap.profile.local.cover['400'], 0)) *
      (1 - smoothstep(0.4, 0.85, lowCoverLocal)) *
      peakSnap.spectral.hazePenalty *
      (peakSnap.profile.local.precipitation > 0.5 ? 0.35 : 1),
    0,
    0.95,
  );

  const grade = gradeOf(timeline.peakVividness);
  const meanHue = snapshots.reduce((a, s, i) => a + s.hue * series[i].vividness, 0) /
    Math.max(snapshots.reduce((a, _s, i) => a + series[i].vividness, 0), 1e-6);

  const tactical = buildTactical({
    bestRingKm: bestRing.ringKm,
    goldenCover: goldenLayerRep.cover,
    highCover: highLayerRep,
    lowCover: lowCoverLocal,
    clearSky: noBurnAtAll,
    spectral: peakSnap.spectral,
    grade: grade.key,
    sunAzimuth: grid.eventAzimuthDeg,
    godRay,
  });

  return {
    vividness: timeline.peakVividness,
    score: timeline.peakScore,
    grade: grade.key,
    gradeLabel: grade.label,
    gradeEn: grade.en,
    confidence,
    uncertainty,
    completeness,
    modelAgreement: agreement,

    eventMs,
    mode: input.mode,
    sunAltitudeDeg: peak.altitudeDeg,
    sunAzimuthDeg: grid.eventAzimuthDeg,
    observerHeightM: observerMslM,
    observerAglM: Math.max(observerHeightM, 0),
    groundElevationM: groundM,
    cloudBaseM: cloudBase ?? 0,
    cloudTopM: eventProfile0.cloudTopM ?? 0,

    layers,
    rings,
    spectral: peakSnap.spectral,
    veto,
    cloudSeaReversal: cloudSeaActive,
    cloudSeaBonus: cloudSeaActive ? 0.16 * lowCoverLocal * peakSnap.spectral.saturationGain : 0,

    timeline,
    series,
    modelPeaks,

    tactical,
    theme: skyTheme(peakSnap.spectral, grade.key, meanHue),

    generatedAt: Date.now(),
    primaryModel,
    timezoneOffsetSeconds: input.timezoneOffsetSeconds,
    timezone: input.timezone,
    locationLabel: input.locationLabel,
    point,
    daily: input.daily,
    debug: {
      stageWeight: peak.stage,
      ringScores: rings.map((r) => r.score),
      layerDebug: peakSnap.layers.map((l) => ({
        key: l.key,
        cover: l.cover * 100,
        quality: l.quality,
        transmittance: l.transmittance,
        pathOpticalDepth: l.opticalDepth,
        pathKm: l.pathKm,
        bestRingKm: l.bestRingKm,
      })),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Canvas / 图表辅助
// ═══════════════════════════════════════════════════════════════════════════

export interface CrossSection {
  profile: VerticalProfile;
  targetLevel: LevelKey;
  targetHeightM: number;
  ray: RayMarchResult;
  levels: Array<{ key: LevelKey; label: string; heightM: number; cover: number; role: Role; lit: number }>;
  stations: Array<RayStation & { bands: Array<{ key: LevelKey; heightM: number; cover: number; role: Role; lit: number }> }>;
  sunAltitudeDeg: number;
  shadowHeightM: number;
  /** 观测者海拔 MSL (m) = 地面 DEM + AGL */
  observerMslM: number;
}

/**
 * 生成某一时刻的光路截面（Canvas 绘制的唯一数据源）。
 *
 * @param observerAglM 机位离地高度 AGL (m)；内部会加上地面 DEM 换算成 MSL
 */
export function buildCrossSection(
  bundle: ForecastBundle,
  model: ModelId,
  timeMs: number,
  sunAltitudeDeg: number,
  observerAglM: number,
  targetLevel: LevelKey = '600',
): CrossSection {
  const groundM = Number.isFinite(bundle.localElevationM) ? Math.max(bundle.localElevationM, 0) : 0;
  const observerMslM = groundM + Math.max(observerAglM, 0);
  const profile = parseVerticalCloudProfile(bundle, model, timeMs, observerMslM);
  const target = profile.local.heightM[targetLevel];
  const terrainM = bundle.terrain.map((t) => t.elevationM);
  const ray = rayMarchingTransmittance(target, sunAltitudeDeg, profile.rings, terrainM);

  const levels = LEVEL_KEYS.map((k) => ({
    key: k,
    label: LEVEL_BY_KEY[k].label,
    heightM: profile.local.heightM[k],
    cover: profile.local.cover[k],
    role: ROLE_OF(k),
    lit: cloudLitFactor(profile.local.heightM[k], sunAltitudeDeg, ROLE_OF(k)),
  }));

  return {
    profile,
    targetLevel,
    targetHeightM: target,
    ray,
    levels,
    stations: ray.stations.map((s) => ({
      ...s,
      bands: LEVEL_KEYS.map((k) => {
        const p = profile.rings.find((r) => r.ringKm === s.ringKm);
        return {
          key: k,
          heightM: p?.heightM[k] ?? LEVEL_BY_KEY[k].nominalM,
          cover: p?.cover[k] ?? 0,
          role: ROLE_OF(k),
          lit: cloudLitFactor(p?.heightM[k] ?? LEVEL_BY_KEY[k].nominalM, sunAltitudeDeg, ROLE_OF(k)),
        };
      }),
    })),
    sunAltitudeDeg,
    shadowHeightM: earthShadowHeightM(sunAltitudeDeg),
    observerMslM,
  };
}

export function localClock(utcMs: number, tzOffsetSeconds: number): string {
  return formatClock(utcMs, tzOffsetSeconds);
}

export function computeDailyEvents(utcDayStartMs: number, lat: number, lon: number) {
  return {
    sunriseMs: sunEvent(utcDayStartMs, lat, lon, 'sunrise'),
    sunsetMs: sunEvent(utcDayStartMs, lat, lon, 'sunset'),
  };
}

export { PRESSURE_LEVELS, LEVEL_BY_KEY, RING_KM };
