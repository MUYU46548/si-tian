# 视图层（AGENTS.md 历史条目归档）

> 由 `AGENTS.md` 的「架构速查 / 开发陷阱」按主题拆出（2026-10-19），**原文一字未改**。
> 这里只放**历史**（当时改了什么、踩了什么坑、判据是什么）；当下口径以代码 + 回归用例为准。
> 新增知识请写回 `AGENTS.md` 的速查或**本文件**的对应主题，不要另开新文档。

- **🔴 星系/星域视图的四个表现层 bug + 颜色拼 alpha 的静默缺陷（2026-10-18 第十修；回归 `test_116` + Node `test_color_util.js`）**：
  - **① 坐标拖拽曾是死代码**：提示文案写着「拖拽恒星编辑坐标」，但 `GalaxyMap.onDragStart` **从不返回** `{mode:'node'}` →
    `onDragMove/onDragEnd` 里那两条分支不可达、`isDraggingMultiple` 恒 false（**文案承诺了不存在的能力**）。
    修法照 `SystemView` 的既有形态补「拖手 / 移动」两个浏览态工具（`data-testid="galaxy-move-tool"`，默认拖手防误触），
    `move` 下拖恒星 → `store.beginNodePositionCapture` + `{mode:'node'}` → `onDragMove` 写 `updateNodePosition` →
    `endNodePositionCapture()`（置 `userMoved` + 一条 undo）；多选（>1 选中）走 `beginMultiNodePositionCapture`。
    🔴 **拖拽把 coordinate 设成"它画在的地方 + 位移"** —— 自动布局的恒星画在**布局坐标**上，与旧 coordinate 不同
    （实测 (737,31) vs 画出来的 (95.5,-600.4)）；判据必须**先快照** `galaxyNodes` 里的 x/y（拖拽会就地改它，
    拿它当基准会得出 Δ≡0 的假红 —— 本轮踩过）。
  - **② 势力改色既不重绘也不落库**：`setFactionColor` 只写组件局部 ref、键还用 `domain.faction`（真实库该值
    `undefined` → 所有星域共用一个键「undefined」= 改一个色改全部）。现在：`resolveDomainColor(domain)`
    （override（**按 domain.id**）→ 节点 `factionColor` → 名字哈希）是**唯一取色口**，布局/边界/图例三处共用；
    `input` 走 `previewFactionColor`（改内存 + **`applyStableLayout()`** + `requestRender()`，不落库），
    `change` 走 `commitFactionColor`（`store.updateNode(id, {factionColor})` = 有闸门 + 一条 undo，被
    `entityExtras()` 带进项目文件）。⚠️ **两句缺一不可**：只重绘不重排 = "画布变了颜色还是旧的"（渲染恒星读布局副本）；
    只重排不重绘 = "拖了色板没反应"。判据分两条（预览后**布局快照**必须是新色 + 像素确实变），
    且**快照要在 `input` 之后、`change` 之前读**（change 自己会重排，读晚了永远绿）。
  - **③ 星域在编辑模式下不可命中**：`hitTest` 只返回 `galaxy`/`domain-label`/`boundary-vertex`，而 `domain-label`
    被 `!editMode` 门控 → 编辑模式星域"看得见点不到"，`type === 'domain'` 的四处消费（锁定/选中/右键目标/删除菜单项）
    全是死代码。现在编辑模式补「点落在势力边界多边形内 → `{type:'domain'}`」（`pointInPolygon` 射线法）。
  - **④ 右键不看 editMode**：`GalaxyMap.onContextMenu` 与 `SystemView.onContextMenu` 首行补
    `if (!editMode.value) return;`（照抄 `SystemDetailView.vue` 的既有闸门 —— **那一层早就修好了**，
    文档若把"6 个 bug"整体挂在星系模块，对 system_detail 是**过期描述**）。判据必须用**真实 `contextmenu`**。
  - 🔴 **顺带修掉一条静默颜色缺陷（`utils/colorUtil.js` = 唯一实现）**：星域边界写着 `border.color + '12'`
    （8 位 hex 拼 alpha）—— 只对 6 位 hex 成立；而 `getFactionColor()` 对**不在硬编码表里的势力名**返回 `hsl(...)`
    → `hsl(210, 70%, 60%)12` 是**非法 CSS**，赋给 `fillStyle`/`addColorStop` 被**静默忽略**（沿用上一个颜色 = 颜色串了，
    不报错）。真实库的势力名必然不在表里 → 必然走到。现在一律 `withAlpha(color, '12')`（也吃小数）；`InteriorView`
    的 `color + '33'` 一并改走它。Node `test_color_util.js` 8 条（含"拼接对 hsl 必须非法"的反向探针）。
  - **本轮没做（据实说）**：**星域位置持久化**（`applyStableLayout` 星域永远按 index 环形现算，既不读也不写
    `star_domain.coordinate`；要 `userMoved` 语义 + 旧数据迁移，属数据层）、**导出 PNG(全图) 与画布同源**
    （`App.vue` 有第三套实现：坐标源/势力配色/凸包扩张/星云全不一样；`当前视图` 的两条导出是同源的）、
    **`faction` 真写入路径**（只有表现层的 `factionColor`；提取器/建笔记/迁移都没有 `faction`）。
    另发现三处**未登记的写口**：`GalaxyMap.setBorderPoints`（直写 `store.domainBorderOverrides`）、
    `geodata.removeHyperlane` / `updateHyperlane`（先改内存后 execute 且**首行无 `guardWrite`**）—— 与 `test_54` 的
    「函数级契约」同类缺口，留给下一轮。

- **🔴 星域位置持久化 + `faction` 写入路径 + 三处未登记写口（2026-10-18 第十一修；回归 `test_116` 扩到 7 段）**：
  - **星域位置持久化（上一轮 6 bug 的第 3 条）**：`applyStableLayout` 里星域原先**永远**按 index 环形现算
    （`radius:350` 硬编码），既不读也不写 `star_domain.coordinate`。现在：
    `(domain.userMoved || domain.id === draggingDomainId) && 有限 coordinate` 才采信。
    🔴 **`userMoved` 这道门是安全阀**：提取器给**每个**星域都写了 `coordinate`（实测 fixture **8/8** 都有）
    那是"文件夹扫描时的遗留值"、从没人摆过 —— 无条件采信会让**老项目一次性全部错位**（判据：初始布局
    必须仍在环形上、且不等于遗留坐标）。`draggingDomainId` 是拖动期预览开关（拖动中还没写 `userMoved`）。
  - **星域拖动接通**：移动工具下 `domain`（编辑态多边形命中）与 **`domain-label`（浏览态的名称标签 = 真正的手柄，
    鼠标落在域中心命中的就是它）** 都能拖；拖动写 `coordinate`，松手 `endNodePositionCapture()` 置 `userMoved`（一条 undo）；
    拖动中 `applyStableLayout()` → **该星域下未手动摆过的恒星跟着走**（整簇移动）。
  - 🔴 **`userMoved` 必须一起进 undo/redo**（`geodata.js` 的 `endNodePositionCapture` / `endMultiNodePositionCapture`）：
    原先它写在命令**外面** —— 撤销只还原坐标、`userMoved` 仍是 true → **撤销后节点瞬移到那个从没显示过的遗留坐标**
    （拖动一个从未摆过的节点时最明显）。判据：一次 undo 后坐标回旧值 + `userMoved` 回旧值 + 重排回环形。
  - **`faction` 写入路径（表现层这一半）**：此前**一个写口都没有**（提取器不产、建笔记不写、store 无 setter）
    → `getFactionColor()` 恒走 `!faction → '#6b5b95'`，图例/画布/鹰眼/全图导出**全是同一个色**。现在图例里
    每个星域有一个 `legend-faction-input`（占位「势力名」）：`change` → `commitFaction` → `store.updateNode(id, { faction })`
    （有闸门 + **一条 undo**；同值 = 空操作不压栈）→ 配色经 `resolveDomainColor` 自动按名字分开（实测 `#6b5b95 → hsl(125,70%,60%)`，
    画布 17655 像素变化）。`faction` 不在 `ENTITY_SHAPE_KEYS` 白名单 → 随 `entityExtras()` 进项目文件（不动 schema）。
    ⚠️ 提取器读 frontmatter / 迁移 / 势力系统本身**仍未做**（见交接文档）。
  - **三处未登记写口补齐**（`test_54` 的函数级契约同类缺口）：`geodata.removeHyperlane` / `updateHyperlane`
    加函数首行 `guardWrite`（都是"先改内存后 execute"）；新增 `geodata.setDomainBorderPoints` ＝
    **星域势力边界覆盖点的唯一写口**（组件原先直写 `store.domainBorderOverrides[id]`，无闸门无 undo →
    只读态拖顶点会**静默改内存**）。`{ preview: true }` = 拖动期的起始快照（过闸门但**不压栈**，
    否则"拖一个顶点"会变成两条撤销）；提交才 `execute`（一条 undo）。三者都登记进 `MEMORY_WRITE_CALLSITES`（id 10/11）。
  - ⚠️ **已知毛边（据实说，未改）**：撤销一次移动后，**自动布局**的节点要等下一次重排才回到原位
    （组件没有 watch 撤销栈；数据是对的，只是画面滞后到下次布局）。写用例时若要拿布局位置当基线，
    **必须先 `applyStableLayout()` 规范化**，否则会拿到上次拖动留下的陈旧位置（本轮踩过这条假红）。

- **🔴 导出 PNG(全图) 与画布同源（2026-10-18 第十二修；回归 `test_117` + Node `test_galaxy_layout.js` 14 条）**：
  上一轮交接里 ④ 的**最后一条**（也是 6 个 bug 里唯一剩下的那个）：`App.vue#handleExportFullPNG` 是**第三套实现**，
  与画布各写一份，**五处不一致且一条都不报错**：
  - **① 坐标源**：导出读 `node.coordinate`，画布读布局坐标 → 自动布局的星系在导出里跑到"没人摆过的旧坐标"上；
    更糟：**没有 coordinate 的节点被整块跳过**（`if (n.coordinate?.x === null) return;`）→ 导出图缺节点。
  - **② 势力配色**：导出按名字哈希 `hsl()`，画布按 `resolveDomainColor()`（节点 `factionColor` 优先）。
  - **③ 恒星颜色**：导出固定 `#ffd700`，画布用势力的 `factionColor`。
  - **④ 凸包**：外扩 25 vs 50；星系数 < 3 时导出**直接 `continue`**（星域凭空消失）。
  - **⑤ 航道配色**：导出 3 类、画布 4 类（丢"用户建的绿"）。
  **修法**：新增 **`utils/galaxyLayout.js`（纯函数，唯一实现）** —— `FACTION_COLORS` / `getFactionColor` /
  `resolveDomainColor` / `GALAXY_LAYOUT`（spacing 700、ring 0.9、galaxyBaseDist 100、step 60、angleOffset 0.3、
  **hullPad 50**、circleSegments 12）/ `convexHull` / `expandHull` / `layoutDomains` / `layoutGalaxies` /
  `factionBorders` / `hyperlaneColor`（4 类）/ `nodeRadius` / `nodeColor` / `STARFIELD`（星云谱，世界坐标固定）。
  **画布（GalaxyMap）与导出（App.vue）都只调它**；`App.vue` 的 `convexHullForExport` / `getDomainColorForExport` /
  本地 `getNodeColor` 与写死的星云常量、`GalaxyMap` 的本地 `convexHull` / `getBorderPoints` **全部删除**。
  - 🔴 **导出图幅必须把布局位置算进去**：环上的星域在 `coordinate` 之外，只按 coordinate 取 bbox 会把它裁掉。
  - ⚠️ **据实说的边界**：更深的层（planet / city / town / location）**不在星系视图的布局里**，仍按自己的
    `coordinate` 画；背景星云只是"取同一条谱"（画布按世界坐标铺、导出按图幅裁），**不是逐像素同源** —— 这两条写进交接文档。
  - **判据**（`test_117`）：**在导出期间插桩 `CanvasRenderingContext2D.prototype.arc`**，把记录到的节点圆心与
    "用同一份共享函数算出来的期望位置"**逐点比对**（实测 108/108 全中；星域在 `(0,-630)` 环上、星系在 `(95.5,-600.4)` 簇内）；
    再把导出的 PNG 抓下来做像素检查（**`#ffd700` 必须为 0**、星系色像素 > 0）。Node `test_galaxy_layout.js` 14 条守函数口径
    （含两条反向口径：遗留坐标不许采信、星系数 < 3 不许消失）。
  - **反向验证**：把导出临时改回"按 coordinate 画 + 星系固定金色" → **6 条具名红**
    （「星域画在了遗留 coordinate (737,131) 上 —— 与画布不同源」「星系画在了自己的旧 coordinate 上」
    「导出图里还有 8752 个 #ffd700 像素」）。
  - ⚠️ 写这类用例的两个坑（本轮都踩了）：① **导出菜单默认不挂载**（`panelsStore.isOpen('export')`），
    要先点工具栏「导出」按钮，且**点完等一拍**再查 DOM（Vue 异步）；② 导出是"同步绘制 + 异步 toBlob"，
    图很大（本用例 **5468×5518**）→ 回调要好几百毫秒，**必须轮询等产物**（否则下一段拿不到 blob）。

- **大文件警告**: **ScenarioMap.vue ≈5356 行（全仓最大，2026-09-23 起）**，PlanetMap.vue 约 3943 行（22 个 composables 的装配体），AreaMap / GalaxyMap / InteriorView / NodeDetailPanel / SettingsPanel 均 >1500 行——**读片段勿整读**。行星图绘制与交互逻辑在 `composables/planetDrawing.js`、`planetInteractions.js`、`planetHitTest.js`

- **区域勾轮廓管线（Phase 2.6，2026-09-20）**: `utils/regionTrace.js`（纯函数 + 离屏 canvas 光栅化）= 勾完轮廓落库前的统一关口：**闭环保形简化**（`simplifyClosedTrace`，RDP 旋转到「离质心最远点」当锚点，容差 = span 的 2%~5% —— **固定 eps 在世界单位下什么都削不掉**：行星图 1px ≈ 3~5 世界单位，实测 eps=2 时 200 点只降到 111 点，改成 span 比例后 200→16）+ **离屏光栅校验**（`validateRegionTrace` → `traceStats`：把轮廓与「可绘制范围 / 兄弟区域」各填一张掩膜逐像素求交，算 `insideRatio` / `overlapRatio`）。**判定顺序 = 先重叠、后范围**（重叠 > 5% 拒绝并点名 + 带百分比；范围外 < 50% 拒绝），两个拒绝都只写状态栏**不动数据**。接线：PlanetMap 区域模式的自由绘制 + 点击描点两条落库路径、AreaMap 区域拖拽 + 笔刷两条路径。⚠️ 三条设计约束：① 「落地内」只在行星**显式设了地图边界**（`canvasSizePreset > 0`）时才硬判，`auto` 下边界随内容增长（没有「画到范围外」这回事）→ `containers` 传空 = 跳过，**宁可不判也不误拒**；② 自由绘制 `simplify: true`，点击描点 / 笔刷 `simplify: false`（顶点是用户刻意摆的，RDP 会削掉有意画的细节）；③ 真实数据里 `mapData[planet].terrain` 是**稀疏小块**（44 块 / 769 点，不是一整块大陆），既有「区域 1」只有 7% 落在 terrain 内 → **绝不能拿 terrain 当可绘制范围**，否则把用户正常画的区域全拒了。回归用例 test_51

- **画布的 px() 与渲染护栏（2026-09-20，ScenarioMap）**: 任何「屏幕像素长度 → 世界单位」的换算必须走 `px(v) = v / Math.max(cameraScale.value, 0.02)`（`MIN_CAMERA_SCALE = 0.02`）——**禁止裸 `N / cameraScale.value`**（48 处已改；`screenToWorld` 的两处除法必须保留原样，坐标变换要真实 scale）。裸除法在窗口矮/窄时可算出**负** `cameraScale` → 绘制半径变负 → Canvas 抛 `IndexSizeError`，而**一次 render 异常会拖死整页交互（实测连坐 12 个用例 CDP 超时）**。`render()` 已拆成「护栏壳 + `renderFrame()`」：异常 → 首帧报告一次 → 连续 3 帧仍失败 → `renderPaused = true`（此后直接 return）+ 状态栏「渲染已暂停：<msg> + 继续渲染」。回归守卫 test_52（源码零裸除法、负 scale 不崩）与 test_53（注入异常被捕获 → 3 帧后暂停 → 可恢复）

- **🔴 画布淡化与「状态改了画布不重绘」的坑（2026-09-24）**: 淡化只覆盖**实体节点**（不是地图对象），5 个视图 7 个绘制入口 —— GalaxyMap `drawGalaxyNodes`（含低 LOD 分支）/ SystemView `drawSystemStar`+`drawSystemPlanets` / SystemDetailView `drawStar`+`drawPlanets` / PlanetMap `planetDrawing.drawPlaces` / AreaMap `drawNodes`。约定：`FADED_ALPHA = 0.45`（「看得出退后、仍读得清」）；**`focused`（选中/悬停/匹配/拖拽中）优先于淡化** —— 「编辑优先于装饰」；`save`/`restore` **必须成对**（GalaxyMap 的 lod 分支有中途 `return`，必须在那里先 restore，save:restore = 1:2，由单测文本计数守住）。⚠️ **根因坑**：`geodata#updateNode` 是 `Object.assign(node, updates)` **就地改字段** → 不换数组引用、不换节点对象 → 所有基于引用的浅 watch 捕捉不到 status 变化；而 GalaxyMap/SystemView/SystemDetailView 画的是**布局副本**（`{...node, x, y}`），连 store 改过都读不到。解法：store 暴露单调递增的 `statusRevision`，`updateNode` 在 **undo 与 redo 两处都递增**（漏了 = 撤销后淡化不还原）；各画布 watch 它，**持有副本的视图必须重建副本**，只 `requestRender` 会一直画旧状态。

- **星系 3D 观景（2026-10-28，`REMAINING_BACKLOG_20261027.md` §1 交付）**: `SystemDetailView` 头部「3D 观景」→ `components/System3DView.vue`（异步组件，`v-if` 卸载即全量 dispose）。三层分工：`utils/system3dScene.js`（纯函数适配：节点 → `{star, bodies[{orbit,size,classId,phase,moons,ring}]}`，**无 DOM/无 three**，Node 单测守）+ `utils/planetArt.js`（18 类程序化纹理，源自 SP-1025 `planetArt.ts`，把 `core/prng` 换成本文件内的 mulberry32）+ 组件（three 场景与生命周期）。three 钉 **0.128.0**（SP-1025 同版本，0.16x 灯光模型会漂观感），只在 `onMounted` 里 `await import('three')`。
  - 🔴 **PascalCase 标签**：模板写 `<system-3d-view>` 会被 camelize 成 `System3dView`（小写 d），与 `System3DView` 绑定对不上 → 编译器 `resolveComponent` 找不到组件、动态 import 被摇掉，**构建产物里连 three chunk 都不生成**（首屏"看起来"很干净，功能整块消失）。必须写 `<System3DView>`；Node 单测 b1 同时禁掉 kebab 写法。
  - 🔴 **three 的 `info.memory` 只在渲染时记账**：构景刚结束读到 0/0，验收会误判"没分配"。每帧 `render()` 后同步一次；关闭时先 `traverse` + 逐个 `dispose()`，再读 `info.memory`（判据 = geometries/textures 都 0），最后 `renderer.dispose()` + `forceContextLoss()`。
  - 🔴 **卫星挂错父节点**：卫星 pivot 若挂到行星 `mesh` 上，会跟着**行星自转**一起转（mesh 每帧 `rotation.y += …`）。正确层级是 `pivot(公转) → holder(行星在轨道上的位置) → mesh(自转) / 卫星 / 环`。
  - **取景要算透视放大**：初始相机距离按 `maxOrbit / tan(hFov/2)` 反算后再 **×1.28** —— 盘面靠近相机的一侧被透视放大，余量只留 1.04 时最外圈轨道左右与底部同时出画（第一版截图即如此）。
  - **dev 必须预打包**：`vite.config.js` 的 `optimizeDeps.include` 加 `three` 与 `three/examples/jsm/controls/OrbitControls.js`，否则首次点开 3D 时 Vite 才发现新依赖 → 整页 reload → 3D 刚挂上就闪回 2D。
  - **低配口径**：AA 关 / 无阴影 / `SphereGeometry(…,24,16)` / `MeshLambertMaterial` / 像素比封顶 1.5 / `OrbitControls` 阻尼且禁平移；`P` 暂停公转、`Esc` 关闭、`visibilitychange` 停 rAF；标签用 DOM 投影（省一份 Sprite 纹理，中文更清楚）。
  - **构建产物（2026-10-28 实测）**：`three.module-*.js` 601.28 kB（gzip 153.61 kB）+ `OrbitControls-*.js` 11.2 kB + `System3DView-*.js` 10.2 kB，三者**都不在首屏**（`index-*.js` 里搜不到 `WebGLRenderer`）。
  - **判据**：`test_163_system_3d.py`（进单系 → 点开 → canvas/frames/labels 出现 → Esc 与按钮各关 3 次，共 6 轮，每轮 `memoryAtDispose` 的 geometries/textures 都是 0、页面 canvas 数回到 1）+ `unit/test_system3d_scene.js` 12 条（确定性/轨道单调/卫星挂靠/类别映射/空系/上限/源码闸门）。2D 恢复用截图逐像素比对：除工具栏一处按钮态外**完全一致**（`build/visual-audit/system3d/`）。
  - **没做**：行星点击下钻（3D 只读观景）、多恒星系同屏、纹理分辨率提升；`planetArt.js` 的纹理缓存常驻内存（跨开关复用，不在 dispose 里清 —— 清了下次要重画）。
