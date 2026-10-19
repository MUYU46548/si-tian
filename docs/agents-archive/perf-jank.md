# 卡顿与性能（AGENTS.md 历史条目归档）

> 由 `AGENTS.md` 的「架构速查 / 开发陷阱」按主题拆出（2026-10-19），**原文一字未改**。
> 这里只放**历史**（当时改了什么、踩了什么坑、判据是什么）；当下口径以代码 + 回归用例为准。
> 新增知识请写回 `AGENTS.md` 的速查或**本文件**的对应主题，不要另开新文档。

- **🔴 地图编辑的卡顿：先量后修（2026-10-18 第十八修；回归 `test_121` + Node `test_skeleton_index.js`）**：暮雨原话「卡顿发生在方方面面，基本涉及地图编辑绘制的，画条线圈个地都要卡一卡……随便拖一条出来都要卡一阵，点节点又开始卡」。**先量**（真实 `docs/mockups/desite.map`：200 省 / 160 河 / 24018 骨架顶点 / 9975 格高度图）：
  - 探针 `scripts/tests/tools/_probe_jank_real.py` + `_probe_jank_real.js`（⚠️ **不能用 `_lab.py run`**：整段 40s+ 会撞 CDP 15s 读超时 → 改成"页面里跑、Python 轮询 `window.__JANK`、超时重连续读"）；CPU 摊派 `_probe_cpu_profile.py`（CDP `Profiler` 按函数聚合自耗时）。
  - 修前：省份自由绘制 **每事件 29.31ms / 帧 p50 44.5ms / p95 72.2ms / 27 帧超 33ms（≈22fps）**；河笔拖笔 3.42ms/p95 24.9；拖节点 9.32ms/p50 23.9。修后：**2.14 / 0.97 / 0.15 ms 每事件，三者帧 p50 全 16.7ms、p95 <18ms、零超 33ms**。
  - CPU 采样把 29ms 摊开：**(program) 67%**（原生 canvas 光栅化，每帧重画整张地图）、`conformToSkeleton` 最近点扫描 590+273ms、Vue 响应式 `get` 陷阱 15%。
  - **三条修法**：① 骨架最近顶点走**空间索引**（`provinceShape.js#nearestSkeletonVertex`：格子边长=threshold、3×3 邻域**完备**、并列按 `seq` 保持"取先出现"⇒ 与朴素双循环**逐位一致**；调用点同时改 `skeletonForTerrain(rawTerrain())` —— 骨架里躺着响应式代理时**每次读坐标都过 get 陷阱**）；② 自动河那段几何**按数据引用缓存**（`autoRiverPartsFor`：闸门/剪枝/成链/抽稀/裁岸线原来**每帧**重算，`render` 7.3→14.3ms，`pruneRiverNetwork` 一项 4.2ms；掩膜改走已缓存的 `getLandMask()`）；③ 🔴 **手势期「底图基帧」缓存**（`beginStrokeBase`/`buildStrokeBase`/`blitStrokeBase`）—— 按下时把「**没有草稿的那一帧**」渲进离屏画布，拖动期每帧只「贴图 + 画在动的浮层」。
  - 🔴 **基帧缓存的三条口径（改这里前必读）**：① 只在**明确的高频手势**里启用（自由绘制/描轮廓/河笔/拖节点/顶点拖动/两种框选/折线切割；**涂抹与高度·群系·文化·宗教笔刷不启用** —— 它们每帧真的在改数据），抬手即丢；② 基帧只装「**草稿之下**的静态层」，草稿之上的四层（省名/势力名/浮雕/标记）与屏幕空间浮层照常逐帧画 ⇒ 贴图帧与全量帧**层叠顺序逐层相同、像素逐点相同**（`test_121` c 段：683640 个像素逐个比对，差异 **0**）；③ **相机一动立刻弃用并解甲**（否则"重建+贴图"比全量重画还贵一倍），另加 `watch` 安全阀：`terrain / rivers / heightmap / autoRivers / autoRiverSegments` 换引用就解甲。机械计数 `strokeBaseStats={builds,blits}` 让用例判"缓存真的在生效"（**不靠墙钟时间**）。
  - ⚠️ 随动：`test_103` 的自动河渲染块锚点改成**不含 `!blitted` 前缀**的子串（加门控不该让判据失效）。

- **🔴 手势期间的自动保存顺延（2026-10-19 第十九修·一；回归 `test_123` + Node `test_interaction_gate.js`）**：上一轮量出"一次编辑之后 800ms 防抖到点，主线程被整块占住 519ms；若那一刻人还在拖，最长帧 596ms"——**连续拖笔已修到 2ms/事件，手感仍然一顿，就是这一顿**。这次保存没有理由必须立刻发生（它是防抖保存，不是 Ctrl+S）。
  - **修法**：`utils/interactionGate.js`（新增，纯状态机 + 每链一份 `createSaveDeferrer`）。四条保存链（地理 800ms / 行星图 800ms / 剧本 300ms / 项目 800ms）在**到点那一刻**先问「人手还在画布上吗」，在就顺延、抬手 + 60ms 静默后立刻补。
  - 🔴 **三条口径（改这里前必读）**：① **只影响"自动"保存** —— 显式保存 / `flushSave()`（退出、关项目）/ Ctrl+S 一律不经闸门（数据安全 > 手感；`test_123` d 段判"手还按着也能立刻写盘"）；② **顺延有 5s 上限**（`SAVE_MAX_DEFER_MS`）：防"手势没配对"把保存饿死 → 到点强制写一次并记 `forced`；③ **抬手后 60ms 静默窗口**（mouseup 里还要提交这一笔：压叠闸门 → undo → 全量写口）。
  - **接线点唯一**：`ScenarioMap.vue` 的 `onMouseDown` / `onMouseUp`（本组件**所有**编辑手势都从 mousedown 起笔，一处接线即全量生效）。配对靠 `canvasGateArmed` —— **不能在 `onMouseUp` 里无条件 end**：`mouseleave` 也走 `onMouseUp`，会刷一堆"没有 begin 的 end"；`onBeforeUnmount` 兜底收掉。
  - **真实测量**（`_probe_save_gate_20261019.js`，真实 `desite.map`，编辑一条河后按住拖 2.6s）：**拖动中最长帧 596 → 18.5ms（0 帧 >50ms）**、期间不写盘（`defers=14`）；**抬手后 275ms / 1 帧**（顺延的保存补上，`savedAfterRelease=true`）。
  - **那 275ms 的摊派**（`_probe_save_breakdown_20261019.js`）：`exportCanvasToProject` **85ms** + `pushSnapshot` **68.9ms** + `toIpcPlain` ~11–15ms + `project.value = …` 的 Vue 深响应式化（未量，估 ~100ms）。**下一件从这三处挑**，取舍与红线写在 `docs/SITIAN_HANDOFF_20261019.md` §2。
  - ⚠️ **测试口径**：`test_123` 的 e 段（5s 上限）必须**拆两次 eval**（会撞 CDP 15s 读超时），且上限是"从**该保存到点**算起" → E1 之后要等 ~7.2s（800ms 防抖 + 5000ms + 余量）；`node scripts/tests/unit/test_interaction_gate.js`（12 条）**不按墙钟判**（`check(now)` 注入时刻 + 机械计数）。
  - ⚠️ 顺带补导出：`scheduleAutoSaveScenarios` 从 geodata 顶层导出（此前只在模块 ctx 里，用例够不着）。

- **🔴 底图编辑（ScenarioMap）的进入性能与「空白陷阱」（P-0 实测 + 修复，2026-09-22，回归 test_61）**: 实测真实库 `desite`（21 省 / 25930 点）：点「历史剧本」→ 113~148ms 同步 JS + 挂载期 367~446ms 长任务（rAF 停摆 381~449ms）；**首帧用的是未适屏相机 (0,0,1) = 画布几乎空白**（非背景像素 7%），适屏帧要等 `setTimeout` 才来 → 用户观感「打开就卡住/空白，滚一下才出现」。修法与四条纪律：① **先算镜位再画第一帧**（`onMounted` 里 `fitToView()` 取代早期的裸 `render()`），布局定稿期（时间轴占位）允许再适屏一次，用户一交互就交还控制权（`initialFitPending`）；② 🔴 **底图数据晚到必须能自动选中**——`baseMapKey` 原本只在 `onMounted` 解析一次，key 为空时 `baseMap` 恒 undefined ⇒ 任何 watch 都不触发 ⇒ **画布永久空白**（只读态被闸门拒绝后就是这个形态）→ 补 `watch(availableBaseMaps)`；③ 🔴 **渲染路径必须 `toRaw`**：`drawProvinces / traceShapePath / 小地图` 每帧对 25930 个顶点走 Vue 响应式代理读取，单帧 **94ms**（profiler：响应式 get 27% / traceShapePath 18% / 每帧重画小地图 16%）——改 `rawTerrain()/rawPointsOf()` + 小地图离屏缩略图缓存后单帧 **0.8ms**、平移 20 步 **1906ms → 16ms**；④ **省份网格懒建必须异步**（`scheduleProvinceGrid`，旧实现 `setTool()` 现场栅格化 170~368ms），等待期 `provinceMeshOn` 为 false → 退回多边形渲染，绝不留白；配套 `provinceGridRev` 让「网格就绪」能触发 `provinceMeshOn` 重算（`getProvinceGrid` 不是响应式的）。⚠️ 该文件的 `vx/vy` 读的是 `p.x ?? p[0]`，判「画布有没有内容」不能只看 `nonBg`：**空画布（只有底网格）实测 colors≈46 / nonBg≈328**，有省份时 ≥100/≥600 —— 判据太松会让性能断言量到一个空画布。
