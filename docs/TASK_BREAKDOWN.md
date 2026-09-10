# 司天 SiTian — 子任务拆分（P0/P1 剩余项）

本文档将 P0（基础编辑能力）和 P1（数据完整性）拆分为独立子任务，每个任务可独立派发给外部 agent 执行。

---

## P0 基础编辑能力

### P0-T1：贝塞尔曲线边界

**目标**：支持省份边界的贝塞尔曲线编辑（当前全是直线段）

**代码位置**：
- `src/renderer/src/components/ScenarioMap.vue` — `drawProvinces()` 函数
- `src/renderer/src/store/geodataModules/scenarioEditing.js` — `addBaseProvince` / `updateBaseProvince`

**实现方案**：
1. 为每个顶点增加 `controlIn` / `controlOut` 属性（相对于顶点的偏移量）
2. `drawProvinces` 中使用 `ctx.bezierCurveTo()` 替代 `ctx.lineTo()`
3. 顶点编辑模式下显示切线手柄（小圆点 + 连接到顶点的虚线）
4. 拖拽切线手柄时更新 `controlIn`/`controlOut`
5. 简化模式：按 Alt 键临时切换为直线（controlIn=controlOut=0）

**验收标准**：
- 绘制新省份时自动生成平滑贝塞尔曲线（控制点位于相邻顶点连线的 1/3 处）
- 顶点编辑模式下可拖拽切线手柄调整曲线
- 按 Alt 键临时切换为直线段

**红线/约束**：
- 修改 `points` 数组中的顶点对象时，必须创建新对象（`{...p, controlIn: {...}, controlOut: {...}}`）以触发响应式
- 所有修改走 `store.updateBaseProvince` 的 undo 栈
- 不得在 render 循环中创建新数组（性能陷阱）

---

### P0-T2：海岸线吸附

**目标**：绘制省份时，顶点自动吸附到相邻省份边界

**代码位置**：
- `src/renderer/src/components/ScenarioMap.vue` — `onCanvasClick()` 中的绘制逻辑
- 新增辅助函数 `snapToEdge(world, threshold)`

**实现方案**：
1. 当用户点击添加顶点时，检测点击位置是否在已有省份边界的阈值范围内（如 10px）
2. 如果命中，将新顶点吸附到最近的边界点上（可以是边的端点或投影点）
3. 吸附时显示视觉反馈（小圆点高亮 + 提示文字 "吸附到边界"）
4. 按 Shift 键临时禁用吸附

**验收标准**：
- 靠近已有省份边界绘制时，顶点自动吸附到边界
- 吸附距离阈值约 10px（世界坐标）
- Shift 键禁用吸附

**红线/约束**：
- 吸附检测需要遍历所有省份的所有边，注意性能（只在绘制模式下触发）
- 吸附后修改的是 `drawPoints` 数组中的坐标，不是 store 数据

---

### P0-T3：网格吸附

**目标**：顶点对齐到网格（50px 世界坐标）

**代码位置**：
- `src/renderer/src/components/ScenarioMap.vue` — 新增 `snapToGrid(world)` 函数

**实现方案**：
1. 新增工具栏 checkbox "网格吸附"（默认开启）
2. 绘制/顶点编辑模式下，将输入坐标对齐到最近的网格点（50px 间隔）
3. 对齐公式：`Math.round(x / 50) * 50`
4. 吸附时显示网格十字标记

**验收标准**：
- 绘制省份时顶点自动对齐到 50px 网格
- 顶点编辑拖拽时也吸附到网格
- 工具栏开关控制是否启用

**红线/约束**：
- 网格间距 50px 与当前 `drawBackground` 的网格线间距一致
- 只在绘制和顶点编辑模式下生效，不影响其他工具

---

## P1 数据完整性

### P1-T1：高度图渲染（地形高度可视化）

**目标**：将 `.map` 中的 cells 高度数据渲染为地形灰度图或分层设色图

**代码位置**：
- `src/renderer/src/utils/azgaar-parser.js` — `parseMapFile()` 已提取 `cellsData`
- `src/renderer/src/components/ScenarioMap.vue` — 新增 `drawHeightmap()` 函数

**实现方案**：
1. cellsData 是一个一维数组，每个元素代表一个 Voronoi 细胞的高度值（h 字段，范围 0-100）
2. 根据细胞高度映射颜色：低=深蓝/蓝，中=绿/黄，高=棕/白
3. 作为半透明图层叠加在省份之上（alpha 0.4）
4. 工具栏增加 "地形高度" 图层开关

**验收标准**：
- 导入 .map 后，画布上显示高度图（灰度或分层设色）
- 工具栏开关控制显隐
- 不影响省份点击选中

**红线/约束**：
- cellsData 可能很大（数千格），需要离屏 canvas 预渲染为 Image，避免每帧重绘
- 使用 `ctx.globalAlpha` 控制叠加透明度

---

### P1-T2：温度/降水数据提取与渲染

**目标**：从 .map 提取温度/降水数据并渲染为图层

**代码位置**：
- `src/renderer/src/utils/azgaar-parser.js` — `parseMapFile()` 中补充提取温度/降水
- `src/renderer/src/components/ScenarioMap.vue` — 新增 `drawClimate()` 函数

**实现方案**：
1. 行 4（0-indexed 3）包含温度/降水设置
2. cellsData 中每个细胞的 `h` 字段对应高度，可通过高度推算温度
3. 温度图层：用色带（蓝→青→绿→黄→红）表示
4. 工具栏增加 "温度" 图层开关

**验收标准**：
- 导入 .map 后可选择显示温度图层
- 温度色带使用科学配色（蓝=冷，红=热）
- 开关切换不影响其他图层

**红线/约束**：
- 温度数据可能需要从 cellsData 的 `h` 字段推算（高度越高温度越低）
- 与高度图互斥（同时只能显示一个）

---

### P1-T3：河流/道路数据解析与渲染

**目标**：从 .map 提取 rivers/routes 数据并渲染为线条

**代码位置**：
- `src/renderer/src/utils/azgaar-parser.js` — `parseMapFile()` 中补充提取 rivers/routes
- `src/renderer/src/components/ScenarioMap.vue` — 新增 `drawRivers()` 函数

**实现方案**：
1. 行 170+ 包含 rivers 数据（id/name/type/points）
2. 行 180+ 包含 routes 数据（id/name/type/points）
3. 河流用蓝色实线（lineWidth 随缩放调整）
4. 道路用棕色虚线
5. 工具栏增加 "河流/道路" 图层开关

**验收标准**：
- 导入 .map 后显示河流（蓝色）和道路（棕色虚线）
- 线条随缩放调整粗细
- 开关控制显隐

**红线/约束**：
- rivers/routes 数据可能很大，需要离屏预渲染
- 线条颜色和样式参考 Azgaar FMG 的默认配色

---

### P1-T4：城镇标记显示

**目标**：将 burg 数据显示为地图上的可点击节点

**代码位置**：
- `src/renderer/src/utils/azgaar-parser.js` — `parseMapFile()` 已提取 burgData
- `src/renderer/src/components/ScenarioMap.vue` — 新增 `drawBurgs()` 函数

**实现方案**：
1. burgData 中每个城镇有 x/y/name/capital 字段
2. 首都显示为金色星形，普通城镇显示为灰色圆点
3. 点击城镇显示 tooltip（名称+人口）
4. 工具栏增加 "城镇" 图层开关

**验收标准**：
- 导入 .map 后显示城镇标记
- 首都（capital=true）显示为金色星形
- hover 显示城镇名称
- 开关控制显隐

**红线/约束**：
- 城镇标记需要支持点击选中（未来可编辑）
- 标记大小随缩放调整

---

### P1-T5：文化/宗教图层渲染

**目标**：将 culturesData/religionsData 渲染为省份底色

**代码位置**：
- `src/renderer/src/utils/azgaar-parser.js` — `parseMapFile()` 已提取 culturesData/religionsData
- `src/renderer/src/components/ScenarioMap.vue` — 修改 `getProvinceColor()` 支持文化/宗教模式

**实现方案**：
1. cellsData 中每个细胞有 `culture` 和 `religion` 字段（id）
2. 工具栏增加 "文化/宗教" 图层开关
3. 开启后，省份底色改为对应文化/宗教的颜色
4. 图例显示文化/宗教名称和颜色

**验收标准**：
- 导入 .map 后可选择按文化或宗教着色
- 图例显示在右下角
- 与生物群系配色互斥

**红线/约束**：
- 需要先建立 cellsData 到省份的映射（按坐标最近邻匹配）
- 文化/宗教颜色使用 culturesData/religionsData 中的 color 字段

---

## 通用约束（所有任务必须遵守）

1. **Vue 3 响应式**：修改 ref 嵌套属性必须创建新对象
2. **Undo 铁律**：所有数据修改走 `store.updateBaseProvince` 的 execute 栈
3. **性能**：大数据量（cells/burgs/rivers）使用离屏 canvas 预渲染
4. **测试**：每个任务完成后跑 `npm run test` 确认 19/19 全绿
5. **构建**：`npm run build` 无错误
6. **Mock 红线**：`dist/index.html` 中不得含 `__SITIAN_MOCK__`

---

## 建议执行顺序

1. P0-T3（网格吸附）— 最简单，建立信心
2. P0-T1（贝塞尔曲线）— 核心编辑能力
3. P0-T2（海岸线吸附）— 依赖 P0-T1
4. P1-T4（城镇标记）— 最简单，数据已有
5. P1-T1（高度图渲染）— 数据已有，需要渲染
6. P1-T3（河流/道路）— 数据已有，需要渲染
7. P1-T5（文化/宗教）— 需要 cells→省份映射
8. P1-T2（温度/降水）— 需要推算逻辑
