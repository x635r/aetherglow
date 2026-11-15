# AetherGlow · 穹霞

> 专业级朝晚霞（火烧云）物理预测引擎 —— 三维光路追踪 + 等压面加密云层 + CAMS 气溶胶光谱消光 + 地形高程遮挡修正

免 API Key，纯前端物理计算，可直接部署到 Cloudflare Pages。

---

## 它和别的「火烧云预测」有什么不同

大多数工具的做法是：`低云 < 30% && 中云 > 40% && 高云 > 30% → 大烧`。这是经验表格，不是物理。

AetherGlow 把「云为什么会被点着」拆成四个互相独立的物理量，任何一项归零，那层云对晚霞就没有贡献：

| 判据 | 物理含义 | 归零的后果 |
|---|---|---|
| **受光** `cloudLitFactor` | 该高度的云此刻是否在地影线之上 | 头顶云已入影 → 不烧，但更远的同层云仍在烧 |
| **透过** `rayMarchingTransmittance` | 阳光穿到该云层还剩多少（Beer–Lambert + 地形 + 曲率） | 远处云墙/山体挡住光 → 本地云幕虚高评分被剔除 |
| **可见** `isVisibleFromObserver` | 观测者视线是否被地平线切断 | 云太低太远 → 你看不见，再亮也白搭 |
| **质量** `cloudScreenQuality` | 这层云「被点亮后好不好看」 | 太薄无云可烧，太厚自我遮挡 |

这四条同时成立才有分，所以不会出现「头顶满铺高积云但天边全黑却报大烧」这类典型误判。

---

## 五步物理管线

### Step 1 — 天文几何与光路采样网格

```
观测点 → NOAA 太阳位置算法 → 日出/日落时刻
      → 沿事件方位角用**球面大圆正解**铺 6 个环：0 / 30 / 80 / 150 / 280 / 450 km
      → 时间窗 [T₀−20min, T₀+40min]，步长 2min，共 31 帧
```

用的是 `destinationPoint()`（大圆正解），不是平面经纬度偏移 —— 所以在高纬和跨越反子午线时不会产生拉伸畸变。

### Step 2 — 等压面加密云层与黄金云层提取

**十个等压面**：`1000 / 925 / 850 / 700 / 600 / 500 / 400 / 300 / 250 / 200 hPa`，各自取**云量 + 位势高度 + 温度 + 相对湿度**。

> 只取**三模型交集**的层：逐模型实测 GFS 20 层、ICON 15 层、**ECMWF 仅 12 层**。
> 扩到 21 层会让默认主源 ECMWF 大部分为空，反而更差。
> 新增的三层：`1000hPa`（雾/层云，此前完全缺失）、`250/200hPa`（卷云顶，二烧的最后画布）。

- 黄金层 = 600 / 500 hPa（约 4.2 / 5.5 km）—— 火烧云主战场
- 高云层 = 400 / 300 hPa（约 7.2 / 9.2 km）—— 紫霞二烧来源
- 近场加权：0 km 权重 0.66、30 km 权重 0.34

云幕质量函数在 25–75% 云量区间取最大，低于 5% 视为无云，高于 78% 快速衰减（云幕沉入自身阴影）。

### Step 3 — 曲率切线光追与远方云墙一票否决

核心几何式（等效地球半径法，`R_eff = 7435 km` 含标准大气折射）：

```
H_ray(d) = H_target + d·tan(α) + d² / (2·R_eff)
```

逐环判断：

1. `H_ray(d) ≤ 0` → 光线撞上地球本体（晨昏线），后续不再透光
2. `H_dem(d) > H_ray(d)` → 撞山，透过率归零（消灭「高原虚标」）
3. 该环该高度的真实云量 → `τ += −ln(1−c)·κ`
4. 降水 > 0.5 mm/h → 额外叠加 τ

**注意两处容易搞错的地方**：

1. 曲率项 `d²/(2R_eff)` 本身已经包含地平线下沉，不能再额外叠加 `dip()` 修正 —— 重复计算是同类项目最常见的物理错误。
2. `ray.transmittance` 是**有效照明度**（含黄昏散射），不是"直射光还剩多少"。
   太阳越低散射占比越高，它会回升。要直射份额请用 `ray.directTransmittance`。
   早期版本把它当直射透过率显示在界面上，出现过"太阳还挂在 +10°、透过率 2×10⁻¹¹"
   这种荒谬数字，并导致剖面图永远判定"已入地影"、连光路和太阳都不画。

**逐环评估而不是只看头顶**，是「本地无云、天边大烧」能被正确识别的关键：

```
从每个云环自身位置沿太阳方向重新积分：
T_to_ring(r) = exp(−∫ring→sun κ(s) ds)
score_r = 质量 × 受光 × T_to_ring × 可见性 × 近远权重
取 max(score_r)
```

日落时低角度光线在近处贴着云层掠过，头顶那层云是暗的；但 450 km 外的同一层云仍高高在上被照得通红 —— 这正是长焦拍摄机会的物理来源。

### Step 4 — CAMS 气溶胶光谱消光

三通道（610 / 550 / 465 nm）分开积分：

```
τ_Rayleigh ∝ λ⁻⁴          （洁净大气：短波抽干 → 橙红底色）
τ_aerosol  ∝ λ^(−α_ang)    （粗颗粒：等量削弱 → 全场洗白）
```

- **水晶天加成**：`AOD < 0.18` 且能见度 > 20 km 且沙尘少 → 饱和度 ×1.25，标记「水晶红」
- **雾霾降权**：`AOD > 0.5` 或 `PM2.5 > 75` 且湿度 > 80% → 指数级惩罚
- **吸湿增长**：高湿下气溶胶粒径膨胀，米氏消光非线性上升

颜色不是配出来的：直射光的 RGB 是沿真实光路积分得到的，色相/饱和度直接进入评分。

### Step 5 — 综合量化与分级

```
每层屏幕分数  sᵢ = 质量ᵢ × 受光ᵢ × 有效照明ᵢ × 可见ᵢ
角色并集       S_role = 1 − Π(1 − sᵢ)        （指数—随机重叠，不是相加）
鲜艳度 = 1.31 × Σ(权重_role × S_role) / 1.25
        × 晨昏辉光 × 光谱饱和度 × 浑浊惩罚 × 红蓝纯度
        × Path 2 观测对比度 × 地形否决 × 云墙否决
```

Path 2 使用有实际贡献云块的代表高度与距离，并按可见面积比计算观测对比度；
深暮光下不再重复施加绝对亮度惩罚。

**为什么是并集而不是求和**：600hPa 和 500hPa 占据的是同一片视野的两个高度，
把两者的"发光面积"相加等于重复计算天空。早期版本用线性求和，
结果「45% 黄金层」反而不如单层，且最优七层配置低于任一两层组合。

| 鲜艳度 | 分级 |
|---|---|
| < 0.05 | 无烧 |
| 0.05 – 0.2 | 微微烧 |
| 0.2 – 0.4 | 小烧 |
| 0.4 – 0.6 | 中烧 |
| 0.6 – 1.0 | 大烧 |
| 1.0 – 1.5 | 特大烧 |
| > 1.5 | 世纪大烧 |

百分制标定：0.6 → 67 分，1.0 → 84 分，1.5 → 94 分。

---

## 紫霞二烧不是特判

9.2 km 卷云在太阳 `α ≈ −3°` 时仍处于**半受光**状态，因为该高度的地平线比地面低约 3.1°：

```
云受光 ⇔ α > −acos(R / (R+H))    （真实半径 + 0.55° 折射余量）
```

而这时直射光已红移到 600 nm 以上，再叠加一层很弱的高层大气散射尾 —— 于是呈现紫红余晖。这是几何与光谱的必然结果，代码里没有任何 `if (isAfterglow)` 分支。

---

## 云海反转

观测者在低云之上（`h_obs > 低云顶 + 120m`）时，低云从「遮挡物」变成「脚下的反射幕布」：权重提升、受光强制抬升、附加 +0.16~0.22 鲜艳度。这是把机位滑块从 0 m 拉到 1500 m 时评分会跳变的物理原因。

---

## 技术栈

- **前端**：Vite + React 18 + TypeScript + Tailwind CSS
- **图表**：Chart.js（分钟级曲线上限 31 帧 × 多模型对照）
- **Canvas**：自研 2D 光路剖面渲染器（`src/render/sectionRenderer.ts`）
- **状态**：Zustand
- **数据**：Open-Meteo（ECMWF IFS / NOAA GFS / DWD ICON）+ CAMS 气溶胶 + Copernicus DEM
- **测试**：Vitest，**293 个用例**（校准 13 · 物理单元 36 · 不变量 48 · 回归 133 · 集合 11 · 验证指标 27 · 极区 3）

## 目录结构

```
aetherglow/
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── tsconfig.json
├── wrangler.toml                  # Cloudflare Pages 配置
├── docs/
│   └── RESEARCH-2026-11.md        # 全网调研（SunsetBot 教程全量数据 / 数据源审计 / 对标）
├── tools/
│   └── validate.ts                # 验证脚手架（CSV 标签 → Brier/AUC/TSS/混淆矩阵）
├── labels.example.csv             # 实测标签模板
├── CHANGELOG-physics.md           # 两轮修复记录
├── src/
│   ├── main.tsx
│   ├── App.tsx                    # Bento Grid 布局装配
│   ├── engine/
│   │   ├── SunsetPhysicsEngine.ts # 五步管线主入口
│   │   ├── astro.ts               # 太阳位置 / 日出日落 / 球面大圆
│   │   ├── optics.ts              # 光路几何 / 地影 / 云相态 / 概率化云隙 / 有效地面
│   │   ├── spectral.ts            # CAMS 气溶胶光谱消光 / AOD 污烧门槛
│   │   ├── constants.ts           # 物理常量 / 分级 / 主题色
│   │   └── types.ts               # 全量类型定义
│   ├── data/
│   │   ├── openMeteo.ts           # 批量请求 / 跨模型补齐 / 缓存 / 429 退避
│   │   ├── ensemble.ts            # ECMWF 50 成员集合概率（成本 91.8 单位/次）
│   │   ├── ozone.ts               # NASA POWER 臭氧总柱量
│   │   └── geocode.ts             # 城市搜索与快捷入口
│   ├── render/
│   │   └── sectionRenderer.ts     # 光路剖面 Canvas 渲染
│   ├── state/
│   │   └── store.ts               # Zustand 全局状态
│   ├── styles/
│   │   └── index.css              # 设计令牌 / 玻璃拟态 / 动画
│   └── ui/
│       ├── primitives.tsx         # Panel / Metric / Bar / Segmented
│       ├── TopBar.tsx             # 控制栏
│       └── cards/
│           ├── HeroScore.tsx      # 主评分卡（流体渐变）
│           ├── RayMarchCard.tsx   # 光路剖面 + 时间滑块
│           ├── TimelineCard.tsx   # 分钟级曲线
│           ├── TacticalCard.tsx   # 机位战术 + 无人机模拟器
│           ├── CloudProfileCard.tsx # 云层剖面 + AOD 仪表
│           ├── MultiModelCard.tsx # 多源交叉验证
│           ├── DiagnosticsCard.tsx# 逐层可追溯诊断
│           └── SkyMapCard.tsx     # 区域热力分布
└── tests/
    ├── engine.test.ts             # 物理单元（36）
    ├── invariants.test.ts         # 物理不变量与端到端回归（48）
    ├── regressions.test.ts        # 审查缺陷回归（139）
    ├── ensemble.test.ts           # 集合评分（11）
    ├── validation.metrics.test.ts # 验证指标定义（30）
    ├── calibrationScenarios.ts    # 典型场景与逐环覆盖夹具
    ├── calibration.test.ts        # 校准回归（12）
    ├── audit-fixes.test.ts        # 本轮光路与缺测修复（10）
    ├── data-race.test.ts          # 数据取消隔离与边界（3）
    ├── store-race.test.ts         # 地点切换请求竞态（1）
    └── polar.test.ts              # 极区边界（3）
```

---

## 运行

```bash
npm install
npm run dev        # http://127.0.0.1:5199
npm run build      # 类型检查 + 生产构建
npm test           # 293 个测试
npm run validate   # 用实测标签评估准确率（见下方「验证」）
```

## 部署到 Cloudflare Pages

```bash
npx wrangler pages deploy dist --project-name aetherglow
```

构建命令 `npm run build`，输出目录 `dist`（`wrangler.toml` 已配置）。

---

## 数据源与限流

单次查询合并为 **4 个请求**（前三个乐观并发，集合请求异步追加）：

| 请求 | 内容 | 配额成本 |
|---|---|---|
| `/v1/forecast` | 6 环 × 3 模型 × 40 变量，一次批量 | 1 次调用 |
| `/v1/air-quality` | 6 环的 AOD / PM2.5 / 沙尘 | 1 次调用 |
| `/v1/elevation` | 6 环的真实 DEM 海拔 | 1 次调用 |
| `/v1/ensemble` | 3 环 × 6 变量 × **50 个 ECMWF 扰动成员** | **91.8 单位** |

缓存策略：localStorage TTL 18 分钟（历史日期 6 小时），429 时指数退避重试（最多 3 次），同 URL 请求内存去重。

### 实测验证过的变量（2026-11）

Open-Meteo 会**接受很多参数名但恒返回 null**。下表全部经过逐变量非空率实测：

| 变量 | 状态 | 用途 |
|---|---|---|
| `cloud_cover_XXXhPa` × 7 | ✅ 3 模型全可用 | 分层云量（核心） |
| `geopotential_height_XXXhPa` × 7 | ✅ 全可用 | 层高度 |
| `temperature_XXXhPa` × 7 | ✅ 全可用 | **云相态判别**（2026-11 接回） |
| `relative_humidity_XXXhPa` × 7 | ✅ 全可用 | **冰云近饱和判据**（2026-11 新增） |
| `direct_radiation` / `diffuse_radiation` | ✅ 全可用 | **实测散射/直射比**，替代经验 `diffuseWeight` |
| `freezing_level_height` | ⚠️ GFS/ICON 有，ECMWF 无 | 冰/水云辅助判据，已做跨模型补齐 |
| `boundary_layer_height` | ⚠️ **仅 GFS** | 霾层厚度（浅霾可越过），已做跨模型补齐 |
| `cloud_base` / `cloud_top` | ❌ **参数被接受但 48/48 全 null** | 不可用，勿再尝试 |
| `cloud_optical_depth` | ❌ 400 不支持 | — |
| `aerosol_optical_depth_XXXnm` | ❌ 400 不支持（只有 550nm） | Ångström 只能由 dust/PM 比例推断 |
| `ozone` | ⚠️ 是**近地面浓度**（µg/m³），非总柱量 | 不能用于 Chappuis 带 |

### 数据源审计：我们到底能用什么（2026-11 实测）

对 Open-Meteo 做了逐变量探测（60+ 变量 × 3 模型 × 6 环），结论如下。
**"文档里有" ≠ "返回真数据"** —— 大量参数会被 200 接受但恒返回 null。

| 变量 | ECMWF | GFS | ICON | 结论 |
|---|---|---|---|---|
| `cloud_cover_XXXhPa` ×7 | ✅ | ✅ | ✅ | 核心输入 |
| `geopotential_height_XXXhPa` ×7 | ✅ | ✅ | ✅ | 层高度 |
| `temperature_XXXhPa` ×7 | ✅ | ✅ | ✅ | 云相态判别 |
| `relative_humidity_XXXhPa` ×7 | ✅ | ✅ | ✅ | 假云幕剔除 |
| `direct/diffuse_radiation` | ✅ | ✅ | ✅ | 实测散射比 |
| `sunshine_duration` | ✅ | ✅ | ✅ | 日照时长 |
| `total_column_integrated_water_vapour` | ✅ | ✅ | ❌ | 吸湿增长强度 |
| `freezing_level_height` | ❌ | ✅ | ✅ | 冰/水云辅助 |
| `boundary_layer_height` | ❌ | ✅ | ❌ | 霾层厚度 |
| `cloud_base` / `cloud_top` | ❌ | ❌ | ❌ | **空壳：200 但 48/48 null** |
| `cloud_optical_depth` | ❌ | ❌ | ❌ | 400 不支持 |
| `aerosol_optical_depth_XXXnm` | — | — | — | 只有 550nm，无分波长 |
| `relative_humidity_2m`（空气质量） | — | — | — | **72/72 全 null** |
| `ozone`（空气质量） | — | — | — | 近地面浓度，非总柱量 |

**跨模型补齐**：`boundaryLayerHeight` / `freezingLevelHeight` 在数据层做双向补齐
（都是大尺度标量，跨模型借用误差远小于"用 0"）。

### 集合预报：原始频率与校准边界

`/v1/ensemble` 返回 ECMWF 50 个扰动成员。我们让每个成员跑一套轻量评分
（保留地影几何、云幕质量、角色并集、整层阴天/低云锁死否决）。
落在"能烧"区间的成员比例是**原始集合频率**，可作为概率估计的输入，
但仍需用独立实测标签做可靠性校准，不能直接解释为已校准的发生概率。

**成本警告**：单次请求计费 **91.8 个配额单位**（`x-ratelimit-cost`），
免费额度 600 单位/分钟 → **每分钟最多约 6 次**。因此：
- localStorage 缓存 TTL 30 分钟
- in-flight 去重
- 失败静默返回 null，退回确定性估计，绝不重试轰炸

---

## 已知限制

> 2026-11 做过一次全面物理审查，修复了 16 项缺陷（详见 `CHANGELOG-physics.md`）。
> 下面区分「已修复」与「仍是局限」，不掩饰后者。

**数据层**

- ECMWF `ecmwf_ifs025` 与 `icon_seamless` **不提供 `visibility`**（实测恒为 null）。此时由 AOD + 湿度经 Koschmieder 关系反演兜底
- Open-Meteo 只给 `cloud_cover`（覆盖率），不给云光学厚度。本引擎用各层典型云水路径（`LEVEL_MICROPHYSICS`）把覆盖率映射为 τ，属于**气候学近似**，无法区分同层内的薄卷云与浓卷云
- 等压面云量是 0.25°（约 25 km）格点值，无法反映次网格尺度的孤立积云、卷云街、云洞
- 地形只沿太阳方位角取 6 个环，不对全象限做遮挡分析；不含建筑天际线
- 空气质量接口只覆盖到 **+6 天左右**，之后 AOD 全为 null。引擎现在会把这种情况判为 `available=false`（`aodValid` 逐点标记），置信度随之下降，而不是拿气候学中值冒充观测

**物理层（仍存在的近似）**

- 只有单次散射 + Beer–Lambert 消光，没有多重散射。黄昏天空的颜色实际由多次散射主导（Haber et al. 2005）。引擎用 `diffuseWeight` 经验权重表征散射照明，不是严格的 3D 辐射传输
- 掠射气团因子用覆盖率相关的经验上限（`X_max = 1 + 7·cover^1.5`）近似破碎云的缝隙，并在短路径端加了 25 km 软启动消除几何突变
- 气溶胶按单一大气柱混合处理，没有垂直分层（对流层大粒子削弱色彩、平流层小粒子增强，二者效应相反）
- 臭氧 Chappuis 带用双高斯（575/603nm 峰）近似，未使用 Orphal 2016 的实测截面
- 云相态已结合 `levelTempC`、相对湿度与冻结层判别，但等压面温湿度仍只是网格尺度的近似

**标尺层**

- 「世纪大烧」(vividness > 1.5) 在当前合成校准场景范围内尚未达到；这只是样本覆盖结论，不是物理不可达证明。要提高分级辨识度仍需云光学厚度等更精细数据与实测校准
- `dual.burnProbability` 与 `gradeIfBurn` 目前是**未校准**估计（`calibration=0`）

**验证层**

- **仍然没有历史实测验证集。** 所有校准基于物理判据与行业口径区间
- 三源一致性只反映模式分歧，不代表绝对准确率
- 提供了 `npm run validate` 脚手架（CSV 标签 → Brier/BrierSkill/AUC/TSS/Spearman/相邻档/可靠度/混淆矩阵）。填上你自己的实测标签即可得到真实可信度数字

### 这个领域的天花板（诚实交代）

两套独立验证都指向同一结论：**所有系统的技能都集中在「不烧」这一类**。

| 来源 | 指标 | 结论 |
|---|---|---|
| SunsetBot 自公布混淆矩阵（上海 2022-06~2023-12，ERA5） | 列归一化准确率 | 不烧类 **93.7%**，其余五档仅 **5.0%–48.5%** |
| Skyglow（1109 行 / 555 天，严格 train/test） | AUC 0.797 · Brier **0.167** vs 基础率 0.1695 · TSS 0.0076 · Spearman 0.36–0.42 | 排序能力尚可，**几乎没赢过气候态** |

本引擎**没有**做过同类验证。在上面的脚手架跑出真实数字之前，任何"比别的工具更准"的说法都不成立。

---

## 调研与文档

- [`docs/RESEARCH-2026-11.md`](docs/RESEARCH-2026-11.md) —— 全网调研：SunsetBot 四章教程
  全部硬数据、SunsetWx 现状、12 个产品是否真预测颜色、8 个开源项目、
  ISCCP COT 分箱、Chappuis 峰值截面、数据源逐变量审计
- [`CHANGELOG-physics.md`](CHANGELOG-physics.md) —— 两轮修复记录（16 项缺陷 + 数据源扩充 + 集合预报）
- [`labels.example.csv`](labels.example.csv) —— 实测标签模板，配合 `npm run validate`

### 与行业口径的对齐

| 项 | 本引擎 | SunsetBot | 状态 |
|---|---|---|---|
| 分档阈值 | 0.03/0.1/0.2/0.4/0.6/0.8/1.0/1.5/2.0 | 同 | ✅ 已对齐 |
| AOD 分档 | 0.5-0.8 削弱，>0.8 污烧 | 同 | ✅ 已对齐 |
| 有效地面高度 | `z=H·ln(AOD/(0.02H))` | 同 | ✅ 精确复现教程值 |
| 微物理 τ_full | 0.9–19.5 | ISCCP 分箱 0–60 | ✅ 独立验证落在箱内 |
| 云相态 | 层温+RH 动态判别 | 云属经验 | ✅ 更细 |
| 臭氧 Chappuis | 实测柱量驱动 | 未实现 | ✅ 领先 |
| 集合概率 | ECMWF 50 成员 | 无 | ✅ 领先 |
| 云光学厚度 | 气候学近似 | 同（靠卫星云顶亮温） | ⚠️ 共同缺口 |

## 参考

- Corfidi, S. F., *The Colors of Sunset and Twilight*, NOAA/NWS (2014)
- Lee, R. L. & Hernández-Andrés, J., *Measuring and modeling twilight's purple light*, Appl. Opt. 42(3) 445–457 (2003)
- Haber, J., Magnor, M. & Seidel, H.-P., *Physically-based simulation of twilight phenomena*, ACM TOG 24(4) (2005)
- Kasten, F. & Young, A. T., *Revised optical air mass tables and approximation formula*, Appl. Opt. 28(22) (1989)
- Kobayashi et al., *Physical Explanation of Tropospheric Aerosol Effects on Twilight Sky Color*, SOLA 9, 15–18 (2013)

---

## 许可

MIT
