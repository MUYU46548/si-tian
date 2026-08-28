# SiTian (司天) — ZCODE 接手任务简报（对外发布阶段）

> **生成方**：Hermes (hy3) ｜ 基准日：2026-08-28 ｜ 用途：直接交给第二位 AI 编码 agent（Zcode）执行。
> **⚠️ 最重要的一条**：本仓库的 `HANDOFF.md` / `ROADMAP.md` / `AGENTS.md`（含技能 SKILL.md）**已严重滞后于代码**，不要再以它们的勾选状态判断完成度。本文 §0 是 2026-08-28 的实测真相，与旧文档冲突时**以本文 §0 + 代码为准**。旧文档写"ahead 4 未推 / 14 文件脏 / 五层架构 / SettingsPanel 未做 / 批次 0 待做"均为过期描述。

---

## 0. 真实状态快照（2026-08-28 实测，非推测）

| 项 | 事实 | 来源 |
|----|------|------|
| Git 状态 | 工作树干净，`main` 已与 `origin/main` 同步（**无未推 commit**） | `git status` |
| 最近提交 | 247fbda(ICO微调) / a1d4b3c(导出含指北针比例尺+批量排列+节点形状差异化) / f40a927(InteriorView 参考图+海拔气候降水图层) / 7b5d170(坐标系绑定真实距离+参考图校准+指北针比例尺) / b3ab124(公开仓库安全整理) | `git log` |
| 视图层级 | **七层**全实现：`world → domain → system → system_detail → planet → area → interior` | 代码核查 |
| 回归测试 | **17 个用例**（test_01~test_17），依赖 Edge CDP + 真实 ROSA 数据 | `scripts/tests/cases/` |
| store 拆分 | `geodata.js` **965 行** + `geodataModules/` 5 子模块（areaEditing 237 / interior 200 / mapDataEditing 663 / search 123 / spaceEditing 159）= 1382 行。批次 0.4 已完成 | `wc -l` |
| PanelShell | 已抽（A9），ClusterPanel/ObjectListPanel/BookmarkPanel/LayerPanel/AreaMap 工具面板已收编 | 代码核查 |
| 测试解耦 | `run_tests.py` 已参数化：`SITIAN_VAULT` / `SITIAN_EDGE_EXE` 环境变量 + `--vault` / `--edge` CLI（批次 0.5 完成） | `run_tests.py:36-50` |
| 面板接线 | SettingsPanel / AboutPanel / KeyboardShortcuts / OnboardingGuide / UpdateNotification / RecoveryPanel / BatchImportPanel **全部存在且已在 App.vue 导入挂载** | `App.vue:288-297` |
| Vault 配置 | 设置面板含"选择知识库目录"（chooseVaultPath → sitianAPI.select-vault-path → 主进程 setVaultPath 持久化）；首次启动 `DEFAULT_VAULT=''` 留空由用户指定 | `SettingsPanel.vue:185-299` / `config.js:6` |
| 自动更新 | `main/updater.js`(105行) + IPC `check-for-updates`/`download-update`/`quit-and-install` 已接；AboutPanel「检查更新」+ UpdateNotification 已接线 | `main/index.js:9,368-372` / `AboutPanel.vue:176` |
| 伪节点面板 | `NodeDetailPanel` 已 `isPseudoNode`（space_marker/fleet_card 简化视图）；`SystemDetailView.ctxViewNode` 已构造伪节点交给面板 | `NodeDetailPanel.vue:21-363` / `SystemDetailView.vue:560-585` |
| 全局错误边界 | `main.js:12` 已设 `app.config.errorHandler`（当前仅 `console.error`，**无用户侧友好提示**） | `main.js:12` |
| 首次启动引导 | `OnboardingGuide` 用 `localStorage['sitian-first-run-complete']` 标记，首次启动弹引导 | `OnboardingGuide.vue:50-51` |
| A8 矢量图标 | **未实装**，仅完成调研文档 `docs/图标选型-A8.md`（结论 unplugin-icons + lucide，~160 处 UI emoji 待替换，canvas 内 2 处 fillText emoji 保留） | `docs/图标选型-A8.md` |
| 公开仓库整理 | b3ab124/9fedce1 已移除内部文档、清理硬编码路径、重写 README（**注意：references/ 目录已被删除**，skill 里引用的 `references/2026-08-*.md` 全部失效） | `git log` |

**结论**：旧 HANDOFF 的"批次 0 地基"和 A/B/C/D 批次**绝大多数已完成**，当前阶段是**对外发布打磨 + 少量已知遗留 bug**。下面的任务列只列**真正待做**项，不要重做已完成项。

---

## 1. 不可违反的约束红线（执行前必读，源自旧 HANDOFF §3）

1. **禁止**在 `render()` / Canvas 绘制函数内用 `Math.random()`——拖拽时节点乱跳。布局/地形抖动用确定性算法（`utils/textures.js` 的 value noise 族）。
2. **坐标/编辑器元数据绝不写原始 Markdown frontmatter**。坐标只活 JSON 缓存层。
3. **禁止**在渲染循环改 Vue 响应式状态——无限重渲染。
4. **禁止**前端直读 Obsidian 文件——必须经 `window.sitianAPI` IPC；路径用 `getVaultPath()` 动态获取，勿硬编码 `E:/图书馆/ROSA`。
5. **Vue ref 嵌套属性直接赋值会丢响应式**——必须 `{ ...obj, [key]: val }` 整体替换。
6. **坐标拖拽**必须 rAF 节流 + `fastMode`。
7. **只渲染当前层级**。
8. **undo 双写陷阱**：`execute({ undo, redo })` 内 `redo` 是唯一写入点，调用 `execute()` 前不要手动改数据（否则重复写入→切换模式元素消失）。影响所有 area*/interior/space 的 add/remove/update。
9. **Canvas 函数拆分**时辅助函数 + 样式常量必须随函数迁移，否则运行时 ReferenceError 断裂渲染管线。
10. **Electron 渲染进程不支持 `window.prompt/alert/confirm`**——所有输入用自定义模态（参考 `usePromptDialog` + `PromptDialog.vue`）。
11. **新视图层级**必须同步：① App.vue 面包屑 ② handleBreadcrumb* ③ 所有 backTo* 清理链 ④ layers.js 图层栈 ⑤ geodata.js select*/enter*。当前七层已同步，新增层级照做。
12. **新层数据**须同步 `extract-data.js` 的 `LAYER_KEYWORDS`/`LAYER_LABELS`/`LAYER_ORDER`/`LAYER_SUFFIX_RULES` 四处。

**通用验收（每个任务做完必须）**：`npm run build` 成功 + `npm run test` 全绿（环境不满足时见 §4 降级）+ 不违反上述红线 + 不引入新的渲染管线 ReferenceError + 不破坏现有面板交互。

---

## 2. 对外发布任务列

### P0 — 对外发布硬前置（阻断发布，最优先）

#### P0.1 跑通 `npm run dist` 安装包实跑
- **现状**：HANDOFF 标"待跑"，但公开仓库整理 commit 在；从未有 dist 实跑验收记录。
- **具体**：`npm run build && npm run dist`（electron-builder nsis）在纯净环境实跑；验证 `release/` 产物、exe 图标（build/icon.ico，a1d4b3c 已微调）、安装目录可选、桌面快捷方式、首次启动引导弹出。
- **验收**：在一台未装过 SiTian 的机器/虚拟机安装并运行成功；首次启动→选库→地图加载全链路无崩。
- **注意**：`package.json` 的 `build.win.target=['nsis']`，mac/linux 图标已配但未验证跨平台打包，外部发布若需 mac 请单独验证。

#### P0.2 自动更新发布通道验证
- **现状**：updater.js + IPC + AboutPanel + UpdateNotification 代码已接，但从未发过 release 验证链路。
- **具体**：确认 `package.json` `publish` 配置（`provider:github, owner:MUYU46548, repo:si-tian, publishAutoUpdate:true`）；确认 GitHub 仓库 `MUYU46548/si-tian` 存在且 CI/本地有 `GITHUB_TOKEN` 注入；发一个 pre-release 验证 `checkForUpdates` 能拉到、`downloadUpdate` → `quitAndInstall` 能静默升级。
- **验收**：AboutPanel「检查更新」显示"有更新"→下载进度→重启后版本号变化；UpdateNotification 在启动时后台检查不阻塞。
- **注意**：若外部用户无 GitHub 访问（如国内网络），评估是否换 Gitee/自建更新服务器（架构不兼容 Quartz 同理，先做 GitHub 验证）。

#### P0.3 无 vault / 错误路径首次体验闭环
- **现状**：OnboardingGuide 触发 + 设置面板选库已就位，但"选库后自动重扫→世界卡片出现"全链路未做端到端验收；空 vault / 非法路径无友好报错。
- **具体**：①引导「选择知识库」按钮 → 调 `selectVaultPath` → 持久化 → 自动 `extract-data` → WorldSelector 出现卡片；②路径为空/不存在/非 Obsidian 库时给模态提示而非白屏或崩溃；③切库后 `.sitian` 缓存重建正确。
- **验收**：新用户首次启动全程无控制台未捕获异常；错误路径有可重试的友好模态。

#### P0.4 全局错误边界 UX（外部用户必须）
- **现状**：`main.js:12` `app.config.errorHandler` 仅 `console.error`，外部用户看不到崩溃原因。
- **具体**：错误处理器升级为——未捕获异常弹友好模态（含错误摘要 + "复制详情"/"提交 issue"链接到仓库 Issues），生产模式不暴露堆栈细节；主进程 `uncaughtException`/`unhandledRejection` 也接住并写日志（`electron-log` 已依赖）。
- **验收**：在渲染进程故意抛错，用户看到模态而非白屏；日志落盘（electron-log 默认路径）。
- **注意**：模态本身不得引入新响应式循环（红线 3）。

---

### P1 — 对外可用性打磨

#### P1.1 A8 矢量图标替换（分四批渐进，不破坏 canvas）
- **现状**：`docs/图标选型-A8.md` 已完成调研，结论 `unplugin-icons` + `lucide-vue-next`，~160 处 UI emoji 待替换；canvas 内 2 处 `fillText` emoji（参考图标记/太空标记菱形）保留。
- **具体**（四批）：
  - 批1：装 `unplugin-icons` + `lucide-vue-next`，配置 vite 插件，建立 `IconBase` 包装（currentColor 直通设计令牌）。
  - 批2：替换工具栏/面板 header 的静态 emoji（✏️/📂/🔍 等）。
  - 批3：替换 NodeDetailPanel / LayerPanel / TreeNavigation 内的语义 emoji（层级图标）。
  - 批4：替换动态拼接的 emoji（如地形类型图标 map），确保拉伸不变形、位置正确。
- **验收**：双主题（明暗）截图审查无缺字/错位/溢出；`npm run build` 不增大超阈（图标编译期内联，预期更小）；不触碰 canvas `fillText` 的两处 emoji。
- **注意**：不要一次性全量替换导致 PR 巨大难以 review，按批独立 commit。

#### P1.2 设置面板对外补全
- **现状**：设置面板已有 vault 路径、窗口模式、vault 监听开关；缺"恢复默认/配置导入导出/版本与许可证"。
- **具体**：①「恢复默认设置」带确认模态；②设置导出为 JSON / 导入（迁移用）；③设置内嵌"关于"链接或版本号展示；④主题切换即时生效已做，确认文案对外友好（中文）。
- **验收**：导出 JSON → 清空设置 → 导入还原，行为一致；恢复默认有防误触确认。

#### P1.3 快捷键面板与实现一致性核对
- **现状**：KeyboardShortcuts.vue 已存在，但文档（旧审计）与代码实际绑定可能漂移。
- **具体**：逐项 `grep` 代码实际 `keydown` 绑定（App.vue / 各画布 composable / useCanvasRenderer）vs KeyboardShortcuts.vue 表格，补遗漏项、删代码已移除的无效项；表格按视图层级分组（全局 / 画布 / 面板）。
- **验收**：面板列出的每个快捷键在代码中真实生效；代码中每个全局快捷键都在面板有记录；新增快捷键同步更新面板（定下"加快捷键必更面板"约定）。

#### P1.4 关于面板内容补全
- **现状**：AboutPanel 已有「检查更新」按钮；缺版本号自动读取、更新日志入口、许可证、联系方式。
- **具体**：①版本号从 `package.json` 注入（构建期 `define` 或主进程 IPC 读）；②「更新日志」按钮打开 ChangeLog 组件；③许可证摘要 + 全文链接（`版权与许可证.md` 已存在，对外发布需确认是否包含第三方依赖许可证）；④GitHub / 反馈入口。
- **验收**：关于面板信息完整、链接可达；版本号随 `npm version` 自动更新。

#### P1.5 空状态 / 边界态统一设计
- **现状**：无节点世界、超大库、参考图加载失败、vault-watcher 断网等场景可能裸白屏或静默。
- **具体**：①WorldSelector 无世界卡片时空态提示「请先选择知识库或导入」；②PlanetMap 无节点时空态而非黑屏；③参考图 `img.onerror` 已有（PlanetMap:1316 / AreaMap:790 / InteriorView:363），统一为"参考图加载失败"占位而非消失；④vault-watcher 文件变更监听异常/断网给状态条提示。
- **验收**：上述边界态均有可见反馈，无裸白屏/黑屏。

#### P1.6 恢复面板（RecoveryPanel）对外可见性
- **现状**：迁移类操作已自动备份 `.sitian/geodata.json` 近 10 份（HANDOFF 提及），RecoveryPanel 已存在。
- **具体**：确认外部用户能找到恢复入口（设置/帮助菜单），文案说明"自动备份最近 10 次"，提供一键恢复 + 差异预览。
- **验收**：故意触发一次破坏性操作后能从 RecoveryPanel 恢复；备份份数上限生效（不无限增长）。

---

### P2 — 已知 bug / 完整性（真实待修）

#### P2.1 SystemView 聚合视图假航道与真 hyperlanes 脱钩
- **现状**：ROADMAP §6.3 顺手修正项仍待修——`SystemView.drawHyperlanes` 用 `dist<450` 距离启发现场重算，与 `store.hyperlanes` 脱钩；右键删航道因命中对象无 id 实际删不掉。
- **具体**：`SystemView.drawHyperlanes` 改读 `store.hyperlanes`（区分 cross_domain 紫虚线等 4 类样式，与 GalaxyMap 一致）；右键删航道按 `id` 走 undo 删除。
- **验收**：域总览航道样式与星图一致；右键删除真实生效；补 test 覆盖。

#### P2.2 多世界坐标缓存隔离验证
- **现状**：P2 批次提过"多世界坐标缓存隔离"，但未验收真隔离；ROSA 含多世界（幻境/粘土/绒兽）。
- **具体**：切换世界时确认 `.sitian/geodata.json` 坐标不串（验证 extract-data 多世界 frontmatter 归属 + 缓存 key 是否含 worldId）；单世界大数据量下切换无坐标错位。
- **验收**：在 A 世界拖动的节点，切到 B 世界再回 A，坐标不变；提取端多世界节点归属正确。

#### P2.3 罗马数字轨道排序（可选增强，后置）
- **现状**：行星轨道顺序=节点扫描顺序，标准化命名罗马数字（衡佑Ⅲ 等）未接线。
- **具体**：`extract-data.js` 解析命名罗马数字作为确定性排序依据（替代扫描顺序），属"数据事实"放提取端；md「轨道位置」字段有内容后接线。
- **验收**：同名罗马数字解析正确；无罗马数字时回退扫描顺序（不破坏现有布局）。

#### P2.4 鹰眼（EagleEye）联动打磨
- **现状**：A3 骨架提了"移动节点/缩放/鹰眼联动手感"但未细化；EagleEye 组件已存在。
- **具体**：缩放/平移时鹰眼视口框实时同步；点击鹰眼跳转主视图中心；大地图鹰眼下性能（视口裁剪已做，鹰眼缩略图另算）。
- **验收**：鹰眼视口框与主视图滚动一致；点击跳转镜头居中。

#### P2.5 测试增量（保持 17→N 全绿）
- **具体**：①伪节点详情面板适配（B6/B7 已做代码，补 test 验证 isPseudoNode 视图简化 + ctxViewNode 通道）；②P2.1 航道修复 test；③增量提取缓存边界（单文件变更/删除/重命名）补 test；④P0.4 错误边界可注入错误验证模态（headless 下可测）。
- **验收**：`npm run test` 全绿，新用例不 flaky（参考 test_16 的 rAF 帧确定化写法）。

---

### P3 — 架构性（独立评估，非发布阻断）

#### P3.1 keep-alive 视图缓存 + 状态失效策略
- **现状**：C 批次因画布组件持 window 级 keydown/resize 监听 + renderer 状态，缓存会跨视图串扰，留作独立架构工作。App.vue 七平行 v-if 全量重建是导航卡顿结构性主因。
- **具体**：设计 `deactivated`/`activated` 钩子清理监听与 renderer ctx；或改为 `<keep-alive>` + 按 viewLevel 缓存；评估与 useCanvasRenderer 生命周期冲突。
- **验收**：视图切换无快捷键串扰、无 canvas 重挂 ctx 丢失；导航帧时间可测改善。

#### P3.2 离屏位图缓存重评
- **现状**：C 批次因内存（~128MB）/失效点分散放弃地形整层位图缓存。
- **具体**：若 P3.1/低配设备仍卡，评估局部地形 LOD 缓存（仅当前视口 + 失效钩子集中化）。
- **验收**：低配数据集拖拽帧时间达标（参考 C 批次 ~2.3× 基线）。

---

## 2b. 编辑能力提升任务列（对标 Figma / ArcGIS / QGIS / Google My Maps）

> 代码实测：现有编辑基础已较好——网格吸附（`utils/snap.js`）、边缘吸附（planetDrawing 金色预览）、框选/多选、路径/区域/标记/文本/建筑绘制、参考图 2 点校准、快照、PNG/SVG/全图/JSON 导出、对称镜像、方向键微移（PlanetMap:3366 / InteriorView:1127，Shift+方向键 5~10px）、undo/redo（App 顶栏 + 各画布，带 canUndo/canRedo）。**以下为对标专业绘图/GIS 工具仍缺失的能力**，按性价比排序。

### E1 克隆 / 复制粘贴选中对象
- **对标**：Figma `Ctrl+D` / `Ctrl+C,V`；ArcGIS 复制要素。
- **现状**：仅支持移动，无克隆/跨层复制。多选拖拽是批量移动，不是复制。
- **具体**：①选中节点/标记/区域/家具 → `Ctrl+D` 原地克隆（偏移少量像素，走 undo）；②`Ctrl+C` 入内部剪贴板（含坐标/属性/类型），`Ctrl+V` 粘贴到当前视图（自动 parentId 归属当前层级，draft 标记）；③跨视图粘贴（行星→区域）按层级规则归一。
- **验收**：克隆/粘贴走 undo（Ctrl+Z 可撤）；粘贴对象不写 Markdown（红线 2）；剪贴板不污染真实数据。
- **注意**：id 生成用确定性后缀（不要用 `Math.random`，红线 1；参考现有 `space_marker_${Date.now()}_...` 但 Date.now 在多对象同帧会撞，需序列计数器）。

### E2 撤销历史面板（可交互）
- **对标**：Figma 右侧 history、ArcGIS Operation History、PS 历史面板。
- **现状**：`store/undo.js` 已有 `getHistory()/getHistoryByType()`（ChangeLog.vue 只读展示），但**不可点击跳转**、无"重做点"可视化。
- **具体**：新增可折叠 `HistoryPanel`，列出每步 label + 图标 + 时间；点击历史项跳到该状态（undo/redo 到对应索引——需 undo.js 支持按索引跳转）；当前位置高亮；支持"从某步新建分支"（点击旧步骤后新操作丢掉未来）。
- **验收**：点击任一项视图回到该状态；不破坏现有线性 undo/redo（Ctrl+Z/Y 仍可用）；大历史（>100 步）不卡（虚拟滚动或分页）。
- **注意**：undo.js 当前是 past/future 双栈，按索引跳转需重构为线性历史数组 + 指针；改动影响红线 8（undo 双写），务必复用 `execute` 语义。

### E3 对齐与分布（多选）
- **对标**：Figma Align（左/中/右/上/下/中心）+ Distribute（水平/垂直等间距）。
- **现状**：多选仅支持批量移动；无对齐/等距分布。
- **具体**：多选后浮窗/工具栏出现对齐组（6 向对齐 + 2 向分布），基于选中集 bbox 计算目标，一次性 transform 所有选中（单 undo 步骤）；参考图/网格不计入。
- **验收**：对齐后选中集贴合目标线；分布后等间距；走单 undo；配合网格吸附不冲突。

### E4 选中对象的旋转 / 缩放手柄
- **对标**：Figma 选框 8 控制点 + 旋转握柄；ArcGIS 旋转要素。
- **现状**：区域顶点可拖（planetInteractions vertex 模式），但无整体缩放/旋转握柄；标记/文本/家具仅平移。
- **具体**：单选对象显示包围盒 + 8 缩放点 + 顶部旋转握柄（参考图已有 rotate/flip，家具已有 rotation 字段）；拖握柄实时变换（rAF 节流 + fastMode）；松手单 undo；多选时用整体 bbox。
- **验收**：缩放/旋转走 undo；参考图/家具字段已存在直接复用，区域/标记需扩 rotation/scale 字段（存 JSON 缓存，红线 2）；不引入 render 内随机（红线 1）。

### E5 智能参考线（对齐辅助）
- **对标**：Figma 智能参考线（拖动时自动吸附到其他对象的中心/边缘，显示粉色临时线）。
- **现状**：有网格吸附 + 边缘吸附（已有对象临边），但**无跨对象中心/边缘对齐参考线**（拖 A 靠近 B 中心时自动对齐并显示提示线）。
- **具体**：拖拽/缩放时检测与其他可见对象/画布中心的边缘距、中心距，<阈值显示临时参考线 + 磁吸；阈值随缩放自适应；与现有网格/边缘吸附共存（优先级：智能参考线 > 边缘 > 网格）。
- **验收**：拖动到对某对象中心对齐时显示粉线并吸附；不干扰现有吸附；fastMode 下仍可用（参考线轻量）。

### E6 测量工具
- **对标**：Google Maps 测距、ArcGIS Measure、QGIS 量算。
- **现状**：有比例尺（自动步长）但无主动测量；坐标绑定真实距离已就绪（planetDrawing scaleBar）。
- **具体**：量距工具（点选折线，实时显示累计 km/m + 分段）；量面工具（多边形面积 km²）；结果显示在画布 + 可选吸附到节点；测量态不修改数据（不进 undo）。
- **验收**：测量值与坐标系一致（复用真实距离换算，1 单位=1m 显示 km/m）；退出工具或 Esc 清除；暗/亮主题可读。

### E7 批量属性编辑
- **对标**：QGIS 多要素属性表、ArcGIS 批量字段计算。
- **现状**：NodeDetailPanel 单节点编辑；多选只能批量移动/迁移父级。
- **具体**：多选 → "批量编辑"面板，可统一设 layer/tags/parentId/draft；区域/标记可批量改颜色/类型；确认前预览影响数量。
- **验收**：批量改走单 undo（或每对象独立 undo 但合并为一个操作组）；不写 Markdown（红线 2）；误操作可 Ctrl+Z。

### E8 图层深度管理（LayerPanel 增强）
- **对标**：Figma 图层面板（拖拽排序/分组/锁定/可见）、ArcGIS 内容列表（拖拽改绘制顺序）。
- **现状**：LayerPanel 已有可见性开关，但**无拖拽改绘制顺序、无对象级锁定/分组**。
- **具体**：LayerPanel 支持拖拽重排图层 z-order（持久化到 JSON）；节点/区域/标记级锁定（防误拖）+ 显隐；分组（如"交通""水系"）折叠。
- **验收**：重排后绘制顺序生效（planetDrawing 按 z-order 绘制）；锁定对象不可选中/拖；持久化不污染 Markdown。

### E9 画布内联文本编辑
- **对标**：Figma 双击直接编辑文字、ArcGIS 标注。
- **现状**：文本标签需经模态输入名称+字号+颜色，无画布内双击直编。
- **具体**：双击文本对象进入画布内编辑（contenteditable overlay 或 canvas 临时 input），失焦/Enter 提交（走 undo）；字号/颜色仍经面板。
- **验收**：内联编辑不触发渲染循环（红线 3）；提交走 undo；主题适配。

### E10 GeoJSON 导出 / 导入
- **对标**：QGIS 图层导出 GeoJSON、ArcGIS 要素转 JSON。
- **现状**：仅有内部"地图配置 JSON"导出（SiTian 私有结构，非标准）；`utils/geometry.js:92` 已用 GeoJSON 闭合标准（说明多边形已是 GeoJSON 友好结构）。
- **具体**：导出当前地图为 GeoJSON（FeatureCollection：节点=Point、区域/地形=Polygon、路线=LineString，属性含 name/layer/tags/parentId）；可选导入 GeoJSON 回填（draft 标记，不覆盖 Obsidian 节点）；坐标系用真实距离（米）。
- **验收**：导出的 GeoJSON 可被 QGIS/geojson.io 直接打开；导入不写 Markdown（红线 2）；坐标与司天坐标系一致。

### E11 状态栏（信息反馈）
- **对标**：ArcGIS/QGIS 底部状态栏（鼠标坐标/缩放/选中数/模式）。
- **现状**：各画布有顶部 hint 文本，但无统一底部状态栏；坐标/缩放仅在导出时算。
- **具体**：底部状态栏常驻：当前视图/缩放百分比/鼠标世界坐标（km,m）/选中对象数/当前工具/吸附状态；编辑态高亮。
- **验收**：坐标随鼠标实时更新（rAF，不进渲染循环改响应式——红线 3，用局部 ref 或 throttle）；暗/亮主题可读；不遮挡画布。

### E12 Inspector 属性检查器（专业版 NodeDetailPanel）
- **对标**：Figma 右侧 Inspector（X/Y/W/H/旋转/不透明度/对齐）、ArcGIS 属性窗。
- **现状**：NodeDetailPanel 三 tab（概览/关系/编辑）偏"查看"，编辑态是表单，非紧凑数值 inspector。
- **具体**：选中对象显示紧凑 Inspector（位置 X/Y、尺寸 W/H、旋转、不透明度滑杆、对齐按钮），数值框可直接输入（回车提交走 undo）；多选显示"混合"态。
- **验收**：数值修改走 undo；输入不触发渲染循环（红线 3，失焦/回车提交）；与现有 NodeDetailPanel 共存或融合（评估是否取代"编辑" tab）。

---

## 2c. UI 改进任务列（对标专业绘图 / GIS 工具）

> 现有 UI 已完成 A 批次基础打磨（光标反馈 / 明暗主题令牌化 / 面板统一 / 启动 splash / 窗口最大化）。以下为对标 Figma / ArcGIS / QGIS / Google My Maps 仍可提升的**界面工程**项，按性价比排序。

### U1 工具箱 dock 化（专业工具栏）
- **对标**：Figma 左侧竖排工具 dock、ArcGIS 工具条、QGIS 工具栏。
- **现状**：各画布编辑工具栏是顶部横排 emoji 按钮（AreaMap:38-44 等），工具多时拥挤、无分组、无工具提示快捷键。
- **具体**：编辑模式左侧独立竖向工具 dock（图标 +  tooltip + 快捷键角标），分组（选择/绘制/标注/测量）；当前工具高亮；与画布间距留白（用户偏好"填满可用空间"，但工具 dock 需清晰边界）；A8 矢量图标替换后此处直接受益。
- **验收**：工具切换与现 `interactionMode` 语义一致；暗/亮主题可读；不遮挡画布内容；可收起。

### U2 缩放控件 + 适配 / 选中
- **对标**：Google Maps 右下角 +/-/适配、ArcGIS 比例尺联动缩放、Figma 缩放百分比下拉。
- **现状**：滚轮缩放 + 鹰眼，但**无显式缩放按钮、无"适配视图"/"适配选中"按钮、无缩放百分比输入**。
- **具体**：右下角缩放控件（+ / − / 百分比下拉含 50%~400% / 适配全部 / 适配选中）；与现有 `useCanvasRenderer` 统一缩放入口（`zoomBy`/百分比同步）复用，避免显示不同步。
- **验收**：按钮缩放与滚轮一致；适配选中镜头居中且留边距；百分比输入实时生效；fastMode 不卡。

### U3 右键上下文菜单统一框架
- **对标**：Figma 右键菜单（按对象类型动态项）、ArcGIS 要素右键。
- **现状**：各画布各自实现 `contextMenu`（GalaxyMap/SystemView/SystemDetailView/PlanetMap/AreaMap 有，InteriorView 弱），项不一致、样式散落。
- **具体**：抽 `useContextMenu` 统一框架（注册项按命中类型过滤、统一样式、统一关闭逻辑、键盘可达）；各画布只声明"对 X 类型显示哪些项"。
- **验收**：所有画布右键行为一致；无重复样式代码；新增对象类型易扩展；不触发渲染循环（红线 3）。

### U4 加载骨架屏（非白屏）
- **对标**：Figma 文档加载骨架、ArcGIS 地图加载态。
- **现状**：A10 做了启动 splash，但**视图切换（七层 v-if 重挂）大地图加载期无骨架**，可能短暂空白/黑屏（参考 P1.5 空态）。
- **具体**：画布挂载到首帧渲染期间显示骨架（占位网格 + 脉冲），数据就绪淡出；与现有 splash 风格一致；不阻塞主线程（挂载链已分帧 C3）。
- **验收**：大地图下钻无裸白/黑屏；骨架随主题适配；不引入渲染循环（红线 3）。

### U5 多标签 / 多视图（远期，低风险不做）
- **对标**：ArcGIS Pro 多地图框、Figma 多页签。
- **现状**：单视图栈式下钻，无并排/多标签。
- **具体**：**仅评估，不实现**——当前七层下钻叙事清晰，多标签会引入状态同步复杂度（叠加 P3.1 keep-alive 风险）。记录为未来可选。
- **验收**：N/A（评估结论入文档）。

### U6 主题复测（对外发布前）
- **对标**：任何双主题应用发布前的双主题截图审计。
- **现状**：A6 已令牌化，但后续新增组件（SettingsPanel/AboutPanel/KeyboardShortcuts/Onboarding/UpdateNotification/EagleEye 等）可能 reintroduce 硬编码；`--planet-*` 两主题相同（行星图暗色恒浅色，记录待议）。
- **具体**：对外发布前对全部面板 + 七层视图做暗/亮双主题截图审计，修复遗漏硬编码；评估 `--planet-*` 暗色化（需整体设计，避免地形/UI 割裂）。
- **验收**：双主题无黑块/白字/溢出；新增组件统一走设计令牌（定下"新增 UI 必令牌化"约定）。

### U7 制图布局（图例 / 指北针 / 比例尺开关）
- **对标**：ArcGIS 布局视图（图例 + 指北针 + 比例尺 + 标题）、QGIS 打印布局。
- **现状**：指北针 + 比例尺已实装（7b5d170 / a1d4b3c），但**无图例（地形/区域类别色板说明）、无标题栏、无一键开关整组制图元素**。
- **具体**：①图例面板（自动汇总当前地图的地形类型/区域/标记类别色 + 名称）；②指北针/比例尺/网格/图例统一开关（LayerPanel 或独立"制图"组）；③可选地图标题文本（导出 PNG 时带）。
- **验收**：图例与实际绘制色一致（复用 PLACE_TYPE_COLORS / 地形色板）；开关即时生效；导出 PNG 含所选制图元素（复用现有 exportFullMapPNG 管线）。

---

## 3. 文档同步（ZCODE 接手第一件事，必须做）

> 旧文档误导风险极高，先做文档同步再写功能，否则易重复劳动。

- **D1 重写 `HANDOFF.md`**：§2 架构改为七层、§4 删"14 文件脏/ahead 4 未推"（已 push 干净）、§5 批次状态按 §0 真实勾选（批次 0 地基/ A / B / C / D 多数已完成，仅标真正未做项：P0.1~0.4 / P2.1~2.2 / A8 / P3）。
- **D2 更新 `ROADMAP.md`**：§0 快照更新为 2026-08-28；原 A/B/C/D 想法标记实际完成态；新增"对外发布阶段"指向本文 §2。
- **D3 清理失效引用**：skill `sitian-development` 引用的 `references/2026-08-*.md` 已全部被公开仓库整理删除（`references/` 目录不存在），要么恢复关键参考文档、要么在 skill 中标注"references 已随公开仓库整理移除，以 HANDOFF/ROADMAP 为准"。**注意**：不要动 `版权与许可证.md`、`.gitignore`、`build/icon.ico`（旧 HANDOFF §7 红线）。

---

## 4. 测试环境前提（ZCODE 自查，已参数化）

- `npm run test` = `python scripts/tests/run_tests.py`，需 Python 3 + **Edge**（`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`，headless CDP 9222）+ 真实 ROSA 数据（`E:/图书馆/ROSA/.sitian/geodata.json`，先 `npm run extract-data` 生成）。
- 环境变量覆盖：`SITIAN_VAULT` / `SITIAN_EDGE_EXE`；CLI：`--vault <path>` / `--edge <exe>`。
- 若本机无 Edge 或 vault 不同：用环境变量/CLI 指向自身环境，或明确报告无法跑（不要伪造绿）。mock 注入不写盘污染真实数据（`saveMapData` 被 mock 拦截）。
- 测试中断残留恢复：`git checkout src/renderer/index.html` + 删 `mock-data/`（旧 HANDOFF §7 坑位）。

---

## 5. 协作约定

- **唯一权威**：仓库代码 > 本文 §0 > `HANDOFF.md`（更新后）> `ROADMAP.md` > `AGENTS.md`（已滞后）。
- **提交规范**：中文 `feat/fix` 前缀 + 批次号（如 `feat: P1.1 — 矢量图标批2 工具栏`）；**不要 push 到 `origin/main` 除非用户明确授权**。
- **不要动**：`.gitignore`、`build/icon.ico`、`版权与许可证.md`、版权文件。
- 遇到 AGENTS.md 与代码不符：以代码为准，在 HANDOFF §2 下补更正，不重写 AGENTS.md（用户资产）。

---

*本简报替代旧 HANDOFF 作为 ZCODE 接手权威。所有"已完成"结论均来自 2026-08-28 代码/git 实测，非旧文档推测。*
