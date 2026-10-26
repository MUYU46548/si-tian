# 交接：地形注记（D3）+ 全量回归（2026-10-26 暂停点）

> 用户叫停原因：时间不够。要求"保存进度、总结未完成内容"。

## 现在的状态

| 项 | 状态 |
|---|---|
| 代码 | 已提交并推送：`c0a8240`（地形注记）、`bcb953d`（逐点河宽）、`3fa8630`（标签避让）、`02e54d1`（海深/配色） |
| Node 单测 | **67/67 绿**（含新增 `test_ridges` / `test_text_on_path` / `test_river_width_factors` / `test_sea_depth` / `test_iso_contours` / `test_label_layout`） |
| `test_154_terrain_labels` | **绿**（面板 → 检测山脊 → 命名 → `origin:'auto'` 落库 → 画布有像素且渲染未暂停 → 一次 undo 归零） |
| **全量 154 用例** | 🔴 **未跑完**（被叫停；`build/_labels3_full.log` 无输出）。这是下次开工第一件事 |
| 工作区 | 干净（只有 `build/` 下的历史临时文件未跟踪；`src/renderer/index.html` 已还原、无 harness 注入） |

## 下次开工第一件事

```powershell
python scripts/tests/run_tests.py
```

重点盯：

- `test_73` / `test_100` / `test_149`：标签层（本赛季重构过 `drawLabels` / `drawPolityLabels` / 导出排布）；
- `test_112` / `test_119`：河宽与选中高亮（`buildRiverRun` 改逐点宽度、选中轮廓改 `offsetPolylineVariable`）；
- `test_152`：造陆（生成器多写 `widths` 字段）；
- `test_54` / `test_47`：`applyTerrainLabels` 已登记 `writeGate` id 8，跑一遍确认契约没漏。

若全量绿：补一条"地形注记会随项目落盘/打开还原"的读盘用例（现在只验证到内存态 + undo）。

## 本轮交付（按提交）

1. **`02e54d1` 海深 + 分带设色**：`utils/seaDepth.js` 渲染期推导海深（8 邻域 Chamfer + p70 归一 + 指数映射）；`contour.extractIsoLines`（marching squares）画等深线；海岸线；`HYPSO_LAND` 按参考图 7 档、按本图 p2~p98 非等宽分档；阴影上限 1.45→1.08。
2. **`3fa8630` 标签避让**：`utils/labelLayout.js` 四档共排（势力/省/城镇/河），画布 `getLabelPlan` 缓存、导出同源。
3. **`bcb953d` 逐点河宽**：造陆河落库 `rivers[].widths`；导入河按弧长 + 距海方向推因子；`offsetPolylineVariable` 防高亮压水面。
4. **`c0a8240` 地形注记（D3）**：
   - 数据 `baseMaps[key].terrainLabels = [{id,kind,name,points,origin}]`；
   - `utils/ridges.js` 检测（平滑 → 脊得分 → 分位阈值 → Zhang-Suen 细化 → 最长路径 → 抽稀）；
   - `utils/textOnPath.js` + `labelStyles.drawTextAlongPath`（逐字 rotate，先描后填）；
   - 面板 `TerrainLabelsPanel.vue`（底图编辑行「地形注记」按钮；检测 → 命名 → 应用）；
   - `applyTerrainLabels` 整表一条 undo；重检测只替换**没命名的自动项**。

## 未完成 / 已知缺口（按优先级）

1. 🔴 **全量回归**（见上）。
2. **地形注记的持久化链路验证**：`.sitian` 保存/重开是否原样带回 `terrainLabels`（字段在 `baseMaps[key]` 下，预计随底图整体落盘，但没跑读盘用例）。
3. **海域 / 平原注记**：数据形状已支持 `kind:'sea'|'plain'`，面板只能从山脊候选生成 `range`；缺"手动新建 + 在地图上画一条线/点"的入口。
4. **河名沿路径**：`textOnPath` 已就绪，但河名仍走水平标签（`drawPlannedLabels(['river'])`）。接上后"河名沿河"才与参考图一致。
5. **导出**：SVG/PNG 是政治图，**不带**地形注记与海深；若用户要"成品地形图"，需要把 `terrainLabels` + 栅格底图接进导出链。
6. **干流/支流汇合处**没有"越汇越宽"的突变（现在只是沿程平滑增宽）；要改 `widths` 语义（同河网共享一条按 flow 的曲线）。
7. **老 97×45 导入图的等深线**：现按 spacing 闸门只给渐变不画线；要画需用 `landFeatures` 高精环另建深场。
8. **省界观感**：参考图是细棕线，我们仍是灰色 0.9~1.1px（未动，怕影响 60+ 用例的观感基线）。

## 踩坑备忘（改这几处之前必读）

- `drawLabels` 的 `!selectedScenario.value?.labels` 守卫**必须保留**：丢了会在无剧本时抛错 → 渲染护栏连续 3 帧失败后**暂停渲染**，画布整片空白（本轮真实发生，靠 test_154 的"画布必须有像素"断言抓出）。
- 地形注记面板的 `Teleport` **不能**放回 `toolbar-more`：`Teleport` 自身也在 `v-if` 子树里，底图编辑模式下面板会"点了不出现"。
- `ridges.js` 的脊得分**只能平均陆格**：把海格算进 4 邻域，贴岸一行会凭空多 3~4 的高度差 → 整条海岸线被当成山脊。
- 标签/排布的缓存键必须含 `timeline`（势力改名撤销后旧名不消失）与 `showTerrainNames`（新开关）。

## 证据（本机 `docs/assets/`，被 .gitignore 忽略，不入库）

- `terrain-labels-20261026/app-terrain-label.png`（山系名沿脊线）
- `river-width-20261026/app-river-widths.png`
- `terrain-sea-20261026/app-sea-depth.png`
