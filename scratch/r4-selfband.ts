/** 量化 selfPathKm 与 skyOpening 自遮挡各自的影响 */
import { cloudLayerTau, cloudLayerDirectTransmittance, cloudBetaPerKm } from '../src/engine/optics';
const cases: Array<[string, number, number, number, number]> = [
  // label, cover, thicknessKm, betaBase(τ_full/thickness), elementKm
  ['600hPa 45% 黄金层', 0.45, 1.4, 10 / 1.4, 60],
  ['600hPa 100% 满铺', 1.0, 1.4, 10 / 1.4, 60],
  ['300hPa 90% 卷云', 0.9, 1.8, 0.865 / 1.8, 120],
  ['900hPa 95% 低云', 0.95, 0.7, 12 / 0.7, 30],
];
console.log('层                    selfPath=2×厚度        selfPath=实际斜程82.9km');
for (const [label, c, t, beta, elem] of cases) {
  const shortT = cloudLayerDirectTransmittance(c, t * 2, beta, elem);
  const longT = cloudLayerDirectTransmittance(c, 82.9, beta, elem);
  console.log(`${label.padEnd(22)} T=${shortT.toFixed(4)} τ=${(-Math.log(shortT)).toFixed(3)}    T=${longT.toFixed(4)} τ=${(-Math.log(longT)).toFixed(3)}`);
}
