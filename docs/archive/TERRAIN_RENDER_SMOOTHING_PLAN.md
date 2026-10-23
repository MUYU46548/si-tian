# 地形渲染平滑方案（反「拼豆」）— 技术方案与改动清单

> 状态：**方案（未实施）**。2026-10-09 立。对应暮雨 2026-10-09 反馈：地形是"马赛克拼豆方块"，问"这算地图编辑器吗"。
> 结论：**不算。但根因不是缺能力，而是「平滑渲染」这条路径只接了 3 个图层，高度图着色档仍在走逐格实心方块。**

---

## 一、结论先行（TL;DR）

1. **已有平滑引擎**：`src/renderer/src/utils/gridOutline.js` —— 标签网格 → 边界有向环 → 共线塌缩 → RDP 简化 → **Chaikin 圆角** → 世界坐标矢量环。等价于一份手写的 marching squares + 平滑，且已针对 40k 格做过性能处理（CSR 邻接表）。
2. **它已经接在这些图层上**：地形涂色 `terrainGrid`（`useTerrainCanvasBrush.js:420`）、生物群系 `biome`（`planetDrawing.js:383`）、省份边界（`useProvinceBrush.js:71`、`provinceShape.js:681/914`）。
3. **"拼豆"发生在**：`utils/heightmapRaster.js` 的 `fillPixelBlock`（`:111`）—— 每格画一个**实心 `spacing×spacing` 方块**，且绘制端 `imageSmoothingEnabled = false`（`planetDrawing.js:454`，为防网格缝隙亮线而刻意关抗锯齿）。这条路径服务 **陆海底色 / 海拔 / 温度 / 降水 / 文化 / 宗教** 六个着色档（+ ScenarioMap 底图）。
4. **因此**：`culture` / `religion`（分类数据）**可直接复用矢量引擎**，属接线级改动；`landsea/height/temp/prec`（连续场）**才需要新能力**（子格插值或等值带）。

---

## 二、现状对码（事实层）

### 两条渲染路径

| 路径 | 实现 | 适用数据 | 观感 |
|---|---|---|---|
| **A 矢量平滑环**（推荐） | `gridOutline.buildLabelOutlines` → `ctx.beginPath/fill` | **分类**标签网格（每格一个离散值） | 有机、抗锯齿、边界可调圆滑度 |
| **B 逐格栅格**（现状"拼豆"） | `heightmapRaster.buildHeightmapRaster` → `fillPixelBlock` | 连续标量场 + 分类（复用了） | 硬边方块，放大即马赛克 |

### 关键文件与锚点

- `utils/gridOutline.js`
  - `traceLabelLoops()` `:40`（CSR 邻接表；注释实测：40k 格 Map 版 56ms → CSR 版个位数 ms）
  - `collapseCollinear()` `:128` / `simplifyLoop()` `:143`（RDP）/ `chaikinLoop()` `:185`（0.75/0.25 圆角）
  - `buildLabelOutlines()` `:220`（一站式；`eps`/`minAreaCells` 以**格**为单位）
- `utils/heightmapRaster.js`
  - `fillPixelBlock()` `:111`（**"拼豆"根因**）
  - `buildHeightmapRaster()` `:140`（`spacing` 默认 14.4，`ctx.createImageData` 逐格填块）
  - `cellColor()` `:88`（六档配色）
- `composables/planetDrawing.js`
  - `heightmapOutlines()` `:374` + `drawHeightmap()` `:462`（**biome 已走矢量**，含 hashLabels 内容缓存）
  - `drawHeightmapRaster()` `:437`（**六档走栅格**；`:454` `imageSmoothingEnabled=false`；`:449` 缓存 key = `kind|hashLabels(h)|…`）
- `components/ScenarioMap.vue:3652` `buildCellRaster/getRaster` → `buildHeightmapRaster`（底图栅格，缓存只在切底图时清 → 涂抹期间陈旧）
- `components/PlanetMap.vue:1402` → `drawing.drawHeightmapRaster(ctx, kind, alpha)`
- `composables/useFullMapExport.js:143/305`（导出全图**也走同一条栅格路径** → 导出图同样是方块）

### 已有先例（同一问题的上一次修复）

`scripts/tests/cases/test_59_terrain_organic.py` 记录：用户当初对 `terrainGrid` 提的正是"马赛克方块填色"，
修复动作 = ① 逐格 `roundRect` → `gridOutline` 平滑环；② 多边形纹理去 `Math.random`。验收：**terrain 层唯一色数贡献 < 3500**、**环数 ≤ 40**、重建 < 60ms。
→ **本次是同一问题的"另一半"**：把 `test_59` 的口径扩到高度图着色档即可。

---

## 三、分三类处置（含取舍）

### 类 1｜`culture` / `religion`（分类）→ 直接复用矢量环 【低成本 · 高收益】

- 做法：新增 `planetDrawing.channelOutlines(hm, kind, palette)`，与 `heightmapOutlines()` 同构：
  `buildLabelOutlines(hm[kind], cellsX, cellsY, { outside: 0 /* 无主 */, ignore: [] })`，
  每个 label 用 `palette[label]` 填色 + 描边。缓存 key 纳入 `hashLabels(hm[kind]) + paletteFingerprint`。
- 取舍：边界 crisp 平滑；分类色不糊。**成本与 biome 同量级**（已有 CSR 引擎，无新算法）。
- 注意：通道值 = **位置（1 起）不是 id**（见 `utils/heightmapChannels.js`）；`0 = 无主`，`outside: 0`。

### 类 2｜`landsea` / `height` / `temp` / `prec`（连续场）→ 三选一 【真正的"新能力"】

| 方案 | 做法 | 观感 | 成本 | 风险 |
|---|---|---|---|---|
| **2a 子格双线性超采样**（推荐） | 把标量场按 SS=3~4 双线性放大后再逐子格 `cellColor` | 平滑渐变海岸线 | 像素数 ×9~16（27k 格 → 24~43 万像素，预渲染一次 ≈ 十几 ms） | 需缓存纪律（内容哈希） |
| 2b 等值带（marching squares 分带） | 在色带断点抽等值线 → 带间填色 | 地图册式清晰分层 | 中（可复用 gridOutline 的走链） | 实现最复杂，边界需羽化 |
| 2c 最廉价 | 离屏高分辨率 + `imageSmoothingEnabled=true` | 柔和但发糊 | 近零 | 分类色会互相污染（不适合 culture） |

- 建议：**2a**（连续场统一走它；`landsea` 的海岸线是收益最大的一档）。

### 类 3｜多边形地形（`mapData.terrain`，截图 1 的"沙漠/陆地/山脉"）→ 非本方案重点

- 它本来就是矢量多边形**平涂**，不是网格。观感升级靠：边缘描边/羽化、确定性柔和底纹（`test_59` ② 已做过一轮）、
  或未来用高度图**切割**多边形边界（`terrainRepresentation` 已有「有高度图则多边形降为叠加物」的口径）。

---

## 四、改动清单（文件级）

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| 1 | `utils/gridOutline.js` | 无（复用）；若需羽化可加 `strokeLoop()` | 低 |
| 2 | `composables/planetDrawing.js` | 新增 `channelOutlines()`；`drawHeightmapRaster()` 拆为「矢量（分类）/ 插值（连续）」两分支；`imageSmoothingEnabled` 按分支定 | 中 |
| 3 | `utils/heightmapRaster.js` | 新增 `buildHeightmapRasterSmooth(hm, kind, {ss})`（双线性超采样）；`fillPixelBlock` 保留给最廉价档 | 中 |
| 4 | `components/ScenarioMap.vue` | `buildCellRaster/getRaster` 切到平滑实现；缓存失效改内容指纹（现在只切底图时清 → 涂抹期间陈旧） | 中 |
| 5 | `components/PlanetMap.vue` | 着色档下拉加「平滑」开关（默认开）；`drawHeightmapRaster` 调用点不变 | 低 |
| 6 | `composables/useFullMapExport.js` | 导出走同一平滑实现（否则"屏幕平滑、导出方块"） | 低 |
| 7 | `utils/terrainRepresentation.js` | 无需改（口径不变） | — |

**红线（必须守）**：预渲染 + 不逐帧重绘（几万格逐帧 = 每帧几十毫秒）；`toRaw` 取原始数据避免响应式代理开销；
缓存 key 用**内容指纹**（`hashLabels`），涂抹即失效。

---

## 五、受影响测试与需重新定基线的断言

| 用例 | 为什么受影响 | 处置 |
|---|---|---|
| `test_59_terrain_organic` | 反马赛克闸门；本轮应把口径**扩到高度图着色档** | 扩断言（新增覆盖点） |
| `test_69_terrain_raster_shared` | f2「切栅格 → 像素变 / 切回 biome → **逐像素复原**」；改渲染后像素值变 | 需**重定基线**（复原性应仍成立，变化量阈值需复核） |
| `test_06_texture` | 合成 fixture 唯一色数（阈值 30 / 实测 31） | 渲染改后色数会变 → **重新定基线** |
| `test_70_terrain_polygon_overlay` | 像素级（开/关覆盖物） | 复核 |
| `test_38_dirty_rect` | 「partial 与 full **逐像素一致**」 | 若改渲染必须保住（无接缝/残影） |
| `test_89_planet_channel_brush` | f0 静态守 `RASTER_KIND_OPTIONS` 单选表 | 若新增"平滑"开关，需同步选项表 |

---

## 六、建议的落地顺序（分两批，各自可独立验收）

**批 1（低成本 · 立竿见影）**
- 类 1：`culture`/`religion` 走矢量环（复用 biome 同引擎）
- 类 3 的 ScenarioMap 底图同步到平滑实现
- `PlanetMap` 加「平滑」开关（默认开，可关回旧观感做对照）
- 验收：新增像素/色数断言 + `test_59` 口径外扩

**批 2（新能力 · 需重定基线）**
- 类 2：连续场双线性超采样（2a）
- 导出链同步
- 验收：重定 `test_06` / `test_69` 基线；`test_38` 逐像素一致性复跑

---

## 七、实施记录（批 1，2026-10-09 已落地）

暮雨拍板：**连续场要平滑渐变**（"哪怕 MC 的生物群系也是渐变的"）+ **可以开工批 1**。

### 实际做法（与初稿的差异 + 理由）

初稿批 1 写的是"culture/religion 走矢量环"。实施时改成了**更小、更统一**的一招：
**在共享的 `heightmapRaster` 里做子格双线性上采样**，一次覆盖全部六档 + ScenarioMap 底图 + 导出链。

理由：
1. 暮雨明确要的是**渐变**，不是矢量硬边 —— 双线性混色正合口径，矢量环反而是另一种观感；
2. 一处改、三处（PlanetMap / ScenarioMap / 导出）同时生效，不用给 culture/religion 再造一条渲染支线；
3. **记忆反而更省**：输出边长 ≈ `w·SS/spacing`，面积只有旧实现的 `(SS/spacing)² ≈ 1/13`。

### 改动清单

| 文件 | 改动 |
|---|---|
| `utils/heightmapRaster.js` | 新增 `RASTER_SMOOTH`（默认 `true`）/ `RASTER_SUBSAMPLE = 4`；`buildHeightmapRaster` 分两档：**平滑档** `buildSmoothRaster`（格 RGB → 子格双线性）/ **方块档** `buildBlockRaster`（旧实现原样保留）；`opts.smooth:false` 可取回旧观感（用例对照用） |
| `composables/planetDrawing.js` | `drawHeightmapRaster` 绘制端 `imageSmoothingEnabled = RASTER_SMOOTH` + `quality='high'`（源画布是格级分辨率，必须插值放大） |
| `components/ScenarioMap.vue` | `drawRasterLayer` 同上 |
| `scripts/tests/cases/test_69` | f1 拆成**方块档判纯度**（landsea 精确二色 / height 多色）+ **平滑档判渐变**（画布边长 < 世界尺寸、过渡色严格多于方块档） |

🔴 **两条实现纪律**：① 必须插值**格 RGB**，不能插值通道值再取色 —— 分类场的值是下标，插值下标会得到"不存在的类别"且不报错；
② 平滑档只在 `cellsX×cellsY === 数据长度` 时启用，不自洽（历史数据）自动退回方块档 —— 下标错位会整体偏色且不报错。

### 仍待做（批 2）

- 若要再提一档质量：提高 `RASTER_SUBSAMPLE`（4 → 6/8）或改等值带（2b）；
- `ScenarioMap` 底图缓存的失效时机仍是"切底图时清"（涂抹期间陈旧）—— 既有行为，未改；
- 多边形地形（`mapData.terrain`）是矢量平涂，不属本方案。

---

## 八、原始待确认（已答复，留档）

1. ~~截图 2 用的是哪个着色档？~~ → 暮雨：**"绘制省份"**；实测代码：该视图的前景是**省份多边形**（`baseMap.terrain[]`，UI 层名就叫「省份」），
   而"拼豆"来自其下的**底图栅格**（`landsea` / `height` / `temp` / `prec`）—— 与本次修复一致。
2. ~~连续场要平滑渐变还是清晰分层？~~ → **平滑渐变**（已按 2a 实施）。
3. ~~批 1 是否开工？~~ → 已开工并落地。

