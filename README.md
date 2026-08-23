# SiTian（司天）

本项目**使用AI辅助制作**。

一个为世界构建者设计的本地 Web 应用，用于可视化、编辑和迭代多层级的科幻/奇幻世界观地理设定。

它以 Obsidian 知识库为单一事实源，通过 《Stellaris》 风格的三层视图（世界卡片 → 星域地图 → 恒星系详情）呈现地理层级，并为 Markdown 附加可编辑的坐标元数据，实现画布与笔记的双向同步。

## 特性

- **多层下钻视图**：世界 → 星域 → 恒星系 → 行星地图 → 区域地图（AreaMap）→ 建筑内部
- **Stellaris 风格星图**：同心圆轨道、双星系统、跨星域超空间航道、空间站标记
- **双向同步**：画布拖拽直接写入 Obsidian `.sitian/geodata.json` 缓存，文件变更自动刷新画布
- **丰富编辑工具**：拖拽布局、自由绘制区域、顶点编辑、撤销/重做、批量导入
- **数据安全**：自动备份 `.sitian/` 缓存、完整性检查、撤销栈持久化
- **主题系统**：亮色/暗色模式、可配置动画/FPS/纹理
- **系统托盘**：最小化到托盘、单实例锁、托盘菜单快捷入口

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron 28 |
| UI 框架 | Vue 3 + Pinia |
| 构建工具 | Vite 5 |
| 前端画布 | 原生 Canvas 2D（无外部渲染库） |
| 数据格式 | Markdown + YAML frontmatter + JSON 缓存层 |

## 快速开始

### 前置要求

- Node.js 18+
- npm 或 pnpm
- Obsidian 知识库（含地理系统笔记与 `地理系统索引.md`）

### 安装与运行

```bash
# 安装依赖
npm install

# 开发模式（仅前端，port 5174）
npm run dev

# 开发模式（Electron 完整）
npm run dev:watch

# 从 Obsidian 知识库提取地理数据
npm run extract-data
```

### 首次启动

1. 启动应用后，前往 **设置面板**（托盘图标右键 → 设置）
2. 配置 Obsidian 知识库路径
3. 应用将自动提取地理数据并生成画布布局

### 构建与分发

```bash
# 构建生产版本（仅前端）
npm run build

# 构建安装包（Windows NSIS）
npm run dist

# 仅生成解压目录（无安装程序）
npm run dist:dir
```

输出位于 `release/` 目录。

## 项目结构

```
src/
├── main/                 # Electron 主进程
│   ├── index.js         # IPC 路由、窗口管理、托盘集成
│   ├── config.js        # 配置管理（知识库路径、窗口模式）
│   ├── tray.js          # 系统托盘模块
│   └── vault-watcher.js # Obsidian 文件监听
├── preload/             # 预加载脚本（暴露 window.sitianAPI）
└── renderer/            # Vue 3 前端
    ├── src/
    │   ├── components/  # UI 组件（画布、面板、导航）
    │   ├── composables/ # Canvas 绘制与交互逻辑
    │   ├── store/       # Pinia 状态管理
    │   ├── App.vue      # 三层视图路由
    │   └── main.js      # 入口
scripts/
├── extract-data.js      # 从 Obsidian 提取地理节点
└── tests/               # 回归测试套件
build/                   # 应用图标资源
```

## 核心原则

1. **Markdown 为唯一事实源**：所有原始世界观数据仅存于 Obsidian 库的 Markdown 文件中
2. **坐标数据不属于世界观**：坐标是编辑器元数据，仅存在于 JSON 缓存层（`.sitian/geodata.json`）
3. **布局确定性**：画布节点的初始坐标在提取脚本中一次性确定，不在渲染循环中使用随机数
4. **只渲染需要的层级**：每个视图级别只绘制其直接相关的节点集合

## 快捷键

| 操作 | 快捷键 |
|------|--------|
| 搜索 | `Ctrl/Cmd + F` |
| 返回上层 | `←` 或 `Backspace` |
| 撤销 | `Ctrl/Cmd + Z` |
| 重做 | `Ctrl/Cmd + Shift + Z` |
| 删除选中 | `Delete` |
| 关于面板 | `F1` |
| 设置面板 | `Ctrl/Cmd + ,` |
| 快捷键速查 | `Ctrl/Cmd + ?` |
| 拖拽画布 | `空格 + 拖动` |

完整快捷键列表见应用内 **快捷键速查** 面板。

## 开发

### 运行测试

```bash
npm run test
```

测试套件包含 17 个端到端用例，覆盖导航、编辑、面板交互、渲染性能等。需本地安装 Microsoft Edge 并配置 Obsidian 知识库。

### 代码风格

- Vue 3 Composition API（`<script setup>`）
- Canvas 绘制函数与组件分离（`composables/` 目录）
- 状态管理集中在 Pinia store
- 文件操作通过 Electron IPC，前端不直接读写磁盘

## 许可证

[MIT License](LICENSE) © 2026 暮雨
