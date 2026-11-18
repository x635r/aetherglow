/** 核实审查文档 P0-2：advectionLagMs 的符号与 0km 硬编码 */
import { advectionLagMs } from '../src/engine/astro';

const show = (label: string, v: number) => console.log(label.padEnd(56), (v / 60000).toFixed(1).padStart(6), 'min');

console.log('=== 场景：视线朝西（sightDeg=270°，采样环在正西）===');
// 高空吹西风：windFromDeg=270（风从正西的环方向吹来）→ 应判为朝观测者吹来
show('西风 270 + 视线 270（应从环吹向本地，应有 lag）', advectionLagMs(270, 60, 270, 80));
// 高空吹东风：windFromDeg=90（风从东边、观测者背后吹来）→ 云被吹离
show('东风 90  + 视线 270（应吹离本地，lag 应为 0）', advectionLagMs(90, 60, 270, 80));

console.log('\n=== 场景：视线朝东（sightDeg=90°）===');
show('东风 90  + 视线 90（应从环吹向本地，应有 lag）', advectionLagMs(90, 60, 90, 80));
show('西风 270 + 视线 90（应吹离本地，lag 应为 0）', advectionLagMs(270, 60, 90, 80));

console.log('\n=== 0km 环硬编码 0.5h 造成的非单调 V 型（vAlong=100km/h）===');
for (const ring of [0, 30, 80, 150, 280, 450]) {
  show(`ring=${ring}km`, advectionLagMs(270, 100, 270, ring));
}
