# 晚霞预测：全网调研与数据源审计

**时间**：2026-11
**方法**：WebFetch 直取官方文档与教程原文；逐变量探测 API 非空率；
GitHub API 枚举近期仓库；对每个关键数字标注 VERIFIED（抓到原文）或 INFERRED。

---

## 一、结论摘要

这个领域**没有任何产品做到全物理辐射传输**。四种工程路线：

| 路线 | 代表 | 物理保真度 | 说明 |
|---|---|---|---|
| A. 云层启发式评分 | SunsetWx、多数 App | 低 | 只加权三层云 + 湿度/气压 |
| B. 射线投射 / 可见性图 | Sunsethue、本引擎 | 中 | 几何正确，辐射简化 |
| C. 光谱透射 + 色度学 | sunset-color-today、本引擎 | 中高 | Beer–Lambert + CIE |
| D. 完整辐射传输 | Haber et al. 2005、libRadtran | 高 | **一次半球天空 2 小时**，无法实时 |

决定性事实：**没有免费全球云光学厚度（COT）预报**。COT 只存在于卫星反演（临近时刻），
从不存在于任何预报产品。这是全行业共同的数据缺口。

---

## 二、SunsetWx（美国商业，2015 年起未变）

**VERIFIED**：`sunsetwx.com/about-the-model/` 内容自 2016 至 2026 年**实质未变**。
`sunburst.sunsetwx.com/v2/docs/` 返回 404，**没有 v2**。

- 数据源：**4 km NAM**，地面至 200mb 全对流层
- 三输入：湿度（权重最高，高层最高、近地面显著降权因为它挡光）、
  气压与气压倾向（次高）、云量（主要用来标记阴天，高云对 Vivid 最关键）
- **无气溶胶项、无光谱物理、无公开公式**

**唯一可借鉴的硬信息** —— Sunburst API 的 composite 分档（两套互相矛盾，说明标定是拍脑袋的）：

| | Poor | Fair | Good | Great |
|---|---|---|---|---|
| 官网 sunrise | ≤−223 | −223…−40 | −40…142 | >142 |
| 官网 sunset | ≤−262.75 | −262.75…−75 | −75…70 | >70 |
| API sunrise | −771…−224 | −224…−113.4 | −113.4…105.8 | 105.8…325 |
| API sunset | −650…−219.5 | −219.5…−76 | −76…67.49 | 67.49…211 |

教训：他们把线性判别值按**百分位**映射到百分比，不是映射到概率。
「50%」不等于「50% 概率」，等于「历史中位数」。

**结论：不值得抄。** 4 km NAM + 三个无气溶胶变量，其全部可转移思想
（高云是画布、近地面湿气有害、气压倾向标记锋面）其他产品都有。

---

## 三、SunsetBot（国内事实标准，唯一完整公开算法）

四章教程（2022-11 首发，2025-04 最后修改）。以下数字均 VERIFIED。

### 3.1 几何：火烧云三角

```
远边界（地影）：h_f(l,t) = (l − v·t)² / (2R)
近边界（云缘）：h_n(l,t) = (l − v·t)² / (2R) + h_CB − (v·t)² / (2R)
日落线速度  ：v = −R · dφ/dt        （φ = 太阳时角）
```

精确霞光深入距离 `L = 2√(2Rh)`：

| 云底 h | 精确值 | 近似值 |
|---|---|---|
| 2 km | 319.23 km | 319.27 |
| 3 km | 390.95 | 391.03 |
| 6 km | 552.78 | 553.00 |
| 8 km | 638.21 | 638.55 |

近似误差 < 0.05%。

**日落线速度实测表**：6.8 km/min（60°N 六月中）到 23.2 km/min（赤道三月中）。
教程附录有 13 纬度 × 12 日期表。工程捷径：`overhead_duration + d(5°)/v`，
其中 `d(5°) ≈ h/tan(5°)`。

观察者仰角（1000km / 100km 内误差 <2%）：

```
z ≈ x·tanθ + x²/(2R)
```

### 3.2 AOD 分档表（表 2.3）——**本引擎已采纳**

| AOD (550nm) | 判定 |
|---|---|
| 0–0.1 | 低于瑞利光学厚度，「水晶天」 |
| 0.1–0.2 | 极少气溶胶，通透 |
| 0.2–0.3 | 较少，较蓝 |
| 0.3–0.5 | 平均，普通通透度 |
| 0.5–0.8 | **明显削弱火烧云** |
| >0.8 | **「污烧」：灰白，再大的云也救不回来** |

### 3.3 气溶胶标高垂直逃逸表（表 2.4）

| 标高 H (km) | 500m 以上剩余 AOD 比例 |
|---|---|
| 0.5 | 37% |
| 1.0 | 60% |
| 1.5 | 72% |
| 2.0 | 78% |
| 3.0 | 85% |
| 4.0 | 88% |

工程含义：**气溶胶被约束在边界层内时，抬高机位极其有效**（H=0.5km 时抬 500m 减少 63% 气柱）；
深对流条件下几乎无效（H=4km 时只减 12%）。

### 3.4 有效地面高度（「抬升地面」效应）

假定日光无法穿透 550nm 消光 > **0.02 km⁻¹** 的空气，该高度成为等效地面：

```
z_eff = H · ln(AOD / (β_c · H)),   β_c = 0.02 km⁻¹
```

**z_eff 对 H 非单调**（在 H ≈ AOD/(e·β_c) 处取极大）。教程实测：
AOD 0.15 → 1.35~2.75 km；AOD 0.14 → 1.32~2.57 km；AOD 0.2 → 1.5~3.0 km。

> **本引擎已实现并精确复现**：AOD 0.14 → 1320~2574m；AOD 0.15 → 1354~2749m。

### 3.5 云属数据（第二章）

| 云属 | 云底 | 厚度/云顶 |
|---|---|---|
| 层云 St | ≤500m | 云顶在 0°C 层以下 |
| 层积云 Sc | 0.5–2.5km | 薄；冷空气型云底 1–2km |
| 积云 Cu | ≥500m，可 >2km | 盛夏云顶 6–7km |
| 积雨云 Cb | 同 Cu | ≥5–6km，常 >12km，极端 >20km |
| 高层云 As | >2500m | >1km，云顶可达对流层顶 |
| 高积云 Ac | >2500m，夏季至 10km | 常仅数百米 |
| 卷云 Ci | >6000m | ≤2–3km；**云底 < −38°C 必为卷云** |
| 卷层云 Cs | >6000m，云底 <−20°C | 2–3km+，云顶 <−38°C |

### 3.6 卷云透明度判据（第四章，上海经验）

设 `t_g` = 红外地面亮温，`t_c` = 探空给出的云顶/云底温度均值，`t_c,avg` 为两者平均。
判据：

```
若  t̂_g − t̂_c < 0.2 (t̂_g − t_c,avg)  →  卷云足够透，能透过大烧
两者接近相等                          →  半透明（「闷烧」）
否则                                  →  卷云封死天空
```

**这是唯一公开的、廉价的「卷云纱会烧 / 卷云盖会封」判别法。** 本引擎可借鉴
（需要红外亮温，目前数据源没有）。

### 3.7 亮度阈值（作者自认是目测、未实测）

> 1/30 入射光 = 明亮；1/1000 = 低价值；< 1/5000 = 不可见

### 3.8 分档（地图页 VERIFIED）

| 鲜艳度 | 分级 |
|---|---|
| 0.001–0.05 | 微烧 |
| 0.05–0.2 | 小烧 |
| 0.2–0.4 | 小到中 |
| 0.4–0.6 | 中烧 |
| 0.6–0.8 | 中到大 |
| 0.8–1.0 | 不完美的大烧 |
| 1.0–1.5 | 典型大烧 |
| 1.5–2.0 | 优质 |
| 2.0–2.5 | 世纪大烧 |

> 本引擎的分档与这一版**不一致**（我们的 0.6 就到大烧）。这是需要在文档里
> 明确的差异，不是 bug —— 但若要和 SunsetBot 对标，应该改成这一版。

### 3.9 混淆矩阵（ERA-5 再分析，上海 2022-06-24 ~ 2023-12-30）

列归一化（每列和为 100%），行 = 实际，列 = 预报：

| 实际\预报 | 基本不烧 | 微烧 | 小烧 | 小到中 | 中到大 | 大烧 |
|---|---|---|---|---|---|---|
| 基本不烧 | **93.71** | 56.52 | 65.00 | 54.17 | 29.17 | 3.03 |
| 微烧 | 0.67 | 6.52 | 0.00 | 0.00 | 1.39 | 3.03 |
| 小烧 | 1.12 | 10.87 | 5.00 | 6.25 | 11.11 | 0.00 |
| 小到中 | 3.25 | 10.87 | 15.00 | 20.83 | 22.22 | 9.09 |
| 中到大 | 1.23 | 10.87 | 10.00 | 14.58 | 29.17 | 36.36 |
| 大烧 | 0.00 | 4.35 | 5.00 | 4.17 | 6.94 | **48.48** |

行归一化：实际大烧中 **61.54%** 被正确预报为大烧，19.23% 报为中到大。
实际基本不烧中 **90.78%** 正确。

**最关键的运营数字：一个「微烧」预报只有约 6.5% 的命中率。**
中间档位几乎不携带信息。作者自己标注：这是 ERA-5 再分析 + 已知良好算法，
即**上限**；真实 GFS 表现更差。

### 3.10 数据源现状

NCEP-GFS + ECMWF（云）、CAMS（AOD）、ERA-5（再分析归档）。
卫星**仅由人工预报员使用**（Himawari-8/9、风云四号可见光/红外目视外推），
**没有卫星 COT 接入、没有 v2、2024 年后没有新增数据源**。

---

## 四、其他产品：谁真的在预测颜色

| 产品 | 预测颜色? | 方法/数字 |
|---|---|---|
| **sunsethue.com** | 是 | "Ray-based v3"；**ICON 0.25°**，1h，00/06/12/18z，78h。反射潜力 0–100%，从观测者投射射线，按累计云量封顶，多射线平均。事后湿度惩罚、黄金时段时长上偏（随纬度季节）。不确定性 = 空间方差 + 时间方差 + 预报时效，无公式 |
| **Alpenglow**（iOS） | 是 | ICON；多层云 + 湿度 + 气压 + 气溶胶；百分比。**「最佳区间 30–70% 中高云」** + 太阳侧地平线开阔。有众包「现场报告」反馈闭环 |
| **sunset-predictor.com** | 是 | 0–100；**90 惊艳 / 70 优秀 / 40 良好**。输入云+高度、能见度/AQI、湿度、气溶胶、风；**理想云高 2000–7000m** |
| SkyCandy / SolarWatch / Helio / Ember / Frey r | 声称 | 无公开方法 |
| **PhotoPills / Ephemeris** | **否** | 纯几何：日出日落、黄金/蓝调时刻、AR 路径。**无云无颜色输入** |
| Yr | 否 | 只有太阳时刻 |
| Windy | 无颜色产品 | 但是 SunsetBot 事实上的 AOD/云剖面查看器（CAMS AOD 550nm 图层） |
| Carrot / Hello Weather | 否 | 商店列表无此功能 |
| 墨迹天气 | 无晚霞产品 | 只有通用预报 |
| 彩云天气 | 无晚霞产品 | 1 分钟降水、1km、83% 准确率、120h 霾 |

**只有 SunsetBot 是有公开方法的中国颜色产品。气象局微博有零散的火烧云临近预报。**

---

## 五、开源项目（2024–2026，GitHub API 实测）

| 仓库 | ★ | 最后推送 | 内容 |
|---|---|---|---|
| `fengfengzhidao/sunsetbot` | 30 | 2025-07 | Go 推送客户端，爬 SunsetBot，无模型 |
| `r-ayin/sunset-prediction` | 34 | 2026-05 | 5 因子启发式：云型 35%、能见度 25%、湿度 15%、降水 10%、总云量 15%。⚠️ **引用了两篇不存在的论文**（Crossref 查无此文），当基线用 |
| `couletian/Skyglow` | 21 | 2026-10 | **文档最好的 ML 尝试**。物理特征 → logit → ridge(α=1.2) → 6 档，加 MLP。1109 行/555 天，基础率 0.1695，**test AUC 0.797，Brier 0.167，相邻档 0.79**。混淆矩阵塌缩到"基本不烧"：默认阈值只有 1 个 TP |
| `b-z/sunsetglow` | 1 | 2026-11 | **SunsetBot 教程的忠实开源实现**。抛物射线追迹、Open-Meteo GFS/ECMWF + CAMS AOD、Terrarium 瓦片地形。常数：`H_RAYLEIGH=8km`、`ÅNGSTRÖM=1.3`、**云消光 10/km 液态、1/km 冰**、RH→云阈值 **80%**、`CLOUD_ELEMENT_KM=30`（概率化云隙）。回测：上海 **Spearman +0.63 / AUC 0.88**；加州 PhenoCam **+0.44 / AUC 0.85** |
| `Her0n24/ACSAF` | 1 | 2026-07 | ECMWF IFS 云+冰水含量、CAMS AOD、13 气压层。**逐层有效 τ：低 2.0 / 中 1.0 / 高 0.3**；r_eff 10µm 水 / 100µm 冰；二烧时长 = 透过率 >0.05 的 60 秒步数 |
| `RaimundoDiaz/sunset-color-today` | 1 | 2026-10 | 19 波长 380–720nm，Rayleigh + Mie + **臭氧 Chappuis** + 水汽 → CIE 1931 → sRGB；沿日落方位 50/150/300km 采样云；NASA POWER 取臭氧/水汽 |
| `NickZhuxy/firecloud-forecast` | 0 | 2026-11 | 可解释的朝晚霞条件预报，含 `research/` 目录 |
| `linuschen-star/FirePhoenixRadar` | 1 | 2026-11 | 台湾枫林的火烧云预报 |

**没有任何开源项目用卫星 COT + 真实标签。** 最接近的是 ACSAF（模式 IWC，非反演 COT）
和 Skyglow（SunsetBot 标签，无卫星）。**这是真实空白。**

---

## 六、学术

- **Lin, Song, Chan, Luo & Li (2026)，《A New Twilight Sky Color Prediction Model
  Based on Machine Learning Methods》，J. Appl. Meteor. Climatol. 65(5)**,
  doi:10.1175/JAMC-D-25-0206.1 —— **VERIFIED via Crossref**。
  深圳朱竹林**视频**观测 + ECMWF + CAMS；三分类：0 无明显色彩 / 1 火烧云 /
  2 晴空橙粉。RF + LightGBM 集成最优。**类别 1（最有价值的）关联：
  高能见度、低总 AOD、低对流降水、低总云量。** 这是近五年最相关的一篇。
- **SkyFinder**：约 **90,000** 张标注图，**53** 台 AMOS 相机，各约一年。
  云的语义分割，非美学标注。
- **Transient Attributes Database**（Laffont et al., ACM TOG 2014）：
  **40 个瞬时属性含 "dusk"/"sunset"**，101 台网络摄像头，众包标注。
  最接近「带标签天空外观数据集」的东西。
- 全天空相机 ML：ResNet/LightGBM 云识别（AJ 2020）；4 类云量分类 5000 图（AMT 2022）；
  SKIPP'D 天空图像/PV 数据集（Sol. Energy 2023）。
- **没有找到任何从 Flickr/Instagram 元数据学习晚霞质量的工作。** 属未探索领域。

---

## 七、物理常数（关键，已核实）

### 7.1 Ångström 指数

`τ_λ/τ_λ₀ = (λ/λ₀)^(−α)`。**α > 2 = 小燃烧颗粒；α < 1 = 海盐/沙尘等大颗粒**
（Schuster et al. 2006, doi:10.1029/2005JD006328）。

**重要警告**：累积模态气溶胶的 `ln τ` vs `ln λ` 曲线**强弯曲**，
α 在 340 与 870nm 之间可差 **3–5 倍**（Eck et al. 1999, doi:10.1029/1999JD900923）。
所以全局固定 α=1.3 是粗平均。

工程默认值（INFERRED，非可引用常数）：

| 类型 | α (440–870nm) |
|---|---|
| 城市/工业 | 1.3–2.0 |
| 生物质燃烧 | 1.6–2.2 |
| 沙漠沙尘 | 0.2–0.8 |
| 海盐 | 0.0–0.6 |

### 7.2 云光学厚度（ISCCP 分类，VERIFIED）

COT 分箱边界：**0, 1.3, 3.6, 9.4, 23, 60, 379**
云顶气压边界：1000, 800, 680, 560, 440, 310, 180, 50 hPa

| 云属 | COT 区间 | 云顶气压 (hPa) |
|---|---|---|
| Ci 卷云 | 0–3.6 | 440–50 |
| Cs 卷层云 | 1.3–9.4 | 440–50 |
| Cb 深对流 | 23–379 | 440–50 |
| Ac 高积云 | 3.6–23 | 680–440 |
| As 高层云 | 9.4–60 | 680–440 |
| Ns 雨层云 | 23–379 | 680–440 |
| Cu 积云 | 9.4–60 | 1000–680 |
| Sc 层积云 | 3.6–60 | 1000–680 |
| St 层云 | 3.6–60 | 1000–680 |

### 7.3 有效半径（ISCCP 反演假设，VERIFIED）

**液态 10µm（T > 260K）；冰 30µm（T < 260K）**。

> ACSAF 用 10µm/100µm，那是建模选择而非反演常数。

### 7.4 液水含量（VERIFIED，Thompson 2007）

| 云型 | LWC (g/m³) |
|---|---|
| 卷云 | **0.03** |
| 雾 | 0.05 |
| 层云 | 0.25–0.30 |
| 积云 | 0.25–0.30 |
| 层积云 | 0.45 |
| 积雨云 | 1.0–3.0 |

交叉验证：`τ ≈ 3·LWP/(2·ρ_w·r_eff)` 给出 100 g/m²、10µm 时 τ≈9，
与 ISCCP 的 3.6–9.4 分箱一致。

### 7.5 臭氧与 Chappuis 带

- 典型柱量 **300 DU**；**220 DU 是臭氧洞阈值**
- 高纬春季平均 **450 DU**，偶超 **600 DU**
- Chappuis 带：**400–650nm，双峰 575 / 603nm**
- **峰值截面 @602.5nm = (5.16 ± 0.03)×10⁻²¹ cm²/molecule**
  （Anderson & Mauersberger 1992, GRL 19:933, doi:10.1029/92GL00780）
- 独立确认：Gorshelev et al. 2014 Table 6 给出 5.10×10⁻²¹ @604.78nm

**臭氧是深暮光偏紫蓝而非纯红的唯一原因** —— 也是 SunsetWx/SunsetBot 谱系
完全省略的那一项。

### 7.6 平流层气溶胶

本底非火山 SAOD ≈ **0.005**（550nm）；皮纳图博 1991 全球峰值 ≈ **0.15**，
约 1 年 e 折衰减。（INFERRED，权威产品是 GloSSAC v2.2x）

### 7.7 多重散射

不存在单一的"增强因子"，它是 τ、g、几何的函数。两流薄云反照率（INFERRED）：

```
R ≈ (1−g)·τ / (2 + (1−g)·τ)
```

g=0.85 时：τ=1 → 0.07；τ=10 → 0.43；τ=60 → 0.82；τ→∞ → 1.0。
破碎云条件下地表 GHI 增强约 **1.3–1.5×** 晴空值。

### 7.8 云顶高度

Ci **6–20km**；Cs >**5.5km**；As 云底 2–8km、厚 1–5km；Ac 云底 2.5–10km；
Sc <2km；Cb 云顶 5–6km 至 >12km，极端 >20km。

---

## 八、数据源审计（逐变量实测非空率）

### 8.1 免费 + CORS + 免 key 的三条路

| 源 | 关键能力 | 限制 |
|---|---|---|
| **Open-Meteo forecast** | 多层云量/位势/温湿、辐射分量、BLH、TCWV | **无 COT、无云底云顶（除 DMI）、无分波长 AOD** |
| **Open-Meteo air quality** | CAMS 550nm AOD、PM、臭氧（近地面） | **只有 550nm；ozone 是地面浓度非柱量** |
| **NASA POWER** | **TO3 真实臭氧柱量 (DU)**、PW | `AOD_55` 实测 2026-09 后全 -999（约 2 月滞后），不可用 |

### 8.2 需要 token（浏览器可调但需暴露密钥）

- **CAMS ADS**：唯一真正的分波长 AOD（469/550/670/865/1240nm）+ 臭氧柱量 +
  137 层气溶胶。**但没有任何云变量。** 异步作业，分钟级往返。
- **ERA5/CDS**：有 `total_column_cloud_liquid/ice_water`、`total_column_ozone`、
  `cloud_base_height`。**无 AOD、无 COT、无能见度。** 再分析，约 5 天滞后，
  只能做历史标定。

### 8.3 CORS 开放但工程成本高

- **ECMWF open data**：`tclw`/`tciw` 真实云液水/冰水路径，CORS `*` + Range
  （实测 206 + 724KB GRIB2）。**但需要浏览器 GRIB2 解码器，没有维护良好的实现。**
- **GOES-19 卫星**：`ABI-L2-CODF` 真实 COT（5 分钟、2km、5.7–6.9MB HDF5），
  还有 `CTPF`（云顶）、`ACTPF`（**云相态**）、`AODC`（**Ångström 指数**）。
  需要 `h5wasm`。**只覆盖美洲。**
- **NASA GIBS**：MODIS/VIIRS COT 瓦片，但**是渲染好的 PNG，不是数值**，
  只能做粗略"是否厚云"判断。

### 8.4 完全不可达

AERONET（无 CORS）、NOMADS grib filter（无 CORS）、DWD opendata（无 CORS）、
Himawari（84–775MB/10min）、GES DISC / LAADS / Sentinel-3（Earthdata/OAuth 门禁）。

### 8.5 关键实测发现

1. **`CDCON` 在 GFS 中完全不存在** —— 四个 GFS 产品全部 grep 无结果。
   **没有任何免费全球 COT 预报。**
2. **`boundary_layer_height` 只有 GFS/KNMI/DMI/METNO 系有**；ECMWF/ICON 全 null。
3. **`visibility` 只有 GFS/DMI 有**；ECMWF/ICON 全 null。
4. **`cloud_base`/`cloud_top` 只有 DMI 有**（欧洲、69h），且质量可疑
   （常见 base ≥ top、夜间哨兵 0）。
5. **21 层云量剖面全部可用**（1000→10hPa），是最大的未开发输入。
6. **Open-Meteo 配额是分域独立的**：`api` 与 `archive-api` 不共享。
   实测 5000 次/小时上限会被密集探测打满。

---

## 九、该采纳什么（按性价比排序）

### 已实施（本轮）

1. **概率化云隙透射** `gapTransmissionBeta(cover, path, β, L=30km)`
   —— 替代拍脑袋的 `AIRMASS_CAP=8`。消融依据：独立实验显示
   30km 概率化使 Spearman 0.26→0.44，消除 3 次漏报大烧。
2. **AOD > 0.8 硬门槛「污烧」** —— 复现 SunsetBot 表 2.3。一条规则就能
   抓住大部分技能。
3. **有效地面高度** `z_eff = H·ln(AOD/(0.02·H))` —— 精确复现教程实测值。
4. **实测臭氧柱量**（NASA POWER TO3）驱动 Chappuis —— 220 vs 450 DU
   让色相差 6°，可感知。
5. **云相态因子**（层温+RH）—— 冰晶 r_eff 是水滴 2–3 倍，同 LWP 下 τ 只有 1/2~1/3。

### 建议下一步

6. **扩到 21 层云剖面** —— 目前只用 7 层，而 API 给 21 层。
   这是「最大增益、零成本」，但牵动 `LevelKey` 联合类型与多处映射，需谨慎重构。
7. **改用 SunsetBot 的分档** —— 我们现在的 0.6 就到大烧，教程是 1.0–1.5 才是大烧。
   若要对外宣称「对齐行业口径」，应改成教程版本。
8. **卷云透明度判据**（红外亮温）—— 唯一公开的廉价「卷云纱 vs 卷云盖」判别法，
   但需要红外亮温数据，当前源没有。
9. **GOES 卫星 COT（仅美洲）** —— 唯一的实测 COT 路径，需 `h5wasm` + 10–15MB。

### 不值得做

- **抄 SunsetWx** —— 2015 年的 4km NAM 启发式，无气溶胶，无公式，两套矛盾标尺。
- **追商业 API 的 0–100 百分比** —— 独立对比发现同一场日落
  Sunsethue 报 1%、Alpenglow 报 64%，与自建指数的 Spearman 仅 0.04。
  它们都不发布标定数据，交叉验证学不到东西。
- **只用一个 Ångström 指数** —— 累积模态下 α 在可见光内可变 3–5 倍。
  α=1.3 只能作为只有 550nm AOD 时的回退。
- **在 20 个标签上跑梯度提升** —— Skyglow 的 MLP 拿到 test AUC 0.797，
  然后在工作阈值上几乎全predict「基本不烧」（1 TP, 88 FN）。
  基础率 17–24% 时，需要数千标签才能让学习模型赢过物理指数。
- **从 Flickr/Instagram 元数据学晚霞质量** —— 无先例，标签自选择
  （人只拍好日落），EXIF 被平台剥离，时间戳只给太阳位置不给云场。
  固定几何的相机网络严格更好。
- **完整 3D 辐射传输** —— 所有可用系统都是沿太阳方位的 2D。
  独立实验显示加 500m 地形瓦片对指数影响 <0.01。
  算力应花在更多方位采样与上游遮挡上。
- **在有 IWC/LWC 时用模式 COT 常数** —— ACSAF 的逐层固定 τ(2.0/1.0/0.3)
  是占位符。有冰水含量就该用 `τ = 3·LWP/(2ρr_eff)` 算。

---

## 十、参考来源

**产品**
- SunsetBot 教程：[一](https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-yi/) ·
  [二、三](https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-er-san/) ·
  [四](https://www.sunsetbot.top/halo/posts/2026/huo-shao-yun-yu-bao-jiao-cheng-zhang-jie-si/)
- SunsetBot 混淆矩阵：`sunsetbot.top/static/media/static_image/CM_fcstnorm.jpg`
- SunsetBot 分档：https://www.sunsetbot.top/map/
- SunsetWx：https://sunsetwx.com/about-the-model/ · https://sunsetwx.com/sunburst/
- Sunsethue：https://sunsethue.com/whitepaper
- Alpenglow：https://alpenglowapp.com/
- PhotoPills：https://www.photopills.com/

**开源**
- https://github.com/couletian/Skyglow（AUC 0.797 / Brier 0.167）
- https://github.com/b-z/sunsetglow（SunsetBot 忠实实现，Spearman 0.63）
- https://github.com/Her0n24/ACSAF
- https://github.com/RaimundoDiaz/sunset-color-today（含 Chappuis）
- https://github.com/NickZhuxy/firecloud-forecast

**学术**
- Lin et al. 2026, JAMC 65(5), doi:10.1175/JAMC-D-25-0206.1
- Haber, Magnor & Seidel 2005, ACM TOG 24(4):1353, doi:10.1145/1095878.1095884
- Lee & Hernández-Andrés 2003, Appl. Opt. 42(3):445, doi:10.1364/ao.42.000445
- Anderson & Mauersberger 1992, GRL 19:933, doi:10.1029/92GL00780
- Schuster et al. 2006, doi:10.1029/2005JD006328
- Eck et al. 1999, doi:10.1029/1999JD900923
- Laffont et al. 2014, ACM TOG, doi:10.1145/2601097.2601101

**数据源**
- https://open-meteo.com/en/docs · https://open-meteo.com/en/docs/air-quality-api
- https://power.larc.nasa.gov/docs/services/api/temporal/hourly/
- https://ads.atmosphere.copernicus.eu/
- https://data.ecmwf.int/forecasts/
- https://noaa-goes19.s3.amazonaws.com/
- https://isccp.giss.nasa.gov/cloudtypes.html
- https://aeronet.gsfc.nasa.gov/
