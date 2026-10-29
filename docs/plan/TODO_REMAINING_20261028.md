# 剩余待办总表（2026-10-28）

> 这张表是**唯一待办清单**：`REMAINING_BACKLOG_20261027.md` 是 10-27 的快照（含当时的分析与证据），
> 10-28 之后**以本表为准**。做完一条就把状态改成 ✅ 并写上提交号，不要删条目（删了就丢上下文）。
>
> 已完成（供对照）：
> - 2026-10-27 SP-1025 阶段 0+1（海陆渲染 / 湖泊 / 特征级锁定）→ `f9f2d3a`
> - 2026-10-28 星系 3D 观景 → `bd80cbc`（交接 `HANDOFF_20261028_system3d.md`）
> - 2026-10-28 阶段 0/1 欠账第一组（导出浅滩 / 保留手绘开关 / handEdits 抽稀 / 湖泊 UI）→ `cad94ab`
> - 2026-10-29 阶段 0/1 欠账第二组 A5（造陆接手绘 / 图幅不再缩）→ `8425a2c`
> - 2026-10-29 **A6 行星侧「生成地形」+ C3 仅已命名省** → `0010380`
> - 2026-10-29 **E1/E2 3D 点选下钻 + `node.planetClass`** → `f9d7366`
> - 2026-10-29 **E3/E5/E6 3D 双星 / 自动降档 / 项目关闭释放纹理** → `844d4bf`
> - 2026-10-29 **C2 国名沿主轴转·折行 + C5 道路四档渐显** → `720a6e4`
>
> 剩下：**C1 字体 / C4 分辨率 / C6 等深线 / F 工程债 / B 阶段 2 FMG**，以及 **D 的两条要用户回话**（B1 截图、F1 的 `reason`、B3 的工具视图）。

---

## A. 阶段 0/1 欠账（原 §3）

| # | 事项 | 状态 | 备注 / 下一步 |
|---|---|---|---|
| A1 | 导出 SVG 的海面平涂 | ✅ 2026-10-28 | 政治档沿海岸线画 9px 浅滩带 + 1.1px 细海岸线；地形档不重复叠（`useScenarioExport` + `ScenarioMap.exportSeaSnapshot`；`test_160` 守） |
| A2 | 「重生成保留手绘」恒开 | ✅ 2026-10-28 | `TerrainGenPanel` 加 checkbox（默认开）；关掉 → `handEdits` 清空、回执写明；store 认 `opts.keepHandEdits`（`test_151` g 段守） |
| A3 | `handEdits` 无上限/无压缩 | ✅ 2026-10-28 | 软上限 2 万，超出按网格逐级抽稀（保形、同格留最新）；`unit/test_hand_edits.js` h6 守 |
| A4 | 湖泊工具强度滑块无意义 | ✅ 2026-10-28 | 行星图湖泊档隐藏强度滑杆，改显示「平底」说明（18/19 固定） |
| A5 | **造陆路径不锁手绘** | ✅ 2026-10-29 | 口径按代码实况定死：新图与旧图共享**世界坐标系**、但**不是同一张网格**（包围盒按省份外扩重推、格距随崎岖度变）→ 按**图幅相对位置**搬（`transferHandEdits`：包围盒归一化 + 吸附到最近格；抬高型落到新图海里丢弃、手挖湖保留；换 seed 不搬）。面板只在真有手绘时露 `lgen-keep-hand`，确认框与回执都点名格数。**顺带修掉一个真缺陷**：旧口径每次重跑都按省份包围盒重推图幅 → 实测**每次缩 ≈9.5%**（1800→1628→1473）；现在把图幅记进 `heightmap.genBBox`，重跑逐格同网格（手绘逐点命中）。判据：`unit/test_hand_edits.js` h7–h10、`test_152` g 段 |
| A6 | 行星图没有「重生成」 | ✅ 2026-10-29 | 把「地形目标」抽成一份（`resolveTerrainTarget`：`{kind:'basemap',key}` / `{kind:'planet',planetId}`），推演/手绘搬移/气候/一条 undo 收进唯一实现 `synthesizeTerrainInto`；对外两个薄入口 `synthesizeBaseMapTerrain` / `synthesizePlanetTerrain`。`TerrainGenPanel` 加 `planetId` 直传目标（**没有第二份面板**），行星高度工具栏加「生成地形」入口（`planet-gen-terrain` → 浮面板）。行星高度笔刷补 `handEdits` 登记（抬手 diff），否则「重生成保留手绘」在行星侧永远是空开关。判据：`test_89` f6（预览 3 张 / 落库 / 同种子手绘逐格全中 / 关掉即丢 / 3 条 undo 归位 / UI 可开）+ `test_54` 反向扫描（写口 `synthesizeTerrainInto` 已登记） |

## B. 阶段 2：FMG 生成管线（最大一块，1–2 周）

> **第 ① 步已交付（2026-10-29）**：`src/renderer/src/utils/fmg/`（`rng.js` / `lattice.js` / `templates.js` /
> `generator.js` / `index.js`）+ `THIRD_PARTY_NOTICES.md` + `unit/test_fmg_heightmap.js`（6 条）。
> 判据实测：**同 seed 逐字节一致**（换 seed 必变）、**8k 格 11ms**（目标 < 1s）、陆地覆盖率命中 40%±1pp、
> 14 个模板齐全且 MIT 头在、`fmg/` 下 **0 处 `Math.random`**。
> 与上游的差异（已写进代码头）：邻居表是规则方阵 **8 邻居**（上游 Voronoi）→ 长得像但不逐字节同构；
> 粗糙度用仓内值噪声 fBm（没引 simplex-noise）；覆盖率校准是本层补充（模板本身不管占比，实测 continents 87% 陆地）。
>
> **第 ② 步已交付（2026-10-29）**：面板 + store 接线。
> - `components/FmgPanel.vue`（**两个视图共用一份**：模板 / 种子 / 陆地占比 / 崎岖度 / 精度 + 3 张候选 + 保留手绘开关），
>   剧本侧入口 `basemap-fmg-terrain`、行星侧 `planet-fmg-terrain`。
> - store：`previewFmgTerrain(target, params, opts)`（**只读**，粗网格 2500 格出 3 张）/
>   `applyFmgTerrain(target, params, opts)` —— 生成后走 `synthesizeTerrainInto` 的 **`opts.heightmap` 分支**：
>   同一条 undo、同一份气候派生、同一套手绘搬移（FMG 换的是整张网格 → 用 `transferHandEdits` 按图幅相对位置搬）。
>   **没有新开写口**，所以这两个入口不进 writeGate 契约（守卫仍在 `synthesizeTerrainInto` 里）。
> - 顺手把两处高度图缩略图收成一份 `utils/heightThumb.js`（`drawHeightThumb`），
>   否则"同一个高度在两块面板里是两种颜色"。
> - 判据：`test_151` h 段（入口 / 3 张候选非空 / 预览只读 + 可复现 / 应用后 `fmg.template` 落库 + `genBBox` 记录 +
>   气候数组齐全 / **一条 undo 回到应用前**）。
>
> **下一步（按顺序）**：③ 气候/群系 —— 🔶 **决定不搬**（见下）；④ 河网 + 湖泊 —— 🔶 **河已通，湖不做**（见下）；
> ⑤ Voronoi 化（`delaunator`）替换 8 邻居；⑥ worker 化 + 进度条。
>
> ③ **决定：不搬 FMG 的 `climate/*` 与 `biomes`**（2026-10-29）。理由：
> 司天已有**唯一一份**气候派生（`heightMath.buildClimateInputs` 纬度 + 离岸距离 → `deriveLayers` 出 temp/prec/biome），
> 而且 A6 的落库链路里气候是**和高度同一笔**写进 undo 的。再搬 FMG 的温带/风带/湿度模型 = 两套气候真值，
> 迟早出现"同一份高度图两种群系"。若将来确实要 FMG 的风带/湿度（观感更真实），正确的做法是
> **替换那份唯一实现**，不是并列新增。
>
> ④ **河：复用司天唯一那份河网追踪**（`riverTrace.traceRivers`），**不搬 FMG 的 `river.ts`**（那是第二套河网）。
> 但 FMG 模板地形**天生带大量封闭洼地** → 实测 8k 格上自动河流 **0 条**（水全困在盆里）。
> 修法：`utils/fmg/index.js` 生成后调用 **`terrainSynthesis.fillDepressions`**（priority-flood，仓里唯一实现，
> 本轮把它导出复用）抬平盆地；同时把覆盖率校准从"整体平移"改成 **"分位值当海岸线 + 陆上落差拉伸到 0..100"** ——
> 平移会把峰值压到 ~50，而源头闸门是绝对高度 `> 60`，河照样长不出来。修后实测：continents 20 条 / oldWorld 5 条 /
> archipelago 2 条（岛小，合理）。判据 `unit/test_fmg_heightmap.js` f7（填洼 941 格 / 峰值 100 / 12 条河 + 填洼不改陆地占比）。
> ④ **湖：本轮不做**（有意）。做一个"真湖"需要 洼地 → 湖面 → **出流** 三件套（FMG `lakes.ts` 的蒸发/出流平衡）；
> 只把盆地挖成 18/19 会得到**没有出水口的死湖** → 河流在湖边断头，正是本项目明令禁止的形态。
> 现阶段湖泊仍走既有「湖泊」笔刷（平底 18/19，松手重标海陆）。要自动化，下一步按 FMG 的出流模型**替换**现有实现。

**前置已核实（2026-10-29）**：参考实现就在本机 `E:\CODE\CangKu\SP-1025\planet-map\src\core`（约 3000 行 TS）：
`graph/{lattice,voronoi,grid,pack}` + `heightmap/{generator,templates}`（**templates 是 Azgaar MIT 的模板脚本，文件头带
`Copyright 2017-2024 Max Haniyeu (Azgaar)` + `SPDX-License-Identifier: MIT`，移植必须原样保留并补 `THIRD_PARTY_NOTICES.md`）
+ `noise/climate/river/lakes/biomes/pipeline`。依赖 `alea` / `delaunator` / `simplex-noise`（**这三个司天一个都没引**，
理由见 `THIRD_PARTY_NOTICES.md` 末节）。

- **搬 `SP-1025/planet-map/src/core/`**：`graph/*`（lattice/voronoi/grid/pack）、`heightmap/*`（14 模板 + DSL 执行器）、
  `pipeline`、`climate/*`、`river`、`lakes`、`biomes`、`noise`、`utils/*`、`worker/generate.worker.ts`。
- **P0 改造**：去掉全局 `Math.random = Alea`，改显式 `rng` 参数（判据：同 seed 全层 hash 一致）。
- **适配层**（真正的工作量）：
  1. 输出 `PlanetMap{grid,pack,rivers}` → 司天 `heightmap{h,temp,prec,biome,grid{points,spacing,cellsX,cellsY}}`；
     8k/16k 与司天 97×45 的分辨率差**一起解决**（要么降采样、要么提栅格）。
  2. `river.ts` 的 pack cell 链 → `rivers[{points,width,discharge}]`（河名仍归标签层）。
  3. 省界仍走司天 `landmass` / `provinceShape`，**不要**把 Voronoi cell 当省。
  4. 存档只保留"转好的 heightmap"，不留 `SerializedMap` 全量结构。
  5. 生成 = 一条 `store.undo`（不接 SP-1025 命令栈）。
- **依赖/许可**：`alea`、`delaunator`、`simplex-noise`；14 个 FMG MIT 头必须保留，补 `THIRD_PARTY_NOTICES.md`。
- **判据**：同 seed hash 一致、陆地覆盖率 ±1%、河流零断头、8k <1s / 16k <3s、415 省项目零影响。
- **建议切分**（避免一口吃不下）：① 网格 + 高度模板 → 只出 heightmap；② 气候/群系；③ 河网 + 湖泊；④ 侵蚀/坡度细节；⑤ worker 化 + 进度条。

## C. 文字 / 观感旧账（原 §4）

| # | 事项 | 状态 | 备注 / 下一步 |
|---|---|---|---|
| C1 | 内嵌字体（宋体/文楷） | ⛔ 需用户定（字体与许可） | **不能自主定**：司天要发布安装包，字体许可是硬约束 —— 系统里的 SimSun/宋体是微软授权，**不许随包分发**；能分发的只有 OFL 字体（如 LXGW 文楷 / Noto Serif SC），但 ① 选哪款、② 可接受的体积预算（整字库 10–20 MB，子集要 fonttools，本机未装）、③ 是否允许走网络取字体文件 —— 三条都得暮雨拍板。定了之后落地动作很明确：`@font-face` + **按需子集**（只收 GB2312 常用字 + 地图用字），`display: swap`，且**不许进首屏关键路径** |
| C2 | 国名多行 / 沿主轴旋转 | ✅ 2026-10-29 | 新增 `utils/labelOrient.js`（画布与导出**共用一份决策**）：`principalAxisAngle`（领土主轴：每省形心 + 面积权的二阶矩；单省退化=不转）+ `planPolityShape`（细长比 ≥1.6 才转、夹 ±30°；超宽折两行，CJK 按字/西文按词）。`drawStyledLabel` 支持 `lines/rotate`，SVG 导出逐行 `<text>` + `transform=rotate`。判据 `unit/test_polity_labels.js` t12/t13 |
| C3 | 省名占位（415 个「新省份 N」） | ✅ 2026-10-29（便宜那条路） | 画布加「仅已命名省」开关（`toggle-named-provinces`，默认关）：打开后占位名整层不画。判据复用 `polityLabels.isPlaceholderProvinceName`（与导出链同一份），过滤落在 `collectScenarioLabels({skipPlaceholderProvinces})`，组件只传开关。`unit/test_polity_labels.js` t11 + `test_73` f0 源码闸门守。数据侧「从 Obsidian 批量导入真名」仍未做（要用户定映射规则） |
| C4 | 地形分辨率 97×45 太粗 | ✅ 2026-10-29（治标） | 放大插值从**双线性换成双三次**（Catmull-Rom）：双线性只有 C0、等值线会拐在格心上，双三次是 C1；四周补一圈用**二阶外插**（`v(-1)=3v(0)-3v(1)+v(2)`，一阶外插在二次面上边缘仍差 1.03 实测），并对**真实格点邻域**做 min/max 夹持砍过冲。判据 `unit/test_heightmap_resample.js`（二次面误差 0 / 阶跃不过冲且单调）。真解（8k/16k 源数据）随 B |
| C5 | 道路分级显隐 | ✅ 2026-10-29 | 新增 `utils/routeDensity.js`（纯函数）：far 只留长度前 50% 的干道 → mid 全部 roads → near 加 trails → close 再加 searoutes —— **与标签/城镇同一套 far→close 档位**；`drawRoutes` 不再自带 `sparse` 分支。判据 `unit/test_label_zoom.js` z6（含"不许按线宽判主干"的理由：FMG 导入的路几乎同宽） |
| C6 | 海岸带导出一致性 | ✅ 2026-10-29（已覆盖，非欠账） | 两条路都在：细网格（spacing ≤14）直接抽等深线；粗格导入图用**高精度 `landFeatures` 环**栅格化重建海深场再抽线（`getSeaDetail` 的 `buildSeaDepthFromRings` 分支，`unit/test_sea_depth.js` t9–t11 守）。只有"粗格且没有高精度环"这一类才需要先 ×2 提分辨率（现在是 bicubic，坡面连续） |

## D. 之前验收的复核项（原 §5）

- **B1「黑一块白一块」**：本轮（10-27）已改无主省纸色 / 陆地色带 / 阴影区间 / 海岸浅滩 + 10-28 导出浅滩。
  仍需**用户在真实项目上看一眼**，若还剩具体某一块，请给截图与位置（否则只能继续猜）。
- **F1「重开项目直接没」**：副本制「关项目 → 重开」数据完整；启动恢复失败会报 `reason`。
  若用户说的是「重启应用后不恢复」，需拿那条 `reason` 再查（`missing` = 文件被移走）。
- **B3「三个都画了没效果」**：剧本侧高度/群系/文化笔刷已自动切可见档；行星侧实测 +43 格。
  若仍无效果，需用户给出「哪个工具、哪个视图」。

## E. 星系 3D 二期（10-28 交付时刻意留的）

1. ~~**3D 里点行星下钻**（现在纯观景，不导航、不改数据）。~~ ✅ 2026-10-29：射线点选（区分点选/拖拽旋转）→ 左下角卡片（类型下拉 + 「进入行星地图」）；下钻经 `emit('select-node', {id})` → `SystemDetailView.on3dSelectNode` 按 id 找回真节点 → 上层 `selectPlanetOrNode`。判据 `test_163` F 段。
2. ~~**行星类别落数据**：现在是 tags/名称推断；建议加 `node.planetClass`（与 `sizeOverride` 同级，走 `updateNode`）。~~ ✅ 2026-10-29：`planetClassForNode` 优先读 `node.planetClass`（非法值/老数据回落推断，绝不把脏 classId 送进渲染）；3D 卡片里改类型 → `updateNode`（一条 undo）+ **当场换贴图**。判据 `unit/test_system3d_scene.js` a4b。
3. ~~**双星互绕可视化**：现在只按主恒星取色，双星不参与光照/轨道。~~ ✅ 2026-10-29：`buildSystem3dScene({companions})` 出伴星（色/轨道/相位/自转，最多 2 颗、脏色回落）；3D 里各带一盏点光 + 光晕绕主星转。判据 `unit/test_system3d_scene.js` a11。
4. **多恒星系同屏**（域内 3D 总览）—— 会显著放大性能与交互复杂度，先不做（维持原判断）。
5. ~~**低配降级**：现在只有"WebGL 不可用 → 报错面板"，没有自动降帧/减段数。~~ ✅ 2026-10-29：按实测帧耗自动降档（high→mid→low，**只降不升**避免抖动）：像素比 1.5→1.0→0.75、最低档关小行星带；HUD 出「已自动降档」提示。判据 `nextQualityLevel` 单测 a10 + 源码闸门 b3。
6. ~~**纹理常驻缓存**：18 张 canvas 跨开关复用（换来二次打开瞬时）；若最后要抠内存，项目关闭时调 `__clearTextureCache()`。~~ ✅ 2026-10-29：`projectStore.closeProject` 里动态 import 后调 `__clearTextureCache()`（跨开关仍复用，只在**项目生命周期**结束时释放）。判据 b3 源码闸门。

## F. 工程债 / 口径待定（跨轮遗留）

- **`.sitian` 体积** —— ✅ 2026-10-29 **已实测**（`npm run audit-project-size -- --project <file>`，只读；顺带修了它把多环省的顶点数算成 `NaN` 的 bug —— `extraRings` 里有 `{points,kind}` 环描述对象，不能直接 `.length`）。
  真实 415 省孤本（`绒花计划.sitian` 7.06 MB / desite 底图 27067 个顶点）的钱花在哪：

  | 占比 | 字节 | 是什么 |
  |---|---|---|
  | 41.8% | 2.95 MB | `snapshots`（13 份；`SNAPSHOT_MAX_BYTES=3MB` 已生效，不是失控）—— 其中**第 0 份 base 就占 2.33 MB**（含全量 `terrain`），其余是 diff |
  | 37.1% | 2.62 MB | `scenarios` 主体 |
  | 19.5% | 1.37 MB | `maps`（行星地图） |
  | ≤1% | 45 KB | `entities` / `hyperlanes` / `meta` |

  更细的两个真问题（工具直接点名）：
  - **同一份 `terrain` 进了 8 份 patch**（`scenarios/baseMaps/底图 2/terrain` × 8 = 0.57 MB）——
    `diffWalk` 对数组是整体替换，动一个省 = 整表重存；
  - 底图级 `updatedAt` 也进了 patch（× 8）—— 噪音 diff 的又一处（与实体时间戳同源）。
  结论：压体积的杠杆顺序 = ① 数组级 diff（省表按 id 局部化）/ ② base 快照里 `terrain` 的去重（口径要动）/
  ③ `grid.points` 去冗余（≈4.5%，可与 origin+spacing 推出，但加载侧要同步改）。**`changeEvents` 只有 18 KB —— 不是大头**。
- **保存挪线程**：指南包里的"分两步"口径仍未做（大项目落盘会占主线程）。**本轮没动** ——
  它要在"数据安全优先"下改序列化/写盘路径，仓促改等于拿落盘安全换手感；下一步先做「序列化耗时实测」再决定第 1 步切在哪。
- **`docs/ARCHITECTURE_MAP.md`** 是脚本生成的，每轮收尾跑一次 `python scripts/gen_architecture_map.py`（本轮已更新）。
- **方寸（fangcun）执行日志**：每轮只落仓内文档，没有回写方寸看板（工具侧没有 create-log 能力；任务卡倒是能更新，已同步进度）。

---

## 下次开工建议

1. **B 阶段 2 第一步**（最大一块）：只搬网格 + 高度模板，出 heightmap，先把"同 seed hash 一致 / 8k <1s"两条判据立起来。
2. **C1 字体**：先定字体与体积预算（要真字体文件；`@font-face` + 子集，不许撑大首屏）。
3. **C4 真解 / C6**：C4 的治标（bicubic 上采样）已做；真解随 B 的 8k/16k 一起。
   C6 已由两条路覆盖（细网格直接抽等深线；粗格导入图用高精度 `landFeatures` 环重算海深场）——
   只有"粗格且没有高精度环"这一类才需要先 ×2 提分辨率。
4. **F 下一步**：快照策略（上限/频次）与 `grid.points` 去冗余（≈4.5%，要同时改加载侧）；保存挪线程先测序列化耗时。
5. D 的三条等用户回话（截图/原因/工具视图），不猜。
