import { MODEL_META } from '../../data/openMeteo';
import { VIVIDNESS_CEILING } from '../../engine/constants';
import type { ModelId, SunsetPredictionOutput } from '../../engine/types';
import { Dot, InfoTip, Panel } from '../primitives';

/**
 * 多模型交叉验证：分歧度、各源峰值、置信度带。
 */
export function MultiModelCard({
  p,
  models,
  onPromote,
}: {
  p: SunsetPredictionOutput;
  models: ModelId[];
  onPromote: (m: ModelId) => void;
}) {
  const peaks = p.modelPeaks;
  const vals = peaks.map((m) => m.peakVividness);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1);
  const spread = max - min;

  const agreeLabel =
    p.uncertainty < 0.18 ? '高度一致' : p.uncertainty < 0.42 ? '基本一致' : p.uncertainty < 0.7 ? '存在分歧' : '分歧显著';
  const agreeColor = p.uncertainty < 0.18 ? '#38e8d0' : p.uncertainty < 0.42 ? '#7dd3fc' : p.uncertainty < 0.7 ? '#ffb340' : '#ff6b6b';

  return (
    <Panel
      className="col-span-full sm:col-span-6 lg:col-span-3 xl:col-span-2"
      title="多模型交叉验证"
      subtitle={`${agreeLabel} · 分歧 ${(p.uncertainty * 100).toFixed(0)}%`}
      right={<InfoTip text="分歧度 =（各源峰值极差）/（均值）。分歧越大，预报不确定性越高，摄影师应准备更宽的曝光/焦段冗余，并在临场根据实况微调。" />}
      bodyClass="!pt-0"
    >
      {/* 一致性条 */}
      <div className="relative mt-1 h-9 w-full overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.025]">
        {/* 均值±极差带 */}
        <div
          className="absolute inset-y-0 opacity-25"
          style={{
            left: `${((min - 0.1) / (VIVIDNESS_CEILING - 0.1)) * 100}%`,
            width: `${(Math.max(spread, 0.02) / (VIVIDNESS_CEILING - 0.1)) * 100}%`,
            background: `linear-gradient(90deg, ${agreeColor}00, ${agreeColor}, ${agreeColor}00)`,
          }}
        />
        {/* 均值线 */}
        <div
          className="absolute inset-y-0 w-px bg-white/45"
          style={{ left: `${((mean - 0.1) / (VIVIDNESS_CEILING - 0.1)) * 100}%` }}
        />
        {/* 各模型点 */}
        {peaks.map((m) => {
          const x = Math.max(2, Math.min(98, ((m.peakVividness - 0.1) / (VIVIDNESS_CEILING - 0.1)) * 100));
          const isPrimary = m.model === p.primaryModel;
          return (
            <button
              key={m.model}
              type="button"
              onClick={() => onPromote(m.model)}
              title={`${m.label}：峰值 ${m.peakVividness.toFixed(2)}（点击切换为主源）`}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-125"
              style={{
                left: `${x}%`,
                width: isPrimary ? 11 : 8,
                height: isPrimary ? 11 : 8,
                background: MODEL_META[m.model].color,
                boxShadow: `0 0 10px ${MODEL_META[m.model].color}aa`,
                border: isPrimary ? '1.5px solid rgba(255,255,255,0.85)' : '1px solid rgba(0,0,0,0.4)',
              }}
              aria-label={`${MODEL_META[m.model].short} 峰值 ${m.peakVividness.toFixed(2)}`}
            />
          );
        })}
        <span className="num absolute bottom-0.5 left-1 text-[7.5px] text-slate-500">0</span>
        <span className="num absolute bottom-0.5 right-1 text-[7.5px] text-slate-500">{VIVIDNESS_CEILING.toFixed(1)}</span>
      </div>

      {/* 各源明细 */}
      <div className="mt-2.5 space-y-1">
        {peaks.map((m) => {
          const isPrimary = m.model === p.primaryModel;
          return (
            <button
              key={m.model}
              type="button"
              onClick={() => onPromote(m.model)}
              className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                isPrimary ? 'border-amber-300/30 bg-amber-300/[0.07]' : 'border-white/[0.06] hover:border-white/15'
              }`}
              title={isPrimary ? '当前主源' : '点击切换为主源'}
            >
              <Dot color={MODEL_META[m.model].color} />
              <span className="w-10 shrink-0 text-[9.5px] font-semibold tracking-wide" style={{ color: MODEL_META[m.model].color }}>
                {MODEL_META[m.model].short}
              </span>
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{
                    width: `${Math.min(100, (m.peakVividness / VIVIDNESS_CEILING) * 100)}%`,
                    background: `${MODEL_META[m.model].color}cc`,
                  }}
                />
              </div>
              <span className="num w-8 shrink-0 text-right text-[10px] font-semibold text-slate-200">
                {m.peakVividness.toFixed(2)}
              </span>
              {isPrimary && (
                <span className="shrink-0 rounded bg-amber-300/20 px-1 text-[7.5px] font-bold uppercase tracking-wider text-amber-200">
                  主
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-white/[0.07] pt-2 text-[9.5px]">
        <span className="text-slate-500">置信度</span>
        <span className="num font-semibold" style={{ color: agreeColor }}>
          {(p.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <p className="mt-1 text-[9.5px] leading-snug text-slate-500 break-anywhere">
        {p.uncertainty < 0.18
          ? '三源高度收敛，可放心出发。'
          : p.uncertainty < 0.42
            ? '主流一致，仍建议提前 10 分钟到场观察实况。'
            : '模型分歧明显：优先参考本地临近云图与实况，备好多机位与多焦段。'}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {models.map((m) => (
          <span key={m} className="chip !px-1.5 !py-0.5 !text-[8.5px]">
            {MODEL_META[m].short}
          </span>
        ))}
      </div>
    </Panel>
  );
}
