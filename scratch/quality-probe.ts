/**
 * 探针：检查 cloudScreenQuality 的云量响应曲线形状，
 * 以及 live 页面上「250hPa 满铺卷云质量 0.90」是否符合 README 契约
 * （「25–75% 取最大，高于 78% 快速衰减」）。
 * 运行：npx tsx scratch/quality-probe.ts
 */
import { cloudScreenQuality } from '../src/engine/SunsetPhysicsEngine';

const cov = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.78, 0.85, 0.9, 0.95, 1];

for (const [role, key, rh] of [
  ['high', '250', 60],
  ['high', '300', 60],
  ['golden', '600', 60],
  ['mid', '700', 60],
  ['low', '850', 60],
] as const) {
  const row = cov.map((c) => `${(c * 100).toFixed(0)}%→${cloudScreenQuality(c, role, key, rh).toFixed(3)}`);
  console.log(`${role.padEnd(6)} ${key.padEnd(4)} ${row.join('  ')}`);
}
