import { useMemo } from 'react';
import type { SunsetPredictionOutput } from '../../engine/types';
import { InfoTip, Panel } from '../primitives';

/**
 * 区域火烧云热力分布 + 太阳方位角扇形视场。
 *
 * 不依赖 Mapbox/Leaflet（免 Key、免 CDN 瓦片），改用**极坐标雷达图**：
 *  · 圆心 = 观测者
 *  · 半径 = 0…450km 的真实距离（按 RING_KM 网格）
 *  · 每个扇区 = 一个采样环在太阳方位角上的位置
 *  · 颜色 = 该环的「受光云幕得分」
 *
 * 这比地图瓦片更直接回答摄影师的问题：「哪个方向、多远的天边在烧」。
 */
export function SkyMapCard({ p }: { p: SunsetPredictionOutput }) {
  const W = 260;
  const H = 260;
  const cx = W / 2;
  const cy = H / 2;
  const R = 100;

  const rings = p.rings;
  const maxKm = 450;
  const rOf = (km: number) => (km / maxKm) * R;

  // 每个环一个扇叶（沿太阳方位角的半圆，模拟 FOV）
  const fovHalf = 34; // 视场半角
  const az = p.sunAzimuthDeg;

  const sectors = useMemo(
    () =>
      rings.map((r) => {
        const score = Math.max(0, Math.min(1, r.score));
        const rInner = r.ringKm === 0 ? 0 : rOf(Math.max(0, r.ringKm - 24));
        const rOuter = r.ringKm === 0 ? rOf(12) : rOf(r.ringKm + 24);
        return { r, score, rInner, rOuter };
      }),
    [rings],
  );

  const colorFor = (score: number, blocked: boolean) => {
    if (blocked) return 'rgba(255,77,109,0.55)';
    if (score > 0.55) return 'rgba(255,120,40,0.85)';
    if (score > 0.34) return 'rgba(255,179,64,0.72)';
    if (score > 0.16) return 'rgba(200,150,255,0.5)';
    return 'rgba(120,150,180,0.24)';
  };

  // 极坐标扇形路径
  const arcSector = (inner: number, outer: number, a0: number, a1: number) => {
    const rad = (d: number) => ((d - 90) * Math.PI) / 180;
    const p0 = { x: cx + Math.cos(rad(a0)) * inner, y: cy + Math.sin(rad(a0)) * inner };
    const p1 = { x: cx + Math.cos(rad(a1)) * outer, y: cy + Math.sin(rad(a1)) * outer };
    const p2 = { x: cx + Math.cos(rad(a0)) * outer, y: cy + Math.sin(rad(a0)) * outer };
    const p3 = { x: cx + Math.cos(rad(a1)) * inner, y: cy + Math.sin(rad(a1)) * inner };
    return [
      `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`,
      `L ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
      `A ${outer} ${outer} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
      `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
      `A ${inner} ${inner} 0 0 0 ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`,
      'Z',
    ].join(' ');
  };

  return (
    <Panel
      className="col-span-full xl:col-span-4"
      title="区域火烧云分布"
      subtitle={`朝向 ${az.toFixed(0)}° · 0–450km`}
      right={<InfoTip text="极坐标雷达：圆心是观测者，向外 450km 是真实大圆距离。扇叶颜色 = 该环「受光云幕得分」（云量 × 受光 × 透过率）。红 = 地形阻断。" />}
      bodyClass="!pt-0"
    >
      {/*
        `max-w` + `w-full` 会让 SVG 在窄容器里等比缩小，而 `fontSize` 是
        viewBox 单位 —— 缩小时刻度的实际字号会掉到 11px 以下
        （实测 240px 时 0.923×12 ≈ 11.1px，再窄就不够了）。
        viewBox 260 是绘图坐标，展示尺寸固定 240 后 scale 恒为 0.923，
        fontSize 12 稳定渲染 ≈11.1px。
      */}
      <svg viewBox={`0 0 ${W} ${H}`} width={240} height={240} className="mx-auto block shrink-0" role="img" aria-label="区域火烧云热力分布">
        <defs>
          <radialGradient id="hz-glow">
            <stop offset="0" stopColor="rgba(255,214,138,0.20)" />
            <stop offset="1" stopColor="rgba(255,214,138,0)" />
          </radialGradient>
        </defs>

        {/* 距离刻度环 */}
        {[80, 150, 280, 450].map((km) => (
          <g key={km}>
            <circle cx={cx} cy={cy} r={rOf(km)} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
            <text
              x={cx + rOf(km) - 1}
              y={cy - 2.5}
              textAnchor="end"
              fontSize="12"
              fill="rgba(130,150,172,0.7)"
              fontFamily="JetBrains Mono, monospace"
            >
              {km}
            </text>
          </g>
        ))}

        {/* 十字准线 */}
        <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />

        {/* 视场扇形底 */}
        <path d={arcSector(0, R, az - fovHalf, az + fovHalf)} fill="url(#hz-glow)" />

        {/* 各环热力扇叶 */}
        {sectors.map(({ r, score, rInner, rOuter }) => (
          <path
            key={r.ringKm}
            d={arcSector(rInner, rOuter, az - fovHalf, az + fovHalf)}
            fill={colorFor(score, r.terrainBlocked)}
            stroke="rgba(0,0,0,0.25)"
            strokeWidth="0.5"
          >
            <title>{`${r.ringKm}km · 得分 ${(score * 100).toFixed(0)} · 云 ${Math.round(r.cloudCoverTotal)}% · T ${r.transmittance.toFixed(2)}`}</title>
          </path>
        ))}

        {/* 太阳方向箭头 */}
        <g transform={`rotate(${az} ${cx} ${cy})`}>
          <line x1={cx} y1={cy} x2={cx} y2={cy - R - 12} stroke="#ffb340" strokeWidth="1.6" strokeLinecap="round" opacity="0.9" />
          <circle cx={cx} cy={cy - R - 12} r="3.4" fill="#ffd68a" />
          <circle cx={cx} cy={cy - R - 12} r="7" fill="#ffd68a" opacity="0.18" />
        </g>

        {/* 方位标 */}
        {[
          { d: 0, t: 'N' },
          { d: 90, t: 'E' },
          { d: 180, t: 'S' },
          { d: 270, t: 'W' },
        ].map(({ d, t }) => {
          const rad = ((d - 90) * Math.PI) / 180;
          return (
            <text
              key={t}
              x={cx + Math.cos(rad) * (R + 8)}
              y={cy + Math.sin(rad) * (R + 8) + 2.5}
              textAnchor="middle"
              fontSize="12"
              fontWeight="700"
              fill="rgba(160,180,205,0.8)"
              fontFamily="Inter, system-ui"
            >
              {t}
            </text>
          );
        })}

        {/* 观测者 */}
        <circle cx={cx} cy={cy} r="3" fill="#38e8d0" />
        <circle cx={cx} cy={cy} r="6" fill="none" stroke="#38e8d0" strokeWidth="1" opacity="0.5" />
      </svg>

      {/* 图例 */}
      <div className="mt-1 flex items-center justify-center gap-2.5 text-[11px] text-slate-500">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-2.5 rounded-sm bg-orange-500/85" />大烧
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-2.5 rounded-sm bg-amber-400/70" />中烧
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-2.5 rounded-sm bg-purple-400/50" />弱
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-2.5 rounded-sm bg-rose-500/70" />阻断
        </span>
      </div>

      <div className="mt-2 space-y-1">
        {[...rings]
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((r) => (
            <div key={r.ringKm} className="flex items-center gap-1.5 text-[11px]">
              <span className="num w-9 shrink-0 text-slate-500">{r.ringKm}km</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, r.score * 100)}%`,
                    background: r.terrainBlocked ? '#ff4d6d' : r.score > 0.4 ? '#ff7a18' : '#ffb340',
                  }}
                />
              </div>
              <span className="num w-7 shrink-0 text-right text-slate-400">{(r.score * 100).toFixed(0)}</span>
            </div>
          ))}
      </div>
    </Panel>
  );
}
