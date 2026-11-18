import { useMemo } from 'react';
import { LEVEL_BY_KEY } from '../../engine/constants';
import type { SunsetPredictionOutput } from '../../engine/types';
import { localClock } from '../../engine/SunsetPhysicsEngine';
import { useStore } from '../../state/store';
import { Bar, InfoTip, Panel } from '../primitives';

const HEIGHT_PRESETS = [
  { v: 0, label: '地面' },
  { v: 300, label: '楼顶' },
  { v: 900, label: '低云上' },
  { v: 1500, label: '云海' },
  { v: 2000, label: '高山' },
];

export function TacticalCard({ p }: { p: SunsetPredictionOutput }) {
  const { query, setObserverHeight, resetObserverHeight } = useStore();
  const h = query.observerHeightM;

  // 低云**底**与低云**顶**是两个不同的高度，不能混用。
  //
  // 上一版取 `min(925hPa, 850hPa)`（≈780m）却把结果叫「低云顶」：
  // 925hPa 是云底参照，850hPa 才是云顶参照。判"机位是否越过云层"
  // 必须比云顶，否则会提示用户"还没越过"而其实早已在云上。
  const lowBase = useMemo(() => {
    const l925 = p.layers.find((l) => l.key === '925')?.altitudeM ?? 780;
    return l925;
  }, [p.layers]);
  const lowTop = useMemo(() => {
    const l850 = p.layers.find((l) => l.key === '850')?.altitudeM ?? 1500;
    return Math.max(lowBase, l850);
  }, [p.layers, lowBase]);

  // **必须用 MSL 比较，不能用 AGL**。
  // 上一版写的是 `h > lowBase`（AGL 对 MSL），于是拉萨这类高原城市
  // （地面 3650m、机位 AGL=0、低云约 780m MSL）会显示「低云之下」，
  // 而实际已高出低云 2870m。引擎内部一直用 MSL，只有这里漏了。
  //
  // 判「机位是否越过云层」必须比**云顶**（审查 P2）：比云底会让
  // 「已在云层中间」显示成「低云之上」，与上面低云底/顶的注释自相矛盾。
  //
  // 阈值必须与引擎的 cloudSea 判定**完全一致**（P1 修复）：
  // 引擎要求 `observerMslM > lowTopM + 120 && lowCoverLocal > 0.4`。
  // 上一版这里只比 lowTop，于是 1550m 机位在 lowTop=1500m 时，
  // 徽章显示「低云之上」而下方提示「尚未越过低云顶」—— 同一张卡片自相矛盾。
  const observerMsl = p.observerHeightM;
  const cloudSeaThresholdM = lowTop + 120;
  const aboveLow = observerMsl > cloudSeaThresholdM;
  // 「云底」只在确实存在低云时才作为判据。
  // 上一版用 `cloudBaseM > 0` —— 但 cloudBaseM 是**任意层**的最低云底
  // （≥20% 覆盖的最低一层，可能是 250hPa 卷云），只有卷云时也为正，
  // 于是「无低云可遮」被误判成「低云之下」（审查 P2）。
  //
  // `cloudBaseM` 也不适合用来写文案：同一张卡片的页脚用 925hPa 报低云底，
  // 若这里用 cloudBaseM，线上实测会出现「仍在云底 10643m 之下」与页脚
  // 「低云底约 811m」并存的自相矛盾。统一用 lowBase（925hPa 参照）。
  const hasLowCloud = useMemo(
    () => p.layers.some((l) => (l.key === '1000' || l.key === '925' || l.key === '850') && l.cover > 5),
    [p.layers],
  );
  const aboveCloudBase = !hasLowCloud || observerMsl > lowBase;

  const clock = localClock(p.timeline.peakMs, p.timezoneOffsetSeconds);

  return (
    <Panel
      className="col-span-full lg:col-span-6 xl:col-span-4"
      title="摄影师机位战术"
      subtitle="改变机位高度会实时重算低云遮挡与云海反转"
      right={<InfoTip text="AGL = Above Ground Level（离地高度）。无人机法规上限通常 120m，本工具支持 0–2000m 用于模拟高山/航拍机位。" />}
    >
      {/* ── 无人机/高山穿云模拟器 ── */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.028] p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <DroneIcon />
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-300">
              机位高度模拟器
            </span>
          </div>
          <button
            type="button"
            onClick={resetObserverHeight}
            className="rounded-md border border-white/10 px-1.5 py-0.5 text-[9.5px] text-slate-400 transition-colors hover:border-amber-300/40 hover:text-amber-200"
          >
            归零
          </button>
        </div>

        <div className="mt-2 flex items-baseline gap-2">
          <span className="num text-2xl font-bold leading-none text-amber-300">{h}</span>
          <span className="text-[11px] text-slate-400">m AGL</span>
          {p.groundElevationM > 1 && (
            <span className="num text-[9.5px] text-slate-500">
              → {Math.round(p.observerHeightM)}m MSL
            </span>
          )}
          <span
            className="ml-auto rounded-md px-1.5 py-0.5 text-[9.5px] font-medium"
            style={{
              background: aboveLow ? 'rgba(56,232,208,0.14)' : 'rgba(255,179,64,0.13)',
              color: aboveLow ? '#38e8d0' : '#ffb340',
            }}
          >
            {aboveLow ? '低云之上' : '低云之下'}
          </span>
        </div>

        <input
          type="range"
          className="ag-range mt-1.5"
          min={0}
          max={2000}
          step={10}
          value={h}
          onChange={(e) => setObserverHeight(Number(e.target.value))}
          aria-label="机位高度"
        />
        <div className="flex justify-between px-0.5">
          {HEIGHT_PRESETS.map((pr) => (
            <button
              key={pr.v}
              type="button"
              onClick={() => setObserverHeight(pr.v)}
              className={`text-[9px] transition-colors ${
                Math.abs(h - pr.v) <= 30 ? 'font-bold text-amber-300' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {pr.v}
            </button>
          ))}
        </div>

        {/* 状态判定 */}
        <div className="mt-2.5 space-y-1 text-[10.5px] leading-snug">
          {hasLowCloud ? (
            <StatusLine
              ok={aboveCloudBase}
              text={
                aboveCloudBase
                  ? `已升至低云底 ${Math.round(lowBase)}m 之上，视野越过低云`
                  : `仍在低云底 ${Math.round(lowBase)}m 之下，可能被低云遮挡`
              }
            />
          ) : (
            <StatusLine ok text="当前无显著低云，机位高度主要影响地平线视角，不改变云幕受光" />
          )}
          {p.cloudSeaReversal && (
            <StatusLine
              ok
              text={`云海反转生效：低云已成为脚下反射幕布（+${p.cloudSeaBonus.toFixed(2)} 鲜艳度）`}
              accent="#38e8d0"
            />
          )}
          {/* 「云海还没形成」有两种完全不同的物理原因，必须分开说（P1 修复）。
              上一版只判 `h >= 900`，于是把 2000m 机位（早已高于云顶）
              也提示成「尚未越过低云顶」，与右上角「低云之上」徽章直接矛盾。
              场景 A：机位确实还在云顶安全高度以下 → 该继续抬
              场景 B：机位已越过云顶，但低云覆盖不足 40% → 抬也没用 */}
          {hasLowCloud && !p.cloudSeaReversal && h >= 300 && (
            observerMsl <= cloudSeaThresholdM ? (
              <StatusLine
                ok={false}
                text={`尚未越过低云顶安全高度（约 ${Math.round(cloudSeaThresholdM)}m MSL = 850hPa 云顶 + 120m 余量），继续抬高可越过低云`}
                accent="#8ea0b8"
              />
            ) : (
              <StatusLine
                ok={false}
                text="已越过低云顶，但低云覆盖率不足 40%，未形成连续云海反射幕"
                accent="#8ea0b8"
              />
            )
          )}
        </div>
      </div>

      {/* ── 焦段与方位 ── */}
      <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.028] p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">建议焦段</div>
            <div className="mt-1 font-display text-[15px] font-semibold text-slate-100">{p.tactical.focalLength}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">拍摄朝向</div>
            <div className="num mt-1 text-[13px] font-semibold text-amber-200">{p.tactical.directionLabel}</div>
          </div>
        </div>
        <p className="mt-2 text-[10.5px] leading-relaxed text-slate-400 break-anywhere">{p.tactical.focalReason}</p>
        <div className="mt-2.5 flex items-center gap-2">
          <CompassRose deg={p.tactical.directionDeg} />
          <div className="min-w-0 flex-1 space-y-0.5 text-[10px] text-slate-400">
            <div className="truncate">{p.tactical.exposureHint}</div>
            <div className="truncate">{p.tactical.compositionHint}</div>
          </div>
        </div>
      </div>

      {/* ── 丁达尔 ── */}
      <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.028] p-3">
        <div className="flex items-center justify-between">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            丁达尔光 / 霞光道
          </span>
          <span
            className="num text-[13px] font-bold"
            style={{ color: p.tactical.godRayProbability > 0.5 ? '#ffd68a' : '#8ea0b8' }}
          >
            {Math.round(p.tactical.godRayProbability * 100)}%
          </span>
        </div>
        <div className="mt-1.5">
          <Bar value={p.tactical.godRayProbability} max={1} color="#ffd68a" height={5} glow={p.tactical.godRayProbability > 0.5} />
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400 break-anywhere">{p.tactical.godRayNote}</p>
      </div>

      {/* ── 顶部时间线摘要 ── */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <TimeChip label="最佳时刻" value={clock} accent />
        <TimeChip label="曝光" value={gradeExposure(p)} />
        <TimeChip label="ISO" value={p.spectral.aod > 0.5 ? '100 · 去雾' : '100 · 长曝'} />
      </div>
      <div className="mt-2 flex items-start gap-1.5 text-[10px] leading-snug text-slate-500">
        <span className="mt-0.5 shrink-0 text-amber-300/70">※</span>
        <span className="break-anywhere">
          {p.tactical.isoHint} 低云底约 {Math.round(lowBase)}m（925hPa）、云顶约 {Math.round(lowTop)}m（850hPa）。
        </span>
      </div>
    </Panel>
  );
}

function gradeExposure(p: SunsetPredictionOutput): string {
  if (p.grade === 'none' || p.grade === 'faint') return '−0.7 EV';
  if (p.grade === 'major' || p.grade === 'extreme' || p.grade === 'epic') return '−1.3 EV · 包围';
  return '−1.0 EV';
}

function StatusLine({ ok, text, accent }: { ok: boolean; text: string; accent?: string }) {
  const color = accent ?? (ok ? '#38e8d0' : '#ffb340');
  return (
    <div className="flex items-start gap-1.5">
      <span
        className="mt-[3px] grid h-3 w-3 shrink-0 place-items-center rounded-full text-[7px] font-bold"
        style={{ background: `${color}22`, color }}
      >
        {ok ? '✓' : '!'}
      </span>
      <span className="text-slate-400 break-anywhere">{text}</span>
    </div>
  );
}

/** 简易罗盘 */
function CompassRose({ deg }: { deg: number }) {
  return (
    <div className="relative grid h-16 w-16 shrink-0 place-items-center">
      <svg viewBox="0 0 64 64" className="absolute inset-0">
        <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
        <circle cx="32" cy="32" r="20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        {[0, 90, 180, 270].map((a) => {
          const rad = ((a - 90) * Math.PI) / 180;
          return (
            <line
              key={a}
              x1={32 + Math.cos(rad) * 24}
              y1={32 + Math.sin(rad) * 24}
              x2={32 + Math.cos(rad) * 28}
              y2={32 + Math.sin(rad) * 28}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth="1.2"
            />
          );
        })}
        {/* 太阳方向扇形 */}
        <g transform={`rotate(${deg} 32 32)`}>
          <path d="M32 32 L32 8 A24 24 0 0 1 45 12 Z" fill="rgba(255,179,64,0.20)" />
          <line x1="32" y1="32" x2="32" y2="6" stroke="#ffb340" strokeWidth="2" strokeLinecap="round" />
          <circle cx="32" cy="7" r="2.6" fill="#ffd68a" />
        </g>
        <circle cx="32" cy="32" r="1.8" fill="rgba(255,255,255,0.5)" />
      </svg>
      <span className="absolute -top-0.5 text-[7px] font-bold text-slate-500">N</span>
    </div>
  );
}

function TimeChip({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className="rounded-lg border px-2 py-1.5"
      style={{
        borderColor: accent ? 'rgba(255,179,64,0.35)' : 'rgba(255,255,255,0.07)',
        background: accent ? 'rgba(255,179,64,0.09)' : 'rgba(255,255,255,0.025)',
      }}
    >
      <div className="text-[8.5px] uppercase tracking-[0.1em] text-slate-500">{label}</div>
      <div className="num mt-0.5 truncate text-[11px] font-semibold" style={{ color: accent ? '#ffd68a' : 'rgba(226,236,250,0.9)' }}>
        {value}
      </div>
    </div>
  );
}

function DroneIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-amber-300/80" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="6" y="6" width="4" height="4" rx="1" />
      <path d="M6 6 3.5 3.5M10 6l2.5-2.5M6 10l-2.5 2.5M10 10l2.5 2.5" />
      <circle cx="3" cy="3" r="1.6" />
      <circle cx="13" cy="3" r="1.6" />
      <circle cx="3" cy="13" r="1.6" />
      <circle cx="13" cy="13" r="1.6" />
    </svg>
  );
}
