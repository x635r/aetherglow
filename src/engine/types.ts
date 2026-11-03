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
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  cloudTotal: number;
  precipitation: number; // mm/h
  humidity: number; // %
  visibilityM: number; // m
  weatherCode: number;
  windSpeed: number; // km/h
  windDir: number; // deg
  dewPointC: number;
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
  kind: 'cloud-wall' | 'terrain' | 'low-cloud-lock' | 'fog' | 'overcast' | 'none';
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

export interface SunsetPredictionOutput {
  // ── 核心量化 ────────────────────────────────
  /** 鲜艳度指数 0.00 ~ 2.50+ */
  vividness: number;
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
