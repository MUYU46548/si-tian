# 断点（2026-10-31 22:0x，N1 刀 1/刀 2 · 第 21 轮收尾）

> 接手先读这一页。上一版（10-31 18:0x，10,749 行）已过时，被本文件取代。

---

## 一、仓库状态

- 分支 `main`，与 `origin/main` 同步到 **`cc47b9a`**，**工作树干净**。
- `ScenarioMap.vue`：**9,356 行**（起点 14,277，已减 **4,921**）。目标 **≤8,500**，**还差 856 行**。
- 已迁出（`src/renderer/src/`）：
  - `scenario/layers/`：background / coast / provinces / labels / overlays / editing / features / preview
  - `scenario/interaction/`：keyboard / pointer / move / down / rivers / province / actions /
    helpers / riverOps / provinceOps / misc / canvasClick
  - `utils/scenarioLayerRegistry.js`（层注册表 + Node 单测）
- 测试工具：`scripts/tests/lib/rsrc.py`（「组件 + 所有 layers + 所有 interaction」源码合集，
  **源码闸门一律读它**）；`scripts/tests/drill_scenario_pixels.py`（同机位像素指纹）。

## 二、判据状态

| # | 判据 | 状态 |
|---|---|---|
| 1 | 同机位逐像素一致 | ✅ 三组 A/B（静态 / 编辑态 / 含要素） |
| 2 | p95 帧时不退化 | ✅ 三档 25.0→25.3 / 18.0→18.0 / 18.0→18.0 |
| 3 | 163 CDP + 72 单测全绿 | ✅ 最近一次全量 163/163（`1a2d939`；`cc47b9a` 正在复核） |
| 4 | `ScenarioMap.vue` ≤8,500 | ❌ 现 **9,356**（还差 856） |
| 5 | 刀 1 完出内测包 | ⏳ 达标后重打 |

## 三、下一轮从这里接（还剩约 214 个函数 / 1,931 行）

**必须留在组件里的接线**（约占 340 行，搬了反而更绕）：
`renderFrame`(157) / `makeLayerView`(114) / `makePreviewView`(38) / `render`(30)。

**可以继续搬的**（按大小排序，前 20）：
`buildStrokeBase`21 / `countCrossingsWithExisting`20 / `selectScenarioAt`16 / `previewTraceRing`16 /
`snapToPolyline`16 / `snapToEdge`16 / `applyMarkerPatch`16 / `bindTerrainToPlanet`15 /
`segmentHitsBox`15 / `onAddPolity`15 / `onPolySplitClick`15 / `deleteAnnotation`15 /
`buildCellRaster`15 / `ownerHitProvinceIds`14 / `onSaveSlicePoint`14 / `provincePathFor`14 /
`openProvinceContextMenu`14 / `onCanvasDblClick`14 / `openReimportDialog`14 / `describeBaseMapMissing`14。

**先查「谁已被别处的 ctx 消费」再决定顺序**（`build/_ctx_used.mjs` 会列出 225 个这样的名字）：
被消费的名字不能在更晚的位置搬走，否则 TDZ（白屏）。

### 工厂调用顺序（硬约束）

```
helpers → rivers → riverOps → provinceOps → misc → province → actions
        → pointer → move → down → keyboard → canvasClick（最后，ctx 引用前面全部）
```

### 达线后的收尾清单

1. `python scripts/tests/drill_scenario_pixels.py --tag cut1_before` / `--tag cut1_after` / `--compare`
2. `python scripts/tests/tools/_probe_jank_real.py …`（p95 三档）
3. `npx electron-builder --dir --config.directories.output=release-internal` → `release-internal/win-unpacked/司天.exe`
4. 交给用户过眼（三件事见下）

## 四、搬家工具（别再手写依赖清单）

| 工具 | 用途 |
|---|---|
| `build/_extract_batch.mjs <fn1,fn2> <out> <factory>` | 一组函数 → 一个工厂（顶层 `let`→`st`；import→直接 import；其余→`ctx`） |
| `build/_wire_at.mjs <rel> <factory> <fns> [锚点]` | 插到某个工厂之前（会校验 ctx 名字都已声明） |
| `build/_wire_last.mjs <rel> <factory> <fns>` | 插到 `<script setup>` 末尾（ctx 可引用前面全部） |
| `build/_ensure_st.mjs <rel>` | 补 `pointerState` 的 get/set（模块里用到但组件没暴露的 `st.xxx`） |
| `build/_ctx_used.mjs` | 列出已被各模块 ctx 消费的名字（判断能不能搬晚一点） |
| `build/_diag_scenario.py` | **白屏诊断**：读应用自己的错误面板（TDZ/未声明都在这里看得见） |
| `build/_list_fns.mjs` / `_measure_draw_lines.mjs` | 剩余函数清单与行数 |

## 五、踩过的坑（都真的炸过）

1. 依赖扫描把**注释里**的名字当依赖 → 同名 const 与 function 冲突。
2. 把**函数自己的声明行**算进依赖 → `return { fn }` 返回 undefined。
3. **import 路径照抄**（组件在 `components/`，模块在 `scenario/interaction/`）。
4. **`async function` 只搬走 `function`** → 组件里留个孤零零 `async`。
5. **`ctx` 撞名**（组件里有 ref 就叫 `ctx`）→ 工具改成参数 `api` + 别名 `ctxRef`。
6. 全局非贪婪 `const {…} =` 扫解构会横跨大段代码 → 把 `w/minX/minY` 当顶层绑定 → 白屏。
7. **生成器双逗号**（每项加 `,` 又 join `,`）→ `vy,,` → 接线时该名字被过滤 → `vy is not a function`。
8. **工厂顺序 = TDZ**：`rivers` 与 `misc` 互相引用 → 把 `countCrossingsWithExisting` 留在组件里断开环路。
9. 🔴 **绝不 `Stop-Process -Name msedge`**（2026-10-31 真实事故：把用户正在看视频的浏览器一起杀了）。
   只杀测试自己的：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
     Where-Object { $_.CommandLine -match 'test-edge-profile|remote-debugging-port=9222' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```
   或 `python scripts/tests/tools/_lab.py down`。
10. 跑全量前先确认**没有别的 lab / 演练占着 5180/9222**；残留 Edge 会让一批用例报 `WinError 10054`。
