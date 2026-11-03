/**
 * AetherGlow · 物理常量
 * ---------------------------------------------------------------------------
 * 所有长度单位统一为 km，角度单位为度，时间单位为毫秒 (Unix epoch)。
 */

/** 地球平均半径 (IUGG) */
export const EARTH_RADIUS_KM = 6371.0088;

/**
 * 标准大气折射修正后的等效地球半径。
 *
 * 对波长为 0.55µm 的可见光，近地面标准大气折射率梯度 k ≈ 0.13~0.17，
 * 对应 R_eff = R / (1 - k) ≈ 7435 km。用等效半径替代真实半径后，
 * 光线在折射大气中仍可按直线处理 —— 这是本引擎光路几何的基础。
 */
export const R_EFF_KM = 7435;

/** 远端光路采样环半径 (km) —— 严格按规范取 6 个环 */
export const RING_KM = [0, 30, 80, 150, 280, 450] as const;

/** 等压面层定义（含标准大气标称高度，作为缺测时的回退值） */
export const PRESSURE_LEVELS = [
  { key: '925', hpa: 925, nominalM: 780, role: 'low', label: '925hPa 底层云' },
  { key: '850', hpa: 850, nominalM: 1500, role: 'low', label: '850hPa 低云' },
  { key: '700', hpa: 700, nominalM: 3000, role: 'mid', label: '700hPa 中云' },
  { key: '600', hpa: 600, nominalM: 4200, role: 'golden', label: '600hPa 黄金高积云' },
  { key: '500', hpa: 500, nominalM: 5500, role: 'golden', label: '500hPa 黄金高积云' },
  { key: '400', hpa: 400, nominalM: 7200, role: 'high', label: '400hPa 卷云' },
  { key: '300', hpa: 300, nominalM: 9200, role: 'high', label: '300hPa 高空卷云' },
] as const;

export type LevelKey = (typeof PRESSURE_LEVELS)[number]['key'];
export const LEVEL_KEYS: LevelKey[] = PRESSURE_LEVELS.map((l) => l.key);
export const LEVEL_BY_KEY: Record<LevelKey, (typeof PRESSURE_LEVELS)[number]> = Object.fromEntries(
  PRESSURE_LEVELS.map((l) => [l.key, l]),
) as Record<LevelKey, (typeof PRESSURE_LEVELS)[number]>;

/** 时间轴：日出/日落前后 → (-20min, +40min) */
export const TIMELINE_START_MIN = -20;
export const TIMELINE_END_MIN = 40;

/**
 * 太阳高度角 → 霞光阶段权重节点（必须按高度角**升序**排列）。
 * 峰值落在 −0.5° ~ −2°（地平线下、红光最纯的窗口）。
 */
export const STAGE_KNOTS: Array<[number, number]> = [
  [-12, 0.02],
  [-9, 0.13],
  [-7.5, 0.28],
  [-6, 0.5],
  [-4.5, 0.74],
  [-3, 0.9],
  [-2, 1.0],
  [-0.5, 1.0],
  [0.5, 0.9],
  [1.5, 0.55],
  [3, 0.22],
  [6, 0.08],
  [12, 0.02],
];

/** 分级阈值 (SunsetBot 行业口径) */
export const GRADES = [
  { max: 0.05, key: 'none', label: '无烧', en: 'None' },
  { max: 0.2, key: 'faint', label: '微微烧', en: 'Faint' },
  { max: 0.4, key: 'minor', label: '小烧', en: 'Minor' },
  { max: 0.6, key: 'moderate', label: '中烧', en: 'Moderate' },
  { max: 1.0, key: 'major', label: '大烧', en: 'Major' },
  { max: 1.5, key: 'extreme', label: '特大烧', en: 'Extreme' },
  { max: Infinity, key: 'epic', label: '世纪大烧', en: 'Epic' },
] as const;

export type GradeKey = (typeof GRADES)[number]['key'];

/** 各分级对应的主题色（Hero 卡片流体渐变） */
export const GRADE_THEME: Record<GradeKey, { from: string; via: string; to: string; accent: string; text: string }> = {
  none: { from: '#1b2436', via: '#232c3f', to: '#2c3446', accent: '#8ea0b8', text: '#c8d3e2' },
  faint: { from: '#2a2a3d', via: '#3c3550', to: '#584a63', accent: '#b6a7c9', text: '#eadff2' },
  minor: { from: '#3a2a3c', via: '#5c3038', to: '#7a3a34', accent: '#e08a63', text: '#ffe7d6' },
  moderate: { from: '#45251f', via: '#7a2f22', to: '#a8451f', accent: '#ff9a4d', text: '#ffe9d2' },
  major: { from: '#4a1b16', via: '#8f2617', to: '#d4571a', accent: '#ffb24d', text: '#fff0d6' },
  extreme: { from: '#4d0f1b', via: '#a4122e', to: '#ff5a3c', accent: '#ff8f5e', text: '#ffeadf' },
  epic: { from: '#3d0a2c', via: '#8f0f42', to: '#ff2f5e', accent: '#ffa3c4', text: '#fff2f7' },
};
