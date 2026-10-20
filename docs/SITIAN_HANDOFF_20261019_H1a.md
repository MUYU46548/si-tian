# 司天交接：H1a 手绘线·安全与几何（2026-10-19）

> 上接 D2 [`SITIAN_HANDOFF_20261019_D2.md`](SITIAN_HANDOFF_20261019_D2.md)。资料线 D1/D2 已收口，
> 本轮进手绘线第一步：**先止住“一笔毁图 / 看到的不是算到的 / 空省残留 / 画布被压小”**。
> T7 笔迹引擎（perfect-freehand）留到 H1b。

---

## 1. 一行账

**描轮廓加“影响省数”闸门（默认 6 省，超过先问）+ 默认不换主；被挖空的省标 `empty` 并过滤出目标下拉；
自由绘制不再写贝塞尔控制点（数据=渲染）；画布 <700×400 给提示。
10 个定向 CDP + 41 Node 单测全绿。**

---

## 2. 改了什么

### 2.1 D10 描轮廓安全（`provinceEditing.js` + `ScenarioMap.vue`）

- `resolveOutlineRegion` 返回 `affected`（这一笔碰到几个省）、`affectedIds`、`targetId/ownerId/neighborId`。
- `applyProvinceOutline` 新增闸门：`affected > maxAffected`（默认 **6**）→ `rejected:'province-gate'`，
  **零副作用**；消息点名前 6 个省 + “确实要一次改这么多，再点仍要执行”。
- 组件层：收到 `province-gate` → `window.confirm` 问人；确认后带 `allowMany: true` 重试。
- **默认 `outlineToNeighbor = false`**：描轮廓默认只修形状、不换主；换主必须显式勾选。
- 回执带上“影响 N 省”。
- 判据：`test_126_outline_safety`（12 省网格，9 省被圈 → 闸门拒绝；allowMany 后执行）。

### 2.2 D11 空省标记（`provinceEditing.js` + `ScenarioMap.vue`）

- `applyRegionToTerrain` / `applyOutlineToTerrain` 在差集挖空时给省标 `empty: true`；
  有地时 `empty: false`。
- `ScenarioMap` 新增 `provinceTargetOptions`：带原始 1-based 下标、过滤 `empty` → 目标省下拉不再出现空壳；
  `provinceTargets` 仍保留原数组（索引稳定，不破坏 `targetIdx`）。
- **没有直接删除数组项**：避免索引漂移/ownership 级联的一次大改；按规划允许的“标 empty 并过滤”路线。
  真正的物理删除（含 ownership/标签级联）留到后续清理轮。
- 判据：`test_126` 断言 8 个省 `empty:true`、下拉只剩 4、undo 后空标记归零。

### 2.3 T8 几何一致：去掉 `/3` 过冲（`ScenarioMap.vue`）

- 自由绘制（`commitFreeTrace`）与描点绘制（`finishDraw`）**不再调用 `withBezierControls`** ——
  落库就是顶点多边形，渲染 `traceShapePath` 走直线；布尔/命中用同一批顶点。
- 预览（`previewTraceRing` 的“将得到的地块”）也不再套贝塞尔 → **预览 = 落库**。
- `withBezierControls` 保留给“用户点顶点显式加手柄”：`/3` → **`/6`**，并按相邻两段长度夹紧
  （不均匀 RDP 点也不会鼓出大包）。
- 旧 `fromGrid` 渲染 Chaikin 未迁移（legacy 数据仍可能显示≠数据）；留到清理轮。

**测试契约变更**（重要）：
- `test_113_draw_preview_wysiwyg`：旧断言“落库环多数顶点带贝塞尔控制点”正是本轮要修的 bug；
  改为“控制点必须为 0”，并反转源码闸门（预览不许再套贝塞尔）。
- `test_20_maplayer`：旧断言“三个顶点全带切线 / 控制点 = 1/3”改为“不写控制点 + controlOut 为空 + Alt 无差异”。

### 2.4 T10 画布过小提示（`ScenarioMap.handleResize`）

- 画布 `<700×400` 时状态栏提示一次“只有 W×H —— 收起面板再画会顺手很多”；恢复到阈值以上后重新武装。
- 没有自动收面板（会打断正在填的表单）；只给可读原因。

---

## 3. 判据与证据

| 用例 | 结果 |
|---|---|
| `test_126_outline_safety`（新增） | 闸门拒绝 9 省 / allowMany 后执行 / 空省 8 个被标 `empty` 且下拉只剩 4 / 一点 undo 全还原 |
| `test_113_draw_preview_wysiwyg` | 预览 16 点 = 落库 16 点；**控制点 0**；圈内着色 Δ=71 |
| `test_20_maplayer` | 交互 8/8；新省份无控制点；Alt 无差异 |
| `test_97_province_outline` | 面积守恒 40000（原 40000） |
| `test_102_vertex_marquee_link` | 共边拖动/面积守恒/一条 undo 全过（显式控制点路径未受影响） |
| `test_52_province_grid` / `test_62_province_rings` / `test_79_province_gates` | 全过（布尔/闸门/套索/面积） |
| `test_120_basemap_edit_mode` / `test_122_river_eraser` | 全过 |
| Node 单测 | **41 个文件全过** |
| 构建 | `npm run build` 通过（ScenarioMap 235KB） |

定向 10 例：`test_97 / 102 / 113 / 120 / 122 / 126 / 20 / 52 / 62 / 79` → **10/10**。

---

## 4. 明确没做

1. **落笔前的“影响 N 省”高亮预览**：现在是**松手后**闸门 + 确认；地图上还没有实时高亮受影响的省。
   需要把 `resolveOutlineRegion` 接进 60ms 预览节流 + 画一层高亮，下一轮可做。
2. **空省的物理删除**（含 ownership/changeEvents/标签级联）：现在只标 `empty` + 过滤；项目 JSON 里仍留着空壳。
3. **旧 `fromGrid` 省的一次性平滑迁移**：渲染期 Chaikin 仍在，老数据仍可能“看到≠算到”。
4. **T7 笔迹引擎**（perfect-freehand / 河宽随速度）：H1b。
5. **真实底图 200 省的 12 笔刷矩阵复跑**：本轮只跑了合成/既有用例；H2 复跑。

---

## 5. 下一步（H1b）

1. `T7-spike`：真实 `desite.map` 上接 perfect-freehand，量 p95 帧/落库/形状；go/no-go。
2. 通过则 T7 笔迹引擎（河流草稿 `getStrokePoints`、可选 `widths[]`、一笔一撤销）。
3. 若失败 → 按规划 §6.1 评估引擎（E1 自研内核优先）。
4. 顺手：描轮廓落笔前高亮（D10 的预览半边）。

---

*H1a 完成于 2026-10-19；本轮未提交 git。*
