import { useEffect, useRef, useState, type ReactNode } from 'react';

/** 通用卡片：玻璃 + 标题 + 可选的右上角操作区 */
export function Panel({
  title,
  subtitle,
  right,
  children,
  className = '',
  bodyClass = '',
  delay = 0,
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  delay?: number;
}) {
  return (
    <section
      className={`glass animate-fade-up ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {(title || right) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2 sm:px-5 sm:pt-4">
          <div className="min-w-0">
            {title && <h2 className="bento-title">{title}</h2>}
            {subtitle && <p className="mt-1 text-[11px] leading-snug text-slate-400/80 break-anywhere">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className={`px-4 pb-4 sm:px-5 sm:pb-5 ${bodyClass}`}>{children}</div>
    </section>
  );
}

/** 数值 + 单位，强调用 */
export function Metric({
  label,
  value,
  unit,
  hint,
  accent = '#e8eefb',
  size = 'md',
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  accent?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const vs = size === 'lg' ? 'text-2xl sm:text-3xl' : size === 'sm' ? 'text-base' : 'text-xl';
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.13em] text-slate-400/85">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={`num ${vs} font-semibold leading-none`} style={{ color: accent }}>
          {value}
        </span>
        {unit && <span className="text-[11px] font-medium text-slate-400/90">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-[10.5px] leading-tight text-slate-400/70 break-anywhere">{hint}</div>}
    </div>
  );
}

/** 水平进度条（可带峰值标记） */
export function Bar({
  value,
  max = 1,
  color = '#ffb340',
  height = 6,
  track = 'rgba(255,255,255,0.09)',
  markers = [],
  glow = false,
}: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
  track?: string;
  markers?: Array<{ at: number; color: string; label?: string }>;
  glow?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="relative w-full" style={{ height }}>
      <div className="absolute inset-0 overflow-hidden rounded-full" style={{ background: track }}>
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}88, ${color})`,
            boxShadow: glow ? `0 0 12px ${color}99` : undefined,
          }}
        />
      </div>
      {markers.map((m, i) => (
        <div
          key={i}
          className="absolute top-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${Math.max(0, Math.min(1, m.at)) * 100}%`,
            width: 2,
            height: height + 6,
            background: m.color,
            boxShadow: `0 0 6px ${m.color}`,
          }}
          title={m.label}
        />
      ))}
    </div>
  );
}

/** 单点状态灯 */
export function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      {pulse && (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
          style={{ background: color }}
        />
      )}
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

/** 数字滚动（轻量，避免依赖库）。对 rAF 被节流/中断做兜底，永远收敛到目标值。 */
export function AnimatedNumber({
  value,
  digits = 2,
  className = '',
}: {
  value: number;
  digits?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  // 以「当前实际显示值」为动画起点，而不是可能过期的 ref
  const shownRef = useRef(value);
  const rafRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const from = shownRef.current;
    const to = value;
    if (Math.abs(to - from) < 1e-9) {
      setDisplay(to);
      shownRef.current = to;
      return;
    }

    const dur = 620;
    const t0 = performance.now();
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearTimeout(timerRef.current);

    const tick = (now: number) => {
      const t = Math.min((now - t0) / dur, 1);
      const e = 1 - Math.pow(1 - t, 3);
      const v = from + (to - from) * e;
      shownRef.current = v;
      setDisplay(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else shownRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);

    // 兜底：rAF 在后台标签页会被节流甚至暂停，届时直接落定最终值
    timerRef.current = setTimeout(() => {
      cancelAnimationFrame(rafRef.current);
      shownRef.current = to;
      setDisplay(to);
    }, dur + 260);

    return () => {
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return <span className={className}>{display.toFixed(digits)}</span>;
}

/** 分段控制器 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-xl border border-white/10 bg-white/[0.035] p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            title={o.hint}
            className={`relative rounded-[9px] font-medium transition-all duration-200 ${
              size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3.5 py-1.5 text-xs'
            } ${
              active
                ? 'bg-gradient-to-br from-amber-300 to-orange-500 text-[#17120a] shadow-[0_4px_16px_-6px_rgba(255,170,60,0.9)]'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 带 tooltip 的信息点。
 *
 * **默认向下展开**（P1 修复）：卡片头部的 ? 图标离卡片上边缘只有 14px，
 * 向上弹出的气泡必然被裁掉。改成 `top-full right-0` 后气泡落在卡片内部，
 * 不再依赖任何祖先的 overflow 设置。
 *
 * 同时补上 `tabIndex` 与 `group-focus-within`：上一版只响应 hover，
 * 键盘 Tab 与移动端触屏都无法触发。
 */
export function InfoTip({ text, align = 'right' }: { text: string; align?: 'center' | 'right' }) {
  const pos = align === 'right' ? 'right-0 top-full mt-2' : 'left-1/2 top-full mt-2 -translate-x-1/2';
  return (
    <span
      tabIndex={0}
      className="group/tip relative inline-flex cursor-help align-middle focus:outline-none"
    >
      <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-white/20 text-[8px] font-bold leading-none text-slate-400 transition-colors group-hover/tip:border-amber-300/60 group-hover/tip:text-amber-300 group-focus-within/tip:border-amber-300/60 group-focus-within/tip:text-amber-300">
        ?
      </span>
      <span
        className={`pointer-events-none absolute z-50 w-56 rounded-xl border border-white/15 bg-[#0b1120]/98 p-2.5 text-[11px] font-normal normal-case tracking-normal leading-relaxed text-slate-200 opacity-0 shadow-2xl backdrop-blur-xl transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 ${pos}`}
      >
        {text}
      </span>
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton-sweep rounded-lg bg-white/[0.055] ${className}`} />;
}
