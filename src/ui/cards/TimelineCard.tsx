import { useEffect, useMemo, useRef } from 'react';
import {
  Chart as ChartJS,
  LineController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  type ChartOptions,
  type ChartData,
} from 'chart.js';
import { MODEL_META } from '../../data/openMeteo';
import type { SunsetPredictionOutput } from '../../engine/types';
import { InfoTip, Panel } from '../primitives';

ChartJS.register(LineController, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

/** 轻量 Chart.js 包装，避免引入 react-chartjs-2 */
function LineChart({ data, options, height }: { data: ChartData<'line'>; options: ChartOptions<'line'>; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chart = useRef<ChartJS<'line'> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = new ChartJS<'line'>(el, { type: 'line', data, options });
    chart.current = c;
    return () => {
      c.destroy();
      if (chart.current === c) chart.current = null;
    };
    // 只在挂载时创建；后续通过下方 effect 增量更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.data = data;
    c.options = options;
    c.update('none');
  }, [data, options]);

  return <canvas ref={ref} style={{ height, width: '100%' }} role="img" aria-label="霞光鲜艳度时间曲线" />;
}

const ROLE_COLOR: Record<string, string> = {
  golden: '#ffb340',
  high: '#c494fc',
  mid: '#98b4d2',
  low: '#7e9ebc',
};

export function TimelineCard({ p }: { p: SunsetPredictionOutput }) {
  const labels = useMemo(() => p.series.map((s) => `${s.offsetMin > 0 ? '+' : ''}${s.offsetMin}`), [p.series]);

  const data: ChartData<'line'> = useMemo(
    () => ({
      labels,
      datasets: [
        {
          label: '主源',
          data: p.series.map((s) => Number(s.vividness.toFixed(3))),
          borderColor: p.theme.accent,
          borderWidth: 2.4,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: p.theme.accent,
          tension: 0.36,
          fill: true,
          backgroundColor: (ctx) => {
            const { chart } = ctx;
            const area = chart.chartArea;
            if (!area) return `${p.theme.accent}22`;
            const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            g.addColorStop(0, `${p.theme.accent}50`);
            g.addColorStop(1, `${p.theme.accent}00`);
            return g;
          },
        },
        ...p.modelPeaks
          .filter((m) => m.model !== p.primaryModel)
          .map((m) => ({
            label: MODEL_META[m.model].short,
            data: m.series.map((v) => Number(v.toFixed(3))),
            borderColor: `${MODEL_META[m.model].color}aa`,
            borderWidth: 1.4,
            borderDash: [4, 3],
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.36,
            fill: false,
          })),
      ],
    }),
    [p, labels],
  );

  const options: ChartOptions<'line'> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 2, right: 4, bottom: 0, left: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(6,10,18,0.96)',
          borderColor: 'rgba(255,255,255,0.14)',
          borderWidth: 1,
          titleColor: '#e8eefb',
          bodyColor: '#a9bad2',
          titleFont: { size: 11, family: 'JetBrains Mono, monospace' },
          bodyFont: { size: 10.5 },
          padding: 9,
          cornerRadius: 9,
          boxWidth: 7,
          boxHeight: 7,
          callbacks: {
            title: (items) => `T0 ${items[0].label} min`,
            label: (item) => ` ${item.dataset.label}: ${Number(item.raw).toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)', drawTicks: false },
          border: { display: false },
          ticks: {
            color: 'rgba(140,158,180,0.8)',
            font: { size: 9, family: 'JetBrains Mono, monospace' },
            maxRotation: 0,
            callback: (_v, i) => {
              const off = p.series[i]?.offsetMin;
              return off !== undefined && off % 10 === 0 ? `${off > 0 ? '+' : ''}${off}` : '';
            },
          },
        },
        y: {
          beginAtZero: true,
          suggestedMax: Math.max(1.0, p.timeline.peakVividness * 1.3),
          grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false },
          border: { display: false },
          ticks: {
            color: 'rgba(140,158,180,0.8)',
            font: { size: 9, family: 'JetBrains Mono, monospace' },
            maxTicksLimit: 5,
            padding: 4,
          },
        },
      },
    }),
    [p],
  );

  const peakIdx = p.series.reduce((b, s, i) => (s.vividness > p.series[b].vividness ? i : b), 0);
  const peakOff = p.series[peakIdx]?.offsetMin ?? 0;
  const onsetOff = p.timeline.onsetMs ? Math.round((p.timeline.onsetMs - p.eventMs) / 60000) : null;
  const endOff = p.timeline.endMs ? Math.round((p.timeline.endMs - p.eventMs) / 60000) : null;
  const pct = (min: number) => ((min + 20) / 60) * 100;

  const maxContrib = Math.max(...p.layers.map((x) => x.contribution), 1e-6);

  return (
    <Panel
      className="col-span-full lg:col-span-6 xl:col-span-4"
      title="分钟级霞光演变"
      subtitle="T0 = 日出/日落时刻 · 每 2 分钟一帧 · 虚线为对照模型"
      right={<InfoTip text="曲线为 31 帧 × 7 层的光路积分结果。起烧/结束阈值取峰值的 35%；二烧窗口按太阳高度角 −1.4° ~ −7.4°（紫光实测区间）自动选取。" />}
      bodyClass="!pt-0"
    >
      <div className="w-full">
        <LineChart data={data} options={options} height={148} />
      </div>

      {/* 图例（自绘，避免 Chart.js legend 占高） */}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1 text-[9px] text-slate-300">
          <span className="h-[2px] w-3.5 rounded" style={{ background: p.theme.accent }} />
          主源
        </span>
        {p.modelPeaks
          .filter((m) => m.model !== p.primaryModel)
          .map((m) => (
            <span key={m.model} className="flex items-center gap-1 text-[9px] text-slate-400">
              <span className="h-[2px] w-3.5 rounded" style={{ background: `${MODEL_META[m.model].color}aa` }} />
              {MODEL_META[m.model].short}
            </span>
          ))}
      </div>

      {/* 时间轴 */}
      <div className="mt-3">
        <div className="relative h-1.5 w-full overflow-visible rounded-full bg-white/[0.08]">
          {onsetOff !== null && endOff !== null && endOff > onsetOff && (
            <div
              className="absolute inset-y-0 rounded-full"
              style={{
                left: `${Math.max(0, pct(onsetOff))}%`,
                width: `${Math.min(100, pct(endOff)) - Math.max(0, pct(onsetOff))}%`,
                background: `linear-gradient(90deg, ${p.theme.accent}44, ${p.theme.accent}bb)`,
              }}
            />
          )}
          {[0, 20, 35].map((t) => (
            <span
              key={t}
              className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-white/35"
              style={{ left: `${pct(t)}%` }}
            />
          ))}
          <span
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${pct(peakOff)}%`,
              background: p.theme.accent,
              boxShadow: `0 0 10px ${p.theme.accent}`,
            }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-slate-500">
          <span>−20′</span>
          <span className={Math.abs(peakOff) <= 6 ? 'font-semibold text-amber-300' : ''}>T0</span>
          <span>+20′</span>
          <span>+40′</span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <PhaseStat label="起烧" value={onsetOff !== null ? `${onsetOff >= 0 ? '+' : ''}${onsetOff}′` : '—'} />
          <PhaseStat label="一烧峰值" value={`${peakOff >= 0 ? '+' : ''}${peakOff}′`} accent={p.theme.accent} active />
          <PhaseStat
            label="二烧概率"
            value={`${Math.round(p.timeline.afterglowProbability * 100)}%`}
            accent="#c494fc"
            active={p.timeline.afterglowProbability > 0.45}
          />
        </div>
      </div>

      {/* 分层贡献 */}
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-semibold uppercase tracking-[0.13em] text-slate-500">峰值层贡献</span>
          <span className="text-[9px] text-slate-500">质量×受光×透过×可见</span>
        </div>
        {[...p.layers]
          .sort((a, b) => b.contribution - a.contribution)
          .slice(0, 4)
          .map((l) => {
            const color = ROLE_COLOR[l.role] ?? '#98b4d2';
            return (
              <div key={l.key} className="flex items-center gap-2">
                <span className="num w-10 shrink-0 text-[9.5px] text-slate-500">{l.key}hPa</span>
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{ width: `${(l.contribution / maxContrib) * 100}%`, background: color, boxShadow: `0 0 8px ${color}66` }}
                  />
                </div>
                <span className="num w-8 shrink-0 text-right text-[9.5px] text-slate-400">
                  {l.contribution.toFixed(2)}
                </span>
              </div>
            );
          })}
      </div>
    </Panel>
  );
}

function PhaseStat({
  label,
  value,
  accent,
  active,
}: {
  label: string;
  value: string;
  accent?: string;
  active?: boolean;
}) {
  return (
    <div
      className="rounded-lg border px-2 py-1.5 transition-colors"
      style={{
        borderColor: active && accent ? `${accent}55` : 'rgba(255,255,255,0.07)',
        background: active && accent ? `${accent}12` : 'rgba(255,255,255,0.025)',
      }}
    >
      <div className="text-[9px] uppercase tracking-[0.1em] text-slate-500">{label}</div>
      <div className="num mt-0.5 text-[13px] font-semibold" style={{ color: accent ?? 'rgba(226,236,250,0.9)' }}>
        {value}
      </div>
    </div>
  );
}
