# SiTian 架构地图 (ARCHITECTURE_MAP)

> **用途**：任务开场读一次本文件，替代全仓库盲扫。读完先核对下方锚点（任选 2-3 个），不符以代码为准。
>
> **维护纪律**：
> - 「结构清单」节由 `python scripts/gen_architecture_map.py` 再生成（行数/文件清单 = 快变量，脚本负责）；自检模式 `--check` 只对比不改写。
> - 「职责」列是人工维护的慢变量，再生成时自动保留；新文件出现时补一句职责，删文件时其描述自动消失。
> - 行为规则/陷阱不写在这里，去 AGENTS.md 速查节和 Hermes skill `sitian-development`。
> - 体积红线：全文 ≤200 行。超了先删职责描述的冗余，不删文件行。

## 锚点（2026-09-11 实测）

| 锚点 | 期望值 |
|---|---|
| 结构清单文件数（脚本扫描） | 118 |
| 测试用例数 | 20 |
| store 模块数（geodataModules/） | 6 |
| App.vue 异步面板 | 19 |
| 主进程 IPC handle | 30 |
| 版本（package.json） | 0.1.5 |

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
| 210 | `scripts/audit-coverage.js` | 提取覆盖率审计（只读）：范围内成节点率 + 缺口清单 + 范围外分布，--write-report 落 96 事务管理/ |
| 103 | `scripts/emoji_audit.py` | emoji 审计（按文件聚合 + 行号上下文） |
| 890 | `scripts/extract-data.js` | Obsidian → geodata.json 提取（LAYER_ORDER/增量缓存/UUID/孤儿检测/mergeUserCreatedNodes） |
| 102 | `scripts/gen_architecture_map.py` | 再生成本清单（--check 自检模式） |
| 100 | `scripts/generate-icons.py` | 图标生成 |
| 237 | `scripts/generate_icon.py` | 图标生成 |
| 60 | `scripts/icon_check.py` | 图标一致性校验（引用名是否都在 Icon.vue 中定义） |
| 180 | `scripts/migrate-mapdata-keys.js` | mapdata.json 旧（无世界前缀）key 清理：dry-run 报告 + --apply 备份/存档/删除 |
| 77 | `scripts/tests/debug_planetmap.py` | PlanetMap 手动诊断脚本 |
| 115 | `scripts/tests/lib/cdp.py` | Edge CDP 连接封装（测试基础设施） |
| 235 | `scripts/tests/lib/helpers.py` | 测试公共 helper（世界/行星导航锚定） |
| 445 | `scripts/tests/run_tests.py` | 测试主控（Edge CDP + mock 注入，用后还原） |
| 296 | `scripts/tests/unit/test_main_module_wiring.js` | Node 单元测试：主进程**模块接线不变式**（index.js 里用到的本地模块导出必须已解构 / 解构了必须真导出）+ config.js 的 loadConfig 读回校验（漏解构只在 IPC 被调用时抛 ReferenceError，启动不报错） |
| 323 | `scripts/tests/unit/test_project_io.js` | Node 单元测试：`.sitian` 路径守卫 / 原子写 / 备份轮转 / 8 个 IPC 通道端到端（CDP 用例的 mock 测不到主进程 I/O） |
| 80 | `scripts/tools_migrate_planetdrawing.py` | 一次性迁移工具（planetDrawing 拆分） |
| 59 | `scripts/tools_migrate_planethittest.py` | 一次性迁移工具（planetHitTest 拆分） |
| 114 | `src/main/config.js` | userData/config.json 读写（VAULT_PATH、closeQuitsApp、windowMode、currentBaseMapKey、lastProjectPath）：loadConfig 必须把每个键**读回内存**（只写不读 = 每次启动丢配置） |
| 372 | `src/main/handlers/projectHandler.js` | `.sitian` 项目文件 I/O：原子写 + 旧文件备份轮转 + 8 个 `project-*` IPC（顶层不依赖 electron，供 Node 单元测试） |
| 785 | `src/main/index.js` | 主进程入口：28 个 IPC handle + 窗口/单实例锁/关闭拦截 |
| 92 | `src/main/tray.js` | 托盘图标（多分辨率 ico）+ 菜单 |
| 105 | `src/main/updater.js` | electron-updater 自动更新 |
| 248 | `src/main/vault-watcher.js` | Obsidian vault 文件变更监听 |
| 159 | `src/preload/index.js` | contextBridge 暴露 sitianAPI（版本号读 asar 内 package.json） |
| 1792 | `src/renderer/src/App.vue` | 全局布局 + 七层视图路由 + 面包屑 + 12 个低频面板异步挂载 |
| 633 | `src/renderer/src/components/AboutPanel.vue` | 关于面板 + 检查更新 + 卸载入口 |
| 2580 | `src/renderer/src/components/AreaMap.vue` | 区域地图（行星下钻）：区域多边形/道路/标记/文本/建筑内部入口 |
| 265 | `src/renderer/src/components/BatchImportPanel.vue` | 批量导入面板 |
| 145 | `src/renderer/src/components/BookmarkPanel.vue` | 书签面板 |
| 29 | `src/renderer/src/components/BrandMark.vue` | （待补） |
| 63 | `src/renderer/src/components/CanvasSkeleton.vue` | 画布加载骨架屏 |
| 235 | `src/renderer/src/components/ChangeLog.vue` | 更新日志面板 |
| 247 | `src/renderer/src/components/ClusterPanel.vue` | 地点簇面板（框选成簇/解散/聚焦） |
| 112 | `src/renderer/src/components/ContextMenu.vue` | 画布右键菜单 |
| 417 | `src/renderer/src/components/EagleEye.vue` | 鹰眼小地图 |
| 410 | `src/renderer/src/components/EntityCreator.vue` | 实体创建向导（C 方案分派式）：表单「名称/层级/父级」+ 层级按父级过滤（CHILD_LAYERS）+ 创建后结果卡片（分派步骤 + 「前往编辑」） |
| 2033 | `src/renderer/src/components/GalaxyMap.vue` | 星域地图：深空风格背景 + 星系聚簇 + 跨星域航道 |
| 231 | `src/renderer/src/components/HistoryPanel.vue` | undo 历史面板 |
| 170 | `src/renderer/src/components/Icon.vue` | （待补） |
| 1897 | `src/renderer/src/components/InteriorView.vue` | 建筑内部：楼层切换 + 家具放置 |
| 269 | `src/renderer/src/components/KeyboardShortcuts.vue` | 快捷键说明面板 |
| 117 | `src/renderer/src/components/LayerPanel.vue` | 图层可见性面板 |
| 2163 | `src/renderer/src/components/NodeDetailPanel.vue` | 节点详情（正文/层级迁移/定位；含 space_marker、fleet_card 伪节点适配） |
| 391 | `src/renderer/src/components/ObjectListPanel.vue` | 对象列表面板 |
| 298 | `src/renderer/src/components/OnboardingGuide.vue` | 首启引导（含选 Obsidian 库入口） |
| 162 | `src/renderer/src/components/PanelShell.vue` | 面板通用外壳（标题/关闭/拖拽） |
| 3718 | `src/renderer/src/components/PlanetMap.vue` | 行星地图（最大组件）：地形/聚落/批量操作，装配 22 个 composables；**读片段勿整读** |
| 741 | `src/renderer/src/components/ProjectPanel.vue` | 项目面板：新建/打开/保存/备份/关闭 + 实体树（改名/两段式删除/拖动改父级/父级下拉，全走 undo）+ 快照回滚（只依赖 projectStore，Phase 2.4 前不接线） |
| 159 | `src/renderer/src/components/PromptDialog.vue` | 自定义对话框（替代被禁的 prompt()） |
| 266 | `src/renderer/src/components/RecoveryPanel.vue` | 崩溃恢复面板（快照回滚） |
| 300 | `src/renderer/src/components/ScenarioLineagePanel.vue` | P2 势力谱系管理面板：可视化纠正 polity.successorOf / lineage 与显式易主年份（纯展示 + emit，写入交给父级） |
| 3954 | `src/renderer/src/components/ScenarioMap.vue` | 剧本地图全屏工作台：底图省份绘制/拆分合并/顶点编辑（贝塞尔切线手柄 + 海岸线吸附 + 网格吸附）、剧本时间轴与势力染色、FMG .map 数据图层（陆海底色/地形高度/温度/降水栅格 + 河流/道路 + 文化/宗教着色与图例）、城镇图层与右键属性面板、PNG 导出 |
| 464 | `src/renderer/src/components/ScenarioTimeline.vue` | 历史剧本时间轴组件：按年比例/等宽双轴向轨道、游标拖动、时代块点击、键盘导航、播放控制（状态由父级持有，多 v-model 同步） |
| 624 | `src/renderer/src/components/SearchBar.vue` | 全局搜索（store/geodataModules/search.js） |
| 1506 | `src/renderer/src/components/SettingsPanel.vue` | 设置面板（选库/关闭行为/窗口模式） |
| 147 | `src/renderer/src/components/SnapshotPanel.vue` | 版本快照面板 |
| 69 | `src/renderer/src/components/StatusBar.vue` | 状态栏 |
| 1274 | `src/renderer/src/components/SystemDetailView.vue` | 单恒星系地图：恒星居中 + 轨道 + 邻系箭头 + 太空标记/部队卡片 |
| 884 | `src/renderer/src/components/SystemView.vue` | 域内恒星系总览（真 hyperlanes） |
| 128 | `src/renderer/src/components/TreeItem.vue` | 树形导航节点项 |
| 130 | `src/renderer/src/components/TreeNavigation.vue` | 树形导航面板 |
| 407 | `src/renderer/src/components/UpdateNotification.vue` | 更新可用提示 |
| 323 | `src/renderer/src/components/WorldSelector.vue` | 世界卡片选择（第一层） |
| 93 | `src/renderer/src/components/ZoomControls.vue` | 缩放控件 |
| 2163 | `src/renderer/src/composables/planetDrawing.js` | 行星图 Canvas 绘制全集（createPlanetDrawing getState 工厂） |
| 219 | `src/renderer/src/composables/planetHitTest.js` | 行星图命中检测 |
| 698 | `src/renderer/src/composables/planetInteractions.js` | 行星图交互回调（createPlanetInteractions getState 工厂） |
| 56 | `src/renderer/src/composables/spaceBackground.js` | 深空背景绘制（GalaxyMap 专用） |
| 113 | `src/renderer/src/composables/systemOrbit.js` | 恒星轨道布局计算 |
| 150 | `src/renderer/src/composables/useAutoRegions.js` | 基于 region 子地点凸包自动生成区域边界 + 迷雾 |
| 187 | `src/renderer/src/composables/useBatchArrange.js` | 批量排列（网格/圆形/对齐/分布/移入区域） |
| 120 | `src/renderer/src/composables/useBatchSelection.js` | 多选/框选 + 批量属性应用 |
| 66 | `src/renderer/src/composables/useBookmarks.js` | 书签逻辑 |
| 778 | `src/renderer/src/composables/useCanvasRenderer.js` | 渲染引擎：viewTransform/rAF/拖拽平移模式切换 |
| 70 | `src/renderer/src/composables/useChangeLog.js` | 变更日志逻辑 |
| 181 | `src/renderer/src/composables/useClusterEditor.js` | 地点簇编辑器 |
| 61 | `src/renderer/src/composables/useContextMenu.js` | 右键菜单状态 |
| 66 | `src/renderer/src/composables/useFocusHighlight.js` | 定位高亮（金色脉冲光圈 + 十字） |
| 487 | `src/renderer/src/composables/useFullMapExport.js` | 全图 PNG 导出（离屏 canvas 重绘 + 比例尺） |
| 53 | `src/renderer/src/composables/useInlineEdit.js` | 双击画布文本原位编辑 |
| 102 | `src/renderer/src/composables/useKeyboardShortcuts.js` | 键盘快捷键（方向键微调/Ctrl+CVD/Esc） |
| 94 | `src/renderer/src/composables/useMarkerEditor.js` | 标记属性编辑器 |
| 97 | `src/renderer/src/composables/useNodeNavigation.js` | 节点跳转定位 |
| 78 | `src/renderer/src/composables/useObjectPanel.js` | 对象面板（聚焦/重命名/删除） |
| 34 | `src/renderer/src/composables/usePanelManager.js` | 本地面板单开互斥 + 与 App 层浮层互斥 |
| 426 | `src/renderer/src/composables/usePlanetHeightBrush.js` | （待补） |
| 63 | `src/renderer/src/composables/usePromptDialog.js` | 对话框状态（替代 prompt()） |
| 71 | `src/renderer/src/composables/useProvinceEditor.js` | 省份(地形块)属性编辑器 |
| 116 | `src/renderer/src/composables/useProvinceSplitMerge.js` | 省份拆分（切割线）/合并（凸包） |
| 228 | `src/renderer/src/composables/useReferenceImage.js` | 区域参考图 + 比例尺校准 |
| 50 | `src/renderer/src/composables/useRegionEditor.js` | 区域属性编辑器 |
| 238 | `src/renderer/src/composables/useReliefBrush.js` | （待补） |
| 92 | `src/renderer/src/composables/useRouteEditor.js` | 路线编辑（描点/虚线/偏移） |
| 82 | `src/renderer/src/composables/useRuler.js` | 标尺/指北针/比例尺（localStorage 持久化） |
| 385 | `src/renderer/src/composables/useScenarioExport.js` | 剧本导出/导入：SVG 矢量图 + PNG（由 SVG 光栅化，两者永远一致）+ scenarios.json 全量数据（含导出前体检与 merge/replace 导入） |
| 59 | `src/renderer/src/composables/useSnapshotPanel.js` | 快照拍摄/恢复/删除 |
| 53 | `src/renderer/src/composables/useStatusBar.js` | 状态栏逻辑 |
| 355 | `src/renderer/src/composables/useTerrainCanvasBrush.js` | （待补） |
| 46 | `src/renderer/src/composables/useTextEditor.js` | 文本标签编辑器 |
| 35 | `src/renderer/src/composables/useTheme.js` | 主题切换 |
| 38 | `src/renderer/src/composables/useZoomControls.js` | 缩放百分比联动 |
| 116 | `src/renderer/src/dev-standalone.js` | （待补） |
| 30 | `src/renderer/src/main.js` | renderer 入口 |
| 1300 | `src/renderer/src/store/geodata.js` | store 壳：defineStore + 装配 5 个 geodataModules + 视图导航 |
| 237 | `src/renderer/src/store/geodataModules/areaEditing.js` | areaZones/areaReferenceImages 增删改（走 undo） |
| 304 | `src/renderer/src/store/geodataModules/interior.js` | interiorData 楼层/家具管理 |
| 886 | `src/renderer/src/store/geodataModules/mapDataEditing.js` | mapData：地形/标记/路线/文本/快照编辑（最大模块） |
| 1543 | `src/renderer/src/store/geodataModules/scenarioEditing.js` | 剧本数据模块：baseMaps（省份/参考图）与 scenarios（polities/ownership/labels/markers）CRUD + 继承拷贝，全部经 execute 走 undo |
| 186 | `src/renderer/src/store/geodataModules/search.js` | matchNode 搜索匹配 |
| 159 | `src/renderer/src/store/geodataModules/spaceEditing.js` | spaceMarkers/fleetCards/hyperlanes 编辑 |
| 180 | `src/renderer/src/store/layers.js` | 图层可见性栈 |
| 39 | `src/renderer/src/store/panels.js` | App 层浮层互斥 |
| 449 | `src/renderer/src/store/projectStore.js` | `.sitian` 项目 store：项目 CRUD + 实体 CRUD（走 undo）+ 快照回滚（Phase 1 未接线） |
| 145 | `src/renderer/src/store/undo.js` | undo/redo 栈（execute 内即调 redo，防双写） |
| 128 | `src/renderer/src/store/writeGate.js` | 单一写闸门：世界观数据落盘写的唯一判定（guardWrite/isReadOnly，三模式 project|legacy|readonly）+ 11 条落盘入口清单 |
| 93 | `src/renderer/src/utils/SpatialIndex.js` | 空间索引（命中加速） |
| 63 | `src/renderer/src/utils/align.js` | 对齐/分布纯函数 |
| 610 | `src/renderer/src/utils/azgaar-parser.js` | Azgaar FMG .map 解析器：按内容嗅探定位各数据段（不写死行号）、grid 级高度/温度/降水数组、provincesBody/河流/道路 SVG 几何、文化/宗教/势力/城镇定义与 province→burg→culture 映射 |
| 289 | `src/renderer/src/utils/canvasIcon.js` | Canvas 端矢量图标（Path2D 复刻 Icon.vue 几何 + 旧 emoji 数据回退） |
| 44 | `src/renderer/src/utils/clipboard.js` | 复制/粘贴/克隆 |
| 229 | `src/renderer/src/utils/contour.js` | （待补） |
| 204 | `src/renderer/src/utils/deriveClient.js` | （待补） |
| 212 | `src/renderer/src/utils/dirtyRect.js` | （待补） |
| 113 | `src/renderer/src/utils/errorReport.js` | 全局错误捕获 + 主进程落盘 |
| 295 | `src/renderer/src/utils/floodfill.js` | 泛洪填充（地形快速绘制） |
| 685 | `src/renderer/src/utils/galaxyDrawing.js` | 星域图绘制全集（GalaxyMap 专用） |
| 162 | `src/renderer/src/utils/geojson.js` | GeoJSON 导入导出 |
| 464 | `src/renderer/src/utils/geometry.js` | 凸包/多边形拆分合并/点包含判定 |
| 188 | `src/renderer/src/utils/heightMath.js` | （待补） |
| 41 | `src/renderer/src/utils/iconSvg.js` | 字符串上下文（innerHTML）用的图标 SVG 助手 |
| 459 | `src/renderer/src/utils/labelStyles.js` | （待补） |
| 238 | `src/renderer/src/utils/markerTypes.js` | （待补） |
| 42 | `src/renderer/src/utils/normalizeId.js` | （待补） |
| 260 | `src/renderer/src/utils/placement.js` | （待补） |
| 151 | `src/renderer/src/utils/planetHeightMap.js` | （待补） |
| 540 | `src/renderer/src/utils/projectSchema.js` | `.sitian` 结构定义 / 校验修复 / 版本迁移 / 就地 diff 快照环形缓冲（纯函数） |
| 244 | `src/renderer/src/utils/reliefIcons.js` | （待补） |
| 139 | `src/renderer/src/utils/rivers.js` | （待补） |
| 69 | `src/renderer/src/utils/roadStyles.js` | （待补） |
| 44 | `src/renderer/src/utils/sampleData.js` | 示例数据 |
| 381 | `src/renderer/src/utils/scenarioTimeline.js` | 剧本时间轴纯函数层（无 DOM/store 依赖）：势力谱系按省份重叠度贪心匹配、逐省易主年份、年份↔轨道轴向映射、EU4 斜线占领判定 |
| 69 | `src/renderer/src/utils/selectionHandles.js` | 选择框手柄 |
| 104 | `src/renderer/src/utils/settlement.js` | （待补） |
| 73 | `src/renderer/src/utils/smartGuides.js` | 智能参考线 |
| 229 | `src/renderer/src/utils/snap.js` | 网格吸附 |
| 84 | `src/renderer/src/utils/stressTest.js` | 压测数据生成 |
| 163 | `src/renderer/src/utils/svgExport.js` | 地图 → SVG 矢量序列化：path 曲线约定同 ScenarioMap 的 `traceShapePath`、斜线 pattern、文档组装与 SVG→PNG 光栅化 |
| 118 | `src/renderer/src/utils/terrainBrush.js` | （待补） |
| 39 | `src/renderer/src/utils/textMeasure.js` | 文本宽度测量 |
| 666 | `src/renderer/src/utils/textures.js` | 程序化地形纹理 |
| 51 | `src/renderer/src/utils/vault.js` | 库名解析：obsidian:// URI 的 vault 参数取自主进程配置（禁硬编码） |
| 42 | `src/renderer/src/utils/viewport.js` | （待补） |
| 59 | `src/renderer/src/workers/deriveWorker.js` | （待补） |
<!-- GEN:END -->

> 测试用例（27 个）在 `scripts/tests/cases/test_01~test_27`，职责见文件名：load/navigation/search/panels/terrain/texture/nodes/interactions/batch_import/system_detail/system_edit/space_entities/tree_jump/tool_cursor/detail_panel_tabs/planet_render_perf/moon_orbit/edit_enhancements/scenario/maplayer/brushes/r2_integrity/tooltip/r4_smart_tools/interior_room/zone_brush/cross_floor。
