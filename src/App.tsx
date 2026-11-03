import { useEffect, useMemo } from 'react';
import { useStore } from './state/store';
import { TopBar } from './ui/TopBar';
import { HeroScore } from './ui/cards/HeroScore';
import { RayMarchCard } from './ui/cards/RayMarchCard';
import { TimelineCard } from './ui/cards/TimelineCard';
import { TacticalCard } from './ui/cards/TacticalCard';
import { CloudProfileCard, AerosolGauge } from './ui/cards/CloudProfileCard';
import { MultiModelCard } from './ui/cards/MultiModelCard';
import { DiagnosticsCard } from './ui/cards/DiagnosticsCard';
import { SkyMapCard } from './ui/cards/SkyMapCard';
import { GRADE_THEME } from './engine/constants';
import type { ModelId } from './engine/types';

export default function App() {
  const { status, error, prediction: p, load, query, setQuery } = useStore();

  // 首次加载
  useEffect(() => {
    void load();
  }, [load]);

  const theme = p ? GRADE_THEME[p.grade] : GRADE_THEME.none;

  const promote = (m: ModelId) => setQuery({ primaryModel: m });

  return (
    <div className="grain relative min-h-screen bg-[#04060c] text-slate-100">
      <Aurora accent={theme.accent} secondary={theme.to} />

      <TopBar />

      <main className="relative z-10 mx-auto max-w-[1560px] px-3 pb-16 pt-3 sm:px-5 sm:pt-4">
        {status === 'error' && <ErrorBanner message={error} onRetry={() => load({ force: true })} />}

        {/* Bento Grid：12 列栅格，移动端单列 */}
        <div className="grid grid-cols-1 gap-3 sm:gap-3.5 lg:grid-cols-12">
          {p ? (
            <>
              {/* Row 1: Hero (全宽) */}
              <div className="col-span-full xl:col-span-12">
                <HeroScore p={p} />
              </div>

              {/* Row 2: 光路剖面 (8) + 时间曲线 (4) */}
              <RayMarchCard />
              <TimelineCard p={p} />

              {/* Row 3: 战术 (4) + 诊断 (4) + 多模型 (2) + 剖面柱 (2) */}
              <TacticalCard p={p} />
              <DiagnosticsCard p={p} />
              <MultiModelCard p={p} models={query.models} onPromote={promote} />
              <CloudProfileCard p={p} />

              {/* Row 4: AOD 仪表 (2) + 热力分布 (2) + 信息说明 (8) */}
              <AerosolGauge p={p} />
              <SkyMapCard p={p} />
              <MethodCard />
            </>
          ) : (
            <LoadingSkeleton />
          )}
        </div>

        <Footer />
      </main>
    </div>
  );
}

/** 背景极光场 */
function Aurora({ accent, secondary }: { accent: string; secondary: string }) {
  return (
    <div className="aurora-field" aria-hidden="true">
      <div
        className="aurora-blob h-[46vw] w-[46vw] animate-drift"
        style={{ left: '4%', top: '6%', background: `radial-gradient(circle, ${accent}3a, transparent 68%)` }}
      />
      <div
        className="aurora-blob h-[40vw] w-[52vw] animate-drift"
        style={{
          right: '0%',
          top: '22%',
          background: `radial-gradient(circle, ${secondary}33, transparent 70%)`,
          animationDelay: '-9s',
        }}
      />
      <div
        className="aurora-blob h-[34vw] w-[40vw] animate-drift"
        style={{
          left: '32%',
          bottom: '-4%',
          background: 'radial-gradient(circle, #1d3b6e2e, transparent 70%)',
          animationDelay: '-15s',
        }}
      />
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/30 bg-rose-950/25 px-4 py-3">
      <span className="text-[12px] font-medium text-rose-200">数据请求失败</span>
      <span className="min-w-0 flex-1 text-[11px] text-rose-300/75 break-anywhere">{message ?? '未知错误'}</span>
      <button type="button" onClick={onRetry} className="btn-ghost shrink-0 !border-rose-300/30 !text-rose-200">
        重试
      </button>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <>
      <div className="col-span-full">
        <div className="glass skeleton-sweep h-[280px] sm:h-[300px]" />
      </div>
      <div className="col-span-full xl:col-span-8">
        <div className="glass skeleton-sweep h-[420px]" />
      </div>
      <div className="col-span-full xl:col-span-4">
        <div className="glass skeleton-sweep h-[420px]" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="col-span-full sm:col-span-6 xl:col-span-3">
          <div className="glass skeleton-sweep h-[260px]" />
        </div>
      ))}
      <div className="col-span-full flex items-center justify-center gap-2 py-6 text-[11.5px] text-slate-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        正在建立光路网格并拉取 3 源等压面场…
      </div>
    </>
  );
}

/** 方法论说明卡：把物理管线坦白地讲清楚 */
function MethodCard() {
  const steps = useMemo(
    () => [
      {
        n: '01',
        t: '天文几何',
        d: 'NOAA 太阳位置算法求日出/日落，沿方位角用球面大圆铺 6 个环（0/30/80/150/280/450km），T0−20min 至 +40min 每 2 分钟采样。',
      },
      {
        n: '02',
        t: '等压面云层',
        d: '925/850/700/600/500/400/300hPa 七层云量 + 位势高度，600–500hPa 为黄金层。云幕质量函数在 25–75% 云量时最高。',
      },
      {
        n: '03',
        t: '曲率切线光追',
        d: 'H_ray = H + d·tanα + d²/(2·7435km)。地形高于光线即归零；沿途云量按 Beer–Lambert 累加 τ；跌破海平面即晨昏线。',
      },
      {
        n: '04',
        t: 'CAMS 光谱消光',
        d: 'Rayleigh(λ⁻⁴) 与气溶胶 Angström 分通道积分得 RGB，AOD<0.18 且能见度>20km 判定「水晶红」饱和度 ×1.25。',
      },
      {
        n: '05',
        t: '综合量化',
        d: '逐层「质量 × 受光 × 透过 × 可见」求和 × 晨昏辉光 × 光谱增益 → 鲜艳度 0–2.5+，并输出起烧/峰值/二烧时间轴。',
      },
    ],
    [],
  );

  return (
    <section className="glass col-span-full xl:col-span-8 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="bento-title">物理管线 · 五步</h2>
          <p className="mt-1 text-[11px] leading-snug text-slate-400/80">
            所有颜色与分数都由光路积分导出 —— 没有「高中低云加权」这类经验公式。
          </p>
        </div>
        <span className="num shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[9.5px] text-slate-400">
          R_eff 7435km
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((s) => (
          <div key={s.n} className="rounded-xl border border-white/[0.07] bg-white/[0.022] p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="num text-[10px] font-bold text-amber-300/80">{s.n}</span>
              <span className="text-[11px] font-semibold text-slate-200">{s.t}</span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400/85 break-anywhere">{s.d}</p>
          </div>
        ))}
        <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.05] p-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-amber-300">★</span>
            <span className="text-[11px] font-semibold text-amber-100">紫霞二烧</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-amber-100/70 break-anywhere">
            9.2km 卷云在太阳 α≈−3° 时仍处半受光（地影线低于云层），叠加高层散射尾 → 紫红余晖。不是特判，是几何必然。
          </p>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-8 flex flex-col items-center gap-1.5 text-center">
      <div className="divider w-full max-w-3xl" />
      <p className="text-[10px] text-slate-600">
        数据：Open-Meteo（ECMWF IFS / NOAA GFS / DWD ICON）· CAMS 气溶胶 · Copernicus DEM 高程
      </p>
      <p className="text-[9.5px] text-slate-700">
        AetherGlow 穹霞 · 免 Key 物理预测引擎 · 结果仅供摄影决策参考，不构成气象预报
      </p>
    </footer>
  );
}
