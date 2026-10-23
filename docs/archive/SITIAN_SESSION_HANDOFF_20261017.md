# 司天改造进度与交接（2026-10-17，暮雨会话收尾）

> 本文 = 本会话全部工作的交接文档，供方寸派发的下一轮 worker 直接开工。
> 上游文档：`SITIAN_MODULE_REFORM_PLAN_20261017.md`（三大模块改造总方案，暮雨已评审）。
> 机器可验证基线：CDP 回归 **111/111**、Node 单测 **30/30**、`npm run build` 通过（收尾时全量再跑一轮）。

---

## 1. 本轮做了什么（全部落地，非计划）

### 1.1 P0 第一件：剧本卡片墙（ScenarioPicker）—— 已落地，暮雨二测后又修三处

**产品形态**：点「历史剧本」不再直接进编辑器，先见卡片墙（EU4 式选剧本界面）：
缩略图（Canvas 烘焙，暮雨拍板方案 B）+ 罗马数字 + 起止年 + 钩子文案（新 schema 字段 `hook`）+
开局势力条（`openingSituation` 纯函数）+ 底部「进入编辑器 / 返回世界」。

**新增文件**
- `utils/scenarioCards.js` — 开局态势纯函数（`openingSituation` 走 `currentOwnerRef` 跨代查归属；
  `cardYearsText` / `cardHookText`）
- `utils/scenarioThumb.js` — 缩略图烘焙器：**Path2D 按底图缓存**（415 省 2.7 万点只建一次路径）+
  地形栅格共享（1×地形 + N×势力叠加）
- `components/ScenarioPicker.vue` — 卡片墙：**Teleport 到 body**（盖全屏）+ 逐张烘（rAF 帧让出）+
  **中下部浮动进度胶囊**（"正在生成地图缩略图 N / M…"）
- `scripts/tests/cases/test_111_scenario_picker.py` — 回归守卫（源码闸门 8 组 + 行为 4 段）

**改动文件**
- `scenarioEditing.js` — schema 加 `hook`（可选，旧数据无感）；管理表单可写钩子文案
- `ScenarioMap.vue` — props `initialScenarioId` / `openManager`（卡片墙带参进入，320ms 定时器
  排在 resetTimelineToStart 之后）；沉浸模式（Ctrl+I，裸 I 被 Relief 占用）
- `App.vue` — 三态（关 / 卡片墙 / 编辑器），`scenarioMode` 语义不变
- `run_tests.py` — 注入 `__SKIP_SCENARIO_PICKER` 跳过开关（**30+ 既有用例路径逐字不变**，
  全量回归绿即证明；test_111 自己关开关验证产品默认路径）

**暮雨两轮实测反馈与修法（都已进 test_111 闸门）**
| 反馈 | 根因 | 修法 |
|---|---|---|
| 进入卡、无加载提示 | 每张卡重建 2.7 万点路径 ×12 | Path2D 缓存；进度胶囊放**中下部**（一测放标题下没看见） |
| 左下角/左侧导航树露出 | fixed 节点仍在 main-content 内，**入场动画 view-fade-in 的 transform 在动画期间把 fixed 包含块改写成 main-content** | **Teleport to body** |
| （一测后）渲染效果不错 | — | 方案 B（Canvas 烘焙）确认 |

### 1.2 河流编辑两处（暮雨实测「删河卡 + 无视觉提示」）

- **删河卡顿根因**：`removeBaseMapRiver` 等 **8 个河流/道路/聚落写口**用同步 `saveScenarios()` ——
  每点一下当场 `JSON.parse(JSON.stringify(整个项目载荷))`（415 省 + 2.7 万点 + 高度图 ≈ 几百 ms
  主线程阻塞）。已全部换成 `scheduleAutoSaveScenarios()`（300ms 防抖；退出前 `flushSave()` 兜底）。
- **选中无视觉提示**：新增 `drawSelectedRiverHighlight`（光晕 + 亮芯两遍描边）。
  二测反馈「太粗太离谱」—— 根因是线宽增量用了**世界单位**（+8 世界单位在放大 4 倍时 = +32 屏幕
  像素）。已改**屏幕像素口径**（`px()` 换算：光晕 +3.5px、亮芯 +1.2px，任何缩放下都是细描边）。

### 1.3 深度分析文档（本轮开工前的三路并行代码扫描）

- `docs/SITIAN_MODULE_REFORM_PLAN_20261017.md` — 三大模块改造总方案（暮雨已评审"没有太大问题"）
- `docs/assets/galaxy-3d-reference.html` — 3D 星系打样归档（原在 Downloads，暮雨要求"直接抄"）
- `docs/DEVPLAN_LLM_FEED_AND_GALAXY_3D_20261014.md` — 10-14 开发计划归档

---

## 2. 未完成内容（下一轮的活，按优先级）

### 2.1 P0 剧本模块收尾（卡片墙线的剩余）
- [ ] **编辑器 → 卡片墙的返回入口**（现在只能「返回世界」再点一次；应有「换剧本」按钮回到卡片墙）
- [ ] **缩略图缓存**：现在每次进卡片墙都重烘；应按「底图数据版本」缓存到内存/项目文件
- [ ] **卡片墙空态引导**：无底图时（纯新项目）应引导「先导入 .map」而不是只说「去编辑器新建剧本」
- [ ] **真机观感验收**：暮雨只测到二测；三处修复（进度胶囊位置 / Teleport / 高亮粗细）**尚未经他确认**
- [ ] 切片点/书签与卡片墙的联动（卡片上标"有书签 N 个"之类，可选）

### 2.2 P1 行星地图（方案 §2，两断点 + 河流遗留）
- [ ] **起步闭环**：.map 导入入口收进行星视图空态（现在提示指向不可达入口）
- [ ] **保存诚实**：项目模式 staged/persisted 差异显示
- [ ] 自动河流遗留：**路由层平局打破**（梳齿根治）、推演地形要有**山脉走向/高原面/裂谷**、
      汇流复杂度（当前底图上界 22）
- [ ] 用户明确要过没做的：框选批量删河、手画河裁海岸线按钮、多选河可视反馈
- [ ] **省份政治属性 + mapData↔baseMaps 双向**（第二阶段，必须先解决数据闭环）

### 2.3 P2 宇宙星系（方案 §2）
- [ ] 6 个表现层 bug：画布改坐标死代码（提示文案骗人）、势力改色不重绘、星域位置不持久、
      导出与画布不同源、hitTest domain 分支不可达、右键不检查 editMode
- [ ] `faction` 字段无写入路径（势力图例对真实库恒为默认色）
- [ ] 3D 星系图：等 LLM 进料真数据落地后动工，**直接抄** `docs/assets/galaxy-3d-reference.html`
      （Three.js，z 坐标先做渲染派生不动 326 处 coordinate）

### 2.4 技术债（随下轮顺手修）
- [ ] `ScenarioMap.vue` 已 **9800+ 行**（本轮又加了沉浸模式/高亮/props）
- [ ] `test_54` 写闸门契约只查"登记"不查"是否走 execute"
- [ ] `setupState` 不暴露 import 绑定（用例无法直接调纯函数层量产品口径）
- [ ] 判据体系缺**端到端工作流**判据（"从空项目到能玩"整条路）；test_111 是第一枚，但判据仍是
      AI 自写的 —— **用户视角验收脚本**（按暮雨操作路径、不看源码）仍未建立
- [ ] AGENTS.md 未同步本轮变更（卡片墙/沉浸模式/防抖/高亮——交接后第一件事补，本轮上下文预算不够）

### 2.5 暮雨点名「地图编辑器本身的毛病这次没抓但存在」
下一轮开工前**先请他列一份具体清单**，不要 AI 自猜。

---

## 3. 给下一轮 worker 的开工须知

1. **先读** `AGENTS.md`（注意它尚未含本轮变更，以本文为准）+ 本文 + `SITIAN_MODULE_REFORM_PLAN_20261017.md`。
2. **回归命令**：`py -3 scripts/tests/run_tests.py`（系统 Python，非 hermes venv）；
   单跑：`py -3 scripts/tests/run_tests.py test_111`。
3. **harness 跳过开关**：`window.__SKIP_SCENARIO_PICKER`（MOCK_SCRIPT 注入）——
   动卡片墙/入口时**必须保住 30+ 既有用例路径**，test_111 是守卫。
4. **本轮修过的红线**（改这些区域前重读 test_111 闸门注释）：
   - 河流/道路/聚落写口 = 防抖保存，**不许**改回同步 `saveScenarios()`
   - 画布线宽增量 = 屏幕像素口径（`px()`），**不许**加世界单位常数
   - 卡片墙 = Teleport to body，**不许**挪回 main-content 内
   - 缩略图 Path2D 缓存，**不许**每卡重建路径
5. **验收纪律**（本会话两次教训）：AI 判据全绿 ≠ 用户能用 —— 本轮 8 坑 5 个是"判据绿但用户用不了"；
   修复后**必须请暮雨真机实测**，不要拿用例绿当交付。

---

## 4. 本会话改动文件清单（git status 可核）

新增：`utils/scenarioCards.js` / `utils/scenarioThumb.js` / `components/ScenarioPicker.vue` /
`scripts/tests/cases/test_111_scenario_picker.py` / `docs/SITIAN_MODULE_REFORM_PLAN_20261017.md` /
`docs/assets/galaxy-3d-reference.html` / `docs/DEVPLAN_LLM_FEED_AND_GALAXY_3D_20261014.md`

修改：`store/geodataModules/scenarioEditing.js`（hook 字段 + 8 处保存防抖）/
`components/ScenarioMap.vue`（props + 沉浸模式 + 选中高亮 + 管理表单 hook 行）/
`components/ScenarioPicker.vue`（Teleport + 进度胶囊）/ `App.vue`（三态接线）/
`scripts/tests/run_tests.py`（跳过开关）/ `scripts/tests/cases/test_111_scenario_picker.py`（闸门扩充）
