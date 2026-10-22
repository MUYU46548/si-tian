# SiTian (司天)

为世界构建者设计的本地桌面应用（Electron 28），以 Obsidian 库（默认 `E:/图书馆/ROSA/`）为事实源之一，通过七层视图呈现世界观地理层级，为 Markdown 附加可编辑的坐标元数据，实现画布与笔记的双向同步。

> **独立运行化（Phase 1 已落地 2026-09-18；Phase 2.4 接线 + 终态翻开 2026-09-20）**：司天另有一套自有项目文件（`.sitian`，JSON 单文件：实体树 + 剧本 + 地图 + 自动快照），目标是脱离知识库也能新建/编辑/保存世界观。
> 接线已完成：**打开项目 → 画布事实源切到项目文件；关闭项目 → 还原打开前的知识库工作态**（`store/canvasBridge.js` 是唯一接线点）；**无项目 = 只读**（`READONLY_WITHOUT_PROJECT = true`，UI 已灰禁且灰禁带能力说明）。细节（写闸门 / 接线 / 快照 / 退出落盘）见 [`docs/agents-archive/project-save.md`](docs/agents-archive/project-save.md)。

## 技术栈 (Tech Stack)

- 桌面壳: Electron 28
- UI 框架: Vue 3 + Pinia
- 构建工具: Vite 5
- 数据格式: Markdown + YAML frontmatter + JSON 缓存层（`E:/图书馆/ROSA/.sitian/`）+ `.sitian` 项目文件
- 前端画布: 原生 Canvas 2D（无外部渲染库）
- UI 基座（2026-10-06 试点）: Tailwind CSS 3（**只出 utilities 层**）+ shadcn-vue 源码组件（`components/ui/`，基于 reka-ui）

## 常用命令 (Common Commands)

- 安装依赖: `npm install`
- 开发模式 (仅前端): `npm run dev`（端口 **5180**）
- 开发模式 (Electron 完整): `npm run dev:watch`（wait-on tcp:5180 后拉起 Electron）
- 构建生产版本: `npm run build`
- 打包安装包: `npm run dist`（electron-builder → `release/SiTian Setup <版本>.exe`）
- 从 Obsidian 提取数据: `npm run extract-data`
- 回归测试: `python scripts/tests/run_tests.py`（**134 用例**；须用系统 Python，Hermes 自带 venv 缺 `websocket-client`）
  - 数据源默认 = **仓库内合成 fixture**（`scripts/tests/fixtures/vault-fixture/`，由 `fixtures/make_vault_fixture.py` 生成：层级结构同构、内容全虚构、地图几何程序合成）→ **用户改自己的世界观数据不会让用例变红**；要对着真实库跑加 `--real-data`
  - 该命令会先跑 `scripts/tests/unit/*.js`（**49 个** Node 单元测试文件：主进程文件 I/O + 真实 git 同步 + 令牌加密保管 + 纯函数层若干，CDP 用例的 mock 覆盖不到），失败计为 1 个失败用例
  - 单跑某个用例：`python scripts/tests/run_tests.py test_47`
  - 🔴 **用例判定必须走 `lib/cdp.py` 的 `eval_json()`**：`cdp.eval` 在 JS 抛异常时返回 `{'__err__': …}`，写成「没有 `fails` 字段就算通过」会造成**静默假绿**（本项目真实踩过：假绿掩盖了「主进程不回显 project → 新建项目必失败」的生产缺陷）
- 提取覆盖率审计: `npm run audit-coverage`（只读；`-- --write-report` 落 `96 事务管理/`）
- mapdata 旧 key 清理: `npm run migrate-mapdata-keys`（默认 dry-run，`-- --apply` 才写盘）
- **存量机器属性搬家（A-1，2026-09-27）**: `npm run migrate-vault-attrs -- --project <file.sitian> [--vault <路径>] [--from-cache]`（默认 dry-run 出**清点表**，`-- --apply` 才写盘）。把笔记 frontmatter 承载的「层级 / 上层挂靠 / 地点类型」搬进项目文件；**只补空、绝不覆盖项目已有值**（不一致进「冲突」清单交人判断），补 parentId 前校验父实体存在，写盘前备份项目文件 + 落**反向档**；**不动笔记**（原字段原地不动 = 后悔药级保险）。⚠️ 跑 `--apply` 前先在司天里关闭该项目（内存态会把改动盖回去）
- **剧本账本 v2 迁移（2026-10-21）**: `node scripts/migrate-ledger-v2.mjs --project <file.sitian> [--apply]`（默认 dry-run 出每代清点；`--apply` 自动备份 + 读回校验）。每代写入 `initialOwnership` + 物化 `changeEvents`（含 `synthesized` 标记），`ownership` 保留为缓存；真实 415 省项目 +6.1% 体积、0 派生冲突。⚠️ 先关闭项目再 apply。
- **事件账本查询/录入（2026-10-22，三刀第一刀）**: `node scripts/ledger-query.mjs --project <file.sitian> --at 1350 --a 瓯 --b 梁`（答「某年两方什么关系」）；`--list` 清点；`--add '<json>' --apply` 录入（默认 dry-run，写前备份 + 写后读回校验；PowerShell 用 `--add @事件.json`）。语义/形状见 [docs/SCENARIO_EVENT_LEDGER.md](docs/SCENARIO_EVENT_LEDGER.md)
- **读料扫描（2026-10-22，三刀第二刀）**: `node scripts/vault-scan.mjs --vault <库根> --out <目录> [--geodata]` —— 全库只读归类（地图实体 / 资料 / 待人工），产物 `scan-report.json` + `待人工.md`（每条带原因与凭据）+ 可选 `geodata.json` 试导；输出目录在库内会被拒绝，跑完自动对比库指纹证明一个字节都没写。归类口径见 [docs/VAULT_BRIDGE.md](docs/VAULT_BRIDGE.md)
- `.sitian` 缓存垃圾清理: `npm run clean-cache-junk`（默认 dry-run，`-- --apply` 才写盘；清空名地形 / 空壳底图 / 测试残留节点，删前自检「引用 / 包围盒 / 子节点」，备份落 `backups/cleanup-<ts>/`）
- emoji 审计: `python scripts/emoji_audit.py`（`--detail` 附行号上下文，`--file <path>` 单文件）
- 退出前落盘真机演练: `python scripts/tests/drill_quit_flush.py`（起真实 Electron + dist + 真实库/项目，
  **纯 UI 驱动 + 读盘核对**；P1 强杀做负向探针 / P2 Ctrl+Q / P3 点 ×；跑前自动备份并还原项目与配置。
  ⚠️ 只在**没有真实任务在跑**时用：它会短暂开一个真实窗口）
  - **P4 = 剧本专用演练（2026-10-07 加）**：`--phase p4`（或 `all`）。空底图下第一次落笔懒建底图 → 建省 → 定位该省 → **拆分改边界** → Ctrl+Z 撤销 → 真右键菜单删省 → 剧本 增·改·删，**每一步都读项目文件核对落盘**（判据只有磁盘，因为剧本/地图各有 300ms + 800ms 两层防抖）。与 p1~p3 不同：**不要求空项目**（全程相对基线，可在有内容的项目上跑），跑完由 main() 还原项目文件。
    - ⚠️ **四个只在真机上才暴露的坑（改这段前必读）**：① **Vue 的 DOM 更新是异步的** —— 同一个 tick 里 `querySelector('.props-name')` 永远是空、`btn.disabled` 永远是旧值，读 DOM 前一律 `await new Promise(r => setTimeout(r, 0))`；② 对 **`:disabled` 按钮 `el.click()` 是静默 no-op**（既不执行也不报错）—— 填完表单必须等一拍再点，并回传 `disabled` 供诊断；③ 按 title 找工具按钮时 **片段必须唯一**：写 `'选择'` 会先命中 **「返回世界选择」**（排在最前）→ 一次点击直接退出剧本视图，必须写 `'选择 (V)'`；④ **CDP 客户端的读超时是 15s** —— 任何"扫描式"探测都要自带**墙钟上限**（本段取 8s）并在超限时**返回可读失败**，否则演练会崩在 `WebSocketTimeoutException` 上而不是给结论。另：底图是懒建的，**必须在落笔之后再读 `.basemap-select`**，用空键查盘会永远查不到（曾导致一条断言期望值也是 0 → **空转通过**）。
- 保存链真机诊断: `python scripts/tests/diag_t2_save.py`（dev 模式起真实 Electron，可读 `projectStore` 的
  `dirty/saveStatus/lastError`；用**工作副本**打开项目 → 真实项目只读、跑前备份跑后还原配置）
- 图标一致性校验: `python scripts/icon_check.py`（校验所有被引用的图标名在 `Icon.vue` 中有定义）
- 结构清单再生成: `python scripts/gen_architecture_map.py`（详见下节）

## 架构速查 (Quick Facts)

> 只放**慢变量**（几个月才变一次的事实）。历史条目在 `docs/agents-archive/`（见文末索引）。

- **七层视图链**（全部已实现）: world → domain → system → system_detail → planet → area → interior，对应组件 WorldSelector → GalaxyMap → SystemView → SystemDetailView → PlanetMap → AreaMap → InteriorView

- **store 结构**: `store/geodata.js` 是壳（defineStore + 装配），真实逻辑在 `store/geodataModules/` 8 个模块：mapDataEditing（最大）/ areaEditing / scenarioEditing / provinceEditing（省份归属标签网格）/ interior / search / spaceEditing / channelBrush（文化·宗教逐格通道笔刷）

- **undo 纪律**: `store/undo.js` 的 `execute()` 内部立即调用 `command.redo()` 完成首次写入——数据修改必须放在 redo 回调内，禁止在 execute 之前手动改数据（会造成双写）

- **图标系统**: `src/renderer/src/components/Icon.vue`（152 个内联 SVG 图标）+ `src/renderer/src/utils/canvasIcon.js`（Canvas 矢量绘制适配），已替换全部 emoji（含 ScenarioMap 的 15 个地貌/标记预设：**预设里存图标名，不存 emoji 字面量**，双端各自渲染；旧数据里的 emoji 仍由 `drawIconOrEmoji` 的 fillText 兜底）；`python scripts/icon_check.py` 校验引用名均有定义

- **开发规则全集**: 60+ 条铁律与踩坑复盘（composable 接线、getState ref 解包、SFC 结构标签、发布验收等）在 Hermes skill `obsidian/sitian-development`，动代码前先加载；本文件不复制规则，防双源漂移

- **交互模式全集**: pan / move / draw / region / marker / route（含自动寻路=道路编辑器，Shift+J）/ settle / text / cluster / height / terrain / political / **relief（R）** / **river（Shift+R）** / **culture（Shift+C）** / **religion（Shift+G）**

- **文档权威顺序**: 代码 > `docs/ARCHITECTURE_MAP.md`（脚本生成部分）> 本文件 > HANDOFF.md / ROADMAP.md（严重滞后，仅作历史参考）

- **现行规划（2026-10-20 取舍）**: [docs/plan/SITIAN_THREE_MODULES_20261020.md](docs/plan/SITIAN_THREE_MODULES_20261020.md) ——
  三模块顶层（星图 / 行星与细节 / 历史剧本）+ 资料层横切；"已有账本不重写"的结论与下一步队列。


### 当前红线（跨模块、动手之前必须知道）

- **无项目 = 只读**：一切落盘写必须过 `guardWrite()`；新增"直接改世界观数据"的函数必须登记进
  `store/writeGate.js` 的 `MEMORY_WRITE_CALLSITES`（`test_47`/`test_54` 读源码反查）。
- **画布 → 项目只有一个写者**（`projectStore`）：`geodata` 只产出载荷、不碰磁盘、不 import projectStore
  （经 `store/canvasBridge.js` 通信，`test_46` 守）。
- **保存诚实**：`persisted === true` 才说「已保存到磁盘」；项目态只到 `staged`
  （`utils/saveStatusText.js` 是唯一实现）。
- **数据安全优先于手感**：退出 / 关项目 / 显式保存一律绕过自动保存的手势闸门（`utils/interactionGate.js` 口径①）。
- **同一能力只许一份实现**（画河几何、河宽换算、导出参考图、保存文案、`.map` 导入…）：
  两份实现不会报错，只会"改一处另两处不变"。
- **「涂归属」只改势力归属**（2026-10-20）：日常行的 `ownerBrush` = 给碰到的省改 `ownership`
  （一笔一条 undo），**绝不碰省界多边形**；改省界形状是「底图编辑 → 改省界」（`provinceBrush`）。
  两个同名按钮曾让用户以为在"生造省份"——不要再合并回去（`test_131` / `test_120` 守）。
- **两本账不双写**（2026-10-22）：`scenario.changeEvents` 只记「某省某日归谁」，
  `scenario.timelineEvents` 只记「谁和谁、什么事、起止」。查归属走 `initialOwnership + changeEvents`，
  查关系走 `utils/scenarioEventLedger.js`；**不许**把归属复制进事件表（或反过来）——
  两份真值迟早漂移，且归属回放会被无关事件拖慢（`test_132` / `unit/test_scenario_event_ledger.js` 守）。
- **读料必须只读**（2026-10-22）：扫知识库（`vaultIndex.buildIndex` / `vault-scan.mjs` / `vault-classify-report`）一律 `write:false` / `writeCache:false`，**连 `.sitian` 都不碰**；要产物就写 `--out` 指定的库外目录。归类/推断只有一份实现（`scripts/lib/vaultClassify.js`），认不出就进「待人工」，不许默认成地点（`unit/test_vault_classify.js` 用库指纹快照守）。
- **不要整读大文件**：`ScenarioMap.vue` / `PlanetMap.vue` 是全仓最大的两个 SFC —— 先 `grep` 定位再读窗口
  （行数以 `docs/ARCHITECTURE_MAP.md` 为准；这条也是 token 成本的纪律）。

### 索引：历史条目去哪了

`AGENTS.md` 只留**慢变量 + 红线 + 索引**；每一轮的"改了什么 / 踩了什么坑 / 判据是什么"
按主题归档在 `docs/agents-archive/`（**原文未改**）。**需要细节时只读对应那一份**，不要通读全部：

| 主题 | 什么时候读它 | 文件 |
|---|---|---|
| 卡顿与性能 | 帧间隔 / 基帧缓存 / 空间索引 / 自动保存占住主线程 / 测量方法 | [perf-jank](docs/agents-archive/perf-jank.md)（3 条） |
| 河流与地形 | 河流画法与橡皮 / 河网路由 / 地形推演 / 高度图与笔刷 / 海岸线 | [map-river-terrain](docs/agents-archive/map-river-terrain.md)（12 条） |
| 省份与顶点 | 省份绘制与布尔 / 顶点与共边 / 骨架吸附 / 框选与分割 | [map-province](docs/agents-archive/map-province.md)（10 条） |
| 底图与导入导出 | .map 导入 / 参考图 / 标记与聚落 / 道路 / 导出 / 底图编辑模式 | [map-basemap](docs/agents-archive/map-basemap.md)（7 条） |
| 项目文件与保存链 | 写闸门 / 快照 / 落盘与恢复 / 只读 / 备份 / 退出落盘 / git 同步 | [project-save](docs/agents-archive/project-save.md)（12 条） |
| 剧本与时间轴 | 剧本装载语义 / 时间切片 / 态势 / 卡片墙 / 标注与事件 | [scenario](docs/agents-archive/scenario.md)（12 条） |
| 视图层 | 星系·星域·行星·区域·室内 / 图层开关 / 拖拽与命中 / 画布单位与淡出 | [views](docs/agents-archive/views.md)（7 条） |
| 知识库与数据 | 提取 / 迁移 / 坐标 / fixture 专名 / 笔记重连 / 实体 id | [vault-data](docs/agents-archive/vault-data.md)（10 条） |
| UI 与测试工具 | UI 基座 / 免责声明 / 图标与配色 / 测试纪律 / 演练 / 方寸联动 | [ui-tooling](docs/agents-archive/ui-tooling.md)（11 条） |
| 规划与决策 | 排期定案 / 批次收口 / 阶段性取舍（当时的判断，不是现状） | [misc](docs/agents-archive/misc.md)（2 条） |

> 归档是**历史**（"当时为什么这么做"）；当下口径以代码 + 回归用例为准（下面「锚点」就是为此）。
> 检索用 `grep -rn "<关键词>" docs/agents-archive/`，不要整读。

### 锚点（读文档后先核对 2-3 个，不符以代码为准）

| 锚点 | 期望值 | 核对方式 |
|---|---|---|
| 测试用例数 | 134 | `ls scripts/tests/cases/test_*.py \| wc -l` |
| Node 单测文件数 | 49 | `ls scripts/tests/unit/*.js \| wc -l` |
| store 模块数 | 8 | `ls src/renderer/src/store/geodataModules/` |
| App.vue 异步面板 | 24 | `grep -c defineAsyncComponent src/renderer/src/App.vue` |
| IPC handle 数 | 45 | `grep -c "ipcMain.handle" src/main/index.js` |
| 项目文件 IPC 通道数 | 10 | `grep -c "ipcMain.handle('project-" src/main/handlers/projectHandler.js` |
| 同步 IPC 通道数 | 7 | `grep -c "ipcMain.handle('git-sync-" src/main/handlers/gitSyncHandler.js` |
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

> 具体的坑（每条都带"当时怎么被发现的 + 判据"）按主题归档在 `docs/agents-archive/`：
> 例："引用未声明标识符"整类缺陷 → [ui-tooling](docs/agents-archive/ui-tooling.md)；
> 项目文件体积三个来源 → [project-save](docs/agents-archive/project-save.md)；
> 顶点共边的真实数据尾差 → [map-province](docs/agents-archive/map-province.md)。
> 其余 60+ 条铁律与踩坑复盘（composable 接线、getState 解包、SFC 结构标签、发布验收等）
> 在 Hermes skill `obsidian/sitian-development`，动代码前先加载；本文件不复制规则，防双源漂移。

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
