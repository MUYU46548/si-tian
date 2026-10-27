# 交接：地形注记收口 + 河名沿河 + 导出带注记（2026-10-27）

> 上一份：`docs/plan/HANDOFF_20261026_terrain.md`（地形注记首版/全量回归暂停点）。
> 这一份是**当前状态**；两份冲突时以本份 + 代码为准。

## 一、今天做了什么（按提交）

| 提交 | 内容 | 判据 |
|---|---|---|
| `0648ca6` | **全量回归收口** + 地形注记持久化用例 | 155/155 绿；`test_155` 守「落盘载荷逐字段 → 关/开项目原样带回」 |
| `8da4d11` | **河名沿河排字** | 45° 斜河字云主轴斜率 **0.87**（水平对照 0.00，同一算子反向探针）→ `test_156` |
| `3eb208e` | **地形注记手动入口**（画山系/画海域/点平原）+ 平原终于会画 | `test_157`：无高度图也能手动；平原画布差 685 像素；3 条 `origin:'user'`；一次 undo 退 1 条；取消/Esc 零落库 |
| `28173e5` | **SVG 导出带上地形注记** | `test_158`：开=7 处逐字 `rotate` + 平原整名；关=逐字计数 0 / rotate 0 |

当前全量：**158 用例 + 67 个 Node 单测**（`python scripts/tests/run_tests.py`，约 25 分钟；
最后一次全绿日志 `build/_final_158b.log`）。

## 二、现在的地形注记长什么样（改之前必读）

数据形状（未变）：

```js
baseMaps[key].terrainLabels = [{ id, kind: 'range'|'sea'|'plain', name, points: [{x,y}], origin: 'auto'|'user' }]
```

- **写口只有一条**：`store.applyTerrainLabels(key, labels)`（整表替换 = 一条 undo；脏数据在写入口归一化丢弃）。
- **入口两条**：
  1. 「检测山脊」→ 候选（`utils/ridges.js`）→ 逐条命名 → 应用；
  2. **手动**：画山系/画海域（在地图上拖一条线）/ 点平原（点一下）→ 完成 → 命名 → 应用。
     几何采集在 `ScenarioMap.terrainLabelPick`（`onMouseDown/onMouseMove/onMouseUp` 三个分支），
     面板只负责命名与落库 —— 面板在 Teleport 里，拿不到屏幕坐标。
- **画布排法**（`drawTerrainLabels`）：`range` 沿脊线（字距 2）、`sea` 沿走向疏排（字距 6）、
  `plain` 落点横排。样式单源 = `utils/mapTextStyles.terrainLabelTextStyle()`。
- **导出排法**（`useScenarioExport.buildScenarioSVG`）：同一份数据/样式/几何；沿路径的字在 SVG 里是
  **逐字 `<text>` + `rotate(a cx cy)`**（SVG 没有沿路径文字，与画布逐字 rotate 同一口径）。

## 三、下次第一件事

先跑全量（务必系统 Python）：

```powershell
python scripts/tests/run_tests.py
```

> 若报「上一次 mock 未收尾 …index.html.bak 还存在」：先确认没有别的回归/诊断在跑
> （`Get-CimInstance Win32_Process` 查 `run_tests` / `vite` / `test-edge-profile`），
> 再 `git checkout -- src/renderer/index.html` 并删掉 `.bak` 与 `mock-data/`。

## 四、剩余缺口（按优先级）

1. **导出仍不带海深/等深线/分带设色**：现在 SVG 是「政治底 + 省界 + 文字（含地形注记）」，
   而画布上的海深渐变、等深线、7 档高程设色**都没有**。要成品地形图，得把栅格底图（或至少
   等深线路径 + 海深分带）接进导出链 —— 这是「导出 = 画布」这条纪律上最后一块大缺口。
2. **导出里的河名仍是水平字**（画布已沿河）。原因：`test_149` 用「单个 `<text>` 含整条河名」做判据，
   改成逐字 rotate 要一并改那条用例。做法与地形注记完全一样（`slicePathAroundPoint` +
   `layoutTextAlongPath` + 逐字 `<text transform="rotate(...)">`）。
3. **干流/支流汇合处没有「越汇越宽」**：现在只是沿程平滑增宽；要改 `widths` 语义
   （同一河网共享一条按 flow 的曲线）。
4. **老 97×45 导入图的等深线**：按 spacing 闸门只给渐变不画线；要画需用 `landFeatures` 高精环另建深场。
5. **省界观感**：参考图是细棕线，我们仍是灰 0.9~1.1px（`BORDER_COLOR`，导出 `stroke-width 1.1`）。
   改它会动到 60+ 条用例的观感基线，先想清楚判据再动。
6. **地形注记不参与避让排布**（画布与导出都一样）：山系名可能压到省名/城镇名。
   若要做，把 `terrainLabels` 作为第 5 档候选喂给 `utils/labelLayout.js`（沿路径的字需要
   「以字云外接框当候选框」的近似）。

## 五、本轮的四个坑（都是实测踩出来的）

1. **像素差必须比 RGB**：`test_157` 一开始只比 alpha（`i = 3`），而画布底色 alpha 恒 255 →
   「平原名没画出来」这条断言永远 0 像素差（假绿方向相反：把画出来的判成没画）。
2. **测试里设相机要在测量那一刻设**：进入剧本 / 底图加载会异步适屏，把 `cameraScale` 从 1.4 改回
   0.697 → `riverLabelTier` 在 <1.2 时刻意不标河名 → 排布为空、整条用例空转。
   现在 `test_156` 在每次抓帧前重设相机（并回读 `cameraScale` 做诊断）。
3. **截图要抢在 undo 之前**：`test_157` 的截图块原本在「一次 undo」之后 → 被撤掉的恰恰是最后加的
   海域注记，图上永远只有两类（而且换参数重跑图片 sha 不变 = 当时还以为"没渲染"）。
4. **面板里 `showTerrainNames` 这类开关不归面板管**：面板只读 `props.baseMapKey`；
   图层开关/相机/几何采集都在 `ScenarioMap`，跨组件通信一律 props/emit（不要 import 对方 store 之外的模块）。

## 六、证据（本机 `docs/assets/`，被 .gitignore 忽略，不入库）

- `river-name-20261027/river-name-along-path.png`（45° 斜河名沿河）
- `terrain-manual-20261027/terrain-labels-manual.png`（三种注记同框：沿脊 / 疏排 / 落点）
- `terrain-export-20261027/terrain-labels-export.svg`（导出件，可直接用浏览器打开看）
