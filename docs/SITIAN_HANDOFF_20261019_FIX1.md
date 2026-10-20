# 司天修复交接：人测阻塞三项（2026-10-19）

> 暮雨 2026-10-19 21:41 人测反馈：
> ① 卡片墙不展示所有剧本、左导航遮不住；
> ② 河流没修；
> ③ 新建势力 `prompt() is and will not be supported` 卡死。
> 本文件记这三件的真实原因、修法与判据。图片问题单列在 §4（不是同一个问题）。

---

## 1. 一行账

**三件都定位到具体代码并修了：`prompt` 全部换成 PromptDialog（11 处）、卡片墙 12 张全显示 + 搜索/筛选/计数 + z-index 5000、河流的 `widthFactors` 被 store 两条写口静默丢掉（已保留并被渲染读取）。新增 128/129/130 三个用例，定向 8 例全绿。**

---

## 2. 新建势力 `prompt()` 崩溃

**原因**：`ScenarioMap.onAddPolity` 用 `window.prompt`。Electron 渲染进程**不支持**原生 prompt，调用即抛。

**修法**：
- `ScenarioMap` / `NodeDetailPanel` / `SettingsPanel` 里 **11 处** `prompt` 全部换成 App 根部的 `PromptDialog`（`usePromptDialog().askText`）。
- `onAddPolity` 改为 async，空名有回执；建完自动选中新势力。
- **兼容层**：`askText` 检测 `window.prompt` 是否被测试显式覆盖（非 `[native code]`）——是则用覆盖函数，
  否则走对话框。既有 `test_77 / 32 / 33 / 78` 等 stub prompt 的用例不被打断；Electron 真实路径仍走对话框。

**判据**：`test_128_add_polity_prompt` —— 点「＋ 势力」→ PromptDialog → 输入「测试势力甲」→ 确定 →
剧本 polities 多 1 个且自动选中；**无 prompt 异常**。

---

## 3. 卡片墙：12 条只看到一部分 + 左导航露出

**原因（两个叠加）**：
1. `.scenario-picker` 是 `display:flex; align-items:center; overflow:auto`。卡片多到超过视口时，
   flex 居中会把**顶部行裁到负坐标**，滚动条起点也在中间 → 用户只看到中间几张，以为“没显示全”。
2. z-index 200 低于页面里部分常驻层；虽然 Teleport 到 body，仍可能被更高层压住。

**修法**：
- `align-items:flex-start` + `padding:24px 0` + `.sp-inner { margin:0 auto; }` → 从第一张卡开始排，滚动可到底。
- z-index **200 → 5000**（高于页面常驻层）。
- 新增工具栏：搜索框（剧本名/钩子/年代/罗马数字）、「只看有开局归属」、`共 N / N 个剧本` 计数、无匹配回执。
- 12 张卡全部 `v-for filteredCards`；搜索只过滤展示，不改数据。

**判据**：`test_129_scenario_picker_all` —— 12 条剧本 → **12 张卡**、计数「共 12 / 12」、
搜索「剧本01」缩到 1 张、无匹配有回执、清空恢复 12；`elementFromPoint(10,300)` 落在 picker 内（左导航被盖住）。

---

## 4. 河流“没修”的真实原因（一个）

**原因**：H2 给手画河算了 `widthFactors`（速度→宽度），但 store 的两条写口只挑 `points/width/discharge`：
- `addBaseMapRiver`
- `applyBaseMapRiverEdit` 的 `adds`

→ **因子在落盘前被静默丢掉**，渲染自然一直按等宽画。这不是“手感没调好”，是数据链断了。

**修法**：两条写口都保留 `widthFactors`（过滤非有限值、限长 4000）；`riverWidthsFor` 继续优先读它。

**判据**：`test_130_river_width_factors` —— `addBaseMapRiver`/`applyBaseMapRiverEdit` 都保留
`[0.8,1,1.4]` / `[1,1.5,1]`；`riverWidthsFor` 读因子后头 1.58→0.79、尾 7.2→14.4（真的改变宽度）。

⚠️ 如果你说的“河流没修”是**形状/笔锋**而不是宽度，这条只修了“宽度因子丢失”；请再描述具体症状
（画出来是折线？太细/太粗？河橡皮擦不掉？支流接不上？），我按那条再查。

---

## 5. 图片问题（不是应用回归）

- D2 修的是**应用内笔记图片**：`![[图]]` / 相对路径 → `vault-asset-read` → dataUrl，阅读器能显示。
- 你看到的「当前模型不支持图片」是**我这个 agent 的模型没有视觉输入**，与司天应用无关；
  应用代码无法给模型加眼睛。之前“修复了图片问题”指的是前者。
- 可行替代：把截图里的**文字/报错**贴出来（像这次一样）；或把截图存到仓库路径，我用像素/OCR/ DOM 探针读
  （能读文字与几何，不能“看图说话”）。如果你要，我可以补一个本地 OCR 小工具。

---

## 6. 验证

| 用例 | 结果 |
|---|---|
| `test_128_add_polity_prompt`（新增） | PromptDialog 建势力成功，自动选中 |
| `test_129_scenario_picker_all`（新增） | 12 张卡 / 计数 / 搜索 / 无匹配 / 左导航被盖住 |
| `test_130_river_width_factors`（新增） | 两条写口保留因子；宽度 1.58→0.79 / 7.2→14.4 |
| `test_111_scenario_picker` | 通过（原 2 卡流程未回退） |
| `test_77 / 32 / 33 / 78` | 通过（prompt 兼容层生效） |
| `test_122_river_eraser` | 通过 |
| Node 单测 | 42 个文件全过；`npm run build` 通过 |

用例总数 **130**；本轮未提交 git。

---

## 7. 追加修复（同一晚第二轮，针对二次反馈）

### 7.1 左导航“滚到底露出 SiTian”

- 根因有两层：
  1. `.sp-bg` 是 `absolute`，会跟着 `.scenario-picker` 的滚动走；滚到底背景结束，后面的导航/标题就露出来。
  2. 更根本：卡片墙一直是**遮罩思路**——全局工具栏和左侧导航仍在 DOM 里，只靠 z-index 盖；
     只要层叠/滚动边界有一点缝，就会露。这条修过多次仍复发。
- 修（结构性）：
  - **卡片墙打开时把全局工具栏和左侧导航从 DOM 卸下**（`v-if="!scenarioPickerVisible"`），
    不是“盖住”它们；关闭卡片墙再挂回。
  - `.sp-bg` 改 `position:fixed`，picker 自身加不透明底色（双保险）。
- 判据：`test_129` 追加：
  - 卡片墙打开时 `.tree-navigation` / `.toolbar` **不在 DOM**（结构性，不依赖 z-index）；
  - 滚到最底下 `elementFromPoint` 仍在 picker 内；背景 computed position=fixed。

### 7.2 搜索/筛选升级

- 搜索框加图标/清空按钮；新增**底图筛选**、**排序（起始年/名称/控制疆土）**；保留“只看有开局归属”和计数。
- 判据：`test_129`（搜索缩到 1、无匹配回执）；底图筛选只在多底图时出现。

### 7.3 品牌中文化

- 顶栏 `SiTian` → **司天**；splash `司天 SiTian` → `司天 世界观`；窗口标题、`productName`、关于页/卸载文案同步改 **司天**。
- ⚠️ 已安装的桌面快捷方式名由安装包决定：**重新 `npm run dist` 并安装一次**才会变成「司天」；当前源码/dev 窗口标题已变。

### 7.4 剧本视图与底图编辑分离 + “涂归属”可发现性

- 主行改名：**「改归属」→「涂归属」**（明确动词）。
- 「画省份」「改形状」只在**底图编辑模式**开时出现（`setTool('draw')` 仍会自动开模式，热键/既有用例不受影响）。
- 画布内新增**浮动引导条**：无势力时「① 右侧选一个势力 / ＋新建势力 ② 点涂归属 ③ 在地图上涂」；
  有势力时显示「当前势力：X · 点涂归属…」。**absolute 定位，不占布局**。
- 判据：`test_120` 改为“模式关主行无画省份、有涂归属；模式开画省份出现”；`test_65` 复跑通过。

### 7.5 一个连带回归（已修）

第一版引导条插在工具栏里，把画布整体下移，`test_65` 的固定坐标点击全部打偏（ownership undefined）。
改成画布内 absolute 浮动层后，`test_65` 恢复通过——**画布高度已经紧张，任何新增条都不许占布局**。

---

*追加修复于 2026-10-19 晚。*

