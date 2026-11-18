import { LEVEL_BY_KEY, LEVEL_KEYS } from '../../engine/constants';
import type { SunsetPredictionOutput } from '../../engine/types';
import { InfoTip, Panel } from '../primitives';

const ROLE_COLOR: Record<string, string> = {
  golden: '#ffb340',
  high: '#c494fc',
  mid: '#98b4d2',
  low: '#7e9ebc',
};

/**
 * 垂直云量柱状剖面 —— 用纯 SVG 绘制，控制精确、无依赖、响应式。
 * 每根柱子由双层构成：底=总云量，顶（高亮）=受光比例。
 */
export function CloudProfileCard({ p }: { p: SunsetPredictionOutput }) {
  const layers = LEVEL_KEYS.map((k) => p.layers.find((l) => l.key === k)!);
  const maxAlt = Math.max(...layers.map((l) => l.altitudeM), 12000);

  const W = 240;
  const H = 168;
  const padL = 30;
  const padB = 22;
  const padT = 10;
  const plotH = H - padB - padT;
  const barW = (W - padL - 8) / layers.length - 6;

  const yOf = (altM: number) => padT + plotH - (altM / maxAlt) * plotH;

  return (
    <Panel
      className="col-span-full sm:col-span-6 lg:col-span-3 xl:col-span-2"
      title="垂直云层剖面"
      subtitle="1000 → 200hPa"
      right={<InfoTip text="柱高 = 该等压面位势高度；柱宽/填充 = 云量；高亮部分 = 此刻处于受光面的比例。黄金层（600/500hPa）是火烧云主战场。" />}
      bodyClass="!pt-0"
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }} role="img" aria-label="垂直云量剖面">
        <defs>
          {Object.entries(ROLE_COLOR).map(([role, color]) => (
            <linearGradient key={role} id={`cg-${role}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.92" />
              <stop offset="1" stopColor={color} stopOpacity="0.22" />
            </linearGradient>
          ))}
        </defs>

        {/* 高度网格 */}
        {[0, 3000, 6000, 9000, 12000].map((alt) => {
          const y = yOf(alt);
          if (y < padT - 1) return null;
          return (
            <g key={alt}>
              <line x1={padL} y1={y} x2={W - 6} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              <text x={padL - 4} y={y + 2.5} textAnchor="end" fontSize="6.5" fill="rgba(150,170,195,0.75)" fontFamily="JetBrains Mono, monospace">
                {alt / 1000}
              </text>
            </g>
          );
        })}

        {layers.map((l, i) => {
          const x = padL + i * ((W - padL - 8) / layers.length) + 3;
          const baseY = padT + plotH;
          const topY = yOf(l.altitudeM);
          const hTotal = baseY - topY;
          const cov = Math.max(0.04, l.cover / 100);
          const bw = barW * (0.42 + cov * 0.58);
          const bx = x + (barW - bw) / 2;
          const color = ROLE_COLOR[l.role] ?? '#98b4d2';
          // 受光部分高度
          const litH = hTotal * Math.min(1, l.transmittance * (l.quality > 0 ? 1 : 0.4));
          const isFocus = l.role === 'golden';

          return (
            <g key={l.key}>
              {/* 云柱底 */}
              <rect
                x={bx}
                y={topY}
                width={bw}
                height={Math.max(hTotal, 1)}
                rx="2"
                fill={`url(#cg-${l.role})`}
                opacity={0.28 + cov * 0.5}
              />
              {/* 受光层高亮 */}
              {litH > 0.5 && (
                <rect
                  x={bx}
                  y={baseY - litH}
                  width={bw}
                  height={litH}
                  rx="2"
                  fill={color}
                  opacity={0.32 + l.quality * 0.5}
                />
              )}
              {/* 轮廓 */}
              <rect
                x={bx}
                y={topY}
                width={bw}
                height={Math.max(hTotal, 1)}
                rx="2"
                fill="none"
                stroke={color}
                strokeWidth={isFocus ? 1.2 : 0.7}
                opacity={0.55}
              />
              {/* 云量数值 */}
              <text
                x={bx + bw / 2}
                y={baseY + 9}
                textAnchor="middle"
                fontSize="7"
                fontFamily="JetBrains Mono, monospace"
                fill={cov > 0.3 ? color : 'rgba(130,148,170,0.7)'}
                fontWeight={isFocus ? 700 : 500}
              >
                {Math.round(l.cover)}
              </text>
              {/* 层名 */}
              <text
                x={bx + bw / 2}
                y={baseY + 18}
                textAnchor="middle"
                fontSize="6.5"
                fontFamily="JetBrains Mono, monospace"
                fill={isFocus ? 'rgba(255,214,150,0.9)' : 'rgba(126,146,172,0.75)'}
              >
                {LEVEL_BY_KEY[l.key].hpa}
              </text>
            </g>
          );
        })}

        {/* 观测者高度标记 */}
        {p.observerHeightM > 0 && p.observerHeightM < maxAlt && (
          <g>
            <line
              x1={padL}
              y1={yOf(p.observerHeightM)}
              x2={W - 6}
              y2={yOf(p.observerHeightM)}
              stroke="#38e8d0"
              strokeWidth="1.1"
              strokeDasharray="3 2"
            />
            <text x={W - 7} y={yOf(p.observerHeightM) - 3} textAnchor="end" fontSize="6.5" fill="#38e8d0" fontFamily="JetBrains Mono, monospace">
              {Math.round(p.observerHeightM)}m
            </text>
          </g>
        )}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[8.5px] text-slate-500">
        <span>km</span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> 黄金层
        </span>
      </div>
    </Panel>
  );
}

/**
 * AOD / 通透度仪表 —— 半环仪表盘（SVG）。
 */
export function AerosolGauge({ p }: { p: SunsetPredictionOutput }) {
  const s = p.spectral;
  const aodMax = 1.0;
  const aodPct = Math.min(s.aod / aodMax, 1);
  const visMax = 40;
  const visPct = Math.min(s.visibilityKm / visMax, 1);

  const toneColor =
    s.tone === 'crystal' ? '#38e8d0' : s.tone === 'clean' ? '#7dd3fc' : s.tone === 'dusty' ? '#e0a45c' : s.tone === 'hazy' ? '#ff6b6b' : '#a8bbd4';

  return (
    <Panel
      className="col-span-full sm:col-span-6 lg:col-span-3 xl:col-span-2"
      title="CAMS 光谱消光"
      subtitle={`${s.toneLabel} · AOD ${s.aod.toFixed(2)}`}
      right={<InfoTip text="AOD（550nm 气溶胶光学厚度）主导色彩饱和度：低 AOD + 高能见度 = 瑞利主导的纯净绯红；高 AOD + 高湿 = 米氏散射洗白。饱和度增益与浑浊惩罚直接乘入鲜艳度。" />}
      bodyClass="!pt-0"
    >
      <div className="flex flex-col items-center">
        <GaugeSvg value={aodPct} color={toneColor} label="AOD" display={s.aod.toFixed(2)} sub="550nm" />

        <div className="mt-1 w-full space-y-1.5">
          <MiniMeter label="能见度" value={`${s.visibilityKm.toFixed(0)} km`} pct={visPct} color="#7dd3fc" />
          <MiniMeter label="饱和度增益" value={`×${s.saturationGain.toFixed(2)}`} pct={(s.saturationGain - 0.3) / 1.05} color="#ffb340" />
          <MiniMeter label="浑浊惩罚" value={`${Math.round((1 - s.hazePenalty) * 100)}%`} pct={1 - s.hazePenalty} color="#ff6b6b" />
        </div>

        <div className="mt-2 grid w-full grid-cols-2 gap-1.5">
          <PairStat label="PM2.5" value={`${s.pm25.toFixed(0)}`} unit="µg/m³" />
          <PairStat label="湿度" value={`${s.humidity.toFixed(0)}`} unit="%" />
          <PairStat
            label="臭氧"
            value={`${s.ozoneDu.toFixed(0)}`}
            unit={s.ozoneMeasured ? 'DU' : 'DU (气候值)'}
          />
        </div>

        <p className="mt-2 text-[9.5px] leading-relaxed text-slate-500 break-anywhere">{s.detail}</p>

        {s.crystal && (
          <div className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-teal-300/30 bg-teal-400/10 px-2 py-1">
            <CrystalIcon />
            {/* 增益必须**动态显示**（P2 修复）：spectral.ts 已改成连续公式，
                实际增益在 ×1.15–×1.27 之间浮动，写死 1.25 会与仪表上的
                真实数值不一致。 */}
            <span className="text-[10px] font-semibold text-teal-200">
              水晶天 · 饱和度 ×{s.saturationGain.toFixed(2)}
            </span>
          </div>
        )}
        {!s.available && (
          <div className="mt-2 flex w-full items-center justify-center rounded-lg border border-amber-300/30 bg-amber-400/10 px-2 py-1">
            <span className="text-[10px] font-semibold text-amber-200">
              气溶胶缺测 · 按气候学中值保守估计
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}

function GaugeSvg({
  value,
  color,
  label,
  display,
  sub,
}: {
  value: number;
  color: string;
  label: string;
  display: string;
  sub: string;
}) {
  // 240° 弧
  const R = 34;
  const cx = 46;
  const cy = 44;
  const start = 150;
  const sweep = 240;
  const rad = (d: number) => (d * Math.PI) / 180;
  const pt = (deg: number) => ({
    x: cx + Math.cos(rad(deg)) * R,
    y: cy + Math.sin(rad(deg)) * R,
  });
  const arcPath = (fromDeg: number, toDeg: number) => {
    const a = pt(fromDeg);
    const b = pt(toDeg);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
  };

  const endDeg = start + sweep * Math.max(0.001, Math.min(1, value));

  return (
    <svg viewBox="0 0 92 74" className="w-full max-w-[112px]" role="img" aria-label={`${label} ${display}`}>
      <path d={arcPath(start, start + sweep)} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="5.5" strokeLinecap="round" />
      <path d={arcPath(start, endDeg)} fill="none" stroke={color} strokeWidth="5.5" strokeLinecap="round" opacity="0.92" />
      <circle cx={pt(endDeg).x} cy={pt(endDeg).y} r="2.6" fill="#fff" opacity="0.95" />
      <text x={cx} y={cy + 1} textAnchor="middle" fontSize="14" fontWeight="700" fill="#eef3fb" fontFamily="JetBrains Mono, monospace">
        {display}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize="6.5" fill="rgba(160,180,205,0.8)" fontFamily="JetBrains Mono, monospace">
        {label} · {sub}
      </text>
    </svg>
  );
}

function MiniMeter({ label, value, pct, color }: { label: string; value: string; pct: number; color: string }) {
  const p = Math.max(0, Math.min(1, pct));
  return (
    <div>
      <div className="flex items-baseline justify-between text-[9px]">
        <span className="text-slate-500">{label}</span>
        <span className="num font-semibold text-slate-300">{value}</span>
      </div>
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${p * 100}%`, background: color }} />
      </div>
    </div>
  );
}

function PairStat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-md border border-white/[0.07] bg-white/[0.025] px-1.5 py-1">
      <div className="text-[8px] uppercase tracking-[0.08em] text-slate-500">{label}</div>
      <div className="num text-[11px] font-semibold text-slate-200">
        {value}
        <span className="ml-0.5 text-[7.5px] font-normal text-slate-500">{unit}</span>
      </div>
    </div>
  );
}

function CrystalIcon() {
  return (
    <svg viewBox="0 0 14 14" className="h-3 w-3 shrink-0 text-teal-300" fill="none" stroke="currentColor" strokeWidth="1.1">
      <path d="M7 1v12M2 4l10 6M12 4 2 10" />
      <circle cx="7" cy="7" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
