# aetherglow · 交接状态（HANDOFF.md）

> 跨会话、跨 Harness 的状态凭据；里程碑完成时覆写，全文约 40 行以内。

## 当前进度

他人提交的第二轮审查修复（15 项缺陷 + 6 项算法升级）已审阅、验证、提交并部署。
随后在浏览器里实跑生产站，发现并修复三处线上可见的语义混用。

- 分支 `main`，HEAD `1d25ea9`，与 origin 同步
- 生产站 https://aetherglow.pages.dev（`index-BvqFDWIu.js`）
- **GitHub 推送不会自动触发 Pages 构建**，仍需手动 `wrangler pages deploy dist`

## 已验证通过

| 命令 | 结果 |
| --- | --- |
| `npm.cmd test` | 10 文件 / 296 项，全通过 |
| `npm.cmd run typecheck` | 通过，无错误 |
| `npm.cmd run build` | 成功；JS 444.38 kB / gzip 155.00 kB |
| 线上浏览器实跑 | 置信度可验算、云底同源、上限文案与实测一致 |

## 阻塞问题

- 仍无真实历史观测标签；当前校准只证明合成场景与物理不变量，不证明实战准确率。
- 权重、经验否决、云光学厚度映射和单次/经验散射仍是启发式近似。
- 集合输出是原始成员频率，未经独立观测可靠性校准，不是已校准概率。
- Open-Meteo 免费额度是真瓶颈（单次查询 106.5 单位，5000/小时 ≈ 46 次/小时）。

## 下一步

1. 采集带日期、地点、晨昏与实测强度的标签，再运行 `npm.cmd run validate` 做样本外校准。
2. 不要跑密集联网标定；复用缓存并限流。改物理参数后跑 `scratch/*-probe.ts` 复核锚点。
3. 若要让 push 即部署，需在 Cloudflare Dashboard 里把 Pages 项目接 GitHub。

## 上次会话

- 日期：2026-11-15
- Harness：ZCode
- 备注：审阅并部署他人提交的第二轮审查修复；修掉三处线上语义混用（云底、置信度可验算、上限文案）。
