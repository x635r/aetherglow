/**
 * 天文几何：太阳位置、日出日落、大圆航线。
 *
 * 采用 NOAA / Meeus 低精度太阳位置算法（典型误差 < 0.01°，
 * 对晚霞判定所需的 0.1° 量级完全足够），配合迭代求根获得
 * 太阳上边缘几何高度角 = 0（含 34′ 折射 + 16′ 视半径 = -0.833°）的时刻。
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const toRad = (d: number): number => d * DEG;
export const toDeg = (r: number): number => r * RAD;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 归一化到 [0,1) */
export const frac = (x: number): number => x - Math.floor(x);

/** 日期 → 儒略日 (JD, UT) */
export function julianDay(ms: number): number {
  return ms / 86400000 + 2440587.5;
}

/** 儒略世纪数 T（自 J2000.0 起） */
export function julianCentury(ms: number): number {
  return (julianDay(ms) - 2451545) / 36525;
}

export interface SunPosition {
  /** 太阳高度角（度），地平线以上为正 */
  altitude: number;
  /** 太阳方位角（度，正北=0，顺时针） */
  azimuth: number;
  /** 赤纬（度） */
  declination: number;
  /** 时角（度） */
  hourAngle: number;
}

/**
 * 给定 UTC 毫秒与观测点，计算太阳视位置。
 * 包含：平黄经 → 真黄经（中心差） → 黄赤交角 → 赤道坐标 → 时角 → 地平坐标。
 */
export function sunPosition(utcMs: number, lat: number, lon: number): SunPosition {
  const J = julianDay(utcMs);
  const T = (J - 2451545) / 36525;

  // 几何平黄经与平近点角（必须以 360 取模，否则 T 较大时丢精度）
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);

  const Mr = toRad(M);
  const C =
    Math.sin(Mr) * (1.914602 - 0.004817 * T - 0.000014 * T * T) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;

  const trueLon = L0 + C; // 真黄经
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLon - 0.00569 - 0.00478 * Math.sin(toRad(omega)); // 视黄经（章动 + 光行差）

  // 黄赤交角（Meeus 22.2 简化式）
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(toRad(omega));

  // 赤道坐标
  const lamR = toRad(lambda);
  const epsR = toRad(eps);
  const decl = Math.asin(clamp(Math.sin(epsR) * Math.sin(lamR), -1, 1));
  const raDeg = toDeg(Math.atan2(Math.cos(epsR) * Math.sin(lamR), Math.cos(lamR)));

  // 格林尼治平恒星时（Meeus 12.4，单位：度）
  const gmst = norm360(
    280.46061837 + 360.98564736629 * (J - 2451545) + 0.000387933 * T * T - (T * T * T) / 38710000,
  );
  const lst = norm360(gmst + lon); // 东经为正
  const hourAngle = (((lst - raDeg + 540) % 360) + 360) % 360 - 180;

  const latR = toRad(lat);
  const haR = toRad(hourAngle);

  const sinAlt = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(haR);
  const altitude = toDeg(Math.asin(clamp(sinAlt, -1, 1)));

  // 方位角：正北 0°，顺时针
  const az = toDeg(
    Math.atan2(-Math.sin(haR), Math.tan(decl) * Math.cos(latR) - Math.sin(latR) * Math.cos(haR)),
  );

  return {
    altitude,
    azimuth: norm360(az),
    declination: toDeg(decl),
    hourAngle,
  };
}

/** 归一化到 [0, 360) */
export function norm360(x: number): number {
  return ((x % 360) + 360) % 360;
}

/** 太阳视半径 16′ + 平均折射 34′ → 日出日落判定高度角 */
const SUNRISE_ALTITUDE = -0.833;

/**
 * 计算某日（本地日期锚定的 UTC 日）的日出/日落时刻。
 *
 * 做法：在给定日的 00:00 UTC 起，以 10 分钟粗扫找到高度角穿越
 * SUNRISE_ALTITUDE 的日子内部区间，再用二分法收敛到 ±2 秒。
 *
 * @param dayStartMs 当日 00:00（UTC）时间戳，允许带任意日偏移
 * @param mode sunrise | sunset
 * @returns UTC 毫秒；极昼/极夜返回 null
 */
export function sunEvent(
  dayStartMs: number,
  lat: number,
  lon: number,
  mode: 'sunrise' | 'sunset',
): number | null {
  const step = 10 * 60 * 1000;
  const f = (t: number) => sunPosition(t, lat, lon).altitude - SUNRISE_ALTITUDE;

  let prevT = dayStartMs;
  let prevV = f(prevT);

  for (let t = dayStartMs + step; t <= dayStartMs + 36 * 3600 * 1000; t += step) {
    const v = f(t);
    const rising = prevV < 0 && v >= 0;
    const setting = prevV > 0 && v <= 0;
    const hit = mode === 'sunrise' ? rising : setting;
    if (hit) {
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 32; i++) {
        const mid = (lo + hi) / 2;
        const risingNow = f(mid) >= 0;
        if (mode === 'sunrise') {
          if (risingNow) hi = mid;
          else lo = mid;
        } else {
          if (risingNow) lo = mid;
          else hi = mid;
        }
      }
      return (lo + hi) / 2;
    }
    prevT = t;
    prevV = v;
  }
  return null;
}

/**
 * 球面大圆：从 (lat1, lon1) 沿给定初始方位角 az 前进 distKm。
 * 返回目标点经纬度。使用标准大圆（Vincenty 正解近似，球面解）。
 */
export function destinationPoint(
  lat1: number,
  lon1: number,
  bearingDeg: number,
  distKm: number,
): { lat: number; lon: number } {
  const d = distKm / 6371.0088; // 角距
  const brg = toRad(bearingDeg);
  const lat1R = toRad(lat1);
  const lon1R = toRad(lon1);

  const lat2 = Math.asin(
    clamp(Math.sin(lat1R) * Math.cos(d) + Math.cos(lat1R) * Math.sin(d) * Math.cos(brg), -1, 1),
  );
  const lon2 =
    lon1R +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1R),
      Math.cos(d) - Math.sin(lat1R) * Math.sin(lat2),
    );

  return { lat: toDeg(lat2), lon: ((((toDeg(lon2) + 540) % 360) - 180)) };
}

/** 两点球面距离 (km) */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = p2 - p1;
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(clamp(Math.sqrt(a), -1, 1));
}

/** 线性插值采样（分段折线），用于把小时序列升采样到分钟 */
export function samplePiecewise(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0;
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
  return lerp(ys[lo], ys[hi], (x - xs[lo]) / span);
}

/** 平滑分段插值（Catmull-Rom 风格），用于太阳高度角→霞光权重 */
export function smoothKnots(knots: Array<[number, number]>, x: number): number {
  if (x <= knots[0][0]) return knots[0][1];
  if (x >= knots[knots.length - 1][0]) return knots[knots.length - 1][1];
  let i = 0;
  while (i < knots.length - 2 && x > knots[i + 1][0]) i++;
  const [x0, y0] = knots[i];
  const [x1, y1] = knots[i + 1];
  const t = (x - x0) / (x1 - x0);
  // smootherstep 权重，保持节点一阶连续
  const s = t * t * t * (t * (t * 6 - 15) + 10);
  return lerp(y0, y1, s);
}

/** 秒 → mm:ss */
export function formatClock(utcMs: number, tzOffsetSeconds = 0, withSeconds = false): string {
  const d = new Date(utcMs + tzOffsetSeconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return withSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

// ── 风场启发的时间平移修正（2026-11）────────────────────────────────────
//
// 命名说明：这套近似曾被称为「半拉格朗日平流插值」，名不副实 ——
// 真正的半拉格朗日格式要在空间网格上回溯轨迹；这里只有时间序列，
// 实际做的是「沿风向把采样时刻平移一段」的一阶启发式修正。

/**
 * 用**上游平移采样**替代逐点线性插值 —— 只有当风场确实会平移云场时才有效。
 *
 * **要解决的问题**：`interpolateHourly` 对每个变量独立做线性插值。对温度、
 * 气压这类缓慢变化的量没问题，但**云量是被风平移平流输运的**：
 * 高空 300hPa 急流 100 km/h 时，一小时里 80km 外的云会移到头顶。
 * 逐点线性插值会把"云还没到"和"云已经走了"混成一个平均值 ——
 * 结果是峰值时刻被抹平、云洞位置漂移、有时候干脆判成"整层均匀云"。
 *
 * **做法**（上游时间平移近似 / upstream time-shift，一阶启发式）：
 *   要问 t 时刻**本地点**的云量，先算这团空气从前沿风追溯一小时前的位置：
 *
 *      x_back = x − v · Δt
 *
 *   然后取 `x_back` 处的云量。因为数据只有**本地**序列与**环向**序列
 *   （沿太阳方位 0/30/80/150/280/450km），所以"上游位置"只能在本序列
 *   内部用时间平移近似：
 *
 *      y(t) ≈ y_series(t − advectLag)
 *      advectLag = min(Δt/2, distKm / v)
 *
 *   `distKm / v` 是"一个云块从采样环移过来需要多久"。对**环向序列**
 *   这个平移是真实的（同一云系在移到本地前先经过近环）；对 0km 序列
 *   只能取半格补偿（因为前后两个时刻的风不同）。
 *
 * **为什么限制在 Δt/2**：整格平移会让 t 时刻直接取到 t−1h 的值，
 * 造成相反方向的偏置（"永远晚一小时"）。取半格是折中：既保留平流
 * 造成的相位移动，又不至于把整条曲线平移。
 *
 * **诚实标注**：这是一阶近似，不做真正的二维/三维轨迹追踪。
 * 它的价值在于**恢复相位信息**（峰值时刻、云洞过境时刻），
 * 而不是提升数值精度。风向垂直视线时收益最大，平行时接近零。
 *
 * @param t           目标采样时刻 (ms)
 * @param timesHours  样本时刻数组（等间隔，ms）
 * @param values      对应的值
 * @param advectLagMs 由风场算出的平流滞后 (ms)
 * @param fallback    序列为空时的兜底值
 */
export function sampleAdvected(
  t: number,
  timesMs: number[],
  values: number[],
  advectLagMs: number,
  fallback = 0,
): number {
  if (!timesMs.length || !values.length) return fallback;
  // 平流滞后为 0（无风 / 风向平行视线）时退化为普通线性插值 ——
  // 保证「没有风场数据时行为完全不变」。
  if (!Number.isFinite(advectLagMs) || Math.abs(advectLagMs) < 1000) {
    return samplePiecewise(timesMs, values, t);
  }
  const x = t - advectLagMs;
  // 平移后越界：退回边界值而不是外推（外推会放大噪声）
  if (x <= timesMs[0]) return values[0];
  if (x >= timesMs[timesMs.length - 1]) return values[values.length - 1];
  return samplePiecewise(timesMs, values, x);
}

/**
 * 由风场计算「云从采样环移到本地需要的滞后」(ms)。
 *
 * 只取**沿视线方向**的投影：垂直视线方向的平流会把云推走而不是推来，
 * 那不是我们想补偿的相位差。
 *
 * **方向约定（曾经的 P0 缺陷，别写反）**：
 *  · `sightDeg` 是**观测者 → 太阳/远端采样环**的方位角
 *  · `windFromDeg` 是气象风向（**来向**）
 *  · 当 `windFromDeg === sightDeg` 时，风正从远端环那个方向吹来、
 *    吹向观测者 —— 这才是「云朝本地来」，需要回看上游。
 *
 * 上一版先算 `motionDeg = windFromDeg + 180`（运动方向）再与 sightDeg 求余弦，
 * 等价于把判据翻成「风从观测者吹向太阳」，方向整整反了 180°。
 * 后果（实测）：真实「云朝本地来」返回 0（不修正），而「云正在离开」
 * 反而被平移 30 分钟 —— 峰值时刻系统性错位。
 *
 * @param windFromDeg 风向（**气象约定**：风的来向，°）
 * @param windSpeedKmh 风速 km/h
 * @param sightDeg    视线方位（太阳方位，°）
 * @param ringKm      采样环距离；0 表示本地序列
 * @returns 滞后 ms（正值表示需回看）；无法计算时为 0
 */
export function advectionLagMs(
  windFromDeg: number,
  windSpeedKmh: number,
  sightDeg: number,
  ringKm: number,
): number {
  if (!Number.isFinite(windFromDeg) || !Number.isFinite(windSpeedKmh)) return 0;
  // 5 km/h 以下的风产生不了可分辨的格内位移
  if (windSpeedKmh <= 5) return 0;
  // 本地环没有「相对环距」，谈不上把远端的云移到本地。
  // 上一版在这里硬编码 0.5h，造成 0km→30min、10km→6min、30km→18min 的
  // 非单调 V 型畸变（本地比近场还晚半小时）。
  if (ringKm <= 1) return 0;

  // 风的来向与视线方向一致 ⇒ 风把远端云吹向观测者
  const toward = Math.cos(toRad(windFromDeg - sightDeg));
  if (toward <= 0.05) return 0;

  const vAlong = Math.max(windSpeedKmh * toward, 1);
  // 位移尺度取**次网格特征尺度**：0.25° 格点约 25km，取半格 12.5km
  // 作为「格内相位微调」上限。直接用整环距（450km/100kmh = 4.5h）会把
  // 数值模式已经平流过的量再延迟一遍，且远超数据本身的分辨率。
  const subGridKm = Math.min(ringKm, 12.5);
  const travelHours = subGridKm / vAlong;
  return clamp(travelHours, 0, 0.25) * 3600 * 1000;
}
