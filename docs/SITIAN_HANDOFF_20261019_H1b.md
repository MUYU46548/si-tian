# 司天交接：H1b 笔迹引擎试笔与接入（2026-10-19）

> 上接 H1a [`SITIAN_HANDOFF_20261019_H1a.md`](SITIAN_HANDOFF_20261019_H1a.md)（安全/几何）。
> 这一轮做 T7：**先试 perfect-freehand（真图量帧），过了才接**；不是“先接再找理由”。

---

## 1. 一行账

**真图 spike 通过：120 点 getStroke p95 0.2ms、连续每帧算 rAF p95 17.8ms、0 帧 >33ms；
已接进自由绘制/描轮廓的中心线稳定器（预览=落库，17 点）；127 用例 / 42 Node 单测基线。**

---

## 2. T7-spike（真实 `desite.map`，200 省）

探针：`scripts/tests/tools/_probe_stroke_spike.js`（驱动 `_probe_jank_real.py … __STROKE`）。

| 指标 | 数值 | 判据 |
|---|---:|---|
| getStroke（120 点）p50 / p95 / max | **0.1 / 0.2 / 0.3 ms** | 预览每帧算一次也不吃帧 |
| smoothStrokePoints p95 | **0.2 ms** | 中心线稳定器可每帧用 |
| 连续 1.5s 每帧算 rAF p50 / p95 | **16.6 / 17.8 ms** | p95 ≤33ms ✅ |
| >33ms 的帧 | **0** | ✅ |
| 轮廓点数（120 点输入） | **222** | 不是压成一条线 |
| 速度→宽度（慢 2px / 快 20px 采样） | **6.5 / 20** | 能拉开（修了“中位数归一化”导致恒定的 bug） |

**结论：go。** 截图（上=perfect-freehand 带笔锋，下=当前等宽折线）：
`docs/assets/stroke-spike-20261019.png`（本地证据，`docs/assets/` 不入库）。

**spike 踩的坑**：
- 第一次跑卡在 `stage: import`：Vite 首次优化 `perfect-freehand` 触发整页 reload，scenario/全局都被冲掉。
  解决：先单独 `import('/src/utils/strokeEngine.js')` 预热，再跑驱动。
- `widthsBySpeed` 首版用“本次笔迹中位数”归一化 → 整条快/整条慢都归一成 1，宽度恒定（实测 14/14）。
  改成**绝对参考间距**（默认 8px）后 6.5→20。

---

## 3. 接进了哪里（只动一条链）

`ScenarioMap.freeTraceRing()`（自由绘制/描轮廓的**唯一几何链**）：

```
rawPts → smoothStrokePoints(streamline 0.35) → simplifyClosedTrace(RDP) → ring
```

- 预览与落库共用同一条链 → `test_113` 仍是“预览 17 点 = 落库 17 点”；
- 引擎异常 → 退回原始手迹（绝不吞笔）；
- 稳定器对 100 点量级 p95 0.2ms，预览 60ms 节流下无感。

**新增文件**：
- `src/renderer/src/utils/strokeMath.js`（纯函数：点转换 / 速度→宽度 / outline→SVG / 长度）
- `src/renderer/src/utils/strokeEngine.js`（perfect-freehand 薄封装：`smoothStrokePoints` / `strokeOutline` / `strokePolygon`）
- `scripts/tests/unit/test_stroke_math.js`（5 段）
- `scripts/tests/cases/test_127_stroke_engine.py`（轮廓 >60 点、无 NaN、p95 <10ms、快/慢宽度拉开）

依赖：`perfect-freehand ^1.2.3`（MIT，零依赖）。

---

## 4. 判据

| 用例 | 结果 |
|---|---|
| `test_127_stroke_engine`（新增） | 轮廓 222 点 / 稳定 119 点 / p95 0.2ms / 宽度 6.5→20 |
| `test_113_draw_preview_wysiwyg` | 手迹 91 → 简化 17；预览 17 = 落库 17；控制点 0 |
| `test_97_province_outline` | 面积守恒 40000 |
| `test_126_outline_safety` | 闸门/空省/undo 全过 |
| `test_20_maplayer` / `test_52_province_grid` | 全过 |
| Node 单测 | **42 个文件全过** |
| 构建 | `npm run build` 通过 |

定向：`test_97 / 113 / 126 / 20 / 52` → **5/5**；`test_127` → **1/1**。

---

## 5. 明确没做

1. **河宽随速度真正落到数据/渲染**：`widthsBySpeed` 已有、判据已过，但还没接到手画河的 `river.width/widths` 与 `riverWidthsFor`；留给 H2（要和“河宽换算单源”一起改）。
2. **笔刷类用 `strokeOutline` 画粗笔迹**：当前只用了中心线稳定器；真正的“像手画的粗线”留给 H2 的笔刷重建。
3. **压力/笔锋在司天画布上的可视验证**：spike 截图是覆盖层，未进主渲染。
4. **12 笔刷矩阵复跑**：H2。

---

## 6. 下一步（H2）

1. 把 `widthsBySpeed` 接进手画河：落库可选 `widths[]`，`riverWidthsFor` 优先用；无则保持现状。
2. 笔刷类（省份涂抹/河笔）的“粗笔迹”用 `strokeOutline` + polygon-clipping 压平；预览=落库。
3. 五件演示（涂色一笔多格/吸管/多选/撤销↔重做/标签联动）+ 12 笔刷矩阵复跑。
4. 半径按屏幕像素、strength 去留、目标省常驻（H1 未做的 T10 UX）。
5. 描轮廓落笔前高亮（D10 预览半边）。

---

*H1b 完成于 2026-10-19；本轮未提交 git。*
