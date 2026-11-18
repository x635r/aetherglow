/**
 * 大气光路剖面渲染器（Canvas 2D）
 * ---------------------------------------------------------------------------
 * 坐标系
 *   x: 0 → 500 km 水平距离（沿太阳方位角）
 *   y: 0 → 12 km  MSL 海拔
 *
 * 几何呈现的两个关键选择
 * ──────────────────────
 *  1. 地面画成**弧**：y_surface(d) = −d²/(2·R) × GAIN。
 *     用真实 R=6371km 而 GAIN=6.5 只是视觉夸张；物理计算全在引擎里用 R_eff。
 *  2. 太阳画在**远端**（500km 侧）而不是观测者背后 ——
 *     这样光路自然从远端高、近端低，与 H_ray(d)=H+d·tanα+d²/2R_eff 一致，
 *     视线方向直观（光从太阳射向观测者/云）。

 * 绘制层次（后→前）
 *   天空渐变 → 地影区 → 地形 → 等压面基线 → 云带 → 光路 → 站点 → 观测者 → 轴标
 */

import type { LevelKey } from '../engine/constants';
import { LEVEL_BY_KEY } from '../engine/constants';
import type { ModelId } from '../engine/types';
import { buildCrossSection, type CrossSection } from '../engine/SunsetPhysicsEngine';

export interface SectionInput {
  bundle: CrossSection extends never ? never : import('../engine/types').ForecastBundle;
  model: ModelId;
  timeMs: number;
  sunAltitudeDeg: number;
  observerHeightM: number;
  focusLevel: LevelKey;
  /** 视觉曲率放大倍率 */
  curvatureGain?: number;
  /** 与主评分同源的整场 COT 乘子（来自 prediction.debug.cotFactor） */
  cotFactor?: number;
  /** 太阳方位角 —— 云量平流修正需与主评分一致 */
  sightAzimuthDeg?: number;
}

export interface HitRegion {
  kind: 'station' | 'observer' | 'sun' | 'layer';
  x: number;
  y: number;
  label: string;
  ringKm?: number;
  level?: LevelKey;
}

const MAX_KM = 500;
const MAX_ALT_KM = 12.5;

const ROLE_STYLE = {
  low: { fill: [126, 158, 188], edge: [176, 204, 230] },
  mid: { fill: [152, 176, 206], edge: [196, 216, 240] },
  golden: { fill: [255, 176, 90], edge: [255, 210, 138] },
  high: { fill: [196, 148, 252], edge: [226, 192, 255] },
} as const;

const rgba = (c: readonly [number, number, number], a: number): string =>
  `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

export function renderSection(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  input: SectionInput,
): HitRegion[] {
  const { bundle, model, timeMs, sunAltitudeDeg, observerHeightM, focusLevel } = input;
  const gain = input.curvatureGain ?? 6.5;
  const section = buildCrossSection(bundle, model, timeMs, sunAltitudeDeg, observerHeightM, focusLevel, {
    cotFactor: input.cotFactor,
    sightAzimuthDeg: input.sightAzimuthDeg,
  });

  const padL = width < 520 ? 42 : 56;
  const padR = width < 520 ? 12 : 20;
  const padT = width < 520 ? 20 : 26;
  const padB = width < 520 ? 30 : 34;
  const plotW = Math.max(width - padL - padR, 10);
  const plotH = Math.max(height - padT - padB, 10);
  const plotBottom = padT + plotH;

  const xOf = (km: number) => padL + (km / MAX_KM) * plotW;
  const yOf = (altM: number) => plotBottom - (altM / 1000 / MAX_ALT_KM) * plotH;

  // 曲率下沉量**仅供标注**（例如在地平线处显示「已下沉 X km」）。
  //
  // **不要把它加到地形/等压面/云带/观测者的 y 坐标上**（P2 修复）。
  // 引擎所有高度量都在展平海拔坐标系里，光路的 d²/2R 项已经表达了
  // 地球弯曲；再给地形单独加一次曲率会让地面与光路分处两套坐标系，
  // 撞山交点与计算值对不上。详见第 3 节注释。
  const curvatureDropKm = (km: number) => (km * km) / (2 * 6371.0088);
  void gain;

  const hits: HitRegion[] = [];

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.clip();

  // ══ 1. 天空渐变 ═══════════════════════════════════════════════════════
  const alpha = sunAltitudeDeg;
  // night: 0(黄昏) → 1(深蓝)
  const night = Math.min(Math.max((-alpha + 1) / 18, 0), 1);
  const warm = Math.min(Math.max((8 - Math.abs(alpha)) / 8, 0), 1);

  const bg = ctx.createLinearGradient(0, padT, 0, plotBottom);
  bg.addColorStop(0, `hsl(228 ${52 - night * 12}% ${7 + night}%)`);
  bg.addColorStop(0.5, `hsl(${222 + warm * -4} ${40 - night * 6}% ${9 + warm * 3}%)`);
  // 近地平线暖光带：只占底部 16%，且饱和度收敛，避免整片橙块
  bg.addColorStop(0.84, `hsl(${28 + warm * 10} ${34 + warm * 30}% ${8 + warm * 8}%)`);
  bg.addColorStop(1, `hsl(${20 + warm * 10} ${30 + warm * 34}% ${7 + warm * 13}%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(padL, padT, plotW, plotH);

  // ══ 2. 地影（晨昏线）区域 ═════════════════════════════════════════════
  const shadowM = section.shadowHeightM;
  if (alpha < 0 && shadowM > 0) {
    const sy = yOf(shadowM);
    const sg = ctx.createLinearGradient(0, sy, 0, plotBottom);
    sg.addColorStop(0, 'rgba(4, 6, 14, 0.05)');
    sg.addColorStop(0.35, 'rgba(4, 6, 16, 0.42)');
    sg.addColorStop(1, 'rgba(2, 4, 12, 0.62)');
    ctx.fillStyle = sg;
    ctx.fillRect(padL, sy, plotW, plotBottom - sy);

    // 地影线
    ctx.strokeStyle = 'rgba(120, 140, 220, 0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(padL, sy);
    ctx.lineTo(padL + plotW, sy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ══ 3. 地形 ══════════════════════════════════════════════════════════
  //
  // **坐标系必须统一为「展平的海拔 MSL」**（P2 修复）。
  //
  // 引擎里所有高度量（等压面 heightM、光路 H_ray(d) = H₀ + d·tanα + d²/2R）
  // 都定义在**展平坐标系**中，曲率项已经把地球下沉折进了抛物线光路里。
  // 上一版给地形额外加了 `curvature(km)`（450km 处 −15.9km × gain），
  // 而等压面虚线与云带画成水平线、光路画成上翘抛物线 —— 于是同一张图上
  // 地面在向下坠落、光线在飞向太空，撞山交点与计算值对不上。
  //
  // 地形直接画真实海拔即可：光路与地形求交就是精确的撞山点。
  const terrainPts = section.profile.rings.map((r, i) => {
    const terr = bundle.terrain[i]?.elevationM ?? 0;
    return { km: r.ringKm, alt: terr, terr };
  });

  const groundGrad = ctx.createLinearGradient(0, padT + plotH * 0.65, 0, plotBottom);
  groundGrad.addColorStop(0, 'rgba(20, 28, 42, 0.94)');
  groundGrad.addColorStop(1, 'rgba(7, 10, 18, 0.99)');

  ctx.beginPath();
  ctx.moveTo(xOf(0), padT + plotH + 4);
  for (const p of terrainPts) ctx.lineTo(xOf(p.km), yOf(p.alt));
  ctx.lineTo(xOf(MAX_KM), padT + plotH + 4);
  ctx.closePath();
  ctx.fillStyle = groundGrad;
  ctx.fill();

  ctx.beginPath();
  terrainPts.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(p.km), yOf(p.alt)) : ctx.lineTo(xOf(p.km), yOf(p.alt))));
  ctx.strokeStyle = 'rgba(116, 150, 190, 0.6)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // 地形标注（仅明显起伏）
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  for (const p of terrainPts.slice(1)) {
    if (p.terr >= 300) {
      ctx.fillStyle = 'rgba(150, 178, 210, 0.72)';
      ctx.fillText(`${Math.round(p.terr)}m`, xOf(p.km) + 4, yOf(p.alt) - 4);
    }
  }

  // ══ 4. 等压面基线 ═════════════════════════════════════════════════════
  for (const lv of section.levels) {
    const y = yOf(lv.heightM);
    if (y < padT - 2 || y > plotBottom) continue;
    const isFocus = lv.key === focusLevel;
    ctx.setLineDash(isFocus ? [4, 4] : [2, 6]);
    ctx.strokeStyle = isFocus ? 'rgba(255, 200, 120, 0.5)' : 'rgba(255,255,255,0.078)';
    ctx.lineWidth = isFocus ? 1.2 : 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // ══ 5. 云带 ═══════════════════════════════════════════════════════════
  const steps = 84;
  for (const lv of section.levels) {
    if (lv.cover < 0.03) continue;
    const st = ROLE_STYLE[lv.role];
    const isFocus = lv.key === focusLevel;
    const baseY = yOf(lv.heightM);
    const bandH = Math.max(5, (plotH / MAX_ALT_KM) * 0.36 * Math.min(0.4 + lv.cover * 1.1, 1.25));

    const covAt = (km: number) => {
      const rs = section.profile.rings;
      if (km <= rs[0].ringKm) return rs[0].cover[lv.key];
      if (km >= rs[rs.length - 1].ringKm) return rs[rs.length - 1].cover[lv.key];
      for (let i = 0; i < rs.length - 1; i++) {
        if (km >= rs[i].ringKm && km <= rs[i + 1].ringKm) {
          const t = (km - rs[i].ringKm) / Math.max(rs[i + 1].ringKm - rs[i].ringKm, 1e-6);
          return rs[i].cover[lv.key] + (rs[i + 1].cover[lv.key] - rs[i].cover[lv.key]) * t;
        }
      }
      return 0;
    };

    const wobble = (km: number) =>
      Math.sin(km * 0.032 + lv.heightM * 0.0012) * bandH * 0.26 + Math.sin(km * 0.098 + 1.7) * bandH * 0.12;

    // 受光面判定：只有 lit 高的云才有暖色高光
    const lit = lv.lit;

    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const km = (i / steps) * MAX_KM;
      const y = baseY + wobble(km);
      if (i === 0) ctx.moveTo(xOf(km), y);
      else ctx.lineTo(xOf(km), y);
    }
    for (let i = steps; i >= 0; i--) {
      const km = (i / steps) * MAX_KM;
      const c = covAt(km);
      ctx.lineTo(xOf(km), baseY + wobble(km) + bandH * (0.35 + c * 1.15));
    }
    ctx.closePath();

    const bodyAlpha = (0.10 + lv.cover * 0.42) * (isFocus ? 1 : 0.7);
    // 未受光 → 灰蓝；受光 → 该层本色
    const fillRgb: readonly [number, number, number] = lit < 0.3
      ? [96 + lit * 60, 112 + lit * 50, 138 + lit * 50]
      : st.fill;
    const grad = ctx.createLinearGradient(0, baseY - bandH, 0, baseY + bandH * 1.6);
    grad.addColorStop(0, rgba(fillRgb, bodyAlpha * (0.55 + lit * 0.85)));
    grad.addColorStop(1, rgba(fillRgb, bodyAlpha * (0.22 + lit * 0.35)));
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = rgba(
      lit < 0.3 ? ([130, 150, 176] as const) : st.edge,
      (0.16 + lv.cover * 0.42) * (0.32 + lit * 0.85),
    );
    ctx.lineWidth = isFocus ? 1.5 : 0.9;
    ctx.stroke();

    // 受光云顶高光
    if (lit > 0.35) {
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const km = (i / steps) * MAX_KM;
        const y = baseY + wobble(km);
        if (i === 0) ctx.moveTo(xOf(km), y);
        else ctx.lineTo(xOf(km), y);
      }
      ctx.strokeStyle = rgba([255, 226, 176], 0.12 + lit * 0.4);
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
  }

  // ══ 6. 太阳与光路 ═════════════════════════════════════════════════════
  // 光路：d 从观测者（x=0，左侧）沿太阳方位角向外递增（右侧=更靠近太阳）。
  // H_ray(d) = H_target + d·tanα + d²/(2R_eff)
  //   日落时 tanα<0 使光路下压，曲率项使光路上抬；净结果通常远端更高，
  //   这正是「天边云先烧、头顶后入影」的几何来源。
  const tanA = Math.tan((sunAltitudeDeg * Math.PI) / 180);
  const rayAt = (km: number) =>
    section.targetHeightM + km * tanA * 1000 + ((km * km) / (2 * 7435)) * 1000;

  const blocked = section.ray.blockedAtKm;
  const groundHit = section.ray.groundHitKm;

  // 光线能走多远：被地形切断或被地球本体挡住
  const maxReach = Math.min(
    blocked !== null ? blocked : MAX_KM,
    Number.isFinite(groundHit) ? groundHit : MAX_KM,
    MAX_KM,
  );

  const rayPoints: Array<{ km: number; alt: number }> = [];
  for (let km = 0; km <= maxReach + 0.01; km += 2.5) {
    rayPoints.push({ km: Math.min(km, maxReach), alt: rayAt(Math.min(km, maxReach)) });
  }
  if (rayPoints.length && rayPoints[rayPoints.length - 1].km < maxReach) {
    rayPoints.push({ km: maxReach, alt: rayAt(maxReach) });
  }

  // 该层是否已经沉入地影 / 光路极短：此时不该画一条象征性的短光线，
  // 而应明确告诉用户「这一层此刻不烧，另有一层还在受光」。
  //
  // **不要再拿 `section.ray.transmittance` 做判据**。那是"有效照明度"，
  // 含黄昏散射分量，太阳越低反而越高；旧代码用 `exp(−τ_full)` 时它恒为
  // ~1e−11，于是剖面图永远判定"已入地影"，连光路和太阳都一个不画 ——
  // 这是本产品主视觉功能失效的直接原因。
  // 正确的判据只看这一层此刻是否真的受光（`cloudLitFactor`）。
  const focusLit = section.levels.find((l) => l.key === focusLevel)?.lit ?? 0;
  const shadowed = focusLit < 0.15 || rayPoints.length < 3 || maxReach < 60;

  if (rayPoints.length > 1 && !shadowed) {
    const path = () => {
      ctx.beginPath();
      rayPoints.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(p.km), yOf(p.alt)) : ctx.lineTo(xOf(p.km), yOf(p.alt))));
    };

    // 外层光晕
    path();
    ctx.strokeStyle = 'rgba(255, 178, 84, 0.10)';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    path();
    ctx.strokeStyle = 'rgba(255, 196, 116, 0.24)';
    ctx.lineWidth = 7;
    ctx.stroke();

    // 主线：光从右侧太阳射出（亮白）→ 传播到观测者侧（橙红）
    const rg = ctx.createLinearGradient(padL, 0, padL + plotW, 0);
    rg.addColorStop(0, 'rgba(230, 88, 128, 0.45)');
    rg.addColorStop(0.38, 'rgba(255, 132, 62, 0.82)');
    rg.addColorStop(0.72, 'rgba(255, 206, 122, 0.94)');
    rg.addColorStop(1, 'rgba(255, 250, 226, 0.98)');
    path();
    ctx.strokeStyle = rg;
    ctx.lineWidth = 2.7;
    ctx.stroke();

    // 太阳（远端）
    const tip = rayPoints[rayPoints.length - 1];
    const sx = xOf(tip.km);
    const sy = yOf(tip.alt);
    if (sx >= padL - 30 && sx <= padL + plotW + 30) {
      const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 42);
      sg.addColorStop(0, 'rgba(255, 253, 238, 1)');
      sg.addColorStop(0.18, 'rgba(255, 226, 152, 0.92)');
      sg.addColorStop(0.5, 'rgba(255, 148, 70, 0.35)');
      sg.addColorStop(1, 'rgba(255, 120, 60, 0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(sx, sy, 42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fffdf2';
      ctx.beginPath();
      ctx.arc(sx, sy, 5.6, 0, Math.PI * 2);
      ctx.fill();
      hits.push({
        kind: 'sun',
        x: sx,
        y: sy,
        label: `太阳 ${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}° · ${section.levels.length} 层剖面`,
      });
    }
  }

  // ══ 7. 地形遮挡标记 ═══════════════════════════════════════════════════
  if (blocked !== null) {
    const bx = xOf(blocked);
    ctx.strokeStyle = 'rgba(255, 82, 100, 0.8)';
    ctx.lineWidth = 1.3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(bx, padT);
    ctx.lineTo(bx, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    const st = section.stations.find((s) => s.ringKm === blocked);
    const by = st ? yOf(st.rayHeightM) : plotBottom * 0.6;
    ctx.strokeStyle = 'rgba(255, 82, 100, 1)';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(bx - 6, by - 6);
    ctx.lineTo(bx + 6, by + 6);
    ctx.moveTo(bx + 6, by - 6);
    ctx.lineTo(bx - 6, by + 6);
    ctx.stroke();

    const label = `地形遮蔽 ${blocked}km`;
    ctx.font = '600 10px "Inter", system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const lx = Math.min(Math.max(bx - tw / 2 - 7, padL + 3), padL + plotW - tw - 17);
    roundRect(ctx, lx, by - 27, tw + 14, 19, 6);
    ctx.fillStyle = 'rgba(60, 10, 20, 0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 82, 100, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ff98a6';
    ctx.fillText(label, lx + 7, by - 14);
  }

  // ══ 8. 采样站点 ═══════════════════════════════════════════════════════
  for (const s of section.stations) {
    const x = xOf(s.ringKm);
    const rayY = yOf(s.rayHeightM);
    // 与地形、等压面同一坐标系（展平海拔），不再叠加曲率
    const terrY = yOf(s.terrainM);

    // 地形 → 光路 的连接（表示该环的垂直剖面）
    if (!s.terrainBlocked) {
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, terrY);
      ctx.lineTo(x, rayY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const T = Number.isFinite(s.transmittance) ? s.transmittance : 0;
    ctx.beginPath();
    ctx.arc(x, terrY, s.terrainBlocked ? 4 : 3.2, 0, Math.PI * 2);
    ctx.fillStyle = s.terrainBlocked
      ? 'rgba(255, 82, 100, 0.95)'
      : `rgba(${Math.round(140 + T * 115)}, ${Math.round(196 + T * 52)}, 214, 0.94)`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 光路交点（十字）
    if (!s.terrainBlocked && s.ringKm > 0) {
      ctx.strokeStyle = 'rgba(255, 214, 150, 0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 3.5, rayY);
      ctx.lineTo(x + 3.5, rayY);
      ctx.moveTo(x, rayY - 3.5);
      ctx.lineTo(x, rayY + 3.5);
      ctx.stroke();
    }

    hits.push({
      kind: 'station',
      x,
      y: terrY,
      ringKm: s.ringKm,
      label: `${s.ringKm}km · 光路 ${Math.round(s.rayHeightM)}m · 云 ${
        Math.round(s.cloudAtRay * 100)
      }% · T ${T.toFixed(2)}${s.terrainBlocked ? ' · 地形阻断' : ''}`,
    });
  }

  // ══ 8.5 入影 / 空窗说明 ══════════════════════════════════════════════
  if (shadowed) {
    // 找仍受光的最高层，给出下一步建议
    const litLevels = section.levels
      .filter((l) => l.lit > 0.35)
      .sort((a, b) => b.heightM - a.heightM);
    const next = litLevels[0];

    const pad = width < 520 ? 10 : 16;
    const boxW = Math.min(plotW - pad * 2, width < 520 ? 300 : 380);
    const boxH = next ? 62 : 46;
    const bx = padL + (plotW - boxW) / 2;
    const by = padT + plotH * 0.34;

    roundRect(ctx, bx, by, boxW, boxH, 10);
    ctx.fillStyle = 'rgba(10, 14, 26, 0.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140, 165, 210, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = '600 11px "Inter", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(186, 202, 228, 0.95)';
    ctx.fillText(`${LEVEL_BY_KEY[focusLevel].hpa}hPa 已入地影`, bx + boxW / 2, by + (next ? 20 : 27));

    if (next) {
      ctx.font = '9.5px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(255, 214, 150, 0.9)';
      ctx.fillText(
        `最高受光层 ${LEVEL_BY_KEY[next.key].hpa}hPa · ${(next.heightM / 1000).toFixed(1)}km`,
        bx + boxW / 2,
        by + 36,
      );
      ctx.font = '9px "Inter", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(150, 170, 196, 0.8)';
      ctx.fillText('点击上方层按钮切换观察', bx + boxW / 2, by + 50);
    } else {
      ctx.font = '9px "Inter", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(150, 170, 196, 0.8)';
      ctx.fillText('全部云层已入影 · 此刻只剩天边余晖', bx + boxW / 2, by + 36);
    }
    ctx.textAlign = 'left';
  }

  // ══ 9. 观测者 ═════════════════════════════════════════════════════════
  // y 轴是 MSL 海拔，观测者必须画在「地面 DEM + AGL」（= section.observerMslM）。
  // 上一版直接用 AGL —— 高原城市（地面 3650m、机位 0m AGL）会被画到
  // 海平面上，视觉上比 780m 的低云还低 2.8km（审查 P2）。
  const ox = xOf(0);
  const oy = yOf(section.observerMslM);
  ctx.beginPath();
  ctx.moveTo(ox, oy - 9);
  ctx.lineTo(ox - 6, oy + 1);
  ctx.lineTo(ox + 6, oy + 1);
  ctx.closePath();
  ctx.fillStyle = '#ffd68a';
  ctx.fill();
  ctx.strokeStyle = 'rgba(10, 8, 4, 0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();
  hits.push({ kind: 'observer', x: ox, y: oy, label: `观测者 ${Math.round(section.observerMslM)}m MSL（机位 ${Math.round(observerHeightM)}m AGL）` });

  ctx.restore();

  // ══ 10. 坐标轴 ════════════════════════════════════════════════════════
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL - 0.5, padT);
  ctx.lineTo(padL - 0.5, plotBottom + 0.5);
  ctx.lineTo(padL + plotW, plotBottom + 0.5);
  ctx.stroke();

  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  for (const r of section.profile.rings) {
    const x = xOf(r.ringKm);
    ctx.beginPath();
    ctx.moveTo(x, plotBottom);
    ctx.lineTo(x, plotBottom + 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(158, 178, 202, 0.78)';
    ctx.fillText(String(r.ringKm), x, plotBottom + 15);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(126, 146, 172, 0.8)';
  ctx.fillText('km', padL + plotW, plotBottom + 27);

  // Y 轴：海拔 + 等压面
  ctx.textAlign = 'right';
  for (let alt = 0; alt <= 12; alt += 3) {
    const y = yOf(alt * 1000);
    ctx.beginPath();
    ctx.moveTo(padL - 4, y);
    ctx.lineTo(padL, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.stroke();
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(158, 178, 202, 0.78)';
    ctx.fillText(`${alt}`, padL - 8, y + 3);
  }

  // 等压面标签：宽屏放在绘图区外右侧；窄屏放到区内右上角内缘，避免裁切
  const labelsInside = width < 720;
  for (const lv of section.levels) {
    const y = yOf(lv.heightM);
    if (y < padT + 6 || y > plotBottom - 3) continue;
    const isFocus = lv.key === focusLevel;
    ctx.font = `${isFocus ? '700 ' : ''}9px "JetBrains Mono", monospace`;
    if (labelsInside) {
      ctx.textAlign = 'right';
      ctx.fillStyle = isFocus ? 'rgba(255, 214, 150, 0.98)' : 'rgba(150, 170, 196, 0.55)';
      ctx.fillText(`${LEVEL_BY_KEY[lv.key].hpa}`, padL + plotW - 4, y - 3);
    } else {
      ctx.textAlign = 'left';
      ctx.fillStyle = isFocus ? 'rgba(255, 214, 150, 0.98)' : 'rgba(150, 170, 196, 0.5)';
      ctx.fillText(`${LEVEL_BY_KEY[lv.key].hpa}`, padL + plotW + 3, y + 3);
    }
  }

  // 纵轴标题
  ctx.save();
  ctx.translate(11, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = '9.5px "Inter", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(126, 146, 172, 0.8)';
  ctx.fillText('海拔 (km MSL)', 0, 0);
  ctx.restore();

  // ══ 11. 角标信息 ══════════════════════════════════════════════════════
  const info = `α ${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}°  ${LEVEL_BY_KEY[focusLevel].hpa}hPa  τ ${section.ray.opticalDepth
    .toFixed(2)
    .padStart(4, '0')}  受光 ${((section.levels.find((l) => l.key === focusLevel)?.lit ?? 0) * 100).toFixed(0)}%`;
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  const iw = ctx.measureText(info).width + 15;
  roundRect(ctx, padL + plotW - iw - 4, padT + 5, iw, 19, 6);
  ctx.fillStyle = 'rgba(5, 8, 15, 0.78)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 216, 156, 0.94)';
  ctx.textAlign = 'left';
  ctx.fillText(info, padL + plotW - iw + 3, padT + 18);

  ctx.restore();
  return hits;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
