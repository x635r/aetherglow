import { LEVEL_BY_KEY } from '../../engine/constants';
import type { SunsetPredictionOutput } from '../../engine/types';
import { InfoTip, Panel } from '../primitives';

const ROLE_COLOR: Record<string, string> = {
  golden: '#ffb340',
  high: '#c494fc',
  mid: '#98b4d2',
  low: '#7e9ebc',
};

/**
 * 光路诊断 + 否决说明 + 环渗透表。
 * 这里把所有「为什么是这个分数」摊开，避免黑箱。
 */
export function DiagnosticsCard({ p }: { p: SunsetPredictionOutput }) {
  const veto = p.veto;

  return (
    <Panel
      className="col-span-full lg:col-span-6 xl:col-span-4"
      title="光路诊断 · 逐层可追溯"
      subtitle="质量 × 受光 × 透过 × 可见 = 贡献；透过 = 阳光抵达该层时穿过上层云后剩余的份额（雨水、云量、云光学厚度）"
      right={<InfoTip text="受光(晨昏线)与透过(云光学厚度+地形)是两个独立判据。云量滚筒鼠标悬停可看光路穿层里程与累计 τ。" />}
      bodyClass="!pt-0"
    >
      {/* 否决条 */}
      {veto.active ? (
        <div
          className="mb-2.5 rounded-xl border p-2.5"
          style={{
            borderColor: 'rgba(255,107,107,0.35)',
            background: 'linear-gradient(135deg, rgba(255,60,90,0.10), rgba(255,60,90,0.03))',
          }}
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-rose-500/20 text-[11px] font-bold text-rose-300">
              !
            </span>
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-rose-200">{veto.title}</div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-rose-200/70 break-anywhere">{veto.detail}</p>
            </div>
            <span className="num ml-auto shrink-0 rounded bg-black/30 px-1.5 py-0.5 text-[11px] text-rose-300">
              ×{veto.penalty.toFixed(2)}
            </span>
          </div>
        </div>
      ) : (
        <div className="mb-2.5 flex items-center gap-2 rounded-xl border border-teal-300/25 bg-teal-400/[0.07] px-2.5 py-2">
          <span className="grid h-4 w-4 place-items-center rounded-full bg-teal-400/20 text-[11px] font-bold text-teal-300">✓</span>
          <span className="text-[11px] font-medium text-teal-200">{veto.title}</span>
          <span className="ml-auto text-[11px] text-teal-200/60">光路无否决</span>
        </div>
      )}

      {/* 逐层表 */}
      <div className="overflow-hidden rounded-lg border border-white/[0.07]">
        <div className="grid grid-cols-[46px_1fr_38px_38px_38px_42px] gap-1 border-b border-white/[0.07] bg-white/[0.03] px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">
          <span>层</span>
          <span>云量</span>
          <span className="text-right">质量</span>
          <span className="text-right">环透过</span>
          <span className="text-right">可见</span>
          <span className="text-right">贡献</span>
        </div>
        {p.layers.map((l) => {
          const color = ROLE_COLOR[l.role] ?? '#98b4d2';
          const dbg = p.debug.layerDebug.find((d) => d.key === l.key);
          return (
            <div
              key={l.key}
              className="grid grid-cols-[46px_1fr_38px_38px_38px_42px] items-center gap-1 border-b border-white/[0.045] px-2 py-1.5 last:border-0"
              style={{ background: l.role === 'golden' ? 'rgba(255,179,64,0.035)' : undefined }}
              title={
                dbg
                  ? `光路穿层里程 ${dbg.pathKm.toFixed(0)}km · 最优受光环 ${dbg.bestRingKm}km · 累计 τ ${dbg.pathOpticalDepth.toFixed(2)}`
                  : undefined
              }
            >
              <span className="num flex items-center gap-1 text-[11px]" style={{ color }}>
                <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: color }} />
                {LEVEL_BY_KEY[l.key].hpa}
              </span>
              <div className="flex items-center gap-1.5">
                <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
                  <div className="h-full rounded-full" style={{ width: `${l.cover}%`, background: color, opacity: 0.7 }} />
                </div>
                <span className="num w-6 shrink-0 text-right text-[11px] text-slate-400">{Math.round(l.cover)}</span>
              </div>
              <span className="num text-right text-[11px] text-slate-300">{l.quality.toFixed(2)}</span>
              <span
                className="num text-right text-[11px]"
                style={{ color: l.terrainBlocked ? '#ff6b6b' : 'rgba(180,196,216,0.9)' }}
              >
                {l.transmittance.toFixed(2)}
              </span>
              <span className="num text-right text-[11px] text-slate-400">
                {l.visible >= 1 ? '✓' : l.visible > 0.1 ? '~' : '✗'}
              </span>
              <span className="num text-right text-[11px] font-semibold" style={{ color: l.contribution > 0.05 ? color : 'rgba(126,146,172,0.8)' }}>
                {l.contribution.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>

      {/* 环渗透 */}
      <div className="mt-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">光路环衰减</span>
          <span className="text-[11px] text-slate-500">600hPa 光路 · 橙色=地形</span>
        </div>
        <div className="flex items-end gap-1">
          {p.rings.map((r) => {
            const h = 8 + r.transmittance * 30;
            return (
              <div key={r.ringKm} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
                <div
                  className="w-full rounded-t-sm transition-all duration-500"
                  style={{
                    height: h,
                    background: r.terrainBlocked
                      ? 'linear-gradient(to top, #ff4d6d66, #ff4d6d)'
                      : `linear-gradient(to top, rgba(255,179,64,0.16), rgba(255,179,64,${0.35 + r.transmittance * 0.6}))`,
                  }}
                  title={`${r.ringKm}km · T=${r.transmittance.toFixed(2)} · 云 ${Math.round(r.cloudCoverTotal)}%`}
                />
                <span className="num text-[11px] text-slate-500">{r.ringKm}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          <SmallStat label="观测海拔" value={`${Math.round(p.observerHeightM)}m`} />
          {/* `p.cloudBaseM` 是「≥20% 覆盖的最低一层」—— 晴天只有 250hPa 卷云时
              它会是 10.6km，标成「云底」会让人误以为是低云底（线上实测到过）。
              这里按真实存在的层标注层名，无云则显示「无」。 */}
          <SmallStat label="最低云层" value={lowestLayerLabel(p)} />
          <SmallStat label="云海反转" value={p.cloudSeaReversal ? '已触发' : '未触发'} accent={p.cloudSeaReversal ? '#38e8d0' : undefined} />
        </div>
      </div>
    </Panel>
  );
}

/**
 * 最低的真实云层（≥5% 覆盖），格式 `925hPa · 811m`；无云返回「无」。
 * 不用 `p.cloudBaseM` —— 它是任意层最低云底，晴天只有卷云时会是 10.6km。
 */
function lowestLayerLabel(p: SunsetPredictionOutput): string {
  const withCloud = p.layers.filter((l) => l.cover > 5).sort((a, b) => a.altitudeM - b.altitudeM);
  if (!withCloud.length) return '无';
  const l = withCloud[0];
  return `${LEVEL_BY_KEY[l.key].hpa}hPa · ${Math.round(l.altitudeM)}m`;
}

function SmallStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.022] px-1.5 py-1">
      <div className="text-[11px] uppercase tracking-[0.08em] text-slate-500">{label}</div>
      <div className="num mt-0.5 truncate text-[11px] font-semibold" style={{ color: accent ?? 'rgba(214,226,242,0.9)' }}>
        {value}
      </div>
    </div>
  );
}
