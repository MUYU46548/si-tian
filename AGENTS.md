# SiTian (司天)

一个为世界构建者设计的本地 Web 应用，用于可视化、编辑和迭代多层级的科幻/奇幻世界观地理设定。它以 Obsidian 库为单一事实源，通过 Stellaris 风格的三层视图（世界卡片 → 星域地图 → 恒星系详情）呈现地理层级，并为 Markdown 附加可编辑的坐标元数据，实现画布与笔记的双向同步。

## 技术栈 (Tech Stack)

- 桌面壳: Electron 28
- UI 框架: Vue 3 + Pinia
- 构建工具: Vite 5
- 数据格式: Markdown + YAML frontmatter + JSON 缓存层
- 前端画布: 原生 Canvas 2D（无外部渲染库）

## 常用命令 (Common Commands)

- 安装依赖: `npm install`
- 开发模式 (仅前端): `npm run dev` (port 5174)
- 开发模式 (Electron 完整): `npm run dev:watch`
- 构建生产版本: `npm run build`
- 从 Obsidian 提取数据: `npm run extract-data`

## 项目结构 (Project Structure)

- `src/main/index.js` — Electron 主进程（IPC 路由、文件读写）
- `src/preload/index.js` — 预加载脚本，暴露 `window.sitianAPI` 给渲染进程
- `src/renderer/` — Vue 3 前端
  - `App.vue` — 三层视图路由（world / domain / system）+ 面包屑导航
  - `components/WorldSelector.vue` — 第一层：世界卡片选择
  - `components/GalaxyMap.vue` — 第二层：星域地图（虚线边界、恒星系聚簇、跨星域航道）
  - `components/SystemView.vue` — 第三层：域内恒星系总览（恒星+行星轨道+超空间航道）
  - `store/geodata.js` — Pinia store，管理 viewLevel / currentWorld / currentDomain / currentSystem 状态
- `scripts/extract-data.js` — 从 `E:/图书馆/ROSA/` 的 Markdown 和索引中提取地理节点，写入 `E:/图书馆/ROSA/.sitian/geodata.json`
- `vite.config.js` — Vite 配置，root 指向 `src/renderer`，端口 5174

## 核心原则 (Critical Principles)

1. **Markdown 为唯一事实源**: 所有原始世界观数据仅存于 Obsidian 库的 Markdown 文件中。`.sitian/geodata.json` 仅作为坐标缓存加速编辑，可被删除后重新提取。
2. **坐标数据不属于世界观**: 坐标是编辑器元数据，永远不应写入原始 Markdown frontmatter。坐标仅存在于 JSON 缓存层。
3. **布局确定性**: 画布节点的初始坐标必须在提取脚本中一次性确定（同心圆/网格算法），绝不在渲染循环中使用随机数。
4. **只渲染需要的层级**: 每个视图级别只绘制其直接相关的节点集合，不为行星建立全球地图，不为恒星系绘制太空建筑细节。

## 三层视图架构

| 视图级别 | 触发条件 | 显示内容 |
|---------|---------|---------|
| `world` | 默认首页 | 世界卡片（幻境、粘土世界、绒兽世界等） |
| `domain` | 点击世界卡片 | 该世界下所有星域的边界圆、星系聚簇、跨星域航道 |
| `system` | 点击星域 | 该星域下所有恒星系的恒星+行星轨道+超空间航道 |

## 数据模型

```typescript
interface GeoNode {
  id: string;             // 文件名标准化
  name: string;           // 显示名称
  layer: string;          // world | star_domain | galaxy | planet | city | town | location | unknown
  layerLabel: string;     // 中文标签
  parentId: string | null;
  tags: string[];
  sourcePath: string;     // Obsidian vault 相对路径
  coordinate: { x: number | null; y: number | null };
}
```

## 重要约束 (Important Constraints)

- **禁止**在 `render()` 函数内使用 `Math.random()` —— 会导致拖拽时节点乱动
- **禁止**在渲染循环中修改响应式状态 —— Vue 会触发无限重渲染
- **禁止**在前端直接读写 Obsidian 文件 —— 必须通过 Electron 主进程 IPC
- **坐标拖拽**必须使用 rAF 节流 + `fastMode`（拖拽时跳过光晕、渐变、标签渲染）

## 术语表 (Glossary)

- **世界**: 世界观中的顶层容器（如"幻境"、"粘土世界"），对应 `layer: "world"`
- **星域**: 世界下的宏观区域，对应 `layer: "star_domain"`，地图中用虚线边界圆表示
- **恒星系**: 星域下的恒星系统，对应 `layer: "galaxy"`，地图中用金色恒星标记表示
- **行星级天体**: 恒星系中的行星/卫星/空间站等，对应 `layer: "planet"`，地图中用小圆点表示
- **场景地点**: 行星表面的具体地点，对应 `layer: "city"/"town"/"location"`，仅在第三层以轨道行星显示
- **航道**: 星系间的连接线，同星域内为实线，跨星域为紫色虚线（暗示超空间航道/虫洞）
