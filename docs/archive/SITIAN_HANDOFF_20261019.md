# 司天交接：第十九修·一（2026-10-19）—— 手势期间的自动保存顺延

> 上接 `docs/SITIAN_BREAKPOINT_20261018.md`（停在"把编辑之后那一下卡量出来、修法一行没写"）。
> 这一轮**只做那一件事**，并把它量到底：**拖动中的那一顿没了；抬手后还剩一次 275ms 的落盘块**。
> 下一件（把那 275ms 拆开/挪走）的**全部数字**都记在 §2，接手的人不需要重新探路。

---

## 1. 这一轮改了什么

### 1.1 修法：手势闸门（`src/renderer/src/utils/interactionGate.js`，新增）

**问题**：编辑之后 800ms 防抖到点，主线程被整块占住（上一轮实测 519ms / 拖动中 596ms）。
这次保存**没有理由必须立刻发生** —— 它是防抖保存，不是用户按下的 Ctrl+S。

**做法**：自动保存在"到点"那一刻先问一句「人手还在画布上吗」；在就**顺延**，抬手 + 60ms 静默后立刻补。

三条口径（改这里之前必读）：

1. **闸门只影响"自动"保存**：显式保存 / `flushSave()`（退出、关项目）/ Ctrl+S 一律**不经闸门**
   —— 数据安全承诺优先于手感。`test_123` d 段就是判这条（手还按着也能立刻写盘）。
2. **顺延有 5s 上限**：万一某个手势没配对（丢 mouseup、程序化按下、组件已卸载），
   不能让保存**永远**顺延 → 到点强制写一次并记 `forced` 计数（用例判"兜底真的会发生"）。
3. **抬手后有 60ms 静默窗口**：mouseup 那一刻还要提交这一笔（压叠闸门 → undo → 全量写口），
   保存若插在同一拍，等于把卡顿叠在收笔上。

**接线点（唯一，且覆盖全部工具）**：`ScenarioMap.vue` 的 `onMouseDown` / `onMouseUp`。
本组件**所有**编辑手势（自由绘制 / 描轮廓 / 河笔 / 橡皮 / 拖节点 / 顶点拖动 / 两种框选 /
涂抹 / 高度·群系·文化·宗教笔刷）都从 `mousedown` 起笔 → 一处接线即全量生效。
配对靠 `canvasGateArmed`（不能在 `onMouseUp` 里无条件 end：`mouseleave` 也走 `onMouseUp`，
会刷一堆"没有 begin 的 end"）；`onBeforeUnmount` 兜底收掉。

**四条保存链都接上了**（只接项目链没用 —— 地理/剧本链在到点时就已经在做那 187ms 的导出了）：

| 链 | 位置 | 防抖 |
|---|---|---|
| 地理数据 `saveGeodata` | `geodata.js` → `runAutoSave()` | 800ms |
| 行星地图 `saveMapData` | `geodata.js` → `runAutoSaveMap()` | 800ms |
| 剧本 `saveScenarios` | `geodata.js` → `runScenarioAutoSave()` | 300ms |
| 项目文件 `saveProject` | `projectStore.js` → `runProjectAutoSave()` | 800ms |

### 1.2 判据

- **`test_123_save_interaction_gate.py`（6 段）**：a) 源码闸门 24 项（含两条红线：
  `flushSave` 的函数体里**不许**出现 Deferrer；组件必须真接线）b) 手势中到点的保存**没发生**、
  `defers` 在涨 c) 抬手后**真的补存**、dirty 归零 d) 显式 flush 手还按着也**立刻写** 
  e) 5s 上限兜底（`forced >= 1`）f) **真实 mousedown/mouseup** 能开关闸门。
  ⚠️ e 段必须**拆两次 eval**（上限 5s 会撞 CDP 15s 读超时），且上限是"从该保存到点算起"，
  所以 E1 之后要等 ~7.2s（800ms 防抖 + 5000ms 上限 + 余量）。
- **`scripts/tests/unit/test_interaction_gate.js`（12 条）**：纯状态机 —— 配对 / 嵌套 /
  静默窗口 / 顺延 / 上限 / 复位；**不按墙钟判**（`check(now)` 注入时刻 + 机械计数）。
- **反向验证**：把 `isInteractionActive()` 改成恒 `false` → `test_123` **5 条具名红**
  （"手势期间自动保存被顺延 (0 → 1)"、"顺延计数在涨"、"改动没丢"、"抬手后补存"、"forced >= 1"）。
- **全量回归 123/123 通过**（Node 单测 39 个文件全过）。

### 1.3 真实测量（`scripts/tests/tools/_probe_save_gate_20261019.js`）

真实 `docs/mockups/desite.map`（200 省 / 载荷 **2,069,701 B**），lab = Vite + Edge headless，
编辑一条河 → 500ms 后**按住并持续拖动 2.6s**（保存的 800ms 防抖正落在拖动里）：

| 场景 | 修前（上一轮） | 修后（本轮） |
|---|---|---|
| 静止基线最长帧 | 18.2ms | **18.4ms** |
| **拖动中（保存已到点）** | **596ms**，1 帧 >100ms | **18.5ms**，**0 帧 >50ms** |
| 抬手之后（顺延的保存补上） | —— | **275ms**，1 帧 >50ms |
| 拖动期间是否写盘 | 是（就在拖动里写） | **否**（`defers=14`，`savedDuringDrag=false`） |
| 抬手后是否补存 | —— | **是**（`savedAfterRelease=true`） |

⇒ **"拖的时候那半秒"没了**；代价是**松手后一次 275ms 的落盘块**（人已经停手，不再叠在手势里）。

## 2. 那 275ms 里是什么（下一件要动的地方，数字已备好）

`_probe_save_breakdown_20261019.js` 的实测（同一张真实底图，预热一次后）：

| 段 | 耗时 | 备注 |
|---|---|---|
| `exportCanvasToProject()`（= `buildProjectPayload`） | **85ms**（冷 96.5ms） | 四次 `JSON.parse(JSON.stringify(...))`，切 store 别名 |
| `pushSnapshot()`（deepClone + `replayTo` 全链 + diff） | **68.9ms** | 每次自动保存都推一份快照；`replayTo` 要重放整条链（上限 50 份） |
| `toIpcPlain`（整份载荷 JSON 往返 2.79MB） | **~11–15ms** | `roundTrip` 实测 10.8ms |
| IPC V8 克隆 | 未量（mock 下量不到） | 真机会再加一笔 |
| `project.value = withSnapshot`（Vue 深响应式化） | **未量**，估计 ~100ms | 2.79MB 对象转响应式 |
| 对照：`flushSave()` 全长（mock IPC） | **90.8ms** | 不含真实磁盘与 V8 克隆 |

**三条候选修法（按风险从低到高，判据也写好了）**：

1. **去掉重复的导出**（省 ~85ms）：项目态下 `saveGeodata` 已经导出过一份并 `mergeCanvasPayload`
   到 `project.value`，紧接着 `saveProject` 又导出一份。**不能裸删**（导出是切断与响应式 store
   别名的保险，T2 事故同源）。安全形态：给画布写口一个**单调修订号**（每次 `scheduleAutoSave*`
   自增），`syncFromCanvas` 记下"已并进的修订号"，`saveProject` 只在**修订号相等**（= 自那次并进之后
   画布一次都没再写）时复用。判据要能抓住"复用后文件里仍有那一笔"（读 mock 的 `__projects`）+
   "新建/打开项目后不许复用"（避免跨项目复用旧载荷）。
   ⚠️ **红线**：这条依赖"任何画布写都必须调 `scheduleAutoSave*`"这个既有纪律；绕过它的裸写
   会被这条优化**静默丢掉**。要做就得同时补一枚"画布写必须有调度"的守卫，否则不要做。
2. **把快照/序列化挪出主线程**（③，收益最大、工程量最大）：`buildProjectPayload` 的输入是响应式
   对象，跨 Worker 要么先深拷贝（那笔拷贝本身也在主线程），要么先 `toRaw` + 结构化克隆 ——
   先量"`toRaw` 之后克隆 2.07MB 要多久"再决定值不值。
3. **快照节流**（省 ~69ms）：自动保存**每次都推一份快照**，50 份上限 ⇒ 连续编辑 40s 就把历史冲光
   （历史本身也没价值）。改成"自动保存最多每 N 秒推一份，显式保存必推" —— 既省 69ms，又让
   历史真的可用。⚠️ 这会改变"快照 = 每次保存都有"的既有预期，需要暮雨点头。

## 3. 明确没做的（不是漏掉）

- **其余三处编辑器**（`PlanetMap` / `AreaMap` / `InteriorView`）仍在每帧全量重画，
  基帧缓存那一套**没有搬过去**。为什么没做：它们各自的"手势入口"不是同一对函数，
  搬之前必须先量（上一轮的教训：先量再搬）。
- **涂抹 / 高度·群系·文化·宗教笔刷**没进基帧缓存（它们每帧真的改数据），要提速得走脏矩形 /
  局部重烘 —— 也没动。
- **②/③ 两条保存修法**：理由见 §2（② 的复用形态有一条"裸写会被静默丢掉"的红线，我不想在
  本轮顺手埋下；③ 是工程量大的一件，得先有目标表）。

## 4. 下一轮起点（暮雨计划：竞品调研 + 全库审查 → 目标表）

调研要抄的**具体条目**（上一轮已列，别泛泛地"看看人家"）：

- **Wonderdraft / Inkarnate**：河流笔刷手感（宽度随速度/压感）、橡皮的段删除语义、撤销粒度；
- **Azgaar FMG**：数据分层与"重生成"的边界、图层开关语义（我们已有 `.map` 导入，可对齐）；
- **Krita / Procreate**：笔迹稳定器 + "手迹 → 曲线"的**可见中间态**；
- **Illustrator / Figma**：节点的可见性与可选中性（我们的节点手柄可直接对照）。

产出建议：一份**目标表**（每条 = 一句可验收的判据 + 一个探针 + 一个最小改动），
而不是又一份现状文档。**本轮已经把"手感"这件事量化成两组数**（拖动中 18.5ms / 抬手后 275ms），
目标表就从这两组数往上写。

## 5. 收尾状态

- **未提交 git**（工作区仍堆着前几轮未提交的改动，我没有替你决定怎么分提交）。
- 临时件已清：`src/renderer/public/`（含 `__real_desite.map`）删除、`index.html` 已还原、
  `.lab-jank.json` / `.lab-edge-profile/` / 全量回归日志 删除、5180/9222 无监听。
- 可复用探针：`_probe_save_gate_20261019.js`（手势中/抬手后帧 + 真实落盘成本）、
  `_probe_save_breakdown_20261019.js`（保存链四段摊派）。
  跑法：`python scripts/tests/tools/_lab.py up` → 拷 `desite.map` 进
  `src/renderer/public/__real_desite.map` → `python scripts/tests/tools/_probe_jank_real.py <probe.js> <全局名>`
  → `_lab.py down`。
