/**
 * 全局状态：zustand。持有查询参数、加载态、预测结果、UI 交互状态。
 */

import { create } from 'zustand';
import { predictSunset } from '../engine/SunsetPhysicsEngine';
import type { ModelId, SunMode, SunsetPredictionOutput, GeoPoint, ForecastBundle } from '../engine/types';
import { loadForecastBundle, resolveEvent, type ResolvedEvent } from '../data/openMeteo';
import { LEVEL_BY_KEY } from '../engine/constants';
import type { LevelKey } from '../engine/constants';

export type DataStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface Query {
  point: GeoPoint;
  label: string;
  dateISO: string;
  mode: SunMode;
  observerHeightM: number;
  primaryModel: ModelId;
  models: ModelId[];
}

interface Store {
  query: Query;
  status: DataStatus;
  error: string | null;
  bundle: ForecastBundle | null;
  resolved: ResolvedEvent | null;
  tzOffsetSeconds: number;
  tzName: string;
  prediction: SunsetPredictionOutput | null;
  lastLoadedAt: number | null;
  fromCache: boolean;

  /** Canvas 时间滑块：相对事件的分钟偏移 */
  scrubMin: number;
  /** Canvas 高亮的层 */
  focusLevel: LevelKey;

  setQuery: (patch: Partial<Query>) => void;
  setPoint: (p: GeoPoint, label: string) => void;
  setObserverHeight: (m: number) => void;
  setScrub: (min: number) => void;
  setFocusLevel: (k: LevelKey) => void;
  toggleModel: (m: ModelId) => void;
  resetObserverHeight: () => void;

  load: (opts?: { force?: boolean }) => Promise<void>;
  recompute: () => void;
}

export function todayISO(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DEFAULT_QUERY: Query = {
  point: { lat: 31.2304, lon: 121.4737 },
  label: '上海 · 外滩',
  dateISO: todayISO(),
  mode: 'sunset',
  observerHeightM: 0,
  primaryModel: 'ecmwf',
  models: ['ecmwf', 'gfs', 'icon'],
};

export const useStore = create<Store>((set, get) => ({
  query: DEFAULT_QUERY,
  status: 'idle',
  error: null,
  bundle: null,
  resolved: null,
  tzOffsetSeconds: 8 * 3600,
  tzName: 'Asia/Shanghai',
  prediction: null,
  lastLoadedAt: null,
  fromCache: false,

  scrubMin: 0,
  focusLevel: '600',

  setQuery: (patch) => {
    const prev = get().query;
    const next = { ...prev, ...patch };
    set({ query: next });
    if (
      patch.point ||
      patch.dateISO ||
      patch.mode ||
      patch.models ||
      patch.primaryModel
    ) {
      void get().load();
    } else if (patch.observerHeightM !== undefined) {
      get().recompute();
    }
  },

  setPoint: (p, label) => {
    set((s) => ({ query: { ...s.query, point: p, label } }));
    void get().load();
  },

  setObserverHeight: (m) => {
    set((s) => ({ query: { ...s.query, observerHeightM: Math.round(m) } }));
    get().recompute();
  },

  setScrub: (min) => set({ scrubMin: Math.max(-20, Math.min(40, Math.round(min))) }),
  setFocusLevel: (k) => set({ focusLevel: k }),
  resetObserverHeight: () => {
    set((s) => ({ query: { ...s.query, observerHeightM: 0 } }));
    get().recompute();
  },

  toggleModel: (m) => {
    const cur = get().query.models;
    if (cur.includes(m)) {
      if (cur.length === 1) return;
      const next = cur.filter((x) => x !== m);
      if (get().query.primaryModel === m) {
        set((s) => ({ query: { ...s.query, models: next, primaryModel: next[0] } }));
      } else {
        set((s) => ({ query: { ...s.query, models: next } }));
      }
    } else {
      set((s) => ({ query: { ...s.query, models: [...cur, m] } }));
    }
    void get().load();
  },

  load: async (opts) => {
    const { query } = get();
    set({ status: 'loading', error: null });
    try {
      const res = await loadForecastBundle({
        point: query.point,
        dateISO: query.dateISO,
        mode: query.mode,
        models: query.models,
        force: opts?.force,
      });
      const resolved = resolveEvent(query.point, query.dateISO, query.mode);
      set({
        bundle: res.bundle,
        tzOffsetSeconds: res.tzOffsetSeconds,
        tzName: res.tzName,
        resolved,
        status: 'ready',
        lastLoadedAt: Date.now(),
        fromCache: res.bundle.cached,
      });
      get().recompute();
    } catch (e) {
      set({ status: 'error', error: (e as Error).message });
    }
  },

  recompute: () => {
    const { bundle, query, resolved, tzOffsetSeconds, tzName } = get();
    if (!bundle || !resolved) return;
    try {
      const pred = predictSunset({
        point: query.point,
        mode: query.mode,
        observerHeightM: query.observerHeightM,
        bundle,
        primaryModel: query.primaryModel,
        timezoneOffsetSeconds: tzOffsetSeconds,
        timezone: tzName,
        locationLabel: query.label,
        eventMs: resolved.eventMs,
        daily: {
          sunriseMs: query.mode === 'sunrise' ? resolved.eventMs : null,
          sunsetMs: query.mode === 'sunset' ? resolved.eventMs : null,
        },
        compareModels: query.models,
      });
      set({ prediction: pred });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
}));

export { LEVEL_BY_KEY };
