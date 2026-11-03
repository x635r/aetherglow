/**
 * 地理编码：Open-Meteo Geocoding API（免 Key）
 */

export interface Place {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  timezone?: string;
  population?: number;
}

const GEO_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
const cache = new Map<string, Place[]>();

export async function searchPlaces(query: string, lang = 'zh'): Promise<Place[]> {
  const q = query.trim();
  if (!q) return [];
  const key = `${q}|${lang}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const url = `${GEO_BASE}?name=${encodeURIComponent(q)}&count=8&language=${lang}&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`地理编码失败 (${res.status})`);
  const json = (await res.json()) as { results?: Place[] };
  const out = (json.results ?? []).map((p) => ({
    ...p,
    label: [p.name, p.admin1, p.country].filter(Boolean).join(' · '),
  })) as Place[];
  cache.set(key, out);
  return out;
}

/** 内置城市快捷入口 */
export const QUICK_CITIES: Array<{ name: string; en: string; lat: number; lon: number; note: string }> = [
  { name: '上海', en: 'Shanghai', lat: 31.2304, lon: 121.4737, note: '东海之滨' },
  { name: '北京', en: 'Beijing', lat: 39.9042, lon: 116.4074, note: '华北平原' },
  { name: '广州', en: 'Guangzhou', lat: 23.1291, lon: 113.2644, note: '珠三角' },
  { name: '成都', en: 'Chengdu', lat: 30.5728, lon: 104.0668, note: '四川盆地' },
  { name: '拉萨', en: 'Lhasa', lat: 29.652, lon: 91.1721, note: '高原 3650m' },
  { name: '乌鲁木齐', en: 'Urumqi', lat: 43.8256, lon: 87.6168, note: '准噶尔' },
  { name: '三亚', en: 'Sanya', lat: 18.2528, lon: 109.5119, note: '热带海岛' },
  { name: '哈尔滨', en: 'Harbin', lat: 45.8038, lon: 126.5349, note: '高纬' },
  { name: '昆明', en: 'Kunming', lat: 24.8801, lon: 102.8329, note: '云贵高原' },
  { name: '深圳', en: 'Shenzhen', lat: 22.5431, lon: 114.0579, note: '南海沿岸' },
];
