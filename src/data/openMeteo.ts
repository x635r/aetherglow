/**
 * Open-Meteo 数据接入层
 * ---------------------------------------------------------------------------
 *  · 单次请求合并 6 个光路采样点 × 多模型（Open-Meteo 支持逗号批量坐标）
 *  · 三期数据源：forecast / air-quality / elevation
 *  · localStorage TTL 缓存 + 内存级 in-flight 去重 + 429 指数退避
 *
 * 注意：ECMWF (ecmwf_ifs025) 不提供 visibility，此时 engine 会由 AOD 反演兜底。
 */

import { clamp, sunEvent, sunPosition } from '../engine/astro';
import { LEVEL_KEYS, PRESSURE_LEVELS, RING_KM } from '../engine/constants';
import type { LevelKey } from '../engine/constants';
import { destinationPoint } from '../engine/astro';
import type {
  AerosolSample,
  ForecastBundle,
  GeoPoint,
  HourlySample,
  ModelDataset,
  ModelId,
  RingAerosol,
  RingSeries,
  TerrainSample,
} from '../engine/types';
import { generateLightPathGrid } from '../engine/SunsetPhysicsEngine';

export const MODEL_META: Record<ModelId, { api: string; label: string; short: string; color: string }> = {
  ecmwf: { api: 'ecmwf_ifs025', label: 'ECMWF IFS 0.25°', short: 'ECMWF', color: '#38e8d0' },
  gfs: { api: 'gfs_seamless', label: 'NOAA GFS Seamless', short: 'GFS', color: '#ffb340' },
  icon: { api: 'icon_seamless', label: 'DWD ICON Seamless', short: 'ICON', color: '#a855f7' },
};

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const AIR_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const ELEV_BASE = 'https://api.open-meteo.com/v1/elevation';

/**
 * 请求变量清单。
 *
 * 每一项都经过实测确认「真的返回数据」——Open-Meteo 会接受很多参数名但恒返回 null
 * （例如 `cloud_base` / `cloud_top` / `cloud_optical_depth` 全部是空壳，
 *  虽然 200 通过但 48/48 全是 null）。下面这些是逐个验证过非空率的。
 *
 * 关键增益（2026-11 补充）：
 *  · `relative_humidity_XXXhPa` —— **气压层湿度**，用于云相态判别。
 *    实测 925hPa 97%、700hPa 83%、300hPa 80%，是真实数据。
 *    「冰云是画布、水云是灰幕」这条领域共识终于有了数据支撑。
 *  · `direct_radiation` / `diffuse_radiation` —— 地面辐射分量，
 *    用来替代此前纯经验公式的 `diffuseWeight`。
 *  · `freezing_level_height` / `boundary_layer_height` —— 零度层与边界层高度。
 *  · `temperature_XXXhPa` —— 原本就请求了但被 `interpolateHourly` 丢弃，现已接回。
 */
const HOURLY_VARS = [
  ...PRESSURE_LEVELS.map((l) => `cloud_cover_${l.hpa}hPa`),
  ...PRESSURE_LEVELS.map((l) => `geopotential_height_${l.hpa}hPa`),
  ...PRESSURE_LEVELS.map((l) => `temperature_${l.hpa}hPa`),
  ...PRESSURE_LEVELS.map((l) => `relative_humidity_${l.hpa}hPa`),
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'cloud_cover',
  'precipitation',
  'relative_humidity_2m',
  'visibility',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'dew_point_2m',
  'surface_pressure',
  // ── 2026-11 新增（均已实测非空）──
  'boundary_layer_height',
  'freezing_level_height',
  'direct_radiation',
  'diffuse_radiation',
  'shortwave_radiation',
  'sunshine_duration',
  'temperature_2m',
];

const AIR_VARS = ['aerosol_optical_depth', 'dust', 'pm2_5', 'pm10', 'relative_humidity_2m'];

// ═══════════════════════════════════════════════════════════════════════════
// 通用 fetch：429 / 5xx 退避 + 去重
// ═══════════════════════════════════════════════════════════════════════════

const inflight = new Map<string, Promise<unknown>>();

class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Rate limited, retry after ${retryAfterMs}ms`);
    this.retryAfterMs = retryAfterMs;
  }
}

async function fetchJson<T>(url: string, attempt = 0, signal?: AbortSignal): Promise<T> {
  // 同一 URL 的内存去重：被取消的调用不能复用别人那条请求，
  // 否则取消者会连带把正常请求也 abort 掉。
  const existing = signal ? undefined : inflight.get(url);
  if (existing) return existing as Promise<T>;

  const task = (async (): Promise<T> => {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after')) * 1000;
      throw new RateLimitError(Number.isFinite(ra) && ra > 0 ? ra : 2500 * Math.pow(2, attempt));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 180)}`);
    }
    return (await res.json()) as T;
  })();

  inflight.set(url, task);
  try {
    return await task;
  } catch (err) {
    if (attempt < 3 && (err instanceof RateLimitError || /HTTP 5\d\d/.test(String(err)))) {
      const wait = err instanceof RateLimitError ? err.retryAfterMs : 800 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
      inflight.delete(url);
      return fetchJson<T>(url, attempt + 1, signal);
    }
    throw err;
  } finally {
    inflight.delete(url);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 缓存
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_PREFIX = 'aetherglow:v3:';
const CACHE_TTL_LIVE_MS = 18 * 60 * 1000; // 实时预报
const CACHE_TTL_PAST_MS = 6 * 3600 * 1000;

interface CacheEntry<T> {
  t: number;
  v: T;
}

function cacheGet<T>(key: string, ttl: number): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (Date.now() - parsed.t > ttl) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return parsed.v;
  } catch {
    return null;
  }
}

function cacheSet<T>(key: string, value: T): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    // 配额溢出：清理旧条目
    try {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
      keys.slice(0, Math.ceil(keys.length / 2)).forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch {
      /* 无缓存也能跑 */
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 时间工具
// ═══════════════════════════════════════════════════════════════════════════

/** 把 `2026-10-31T08:00` 视为指定偏移下的本地时间 → UTC ms */
function localIsoToUtcMs(iso: string, offsetSeconds: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return Number.NaN;
  const [, y, mo, d, hh, mm] = m;
  return Date.UTC(+y, +mo - 1, +d, +hh, +mm) - offsetSeconds * 1000;
}

/** 由日期串与经度估算时区偏移（仅用于选择 API 的 start_date） */
export function estimateOffsetSeconds(lon: number): number {
  return Math.round(lon / 15) * 3600;
}

export interface ResolvedEvent {
  eventMs: number;
  azimuthDeg: number;
  mode: 'sunrise' | 'sunset';
  /** 参考时间的 UTC 起点（本地日期 00:00） */
  localDayStartUtcMs: number;
  /**
   * 该本地日是否真的存在这个事件。
   * false = 极夜 / 极昼，eventMs 只是兜底值（太阳可能深在地平线下 20°+），
   * UI 必须明确告知「本日无日落」，而不是给出一个"无烧"的假预报。
   */
  exists: boolean;
}

/**
 * 在本地日期 dateISO 上解析日出/日落时刻（纯天文，不需网络）。
 *
 * **上一版的严重 bug**：扫描起点取 `localMidnightUtc − 12h`，然后返回遇到的
 * 第一个日落 —— 那是**前一天的日落**。日落查询因此整体偏移约 −24 小时，
 * 而日出恰好正确（因为"前一天正午"之后的第一个日出就是当天的日出）。
 * 更糟的是它和 API 的时间窗错位：请求 11-01 的数据，事件却在 10-31，
 * `samplePiecewise` 对越界值返回序列首元素，于是所有气象量都被钳到
 * 「当天凌晨 0 点」—— 晚霞预报实际是"前一天的日落 + 当天凌晨的云"。
 *
 * 正确做法：从**本地午夜零点**开始向前扫，取第一个落在本地日期内的事件。
 *
 * @param point   观测点
 * @param dateISO 本地日期 YYYY-MM-DD
 * @param mode    sunrise | sunset
 */
export function resolveEvent(point: GeoPoint, dateISO: string, mode: 'sunrise' | 'sunset'): ResolvedEvent {
  const offset = estimateOffsetSeconds(point.lon);
  const [y, mo, d] = dateISO.split('-').map(Number);
  const localMidnightUtc = Date.UTC(y, mo - 1, d, 0, 0) - offset * 1000;

  // 从本地零点稍早处开始（-2h 覆盖时区估算误差），扫到 +36h，
  // 然后**按本地日期筛选**，保证拿到的是当天的那个事件。
  const searchFrom = localMidnightUtc - 2 * 3600 * 1000;
  const candidates = sunEventsInWindow(searchFrom, 38, point.lat, point.lon, mode);

  const localDateOf = (ms: number): string =>
    new Date(ms + offset * 1000).toISOString().slice(0, 10);

  const onDay = candidates.find((ms) => localDateOf(ms) === dateISO);
  // 极昼/极夜兜底：没有符合日期的事件时，取窗口内最接近正午的那个。
  // 注意必须把 `exists` 上报出去 —— 否则 UI 会拿一个「太阳在地平线下 23°」的
  // 时刻当成正常日落，给出一份看起来很正常的"无烧"预报，把极夜误读成坏天气。
  const exists = onDay !== undefined;
  const eventMs =
    onDay ??
    (candidates.length
      ? candidates.reduce((best, ms) =>
          Math.abs(localDateOf(ms).localeCompare(dateISO)) < Math.abs(localDateOf(best).localeCompare(dateISO))
            ? ms
            : best,
        )
      : localMidnightUtc + (mode === 'sunrise' ? 6 : 18) * 3600 * 1000);

  const sun = sunPosition(eventMs, point.lat, point.lon);
  return { eventMs, azimuthDeg: sun.azimuth, mode, localDayStartUtcMs: localMidnightUtc, exists };
}

/** 在给定时间窗内枚举某模式的所有事件时刻（最多 3 个）。 */
function sunEventsInWindow(
  fromMs: number,
  spanHours: number,
  lat: number,
  lon: number,
  mode: 'sunrise' | 'sunset',
): number[] {
  const out: number[] = [];
  const end = fromMs + spanHours * 3600 * 1000;
  let t = fromMs;
  while (t < end && out.length < 3) {
    const ev = sunEvent(t, lat, lon, mode);
    if (ev === null) break;
    out.push(ev);
    t = ev + 3 * 3600 * 1000; // 跳到本次事件之后，避免重复命中
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 数据解析
// ═══════════════════════════════════════════════════════════════════════════

interface OmHourly {
  time: string[];
  [key: string]: Array<number | null> | string[];
}

interface OmPointResponse {
  latitude: number;
  longitude: number;
  elevation?: number;
  utc_offset_seconds: number;
  timezone?: string;
  timezone_abbreviation?: string;
  hourly: OmHourly;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function keyFor(varName: string, model: ModelId): string {
  return `${varName}_${MODEL_META[model].api}`;
}

/** 取某变量序列（带模型后缀），缺失返回全 null 数组 */
function series(hourly: OmHourly, varName: string, model: ModelId): Array<number | null> {
  const k = keyFor(varName, model);
  const arr = hourly[k] ?? hourly[varName];
  if (!Array.isArray(arr) || typeof arr[0] === 'string') {
    return hourly.time.map(() => null);
  }
  return arr as Array<number | null>;
}

/**
 * 位势高度缺测 → 由地面气压反演 MSL 高度。
 *
 * **上一版公式用错了**：`z = 44330·(1 − (p/p0)^0.1903)` 给出的是**离地高度 (AGL)**，
 * 而调用方要的是 MSL。且 `p0` 被 clamp 到 ≥850，于是拉萨（地面 650hPa）
 * 的 500hPa 算出 4258m、400hPa 算出 5924m —— 真实 MSL 约 5500 / 7200m，
 * 凭空下移了一千多米，位势高度一旦缺测就会把黄金层判到错误高度。
 *
 * 正确做法：用**标准大气压高公式**从海平面气压出发，
 *     z = 44330·(1 − (p / 1013.25)^0.1903)
 * 这本来就是 MSL（标准大气以海平面为基准）。
 * 现实大气与标准大气有偏差，用地面气压做一次线性修正即可。
 */
function levelHeightM(
  hourly: OmHourly,
  model: ModelId,
  level: (typeof PRESSURE_LEVELS)[number],
  i: number,
  surfacePressure: number,
): number {
  const gph = numOrNull(series(hourly, `geopotential_height_${level.hpa}hPa`, model)[i]);
  if (gph != null && gph > 0) return gph;

  // 标准大气：以 1013.25hPa 为海平面基准 → 直接得到 MSL
  const zStd = 44330 * (1 - Math.pow(level.hpa / 1013.25, 0.1903));
  // 地面气压偏离标准值时，按等温大气的近似做一次厚度修正
  // （低压环境整层气柱更厚，同一等压面抬升）
  const sp = clamp(Number.isFinite(surfacePressure) && surfacePressure > 0 ? surfacePressure : 1013.25, 300, 1100);
  const corr = 1 + (1013.25 - sp) * 0.00008;
  const z = zStd * corr;
  return Number.isFinite(z) ? clamp(z, 100, 12000) : level.nominalM;
}

function buildSamples(hourly: OmHourly, model: ModelId, offsetSeconds: number): HourlySample[] {
  const times = hourly.time;
  const out: HourlySample[] = [];
  for (let i = 0; i < times.length; i++) {
    const timeMs = localIsoToUtcMs(times[i], offsetSeconds);
    if (!Number.isFinite(timeMs)) continue;
    const sp = numOrNull(series(hourly, 'surface_pressure', model)[i]) ?? 1013.25;

    const cloud = {} as Record<LevelKey, number>;
    const levelHeight = {} as Record<LevelKey, number>;
    const levelTemp: Partial<Record<LevelKey, number>> = {};
    const levelHumidity: Partial<Record<LevelKey, number>> = {};
    for (const lv of PRESSURE_LEVELS) {
      cloud[lv.key] = clamp(num(series(hourly, `cloud_cover_${lv.hpa}hPa`, model)[i]), 0, 100);
      levelHeight[lv.key] = levelHeightM(hourly, model, lv, i, sp);
      const t = numOrNull(series(hourly, `temperature_${lv.hpa}hPa`, model)[i]);
      if (t != null) levelTemp[lv.key] = t;
      const rh = numOrNull(series(hourly, `relative_humidity_${lv.hpa}hPa`, model)[i]);
      if (rh != null) levelHumidity[lv.key] = clamp(rh, 0, 100);
    }

    const visRaw = numOrNull(series(hourly, 'visibility', model)[i]);
    // Open-Meteo 的 visibility 单位是米；部分模型为 null
    const visMs = visRaw == null ? 0 : clamp(visRaw, 0, 120000);

    out.push({
      timeMs,
      cloud,
      levelHeightM: levelHeight,
      levelTempC: levelTemp,
      levelHumidity,
      boundaryLayerM: Math.max(0, numOrNull(series(hourly, 'boundary_layer_height', model)[i]) ?? 0),
      freezingLevelM: Math.max(0, numOrNull(series(hourly, 'freezing_level_height', model)[i]) ?? 0),
      directRadiation: Math.max(0, num(series(hourly, 'direct_radiation', model)[i])),
      diffuseRadiation: Math.max(0, num(series(hourly, 'diffuse_radiation', model)[i])),
      shortwaveRadiation: Math.max(0, num(series(hourly, 'shortwave_radiation', model)[i])),
      sunshineDurationS: Math.max(0, num(series(hourly, 'sunshine_duration', model)[i])),
      cloudLow: clamp(num(series(hourly, 'cloud_cover_low', model)[i]), 0, 100),
      cloudMid: clamp(num(series(hourly, 'cloud_cover_mid', model)[i]), 0, 100),
      cloudHigh: clamp(num(series(hourly, 'cloud_cover_high', model)[i]), 0, 100),
      cloudTotal: clamp(num(series(hourly, 'cloud_cover', model)[i]), 0, 100),
      precipitation: Math.max(0, num(series(hourly, 'precipitation', model)[i])),
      humidity: clamp(num(series(hourly, 'relative_humidity_2m', model)[i], 55), 0, 100),
      visibilityM: visMs,
      weatherCode: Math.round(num(series(hourly, 'weather_code', model)[i])),
      windSpeed: num(series(hourly, 'wind_speed_10m', model)[i]),
      windDir: num(series(hourly, 'wind_direction_10m', model)[i]),
      dewPointC: num(series(hourly, 'dew_point_2m', model)[i]),
      surfacePressureHpa: sp,
    });
  }
  return out;
}

function buildAerosol(hourly: OmHourly, offsetSeconds: number): AerosolSample[] {
  const times = hourly.time;
  const out: AerosolSample[] = [];
  for (let i = 0; i < times.length; i++) {
    const timeMs = localIsoToUtcMs(times[i], offsetSeconds);
    if (!Number.isFinite(timeMs)) continue;
    // Air quality API 不要模型后缀
    const aodRaw = numOrNull((hourly['aerosol_optical_depth'] as Array<number | null>)?.[i]);
    out.push({
      timeMs,
      // 保留 null 语义：数值上仍需一个可用于插值的占位（0.22 = 气候学中值），
      // 但 `aodValid` 明确标记它是不是真值。引擎据此把 `available` 判成 false。
      aod: clamp(aodRaw ?? CLIMATOLOGICAL_AOD, 0.01, 3),
      dust: Math.max(0, num((hourly['dust'] as Array<number | null>)?.[i])),
      pm25: Math.max(0, num((hourly['pm2_5'] as Array<number | null>)?.[i])),
      pm10: Math.max(0, num((hourly['pm10'] as Array<number | null>)?.[i])),
      humidity: clamp(num((hourly['relative_humidity_2m'] as Array<number | null>)?.[i], 55), 0, 100),
      aodValid: aodRaw != null && aodRaw > 0,
    });
  }
  return out;
}

/** 气溶胶缺测时的气候学中值（典型城市背景 AOD@550nm） */
export const CLIMATOLOGICAL_AOD = 0.22;

// ═══════════════════════════════════════════════════════════════════════════
// URL 构造
// ═══════════════════════════════════════════════════════════════════════════

function coordsParam(points: GeoPoint[]): string {
  return points.map((p) => p.lat.toFixed(4)).join(',');
}
function lonParam(points: GeoPoint[]): string {
  return points.map((p) => p.lon.toFixed(4)).join(',');
}

function forecastUrl(points: GeoPoint[], models: ModelId[], startDate: string, endDate: string): string {
  const q = new URLSearchParams({
    latitude: coordsParam(points),
    longitude: lonParam(points),
    hourly: HOURLY_VARS.join(','),
    models: models.map((m) => MODEL_META[m].api).join(','),
    start_date: startDate,
    end_date: endDate,
    timezone: 'auto',
    windspeed_unit: 'kmh',
  });
  return `${FORECAST_BASE}?${q.toString()}`;
}

function airUrl(points: GeoPoint[], startDate: string, endDate: string): string {
  const q = new URLSearchParams({
    latitude: coordsParam(points),
    longitude: lonParam(points),
    hourly: AIR_VARS.join(','),
    start_date: startDate,
    end_date: endDate,
    timezone: 'auto',
  });
  return `${AIR_BASE}?${q.toString()}`;
}

function elevUrl(points: GeoPoint[]): string {
  const q = new URLSearchParams({
    latitude: coordsParam(points),
    longitude: lonParam(points),
  });
  return `${ELEV_BASE}?${q.toString()}`;
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

// ═══════════════════════════════════════════════════════════════════════════
// 主加载函数
// ═══════════════════════════════════════════════════════════════════════════

export interface LoadOptions {
  point: GeoPoint;
  dateISO: string;
  mode: 'sunrise' | 'sunset';
  models: ModelId[];
  /** 强制忽略缓存 */
  force?: boolean;
  signal?: AbortSignal;
}

export interface LoadResult {
  bundle: ForecastBundle;
  tzOffsetSeconds: number;
  tzName: string;
  modelLabels: Record<ModelId, string>;
}

export async function loadForecastBundle(opts: LoadOptions): Promise<LoadResult> {
  const { point, dateISO, mode, models, force } = opts;
  const resolved = resolveEvent(point, dateISO, mode);
  const grid = generateLightPathGrid(point.lat, point.lon, resolved.eventMs, mode);

  // 采样环：严格按距观测点的大圆距离
  const ringPoints: GeoPoint[] = RING_KM.map((d) => {
    if (d === 0) return { lat: point.lat, lon: point.lon };
    return destinationPoint(point.lat, point.lon, resolved.azimuthDeg, d);
  });

  // ── 请求日期窗 ──
  // 事件窗口是 [T0−20min, T0+40min]。如果 T0 在本地日期边界附近
  // （例如高纬冬季 15:30、或低纬夏季 19:10 而 +40min 已跨日），
  // 单日数据会覆盖不到事件窗口。这里请求 dateISO−1 ~ dateISO+1 三天，
  // 既能覆盖跨日，也能让「前后一小时」插值有真实邻点可依。
  const pad = (iso: string, deltaDays: number): string => {
    const t = Date.parse(`${iso}T00:00:00Z`) + deltaDays * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  };
  const startDate = pad(dateISO, -1);
  const endDate = pad(dateISO, 1);

  const cacheKey = [
    // 与请求用的光环点保持同一精度（toFixed(4)）。上一版这里用 toFixed(3)，
    // 约 110m 的粒度，于是相邻 100m 的两个机位会命中同一份缓存。
    point.lat.toFixed(4),
    point.lon.toFixed(4),
    dateISO,
    mode,
    models.slice().sort().join('-'),
  ].join('|');

  const isPast = Date.parse(`${dateISO}T00:00:00Z`) < Date.now() - 86400000;
  const ttl = isPast ? CACHE_TTL_PAST_MS : CACHE_TTL_LIVE_MS;

  const cached = force ? null : cacheGet<CachedBundle>(cacheKey, ttl);
  if (cached) {
    return hydrate(cached, ringPoints, grid, models, resolved, true);
  }

  const signal = opts.signal;
  const [fcRaw, aqRaw, elRaw] = await Promise.all([
    fetchJson<OmPointResponse | OmPointResponse[]>(forecastUrl(ringPoints, models, startDate, endDate), 0, signal).catch(
      (e) => {
        if (signal?.aborted) throw e;
        throw new Error(`气象场请求失败：${(e as Error).message}`);
      },
    ),
    fetchJson<OmPointResponse | OmPointResponse[]>(airUrl(ringPoints, startDate, endDate), 0, signal).catch(() => null),
    fetchJson<{ elevation: number[] }>(elevUrl(ringPoints), 0, signal).catch(() => null),
  ]);

  // 请求返回后若已被取消，丢弃结果（不写缓存、不覆盖新结果）
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const fc = asArray(fcRaw);
  const aq = aqRaw ? asArray(aqRaw) : [];

  // 以观测点（第一个点）的时区为准，用于 UI 展示与本地时钟。
  const tzOffsetSeconds = fc[0]?.utc_offset_seconds ?? estimateOffsetSeconds(point.lon);
  const tzName = fc[0]?.timezone ?? 'GMT';

  const elevations = elRaw?.elevation ?? ringPoints.map(() => 0);
  const terrain: TerrainSample[] = ringPoints.map((p, i) => ({
    ringKm: RING_KM[i],
    point: p,
    elevationM: Math.max(0, num(elevations[i])),
  }));
  const localElevationM = terrain[0].elevationM;

  const ringSeries: Record<ModelId, RingSeries[]> = {} as Record<ModelId, RingSeries[]>;
  const ringAerosol: Record<ModelId, RingAerosol[]> = {} as Record<ModelId, RingAerosol[]>;

  // `timezone=auto` 对每个坐标返回**该坐标自己的** utc_offset_seconds。
  // 450km 的环可能跨时区（如乌鲁木齐 87°E 与 450km 外的 81°E），
  // 若统一用观测点偏移解析，远环的小时序列会整体错位若干小时 ——
  // 而远环正是"光路上游云况"的来源。因此逐环用各自的偏移。
  const offsetOf = (resp: OmPointResponse | undefined): number =>
    Number.isFinite(resp?.utc_offset_seconds) ? (resp!.utc_offset_seconds as number) : tzOffsetSeconds;

  for (const m of models) {
    ringSeries[m] = ringPoints.map((p, i) => {
      const resp = fc[i];
      return {
        ringKm: RING_KM[i],
        point: p,
        samples: resp ? buildSamples(resp.hourly, m, offsetOf(resp)) : [],
      };
    });
    ringAerosol[m] = ringPoints.map((p, i) => {
      const resp = aq[i];
      return {
        ringKm: RING_KM[i],
        point: p,
        samples: resp ? buildAerosol(resp.hourly, offsetOf(resp) || tzOffsetSeconds) : [],
      };
    });
  }

  const payload: CachedBundle = {
    fetchedAt: Date.now(),
    tzOffsetSeconds,
    tzName,
    localElevationM,
    terrain,
    gridLat: fc[0]?.latitude ?? point.lat,
    gridLon: fc[0]?.longitude ?? point.lon,
    rings: ringPoints.map((p, i) => ({
      ringKm: RING_KM[i],
      point: p,
      series: Object.fromEntries(models.map((m) => [m, ringSeries[m][i].samples])) as Record<
        ModelId,
        HourlySample[]
      >,
      aerosol: Object.fromEntries(models.map((m) => [m, ringAerosol[m][i].samples])) as Record<
        ModelId,
        AerosolSample[]
      >,
    })),
    apiCalls: 3,
  };

  cacheSet(cacheKey, payload);
  return hydrate(payload, ringPoints, grid, models, resolved, false);
}

// ── 缓存结构（扁平化，便于 JSON 存储） ────────────────────────────────

interface CachedRing {
  ringKm: number;
  point: GeoPoint;
  series: Record<ModelId, HourlySample[]>;
  aerosol: Record<ModelId, AerosolSample[]>;
}

interface CachedBundle {
  fetchedAt: number;
  tzOffsetSeconds: number;
  tzName: string;
  localElevationM: number;
  terrain: TerrainSample[];
  gridLat: number;
  gridLon: number;
  rings: CachedRing[];
  apiCalls: number;
}

/**
 * 用其他模型的非空值补齐本模型缺失的大尺度标量。
 *
 * 只补 `boundaryLayerM` / `freezingLevelM` 两个字段：
 *  · 都是单值标量，跨模型借用误差远小于"直接用 0"
 *  · 逐样本、逐环匹配（按时间戳找最近样本），不做外推
 */
function backfillModelScalars(datasets: Record<ModelId, ModelDataset>, models: ModelId[]): void {
  const fields = ['boundaryLayerM', 'freezingLevelM'] as const;
  for (const m of models) {
    const ds = datasets[m];
    if (!ds?.rings.length) continue;
    const donors = models
      .filter((x) => x !== m)
      .map((x) => datasets[x])
      .filter((d) => d?.rings?.length);

    for (const field of fields) {
      const hasAny = ds.rings.some((r) => r.samples.some((s) => (s[field] ?? 0) > 0));
      if (hasAny) continue;
      for (const ring of ds.rings) {
        const donorRing = donors
          .map((d) => d.rings.find((r) => r.ringKm === ring.ringKm))
          .find((r) => r && r.samples.some((s) => (s[field] ?? 0) > 0));
        if (!donorRing) continue;
        for (const sample of ring.samples) {
          // 找时间最近的多方样本
          let best: HourlySample | null = null;
          let bestDt = Infinity;
          for (const ds2 of donorRing.samples) {
            const dt = Math.abs(ds2.timeMs - sample.timeMs);
            if (dt < bestDt) {
              bestDt = dt;
              best = ds2;
            }
          }
          const v = best?.[field] ?? 0;
          if (v > 0 && bestDt <= 45 * 60000) sample[field] = v;
        }
      }
    }
  }
}

function hydrate(
  payload: CachedBundle,
  ringPoints: GeoPoint[],
  _grid: unknown,
  models: ModelId[],
  _resolved: ResolvedEvent,
  cached: boolean,
): LoadResult {
  const modelDatasets = {} as Record<ModelId, ModelDataset>;
  for (const m of models) {
    modelDatasets[m] = {
      model: m,
      label: MODEL_META[m].label,
      gridLat: payload.gridLat,
      gridLon: payload.gridLon,
      gridElevationM: payload.localElevationM,
      rings: payload.rings.map((r) => ({
        ringKm: r.ringKm,
        point: r.point,
        samples: r.series[m] ?? [],
      })),
      aerosol: payload.rings.map((r) => ({
        ringKm: r.ringKm,
        point: r.point,
        samples: r.aerosol[m] ?? [],
      })),
    };
  }

  // 补齐缺失模型（缓存只含部分模型时）
  for (const m of models) {
    if (!modelDatasets[m]) {
      modelDatasets[m] = {
        model: m,
        label: MODEL_META[m].label,
        gridLat: payload.gridLat,
        gridLon: payload.gridLon,
        gridElevationM: payload.localElevationM,
        rings: [],
        aerosol: [],
      };
    }
  }

  // ── 跨模型补齐大尺度标量 ──
  //
  // 实测：`boundary_layer_height` 只有 GFS 提供（ECMWF/ICON 全 null），
  // `freezing_level_height` ECMWF 不提供。这两个量对「霾层厚度」「冰/水云分界」
  // 都是必要输入，缺失时相关物理判据会静默失效。
  //
  // 它们都是**大尺度标量**（不像云量那样有强局地性），跨模型借用可接受。
  // 在数据层做（而不是引擎层），这样 UI、诊断、导出都能拿到补齐后的值。
  backfillModelScalars(modelDatasets, models);

  const bundle: ForecastBundle = {
    models: modelDatasets,
    terrain: payload.terrain.length ? payload.terrain : ringPoints.map((p, i) => ({ ringKm: RING_KM[i], point: p, elevationM: 0 })),
    localElevationM: payload.localElevationM,
    fetchedAt: payload.fetchedAt,
    apiCalls: payload.apiCalls,
    cached,
  };

  return {
    bundle,
    tzOffsetSeconds: payload.tzOffsetSeconds,
    tzName: payload.tzName,
    modelLabels: Object.fromEntries(models.map((m) => [m, MODEL_META[m].label])) as Record<ModelId, string>,
  };
}

/** 清理所有 AetherGlow 缓存 */
export function clearCache(): number {
  let n = 0;
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(CACHE_PREFIX)) {
      localStorage.removeItem(k);
      n++;
    }
  }
  return n;
}

export { LEVEL_KEYS };
