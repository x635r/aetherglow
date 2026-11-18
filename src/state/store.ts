/**
 * 全局状态：zustand。持有查询参数、加载态、预测结果、UI 交互状态。
 */

import { create } from 'zustand';
import { predictSunset } from '../engine/SunsetPhysicsEngine';
import type { ModelId, SunMode, SunsetPredictionOutput, GeoPoint, ForecastBundle } from '../engine/types';
import { loadForecastBundle, resolveEvent, QuotaExhaustedError, type ResolvedEvent } from '../data/openMeteo';
import { fetchEnsembleProbability } from '../data/ensemble';
import { fetchOzoneColumn } from '../data/ozone';
import { sunPosition } from '../engine/astro';
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
  /**
   * 当前展示的数据是否为**过期缓存**（网络/额度失败时的兜底）。
   *
   * 与 `status==='error'` 互斥：有过期数据时 `status` 仍是 `'ready'`
   * （页面正常渲染），但 `stale` 为 true，UI 需要显式提示数据年龄。
   * 这样「额度耗尽」不会让整页变空白。
   */
  stale: boolean;
  staleAgeMs: number;
  staleReason: string | null;
  /** 额度恢复时刻 (epoch ms)；0 = 非额度问题 */
  quotaResetAtMs: number;
  /** 臭氧总柱量 (DU)，来自 NASA POWER；null = 用标准 300 DU */
  ozoneDu: number | null;

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

/** 请求序号与取消句柄（模块级，不属于 UI 状态） */
let loadSeq = 0;
let inflightAbort: AbortController | null = null;

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
  stale: false,
  staleAgeMs: 0,
  staleReason: null,
  quotaResetAtMs: 0,
  ozoneDu: null,

  scrubMin: 0,
  focusLevel: '600',

  setQuery: (patch) => {
    const prev = get().query;
    const next = { ...prev, ...patch };
    // 换日期/模式/地点都要丢弃旧臭氧（审查 P2）：
    // 臭氧是按「地点 + 事件时刻」取的，换日期后旧柱量属于另一天。
    // （setPoint 已单独处理 point；这里覆盖 dateISO/mode 的路径。）
    const dropOzone = patch.point || patch.dateISO || patch.mode;
    set((s) => ({ query: next, ozoneDu: dropOzone ? null : s.ozoneDu }));
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
    // 换地点必须丢弃旧臭氧（不同纬度柱量差可达 100+ DU）
    set((s) => ({ query: { ...s.query, point: p, label }, ozoneDu: null }));
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

    // **不要为了切换图表可见性而重新联网**（P1 修复）。
    //
    // 首次加载时三个模型的数据已经全部存进 `bundle.models`，缓存键为
    // `...|ecmwf-gfs-icon`。关掉 GFS 后若调 `load()`，缓存键变成
    // `...|ecmwf-icon`，与前者不匹配 ⇒ 全屏 loading + 重发
    // forecast/air-quality/elevation/ensemble 四个请求（约 166 配额单位），
    // 而用户只是想隐藏一条曲线。
    const bundle = get().bundle;
    const nextModels = get().query.models;
    const allLoaded =
      bundle != null &&
      nextModels.every((id) => {
        const ds = bundle.models[id];
        return !!ds && ds.rings.length > 0;
      });
    if (allLoaded) {
      // 数据已在内存：只重算展示层，不发网络请求
      get().recompute();
      return;
    }
    void get().load();
  },

  load: async (opts) => {
    const { query } = get();
    // 请求序号 + AbortController：快速切换城市时，先发后到的响应不能覆盖新结果。
    // 上一版完全没有这层保护（`signal` 参数传到数据层也被丢弃）。
    loadSeq++;
    const mySeq = loadSeq;
    inflightAbort?.abort();
    const ac = new AbortController();
    inflightAbort = ac;

    // ── 额度冷却：额度耗尽后拒绝新请求 ──
    //
    // 上一版点「重试」会立刻再发一次请求，而额度是**小时窗口**级的 ——
    // 分钟内重试必然还是 429。用户看到红色横幅后通常会连点几次，
    // 结果是把自己的 429 计数刷得更高、日志更难看，还拖慢了真正的恢复。
    //
    // 现在：一旦确认额度耗尽并把 `quotaResetAtMs` 记下来，在恢复前
    // 直接短路返回（保留现有数据与错误提示，不发请求）。
    const cooldownUntil = get().quotaResetAtMs;
    if (cooldownUntil > 0 && Date.now() < cooldownUntil) {
      const mins = Math.ceil((cooldownUntil - Date.now()) / 60000);
      set((s) => ({
        status: s.prediction ? 'ready' : 'error',
        error: s.prediction
          ? null
          : `Open-Meteo 额度预计 ${mins} 分钟后恢复，暂不重复请求。`,
      }));
      return;
    }

    set({ status: 'loading', error: null });
    try {
      const res = await loadForecastBundle({
        point: query.point,
        dateISO: query.dateISO,
        mode: query.mode,
        models: query.models,
        force: opts?.force,
        signal: ac.signal,
      });
      const resolved = resolveEvent(query.point, query.dateISO, query.mode);
      // 竞态守卫（审查 P2）：abort 只能打断**还在等待**的请求；
      // 若旧请求在 abort 前已 resolve（或数据层某处丢了 signal），
      // 它仍会走到这里 —— 不写序号检查就会让旧城市的结果覆盖新城市。
      if (mySeq !== loadSeq) return;
      set({
        bundle: res.bundle,
        tzOffsetSeconds: res.tzOffsetSeconds,
        tzName: res.tzName,
        resolved,
        status: 'ready',
        lastLoadedAt: Date.now(),
        fromCache: res.bundle.cached,
        // 过期缓存兜底：status 仍是 ready（页面正常渲染），
        // 但要把"数据是旧的"这个事实明确传出去
        stale: res.stale === true,
        staleAgeMs: res.staleAgeMs ?? 0,
        staleReason: res.staleReason ?? null,
        quotaResetAtMs: 0,
      });
      get().recompute();
    } catch (e) {
      // 被后续请求取消的旧请求：静默丢弃，不要把 stale error 显示给用户
      if (mySeq !== loadSeq || (e as Error).name === 'AbortError') return;

      // 额度耗尽：单独记录恢复时刻，供 UI 显示倒计时并禁用重试。
      // 不要把它和普通网络错误混为一谈 —— 用户狂点重试只会继续吃 429。
      const resetAtMs = e instanceof QuotaExhaustedError ? e.resetAtMs : 0;

      // **关键：不清空已有数据**。如果之前已经成功加载过一份 bundle，
      // 保留它（predictions 也保留），只在顶部显示错误。
      // 上一版这里直接 set({status:'error'})，而 App 用 `p` 决定渲染哪些卡片 ——
      // 于是额度一耗尽，整个页面从"有一份预报"变成"完全空白"。
      set((s) => ({
        status: 'error',
        error: (e as Error).message,
        quotaResetAtMs: resetAtMs,
        // 已有数据时保留；没有数据时保持 null（真的没东西可显示）
        bundle: s.bundle,
        prediction: s.prediction,
      }));
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
        eventExists: resolved.exists,
        ozoneColumnDu: get().ozoneDu ?? undefined,
        compareModels: query.models,
      });
      set({ prediction: pred });

      // ── 臭氧总柱量（异步、独立、失败不影响主结果）──
      //
      // 滞后 2–3 天对臭氧完全够用（柱量在天气尺度到季节尺度上缓慢变化），
      // 但它 ±30% 的变化会让黄昏色相偏移 6° —— 值得等这 200ms。
      //
      // **必须传 `resolved.eventMs` 而不是 `Date.now()`**：用户可能在查
      // 明天、甚至几天后的晚霞，用当前时刻会把臭氧窗口整体错位。
      const seqO3 = loadSeq;
      if (get().ozoneDu == null) {
        void fetchOzoneColumn(query.point, resolved.eventMs)
          .then((o3) => {
            if (seqO3 !== loadSeq || !o3) return;
            // 写入 state 后重算一次；ozoneDu 非空后不会再次触发，无循环
            set({ ozoneDu: o3.totalColumnDu });
            get().recompute();
          })
          .catch(() => {
            /* 臭氧失败静默：退回标准 300 DU */
          });
      }

      // ── 集合概率（异步、独立、失败不影响主结果）──
      // 深拷贝一份再替换，避免和后续 recompute 竞争同一个对象。
      const seqAtCall = loadSeq;
      if (query.mode === 'sunset' || query.mode === 'sunrise') {
        void fetchEnsembleProbability({
          point: query.point,
          eventMs: resolved.eventMs,
          mode: query.mode,
          tzOffsetSeconds,
          // 必须传事件时刻的真实方位角：集合沿太阳方位铺采样环，
          // 写死 250° 会让朝霞/高纬日落采到背对太阳的天空。
          azimuthDeg: resolved.azimuthDeg,
          altitudeAt: (t: number) => sunPosition(t, query.point.lat, query.point.lon).altitude,
        })
          .then((ens) => {
            // 只接受**当前**这次查询的结果；用户已切城市则丢弃
            if (seqAtCall !== loadSeq) return;
            const cur = get().prediction;
            if (!cur || !ens) return;
            set({
              prediction: {
                ...cur,
                dual: {
                  ...cur.dual,
                  ensemble: {
                    probability: ens.probability,
                    members: ens.members,
                    p10: ens.p10,
                    p50: ens.p50,
                    p90: ens.p90,
                    peakOffsetP10: ens.peakOffsetP10,
                    peakOffsetP50: ens.peakOffsetP50,
                    peakOffsetP90: ens.peakOffsetP90,
                  },
                },
              },
            });
          })
          .catch(() => {
            /* 集合失败静默：主预测仍然有效 */
          });
      }
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
}));

export { LEVEL_BY_KEY };
