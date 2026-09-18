# SiTian (司天)

为世界构建者设计的本地桌面应用（Electron 28），以 Obsidian 库（默认 `E:/图书馆/ROSA/`）为唯一事实源，通过七层视图呈现世界观地理层级，为 Markdown 附加可编辑的坐标元数据，实现画布与笔记的双向同步。

> **独立运行化（Phase 1 已落地 2026-09-18）**：司天另有一套自有项目文件（`.sitian`，JSON 单文件：实体树 + 剧本 + 地图 + 自动快照），目标是脱离知识库也能新建/编辑/保存世界观。
> 当前七层视图仍读 Obsidian 缓存（`<vault>/.sitian/*.json`），**项目文件尚未接线**（接线属 Phase 2）——两套事实源并存期间以 geodata 链路为准。

## 技术栈 (Tech Stack)

- 桌面壳: Electron 28
- UI 框架: Vue 3 + Pinia
- 构建工具: Vite 5
- 数据格式: Markdown + YAML frontmatter + JSON 缓存层（`E:/图书馆/ROSA/.sitian/`）
- 前端画布: 原生 Canvas 2D（无外部渲染库）

## 常用命令 (Common Commands)

- 安装依赖: `npm install`
- 开发模式 (仅前端): `npm run dev`（端口 **5180**）
- 开发模式 (Electron 完整): `npm run dev:watch`（wait-on tcp:5180 后拉起 Electron）
- 构建生产版本: `npm run build`
- 从 Obsidian 提取数据: `npm run extract-data`
- 回归测试: `python scripts/tests/run_tests.py`（46 用例；须用系统 Python，Hermes 自带 venv 缺 `websocket-client`）
  - 该命令会先跑 `scripts/tests/unit/*.js`（Node 单元测试：主进程文件 I/O，CDP 用例的 mock 覆盖不到），失败计为 1 个失败用例
  - 单跑某个用例：`python scripts/tests/run_tests.py test_46`
- 提取覆盖率审计: `npm run audit-coverage`（只读；`-- --write-report` 落 `96 事务管理/`）
- mapdata 旧 key 清理: `npm run migrate-mapdata-keys`（默认 dry-run，`-- --apply` 才写盘）
- emoji 审计: `python scripts/emoji_audit.py`（`--detail` 附行号上下文，`--file <path>` 单文件）
- 图标一致性校验: `python scripts/icon_check.py`（校验所有被引用的图标名在 `Icon.vue` 中有定义）
- 结构清单再生成: `python scripts/gen_architecture_map.py`（详见下节）

## 架构速查 (Quick Facts)

> 本节 = 每次会话最高频问题的事实层，只放慢变量。行数等快变量在 `docs/ARCHITECTURE_MAP.md`，由脚本再生成，勿手改。

- **七层视图链**（全部已实现）: world → domain → system → system_detail → planet → area → interior，对应组件 WorldSelector → GalaxyMap → SystemView → SystemDetailView → PlanetMap → AreaMap → InteriorView
- **store 结构**: `store/geodata.js` 是壳（defineStore + 装配），真实逻辑在 `store/geodataModules/` 6 个模块：mapDataEditing（最大）/ areaEditing / scenarioEditing / interior / search / spaceEditing
- **undo 纪律**: `store/undo.js` 的 `execute()` 内部立即调用 `command.redo()` 完成首次写入——数据修改必须放在 redo 回调内，禁止在 execute 之前手动改数据（会造成双写）
- **大文件警告**: PlanetMap.vue 约 2900 行（22 个 composables 的装配体），AreaMap / GalaxyMap / InteriorView / App.vue / NodeDetailPanel 均 >1700 行——**读片段勿整读**。行星图绘制与交互逻辑在 `composables/planetDrawing.js`、`planetInteractions.js`、`planetHitTest.js`
- **测试基线**: 两层。① `scripts/tests/unit/*.js` Node 单元测试（**主进程文件 I/O**：`.sitian` 原子写/备份轮转/路径守卫——CDP 用例里 `window.sitianAPI` 是 mock，测不到真实落盘）；② `scripts/tests/cases/` 46 个 CDP 用例（Edge 驱动），46/46 全绿 + Node 层通过 = 迁移/重构完整。`run_tests.py` 把前者作为前置步骤，失败计 1 个失败用例
- **`.sitian` 项目文件（Phase 1，独立运行基础）**: 三层边界**只许单向依赖**——`utils/projectSchema.js`（**纯函数**：结构/校验修复/版本迁移/就地 diff 快照，Node 可读）← `store/projectStore.js`（内存态 + 实体 CRUD，走 `undo.js`）← `main/handlers/projectHandler.js`（只管路径/磁盘/备份，**顶层不 require electron** 以便 Node 测）。改文件结构只改 schema + 升 `PROJECT_VERSION` + 补 `MIGRATIONS`。默认项目目录：用户文档下的 `SiTianProjects`；快照 = 「1 份 base + ≤50 份 diff」（`maps` 不进快照，另有磁盘整文件备份 10 份兜底）。回归用例 test_46 + Node 单元测试
- **图标系统**: `src/renderer/src/components/Icon.vue`（148 个内联 SVG 图标）+ `src/renderer/src/utils/canvasIcon.js`（Canvas 矢量绘制适配），已替换全部 339 处 emoji；`python scripts/icon_check.py` 校验引用名均有定义
- **开发规则全集**: 60+ 条铁律与踩坑复盘（composable 接线、getState ref 解包、SFC 结构标签、发布验收等）在 Hermes skill `obsidian/sitian-development`，动代码前先加载；本文件不复制规则，防双源漂移
- **P0/P1 编辑器模块**（2026-09-15 落地，全部有回归用例 test_28~test_35）: `utils/labelStyles.js`（标签样式预设 + `drawStyledLabel` 统一文本渲染）、`utils/reliefIcons.js`（地貌图标确定性散布 + 网格桶）、`utils/markerTypes.js`（标记类型注册表）、`utils/settlement.js`（人口对数滑块/分级/半径）、`utils/roadStyles.js`（道路样式）、`utils/rivers.js`（河流流向排序/拖拽 clamp）、`utils/viewport.js`（视口世界矩形，小地图遮罩用）；`composables/useReliefBrush.js`
- **历史剧本时间轴**（2026-09-17 落地，回归用例 test_41~test_45）: `utils/scenarioTimeline.js`（**纯函数**：势力谱系按省份重叠度贪心匹配 + 逐省易主年份 + 年份/轨道轴向映射；无 DOM 依赖，可单独在 Node 里跑）、`components/ScenarioTimeline.vue`（按年比例/等宽双轴向轨道 + 游标拖动 + 键盘 + 播放）、`components/ScenarioLineagePanel.vue`（P2 谱系纠正面板）、`composables/useScenarioExport.js`（SVG/PNG/scenarios.json 导出导入）。**出口**：`utils/svgExport.js`（SVG 序列化，曲线约定同 `traceShapePath`；PNG 由 SVG 光栅化而来，两者永远一致）+ `save-text-file` IPC
- **剧本时间轴的两条硬约束**：① `era.startYear/endYear` 是**字符串且可为负**（`'-1350'`→`'2138'`），任何算术先 `Number()`；② **每个剧本的 polity id 都是全新的**（`pol_ou`→`pol_li`），直接比 id 会得出「每代 100% 省份全变」→ 必须先做谱系匹配。详见 skill `obsidian/sitian-development`
- **交互模式全集**: pan / move / draw / region / marker / route（含自动寻路=道路编辑器，Shift+J）/ settle / text / cluster / height / terrain / political / **relief（R）** / **river（Shift+R）**
- **新增全局事件**: `sitian:label-styles-changed` / `sitian:marker-types-changed`（画布监听后 `requestRender`，不依赖深度 watch）
- **节点 id 连续性（Draft 转正）**: `store.changeNodeId(oldId,newId)` 是「节点 id 变更 + 引用级联」的唯一入口（入 undo 栈，undo 闭包**显式记录**旧值不做反向推断）。引用清单（值槽 / 数组槽 / 字典键）在 `store/geodata.js` 内以注释 + `ID_REF_VALUE_FIELDS`/`ID_REF_ARRAY_FIELDS` 白名单登记，**新增任何以节点 id 为值或为键的结构必须同步登记**。`utils/normalizeId.js` 是 `scripts/extract-data.js` 的逐字符副本（三处一致由 test_40 用例守卫，改一处必改三处）
- **文档权威顺序**: 代码 > `docs/ARCHITECTURE_MAP.md`（脚本生成部分）> 本文件 > HANDOFF.md / ROADMAP.md（严重滞后，仅作历史参考）

### 锚点（读文档后先核对 2-3 个，不符以代码为准）

| 锚点 | 期望值 | 核对方式 |
|---|---|---|
| 测试用例数 | 46 | `ls scripts/tests/cases/test_*.py \| wc -l` |
| store 模块数 | 6 | `ls src/renderer/src/store/geodataModules/` |
| App.vue 异步面板 | 19 | `grep -c defineAsyncComponent src/renderer/src/App.vue` |
| IPC handle 数 | 35 | `grep -c "ipcMain.handle" src/main/index.js` |
| 项目文件 IPC 通道数 | 8 | `grep -c "ipcMain.handle('project-" src/main/handlers/projectHandler.js` |
| 七层视图组件 | 7 个齐全 | `ls src/renderer/src/components/` |

## 核心原则 (Critical Principles)

1. **Markdown 为唯一事实源**: 所有原始世界观数据仅存于 Obsidian 库的 Markdown 文件中。`.sitian/geodata.json` 仅作为坐标缓存加速编辑，可删除后重新提取。
2. **坐标数据不属于世界观**: 坐标是编辑器元数据，永远不写入原始 Markdown frontmatter，仅存在于 JSON 缓存层。
3. **布局确定性**: 画布节点的初始坐标必须在提取脚本中一次性确定（同心圆/网格算法），绝不在渲染循环中使用随机数。
4. **只渲染需要的层级**: 每个视图级别只绘制其直接相关的节点集合。

## 七层视图架构

| 视图级别 | 组件 | 显示内容 |
|---|---|---|
| world | WorldSelector | 世界卡片选择 |
| domain | GalaxyMap | 星域总览：边界圆、星系聚簇、跨星域航道（**深空风格**：渐变+星云+发光节点） |
| system | SystemView | 域内恒星系聚合视图（读真 hyperlanes 数据，无假航道） |
| system_detail | SystemDetailView | 单恒星系：恒星居中 + 行星轨道 + 邻系箭头 |
| planet | PlanetMap | 行星表面：地形背景 + 聚落/地点（**GIS 工具风格**：纯色底 `#1a2a3a`，无星云无发光） |
| area | AreaMap | 区域地图：区域多边形、道路、标记、文本、建筑入口 |
| interior | InteriorView | 建筑内部：楼层切换 + 家具放置 |

> 两套绘制风格独立维护：GalaxyMap 用 `utils/galaxyDrawing.js` + `composables/spaceBackground.js`；PlanetMap 用 `composables/planetDrawing.js`。禁止互相套用。

## 数据模型

```typescript
interface GeoNode {
  id: string;             // 文件名标准化（UUID 稳定身份，重提取不变）
  name: string;           // 显示名称
  layer: string;          // world | star_domain | galaxy | star | planet | moon | region | city | town | village | building | facility | location | unknown
  layerLabel: string;     // 中文标签
  parentId: string | null;
  tags: string[];
  sourcePath: string;     // Obsidian vault 相对路径
  coordinate: { x: number | null; y: number | null };
}
```

- `mapData[planetId]`: terrain / regions / markers / routes / textLabels / referenceImages
- `areaZons`/`areaRoutes`/`areaMarkers`/`areaTextLabels`: 区域级编辑数据（mapdata.json）
- `interiorData[buildingId]`: 楼层 + 家具
- `draft: true`: 司天内创建的暂存节点（无 Obsidian 词条，虚线边框）

## 重要约束 (Important Constraints)

- **禁止**在 `render()` 函数内使用 `Math.random()`——会导致拖拽时节点乱动
- **禁止**在渲染循环中修改响应式状态——Vue 会触发无限重渲染
- **禁止**在前端直接读写 Obsidian 文件——必须通过 Electron 主进程 IPC
- **坐标拖拽**必须使用 rAF 节流 + `fastMode`（拖拽时跳过光晕、渐变、标签渲染）

## 开发陷阱 (Pitfalls)

- Vue 3 ref 嵌套属性直接赋值（`obj[key]=value`）会丢失响应式，必须创建新对象（`{...obj, [key]: value}`）
- Canvas 绘制函数拆分时，辅助函数和样式常量必须随函数一起迁移，否则运行时 ReferenceError 导致渲染管线断裂
- 其余 60+ 条陷阱见 Hermes skill `sitian-development`（含 composable 接线、getState 解包、SFC 标签丢失、发布验收、测试环境），本文件不重复

## 术语表 (Glossary)

- **世界**: 顶层容器，`layer: "world"`
- **星域**: 世界下宏观区域，`layer: "star_domain"`，虚线边界圆
- **恒星系**: `layer: "galaxy"`，金色恒星标记
- **恒星**: `layer: "star"`（system_detail 层中心天体）
- **行星/卫星**: `layer: "planet"` / `"moon"`
- **区域**: `layer: "region"`，行星表面半透明色域
- **聚落**: 城市/城镇/村庄，`layer: "city" / "town" / "village"`，实心图标
- **建筑**: `layer: "building"`，可下钻进入建筑内部
- **设施/地点**: `layer: "facility" / "location"`
- **航道**: 星系间连接线，同星域实线，跨星域紫色虚线
