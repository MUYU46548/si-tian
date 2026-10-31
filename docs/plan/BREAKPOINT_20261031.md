# 断点（2026-10-31 18:0x，N1 刀 1/刀 2 进行中 · 第 15 轮）

> 接手先读这一页：现在在哪、还差什么、怎么继续、哪些坑别重踩。
> 上一版（10-30 22:4x）已过时，被本文件取代。

---

## 一、此刻的仓库状态

- 分支 `main`，与 `origin/main` 同步到 **`596bff4`**，**工作树干净**。
- `ScenarioMap.vue`：**10,749 行**（起点 14,277，已减 **3,528**）。目标 **8,500**，还差 **2,249**。
- 已迁出的模块（都在 `src/renderer/src/`）：
  - `scenario/layers/`：background / coast / provinces / labels / overlays / editing / features / preview
  - `scenario/interaction/`：keyboard / pointer / move / down / rivers / province / actions
  - `utils/scenarioLayerRegistry.js`（层注册表引擎 + Node 单测）
- 测试工具：`scripts/tests/lib/rsrc.py`（`render_src()` = 组件 + 所有 layers + 所有 interaction 的合集，
  **源码闸门一律读它**，搬家不会再误伤用例）；`scripts/tests/drill_scenario_pixels.py`（同机位像素指纹）。

## 二、判据状态

| # | 判据 | 状态 |
|---|---|---|
| 1 | 同机位逐像素一致 | ✅ 三组 A/B（静态 `6993c0bc` / 编辑态 `df13eec4` / 含要素 `c65ed170`） |
| 2 | p95 帧时不退化 | ✅ 三档 25.0→25.3 / 18.0→18.0 / 18.0→18.0（`_probe_jank_real.py`） |
| 3 | 163 CDP + 72 单测全绿 | ✅ 最后一次全量 163/163（`596bff4`） |
| 4 | `ScenarioMap.vue` ≤8,500 | ❌ 现 **10,749**（还差 2,249） |
| 5 | 刀 1 完出内测包 | ⚠️ 21:19 那版内测包是 11 万行时期的老包，**行数达标后要重打** |

## 三、继续搬的顺序（下一轮从这里接）

1. **先搬"叶子"函数**（不依赖其它待搬函数的）：`getSeaDetail` / `riverWidthSeries` / `mapWorldSize` /
   `applyReimportDialog` / `autoSeedBatch` / `onWheel` / `handleResize` …
2. 再搬"中间层"：`fitToView` / `confirmVertexBatchOverlap` / `beginVertexLinkContext` /
   `buildLinkedPreview` / `buildProvincePath` / `handleSplitClick` / `ctxDuplicateProvince` /
   `addProvinceWithOverlapGate` / `confirmVertexMoveOverlap`。
3. **必须留在组件里的**：`renderFrame`(157) / `makeLayerView`(114) / `makePreviewView`(38) / `render`(30)
   —— 它们就是"接线"，是这次重构的成品形态。
4. 全部搬完预计落在 **≈8,2xx**，达标后：像素 A/B → 帧时 A/B → 重打内测包 → 交给用户过眼。

### 工厂调用顺序（硬约束，错了就是 TDZ / 白屏）

```
rivers → provinceOps → province → actions → pointer → move → down → keyboard
```

理由：后面的工厂在 ctx 里**直接引用**前面工厂返回的 const（例如 `pointer` 的 ctx 里有
`finishRiverDraft`）。顺序反了会 `Cannot access 'xxx' before initialization`，表现是
**整个剧本视图挂不起来**（用例只报"剧本模式未挂载超时"，看不出根因）。

## 四、搬家工具（别再手写依赖清单）

- `build/_extract_batch.mjs <fn1,fn2,…> <outFile> <factoryName>`：一组函数 → 一个工厂。
  依赖规则：组件顶层 `let` → `st`（带 get/set）；import 绑定 → 模块直接 import；
  其余 ref/const/函数 → `ctx`。
- `build/_wire_module.mjs <moduleRel> <factory> <fn1,fn2>`：把工厂接进组件（**会校验 ctx 名字
  是否都在组件里声明过**，不通过就拒绝写盘）。
- `build/_measure_draw_lines.mjs` / `_measure_sfc_blocks.mjs`：行数与函数清单。
- `build/_diag_scenario.py`：**白屏诊断**（起 lab、开项目、点历史剧本、读应用自己的错误面板）。

## 五、踩过的坑（每条都真的炸过）

1. **依赖扫描把注释里的名字当依赖** → 同名 const 与 function 冲突（`onMouseDown`）。
2. **把函数自己的声明行算进依赖** → `return { onMouseMove }` 返回解构出来的 undefined。
3. **import 路径照抄** → 组件在 `components/`，模块在 `scenario/interaction/`，`../utils/x` 要变 `../../utils/x`。
4. **`async function` 只搬走 `function`** → 组件里留一个孤零零 `async`，解析失败。
5. **`ctx` 撞名**（组件里有 ref 就叫 `ctx`）→ 工具现在自动改参数名为 `api` + 别名 `ctxRef`。
6. **全局非贪婪 `const {…} =` 扫解构**会横跨大段代码，把函数内局部变量（`w` / `minX` / `minY`）
   当成顶层绑定 → `w` 未声明 → 白屏。现在只在**行首**匹配并配平花括号。
7. **造基帧（stroke base）在搬完之后失效过一次**（2026-10-31 第 15 轮）：把
   `addProvinceWithOverlapGate` 等 8 个函数搬进 `provinceOps.js` 后，用例 `test_121` 报
   「一次拖动建了 0 次基帧 / 拖动期间贴图 0 次 / 相机变了基帧没作废」——**已回滚该次搬动**，
   代码仍停在 `596bff4`。下次重试时先查：`beginStrokeBase()` 的调用链是否被 `ctx` 转手打断
   （它在 `down.js` 里被调用，而 `strokeBaseArmed` 仍在组件里）。
8. **PowerShell 处理这个 10k 行 SFC 会毁编码/吃引号** —— 一律用 `node` 脚本（utf8 读写）+ 先判 CRLF。

## 六、给用户的现状一句话

刀 1 四层迁完、判据 1/2/3 全绿；从 14,277 减到 **10,749 行**（−3,528）。
行数判据（≤8,500）还差 2,249，按每轮 200–400 行算还要 **6–8 轮**；
达线后我会重打内测包、再跑一次像素与帧时 A/B，然后交给你过眼。
