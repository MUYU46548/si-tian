# UI 与测试工具（AGENTS.md 历史条目归档）

> 由 `AGENTS.md` 的「架构速查 / 开发陷阱」按主题拆出（2026-10-19），**原文一字未改**。
> 这里只放**历史**（当时改了什么、踩了什么坑、判据是什么）；当下口径以代码 + 回归用例为准。
> 新增知识请写回 `AGENTS.md` 的速查或**本文件**的对应主题，不要另开新文档。

- **免责声明 + UI 基座试点（2026-10-06，方案 A）**: [`docs/PROPOSAL_DISCLAIMER_AND_UI.md`](docs/PROPOSAL_DISCLAIMER_AND_UI.md) 已落地。
  - **文案单一事实源** `utils/disclaimer.js`：13 节全文 + 短版要点 + 版本化 ack（`DISCLAIMER_ACK_KEY = 'sitian_disclaimer_ack_v' + DISCLAIMER_VERSION`）。⚠️ **不要用 `package.json` 的版本号代替 `DISCLAIMER_VERSION`** —— 发版 ≠ 条款变更，混用会让「改个 bug 也逼所有人重新点同意」。改字只动这一个文件（组件零改动）。
  - **UI**：`components/DisclaimerDialog.vue` 双模式（`gate` 首启阻断 / `view` 随时可查，同一实例由 `App.vue` 持有，避免两份实现漂移）；首次落地 shadcn-vue 源码组件 `components/ui/{button,dialog,card}/`。阻断三件套 = 滚到底才可勾选 + 勾选才能同意 + 「不同意并退出」。
  - 🔴 **三条 reka-ui 事实（读源码实测，不是猜的）**：① `DialogContent` **不会**自动 portal（portal 是独立的 `DialogPortal` 组件）—— 我们**刻意不套它**，因为司天 token 挂在 App 根元素（scoped 的 `.theme-dark/.theme-light`），teleport 到 body 就拿不到颜色（R7）；② `trapFocus` **没给默认值**，不显式传就是 `false` → FocusScope 不做焦点陷阱（「Tab 困在弹窗内」是知情同意的证据力所在，必须显式传）；③ reka-ui 只给 `role="dialog"`，**不给 `aria-modal`** → 要自己写死（本仓此前 0 处 aria-modal，`test_83` 守）。
  - 🔴 **首启挂载的三个必踩坑**：① 判定必须在 `await store.loadGeodata()` **之前**（之后会出现「splash 淡出 → 闪一下主界面 → 才盖上来」）；② `OnboardingGuide` 挂载 1s 后会自动弹出 → 必须加 `window.__sitianDisclaimerGate` 守卫并**在同意后主动补开一次引导**（两层浮层同屏 = 声明被盖住 = 没读过就进去了）；③ 阻断态要在全局 keydown 里**吞掉 Esc 与 F1**（弹窗自身已拦「Esc 关闭」，这层是防全局 Escape 去 `closeAll()`、防 F1 在模态后面开关于面板）。
  - 🔴 **Tailwind 只出 utilities 层，不许引 base**：`tailwind.config.js` 的 `corePlugins.preflight=false` + `assets/tailwind.css` 只写 `@tailwind utilities`（**双保险**）。preflight 会带来 `html{line-height:1.5}`（R2：全仓本无全局行高，一引就整体漂移）与 `ol,ul{list-style:none}`（R1：`NodeDetailPanel` 的 `.markdown-body ul/ol` 没写 `list-style`，靠浏览器默认渲染列表符号 → 会直接消失）。**副作用要自己补**：preflight 缺席时 `class="border"` 只给宽度、`border-style` 仍是 `none`（边框不可见且不报错）→ `tailwind.css` 只对 `.border*` 这几类选择器补 `border-style: solid`，**绝不写 `*` 选择器**（那等于把 preflight 从后门请回来）。配色靠非 scoped 的 `.theme-dark/.theme-light` 把司天取值映射成 `--ui-*`（shadcn 的 `:root` + `html.dark` 体系与司天不接通，见 R7）。⚠️ **引 Tailwind 前必须重跑类名撞车审计**（既有标记里有没有人用了 `container`/`hidden`/`flex`/`border`… 这类单类名 utility）；本轮实测 **0 处撞车**。
  - 🔴 **回归基线必须播种 ack**：`run_tests.py` 的 `MOCK_SCRIPT` 在页面加载前写入「已确认」记录（**键名与版本号从 `utils/disclaimer.js` 解析注入，不在测试里写死** —— 写死会在升版本时静默失配，几十个用例被阻断层一起挡住，表现为「大回归」）。`test_83` 用 `sessionStorage` 的跳过开关清掉 ack 再重载来验证阻断行为，**用例收尾必须清掉该开关并回写 ack**（sessionStorage 跨导航存活，不清会污染后续用例）。
  - 回归 `test_83_disclaimer`（6 段：源码守卫 / 首启阻断 / Esc+点遮罩+全局 Escape 三条路径都关不掉 / 半程不解锁→滚到底→同意 / 已确认不重弹（删 ack 重弹作反证）/ 关于面板入口与查看模式）+ Node `test_disclaimer.js`（13 条：版本化 ack / 降级 / 13 节骨架 / **未成年人条款必须保留** / 第 12 节必须留占位符）。
  - 随动：`版权与许可证.md` 升到 0.1.7 并补齐全部依赖（含 `lucide-vue-next` ISC、`class-variance-authority` Apache-2.0），免责声明第 9 节引用它 —— **改依赖必须同时改这两处**；`README.md` 同步用例数与命令表。

- **🔴 方寸联动：管道是间歇性的 + 确定能跑的客户端（2026-10-18）**：
  - **管道会"消失"**：本轮两次探测结果相反（一次 `ENOENT`、一次连通）—— 原因是**方寸重启的空窗期**，
    以及我们的 `_lab.py down` 用 `taskkill /PID /T /F`（`/T` 会连带杀进程树，
    而方寸桌面版可能与被 kill 的进程同树）。⚠️ **别把一次 ENOENT 当成"桌面版没运行"**。
    自检必须 `Test-Path -LiteralPath '\\.\pipe\tegula-mcp'`（**不带 `-LiteralPath` 是假阳性**，
    它只判路径字符串形式）。
  - **写入口已跑通**：新增 `scripts/tests/tools/fangcun_pipe.py`（Python 直连管道，读写通用，
    `--list` / `--schema <tool>` / `--call <tool> '@args.json'`）。为什么不用 `desktop/dist/cli/tegula-mcp.js`：
    那个 Node 桥在 PowerShell 下过管道/quote 时"没有输出"（实测），而我要的是确定能跑的东西。
    ⚠️ 方寸只认一个 `initialize`；`notifications/initialized` 会回 `Method not found`（无害，别当失败）。
  - **本轮已投递**：方寸任务「司天：下一阶段优先级＝历史剧本修至可用（第十五/十六修已交付…）」
    （project=sitian，状态待办，id 形如 `司天下一阶段优先级历史剧本修至可用第十五-<hash>`）。
  - **绒花墨坊"找不到桌面版"是另一回事**：方寸 `registry.yaml` 里它登记了服务 `NovelForge API : 8765`，
    实测该端口**不通**（服务没跑）—— 与方寸桌面版无关。

- **🔴 与方寸联动：写入口现状 + 一条管道自检的假阳性（2026-10-18）**：
  - **只读入口可用**：`cd <fangcun 仓库> && python tegula.py mcp`（stdio，14 个只读工具，
    **不依赖桌面版**）—— 本轮用它读到了 `task-20261015-002`。
  - **写入口（named pipe `\\.\pipe\tegula-mcp`）不可用**：本轮机器上 **方寸桌面版没在运行**
    （`Get-Process` 无 fangcun/tegula；`Get-ChildItem \\.\pipe\` 里 0 个 tegula 管道）。
    ⇒ 写操作只能走它，因此**无法从本机投递**（按接线卡边界，**禁止**绕过 MCP 去改 `task-data/*.md`：
    会跳过乐观锁与审计）。决策记录先落在 `docs/SITIAN_HANDOFF_20261018_ROUND15.md` §4.5 的
    「方寸决策记录（待投递）」。
  - 🔴 **自检必须用 `Test-Path -LiteralPath`**：`Test-Path \\.\pipe\tegula-mcp`（不带 `-LiteralPath`）
    返回 **True** 是**假阳性** —— PowerShell 只判"这个路径字符串形式合法"，**不去打开管道**。
    本轮因此白追了一轮"CLI 没输出"（直连管道才看到真相：`ENOENT`；
    探针 `scripts/tests/tools/_probe_fangcun_pipe.mjs`）。

- **测试基线**: 两层。① `scripts/tests/unit/*.js` Node 单元测试（**主进程侧**：`.sitian` 原子写/备份轮转/会话基线/路径守卫 + `index.js` 模块接线不变式 + `config.js` 读回校验 + **git 同步/拉取真端到端**（本地 bare 仓库当远程）+ **令牌加密保管**（假加密注入：磁盘无明文、跨实例可取回）——CDP 用例里 `window.sitianAPI` 是 mock，测不到真实落盘、主进程接线与 git）；② `scripts/tests/cases/` **119 个** CDP 用例（Edge 驱动），全绿 + Node 层通过 = 迁移/重构完整。`run_tests.py` 把前者作为前置步骤，失败计 1 个失败用例；**每个用例前还会打开 harness 基线项目**（决策 1 终态下无项目=只读，用例必须跑在有项目的状态，见写闸门条目）。**数据源与真实库解耦（2026-09-21）**：默认读 `scripts/tests/fixtures/vault-fixture/*.json`（合成 fixture，带「不得残留真实专名」硬闸门），用例只依赖 fixture

- **面板/空态可用性（2026-09-20 用户实测 5 条，test_53）**: ① **async 面板的输入框必须自动聚焦**——面板走 `defineAsyncComponent` + `v-if` 挂载，从点工具栏按钮到 DOM 出现有加载窗口，这期间的点击落到底下的画布上，用户表现为「输入框点不进去」（headless 复现不出，别去调时序，改成不依赖点击的实现：`onMounted(() => nextTick(() => input.focus()))` + `.pp-name-row` 整行可点 + `:focus` 深色描边）。② **空态卡片里的按钮行必须 `flex-wrap`**（`.empty-actions`；WorldSelector 卡片 `max-width:560px`）——三个 nowrap 按钮 ≈460px 会溢出 420px 卡片。③ 🔴 **示例数据绝不硬编码真实自用数据**：`ScenarioMap` 的 `baseMapKey` 初值 `''`（按「上次用的且当前项目里存在 → 项目里第一张 → 空」解析），无底图给空态提示、**落笔才懒建**中性名「底图 N」；连带教训：产品里任何「为了好用而隐式造的数据」都会变成测试的隐式依赖（当时 6 个用例靠硬编码默认底图活着，去掉即集体变红），去掉它必须先把依赖显式化 → 用例自带 fixture `lib/helpers.py#open_test_base_map`

- **🔴 「能开始用」批次（B1~B8，2026-09-24；用户反馈「核心功能依然薄弱、不足以投入实际使用」后先做的一批）**: 八项全落地 ——
  ① **空态按只读 / 可写分组**：无项目时 `WorldSelector` 空态给「新建项目（从这里开始）/ 打开已有项目」一等按钮（此前唯一入口是工具栏一个图标，新人无从下手）；header 的「＋新建世界」在只读态自动变「＋新建项目」；**被写闸门拒绝的动作不再谎报成功**（`handleCreateWorld` / `handleLoadSampleWorld` 原来不看返回值就打印「已创建 / 已加载」）。
  ② **首次引导不再撞拒绝**：`OnboardingGuide` 选完知识库原来派发 `sitian:reextract`（落盘写 → 无项目=只读下**必被拒**，用户选完库数据进不来）；改为把用户送到项目面板并指明「新建并导入知识库内容」，引导首步补「先建一个项目」。
  ③ **启动恢复上次项目**：新增 IPC `project-get-last-path`（**只回报「文件确实还在」的路径**，否则回报 `missing`，渲染层据此静默回落只读）+ `canvasBridge.restoreLastProject()`。⚠️ 为什么绕 `canvasBridge`：App 有静态闸门（不得出现 `projectStore` 字样），而 projectStore 是 **Pinia 惰性实例化**（没人 `useProjectStore()` 就不会创建）→ 启动期必须有一个中立入口；用**动态 import** 顺带避开循环依赖与启动开销。**一切失败都静默回落只读，绝不阻塞启动**。
  ④ **保存状态常驻底部状态栏**（`useStatusBar.saveState`，ok/warn/err/busy 四档）：以前落盘失败只在 `ProjectPanel.statusLine` 显示且 5s 自清 → 用户在行星图里连着画几小时**完全看不出**保存失败。现在 **`error` 不自动消失**，由下一次成功保存来清。
  ⑤ **工具栏「保存」不再谎报**：按 `saveGeodata()` 的返回值区分 `staged`（项目态只是推给 projectStore）与已落盘；失败时**不清 dirty**。
  ⑥ **批量建实体**：`EntityCreator` 加「单个 / 批量」切换（每行一个名称）+ `projectStore.createEntities()`（**一条 undo**、同名跳过并列出）—— 以前一次只能建一个，而「批量导入笔记」那条路写的是 .md、要靠 `reextract` 回流（项目态被拒）→ **规模化建实体实际是死的**。
  ⑦ **导入地图配置进 undo 栈**：原来直接给 store 各容器赋值（绕写闸门 + 撤不掉），现在「先把导入后应该是什么样算好 → 交给 `execute` 的 redo 落库」，恢复走**逐键** `restoreMap()` 而非整体替换容器对象（整体替换会让按引用持有的选中态脱钩 —— 项目踩过这个坑）。
  ⑧ **测试守卫同步**：`test_46` 与 `unit/test_project_io` 里**写死通道条数**的断言（`!= 8`、`size === expected.length`）改为**下限守卫 + 集合差报错** —— 数条数不是它们的职责，且新增通道必然假红（本轮真实踩到）。项目 IPC 通道锚点 8 → **9**。

- **🔴 面板配色的铁律：坐在面板底色上的文字必须用主题变量，自带浅色底的块继续用深色字（2026-09-22 用户实测「暗色模式面板文字难以阅读」，回归 test_58）**: 面板底色是 `PanelShell` 的 `var(--panel-bg)`（暗色主题 = #161b22），而同期代码为了满足"浅色卡面"的对比度要求写死了深色字（`#2d3436`/`#1c4fa1`）→ **暗色主题下 = 深底深字**（实测 `.gs-body` 等一批元素对比度 1.2~1.4）。正确做法是按**元素自己的背景**决定用色：直接坐在面板底色上的（正文/标签/链接/次要说明）用 `var(--text-primary/secondary)` + `var(--accent)`；自带浅色底的块（提示条 / 危险区 / 药丸标签 / `code` 片段 / 白底按钮）**继续用显式深色字**。判据不要靠肉眼：用「逐层合成背景 + WCAG 比值」探针在两套主题下各扫一遍（小字 ≥4.5），并把它做成回归断言（本次实测修复后 同步面板 暗色 5.72 / 亮色 5.19，项目面板 4.73 / 5.24）。

- **🔴 UI 可点性与样式统一（2026-09-22 用户实测 3 条 → 回归 test_57）**: ① **「编辑地图」被视图动作条整片盖住**（用户报「行星地图无法编辑」的真因）：`.view-actions` 曾 `position:absolute; top:12px; right:16px; z-index:5`，与 `.map-header` 里同样右对齐的「编辑地图 / 采用自动区域 / 重新生成」**必然重合**，且它在 DOM 里更靠后 → 那三个按钮**看不见也点不到**（截图实测：修复前界面上只剩 5 个按钮）。修法：动作条回到**文档流内的第二行**（`display:flex; justify-content:flex-end`），CSS 里写明「不要再改回绝对定位」。② **flex 居中 + 内容超高会把顶部裁掉且滚不到**：`.world-selector` 的 `justify-content:center` 在 756×441 下把顶部按钮行推到 **y=-20**（够不着）。修法：`justify-content: flex-start` + 首尾元素 `margin:auto`（有富余仍居中、超出则可滚）。同类风险：任何固定高度 + `overflow` + `justify-content:center` 的容器。③ **非激活态 class 为空 = 浏览器默认样式**：Azgaar 参考图层那组按钮只写了 `:class="{active:…}"`，非激活态 class 为空 → 灰底 + 2px outset 边框。判据用 computed style 的 `border-style: outset`（Chromium 默认按钮签名），test_57 全站扫描断言为 0。**手法铁律**：守「按钮真的点得到」必须用**命中测试**（元素中心点 `elementsFromPoint` 的最上层是不是它自己），「元素存在」是假绿；守「看不见的按钮」用 `getBoundingClientRect().top < 0` 扫描。

- **新增全局事件**: `sitian:label-styles-changed` / `sitian:marker-types-changed`（画布监听后 `requestRender`，不依赖深度 watch）

- 🔴 **「引用未声明标识符」是一整类不会被任何旧闸门抓到的缺陷（2026-10-11）**：打包（vite/rollup/esbuild）**不报错**——未声明标识符在 JS 里合法，运行时才去全局找；CDP 用例也只在走到那条路径时才炸。0.2.3 的 `ReferenceError: provinceGridTimer is not defined`（`ScenarioMap.vue` 的 `onUnmounted` 里留着格点时代的陈旧引用）就是这么漏出去的，而用户一退出剧本视图就崩（用户机 `logs/main.log`：`[2026-10-11 15:18:31.889] [error] [renderer] provinceGridTimer is not defined { component: 'ScenarioMap' }`）。现在由 **`scripts/tests/unit/test_undefined_identifiers.js`** 全仓守（`@babel/parser` 扫 `src/renderer/src` / `src/main` / `src/preload` 的 187 个文件；判据 = 引用位置标识符 ∈ 文件内声明 ∪ 全局白名单，**刻意不区分作用域嵌套** = 宁可漏报不可误报；含两条自证反向探针）。它上线时**一次抓出 6 个真缺陷**（`ScenarioMap` 四处 `renderer.requestRender()` / `AreaMap` 漏了整个 `defineEmits` 导致 `@dirty` 永不触发 / `GalaxyMap` 只写不读的 `panSuppressed` / `ScenarioSliceExport` 的 `provinceNames.value` / `planetDrawing.js` 漏 import 的 `convexHull` 与跨模块引用的 `mirrorPoint`）。⚠️ 它依赖 `@babel/parser`（`@vue/compiler-sfc` 的传递依赖，**没进 package.json**，取不到时明确报错、不静默跳过）。
  - 🔴 **两道既有闸门各自够不到它的一半，缺的那一半由 `scripts/tests/drill_package_smoke.py` 补**：93 个 CDP 用例跑在 **Vite dev server** 上（不是打包产物），而 `drill_quit_flush.py` **四个阶段都不离开剧本视图** → `ScenarioMap` 的卸载钩子在真机上一次都没被执行过。新脚本在**打包出来的 `app.asar`** 上走「进历史剧本 → 返回世界选择」，判据 = ①视图真的卸载了（否则是空转）②没有 `#sitian-error-overlay` ③应用自己的错误通道（electron-log）零写入。⚠️ **阳性对照实测：控制台钩子会漏**（故意抛一个未声明标识符，`console.error` 捕获不到，但 overlay 与主进程日志都响了）——**"没报错"的断言必须先证明探测器会响**，否则就是假绿。userData 隔离到临时目录 + 跑完核对真实项目 sha256 未变。

- **0.2.9「收口批」：三件"在跑但没人守"的（2026-10-13；回归 `test_100` / `test_101` / `test_95` b7）**：
  ① 🔴 **PNG 导出此前零回归覆盖**（`test_42` 只测 JSON 与 SVG；`grep export-png|exportScenarioPNG|rasterizeSvg scripts/` 零命中）。
  现由 `test_100` 用**像素判据**守：真鼠标事件点 `[data-testid="export-png"]` → `lib/cdp.py` 的 `fetch_string()`
  分块（512KB）取回 dataUrl → `lib/pngcheck.py`（Pillow）判「合法 PNG / 尺寸 == SVG 头 ×2 / 去重色 ≥4 /
  各势力色有像素 / `LABEL_COLOR` 文字像素 / 状态栏有回音」，外加"关掉标注重导"与"连导两次一致"两条对照。
  ⚠️ **导出按钮在 `.toolbar-more` 里**（模板 `v-if="moreOpen"`）—— 不先 `open_toolbar_more()` 按钮**根本不在 DOM**；
  ⚠️ `buildScenarioSVG` **不是** setupState 顶层绑定（组件只解构了 `export*`），必须走 `SM.scenarioExport.buildScenarioSVG()`。
  ② **「从留底恢复」**：0.2.8 的 `basemap-source-save` 只有 save+list、**没有读回通道** → 那批 `.map` 在界面上等于不存在
  （**备份读不回来就不算备份**）。现补**只读** `basemap-source-read`（名字过 `sanitizeFileName`，**并**校验 resolve 后仍在
  `basemap-sources/` 内 —— 消毒是"不产生层级"，这层是"即使消毒规则改松也不许读出去"）+ 底图组的**时钟图标**入口。
  恢复走 `triggerMapImport({ source })` 的**同一条链**（`handle()` 是唯一实现，刻意不另写导入路径），靠 `file.__fromBackup`
  **不重复留底**（否则每恢复一次就多吃一个轮转位、把更早的版本挤掉）。mock 侧 save/list/read 三者**有状态**
  （`window.__MOCK_BMSRC`）—— 否则整条恢复链在 CDP 层没法真跑。
  ③ **旧数据里的聚落**（早期导入只把首都写进剧本 markers、底图侧无 `burgs`）：那种城镇看得见、点得开编辑器，
  一保存却报"不在这张底图上"＝**改不了**。`updateBaseMapBurg(key, id, patch, { materialize })` 在找不到 id 时把
  **整批**登记成真 burg 再应用这次编辑，且与编辑**共用一条 undo**（拆两条 = "名字退了、城镇还在"的半吊子状态）。
  ⚠️ 只登记被编辑的那一个 → `burgs` 一旦非空，组件的 markers 派生回退分支就不再兜底，**其余城镇会从地图上消失**。
