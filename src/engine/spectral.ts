/**
 * Step 4 — CAMS 气溶胶光谱消光与「雨后水晶天」修正
 * ---------------------------------------------------------------------------
 * 物理背景
 * ─────────
 * 散射相函数对不同波段并非等价：
 *
 *  · 瑞利散射  τ_R ∝ λ⁻⁴  —— 洁净大气中蓝光优先被散射，日落光路中
 *    短波被抽干，剩余直射光呈饱和橙红（这是火烧云的底色）。
 *  · 米氏散射  τ_M ≈ 与 λ 弱相关（大颗粒气溶胶、雾滴、沙尘）——
 *    等量地削弱所有波段，并把直射光混入灰白漫射光，造成「浑浊洗白」。
 *
 * 因此 AOD（550nm 整层气溶胶光学厚度）与 PM2.5 / 相对湿度是决定
 * 「色彩饱和度」的核心变量，而非云量。
 *
 * 输出：
 *  · saturationGain  —— 饱和度倍率，1.0 为中性；水晶天 > 1.2，重霾 < 0.5
 *  · hazePenalty     —— 米氏浑浊惩罚 0~1（1 为无惩罚）
 *  · tone            —— 主色调类别，驱动 UI 与调色建议
 */

import type { SpectralReport } from './types';

import { clamp } from './astro';

/**
 * Angström 指数：沙尘（粗颗粒）≈0.6，城市气溶胶 ≈1.3
 *
 * 规范值域是 0.5–1.5。上一版恒返回 ≤1.45，导致「细颗粒城市气溶胶」
 * 一类永远取不到 1.6 —— 这会把霾的波长选择性低估，进而高估红化。
 */
export function angstromFromAod(dust: number, pm25: number): number {
  // 以 dust/PM2.5 比例推断粗模态占比（沙尘多 → α 小 → 光谱选择性更弱）
  const coarseRatio = dust > 0 ? clamp(dust / Math.max(pm25, 1), 0, 4) / 4 : 0;
  return clamp(1.5 - coarseRatio * 0.95, 0.55, 1.5);
}

/**
 * 单色透过率：Beer-Lambert，含 Angström 波长依赖。
 * @param aod 550nm 气溶胶光学厚度
 * @param wavelengthNm 目标波长
 */
export function monochromaticTransmittance(aod: number, wavelengthNm: number, angstrom: number): number {
  const tau = aod * Math.pow(550 / wavelengthNm, angstrom);
  return Math.exp(-tau);
}

/**
 * 光谱消光评估。
 *
 * @param aod     CAMS 550nm AOD
 * @param pm25    µg/m³
 * @param dust    µg/m³（沙尘柱含量）
 * @param humidity 地面相对湿度 %
 * @param visibilityKm 地面能见度 km（可用 AOD 反演兜底）
 * @param aerosolAvailable 气溶胶数据是否真实可用。
 *        默认 **true**（直接传数值 = 调用方声明"我有数据"）；
 *        引擎内部经 `calculateSpectralExtinction` 显式传入 `sampleAerosol`
 *        的探测结果，接口缺测时为 false —— 绝不容忍"越缺数据越乐观"。
 */
export function evaluateSpectral(
  aod: number,
  pm25: number,
  dust: number,
  humidity: number,
  visibilityKm: number,
  aerosolAvailable = true,
  /**
   * 整层可降水总量 kg/m²（可选）。
   *
   * 与地面点湿度的区别：TCWV 是**整条光路**的水汽负荷。同样的 AOD 下，
   * TCWV 30 kg/m² 时的吸湿增长远强于 8 kg/m² —— 前者黄昏浑白、后者橙红。
   * 实测 ECMWF 常见 10–40 kg/m²。缺失时退回纯 RH 判据（行为不变）。
   */
  totalColumnWaterVapour?: number,
  /** 臭氧总柱量 (DU)；缺省用标准 300 DU */
  ozoneColumnDu = 300,
  /** 该臭氧值是否为实测 */
  ozoneMeasured = false,
): SpectralReport {
  // AOD = 0 是**合法测量值**（极地/高空洁净大气），不是缺测。
  // 缺测只能由 `aerosolAvailable=false` 表达，不能用数值大小推断。
  const hasAerosol = aerosolAvailable && Number.isFinite(aod) && aod >= 0;

  const A = clamp(Number.isFinite(aod) ? aod : 0.22, 0, 3.0);
  const PM = clamp(Number.isFinite(pm25) ? pm25 : 20, 0, 900);
  const DU = clamp(Number.isFinite(dust) ? dust : 10, 0, 3000);
  const RH = clamp(Number.isFinite(humidity) ? humidity : 55, 1, 100);
  const VIS = clamp(Number.isFinite(visibilityKm) && visibilityKm > 0 ? visibilityKm : 22, 0.05, 80);

  // 吸湿增长：高湿下气溶胶粒径膨胀，米氏消光效率非线性上升
  const hygroscopic = 1 + Math.pow(clamp((RH - 55) / 45, 0, 1), 2) * 1.15;

  // TCWV 修正：整层水汽负荷越高，吸湿增长越强。
  // 以 20 kg/m² 为基准（典型中纬度值），±10 对应约 ±18% 的增长系数。
  const tcwvFactor =
    totalColumnWaterVapour != null && totalColumnWaterVapour > 0
      ? clamp(1 + (totalColumnWaterVapour - 20) / 55, 0.8, 1.5)
      : 1;
  const aodEffective = A * hygroscopic * tcwvFactor;

  // 粗模态（沙尘）比例
  const coarse = clamp(DU / Math.max(PM + DU, 1), 0, 0.9);

  // ── 米氏浑浊惩罚 ───────────────────────────────────────────────
  // 以 AOD_eff 与 PM2.5 双通道取较差者，湿+脏叠加时惩罚更重
  const aodHaze = clamp((aodEffective - 0.25) / 0.65, 0, 1); // 0.25→0 , 0.9→1
  const pmHaze = clamp((PM - 45) / 130, 0, 1); // 45→0 , 175→1
  let hazePenalty = 1 - 0.62 * Math.max(aodHaze, pmHaze * 0.85);

  // 沙尘：暖色偏移但对比度下降
  if (coarse > 0.35) hazePenalty *= 1 - 0.25 * ((coarse - 0.35) / 0.55);
  // 能见度兜底（地面观测更直接）
  const visFactor = clamp((VIS - 2) / 18, 0, 1); // 2km→0 , 20km→1
  hazePenalty *= 0.55 + 0.45 * visFactor;
  hazePenalty = clamp(hazePenalty, 0.06, 1);

  // ── AOD 浑浊上限：连续 logistic（取代 0.8 硬门槛）──
  //
  // SunsetBot 教程表 2.3 的分档是行业事实标准：
  //   0–0.1   低于瑞利光学厚度 → 水晶天
  //   0.1–0.2 极少气溶胶 → 通透
  //   0.2–0.3 较少 → 较蓝
  //   0.3–0.5 平均 → 普通通透度
  //   0.5–0.8 气溶胶偏多 → **明显削弱火烧云**
  //   >0.8    重度霾/沙尘 → **「污烧」：灰白，再大的云也救不回来**
  //
  // 这些分档**保留为天气类型标签**（见下方 tone 判定），但物理分数不能
  // 在无限小输入变化下跳变：旧的 `A > 0.8` 硬分支让 AOD 从 0.800000 增到
  // 0.800001 时 hazePenalty 从 0.4754 断崖到 0.3400（−28.5%，探针实测）。
  // 任何实测都不会有这种跳变 —— 它是实现产物，不是大气物理。
  //
  // 改为连续 logistic 上限：洁净端趋近 1，AOD≈0.9 时已压到约 0.30，
  // 高污染端渐近到 0.12；不再让分类边界控制数值分支。
  if (hasAerosol) {
    // 上限只负责表达重霾的渐近压制：0.82 附近进入污烧区，洁净端趋近 1。
    // 天气类型仍可沿用 0.8 的离散标签，但数值不得随标签跨档而跳变。
    const hazeCap = 0.12 + 0.88 / (1 + Math.exp((A - 0.82) / 0.06));
    hazePenalty = Math.min(hazePenalty, hazeCap);
  }

  // 气溶胶缺测时：按**气候学中值**给一个轻微的保守惩罚，而不是完全中性。
  //
  // 为什么不能全中性：摄影师拿到的若是"缺测的中性分"，会与"空气尚可"混淆。
  // 缺测的正确语义是「我不知道，但历史上这个季节多半有点霾」——
  // 因此用典型城市 AOD≈0.25 对应的轻度浑浊，比洁净略差、比重霾好得多，
  // 同时置信度会因 completeness 下降而单独告警。
  if (!hasAerosol) {
    const climatologicalHaze = 0.86;
    hazePenalty = Math.min(hazePenalty, climatologicalHaze);
  }

  // ── 洁净加成（水晶天）───────────────────────────────────────────
  // **必须先确认气溶胶数据真实存在**，否则「缺数据」会被当成「最洁净」。
  const crystalEligible = hasAerosol && A < 0.18 && VIS > 20 && DU < 40 && PM < 25;
  const cleanEligible = hasAerosol && !crystalEligible && A < 0.28 && VIS > 15;

  const smooth01 = (x: number): number => {
    const t = clamp(x, 0, 1);
    return t * t * (3 - 2 * t);
  };

  let saturationGain: number;
  if (!hasAerosol) {
    // 气溶胶数据缺失：给中性值，不加成也不惩罚，绝不容忍"越缺数据越乐观"
    saturationGain = 1.0;
  } else {
    // 连续基底 + 连续洁净增益。旧实现把 crystal / clean / normal 三档直接
    // 映射到不同公式，导致 AOD=0.18、0.28 以及 RH=80 处出现人为台阶。
    // 标签分档仍保留给 UI，所有进入评分的数值都在这里平滑过渡。
    saturationGain = clamp(1.02 - Math.max(0, A - 0.28) * 0.85, 0.42, 1.06);
    const cleanBoost =
      0.25 *
      (1 - smooth01((A - 0.12) / 0.22)) *
      smooth01((VIS - 12) / 12) *
      (1 - smooth01((PM - 20) / 40)) *
      (1 - smooth01((DU - 30) / 60));
    saturationGain += cleanBoost;

    // 高湿只增强已有的霾/PM 惩罚；用 smoothstep 渐入，不在 RH=80 突然启用。
    const humidActivation = smooth01((RH - 70) / 20);
    saturationGain *= Math.exp(
      -0.55 * clamp((A - 0.5) / 0.5, 0, 1.2) * humidActivation,
    );
    saturationGain *= Math.exp(
      -0.35 * clamp((PM - 75) / 120, 0, 1.5) * humidActivation,
    );
  }
  saturationGain = clamp(saturationGain, 0.32, 1.34);

  // ── 主色调分类 ─────────────────────────────────────────────────
  let tone: SpectralReport['tone'];
  let toneLabel: string;
  let detail: string;

  if (!hasAerosol) {
    tone = 'unknown';
    toneLabel = '气溶胶缺测';
    detail = `未取到 CAMS 气溶胶数据，饱和度按中性处理（不加成、不惩罚）。能见度 ${VIS.toFixed(
      0,
    )}km 仅作参考。`;
  } else if (crystalEligible) {
    tone = 'crystal';
    toneLabel = '水晶天';
    detail = `AOD ${A.toFixed(2)} / 能见度 ${VIS.toFixed(0)}km 极通透，短波净空、红橙纯度最高，饱和度 ×${saturationGain.toFixed(2)}。`;
  } else if (coarse > 0.5) {
    tone = 'dusty';
    toneLabel = '沙尘浑浊';
    detail = `沙尘柱含量 ${DU.toFixed(0)}µg/m³ 偏高，暖调偏移但对比度下降，建议降低曝光补偿。`;
  } else if (A > 0.8) {
    tone = 'hazy';
    toneLabel = '污烧';
    detail = `AOD ${A.toFixed(
      2,
    )} 已超过 0.8 的污烧参考线：米氏散射把直射光整体洗灰，再好的云幕也只能烧出灰白色，不是绯红。`;
  } else if (hazePenalty < 0.62) {
    tone = 'hazy';
    toneLabel = '雾霾浑浊';
    detail = `AOD ${A.toFixed(2)}（等效 ${aodEffective.toFixed(2)}）/ PM2.5 ${PM.toFixed(0)} / 湿度 ${RH.toFixed(0)}%，米氏散射洗白严重，鲜艳度受压制。`;
  } else if (cleanEligible) {
    tone = 'clean';
    toneLabel = '通透';
    detail = `AOD ${A.toFixed(2)}，气溶胶负荷低，散射以瑞利为主，色调干净。`;
  } else {
    tone = 'normal';
    toneLabel = '常规';
    detail = `AOD ${A.toFixed(2)} / 能见度 ${VIS.toFixed(0)}km，散射条件中性，色彩表现取决于云幕结构。`;
  }

  return {
    aod: A,
    pm25: PM,
    dust: DU,
    humidity: RH,
    visibilityKm: VIS,
    saturationGain,
    hazePenalty,
    tone,
    toneLabel,
    crystal: crystalEligible,
    available: hasAerosol,
    ozoneDu: ozoneColumnDu,
    ozoneMeasured,
    detail,
  };
}

/**
 * 由 AOD 与湿度反演能见度（Koschmieder + 吸湿增长），用于 API 缺测兜底。
 */
export function visibilityFromAod(aod: number, humidity: number): number {
  const RH = clamp(humidity, 1, 100);
  const hygroscopic = 1 + Math.pow(clamp((RH - 55) / 45, 0, 1), 2) * 1.15;
  // AOD → 地面消光系数近似（气溶胶标高 ~1.5km）
  const sigmaExt = (aod * hygroscopic) / 1.5; // km⁻¹
  const visKm = 3.912 / Math.max(sigmaExt, 0.02);
  return clamp(visKm, 0.3, 60);
}
