# aetherglow · 交接状态（HANDOFF.md）

> 跨会话、跨 Harness 的状态凭据；里程碑完成时覆写，全文约 40 行以内。

## 当前进度

第五轮外部审查（针对线上 `1d25ea9`）的 **20 项缺陷全部复核确认并修复**，
其中 4 项 P0 会直接废除新特性或反转物理方向。

- 分支 `main`，共 3 个提交（本轮）
- 生产站 https://aetherglow.pages.dev（部署后核对 `index-*.js` 哈希）
- **GitHub 推送不会自动触发 Pages 构建**，仍需手动 `wrangler pages deploy dist`

## 已验证通过

| 命令 | 结果 |
| --- | --- |
| `npm.cmd test` | 10 文件 / 298 项，全通过 |
| `npm.cmd run typecheck` | 通过，无错误 |
| `npm.cmd run build` | 成功；JS 446.36 kB / gzip 155.90 kB |
| `tsx scratch/p0-verify.ts` | 4 项 P0 端到端验证全部 ✅ |
| 浏览器实跑（375px + 1280px） | InfoTip 完整、移动端模型/刷新按钮可见 |

## P0 修复要点（都在 `CHANGELOG-physics.md` 第五轮）

1. 朝霞 COT 参考时刻从「日出前 90min（黑夜）」改为按 mode 搜索；门槛 15°→10°
2. `advectionLagMs` 风向投影 180° 反了；`ringKm=0` 硬编码 0.5h 造成 V 型畸变
3. 集合 `mid×0.3` 使整层阴天否决数学上永不成立（100% 阴天被算成大烧）
4. 高原地下等压面未过滤（云海反转误触发）；`visibleFactor` 绕过地球曲率

## 阻塞问题

- 仍无真实历史观测标签；校准只证明合成场景与物理不变量，不证明实战准确率。
- 权重、经验否决、COT 映射、单次散射仍是启发式近似。
- Open-Meteo 免费额度是真瓶颈（单次查询 106.5 单位，5000/小时 ≈ 46 次）。

## 下一步

1. 采集带日期、地点、晨昏与实测强度的标签，跑 `npm.cmd run validate` 做样本外校准。
2. 不要跑密集联网标定；改物理参数后跑 `scratch/*-probe.ts` 复核锚点。
3. 若要让 push 即部署，需在 Cloudflare Dashboard 把 Pages 项目接 GitHub。

## 上次会话

- 日期：2026-11-18
- Harness：ZCode
- 备注：第五轮审查 20 项全修。P1-6（远端环外推）实测驳回——建议的
  `maxRangeKm` 截断会让整层阴天从 faint 抬成 minor，比原问题更糟。
