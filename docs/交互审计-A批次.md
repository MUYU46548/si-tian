# SiTian 交互审计清单（批次 A / A1）

> 生成时间：2026-08-22 ｜ 依据：对 25 个组件 + 共享 composables 的全量代码走查（详见文末证据索引）。
> 方法：对标主流图形/地图产品的交互范式（Figma / Photoshop / ArcGIS / Google Maps / Stellaris），
> 逐项检查 SiTian 的「易用 / 简洁 / 美观 / 流畅」现状，输出问题清单与修复映射。

---

## 1. 对标范式与差距总览

| 范式 | 主流产品做法 | SiTian 现状 | 差距评级 | 对应修复 |
|---|---|---|---|---|
| 工具光标反馈 | Figma/PS：画笔=笔形/十字，抓手=抓手，拖拽=抓取中 | 全部画布只有 `default`；无 crosshair；平移全程不变光标；AreaMap/InteriorView 无任何光标代码 | ★★★ 高 | A2 |
| 单击选中 vs 双击导航 | 资源管理器/Figma 图层树：单击=选中，双击=进入/跳转 | 树导航对 world/star_domain/galaxy **单击即跳转**（连跳两层），深层节点单击只选中——同一棵树两套语义 | ★★★ 高 | A4 |
| 信息面板信息密度 | PS 属性面板：高频操作置顶，低频详情折叠 | 详情面板 8 个区块纵向平铺一列，frontmatter 全量平铺且与 TAGS 行重复 | ★★ 中 | A5 |
| 明暗主题一致性 | 任何支持主题的应用：控件全部跟随主题 | 13+ 个组件硬编码 GitHub-dark 色，亮色主题下成片黑块；3 处幽灵令牌引用不存在的变量 | ★★★ 高 | A6 |
| 首启反馈 | Electron 应用常规：splash 遮罩 + 进度 | 窗口先白屏 → Vue 挂载后突然出现内容，无加载反馈 | ★★ 中 | A10 |
| 窗口默认尺寸 | 桌面地图/图形工具默认最大化启动 | 固定 1600×900，不记忆用户偏好 | ★ 低 | A7 |
| 导航即时性 | Google Maps：层级切换 <100ms | v-if 全量卸载重挂 + 挂载期同步重活（O(n²) 布局、纹理预热），可感卡顿 | ★★ 中 | A3（本批速赢）+ C 批次（结构优化） |
| 图标体系 | 矢量图标、拉伸不变形 | 全 Emoji 图标，跨平台字形差异大 | ★ 低（远期） | A8 选型 |

---

## 2. 审计发现明细

### 2.1 工具光标（→ A2）

- **发现**：全仓库画布无一处 `crosshair`；唯一 `grabbing` 在 TreeItem（树拖拽）而非画布。
- **发现**：平移（含空格临时平移）在 `useCanvasRenderer` 内部完成，全程不改光标——用户没有「可拖拽」的视觉暗示。
- **发现**：PlanetMap `onHover` 把非 move 工具的光标一律清空为 `''`，即便未来别处设置也会被覆盖。
- **发现**：SystemView/SystemDetailView/GalaxyMap 有局部光标逻辑（pointer/move/grab），但编辑模式切换时只重置为 `default`，无工具语义。
- **修复映射**：在共享 `useCanvasRenderer.js` 增加工具→光标映射（pan→grab、绘制/标记/道路/区域类→crosshair、pan 拖动中→grabbing），仅对传入 `interactionMode` 的组件（AreaMap/InteriorView/PlanetMap）生效，避免覆盖三个星图组件的既有悬停光标。

### 2.2 树导航（→ A4）

- **发现**：`TreeNavigation.handleSelect` 单击对浅三层跳视图、对深层节点不跳——语义不一致，且单击跳转容易误触（想选中看详情却被拽走视图）。
- **发现**：跳转逻辑是 SearchBar `autoNavigateToNode` 的残缺复制版（galaxy 分支手动上溯两级，不含 area/interior 层），两处逻辑漂移风险。
- **修复映射**：统一为「单击=选中并开详情面板，双击=跳转对应视图」；跳转逻辑抽为共享模块，SearchBar 与树导航共用，并补全 area/building 层与镜头聚焦。

### 2.3 信息面板（→ A5）

- **发现**：`NodeDetailPanel` 8 区块平铺：操作按钮 → 元信息 → frontmatter+正文 → 关系 → 层级迁移 → 标签 → 属性编辑 → 坐标，阅读与编辑混杂。
- **发现**：frontmatter 无折叠全量平铺，且其中 tags 与上方 TAGS 行重复展示。
- **修复映射**：收进 3 个 tab（概览/关系/编辑），frontmatter 默认折叠进「详情」，高频按钮保持在首屏。

### 2.4 主题一致性（→ A6）

- **发现**：3 处幽灵令牌——引用了不存在的变量名，fallback 恒生效：`var(--btn-hover)`（实际为 `--btn-bg-hover`，App.vue/AreaMap×2）、`var(--text-dim)`×5、`var(--text-main)`×2（BatchImportPanel）。
- **发现**：PanelShell 作为 4 个面板的统一外壳，边框/header 仍硬编码 GitHub-dark——亮色模式下白身黑头撕裂。
- **发现**：五个模态弹窗（设置/快捷键/关于/引导/恢复/变更日志）、NodeDetailPanel、TreeItem、EagleEye、WorldSelector 等硬编码暗色系。
- **发现**：`--panel-glass*` 令牌两主题相同且全仓库零使用（死令牌）；`--planet-*` 两主题相同（行星图在暗色主题恒浅色——历史如此，暂维持，记录在案）。
- **修复映射**：机械映射到既有令牌（#0d1117→--panel-bg、#30363d→--panel-border、#f0f6fc→--text-primary、#8b949e→--text-tertiary、#58a6ff→--accent…），语义红（#f85149/#ff7b72）保留；新增 `--panel-header-bg` 令牌。

### 2.5 导航流畅（→ A3 本批速赢；结构性优化归 C 批次）

- **发现**：App.vue 用 7 个平行 `v-if` 切视图，每次下钻/返回全量卸载重挂组件、重跑布局（无 keep-alive）——结构性主因，**留给 C 批次评估**（keep-alive 有画布状态残留风险，需单独设计）。
- **发现**：GalaxyMap `applyStableLayout` 对每个 galaxy 做 `galaxies.filter(同 parentId)`——O(n²)，挂载时同步执行；且 `[galaxies, domains]` deep watch 会再触发。**本批速赢**：按 parentId 建索引一次 O(n)。
- **发现**：PlanetMap 挂载链=同步 generateAutoRegions + IPC loadMapData + 同步 prewarmTextures + 两个 deep watch——C1/C3 处理，本批不动（风险控制）。
- **发现**：store 侧切换 action 与 computed 全部轻量 O(n)，非瓶颈。
- **发现**：`loadMapData` 已有内存缓存仍重走 IPC——C3 处理。

### 2.6 启动体验（→ A10）

- **发现**：index.html 无 loading 占位，Electron 窗口 `backgroundColor` 未设置——启动白屏闪烁后突然出内容。
- **修复映射**：index.html 内置 splash（星空底 + 进度条 + 按日轮换的使用 tip），入口脚本与 App.vue 启动链分阶段上报进度，数据就绪后淡出。

### 2.7 窗口管理（→ A7）

- **发现**：BrowserWindow 固定 1600×900，无 maximize、无窗口偏好持久化；设置面板无窗口相关项（现有机制：localStorage `sitian-settings`）。
- **修复映射**：主进程 config.json 增加窗口模式偏好（最大化/全屏/默认），默认最大化；设置面板加选择项，经 IPC 即时生效并持久化。

### 2.8 面板风格统一（→ A9）

- **发现**：`.close-btn` 在 9 个文件里各自定义（字号 15/16/18px 不一，hover 行为各异）；模态遮罩五种深浅。
- **发现**：BookmarkPanel/LayerPanel 是浮窗形态但未用 PanelShell（自制 header + close）；ClusterPanel/ObjectListPanel 壳已统一但 body 内按钮仍硬编码。
- **修复映射**：BookmarkPanel/LayerPanel 迁 PanelShell；模态类（设置/关于/快捷键/变更日志/引导/恢复）不套浮窗壳（交互形态不同），仅在 A6 令牌化 + 统一遮罩色。

---

## 3. 证据索引（关键位置）

| 发现 | 位置 |
|---|---|
| 无 crosshair / 平移无光标 | `useCanvasRenderer.js:218-309,362-377`（pan 实现处无 cursor 写入） |
| PlanetMap 清空光标 | `PlanetMap.vue:1920-1922` |
| 树单击跳转 | `TreeNavigation.vue:33-57` |
| 完整跳转实现（可复用） | `SearchBar.vue:224-265`（autoNavigateToNode / findAncestorByLayer） |
| 面板平铺结构 | `NodeDetailPanel.vue:2-255`（模板），frontmatter :53-58 |
| 幽灵令牌 | `App.vue:1443`、`AreaMap.vue:1378,1569`、`BatchImportPanel.vue:169-255` |
| PanelShell 硬编码 | `PanelShell.vue:96-155` |
| O(n²) 布局 | `GalaxyMap.vue:357-361`（applyStableLayout 内嵌 filter），deep watch :1529-1532 |
| v-if 全量重建 | `App.vue:169-237` |
| 窗口固定尺寸 | `src/main/index.js:13-22` |
| 无启动占位 | `src/renderer/index.html` |

---

## 4. 本批次不做的（明确出界）

- **keep-alive 视图缓存**：收益最大但画布组件持有 renderer 状态（viewTransform/事件监听），缓存后需设计状态失效策略——归 C 批次。
- **PlanetMap 挂载链异步化**（generateAutoRegions/prewarmTextures 分帧）：归 C1。
- **SVG 图标实装**：A8 仅输出选型结论（见 `docs/图标选型-A8.md`）。
- **--planet-\* 令牌暗色化**：行星图当前在暗色主题保持浅色底是既成视觉（地形/纹理按浅色调色），单改令牌会导致地形与 UI 割裂，需整体设计——记录待议。
