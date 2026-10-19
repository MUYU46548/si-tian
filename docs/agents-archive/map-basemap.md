# 底图与导入导出（AGENTS.md 历史条目归档）

> 由 `AGENTS.md` 的「架构速查 / 开发陷阱」按主题拆出（2026-10-19），**原文一字未改**。
> 这里只放**历史**（当时改了什么、踩了什么坑、判据是什么）；当下口径以代码 + 回归用例为准。
> 新增知识请写回 `AGENTS.md` 的速查或**本文件**的对应主题，不要另开新文档。

- **M3/A7：参考底图的导出几何（2026-09-25）**: 新增 **`utils/svgExport.js` 的 `refImageSvgGroup(r)` / `refImageWorldBounds(r)`** —— 参考图 → SVG 组 与 世界包围盒的**唯一实现**，`useFullMapExport`（行星全图）与 `useScenarioExport`（剧本）两处共用。此前两处各写一份，实测有**四处**错，第一处让整段成为**死代码**：① 读 `referenceImage.referenceImage` —— 那是 computed **ref 对象**（不是值），`.width` 恒为 undefined → 分支永不进入，**参考图从来没有被导出过**（不报错，只是导出图与画布不一致）；② 只取「当前激活的一张」，而画布画的是**全部**（P2 多图之后导出没跟上）；③ 把 `rotation`（**象限索引 0/1/2/3**；画布用 `% 4` 再乘 90°）当弧度换算 `* 180 / Math.PI` → 转 1 次导出成 57°；④ 漏 `flipH` 与 90/270 的**宽高互换**。画布侧约定（AreaMap / InteriorView / PlanetMap 三处本来就一致且正确）：`rot = (rotation || 0) % 4` → `rotate(rot * π/2)`；`drawW = rot%2 ? h : w`；`flipH` 在 `rotate` **之后**镜像（顺序不能换）；90/270 交换绘制宽高是为了**保持用户校准好的占位框**。导出算边界也必须用**旋转后**的包围盒，否则旋转过的底图会被裁掉一角。回归 **`test_71`**（源码守卫「两处共用 + 不许再读 ref 对象 / 不许再把象限当弧度，**判据先剥注释**」+ 纯函数四值 + 端到端 SVG 几何：单图/多图/翻转/包围盒）。⚠️ 反向验证 3 枚探针命中 **10 项**，f1/f2 两段各自说话

- **🔴 行星视图的 `.map` 导入 + 保存诚实（2026-10-17 第六轮；回归 `test_115` + Node `test_save_status_text.js` / `test_planet_map_bundle.js`）**：
  - **起步闭环**：`.map` 导入此前**只有剧本视图**一条路（装进底图 `baseMaps[key]`），行星图看的是 `mapData[planetId]`（**另一个容器**）→ 空行星上想用自己的 Azgaar 地图起步，界面上做不到；而高度笔刷还提示「先导入 Azgaar .map」，指向一个**行星视图里不存在的入口**。现在：空态卡片里两个**真按钮**（`planet-import-map` / `planet-empty-draw`）+ 高度面板一个入口（`planet-import-map-height`）；落库走**新写口** `store.importPlanetMapBundle`（`mapDataEditing`，只覆盖 `PLANET_IMPORT_KEYS` 那 8 个键 —— **区域 / 标记 / 文本 / 地点簇 / 参考图 / 快照一律不动**，一整次导入 = **一条撤销**；源里没有高度图就**不删**现有高度图），已登记 `MEMORY_WRITE_CALLSITES`（test_54 反向校验也查）。
  - **共用件（防"两份实现"）**：`utils/mapImportSource.js`（文件名→底图名 / 原文留底 / 读文本）＝ 行星与剧本的**唯一**实现；`utils/planetMapBundle.js`（纯函数映射）+ `buildAzgaarReferenceLayers`（**`scenarioEditing.importPlanetLayerData` 也改用它** —— 参考图层的 id 口径只许一份）。
  - 🔴 **映射的三条硬口径**（写错都不报错，只会"导入了看不见"）：① 河流落 **`nodes`**（行星 `drawRivers` 读 nodes）、道路落 **`points`**；② 高度图**必须补齐四通道** h/temp/prec/biome —— 只给 `h` 会被 `ensureHeightmap` 判成派生层损坏，把文件里的温度/降水**静默换成估值**；③ 解析器的省份在 **`terrain`** 键（`provinces` 是 `importPlanetLayerData` 那条路的入参名），键名弄错 → 参考图层出空数组、「政治/文化」按钮点了没反应。
  - **保存诚实**：`utils/saveStatusText.js`（`describeSaveAction` / `resolveSaveDisplay`）+ `composables/useSaveDisplay.js` ＝ 保存文案**唯一实现**，供 剧本保存 chip、行星保存横幅、**底部常驻状态栏** 三处共用。判据：`persisted === true` 才说「已保存到磁盘」；`staged` 只说「已交给项目，正在写入磁盘…」（**warn 色，不是绿标**）；`projectStore` 把 `dirty` 同步进状态栏（`setSavePending`）→「有改动待写入磁盘…」不会再被上一枚绿标盖住。
  - 🔴 **顺带修掉一个真缺陷**：行星「保存地图」原来写 `snapshotPanel.saveStatusTimer.value = setTimeout(...)`，而该字段在 `useSnapshotPanel` 里是普通 `let`（composable 返回时已快照成 `null`）→ **每次点保存都抛 TypeError**，被 `.catch()` 接住显示「保存失败」（**即使其实成功了**）；更糟的是这个异常把"项目态只是 staged"的真问题一起盖住。现在横幅计时器是组件自己的 `bannerTimer` + `setBanner()`。
  - ⚠️ 写这类用例的两个坑（本轮都踩了）：① 一条 eval 里串太多等待会撞 **CDP 15s 读超时**（症状是「Connection timed out」而不是某条断言红）→ 拆成多段 + Python 侧 `wait_for`；② `eval_json` 要求返回对象**必须有 `fails` 字段**，非断言探针也要带 `fails: []`（否则本身就是"假绿闸门"在报错）。
  - **出图（`scripts/tests/tools/_shot_planet_20261017.py`，产物 `docs/assets/planet-20261017/`）**：真实 `desite.map` 走产品导入链（真按钮 + 真 `File`），五张图 = 空态 / 导入后 / 多边形覆盖 / staged 横幅 / persisted 横幅。⚠️ 两条出图纪律：① **别在渲染器背后直接改 `mapData`** —— 会留下旧像素（脏矩形局部重绘不重画未标记区域；实测逐层关图层、逐个摘绘制函数都摘不掉它，只有让组件重挂载才干净）；② 截图**连拍两张只留第二张**（headless 下第一张常是旧帧）。

- **🔴 底图编辑模式（2026-10-18 第十七修；回归 `test_120` + 随动 `test_65`/`test_97`/`test_61`）**：
  暮雨原话「我甚至觉得这玩意得进底图编辑，**底图编辑要单开一个编辑模式**，不要和日常的剧本编辑混在一起」。
  修前：主行是日常动作（选择/画省份/改归属/改形状/更多），而「更多」里**同时**装着地理类
  （河流/自动河流/道路/地貌/地名/标记/聚落/文化/宗教/高度/群系/裁到海岸线/着色档）与省份批量
  （拆分/合并/点击填充/描轮廓/Voronoi/删除）——**编辑对象不同却在同一排按钮里**，这就是"混"。
  - 落地：`basemapEditMode` + 顶部**模式条**（`data-testid="toolbar-modes"`，含 `basemap-edit-toggle`
    与一句模式文案）+ 开模式后出现 `basemap-row`（`data-testid="basemap-row"`，10 个地理工具，
    清单单源 `BASEMAP_TOOLS`，按钮带 `data-testid="basemap-tool-<id>"`）。
  - 🔴 **零迁移的关键**：`setTool()` 里有门 —— **选到地理类工具自动开模式**（`BASEMAP_TOOL_IDS.has(t)`）。
    既有 60+ 个直接 `setTool('river')` 的用例一字不改；切回省份类工具**不自动关**。
    口径**只是分组与可见性**，不改工具语义（模式不是锁，锁起来只会制造"点了没反应"）。
  - 🔴 **两个被守卫教回来的坑**：① 模式开关**不能放主行** —— `test_65`/`test_97` 硬守"主行可见控件 ≤6"，
    放进去实测 7 个、两条同时红；现在它是**主行之上的模式条**（语义也更对：模式是状态不是工具），
    并把 `test_65` 口径明确为"**排除模式条**之后 ≤6"（注释写明理由）。
    ② **开模式不许顺带展开「更多」**（出图实测）：`setTool → toggleBasemapEditMode()`（内含 `moreOpen = true`）
    会让"切一下工具"展开 42vh 面板、画布高度骤变，**把 `test_61` 的画布内容判空判红**；
    而"只有人手动点才展开"也不行 —— 手动点开关时工具栏实测从 **~120px 撑到 ~470px**（画布被压一半，
    `docs/assets/basemap-mode-20261018/` 前后两张图可见）。**现在开模式顺手收起「更多」**
    （地理工具已在模式行里，进阶开关想用再点开），判据在 `test_120` c 段：开模式后「更多」**不许**展开。
  - 判据 `test_120`（6 段）：默认无地理行 / 开关往返 / **直接 `setTool('river')` 必须自动开模式且行出现**
    （零迁移）/ 日常工具可用且不关模式 / 收尾回日常。

- **~~⏳ 待拍板：底图编辑单开一个模式~~（已被第十七修取代，见上方「底图编辑模式」条目）**：
  （留一行指针，免得有人照着旧条目去"等拍板"）
  - **① 历史剧本不再是"盖在顶上的大图层"**：`<scenario-map>` 旧条件只有 `scenarioMode && !scenarioPickerVisible`
    —— 只管"在不在剧本域"，**不管当前看的是哪一层**。用户在编辑器里双击导航树的行星 →
    `jumpToNode` → `store.selectPlanet()` 把 `viewLevel` 改成 planet 而 `scenarioMode` 仍 true ⇒
    **ScenarioMap 不卸 + PlanetMap 同时挂载**（两者都 `height:100%`、同在 `.main-content`、
    模板里 ScenarioMap 在前）⇒ 行星地图看得见 0 像素、点不到一下（用户：「点导航栏双击几遍都出不来」）。
    修法：`scenarioEditorVisible = scenarioMode && !scenarioPickerVisible && viewLevel === 'world'`
    （**第一层 world 才是编辑器该出现的唯一层级**）+ `scenarioSteppedOut` 回程浮标
    （`data-testid="scenario-return-chip"`，**必须左下角**：居中会压住画布正下方的缩放/平移控件，
    实测 `elementFromPoint` 当场点到浮标 —— 与"盖住行星地图"是同一类缺陷）。
    判据 `test_118`：`elementFromPoint(画布中心)` 修前命中 ScenarioMap 的 canvas、修后命中 PlanetMap 的 canvas；
    反向验证 6 条具名红。⚠️ **卡片墙穿帮（Teleport + fixed 全屏）本轮实测已修好**，无可复现残留。
  - **② 手画河"放大成发丝/空心铁轨"的真因＝宽度被除了两次缩放**：`drawOneHandRiver` 传
    `toPx: (w) => px(w)`（`px(w) = w / cameraScale`），而画布在该处**已经** `scale(cameraScale)`。
    实测（`scripts/tests/tools/_probe_rail_widths.py`，真实 desite 底图）水色像素 1×/2×/4×/8×/16×
    = **6/6/6/6/8**（把 `river.width` 放大 10 倍：6/6/8，纹丝不动）—— 屏幕宽度与缩放完全无关。
    修法两处：`toPx` 改**恒等**（宽度＝世界单位）+ `riverWidthsFor` 的屏幕下限**封顶**
    （`RIVER_MIN_SCREEN_CAP_PX = 12`，世界硬下限 `RIVER_WORLD_FLOOR = 0.4` ——
    ⚠️ **数值刻意避开 `test_73` 守卫的那个字面量，连注释里都别写出它**）；
    `riverRender.drawCurvedRiver` 的岸线宽度**与水宽挂钩**（`water + min(bankPx, max(0.4, water*0.45))`）
    —— 老写法 `water + bankPx` 里 `bankPx` 是屏幕常量，放大后那 1.1px 就是"两边各一条轨道"。
    修后 16× 水色 **8 → 66px**（描边设备像素上界 134.5 = 8.4 世界单位 × 16）。
  - **③ 支流可画了**：Shift + 在河身上拖出去 → 起点**吸附到河身**、记母河、落库时**在母河上插拐点**
    （支流口与干流共享同一坐标）。🔴 **为什么必须给 Shift 这个无歧义触发**：节点命中容差 24 屏幕像素，
    河又细 ⇒ **几乎整条河**都落在"节点"容差里，老顺序"节点优先"意味着**支流永远起不了笔**
    （实测症状：状态栏显示「已移动第 10 个节点」而河身没动）。手势优先级＝顺序即语义：
    ① Shift+河身→支流 ② 选中河的节点→拖动微调（既有能力一字不改）③ 河身（离节点远）→也当支流 ④ 空白→新河。
  - **④ 「交叉怪物」结构性拦下**：松手时三道闸门（**丢弃 + 明说原因**，绝不静默吞掉用户的笔迹）：
    穿回母河（交点 ≥2）／自交（打结）／横切（同一侧出去又绕回同一侧 ⇒ 同一条河被穿 ≥2 次）。
    🔴 **这道闸门的口径迭代了三次，每次都被真实用例教回来**（别走回头路）：
    ① "与任何已有河 ≥2 交点就拒" → 把搭桥/正当交汇也拒了（`test_95` 红）；
    ② "同一条河 ≥2 交点才拒" → 仍误伤"穿过两条河各一次"的同一形状（`test_95` 又红）；
    ③ "交点 ≥2 **且** 笔迹首尾在该河**同侧**" → ✅（真穿过去首尾必然异侧）。
    另两个判据坑：**笔迹点数要够**（否则先撞"太短已丢弃"，回执里没有"交叉"字样 = 假红）；
    **别强绑"回执具体是哪句话"**（那是措辞判据，不是行为判据）。
  - **⑤ 测这类改动的两条硬纪律（本轮各踩一次）**：
    ① **改完源码必须硬重载页面**（`cdp.navigate('…?bust=<ts>')`）—— Vite 的 HMR 是就地换模块，
    `<script setup>` 里**已经闭包捕获的旧函数**仍指向旧实现；不重载时"改了三处、量出来的数字一位不动"；
    ② **探针 JS 里 `const st = document.querySelector('#app')…` 会让 V8 当私有字段报
    `Private field '#app' must be declared`** —— 一律套一层括号 `const st = (…)`。
  - 判据：`test_118`（5 段）+ `test_119`（11 段）；反向验证：把 `<scenario-map>` 退回旧条件 → 6 条具名红；
    把 `toPx` 退回 `px(w)` → 2 条具名红。
  - ⚠️ **本轮明确没做**（别以为做完了）：用户问的"那一条白色的是什么玩意"（最可能是选中态高亮的暖白光晕
    `rgba(255,244,200,0.30)`，**未在真机确认**）；支流的孤儿子河语义（删母河之后）；
    "加河 + 改母河"合成**一条 undo**（现在两条）；星域编辑贴边整合/卡顿；行星地图空图误判/一键清空色块/选中文字描边。

- **🔴 底图数据（高度图/河流/道路）的「只补缺刷新」+ 忙时遮罩与取消（2026-10-11；回归 `test_94` 5 段 / `test_95` 4 段）**: 傍晚一轮反馈拆出来的四条，全部有实测证据，**不是设想**：
  - **根因：地图上没有地形，不是显示问题、也不是"数据丢了"** —— 暮雨的剧本底图 `desite` **建自 2026-09-10**（`d07c1d1`），而**当时那版解析器的返回对象只有 `terrain / polities / ownership / labels / markers`**（`git show d07c1d1:...azgaar-parser.js` 实测），高度图/河流/道路/城镇**根本没被读出来**（具备网格能力是 `1c2a4d2`）；因此这张底图的 `baseMaps.desite` 到今天仍然只有 `id/name/terrain/referenceImages/createdAt/updatedAt/provinceLabels`。而**今天的解析器完全读得出**：同一份 `docs/mockups/desite.map` 实测 **9975 格高度（98 种取值）/ 160 条河流 / 496 条道路 / 617 个城镇**。项目文件里"乐园星"那份高度图确实是平板（**22074/26910 格 = 20、3829 格 = 30、量程 15..100**），但**它与这张底图无关**（`desite` 没有绑定任何行星）。
  - 🔴 **两条路必须分开，混用 = 毁数据**：`.map` 导入走的 `applyScenarioState` 是「**同 key 整体替换**」→ 拿它去"补高度图"会把用户已切好的**几百块省份 + 归属 + 易主记录一起盖掉**。因此新增 `scenarioEditing.updateBaseMapData(key, bundle, opts)`：**只补缺**（已有的字段一律不覆盖）、**绝不动 `terrain` / `provinceLabels` / `planetId`**、一整次刷新 = **一条 undo**、返回 `{added, skipped, kept, blocked, message}` 如实交代。配套 `buildBaseMapFromBundle` 给"新底图"用（两者分开，判据 test_94 d 段）。🔴 **绑定了行星的底图拒绝写底图侧高度图**（高度图的家在行星侧，A1/M1b）→ 返回 `blocked[{reason:'basemap-bound-to-planet'}]` 并指路「跟随 / 冻结导入」，**不是静默不写**。
  - **UI**：底图那一组在缺数据时出现「刷新底图数据」按钮（`data-testid="basemap-refresh-data"`，`basemapDataMissing` 计算缺项）；`triggerMapImport` 遇到同名底图**不再静默替换**，改为「只补缺刷新」确认框。⚠️ 手册示例专名一律虚构（`绒花计划/德斯特星/瓯王朝` 已换成「示例世界/示例大陆/示例王朝」，`test_user_guide.js` 用**黑名单**守，同 test_86 性质）。
  - 🔴 **批量铺底的让出方式错了**（真实症状：「提示已切出 415 块，实际在 414 卡很久」「到处乱点更卡」）：旧实现 `await new Promise(r => setTimeout(r, 0))` **只把控制权交回定时器队列，浏览器不保证插进一次渲染** → 进度提示形同不动。现在是 `yieldToPaint()`（`requestAnimationFrame`，语义就是"等下一帧"）+ 忙时**画布遮罩**（吃掉指针事件：卡住期间点的每一下都会排队、回来一起执行）+ **取消**（`token = {cancelled}`，在每个帧让出点检查；取消**不落库、不压 undo**）。默认 `yieldEvery` 6 → 4（真实底图单块布尔 ~38ms ⇒ 约 150ms 让出一次）。
  - 🔴 **手画的水路原来根本不落盘**（三条独立缺陷，test_95 守）：① `finishRiverDraft` 只把路径 push 进**组件本地数组** `riverPaths`（全仓无人写 store）→ 重开应用河就没了；② 手画道路直接 `store.baseMaps = {...}` 手搓替换 → **既不在撤销栈、也不排自动保存**（只能碰巧赶上别的保存），还绕过只读闸门；③ 聚落编辑同款（`Object.assign` 直改 store 活对象 → 撤销把新值当旧值）。现在 store 侧补 `addBaseMapRiver / removeBaseMapRiver / addBaseMapRoute / removeBaseMapRoute / updateBaseMapBurg`（全部 `guardWrite` + `execute` + `saveScenarios`，删除的撤销 **splice 回原位** = 渲染层叠顺序；找不到 id 给 `{ok:false, rejected:'not-found', message}` 而不静默），组件侧一律改走 store。`drawRiverPaths` 改读 `baseMap.rivers` 里 id 前缀 `river_` 的那些（**不再有第二条事实源**；`test_95` 红线：组件里出现 `riverPaths` 或 `store.baseMaps = {` 即红）。
  - 🔴 **两个"高度图判据"必须分清 —— 混用会出真事故（2026-10-11，`test_96` 抓到）**：
    · `heightmapAccess.hasGrid(hm)` = **"能否开始用笔刷编辑"**（只要有网格点即可）。⚠️ **不许把它收紧成"必须有 h"** —— 本轮试过、被全量回归打回：既有 fixture（`test_39`/`test_67`/`test_68`）用的是**只有网格点、没有 `h` 的历史高度图**，收紧后 `resolveHeightmap` 返回 null → 笔刷 / 派生 / 绑定全线 `Cannot read properties of null (reading 'h')`。这条教训已写成 Node 单测里的**反向纪律**（`test_heightmap_channels.js`）。
    · `terrainRepresentation.hasHeightmapContent(hm)` = **"有没有地形内容"**（点与 `h` 都要有）→ **状态栏与"缺什么"诊断必须用这个**。
    · 事故形态：解析器读不到 `cells.h` 时造出 `{ grid:{points:[…]}, h:[] }` 这种**空壳高度图**，而状态栏用的是"有点就算"，于是把空壳报成「4 网格」→ 用户看到纯色扁平图、状态栏却说"有网格"，只能去找一个**根本不存在的显示开关**（正是暮雨那次困惑的形态）。
    · 已修：`layerAvailability.cells` 改走 `hasHeightmapContent`（空壳报 0）；`describeBaseMapMissing` / `basemapDataMissing` 同口径；`azgaar-parser.buildScenariosJson` 与 `buildBaseMapFromBundle` 在**没有高度值时干脆不写 `heightmap` 键**（宁可不给，也不要一个会被误判成"有"的空壳）。
    · ⚠️ 写测试数据时两个坑：① `h` 是**顶层**字段 —— `{ grid: { points: [[x,y],…] }, h: [高度,…] }`（本用例首版把 `h` 写进 `grid` 里，"实现坏了"的假象骗了我两轮）；② 两格相距 1 世界单位在间距 14.4 下算**退化**，`buildHeightmapRaster` 会返回 null（**这是保护，不是 bug**），自造数据要用正常坐标（如 0 与 100）。

- **🔴 原始底图来源备份 + 补注册一条从未生效的 IPC（0.2.8，2026-10-11）**: 起因是暮雨的一句话 ——「这反映出另一个问题：司天自身没办法备份用户的原始底图文件」。**他说得对，而且已经造成过真实损失**：`desite` 底图建于 2026-09-10（当时解析器读不出高度图/河流/道路），等到想补时，唯一来源是**他自己还留着的那份 `.map` 导出**；司天此前**只备份自己的项目文件**（`<名>.sitian.backups/` 轮转 10 份 + 会话基线），**从不留用户导入的 `.map`** —— 那份一丢，地形/河流/道路永久无法恢复（只能去生成器重做一张，而新图的海岸线与现有几百块省份边界并不一致）。
  - **做法**：`projectHandler.saveBaseMapSource(projectPath, { name, text })` → 写到 `<项目>.sitian.backups/basemap-sources/<清洗后的名字>.map`。**原样字节**（它是"再次导入/刷新"的唯一凭据，改了就不是凭据）、**原子写**（`.tmp-<ts>` → rename）、**轮转保留 10 份**、`sanitizeFileName` 清洗（不产生目录层级）。`listBaseMapSources()` 供 UI 列"能从哪几份恢复"。IPC：`basemap-source-save` / `basemap-source-list` / **只读** `project-current-path`（主进程侧权威回答当前项目路径 —— 这样 `ScenarioMap` 不必为拿一个路径去 import projectStore）。
  - 🔴 **轮转必须按 mtime、不能按文件名**：首版用 `.sort()` 按名字排，于是**刚写进去的 `reverse.map` 因字母序靠前被当成"最旧"删掉**（单测 e3 当场抓到 ENOENT：刚留的底还没用就没了）。文件名与写入先后**没有任何关系**。为此单测加了 **c1b 反证**（名字序与写入序完全相反）。
  - 🔴 **顺手抓出一条从未生效的 IPC**：`project-git-snapshot`。`gitSnapshot()` 函数存在且已导出、preload 也一直暴露 `projectGitSnapshot`、`ProjectPanel.vue:707` 的「司天快照」按钮在调它 —— **但该 IPC 通道从未注册**，真机上点它必然抛 `No handler registered for 'project-git-snapshot'`。CDP 用例里 `window.sitianAPI` 是 mock，这层**永远看不见**；而 `test_project_io` 的"通道白名单"断言写的是"这个通道在不在 expected 列表里"、**不是"它有没有被注册"** → 漏注册一直假绿。本轮补注册，并新增**通用**守卫：**preload 里 `ipcRenderer.invoke` 的通道，主进程必须有 `ipcMain.handle`**（实测 54 invoke ↔ 56 handle 全部对齐；加在 `test_main_module_wiring.js`）。
  - ⚠️ 组件侧三条纪律：备份在**解析之前**做（解析失败也该留下素材）；**备份失败绝不阻断导入**（只在状态栏留一句 —— 数据安全功能不该变成新的失败点）；**只读态也备份**（不改世界观数据，只是留素材）。
  - 一次性修复脚本 `scripts/maint/repair_basemap_data.py`：照 `diag_t2_save.py` 的安全模式（跑前把项目与 `.map` 各复制一份到 `backups/repair-basemap-<ts>/`、真机 Electron + CDP 驱动**与按钮同一个 store 接口**、跑完显式 `saveProject()` 并等磁盘 mtime 变化、无论成败都杀自己拉起的进程并还原 `config.json`）。**实测效果（暮雨的真实项目）**：省份 415 → **415（未动）**；高度图 0 → **9975 格**；河流 0 → **160**；道路 0 → **496**；城镇 0 → **617**；海岸线重建只改了 **4** 个省（411 个内陆省逐点未动，漂移 −0.01% —— 说明那批省的沿海边界本来就贴着海岸线）。
    - ⚠️ 该脚本首版把 `ROOT` 数错一层（在 `scripts/` 下照抄了 `scripts/tests/` 的三层写法）→ 报"找不到原始导出"；挪到 `scripts/maint/` 后必须回到三层。**改动它的位置时先重数那一行。**
    - ⚠️ 顺手证实一件要说准的事：**"解析后的数据"其实一直有救**（它已经进了项目文件，而项目文件本身有 10 份轮转 + 会话基线）；缺的**只是那份原始 `.map`**。对用户要分清这两层，否则会夸大风险。
  - **`test_46` 的通道对齐改成"按前缀族"而不是"全集相等"**：它原写 `invoke('(project-[^']+)')` 再与主进程 handler 全集判相等 → 主进程只要注册任何非 `project-` 前缀通道（本轮的 `basemap-source-*`）就必然假红。现在按前缀族分别对齐（族内仍要集合相等，那才是"漏注册/漏暴露"的判据），下限守卫只看 `project-*` 数量。`test_project_io` 的 `expected` 白名单是**故意**的（逼人登记新通道），加通道时要一起改。
  - **`.map` 导入必须当场说清结果（同上，`test_96` 守）**：解析器早就把「未解析到 cells.h（高度图不可用）」收进 `warnings`，但导入路径一个字都不报（只有一个要悬停才看见的小徽章）。现在导入完成即回报：省份/河流/道路条数、**"这份 .map 里就没有地形高度图 → 所以是纯色扁平图，这不是显示开关的问题"**、以及"这张底图还缺什么（可用「刷新底图数据」从另一份 .map 补）"。⚠️ 读回音要认准 `provinceHint`（`statusMsg()` 的落点）；`statusText` 是工具条上那句**摘要** computed，两者不是一回事（首版读错 → 断言与现场无关）。
  - ⚠️ **已知未做（如实登记）**：`desite` 的旧边界只有 21 个点（`features` 退化轮廓），补齐高度图后**海岸线与地形不会自动对齐** —— 现在有第三条路了：用「重建省份外环」把新 .map 的海岸线换上去（**不必**重导为新底图、不作废省份），见下面「折线切割一次切多块 + 海岸线重建」条。「描轮廓 + 相邻省自动重算」**已做**（`Y` 键，回归 `test_97`）。

- **P0/P1 编辑器模块**（2026-09-15 落地，全部有回归用例 test_28~test_35）: `utils/labelStyles.js`（标签样式预设 + `drawStyledLabel` 统一文本渲染）、`utils/reliefIcons.js`（地貌图标确定性散布 + 网格桶）、`utils/markerTypes.js`（标记类型注册表）、`utils/settlement.js`（人口对数滑块/分级/半径）、`utils/roadStyles.js`（道路样式）、`utils/rivers.js`（河流流向排序/拖拽 clamp）、`utils/viewport.js`（视口世界矩形，小地图遮罩用）；`composables/useReliefBrush.js`
