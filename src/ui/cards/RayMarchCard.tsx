import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LEVEL_BY_KEY, LEVEL_KEYS } from '../../engine/constants';
import { sunPosition } from '../../engine/astro';
import { useStore } from '../../state/store';
import { renderSection, type HitRegion } from '../../render/sectionRenderer';
import { InfoTip, Panel } from '../primitives';

/** 时间滑块步进 2 分钟，与引擎采样对齐 */
const MIN = -20;
const MAX = 40;
const STEP = 2;

export function RayMarchCard() {
  const { prediction: p, bundle, query, resolved, scrubMin, setScrub, focusLevel, setFocusLevel, tzOffsetSeconds } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  const hitsRef = useRef<HitRegion[]>([]);

  // ResizeObserver：跟随容器尺寸
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 当前时刻的太阳高度角
  const timeMs = useMemo(() => {
    if (!resolved) return Date.now();
    return resolved.eventMs + scrubMin * 60000;
  }, [resolved, scrubMin]);

  const sun = useMemo(() => {
    if (!query.point) return { altitude: 0, azimuth: 0 };
    return sunPosition(timeMs, query.point.lat, query.point.lon);
  }, [timeMs, query.point]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bundle || size.w === 0 || size.h === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    hitsRef.current = renderSection(ctx, size.w, size.h, {
      bundle,
      model: query.primaryModel,
      timeMs,
      sunAltitudeDeg: sun.altitude,
      observerHeightM: query.observerHeightM,
      focusLevel,
    });
  }, [bundle, size.w, size.h, query.primaryModel, timeMs, sun.altitude, query.observerHeightM, focusLevel]);

  useEffect(() => {
    draw();
  }, [draw]);

  // 交互：悬停显示站点信息
  const onMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: HitRegion | null = null;
    let bestD = 22;
    for (const h of hitsRef.current) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    setHover(best ? { x: best.x, y: best.y, label: best.label } : null);
  };

  const clock = useMemo(() => {
    const d = new Date(timeMs + tzOffsetSeconds * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }, [timeMs, tzOffsetSeconds]);

  const offsetLabel = `${scrubMin >= 0 ? '+' : ''}${scrubMin} min`;
  const sunWord = p?.mode === 'sunrise' ? '日出' : '日落';

  return (
    <Panel
      className="col-span-full xl:col-span-8"
      title="三维光路大气剖面 · Ray-Marching Cross-Section"
      subtitle={
        p
          ? `沿太阳方位角 ${p.sunAzimuthDeg.toFixed(0)}°（${p.tactical.directionLabel}）的 0–500km 垂直剖面。虚线为等压面，黄线为受光层光路，红叉表示被地形切断。`
          : '正在建立光路网格…'
      }
      right={
        <div className="flex items-center gap-2">
          <span className="num hidden rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[10.5px] text-slate-300 sm:block">
            {clock} · {offsetLabel}
          </span>
          <InfoTip text="光路几何 H_ray(d) = H_target + d·tanα + d²/(2·R_eff)，R_eff = 7435km（含标准大气折射）。地形高于光线即判定遮挡。「远端 T」是光线走完 0–450km 后的剩余份额。" />
        </div>
      }
      bodyClass="!pt-1"
    >
      {/* 层选择 */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-slate-500">目标层</span>
        {LEVEL_KEYS.map((k) => {
          const lv = LEVEL_BY_KEY[k];
          const on = k === focusLevel;
          const roleColor =
            lv.role === 'golden' ? '#ffb340' : lv.role === 'high' ? '#c494fc' : lv.role === 'mid' ? '#98b4d2' : '#7e9ebc';
          return (
            <button
              key={k}
              type="button"
              onClick={() => setFocusLevel(k)}
              className="rounded-lg border px-2 py-1 text-[10px] font-medium transition-all"
              style={{
                borderColor: on ? `${roleColor}88` : 'rgba(255,255,255,0.09)',
                background: on ? `${roleColor}22` : 'rgba(255,255,255,0.025)',
                color: on ? roleColor : 'rgba(148,166,190,0.85)',
                boxShadow: on ? `0 0 14px -4px ${roleColor}77` : undefined,
              }}
              title={`${lv.label} · 标称 ${lv.nominalM}m`}
            >
              {lv.hpa}
              <span className="ml-0.5 opacity-55">hPa</span>
            </button>
          );
        })}
      </div>

      {/* Canvas */}
      <div
        ref={wrapRef}
        className="relative h-[248px] w-full overflow-hidden rounded-xl border border-white/[0.07] bg-[#04070e] sm:h-[300px] lg:h-[330px]"
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label="大气垂直剖面与三维太阳光路追踪图"
        />
        {hover && (
          <div
            className="pointer-events-none absolute z-20 max-w-[240px] rounded-lg border border-white/15 bg-[#060a12]/96 px-2 py-1.5 text-[10px] leading-snug text-slate-200 shadow-xl backdrop-blur-md"
            style={{
              left: Math.min(hover.x + 11, size.w - 200),
              top: Math.max(hover.y - 42, 4),
            }}
          >
            {hover.label}
          </div>
        )}
        {!bundle && (
          <div className="absolute inset-0 grid place-items-center text-[11.5px] text-slate-500">
            正在同步气象场…
          </div>
        )}
        {/* 图例 */}
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-lg border border-white/10 bg-black/55 px-2 py-1.5 backdrop-blur-sm">
          {[
            { c: '#ffb340', t: '黄金层' },
            { c: '#c494fc', t: '高空卷云' },
            { c: '#98b4d2', t: '中云' },
            { c: '#5a84a6', t: '地形' },
          ].map((l) => (
            <span key={l.t} className="flex items-center gap-1 text-[9px] text-slate-300">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: l.c }} />
              {l.t}
            </span>
          ))}
        </div>
      </div>

      {/* 时间滑块 */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] text-slate-400">
          <span className="num font-medium">
            日{sunWord}前 20 分
          </span>
          <button
            type="button"
            onClick={() => setScrub(0)}
            className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[9.5px] text-slate-300 transition-colors hover:border-amber-300/40 hover:text-amber-200"
          >
            对齐{sunWord} 00:00
          </button>
          <span className="num font-medium">后 40 分</span>
        </div>
        <input
          type="range"
          className="ag-range mt-0.5"
          min={MIN}
          max={MAX}
          step={STEP}
          value={scrubMin}
          onChange={(e) => setScrub(Number(e.target.value))}
          aria-label="光路时间滑块"
        />
        <div className="num mt-0.5 flex justify-between text-[9px] text-slate-500">
          {[-20, -10, 0, 10, 20, 30, 40].map((t) => (
            <span key={t} className={t === scrubMin ? 'font-bold text-amber-300' : ''}>
              {t > 0 ? `+${t}` : t}
            </span>
          ))}
        </div>
        {p && (
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat label="太阳高度" value={`${sun.altitude >= 0 ? '+' : ''}${sun.altitude.toFixed(2)}°`} />
            <MiniStat label="太阳方位" value={`${sun.azimuth.toFixed(0)}°`} />
            <MiniStat label="观测高度" value={`${query.observerHeightM} m`} />
            <MiniStat
              label="此刻鲜艳度"
              value={(() => {
                const nearest = p.series.reduce(
                  (b, s) => (Math.abs(s.offsetMin - scrubMin) < Math.abs(b.offsetMin - scrubMin) ? s : b),
                  p.series[0],
                );
                return nearest ? nearest.vividness.toFixed(2) : '—';
              })()}
              accent={p.theme.accent}
            />
          </div>
        )}
      </div>
    </Panel>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-[0.11em] text-slate-500">{label}</div>
      <div className="num mt-0.5 text-[12.5px] font-semibold" style={{ color: accent ?? 'rgba(226,236,250,0.92)' }}>
        {value}
      </div>
    </div>
  );
}
