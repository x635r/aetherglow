import { useEffect, useMemo, useRef } from 'react';
import { GRADE_THEME, VIVIDNESS_CEILING } from '../../engine/constants';
import type { SunsetPredictionOutput } from '../../engine/types';
import { localClock } from '../../engine/SunsetPhysicsEngine';
import { AnimatedNumber, Bar, InfoTip } from '../primitives';

const GRADE_ORDER = ['none', 'faint', 'minor', 'moderate', 'major', 'extreme', 'epic'] as const;

export function HeroScore({ p }: { p: SunsetPredictionOutput }) {
  const theme = p.theme;
  const key = theme.key;
  const idx = GRADE_ORDER.indexOf(key);

  const clock = localClock(p.timeline.peakMs, p.timezoneOffsetSeconds);
  const eventClock = localClock(p.eventMs, p.timezoneOffsetSeconds);

  const sunLabel = p.mode === 'sunset' ? '日落' : '日出';

  // 边界：鲜艳度进度（分母统一用 VIVIDNESS_CEILING，与其余卡片一致）
  const vividPct = Math.min(p.vividness / VIVIDNESS_CEILING, 1);
  const scorePct = p.score / 100;

  return (
    <div className="glass relative overflow-hidden min-h-[268px] sm:min-h-[300px]">
      {/* 流体渐变背景 */}
      <FluidBackdrop theme={key} accent={theme.accent} />

      <div className="relative z-10 flex h-full flex-col justify-between p-4 sm:p-6">
        {/* 顶部：地点 / 时间 */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
                {p.mode === 'sunset' ? 'SUNSET FORECAST' : 'SUNRISE FORECAST'}
              </span>
              <span className="rounded-full border border-white/20 bg-black/25 px-2 py-0.5 text-[9.5px] font-medium tracking-wide text-white/70">
                {p.primaryModel === 'ecmwf' ? 'ECMWF 主源' : p.primaryModel === 'gfs' ? 'GFS 主源' : 'ICON 主源'}
              </span>
            </div>
            <h1 className="mt-1.5 truncate font-display text-lg font-semibold tracking-tight text-white/95 sm:text-xl">
              {p.locationLabel}
            </h1>
            <p className="num mt-1 text-[11px] text-white/55">
              {p.eventExists ? (
                <>{sunLabel} {eventClock} · 峰值 {clock} · {theme.toneName}</>
              ) : (
                <span className="text-amber-200/90">
                  本日无{sunLabel}（极昼 / 极夜）· 以下数值为兜底结果，不可作为拍摄依据
                </span>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <ConfidenceBadge value={p.confidence} uncertainty={p.uncertainty} completeness={p.completeness} />
            {p.veto.active && (
              <span className="flex max-w-[220px] items-center gap-1.5 rounded-lg border border-rose-400/35 bg-rose-950/45 px-2 py-1 text-[10px] leading-tight text-rose-200">
                <WarnIcon />
                <span className="truncate">{p.veto.title}</span>
              </span>
            )}
          </div>
        </div>

        {/* 主数值 */}
        <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">
              鲜艳度指数
              <InfoTip text="Vividness Index 0.00–1.60+（当前数据模型的可达上限约 1.15）。由受光云幕质量 × 晨昏辉光 × 光谱饱和度 × 光路透过率积分得到，对齐 SunsetBot 行业分级。" />
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span
                className="num text-[52px] font-bold leading-[0.86] tracking-tight sm:text-[68px]"
                style={{ color: theme.text, textShadow: `0 0 42px ${theme.accent}66` }}
              >
                <AnimatedNumber value={p.vividness} digits={2} />
              </span>
              <span className="num pb-1.5 text-sm font-medium text-white/45">/ {VIVIDNESS_CEILING.toFixed(2)}</span>
            </div>

            <div className="mt-2.5 w-[190px] sm:w-[250px]">
              <Bar value={vividPct} max={1} color={theme.accent} height={7} glow />
              <div className="mt-1.5 flex justify-between text-[9px] text-white/40">
                {['无', '微', '中', '大', '世纪'].map((t, i) => (
                  <span key={t} className={i === 0 || i === 4 ? '' : 'hidden sm:inline'}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-end gap-6">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">综合评分</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="num text-3xl font-semibold leading-none text-white sm:text-4xl">
                  <AnimatedNumber value={p.score} digits={0} />
                </span>
                <span className="text-xs text-white/45">/100</span>
              </div>
              <div className="mt-1.5 w-20">
                <Bar value={scorePct} max={1} color="rgba(255,255,255,0.85)" height={4} />
              </div>
            </div>

            <div>
              <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">
                会烧概率
                <InfoTip text="P(会烧)：达到「小烧」及以上的估计概率。与下方「若烧多强」是两个独立的头 —— 把二者压进一个分数，会让「高概率小烧」和「低概率大烧」无法区分。当前为未校准估计（calibration=0）。" />
              </div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="num text-2xl font-semibold leading-none text-white sm:text-3xl">
                  {Math.round(p.dual.burnProbability * 100)}
                </span>
                <span className="text-xs text-white/45">%</span>
                <span
                  className="ml-1 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                  style={{
                    background:
                      p.dual.advisory === 'go'
                        ? 'rgba(56,232,208,0.20)'
                        : p.dual.advisory === 'watch'
                          ? 'rgba(255,179,64,0.20)'
                          : 'rgba(255,255,255,0.10)',
                    color:
                      p.dual.advisory === 'go' ? '#38e8d0' : p.dual.advisory === 'watch' ? '#ffb340' : 'rgba(255,255,255,0.55)',
                  }}
                >
                  {p.dual.advisory === 'go' ? '值得去' : p.dual.advisory === 'watch' ? '可观察' : '不建议'}
                </span>
              </div>
              <div className="mt-1.5 w-20">
                <Bar value={p.dual.burnProbability} max={1} color="rgba(255,255,255,0.55)" height={3} />
              </div>
              {p.dual.ensemble && (
                <div
                  className="num mt-1 text-[9px] leading-tight text-white/45"
                  title={`集合预报：ECMWF ${p.dual.ensemble.members} 个扰动成员中，${Math.round(
                    p.dual.ensemble.probability * 100,
                  )}% 落在「能烧」区间。成员强度 p10/p50/p90 = ${p.dual.ensemble.p10.toFixed(
                    2,
                  )} / ${p.dual.ensemble.p50.toFixed(2)} / ${p.dual.ensemble.p90.toFixed(
                    2,
                  )}。成员峰值时刻分散在 ${p.dual.ensemble.peakOffsetP10}~${p.dual.ensemble.peakOffsetP90} 分钟（中位 ${p.dual.ensemble.peakOffsetP50}）—— 分散越窄说明时间窗越确定。`}
                >
                  集合 {Math.round(p.dual.ensemble.probability * 100)}% · n={p.dual.ensemble.members}
                  <br />
                  峰值 {p.dual.ensemble.peakOffsetP50 >= 0 ? '+' : ''}
                  {p.dual.ensemble.peakOffsetP50}′
                  <span className="text-white/30">
                    {' '}
                    ({p.dual.ensemble.peakOffsetP10 >= 0 ? '+' : ''}
                    {p.dual.ensemble.peakOffsetP10}~{p.dual.ensemble.peakOffsetP90 >= 0 ? '+' : ''}
                    {p.dual.ensemble.peakOffsetP90})
                  </span>
                </div>
              )}
            </div>

            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">等级</div>
              <div
                className="mt-1 inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[15px] font-bold leading-none"
                style={{
                  borderColor: `${theme.accent}66`,
                  background: `${theme.accent}1f`,
                  color: theme.text,
                }}
              >
                {p.gradeLabel}
                <span className="text-[9px] font-medium uppercase tracking-wider opacity-65">{p.gradeEn}</span>
              </div>
              <div className="mt-1.5 flex gap-0.5">
                {GRADE_ORDER.map((g, i) => (
                  <span
                    key={g}
                    className="h-1 w-3.5 rounded-full transition-all"
                    style={{
                      background: i <= idx ? theme.accent : 'rgba(255,255,255,0.16)',
                      boxShadow: i === idx ? `0 0 8px ${theme.accent}` : undefined,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 底部：关键几何 */}
        <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/10 pt-3 sm:grid-cols-4">
          <HeroStat label={`${sunLabel}方位角`} value={`${p.sunAzimuthDeg.toFixed(0)}°`} sub={compass(p.sunAzimuthDeg)} />
          <HeroStat label="峰值太阳高度" value={`${p.sunAltitudeDeg >= 0 ? '+' : ''}${p.sunAltitudeDeg.toFixed(1)}°`} sub={stageName(p.sunAltitudeDeg)} />
          <HeroStat
            label="二烧概率"
            value={`${Math.round(p.timeline.afterglowProbability * 100)}%`}
            sub={afterglowRange(p.timeline.afterglowWindow.fromMin, p.timeline.afterglowWindow.toMin)}
          />
          <HeroStat
            label="持续时长"
            value={p.timeline.durationMin > 0 ? `${p.timeline.durationMin}` : '—'}
            sub={p.timeline.durationMin > 0 ? '分钟（可拍窗口）' : '无有效窗口'}
          />
        </div>
      </div>
    </div>
  );
}

function HeroStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[9.5px] font-medium uppercase tracking-[0.12em] text-white/45">{label}</div>
      <div className="num mt-0.5 text-[15px] font-semibold leading-tight text-white/92">{value}</div>
      {sub && <div className="truncate text-[9.5px] text-white/40">{sub}</div>}
    </div>
  );
}

function ConfidenceBadge({
  value,
  uncertainty,
  completeness,
}: {
  value: number;
  uncertainty: number;
  completeness: number;
}) {
  const pct = Math.round(value * 100);
  const color = pct >= 75 ? '#38e8d0' : pct >= 50 ? '#ffb340' : '#ff6b6b';
  const ringLen = 2 * Math.PI * 11;
  // 完整度低于 0.7 时明确提示"数据不全"，避免用户把低置信误读成"预报不稳定"
  const dataWarning = completeness < 0.7;
  return (
    <div
      className="flex items-center gap-2 rounded-xl border border-white/12 bg-black/25 px-2.5 py-1.5 backdrop-blur-sm"
      title={`置信度 = 数据完整度(${(completeness * 100).toFixed(0)}%) × (1 − 0.55·模型分歧(${(uncertainty * 100).toFixed(0)}%))`}
    >
      <div className="relative grid h-6 w-6 place-items-center">
        <svg viewBox="0 0 26 26" className="absolute inset-0 -rotate-90">
          <circle cx="13" cy="13" r="11" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2.4" />
          <circle
            cx="13"
            cy="13"
            r="11"
            fill="none"
            stroke={color}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray={ringLen}
            strokeDashoffset={ringLen * (1 - value)}
            style={{ transition: 'stroke-dashoffset .7s cubic-bezier(.22,1,.36,1)' }}
          />
        </svg>
        <span className="num relative text-[8.5px] font-bold" style={{ color }}>
          {pct}
        </span>
      </div>
      <div className="leading-none">
        <div className="text-[8.5px] font-semibold uppercase tracking-[0.1em] text-white/50">置信度</div>
        <div className="num mt-0.5 text-[10px] font-medium text-white/80">
          {dataWarning ? `数据仅 ${(completeness * 100).toFixed(0)}%` : `分歧 ${(uncertainty * 100).toFixed(0)}%`}
        </div>
      </div>
    </div>
  );
}

/** 动态流体背景：用 CSS radial gradient 叠三层 + 位移动画 */
function FluidBackdrop({ theme, accent }: { theme: string; accent: string }) {
  const t = GRADE_THEME[theme as keyof typeof GRADE_THEME] ?? GRADE_THEME.none;
  const ref = useRef<HTMLDivElement>(null);

  // 跟随鼠标轻微视差（桌面端）
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(pointer: coarse)').matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        el.style.setProperty('--mx', `${x * 18}px`);
        el.style.setProperty('--my', `${y * 14}px`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 overflow-hidden" style={{ background: `linear-gradient(150deg, ${t.from}, ${t.via} 45%, ${t.to})` }}>
      <div
        className="absolute -left-[18%] -top-[32%] h-[86%] w-[62%] rounded-full opacity-70 blur-[52px] animate-drift"
        style={{ background: `radial-gradient(circle, ${accent}cc, transparent 68%)`, transform: 'translate(var(--mx,0), var(--my,0))' }}
      />
      <div
        className="absolute -bottom-[42%] right-[-14%] h-[96%] w-[56%] rounded-full opacity-55 blur-[58px] animate-drift"
        style={{
          background: `radial-gradient(circle, ${t.to}ee, transparent 66%)`,
          animationDelay: '-7s',
          transform: 'translate(calc(var(--mx,0) * -1), calc(var(--my,0) * -1))',
        }}
      />
      <div
        className="absolute left-[38%] top-[16%] h-[46%] w-[40%] rounded-full opacity-40 blur-[46px] animate-drift"
        style={{ background: `radial-gradient(circle, #ffffff55, transparent 70%)`, animationDelay: '-13s' }}
      />
      {/* 暗角，保证文字可读 */}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 100% at 50% 0%, transparent 32%, rgba(3,5,11,0.55) 88%)' }} />
      <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(3,5,11,0.6), transparent 55%)' }} />
      {/* 微网格纹理 */}
      <div
        className="absolute inset-0 opacity-[0.09]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '42px 42px',
          maskImage: 'radial-gradient(120% 90% at 20% 10%, black, transparent 72%)',
          WebkitMaskImage: 'radial-gradient(120% 90% at 20% 10%, black, transparent 72%)',
        }}
      />
    </div>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 14 14" className="h-3 w-3 shrink-0" fill="currentColor">
      <path d="M7 1.2 13.2 12H.8L7 1.2Zm0 3.1a.62.62 0 0 0-.62.66l.16 3.2a.46.46 0 0 0 .92 0l.16-3.2A.62.62 0 0 0 7 4.3Zm0 4.6a.72.72 0 1 0 0 1.44.72.72 0 0 0 0-1.44Z" />
    </svg>
  );
}

function compass(deg: number): string {
  const n = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return n[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * 二烧窗口显示。分钟偏移可能为负（窗口起点早于日落），
 * 需要逐项加符号，不能只在整个区间前加一个 "+"。
 */
function afterglowRange(fromMin: number, toMin: number): string {
  const f = fromMin > 0 ? `+${fromMin}` : `${fromMin}`;
  const t = toMin > 0 ? `+${toMin}` : `${toMin}`;
  return `${f}~${t} min`;
}

function stageName(a: number): string {
  if (a > 6) return '日光';
  if (a > 2) return '金色时刻';
  if (a > -1) return '地平线一烧';
  if (a > -3) return '绯红高峰';
  if (a > -6) return '紫霞二烧';
  if (a > -10) return '天边余晖';
  return '蓝调时刻';
}

export function useHeroMemo(p: SunsetPredictionOutput) {
  return useMemo(() => ({ vividPct: Math.min(p.vividness / VIVIDNESS_CEILING, 1) }), [p.vividness]);
}
