# SiTian 架构地图 (ARCHITECTURE_MAP)

> **用途**：任务开场读一次本文件，替代全仓库盲扫。读完先核对下方锚点（任选 2-3 个），不符以代码为准。
>
> **维护纪律**：
> - 「结构清单」节由 `python scripts/gen_architecture_map.py` 再生成（行数/文件清单 = 快变量，脚本负责）；自检模式 `--check` 只对比不改写。
> - 「职责」列是人工维护的慢变量，再生成时自动保留；新文件出现时补一句职责，删文件时其描述自动消失。
> - 行为规则/陷阱不写在这里，去 AGENTS.md 速查节和 Hermes skill `sitian-development`。
> - 体积红线：全文 ≤200 行。超了先删职责描述的冗余，不删文件行。

## 锚点（2026-09-08 实测）

| 锚点 | 期望值 |
|---|---|
| 结构清单文件数（脚本扫描） | 110 |
| 测试用例数 | 18 |
| store 模块数（geodataModules/） | 5 |
| App.vue 异步面板 | 12 |
| 主进程 IPC handle | 28 |
| 版本（package.json） | 0.1.4 |

## 数据流

```
Obsidian vault (E:/图书馆/ROSA/, Markdown 唯一事实源)
  └─ scripts/extract-data.js ──→ E:/图书馆/ROSA/.sitian/geodata.json + mapdata.json (坐标缓存)
       └─ src/main/index.js (IPC: 28 个 handle, 读 vault/写缓存)
            └─ src/preload/index.js (contextBridge → window.sitianAPI)
                 └─ renderer (Vue 3)
                      ├─ App.vue: 七层视图路由 + 面包屑 + 12 个异步面板
                      ├─ store/geodata.js (壳) + store/geodataModules/* (逻辑) + undo.js (历史栈)
                      └─ components/ (按视图层级装配) + composables/ (行星图绘制/交互/编辑器)
```

## 结构清单

<!-- GEN:START -->
| 行数 | 文件 | 职责 |
|---:|---|---|
| 219 | `scripts/add-layer-frontmatter.js` | 给 vault 笔记补 layer frontmatter |
| 234 | `scripts/add-place-type-frontmatter.js` | 给 vault 笔记补 placeType frontmatter |
| 858 | `scripts/extract-data.js` | Obsidian → geodata.json 提取（LAYER_ORDER/增量缓存/UUID/孤儿检测/mergeUserCreatedNodes） |
| 102 | `scripts/gen_architecture_map.py` | 再生成本清单（--check 自检模式） |
| 100 | `scripts/generate-icons.py` | 图标生成 |
| 237 | `scripts/generate_icon.py` | 图标生成 |
| 77 | `scripts/tests/debug_planetmap.py` | PlanetMap 手动诊断脚本 |
| 84 | `scripts/tests/lib/cdp.py` | Edge CDP 连接封装（测试基础设施） |
| 204 | `scripts/tests/lib/helpers.py` | 测试公共 helper（世界/行星导航锚定） |
| 256 | `scripts/tests/run_tests.py` | 测试主控（Edge CDP + mock 注入，用后还原） |
| 80 | `scripts/tools_migrate_planetdrawing.py` | 一次性迁移工具（planetDrawing 拆分） |
| 59 | `scripts/tools_migrate_planethittest.py` | 一次性迁移工具（planetHitTest 拆分） |
| 82 | `src/main/config.js` | userData/config.json 读写（VAULT_PATH、closeQuitsApp、windowMode） |
| 653 | `src/main/index.js` | 主进程入口：28 个 IPC handle + 窗口/单实例锁/关闭拦截 |
| 88 | `src/main/tray.js` | 托盘图标（多分辨率 ico）+ 菜单 |
| 105 | `src/main/updater.js` | electron-updater 自动更新 |
| 244 | `src/main/vault-watcher.js` | Obsidian vault 文件变更监听 |
| 135 | `src/preload/index.js` | contextBridge 暴露 sitianAPI（版本号读 asar 内 package.json） |
| 1742 | `src/renderer/src/App.vue` | 全局布局 + 七层视图路由 + 面包屑 + 12 个低频面板异步挂载 |
| 631 | `src/renderer/src/components/AboutPanel.vue` | 关于面板 + 检查更新 + 卸载入口 |
| 2321 | `src/renderer/src/components/AreaMap.vue` | 区域地图（行星下钻）：区域多边形/道路/标记/文本/建筑内部入口 |
| 264 | `src/renderer/src/components/BatchImportPanel.vue` | 批量导入面板 |
| 145 | `src/renderer/src/components/BookmarkPanel.vue` | 书签面板 |
| 63 | `src/renderer/src/components/CanvasSkeleton.vue` | 画布加载骨架屏 |
| 234 | `src/renderer/src/components/ChangeLog.vue` | 更新日志面板 |
| 246 | `src/renderer/src/components/ClusterPanel.vue` | 地点簇面板（框选成簇/解散/聚焦） |
| 111 | `src/renderer/src/components/ContextMenu.vue` | 画布右键菜单 |
| 276 | `src/renderer/src/components/EagleEye.vue` | 鹰眼小地图 |
| 2032 | `src/renderer/src/components/GalaxyMap.vue` | 星域地图：深空风格背景 + 星系聚簇 + 跨星域航道 |
| 147 | `src/renderer/src/components/HistoryPanel.vue` | undo 历史面板 |
| 1720 | `src/renderer/src/components/InteriorView.vue` | 建筑内部：楼层切换 + 家具放置 |
| 269 | `src/renderer/src/components/KeyboardShortcuts.vue` | 快捷键说明面板 |
| 116 | `src/renderer/src/components/LayerPanel.vue` | 图层可见性面板 |
| 1717 | `src/renderer/src/components/NodeDetailPanel.vue` | 节点详情（正文/层级迁移/定位；含 space_marker、fleet_card 伪节点适配） |
| 390 | `src/renderer/src/components/ObjectListPanel.vue` | 对象列表面板 |
| 297 | `src/renderer/src/components/OnboardingGuide.vue` | 首启引导（含选 Obsidian 库入口） |
| 162 | `src/renderer/src/components/PanelShell.vue` | 面板通用外壳（标题/关闭/拖拽） |
| 2972 | `src/renderer/src/components/PlanetMap.vue` | 行星地图（最大组件）：地形/聚落/批量操作，装配 22 个 composables；**读片段勿整读** |
| 159 | `src/renderer/src/components/PromptDialog.vue` | 自定义对话框（替代被禁的 prompt()） |
| 265 | `src/renderer/src/components/RecoveryPanel.vue` | 崩溃恢复面板（快照回滚） |
| 589 | `src/renderer/src/components/SearchBar.vue` | 全局搜索（store/geodataModules/search.js） |
| 642 | `src/renderer/src/components/SettingsPanel.vue` | 设置面板（选库/关闭行为/窗口模式） |
| 145 | `src/renderer/src/components/SnapshotPanel.vue` | 版本快照面板 |
| 55 | `src/renderer/src/components/StatusBar.vue` | 状态栏 |
| 1270 | `src/renderer/src/components/SystemDetailView.vue` | 单恒星系地图：恒星居中 + 轨道 + 邻系箭头 + 太空标记/部队卡片 |
| 883 | `src/renderer/src/components/SystemView.vue` | 域内恒星系总览（真 hyperlanes） |
| 127 | `src/renderer/src/components/TreeItem.vue` | 树形导航节点项 |
| 129 | `src/renderer/src/components/TreeNavigation.vue` | 树形导航面板 |
| 406 | `src/renderer/src/components/UpdateNotification.vue` | 更新可用提示 |
| 301 | `src/renderer/src/components/WorldSelector.vue` | 世界卡片选择（第一层） |
| 93 | `src/renderer/src/components/ZoomControls.vue` | 缩放控件 |
| 1638 | `src/renderer/src/composables/planetDrawing.js` | 行星图 Canvas 绘制全集（createPlanetDrawing getState 工厂） |
| 219 | `src/renderer/src/composables/planetHitTest.js` | 行星图命中检测 |
| 605 | `src/renderer/src/composables/planetInteractions.js` | 行星图交互回调（createPlanetInteractions getState 工厂） |
| 56 | `src/renderer/src/composables/spaceBackground.js` | 深空背景绘制（GalaxyMap 专用） |
| 113 | `src/renderer/src/composables/systemOrbit.js` | 恒星轨道布局计算 |
| 150 | `src/renderer/src/composables/useAutoRegions.js` | 基于 region 子地点凸包自动生成区域边界 + 迷雾 |
| 187 | `src/renderer/src/composables/useBatchArrange.js` | 批量排列（网格/圆形/对齐/分布/移入区域） |
| 120 | `src/renderer/src/composables/useBatchSelection.js` | 多选/框选 + 批量属性应用 |
| 66 | `src/renderer/src/composables/useBookmarks.js` | 书签逻辑 |
| 71 | `src/renderer/src/composables/useBrushDrawing.js` | 地形笔刷（拖动涂抹 → 凸合并） |
| 667 | `src/renderer/src/composables/useCanvasRenderer.js` | 渲染引擎：viewTransform/rAF/拖拽平移模式切换 |
| 70 | `src/renderer/src/composables/useChangeLog.js` | 变更日志逻辑 |
| 181 | `src/renderer/src/composables/useClusterEditor.js` | 地点簇编辑器 |
| 61 | `src/renderer/src/composables/useContextMenu.js` | 右键菜单状态 |
| 66 | `src/renderer/src/composables/useFocusHighlight.js` | 定位高亮（金色脉冲光圈 + 十字） |
| 240 | `src/renderer/src/composables/useFullMapExport.js` | 全图 PNG 导出（离屏 canvas 重绘 + 比例尺） |
| 53 | `src/renderer/src/composables/useInlineEdit.js` | 双击画布文本原位编辑 |
| 102 | `src/renderer/src/composables/useKeyboardShortcuts.js` | 键盘快捷键（方向键微调/Ctrl+CVD/Esc） |
| 79 | `src/renderer/src/composables/useMarkerEditor.js` | 标记属性编辑器 |
| 97 | `src/renderer/src/composables/useNodeNavigation.js` | 节点跳转定位 |
| 78 | `src/renderer/src/composables/useObjectPanel.js` | 对象面板（聚焦/重命名/删除） |
| 34 | `src/renderer/src/composables/usePanelManager.js` | 本地面板单开互斥 + 与 App 层浮层互斥 |
| 63 | `src/renderer/src/composables/usePromptDialog.js` | 对话框状态（替代 prompt()） |
| 71 | `src/renderer/src/composables/useProvinceEditor.js` | 省份(地形块)属性编辑器 |
| 116 | `src/renderer/src/composables/useProvinceSplitMerge.js` | 省份拆分（切割线）/合并（凸包） |
| 228 | `src/renderer/src/composables/useReferenceImage.js` | 区域参考图 + 比例尺校准 |
| 50 | `src/renderer/src/composables/useRegionEditor.js` | 区域属性编辑器 |
| 92 | `src/renderer/src/composables/useRouteEditor.js` | 路线编辑（描点/虚线/偏移） |
| 82 | `src/renderer/src/composables/useRuler.js` | 标尺/指北针/比例尺（localStorage 持久化） |
| 54 | `src/renderer/src/composables/useSnapshotPanel.js` | 快照拍摄/恢复/删除 |
| 53 | `src/renderer/src/composables/useStatusBar.js` | 状态栏逻辑 |
| 46 | `src/renderer/src/composables/useTextEditor.js` | 文本标签编辑器 |
| 35 | `src/renderer/src/composables/useTheme.js` | 主题切换 |
| 38 | `src/renderer/src/composables/useZoomControls.js` | 缩放百分比联动 |
| 17 | `src/renderer/src/main.js` | renderer 入口 |
| 1060 | `src/renderer/src/store/geodata.js` | store 壳：defineStore + 装配 5 个 geodataModules + 视图导航 |
| 237 | `src/renderer/src/store/geodataModules/areaEditing.js` | areaZones/areaReferenceImages 增删改（走 undo） |
| 200 | `src/renderer/src/store/geodataModules/interior.js` | interiorData 楼层/家具管理 |
| 699 | `src/renderer/src/store/geodataModules/mapDataEditing.js` | mapData：地形/标记/路线/文本/快照编辑（最大模块） |
| 123 | `src/renderer/src/store/geodataModules/search.js` | matchNode 搜索匹配 |
| 159 | `src/renderer/src/store/geodataModules/spaceEditing.js` | spaceMarkers/fleetCards/hyperlanes 编辑 |
| 172 | `src/renderer/src/store/layers.js` | 图层可见性栈 |
| 39 | `src/renderer/src/store/panels.js` | App 层浮层互斥 |
| 100 | `src/renderer/src/store/undo.js` | undo/redo 栈（execute 内即调 redo，防双写） |
| 93 | `src/renderer/src/utils/SpatialIndex.js` | 空间索引（命中加速） |
| 63 | `src/renderer/src/utils/align.js` | 对齐/分布纯函数 |
| 44 | `src/renderer/src/utils/clipboard.js` | 复制/粘贴/克隆 |
| 111 | `src/renderer/src/utils/errorReport.js` | 全局错误捕获 + 主进程落盘 |
| 295 | `src/renderer/src/utils/floodfill.js` | 泛洪填充（地形快速绘制） |
| 685 | `src/renderer/src/utils/galaxyDrawing.js` | 星域图绘制全集（GalaxyMap 专用） |
| 162 | `src/renderer/src/utils/geojson.js` | GeoJSON 导入导出 |
| 464 | `src/renderer/src/utils/geometry.js` | 凸包/多边形拆分合并/点包含判定 |
| 44 | `src/renderer/src/utils/sampleData.js` | 示例数据 |
| 69 | `src/renderer/src/utils/selectionHandles.js` | 选择框手柄 |
| 73 | `src/renderer/src/utils/smartGuides.js` | 智能参考线 |
| 229 | `src/renderer/src/utils/snap.js` | 网格吸附 |
| 84 | `src/renderer/src/utils/stressTest.js` | 压测数据生成 |
| 39 | `src/renderer/src/utils/textMeasure.js` | 文本宽度测量 |
| 666 | `src/renderer/src/utils/textures.js` | 程序化地形纹理 |
<!-- GEN:END -->

> 测试用例（18 个）在 `scripts/tests/cases/test_01~test_18`，职责见文件名：load/navigation/search/panels/terrain/texture/nodes/interactions/batch_import/system_detail/system_edit/space_entities/tree_jump/tool_cursor/detail_panel_tabs/planet_render_perf/moon_orbit/edit_enhancements。
