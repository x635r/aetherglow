import { useEffect, useMemo, useState } from 'react';
import { useStore } from './state/store';
import { TopBar } from './ui/TopBar';
import { HeroScore } from './ui/cards/HeroScore';
import { RayMarchCard } from './ui/cards/RayMarchCard';
import { TimelineCard } from './ui/cards/TimelineCard';
import { TacticalCard } from './ui/cards/TacticalCard';
import { CloudProfileCard } from './ui/cards/CloudProfileCard';
import { DiagnosticsStudio } from './ui/cards/DiagnosticsStudio';
import { SkyMapCard } from './ui/cards/SkyMapCard';
import { GRADE_THEME } from './engine/constants';
import type { ModelId } from './engine/types';

export default function App() {
  const { status, error, prediction: p, load, query, setQuery, quotaResetAtMs, stale, staleAgeMs } = useStore();

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
        {status === 'error' && (
          <ErrorBanner
            message={error}
            // **不再 force 绕过缓存**：额度耗尽时 force 只会继续撞 429。
            // 普通刷新会优先命中（过期但在保留期内的）缓存。
            onRetry={() => load({ force: false })}
            resetAtMs={quotaResetAtMs}
            hasStaleData={p != null}
          />
        )}
        {status !== 'error' && stale && p != null && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-sky-400/25 bg-sky-950/20 px-4 py-2.5">
            <span className="text-[11.5px] font-medium text-sky-200">非实时数据</span>
            <span className="min-w-0 flex-1 text-[11px] text-sky-300/70 break-anywhere">
              数据源暂时不可用，当前展示的是 {Math.round((staleAgeMs || 0) / 60000)} 分钟前的缓存。日落后请以实况为准。
            </span>
            <button
              type="button"
              onClick={() => load({ force: true })}
              className="btn-ghost shrink-0 !border-sky-300/30 !text-sky-200"
            >
              尝试刷新
            </button>
          </div>
        )}

        {/* Bento Grid：12 列栅格，移动端单列 */}
        <div className="grid grid-cols-1 gap-3 sm:gap-3.5 lg:grid-cols-12">
          {p ? (
            <>
              {/* Row 1: Hero 主卡（全宽） */}
              <div className="col-span-full xl:col-span-12">
                <HeroScore p={p} />
              </div>

              {/* Row 2: 一体化光线追踪工作台 —— 左剖面 8 列 + 右云廓线 4 列。
                  第四轮重设计：这两张卡展示的是**同一套 10 层等压面数据**，
                  却被拆成坐标轴正交的两张卡。现在并排等宽对齐，
                  剖面图上的某层可以直接横向读到右侧的云量与受光率。 */}
              <RayMarchCard />
              <CloudProfileCard p={p} />

              {/* Row 3: 时间轴 7 列 + 战术 5 列 */}
              <TimelineCard p={p} />
              <TacticalCard p={p} />

              {/* Row 4: 光谱 / 物理拆解 / 多源一致性 —— 分段切换，渐进披露 */}
              <DiagnosticsStudio p={p} models={query.models} onPromote={promote} />

              {/* Row 5: 区域热力 + 方法说明 */}
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

/**
 * 错误横幅。
 *
 * **两种错误必须区别对待**：
 *  · 普通网络错误 → 给「重试」按钮
 *  · 额度耗尽     → **不给**「强制重试」按钮（点了还是 429，只会让用户更困惑），
 *    改为显示恢复倒计时，并把「重试」降级为不绕过缓存的普通刷新
 *
 * 另外：如果已有数据（`hasStaleData`），横幅要说明"下方显示的是旧数据"，
 * 而不是让用户以为页面坏了。
 */
function ErrorBanner({
  message,
  onRetry,
  resetAtMs,
  hasStaleData,
}: {
  message: string | null;
  onRetry: () => void;
  resetAtMs?: number;
  hasStaleData?: boolean;
}) {
  // 倒计时：每秒刷新。额度恢复后按钮自动回到可用状态。
  const [now, setNow] = useState(() => Date.now());
  const quota = resetAtMs != null && resetAtMs > 0;
  useEffect(() => {
    if (!quota) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [quota]);

  const remainMs = quota ? Math.max(0, resetAtMs! - now) : 0;
  const remainMin = Math.ceil(remainMs / 60000);
  const recovered = quota && remainMs <= 0;

  if (quota) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-amber-400/30 bg-amber-950/20 px-4 py-3">
        <span className="text-[12px] font-medium text-amber-200">
          {recovered ? '额度已恢复' : '数据源额度耗尽'}
        </span>
        <span className="min-w-0 flex-1 text-[11px] text-amber-200/70 break-anywhere">
          {recovered
            ? 'Open-Meteo 的小时额度已重置，可以重新拉取。'
            : `Open-Meteo 免费额度（5000 单位/小时）已用尽，约 ${remainMin} 分钟后恢复。本应用单次查询约消耗 112 单位（3 模型 × 6 环 × 62 变量）。`}
          {hasStaleData && ' 下方展示的是最近一次成功获取的数据。'}
        </span>
        <button
          type="button"
          onClick={onRetry}
          disabled={!recovered}
          className="btn-ghost shrink-0 !border-amber-300/30 !text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {recovered ? '重新拉取' : `${remainMin} 分钟后重试`}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/30 bg-rose-950/25 px-4 py-3">
      <span className="text-[12px] font-medium text-rose-200">数据请求失败</span>
      <span className="min-w-0 flex-1 text-[11px] text-rose-300/75 break-anywhere">
        {message ?? '未知错误'}
        {hasStaleData && ' · 下方展示的是最近一次成功获取的数据'}
      </span>
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
        d: '1000/925/850/700/600/500/400/300/250/200hPa 十层云量 + 位势高度（三模型交集层），600–500hPa 为黄金层，250–200hPa 为卷云顶。云幕质量函数在 25–75% 云量时最高。',
      },
      {
        n: '03',
        t: '曲率切线光追',
        d: 'H_ray = H + d·tanα + d²/(2·7435km)。地形高于光线即归零；沿途云量按 Beer–Lambert 累加 τ；跌破海平面即晨昏线。',
      },
      {
        n: '04',
        t: 'CAMS 光谱消光',
        d: 'Rayleigh(λ⁻⁴) 与气溶胶 Angström 分通道积分得 RGB。AOD<0.18、能见度>20km、少沙尘时判为「水晶红」，饱和度增益按洁净度连续取值（约 ×1.15–1.27），不是固定常数。',
      },
      {
        n: '05',
        t: '综合量化',
        d: '逐层「质量 × 受光 × 透过 × 可见」按角色并集合成 × 晨昏辉光 × 光谱增益 → 鲜艳度 0–2.5+，并输出起烧/峰值/二烧时间轴。',
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
        <span className="num shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-slate-400">
          R_eff 7435km
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((s) => (
          <div key={s.n} className="rounded-xl border border-white/[0.07] bg-white/[0.022] p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="num text-[11px] font-bold text-amber-300/80">{s.n}</span>
              <span className="text-[11px] font-semibold text-slate-200">{s.t}</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400/85 break-anywhere">{s.d}</p>
          </div>
        ))}
        <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.05] p-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-bold text-amber-300">★</span>
            <span className="text-[11px] font-semibold text-amber-100">紫霞二烧</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-100/70 break-anywhere">
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
      <p className="text-[11px] text-slate-600">
        数据：Open-Meteo（ECMWF IFS / NOAA GFS / DWD ICON）· CAMS 气溶胶 · Copernicus DEM 高程
      </p>
      <p className="text-[11px] text-slate-700">
        AetherGlow 穹霞 · 免 Key 物理预测引擎 · 结果仅供摄影决策参考，不构成气象预报
      </p>
    </footer>
  );
}
