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
/**
 * 等压面层定义 —— **只取三模型交集的层**。
 *
 * 逐模型实测（`cloud_cover_XXXhPa` 非空率）：
 *   GFS    20 层：1000/950/925/900/850/800/750/700/650/600/550/500/450/400/350/300/250/200/150/100
 *   ICON   15 层：1000/950/925/900/850/800/700/600/500/400/300/250/200/150/100
 *   ECMWF  **仅 12 层**：1000/925/850/700/600/500/400/300/250/200/150/100
 *
 * 天真地扩到 21 层会让 ECMWF（默认主源）大部分为空，反而更差。
 * 所以只取**三模型都有**的层，缺一层就整体不可比。
 *
 * 从 7 层扩到 10 层，新增的三层各有明确用途：
 *   · `1000hPa`（≈110m）—— **雾 / 层云**。此前完全没有，导致近地面阴雾
 *     只能靠 925hPa（780m）间接推断，漏判率高
 *   · `250hPa`（≈10.4km）/ `200hPa`（≈11.8km）—— 高空卷云顶。
 *     教程说卷云底 >6000m、厚 2–3km，云顶正好落在这一带；
 *     这是「二烧」的最后画布
 *
 * 不取 `150hPa`（≈14km）/ `100hPa`（≈16km）：已在对流层顶附近
 * （上海对流层顶 16–17km），云极少，多为模式噪声。
 */
export const PRESSURE_LEVELS = [
  { key: '1000', hpa: 1000, nominalM: 110, role: 'low', label: '1000hPa 雾/层云' },
  { key: '925', hpa: 925, nominalM: 780, role: 'low', label: '925hPa 底层云' },
  { key: '850', hpa: 850, nominalM: 1500, role: 'low', label: '850hPa 低云' },
  { key: '700', hpa: 700, nominalM: 3000, role: 'mid', label: '700hPa 中云' },
  { key: '600', hpa: 600, nominalM: 4200, role: 'golden', label: '600hPa 黄金高积云' },
  { key: '500', hpa: 500, nominalM: 5500, role: 'golden', label: '500hPa 黄金高积云' },
  { key: '400', hpa: 400, nominalM: 7200, role: 'high', label: '400hPa 卷云' },
  { key: '300', hpa: 300, nominalM: 9200, role: 'high', label: '300hPa 高空卷云' },
  { key: '250', hpa: 250, nominalM: 10400, role: 'high', label: '250hPa 卷云顶' },
  { key: '200', hpa: 200, nominalM: 11800, role: 'high', label: '200hPa 极高卷云' },
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
 *
 * 两端必须收敛到 **0**，不能留 0.02 的尾巴：
 * 上一版最低节点是 `[-12, 0.02]`，于是太阳在 −20°（深夜）时晴空仍得
 * 0.02 × 其余因子 的分数。虽然数值很小，但它让「天文夜」与「民用暮光末」
 * 无法在曲线上区分，并且给 timeline 右端制造了一个永不归零的底噪。
 * 补 `[-18, 0]` 节点 —— −18° 是天文学晨昏蒙影的正式边界。
 */
export const STAGE_KNOTS: Array<[number, number]> = [
  [-18, 0],
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
  [15, 0],
];

/** 分级阈值 (SunsetBot 行业口径) */
/**
 * 分档阈值 —— **对齐 SunsetBot 地图页公布的口径**。
 *
 * 早期版本用的是自己编的一套（0.6 就算"大烧"），与行业标准差了近一倍，
 * 会让用户拿本引擎的分数去和 SunsetBot 对比时严重误读。
 *
 * SunsetBot 原始分档（https://www.sunsetbot.top/map/ 实测）：
 *   0.001–0.05 微烧 | 0.05–0.2 小烧 | 0.2–0.4 小到中 | 0.4–0.6 中烧
 *   0.6–0.8 中到大 | 0.8–1.0 不完美大烧 | 1.0–1.5 典型大烧
 *   1.5–2.0 优质 | 2.0–2.5 世纪大烧
 *
 * 注意 SunsetBot 的「微烧」从 0.001 起，且**没有独立的"无烧"档** ——
 * 它的尺度上 0 以下不存在。我们把 <0.001 归为「无烧」以覆盖真正的零贡献场景，
 * 这是唯一的偏离，已在文档中说明。
 *
 * 另外「世纪大烧」(>1.5) 在本引擎当前数据模型下物理不可达
 * —— 实测上限约 1.09（见 VIVIDNESS_CEILING 注释）。这是诚实的局限。
 */
export const GRADES = [
  // 低端：SunsetBot 的尺度从 0.001 起就算「微烧」，但那是给"云幕通了但没烧"
  // 这类有微弱色彩的场景。对我们这种显式建模零贡献（无云 / 阴天锁死）的引擎，
  // 必须保留"无烧"档，否则「整天乌云」和「晴空无云落霞」会被报成有烧。
  { max: 0.03, key: 'none', label: '无烧', en: 'None' },
  { max: 0.10, key: 'faint', label: '微烧', en: 'Faint' },
  { max: 0.2, key: 'minor', label: '小烧', en: 'Minor' },
  { max: 0.4, key: 'moderate', label: '小到中烧', en: 'Minor–Moderate' },
  { max: 0.6, key: 'moderatePlus', label: '中烧', en: 'Moderate' },
  { max: 0.8, key: 'majorLow', label: '中到大烧', en: 'Moderate–Major' },
  { max: 1.0, key: 'major', label: '不完美大烧', en: 'Imperfect Major' },
  { max: 1.5, key: 'extreme', label: '大烧', en: 'Major' },
  { max: 2.0, key: 'premium', label: '优质大烧', en: 'Premium' },
  { max: Infinity, key: 'epic', label: '世纪大烧', en: 'Epic' },
] as const;

export type GradeKey = (typeof GRADES)[number]['key'];

/**
 * 鲜艳度标尺的显示上限（进度条分母）。
 *
 * 这是**显示**上限，取 1.6 —— 覆盖到「大烧」（1.0–1.5）整档并留出余量，
 * 让用户看到分数与满分还有距离，而不是把 1.09 画成满格。
 *
 * 与「模型可达上限」是两回事，不要混为一谈：
 *   · 显示上限 = 1.6（本常量，UI 分母）
 *   · 实测可达上限 ≈ 1.09（`scratch/ceiling-probe.ts` 网格搜索：
 *     600/500=0.40、300=0.85、AOD=0.01、VIS=30km 处取到 1.0938）
 * 「世纪大烧」(>1.5) 需要云光学厚度/云相态数据才能达到，
 * 当前数据源（Open-Meteo 只给覆盖率）到不了。
 *
 * UI 一律用这个常量做进度条分母，不要再各自写 2.5 / 2.6 —— 那会让同一个
 * 数值在同一屏上出现两种刻度（审查时发现的实际缺陷）。
 */
export const VIVIDNESS_CEILING = 1.6;

/** 各分级对应的主题色（Hero 卡片流体渐变） */
export const GRADE_THEME: Record<GradeKey, { from: string; via: string; to: string; accent: string; text: string }> = {
  none: { from: '#1b2436', via: '#232c3f', to: '#2c3446', accent: '#8ea0b8', text: '#c8d3e2' },
  faint: { from: '#2a2a3d', via: '#3c3550', to: '#584a63', accent: '#b6a7c9', text: '#eadff2' },
  minor: { from: '#3a2a3c', via: '#5c3038', to: '#7a3a34', accent: '#e08a63', text: '#ffe7d6' },
  moderate: { from: '#45251f', via: '#7a2f22', to: '#a8451f', accent: '#ff9a4d', text: '#ffe9d2' },
  moderatePlus: { from: '#4a221c', via: '#88301f', to: '#b84d1d', accent: '#ffa257', text: '#ffecd6' },
  majorLow: { from: '#4a1b18', via: '#8c2818', to: '#cc4f1a', accent: '#ffab52', text: '#ffeeda' },
  major: { from: '#4a1b16', via: '#8f2617', to: '#d4571a', accent: '#ffb24d', text: '#fff0d6' },
  extreme: { from: '#4d0f1b', via: '#a4122e', to: '#ff5a3c', accent: '#ff8f5e', text: '#ffeadf' },
  premium: { from: '#4a0d22', via: '#b81038', to: '#ff4a52', accent: '#ff9d72', text: '#ffeedd' },
  epic: { from: '#3d0a2c', via: '#8f0f42', to: '#ff2f5e', accent: '#ffa3c4', text: '#fff2f7' },
};
