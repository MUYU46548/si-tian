# 司天改进清单（2026-09-24 全库审计 + 修复）

> **本轮已修 18 项**（P0 2 项 / P1 8 项 / P2 4 项 / 文档 1 项 / 死代码 4 个文件）。
> 剩 4 项是**功能缺口**（不是 bug），已单列在末尾待定优先级。
> 回归基线：**75 用例** + 11 个 Node 单测文件（2026-09-27 起；`test_75` 笔记改名断线检测与重连 / `test_74` P0 三条缺口修复 / `test_73` 历史剧本势力标注 / `test_71` 参考图导出几何）。

---

## 一、已修（按严重程度）

### P0 — 会静默丢数据

**1. ✅ 自动保存竞态：`await` 之后回写旧快照，覆盖新编辑并清掉 dirty**
`store/projectStore.js` `saveProject()`
- **修法**：保存前记下「落盘时的项目引用」，`await` 返回后**仅在未被改动时**才确认写入；已改动则保留新态 + 维持 `dirty` + 立刻重排一次保存（返回 `superseded: true`）。
- **影响**：消除「连续编辑时最后一批改动从内存消失且不再落盘」的路径。

**2. ✅ 知识库 watcher 在项目态仍在改画布（两套事实源混流）**
`store/geodata.js` `handleNodeUpdated` / `handleNodeRemoved`
- **修法**：两个 handler 首行判 `canvasSourceRef === 'project'` → 直接 `return false`；`App.vue` 据返回值给状态栏回音（拒绝必须有回音）。
- **影响**：项目态下改 Obsidian 词条不再污染项目画布。

### P1 — 静默失败 / 契约漏洞

**3. ✅ 写闸门契约改为「函数级」（根因修复）**
`store/writeGate.js` + `scripts/tests/cases/test_54_write_gate_and_reparent.py`
- **旧病**：条目录 `marker: 'guardWrite('`，测试只判「**文件里**出现过 `guardWrite(`」→ 一个文件里有一个守卫，整行就算过 → 同文件其余裸奔函数**永远查不出来**（漏报型假绿）。
- **修法**：条目登记到 `fns: [...]`（**8 条 / 53 个函数**）；测试新增 `_function_body()`（括号配对截取函数体，跳过字符串与行注释）逐函数断言 `guardWrite(`/`blocked(`；另断言 `undo.execute()` 的 `guardWrite` **必须在 `.redo()` 之前**。

**4. ✅ `interior.js` 4 处「先改内存 / 裸写」补守卫**
`removeFloor` / `updateFloor` / `removeFurniture` / `updateFurniture`（后者是「先 `Object.assign` 再 execute」）
- 同批修正：文件头注释原写「3 个直接写」与实际不符，改为 7 个写点的准确清单。
- ⚠️ 复核纠错：子 agent 报「13 个函数只有 3 个有守卫」，逐函数读完后确认实际是 **4 处**缺口 —— `addFurniture` / `addFurnitureBatch` / `transferFurnitureBatch` / `endMultiFurnitureCapture` 都已走 `execute()`，不需要单独守卫。

**5. ✅ `InteriorView.vue` 楼层栏只读灰禁**
- `.floor-actions` **不受 `editMode` 控制**（浏览态也要用），原先「+ 楼层」「命名」「删除」在只读态照常可点 —— 配合 #4 就是「点了没反应却改了内存」。现三个按钮均加 `:disabled="store.isReadOnly"` + title 说明。

**6. ✅ `mapDataEditing.js` 26 处「先改内存后 execute」补守卫**
- 覆盖地形多边形 / 区域 / 路线 / 文本标签 / 标记 / 地点簇 / 参考图 / 地图快照 / 地貌笔刷 / 文化 / 控制点，以及 `addMapSnapshot` / `removeMapSnapshot` 两个原本**完全裸写且未登记**的快照函数。

**7. ✅ `scenarioEditing.js` 笔刷补守卫 + `toRaw` + 修埋雷**
- `applyHeightBrush` / `applyBiomeBrush` 是「先改内存后 execute」→ 补函数首行守卫。
- 热循环 `toRaw(grid.points)`（`applyBiomeBrush` 是全量遍历，收益最明显）。
- 🐞 `getHeightAt()` 引用**未定义**的 `pts` → 一旦调用即 `ReferenceError`；已补定义 + 网格存在性防御。

**8. ✅ `geodata.js` `selectBuilding` 懒建容器补守卫**
- **只守懒建那一段** —— 视图导航（`currentBuilding` / `viewLevel`）在只读态必须照常工作（只读 ≠ 看不了）。

**9. ✅ 退出前落盘失败用户看得见**
`App.vue` + `src/main/index.js` + `src/preload/index.js`
- **旧病**：失败只进渲染层 `console.warn`，窗口随即关闭 → 用户以为「已正常退出、改动已保存」。
- **修法**：渲染层把失败清单经 `notifyFlushDone({failed})` 回执 → 主进程用**原生对话框**告知，并提供「留在窗口」出口（数据仍在内存，可导出为文件）。

**10. ✅ 打开项目时「会话基线」失败不再静默**
`src/main/handlers/projectHandler.js` → 返回 `baselineWarning` → `projectStore.adopt` 经 `sitian:project-warning` 事件 → `App.vue` 状态栏。

**11. ✅ 项目态不再谎报「已保存」**
`store/geodata.js`
- `saveScenarios` 项目分支原设 `saveStatus = 'saved'`，实则只是推给 `projectStore`（真实落盘在 800ms 防抖后）。现改设 `'staged'`（已交给项目、等待落盘）。
- `saveGeodata` / `saveMapData` 项目分支返回值补 `staged: true, persisted: false`（不再恒返回 `{success:true}` 让人误判成已写盘）。

**12. ✅ 全局导出在 4 个视图「点了没反应」**
`App.vue`
- `getActiveCanvas()` 只覆盖 `domain/system/system_detail`，`planet/area/interior` 拿到 `null` 就**静默 return**。现：菜单按钮置灰 + `:title` 说明去处（「行星地图与历史剧本请用各自工具栏的导出按钮」）；`handleExportPNG/SVG` 的早退也补状态栏提示（双保险）。
- 文案区分：`导出 SVG (当前视图，位图封装)` + title 注明「非矢量，不能进 Illustrator 二次编辑」。

**13. ✅「导出地图配置 (JSON)」往返丢数据**
`App.vue`
- 导出端原只写 `nodes + hyperlanes`，导入端却读 `mapData / areaZones / interiorData` → 往返即丢。现导出补齐 `mapData / areaZones / areaRoutes / areaMarkers / areaTextLabels / interiorData`（走 `jsonSafeReplacer` 深拷贝），导入端补齐 `areaRoutes / areaMarkers / areaTextLabels` 的读取。

### P2 — 性能与代码健康

**14. ✅ 笔刷热循环读响应式代理** — 见 #7（`applyHeightBrush` / `applyBiomeBrush` 改用 `toRaw`）。

**15. ✅ 修正 `statusKind` 的非法值** — `App.vue` 数据加载失败处曾写 `statusKind = 'error'`（模板只认 `ok`/`err`/`warn`）→ 该提示长期**没有图标**。已改 `'err'`，并给模板补 `warn` 分支（用 `info` 图标）。

**16. ✅ 删除约 1000 行死代码**（严格验证 `import` / `import()` / `require()` 三类引用均零命中后 `git rm`）
| 文件 | 行数 |
|---|---|
| `utils/galaxyDrawing.js` | ~685 |
| `utils/SpatialIndex.js` | 93 |
| `utils/planetHeightMap.js` | 151 |
| `composables/useChangeLog.js` | 70 |

**17. ✅ 文档漂移** — `AGENTS.md` 用例数三处口径统一（60/58 → **65**）、Node 单测数（4 → **6**）；`docs/ARCHITECTURE_MAP.md` 已再生成（167 文件）。

**18. ✅ `AGENTS.md` 事实层补录本轮结论** — 函数级契约的判据与「先改内存后 execute」口径、两条 P0 数据风险、退出落盘可见性。

---

## 二、未修：功能缺口（不是 bug，需要你定优先级）

| # | 缺口 | 证据 |
|---|---|---|
| 19 | **GalaxyMap 提示与实现矛盾**：`:10` 写「拖拽恒星编辑坐标」，但 `:1302-1312` / `:1461-1471` 都不改坐标；`isDraggingMultiple` 从未置 true、`store.beginMultiNodePositionCapture` 无调用方。**能拖的是下层 SystemView** —— 星域总览这一层能力反而更弱 | `GalaxyMap.vue` / `geodata.js:745` |
| 20 | **建筑只有「点」没有「轮廓」**：建筑落点是点节点，无多边形字段，与「区域」多边形是两套结构 → 城镇地图（建筑占地范围）做不了 | `AreaMap.vue:1324` / `:1573-1584` |
| 21 | **历史剧本只在「世界选择页」有入口**：进入任一世界后工具栏无重开入口，必须退回世界选择页 | `WorldSelector.vue:9` → `App.vue:222/1147` |
| 22 | **压力测试无 UI 入口**：只有 `window.runStressTest`，devtools 可达 | `App.vue:1079-1090` |

### 顺带记录（本轮未改，理由见下）
- **`applyHeightBrush` 的 smooth 模式是 O(n²)**（每个命中格再全量扫一遍 `pts`，`scenarioEditing.js:1149-1157`）。已有 `_spatialIndex` 可复用，但**改算法会改变涂抹结果**，须先量化再动 —— 按项目「先量化再改」纪律留待单独一轮。
- **鹰眼小地图（PlanetMap `eagleEyeElements`）仍按 `terrain[]` 多边形绘制**：M2 第二步后主画布地形已改由高度图驱动，小地图仍是色块概览。导航用途无害，但两者表示不一致；若要统一，须避免在第三处再写一份「该画什么」的判定。
- **`legacy` 模式的 4 个落盘入口仍是 `fs.writeFile` 非原子写**（`main/index.js` 的 `save-geodata` / `save-scenarios` / `save-map-data` / `reextract-geodata`）。当前 `READONLY_WITHOUT_PROJECT=true` 使其在生产路径不可达，属代码里的休眠风险。

---

## 三、关于「实质危机」

本轮把能确定的 bug 都修了。如果要在架构层面点出**最接近实质风险**的两条，我认为是：

1. **「测试全绿」这个安全感本身不可靠** —— 本轮所有问题都在 65/65 全绿、Node 单测全过的情况下存在。根因是**判据粒度**：按文件/按子串判，等于给整个文件发永久免检证。#3 已把守卫契约改成函数级，但同类"粒度错"的判据可能还有别处（值得单独做一轮判据审计）。
2. **可维护性天花板** —— `ScenarioMap.vue 4860 行`、`PlanetMap.vue 3816 行`、`AreaMap.vue 2610 行`。这不会立刻出问题，但会持续抬高每次改动的风险与成本。

---

## 四、反复提出但从未实装（2026-09-26 稽核）

起因：暮雨在给「Phase 2 待拍板决策点」定调时说 ——「隔壁方寸等项目都出现**我提过好几次但一直没做**的东西」，
故要求对 §7-1 谨慎处理（不销账）。这一节就是顺着这个担心做的**全仓稽核**：
把开发日志 / ROADMAP / 本清单里**反复出现却始终没有落到代码**的条目捞出来，逐条给当前代码证据。

判据：只要能在两个以上不同时间的记录里找到同一条，且当前代码里查不到实现，就登记。
（证据以 `grep` 可直接复验为准，不采信"我记得做过了"。）

> ⚠️ 2026-09-27 追加的 **R15 / R16 不适用上述判据** —— 它们是核验《机器属性搬家》报告时的新发现，不是「提过没做」，列在同一张表只为统一编号；"提出记录"列已注明来路。

| # | 事项 | 提出记录（时间 × 次数） | 当前代码证据 |
|---|---|---|---|
| R1 | **城镇地图补齐**：建筑轮廓（有面积的多边形）/ 街区·地块 / 按街区批量落位 / 图例 | 2026-09-14 遗留 P1-5（原文标注「用户点名的两条链路」）→ 09-20/21 未做 ×2 → 09-22 未测 | `AreaMap.vue` / `areaEditing.js` 无建筑轮廓字段与实现（`buildingOutline` / `footprint` 零命中），建筑仍是**点节点**。**已做部分**：比例尺 + 指北针（`scaleBarVisible`，默认开）。**缺**：建筑轮廓、街区/地块、批量落位、图例 |
| R2 | **建筑内部补齐**：墙体与房间边界 / 门窗 / 家具尺寸显式编辑 / 导出 PNG | 同 R1（同上 4 次） | `InteriorView.vue` 有楼层 / 家具 / 跨层复制移动 / 旋转 / 网格吸附 / 参考图；**无墙体、无门窗、无尺寸显式编辑、无导出** |
| R3 | **「简化模式」开关**（只进行星地图层级、可逆、不动数据） | 2026-09-22「用户提到是『后续计划』—— 是否本轮就做」；`ROADMAP_NEXT` C8 | **全仓零实现**（`简化模式` / `simpleMode` 无命中） |
| R4 | **退出前落盘真机演练** | 2026-09-20 / 09-21 / 09-22 三次记为「未测」 | 护栏 + 回执链路已实现且有单测；**从未在真机「改完直接关窗」场景演练过** |
| R5 ✅ **已修 2026-09-26** | **书签在 planet / area / interior 静默失效**（另：不按项目隔离 / 上限 20 / 无最近访问） | 修法：`PlanetMap` / `AreaMap` / `InteriorView` 补 `defineExpose({canvas, renderer})` + App 补声明三个模板 ref + `getActiveRenderer()` 覆盖六层；书签新增**锚点实体 id**（跨层先 `focusEntityOnCanvas` 再套相机）；任何不成立的分支都给**状态栏可见原因**（不再裸 `return`）；面板标出「异层」书签。回归 `test_74` f1。**遗留**：C3 的项目隔离 / 上限 / 最近访问未做 |
| R6 ✅ **已修 2026-09-26** | **「导出配置」不可移植** | 导出载荷抽出 `buildMapConfig()` 并补 `parentId` + 全部编辑侧字段（走 `entityExtras`，唯一白名单）；导入端**新建缺失实体**（原来只 `find` 更新坐标 = 换机导入什么都没有却说"已导入"），层级按 `parentId` 复原、形状走 `store.entityToNode()` 单源。回归 `test_74` f2（**真实载荷往返**） |
| R7 ✅ **已修 2026-09-26** | **删除节点不清孤儿数据** | 画布路径 `removeNode` 连带清 `mapData`/`domainBorderOverrides`/`areaZones·Routes·Markers·TextLabels·ReferenceImages`/`interiorData`/`interiorReferenceImages`（容器清单 `ORPHAN_DATA_CONTAINERS` 单源），undo 逐值回灌；项目路径 `deleteEntity` 通过画布适配器新增的 `pruneData`/`mergeData` 清**画布活副本**（只删项目文件会被下一次保存写回）并把清理份数写进回执。回归 `test_74` f3a/f3b |
| R8 | **鹰眼小地图与主画布表示不一致** | 09-24 本清单顺带记录 | `PlanetMap.vue:1323 eagleEyeElements` 仍从 `currentMapData.terrain[]` 取多边形；M2 第二步后主画布已改高度图驱动 |
| R9 | **GalaxyMap 多选拖拽（提示与实现矛盾）** | 09-24 本清单缺口 19 | `isDraggingMultiple` 有声明、被读（`:1342` / `:1430`），但**全仓无 `= true` 赋值** → 分支永不进入；`:10` 的提示文案仍在承诺「拖拽恒星编辑坐标」 |
| R10 | **历史剧本进入世界后没有重开入口** | 09-24 本清单缺口 21 | `open-scenarios` 只由 `WorldSelector` 发出（`App.vue:228`），世界内（domain/system/…）无入口 |
| R11 | **压力测试无 UI 入口** | 09-24 本清单缺口 22 | 只有 `window.runStressTest`（`App.vue:1317`） |
| R12 | **搜索不覆盖地图对象** | `ROADMAP_NEXT` C1 | 已补 `scenario-label` / `scenario-marker` 两类；仍缺：行星地形多边形名 / 区域名 / 浮动文本 / 地点簇 / 内部家具 |
| R13 | **`applyHeightBrush` smooth 模式 O(n²)** | 09-24 顺带记录 | 未动（`_spatialIndex` 已可复用）—— 改算法会改变涂抹结果，须先量化 |
| R14 | **`legacy` 4 个落盘入口非原子写** | 09-24 顺带记录 | 未动（`READONLY_WITHOUT_PROJECT=true` 使其在生产路径不可达，属休眠风险） |
| R15 ✅ **已修 2026-09-27** | **笔记改名无断线检测**（认亲钥匙＝`sourcePath`） | 病根：项目态下知识库 add/unlink 事件被整条拦掉（防事实源混流）→ 改名静默。修法：`utils/vaultRelink.js`（判定 + 打分唯一实现）→ 主进程只读通道 `list-vault-notes`（复用提取器 `listScannedNotes`，口径单源）→ `projectStore.scanBrokenLinks` / `relinkEntity`（**id 不变**，目标被占用则拒绝并点名）→ 项目面板「检查笔记改名」（给可读理由，不静默）。回归 `test_75` + Node 单测 `test_vault_relink.js`；反向验证 4 枚一枚一验 |
| R16 | **文档对实现的假承诺：`SITIAN_VAULT_SPEC.md` 曾写「UUID 稳定标识，重命名后关联保留」** | 2026-09-27 同批发现 | 原 `SITIAN_VAULT_SPEC.md:237-239`，与 R15 的实测**正好相反** —— 这类「文档替实现撒谎」比没有文档更坏（无 LLM 架构下所有聪明必须显式且真实）。**已按实况改写并注明原句为假承诺**；「文档必须说实话」已列入 `ROADMAP_NEXT` D8 |

### 稽核结论（比清单本身重要）

这 14 条的**共同点不是"忘了"**：它们各自都被如实记录过，一条没丢。
真正的原因是 **它们都不在任何一个里程碑的主线上** ——
每轮的验收锚点都是当前主线（`A1 → A2 → M3 → A8`），而 R1~R14 全部被标成「顺带记录」或「P2 收尾」，
于是**没有任何一轮的"完成"定义包含它们**，主线一推进就自然被推到下一轮。

→ 对策不是「更努力地记住」，而是**给它们挂上属于某一轮的验收**：
每条要么指定轮次，要么明确写下"本轮接受不做"（并留触发条件）。
只登记、不挂验收的条目，一定会一直躺在这里。
**2026-09-26 首次照此执行**：P0 三条（R5/R6/R7）被明确挂进本轮验收并已落地 —— 见下方「P0 三条的落地记录」。

**2026-09-27 追加 R15 / R16** —— 这两条性质与 R1~R14 不同：不是「提过没做」，而是核验《机器属性搬家》报告时**新发现**的静默缺陷（R15）与文档不实（R16）。
R15 已挂进 `ROADMAP_NEXT` 线 A 的 **A-0**（带验收锚点与反向探针），R16 已当场改写。
→ 顺便印证同一结论：**R15 能长期存在，恰恰因为没有任何一轮的验收包含「改名之后还能找回原节点」这件事**。

### 建议优先级（2026-09-26）

- **P0（并入下一轮，都是小改 + 静默失败类）**：~~R5 书签三层限制 · R6 导出配置补 `parentId` 且导入端新建缺失实体 · R7 删除节点清孤儿数据~~ → ✅ **三条已于 2026-09-26 落地**（回归 `test_74`，五枚反向探针一枚一验）
- **P1（战略主线，见 `ROADMAP_NEXT`）**：**线 A 数据入口**（~~A-0 断线检测~~ ✅ / ~~A-1 迁移工具~~ ✅ / ~~A-2 读路径切换~~ ✅ → **A-3 中文点选糙版**；2026-09-27 定案）→ **线 B**（A4a 一键重算派生 → A3 文化/宗教笔刷 → Tiled JSON 互通，D1 已定 v2）
  → 🔴 2026-09-27 实测（ROSA 缓存模拟导入后项目）：搬家务实可做 = **待补 0 / 已一致 304 / 冲突 0**（导入即搬家），真空白 = `parentId` **9** / `placeType` **45** → **A-3 才是真正填洞的那件**
- **P1.5**：~~R15 断线检测（＝ A-0 本体）~~ ✅ **已完成 2026-09-27**（`test_75`，4 枚反向探针一枚一验）· R16 文档假承诺（已改写）
- **P2（暮雨点名的两条链路，工作量大）**：R1 城镇地图 · R2 建筑内部
- **P3（低成本顺手）**：R3 · R8 · R9 · R10 · R11 · R12 · R13 · R14（R4 是一次人工演练，随时可做）

### P0 三条的落地记录（2026-09-26）

| 条目 | 关键改动 | 反向验证（各一枚、互不掩盖） |
|---|---|---|
| R5 | 三层视图 `defineExpose` + App 声明 ref + 六层 `getActiveRenderer` + 书签锚点 + 全部出口有可见回音 | 探针 P1（行星层 renderer 置 null）→ 3 条具名失败 |
| R6 | `buildMapConfig()` 抽出 + `parentId` + `entityExtras` 全字段 + 导入端新建实体（`entityToNode` 单源） | 探针 P2（导出 parentId 恒 null）→ 先被 f0 守卫抓到；**并因此发现测试漏洞**：原断言只查「键存在」+ 导入用的是**手写配置** → 改为「取真值 + 真实载荷往返」后才真正闭合 |
| R7 | 画布 `removeNode` 连带清 + `ORPHAN_DATA_CONTAINERS` 单源；项目 `deleteEntity` 经画布适配器 `pruneData`/`mergeData` 清活副本并回执份数 | 探针 P3（画布不清）→ 2 条；P4a（项目只暂存不删）→ 1 条；P4b（只清不还）→ 1 条。**互补半边分开装**：P4a/P4b 各自只亮自己那条 |

**本轮新增的两条方法论**（都值得复用）：
1. **「有键就算过」是假断言。** `hasOwnProperty('parentId')` 在 `parentId: null` 时照样为真 —— 凡是「字段必须带上」的断言，必须**断言取值**，最好直接把**真实导出载荷**喂回导入端做往返（手写夹具会替被测代码圆谎）。
2. **两条删除路径不要共用一份夹具。** 串在一起时，前一段的 `removeNode`/`undo` 会经防抖保存把中间态推给项目，后一段的 `descendantsOf` 拿到的是被改过的父子关系 → 红的是测试自己。

---

## 五、2026-10-06 追加（审「历史剧本能不能真用」时抓到的）

### S1 ✅ 已修｜剧本「隐式载入」会用知识库缓存覆盖项目数据（回归 `test_84`）

| 项 | 内容 |
|---|---|
| 症状 | 每次启动后**第一次点「历史剧本」**，项目里那份剧本与底图被**静默回退**到知识库缓存的版本（用户改过的 `ownership` / `changeEvents` / 势力谱系 / 标注 / 标记、画过的省份、涂过的地形全没了） |
| 病根 | `App.enterScenarioMode()` 无条件 `loadScenarios()`（读**知识库缓存**）→ `importFromScenariosJson()` → `applyScenarioState(data, {fresh:false})` 的**默认合并是「新值赢」**；项目态下画布事实源是项目文件，于是同名条目被整体替换，随后 `saveScenarios()` 把覆盖结果推给项目并落盘 |
| 为什么一直没被发现 | **三个条件同时成立才触发**：① 项目态；② 库里有同名剧本/底图；③ 用户已经在司天里改过。测试 harness 的 `loadScenarios` mock 返回**空**结构 → CDP 层永远复现不出来（真实库里 12 个王朝剧本，一撞就中） |
| 修法 | 装载口新增第三种显式语义 `fillMissingOnly`（内存已有优先、只补缺）；隐式载入必须传它；「同 key 覆盖」留给**显式**动作（工具栏「导入剧本数据（合并：同 key 覆盖）」）。配套：`changed` 回报 → 无事可补时**不排保存**（不白写盘/不刷备份轮转）；补缺语义**不碰切片点** |
| 反向验证 | `test_84` f1 直接断言「项目剧本/底图的 marker 与对象引用都没变 + 库里独有的剧本被补进来 + 读了库 1 次（防空转）」；f2 断言显式导入**仍是**覆盖（防止两种语义被合并成一种）；f3 断言无事可补时 `changed=false` 且引用不变 |

### S2 ⚠️ 未做完｜回归基线的 fixture 专名耦合（`--real-data` 还不是全绿闸门）

第一次拿**真实知识库**跑全量回归：**46/83**。逐条看下来，失败几乎全部是同一族 ——
测试写死了**合成 fixture 的专名**，而真实库没有这些名字：

| 写死的专名 | 位置 | 影响用例 |
|---|---|---|
| `曜川星`（行星） | `lib/helpers.py#goto_planet` 默认参数 | ~22 个（`no-planet`） |
| `曜川星系` | `test_10/11/12/15/17` | 5 个（`no-sys`） |
| `归岚星域` | `test_13` | 1 个 |
| `沧屿` | `test_03` | 1 个 |
| `叠翠原 / 拾光小筑 / 缄默工坊` | `test_22` | 1 个 |

- ✅ **已修 `goto_planet`**：先按名字找（**合成数据路径逐字不变**），找不到再按结构兜底
  （自底向上找四层链路贯通的行星）。
- ⚠️ **其余仍在**：`test_03 / test_10 / test_11 / test_12 / test_13 / test_15 / test_17 / test_22`。
  **所以 `--real-data` 目前只能做定向体检（真实数据能不能加载 + 剧本链能不能跑），不能当"全绿"闸门。**
- **纪律（新用例必须遵守）**：取节点一律按 `layer` / 父子结构找，**不许写死专名**。
- 顺带确认的好消息：真实库 **120 节点**（4 世界 / 8 星域 / 18 星系 / 9 行星 / 69 设施…）**结构完整、加载正常**；
  且 **18 个剧本/省份类用例在真实数据上全部通过**（`test_41~44 / 52 / 61~65 / 68 / 73 / 77~82`）。

---

## 六、2026-10-06 追加（B：真实数据失败逐条定性；C：退出前落盘真机演练）

### B｜`--real-data` 的 19 个失败**全部定性完毕：没有一个是产品缺陷**

第一次拿真实知识库跑全量回归时是 46/83；修掉 `goto_planet` 的专名耦合后复跑 **65/84**。
把剩下 19 条逐条查完，结论如下（**分类判据可复验**：对每条用例 grep 下表里的专名）：

| 类别 | 条数 | 用例 | 说明 |
|---|---|---|---|
| **写死合成 fixture 专名** | **17** | `test_03 / 06 / 10 / 11 / 12 / 13 / 15 / 17 / 18 / 21 / 22 / 24 / 31 / 32 / 34 / 35 / 50` | 最常见的是**把地图 key 写成 `曜川星`**（`window.__probe.lastMapPayload('曜川星')`）—— 真实库那颗行星叫 `乐园星`，于是 `n:0` 被读成"没有触发项目文件落盘"。其余是 `曜川星系` / `归岚星域` / `沧屿` / `叠翠原·拾光小筑·缄默工坊`（wikilinks）。**合成 fixture 是真实结构的换名克隆**（同为 120 节点 / 4 世界 / 8 星域 / 18 星系 / 9 行星 / 69 设施），所以专名一换，这些断言全部失准 |
| **断言用浮点精确相等** | 1 | `test_67` | `s2 === s0` 判「撤销复原高度图」；真实数据下两次求和都打印 `601810.3`（差在小数点后第 5 位以下）。代码上 `applyHeightBrush` 的撤销走**快照回填**（`oldH = new Float32Array(hm.h)`），按说应逐位相同 —— 所以要么断言过严、要么中间有一条路径把 `h` 重算过。**未分辨**（要分辨需一枚逐元素探针）。⚠️ 刻意**不**加容差：本仓其它地方的标准是「逐像素/逐值复原」，放宽会掩盖真问题 |
| **几何假设（节点必能居中）** | 1 | `test_66` | `focusOn` 把探针节点放中心 ±80 设备像素内；实测 `dx=107`。真实行星那颗节点多半靠边 → 相机夹住，居中不成立。属"fixture 合成几何恰好允许" |

**结论**：`--real-data` 目前**不是全绿闸门**。要让它成为闸门，要么逐条去除专名耦合（17 个文件），
要么在 harness 里做一次「真实数据主链改名成 fixture 规范名」的映射。**都不是本轮该顺手做的**。

### C｜退出前落盘真机演练（R4）—— 已从"人工演练"变成一条命令

新增 **`scripts/tests/drill_quit_flush.py`**：起**真实 Electron（dist 产物 + 真实 preload +
真实知识库 + 真实项目文件）**，用**纯 UI 操作**制造「改完立刻退出」，然后**读盘**核对。
三阶段（P1 与 P2 互为反面）：
· **P1 负向探针（强杀）** → 磁盘**不该**有改动；它证明的是「P2 的成功不是假象」（防抖窗口是真的）。
· **P2 正向（Ctrl+Q）** → 进程正常退出后，磁盘**必须**有改动。
· **P3 点 × 关窗**（本机 `closeQuitsApp=false`）→ 验证「最小化到托盘而非退出」。

| # | 结果 | 内容 |
|---|---|---|
| **T1** ✅ **已修** | **托盘提示永远不弹** | `main/index.js:107` 的 `if (tray)` 里 `tray` 是**未声明标识符**（`tray` 是 `tray.js` 的模块私有变量，`index.js` 只解构了 4 个函数）→ **每次点 × 都抛 `ReferenceError`（主进程 uncaughtException）**，「已最小化到托盘 · Ctrl+Q 彻底关闭」的气泡**永远不弹**。而托盘是用户唯一能把窗口找回来的入口 —— 提示失灵 = 用户以为程序把自己关了。修法：`tray.js` 补 `getTray()`，`index.js` 改用 `getTray()` |
| **T2** 🔴 **未定位** | **真机上保存链一次都没跑通** | 点「导入知识库内容」后**连续 12 秒**：项目文件仍是 367 字节空壳、`.sitian.backups/` 无任何新增、会话基线 mtime 不动。**已排除**：不是设置（`localStorage` 里根本没有 `sitian-settings`，即用默认 `autoSave:true`）、不是漏排保存（`importFromVault` 的 redo 闭包确实调了 `scheduleAutoSave()`）、`AUTO_SAVE_DELAY=800` ✓。**根因未定位** —— 生产构建里 `__vue_app__._instance` 是 `null`（Vue 只在 `__DEV__\|PROD_DEVTOOLS` 分支赋值），读不到 `dirty` / `saveStatus` / `lastError`。下一步：用 dev 构建复现并读 store 三者。**旁证**：暮雨那个项目文件自 9-20 起一直是 367 字节空壳 —— 与「导入过但从未落盘」吻合 |
| **T3** ⚠️ 未通过 | P2 / P3 阶段 | 因 T2（没有改动可落盘）而不成立；另有 P2 的 Ctrl+Q 在渲染层忙时未被处理（40s 后进程仍在）—— 成因未定（候选：CDP 键注入在渲染层忙时被丢） |

**演练脚本踩过的四个环境坑**（都写进注释了，避免下次重踩）：
① `ELECTRON_RUN_AS_NODE=1`（受管终端预设）会让 `electron.exe` 退化成纯 node → `app` 未定义、CDP 永不起；
② 本机 GPU 进程反复 `0xC0000005` 崩 → `FATAL: GPU process isn't usable` 直接带走应用 → 要 `--disable-gpu --disable-software-rasterizer --in-process-gpu`；
③ Chromium 111+ 拒绝带 Origin 的 DevTools WebSocket 握手 → 403 → `websocket.create_connection(..., suppress_origin=True)`；
④ **残留实例会抢走 CDP 端口**，下一次 `wait_cdp` 连上的是**上一轮的旧实例**（页面里还留着上轮状态）→ 必须按端口精确定位进程再杀（`taskkill /T` 依赖父子链，中间层一死就杀不到孙子进程）。

---

*§六 追加：企鹅 · 2026-10-06 · B 可用 `grep` 复验，C 可用 `python scripts/tests/drill_quit_flush.py` 复现*

---

*§五 追加：企鹅 · 2026-10-06 · 症状可用 `test_84` 与 `python scripts/tests/run_tests.py --real-data` 复现*

---

*审计 + 修复：企鹅 · 2026-09-24 · 每条改动均带证据路径，可 `git diff` 复验*
*§四 稽核追加：企鹅 · 2026-09-26 · 证据均为 `grep` 可直接复验的代码位置*
