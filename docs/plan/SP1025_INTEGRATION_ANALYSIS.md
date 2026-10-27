# SP-1025 集成分析（2026-10-27）

> 对象：`E:\CODE\CangKu\SP-1025`（匿名项目，ZCode 从零实现的两大模块）
> 对照：司天 `E:\CODE\CangKu\SiTian`（当前 0.4.0）
> 本机验证：`planet-map` **62/62** Vitest 全绿；根仓库星系模块 **121/121** 全绿（2026-10-27 19:30 实测）。
> 结论先行：**两个模块都不能整包替换司天，只能拆件**。最值得先搬的是「海陆渲染」，
> 其次是「湖泊工具 + 地形特征级锁定」，最后才是「FMG 生成管线」。

---

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| 海陆图为什么不如 SP-1025？ | 司天的海是**平涂**：`HYPSO_WATER` 是 5 档淡蓝、政治档是单色海面；SP-1025 有**近岸浅滩带 + 远海按 h 的深度渐变 + 卫星陆色（群系×海拔）+ 山体阴影**。差距在 `palettes.ts` + `renderer.ts` 的约 200 行，不在整条管线。 |
| 能不能把 SP-1025 的行星模块整个搬进来？ | **不能**。它是「Voronoi 格 → 位图」的独立生成器；司天的底图是**415 个省矢量多边形 + 剧本归属**。整包替换会丢掉省界/归属/时间轴/导出链。 |
| 最值得搬的三件 | ① 海陆调色与浅滩/阴影；② 湖泊工具（平底 18-19）+ 地形特征级锁定（坐标重放）；③ FMG 模板 + 生成管线（仅用于**新建底图**）。 |
| 明确不搬 | 星系编辑器整包、两套 vanilla UI/Electron/启动脚本、`serialize` 外壳、全局 `Math.random` 改写。**3D 观景例外：它必做（用户 2026-10-27 明确「一直在计划里」），只是未排期**，参考 `System3D.vue`。 |
| 司天现状更强的部分 | 项目文件/快照/写闸门/撤销栈/162 用例、415 省矢量与剧本账本、七层视图、导出链（PNG/SVG/切片）、读料桥。**这些不要回退**。 |

---

## 1. 两个仓库的定位差异

| | SP-1025 | 司天 |
|---|---|---|
| 形态 | 两个独立 demo：星系编辑器（根）+ 行星地表生成器（`planet-map/`） | 一个完整的本地桌面应用（Electron + Vue 3 + Pinia） |
| 事实源 | 单文件 JSON（星系）/ v2 JSON（行星） | `.sitian` 项目文件 + Obsidian 库（双事实源，项目优先） |
| 地图模型 | 星系：节点/边/区域；行星：Voronoi grid + pack | 七层实体树 + `mapData` 高度图/terrainGrid + `baseMap.terrain[]` 省多边形 + 剧本归属 |
| 渲染 | Canvas 2D 位图（星系 6 层 / 行星逐格） | 七个 Canvas 视图，各自绘制；剧本图是矢量省界 + 栅格底图 + 文字排布 |
| 编辑 | 命令模式（纯 TS，栈深 100） | `store/undo.js` 命令栈 + 写闸门 + 自动保存/快照 |
| 测试 | 星系 121 / 行星 62（Vitest） | 162 CDP + 69 Node（自研 harness） |
| 强项 | 生成质量（FMG 模板/气候/河网/侵蚀）、海陆观感、湖泊/锁定 | 产品完整度、数据安全、剧本/省份、导出、七层视图 |

> 关键判断：SP-1025 是**生成器 + 编辑器 demo**；司天是**世界观编辑器 + 事实源**。
> 所以集成方向只能是「把生成/渲染能力做成司天的一个零件」，不是「把司天换成 SP-1025」。

---

## 2. 行星模块 `planet-map/` 逐文件判定

图例：✅ 直接搬 ｜ 🟡 改后搬 ｜ 🔵 参考思路 ｜ ⚫ 废件 ｜ ⛔ 不如现状

| 文件 | 作用 | 判定 | 说明 |
|---|---|---|---|
| `core/types.ts` | `Cells/Feature/River/GridGraph/PackedGraph/PlanetParams` 契约 | ✅ | 纯类型；搬入后改名为 `fmgTypes`，避免与司天 `GeoNode` 混淆 |
| `core/constants.ts` | `SEA_LEVEL=20`、1920×1080、typed array 上限 | ✅ | 与司天 `RASTER_SEA_LEVEL=20` 同口径，天然对齐 |
| `core/graph/lattice.ts` `voronoi.ts` `grid.ts` `pack.ts` | 撒点/Voronoi/grid/pack | 🟡 | 依赖 `delaunator`；司天现在没有网格图。作为「生成器」整体搬，**不替换**现有高度图 |
| `core/heightmap/templates.ts` | 14 个 FMG 内置模板 + `buildContinentsTemplate` | ✅ | **MIT 头必须保留**；模板 DSL 与执行器配套 |
| `core/heightmap/generator.ts` | 模板 DSL 执行器（Hill/Pit/Range/Trough/Strait/Mask/Invert/Add/Multiply/Smooth） | ✅ | 只要求 `grid.cells.c`（邻接）与 `grid.points`；给司天常规网格做一层伪 grid 适配即可 |
| `core/pipeline.ts` | 8 步生成主入口 + 覆盖率二分 | 🟡 | 逻辑可搬；**必须去掉 `Math.random = Alea(...)` 全局改写**（见 §5 风险） |
| `core/climate/temperature.ts` `precipitation.ts` | 温度/降水 | ✅ | 纯函数；输出到 `heightmap.temp/prec` |
| `core/biomes.ts` | 13 群系查表矩阵 | ✅ | 与司天 `BIOME_COLORS` 可合并成一张表 |
| `core/features.ts` `lakes.ts` | 海陆特征/距离场/湖泊 | ✅ | 浅滩带与湖判定的数据源 |
| `core/river.ts` | 填洼/汇流/河宽/meander/下切/锁定 | 🟡 | 29KB，最深的一块；输出是 pack cell 链，司天是**世界坐标折线**。需要适配层（见 §3） |
| `core/noise.ts` | simplex fBm | ✅ | 依赖 `simplex-noise` |
| `core/utils/*` | number/probability/geometry/path-utils | ✅ | d3 等价实现；MIT 头保留 |
| `core/brush.ts` | 高度笔刷四模式 + **湖泊挖掘** | ✅ | `applyLakeDigAt` 是本轮最值钱的小件（平底 18-19） |
| `core/commands.ts` | 编辑命令层 + 群系覆写 + **手绘格锁定** | 🟡 | 命令层**不要搬**（与司天 undo 双栈）；搬 `heightStrokeCommand` 的语义、`exportEdits`、`reapplyHandEdited` |
| `core/recompute.ts` | 下游重算 + 锁定河按坐标重匹配 | 🟡 | 思路可搬；worker 化与司天 `test_39` 的派生 worker 同款 |
| `core/hash.ts` | FNV-1a 全图指纹 | ✅ | 回归断言用 |
| `core/serialize.ts` | base64 typed arrays + 拓扑重建 | 🔵 | 格式与 `.sitian` 不同；参考其压缩思路，不搬外壳 |
| `render/palettes.ts` | 七图层色带 + **海洋深度/浅滩** + 群系色 | ✅ | **最高性价比**；几乎零风险，直接回答「海陆图不如它」 |
| `render/renderer.ts` | 两档 LOD 位图 + 山体阴影 + 海岸/河流 | 🔵/🟡 | 逐格位图**不适合**司天矢量省界；只搬 `colorOfGridCell` 的阴影/海色逻辑与海岸描边规则 |
| `worker/generate.worker.ts` | 生成 Worker + 进度 | 🟡 | 改成 Vite worker；司天已有 worker 模式 |
| `ui/main.ts` `styles.css` `index.html` | vanilla 工具条/参数面板/图层/探针 | ⚫ | 司天是 Vue 3 + Pinia，重写面板比移植便宜 |
| `electron/*` `启动行星地图.bat` | 独立壳/启动 | ⚫ | 司天已有 Electron 主进程与 IPC |
| `tests/*` | 62 例 Vitest | 🟡 | 核心断言（同种子 hash/模板幂等/河流连通/群系边界）可移植；建议 Node 化，避免给司天新增 Vitest 运行链 |

**行星模块结论**：`core/` 是干净的纯 TS（约 165KB，零 DOM），**可搬**；`render/` 只搬调色与阴影；
`ui/`、`electron/`、`serialize` 外壳、`commands` 栈**不搬**。

---

## 3. 数据模型怎么对接（最容易翻车的地方）

### 3.1 两边的形状

- SP-1025：`PlanetMap = { grid:{cells:{h,temp,prec,t,f,biome?}, vertices, points, features}, pack:{cells,rivers,features}, rivers, params }`，固定 1920×1080。
- 司天：`mapData[planetId] = { heightmap:{h,temp,prec,biome,grid:{points,spacing,cellsX,cellsY}}, terrainGrid, gridWidth/Height/Origin/Cell, ... }`
  + `baseMap.terrain[]`（省多边形）+ `scenario.ownership`。

### 3.2 三种对接方案

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| A（推荐）**只做生成器** | SP-1025 生成 → 转成司天 `heightmap`（h/temp/prec/biome）+ 可选 `terrainGrid`；省界仍由司天现有 `landmass`/`provinceShape` 生成 | 需要一个坐标/分辨率适配层；不碰 415 省项目 | ✅ 风险最低，保留司天全部能力 |
| B 整包替换底图 | 把 SP-1025 的 Voronoi cell 当 `terrain[]` 省 | 数千个碎省、无剧本归属、无省名/省界/导出；415 省项目直接废 | ⛔ 不可行 |
| C 只借渲染 | 不搬生成，只把海色/浅滩/阴影移植到司天现有高度图 | 最小改动；生成质量仍不如 SP-1025 | ✅ 阶段 0 就这么做 |

### 3.3 坐标与分辨率

- SP-1025 固定 `1920×1080`，`grid.spacing` 约 12~24；司天 415 省底图约 `1900×1100` 世界单位、高度图 `97×45`（spacing 18.3）。
- 适配：生成时把 SP-1025 的 `x/y` 线性映射到司天的 `gridOriginX/Y + cellWorldSize` 栅格；**不要**直接改司天的 world 坐标。
- 分辨率：8k 单元 ≈ 90×50 的密度，与司天 97×45 接近；16k/32k 对司天当前栅格是**超采样**，需要降采样后写 `heightmap`（或把司天高度图分辨率提升，见阶段 2）。

### 3.4 存档

- 不要把 SP-1025 的 `SerializedMap`（base64 typed arrays + 拓扑）原样塞进 `.sitian`：司天项目已 7MB，快照还排除 `heightmap/terrainGrid`。
- 建议：`baseMap.fmgSource = { version, params, gridHash }` + 派生的 `heightmap`；需要重生成时用 `fmgSource` + 种子重跑；快照只存轻量 `fmgSource`。
- 或者：只在「新建底图」时生成一次，之后完全转成司天自己的 `heightmap`，不保留 SP-1025 结构（最简单，推荐）。

### 3.5 撤销

- SP-1025 `commands.ts` 有自己的栈（100 深、全局 `PlanetEditState`）；司天 `store/undo.js` 是唯一命令栈，且写盘有闸门。
- **只搬算法**：`heightStrokeCommand` 的 before/after 快照 → 包成司天 `execute({undo,redo})`；一笔 = 一条 undo。**绝不**同时启用两套栈（会双写/串味）。

### 3.6 随机数（P0 风险）

- SP-1025 在 `pipeline.ts` / `recompute.ts` 里写 `Math.random = Alea(seed)` —— **全局改写**。
- 司天是多视图/多 worker 应用，全局改写会污染其他视图的随机数（粒子、纹理、测试）。
- 搬的时候**必须**改成显式注入 `rng`（`generatePlanetMap(params, { rng })`），或只在 worker 内局部替换并立即恢复。

### 3.7 测试运行器

- SP-1025 用 Vitest；司天用 `scripts/tests/unit/*.js`（纯 Node + assert）。
- 建议：把核心断言**Node 化**（同种子 hash/模板幂等/河流连通/群系边界/笔刷四模式/锁重放），
  不为一个可选生成器给主仓新增 Vitest 运行链；若想保留原测试，可在 `third_party` 子目录用独立 `package.json` 跑。

---

## 4. 星系模块（根仓库）逐文件判定

| 文件 | 判定 | 说明 |
|---|---|---|
| `core/model.ts` `generator.ts` `topology.ts` `territory.ts` `geometry.ts` `metrics.ts` `commands.ts` `serializer.ts` `view.ts` `prng.ts` `ids.ts` | 🔵 参考 | 与司天 `GalaxyMap/SystemView` 的数据模型不同（节点/边/区域 vs 实体树/航道/势力）。可借鉴：**所有权场 φ**（零重叠边界）、**metaball 并集轮廓**、**生成即量化回验**、**LOD 规则表** |
| `render/background.ts` `planetArt.ts` `regions.ts` `lanes.ts` `nodes.ts` `labels.ts` `lod.ts` | 🔵 参考 | 司天已有 `galaxyDrawing.js`/`spaceBackground.js`；可借 `planetArt`（18 类行星 sprite）与背景分层，但不要整包替换 |
| `app/*` | ⚫ 废件 | vanilla/Vue demo UI，与司天壳/面板体系不兼容 |
| `System3D.vue` + three@0.128 | 🟡 必做（参考实现） | 用户 2026-10-27 明确「星系 3D 必做，一直在计划里」；接 `SystemDetailView`，three 动态加载、关闭即 dispose |
| `tests/*` 121 例 | 🔵 参考 | 只作为「生成器该有的判据」清单，不搬运行链 |
| `README` 决策点清单 | ✅ 参考 | 15 条跨文件决策（命令模式/所有权场/批量原位插回/资产缓存）值得抄进司天文档 |

**星系模块结论**：**不建议整包集成**。司天的星系层在数据/视图完整性上更强；只借 `territory.ts` 的零重叠边界与
`planetArt.ts` 的行星美术。**3D 观景是例外：用户明确必做**，按 `System3D.vue` 的参考实现接到
`SystemDetailView`（three 动态加载、关闭即 dispose）。

---

## 5. 许可证与依赖

- **MIT 头必须保留**：`planet-map/src/core/` 里 **14 个文件**带
  `Copyright 2017-2024 Max Haniyeu (Azgaar)` / `SPDX-License-Identifier: MIT`。
  搬进司天后要在文件头保留，并在 `About` / `README` / `THIRD_PARTY_NOTICES.md` 写第三方声明。
- 运行时依赖（行星）：`alea`、`delaunator`、`simplex-noise`。司天当前没有这三个。
  两条路：① 正常加为 dependency（3 个小包）；② 把源码 vendor 到 `src/renderer/src/third_party/`，保持「零新增依赖」。
- 星系根仓库的 `three@0.128` **只在 3D 观景视图里动态加载**（不进首屏）；版本钉 0.128.0（0.16x 灯光模型会漂观感）。
- `planet-map` 的 `README` 已写明「抄码主源 FMG @ 67d555b8（MIT）」，照抄其声明即可。

---

## 6. 分阶段集成路线（按性价比）

### 阶段 0：海陆渲染（1–2 天，零数据迁移）✅ 建议立刻做

把 `palettes.ts` 的 **`OCEAN_DEPTH` 五档（turquoise→深海）+ `HYPSO`/`TERRAIN_LAND` + `satelliteLand`**
和 `renderer.ts` 的 **NW 山体阴影**移植到司天 `heightmapRaster.js` / `PlanetMap` 的 raster 层：

1. `HYPSO_WATER` 从 5 档淡蓝换成 `OCEAN_DEPTH`（近岸青绿 → 深海），并加上「近岸两圈用距离场、远海用 h」的规则；
2. 增一个 `satellite` 主图层：群系色 × 海拔（高山岩灰/雪）+ 阴影；保留现有 `biome/height/temp/prec` 档；
3. 海岸带用司天已有 `getSeaDetail().coasts`（高精度 landFeatures）描浅滩 + 细线（政治档也能用）；
4. PlanetMap 默认档可从 `biome` 改为 `satellite`（先给开关，确认观感后再改默认）。

**判据**：与 `planet-map/screenshots/style-standard.jpg` 并排看；`test_69/70`（栅格共享/覆盖物）仍绿；
`test_160`（导出地形档）仍绿；新增 Node 单测锁色带（同 h/t 必得同色）。
**风险**：低。只动渲染，不动数据。

### 阶段 1：湖泊工具 + 地形特征级锁定（3–5 天）

- **湖泊**：搬 `applyLakeDigAt` 的语义（触及格统一 18–19、平底、临海灌穿成海湾），
  接到司天高度笔刷/`terrainGrid`；UI 加「湖泊（L）」；一笔 = 一条 `store.undo`。
- **锁定**：`handEditedCells` 按**世界坐标**登记（`baseMap.handEdits`），
  重生成时 `reapplyHandEdited` 写回 + 海陆重标 + 状态栏「保留 N 格手绘」；换 seed 明确丢弃。
- **判据**：挖湖 49 格成 10 湖 / 一条 undo / 同 seed 重生成保留、换 seed 丢弃 / 只读拒绝；
  Node 单测 + 一条 CDP 用例。

### 阶段 2：FMG 生成管线（1–2 周，可选新建底图）

- 先搬 `templates.ts` + `generator.ts` + `pipeline.ts`（3 个模板：archipelago/supercontinents/mediterranean），
  输出到司天 `heightmap`；保留 `landmass` 作为另一条生成路径，**不替换**。
- 再搬 `climate/` + `river.ts` + `lakes.ts` + `biomes.ts`，把河网转成司天世界坐标折线（`rivers[]`）。
- 最后才考虑 `graph/pack` 与 cell→province 的分组（这一步决定能不能用于 415 省风格底图）。
- **判据**：同 seed hash 一致；陆地覆盖率 ±1%；河流零断头；8k/16k 生成 <3s；与现有 415 省项目互不影响。

### 阶段 3：按需

- `territory.ts` 的零重叠所有权场 → 如果司天势力边界要更平滑；
- `planetArt.ts` 的 18 类行星 sprite → 行星列表/详情图标；
- `System3D` **必做**（用户 2026-10-27 明确）：参考 `System3D.vue` + `planetArt.ts`，独立一轮排期。

---

## 7. 明确「不如司天现状」的清单（不要回退）

1. **项目/数据安全**：`.sitian` + 快照 + 写闸门 + 自动保存 + 只读态；SP-1025 是独立 JSON。
2. **省与剧本**：415 省矢量边界、归属账本、时间轴、切片导出；SP-1025 只有 Voronoi 格。
3. **七层视图**：world/domain/system/system_detail/planet/area/interior 的联动；SP-1025 只有一个视图。
4. **导出链**：PNG/SVG/切片/地形底图；SP-1025 只有当前画布导出（行星有 PNG，但没有司天的 SVG/切片）。
5. **测试规模**：162 + 69 vs 62/121；且司天用例覆盖真实 415 省项目。
6. **UI/可发现性**：项目面板、图层、时间轴、提示、只读说明；SP-1025 是 demo 工具条。
7. **撤销/写盘耦合**：司天 undo 与写闸门/自动保存一体；SP-1025 是内存栈。
8. **本地化/文档/免责声明**：司天有指南、免责声明、读料桥；SP-1025 没有。

---

## 8. 风险清单（按严重度）

| 级别 | 风险 | 缓解 |
|---|---|---|
| P0 | `Math.random` 全局改写 | 改为显式 `rng` 注入；worker 内隔离 |
| P0 | 用 cell 替换省多边形 | **禁止**；只做「生成 heightmap」，省份仍由司天生成 |
| P1 | 两套 undo 双栈 | 只搬算法，包进 `store/undo.execute`；一笔一条 |
| P1 | 项目体积 | 不存 SP-1025 全量结构；只存 `fmgSource` 或一次性转 heightmap |
| P1 | MIT 头丢失 | 搬文件时逐文件保留；加 THIRD_PARTY_NOTICES |
| P2 | Vitest 运行链 | 核心断言 Node 化；不为主仓加测试框架 |
| P2 | 坐标/分辨率错位 | 显式 `width/height/spacing` 适配层 + 单测锁边界 |
| P2 | 固定 1920×1080 | 生成时映射到司天 worldBounds；存 `width/height` |
| P2 | 3D/three.js：体积 / Electron WebGL 兼容 / 资源泄漏 | 动态 import、按 SP-1025 低配口径、关闭即 dispose + 连续开关 20 次内存判据 |

---

## 9. 建议的下一步（按顺序）

1. **阶段 0（海陆渲染）**：先让司天的海图达到 `style-standard.jpg` 的观感；这是用户当前最直接的抱怨，且零数据风险。
2. **阶段 1（湖泊 + 锁定）**：两个可见功能，不动 415 省项目。
3. **阶段 2（生成管线）**：先 3 个模板 + heightmap 输出；验证后再谈河网/群系/省份分组。
4. 星系模块只做「参考」；**3D 观景必做**（用户点名，独立一轮）。

---

## 10. 本机验证记录

- `cd E:\CODE\CangKu\SP-1025\planet-map && npm test` → **62/62**（8 个测试文件，1.92s）。
- `cd E:\CODE\CangKu\SP-1025 && npm test` → **121/121**（12 个测试文件，3.82s）。
- 代码规模：行星 `core/` 约 165KB / 25 文件；星系 `core/` 约 90KB / 11 文件。
- 视觉证据：`planet-map/screenshots/style-standard.jpg`（海陆）、`final-seed-*.jpg`（三种子）、
  `SP-1025/screenshots/成品图5/13`（星系）。
- 司天当前：162 用例 + 69 Node 单测全绿（提交 `50a98da`）。
