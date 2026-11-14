# aetherglow · 交接状态（HANDOFF.md）

> 跨会话、跨 Harness 的唯一状态凭据。**提交进 git，不要加进 .gitignore。**
> 会话结束 / 换 Harness / 里程碑完成时**覆写**，全文 40 行以内。
> 模板：`D:/dev/docs/templates/HANDOFF.md`

## 当前进度

外部审查文档（`aetherglow-core-2026-11-14.zip`）的 15 项缺陷全部修复，
并完成 5 项算法升级。线上已部署（Cloudflare Pages，提交 `c54fb89`）。

- 分支 `main`，HEAD `c54fb89`，与 origin 同步
- 生产站 https://aetherglow.pages.dev（Pages 项目 `aetherglow`）
- **GitHub 推送不会自动触发 Pages 构建**，目前手动 `wrangler pages deploy dist`

## 已验证通过

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，无错误 |
| `npm test` | 273 个用例 / 7 文件，全通过 |
| `npm run build` | 成功（439KB / gzip 153KB） |
| 真实 API 端到端 | 三模型 SW/TOA/CAPE/wind500 均 72/72 非空，臭氧 261 DU 实测 |
| 浏览器实跑（线上） | UI 无回归，10 层等压面 / 集合预报 / 双头输出均正常 |

## 阻塞问题

- **Open-Meteo 免费额度是真瓶颈**：实测 `cost = 0.102 × 变量 × 地点 × 成员`，
  单次查询 6 环 × 58 变量 × 3 模型 = **106.5 单位**，免费额度 5000/小时
  只够 **46 次查询/小时**。COT 标定（442 个晴空样本）就吃掉过 62% 额度。
  已加缓存兜底与额度冷却，但根治需付费 key 或自建实例。

## 下一步

1. **不要再跑密集网络标定**（`scratch/agopt/*.ts` 那种多城×多天×多模型的循环）
   —— 一次就能打满小时额度。要用必须限流并复用缓存。
2. 若要 push 即部署，需在 Cloudflare Dashboard 里把 Pages 项目接 GitHub
   （构建命令 `npm run build`，输出目录 `dist`）。
3. 实测标签集仍缺 —— `npm run validate` 就绪，等真实观测数据才能出 Brier/AUC。

## 上次会话

- 日期：2026-11-14
- Harness / 模型：ZCode · opencode-go-responses/deepseek-v4.1-flash
- 备注：修完审查 15 项 + 5 项算法升级；处理额度耗尽导致整页空白的线上事故
