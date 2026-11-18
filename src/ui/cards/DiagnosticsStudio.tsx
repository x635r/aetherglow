import { useState } from 'react';
import type { SunsetPredictionOutput } from '../../engine/types';
import type { ModelId } from '../../engine/types';
import { InfoTip } from '../primitives';
import { DiagnosticsCard } from './DiagnosticsCard';
import { MultiModelCard } from './MultiModelCard';
import { AerosolGauge } from './CloudProfileCard';

type TabKey = 'spectrum' | 'factors' | 'models';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'spectrum', label: '光谱与色温' },
  { key: 'factors', label: '物理拆解' },
  { key: 'models', label: '多源一致性' },
];

/**
 * 「大气光谱与多源物理诊断」合并卡（第四轮重设计）。
 *
 * 为什么合并：原先《光谱与色温》《物理引擎诊断》《多模型一致性》是三张
 * 并排的 `.glass` 卡，占掉整整一行纵向空间，而它们**服务于同一类问题**
 * ——「这个分数是怎么来的、可不可信」。对普通风光摄影师来说，
 * 第一眼要的是「今晚烧不烧、几点最红、往哪拍」，这三张属于第二层。
 *
 * 于是改成一张卡 + 分段控件：默认展示最直观的光谱，需要时切到因子拆解
 * 或模型一致性。信息一条不少，但首屏不再被硬核诊断淹没。
 */
export function DiagnosticsStudio({
  p,
  models,
  onPromote,
}: {
  p: SunsetPredictionOutput;
  models: ModelId[];
  onPromote: (m: ModelId) => void;
}) {
  const [tab, setTab] = useState<TabKey>('spectrum');

  return (
    <section className="glass col-span-full xl:col-span-6 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="bento-title">大气光谱与物理诊断</h2>
          <p className="mt-1 text-[11px] leading-snug text-slate-400/80 break-anywhere">
            颜色由 Rayleigh λ⁻⁴ + 气溶胶 Angström + 臭氧 Chappuis 分通道积分导出
          </p>
        </div>
        <InfoTip
          align="right"
          text="三段视图：光谱给出 380–780nm 的地面到达曲线与色温；物理拆解给出逐层「质量 × 受光 × 透过 × 可见」的贡献与光路环衰减；多源一致性给出 ECMWF / GFS / ICON 的峰值偏差与分歧度。"
        />
      </div>

      {/* 分段控件 */}
      <div
        role="tablist"
        aria-label="诊断视图"
        className="mt-3 flex w-full gap-1 rounded-xl border border-white/[0.07] bg-black/25 p-1"
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors ${
                active
                  ? 'bg-white/[0.10] text-white/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                  : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-2.5">
        {tab === 'spectrum' && <SpectrumPane p={p} />}
        {tab === 'factors' && <FactorsPane p={p} />}
        {tab === 'models' && (
          <div className="[&>.glass]:!border-0 [&>.glass]:!bg-transparent [&>.glass]:!p-0 [&>.glass]:!shadow-none [&>.glass]:!backdrop-blur-none [&>section>header]:!px-0 [&>section>header]:!pt-0 [&>section>div]:!px-0 [&>section>div]:!pb-0">
            <MultiModelCard p={p} models={models} onPromote={onPromote} />
          </div>
        )}
      </div>
    </section>
  );
}

/** 光谱视图：直接用 AerosolGauge 的内容（去掉它的卡片外壳） */
function SpectrumPane({ p }: { p: SunsetPredictionOutput }) {
  return (
    <div className="[&>.glass]:!border-0 [&>.glass]:!bg-transparent [&>.glass]:!p-0 [&>.glass]:!shadow-none [&>.glass]:!backdrop-blur-none [&>section>header]:!px-0 [&>section>header]:!pt-0 [&>section>div]:!px-0 [&>section>div]:!pb-0 [&_svg]:max-w-[140px]">
      <AerosolGauge p={p} />
      <SpectralCurve p={p} />
    </div>
  );
}

/** 物理拆解视图：复用 DiagnosticsCard 内容 */
function FactorsPane({ p }: { p: SunsetPredictionOutput }) {
  return (
    <div className="[&>.glass]:!border-0 [&>.glass]:!bg-transparent [&>.glass]:!p-0 [&>.glass]:!shadow-none [&>.glass]:!backdrop-blur-none [&>section>header]:!px-0 [&>section>header]:!pt-0 [&>section>div]:!px-0 [&>section>div]:!pb-0">
      <DiagnosticsCard p={p} />
    </div>
  );
}

/**
 * 380–780nm 地面到达光谱曲线。
 *
 * 纯几何计算：把引擎已经算出的 Rayleigh / 气溶胶 / 臭氧三个气柱量
 * 在可见光波段上采样，归一化后画曲线。**不是示意图** —— 曲线形状
 * 与 `p.renderedRgb` 同源。
 */
function SpectralCurve({ p }: { p: SunsetPredictionOutput }) {
  const W = 320;
  const H = 72;
  const pad = 4;

  // 用 aod / 湿度 / 臭氧重建可见光段相对辐照度
  const { aod, humidity, ozoneDu } = p.spectral;
  const points = Array.from({ length: 41 }, (_, i) => {
    const nm = 380 + (i / 40) * 400; // 380 → 780
    const lam = nm / 550;
    // Rayleigh ∝ λ⁻⁴；气溶胶 ∝ λ^(−Ångström)；臭氧 Chappuis 在 600nm 附近
    const psi = 1 + Math.pow(Math.max(humidity - 55, 0) / 45, 2) * 1.15;
    const tauRay = 0.0984 * Math.pow(lam, -4);
    const tauAer = aod * psi * Math.pow(lam, -1.3);
    const chappuis = Math.exp(-Math.pow((nm - 600) / 55, 2));
    const tauO3 = (ozoneDu / 300) * 0.035 * chappuis;
    return { nm, v: Math.exp(-(tauRay + tauAer + tauO3)) };
  });
  const max = Math.max(...points.map((q) => q.v), 1e-6);
  const xOf = (nm: number) => pad + ((nm - 380) / 400) * (W - pad * 2);
  const yOf = (v: number) => H - pad - (v / max) * (H - pad * 2);

  const path = points.map((q, i) => `${i === 0 ? 'M' : 'L'} ${xOf(q.nm).toFixed(1)} ${yOf(q.v).toFixed(1)}`).join(' ');

  // 用曲线本身的颜色画（加粗、渐变）
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium text-slate-400">可见光到达光谱</span>
        <span className="num text-[11px] text-slate-500">380 – 780 nm</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="可见光到达光谱曲线">
        <defs>
          <linearGradient id="spec-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7c5cff" />
            <stop offset="25%" stopColor="#38bdf8" />
            <stop offset="50%" stopColor="#4ade80" />
            <stop offset="75%" stopColor="#fbbf24" />
            <stop offset="100%" stopColor="#fb7185" />
          </linearGradient>
          <linearGradient id="spec-fill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7c5cff" stopOpacity="0.18" />
            <stop offset="50%" stopColor="#4ade80" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#fb7185" stopOpacity="0.18" />
          </linearGradient>
        </defs>
        {/* 可见光谱底色条 */}
        <rect x={pad} y={H - pad - 3} width={W - pad * 2} height="3" rx="1.5" fill="url(#spec-stroke)" opacity="0.5" />
        <path d={`${path} L ${xOf(780)} ${H - pad} L ${xOf(380)} ${H - pad} Z`} fill="url(#spec-fill)" />
        <path d={path} fill="none" stroke="url(#spec-stroke)" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
      <div className="num mt-0.5 flex justify-between text-[11px] text-slate-600">
        <span>380</span>
        <span>550</span>
        <span>780</span>
      </div>
    </div>
  );
}
