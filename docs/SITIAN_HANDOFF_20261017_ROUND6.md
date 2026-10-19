# 司天：第六轮（行星视图 `.map` 导入 + 保存诚实）2026-10-17

> 上一轮：`docs/SITIAN_HANDOFF_20261017_ROUND5.md`（河流编辑三件）。
> 暮雨这一轮仍是那句「**继续帮我做剩下内容**」，等的还是「历史剧本模块收口后单独给一份可操作验收指南」。
> 本轮做的是交接文档 §5 里排在最前、且都**有硬判据**的两件：**1**（行星视图 `.map` 导入入口收进空态）、**2**（保存诚实显示）。

---

## 0. 先说结论

| 事项 | 事实 | 判据 |
|---|---|---|
| ① 行星视图此前**根本没有** `.map` 导入路径 | `.map` 只进**剧本底图**（`baseMaps[key]`），而行星图读的是 `mapData[planetId]`（另一个容器）；高度笔刷却提示「先导入 Azgaar .map」——**指向一个不存在的入口** | `test_115` f0 源码闸门 + f1 端到端 |
| ② 行星「保存地图」会**谎报**或**误报** | 项目态 `saveMapData` 返回 `{success:true, staged:true, persisted:false}`（只交给了项目、还没进磁盘），旧代码按 `result.success` 报「保存成功」；更糟：横幅计时器写的是 `snapshotPanel.saveStatusTimer.value`，而那字段是普通 `let`（返回时已快照成 `null`）→ **每次点保存都抛 TypeError**，落进 `.catch()` 显示「保存失败」——**即使其实成功了** | `test_115` f4 |
| ③ 状态栏看不出「改了但还没落盘」 | 只有 `saveState`（某次保存尝试的结果），没有 `dirty`；上一枚绿标会一直挂着 | Node `test_save_status_text.js` + `test_115` f4 |

---

## 1. 行星视图的 `.map` 导入（起步闭环）

**入口（三个，同一个函数）**：
- 空态卡片主按钮 `planet-import-map`（「导入 .map 底图」）+ 副按钮 `planet-empty-draw`（「从零开始画」）；
- 高度笔刷面板 `planet-import-map-height`（`无高度图数据` 那句话就出现在这条工具链上，提示必须指向**看得见**的入口）。

**落库**：新写口 `store.importPlanetMapBundle(planetId, bundle)`（`mapDataEditing.js`）——
- 只覆盖 `PLANET_IMPORT_KEYS` 那 **8 个键**（terrain / rivers / routes / heightmap / azgaar×4）；
- **区域 / 标记 / 文本 / 地点簇 / 参考图 / 快照 / 地貌图标 / 涂色网格一律不动**（`test_115` f1b/f3 断言）；
- 一整次导入 = **一条撤销**（`test_115` f2：省份 2 → 撤销 → 0，高度图同时回到 `null`）；
- 源里**没有高度图**就**不删**现有高度图（不能因为导一份旧文件把用户涂好的地形删掉）；
- 已登记 `writeGate.js` 的 `MEMORY_WRITE_CALLSITES`（`test_54` 反向校验也查）。

**共用件（防"两份实现"）**：
- `utils/mapImportSource.js`：`mapNameFromFileName` / `backupMapSourceFile` / `readMapSourceText` —— 行星与剧本**唯一**实现（剧本侧原来的本地 `backupMapSourceFile` 已删）。两处各写一份的代价不是报错，而是「只有一边留了原文 / 只有一边剥掉日期后缀」。
- `utils/planetMapBundle.js`：解析产物 → 行星容器的**纯函数映射**（Node 单测 `test_planet_map_bundle.js` 19 条）+ `buildAzgaarReferenceLayers`（`scenarioEditing.importPlanetLayerData` 也改用它）。

**三条映射硬口径（写错都不报错）**：
1. 河流落 **`nodes`**（行星 `drawRivers` 读 nodes）、道路落 **`points`**；
2. 高度图**必须补齐四通道** h/temp/prec/biome —— 只给 `h` 会被 `ensureHeightmap` 判成派生层损坏，把文件里的温度/降水**静默换成估值**；
3. 解析器的省份在 **`terrain`** 键（`provinces` 是 `importPlanetLayerData` 的入参名）—— 键名弄错 → 参考图层空数组、「政治/文化」按钮点了没反应。这条是 Node 单测 `d1b` 抓出来的（首版就是这样错的）。

**回执**（导入完当场说清，不静默）：
`已导入「case115」到本行星：省份 2 块、河流 1 条、道路 0 条、高度图 有；原始 .map 已留底（…）；
城镇 N 个未导入（行星地图没有城镇图层，去剧本底图看）；（这是**本行星自己的**地图数据；
历史剧本侧要用同一份 .map，请在那边也导入一次 ——两个容器各存一份，互不覆盖）`

⚠️ **两个容器各存一份**是现状（`mapData` ↔ `baseMaps` 的双向同步是已知未完成项），所以回执必须这么说，
不能让用户以为"导一次两边都有"。

---

## 2. 保存诚实（staged / persisted）

**唯一实现**：
- `utils/saveStatusText.js`（纯函数）：`describeSaveAction(result)` + `resolveSaveDisplay({project, canvas})`；
- `composables/useSaveDisplay.js`：把 geodata 的两段保存链（`saveStatus` / `lastSaveError`）与 projectStore 的
  `saveState` / **`savePending`（= dirty）** 合成一句；供 **剧本保存 chip / 行星保存横幅 / 底部常驻状态栏** 三处共用。

**判据（优先级从重到轻）**：项目落盘失败 > 画布侧失败 > 正在写入磁盘 / 正在交给项目 >
**有改动待写入磁盘（dirty）** > 已交给项目待写入 > 已保存到磁盘 > 空闲。
文案：`persisted` 才说「已保存到磁盘」；`staged` 只说「已交给项目，正在写入磁盘…」（**warn 色**）；
失败**把原因写进文字**（暮雨上次的原话：「保存失败就是保存失败，我没看到其他内容」）。

**配套改动**：
- `projectStore` 跟随 `dirty` 写 `setSavePending`、跟随 `lastSavedAt` 写 `setSavedAt`（状态栏 chip 的 title 用）；
- `ScenarioMap` 不再自己写 `saveDisplay` computed（改 `useSaveDisplay()`），加 `staged` 样式与图标；
- `StatusBar` 改走 `useSaveDisplay()`，`data-testid="save-state-<state>"`（含 `staged`）；
- `test_91` 的源码闸门**跟着实现搬家**（判据从组件搬到 `useSaveDisplay` / `saveStatusText`），
  并新增两条反向闸门：「组件里不许再写第二份 `saveDisplay` computed」「projectStore 必须把 dirty 同步进状态栏」。

🔴 **顺带修掉的真缺陷**（`PlanetMap.saveMap`）：旧代码 `snapshotPanel.saveStatusTimer.value = setTimeout(...)`
—— `useSnapshotPanel` 里那是普通 `let`，返回时已快照成 `null` → `.value` 必然抛 TypeError，
被 `.catch()` 接住 → 用户看到「保存失败」。现在统一 `setBanner()` + 组件自己的 `bannerTimer`。

---

## 3. 判据（`test_115_planet_import_and_save_honesty.py`，全走真按钮 / 真 File）

| 段 | 判据 | 本轮实测 |
|---|---|---|
| f0 | 源码闸门 24 项：空态真按钮 / 三入口 / 共用件（不许组件自写命名与留底）/ 写口有守卫且登记 / 保存走 `describeSaveAction` / 旧提示「先导入 Azgaar .map」已消失 | 全过 |
| f1 | 点空态按钮 + 真 `File` → **mapData** 里省份 2 块、高度图四通道齐全（30/40/10/60 原样）、河流带 `nodes`；**标记 / 地点簇 / 区域原样保留** | 通过 |
| f2 | **一次** `undo()` → 省份 0、高度图回 `null`、河流 0 | 通过 |
| f3 | 已有内容时弹确认；**取消 → 一字不动**（仍 2 块 + 回执含「取消」）；**确认 → 替换不是累加**（仍 2 块），区域仍在 | 通过 |
| f4 | stub `saveMapData`：`staged` → 「已交给项目，正在写入磁盘…」/ warn 标，且**不含**「保存成功」「已保存到磁盘」；`persisted` → 「已保存到磁盘」/ ok 标；失败 → 带 `EBUSY` 原因 / err 标 | 通过 |

⚠️ 本用例主探针**拆成多段**：CDP 客户端读超时 15s，一条 eval 串太多等待会崩在
`Connection timed out` 上而不是给结论（本轮首版就踩了）。另外 `eval_json` 要求返回对象**必须有 `fails` 字段**，
非断言探针也要带 `fails: []`。

### 机器基线（本轮收尾实测）

- **CDP 回归：115/115 通过**（新增 `test_115`；`test_91` / `test_96` 的判据跟着实现搬家）
- **Node 单测：33/33 文件全过**（新增 `test_save_status_text.js` 16 条、`test_planet_map_bundle.js` 19 条）
- **`npm run build`：通过**（`dist/` 已重建）；`docs/ARCHITECTURE_MAP.md` 已再生成（292 文件）
- 收尾卫生：无临时 `.map` / `mock` / 日志残留，5180·9222 端口已释放

⚠️ **两次"失败起跑"的现场（诚实交代）**：① 第一次全量跑到 `test_21` 后就**没有任何输出**（25 分钟），
杀掉后单跑 `test_21`、`test_20 test_21` 都通过 → **未能复现**；② 被杀的那次留下了
`src/renderer/index.html.bak`，下一次启动被护栏当场拒绝（「检测到上一次 mock 未收尾」）——
清理办法就写在报错里：`git checkout -- src/renderer/index.html` + 删掉 `.bak` 与 `mock-data/`。
第三次（干净状态 + `python -u`）一口气 **115/115**。
→ 操作纪律：**跑全量用 `python -u`**（否则 stdout 块缓冲，卡了也看不见卡在哪），
被杀之后先按上面的办法清干净再重跑。

---

## 4. 本轮改动清单

- **新增**：`src/renderer/src/utils/mapImportSource.js`、`utils/planetMapBundle.js`、`utils/saveStatusText.js`、
  `composables/useSaveDisplay.js`
- **新增测试**：`scripts/tests/cases/test_115_planet_import_and_save_honesty.py`、
  `scripts/tests/unit/test_save_status_text.js`（16 条）、`scripts/tests/unit/test_planet_map_bundle.js`（19 条）
- **改**：`components/PlanetMap.vue`（空态入口 / 导入实现 / 保存横幅 / `setBanner` / 高度面板入口 / 提示语）、
  `components/ScenarioMap.vue`（改用共用件 + `useSaveDisplay` + `staged` 样式）、
  `components/StatusBar.vue`（走 `useSaveDisplay`）、
  `store/geodataModules/mapDataEditing.js`（`importPlanetMapBundle`）、
  `store/geodataModules/scenarioEditing.js`（参考图层映射改用共用件）、
  `store/writeGate.js`（登记新写口）、`store/projectStore.js`（dirty / lastSavedAt → 状态栏）、
  `composables/useStatusBar.js`（`savePending` / `savedAt` / setter）、
  `scripts/tests/cases/test_91_save_failure_visibility.py`（判据搬家）、`test_96_import_diagnostics.py`（留底判据搬家）、
  `AGENTS.md`（用例数 114→115、Node 31→33、新增本轮条目）

---

## 5. 出图（观感证据，本轮真的看了图）

工具：`scripts/tests/tools/_shot_planet_20261017.py`（真实 `docs/mockups/desite.map` 走**产品导入链**：
真按钮点击 + 真 `File` 注入，不直接调 store）。产物：`docs/assets/planet-20261017/`

| 图 | 拍到了什么 | 看图结论 |
|---|---|---|
| `01-planet-empty.png` | 空行星的空态卡片 | 卡片居中、两条入口都在（「导入 .map 底图」为主按钮、「从零开始画」为次），底部一行小字说明"两个容器各存一份"；**入口真的是按钮**，不是一句提示 |
| `02-planet-imported.png` | 导入 4.3MB 真实底图之后 | 200 省 / 160 河 / 496 路 / 9975 格高度图 2.1s 落库；画面：高度图分层设色 + 河流（蓝）+ 道路（棕），工具栏多出「政治/自然/海岸/文化」四个参考图层按钮；底部绿色回执横幅说清"导了什么、城镇没导、原文已留底、两容器各存一份" |
| `02b-polygons-only.png` | 打开「多边形（覆盖物）」 | 省份多边形以半透明叠在高度图上（与 `test_70` 的口径一致：看得见两者） |
| `03-save-staged.png` | `saveMapData` 返回 `{staged:true,persisted:false}` 时点保存 | 琥珀色横幅 + 时钟图标：「已交给项目，正在写入磁盘…」——**不是**绿标、**不说**「保存成功」 |
| `04-save-persisted.png` | `persisted:true` | 绿色横幅 + 对勾：「已保存到磁盘」 |

**看图时发现并处理的两件事**：
1. 🔴 首版 `01` 的空态画布上残留着几块旧地形色块。查证过程（出图工具内做的）：
   逐层关掉 → `terrain` 层变化最大；逐个把绘制函数替换成空函数 → 色块**一个都没消失**；
   `markFullRedraw()` 后依旧在 → **不是绘制的，是渲染器背后直接改 `mapData` 留下的旧像素**
   （脏矩形局部重绘不会重画没被标记的区域）。修法：出图工具改成「先离开行星视图再回来」让组件重挂载，
   空态图才干净。**产品路径不受影响**（它走 store 写口）；但这条经验已写进代码注释：
   改地图数据一律走 store 写口，别在渲染器背后动 `mapData`。
2. 回执横幅原来 4 行、字很密，已把"城镇未导入"的括号说明与"两容器"那句压短（判据子串保持不变）。
   顺带把「截图连拍两张、只留第二张」写进工具（headless 下 rAF 可能晚一拍，第一张常是旧帧）。

⚠️ 仍然存在、**本轮未改**的观察：指北针是**世界坐标**定位（`bottomRight - 30`），镜头刚好卡到边缘时
会被画布右缘裁掉一半（02/03/04 都能看到）。属于既有的"叠加控件跟着镜头跑"问题，和本轮两件无关。

---

## 6. 下一步

按交接文档 §5 剩下的：

3. **自动河流遗留**：路由层平局打破、推演地形要有山脉走向 / 高原面 / 裂谷（"丑"的根，大工程）；
4. **P2 星系的 6 个表现层 bug** + `faction` 无写入路径；
5. `ScenarioMap.vue` 已 10200+ 行（技术债）。

**验收指南**：仍是「整个历史剧本模块收口后再单独出」——现在先把 3/4 做完。
