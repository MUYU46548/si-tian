# SiTian (司天) — 接手交接包 HANDOFF

> 本文档供**第二位 AI 编码 agent（Zcode / GLM-5.3）**接手本项目时使用。
> 配套权威文档：`AGENTS.md`（项目概述）、`开发日志.md`（完整历史与决策）。
> **遇到冲突时以本仓库代码为最终事实，`AGENTS.md` 部分内容已滞后（见 §2 架构更新）。**

---

## 0. 一句话定位

SiTian 是一个本地 Electron + Vue 3 应用，把 Obsidian 库（`E:/图书馆/ROSA/`）当作**唯一事实源**，用 Stellaris 风格的**多层下钻星图**可视化/编辑世界观地理设定。坐标等编辑器元数据放在 JSON 缓存层，**绝不污染原始 Markdown**。

---

## 1. 技术栈与验证命令

- Electron 28 + Vue 3 + Pinia + Vite 5 + 原生 Canvas 2D（无渲染库）
- 数据：Markdown + YAML frontmatter（事实源） + `.sitian/geodata.json` / `mapdata.json`（只存坐标/编辑态，可删可重建）

| 命令 | 作用 | 前置 |
|------|------|------|
| `npm install` | 装依赖 | — |
| `npm run dev` | 仅前端 dev server（端口 **5174**，但测试走 5180 见下） | — |
| `npm run dev:watch` | 完整 Electron 开发模式 | — |
| `npm run build` | 生产构建（Vite，输出 `dist/`） | — |
| `npm run extract-data` | 从 ROSA 重新提取地理节点到 JSON | 需 `E:/图书馆/ROSA/` 存在 |
| `npm run test` | **回归测试**（`python scripts/tests/run_tests.py`，9 个用例） | 见 §6 环境前提 |

**每次提交前必须过：`npm run build` + `npm run test`。** 任一失败不可合并。

---

## 2. 架构更新（AGENTS.md 已滞后，以本仓库为准）

实际已演进为**五层下钻**，而非 AGENTS.md 描述的三层：

```
world(世界) → star_domain(星域) → galaxy(恒星系) → planet(行星) → area(区域/聚落地点) → interior(建筑内部)
```

视图级别（`viewLevel`）：`world` / `domain` / `system` / `planet` / `area` / `interior`。

实际组件清单（`src/renderer/src/components/`，共 22 个）：
- 核心画布：`WorldSelector.vue` / `GalaxyMap.vue` / `SystemView.vue` / `PlanetMap.vue` / `AreaMap.vue` / `InteriorView.vue`
- 面板：`NodeDetailPanel` / `LayerPanel` / `ClusterPanel` / `ObjectListPanel` / `TreeNavigation` / `SearchBar` / `BookmarkPanel` / `SnapshotPanel` / `RecoveryPanel` / `BatchImportPanel` / `SettingsPanel` / `AboutPanel` / `KeyboardShortcuts` / `OnboardingGuide` / `EagleEye` / `ChangeLog` / `TreeItem`
- 状态：`store/geodata.js`（主 store，约 1900 行，含 undo/redo、interiorData、areaZones/routes/markers、search 状态）/ `store/layers.js` / `store/panels.js` / `store/undo.js`
- 绘制逻辑：已从组件拆分到 `composables/planetDrawing.js` 等（Canvas 绘制函数集中管理，迁移函数时**辅助函数与样式常量必须一并迁移**，否则运行时 ReferenceError 断裂渲染管线）

---

## 3. 不可违反的约束红线

这些错误在代码评审/运行时才暴露，请严格前置规避：

1. **禁止**在 `render()` / Canvas 绘制函数内使用 `Math.random()` —— 会导致拖拽时节点乱跳。布局/地形抖动用**确定性算法**（已实现的 value noise 工具族，见 `开发日志.md` 阶段 3 续），绝不用随机。
2. **坐标/编辑器元数据绝不写入原始 Markdown frontmatter**。坐标只活在 JSON 缓存层（`geodata.json` / `mapdata.json`）。Markdown 永远是世界观事实源。
3. **禁止**在渲染循环中修改 Vue 响应式状态 —— 会触发无限重渲染。
4. **禁止前端直接读写 Obsidian 文件** —— 必须经 Electron 主进程 IPC（`window.sitianAPI`）。路径读取已改为 `getVaultPath()` 动态获取，不要硬编码 `E:/图书馆/ROSA`。
5. **Vue ref 嵌套属性直接赋值（如 `obj[key] = val`）会丢失响应式**。必须创建新对象：`{ ...obj, [key]: val }`，再整体替换 `ref.value`。
6. **坐标拖拽**必须用 rAF 节流 + `fastMode`（拖拽时跳过光晕/渐变/标签渲染）。
7. **只渲染当前层级**：每个视图级别只画其直接相关节点集合，不要为行星建全球地图、不要为恒星系画太空建筑细节（除非在 `interior` 层）。

---

## 4. 接手前的仓库状态（重要！先清理再开发）

当前工作区**有未提交的散落改动**，且 `App.vue` / `geodata.js` 同时出现在 staged 与 unstaged 两侧：

- staged：`scripts/extract-data.js`、`App.vue`、`AreaMap/GalaxyMap/InteriorView/NodeDetailPanel/PlanetMap`、`store/geodata.js`
- unstaged：`App.vue`、`AreaMap/InteriorView/NodeDetailPanel/PlanetMap`、`store/geodata.js`

`git log` 显示最近 4 个提交（批次1-3：家具拖拽旋转、多选批量移动、节点层级迁移工具）**尚未 push**（`ahead 4`）。

**接手操作建议（按顺序）：**
1. 先 `git status` / `git diff` 看清现状，理解这些改动在做什么（主要是：App.vue 面包屑/层级指示器重构、AreaMap 区域绘制扩展、InteriorView 楼层家具编辑、PlanetMap 图层）。
2. 把这些**已在进行的工作**合理分组提交（不要在大混乱 diff 上叠新功能）。建议提交粒度：按功能模块而非按文件。
3. 提交前跑 `npm run build` + `npm run test` 确认绿。
4. 之后再开始新任务。

---

## 5. 给 Zcode 的任务清单（按优先级，附验收标准）

> 以下批次指令由 `ROADMAP.md` 的用户想法转译而来（A1–A10 / B1–B7 / C1–C3）。**每个批次做完必须过 §1 验证命令（build + test 全绿、不违反 §3 红线）。** 按序号推进，每个批次独立 commit 后交回 review。

---

### 批次 0 — 地基收口（最优先，Zcode 接手第一件事）
**来源**：ROADMAP §1。
- [ ] **0.1 清理 §4 脏状态**：把 14 个在途文件按功能模块分组 commit（不要按文件平铺），保持 working tree 干净、`build`+`test` 绿。**不 push**（当前 `ahead 4` 未推，等你授权）。
- [ ] **0.2 跑通 `npm run dist`**：nsis 安装包实跑验证，确认无打包错误（发布闭环最后一块）。
- [ ] **0.3 抽 `PanelShell`**：统一浮窗架构（header 拖拽 + 关闭用 `$emit('close')` + 多面板互斥/避让布局），把 `ClusterPanel`/`ObjectListPanel`/`AreaMap` 工具面板迁到它，消灭"面板无法关/重叠/无法移动"反复坑。
- [ ] **0.4 拆 `store/geodata.js`**（1929 行）：把 area*/interior/search/undo 拆成子模块，降低改局部动全局风险。
- [ ] **0.5 测试环境解耦**：`run_tests.py` 的 `EDGE_EXE`/`REAL_GEODATA` 常量参数化（env 或 CLI 参数），让其它环境能自助验证或明确报错原因。
- **验收**：build✅ + test✅ + 现有面板行为不变（关闭/拖拽/互斥） + store 拆分后功能无回归。

---

### 批次 B4 — 恒星系视图范式评估（独立架构批次，先出方案不强行改）
**来源**：ROADMAP B4。当前 `system` 视图把"星域内所有恒星系聚合"显示，与预设 Stellaris 式"点击单个恒星系亮点→进入该系独立地图"不符。
- [ ] **B4.1 现状测绘**：确认 `GalaxyMap`/`SystemView` 当前如何渲染恒星系聚合，列出要改成"单系独立地图"涉及的文件与状态（`currentSystem` 已有，需新增单系详情视图/路由）。
- [ ] **B4.2 输出改造方案文档**（不写代码）：视图层级是否新增 `system-detail`？现有 `system` 聚合视图保留还是替换？`extract-data.js` 是否需要为单系预生成轨道数据？给出影响面与工作量估算。
- [ ] 把方案写进 `ROADMAP.md` 的 B4 下，交回用户定夺后再编码。
- **验收**：一份可评审的方案 + 影响面清单；**不在此批次改业务代码**。

---

### 批次 A — UI/UX 打磨（来源 ROADMAP §2）
完成批次 0 后推进，每条独立小 commit。
- [ ] **A1 对标主流图形/地图产品**：参照图像编辑、GIS、地图制图产品的交互范式，梳理并提升整体易用/简洁/美观/流畅（先做交互审计清单，再改）。
- [ ] **A2 工具光标反馈**：选择画笔/区域/道路/标记等工具后，光标形态对应变化（如十字/画笔/抓手），强化人机反馈。
- [ ] **A3 导航流畅**：各层级、图层跳转不卡顿（与 C 批次性能联动）。
- [ ] **A4 左侧导航双击跳转**：`TreeNavigation.vue` 支持双击节点直接下钻/跳转对应视图。
- [ ] **A5 地点信息面板重排**：`NodeDetailPanel` 高频按键 + 关键信息优先可见；详情信息（如完整 frontmatter / 长描述）移入"详情"选项卡，默认折叠。
- [ ] **A6 明暗主题修瑕**：修亮色模式的暗色按钮、暗色模式的刺眼白框等不一致（主题系统已存在 `theme-dark`/`theme-light` + 切换按钮，本批次是修 bug 不是从零做）。
- [ ] **A7 窗口最大化**：`src/main/index.js` 的 `BrowserWindow` 默认 `maximize()`（或默认最大化），设置面板保留分辨率可选项。
- [ ] **A8 Emoji→矢量图标**（远期）：规划用 SVG 图标替换 Emoji，确保拉伸不变形、位置正确；本批次只做调研 + 选型，不强制替换。
- [ ] **A9 面板统一美术风格**：所有面板对齐统一设计令牌（参照 `App.vue` P0-1 设计令牌），消除样式混乱/按钮缺失。
- [ ] **A10 启动加载画面**：新增启动 splash（进度条 + 加载 tip），首屏数据/资源就绪前显示。
- **验收**：A1–A10 各自 `build`+`test` 绿；A6 在明暗两主题下无刺眼/错位；A7 默认最大化且可改分辨率。

---

### 批次 B — 新视图 / 层级功能（来源 ROADMAP §3）
**硬约束**（源自 §3）：新画布禁 `Math.random` in render、确定性布局、只渲染当前层级；新层级须同步扩 `extract-data.js` 的 `LAYER_KEYWORDS`/`LAYER_ORDER` 与 store `currentXxx`；新数据类型走 `store/undo.js` 的 `execute()`（避免绕过 undo 栈）。
- [ ] **B1 严守 ROSA 层级规则**：确认城镇/建筑等添加符合系统层级划分，不引入越级节点。
- [ ] **B3 恒星系精细制作**：支持在恒星系内添加复杂天体、编辑轨道（依赖 B4 方案落地后再做）。
- [ ] **B5 恒星系跳转箭头**：在恒星系地图加箭头，以航道链接为依据跳转到相邻恒星系（Stellaris 风格）。
- [ ] **B6/B7 太空标记/舰队卡片**：预留太空兽群/资源点/古战场标记 + 太空舰队/行星军小卡片（信息提示，非策略玩法）；先做数据模型与渲染占位，遵守 B 硬约束。
- [ ] **B2 未来接口预留**：为宇宙总览/时间维度/场景视图预留扩展点（不实现，只留接口/注释）。
- **验收**：B3/B5/B6/B7 各自 build+test 绿且不违反 §3 红线；B2 仅留接口无副作用。

---

### 批次 C — 性能与渲染优化（来源 ROADMAP §4）
- [ ] **C1 行星地图卡顿**：低配设备绘制/拖动优化（视口裁剪、LOD、离屏缓存）。
- [ ] **C2 多线路/标记渲染压力**：大量路线/标记时降级或分层绘制。
- [ ] **C3 启动压力**：首屏加载与数据提取优化（`extract-data.js` 增量提取，避免全量重提）。
- **验收**：在基准数据集下，行星地图拖动帧率可测改善；加载时间缩短；build+test 绿。

---

**通用验收（所有批次）**：改动后 `npm run build` 成功 + `npm run test` 全绿 + 不违反 §3 红线（尤其无 `Math.random` 进 render、坐标绝不写 frontmatter）+ 不引入新的渲染管线 ReferenceError + 不破坏现有面板交互。

---

## 6. 测试环境前提（Zcode 自查）

`npm run test` 的 runner（`scripts/tests/run_tests.py`）需要：
- Python 3（用 `python`，非 `python3` 亦可，见 `package.json` 的 `test` 脚本）。
- **Edge 浏览器**位于 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`（headless CDP，端口 9222）。
- 真实数据：`E:/图书馆/ROSA/.sitian/geodata.json` 与 `mapdata.json` 存在（先跑 `npm run extract-data` 生成）。
- 测试用 mock 注入，**不会写盘污染真实数据**（`saveMapData` 被 mock 拦截）。
- 若本机无 Edge 或 ROSA 路径不同，测试会失败——请先确认环境，或调整 runner 中的 `EDGE_EXE` / `REAL_GEODATA` 常量。

---

## 7. 协作约定

- **唯一权威**：仓库代码 > 本 HANDOFF.md > `AGENTS.md` > `开发日志.md`（历史决策参考）。
- **提交规范**：中文feat/fix 前缀 + 批次号（如 `feat: 批次4 — xxx`）；不要 push 到 `origin/main` 除非用户明确授权（当前 `ahead 4` 未推）。
- **不要动** `.gitignore`、`build/icon.ico`、版权文件（`版权与许可证.md` / `版权备忘.md`）。
- **遇到 AGENTS.md 与代码不符**：以代码为准，并可在本文件 §2 下补充更正，不要重写 AGENTS.md 整体（那是用户资产）。

---

*生成方：Hermes (hy3) ｜ 生成时间：2026-08-22 ｜ 目的：在 GLM-5.3 (Zcode) 限时 token 窗口内高效接手 SiTian 开发。*
