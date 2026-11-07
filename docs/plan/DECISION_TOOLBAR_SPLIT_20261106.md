# 决断：ScenarioMap 工具栏怎么拆（2026-11-06）

> 这是**动手前的决断页**，不是施工记录。施工进度看
> [`HANDOFF_20261105_UIUX.md`](./HANDOFF_20261105_UIUX.md) 的 A2 节。
> 决断一旦实施完，本页并入交接页并从这里的"待办"里划掉。

## 一、为什么要先决断

工具栏是 `ScenarioMap.vue` 里**最后一块大模板**（也是最大的一块）：

| 指标 | 实测（2026-11-06） |
|---|---|
| 模板块 | `L124–L1074` = **951 行** |
| 结构 | **10 个 `.toolbar-row`** |
| 用到的根标识符 | **161 个**（`ref` 66 / 工厂解构 49 / `computed` 19 / 本文件函数 16 / 常量 9） |

161 个绑定意味着：**"整块搬成一个组件、把东西都传进去"这条路直接出局**（161 个 props 谁也读不懂，
且每加一个控件都要改父组件签名）。所以必须先定"拆到什么粒度、用什么传"。

### 10 个行各自的体量（按行拆是否划算的关键数据）

| # | 行（class） | 行数 | 依赖数 | 只有这行用的标识符 |
|---|---|---|---|---|
| 0 | `basemap-row`（底图编辑行） | 44 | 8 | 4 |
| 1 | `primary-row`（主行：4 个任务工具 + 更多） | 47 | 7 | 2 |
| 2 | `province-row`（省份与笔刷，含批量铺底） | **221** | **39** | 33 |
| 3 | `river-selected-row` | 37 | 8 | 3 |
| 4 | `river-edit-row` | 45 | 10 | 3 |
| 5 | （"更多"里的 拆分/合并/删除） | 23 | 2 | 0 |
| 6 | （"更多"里的 地名/聚落/标记/河流/派生…） | 135 | 22 | 20 |
| 7 | （"更多"整块） | **290** | **62** | 57 |
| 8 | （图层/着色/栅格开关） | 50 | 16 | 16 |
| 9 | （外交/导出/历史/谱系…） | 28 | 9 | 8 |

两个结论直接来自这张表：

1. **小行（≤16 个依赖）有 7 个**，它们的依赖基本是这行自己的 —— 显式 props 完全可读；
2. **两行太大**（省份行 39、更多 62），但它们**内部本来就是分组的**（"更多"里有"省份与笔刷 / 笔刷与绘制 /
   地名 / 聚落 / 河流 / 派生 / 生成 / 图层"若干 `section.tm-card`），所以先细分再各取所需，
   不需要把 39/62 端出来。

## 二、三个候选方案

### 方案 A：`provide/inject` 一个控制器对象

父组件 `provide('scenarioToolbar', ctl)`，工具栏子组件 `inject` 后模板里写 `ctl.tool`。

- 优点：改动机械（951 行的绑定改成 `ctl.` 前缀即可），一次就能把整块搬出去。
- **代价（本仓特有）**：`ctl` 里有什么、从哪来，**源码里搜不到**。本仓的闸门体系建立在
  "源码可搜 + 唯一实现"上（`unit/test_undefined_identifiers.js` 全仓扫未声明标识符、
  `lib/rsrc.py` 拼合集给源码闸门读、`test_65` 断言"主行恰好 6 个可见控件"）。
  注入会让"这个模板用的 `batchCount` 是谁的"变成运行时才知道的事 —— 现有那套闸门抓不到，
  下一个接手的人（或 agent）只能靠跑起来猜。
- 判定：**否决**。省下的是打字量，付出的是可搜性与可测性。

### 方案 B：把 66 个 `ref` 挪进 store（`store/scenarioUi.js`）

- 优点：工具样子最"标准"，任何组件都能直接读；以后要加第二处工具栏不用再传。
- 代价：**动的是身份**。这 66 个 `ref` 同时被画布交互（`scenario/interaction/*`）、快捷键、
  时间轴、以及 20+ 个用例的 `setupState` 读取（`sm.baseMapKey`、`sm.tool`…）引用；
  搬进 store 后 `document.querySelector('.scenario-map-container').__vueParentComponent.setupState`
  上**就取不到了** —— 至少 12 个真机用例会当场红，得逐个改成读 store。
  而且 UI 瞬时状态（`moreOpen`、`drag`）进 store 与"store = 领域数据"的分层相悖。
- 判定：**暂缓**。收益是"以后方便"，代价是"现在一片红 + 分层变浑"。真要搬，单开一轮，和拆分解耦。

### 方案 C：**按行拆成子组件，客户端显式 props + emits（推荐）**

- 粒度：**一行一个组件**（大行先按 `tm-card` 再分），一个组件只声明它自己用到的那 2–16 个绑定。
- 父子契约写在 `defineProps` 里：谁用谁传，源码可搜，`test_undefined_identifiers` 照样成立。
- 状态仍归 `ScenarioMap`（唯一所有者）；子组件只发事件（`@set-tool="setTool"`），不碰 store。
- 代价：小行要写 7–16 个 props（可读）；每次加控件要动两处（父传 + 子声明）。
- 判定：**采用**。

## 三、决断

**采用方案 C**：按行拆、显式 props + emits；大行先按 `tm-card` 细分；**不引入 `provide/inject`，
也不把工具栏状态搬进 store**。

三条附带约束（不满足就是没拆对）：

1. **DOM 必须一模一样**：行的 class（`toolbar-row basemap-row` 等，`test_65`/`test_97` 按它数
   "主行恰好 6 个可见控件"）、`data-testid`、`title` 全部原样 —— 组件根元素必须是那个
   `<div class="toolbar-row …">`，不许包一层 wrapper。
2. **子组件不许直接读 store 的"UI 状态"**（`tool` / `moreOpen` / `basemapEditMode` 这类），
   状态与写口仍归父组件；可以读纯常量表（`BASEMAP_TOOLS`、`BURG_SIZES`…）但更推荐父传，
   避免"同一张表两个来源"。
3. **每一步单独提交、单独过闸门**，不攒大提交。回滚点就是上一步的提交号。

## 四、执行顺序（按依赖数从少到多，先小后大）

> **进度**：第 1 步（试点）已于 2026-11-06 落地，见第七节；第 2 步（`primary-row`）已于 2026-11-07 落地，见第八节。

| 步 | 目标 | 依赖数 | 预估 | 备注 |
|---|---|---|---|---|
| 1 | "更多"里的 拆分/合并/删除（row5） | 2 | 小 | **已完成**：`ProvinceOpsRow.vue` |
| 2 | `primary-row` | 7 | 小 | **已完成**：`PrimaryRow.vue`（5 props / 3 emits；84 个按钮 computedStyle 零差异） |
| 3 | `basemap-row` | 8 | 小 | **已完成**：`BasemapRow.vue`（4 props / 3 emits；84 个按钮零差异） |
| 4 | `river-selected-row` / `river-edit-row` | 8 / 10 | 小 | 下一个；两行共用 `riverSelIds`/`selectedRiver`，可一起做 |
| 5 | "外交/导出/历史/谱系"行 | 9 | 小 | |
| 6 | "图层/着色/栅格开关"行 | 16 | 中 | 16 个开关，建议按 3 个 `tm-card` 再分 |
| 7 | "地名/聚落/标记/河流/派生"行 | 22 | 中 | |
| 8 | 省份行（批量铺底那 221 行） | 39 | 大 | 先按 `tm-card` 分成 3–4 块 |
| 9 | "更多"整块（290 行） | 62 | 大 | 最后做；前面几块搬完后它会自然变小 |

**预计终局**：`ScenarioMap.vue` 从 6,625 行降到 **约 5,900 行**（模板从 ~1,700 降到 ~750），
`scenario/panels/toolbar/` 下 10+ 个小组件（每个 20–80 行，props ≤16）。
**不追求"一次拆完"**：每步都是可交付状态。

## 五、每步的闸门（缺一不可）

```bash
npm run build                                             # SFC 编译
node scripts/tests/unit/test_toolbar_ux_panels.js         # 每个按钮都有名字（新组件加进 FILES）
node scripts/tests/unit/test_toolbar_ux.js                # 剧本视图：分区标题/按钮有字/术语黑名单
node scripts/tests/unit/test_undefined_identifiers.js     # 全仓未声明标识符（props 写漏会红）
node scripts/tests/unit/test_scenario_map_split.js        # m1 行数逐轮收紧 + m7 双源守卫
python scripts/tests/run_tests.py test_65 test_97         # 主行"恰好 6 个可见控件" + 工具栏/海域
```

- **m1 行数闸门每步都要收紧**（当前 ≤6,620），否则"拆了又涨回来"没人发现；
- 新组件一律进 `scenario/panels/toolbar/`（`lib/rsrc.py` 已把 `panels/**/*.vue` 递归并进合集）；
- 新组件进面板闸门 `FILES`，并给 `min`（只有 1–2 个按钮的写实际值）；
- ⚠️ **注释里也别用直角引号**：`unit/test_quote_marks.js` 对注释同样生效（本轮两次被它抓到），
  引用一律用中文双引号。

## 六、明确不做的

- ❌ `provide/inject` 控制器（理由见方案 A）；
- ❌ 把工具栏状态搬进 store（理由见方案 B；真要搬另开一轮）；
- ❌ 改 `test_65` 的"主行恰好 6 个可见控件"判据来迁就拆分 —— **那是产品判据，不是拆分障碍**；
- ❌ 顺手改工具栏的视觉/文案（这一轮只搬不改，改视觉会让"搬前/搬后视觉比对"失去意义）。

## 七、试点结果（2026-11-06 已落地）

`scenario/panels/toolbar/ProvinceOpsRow.vue`（"省份与笔刷"卡片里的 拆分/合并/删除 一行）：

- 20 行模板 → 3 行组件引用；`props` 只有 `tool`，`emits` 只有 `setTool`；
- 根元素仍是 `<div class="toolbar-row">`（**没有包 wrapper**）；
- 闸门：面板闸门 **68/68**（21 个组件，含这一行）/ 体量 **8/8** / 未声明标识符 **4/4** /
  `npm run build` 通过 / 真机 `test_65`（主行 6 个可见控件 + "更多" 56 项）与 `test_97` 全过。

**一条新学到的边界**：工具栏各行**共用** `.toolbar-row`/`.tool-group` 这些样式（在
`scenario-map.css` 里，父组件的 scoped 表），所以 `m7`（"老 class 不许留在主表"）**不适用于
工具栏行** —— 它不是"搬到组件里"，而是"同一个工具栏样式表的另一段模板"。
**不要再给工具栏行单独抄一份 CSS**。

> 🔴 **2026-11-07 修正（真机读数推翻了下面这段）**：原先这里写的是
> “子组件根节点会继承父 scope id，样式照常命中”。**这句话只对根节点成立** ——
> `<style scoped>` 的父 scope id 只贴在子组件的**根元素**上，根**里面**的
> `<button>` / `<label>` / `.tool-group` 拿不到 `[data-v-父]`。
> 后果是试点那一行的“拆分 / 合并 / 删除”三个按钮退回浏览器默认样式
> （实测 h=23px / font=Arial 13.3px / inline-block / 白底黑字，而同屏其它按钮是
> 32px / 12px / flex / 深色皮肤），而**所有源码闸门与浮层视觉演练都看不见**。
>
> 正确做法：工具栏那套"按钮皮肤 + 行内小标签"在 `scenario-map.css` 里写成
> `:deep(类)` 形式（编译成 `[data-v-父] 类`，specificity 与原 `.类[data-v-父]` 相等）。
> 两条硬规矩：
> 1. **必须用 `:deep()`**，别再假设"根节点继承"能覆盖行内元素；
> 2. **`:deep()` 前面不要加 `.scenario-toolbar` 之类的前缀**（那会多一个 class、
>    改变优先关系：实测把 `.back-btn` 的 `padding: 6px 12px` 顶掉了
>    `.scenario-toolbar button` 的 `0 8px`，退回键宽 79.6 → 87.6px）。
>    唯一例外是 `.scenario-toolbar :deep(button)` —— 不加限定会命中**整个视图**的按钮。
>
> 守门：`unit/test_scenario_map_split.js` 的 **m8 + m8b**（`scenario/panels/toolbar/` 下的行
> 组件用到的 button / 行内 class，父表给它写过样式就必须有一条 `:deep()` 版本；
> 负向探针验过：去掉 `:deep` → 当场红）。
> 真机读数工具：`scripts/tests/tools/probe_toolbar_row_styles.py`（三档状态 84 个按钮
> 的 computedStyle + 尺寸，可 `--compare` 对拍）—— **动工具栏的 CSS 请都用它验一次**。

---

## 八、第 2 步结果（2026-11-07 已落地）

`scenario/panels/toolbar/PrimaryRow.vue`（主行：退回 / 选择 / 画省份 / 涂归属 / 改形状 / 更多）：

- `ScenarioMap.vue` **6,611 → 6,586 行**（m1 判据跟着收紧到 ≤6,590）；
- 契约：props **5 个**（`basemapEditMode` / `tool` / `moreOpen` / `advancedToolActive` /
  `snapToGridEnabled`）、emits **3 个**（`back` / `setTool` / `toggleMore`）——
  远低于"超过 20 个 props 就说明粒度选错"那条复核口子；
- 根元素仍是 `<div class="toolbar-row primary-row">`，`data-testid` / `title` / 顺序 / `v-if` 原样；
- **搬前/搬后真机对拍：84 个按钮 0 个有差异**（样式 19 项 + 尺寸逐项比）；
- `test_65` / `test_97` 照过（默认可见控件 4 个、"更多"56 项，与搬前读数一致）。

**这一轮真正学到的**（已写进第七节的修正块）：`:deep` 是必需的，但**写法会改 specificity**。
第一次写成 `.scenario-toolbar :deep(.back-btn)`，编译出来比原来的 `.back-btn[data-v]` 多一个 class，
于是 `.back-btn` 的 padding 顶掉了 `.scenario-toolbar button` 的 padding —— 真机读数立刻现形
（退回键 79.6 → 87.6px、“更多”那个按钮的 gap 4 → 3px）。改成等权重的 `:deep(.back-btn)` 后归零。
**结论：搬工具栏行之前先跑一遍 `probe_toolbar_row_styles.py` 留底，搬完再跑一遍 `--compare`**，
不要靠"看起来一样"。

---

## 九、第 3 步结果（2026-11-07 已落地）+ 一次“把皮肤收成一个入口”

`scenario/panels/toolbar/BasemapRow.vue`（底图/地理行：高度 / 湖泊 / 群系 … 笔刷建省 / 改省界 /
地形注记 / 出口）：

- `ScenarioMap.vue` **6,586 → 6,557 行**（m1 收紧到 ≤6,560）；
- 契约：props 4 个（`tools` / `tool` / `baseMapKey` / `terrainLabelsOpen`）、emits 3 个；
  `v-if="basemapEditMode"` 留在父组件，工具清单仍由父组件的 `BASEMAP_TOOLS` 单源出；
- 真机对拍：**84 个按钮 0 差异**。

### 顺带收口：按钮皮肤从 `.tool-group button` 提到一个入口

拆到第 3 步时暴露出一个**既有**问题（不是拆分造成的）：皮肤只写在 `.tool-group button` 上，
而主行 / 省份行 / 底图行的按钮**早就不在 `.tool-group` 里**了 → 真机上 **28 个按钮**是浏览器默认样式
（`#f0f0f0` 底、黑字、2px 黑边、圆角 0、`cursor: default`），在深色工具栏上像一排旧 Windows 按钮。
（2026-10-19 的截图里就已经是这样。）用户 2026-11-07 点头后把皮肤提到
`.scenario-toolbar :deep(button)`，`.tool-group button` 那份同值写法删掉。

改动读数是**可验证**的（84 条 computedStyle 逐项对拍）：
- 35 个白底按钮 → 深色皮肤；剩余“浏览器默认样式”读数 **0**；
- 两个**有意不同**的橙色按钮保住颜色（`.basemap-edit-toggle.active` 与 `.basemap-exit`，
  两者都跟着抬到 `:deep` 级），只顺带统一了 1px 描边与 `cursor: pointer`。
- ⚠️ 抬 specificity 时踩到一个**几何**坑：`.basemap-exit` 里那句 `padding: 2px 10px`
  十几年来一直被 `.scenario-toolbar button` 的 `0 8px` 盖着、从没生效过；一抬就把它撑宽了。
  所以那句 padding 显式删掉，几何继续由统一入口给 —— 外观一个像素都不变。

### 两步都验证到的一件事：**m8 源码闸门是必需的**

第 3 步搬完后 m8 当场报：`.basemap-row-label`（“底图/地理：”那个琥珀色小标题）只有普通写法、
没有 `:deep` 入口 —— 搬走后会掉回灰色。**真机探针当时看不见它**（它只量 button）。
两处都补上了：
- CSS 补 `:deep(.basemap-row-label)`；
- 探针从“只量 button”扩到 `.row-label / .basemap-row-label / .row-hint / .check-label /
  .draw-hint / select`（三档状态现在 84 个按钮 + 27 个行内元素一起拍）。

**结论（下一步照做）**：搬完一行先看 m8，再用探针 `--compare`；两边都要绿。

---

**决断人**：AI（用户 2026-11-06 授权“大文件你自己想办法拆分”+“先把架构决断做掉”）
**复核方式**：按第四节顺序继续第 4 步（`river-selected-row` + `river-edit-row`）。若某一步发现自己要往子组件塞超过 20 个 props，
说明粒度选错 —— 回到第二节重新评估，而不是硬塞。
