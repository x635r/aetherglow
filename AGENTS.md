# aetherglow · 项目规范（L3）

> 由 `D:/dev/docs/templates/project-AGENTS.md` 生成。ZCode / dsh / Kimi Code 进入本目录会自动加载。
> 工作区级规范见 `D:/dev/AGENTS.md` —— 进入本目录后**不会**自动加载，所以下面必须能独立看懂。
> 只写这个项目特有、别处查不到的事。

## 这是什么

专业级朝晚霞（火烧云）物理预测引擎：三维光路追踪 + 等压面加密云层 + CAMS 气溶胶光谱消光 + 地形高程遮挡修正。免 API Key，纯前端物理计算。

## 构建与运行

```powershell
# 无外网：依赖已在本机，不要联网重装
npm run dev        # 本地开发
npm run build      # 生产构建
```

## 技术栈与目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 物理引擎与界面 |
| `public/` | 静态资源 |
| `docs/` | 物理模型说明 |
| `CHANGELOG-physics.md` | 物理模型改动记录 |

## 这个项目的坑

| 症状 | 原因 | 绕行 |
| --- | --- | --- |
| `npm install` 卡住或报 `Connection was reset` | 本机无外网 | 依赖已在 `node_modules/`，**不要删、不要重装** |
| `.ps1` 报语法错误 / 中文乱码 | PowerShell 5.1 把无 BOM 的 UTF-8 当 GBK | 含中文的 `.ps1` 必须存成 UTF-8 **带 BOM** |
| `npm.ps1 cannot be loaded` | 执行策略是 Restricted | 用 `npm.cmd`，或 `-ExecutionPolicy Bypass` |

## 跨项目依赖

- 无（本项目不引用其它项目的源码或数据）

## 接力

会话结束前按 `D:/dev/docs/templates/HANDOFF.md` 覆写本项目的 `HANDOFF.md`。
