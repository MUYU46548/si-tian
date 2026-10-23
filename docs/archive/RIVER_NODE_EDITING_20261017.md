# 剧本底图河流节点编辑 + 实时平滑预览（2026-10-17）

> 本轮起因：暮雨说「请继续。河流已经花了好几次会话去修了，前后成本已超过 20 元，别让我失望」
> +「把河流绘制其他未完成的内容也做完，一并汇报」。
>
> 上一轮（`RIVER_AND_UNFINISHED_20261016.md` §3.7）自己列的三项收口：
> **剧本底图的节点编辑** / **画的时候实时看到平滑** / **删除单个节点** —— 本轮全部做完。
>
> 🔴 但**核实出来的问题比那三项更严重**：剧本底图的"画河"手势**根本没接完**。

---

## 1. 🔴 先说实话：上一轮那条"已接线"其实只接了一半

上一轮的报告写着「**剧本底图**：拖笔收点加最小间距…抬笔时抽稀 + 平滑再落库」。
本轮**读代码 + 真机探针**逐个核实，结论是：那条描述与真机行为不符。

| 我以为的 | 代码里的实际 | 真机后果 |
|---|---|---|
| 拖笔连续收点 | `onMouseMove` 里**根本没有 river 分支** | 「按住拖出笔迹」**画不出来** —— 只有 `onMouseDown` 每按一下落一个点 |
| 抬笔收口落库 | `finishRiverDraft()` **只挂在小双击上**（`onCanvasDblClick`） | 画布提示写着"按住拖出笔迹"，**松手什么也不发生** |
| 落点在底图上 | `onCanvasClick` 的 river 分支排在 `if (viewMode !== 'scenario' \|\| !selectedScenario) return;` **之后** | `viewMode` 初值就是 `'base'`（`const viewMode = ref('base')`）→ **底图模式下这一整条链一次都进不去** |

**真机探针复现**（`scripts/tests/tools/_probe_basemap_river_ui.js`，改之前）：
`viewMode='base'` → 点画布 → `riverDraft` 涨到 2、`baseMap.rivers` **仍然是 0**。

**怎么被漏掉的**：`test_95` 的端到端判据是
`sc.riverDraft = [...]; sc.finishRiverDraft();` —— **直接调组件内部函数**，
于是"函数本身是对的"被证明成了"这条路是通的"。
（本项目第五次踩同一类：**判据要量"用户做了什么"，不能只量"某个函数被调用后结果对不对"**。）
所以本轮新用例 `test_106` 的 c 段**全部用真鼠标事件驱动画布**，一个内部函数都不直调。

---

## 2. 本轮做了什么

### 2.1 store：补上"改已有河"这个**写口**（底图侧此前只有 add / remove）

新增 `scenarioEditing.updateBaseMapRiver(baseMapKey, riverId, patch, opts)`：

- `patch.points` = 换点列（拖节点 / 加拐点）；
- `opts.removeNodeAt` = 删某一个节点（**在 store 内算**，组件只报"删第几个"）——
  组件自己先算再传 `points` 会让同一份数据有两条算路（本项目反复踩过）；
- 删点后**线宽随点数重算**（与 `addBaseMapRiver` 落库同一口径，否则"越长越宽"会悄悄失真）；
- 一次编辑 = **一条 undo**（undo 恢复整份河流列表快照 —— 就地只改一条在撤销时无法还原**位置**，
  而数组顺序就是渲染层叠顺序）；
- 幂等：点位没变 → `changed:false`，**不往撤销栈里塞空条目**；
- 找不到 id / 底图不存在 / 只剩 2 点 → 三种**明确回执**，不静默；
- 已登记进 `writeGate.MEMORY_WRITE_CALLSITES`（只读态拦得住）。

🔴 **字段口径是 `points` 不是 `nodes`**（这一脚很隐蔽）：底图河的唯一载荷口径由
`normalizeBaseMapRivers` / `addBaseMapRiver` / `drawRiverPaths` 三方约定为 `{points,width,discharge}`；
写 `nodes` 的后果是**数据确实改了、画布一动不动**（不报错）。
`test_106` 有源码红线守这一条。

### 2.2 组件：三个手势补齐（这才是"随心所欲画河流"）

| 手势 | 之前 | 现在 |
|---|---|---|
| 按住拖 | **没有这条代码** | `onMouseMove` 每次移动按**屏幕 6px** 最小间距采点 |
| 松手 | 什么都不发生 | `onMouseUp` → 抽稀 + Chaikin 平滑 → 落库（**一条 undo**），并**自动选中**这条新河 |
| 点河身 | 底图模式下完全进不去 | 第一次点=选中；再点=在最近**线段**的投影处**加拐点** |
| 拖节点 | 无 | 悬停变黄 → 按住拖动（**拖动期间只动草稿**，松手才一条 undo） |
| 删一个节点 | 无 | 悬停到节点 + `Delete`（或面板按钮） |
| 删整条 | 只能靠"删了重画" | 没有活动节点时 `Delete`（或面板按钮），一条 undo 可回滚 |

🔴 **拖动为什么用"草稿"而不是就地改 `selectedRiver.points[i]`**：
实测就地改**不生效**（日志里 `commit changed=true`，而 store 里的点纹丝不动）——
拖动期读到的那条河**不保证是 store 里那条对象**（本仓在项目↔画布接线上踩过同款：
按引用持有的"当前节点"会脱钩）。改成显式草稿后，"画什么"与"存什么"各有唯一来源，
也不再依赖对象身份。与同文件顶点拖动的 `dragPreview` 同款。
`test_106` 的 c3 段有三个判据把这条钉死：拖动期 store 不动 / 预览走草稿 / 松手后坐标真的变。

### 2.3 实时平滑预览（两图 + 拖笔那条路）

新增 `polylineSmooth.smoothWhileDrawing(nodes, iterations, tailLen)`：

- **只平滑尾部窗口**（不是整条）：整条每帧重算会让"已经画完的部分"一直蠕动；
- 交接点留在窗口里（否则平滑段与稳定段之间会出现一个**没人切过的角**）；
- 稳定段**逐字定格** —— 单测里用"追加一个点后前 18 个输出点必须完全相同"来守，
  并配一条反证（窗口开满 → 整条会重算，证明判据有判别力）。

接上之后：

- **剧本底图**：笔迹预览走 `smoothWhileDrawing`（以前预览是折线、落库才变曲线，
  用户按他看到的形状判断好不好看，一松手形状突然变了）；
- **行星图**：新增 `riverDraftPreview` —— 🔴 这里发现同一类漏接：**拖笔画河在画布上什么都看不到**
  （`riverBrushPath` 只进 `riverBrushEnd`，绘制层读的是 `riverDraftPoints`）。
  现在"拖笔"与"描点"两条路都汇到 `riverDraftPreview` 进绘制层。

### 2.4 顺手修的：`smoothRiverNodes` 会给**没有海拔**的数据伪造 `h: 0`

底图河存的是 `{x,y}`（没有海拔概念），而 `smoothRiverNodes` 原来无条件补 `h: 0`
→ 每存一条底图河都往项目文件塞几百个 `"h":0`（体积 + 一个"它有海拔"的假信号）。
现在按"输入里任何一点有有限 h"决定（有 h 才补，没 h 就不出现这个字段）。
反向探针：有一个点带 h 时，输出必须**点点有 h**（行星图那条路行为不变）。

### 2.5 单源收敛：`distanceToPolyline` / `hitTestRiver` 下沉

`PlanetMap.vue` 里私有的 `distanceToPolyline` 与 `hitRiver` 下沉到 `utils/rivers.js`
（新增 `hitTestRiver(list, x, y, radius, nodesOf)`），行星图改为 import 同一份。
理由：剧本底图这次也要做河身命中 —— 再抄一份就是"同一件事两套实现"，
而这类偏差**不会报错**，只会让"两张图里点河身的手感不一样"。
`test_106` 有红线守"组件里不许再出现私有副本"。

---

## 3. 回归与验证

**106/106 CDP + 30 个 Node 单测全绿**（用例总数 105 → **106**，本轮新增 `test_106`；
Node 单测文件仍 30 个，但"河流编辑器节点操作"那个文件的用例 13 → **18 条**）。
`dist` 已重建，并逐文件核验新代码真的进了产物
（`ScenarioMap-*.js` 含 `river-edit-row` / `updateBaseMapRiver`；`PlanetMap-*.js` 含 `riverDraftPreview`）。

- Node 单测（`scripts/tests/unit/test_river_editor_nodes.js`，**18 条**）新增 5 条：
  `distanceToPolyline`/`hitTestRiver`（含"线段口径 vs 顶点口径必须可区分"）、
  `replaceRiverNode`（不改入参 / 越界 / **h 不凭空冒出来**）、
  `smoothWhileDrawing` 两条（笔尖段真的切角 84°→24°、稳定段逐字定格 + 开满窗口作反证）。
- CDP `test_106`（4 段 20 源码闸门 + 6 类 store 边界 + 13 条真事件驱动的 UI 判据）。

⚠️ **本轮两次假红/白查，都留档在代码注释里**（都是"我自己算错"而不是产品缺陷）：
1. **探针手写坐标换算**：`sc.cameraX + wx * sc.cameraScale` —— `sc` 是组件实例代理，
   **ref 不会在那里解包**，于是变成 `[object] + wx * [object]`，点在了别处，
   我以为"节点拖不动"。为此加了产品侧的 `worldToScreen()`（与 `screenToWorld` 互逆），
   探针与产品从此走同一个换算。
2. **探针用旧 `getBoundingClientRect()`**：切到河流工具会多出一行「河流编辑」→ 工具栏变高 →
   画布下移 40px，旧 rect 让后续点击整体偏一行。
   纪律：**每次交互前重读 rect**（已写进 `test_106` 的注释）。
3. **单测判据量错口径**：`smoothWhileDrawing` 的稳定段长度我按"每输入点经 2 轮变 4 点"算成 68，
   实测首个变化下标是 17 —— Chaikin 的输出点序**不与输入点一一对应**，只能量**实测下标**。

---

## 4. 河流绘制"还差什么"—— 三条候选，**我不自己定**

| # | 事项 | 现状 | 成本的量级 | 我的建议 |
|---|---|---|---|---|
| 1 | **手画的河不裁海岸线** | 自动河已裁（第五修），导入河已裁，**手画的完全没裁** | 中（要新写一条写口 + undo + UI + 用例） | **可做**：给河流编辑行加一个「裁到海岸线」按钮（覆盖该底图全部手画河，一条 undo）。⚠️ 但这是**你的意图问题** —— 有人就是想让河画进海里（三角洲/入海口）。所以做成**按钮**而不是自动行为 |
| 2 | **`riverTrace.opts.upsample`** | 完整实现 + 注释齐全，**全仓零调用** | 小（接一个下拉） | 🔴 **不建议接**：上一轮已实测"放大 ×2/×3 → 河更碎"（河 12→116→405、最长 140→110→103）。接出来只会让你以为"河变好了"，其实更差。建议**照实删掉**或标注为实验开关 |
| 3 | **自带河与自动河"两套水系"** | 已给三档开关（两套都画 / 只画自带 / 只画自动） | 大（要给自动河做"按自带河走向排斥"） | 等你用过三档开关再说 —— 现在**不替你选**是对的 |

其余"河流绘制"相关的未接线项在 `docs/RIVER_AND_UNFINISHED_20261016.md` §3.2 / §3.3 两张清单里
（切片点 CRUD、`countMarkersOfType`、若干真死代码），它们与"画河"无关，属于别的批次。

---

## 5. 本轮改了什么（代码）

| 文件 | 改动 |
|---|---|
| `store/geodataModules/scenarioEditing.js` | 新增 `updateBaseMapRiver`（改点 / 删点 / 幂等 / 三种明确拒绝）+ 导出 |
| `store/writeGate.js` | 写口契约登记 `updateBaseMapRiver` |
| `utils/rivers.js` | 新增 `distanceToPolyline`（从 PlanetMap 下沉）、`hitTestRiver`、`replaceRiverNode` |
| `utils/polylineSmooth.js` | 新增 `smoothWhileDrawing`（尾部窗口）；`smoothRiverNodes` **不再给无海拔数据伪造 h** |
| `components/PlanetMap.vue` | 河身命中改用共享 `hitTestRiver`；删除私有 `distanceToPolyline`；新增 `riverDraftPreview`（拖笔时画布上看得见）；`riverBrushPath` 收点带 h |
| `composables/planetDrawing.js` | 河流草稿改读 `riverDraftPreview`（两条路都看得见） |
| `components/ScenarioMap.vue` | 重做河流手势：`onMouseDown`（起笔/命中节点）、`onMouseMove`（连续采点 + 悬停高亮）、`onMouseUp`（松手成河 / 收拖动）、`onCanvasClick`（**前移到剧本闸门之前** + 选中 / 加拐点）、`onKeyDown`（ Delete 删节点 / 删整条）、`worldToScreen`（互逆换算，供探针与产品共用）、`riverNodesForRender`（拖动期画草稿）、节点标记绘制、**可见的「河流编辑」行**（两个按钮带文字） |
| `scripts/tests/unit/test_river_editor_nodes.js` | 13 → **18 条** |
| `scripts/tests/cases/test_106_basemap_river_nodes.py` | **新增**（20 源码闸门 + 2 红线 + 6 store 边界 + 13 真事件 UI 判据） |
| `scripts/tests/run_tests.py` | `setup_mock` 加**二次注入闸门**（见下） |
| `scripts/tests/tools/_probe_basemap_river_ui.js`、`_lab.py` | 新增诊断工具（见下） |

### 5.1 ⚠️ 顺手补的一条工具纪律：`index.html` 是**共享可变状态**

本轮我起了 `_lab.py`（常驻 Vite+Edge 的快速探针台）做迭代，与 `run_tests.py` **同时**用同一套 mock
→ 两边的 `index.html.bak` 互相覆盖 → 收尾时把**注入了 mock 的 index.html 当成原始文件**留下，
工作区里多出 891 行注入脚本而 `.bak` 已不存在（谁也不知道原始文件在哪）。
现在 `setup_mock()` 会在动手前**当场说清**并拒跑（发现 `.bak` 已存在、或文件里已有
`window.__SITIAN_MOCK__` 却没有 `.bak`），而不是十几分钟后留下一个被污染的工作区。

### 5.3 ⚠️ 一次意外重启的收尾（机器重启，不是代码问题）

全量回归跑到 **8:05** 时机器意外重启（`LastBootUpTime = 8:09:04`），于是 `run_tests.py`
被硬切断在收尾之前 —— 留下**工作区里仍带着 mock 的 `index.html`**（`.bak` 与 `mock-data/` 也在）。
重启后我做的事（**这条流程请照抄，因为它的判据是"内容"而不是"有没有 .bak"**）：

1. **先验 `.bak` 是不是真原始文件**：`Select-String index.html.bak -Pattern '__SITIAN_MOCK__'`
   → 命中就说明 `.bak` 也是被污染的那份，必须改用 `git checkout -- src/renderer/index.html`；
   没命中（本次）才可以直接拷回去。
2. 拷回 + 删 `.bak` + 删 `mock-data/`，再用 `git diff --name-only src/renderer/index.html` 复核"与 HEAD 一致"。
3. **确认源码改动一行没丢**（`git diff --stat` 对 7 个文件 + 4 个新增文件逐个点名）——重启只影响
   进程，不影响已落盘的编辑；但**必须核对**，不能假设。
4. **重跑整套回归**（上一次的中间结果不可用：它没跑到收尾，也没有汇总行）。

### 5.4 新增诊断工具（真机快速迭代用，不是回归用例）

- `scripts/tests/tools/_lab.py` —— 常驻 Vite + Edge，反复跑一小段探针 JS 的小台子
  （`up` / `run <file.js>` / `down`）。它替掉"每改一行都付一次十几分钟的整套回归"。
  ⚠️ **与 `run_tests.py` 互斥**（见 5.1）；跑完一定 `down`。
  ⚠️ **改完源码要硬重载**（脚本里已带 `?lab=<ts>` 破缓存）：我为此白查过一轮
  "产品缺陷"，其实是页面还跑着改之前的代码。
  探针注入用 `window.__LABDBG` / `window.__LABLOG`（页面里不留东西）。
- `scripts/tests/tools/_probe_basemap_river_ui.js` —— 剧本底图河流手势的逐步读数
  （真鼠标事件驱动，打印每一步的 `draft / rivers / selectedRiver / riverActiveNode`）。
- 本项目里**手写坐标换算**是踩坑高发区，所以产品侧留了 `worldToScreen()`（与 `screenToWorld` 互逆）：
  探针与产品走**同一个换算**，同理"每次交互前重读 `getBoundingClientRect()`"也写进了注释。
  一次性用的小探针（`_probe2.js` / `_probe3.js` / `_probe_smooth_window.mjs`）本轮已删。

---

## 6. 据实说的"我还不确定 / 没做"

1. **我没有肉眼看真机效果**：所有判据都是脚本实测（真鼠标事件 + 读 store + 读 DOM），
   "好不好看"必须你自己看一次。建议路径：世界选择页 →「历史剧本」→「更多」→「河流 (W)」→
   按住左键拖一笔（松手成河）→ 点河身加拐点 → 拖节点微调 → 鼠标移到节点上按 `Delete`
   → `Ctrl+Z` 逐条撤回。
2. **手画的河仍不裁海岸线**（第 4 节第 1 条，等你定）。
3. `test_106` 用的是**合成的空底图 + 真鼠标事件**：它证明"事件→数据"这条链是通的；
   **真实底图（desite，415 块省 / 133×75 高度图）上的手感**没量（那不是脚本能判的）。
4. 行星图的 `riverBrushPath` 现在收点带 `h`，`finalizeRiverNodes` 仍会**再采一次**
   （幂等，同一个点同一个高度图）。留着的理由是"抽稀后剩下的点各自重新采样" ——
   如果你以后改成"用别的高度图"，这里要一起看。
