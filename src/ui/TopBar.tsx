import { useEffect, useRef, useState } from 'react';
import { QUICK_CITIES, searchPlaces, type Place } from '../data/geocode';
import { MODEL_META } from '../data/openMeteo';
import { useStore, todayISO } from '../state/store';
import type { ModelId, SunMode } from '../engine/types';
import { Dot, Segmented } from './primitives';

export function TopBar() {
  const { query, setQuery, setPoint, toggleModel, load, status, fromCache, lastLoadedAt, tzName, bundle } = useStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    // **竞态守卫**（P2 修复）：快速输入时，先发的慢请求可能后到，
    // 把新搜索词的结果覆盖成旧词的。cancelled 标记丢弃过期响应。
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await searchPlaces(q);
        if (!cancelled) setResults(found);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 420);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const pick = (p: Place) => {
    setPoint({ lat: p.latitude, lon: p.longitude }, p.name);
    setSearchOpen(false);
    setQ('');
    setResults([]);
  };

  const statusColor =
    status === 'loading' ? '#ffb340' : status === 'error' ? '#ff4d6d' : status === 'ready' ? '#38e8d0' : '#66748a';

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#04060c]/72 backdrop-blur-2xl">
      <div className="mx-auto max-w-[1560px] px-3 py-2 sm:px-5 sm:py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 sm:gap-3">
          {/* 品牌 */}
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <div className="leading-none">
              <div className="font-display text-[15px] font-bold tracking-[0.06em] text-slate-50">
                AETHERGLOW
                <span className="ml-1.5 text-[10px] font-medium tracking-[0.22em] text-amber-300/80">穹霞</span>
              </div>
              <div className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.18em] text-slate-500">
                Ray-Marched Twilight Engine
              </div>
            </div>
          </div>

          {/* 移动端把模式切换紧贴品牌，减少一整行高度 */}
          <div className="ml-auto sm:hidden">
            <Segmented<SunMode>
              size="sm"
              ariaLabel="选择朝霞或晚霞"
              value={query.mode}
              onChange={(m) => setQuery({ mode: m })}
              options={[
                { value: 'sunrise', label: '朝霞' },
                { value: 'sunset', label: '晚霞' },
              ]}
            />
          </div>

          <div className="hidden h-8 w-px bg-white/10 lg:block" />

          {/* 搜索 / 城市 */}
          <div className="relative order-3 w-full sm:order-none sm:w-auto" ref={boxRef}>
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              className="btn-ghost w-full justify-between sm:w-auto sm:min-w-[210px]"
              aria-expanded={searchOpen}
            >
              <span className="flex min-w-0 items-center gap-2">
                <PinIcon />
                <span className="truncate text-[12.5px]">{query.label}</span>
              </span>
              <span className="num ml-2 shrink-0 text-[10px] text-slate-500">
                {query.point.lat.toFixed(2)}, {query.point.lon.toFixed(2)}
              </span>
            </button>

            {searchOpen && (
              <div className="absolute left-0 top-full z-50 mt-2 w-full min-w-[320px] rounded-2xl border border-white/12 bg-[#080c16]/97 p-3 shadow-2xl backdrop-blur-2xl sm:w-[380px]">
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索城市 / 地名（中英文均可）"
                  className="w-full rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500 focus:border-amber-300/45 focus:outline-none"
                />
                <div className="mt-2.5 max-h-52 overflow-y-auto">
                  {searching && <div className="px-2 py-2 text-[12px] text-slate-500">检索中…</div>}
                  {!searching && q.trim() && results.length === 0 && (
                    <div className="px-2 py-2 text-[12px] text-slate-500">无匹配结果</div>
                  )}
                  {results.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => pick(p)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.07]"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] text-slate-100">{p.name}</span>
                        <span className="block truncate text-[10.5px] text-slate-500">
                          {[p.admin1, p.country].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="num shrink-0 text-[10px] text-slate-500">
                        {p.latitude.toFixed(2)}, {p.longitude.toFixed(2)}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-2.5 border-t border-white/8 pt-2.5">
                  <div className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    快捷城市
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_CITIES.map((c) => (
                      <button
                        key={c.en}
                        type="button"
                        onClick={() => {
                          setPoint({ lat: c.lat, lon: c.lon }, c.name);
                          setSearchOpen(false);
                        }}
                        className="chip hover:border-amber-300/40 hover:text-amber-200"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 定位后要关闭下拉（P2 修复）：上一版漏了 setSearchOpen(false)，
                    面板会一直悬停遮挡主卡片 */}
                <CoordPicker
                  onApply={(lat, lon) => {
                    setPoint({ lat, lon }, `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
                    setSearchOpen(false);
                  }}
                />
              </div>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* 日期 */}
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={query.dateISO}
                min={todayISO(-7)}
                max={todayISO(15)}
                onChange={(e) => e.target.value && setQuery({ dateISO: e.target.value })}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11.5px] text-slate-200 focus:border-amber-300/45 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setQuery({ dateISO: todayISO() })}
                className="chip hover:text-amber-200"
                title="回到今天"
              >
                今天
              </button>
            </div>

            {/* 朝/晚霞（桌面端；移动端已放在品牌行） */}
            <div className="hidden sm:block">
              <Segmented<SunMode>
                ariaLabel="选择朝霞或晚霞"
                value={query.mode}
                onChange={(m) => setQuery({ mode: m })}
                options={[
                  { value: 'sunrise', label: '朝霞' },
                  { value: 'sunset', label: '晚霞' },
                ]}
              />
            </div>

            {/* 数据源。
                **移动端也要能用**（P2 修复）：上一版 `hidden md:flex`
                把三个模型开关和强制刷新在 <768px 完全隐藏，
                手机/平板竖屏用户既不能切模型也不能手动刷新。
                现在只是换行，不隐藏。 */}
            <div className="flex flex-wrap items-center gap-1">
              {(['ecmwf', 'gfs', 'icon'] as ModelId[]).map((m) => {
                const on = query.models.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleModel(m)}
                    className="chip"
                    data-active={on}
                    title={`${MODEL_META[m].label}${query.primaryModel === m ? '（主源）' : ''}`}
                    style={on ? { background: `linear-gradient(135deg, ${MODEL_META[m].color}dd, ${MODEL_META[m].color})` } : undefined}
                  >
                    <Dot color={on ? '#0a0d14' : MODEL_META[m].color} />
                    {MODEL_META[m].short}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => load({ force: true })}
                className="btn-ghost !px-2.5 !py-1.5"
                title="强制刷新（跳过缓存）"
                disabled={status === 'loading'}
              >
                <RefreshIcon spinning={status === 'loading'} />
              </button>
            </div>
          </div>
        </div>

        {/* 状态条 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[9.5px] text-slate-500 sm:text-[10px]">
          <span className="flex items-center gap-1.5">
            <Dot color={statusColor} pulse={status === 'loading'} />
            {status === 'loading'
              ? '正在拉取等压面场与气溶胶…'
              : status === 'error'
                ? '数据请求失败'
                : status === 'ready'
                  ? fromCache
                    ? '缓存命中 · Edge/Local'
                    : '实时数据已同步'
                  : '待初始化'}
          </span>
          {bundle && (
            <>
              <span className="hidden sm:inline">·</span>
              <span className="hidden sm:inline">
                光路环 {bundle.terrain.length} 点 · {query.models.length} 源
              </span>
              <span className="hidden md:inline">·</span>
              <span className="hidden md:inline">时区 {tzName}</span>
            </>
          )}
          {lastLoadedAt && (
            <>
              <span>·</span>
              <span>{new Date(lastLoadedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function CoordPicker({ onApply }: { onApply: (lat: number, lon: number) => void }) {
  const [lat, setLat] = useState('39.9042');
  const [lon, setLon] = useState('116.4074');
  const ok = Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180 && lat !== '' && lon !== '';

  return (
    <div className="mt-2.5 border-t border-white/8 pt-2.5">
      <div className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        任意经纬度拾取
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={lat}
          onChange={(e) => setLat(e.target.value)}
          inputMode="decimal"
          placeholder="纬度"
          className="num w-full rounded-lg border border-white/12 bg-white/[0.04] px-2 py-1.5 text-[11.5px] focus:border-amber-300/45 focus:outline-none"
        />
        <input
          value={lon}
          onChange={(e) => setLon(e.target.value)}
          inputMode="decimal"
          placeholder="经度"
          className="num w-full rounded-lg border border-white/12 bg-white/[0.04] px-2 py-1.5 text-[11.5px] focus:border-amber-300/45 focus:outline-none"
        />
        <button
          type="button"
          disabled={!ok}
          onClick={() => onApply(Number(lat), Number(lon))}
          className="btn-ghost shrink-0 !px-2.5 !py-1.5 !text-[11px]"
        >
          定位
        </button>
      </div>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="relative grid h-9 w-9 shrink-0 place-items-center">
      <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-amber-300/85 via-orange-500/70 to-fuchsia-600/55 blur-[9px] opacity-70" />
      <svg viewBox="0 0 32 32" className="relative h-9 w-9">
        <defs>
          <linearGradient id="bm" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff2cc" />
            <stop offset="0.45" stopColor="#ffb340" />
            <stop offset="1" stopColor="#ff4d6d" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16.5" r="7.2" fill="url(#bm)" />
        <path d="M3 23.5 Q16 18.5 29 23.5" stroke="url(#bm)" strokeWidth="1.8" fill="none" strokeLinecap="round" opacity="0.85" />
        <path d="M5 27 Q16 23.5 27 27" stroke="url(#bm)" strokeWidth="1.3" fill="none" strokeLinecap="round" opacity="0.45" />
      </svg>
    </div>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-amber-300/85" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 14.5s5-4.6 5-8.2A5 5 0 0 0 3 6.3c0 3.6 5 8.2 5 8.2Z" />
      <circle cx="8" cy="6.2" r="1.8" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 ${spinning ? 'animate-spin' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 1.8v3.1h-3.1" />
    </svg>
  );
}
