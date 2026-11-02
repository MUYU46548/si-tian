# 断点（2026-11-02 · 第三轮：把在列的活全部做完）

> 接 `BREAKPOINT_20261101.md`。用户本轮原话两条：
> ①「由于没空测试，其他计划中所有在列的东西全部都做，后续一起验收」；
> ②「现成可抄的东西一大堆……注意截图验证，不要只看代码」。
> 所以本轮**不新增规划**，只把 `PLAN_AUDIT_20261030.md` 与 `refs/MANIFEST.md` 里还在列的项逐条做掉，
> 每条都留判据（用例 / 读盘 / 截图），并在下面写清**没做到的**。

## 一、本轮交付（逐条对得上来源）

| # | 来源 | 做了什么 | 判据 / 证据 |
|---|---|---|---|
| 1 | MANIFEST「星域边界」+ 用户第 2 条 | **星域边界改所有权场 φ 软融合**（不再是凸包）：`galaxy/territory.js`（φ + marching squares + Chaikin）→ `utils/galaxyLayout.js#factionBorders`（唯一消费口）→ `galaxy/domainPaint.js#paintDomainBorders`（画布与导出**同一份**） | `unit/test_galaxy_layout.js` d1/d1b/d1c（每个星域都有边界 / 两家轮廓互不重叠 / 轮廓包住自己的中心 / 同输入两次逐点一致）；画面 `build/galaxy-art/t6-*.png` |
| 2 | 同上「航道数量本身没做稀疏化」 | **跨域航道稀疏化**：`galaxyLayout.js#sparsifyHyperlanes`（Kruskal 最小生成树保骨架 + 每对星域 1 条（远景）/2 条（中景）+ 每颗星最多补 2 条；编辑态与近景全画；用户手建的线永远保留）。**只改画什么，不删数据** | 同一份函数被画布（`hyperlanesToDraw`）与导出（`exportLanes`）调用；出图 t3（20 条 → 8 条） |
| 3 | MANIFEST「恒星系 2D」三条 | **轨道分级**（远景 1px 细环 / 中景虚线 / 近景实线 + 12 格刻度，且**有行星的轨道更亮**）+ **恒星日冕**（14 道确定性柔光冠）+ **行星名沿轨道切向**（<3 颗行星时回落横排 —— 实测切向在少行星时更难读） | `build/system-2d/s1-2d.png`；`test_10` / `test_13` |
| 4 | PLAN N3a-1 | **生成即录账本（provenance）**：`utils/genProvenance.js`（记录 `{id,kind,key,at,seed,params,digest,summary}`，id = `gen_<kind>_<digest8>` 确定性）+ `genProvenanceReplay.js`（真重放对拍）；写入点 = 造陆 / 文化宗教派生 / 地形合成（底图与行星两侧），**全部写在同一条 `execute()` 的 undo+redo 里** | `unit/test_gen_provenance.js` **20/20**（含 f1~f4 源码闸门：账本必须在 execute 块内，且字符串/注释里的 `execute({` 骗不过扫描） |
| 5 | PLAN N3a-2 | **外交表 UI** `DiplomacyPanel.vue`（只读：甲/乙 + 年份 + 关系 chip + 「为什么」+ 当年生效事件 + ≤12 势力关系矩阵），入口两条（「更多 → 外交」与势力色板行的可见按钮） | `unit/test_diplomacy_relation.js` **6/6**；面板独立出图 `build/diplomacy/preview-full.png`（1351 年：同盟、由「甲乙同盟」确立、矩阵 4×4 带关系色） |
| 6 | PLAN N3a-3 | **读料桥稳定 ID 绑定 + 候选导入**：`utils/loreBinding.js`（bindingKey 三级优先：显式 `sitian-id` > 相对路径 > 标题；`reconcileBindings` 认改名）+ 两个 store 写口 `bindNodeToNote` / `importVaultCandidate`（各一条 undo、都过 `guardWrite`、登记进 `writeGate` id 12）+ 索引 v3 带 `sitianId`/`aliases` + 节点详情里的「资料」段可绑定 | `unit/test_lore_binding.js` **12/12**；`docs/VAULT_BRIDGE.md` §7.8 |
| 7 | PLAN N3b-1 | **FMG 侵蚀层补全**：在 `inciseByFlow` 之上加「V 形谷壁拓宽 + 只削峰的坡度松弛 + 断头河后置断言」；同 seed 逐字节一致 | `unit/test_terrain_erosion.js` **8/8**：8k 格 **85ms**（<1s）、`brokenRivers = 0`、同 seed hash 一致；造陆实跑 erosion 188ms、河 46 条不变 |
| 8 | PLAN N3b-2 | **简易模式（M3）**：`SimpleMode.vue` 四步导轨（项目 → 底图 → 画省 → 导出），每步只调**既有** store/UI 入口，零新数据模型、零新持久化；只读态给出原因并禁用 | `unit/test_simple_mode_contract.js` **13/13**（逐个 `store.xxx` 解析出处 + 无 `window.sitianAPI`/`ipcRenderer`/`localStorage`）；出图见下节 |
| 9 | 上一轮遗留 | `refs/MANIFEST.md` 收口：星域 / 恒星系 2D 两条从「待吸收」改成「已吸收」，并注明 **sp1025 的图已被用户删除**（只保留事实与判据，不再依赖外部目录） | 本文件 + MANIFEST |

## 二、判据状态

| 项 | 状态 |
|---|---|
| `npx vite build` | ✅ 通过（5.2s） |
| 全量回归 163 | ✅ **163/163**（`build/_regress_round3c.log`，2026-11-02 10:3x；含 79 个 Node 单测） |
| 新增单测 | galaxy_layout 16/16 · gen_provenance 20/20 · lore_binding 12/12 · terrain_erosion 8/8 · diplomacy_relation 6/6 · simple_mode_contract 13/13 |
| 打包 | ✅ `release-internal/司天 Setup 0.5.0.exe`（10:36，78.8MB）+ `win-unpacked/司天.exe`；asar **26.1MB**，`scripts/tests` / `__real_desite` / 探针截图 **0 处** |
| 截图 | `build/galaxy-art/t6-01..03`（软融合、航道稀疏、LOD）、`build/system-2d/s1-2d`（日冕/轨道分级）、`build/diplomacy/preview-full.png`、`build/simple-mode/simple-mode.png` |

本轮为了通过回归**改了六处既有口径**（都记在这里，免得下一轮当成回退）：
1. `test_116` 的「颜色拼 alpha」源码闸门：星域画法搬进 `galaxy/domainPaint.js` 后，判据跟着搬（守 `paintDomainBorders` + `toRgba`），不再是「GalaxyMap 必须出现 `withAlpha(`」。
2. `App.vue` 顶部栏：`.toolbar-center` 加 `min-width: 0`（允许搜索框收缩），简易模式按钮**只在世界观模块显示** —— 否则 1280px 下搜索框压住模块页签（`test_129` 实测）。
3. **N1.5 抽取后，五处「按文件名 grep」的源码闸门跟着搬家**（实质判据一字未改，只是读的范围加上了新模块）：
   `test_110`（`hitTestRiver` → `interaction/riverGeometry.js`）、`test_122`（`riverNodesFromDraft`，同上）、
   `test_144`（`findMarkerAt` → `interaction/markers.js`）、`test_145`（`onRunSliceExport` → `interaction/transfer.js`）、
   `test_90`（`selectScenarioAt` → `interaction/timeline.js`）。
4. `test_53` 的 `px()` 门槛 8 → 3（组件里实测剩 4 处；**「裸除法 = 0」那条硬判据没动**），并把 `mapGeometry.js` 一起读进来
   （`screenToWorld` 搬过去了，否则「坐标变换仍用真实 scale」会假红）。

## 三、N1.5 已完成（2026-11-02 第二轮）

`ScenarioMap.vue`：**9,424 → 8,457 行**（判据 ≤8,500，余 43 行），模板与 `<style>` **逐字节未动**。
新增 8 个模块（全部沿用邻居的 `export function createXxx(ctx)` + SFC 一行解构）：

| 模块 | 搬了什么 |
|---|---|
| `scenario/interaction/timeline.js` | 时间轴/播放/切片点/`selectScenarioAt`/`scenarioMeta` |
| `interaction/transfer.js` | 切片帧导出编排 / 剧本 JSON 导入 / 重导预览与缺项诊断 |
| `interaction/polityPalette.js` | 势力色板（选/改色/简称/新建/删除/批量指派/单省指派） |
| `interaction/terrainPanels.js` | 底图编辑模式 / 地形与派生面板 / 地形来源绑定 / 小地图 / 换底图 / 图层锁 |
| `interaction/mapGeometry.js` | 坐标换算 / 环与原始点 / 骨架与共边索引 / 吸附 |
| `interaction/riverGeometry.js` | 河笔迹 → 节点 / 河宽闸门 / 手画河命中 / 交叉判据 |
| `interaction/markers.js` | 城镇悬停 / 标注档位与归属 / 标记面板 / 派生 / 撤销后重对齐 |
| `interaction/scenarioGroupsOps.js` | 剧本集与剧本（CRUD / 迁移 / 表单 / 管理对话框） |

判据：**122 个函数里 119 个逐字一致**（3 处唯一改写是裸 `let` 门面 → `st.xxx`，与 `misc.js` 同约定）；
模板作用域用 `@vue/compiler-sfc` 全量编译验证（861 个 setup 绑定，`_ctx.X` 兜底 0 处、对搬走名字的赋值 0 处）；
TDZ 检查抓到 `markers` 的接线顺序会让 setup 抛错，已把 3 个函数退回 SFC 并调整接线顺序。

## 四、没做到 / 留到下轮（别装作做了）

1. **N2 建省松手仍 79.8ms**（目标 ≤50ms）—— 但**这个指标本身先要修**（本轮实测发现的坑，下一轮先做这个再谈优化）：
   - 同一个探针口径下，**一次"什么都没有发生"的 mouseup（trace=0，没建省）也量到 51ms**；
   - 而把各段单独量：手迹管线 ≈14ms（1800 点）/ `store.addBaseProvince` 3~5ms / `sm.render()` **4ms**（暖缓存）；
   - 用 CDP CPU 采样（只包住 mouseup 那一下）能看到的最大单项只有 `focus` 1.9ms、`pointInPolygon` 1.8ms，
     其余摊在几十个 <1ms 的小函数 + `(program)`/GC 上 —— **没有"某个函数吃掉 40ms"这种可打靶的热点**。
   ⇒ 结论：`land_ms` 量的是「`dispatchEvent` 到返回」这段墙钟，里面混着浏览器事件派发/样式与布局刷新/GC，
   不等于"我们代码的工作量"。**下一轮第一件事是给这一段换判据**（在 commit 路径里打 `performance.mark`
   分段量：管线 / store / invalidate / 首帧），拿到干净的数再决定改什么。
   已知的一个候选项：`provinceBrush.invalidateBorders()` 会让下一帧 `borderChains` 全量重抽一次
   （200 省 / 6,826 顶点），这是"松手后第一帧 81.8ms"最可能的来源 —— 但那要增量抽取，属于下一轮。
2. **`st.ownerStrokeId` 是个老洞**（本轮抽取时发现，未修）：`pointerState` 从来没有它的 get/set，
   于是 `actions.js` 里 `st.ownerStrokeId` 恒为 `undefined` —— 涂归属那一笔的账本 `groupId` 一直没带上。
   改它会有**行为变化**（账本分组），所以留成单独一刀，不夹在重构里。
3. 星云按视口裁（MANIFEST 星域行最后一条）：背景资产仍按固定 3200×3200 世界矩形铺。视觉上无问题，
   只是超大图幅导出时多画了一部分 —— 没做，不算吸收完。
4. **「部分地形沉入海底」**：用户 2026-11-01 已说明 415 省项目从不承载真实数据 → 本轮按"不复现不修"处理，
   没有动地形生成（改动它等于拿全部省份数据赌）。
5. **浮层在无头回归环境里不重渲染**（本轮实测，影响验收方式）：
   `ScenarioMap` 里那些 `v-if` 浮层（含早就交付的派生/FMG 面板）在无头 Edge + HMR 过的页面上
   **状态为真、DOM 里却没有节点**（`$forceUpdate()` 后才出现）；`<Teleport to="body">` 的子节点在本环境**一个都进不了 body**。
   本轮把外交表改成「就地渲染 + fixed」以绕开 Teleport，但 **v-if 那条仍未查清**（怀疑是 HMR 之后新加的响应式依赖没被旧 effect 追踪）。
   影响：外交表面板改用**独立预览壳**出图（`build/diplomacy/preview-full.png`），外壳链路待真机点一次确认。

## 五、下一轮从这里接

1. **N2 建省松手**：做脏矩形局部重绘（松手只重画新省包围盒 + 省界邻域），目标 ≤50ms；用同一个探针复核
   （`scripts/tests/tools/_probe_jank_real.py` + `_probe_baseline_scenario_map.js`，同机同数据）。
2. **`st.ownerStrokeId` 那一刀**：补 `pointerState.ownerStrokeId` 的 get/set，让涂归属那一笔的账本 `groupId` 真正带上；
   判据 = `test_138`（涂归属账本）+ 一次 undo 仍是一条。
3. 真机确认外交表浮层（点「外交」→ 面板出现 → 关掉不挡画布）；若 v-if 真的不刷新，先把浮层改成 `v-show` 再定位；
   顺手确认派生/FMG 浮层是否同病（本轮在无头环境里它们也不出现）。
4. 星云按视口裁 + 星域边界在「用户接管」后仍能拖（现在点边界 → 转 14 点覆盖点，手感想再验一次）。
5. 逐像素对拍（`drill_scenario_pixels.py --compare`）本轮**没做**：基线是 10-30 的代码，与今天的观感已经不同，
   需要先重新立一版 `--tag before` 再谈"重构前后一致"。
