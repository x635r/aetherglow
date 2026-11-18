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
 * 垂直云量廓线 —— **横向条形图**，自上而下 200→1000 hPa。
 *
 * 第四轮 NEW-06：上一版是 10 根竖向柱 + 10 个 X 轴等压面标签，
 * 在 `xl:col-span-2` 的窄槽（内容区约 186px）里标签间距只剩 20.2px，
 * 字号被迫压到 7.5px —— 线上实测严重拥挤。
 *
 * 改成横条后：
 *   · 等压面标签在左侧**自上而下一行一个**，永远不会横向挤压
 *   · 条形长度承载云量，色彩承载"受光"，读数对齐到右列
 *   · 行序与《光线追踪剖面图》的垂直轴一致（高在上一行、低在下一行），
 *     两卡并排时可以直接横向对照同一高度层
 */
export function CloudProfileCard({ p }: { p: SunsetPredictionOutput }) {
  // 自上而下：200hPa（最高）→ 1000hPa（最低），与剖面图 Y 轴同序
  const layers = [...LEVEL_KEYS]
    .reverse()
    .map((k) => p.layers.find((l) => l.key === k))
    .filter((l): l is NonNullable<typeof l> => l != null);
  const groundMsl = p.groundElevationM;

  return (
    <Panel
      // `h-full flex flex-col` + body 的 `flex-1`：
      // 让 10 行在竖直方向上均分整张卡片的高度，
      // 与左侧《光线追踪剖面图》的 200→1000hPa 高度轴大致对齐。
      // 上一版固定行高，卡片下半截留出大片空白。
      className="col-span-full xl:col-span-4 h-full flex flex-col"
      title="垂直云量廓线"
      subtitle="200 → 1000hPa · 与剖面同序"
      right={
        <InfoTip
          align="right"
          text="自上而下对应 200hPa（约 12km 卷云）到 1000hPa（近地面）。灰条长度 = 该层云量；彩色亮条 = 太阳穿过远场阻挡后真正照到该层的比例。黄金层（600/500hPa）是火烧云主战场。"
        />
      }
      bodyClass="!pt-0 flex-1 flex flex-col"
    >
      <div className="flex flex-1 flex-col justify-between gap-[3px]">
        {layers.map((l) => {
          const isUnderground = l.altitudeM < groundMsl - 30;
          const coverPct = Math.round(l.cover);
          const transPct = Math.round(l.transmittance * 100);
          const color = ROLE_COLOR[l.role] ?? '#98b4d2';
          const isFocus = l.role === 'golden';
          // 彩色亮条 = 该层「实际被点亮的量」= 云量 × 受光率
          const litPct = Math.round(l.cover * l.transmittance);

          return (
            <div
              key={l.key}
              className={`grid grid-cols-[38px_1fr_42px] items-center gap-1.5 rounded-md px-1 py-[3px] ${
                isFocus ? 'bg-amber-300/[0.06]' : ''
              } ${isUnderground ? 'opacity-30' : ''}`}
              title={`${LEVEL_BY_KEY[l.key].hpa}hPa · ${Math.round(l.altitudeM)}m${
                isUnderground ? ' · 位于地下' : ` · 云量 ${coverPct}% · 受光 ${transPct}%`
              }`}
            >
              {/* 左列：等压面（数值在左、单位在右，等宽对齐） */}
              <div className="num flex items-baseline justify-end gap-0.5 text-[11px] leading-none">
                <span className={isFocus ? 'font-semibold text-amber-200' : 'text-slate-300/85'}>
                  {LEVEL_BY_KEY[l.key].hpa}
                </span>
              </div>

              {/* 中列：双层条（底=云量，亮=受光量） */}
              <div className="relative h-[7px] w-full overflow-hidden rounded-full bg-white/[0.055]">
                {!isUnderground && (
                  <>
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-white/20"
                      style={{ width: `${Math.max(coverPct, coverPct > 0 ? 3 : 0)}%` }}
                    />
                    {litPct > 0 && (
                      <div
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{ width: `${litPct}%`, background: color, opacity: 0.9 }}
                      />
                    )}
                  </>
                )}
              </div>

              {/* 右列：云量 / 受光率 */}
              <div className="num text-right text-[11px] leading-none tabular-nums">
                {isUnderground ? (
                  <span className="text-slate-600">地下</span>
                ) : (
                  <>
                    <span className="text-slate-300/90">{coverPct}</span>
                    <span className="mx-[1px] text-slate-600">/</span>
                    <span style={{ color }}>{transPct}</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[11px] leading-none text-slate-500">
        <span className="num">云量% / 受光%</span>
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

        <p className="mt-2 text-[11px] leading-relaxed text-slate-500 break-anywhere">{s.detail}</p>

        {s.crystal && (
          <div className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-teal-300/30 bg-teal-400/10 px-2 py-1">
            <CrystalIcon />
            {/* 增益必须**动态显示**（P2 修复）：spectral.ts 已改成连续公式，
                实际增益在 ×1.15–×1.27 之间浮动，写死 1.25 会与仪表上的
                真实数值不一致。 */}
            <span className="text-[11px] font-semibold text-teal-200">
              水晶天 · 饱和度 ×{s.saturationGain.toFixed(2)}
            </span>
          </div>
        )}
        {!s.available && (
          <div className="mt-2 flex w-full items-center justify-center rounded-lg border border-amber-300/30 bg-amber-400/10 px-2 py-1">
            <span className="text-[11px] font-semibold text-amber-200">
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
    // 固定像素宽度（而不是 `w-full max-w-[112px]`）。
    //
    // 原因：SVG 的 `fontSize` 是 viewBox 单位，实际渲染字号 =
    // fontSize × (显示宽度 / viewBox 宽度)。上一版用 `w-full` 时，
    // 同一段代码在 92–140px 的容器里渲染出 8–13.7px 的字号 ——
    // 既无法守住 11px 底线，同一张卡内的标签大小还会随窗口变化。
    // 固定 112px 后 viewBox 92 → scale 恒为 1.217：
    // 主数值 14×1.217≈17px、副标签 9×1.217≈11.0px，两者都恰好达标。
    <svg viewBox="0 0 92 74" width={112} height={90} className="shrink-0" role="img" aria-label={`${label} ${display}`}>
      <path d={arcPath(start, start + sweep)} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="5.5" strokeLinecap="round" />
      <path d={arcPath(start, endDeg)} fill="none" stroke={color} strokeWidth="5.5" strokeLinecap="round" opacity="0.92" />
      <circle cx={pt(endDeg).x} cy={pt(endDeg).y} r="2.6" fill="#fff" opacity="0.95" />
      <text x={cx} y={cy + 1} textAnchor="middle" fontSize="14" fontWeight="700" fill="#eef3fb" fontFamily="JetBrains Mono, monospace">
        {display}
      </text>
      {/*
        scale 恒为 1.217（viewBox 92 → 固定展示 112px）：
        fontSize 9 → 实际 11.0px，正好压在底线上。
      */}
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize="9" fill="rgba(160,180,205,0.8)" fontFamily="JetBrains Mono, monospace">
        {label} · {sub}
      </text>
    </svg>
  );
}

function MiniMeter({ label, value, pct, color }: { label: string; value: string; pct: number; color: string }) {
  const p = Math.max(0, Math.min(1, pct));
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
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
      <div className="text-[11px] uppercase tracking-[0.08em] text-slate-500">{label}</div>
      <div className="num text-[11px] font-semibold text-slate-200">
        {value}
        <span className="ml-0.5 text-[11px] font-normal text-slate-500">{unit}</span>
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
