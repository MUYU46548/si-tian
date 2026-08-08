# 可视化地图编辑器是如何实现的：从技术选型到架构设计

> 专题研究笔记 | 2026-08-06
> 
> 本文面向希望从零构建一个"够用"的可视化地图编辑器的开发者，系统梳理图形技术选型、开源项目剖析、关键设计模式、性能优化策略，并给出实战技术栈推荐与避坑清单。

---

## 目录

1. [图形技术选型：SVG vs Canvas vs WebGL](#1-图形技术选型svg-vs-canvas-vs-webgl)
2. [典型开源地图编辑器实现剖析](#2-典型开源地图编辑器实现剖析)
3. [编辑器的关键能力设计模式](#3-编辑器的关键能力设计模式)
4. [性能与大数据量处理](#4-性能与大数据量处理)
5. [实战建议：如何从零做一个"够用"的可视化地图编辑器](#5-实战建议如何从零做一个够用的可视化地图编辑器)
6. [参考资料](#6-参考资料)

---

## 1. 图形技术选型：SVG vs Canvas vs WebGL

地图编辑器的渲染层是整个系统的地基。三种主流 Web 图形技术——SVG、Canvas 2D、WebGL——在地图编辑场景下各有鲜明的优劣谱系。选型失误往往导致后期推倒重来，因此必须在动手前做清晰判断。

### 1.1 三种渲染模型的核心差异

#### SVG（Scalable Vector Graphics）

SVG 是基于 DOM 的保留模式（retained mode）渲染：每个图形元素（`<path>`、`<circle>`、`<polygon>`）都是 DOM 节点，浏览器维护其内部表示，自动处理重绘。

| 维度 | 表现 |
|------|------|
| **渲染模式** | 保留模式（Retained Mode），浏览器维护场景图 |
| **元素数量** | 舒适区 ~500 以下 DOM 节点；超过 3000-5000 节点后帧率显著下降 |
| **事件处理** | 原生支持——每个元素独立响应 click/hover/drag，无需手动命中检测 |
| **性能** | 优势在少量元素场景；劣势在大规模场景（DOM 操作触发 reflow/repaint） |
| **跨端兼容性** | 极佳——IE9+、所有移动端浏览器原生支持 |
| **开发体验** | 最友好——可直接用 CSS 样式、浏览器 DevTools 检查、支持无障碍 ARIA |
| **内存** | 每个节点携带 DOM 开销，内存占用高 |

**典型适用场景：** 要素数量 < 1000 的专题地图编辑器、示意图工具、需要无障碍支持或重度依赖 CSS 动画的场景。

#### Canvas 2D

Canvas 是立即模式（immediate mode）渲染：开发者每帧手动绘制像素，浏览器不维护任何场景状态。

| 维度 | 表现 |
|------|------|
| **渲染模式** | 立即模式（Immediate Mode），手动绘制每一帧 |
| **元素数量** | 舒适区 ~5000-50000 取决于绘制复杂度；上限远高于 SVG |
| **事件处理** | 需手动实现命中检测（hit detection）——颜色拾取法或几何算法 |
| **性能** | 优势在大规模绘制；劣势在无硬件加速（CPU 绘制） |
| **跨端兼容性** | 优秀——所有现代浏览器 + 移动端 |
| **开发体验** | 中等——需自行管理场景循环、拾取、脏矩形优化 |
| **内存** | 低——仅存储像素缓冲区和应用层数据 |

**典型适用场景：** 中等规模地图编辑器（1000-50000 要素）、需要热力图/粒子效果、游戏化交互。

#### WebGL

WebGL 是直接访问 GPU 的底层渲染 API，通过着色器程序在图元级别操作。

| 维度 | 表现 |
|------|------|
| **渲染模式** | 立即模式 + GPU 着色器管线 |
| **元素数量** | 百万级要素仍可维持 60fps（配合实例化渲染） |
| **事件处理** | 需完全手动实现——颜色缓冲拾取或 GPU 计算 |
| **性能** | 极高——硬件加速、批量渲染、instancing |
| **跨端兼容性** | 良好——桌面端完美，移动端受 GPU 性能和电量限制 |
| **开发体验** | 最复杂——需掌握 GLSL 着色器、缓冲区管理、矩阵变换 |
| **内存** | GPU 显存 + 应用层缓冲 |

**典型适用场景：** 超大规模数据可视化（10 万+ 要素）、3D 地图、需要自定义着色器效果。

### 1.2 结合地图/图表库案例

| 技术栈 | 代表项目 | 典型场景 |
|--------|---------|---------|
| SVG | D3.js、Raphael、JointJS | 力导向图、拓扑图、流程编辑器 |
| Canvas 2D | Leaflet（默认渲染器）、Konva.js、Fabric.js | 轻量级交互地图、画布编辑器 |
| WebGL | Mapbox GL JS / MapLibre GL、Deck.gl、PixiJS | 大规模矢量地图、3D 城市、大数据可视化 |

**关键案例：**

- **D3.js**（SVG）：数据新闻领域的标杆，通过 data join 将数据绑定到 SVG 节点。在"纽约时代广场人流可视化"等项目中，D3 用不足 500 个 SVG 元素实现了丰富交互。但一旦数据量过千，开发者就需要切换到 Canvas 或 WebGL。

- **Leaflet**（Canvas/SVG 双模式）：默认用 SVG 渲染标记和矢量层（方便交互），用 Canvas 渲染大量标记（`L.canvas()` 渲染器）。这种混合策略在小到中等规模地图中非常实用。

- **Mapbox GL JS**（WebGL）：将地图样式和矢量瓦片完全 GPU 化。在 Uber 的 Kepler.gl 中，Deck.gl 用 WebGL 在浏览器中渲染 100 万+ 数据点并保持流畅交互。

- **Deck.gl**（WebGL）：Uber 开源的地理可视化库，纯 WebGL 渲染。其 ScatterplotLayer 在单一图层中渲染百万级散点，性能碾压任何 SVG 方案。

### 1.3 决策树：什么时候用什么

```
你的地图编辑器要素数量大概是多少？
│
├─ < 500 要素，且需要丰富交互（hover tooltip、无障碍、CSS 动画）
│   └─ ✅ 选 SVG
│       推荐：D3.js + 自研选择系统，或用 JointJS/Flowchart.js
│
├─ 500 ~ 5000 要素
│   └─ 需要原生事件处理吗？
│       ├─ 是，且不需要复杂特效
│       │   └─ ⚠️ 仍可选 SVG（需虚拟化 + 符号化优化）
│       └─ 否/需要高性能绘制
│           └─ ✅ 选 Canvas 2D
│               推荐：Leaflet + Leaflet.draw，或自研 Canvas 渲染层
│
├─ 5000 ~ 50000 要素
│   └─ 需要 3D 或复杂着色器效果吗？
│       ├─ 否
│       │   └─ ✅ 选 Canvas 2D + 空间索引（R-tree）
│       │       推荐：MapLibre GL 简化模式，或自研 Canvas 渲染 + rbush
│       └─ 是
│           └─ ✅ 选 WebGL
│               推荐：Deck.gl / MapLibre GL JS
│
└─ > 50000 要素
    └─ ✅ 必须 WebGL
        推荐：Deck.gl（地理图层） / PixiJS（2D 游戏化）
        配合：矢量瓦片（MVT）+ Web Worker 离屏计算
```

### 1.4 混合渲染策略

实际项目中，很少有非此即彼的选择。成熟的地图编辑器往往采用**混合渲染策略**：

- **底图瓦片**：用 WebGL（MapLibre GL）或 Image Tile（Leaflet）
- **矢量编辑层**：用 Canvas 2D 或 SVG（取决于要素数量）
- **控制手柄/UI 覆盖层**：用 DOM/SVG
- **大数据背景层**：用 WebGL（Deck.gl）

例如，Figma 的画布使用 WebGL 渲染像素内容，但属性面板、工具栏使用 DOM。这种"渲染层 + UI 层分离"的架构值得借鉴。

---

## 2. 典型开源地图编辑器实现剖析

### 2.1 基于 Leaflet 的编辑方案：Leaflet.draw

**项目地址：** https://github.com/Leaflet/Leaflet.draw

**Star 数：** ~2k（已归档，但生态庞大）

**定位：** 最广泛使用的轻量级矢量绘制和编辑插件。

#### 整体架构

```
┌─────────────────────────────────────────┐
│              Map (L.map)                │
│  ┌───────────────────────────────────┐  │
│  │     FeatureGroup (drawnItems)     │  │  ← 可编辑图层容器
│  │   ┌─────┐ ┌────────┐ ┌────────┐  │  │
│  │   │Marker│ │Polyline│ │Polygon │  │  │  ← 编辑目标层
│  │   └─────┘ └────────┘ └────────┘  │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │    L.Control.Draw (Toolbar)       │  │  ← 工具栏 UI
│  │   ┌─────────┬─────────┬─────────┐ │  │
│  │   │  Draw   │  Edit   │ Remove  │ │  │  ← 三种操作模式
│  │   └─────────┴─────────┴─────────┘ │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │   Handler.* (Draw/Edit handlers)  │  │  ← 交互逻辑层
│  │   Draw.Polygon / Edit.Polyline    │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**核心设计：**
- **渲染层**：直接复用 Leaflet 的图层系统（`L.Polygon`、`L.Polyline`、`L.Marker`），底层使用 SVG（VML for IE8）
- **数据层**：没有独立的 FeatureStore——可编辑要素存储在 `L.FeatureGroup` 中，通过 `toGeoJSON()` 导出
- **状态管理**：通过事件系统实现——`L.Draw.Event.CREATED`、`L.Draw.Event.EDITED`、`L.Draw.Event.DELETED`
- **持久化**：不提供内置持久化，需监听事件后自行保存 GeoJSON

#### 编辑交互实现

```javascript
// 初始化可编辑图层组
var drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

// 配置绘制和编辑控制
var drawControl = new L.Control.Draw({
    position: 'top-left',
    draw: {
        polygon: {
            allowIntersection: false,  // 禁止自相交
            showArea: true,
            shapeOptions: { color: '#bada55' }
        },
        polyline: { shapeOptions: { color: '#f357a1', weight: 8 } },
        rectangle: { shapeOptions: { clickable: true } },
        circle: false,  // 关闭圆形工具
        marker: { icon: new MyCustomMarker() }
    },
    edit: {
        featureGroup: drawnItems,  // 关键：指定要编辑的图层组
        remove: true
    }
});
map.addControl(drawControl);

// 监听绘制完成事件
map.on(L.Draw.Event.CREATED, function (e) {
    var type = e.layerType, layer = e.layer;
    if (type === 'marker') {
        layer.bindPopup('A popup!');
    }
    drawnItems.addLayer(layer);  // 将新要素加入可编辑集合
});

// 监听编辑/删除事件
map.on(L.Draw.Event.EDITED, function (e) {
    var layers = e.layers;
    layers.eachLayer(function (layer) {
        console.log('Edited:', layer.toGeoJSON());
    });
});
```

**关键机制：**
- **选中态**：点击要素时，Leaflet 自动为该要素添加 `leaflet-edit-selected` CSS 类，并显示编辑顶点（通过 `L.EditHandle` 叠加层）
- **拖拽编辑**：`L.EditToolbar.Edit` handler 为每个顶点创建 `L.marker` 作为控制点，拖拽时实时更新父几何体的坐标数组
- **撤销重做**：**不提供内置撤销重做**——这是 Leaflet.draw 最大的短板。社区方案是监听事件后手动维护命令栈

#### 扩展性

- **自定义工具**：可通过 `L.Draw.Feature` 子类化实现自定义绘制工具
- **自定义 marker**：`draw.marker.icon` 接受任何 `L.Icon` 实例
- **消息定制**：`draw.error` 对象支持自定义错误提示和 intersect 消息

#### 局限性

- 已归档，不再活跃维护
- 无内置撤销/重做
- 要素数量受限于 SVG DOM（>1000 个多边形时性能显著下降）
- 不支持复杂拓扑关系（如岛屿多边形、多部件几何体）

---

### 2.2 基于 Mapbox-GL / MapLibre-GL 的绘制编辑方案：mapbox-gl-draw

**项目地址：** https://github.com/mapbox/mapbox-gl-draw

**定位：** 为 Mapbox GL JS / MapLibre GL JS 提供绘制和编辑能力，是 WebGL 地图编辑的事实标准。

#### 整体架构

```
┌──────────────────────────────────────────────┐
│              Map (mapboxgl.Map)              │
│         WebGL 渲染层（矢量瓦片/GeoJSON）       │
│  ┌────────────────────────────────────────┐  │
│  │         GeoJSON Source / Layer         │  │  ← 数据层
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │      MapboxDraw (Control)              │  │  ← 控件入口
│  │  ┌──────────────────────────────────┐  │  │
│  │  │       Modes (交互模式)            │  │  │
│  │  │  simple_select / direct_select   │  │  │
│  │  │  draw_point / draw_polygon       │  │  │
│  │  └──────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │       Store (Internal)           │  │  │
│  │  │  FeatureIndex / ContextMenu      │  │  │
│  │  └──────────────────────────────────┘  │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

**核心设计：**
- **渲染层**：完全复用 Mapbox GL 的 WebGL 渲染管线。Draw 本身不直接渲染任何像素，而是通过操作 GeoJSON Source 让地图引擎渲染
- **状态管理**：内部 Store 维护所有 GeoJSON Feature 的集合（`_store`），通过事件发射器（EventEmitter）广播变更
- **交互模式系统（Modes）**：这是 mapbox-gl-draw 最核心的设计——将不同交互抽象为独立 Mode

#### 交互模式（Modes）详解

mapbox-gl-draw 定义了 6 种内置模式：

| 模式 | 功能 | 交互逻辑 |
|------|------|---------|
| `simple_select` | 选择、删除、拖拽要素 | 点击空白取消选择；点击要素选中；拖拽整体移动 |
| `direct_select` | 编辑顶点、添加顶点 | 选中线/面要素后点击顶点进入；可拖拽/删除顶点 |
| `draw_point` | 绘制点 | 单击放置点 |
| `draw_line_string` | 绘制线 | 单击放置顶点，双击完成 |
| `draw_polygon` | 绘制面 | 单击放置顶点，双击或闭合完成 |

**模式切换机制**：

```javascript
// 在 simple_select 模式下点击一个顶点
// 内部自动切换到 direct_select 模式
Draw.changeMode('direct_select', {
    featureId: selectedFeatureId  // 指定要编辑的要素
});

// 开始绘制多边形
Draw.changeMode('draw_polygon');
```

#### 编辑交互实现

```javascript
// 初始化 Draw
const Draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {
        polygon: true,
        trash: true  // 显示删除按钮
    },
    modes: {
        ...MapboxDraw.modes,  // 继承所有默认模式
        // 可在此处覆盖或扩展自定义模式
    },
    styles: [  // 自定义渲染样式（GL Style）
        {
            id: 'gl-draw-polygon-fill-active',
            type: 'fill',
            filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'true']],
            paint: { 'fill-color': '#3bb2d0', 'fill-opacity': 0.3 }
        },
        {
            id: 'gl-draw-polygon-stroke-active',
            type: 'line',
            filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'true']],
            paint: { 'line-color': '#3bb2d0', 'line-width': 2 }
        }
    ]
});

map.addControl(Draw, 'top-left');

// 监听绘制完成
map.on('draw.create', (e) => {
    const feature = e.features[0];
    console.log('Created:', feature);
    // 保存到后端或本地存储
});

// 监听更新（编辑、拖拽、删除）
map.on('draw.update', (e) => {
    const feature = e.features[0];
    console.log('Updated:', feature);
});

// 监听删除
map.on('draw.delete', (e) => {
    console.log('Deleted:', e.features[0].id);
});

// 选中状态变化
map.on('draw.selectionchange', (e) => {
    console.log('Selected:', e.features);
});
```

**关键机制：**

- **选中态**：每个 Feature 有一个 `active` 属性（`'true'` / `'false'`）。样式系统根据 `active` 状态切换 GL paint properties，实现高亮
- **拖拽编辑**：`simple_select` 模式下拖拽时，实时更新 Feature 坐标并通过 `Draw.getAll()` 触发 Source 更新
- **顶点编辑**：`direct_select` 模式为每个顶点创建隐形控制点，使用 `map.queryRenderedFeatures()` 实现拾取
- **撤销重做**：**仍无内置撤销重做**——但社区有 `mapbox-gl-draw-undo` 等插件通过拦截事件实现

#### 扩展性

- **自定义模式**：这是 mapbox-gl-draw 最强大的扩展点

```javascript
// 自定义"矩形绘制"模式
const DrawRectangle = {
    // 点击第一个角点
    onTap(state, e) {
        if (state.rectangle) return;
        state.rectangle = Draw.create('feature', [
            [e.lngLat.lng, e.lngLat.lat]
        ], 'draw_rectangle_active');
        state.rectangle.updateCoordinate('0.0', e.lngLat.lng, e.lngLat.lat);
    },
    // 移动鼠标时实时更新矩形
    onMouseMove(state, e) {
        if (!state.rectangle) return;
        const start = state.rectangle.getCoordinate('0.0');
        state.rectangle.updateCoordinate('0.1', e.lngLat.lng, start[1]);
        state.rectangle.updateCoordinate('0.2', e.lngLat.lng, e.lngLat.lat);
        state.rectangle.updateCoordinate('0.3', start[0], e.lngLat.lat);
    },
    // 点击第二个角点完成
    onClick(state, e) {
        // ...完成绘制
    }
};

// 注册模式
const Draw = new MapboxDraw({
    modes: {
        ...MapboxDraw.modes,
        draw_rectangle: DrawRectangle
    }
});
```

- **自定义样式**：完全遵循 Mapbox GL Style Spec，支持数据驱动样式（data-driven styling）
- **自定义控件**：`controls` 配置对象控制工具栏显示
- **事件拦截**：`draw.modechange`、`draw.actionable` 等事件允许细粒度控制

---

### 2.3 专门的 GeoJSON 编辑器：geojson.io

**项目地址：** https://github.com/mapbox/geojson.io

**定位：** 浏览器端的轻量级 GeoJSON 创建和编辑工具，由 Mapbox 维护。

#### 整体架构

```
┌─────────────────────────────────────────────┐
│              Browser Application            │
│  ┌───────────────────────────────────────┐  │
│  │          UI Layer (jQuery)            │  │
│  │  Toolbar / Map Container / Code Editor │  │
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │       Map Rendering (Leaflet)         │  │
│  │   L.geoJSON() — SVG 渲染矢量要素       │  │
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │      Data Flow (Observable)           │  │
│  │  GeoJSON (source of truth)            │  │
│  │    ↕ 双向同步                          │  │
│  │  Code Editor (CodeMirror)             │  │
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │     Export / Import / Gist / URL      │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

**核心设计：**
- **渲染层**：Leaflet + SVG 渲染，适合中小规模数据
- **数据层**：单一 GeoJSON 对象作为 source of truth。地图和代码编辑器双向绑定——编辑地图要素时自动更新 GeoJSON 文本，修改代码时重新渲染地图
- **状态管理**：早期使用 jQuery + 自定义事件，较新的版本引入了一些响应式机制
- **持久化**：支持 GitHub Gist、URL hash、本地文件下载

#### 关键交互

```javascript
// geojson.io 的核心数据流（简化版）
var geojson = {
    type: "FeatureCollection",
    features: []
};

// 地图 → 代码编辑器（单向流）
function updateEditor() {
    var json = JSON.stringify(geojson, null, 2);
    editor.setValue(json);
    // 更新 URL hash
    location.hash = L.Util.encodeParam(geojson);
}

// 代码编辑器 → 地图（反向流）
function updateMap() {
    try {
        geojson = JSON.parse(editor.getValue());
        map.eachLayer(function (layer) {
            if (layer.feature) map.removeLayer(layer);
        });
        L.geoJSON(geojson, {
            onEachFeature: function (feature, layer) {
                layer.on('click', function () {
                    // 选中逻辑
                });
            }
        }).addTo(map);
    } catch (e) {
        // JSON 解析失败时显示错误
    }
}
```

#### 局限性

- 无撤销/重做
- 无属性编辑器（只能编辑几何坐标）
- 数据量增大后性能急剧下降
- 不支持自定义投影（仅 Web Mercator）

---

### 2.4 其他值得关注的项目

| 项目 | 技术栈 | 特色 |
|------|--------|------|
| **Krata Maps** | React + Leaflet | 专注于区域划分编辑 |
| **softwarity/geojson-editor** | Vue + Leaflet | 纯浏览器端 GeoJSON 编辑 |
| **google-developers/simple-geojson-editor** | jQuery + Google Maps | Google 官方简化版 |
| **turf.js** | 纯 JS 库 | 几何分析引擎，常与上述编辑器配合使用 |
| **OpenLayers Draw** | OpenLayers | 支持更复杂的投影和坐标系 |
| **draw-polygon (openstreetmap)** | iD editor (D3.js) | OSM 的默认编辑器，使用 SVG + D3 |

---

## 3. 编辑器的关键能力设计模式

### 3.1 选中状态与当前编辑工具管理

地图编辑器的核心状态通常包括：

```typescript
interface EditorState {
    // 当前激活的工具
    activeTool: 'select' | 'point' | 'line' | 'polygon' | 'rectangle' | 'circle';
    
    // 选中的要素
    selectedFeatureIds: Set<string>;
    
    // 当前正在编辑的要素（顶点编辑模式）
    editingFeatureId: string | null;
    
    // 当前绘制中的临时几何体
    drawingInProgress: boolean;
    drawingVertices: [number, number][];
    
    // 悬停状态
    hoveredFeatureId: string | null;
}
```

#### 模式-状态机设计

最成熟的实现（如 mapbox-gl-draw）将每种交互封装为独立的"模式"（Mode），状态机控制模式切换：

```
                    ┌──────────────────┐
                    │   simple_select  │ ← 默认模式
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │ click feature │ click vertex │ click empty
              ▼               ▼              ▼
    ┌─────────────┐  ┌──────────────┐  (deselect all)
    │ 保持选中状态  │  │direct_select │
    │ (可拖拽移动)  │  │  (编辑顶点)   │
    └─────────────┘  └──────────────┘
              │               │
              │ drag end      │ click elsewhere
              ▼               ▼
          (触发 update)   返回 simple_select
```

**实现伪代码：**

```javascript
class ModeManager {
    constructor() {
        this.currentMode = null;
        this.state = {
            selectedFeatureIds: new Set(),
            drawingInProgress: false,
            drawingVertices: []
        };
    }
    
    changeMode(modeName, options = {}) {
        // 退出当前模式
        if (this.currentMode) {
            this.currentMode.onStop && this.currentMode.onStop();
        }
        
        // 切换到新模式
        this.currentMode = Modes[modeName];
        this.currentMode.onStart && this.currentMode.onStart(this.state, options);
        
        // 广播事件
        this.emit('modechange', modeName);
    }
    
    // 将鼠标/键盘事件转发给当前模式
    handleMouseEvent(event) {
        if (!this.currentMode) return;
        const handler = this.currentMode[`on${event.type}`];
        if (handler) handler(this.state, event);
    }
}
```

#### 选中态的视觉反馈

选中态需要通过渲染层体现。不同渲染技术的实现方式：

- **SVG**：直接修改元素的 class 或 attribute（`element.classList.add('selected')`）
- **Canvas**：根据 Feature 的 `selected` 属性在绘制时切换样式
- **WebGL**：通过 Mapbox GL Style 的 filter 属性切换图层 paint properties

### 3.2 撤销 / 重做（Undo / Redo）

撤销重做是编辑器的必备能力，主流实现有两种策略：

#### 策略一：命令模式（Command Pattern）

将每个操作封装为独立的 Command 对象，包含 `execute()` 和 `undo()` 方法。

```javascript
// Command 基类
class EditorCommand {
    execute() { throw new Error('Not implemented'); }
    undo() { throw new Error('Not implemented'); }
    redo() { return this.execute(); }
}

// 具体命令：创建要素
class CreateFeatureCommand extends EditorCommand {
    constructor(feature, store) {
        super();
        this.feature = feature;
        this.store = store;
    }
    execute() {
        this.store.add(this.feature);
    }
    undo() {
        this.store.remove(this.feature.id);
    }
}

// 具体命令：移动要素
class MoveFeatureCommand extends EditorCommand {
    constructor(featureId, delta, store) {
        super();
        this.featureId = featureId;
        this.delta = delta;  // [dx, dy]
        this.store = store;
    }
    execute() {
        const feature = this.store.get(this.featureId);
        feature.geometry.coordinates = feature.geometry.coordinates.map(
            coord => [coord[0] + this.delta[0], coord[1] + this.delta[1]]
        );
        this.store.update(feature);
    }
    undo() {
        const feature = this.store.get(this.featureId);
        feature.geometry.coordinates = feature.geometry.coordinates.map(
            coord => [coord[0] - this.delta[0], coord[1] - this.delta[1]]
        );
        this.store.update(feature);
    }
}

// 命令管理器
class CommandManager {
    constructor(limit = 100) {
        this.history = [];
        this.future = [];
        this.limit = limit;
    }
    
    execute(command) {
        command.execute();
        this.history.push(command);
        this.future = [];  // 清空 redo 栈
        
        // 限制历史栈大小
        if (this.history.length > this.limit) {
            this.history.shift();
        }
    }
    
    undo() {
        if (this.history.length === 0) return;
        const command = this.history.pop();
        command.undo();
        this.future.push(command);
    }
    
    redo() {
        if (this.future.length === 0) return;
        const command = this.future.pop();
        command.redo();
        this.history.push(command);
    }
    
    canUndo() { return this.history.length > 0; }
    canRedo() { return this.future.length > 0; }
}
```

**优点：** 精确控制、支持宏命令（合并多个命令为一个）、易于序列化
**缺点：** 每个操作都要写一个 Command 类、内存占用随历史增长

#### 策略二：快照模式（Snapshot / Memento）

在每次操作前后保存完整或差异化的状态快照。

```javascript
class SnapshotHistory {
    constructor(limit = 50) {
        this.snapshots = [];
        this.currentIndex = -1;
        this.limit = limit;
    }
    
    // 保存当前状态
    push(state) {
        // 如果当前不在最新位置，丢弃后续快照
        if (this.currentIndex < this.snapshots.length - 1) {
            this.snapshots = this.snapshots.slice(0, this.currentIndex + 1);
        }
        
        // 保存深拷贝（或使用 immutable 库的引用）
        this.snapshots.push(JSON.parse(JSON.stringify(state)));
        
        // 限制大小
        if (this.snapshots.length > this.limit) {
            this.snapshots.shift();
        } else {
            this.currentIndex++;
        }
    }
    
    undo() {
        if (this.currentIndex <= 0) return null;
        this.currentIndex--;
        return JSON.parse(JSON.stringify(this.snapshots[this.currentIndex]));
    }
    
    redo() {
        if (this.currentIndex >= this.snapshots.length - 1) return null;
        this.currentIndex++;
        return JSON.parse(JSON.stringify(this.snapshots[this.currentIndex]));
    }
}
```

**优点：** 实现简单、无需为每个操作编写类
**缺点：** 内存占用高（大量要素时）、无法描述操作语义（UI 无法显示"撤销移动"）

#### 策略三：混合模式（推荐）

现代编辑器（如 Figma、Mapbox Studio）通常采用混合策略：

1. **轻量级操作用命令模式**：移动、顶点编辑、属性变更
2. **重量级操作用快照**：导入大文件、批量操作
3. **合并连续操作**：拖拽过程中的多次移动合并为一个命令

```javascript
// 合并连续拖拽
let dragCommand = null;

onDragStart() {
    dragCommand = new MoveFeatureCommand(featureId, [0, 0], store);
}

onDrag(delta) {
    // 更新命令的 delta，但不立即执行
    dragCommand.delta = delta;
    // 直接更新视图（不经过 store）
    viewLayer.moveFeature(featureId, delta);
}

onDragEnd() {
    commandManager.execute(dragCommand);
    dragCommand = null;
}
```

### 3.3 拓扑一致性保证

地图编辑器必须保证几何体的拓扑有效性：

#### 常见拓扑规则

| 规则 | 描述 | 校验方式 |
|------|------|---------|
| 多边形闭合 | 首尾坐标相同 | `coordinates[0][0] === coordinates[n][0]` |
| 无自相交 | 边与边不相交 | 使用 turf.lineIntersect() 检测 |
| 环的方向 | 外环逆时针、内环顺时针 | Shoelace 公式计算有向面积 |
| 无重复顶点 | 相邻顶点不重合 | 逐对比较 |
| 最小顶点数 | 多边形至少 4 个点（三角形+闭合点） | `coordinates.length >= 4` |

#### 自相交检测与修复

```javascript
// 使用 Turf.js 检测自相交
function isSelfIntersecting(polygon) {
    const coords = polygon.geometry.coordinates[0];
    const line = turf.lineString(coords);
    const intersects = turf.lineIntersect(line, line);
    // 过滤掉相邻边的交点
    return intersects.features.length > coords.length - 1;
}

// 修复自相交（简化版：移除相交的顶点）
function fixSelfIntersection(polygon) {
    // 使用 Grehu-Hoppe 算法或 Earcut 重新三角化
    // 这里展示简化版
    const cleanCoords = [];
    const coords = polygon.geometry.coordinates[0];
    for (let i = 0; i < coords.length - 1; i++) {
        let intersects = false;
        for (let j = i + 2; j < coords.length - 1; j++) {
            if (j === i + 1 || (i === 0 && j === coords.length - 2)) continue;
            if (linesIntersect(coords[i], coords[i+1], coords[j], coords[j+1])) {
                intersects = true;
                break;
            }
        }
        if (!intersects) cleanCoords.push(coords[i]);
    }
    cleanCoords.push(cleanCoords[0]);  // 闭合
    return turf.polygon([cleanCoords]);
}
```

#### 实时校验策略

- **绘制中**：实时显示面积/周长、高亮显示自相交边（红色）
- **编辑中**：顶点拖拽后立即校验，无效时回退到上一有效位置
- **保存前**：全面校验所有几何体，列出所有错误供用户选择修复或忽略

### 3.4 最小可用地图编辑器的模块划分

```
┌─────────────────────────────────────────────────────────┐
│                   Map Editor Core                        │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Renderer    │  │ Interaction  │  │ State        │   │
│  │ (渲染层)    │  │ Manager      │  │ Manager      │   │
│  │             │  │ (交互管理器)  │  │ (状态管理)    │   │
│  │ - draw()    │  │ - onMouseDown│  │ - features   │   │
│  │ - hitTest() │  │ - onMouseMove│  │ - selection  │   │
│  │ - pan()     │  │ - onMouseUp  │  │ - mode       │   │
│  │ - zoom()    │  │ - onKeyPress │  │ - history    │   │
│  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                │                  │           │
│         └────────────────┼──────────────────┘           │
│                          │                              │
│  ┌───────────────────────┴───────────────────────────┐  │
│  │              Feature Store (数据层)                 │  │
│  │  - add(feature) / remove(id) / update(feature)     │  │
│  │  - get(id) / getAll() / query(bbox)                │  │
│  │  - on('change', callback)                          │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Persistence Layer (持久化层)           │  │
│  │  - save() / load() / autoSave(interval)           │  │
│  │  - exportGeoJSON() / importGeoJSON()              │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**伪代码实现：**

```javascript
// === Feature Store ===
class FeatureStore extends EventEmitter {
    constructor() {
        super();
        this.features = new Map();  // id → Feature
        this.spatialIndex = new RBush();  // R-tree 空间索引
    }
    
    add(feature) {
        feature.id = feature.id || uuid();
        this.features.set(feature.id, feature);
        this.spatialIndex.insert(featureToBbox(feature));
        this.emit('add', feature);
        this.emit('change');
    }
    
    remove(id) {
        const feature = this.features.get(id);
        if (!feature) return;
        this.spatialIndex.remove(featureToBbox(feature));
        this.features.delete(id);
        this.emit('remove', feature);
        this.emit('change');
    }
    
    update(feature) {
        this.remove(feature.id);
        this.add(feature);
    }
    
    query(bbox) {
        return this.spatialIndex.search(bbox).map(
            item => this.features.get(item.id)
        );
    }
    
    toGeoJSON() {
        return {
            type: "FeatureCollection",
            features: Array.from(this.features.values())
        };
    }
}

// === 渲染循环 ===
function renderLoop() {
    renderer.clear();
    
    // 1. 渲染底图（瓦片/纯色背景）
    renderer.drawBasemap();
    
    // 2. 查询视口内的要素（使用空间索引）
    const visibleFeatures = store.query(map.getBbox());
    
    // 3. 按图层顺序渲染
    for (const feature of visibleFeatures) {
        const style = getStyleForFeature(feature);
        renderer.drawFeature(feature, style);
    }
    
    // 4. 渲染选中态和控制手柄
    for (const id of state.selectedFeatureIds) {
        renderer.drawSelection(store.get(id));
    }
    
    // 5. 渲染绘制中的临时几何体
    if (state.drawingInProgress) {
        renderer.drawTempGeometry(state.drawingVertices);
    }
    
    requestAnimationFrame(renderLoop);
}

// === 交互处理 ===
function onMouseDown(e) {
    const [x, y] = map.screenToLatLng(e.clientX, e.clientY);
    
    switch (state.activeTool) {
        case 'select':
            const clicked = renderer.hitTest(x, y);
            if (clicked) {
                selectFeature(clicked.id);
            } else {
                clearSelection();
            }
            break;
            
        case 'polygon':
            if (!state.drawingInProgress) {
                state.drawingInProgress = true;
                state.drawingVertices = [[x, y]];
            } else {
                state.drawingVertices.push([x, y]);
            }
            break;
    }
}

function onMouseMove(e) {
    if (state.drawingInProgress) {
        const [x, y] = map.screenToLatLng(e.clientX, e.clientY);
        // 更新最后一个顶点（实时跟随鼠标）
        state.drawingVertices[state.drawingVertices.length - 1] = [x, y];
    }
    
    if (state.draggingFeature) {
        const [x, y] = map.screenToLatLng(e.clientX, e.clientY);
        const delta = [x - state.dragStart[0], y - state.dragStart[1]];
        renderer.previewMove(state.draggingFeature, delta);
    }
}

function onMouseUp(e) {
    if (state.drawingInProgress && e.detail === 2) {  // 双击完成
        const vertices = state.drawingVertices;
        if (vertices.length >= 3) {
            const polygon = turf.polygon([
                [...vertices, vertices[0]]  // 闭合
            ]);
            store.add(polygon);
        }
        state.drawingInProgress = false;
        state.drawingVertices = [];
    }
    
    if (state.draggingFeature) {
        const command = new MoveFeatureCommand(
            state.draggingFeature,
            state.dragDelta,
            store
        );
        commandManager.execute(command);
        state.draggingFeature = null;
    }
}
```

---

## 4. 性能与大数据量处理

当地图要素数量从数百增长到数万甚至数十万时，不同渲染方案会遇到截然不同的性能瓶颈。

### 4.1 SVG DOM 节点过多时的问题与优化

**问题本质：** 每个 SVG 元素都是 DOM 节点，浏览器需要为每个节点维护样式、布局、事件监听器。当节点数超过 5000-10000 时：

- **首次渲染**：浏览器需要计算每个节点的 layout 和 paint，耗时可达秒级
- **交互响应**：每次 hover 都可能导致大面积 reflow
- **内存**：每个节点约占用 1-5KB 内存，10000 个节点 = 10-50MB

#### 优化手段

**1. 虚拟化（Virtualization）**

只渲染视口内的要素，不可见的要素不创建 DOM 节点。

```javascript
// 简化版 SVG 虚拟化
function renderVisibleOnly(allFeatures, viewport) {
    const visible = allFeatures.filter(f => 
        turf.booleanIntersects(f, viewport)
    );
    // 仅对可见要素创建 SVG 节点
    svg.selectAll('path').data(visible, d => d.id)
        .enter().append('path')
        .attr('d', pathGenerator);
}
```

**2. 符号化（Simplification）**

- 使用 Douglas-Peucker 算法简化几何体（减少顶点数）
- 根据缩放级别切换详细程度（Level of Detail）
- 使用 Turf.js 的 `simplify()` 函数

```javascript
import * as turf from '@turf/turf';

function simplify(geojson, tolerance) {
    return turf.simplify(geojson, {
        tolerance: tolerance,  // 简化容差（度）
        highQuality: true
    });
}

// 根据缩放级别动态调整
map.on('zoomend', () => {
    const zoom = map.getZoom();
    const tolerance = zoom < 10 ? 0.01 : 
                       zoom < 14 ? 0.001 : 0;
    const simplified = simplify(originalGeojson, tolerance);
    render(simplified);
});
```

**3. Canvas 混合渲染**

将大量静态要素渲染到 Canvas（作为背景层），仅将需要交互的少量要素用 SVG 渲染（作为前景层）。

### 4.2 Canvas / WebGL 中的性能瓶颈与优化

#### 拾取（Hit Detection）

Canvas 和 WebGL 没有 DOM 事件系统，需要手动实现拾取：

**颜色缓冲拾取法（Color Picking）：**

```javascript
// 离屏渲染：每个要素用唯一颜色编码
const offscreenCanvas = document.createElement('canvas');
const offCtx = offscreenCanvas.getContext('2d');

function renderOffscreen() {
    offCtx.clearRect(0, 0, width, height);
    store.getAll().forEach((feature, index) => {
        // 将 index 编码为 RGB 颜色
        const r = (index + 1) & 0xFF;
        const g = ((index + 1) >> 8) & 0xFF;
        const b = ((index + 1) >> 16) & 0xFF;
        offCtx.fillStyle = `rgb(${r},${g},${b})`;
        drawFeature(offCtx, feature);
    });
}

function hitTest(x, y) {
    const [r, g, b] = offCtx.getImageData(x, y, 1, 1).data;
    const index = r + (g << 8) + (b << 16) - 1;
    return store.getAll()[index];
}
```

**优点：** 实现简单、GPU 友好
**缺点：** 需要额外渲染一帧、不支持亚像素精度

**几何算法拾取：**

```javascript
// 使用 Turf.js 进行几何命中检测
function hitTest(x, y) {
    const point = turf.point([x, y]);
    return store.getAll().find(feature => {
        if (feature.geometry.type === 'Point') {
            return turf.distance(point, feature) < threshold;
        } else if (feature.geometry.type === 'Polygon') {
            return turf.booleanPointInPolygon(point, feature);
        }
        // LineString 类似...
    });
}
```

**优化：** 先用 bbox 粗筛，再对候选要素做精确几何检测。

#### 图层聚合策略

- **聚类（Clustering）**：将相邻点聚合为带数字的圆形标记（Leaflet.markercluster）
- **热力图（Heatmap）**：点数据量大时渲染热力图代替单个标记
- **LOD（Level of Detail）**：根据缩放级别切换渲染策略
  - 缩放级别 < 10：渲染简化几何或聚合
  - 缩放级别 10-14：渲染完整几何
  - 缩放级别 > 14：渲染顶点和细节

### 4.3 空间索引

空间索引是高性能地图编辑器的基石。常用结构：

| 索引类型 | 适用场景 | 代表库 |
|---------|---------|--------|
| R-tree | 通用二维空间查询 | rbush、rtree-lib |
| 四叉树 | 地图瓦片索引 | quadtree-js |
| Geohash | 地理位置编码 | ngeohash |
| H3 | 六边形网格 | uber/h3-js |
| S2 | 球面几何 | google/s2geometry |

**RBush 使用示例：**

```javascript
import RBush from 'rbush';

class SpatialIndex {
    constructor() {
        this.tree = new RBush();
        this.idToItem = new Map();
    }
    
    insert(feature) {
        const bbox = turf.bbox(feature);
        const item = {
            minX: bbox[0], minY: bbox[1],
            maxX: bbox[2], maxY: bbox[3],
            id: feature.id
        };
        this.tree.insert(item);
        this.idToItem.set(feature.id, item);
    }
    
    remove(feature) {
        const item = this.idToItem.get(feature.id);
        if (item) {
            this.tree.remove(item);
            this.idToItem.delete(feature.id);
        }
    }
    
    search(bbox) {
        return this.tree.search({
            minX: bbox[0], minY: bbox[1],
            maxX: bbox[2], maxY: bbox[3]
        }).map(item => item.id);
    }
}
```

### 4.4 瓦片化渲染与矢量瓦片

#### 矢量瓦片（MVT / Vector Tiles）

矢量瓦片是将地理数据按金字塔网格切片的二进制格式（Mapbox Vector Tile 规范）。

```
数据流：
GeoJSON → tippecanoe/postgis → .pbf (MVT) → MapLibre GL JS → WebGL 渲染

优势：
- 按需加载：只加载视口内的瓦片
- 数据量小：每个瓦片通常 5-50KB（相比 GeoJSON 的 MB 级）
- 服务端预渲染：客户端只需解码和渲染
- 样式动态：客户端可动态切换样式而不重新获取数据

劣势：
- 切片有损：顶点数限制、跨切片要素裁剪
- 更新延迟：数据更新需重新切片
- 不适合编辑：编辑结果需要重新切片才能反映到底图
```

**编辑器中的矢量瓦片策略：**
- 底图使用矢量瓦片（服务端切片）
- 编辑层使用动态 GeoJSON（客户端维护）
- 编辑完成后将结果导出并触发服务端重新切片

### 4.5 Web Worker 与离屏计算

```javascript
// worker.js
import * as turf from '@turf/turf';

self.onmessage = function(e) {
    const { type, payload } = e.data;
    
    switch (type) {
        case 'simplify':
            const simplified = turf.simplify(payload.geojson, {
                tolerance: payload.tolerance
            });
            self.postMessage({ type: 'simplify:done', result: simplified });
            break;
            
        case 'intersect':
            const result = turf.booleanIntersects(
                payload.feature1, payload.feature2
            );
            self.postMessage({ type: 'intersect:done', result });
            break;
    }
};

// 主线程
const worker = new Worker('worker.js');

function simplifyAsync(geojson, tolerance) {
    return new Promise((resolve) => {
        worker.onmessage = (e) => {
            if (e.data.type === 'simplify:done') {
                resolve(e.data.result);
            }
        };
        worker.postMessage({
            type: 'simplify',
            payload: { geojson, tolerance }
        });
    });
}
```

---

## 5. 实战建议：如何从零做一个"够用"的可视化地图编辑器

### 5.1 技术栈推荐

根据项目规模和需求，推荐以下三种技术栈组合：

#### 方案 A：轻量级（< 5000 要素，快速原型）

```
渲染层：Leaflet 1.9 + Leaflet.draw 1.0
状态管理：Vue 3 Composition API（或 React Hooks）
数据层：L.FeatureGroup（直接作为 GeoJSON 容器）
持久化：LocalStorage / JSON 文件下载
适用场景：区域划分工具、示意图编辑器、教学演示
```

#### 方案 B：中等规模（5000-50000 要素，生产可用）

```
渲染层：MapLibre GL JS 3.x（WebGL，开源免 API key）
绘制编辑：mapbox-gl-draw（兼容 MapLibre）
状态管理：Pinia（Vue）或 Zustand（React）
数据层：自研 FeatureStore + RBush 空间索引
持久化：IndexedDB（本地）+ REST API（后端）
几何分析：Turf.js
撤销重做：自研 CommandManager
适用场景：GIS 数据编辑、城市规划工具、农业地块管理
```

#### 方案 C：大规模（50000+ 要素，企业级）

```
渲染层：MapLibre GL JS + Deck.gl（大数据图层）
编辑层：自研编辑模式（基于 mapbox-gl-draw 扩展）
状态管理：Redux Toolkit + Immer（不可变数据）
数据层：PostGIS（服务端）+ 矢量瓦片（底图）
        本地编辑用 FeatureStore + 差异同步
持久化：PostgreSQL + 矢量瓦片服务（Tegola / Martin）
几何分析：PostGIS 服务端 + Turf.js 客户端
协同编辑：CRDT（Yjs）或 OT
适用场景：国家级 GIS 平台、智慧城市底座、多人协同编辑
```

### 5.2 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                        User Interface                        │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Toolbar │  │Sidebar  │  │ Map View │  │ Property     │   │
│  │(工具选择)│  │(图层列表)│  │(地图视图) │  │ Panel(属性)  │   │
│  └────┬────┘  └────┬────┘  └────┬─────┘  └──────┬───────┘   │
│       │            │            │                │            │
├───────┼────────────┼────────────┼────────────────┼────────────┤
│       │        Interaction Layer (交互层)        │            │
│  ┌────┴────────────┴────────────┴────────────────┴───────┐    │
│  │                  Mode Manager (模式管理器)              │    │
│  │  select │ draw_point │ draw_line │ draw_polygon │ ... │    │
│  └────────────────────────┬─────────────────────────────┘    │
│                           │                                  │
│  ┌────────────────────────┴─────────────────────────────┐    │
│  │            Command Manager (命令管理器)               │    │
│  │  history[] ←── currentIndex ──→ future[]             │    │
│  └────────────────────────┬─────────────────────────────┘    │
│                           │                                  │
├───────────────────────────┼──────────────────────────────────┤
│                           │     Data Layer (数据层)          │
│  ┌────────────────────────┴─────────────────────────────┐    │
│  │               Feature Store (要素存储)                │    │
│  │  ┌───────────────────────────────────────────────┐   │    │
│  │  │  features: Map<id, Feature>                    │   │    │
│  │  │  spatialIndex: RBush                           │   │    │
│  │  │  listeners: Set<callback>                      │   │    │
│  │  └───────────────────────────────────────────────┘   │    │
│  │  add() / remove() / update() / query() / toGeoJSON()│    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                     Persistence Layer                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ LocalStorage │  │   IndexedDB  │  │   REST API       │   │
│  │ (小型配置)    │  │ (离线编辑)   │  │ (服务端同步)      │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 5.3 最容易踩坑的 10 个点

#### 坑 1：坐标系混乱

**问题：** GeoJSON 使用 WGS84 (EPSG:4326)，但地图显示用 Web Mercator (EPSG:3857)。编辑时坐标不匹配。

**规避：** 始终在数据层使用 WGS84，仅在渲染层做投影转换。使用 Turf.js 进行几何计算（它内部处理投影）。

```javascript
// 正确做法：数据层始终 WGS84
const feature = {
    type: "Feature",
    geometry: {
        type: "Point",
        coordinates: [116.397, 39.909]  // WGS84
    }
};

// 渲染时由 MapLibre/Leaflet 自动投影到 Web Mercator
```

#### 坑 2：多边形不自闭合

**问题：** GeoJSON 标准要求多边形首尾坐标相同，但很多编辑器不强制。

**规避：** 保存和导出前自动闭合：

```javascript
function ensureClosed(ring) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        return [...ring, first];
    }
    return ring;
}
```

#### 坑 3：撤销栈无限增长

**问题：** 长时间编辑后内存溢出，浏览器变慢。

**规避：** 限制历史栈大小（通常 50-100 步），使用差异快照代替完整快照。

#### 坑 4：并发编辑冲突

**问题：** 多人同时编辑同一要素，后保存的覆盖先保存的。

**规避：** 引入乐观锁（version 字段）或 CRDT。

```javascript
// 乐观锁
function saveFeature(feature) {
    return api.put(`/features/${feature.id}`, {
        ...feature,
        version: feature.version  // 发送当前版本号
    }).catch(err => {
        if (err.status === 409) {
            alert('该要素已被他人修改，请刷新后重试');
        }
    });
}
```

#### 坑 5：大文件渲染卡顿

**问题：** 导入 10MB+ GeoJSON 文件时界面冻结。

**规避：** 使用 Web Worker 解析和简化，分块渲染（只渲染视口内）。

#### 坑 6：移动端触摸事件冲突

**问题：** 拖拽编辑与地图平移冲突、双指缩放误触发绘制。

**规避：** 在绘制模式下禁用地图平移，使用 `map.dragging.disable()` 临时禁用。

```javascript
// 进入绘制模式
function enterDrawMode() {
    map.dragging.disable();
    map.doubleClickZoom.disable();
    map.getContainer().classList.add('drawing-mode');
}

function exitDrawMode() {
    map.dragging.enable();
    map.doubleClickZoom.enable();
    map.getContainer().classList.remove('drawing-mode');
}
```

#### 坑 7：内存泄漏

**问题：** 事件监听器未移除、闭包引用旧数据。

**规避：** 使用 WeakMap/WeakSet 存储监听器，组件卸载时统一清理。

#### 坑 8：浮点精度问题

**问题：** 多次坐标变换后浮点误差累积，导致多边形不闭合。

**规避：** 使用定点数运算或设置容差值：

```javascript
const EPSILON = 1e-10;
function floatEqual(a, b) {
    return Math.abs(a - b) < EPSILON;
}
```

#### 坑 9：跨浏览器兼容性

**问题：** Safari 对 WebGL 支持有差异、触摸事件不同。

**规避：** 使用成熟库（Leaflet/MapLibre）做兼容层，避免直接操作原生 API。

#### 坑 10：未考虑国际化坐标系

**问题：** 中国用户常用 GCJ-02（火星坐标系）或 BD-09，与 WGS84 有偏移。

**规避：** 在项目中明确标注支持的坐标系，提供坐标转换工具：

```javascript
// 使用 coordtransform 库（npm）
const coordtransform = require('coordtransform');
const wgs84 = coordtransform.gcj02towgs84(116.397, 39.909);
```

---

## 6. 参考资料

1. **Leaflet.draw 文档:** https://leaflet.github.io/Leaflet.draw/docs/leaflet-draw-latest.html
2. **mapbox-gl-draw 文档:** https://github.com/mapbox/mapbox-gl-draw/blob/main/docs/MODES.md
3. **geojson.io 源码:** https://github.com/mapbox/geojson.io
4. **MapLibre GL JS:** https://maplibre.org/maplibre-gl-js/docs/
5. **Turf.js 几何分析:** https://turfjs.org/
6. **RBush 空间索引:** https://github.com/mourner/rbush
7. **Deck.gl 大数据可视化:** https://deck.gl/
8. **SVG vs Canvas vs WebGL 性能对比 (2026):** https://www.svggenie.com/blog/svg-vs-canvas-vs-webgl-performance-2025
9. **Vector Tiles 介绍:** https://docs.mapbox.com/data/tilesets/guides/vector-tiles-introduction/
10. **Mapbox GL Draw Modes 详解:** https://deepwiki.com/mapbox/mapbox-gl-draw/6.1-mapboxdraw-methods

---

> 本文档为研究笔记性质，代码示例为说明用途的简化版，生产环境需要额外的错误处理、边界条件和安全性考虑。
