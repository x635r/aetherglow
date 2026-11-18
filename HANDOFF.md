# aetherglow · 交接状态（HANDOFF.md）

> 跨会话、跨 Harness 的状态凭据；里程碑完成时覆写，全文约 40 行以内。

## 当前进度

第六轮审查（针对 `3fafd82`）的 **12 项缺陷全部复核确认并修复**
（3 P0 / 8 P1 / 2 P2），并完成对标 Apple Weather / Linear 的前端重设计。

- 分支 `main`
- 生产站 https://aetherglow.pages.dev（部署后核对 `index-*.js` 哈希）
- **GitHub 推送不会自动触发 Pages 构建**，仍需手动 `wrangler pages deploy dist`

## 已验证通过

| 命令 | 结果 |
| --- | --- |
| `npm.cmd test` | 10 文件 / 304 项，全通过 |
| `npm.cmd run typecheck` | 通过，无错误 |
| `npm.cmd run build` | 成功；JS 450.93 kB / gzip 157.16 kB |
| `tsx scratch/anchor-baseline.ts` | 10 个校准锚点全部在区间内 |
| `tsx scratch/r4-probe.ts` | NEW-01 三种构型全部符合物理 |
| 浏览器 1440px / 375px | 右轴 `1000` 完整、InfoTip 无裁剪、最小字号 11.0px、无横向溢出 |

## P0 修复要点（详见 `CHANGELOG-physics.md` 第六轮）

1. **NEW-01** `skyOpening` 漏算本层 → 100% 满铺密云有效照明度 0.857（应≈0）。
   同时把其它层的 `1−c` 改成按每层透过率累乘（原式把薄卷云当不透明遮板）。
2. **NEW-02** `coverAtObserverDistance` 的注释与实现矛盾 → **改注释不改代码**：
   实测线性衰减会破坏「环透过率随距离单调不增」（末尾环 T 跳回 1.00）。
3. **NEW-03** 朝霞 `cotRef` 的 `max(bestAlt, midAlt)` 高估 2.7–5.0° →
   搜索判据与返回值统一用辐射窗口中点高度角。

## 阻塞问题

- 仍无真实历史观测标签；校准只证明合成场景与物理不变量，不证明实战准确率。
- 权重、经验否决、COT 映射、单次散射仍是启发式近似。
- Open-Meteo 免费额度是真瓶颈（单次查询 ~106.5 单位，5000/小时 ≈ 46 次）。

## 下一步

1. 采集带日期、地点、晨昏与实测强度的标签，跑 `npm.cmd run validate`
   做样本外校准（已补 ozone 传递与 90s 节流）。
2. 改物理参数后跑 `scratch/anchor-baseline.ts` + `scratch/r4-probe.ts` 复核锚点。
3. 若要让 push 即部署，需在 Cloudflare Dashboard 把 Pages 项目接 GitHub。

## 上次会话

- 日期：2026-11-19
- Harness：ZCode
- 备注：第六轮 12 项全修 + 前端重设计（11px 字号底线、12 列 Bento、
  三视图诊断分段切换）。NEW-02 实测驳回「线性衰减」建议，改注释对齐实现；
  NEW-01 中途试过 5 种封堵形状，放弃了能让测试过关但无物理依据的调参版本。
