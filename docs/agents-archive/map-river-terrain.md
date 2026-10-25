# 河流与地形（AGENTS.md 历史条目归档）

> 由 `AGENTS.md` 的「架构速查 / 开发陷阱」按主题拆出（2026-10-19），**原文一字未改**。
> 这里只放**历史**（当时改了什么、踩了什么坑、判据是什么）；当下口径以代码 + 回归用例为准。
> 新增知识请写回 `AGENTS.md` 的速查或**本文件**的对应主题，不要另开新文档。

- **A1/M1b：底图高度图写入统一（2026-09-25）**: `scenarioEditing.js` 的 5 个写入入口（`applyHeightBrush` / `applyBiomeBrush` / `applyCultureBrush` / `applyReligionBrush` / `deriveAllLayers`，各含 undo+redo）**全部改走 `commitHeightmap`** —— 底图侧原来的形态是「整体替换 baseMap 对象」（`baseMaps.value = { ...baseMaps.value, [k]: { ...baseMap, heightmap: {...hm} } }`），**一写就换引用**，与「共享同一份高度图」天然冲突：绑定行星后会变成「**读行星那份 / 写自己那份**」＝用户以为改了、画布却不变（静默分裂）。`commitHeightmap(key, hm, { touch })`：绑定态写 `mapData[pid]` 并排**行星侧**落盘（`scheduleAutoSaveMap`）；`touch:false` 供 undo 用（撤销不打 `updatedAt`，与改动前逐字段一致）；**悬空绑定回落到底图自身**（旧实现 `if (!planet) return;` = 静默吞掉这次编辑）。配套两条同批修复（`test_67` 守）：① `changeNodeId` 采集根补 `baseMaps` **值槽** —— `baseMaps[*].planetId` 是 id 引用，不级联则行星改名后绑定悬空，而绑定迁移时底图侧那份已被 `delete` → 底图表现为「空地图」（只采值、不采键，键语义混用见 `idRefDicts` 注释）；② 派生 Worker 异步回写的落盘通道**按归属分流**（写进 `mapData` 却排剧本保存 = 不落盘）。同批已修（各带反向探针）：**R2 一星一图**（`planBindBaseMapToPlanet` 加第 4 参 `allBaseMaps`，命中则 `conflictKind='planet-taken'` 拒绝并点名占用者）、**R4**（新增 `getBaseMapsBoundToPlanet` 反查 → 行星侧重建高度图时**点名**受影响的剧本，不再只报「高度图已重建」）、**P3 的一半**（`projectStore.adopt` / `closeProject` 清 undo 栈 —— 跨项目/跨事实源的撤销串味；⚠️ 只能放项目生命周期层，**不可**下沉到 `applyProjectToCanvas`：`seedFromPayload` 复用它重新装载画布，在那里清会把刚入栈的导入命令清掉，test_50 实测抓到）、**R1**（**快照不再装高度图**：`SNAPSHOT_HEAVY_FIELDS = ['heightmap','terrainGrid','referenceImages']` —— `snapshotState` 剔除、`restoreSnapshot` 从**当前项目**补回、新增 `snapshotStateWithHeavy` 供回滚的 `before`；满 50 份实测 **38.23 MB → 4.7 KB**，UI 已写明「快照不含地形高度图」；⚠️ 「剔除」与「补回」两半的探针**会互相掩盖**，必须一次一枚验证）。⚠️ **M1c 已开放双模式入口（2026-09-25）**，见下一条

- **A1/M1c：剧本地形「冻结导入 / 跟随行星」双模式（2026-09-25）**: `scenarioEditing` 新增 `importHeightmapFromPlanet(baseMapKey, planetId, { force, planetName })` —— 把行星当前地形**深拷贝**一份到底图（`cloneHeightmapForFreeze`：逐数组 `new Float32Array(...)`，**绝不共享引用**，也不复制运行期 `_spatialIndex`），走 undo，并记**纯展示**标注 `terrainFrozenFrom = { name, at }`（非引用、非真相）；底图已有地形时返回 `conflict`（`conflictKind='basemap-has-terrain'`），`force:true` 才覆盖。另有 `describeBaseMapTerrain(key)` → `{ mode: 'following'|'frozen'|'empty'|'none', planetId?, dangling?, from? }` 供 UI 显示（`following` 且行星已不存在时给 `dangling`，提示解绑/改冻结）。**为什么两种模式并存**：跟随 = 共用同一份 → 行星改地形会连带改剧本（适合当代同步构建）；冻结 = 独立副本 → 双向互不影响（适合历史存档剧本）。A1 文档最初否掉「复制」方案的理由（「复制即双源、漂移必然回归」）在**同步构建**场景成立，在**存档**场景恰恰相反 —— 存档要的就是漂移不发生。UI 在 `ScenarioMap` 底图区（工具栏「更多」里）加「地形：<状态> + 选行星 + 冻结导入 / 跟随 / 解绑」，两个按钮的 `title` 写明取舍（「复制一份」vs「会改到行星」）。⚠️ **不做任何自动绑定**（`.map` 导入只推 provinces 到行星，从不设 `planetId`）。回归 `test_68`（冻结/跟随**互为反面**：同一句「在剧本涂山」，冻结下行星必须不变、跟随下必须变）

- **M2/A2（渲染数据驱动）第一步：高度图栅格渲染跨视图共享（2026-09-25）**: 新增 **`utils/heightmapRaster.js`** —— 从 `ScenarioMap` 抽出的「高度图 + 配色 → 离屏 canvas」纯函数层（色带 `HYPSO_/TEMP_/PREC_` + `cellColor` + `fillPixelBlock` + `buildHeightmapRaster(hm, kind)` + `createRasterCache()` 工厂），**ScenarioMap 与 PlanetMap 现在共用同一套配色**（此前同一份高度图两个视图各有一套算法/配色 = 观感分裂 + 改一处另一处不变）。`ScenarioMap` 只保留「用哪份高度图」与「缓存失效时机」（它的栅格缓存只在切底图时清 → 涂抹期间是陈旧的，属既存行为，未改）；`PlanetMap` 新增 `drawHeightmapRaster(ctx, kind)`，缓存失效用**内容指纹** `hashLabels(hm.h)`（涂抹即失效，无需外部 clear）。UI：PlanetMap 高度笔刷参数区加「着色」下拉（`data-testid="heightmap-raster-kind"`，**只在高度模式渲染**），五档 `biome`（默认=原矢量群系着色，**零行为变更**）/`landsea`/`height`/`temp`/`prec`。⚠️ 两处**易漏接线**：① 切换档位必须 `watch(heightmapRasterKind) → requestRender()`，否则「下拉改了画布没反应」（test_69 像素断言抓到过 `diffPixels: 0`）；② `currentMapData` 在 **PlanetMap 的 setupState** 上，store 上没有（写成 `store.currentMapData` 恒 undefined → 装置断言假红）。回归 `test_69`（源码守卫「组件里不许留副本」+ 纯函数四色 + 切档像素变化/切回逐像素复原）

- **M2/A2（渲染数据驱动）第二步：`terrain[]` 降为可选覆盖物、地形改由高度图驱动（2026-09-25）**: 新增 **`utils/terrainRepresentation.js`**（纯函数 `hasHeightmapContent` + `resolveTerrainRepresentation`）＝「这片地形该画什么」的**唯一判定**，**渲染 / 命中 / 导出三处共用**（各写一套 `if` 就是又一个「改一处另两处不变」的双源，而且不会报错）。规则：**有高度图 → 高度图是地形主表示**（多边形默认**不画**；`terrainPolygons` 图层显式打开后**半透明**叠加 `alpha 0.5`，此时高度图转半透明 `0.75` —— 两者都要看得见）；**没有高度图（自建底图 / 旧多边形地图）→ 多边形照旧是主表示、照旧不透明**（兼容性底线）。`layers.planet` 新增 `terrainPolygons`、**删除 `heightmap`**（职责被「地形」总开关吸收；它原本就没有 UI 入口）。涂色网格（`terrainGrid`）显示条件从「死绑 `terrain` 图层」改为**地形有显示即可**（否则关掉总开关改看覆盖物时涂色层凭空消失）。高度图渲染位置**从最后（所有元素之上）移到地形槽位** —— 那个位置正是「只能默认关着，否则像遮罩」的成因。同批修掉三条**真缺陷**：① **PNG/SVG 导出此前完全没有高度图**（`useFullMapExport` 只有 `drawTerrain`）→ 导出图与画布不一致；现在两侧读同一份判定，SVG 用**内联位图**承载高度图（栅格数据在矢量格式里只能如此，与参考底图同手法）；② **导出必须 `drawHeightmap(ctx, alpha, { full: true })`** —— 它的视口剔除是**屏幕**优化，导出时会把屏幕外的地形整块丢掉（不报错，只是悄悄缺一大片）；③ 高度图叠加不透明度**统一 0.75**（原先矢量 `0.7` / 栅格 `0.85` 两套取值）。命中随动：`planetHitTest` 改用 **`terrainHit`**（= `drawPolygons` 且未锁定）——「看得见才点得到」，关掉图层后点不中；编辑多边形（`draw`/`move`）与高度笔刷分别强制显示覆盖物 / 高度图，否则「看不见也点不到 / 涂了看不见」。回归 **`test_70`**（源码守卫三处共用且无残留旧 `if` + 像素「开覆盖物→画布变→关回**逐像素复原**」+ 命中开/关 + 导出含高度图位图与覆盖物 path）；随动 `test_45`（导出断言改挂覆盖物图层 + 新增「默认导出含高度图位图」）、`test_59`（图层控制改走覆盖物；纹理强度守卫改为要求 `0.45 * alpha`，因为覆盖物半透明时纹理不跟着淡就会显得比底色更实）、Node 单测 `test_terrain_representation.js`（13 条，含与 `heightmapAccess.hasGrid` 的**口径蕴含**关系）。⚠️ 反向验证 3 枚探针命中 **8 项且 f0/f1/f2/f3 四段各自说话**（累积式失败，非 fail-fast）

- **M3/A6：笔刷工具的统一滚轮契约（2026-09-25）**: `PlanetMap.onWrapperWheel` 从「只有地貌笔刷调间距」扩到**三个笔刷模式统一契约**（与 `ScenarioMap.onWheel` 对齐）：**滚轮 = 半径 / 大小；Shift+滚轮 = 强度 / 硬度；上滚增大**（`deltaY < 0`）。两条纪律：① 步进与范围**取自各笔刷滑块自身的 min/max/step**（高度 20-300/step 10、0.5-10/step 0.5；地形 1-30/step 1、0-1/step 0.05）—— 滚轮另立一套数字就会出现「滚轮能调出滑块调不出的值」这种静默不一致；② 必须用 **`@wheel.capture`**（捕获阶段）拦截，否则同一次滚轮会**同时**触发画布缩放。非笔刷模式（pan / draw / region / marker / route / …）**不拦截**，滚轮仍归画布缩放（与从前一致）。UI 加 `.brush-wheel-hint` 提示 —— 用户不知道有这组手势，等于没有。回归 **`test_72`**（真 `WheelEvent` 派发到 `.canvas-wrapper`：上滚/下滚、Shift 改强度而非半径、边界夹住、非笔刷模式不拦截）

- **🔴 河流：预览 = 落库 + 橡皮 + 「加河+改母河」一条撤销（2026-10-18 第十八修·三/四；回归 `test_122` + Node `test_river_erase.js`）**：暮雨原话「节点的设计是不是本来就有问题？有变成描点连线模拟器的风险。河流要不要尝试其他画法？应该更偏向手绘吗（**甚至有橡皮擦来擦除**）……应该优先参考现成各类绘图软件」。
  - **预览 = 落库**：修前预览走 `smoothWhileDrawing(draft,1,18)` 且**宽度写死 `0.7`**、落库走「抽稀→按弧长压点数→Chaikin」+ 宽度 3.5 ⇒ 画的是细发丝、松手变成宽河，形状也不是同一条。现在两边共用 **`riverNodesFromDraft()`**（唯一几何链）+ 共用 `RIVER_WIDTH_DEFAULT`，`test_122` b 段按点比对（38 点 = 38 点，`JSON.stringify` 相等）。
  - **橡皮**（工具 `riverErase` / **Shift+W** / 底图编辑行「橡皮」按钮；图标 `eraser` 已加进 `Icon.vue`）：按住抹过去就擦，**不需要先选中对象/挑节点/Delete**。几何在纯函数层 `utils/riverErase.js`（`erasePolylineByStroke` / `planRiverErase`）。🔴 **判定看"线的哪一段落在半径内"，不是"哪个节点落在里面"** —— 节点间距按屏幕像素定（30px），长河被 `RIVER_MAX_NODES`(72) 截住后间距可远超橡皮直径，只判节点会"擦过去没反应"；做法是按 `radius/2` **虚拟加密**再判，结果只保留「原节点 + 每段切口」（不漏、也不摊爆节点数）。边界**算留不算擦**（严格 `dist < radius`）；留下短于 2 点的段丢弃。半径 `RIVER_ERASE_RADIUS_PX = 18`（屏幕像素，画布上的轨迹与笔尖圈**用同一个常量**画）。**只擦手画的河**（`river_` 前缀；导入河/自动河不动，抹到就明确回一句，绝不静默）。擦断 → 第一段留原 id、其余段为新河（继承宽度）。
  - **原子写口 `applyBaseMapRiverEdit(baseMapKey, {patches, adds, removes})`**（改/加/删一起、`execute` 只有一处、已登记 `writeGate`）：橡皮一次擦除 = **一条撤销**；顺带把「画支流」从**两条 undo** 变成一条（`addBaseMapRiver` + `updateBaseMapRiver` → 同一个口，`test_119` 行为不变）。
  - ⚠️ 随动：`test_95` 组件画河闸门 `store.addBaseMapRiver(` → `store.applyBaseMapRiverEdit(`；`test_106` 预览闸门 → `riverNodesFromDraft` + `riverPreviewNodes()`。
  - ⚠️ **踩过的两个坑**：① 出图脚本里"中途改相机"会让"预览=落库"这条不变量失效（`px()` 跟着相机走 → 预览 32 点 / 落库 72 点），出图前把相机按定就不要再动；② `headless` 下压叠闸门的 `window.confirm` 会**永久阻塞**（没有 dialog handler）—— 探针/用例量落库那条链前必须 `window.confirm = () => true`。
  - 观感存档：`docs/assets/river-eraser-20261018/{01-preview-equals-landed,02-landed,03-erase-trail,04-erased-split}.png`（真实底图）。交接与欠账：`docs/SITIAN_HANDOFF_20261018_ROUND18.md`。

- **🔴 河流编辑三件：多选 / 框选批量删 / 裁到海岸线（2026-10-17 第五轮；回归 `test_114`）**：
  - **多选**：`selectedRiverIds`（整批）+ `selectedRiverId`（主选中 —— 拖节点/加拐点仍只作用于它）。
    **Shift+点 = 加选/移出**；高亮**逐条画**（主选中暖白光晕、其余淡青细芯），以前只画一条 → 多选时其余几条毫无反馈。
  - **框选批量删**：**Shift+拖动**出虚线框；判定必须**同时**含"顶点在框内"与"**线段穿过框**"（Liang–Barsky）——
    河的点很稀疏，只判顶点的话"框住河身中部"一条都选不中（判据与视觉不一致）。批量删 = **一条撤销**
    （写口 `removeBaseMapRivers`；`test_114` 判据：删 3 → 0，**一次** Ctrl+Z → 3 条全回）。
  - **裁到海岸线**（按钮，两个入口都有文字）：只在他按下时裁 —— 有人就是要画进海里做三角洲。
    陆地判定走 `makeRiverLandCheck(getLandMask())`（省份掩膜独占）+ `clipPolylineToCoast`（**同一份实现**，
    不许在组件里另写一套）；写口 `applyBaseMapRiverPatches`（整批一条 undo）；整条在海里的**不自动删**，只在回执里点名。
  - ⚠️ 两个写口都要登记进 `writeGate.js` 的 `MEMORY_WRITE_CALLSITES`（test_54 的反向校验会查"有守卫没登记"）。
  - ⚠️ 写这类行为用例的两个坑（本轮都踩了）：① **选中一条河后工具栏会多一行**，画布整体下移 ——
    每次点击都要**重新量** `canvas.getBoundingClientRect()`，用开头那份 rect 会让第二次点击落到河上方；
    ② 框选起点必须离所有河 ≥ `RIVER_SELECT_HIT_PX`(24@1×)，否则按下瞬间先命中河、走成"Shift+点加选"。

- **🔴 推演地形的结构：山脉走向 / 高原面 / 裂谷 +「路由层四个候选全被否定」（2026-10-18 第九修；Node `test_terrain_structure.js` 15 条）**：
  - **先否定（有数，别再试）**：在真实 `desite` 底图（133×75 / 陆格 2876 / 高程量化到 0~100）上，
    **平局打破 / 最小代价出流 / 双线性放大网格（2~8×）/ 放大＋分形细节** 四种口径对河网几何**都没有改善**
    —— 判据用"与分辨率无关的**链节长度**"（每格到下一个汇流点/河口的**世界距离**）：中位 **26u 一位小数都不动**，
    最小代价与哈希平局反而更碎（<20u 占比 26% → 35%/45%）。⚠️ **度量陷阱**：别用 `buildRiverPaths` 的链统计
    比较分辨率 —— 它按流量截到 `maxPaths`（1200），细网格下只统计流量最高那批 → 中位链长被系统性拉高
    （我先得出过"放大 3 倍就把短棍消掉了"的**假结论**）。完整数据：`docs/RIVER_ROUTING_NEGATIVE_RESULTS_20261018.md`。
  - **真正的杠杆是"地形里有什么"**：`utils/terrainSynthesis.js` v2（`TERRAIN_SYNTHESIS_VERSION = 2`）在同一个骨架
    （离岸距离场 + chamfer + priority-flood 填洼）上叠三样：① **各向异性脊线**（ridged multifractal，垂直走向频率
    8.5 vs 沿走向 2.6 —— 两者相等就退化成碎丘）+ 次走向 0.12 + 域扭曲 0.16；② **高原面**（低频场**按 p62~p80 分位**圈地、
    强混合 0.92、面内残差 0.015）；③ **裂谷**（1~2 条折线 + 距离剖面下切）。**默认开**，`structure:false` 只作对照组。
  - 🔴 **三条踩过的硬口径**：① **高原掩膜必须按分位** —— 固定阈值 `smoothstep01(0.50,0.62,pf)` 实测圈住 **64% 陆地**
    → 中位高度被抬到高原面上 = "处处是高原"= 没有高原；② **裂谷走向必须跟着山脉**（`axis ± 15°`）——
    第一版随机取向后，结构张量量出的主导走向与 `rangeAxisDeg` 实测差 **49°**，走向判据直接失效；
    ③ **裂谷落点要用 `spanY/spanX`**（归一化 `ny` 只到 aspect）—— 第一版把裂谷放到陆地**外面**（走廊 0 格），判据量的是空气。
  - 🔴 **高度预算**：下游「源头高度闸门」是**绝对高度**（`TRACE_SOURCE_HEIGHT = 60`）。结构权重第一版把陆地均值
    45.6 → **63.1**、**85% 的陆格在闸门之上**（一点自动河流 = 2400 个源头）。现值均值 42~44、>60 占 15~21%，有判据守。
  - **判据的口径（四条，都带 v1 反向对照）**：各向异性在**高频残差**上算（原始高度上会被离岸放射趋势冲成各向同性，
    且 v1 自己能刷出 17.8% 假值）；高原面看**最大连片平高块**（v1 缓坡肩也有 20~114 格 → 不许写"v1 必须为 0"，
    要"≥180 格且 ≥2× v1"）；裂谷用**走廊带 vs 对照带的相对下切**（一刀切阈值会因"沿线渐变"假红）；
    排水看**最长主河**与**汇流上界**。实测：各向异性 4~18% → **35~76%**；最长主河 737/870/779u → **1645/1941/1701u**；
    汇流上界 333~430 → **1073~1329**；高原面 20~114 格 → **221~470 格**；裂谷下切 0.5~2.2 → **6.7~12.9** 单位。
  - **接线**：默认开（产品按钮与"无高度图时的临时推演"都走它）；`synthesizeBaseMapTerrain` 的回执加一句结构自述
    （走向/裂谷数/高原格数）——否则用户以为还是老样子。`structure:false` 口径**不带** `structure` 字段（用例 c5 守）。
    观感存档：`docs/assets/terrain-structure-20261018/`（v1/v2 地形与水系各一张 SVG，纯 Node 生成，无依赖）。
  - ⚠️ **本仓纪律（再次确认）**：**不许用 PowerShell 的 `Set-Content` 改源码** —— 会把 UTF-8 中文写成 ANSI（GBK），
    下一次读就是乱码、`import` 直接报 `Illegal return statement`（本轮真实发生，靠探针留的临时副本才救回来）。
    改文件一律走编辑工具；真要恢复，`%TEMP%/sitian-ts-*/terrainSynthesis.js` 是探针顺手留的干净副本。

- **🔴 河流选中标记：那条"白线"＝选中光晕，已改成零遮挡轮廓（2026-10-18 第十六修；回归 `test_119` f 段 + `test_112` c 段 + Node `test_river_editor_nodes.js` 26 条）**：
  - **暮雨原话**：「那一条白色的显然就算选中河流的光晕，但是太诡异太离谱了，**根本没办法正常绘图，把整条河都挡住**。
    也许需要想想别的办法。**只要用户能编辑河流就行了，而不是点下去没反馈。**」
  - **真因**：`drawSelectedRiverHighlight` 旧形态是**两遍加宽描边**（外层暖白 `rgba(255,244,200,0.30)` 宽 `baseW+3.5px`
    + 内层亮芯 `rgba(223,243,255,0.95)` 宽 `baseW+1.2px`）⇒ 叠起来接近不透明，整条河被奶白色盖住。
    **"点下去有反馈"与"能编辑"在设计上互斥了。** 判据（`_probe_river_selection_visibility.py`，量窗口内水色像素）：
    修前 **0.009** → 现在细河 **0.68** / 宽河 **0.72~0.83**。
  - 🔴 **两条踩过的弯路（别重走）**：① 我第一版改成"虚线轮廓"**照样盖住**，因为线宽是 `baseW + 1.6px`、
    **中心仍在河道中心线上** ⇒ **轮廓不能靠"加粗的中心线"实现**，必须真算偏移几何（`offsetPolyline`，已下沉到 `riverRender.js`）；
    ② 探针第一版把采样窗口算一次就复用，而**选中一条河会让工具栏多一行、画布高度变** ⇒ after 量到的是河旁边的空地
    （假结论 0.009）。**每次测量都要重算窗口**（test_114 也踩过同一个坑）。
  - **新形态**：沿河**两侧**各退开 `riverSelGapForWidth(basePx)` 像素画轮廓（主选中暖金、多选冷青）+ 节点手柄
    （源头金/河口青/中间白）+ 两端短横杠；**空隙跟着河宽收窄**（细河 ~1px，固定 3.5px 会把 3.6px 宽的河吃掉一半）。
  - ⚠️ **`test_112` 的 c 段判据被同步改了**：它原先找"暖白亮芯"—— 那**正是被投诉的那个东西**，已刻意删除，
    再判它等于判"退回被投诉的形态"。现在按**色相**认标记 + 新增**水面可读性**判据（细河阈值 0.35，
    因为"两侧各 1.4px 线 + 各 1px 空隙"≈5px 在 3.6px 宽的河上几何上就注定占一部分；判别看的是与 0.009 的量级差）。
    同时把它的源码闸门从"每条 `lineWidth` 那**一行**必须有 `px(`"放宽成"**取值来自 `px()` 转换**"
    （合法写法 `const w = px(CONST); c.lineWidth = w;` 会让旧闸门假红 —— 本轮实测）。
  - **反向验证**：把选中标记整体关掉 → `test_119` f 段 **2 条具名红**「🔴 选中后一个选中色像素都没有（点下去没反馈）」。
  - 产物：`docs/assets/river-selection-20261018/`（1×/4× 选中态）。

- **🔴 地形绘制「反马赛克」（2026-09-22 用户实测，回归 test_59 + Node 单测）**: 用户原话「行星地图的绘制功能不太好，依然是马赛克方块填色（地形），不是自然的笔刷」。CDP 实测归因（scale=1.0、画布 900×600 唯一色数）：**全开 7458 → 关掉 `terrain` 层 717**，两个来源缺一不可 ——
  ① **地形涂色网格**：`useTerrainCanvasBrush.drawTerrainGridToCtx` 原来逐格 `roundRect` + 5 档噪点抖动再 `blur(1.4/zoom)`；真实缩放下 1 格只有 2~3 屏幕像素 → 整屏被读成细密马赛克。现改为 **`utils/gridOutline.js`（纯函数，Node 可测）把格边界抽成平滑闭合环**：CSR 扁平邻接（计数→前缀和→填边，**别用 Map<string,number[]>**：40k 格走链 56ms vs 5ms）→ 共线塌缩 → 闭环 RDP（容差 **以格为单位** 0.75）→ Chaikin 2 轮 → `fill('evenodd')`；**同色描边 `lineWidth = cell*0.9`** 堵掉圆角内收留下的细缝。轮廓缓存带 revision，起笔/抬手强制重建、涂抹中按「上次耗时 ×2.5」自适应节流（3.9 万格实测 6~12ms）。
  ② **地形多边形纹理** `utils/textures.js`：原来是 64×64 瓦片里撒上百个 `Math.random()` 小圆点/短线（草叶/树冠/砂粒/碎石），alpha 0.7 平铺 → 1~3px 的斑点整屏铺开同样是马赛克，且**每次重建纹理颜色都在变**（文件头却写着「全部确定性」）。现重写为「低频 fbm 底噪 + 少量大半径柔光斑 + 极淡带状起伏」，全部走确定性 PRNG，`drawTerrain` 叠加强度 0.7 → **0.45**。
  **三条纪律**：① **任何平铺纹理里都不许加逐像素级随机元素**（叠在色块上就是马赛克；要质感就加大尺度、低对比的明暗层次 —— 我第一版加的「纸感噪点瓦片」同属此类，已删）；② **测试 fixture 的涂色网格必须是连续色块**（`make_vault_fixture.py` 原来 `rnd.random() < 0.35` 随机撒点 → 8207 格碎成 6863 块，任何渲染都只是雪花噪点，观感类断言全在拿假数据下结论；真实库实测 935 格 / 仅 6 个连通分量）；③ **静态源码判据必须先剥注释**（`textures.js` 注释里写着「旧实现用 `Math.random()`」，子串判据当场把自己的注释判成违规 —— 与 §126/§139.9 同一个坑的第三次）。

- **🔴 反马赛克第二轮：同一套配方还在另外三处（2026-09-22 用户实测，回归 test_60）**: 用户三条 —— ① 地形笔刷「无法越过某条隐藏界限……形成明显的真空区」② 群系（高度）笔刷「一画就卡……约二十秒后地图上出现神秘草绿色方块」③ 历史剧本底图「很卡…绘制有退化为描点连线模拟器的风险…自由轮廓视图下让人产生密集恐惧症」。CDP 量化归因：① 涂色网格范围 = **高度图 + 16 格**，而 `worldBounds`（地形∪区域∪路线∪标记∪文本∪**地点坐标**）更大 —— 真实库只盖 **87.7%**，底部 555m 看得见涂不上，且落点在网格外时 `TerrainBrush.paint` 的下标 clamp 让整笔**静默无效**；② `planetDrawing.drawHeightmap` 仍是上一轮只改 terrainGrid 时**漏掉的另一半**（逐格 `roundRect` + `ctx.filter = blur(1.4/zoom)` + 13 分桶各一次 fill —— 画布滤镜每次 fill 都要整层重做），而 `interactionMode === 'height'` 会**强制显示**该层（中位帧 66ms，关掉该层 33ms）；③ `rasterizeProvinces` 走 Vue 响应式代理做 O(格数×点数) 热循环（6 省 3600 点实测 **838.6ms**），省份网格逐格 roundRect → 圆角格的缝隙连成深色网格、四角露出「点」= 那个密集恐惧症视图。
  **修法与实测**：涂色网格范围取**并集**（高度图 ∪ worldBounds ∪ 已涂内容，原点对齐高度图相位）+ `ensureCoverage()` 越界自动扩网格（按世界坐标重采样保留已涂；**快照必须在扩张之前取**，一条 undo 连几何与像素一起还原；不能再用 `beginGridSnapshot/endGridStroke` —— 长度变了 `grid.set(before)` 会抛 RangeError）；高度图渲染改 `buildLabelOutlines` + **内容哈希缓存**（双 FNV-1a 扫 27k 字节 ≈0.05ms，能识别就地涂抹）→ 源码零 roundRect / 零 ctx.filter，中位帧 66 → **33ms**；省份网格同样走矢量轮廓 + 栅格化前两层 `toRaw` → 838.6 → **34.6ms**；「绘制」工具补**按住拖动一笔成型**（`simplifyClosedTrace` 闭环 RDP → 省份多边形），单击仍是描点（一笔成型后紧随的 `click` 必须吞掉）。
  **纪律**：① 修「渲染配方」类问题要**按配方 grep**（`ctx.filter` / `roundRect` / `Math.random` / 逐格 fillRect 会成批复制到多个图层）；② **定长 TypedArray + 下标 clamp = 看不见的墙** —— 凡「在网格上涂抹」的功能都必须能自动扩网格或给出可见边界（静默 no-op 最坏，用户会以为笔坏了）；③ 热循环里不许读响应式代理（`toRaw(toRaw(x))`，本项目第四次踩）；④ 用例探针别缓存数组引用（`applySnapshot` 会整体替换 `terrainGrid.value`，缓存旧引用会把修复判成无效）；⑤ 静态判据的分段标记别用注释（`_code_only()` 已把注释行剥掉，`partition('// ===== …')` 必然落空）。

- **A3 行星侧文化 / 宗教笔刷（2026-10-08，回归 test_89 + Node 单测 `test_heightmap_channels.js`）**: 行星主编辑器此前**没有**文化/宗教笔刷（`interactionMode` 无 culture/religion；`drawCultureReligionRegions` 画的只是 Azgaar 导入的参考数据）—— 现在补齐「涂抹 → 渲染 → 吸管」整条链。**分层（别混）**：数据层 `store/geodataModules/channelBrush.js`（写口契约 id 9）、交互层 `composables/usePlanetChannelBrush.js`（半径/硬度/当前值/预览/吸管）、渲染层 `utils/heightmapRaster.js` 的新档位 `culture`/`religion` + `buildChannelPalette`。四条必须记住的口径：
  - 🔴 **通道值 = 列表位置（1 起），不是元数据的 `id`** —— 行星侧 `mapData[pid].cultures` 的 `id` 是 `Date.now()`（`NodeDetailPanel.createCulture` 就是这么写的），时间戳塞进 `Uint8Array` 会被截成低 8 位 → 两个文化抢同一下标、颜色名字全乱且**不报错**。上限 255。
  - 🔴 **抬手 diff 才是本项目的手感标准**，别照抄外部的 `patches[]`、也别照抄本仓剧本侧的「每次 mousemove 都 execute + merge」：`beginChannelStroke`（首行守卫）→ `applyChannelStroke`（就地改数组 + 每格首见记旧值，**不 execute、不落盘**）→ `endChannelStroke`（整笔压成**一条** undo + 落盘）。实测一次拖动改 34 格 → undo 栈 **+1**。**就地改数组、绝不换引用**（画布/用例持有同一引用）。
  - **通道数组三态归一**：落盘 `jsonSafeReplacer` 会把 TypedArray 变普通数组；历史上还有结构化克隆后的 `{0:..}`（**无 length**）。`utils/heightmapChannels.js#normalizeChannel` 是唯一实现（能救就救，救不了返回 null 而不是悄悄造零值）；`usePlanetHeightBrush.ensureHeightmap` 在装载时调用它。
  - **新增着色档必须只改一处**：下拉选项表 = `PlanetMap.vue` 的 `RASTER_KIND_OPTIONS`（高度面板与文化/宗教面板共用）；硬编码 `<option>` 会在两个面板各写一份 → 必然漂移（test_89 f0 静态守）。

- **🔴 造陆 v3：从「花生酱」到可读的海岸（2026-10-25 用户实测，回归 `test_landmass.js`）**: 用户判词「从几坨面团变成了几坨花生酱……造陆形状真的很丑」，并给了 Azgaar / EU4 的地图作为参照。**根因不是参数没调好，是模型错了两层**：
  - **地形层**：v2 是「椭圆掩膜 + 噪声 + 等值线」，场里没有成因。v3 换成**体元地形**（`utils/landmassField.js`）：陆核（平顶 `H·(1-d²)²`）+ 叶（半岛基座）+ 山脊（尾巴=半岛）+ 海槽（海湾）+ 海峡（**取 min** 压到海平面以下，相减会被叠高的山抵消）。半岛/海湾/内海从此是"算出来的"，不是摇出来的。
  - **海岸层**：等值线（marching squares）在平滑场上只能给出**光滑大弧**。v3 改成 **抖动网格逐格判海陆、沿格边描环**（Azgaar 的海岸本质）：陆格的有向边界边（陆地始终在左）串环 → 外环 CCW / 湖 CW；一次角切 + RDP。**一次角切是上限**：v2 的两轮 Chaikin 正是把锯齿磨成花生酱的元凶。
  - **海平面口径**：目标占比 → **格高分位数**，不是"整体平移高度"。双峰分布（大片平台 + 丘）下平移只能让平台整块同时露出/没入，实测要么 0% 要么 100%，永远差 10 个点以上；分位数口径实测 ≤0.5 个点。
  - 三个踩过的坑：① **指数扩散的尾巴**：`h^(p^step)` 在 240 格场上从峰值跌到海平面只占半径 ~19%，陆地变"蜘蛛腿"；而且浮点 `change` 在 1 附近有稳定不动点 → 每个丘都漫延全图（实测 89,422/89,824 格全被摸过）。要量化截断（Azgaar 的 `Uint8Array` 是天然 floor）或直接用体元。② **图幅边框必须是海**：早先 mask 用"与原值混合"，边框还剩 0.64h → 等值线出界、环不闭合，闭合成**横跨半张图的直线边**。③ **PowerShell 改源码会把 UTF-8 中文写成 GBK 乱码**（`Get-Content | Set-Content`），并吞掉换行 —— 本轮真实发生，靠 `git checkout` 捞回；改源码一律走编辑工具。
  - 判据：确定性 / 不重叠 / 不出界 / 格口径 ≤0.5pp 且多边形 ≤2pp / 湖泊存在 / 长条整体扁长比 / 群岛环数 / roughness↑ 复杂度与顶点密度（`test_landmass.js` 9 条）。

