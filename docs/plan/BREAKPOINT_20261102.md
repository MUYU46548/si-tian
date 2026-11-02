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

本轮为了通过回归**改了两处既有口径**（都记在这里，免得下一轮当成回退）：
1. `test_116` 的「颜色拼 alpha」源码闸门：星域画法搬进 `galaxy/domainPaint.js` 后，判据跟着搬（守 `paintDomainBorders` + `toRgba`），不再是「GalaxyMap 必须出现 `withAlpha(`」。
2. `App.vue` 顶部栏：`.toolbar-center` 加 `min-width: 0`（允许搜索框收缩），简易模式按钮**只在世界观模块显示** —— 否则 1280px 下搜索框压住模块页签（`test_129` 实测）。

## 三、没做到 / 留到下轮（别装作做了）

1. **N1.5 行数**：`ScenarioMap.vue` **9,424 行**（目标 ≤8,500，差 924）。N1 的判据 4a（≤12,700 + `draw*` 迁出）已达成（现在只剩 1 个 `draw*`），
   但把「编辑交互/导入导出」再拆一轮会动 1,000+ 行，本轮没有余量做**带回归的**拆分 —— 不拿"看起来拆完了"充数。
2. **N2 手感复测**：本轮**测了**（`scripts/tests/tools/_probe_jank_real.py` + `_probe_baseline_scenario_map.js`，
   真实 200 省 `__real_desite.map`、1080×484、scale 0.507、同机同探针）：
   - **涂归属** p50 16.9 / **p95 18.0** / max 18.5 / **>50ms 帧 0**、抬手 8.9ms → **到线**（目标 p95 ≤33ms、零帧 >50ms）；
   - **建省松手 79.8ms** → **未到线**（目标 ≤50ms）。本轮把这段**拆开量了**（`build/_probe_step.py`，
     1800 点手迹 → 简化 32 点 / 骨架 200 条）：`smoothStrokePoints` 1.4 + `simplifyClosedTrace` 1.6 +
     `sanitizeFreehandRing` 0.1 + `buildSkeleton` 2.8 + `conformToSkeleton` 8.1 ≈ **14ms**；
     `store.addBaseProvince`（含压叠度量 + execute + `saveScenarios` 同步段）**3~5ms**。
     ⇒ 剩下 **40~50ms 在鼠标抬起后的整屏重绘**（200 省 + 河 + 海岸 + 标签，1080×484）。
     **下一轮的正确方向不是优化 store，而是松手时只重绘新省的包围盒**（脏矩形），别整屏重来。
3. **星云按视口裁**（MANIFEST 星域行最后一条）：背景资产仍按固定 3200×3200 世界矩形铺。视觉上无问题，
   只是超大图幅导出时多画了一部分 —— 没做，不算吸收完。
4. **「部分地形沉入海底」**：用户 2026-11-01 已说明 415 省项目从不承载真实数据 → 本轮按"不复现不修"处理，
   没有动地形生成（改动它等于拿全部省份数据赌）。
5. **浮层在无头回归环境里不重渲染**（本轮实测，影响验收方式）：
   `ScenarioMap` 里那些 `v-if` 浮层（含早就交付的派生/FMG 面板）在无头 Edge + HMR 过的页面上
   **状态为真、DOM 里却没有节点**（`$forceUpdate()` 后才出现）；`<Teleport to="body">` 的子节点在本环境**一个都进不了 body**。
   本轮把外交表改成「就地渲染 + fixed」以绕开 Teleport，但 **v-if 那条仍未查清**（怀疑是 HMR 之后新加的响应式依赖没被旧 effect 追踪）。
   影响：外交表面板改用**独立预览壳**出图（`build/diplomacy/preview-full.png`），外壳链路待真机点一次确认。

## 四、下一轮从这里接

1. N1.5：把「时间轴 / 导入导出 / 势力色板」三块交互拆成 composable，目标 ≤8,500，判据 = 全量 163 + 逐像素对拍不变；
2. N2 复测两个数（涂归属 p95、建省松手），到线销账；
3. 真机确认外交表浮层（点「外交」→ 面板出现 → 关掉不挡画布）；若 v-if 真的不刷新，先把浮层改成 `v-show` 再定位；
4. 星云按视口裁 + 星域边界在"用户接管"后仍能拖（现在点边界 → 转 14 点覆盖点，手感想再验一次）。
