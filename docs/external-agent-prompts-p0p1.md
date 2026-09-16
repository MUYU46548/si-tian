# 司天 P0+P1 外部 Agent 提示词集

> 适用：OPencode / Claude Code / Codex 等外部 agent
> 维护：2026-09-14
> 使用方法：按功能拆分提示词，逐条粘贴执行

---

## 通用上下文（每条提示词前都附上）

```
## 项目背景

司天（SiTian）是世界构建者本地桌面应用，以 Obsidian 库（默认 E:/图书馆/ROSA/）为唯一事实源，七层视图呈现世界观地理层级。

技术栈：
- Electron 28 + Vue 3 + Pinia + Vite 5
- 前端 Canvas 2D 绘制，无外部渲染库
- 数据格式：Markdown + YAML frontmatter + JSON 缓存层（E:/图书馆/ROSA/.sitian/）

仓库路径：E:\CODE\CangKu\SiTian
源码关键目录：
- src/renderer/src/components/ — 视图组件（PlanetMap/AreaMap/InteriorView等）
- src/renderer/src/store/ — Pinia store + geodataModules/
- src/renderer/src/composables/ — 交互/绘制/笔刷 composables
- src/renderer/src/utils/ — 工具函数（heightMath.js/placement.js等）
- scripts/ — Python 脚本（提取/审计/测试）
- scripts/tests/cases/ — 回归测试用例

## 编码纪律

1. 改任何文件前，先用 search_files/read_file 读当前代码原文
2. 禁止在前端直接读写 Obsidian 文件——必须通过 Electron 主进程 IPC
3. 禁止在 render() 函数内使用 Math.random()——会导致拖拽时节点乱动
4. 禁止在渲染循环中修改响应式状态——Vue 会触发无限重渲染
5. store.mapData 是 ref，必须 .value 访问
6. undo 纪律：修改数据的逻辑放在 redo 回调内，禁止在 execute 之前手动改数据（会造成双写）
7. 图标引用必须用 Icon.vue 内已定义的名称，禁止 emoji

## 验证方式

- npm run build 必须通过
- python scripts/tests/run_tests.py 用系统 Python 跑回归（需 Edge CDP 环境）
- python scripts/icon_check.py 检查图标引用
```

---
---

## P0-1 Relief Icons 笔刷

```
## 任务：Relief Icons 笔刷（山脉/树木/沙漠图标散布）

### 背景

参考 Azgaar FMG 的 Relief editor：可以在地图上自然散布山脉、树木、沙漠等地貌图标。
当前司天 PlanetMap 没有 Relief icons 层，需要在地图编辑中增加该能力。

### 功能描述

1. **工具栏新增 Relief 笔刷工具**（快捷键建议 R）
2. **图标类型**：至少 4 种（mountain 山脉 / tree 树木 / cacti 沙漠 / rock 岩石）
3. **编辑模式**：
   - 左键拖动：沿路径散布图标（间距可配置，默认 30px）
   - 右键拖动：清除区域内的图标
   - 滚轮：调整散布间距
4. **图标参数**：
   - 大小（16-48px，默认 24）
   - 旋转随机角度（0-359°，可关闭）
   - 密度（每平方像素图标数，默认中等）
5. **数据存储**：在 mapData[id].reliefIcons 数组存储每个图标 {type,x,y,size,rotation}
6. **渲染**：在 TerrainRenderer 上方、聚落 layer 下方渲染
7. **撤销**：单条 undo（brush 一次拖动 = 一条）

### 实现要点

- 新建 src/renderer/src/utils/reliefIcons.js（散布算法、类型定义）
- 扩展 TerrainRenderer 增加 reliefIcons 渲染层
- PlanetMap 工具栏增加 Relief 按钮 + 子面板（类型选择+参数滑块）
- composable 写 useReliefBrush.js（交互逻辑）
- 参考 Icon.vue 已有 SVG 路径或 canvasIcon.js 绘制

### 验收标准

- [ ] 拖动后图标沿线散布，自然不重叠
- [ ] 4 种图标类型可以切换
- [ ] 调整大小/间距实时生效
- [ ] 撤销/重做正常（一次拖动=一条 undo）
- [ ] npm run build 通过
- [ ] icon_check.py 新增图标引用通过
- [ ] 至少 1 条回归测试用例

### 注意事项

- reliefIcons.js 里的散布算法必须是确定性的（同 seed 同结果），禁止 Math.random 散布位置（旋转角度可以用伪随机 hash）
- 数据量大的时候做空间索引（网格桶），避免渲染 O(n)
```

---
---

## P0-2 标签样式预设

```
## 任务：标签样式预设（Aesthetic Labels）

### 背景

当前司天 PlanetMap/AreaMap 的文本标签是简单样式（统一字号/颜色）。参考 Azgaar 的 aesthetic labels：不同类型的节点有不同预设样式（大城市金色衬线、小镇灰色无衬线、区域标签半透明等）。

### 功能描述

1. **标签样式预设系统**：
   - city：金色衬线字体 + 外发光
   - town：白色无衬线 + 描边
   - village：灰色小字
   - region：半透明大字 + 背景条
   - building/facility：小字 + 图标旁
   - marker/自定义：用户可编辑文字内容（已有内联编辑）

2. **可视化样式编辑面板**：
   - 字体族选择（serif/sans-serif/mono）
   - 字号（8-32px）
   - 颜色选择器
   - 描边开关 + 颜色
   - 阴影/外发光开关
   - 背景条开关 + 透明度

3. **预设管理**：
   - 支持保存当前样式为预设
   - 预设下拉菜单快速切换
   - 预设导入/导出（JSON）

4. **渲染适配**：
   - 所有地图视图（PlanetMap/AreaMap/InteriorView）的标签统一走样式系统
   - 缩放时字号可选锁定屏幕像素或跟随地图坐标

### 实现要点

- 新建 src/renderer/src/utils/labelStyles.js（预设定义、渲染函数）
- 扩展现有文本渲染逻辑，根据节点 layer 匹配预设
- Settings 面板新增「标签样式」标签页
- 预设用 localStorage 或 .sitian/config/label-presets.json 持久化
- 支持从 GeoJSON 导入标签配置

### 验收标准

- [ ] 6 种预设可切换，视觉效果明显区分
- [ ] 自定义样式实时预览
- [ ] 预设保存/加载正常，重启后保留
- [ ] 三种视图（Planet/Area/Interior）标签样式一致
- [ ] 地图缩放时标签清晰可读
- [ ] npm run build 通过
- [ ] 至少 1 条回归测试用例
```

---
---

## P0-3 撤销历史面板

```
## 任务：撤销历史面板可视化

### 背景

当前司天有 undo/redo 功能，但只通过工具栏按钮操作，无法查看历史记录。用户无法回退到"任意一步"，只能逐步 undo。参考 PS 的历史记录面板。

### 功能描述

1. **可视化面板**：
   - dock 在底部或侧边（可折叠）
   - 列出操作历史（从旧到新），每条显示：
     - 序号
     - 操作名称（本地化：如"添加聚落""绘制地形""移动节点"）
     - 时间戳（可选）
   - 当前步高亮，未来的步骤灰色
   - 点击任意条目 = undo/redo 到该状态

2. **交互**：
   - 面板可折叠/展开（双击标题栏或点击切换按钮）
   - 面板高度自适应
   - 点击某条 = 跳转到该状态（触发多次 undo 或单次 redo+undo 链）

3. **操作名称**：
   - 从 undo 栈的 command.name 或 command.label 读取
   - 未命名的操作显示"未命名操作 #N"

### 实现要点

- 读取 store/undo.js 的 history 数组 + currentIndex
- 在 App.vue 或某容器组件dock 一个新的面板
- 不修改 undo.js 核心逻辑，只读取
- 跳转用 performUndo 循环或扩展 undo.js 增加 goTo(index) 方法

### 验收标准

- [ ] 面板实时显示操作历史
- [ ] 点击任意条目跳转到对应状态
- [ ] 当前步高亮正确
- [ ] undo/redo 按钮操作后面板跟随移动
- [ ] 面板可折叠不挡画布
- [ ] npm run build 通过
- [ ] 至少 1 条回归测试用例
```

---
---

## P0-4 小地图/缩略图

```
## 任务：小地图/缩略图导航

### 背景

大地图（尤其是行星地图数据密集时）需要快速导航到任意区域。右下角小地图显示当前视口在全图中的位置，支持点击跳转。

### 功能描述

1. **右下角小地图**：
   - 显示全图缩略（底图 + 主要节点/区域轮廓）
   - 半透明白色遮罩标记当前视口范围
   - 视口遮罩可拖动 = 平移画布
   - 点击非遮罩区域 = 画布跳转到该位置

2. **层级适配**：
   - PlanetMap：缩略显示整个行星 + 区域边界 + 聚落位置
   - AreaMap：缩略显示区域全图 + 内部标记
   - 其他视图可选禁用

3. **UI**：
   - 可折叠（按钮切换显隐）
   - 尺寸约 200x200px（可配置）
   - 背景半透明深色，不抢画布焦点

### 实现要点

- 新建组件 Minimap.vue
- 用离屏 canvas 或轻量 SVG 渲染缩略图（分层：底图→区域→节点→标记）
- 视口位置从 renderer.viewTransform 计算 → 映射为小地图坐标
- 拖动/点击事件反向换算为主画布坐标
- 性能用 rAF 节流 + dirty 标记

### 验收标准

- [ ] 小地图缩略清晰可辨主要元素
- [ ] 视口遮罩显示正确
- [ ] 拖动遮罩画布跟随
- [ ] 点击跳转定位准确
- [ ] 折叠/展开正常
- [ ] npm run build 通过
- [ ] 至少 1 条回归测试用例
```

---
---

## P1-1 河流编辑器（手动+保流向）

```
## 任务：河流编辑器——手动绘制 + 保持流向

### 背景

当前司天已有自动生成河流（高度梯度法），但无法手动编辑已有河流。用户需要：① 画一条新河流 ② 调整河流路径但保持流向逻辑。

参考 Azgaar 的 River Editor：沿路径绘制，自动从高到低排序节点。

### 功能描述

1. **手动绘制模式**：
   - 快捷键 Shift+R 进入河流模式
   - 点击多个节点作为河流路径（河流编辑器自动按高度排序：从高→低）
   - 双击完成
   - 河流渲染为蓝色曲线，线宽=流量（这里可简化为等宽）

2. **编辑已有河流**：
   - 点击河流进入编辑
   - 可拖拽中间节点调整路径（保持流向：节点按 y 坐标或高度排序）
   - 可删除节点（右键）
   - 可添加节点（Shift+点击边上）

3. **流向保持**：
   - 如果用户试图反向拖拽节点（拖到更高的位置），自动 swap 保持高→低
   - 或标记警告"河流只能从高处流向低处"并阻断操作

4. **删除**：Delete 键或右键菜单删除整条河流

### 实现要点

- 扩展 PlanetMap 交互逻辑或独立 composable useRiverEditor.js
- 河流数据存储：数组 [{id, nodes: [{x,y,riverId}], width, name}]
- 河流路径自动按 height 升序排列（或按用户点击顺序+高度校验）
- 参考现有Routes编辑器（LineRoute）的节点编辑模式
- 流向校验：读取 heightMath.js 的 getHeightAt() 函数

### 验收标准

- [ ] 手动绘制河流成功（点击多节点→双击完成）
- [ ] 河流自动从高流向低
- [ ] 拖拽节点不会反向
- [ ] 向低处拖拽有效，向高处自动 snapshot 或回退
- [ ] 删除河流 undo 正常
- [ ] 一次创建=单条 undo
- [ ] npm run build 通过
- [ ] 至少 1 条回归测试用例
```

---
---

## P1-2 道路编辑器（样式预设+沿等高线）

```
## 任务：道路编辑器——样式预设 + 沿等高线绘制

### 背景

当前司天已有 A* 自动生成道路（R4-2），但路径是系统算的。用户需要：① 手动绘制道路 ② 沿等高线自动调整路径（避开大高差）③ 让道路有"样式"（官道/山路/小径等视觉区分）。

### 功能描述

1. **手动绘制**：
   - 快捷键 Shift+J 进入道路模式
   - 点击起点→点击终点（类似画线）
   - 自动沿等高线使用 A* 计算中间路径
   - 生成一系列道路节点（可后续拖拽调整）

2. **等高线优化**：
   - 调用现有 generateRoadPath() 沿等高线寻路
   - 路径点自动吸附最近的缓坡
   - 单步高差 > 15 的地方自动绕行

3. **样式预设**：
   - highway：官道（金色 3px 实线，标注）
   - road：普通道路（棕色 2px）
   - path：山路（灰色 1px）
   - trail：小径（虚线）
   - 切换工具栏下拉选择

4. **编辑**：
   - 点击道路 = 选中
   - 拖拽中间节点 = 手动调整路径（保留样式）
   - Delete 删除整条

### 实现要点

- 基于 R4 的 generateRoadPath() A* 寻路逻辑
- 新建 RoadEditor 交互模块或扩展 RouteManager 中的道路笔画
- 道路数据存储在 mapData[id].routes[]（已有）增加 style 字段
- 渲染时根据 style 切换线宽/颜色/虚实
- 等高线检测复用 placement.js 的 heightAt()

### 验收标准

- [ ] 手动点击起点终点生成沿等高线路径
- [ ] 4 种样式可切换
- [ ] 路径明显避开大高差（等高线）
- [ ] 拖拽调整节点后路径不悬空
- [ ] 删除/撤销正常
- [ ] npm run build 通过
- [ ] 至少 1 条回归测试用例
```

---
---

## P1-3 聚落编辑器（规模/人口/文化归属）

```
## 任务：聚落编辑器——规模、人口、文化归属

### 背景

当前司天聚落只有 name + tags 信息，编辑能力薄弱。Azgaar 的 Burg editor 支持：规模（人口）滑块、文化选择（下拉）、k聚类归属、阵营颜色等。

### 功能描述

1. **规模/人口**：
   - 聚落详情面板增加人口输入（数字滑块或输入框）
   - 人口数值：100 ~ 1,000,000（对数滑块）
   - 聚落图标根据规模分级：
     - < 1k：小村庄
     - 1k ~ 10k：村庄
     - 10k ~ 100k：城镇
     - 100k+：城市
   - 分级影响图标大小（地图上视觉区分）

2. **文化归属**：
   - 下拉选择该聚落所属的文化 ID（从 mapData 中已有的 cultures 列表读取）
   - 文化 ID = -1 表示"无归属"
   - 显示文化名称 + 文化主色（如果有）

3. **阵营/所属势力**（高级）：
   - 如果未来有省份/国家数据，可关联此字段
   - 当前版本可实现纯数据字段 + UI 预留

4. **高级编辑窗口**：
   - 双击聚落详情面板 → 弹出"Burg Editor"专业窗口
   - 包含：人口输入、文化选择、尺寸滑块
   - 底部显示预估信息（"XX级城市"等）

### 实现要点

- 扩展 NodeDetailPanel 中聚落节点（layer === 'city'/'town'/'village'）的编辑区
- 数据结构 mapData[id].burgs[] 已有，扩展 population/culture 字段
- 聚落分级逻辑：判断 population 阈值返回 tier (village/town/city)
- 下拉项从 store 中获取：cultures 列表存于 mapData[id].cultures
- 参考 PlacementCity 的算分逻辑

### 验收标准

- [ ] 人口可输入变更
- [ ] 聚落图标按人口变化大小
- [ ] 文化下拉可选
- [ ] 村庄/城镇/城市有视觉区分
- [ ] 修改后 undo 正常
- [ ] 数据持久化到 mapdata.json
- [ ] npm run build 通过
- [ ] 至少 1 条回归测试用例
```

---
---

## P1-4 标记类型系统

```
## 任务：标记类型系统（Marker Types System）

### 背景

当前司天标记（Marker）只是坐标+名称+描述+颜色，所有标记视觉相同。Azgaar 有 Marker types：每种类型有专属图标、颜色、默认描述模板，所有该类型标记共享图标和颜色。

### 功能描述

1. **标记类型定义**：
   - 至少 6 种默认类型：
     - interest：兴趣点（红色三角）
     - settlement：前哨/定居（绿色圆点）
     - battle：战斗地点（交叉剑）
     - resource：资源标记（蓝色水晶）
     - danger：危险区域（黄色三角）
     - custom：自定义
   - 每种类型：icon name（Lucide）、color（hex）、label（中文显示名）
   - 所有该类型标记**默认**继承类型图标和颜色（可单个覆盖）

2. **类型管理面板**：
   - 设置面板新增「标记类型」标签页
   - 新建类型：选择图标（从 Icon.vue 数量中选）+ 颜色 + 名称
   - 删除类型：二次确认 + "将该类型所有标记转为 custom"
   - 类型排序拖拽

3. **标记节点编辑**：
   - 现有 Marker 节点详情面板增加 type 下拉（从类型列表选择）
   - 选择 type 后，自动继承该类型的默认 icon + color
   - 显示层级调整（icon / 名称 / 描述）

4. **渲染联动**：
   - 地图上 Marker 渲染根据 marker.type 查类型定义 → 使用对应图标
   - 缩放 < 0.5x 时只显示图标不显示名称（性能）

### 实现要点

- 新建 src/renderer/src/utils/markerTypes.js（默认类型定义 + 查询函数）
- 设置面板（SettingsPanel.vue）新增加标签页
- Marker 节点编辑（NodeDetailPanel）增加 type 选择
- markerType 配置区建议存 mapData[id].markerTypes 或 .sitian/config/marker-types.json
- 已有标记数据迁移：读取旧数据时 type 字段为空 → 默认为 custom

### 验收标准

- [ ] 6 种默认类型存在
- [ ] 类型创建/删除正常
- [ ] 标记继承类型和颜色
- [ ] 覆盖后保存再打开不丢
- [ ] 大面积标记渲染性能正常
- [ ] npm run build 通过
- [ ] 至少 1 条回归测试
```

---
---

## 执行顺序建议

1. P0-3 撤销历史面板（最小改动，先暖身）
2. P0-4 小地图（独立组件，无侵入）
3. P0-2 标签样式预设（基础 UI 能力）
4. P0-1 Relief icons 笔刷（笔刷交互模式验证）
5. P1-4 标记类型系统（数据模型基础，P1 其他功能前置）
6. P1-3 聚落编辑器（依赖标记/文化数据）
7. P1-2 道路编辑器（等高线寻路独立）
8. P1-1 河流编辑器（最复杂，放最后）

---

*提示词集由 Hermes Agent 生成，2026-09-14*
