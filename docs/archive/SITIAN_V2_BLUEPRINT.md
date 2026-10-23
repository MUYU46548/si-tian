# SiTian v2 编辑能力改进纲领

> 目标：从"几何编辑器"转型为"数据驱动地图编辑器"，达到 Azgaar FMG 级别的交互体验。

---

## 一、现状诊断

### 1.1 当前架构（"几何编辑"模型）

```
用户操作 → 编辑多边形顶点 → 更新 points[] → 重绘画布
```

**问题**：
- 编辑一个地形需要点击 N 个顶点 + 双击完成
- 没有笔刷，没有实时联动
- 生物群系/温度/降水是静态数据，不会随地形变化
- 交互反馈延迟（顶点拖拽 → 贝塞尔手柄 → 重绘）

### 1.2 目标架构（"数据驱动"模型）

```
用户操作 → 编辑数据层（高度图/文化图/...） → 自动派生 → 实时渲染
```

**特征**：
- 笔刷直接作用于数据层
- 高度变化 → 温度/降水/生物群系自动重算
- 实时反馈（<16ms）
- 撤销/重做基于数据快照

---

## 二、参考工具分析

### 2.1 Azgaar FMG（核心参考）

| 功能 | 实现方式 | 用户体验 |
|:---|:---|:---|
| **高度编辑** | 笔刷修改高度图（Float32Array） | 左键抬高、右键降低、滚轮调大小 |
| **生物群系** | 基于高度+温度+降水自动分类 | 编辑高度后生物群系立即变化 |
| **温度/降水** | 基于高度+纬度自动计算 | 可手动覆盖 |
| **聚落放置** | 点击放置，自动贴合最近水源/平原 | 智能放置，无需微调 |
| **河流** | 沿高度梯度自动生成 | 从高地向低地流动 |
| **文化/宗教** | 笔刷涂抹 + Voronoi 划分 | 像绘画一样简单 |
| **政治边界** | 省份多边形编辑 + 自动归属 | 可视化编辑 |
| **渲染** | Canvas 2D 多层叠加 | 实时预览，图层可切换 |

**核心设计原则**：
1. **数据层分离**：高度、温度、降水、生物群系、文化、宗教、政治是独立的数据层
2. **自动派生**：编辑高度 → 温度/降水/生物群系自动重算
3. **笔刷交互**：所有编辑都通过笔刷完成，而非顶点拖拽
4. **实时反馈**：每次操作立即渲染，无延迟

### 2.2 Wonderdraft / Inkarnate（交互参考）

| 功能 | 实现方式 | 用户体验 |
|:---|:---|:---|
| **自由绘制** | 笔刷绘制陆地/海洋 | 像画画一样自然 |
| **纹理笔刷** | 选择地形类型，拖动涂抹 | 实时预览边缘融合 |
| **符号放置** | 拖拽放置，自动对齐 | 智能吸附 |
| **区域填充** | 点击填充封闭区域 | 一键填充 |

**核心设计原则**：
1. **笔刷优先**：所有操作通过笔刷完成
2. **实时预览**：拖动时显示结果，松开确认
3. **容错性**：无限撤销，无破坏性操作
4. **视觉反馈**：hover 显示目标，点击确认

---

## 三、数据模型重设计

### 3.1 核心数据层

```
┌─────────────────────────────────────────────────────────────┐
│                      渲染层（Canvas 2D）                      │
├─────────────────────────────────────────────────────────────┤
│  政治边界层  │  文化层  │  宗教层  │  聚落层  │  道路层  │  标记层  │
├─────────────────────────────────────────────────────────────┤
│                      派生数据层                              │
│  生物群系 = f(高度, 温度, 降水)                              │
│  温度 = f(高度, 纬度)                                       │
│  降水 = f(温度, 风向)                                       │
├─────────────────────────────────────────────────────────────┤
│                      基础数据层                              │
│  高度图（Float32Array）← 用户直接编辑                        │
├─────────────────────────────────────────────────────────────┤
│                      网格层                                  │
│  Voronoi 细胞 / 网格点坐标                                   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 高度图数据结构

```javascript
// 高度图：每个网格点一个浮点值（0-100，20 为海平面）
heightmap: Float32Array  // length = 网格点数

// 温度：基于高度 + 纬度自动计算（可手动覆盖）
temperature: Float32Array  // -40°C ~ 50°C

// 降水：基于温度 + 风向自动计算（可手动覆盖）
precipitation: Float32Array  // 0-100

// 生物群系：基于高度 + 温度 + 降水自动分类
biomes: Uint8Array  // 0-12（对应 13 种生物群系）

// 文化：用户编辑（Voronoi 区域）
cultures: Int16Array  // -1 = 无，0+ = 文化 ID

// 宗教：用户编辑
religions: Int16Array  // -1 = 无，0+ = 宗教 ID

// 政治：省份多边形 + 归属
provinces: [{ id, name, color, cells: [...], culture, religion }]
```

### 3.3 自动派生规则

```javascript
// 温度计算（基于高度 + 纬度）
function calculateTemperature(height, latitude) {
  const baseTemp = 30 - Math.abs(latitude) * 0.6  // 纬度越高越冷
  const heightPenalty = Math.max(0, height - 20) * 0.5  // 海拔越高越冷
  return baseTemp - heightPenalty
}

// 降水计算（基于温度 + 风向 + 海洋距离）
function calculatePrecipitation(temperature, windDirection, oceanDistance) {
  const basePrecip = temperature > 0 ? 60 : 20  // 温暖地区降水多
  const oceanBonus = Math.max(0, 50 - oceanDistance * 2)  // 靠近海洋降水多
  return Math.min(100, basePrecip + oceanBonus)
}

// 生物群系分类（基于高度 + 温度 + 降水）
function classifyBiome(height, temperature, precipitation) {
  if (height < 20) return 'ocean'
  if (height > 80) return 'mountain'
  if (temperature < -10) return 'tundra'
  if (temperature < 5 && precipitation < 30) return 'cold_desert'
  if (temperature > 20 && precipitation > 70) return 'tropical_rainforest'
  if (temperature > 20 && precipitation > 40) return 'tropical_seasonal'
  if (temperature > 10 && precipitation > 50) return 'temperate_deciduous'
  if (temperature > 10 && precipitation < 30) return 'grassland'
  if (temperature > 5 && precipitation < 20) return 'hot_desert'
  if (height > 60) return 'highland'
  return 'grassland'
}
```

---

## 四、交互设计

### 4.1 笔刷系统

#### 4.1.1 高度笔刷

| 操作 | 行为 |
|:---|:---|
| 左键拖动 | 抬高地形 |
| 右键拖动 | 降低地形 |
| 滚轮 | 调整笔刷半径 |
| Shift + 滚轮 | 调整笔刷强度 |
| 双击 | 平滑区域 |

**笔刷形状**：圆形，软边缘（高斯衰减）

**笔刷强度**：中心最强，边缘衰减

```javascript
// 笔刷应用
function applyBrush(cx, cy, radius, strength, mode) {
  for (const cell of getCellsInRadius(cx, cy, radius)) {
    const dist = distance(cell.x, cell.y, cx, cy)
    const falloff = Math.exp(-dist * dist / (2 * radius * radius * 0.25))
    const delta = strength * falloff
    
    if (mode === 'raise') {
      cell.h = Math.min(100, cell.h + delta)
    } else if (mode === 'lower') {
      cell.h = Math.max(0, cell.h - delta)
    } else if (mode === 'smooth') {
      cell.h = averageNeighborHeight(cell)
    }
  }
  
  // 自动派生
  recalculateDerivedLayers()
}
```

#### 4.1.2 生物群系笔刷

| 操作 | 行为 |
|:---|:---|
| 选择生物群系类型 | 从调色板选择 |
| 左键拖动 | 涂抹生物群系 |
| 右键 | 恢复自动分类 |

#### 4.1.3 文化/宗教笔刷

| 操作 | 行为 |
|:---|:---|
| 选择文化/宗教 | 从调色板选择 |
| 左键拖动 | 涂抹文化/宗教 |
| 右键 | 清除 |

### 4.2 智能放置

#### 4.2.1 聚落放置

| 规则 | 实现 |
|:---|:---|
| 海拔限制 | 自动避开海洋（h < 20）和高山（h > 70） |
| 水源偏好 | 靠近河流/湖泊的权重更高 |
| 坡度限制 | 自动避开陡峭区域 |
| 生物群系偏好 | 森林/草原权重高，沙漠/苔原权重低 |

```javascript
function findOptimalBurgPosition(clickX, clickY) {
  const candidates = getCellsInRadius(clickX, clickY, 100)
  let best = null
  let bestScore = -Infinity
  
  for (const cell of candidates) {
    let score = 0
    if (cell.h < 20 || cell.h > 70) continue  // 避开海洋和高山
    score -= Math.abs(cell.h - 40) * 0.1  // 偏好中等海拔
    score += (100 - distanceToNearestWater(cell)) * 0.3  // 靠近水源
    score -= cell.slope * 0.2  // 避开陡坡
    score += biomeSuitability(cell.biome) * 0.4  // 生物群系适宜性
    
    if (score > bestScore) {
      bestScore = score
      best = cell
    }
  }
  return best
}
```

#### 4.2.2 道路生成

| 规则 | 实现 |
|:---|:---|
| 沿等高线 | 优先选择高度变化小的路径 |
| 避开高山 | 高度 > 60 的区域绕行 |
| 连接聚落 | 自动吸附到最近的聚落 |
| 河流交叉 | 自动添加桥梁标记 |

### 4.3 河流生成

```javascript
function generateRivers() {
  const rivers = []
  const sources = findHighElevationCells(60)  // 高山作为源头
  
  for (const source of sources) {
    const river = [source]
    let current = source
    
    while (current.h >= 20) {  // 流到海洋为止
      const neighbors = getNeighbors(current)
      const lowest = neighbors.reduce((a, b) => a.h < b.h ? a : b)
      
      if (lowest.h >= current.h) break  // 局部最低点（湖泊）
      
      river.push(lowest)
      current = lowest
    }
    
    rivers.push(river)
  }
  
  return rivers
}
```

---

## 五、渲染管线

### 5.1 分层渲染顺序

```
1. 海洋底色（基于高度图，h < 20 为海洋）
2. 地形纹理（基于生物群系配色）
3. 高度阴影（基于高度图的阴影/高光）
4. 河流（蓝色线条，线宽随流量）
5. 道路（棕色虚线）
6. 文化/宗教/政治边界（半透明叠加）
7. 聚落（图标 + 名称）
8. 标记（用户放置的标记）
9. 网格（可选）
10. 笔刷预览（hover 时显示）
```

### 5.2 实时渲染优化

| 技术 | 实现 |
|:---|:---|
| **离屏 Canvas** | 静态层（地形、海洋）预渲染为 Image，每帧只渲染动态层 |
| **脏矩形** | 只重绘受影响的区域 |
| **LOD** | 缩放 < 0.5x 时降低细节 |
| **Web Worker** | 高度图计算在 Worker 中执行，不阻塞 UI |

### 5.3 笔刷预览

```javascript
// 笔刷预览：hover 时显示圆形区域
function drawBrushPreview(ctx, x, y, radius, mode) {
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.strokeStyle = mode === 'raise' ? '#4a9eff' : '#ff6b6b'
  ctx.lineWidth = 2
  ctx.setLineDash([5, 5])
  ctx.stroke()
  ctx.setLineDash([])
  
  // 半透明填充
  ctx.fillStyle = mode === 'raise' ? 'rgba(74, 158, 255, 0.1)' : 'rgba(255, 107, 107, 0.1)'
  ctx.fill()
}
```

---

## 六、UI 布局

### 6.1 工具栏（左侧垂直）

```
┌─────────────┐
│  ✏️ 高度     │  ← 高度笔刷
│  🌿 生物群系  │  ← 生物群系笔刷
│  🎨 文化     │  ← 文化笔刷
│  ⛪ 宗教     │  ← 宗教笔刷
│  🏘 聚落     │  ← 聚落放置
│  🛣 道路     │  ← 道路绘制
│  🏷 标记     │  ← 标记放置
├─────────────┤
│  👁 图层     │  ← 图层开关
│  ↶ 撤销     │  ← 撤销
│  ↷ 重做     │  ← 重做
└─────────────┘
```

### 6.2 属性面板（右侧）

```
┌─────────────────┐
│  笔刷设置        │
│  ──────────────  │
│  半径: [====] 50 │
│  强度: [====] 50 │
│  形状: ● ○ □    │
├─────────────────┤
│  数据层选择      │
│  ──────────────  │
│  ☑ 高度         │
│  ☑ 生物群系      │
│  ☐ 温度         │
│  ☐ 降水         │
│  ☑ 文化         │
│  ☐ 宗教         │
├─────────────────┤
│  视图选项        │
│  ──────────────  │
│  ☑ 网格         │
│  ☑ 标签         │
│  ☐ 3D 预览      │
└─────────────────┘
```

### 6.3 底部状态栏

```
高度: 45  |  温度: 12°C  |  降水: 60  |  生物群系: 温带落叶林  |  坐标: (123, 456)
```

---

## 七、实施路线

### 阶段 1：高度图编辑器原型（2-3 周）

**目标**：在 ScenarioMap 上实现高度图笔刷编辑

**任务**：
1. 高度图数据结构（Float32Array）
2. 高度笔刷（抬高/降低/平滑）
3. 实时渲染（离屏 Canvas + 脏矩形）
4. 撤销/重做（数据快照）
5. 笔刷预览（hover 显示）

**验收**：
- 能用 5 分钟画出一座山脉
- 编辑高度后生物群系自动变化
- 撤销/重做正常工作

### 阶段 2：自动派生系统（1-2 周）

**目标**：高度变化自动重算温度/降水/生物群系

**任务**：
1. 温度计算（高度 + 纬度）
2. 降水计算（温度 + 风向）
3. 生物群系分类（高度 + 温度 + 降水）
4. 河流生成（沿高度梯度）

**验收**：
- 画一座山，山脚是森林，山腰是苔原，山顶是雪
- 河流从高山流向海洋

### 阶段 3：智能放置（1-2 周）

**目标**：聚落/道路/标记的智能放置

**任务**：
1. 聚落放置（自动贴合地形）
2. 道路生成（沿等高线）
3. 标记放置（自动对齐）

**验收**：
- 点击放置聚落，自动避开海洋和高山
- 点击两点生成道路，自动沿等高线

### 阶段 4：文化/宗教/政治（1-2 周）

**目标**：文化/宗教/政治边界编辑

**任务**：
1. 文化/宗教笔刷
2. 政治边界编辑
3. 图例和配色

**验收**：
- 用笔刷涂抹文化区域
- 编辑政治边界，自动更新归属

### 阶段 5：PlanetMap 迁移（2-3 周）

**目标**：将 PlanetMap 从几何编辑迁移到数据驱动

**任务**：
1. 地形编辑改为高度图笔刷
2. 聚落放置改为智能放置
3. 道路绘制改为自动生成

**验收**：
- PlanetMap 的编辑体验与 ScenarioMap 一致

---

## 八、技术决策

### 8.1 渲染引擎

**选择**：Canvas 2D（保持现状）

**理由**：
- Azgaar 用 Canvas 2D 实现了 60fps
- WebGL 学习成本高，ROI 低
- Canvas 2D 足以满足需求

### 8.2 数据结构

**选择**：TypedArray（Float32Array / Uint8Array）

**理由**：
- 内存效率高（10000 网格点 = 40KB）
- 计算速度快（CPU 友好）
- 易于序列化（JSON 或二进制）

### 8.3 撤销/重做

**选择**：数据快照（每步操作保存完整高度图副本）

**理由**：
- 实现简单
- 内存可控（10000 网格点 × 4 字节 = 40KB/快照，100 步 = 4MB）
- 切换速度快

### 8.4 性能目标

| 指标 | 目标 |
|:---|:---|
| 笔刷响应 | <16ms（60fps） |
| 自动派生 | <50ms |
| 渲染帧率 | >30fps（全图层） |
| 内存占用 | <100MB（含撤销栈） |

---

## 九、风险与缓解

| 风险 | 影响 | 缓解 |
|:---|:---|:---|
| 高度图分辨率过高导致性能问题 | 卡顿 | 动态 LOD，缩放时降低分辨率 |
| 自动派生计算量大 | 延迟 | Web Worker 异步计算 |
| 撤销栈内存占用高 | 内存泄漏 | 限制撤销步数（100 步） |
| 与现有数据模型不兼容 | 迁移困难 | 渐进式迁移，保留旧接口 |

---

## 十、验收标准

### 10.1 功能验收

- [ ] 高度笔刷：左键抬高、右键降低、滚轮调大小
- [ ] 生物群系自动派生：编辑高度后生物群系立即变化
- [ ] 温度/降水自动派生：基于高度 + 纬度
- [ ] 河流自动生成：从高山流向海洋
- [ ] 聚落智能放置：自动避开海洋和高山
- [ ] 道路自动生成：沿等高线
- [ ] 文化/宗教笔刷：涂抹文化/宗教区域
- [ ] 撤销/重做：100 步，切换速度 <100ms

### 10.2 性能验收

- [ ] 笔刷响应 <16ms
- [ ] 自动派生 <50ms
- [ ] 渲染帧率 >30fps
- [ ] 内存占用 <100MB

### 10.3 用户体验验收

- [ ] 新用户 5 分钟内学会基本操作
- [ ] 编辑一个区域（10 个聚落 + 道路 + 边界）<30 分钟
- [ ] 无需阅读文档即可完成常见操作

---

## 十一、与现有代码的关系

### 11.1 保留部分

- 七层视图架构（world → domain → system → system_detail → planet → area → interior）
- 数据模型（GeoNode、frontmatter 解析）
- Obsidian 同步链路
- 设置面板、关于面板等 UI 外壳
- Icon.vue 图标系统
- 测试框架

### 11.2 重做部分

- ScenarioMap 编辑逻辑（从顶点编辑改为高度图笔刷）
- PlanetMap 绘制逻辑（从多边形编辑改为笔刷）
- AreaMap 道路/标记编辑
- InteriorView 家具放置（简化交互）

### 11.3 新增部分

- 高度图数据结构
- 笔刷系统
- 自动派生系统
- 智能放置系统
- 河流生成算法

---

## 十二、总结

**核心转变**：从"编辑几何"到"编辑数据"。

**关键洞察**：Azgaar 的成功不在于功能多，而在于**交互模型正确**——笔刷编辑数据层，自动派生，实时反馈。

**实施策略**：从 ScenarioMap 开始，验证高度图编辑器原型，再逐步迁移到 PlanetMap。

**预期结果**：编辑体验从"垃圾"提升到"像 Azgaar 一样好用"。
