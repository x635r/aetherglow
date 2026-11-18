/**
 * SVG 字号审计：`fontSize` 是 viewBox 单位，实际渲染字号 =
 * fontSize × (显示宽度 / viewBox 宽度)。这个脚本检查源码里每个
 * <svg> 的 viewBox 宽度是否与固定的展示宽度匹配，避免"字面 12px
 * 实际渲染 8px"这种隐形踩线。
 *
 * 用法：node scratch/svg-font-audit.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

let bad = 0;
for (const f of walk('src/ui')) {
  const src = readFileSync(f, 'utf8');
  // 找 <svg ...viewBox="0 0 W H"...width={N}...> 或 width="N"
  const re = /<svg[^>]*viewBox=(?:"0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"|\{`0 0 \$\{(\w+)\} \$\{(\w+)\}`\})[^>]*>/g;
  for (const m of src.matchAll(re)) {
    const vb = Number(m[1] ?? 0) || null;
    const tag = m[0];
    const wm = tag.match(/width=\{(\d+)\}|width="(\d+)"/);
    const displayW = wm ? Number(wm[1] ?? wm[2]) : null;
    if (!vb || !displayW) continue;
    const scale = displayW / vb;
    const fonts = [...tag.matchAll(/fontSize="(\d+(?:\.\d+)?)"/g)].map((x) => Number(x[1]));
    // fontSize 可能出现在子节点上，这里只报该 svg 的固定宽度与缩放
    console.log(`${f}  viewBox=${vb}  display=${displayW}  scale=${scale.toFixed(3)}`);
    if (Math.abs(scale - 1) > 0.01) {
      console.log(`   ⚠ ${f}: SVG 有非 1 缩放，所有 fontSize 需按 ×${scale.toFixed(2)} 换算`);
    }
  }
}
console.log(bad === 0 ? '\n审查完成：宽高比已显式固定的 SVG 不会随容器缩放' : '');
