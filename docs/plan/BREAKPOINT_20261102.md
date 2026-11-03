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
| 8 | PLAN N3b-2 | **简易模式（M3）**：`SimpleMode.vue` 四步导轨（项目 → 底图 → 画省 → 导出），每步只调**既有** store/UI 入口，零新数据模型、零新持久化；只读态给出原因并禁用 | `unit/test_simple_mode_contract.js` **13/13**（逐个 `store.xxx` 解析出处 + 无 `window.sitianAPI`/`ipcRenderer`/`localStorage`）；**端到端真跑过一遍**（2026-11-02 第五轮）：① 新建项目 → 真落 `.sitian`；② 一键生成 → 9 块陆地 / **180 省 / 46 河**（回执齐全）；③ 进编辑器 → 画布上就是那 180 省、46 条河、小地图正常（`build/simple-mode/flow-01..04.png`） |
| 9 | 上一轮遗留 | `refs/MANIFEST.md` 收口：星域 / 恒星系 2D 两条从「待吸收」改成「已吸收」，并注明 **sp1025 的图已被用户删除**（只保留事实与判据，不再依赖外部目录） | 本文件 + MANIFEST |

## 二、判据状态

| 项 | 状态 |
|---|---|
| `npx vite build` | ✅ 通过（5.2s） |
| 全量回归 163 | ✅ **163/163**（`build/_regress_round3c.log`，2026-11-02 10:3x；含 79 个 Node 单测） |
| 新增单测 | galaxy_layout 16/16 · gen_provenance 20/20 · lore_binding 12/12 · terrain_erosion 8/8 · diplomacy_relation 6/6 · simple_mode_contract 13/13 |
| 打包 | ✅ `release-internal/司天 Setup 0.5.0.exe`（10:36，78.8MB）+ `win-unpacked/司天.exe`；asar **26.1MB**，`scripts/tests` / `__real_desite` / 探针截图 **0 处** |
| 截图 | `build/galaxy-art/t6-01..03`（软融合、航道稀疏、LOD）、`build/system-2d/s1-2d`（日冕/轨道分级）、`build/diplomacy/preview-full.png`、`build/simple-mode/simple-mode.png` |

本轮为了通过回归**改了六处既有口径**（都记在这里，免得下一轮当成回退）：1. `test_116` 的「颜色拼 alpha」源码闸门：星域画法搬进 `galaxy/domainPaint.js` 后，判据跟着搬（守 `paintDomainBorders` + `toRgba`），不再是「GalaxyMap 必须出现 `withAlpha(`」。
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

1. ~~**N2 建省松手 79.8ms**~~ → **已到线（并顺手修了指标）**：
   - `land_ms`（包住 `dispatchEvent` 量墙钟）**不是干净的信号** —— 实测一次「什么都没发生」的 mouseup 也有 51ms，
     里面混着事件派发/样式与布局刷新/GC。所以给 commit 路径加了分段 `performance.mark`
     （`window.__SITIAN_PERF__` 打开才记，默认零成本，读数落 `window.__LAND_PERF__`）。
   - 分段实测（真实 200 省底图 / 1080×484 / 新画一圈地形）暴露真凶：
     **`measureProvinceOverlap` 80.5ms**（占松手 88%），根因是它对**每个采样格心**都重算一次
     `provinceRings` / `ringSigns`（40×40=1600 次）。
   - 修法：在 `utils/provinceOverlap.js` 里把「环 + 环向」按形状**预计算一次**再传进 `pointInProvince(…, cached)`
     —— **同一份几何、同一套判定，结果逐字节不变**（`test_79` 的 0.50 / 0.20 两个精确比值原样通过）。
   - 结果（同机同数据，3 次）：**手迹管线 3~6ms ｜ 重叠度量 28~40ms ｜ execute 0.1~0.4ms ｜
     saveScenarios 同步段 3~4ms ｜ 落库合计 32~43ms ｜ 松手墙钟 36~47ms** → **≤50ms 达标**。
   - 仍大的一块是 `重叠度量`（占剩余时间 70%）：要再快就得动采样口径（`OVERLAP_MAX_DIM` / 每省点数上限），
     那会改变比值语义、牵连 `test_79` 的精确断言 —— 不做，留作"以后真的嫌慢再说"。
2. ~~**`st.ownerStrokeId` 是个老洞**~~ → **已修（2026-11-02 第四轮）**：`pointerState` 从来没有它的 get/set，
   于是 `actions.js` 里 `st.ownerStrokeId` 恒为 `undefined` —— 涂归属那一笔的账本 `groupId` 一直没带上
   （账本照记，但记不成"一组"）。现在由 `polityPalette.js` 交出 `ownerStrokeIdNow()`（唯一实现），
   `commitOwnerStroke` 改调它。判据：真实拖一笔 → 账本长出同一 `groupId`
   （实测 `own-mvyux7hb-6ow`，2 条事件）；`test_138` 的「属性面板自动 groupId 不复用笔刷的 groupId」仍绿。
3. 星云按视口裁（MANIFEST 星域行最后一条）：背景资产仍按固定 3200×3200 世界矩形铺。视觉上无问题，
   只是超大图幅导出时多画了一部分 —— 没做，不算吸收完。
4. **「部分地形沉入海底」**：用户 2026-11-01 已说明 415 省项目从不承载真实数据 → 本轮按"不复现不修"处理，
   没有动地形生成（改动它等于拿全部省份数据赌）。
5. **浮层在无头回归环境里不重渲染**（本轮实测，影响验收方式）：
   `ScenarioMap` 里那些 `v-if` 浮层（含早就交付的派生/FMG 面板）在无头 Edge + HMR 过的页面上
   **状态为真、DOM 里却没有节点**（`$forceUpdate()` 后才出现）；`<Teleport to="body">` 的子节点在本环境**一个都进不了 body**。
   本轮把外交表改成「就地渲染 + fixed」以绕开 Teleport，但 **v-if 那条仍未查清**（怀疑是 HMR 之后新加的响应式依赖没被旧 effect 追踪）。
   影响：外交表面板改用**独立预览壳**出图（`build/diplomacy/preview-full.png`），外壳链路待真机点一次确认。

## 六、对照《欧陆风云4》/《群星》的诚实清点（2026-11-02 第六轮）

用户原话：「一堆东西放在那里抄了几十次……自己对比目标《欧陆风云4》和《群星》，抄没抄清楚心里要有数」。
对着 `refs/src/20261027-08-eu4-1518.jpg`、我们自己的剧本视图出图（`build/eu4-compare/ours-political.png`，
200 省 + 14 势力）、以及星域出图（`build/galaxy-art/sky1-*.png`）逐项比对：

| 维度 | EU4 / 群星的做法 | 我们现在 | 判定 |
|---|---|---|---|
| 势力名 | 巨大、半透明墨字、**沿国土主轴转**、按面积分档、有浅色描边 | 巨大、旋转、按面积分档、有描边（`scenario/layers/labels.js` + `utils/polityLabels.js`） | ✅ **抄到了**（这轮对照看到的最接近的一块） |
| 无主省 | 纸色、不抢眼 | `#d8d2c2` 纸色 | ✅ 抄到了 |
| 省界 | 发丝线 + 共边吸附，无针孔 | 同（共边吸附、发丝线） | ✅ 抄到了 |
| **地形底** | 整幅**浮雕底**（山地阴影/丘陵起伏），政治色只是 35~45% 的水洗 | 纯色省填 + 深色底，**没有地形层**（`scenario/layers/background.js` 只画 `#1a2a3a` + 网格） | ❌ **没抄**——这是"不像 EU4"的第一大原因 |
| **海** | 深浅海 + 岸线光晕 + 海的纹理 | 平涂蓝 | ❌ 没抄 |
| **政治配色饱和度** | 低饱和、彼此区分但不刺眼 | 目前很艳（粉/黄/绿饱和度偏高） | ❌ 没抄（观感"花花绿绿"） |
| 线宽层级 | 海岸 > 国界 > 省界（三级） | 基本一级 | ❌ 没抄 |
| 群星的**银河形态** | 螺旋盘 + 星链 + 星云结构 | **N 个星域摆成半径 630 的环**（`layoutDomains`），再好的美术也是"几个色块围一圈" | ❌ **没抄，而且这是布局/数据层的问题，不是美术层** |
| 群星的星点/航道/领土 | 已内化（色温、光晕、细线、软轮廓、LOD、远景稀疏） | 同上 + 本轮加了按视口选分辨率 | ✅ 大体抄到了 |

**为什么"抄了几十次"还是不像**（这条比任何单项都重要）：一直在抄**样式参数**（字号、颜色、透明度、线宽），
没有抄**画面构成比例** —— EU4 一屏大约 65% 地形纹理 + 25% 政治水洗 + 10% 线/字；
我们一屏 90% 平涂色块 + 10% 线/字。参数再调也不会像，因为缺的是那 65% 的「地形」。
同理星域：群星是"盘 + 螺旋臂"，我们是"环"，形态这一层没跟上，材质做得再细也不像。

**下一轮就该做这一件（不再零敲）**：
1. 剧本视图：地形浮雕底（复用 `heightmapRaster`，底图本来就有高度图）→ 政治色降到 ~40% 水洗 →
   三级线宽（海岸 1.6 / 国界 1.2 / 省界 0.7）→ 海的深浅 + 岸线光晕；
   判据：与 EU4 截图同尺寸并排、像素基线**重立**（旧基线作废，先 `--tag before` 后 `--tag after` 对拍）。
2. 星域：`layoutDomains` 从「环」改成「盘 + 螺旋臂」（数据层），这才是群星观感的根；
   判据：同一份 120 节点 fixture 的布局出图 + `test_116`（拖拽/边界/命中）全绿。
3. 参考图缺口（必须由用户补）：真实《群星》截图从没进过 `refs/`（此前抄的是自家原型，已被用户删除）；
   EU4 只有两张整幅图，缺局部放大（省界/海岸/字的细节尺寸）。**没有这些，"抄"就只能靠猜比例。**

## 七、待办：直角引号「」清理（用户 2026-11-02 点名）

**规则**：`「」` 不是常规中文标点（日式角括号），界面文案与代码注释都不该拿它当"引用/强调"。
正确写法是中文双引号 “ ” 与单引号 ‘ ’（不是英文直引号 `"` `'`，代码里除外）。

**现状（`node scripts/quote-audit.mjs` 实测，只读）**：`「` **7,066** 次 / `」` 7,067 次，命中 **584 个文件**；
其中 **Vue 模板（直接显示给用户）329 处**、**JS 字符串/代码里 728 处**（状态栏回执、用户指南 `utils/userGuide.js` 149 处等），
其余是注释与 docs（docs 侧 1,450 行提到）。

**为什么不能现在随手改**：大量用例断言的是**原文**（`statusMsg` 回执、指南正文、验收文案），
一改就会红一片；而且这是 2,500+ 行的机械替换，必须一次做完 + 一次全量回归。

**下一轮做法（建议单独一刀）**：
1. 写 `scripts/fix-quote-marks.mjs`：默认 dry-run 出清单；`--apply` 才写盘，替换规则
   `「 → “`、`」 → ”`（嵌套 `『』` 先处理成 ‘ ’）；**跳过** `.js` 字符串里的正则/JSON key，只改面向人的文案；
2. 同步改用例里的期望字符串（成对替换，保证断言跟实现一起变）；
3. 判据：`quote-audit` 的「界面 + 代码」两个计数降到 0（docs 可分批）；全量 163 全绿；像素基线不变；
4. 顺手把这条写进 `AGENTS.md` 红线（新代码不许再出现）。

**2026-11-03 已执行（提交 `8ffe330`）**：
- 新增 `scripts/fix-quote-marks.mjs`：默认 dry-run；`--apply` 才写；`--scope src|tests|docs`；
  `--files a,b` 定向；**正则字面量行自动跳过**并进"需人工"清单（本仓实测只命中一处）。
- 实际落盘：`src/` + `scripts/` **10,269 处 / 498 文件**（界面 5,724 + 用例/脚本 4,493 + mockup 52）。
  实现与用例**同一套替换**，所以断言跟着一起变，一次全绿。
- 两处手工（脚本跳过的）：
  ① `scripts/lib/vaultClassify.js` 的剥离字符类改用 `\u300c\u300d` 转义 —— 语义不变（老资料里的角括号
     照样被剥），但源码里不再有字面量；
  ② `scripts/quote-audit.mjs` 的输出改成用 `OPEN`/`CLOSE` 常量拼，注释不再写字面量。
- 判据：`node scripts/quote-audit.mjs` → **界面 0 / 代码 0**；全量回归 **163/163**
  （`build/_regress_round14.log`）；`npx vite build` 通过。
- **没做**：**docs 归档 1,978 处**原样保留 —— `docs/agents-archive/*` 页头写着"原文一字未改"，
  改了就等于改历史证据。要清只需 `node scripts/fix-quote-marks.mjs --scope docs --apply`，
  但得先接受那句承诺作废（建议：只清 `docs/plan/` 与 `docs/guides/`，归档不动）。

## 八、原型（SP-1025）集成清点（2026-11-02，用户追问"都利用完了吗"）

原型 `E:\CODE\CangKu\SP-1025\src` 共 **4,004 行 / 24 个 .ts**。逐个对账后的事实是：**只进了"美术层"，没进"生成器/拓扑/自验"**。

| 原型文件 | 行 | 进了没有 | 在哪 / 差什么 |
|---|---|---|---|
| `render/background.ts` | 227 | ✅ 已内化 | `galaxy/sky.js`（同 spec 重写：星云/尘埃带/三层星场/暗角） |
| `render/nodes.ts` | 183 | ✅ 已内化 | `galaxy/starArt.js`（色温五档 + 归属环 + 光晕 + LOD） |
| `render/labels.ts` | 64 | ✅ 已内化 | `galaxy/labels.js`（LOD + 贪心避让 + 无底框） |
| `core/territory.ts` | 201 | 🟡 部分 | `galaxy/territory.js`（φ 场 + claim），**`growRegions`/`factionWeights` 没搬**（那是"从零生成归属"用的，我们现在靠用户数据） |
| `render/regions.ts` | 215 | 🟡 部分 | `galaxy/domainPaint.js`（轮廓 + 三层边；渐隐参数按群星图重定） |
| `render/lanes.ts` | 92 | 🟡 部分 | 线宽/光晕已抄；**按类型配色改成单色青是今天才按群星图做的** |
| `render/planetArt.ts` | 232 | 🟡 部分 | `utils/planetArt.js#getPlanetDisc`（只搬了 2D 圆盘那条） |
| **`core/generator.ts`** | **350** | ❌ **没进** | 盘/螺旋/环带的**形态采样 + 参数自验 + 首府/要冲/资源带**。**这是"和原型差那么多"的头号原因** |
| **`core/topology.ts`** | **270** | ❌ **没进** | kNN/度数建航道 + 桥接 + 割点（我们的航道来自数据/自动生成，不是这一套） |
| **`core/metrics.ts`** | **166** | ❌ **没进** | 量化自验（重叠对/最大度/连通分量）——原型"生成不合格就换种子重试"靠它 |
| `render/lod.ts` | 62 | ❌ 没进 | 我们用的是 `lod = clamp((scale-0.3)/0.7)` 的临时口径，不是原型的分档带 |
| `render/renderer.ts` | 451 | ❌ 没进 | 原型自己的渲染编排（绘制顺序/剔除/LOD 套用）；我们有自己的一套 |
| `core/geometry.ts` | 249 | 🟡 自研替代 | 等值线/Chaikin 是自己重写的（`galaxy/territory.js`），没逐行对照过 |
| `core/commands.ts` / `model.ts` / `serializer.ts` | 900 | ➖ 不适用 | 撤销栈/文档模型跟着司天自己的 store 走 |
| `app/*` / `core/{ids,prng,view}.ts` / `render/camera.ts` | 400 | ➖ 不适用 | 原型壳 |

**一句话**：进了约 **40%**（美术层），没进的是**生成器 + 拓扑 + 量化自验 + LOD 分档**。
原型的"银河感"主要来自 `generator.ts` 在 120 个节点 / 4 个势力上跑盘/螺旋采样 + kNN 航道；
我们是在"4 个星域 + 10 颗星"的用户数据上套美术 —— 数据密度差一个数量级，所以怎么调都不像。

**2026-11-02 已补的第一步**：`layoutDomains` 加了 `shape: 'ring' | 'disc' | 'spiral'`
（`sampleDomainShape`/`sampleDomainCenters` 直接移植原型公式；默认仍是 ring，可用
`window.__SITIAN_DOMAIN_SHAPE__` 或传参切换）。出图 `build/galaxy-shape/{ring,disc,spiral}.png`。
⚠️ 实测：**只有 4 个星域时，螺旋读不出来**（采样点太少，退化成一横排）——形态要成立，需要 8+ 星域。

**方案 A 已实现（2026-11-02，用户拍板）**：
- 新增 `src/renderer/src/galaxy/generator.js`（纯函数，**逐条移植**原型 `core/generator.ts` + `topology.ts` +
  `metrics.ts`：mulberry32/Rng、sampleShape 三形态、加权 Prim 区域生长、kNN/Gabriel 候选 + 2 跳补环（禁交叉）
  + 分量桥接、Tarjan 割点、computeMetrics、三次换种子自验）；
- 新增 store 写口 `generateSampleGalaxy`（`geodata.js`，**首行 guardWrite、一条 execute**，登记 `writeGate` id 13）；
- `toSiTianEntities()` 把生成物转成司天实体（star_domain / galaxy / hyperlane）：
  **边域（ρ>0.7）的星没有势力归属**，原型里它们不属于任何区 —— 司天按 parentId 聚簇，挂世界上就画不出来，
  所以兜底归到**最近星域**；
- GalaxyMap 工具栏新增「示例星系」按钮（`data-testid="gen-sample-galaxy"`，只读态禁用带原因）。

判据（实测）：
- `unit/test_galaxy_generator.js` **10/10**：同 seed 逐项一致 / overlap 0 / maxDeg 5 ≤ cap / 分量 1 /
  三形态分布不同 / 名字不重（原型只补一次序数，实测 120 节点重名 9 个 —— 已改成补到不重）/
  实体形状合法 / 写口过闸门；
- 真机点按钮：节点 120 → 244（+4 星域 +120 恒星）、航道 72 → 247（+175），**一次 undo 精确回到 120/72**；
- 出图 `build/galaxy-shape/generated.png`；全量回归 **163/163**（`build/_regress_round9.log`）。

**下一步**：
- B. 布局默认切 `disc`，星域数 ≥8 时自动 `spiral`；等用户数据变多自然就对了。
  → **2026-11-03 已按证据改口径落地，见第十节**（环在 ≤6 反而更舒展；7 起才切，8+ 螺旋）。

## 九、下一轮从这里接1. **星域领土改成“暗底 + 亮边”**（按新增群星图的事实，见 `refs/MANIFEST.md` 第〇节）：
   现在 `domainPaint` 是亮色径向水洗（越往中心越亮）—— 方向反了。群里图上是**近黑半透明底 + 1px 亮线 + 外柔光**。
   判据：同机位出图与 `refs/src/星域视图2.jpg` / `星域视图4.png` 并排；`test_116`（改色/命中/拖拽）全绿。
2. **航道改单色**（群星只有一种青色，靠明暗分主次）：`hyperlaneColor` 的 4 类色要收成 1 类 + 两档明暗；
   跨域/跳跃只用「虚线 + 压暗」区分。判据：`test_116` / `test_117` 全绿 + 出图。
3. **星域名改小字**：现在 16~19px，群星是 ~12px、字距宽、白色；中文没有大小写，靠**字距 + 低饱和**做层级。
4. **星域布局从「环」改「盘 + 螺旋臂」**（`layoutDomains`，数据层）—— 这是"像不像群星"的根，排在上面的观感调整之后做，
   因为它会动布局与坐标持久化，要单独一轮 + `test_116` 兜底。
5. 直角引号清理（第七节，单独一刀）。
6. 真机确认外交表浮层（点「外交」→ 面板出现 → 关掉不挡画布）；顺手确认派生/FMG 浮层是否同病。

## 十、2026-11-03：星域布局按数量自动切形态（§八"下一步 B" / §九-4）

**改了什么**（`src/renderer/src/utils/galaxyLayout.js`，唯一实现，画布与导出共用）：
- 新增 `autoDomainShape(count)`：**≤6 → ring / 7 → disc / ≥8 → spiral**。
  原计划写的是"≤3 环、4~7 盘"，出图目检后改了两处：3 个点摆盘会退化成一条线；4 个点摆盘像一坨（环更舒展）。
- 环半径不再恒为 630：按"相邻中心 ≥ `minDomainGap`"反解（`760 / (2·sin(π/n))`），
  **n=6 时 630 上相邻只剩 630 < 700（两倍星域半径）本来就在压**；n≥7 环的相邻间距更小，所以从 7 起切盘。
- 新增 `expandCentersToGap`：先**两两松弛**再等比放大（放大倍率封顶 1.6、最多 4 轮）。
  只等比放大会出事：兜底点与已有点几乎重合时，整团被吹到天边（实测 n=10 半径从 ~1,200 炸到 ~34,000）。
- 采样盘按 √n 放大（`fieldScale`）：否则 8+ 星域在 630 的盘里放不进（拒采 800 次仍失败）→ 全掉进环形兜底 → 螺旋白采。
- `window.__SITIAN_DOMAIN_SHAPE__` / `opts.shape` 仍可强制；`userMoved` 坐标照旧优先（布局坐标本就不落盘）。

**判据（都实测过）**：
| 判据 | 结果 |
|---|---|
| `unit/test_galaxy_layout.js` | **19/19**（新增 b3 形态门槛 / b4 n=7 盘：最近 760.3 / b5 n=12：最近 761.0、半径 706~2870） |
| `test_116`（拖拽/边界/命中/持久化） | **通过**；f5 口径改成「任意两中心 ≥ 760」+「撤销回到拖动前的布局位置」（实测最近 891.0） |
| 出图目检 | `build/domain-layout/preview.png`（n=3/6/7/8/12/16，每格自动缩放、圆圈 = 350 半径领土） |
| 全量回归 163 | **163/163**（`build/_regress_round12b.log`） |

**诚实结论（没做到的，别当已吸收）**：n≥8 的螺旋臂**还是读不出来**——8~16 个星域时看上去是"摊开的场"，
不是三条旋臂。原因不是采样公式，是"领土半径 350 + 中心间距 760"把臂挤平了；要真像群星，
需要 ①星域数量再上一个量级，或 ②整幅美术（星云/星链/尘埃）托底。本轮只解决了**"环会互相压"**这个真问题。

## 十一、2026-11-03：剧本视图地形浮雕底（§六「下一轮就该做这一件」第 1 条）

**问题**（用户原话的量化版）：EU4 一屏约 65% 地形纹理 + 25% 政治水洗；我们 90% 是平涂色块，
只剩 10% 线字。所以怎么调字体/线宽都不像 —— 缺的是那 65%。

**改了什么**：
| 文件 | 改动 |
|---|---|
| `scenario/layers/background.js` | 新增 `drawRelief`：底色之后、网格之前 `drawImage` 一张**浮雕栅格**（地形色 + 山体阴影） |
| `components/ScenarioMap.vue` | 新增 `reliefOn()`（只在政治档 landsea/none + 底图**真有高度图**时开，可 `window.__SITIAN_SCENARIO_RELIEF__ = false` 关）与 `getReliefRaster()`（`buildHeightmapRaster(hm,'terrain',{shade:1.25})`，按高度图引用缓存）；`basemap.raster` 在浮雕开时**让位**（否则 landsea 栅格会把浮雕盖住） |
| `scenario/layers/provinces.js` | 填色与同色缝描边都吃 `view.politicalWash`（浮雕开 = **0.42**，关 = 1 旧口径） |
| `scenario/layers/coast.js` | 政治档海岸线 1.1 → **1.6px**；浅海光带 0.55 → 0.38（原先在浮雕上像一圈发光塑料） |
| `ScenarioMap.vue` | 省界 `PROVINCE_BORDER_PX` 0.9 → **0.7**（三级线宽：海岸 1.6 > 国界 1.2 > 省界 0.7） |

**判据（都实测过）**：
| 判据 | 结果 |
|---|---|
| `unit/test_scenario_relief.js`（新增，假 ctx 记账） | **7/7**：浮雕按序 drawImage / 关掉时一次不画 / 拿不到栅格不崩；填色与缝描边**都**吃 0.42；无浮雕时回到 1；海岸 5px 带 + 1.6px 线；省界常量 0.7 |
| `scripts/tests/drill_scenario_relief.py`（新增，真机开/关各拍一张） | **通过**：同机位开/关两帧不同；全图颜色数 **4,006 → 8,192**（地形色+阴影真的进来了） |
| 出图目检 | `build/scenario-relief/on.png` / `off.png`（off 是纯平涂色块，on 能看出山脊与阴影，政治色明显被水洗） |
| 全量回归 163 | 见 `build/_regress_round13.log` |

**没做到（诚实）**：
1. **国界 1.2px 没实现**：要在共边索引上比对两侧归属（同一对顶点两侧 `ownership` 不同才画），
   本轮只落了省界 0.7 与海岸 1.6 两级；「国界」现在是**缺的一级**。
2. **像素基线没重立**：`build/pixel-baseline/before` 是旧观感下的，浮雕一开就作废；
   重立要在新观感上重拍 before/after（任务卡 `像素基线重立…3213daba`）。
3. 浮雕色带直接用 SP-1025 的 `terrain` 档（偏绿）；EU4 的地形色更偏**灰褐**。要不要另调一条
   「浮雕专用色带」得先有并排对照图，本轮没做。
