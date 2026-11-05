/**
 * NASA POWER 臭氧总柱量接入
 * ===========================================================================
 * 为什么必须补这一项：
 *
 * 臭氧 Chappuis 带（400–650nm，双峰 575/603nm）是**黄昏天空偏紫偏蓝的唯一原因**。
 * 此前引擎用的是气候常数（300 DU），而真实大气柱量在 220–450 DU 之间变化 ——
 * 极地春季可达 600 DU。±30% 的臭氧差异会直接改变蓝调时刻的色相与亮度。
 *
 * 数据源：NASA POWER `TO3`（Total Column Ozone，单位 Dobsons）
 *  · CORS: `access-control-allow-origin: *`（实测）
 *  · 免 API key，免注册
 *  · 滞后 2–3 天（对臭氧完全够用 —— 柱量在天气尺度到季节尺度上缓慢变化）
 *  · 实测值 260.96 DU @ 上海 2026-11-02
 *
 * **注意 AOD_55 不可用**：实测 2026-09 之后全部 -999（约 2 个月滞后），
 * 所以 AOD 仍用 Open-Meteo 的 CAMS。
 */

const POWER_BASE = 'https://power.larc.nasa.gov/api/temporal/hourly/point';

/** NASA POWER 缺测哨兵值 */
const POWER_MISSING = -999;

const OZONE_CACHE_PREFIX = 'aetherglow:o3:v1:';
const OZONE_CACHE_TTL_MS = 12 * 3600 * 1000; // 臭氧变化慢，12h 足够

const ozoneInflight = new Map<string, Promise<OzoneEstimate | null>>();

export interface OzoneEstimate {
  /** 总柱量 (Dobson Unit) */
  totalColumnDu: number;
  /** 观测时刻（UTC ms），用于告知用户数据新鲜度 */
  observedAtMs: number;
  /** 相对观测时刻的滞后小时数 */
  lagHours: number;
  source: 'nasa-power';
}

/** 标准大气臭氧柱量 (DU) —— 数据不可用时的保守回退 */
export const OZONE_CLIMATOLOGY_DU = 300;

/**
 * 拉取该点最近可用的臭氧总柱量。
 *
 * @returns 臭氧柱量与数据新鲜度；任何失败返回 null，调用方回退到气候值。
 */
export async function fetchOzoneColumn(
  point: { lat: number; lon: number },
  nearMs: number,
  signal?: AbortSignal,
): Promise<OzoneEstimate | null> {
  const cacheKey = `${OZONE_CACHE_PREFIX}${point.lat.toFixed(2)}|${point.lon.toFixed(2)}`;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { t: number; v: OzoneEstimate | null };
      if (Date.now() - parsed.t < OZONE_CACHE_TTL_MS) return parsed.v;
    }
  } catch {
    /* 无缓存也能跑 */
  }
  const existing = ozoneInflight.get(cacheKey);
  if (existing) return existing;

  const task = (async (): Promise<OzoneEstimate | null> => {
    const v = await fetchOzoneUncached(point, nearMs, signal);
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), v }));
    } catch {
      /* 配额溢出：放弃缓存 */
    }
    return v;
  })();
  ozoneInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    ozoneInflight.delete(cacheKey);
  }
}

async function fetchOzoneUncached(
  point: { lat: number; lon: number },
  nearMs: number,
  signal?: AbortSignal,
): Promise<OzoneEstimate | null> {
  // 臭氧滞后 2–3 天，往回取 7 天窗口以确保能拿到有效值
  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const start = fmt(nearMs - 7 * 86400000);
  const end = fmt(nearMs);

  const q = new URLSearchParams({
    parameters: 'TO3',
    community: 'RE',
    longitude: point.lon.toFixed(4),
    latitude: point.lat.toFixed(4),
    start,
    end,
    format: 'JSON',
  });

  let json: unknown;
  try {
    const res = await fetch(`${POWER_BASE}?${q}`, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  }

  const param = (json as { properties?: { parameter?: Record<string, Record<string, number>> } })
    ?.properties?.parameter?.TO3;
  if (!param) return null;

  // 取**最近一个有效值**（POWER 的键是 YYYYMMDDHH 本地太阳时）
  let bestKey: string | null = null;
  for (const k of Object.keys(param)) {
    if (!/^\d{10}$/.test(k)) continue;
    const v = param[k];
    if (typeof v !== 'number' || v === POWER_MISSING || !Number.isFinite(v) || v <= 0) continue;
    if (bestKey === null || k > bestKey) bestKey = k;
  }
  if (!bestKey) return null;

  const totalColumnDu = param[bestKey];
  // 解析 YYYYMMDDHH → UTC ms（POWER 的时间标记按 UTC 提供的小时级数据）
  const y = Number(bestKey.slice(0, 4));
  const mo = Number(bestKey.slice(4, 6));
  const d = Number(bestKey.slice(6, 8));
  const h = Number(bestKey.slice(8, 10));
  const observedAtMs = Date.UTC(y, mo - 1, d, h, 0, 0);
  const lagHours = Math.max(0, Math.round((nearMs - observedAtMs) / 3600000));

  // 合理性检查：220 DU 是臭氧洞阈值，600 DU 是极地春季上限
  if (totalColumnDu < 150 || totalColumnDu > 700) return null;

  return { totalColumnDu, observedAtMs, lagHours, source: 'nasa-power' };
}
