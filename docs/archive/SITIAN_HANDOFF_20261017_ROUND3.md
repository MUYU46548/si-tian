# 司天：2026-10-17 第三轮进度与交接（卡片墙收尾 + 河流线宽口径）

> 上一轮交接文档：`docs/SITIAN_SESSION_HANDOFF_20261017.md`（读它了解 P0/P1/P2 全貌与三条红线）。
> 本文 = **本轮（第三轮）**做了什么、量到了什么、还差什么。
> 机器基线：CDP 回归 **112/112**、Node 单测 **31/31**、`npm run build` 通过（详见 §5）。

---

## 1. 本轮改了什么（全部落地，逐条有判据）

### 1.1 P0-1 编辑器 → 卡片墙 的返回入口（「换剧本」）

- `ScenarioMap.vue` 剧本列表头部加 `data-testid="slp-picker"`「换剧本」（沉浸顶条另有 `imb-picker`）→ 发 `picker` 事件 →
  `App.backToScenarioPicker()`。此前从编辑器回卡片墙要「返回世界 → 历史剧本」三步。
- 🔴 **没有**把 `← 返回` 改成回卡片墙：它的语义是**离开剧本域**（去世界选择页），混成一个按钮会出现"想回世界却被留在剧本域"。
- 回卡片墙时**清掉 `scenarioInitialId` / `scenarioOpenManager`**（一次性进入载荷；不清会让下次点卡片莫名弹管理对话框）。
- ⚠️ 按钮放 `.slp-head` 而非工具栏主行 —— 主行受 P3「恰好 6 个可见控件」闸门管（`test_65` / `test_97`）。

### 1.2 P0-2 缩略图成品缓存 + 态势面积索引（进卡片墙不再等）

| 项 | 之前 | 现在 | 判据 |
|---|---|---|---|
| 第二次进卡片墙的缩略图 | 每张重画（Path2D 每实例重建） | **一次 `drawImage`**（模块级成品位图缓存，键 = 内容签名） | `test_111` f 段：`thumbCacheStats()` hits 0→2 且 **misses 不变** |
| 卡片态势（开局势力） | 每条剧本把同一份净面积重算一遍 | `provinceAreaIndex()` 算一次、逐条复用 | `_probe_picker_perf.js`：**1058.8ms → 3.6ms（294×）**；Node `test_scenario_cards.js` 用**计数 getter** 守（共享索引时几何读 **0** 次 / 逐条现算 **800** 次） |
| 命中缓存时 | 仍逐张让出 rAF（白等 N 帧） | **不让出**（`if (!cached) await rAF`） | `test_111`：第二次进墙 `烘图中…` 残留 = 0 |

- 签名是**全量哈希**（省份点列 / 高度图 h / 河流点 / 剧本归属与势力色；量化到 1/64 世界单位）。
  ⚠️ 不许改成抽样或只看长度 —— 那种失效表现是「图看着对但其实是上一版」。
- 面积索引**每次算卡片时重建**，不跨渲染缓存（缓存几何派生值 = "面积悄悄是旧的"）。

### 1.3 P0-3 空态分流 + 空态里能点的按钮

- 卡片墙空态按「项目里有没有底图」分两支：有底图 → 引导建剧本；**没有底图 → 说清"剧本画在底图上"并引导导 .map**。
- 🔴 **真按钮**：`ScenarioMap` 空态补 `data-testid="empty-import-map"`（→ `triggerMapImport()`）与 `empty-new-basemap`（→ 懒建空底图）。
  旧提示写「用上方「+」导入」，而「+」在默认收起的「更多」面板里 = **提示指向一个当刻看不见的入口**（行星视图同一类问题）。
- ⚠️ 空态容器是 `pointer-events: none`（不许挡住画布），里面的按钮必须逐个 `pointer-events: auto`，否则是"看得见点不动"的假按钮。

### 1.4 🔴 河流线宽：屏幕像素口径的**成对**换算（本轮抓出的真缺陷）

暮雨上一轮报「选中的河放大后太粗太离谱」。上一轮只改了**增量**（`+8 世界单位` → `px(3.5)`），**本轮逐像素实测发现只修了一半**：

```
改前（_probe_river_highlight.js，同一条河、逐像素比"选中 vs 未选中"的差异宽度）
  1× = 8px     2× = 11px     4× = 18~19px     ← 高亮跟着缩放一起变粗
改后
  1× = 8px     2× = 8px      4× = 8px         ← 屏幕像素口径（河宽 3.6 + 光晕 3.5 + 抗锯齿）
```

根因：画布此处已 `ctx.scale(cameraScale)`，`lineWidth` 的单位是**世界单位**，而 `basemapRiverWidthPx()` 返回的是**屏幕像素数**——
`drawRivers`（地图自带河）与 `drawSelectedRiverHighlight`（选中高亮）**一直**把屏幕像素数直接塞进 `lineWidth`（注释却写着"不随缩放变粗"）。
修法：两处都过 `basemapRiverWidthWorld(r, cameraScale.value)`。**副带修好**：自带河在放大时也不再变粗
（高亮 = 自带河宽 + 光晕，所以实测的 18~19px 里就含自带河那 3.6×4≈14.4px —— 这一项是**按公式推的**，
`test_112` 量到的是"自带河色像素横截面 1×/2×/4× = 3/3/1px"，量法对细线偏保守，故以公式+高亮实测两边互证）。
⚠️ **自动河那一侧（`strokeRiverNetworkAsPaths`）第八修已经修对，自带河这一侧漏了** —— 又一次「同一个能力两个消费者只接一个」。
⚠️ 同类嫌疑未动：`ROUTE_STYLES.width`（道路 0.9 / 0.5 世界单位）没换算 —— **未实测前不许改**（可能刻意让道路随缩放变粗）。
新增守卫：`test_112_river_screen_width.py`（源码闸门 + 1×/2×/4× 三档像素判据：亮芯宽度、光晕差异宽度、自带河宽度都必须基本相等）。

### 1.5 出图与量尺工具（临时件，`scripts/tests/tools/`）

- `_shot_story_20261017.py` —— **故事线出图器**（Python 侧控制出图时机）。为什么需要：`_lab.py` 一次只出最后一张图，而本轮要看的
  全是**过程态**（加载胶囊、空态）。页面侧 async 故事线用**不 await** 方式启动（`cdp.eval` 带 awaitPromise，直接 await 会把 Python 侧堵死）。
  产物：`docs/assets/story-20261017/01..09-*.png`（9 张：卡片墙烘图中 / 烘完 / 编辑器 / 缓存命中回来 / 无底图空态 / 编辑器空态 / 河流 1× / 4× / 4× 量完）。
  ⚠️ 出图前必须先关掉 **RecoveryPanel**（`localStorage` 残留备份时全屏弹出，`z-index 1100` 盖住一切，`elementFromPoint` 全指向它）。
- `_probe_picker_perf.js` —— 卡片墙逐段计时（就是它揪出"面积算 10 遍"）。
- `_probe_river_highlight.js` —— 1×/2×/4× 逐像素量高亮宽度（就是它证明"只修了一半"）。

---

## 2. 本轮读数存档（可复现）

| 读数 | 值 | 出处 |
|---|---|---|
| 卡片态势 10 条剧本（400 省） | 1058.8ms → **3.6ms**（索引一次 103.5ms） | `_probe_picker_perf.js` |
| 缩略图缓存 | hits 10 / misses 10（第二次进墙 hits +10、misses 不变） | 同上 / `test_111` |
| 选中高亮屏幕宽度 | 1× 8 / 2× 11 / 4× 18 → **8 / 8 / 8** | `_probe_river_highlight.js` |
| 进度胶囊位置 | 文案「正在生成地图缩略图 2 / 10…」，cx=640（视口中心）、底距 96px（= 12vh） | `_shot_story_20261017.py` |
| 卡片墙盖全屏（结构判据） | `parentElement === body`、`closest('.main-content') === null`、左侧导航树中心点命中 = 卡片墙 | 同上 / `test_111` |
| 空态按钮可点性 | `pointer-events: auto`、按钮中心点 `elementFromPoint` = 按钮本身 | 同上 / `test_111` |

---

## 3. 本轮的方法论教训（写进 AGENTS.md 了，这里留档）

1. 🔴 **本会话模型没有图像输入**（`read_image` 直接报"model does not declare image input"）→ 不能靠眼睛看截图。
   替代口径 = **像素级数值判据（在页面里量、落进用例）+ 出图存档交人看**；观感类结论必须同时给出"数值 + 图 + 未确认项"。
   **不许把"我读过代码"说成"我看过画面"。**
2. 🔴 **"注释说的"和"代码做的"要分开验**：`drawRivers` 的注释写着"线宽走屏幕像素（不随缩放变粗）"，代码却是世界单位 ——
   五轮都没人发现，因为它**只在缩放 ≠ 1 时才看得出来**（1× 下两种口径数值相同）。
3. 🔴 **修"太粗/太细"这类口径问题，要把式子拆成两项分别验证**：只改了增量（`px(3.5)`）没改基数（`baseW`），量出来就是"改了一半"。
4. 🔴 **临时出图脚本也会被 UI 浮层骗**：RecoveryPanel 全屏 + `z-index 1100` 时，`elementFromPoint` 全指向它，截图也全是它。
   任何"盖全屏"的判据都要先确认**没有别的浮层盖在上面**。

---

## 4. 未完成 / 待暮雨确认

- [ ] **真机观感确认（最重要）**：本轮 9 张图在 `docs/assets/story-20261017/`，请暮雨过一遍 ——
      尤其 **04-picker-cached**（第二次进墙是否真的"立刻"）、**05/06 空态**话术是否到位、**07/08 河流高亮**粗细是否合适。
- [ ] 上一轮遗留的 P0-3「**编辑器 → 卡片墙的返回入口**」已做，但**缩略图缓存落盘**（跨会话）没做：现在是内存缓存，重启司天第一次进墙仍要烘。
- [ ] P1 行星地图：.map 导入入口收进行星视图空态、保存诚实显示、自动河流遗留（平局打破 / 推演地形结构）、
      **框选批量删河 / 手画河裁海岸线按钮 / 多选河可视反馈**（暮雨点名要过的）。
- [ ] P2 星系：6 个表现层 bug、`faction` 无写入路径、3D 星系图（打样在 `docs/assets/galaxy-3d-reference.html`）。
- [ ] 技术债：`ScenarioMap.vue` 已 **9900+ 行**；`test_54` 只查登记不查是否走 execute；缺**用户视角验收脚本**。
- [ ] 🔴 **暮雨点名的「地图编辑器本身的毛病」**：交接文档 §2.5 写的是"下一轮开工前先请他列清单，不要 AI 自猜" ——
      本轮仍未拿到清单（本轮所做的是**清单之外**、已明确写进文档的三件 + 一处实测缺陷），**下一轮开工前请先给清单**。

---

## 5. 机器基线（本轮收尾实测）

| 项 | 结果 |
|---|---|
| CDP 回归 | **112/112 通过**（`py -3 scripts/tests/run_tests.py`；新增 `test_112_river_screen_width`，扩写 `test_111` 至 a~g 七段） |
| Node 单测 | **31/31 通过**（新增 `unit/test_scenario_cards.js` 6 条） |
| `npm run build` | ✓ built in 4.04s（`dist/` 已重建） |
| 收尾卫生 | `src/renderer/index.html` 未被 mock 污染（无 `.bak` 残留）、5180/9222 端口已释放 |

- 本轮改动文件：`src/renderer/src/App.vue` / `components/ScenarioMap.vue` / `components/ScenarioPicker.vue` /
  `utils/scenarioThumb.js` / `utils/scenarioCards.js`
- 新增：`scripts/tests/cases/test_112_river_screen_width.py`、`scripts/tests/unit/test_scenario_cards.js`、
  `scripts/tests/tools/_shot_story_20261017.py`、`_probe_picker_perf.js`、`_probe_river_highlight.js`、`_shot_stats.py`
- 扩写：`scripts/tests/cases/test_111_scenario_picker.py`（源码闸门 6 组 → 增四条 + 行为段 f/g）
- 同步：`AGENTS.md`（补记前两轮未同步的内容 + 本轮四条；用例数 105→112、Node 单测 29→31）
- 出图存档：`docs/assets/story-20261017/01..09-*.png`（9 张，**已按修好的代码重跑**；纯像素读数见下方）

### 5.1 出图存档的像素读数（没有图像输入时的替代口径）

`py -3 scripts/tests/tools/_shot_stats.py` 直接读 PNG：

| 图 | 左列（0..200px，导航树所在） | 中下胶囊带（bottom 12vh） |
|---|---|---|
| 01-picker-baking | 均值 22.9 / 色数 382 | 均值 32.3、**亮像素 1034** ← 进度胶囊在场 |
| 02-picker-baked | 同上 | 均值 29.0、亮像素 362 ← 胶囊已消失（烘完） |
| 04-picker-cached | 同上（与 02 逐项一致） | 均值 29.0、亮像素 362 ← 缓存命中后立即完整 |
| 05-picker-empty | 均值 12.3 / **方差 0.8** / 色数 23 | 无胶囊 ← 空态是干净背景（导航树未露） |
| 03/06/07/08/09-editor | 均值 34.6（编辑器自己的左栏） | — |

⚠️ **这不能替代人的眼睛**：读数只证明"该有的在场、不该有的不在"，判断"好不好看"仍需暮雨看图。

