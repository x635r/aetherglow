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
