import type { GradeKey, LevelKey } from './constants';

export type ModelId = 'ecmwf' | 'gfs' | 'icon';
export type SunMode = 'sunrise' | 'sunset';

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** 单小时观测包（已按期次对齐） */
export interface HourlySample {
  timeMs: number;
  /** 各等压面云量 % */
  cloud: Record<LevelKey, number>;
  /** 各等压面位势高度 m（缺测用标称值） */
  levelHeightM: Record<LevelKey, number>;
  /** 各等压面温度 °C */
  levelTempC: Partial<Record<LevelKey, number>>;
  /**
   * 各等压面相对湿度 %（用于云相态判别：冰云 vs 水云）。
   * 可选：旧版 localStorage 缓存里没有这个字段，缺失时引擎退回到温度判据。
   */
  levelHumidity?: Partial<Record<LevelKey, number>>;
  /** 边界层高度 m（霾层厚度）。可选，缺失时按 0 处理 */
  boundaryLayerM?: number;
  /** 零度层高度 m（冰/水云分界的辅助判据）。可选 */
  freezingLevelM?: number;
  /** 地面直射辐射 W/m²（实测，用于反演云对直射光的削减） */
  directRadiation?: number;
  /** 地面散射辐射 W/m²（实测，用于反照黄昏散射照明的真实性） */
  diffuseRadiation?: number;
  /**
   * 整层可降水总量 kg/m²（= mm）。
   *
   * 比地面单点湿度更能代表整条光路的水汽负荷：同样的 AOD，TCWV 高时
   * 气溶胶吸湿增长更强、米氏散射更重，黄昏会从"橙红"变成"浑白"。
   * 实测 ECMWF 19.9 / GFS 20.3 kg/m²，ICON 不提供。
   */
  totalColumnWaterVapour?: number;
  /**
   * 地面短波总辐射 W/m²（direct + diffuse 的向下总量，含散射）。
   * 与 `terrestrialRadiation` 相除即得整层短波透射率。
   */
  shortwaveRadiation?: number;
  /**
   * **大气顶**短波辐照 W/m²（只由太阳位置决定，含日地距离修正，不含云）。
   *
   * 这是免费拿到真实云光学厚度的关键：`SW / TOA` 就是整层短波透射率，
   * 反解两流近似即可得到当日实际 COT —— 补上「只有云覆盖率、
   * 没有云厚薄」这个本引擎最大的数据缺口。
   */
  terrestrialRadiation?: number;
  /**
   * 对流有效位能 J/kg。
   *
   * 高 CAPE + 强降水 = 深对流积雨云，是不透明的黑幕而非画布。
   * 用来区分「层状云画布」与「对流云黑幕」—— 单看云量无法区分。
   */
  cape?: number;
  /**
   * 高空风（700/500/300 hPa）—— 用于**半拉格朗日平流插值**。
   *
   * 云场是被风平移输运的，逐点线性插值会把"云还没到"与"云已走"
   * 平均成一片均匀云，抹平峰值时刻并漂移云洞位置。有了高空风，
   * 就能把上游的云量平移到当前时刻，恢复相位信息。
   */
  windSpeed700?: number;
  windDir700?: number;
  windSpeed500?: number;
  windDir500?: number;
  windSpeed300?: number;
  windDir300?: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  cloudTotal: number;
  precipitation: number; // mm/h
  humidity: number; // %
  visibilityM: number; // m
  /** 地面气压 hPa —— 位势高度缺测时用于反演 MSL 高度 */
  surfacePressureHpa: number;
}

/** 一个光路采样环的时序数据 */
export interface RingSeries {
  ringKm: number;
  point: GeoPoint;
  samples: HourlySample[];
}

export interface AerosolSample {
  timeMs: number;
  aod: number;
  dust: number; // µg/m³
  pm25: number;
  pm10: number;
  humidity: number;
  /**
   * 该时刻的 AOD 是否为**真实观测值**。
   *
   * 上一版把 null 直接填成 0.22 常量，而 `sampleAerosol` 只看数组长度，
   * 于是"空气质量接口只覆盖到 +6 天、之后全是 null"会被判成"有数据"，
   * 界面显示 `AOD 0.22 / 通透`，其实是编的。
   * 必须把 null 语义保留到引擎层，让 available=false + confidence 下降。
   */
  aodValid?: boolean;
}

export interface RingAerosol {
  ringKm: number;
  point: GeoPoint;
  samples: AerosolSample[];
}

/** 地形剖面采样点 */
export interface TerrainSample {
  ringKm: number;
  point: GeoPoint;
  elevationM: number;
}

/** 单一模式的完整数据集 */
export interface ModelDataset {
  model: ModelId;
  label: string;
  rings: RingSeries[];
  aerosol: RingAerosol[];
  gridLat: number;
  gridLon: number;
  gridElevationM: number;
}

export interface ForecastBundle {
  models: Record<ModelId, ModelDataset>;
  terrain: TerrainSample[];
  /** 观测点本地 DEM 海拔（m） */
  localElevationM: number;
  /** 各模型/各环的请求时间窗 */
  fetchedAt: number;
  apiCalls: number;
  cached: boolean;
  /**
   * 地形数据是否**真实可用**。
   *
   * 不能靠 `terrain.some(t => t.elevationM > 0)` 判断 —— 沿海城市（海拔
   * 恰好 0m）会被永久判为缺测，`completeness` 白扣 8 分。数据层按 API
   * 响应状态直接标记，引擎只读标记。
   */
  terrainAvailable?: boolean;
  /**
   * 位势高度是否为**真实探空/模式值**（而非由地面气压反演的标称值）。
   *
   * 同理不能用 `|h − nominal| > 1` 判断：真实探空若恰好接近标准大气高度
   * （例如 500hPa 真是 5560m），会被误判为"退回标称值"。
   */
  gphAvailable?: boolean;
}

export interface TimeSample {
  offsetMin: number;
  timeMs: number;
  altitudeDeg: number;
  azimuthDeg: number;
  /** 太阳高度角 → 霞光阶段权重 0~1 */
  stage: number;
  /** 分钟级鲜艳度指数 */
  vividness: number;
  /** 0~100 */
  score: number;
  grade: GradeKey;
}

export interface LayerReport {
  key: LevelKey;
  label: string;
  /** 该层代表性云量 %（取最优受光环） */
  cover: number;
  /** 云层海拔 m（位势高度） */
  altitudeM: number;
  /** 云幕质量 0~1 */
  quality: number;
  /** 受光透过率 0~1（含地形与上层云遮挡） */
  transmittance: number;
  /** 视线可见系数 0~1（1=可见，0.05=被地平线切断） */
  visible: number;
  /** 该层最终贡献 */
  contribution: number;
  role: 'low' | 'mid' | 'golden' | 'high';
  /** 光路是否被地形切断 */
  terrainBlocked: boolean;
}

export interface RingReport {
  ringKm: number;
  point: GeoPoint;
  cloudCoverTotal: number;
  /** 太阳光到达该环上方目标云层的透过率 */
  transmittance: number;
  /** 是否被远山遮挡 */
  terrainBlocked: boolean;
  terrainElevationM: number;
  /** 该环处太阳光线的几何高度（m，对黄金层） */
  rayHeightM: number;
  precipitation: number;
  score: number;
}

export interface VetoFlag {
  active: boolean;
  kind: 'cloud-wall' | 'terrain' | 'low-cloud-lock' | 'fog' | 'haze' | 'overcast' | 'none';
  title: string;
  detail: string;
  /** 惩罚系数 */
  penalty: number;
}

export interface SpectralReport {
  aod: number;
  pm25: number;
  dust: number;
  humidity: number;
  visibilityKm: number;
  /** 饱和度增益（1.0 为中性） */
  saturationGain: number;
  /** 米氏浑浊惩罚 0~1 */
  hazePenalty: number;
  /** 主色调标记 */
  tone: 'crystal' | 'clean' | 'normal' | 'hazy' | 'dusty' | 'unknown';
  toneLabel: string;
  /** 水晶红加成 */
  crystal: boolean;
  /** 气溶胶数据是否真实可用（false = 接口缺测，此时不做任何色彩加成/惩罚） */
  available: boolean;
  /** 臭氧总柱量 (DU) 及是否为实测值 */
  ozoneDu: number;
  ozoneMeasured: boolean;
  detail: string;
}

export interface TacticalAdvice {
  focalLength: string;
  focalReason: string;
  directionDeg: number;
  directionLabel: string;
  /** 丁达尔（霞光道）概率 0~1 */
  godRayProbability: number;
  godRayNote: string;
  exposureHint: string;
  compositionHint: string;
  isoHint: string;
}

export interface TimelineReport {
  onsetMs: number | null;
  peakMs: number;
  endMs: number | null;
  durationMin: number;
  peakVividness: number;
  peakScore: number;
  /** 二烧（紫霞）概率 0~1 */
  afterglowProbability: number;
  afterglowWindow: { fromMin: number; toMin: number };
  afterglowPeakVividness: number;
}

export interface SkyColorTheme {
  key: GradeKey;
  label: string;
  gradient: [string, string, string];
  accent: string;
  text: string;
  /** 预测主色调描述 */
  toneName: string;
}

/**
 * 双头输出：把「会不会烧」和「烧多大」拆开。
 *
 * 依据（两套独立验证都指向同一结论）：
 *  · SunsetBot 自公布混淆矩阵：不烧类 93.7% 正确，其余五档只有 5–48%
 *  · Skyglow 严格 train/test：AUC 0.797，但 Brier 0.167 vs 基础率 0.1695
 * 即：**所有系统的技能都集中在"不烧"这一侧**，把二者混进一个 0–2.5 连续值
 * 再硬切 7 档，会让"高概率小烧"和"低概率大烧"无法区分。
 *
 * 拆开后：
 *  · `burnProbability` 用 Brier + reliability + AUC + TSS 评估
 *  · `gradeIfBurn`   用 Spearman + 相邻档准确率评估
 * 两者都必须在**按日期分组**的测试集上评估（同日数据高度自相关）。
 */
export interface DualHeadEstimate {
  /** P(会烧) —— 二分类概率 0~1，本日峰值鲜艳度 > 微微烧门槛的估计概率 */
  burnProbability: number;
  /** 「若会烧，烧多大」的条件强度 0~1.6+（与 burnProbability 独立） */
  gradeIfBurn: number;
  /** 建议行动档：none / watch / go —— 供 UI 直接消费 */
  advisory: 'none' | 'watch' | 'go';
  /** 该估计的样本外可靠度 0~1（未校准时为 0，接了实测标签后由拟合给出） */
  calibration: number;
  /**
   * 集合预报给出的概率（ECMWF 50 成员）。
   *
   * 与 `burnProbability` 的区别：后者是对单个确定性预报做逻辑斯蒂映射的启发式，
   * 前者是**真的统计概率** —— 50 个扰动成员里落在"能烧"区间的比例。
   * 集合请求昂贵（91.8 配额单位/次，免费额度 600/min），可能为 null。
   */
  ensemble?: {
    probability: number;
    members: number;
    p10: number;
    p50: number;
    p90: number;
    /** 成员峰值时刻分布（相对事件时刻的分钟偏移） */
    peakOffsetP10: number;
    peakOffsetP50: number;
    peakOffsetP90: number;
  } | null;
}

export interface SunsetPredictionOutput {
  // ── 核心量化 ────────────────────────────────
  /** 鲜艳度指数 0.00 ~ 1.6+（当前数据模型可达上限约 1.15） */
  vividness: number;
  /** 双头估计（会不会烧 / 烧多大） */
  dual: DualHeadEstimate;
  /** 0~100 百分制 */
  score: number;
  grade: GradeKey;
  gradeLabel: string;
  gradeEn: string;
  /** 置信度 0~1（= 多模型一致性 × 数据完整度） */
  confidence: number;
  /** 分歧度 0~1 */
  uncertainty: number;
  /** 数据完整度 0~1（云场 / 气溶胶 / 能见度 / 地形 的加权覆盖率） */
  completeness: number;
  /** 多模型一致性 0~1（纯峰值收敛度，不含数据完整度） */
  modelAgreement: number;

  // ── 几何 ────────────────────────────────────
  eventMs: number;
  mode: SunMode;
  sunAltitudeDeg: number;
  sunAzimuthDeg: number;
  /** 机位**海拔** MSL (m) = 地面高程 + AGL */
  observerHeightM: number;
  /** 用户输入的机位离地高度 AGL (m) */
  observerAglM: number;
  /** 观测点地面 DEM 高程 (m) */
  groundElevationM: number;
  cloudBaseM: number;
  cloudTopM: number;

  // ── 分层诊断 ────────────────────────────────
  layers: LayerReport[];
  rings: RingReport[];
  spectral: SpectralReport;
  veto: VetoFlag;
  /** 无人机/高山模式触发的云海反转 */
  cloudSeaReversal: boolean;
  cloudSeaBonus: number;

  // ── 时序 ────────────────────────────────────
  timeline: TimelineReport;
  series: TimeSample[];
  /** ECMWF 主序列与各模型峰值对照 */
  modelPeaks: Array<{ model: ModelId; label: string; peakVividness: number; peakScore: number; series: number[] }>;

  tactical: TacticalAdvice;
  theme: SkyColorTheme;

  /**
   * 该本地日是否真的存在日出/日落。
   * false = 极夜/极昼，此时所有数值都是兜底结果，UI 应显示提示而非预报。
   */
  eventExists: boolean;

  /** 预测生成时间与模型主源 */
  generatedAt: number;
  primaryModel: ModelId;
  timezoneOffsetSeconds: number;
  timezone: string;
  locationLabel: string;
  point: GeoPoint;
  daily: {
    sunriseMs: number | null;
    sunsetMs: number | null;
  };
  debug: {
    stageWeight: number;
    ringScores: number[];
    layerDebug: Array<{
      key: LevelKey;
      cover: number;
      quality: number;
      transmittance: number;
      pathOpticalDepth: number;
      /** 光路在该层厚度带内的穿越长度 (km) —— 斜程诊断 */
      pathKm: number;
      /** 该层的最优受光环 (km) */
      bestRingKm: number;
    }>;
  };
}
