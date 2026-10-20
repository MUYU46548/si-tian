# 司天交接：H2 笔刷可用化与五件演示（2026-10-19）

> 上接 H1b [`SITIAN_HANDOFF_20261019_H1b.md`](SITIAN_HANDOFF_20261019_H1b.md)。
> 这一轮把 H1b 备好的笔迹引擎接到河宽/笔刷半径上，并把“五件演示 + 12 笔刷矩阵”跑成证据。

---

## 1. 一行账

**手画河落库带 `widthFactors`（速度→宽度，0.65~1.55），渲染优先用；省份笔刷半径改屏幕像素（默认 26px）、删掉空转的“强度”；五件演示 5/5、12 笔刷矩阵复跑（11/12，折线切割未复现）；42 Node 单测全绿。**

---

## 2. 改了什么

### 2.1 河宽随速度（`ScenarioMap.vue` + `strokeMath.resampleSeries`）

- 手画河落库：`widthFactors = resampleSeries(widthsBySpeed(draft, { referenceGap: px(6) }), pts.length)`，
  存在 river 对象上（可选字段；导入河/自动河没有 → 行为不变）。
- `riverWidthsFor`：若 `river.widthFactors.length === count`，先乘到 taper 后的宽度上，再走原有的
  “屏幕像素下限”闸门；用户调 `river.width` 仍整条等比变宽。
- 纯函数 `resampleSeries(values, count)`：按弧长线性重采样，端点不丢、不产生 NaN（Node 单测 t6）。
- 判据：`test_127` 源码闸门（`river.widthFactors` 在位）+ `test_stroke_math`（宽度 6.5→20、重采样）。

### 2.2 省份笔刷半径改屏幕像素（`useProvinceBrush.js` + `ScenarioMap.vue`）

- 滑块语义从“世界单位”改为**屏幕像素**（默认 **26px**，1~200）；`provBrushWorldRadius = px / cameraScale`，
  预览圈、落库几何都用它 → 缩放时手感一致。
- 删掉“强度”滑块：`applyProvinceStroke` 从未使用 `strength`（H2 审计确认），UI 不再说谎；
  `strength` 字段保留在接口里，避免打断既有调用/用例。
- 目标省下拉继续过滤 `empty`（H1a）；`provinceTargets` 保留原数组以稳定下标。

### 2.3 五件演示（用既有用例逐条取证，不另造演示脚本）

| 演示 | 用例 | 结果 |
|---|---|---|
| 涂色一笔多格 | `test_62_province_rings` | 涂归属 union+difference，1000 点省涂抹后 996 点、精度不降级 |
| 吸管 | `test_89_planet_channel_brush` | 吸到刚涂那格（culture=1），纯读不改通道 |
| 多选 | `test_102_vertex_marquee_link` | 框选 3 个共边顶点 → 拖动邻省跟着走 / 面积守恒 / 一条 undo |
| 撤销↔重做 | `test_122_river_eraser` | 擦断后一次 Ctrl+Z 回原样 |
| 标签联动 | `test_73_scenario_polity_labels` | 分级三档 + 改名落库/撤销重做 + 勾选框/内联编辑 |

### 2.4 12 笔刷矩阵复跑（真实 desite.map，200 省）

- 探针：`_probe_brush_matrix.py`；截图/读数：`docs/assets/s0-brush-20261019/index.html`。
- **11/12** 改数据：画/描轮廓/涂/圈/河/河橡皮/高度/群系/文化/宗教/抹除。
- **折线切割仍未被矩阵复现**（05-polysplit 无变化）——单独记，不据此判“坏”。
- 描轮廓在矩阵里仍会“一笔碰多省”（真实边界密集），但现在有 **6 省闸门 + 确认**；
  空省标 `empty` 后目标下拉被过滤。

---

## 3. 判据

| 用例 | 结果 |
|---|---|
| `test_62` / `test_89` / `test_102` / `test_122` / `test_73` / `test_127` | **6/6**（五件演示 + 引擎） |
| `test_52` / `test_97` / `test_113` / `test_126` | 全过（半径语义变更未破坏布尔/描轮廓/安全闸门） |
| Node 单测 | **42 个文件全过**（strokeMath 6 段） |
| 构建 | `npm run build` 通过 |
| 矩阵 | 11/12（折线切割未复现）；描轮廓闸门生效 |

---

## 4. 明确没做

1. **描轮廓落笔前的地图高亮**：仍是松手后闸门 + 确认（D10 的预览半边）。
2. **行星侧文化/宗教笔刷复用 `channelBrush`**：仍是每 move 全量拷贝（性能债），本轮未动。
3. **T10 参数浮层化 / 自动收面板**：只保留画布 <700×400 的状态栏提示。
4. **性能复测**（拖动中 <20ms）：本轮只做功能判据；H1/S0 的 18.5ms 仍是最近一次实测。
5. **折线切割**单独诊断。

---

## 5. 下一步（P0）

1. 真实 415 省项目：选势力 → 涂抹归属 → 选时间点 → 导 PNG（图例/比例尺/标题）。
2. 判据：PNG 非空白、含标注、读盘有项目文件；**暮雨亲手一次**。
3. 不在 P0 顺手做：C7 制图要素分裂、花哨滤镜、AI 出图。

---

*H2 完成于 2026-10-19；本轮未提交 git。*
