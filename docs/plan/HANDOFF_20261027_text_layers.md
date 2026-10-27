# 交接：地形注记 + 河名沿河 + 导出带动注记 + 缩放分层（2026-10-27）

> 上一份：`docs/plan/HANDOFF_20261026_terrain.md`（地形注记首版 / 全量回归暂停点）。
> 本份是**当前状态**；两份冲突时以本份 + 代码为准。

## 一、这两轮做了什么（按提交）

| 提交 | 内容 | 判据 |
|---|---|---|
| `0648ca6` | **全量回归收口** + 地形注记持久化用例 | 155/155；`test_155` 守「落盘载荷逐字段 → 关/开项目原样带回」 |
| `8da4d11` | **河名沿河排字** | 45° 斜河字云主轴斜率 **0.87**（水平对照 0.00，同一算子反向探针）→ `test_156` |
| `3eb208e` | **地形注记手动入口**（画山系 / 画海域 / 点平原）+ 平原终于会画 | `test_157`：无高度图也能手动；平原画布差 685 像素；3 条 `origin:'user'`；一次 undo 退 1 条 |
| `28173e5` | **SVG 导出带上地形注记** | `test_158`：开 = 7 处逐字 `rotate` + 平原整名；关 = 逐字计数 0 |
| `4114b23` | 角度换算收成 `RAD_TO_DEG`（`test_71` 源码闸门误伤）+ 交接/归档 | — |
| `dcf9184` | **缩放分层 + 字号自适应**（Paradox 式，用户点名） | `test_159`：far 只剩势力名 / mid 加地形注记 / near 出河名 / close 出省名+城镇名；滞回 12% |
| （本条+上一条待提交） | **导出地形底图**（分带设色 + 海深 + 等深线/海岸线）+ **导出河名沿河** | `test_160`（内联 PNG 水域 9 蓝/陆地 34 色、海岸线、地形档不填省色；政治档反向对照）/ `test_149`（逐字判定） |

当前全量：**160 用例 + 68 个 Node 单测**（`run_tests.py`，约 25 分钟；全绿日志见 `build/_export_full.log`）。

## 二、地形注记长什么样（改之前必读）

```js
baseMaps[key].terrainLabels = [{ id, kind: 'range'|'sea'|'plain', name, points: [{x,y}], origin: 'auto'|'user' }]
```

- **写口只有一条**：`store.applyTerrainLabels(key, labels)`（整表替换 = 一条 undo；脏数据在写入口归一化丢弃）。
- **入口两条**：① 「检测山脊」→ 候选（`utils/ridges.js`）→ 逐条命名 → 应用；
  ② 手动：画山系 / 画海域（拖一条线）/ 点平原（点一下）→ 完成 → 命名 → 应用。
  几何采集在 `ScenarioMap.terrainLabelPick`（`onMouseDown/onMouseMove/onMouseUp` 三个分支），
  面板只负责命名与落库 —— 面板在 Teleport 里，拿不到屏幕坐标。
- **画布排法**（`drawTerrainLabels`）：`range` 沿脊线（字距 2）、`sea` 沿走向疏排（字距 6）、
  `plain` 落点横排。样式单源 = `utils/mapTextStyles.terrainLabelTextStyle()`。
- **导出排法**（`useScenarioExport.buildScenarioSVG`）：同一份数据/样式/几何；沿路径的字在 SVG 里是
  **逐字 `<text>` + `rotate(a cx cy)`**（SVG 没有沿路径文字，与画布逐字 rotate 同一口径）。

## 三、缩放分层 / 字号自适应（用户点名的 Paradox 式）

口径：「文本大小需要自动适应缩放……放大清晰显示省份名，缩小只看见势力名称」。

- **唯一判定** = `utils/labelZoom.js`（纯函数）。`ratio = 视口可见世界宽 ÷ 地图世界宽`：
  `close(≤0.35) / near(≤0.6) / mid(≤2.2) / far(>2.2)`；`DETAIL_CAPS` 决定每档标什么 ——
  `far` = 城镇 / 河流 / 地形注记**全隐**（只剩势力名）。
- **滞回 12%**：滚轮停在阈值上不抖档。⚠️ 边界取「两档之间那条」（更细那一档的上沿）；
  写成"上一档的上沿"会让滞回失效（第一版错法，单测 z3 当场抓到）。
- **字号系数**：`labelFontScale(ratio) = clamp((0.6/ratio)^0.2, 0.95, 1.55)` ——
  放大略大（ratio 0.1 → 1.43）、整图以外略小（0.95）。样式常量是 freeze 的，
  排布时克隆成带缩放字号的**新对象**再量字/绘制。
- 旧的 `burgLabelTier(scale)` / `riverLabelTier(scale)`（按绝对缩放分档，换数据量纲就失准）已删除。
- 缓存纪律：`labelPlanCache` 的 `nums` 必须含**档位 + 字号**，否则滚轮跨档时"画面不动"。
- ⚠️ 改阈值前先看 `test_149`：它的适屏 ratio 刚好 **1.62**，mid 上沿若定 1.6 就会把首都名收掉。

## 四、下次开工第一件事

先跑全量（务必系统 Python）：

```powershell
python scripts/tests/run_tests.py
```

> 若报「上一次 mock 未收尾 …index.html.bak 还存在」：先确认没有别的回归/诊断在跑
> （`Get-CimInstance Win32_Process` 查 `run_tests` / `vite` / `test-edge-profile`），
> 再 `git checkout -- src/renderer/index.html` 并删掉 `.bak` 与 `mock-data/`。

## 五、缺口（3–6 已在 2026-10-27 第二轮补齐）

1. ✅ ~~导出不带海深/等深线/分带设色~~（`test_160`）。
2. ✅ ~~导出里的河名仍是水平字~~（`test_149` 逐字判据）。
3. ✅ ~~干流/支流汇合处没有「越汇越宽」~~（`utils/riverWidths.js`：流量按弧长投到平滑点列 + 汇流台阶
   `factor 1.35 / jumpRatio 1.6`；`test_river_widths.js` 5 条）。
4. ✅ ~~老 97×45 导入图的等深线~~（`seaDepth.buildSeaDepthFromRings`：环栅格化 → Chamfer → p70 →
   同一组档位；`test_161` 有环 4 条 / 无环 0 条、导出也带上）。
5. ✅ ~~省界细棕线~~（`BORDER_COLOR #8d8a82 → #7b5b3f`，画布 1.1 → 0.9px、导出 `stroke-width 0.9`）。
6. ✅ ~~地形注记不参与避让~~（`layoutLabels` 新增 `opts.reserve`；画布/导出各自算「注记走廊」，
   沿路径只占中点附近一段；`test_162` + `unit/test_label_layout.js` t10）。
7. **缩放分档只作用于画布**（已与用户确认：导出是静态图，不分层）；行星 / 区域 / 建筑
   三处文字层仍按各自阶段门后延。
8. **导出地形档的局限**：等深线只对 `height` 档（温度/降水是专题图，与画布同一条口径）；
   等深线在导出里是**世界单位** 0.6/1.7 宽（画布是屏幕像素），超大导出尺寸下会偏细。
9. **汇流台阶目前只作用于造陆生成的河**（`landmass.js`）；导入河（FMG）的逐点宽度按弧长 +
   距海推，没有 flow 数据 —— 想让它也有台阶，得从 `.map` 的河网里恢复流量。

## 六、这一轮踩到的坑（都是实测）

1. **像素差必须比 RGB**：`test_157` 一开始只比 alpha（`i = 3`），画布底色 alpha 恒 255 →
   「平原名没画出来」永远 0 像素差（把画出来的判成没画，反方向的假绿）。
2. **测试里设相机要"在测量那一刻"设**：进入剧本 / 底图加载会异步适屏覆盖它
   （1.4 → 0.697 之类），档位/裁剪全跟着变，用例就空转。`test_156/157/159` 都在抓帧前重设相机。
3. **截图要抢在 undo 之前**：`test_157` 的截图块原本在 undo 之后 → 被撤掉的恰恰是最后加的
   海域注记，图上永远只有两类（而且换个参数重跑图片 sha 不变 = 还以为"没渲染"）。
4. **滞回的边界是"两档之间那条"**：写成"上一档的上沿"时，从 mid 放大到 0.58（near 上沿 0.6）
   会拿 mid 的上沿 1.6 去比，永远满足 → 滞回等于没做。
5. **图层开关不归面板管**：`showTerrainNames` 这类开关、相机、几何采集都在 `ScenarioMap`；
   面板只读 props、只 emit。跨组件各存一份状态 = 两份真值。
6. **源码闸门会误伤新代码**：`test_71` 用子串 `* 180 / Math.PI` 抓「把参考图 rotation 当弧度」
   的老 bug；沿路径排字新增的角度换算撞了同一形态 → 收成 `RAD_TO_DEG` 常量。

## 七、证据（本机 `docs/assets/`，被 .gitignore 忽略，不入库）

- `river-name-20261027/river-name-along-path.png`（45° 斜河名沿河）
- `terrain-manual-20261027/terrain-labels-manual.png`（三种注记同框：沿脊 / 疏排 / 落点）
- `terrain-export-20261027/terrain-labels-export.svg`（导出件，浏览器可直接打开）
- `label-zoom-20261027/zoom-{far,mid,near,close}.png`（四个缩放档的文字层）
