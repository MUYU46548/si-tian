# 司天改进清单（2026-09-24 全库审计 + 修复）

> **本轮已修 18 项**（P0 2 项 / P1 8 项 / P2 4 项 / 文档 1 项 / 死代码 4 个文件）。
> 剩 4 项是**功能缺口**（不是 bug），已单列在末尾待定优先级。
> 回归基线：**73 用例** + 10 个 Node 单测文件（2026-09-26 起；`test_73` 历史剧本势力标注 / `test_71` 参考图导出几何 / `test_72` 滚轮契约）。

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

*审计 + 修复：企鹅 · 2026-09-24 · 每条改动均带证据路径，可 `git diff` 复验*
