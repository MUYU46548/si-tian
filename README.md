# SiTian（司天）

本项目**使用AI辅助制作**。

一个为世界构建者设计的**本地桌面应用**（Electron），用于可视化、编辑和迭代多层级的科幻 / 奇幻世界观地理设定。

它以 Obsidian 知识库为唯一事实源，通过**七层下钻视图**呈现地理层级，为 Markdown 附加可编辑的坐标元数据；画布为自研 Canvas 2D 渲染（不依赖外部地图库）。

> **双轨数据（进行中）**：除知识库缓存外，司天还有一套**自有项目文件**（`.sitian`：实体树 + 剧本 + 地图 + 自动快照），目标是脱离 Obsidian 也能独立建库。当前项目面板 / 实体向导已落地，七层视图仍读知识库缓存（接线进行中）。

## 特性

- **七层下钻视图**：世界卡片 → 星域（GalaxyMap）→ 恒星系（SystemView）→ 单恒星系详情（SystemDetailView）→ 行星表面（PlanetMap）→ 区域（AreaMap）→ 建筑内部（InteriorView）
- **背景风格双轨**：星域图走深空风（渐变 + 星云 + 发光节点）；行星表面走 GIS 工具风（纯色底 `#1a2a3a`，无星云无发光）——两套绘制逻辑独立维护
- **行星表面编辑器**：地形多边形、区域色域、聚落 / 地点 / 标记、道路与河流、文本标注、参考图校准、多选与批量排列、撤销栈历史面板
- **数据驱动编辑（v2 方向）**：高度笔刷 → 温度 / 降水 / 生物群系自动派生、河流生成、智能聚落选址（空间哈希 + 二叉堆，避开海洋高山）
- **历史剧本（ScenarioMap）**：底图省份编辑（绘制 / 顶点 / 拆分 / 合并 / 油漆桶）、势力色板、**势力谱系匹配 + 时间轴**（按年比例 / 等宽双轴向、EU4 式斜线占领变化图层、播放）、导出 SVG / PNG / `scenarios.json`
- **Azgaar FMG 底图导入**（可选）：导入 `.map` 后可在行星地图叠加政治实体边界、自然区划轮廓、海岸线 / 山脊、文化 / 宗教区域作为绘画参考；不导入也能使用全部核心功能
- **项目文件（`.sitian`）**：项目面板（新建 / 打开 / 保存 / 备份 / 定位 / 关闭）+ 实体树（改名 / 删除 / 拖动改父级）+ 实体创建向导（按层级分派的落位 / 绘制流程）+ 快照回滚（1 份基准 + ≤50 份增量 diff）
- **数据安全**：知识库缓存自动备份（同一时间戳算一批，保留最近 10 批）、项目文件磁盘备份（10 份）、撤销 / 重做栈、写前完整性校验
- **系统集成**：系统托盘（最小化到托盘 / 单实例锁）、亮色 / 暗色主题、可配置动画 / FPS / 纹理、自动更新（GitHub Releases）

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron 28 |
| UI 框架 | Vue 3 + Pinia |
| 构建工具 | Vite 5 |
| 前端画布 | 原生 Canvas 2D（无外部渲染库） |
| 数据格式 | Markdown + YAML frontmatter + JSON 缓存层（`.sitian/`） |
| 图标 | 内联 SVG 组件（`Icon.vue`）+ Canvas 矢量适配（`canvasIcon.js`），无 emoji |

## 快速开始

### 前置要求

- Node.js 18+ 与 npm
- **Microsoft Edge**（仅回归测试需要，headless 驱动）
- **系统 Python 3.10+**（仅回归测试需要，需 `websocket-client`；Hermes 等自带 venv 可能缺此包）
- 一个 Obsidian 知识库（含地理系统笔记与 `地理系统索引.md`）

### 安装与运行

```bash
npm install

npm run dev          # 仅前端，端口 5180（浏览器里可用只读数据 + mock 写入）
npm run dev:watch    # 完整 Electron（推荐；有真实文件系统与持久化）
```

> 浏览器模式（`npm run dev`）下没有 Electron preload，写入一律返回失败、不落盘——它只用来调界面，不要用它判断"保存是否成功"。

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 仅前端开发服务器（5180） |
| `npm run dev:watch` | 前端 + Electron（真实应用） |
| `npm run build` | 构建生产前端到 `dist/` |
| `npm run dist` / `dist:dir` | 打 Windows 安装包 / 仅解压目录（输出 `release/`） |
| `npm run extract-data` | 从知识库提取地理节点到 `<vault>/.sitian/geodata.json` |
| `npm run audit-coverage` | 提取覆盖率审计（只读；`-- --write-report` 落报告） |
| `npm run migrate-mapdata-keys` | 清理 mapdata 旧 key（默认 dry-run，`-- --apply` 才写盘） |
| `npm run test` | 回归测试（48 个 CDP 用例 + Node 单元测试，见下） |
| `python scripts/gen_architecture_map.py` | 再生成 `docs/ARCHITECTURE_MAP.md` 的清单节（`--check` 自检） |
| `python scripts/emoji_audit.py` / `python scripts/icon_check.py` | emoji 审计 / 图标名一致性校验 |

### 首次启动

1. 启动应用 → **设置面板**（工具栏齿轮，或托盘图标右键）配置 Obsidian 知识库路径
2. 应用会提取地理数据并生成画布布局（缓存写进 `<vault>/.sitian/`）
3. 想脱库使用：工具栏「项目」→ 新建 `.sitian` 项目文件

## 项目文件（`.sitian`）

司天的自有数据格式：**单文件 JSON**（实体树 + 航道 + 剧本 + 地图 + 快照），默认存放于「用户文档 / `SiTianProjects`」。

- **项目面板**：新建 / 打开 / 保存 / 备份 / 定位文件 / 关闭；列出目录内所有 `.sitian`；显示最近 5 份快照并可一键回滚（回滚走撤销栈）
- **实体树**：按父子缩进显示，支持**改名**（双击或行内铅笔）、**删除**（两段式确认，默认连带子实体）、**拖动改父级**（拖到某行 = 挂到它脚下，拖到顶部投放条 = 回到顶层；拖到自己或自己的后代会被拒绝）
- **实体创建向导**：填「名称 / 层级 / 父级」，层级下拉会**按父级自动过滤**（如父级是「世界」时只能建「星域」）；创建完成后给出**结果卡片**（该层级的下一步流程 + 「前往编辑」）
- **快照机制**：1 份基准 + ≤50 份增量 diff（`maps` 不入快照，另有磁盘整文件备份 10 份兜底）

> **阶段说明**：项目文件与面板已可用，但七层视图尚未接到项目文件上（接线进行中）。在接线完成前，画布编辑仍写入知识库缓存，面板里的实体树与画布内容暂时是两套数据——这一点在面板状态条上如实标注，不伪装成只读。

## 底图与剧本数据（Azgaar FMG，可选）

司天支持导入 [Azgaar Fantasy Map Generator](https://azgaar.github.io/Fantasy-Map-Generator/) 导出的 `.map` 文件：

| 图层 | 说明 | 显示方式 |
|------|------|----------|
| 政治实体边界 | 国家 / 省份边界 | 半透明虚线（`political` 模式下可点击编辑） |
| 自然区划轮廓 | 生物群系之间的边界 | 白色细线（marching squares 提取） |
| 海岸线 / 山脊 | 海平面等值线 + 高度梯度大的边 | 蓝色实线（海岸）+ 橙色虚线（山脊） |
| 文化 / 宗教区域 | 文化 / 宗教分布 | 半透明色块叠加 |

导入入口在剧本地图（ScenarioMap）工具栏；导入的省份 / 高度数据会同步到对应行星地图（`mapData[planetId]`）。

> ⚠️ FMG 的角色是「借海陆分布与现成轮廓」，省份 / 区域 / 文化最终仍以司天自己的编辑工具产出为准。

## 项目结构

```
src/
├── main/                    # Electron 主进程
│   ├── index.js             # IPC 路由、窗口管理、缓存备份
│   ├── config.js            # 配置（库路径 / 窗口模式 / 当前底图键 / 最近项目）
│   ├── tray.js              # 系统托盘
│   ├── updater.js           # 自动更新
│   ├── vault-watcher.js     # 知识库文件监听
│   └── handlers/            # 独立 handler（projectHandler：.sitian 文件 I/O，顶层不依赖 electron 以便单测）
├── preload/                 # 预加载脚本（暴露 window.sitianAPI）
└── renderer/                # Vue 3 前端
    └── src/
        ├── components/      # 视图与面板（七层视图、编辑面板、项目面板…）
        ├── composables/     # Canvas 绘制 / 交互逻辑
        ├── store/           # Pinia（geodata 壳 + geodataModules/ 模块、projectStore、writeGate、undo）
        ├── utils/           # 纯函数（几何、样式、schema、导出…）
        ├── workers/         # 派生计算 worker
        └── App.vue          # 视图路由与工具栏
scripts/
├── extract-data.js          # 知识库 → geodata.json
├── audit-coverage.js        # 提取覆盖率审计
├── migrate-mapdata-keys.js  # 缓存旧 key 清理
├── gen_architecture_map.py  # 架构地图再生成
└── tests/                   # 回归测试（cases/ CDP 用例 + unit/ Node 单元测试 + lib/ 客户端）
build/                       # 应用图标资源
docs/                        # 架构地图与设计文档（ARCHITECTURE_MAP.md 权威）
```

## 核心原则

1. **Markdown 为唯一事实源**：世界观原始数据只存在于知识库的 Markdown 文件
2. **坐标不属于世界观**：坐标是编辑器元数据，只进 JSON 缓存层，不写入笔记 frontmatter
3. **布局确定性**：画布节点初始坐标在提取脚本里一次性确定，渲染循环内不使用随机数
4. **只渲染需要的层级**：每个视图只绘制其直接相关的节点集合
5. **外部数据可选**：Azgaar `.map` 等第三方数据只是绘画参考，不导入也能用全部核心功能
6. **写操作单一闸门**：世界观数据的落盘写统一经 `store/writeGate.js` 判定（项目模式 / 知识库回退 / 只读）

## 快捷键

| 操作 | 快捷键 |
|------|--------|
| 搜索 | `Ctrl/Cmd + F` |
| 返回上层 | `←` 或 `Backspace` |
| 撤销 / 重做 | `Ctrl/Cmd + Z` / `Ctrl/Cmd + Shift + Z` |
| 删除选中 | `Delete` |
| 关于面板 | `F1` |
| 设置面板 | `Ctrl/Cmd + ,` |
| 快捷键速查 | `Ctrl/Cmd + ?` |
| 拖拽画布 | `空格 + 拖动` |

编辑模式下还有大量单键工具（选择 / 绘制 / 顶点 / 拆分 / 合并 / 油漆桶 / 各类笔刷 / 河流 / 道路 / 标记…），完整列表见应用内 **快捷键速查** 面板。

## 开发

### 回归测试

```bash
npm run test                      # 需要系统 Python（含 websocket-client）+ Microsoft Edge
python scripts/tests/run_tests.py test_48    # 只跑某个用例
```

两层基线，缺一不可：

1. **Node 单元测试**（`scripts/tests/unit/*.js`，跑在 CDP 用例之前）：主进程真实文件 I/O（`.sitian` 原子写 / 备份轮转 / 路径守卫）与主进程模块接线不变式。CDP 用例里 `window.sitianAPI` 是 mock，**主进程落盘在 CDP 层零覆盖**，所以这层必须存在。
2. **CDP 用例**（`scripts/tests/cases/test_*.py`，Edge headless 驱动真实 Vite dev server + mock 数据）：导航、编辑、面板、渲染性能、剧本时间轴、项目文件等端到端行为。

判定口径：**48/48 CDP 全绿 + Node 单元测试全通过 = 基线完整**。

> 用例断言纪律：`cdp.eval` 在 JS 抛异常时返回 `{'__err__': …}`，判定一律走 `lib/cdp.py` 的 `eval_json()`；「没有报错字段就算通过」会造成静默假绿。

### 代码风格

- Vue 3 Composition API（`<script setup>`）
- Canvas 绘制函数与组件分离（`composables/`、`utils/`）
- 状态集中在 Pinia；世界观数据修改一律走 `store/undo.js` 的 `execute()`（首次写入放在 `redo` 内，防双写）
- 前端不直接读写磁盘：一切文件操作经 Electron IPC
- 测试选择器用 `title` / `data-testid` / class，**不用 emoji 文本**

## 致谢

- **[Azgaar Fantasy Map Generator](https://azgaar.github.io/Fantasy-Map-Generator/)** — `.map` 格式解析与海陆 / 轮廓数据的来源
- **[Vue.js](https://vuejs.org/)** / **[Electron](https://www.electronjs.org/)** / **[Pinia](https://pinia.vuejs.org/)** / **[Vite](https://vitejs.dev/)** — 前端与桌面壳

## 许可证

[MIT License](LICENSE) © 2026 暮雨

## 欢迎赞助

如果喜欢司天，欢迎来[爱发电](https://afdian.com/a/muyu46548B?utm_source=copylink&utm_medium=link)支持作者！

您也可以在爱发电获取绒花计划相关资讯或部分作品资料。
