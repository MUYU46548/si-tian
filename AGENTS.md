# SiTian (司天)

为世界构建者设计的本地桌面应用（Electron 28），以 Obsidian 库（默认 `<库根>/`）为事实源之一，通过七层视图呈现世界观地理层级，为 Markdown 附加可编辑的坐标元数据，实现画布与笔记的双向同步。

> **独立运行化（Phase 1 已落地 2026-09-18；Phase 2.4 接线 + 终态翻开 2026-09-20）**：司天另有一套自有项目文件（`.sitian`，JSON 单文件：实体树 + 剧本 + 地图 + 自动快照），目标是脱离知识库也能新建/编辑/保存世界观。
> 接线已完成：**打开项目 → 画布事实源切到项目文件；关闭项目 → 还原打开前的知识库工作态**（`store/canvasBridge.js` 是唯一接线点）；**无项目 = 只读**（`READONLY_WITHOUT_PROJECT = true`，UI 已灰禁且灰禁带能力说明）。细节（写闸门 / 接线 / 快照 / 退出落盘）见 [`docs/agents-archive/project-save.md`](docs/agents-archive/project-save.md)。

## 技术栈 (Tech Stack)

- 桌面壳: Electron 28
- UI 框架: Vue 3 + Pinia
- 构建工具: Vite 5
- 数据格式: Markdown + YAML frontmatter + JSON 缓存层（`<库根>/.sitian/`）+ `.sitian` 项目文件
- 前端画布: 原生 Canvas 2D（无外部渲染库）；**星系 3D 观景**按需加载 `three@0.128.0`（动态 import，不进首屏，见 views 归档）
- UI 基座（2026-10-06 试点）: Tailwind CSS 3（**只出 utilities 层**）+ shadcn-vue 源码组件（`components/ui/`，基于 reka-ui）

## 常用命令 (Common Commands)

- 安装依赖: `npm install`
- 开发模式 (仅前端): `npm run dev`（端口 **5180**）
- 开发模式 (Electron 完整): `npm run dev:watch`（wait-on tcp:5180 后拉起 Electron）
- 构建生产版本: `npm run build`
- 打包安装包: `npm run dist`（→ **仓库外**的产物目录，见下条；不再写 `release/`）
- **打包产物不许落进仓库（2026-11-08 用户拍板：“构建目录本来就不应该跑到其他文件夹里污染仓库”）**：
  输出目录由 `scripts/lib/distPaths.mjs` 算（**唯一实现**）——默认 `%LOCALAPPDATA%\sitian-build\release`
  （macOS = `~/Library/Application Support/sitian-build`，Linux = `$XDG_DATA_HOME/sitian-build`），
  可用环境变量 `SITIAN_DIST_ROOT` 覆盖；`npm run dist / dist:dir / dist:publish` 一律经 `scripts/dist.mjs`
  （它把 `--config.directories.output=<算出来的>` 透传给 electron-builder）。**不要再裸调 electron-builder**，
  也不要再靠 `release-xxx/` 换目录（历史上这么攒出 10 个目录 / 3.9 GB，已清）。
  验包脚本 `drill_packaged_app.py` 也问同一个模块（不自己算）。守门：`unit/test_dist_paths.js`
  （默认不在仓库内 + 三个脚本都走 dist.mjs + 反向探针）。
- 从 Obsidian 提取数据: `npm run extract-data`
- 回归测试: `python scripts/tests/run_tests.py`（**178 用例**；须用系统 Python，Hermes 自带 venv 缺 `websocket-client`）
  - 数据源默认 = **仓库内合成 fixture**（`scripts/tests/fixtures/vault-fixture/`，由 `fixtures/make_vault_fixture.py` 生成：层级结构同构、内容全虚构、地图几何程序合成）→ **用户改自己的世界观数据不会让用例变红**；要对着真实库跑加 `--real-data`
  - 该命令会先跑 `scripts/tests/unit/*.js`（**135 个** Node 单元测试文件：主进程文件 I/O + 真实 git 同步 + 令牌加密保管 + 纯函数层若干，CDP 用例的 mock 覆盖不到），失败计为 1 个失败用例
  - 单跑某个用例：`python scripts/tests/run_tests.py test_47`
  - **退出码 3 = 环境没起来（不是产品结论）**（2026-11-08）：`store.nodes` 恒 0 / 页面被关掉 /
    harness 基线项目打不开（`no-app`、`browser-dev-mode`）时，整轮**中止**并印一段横幅，
    而不是让 165 条用例各自把“空 store”演成产品缺陷。实测踩过：一次冷启动抖动让 9 条用例集体假红
    （`test_109` 说“推演没起伏”、`test_85` 说“没有打开的项目”、`test_48` 说“面板没渲染”），
    而同一份代码紧接着单跑 `test_46 test_124` 是 2/2 绿。想让它自己重建浏览器重来一次：加 `--retry-env 1`
    （默认 0 = 直接中止）。负向演练：拿一个 `{"nodes":[]}` 的空库跑，必须 exit 3 + 横幅、一条用例都不执行。
  - 🔴 **用例判定必须走 `lib/cdp.py` 的 `eval_json()`**：`cdp.eval` 在 JS 抛异常时返回 `{'__err__': …}`，写成「没有 `fails` 字段就算通过」会造成**静默假绿**（本项目真实踩过：假绿掩盖了「主进程不回显 project → 新建项目必失败」的生产缺陷）
- 提取覆盖率审计: `npm run audit-coverage`（只读；`-- --write-report` 落 `96 事务管理/`）
- mapdata 旧 key 清理: `npm run migrate-mapdata-keys`（默认 dry-run，`-- --apply` 才写盘）
- **存量机器属性搬家（A-1，2026-09-27）**: `npm run migrate-vault-attrs -- --project <file.sitian> [--vault <路径>] [--from-cache]`（默认 dry-run 出**清点表**，`-- --apply` 才写盘）。把笔记 frontmatter 承载的「层级 / 上层挂靠 / 地点类型」搬进项目文件；**只补空、绝不覆盖项目已有值**（不一致进「冲突」清单交人判断），补 parentId 前校验父实体存在，写盘前备份项目文件 + 落**反向档**；**不动笔记**（原字段原地不动 = 后悔药级保险）。⚠️ 跑 `--apply` 前先在司天里关闭该项目（内存态会把改动盖回去）
- **剧本账本 v2 迁移（2026-10-21）**: `node scripts/migrate-ledger-v2.mjs --project <file.sitian> [--apply]`（默认 dry-run 出每代清点；`--apply` 自动备份 + 读回校验）。每代写入 `initialOwnership` + 物化 `changeEvents`（含 `synthesized` 标记），`ownership` 保留为缓存；真实 415 省项目 +6.1% 体积、0 派生冲突。⚠️ 先关闭项目再 apply。
- **事件账本查询/录入（2026-10-22，三刀第一刀）**: `node scripts/ledger-query.mjs --project <file.sitian> --at 1350 --a 瓯 --b 梁`（答「某年两方什么关系」）；`--list` 清点；`--add '<json>' --apply` 录入（默认 dry-run，写前备份 + 写后读回校验；PowerShell 用 `--add @事件.json`）。语义/形状见 [docs/SCENARIO_EVENT_LEDGER.md](docs/SCENARIO_EVENT_LEDGER.md)
- **账本引擎 v3 试算（2026-10-24，第 3 件）**: `node scripts/ledger-dryrun.mjs --project <file.sitian>` —— **只读**：把每段剧本的 `initialOwnership + changeEvents` 迁成事件流（`src/ledger/`）再回放，与落盘缓存 `ownership` **逐省对拍**；有冲突非 0 退出，跑完自证文件未动。回放是**唯一实现**（`src/ledger/replay.js`；`utils/scenarioLedgerV2.deriveFrom` 只是 v2 形状适配器）。415 孤本实测：13 段 / 冲突 0 / 11ms
- **读料扫描（2026-10-22，三刀第二刀）**: `node scripts/vault-scan.mjs --vault <库根> --out <目录> [--geodata]` —— 全库只读归类（地图实体 / 资料 / 待人工），产物 `scan-report.json` + `待人工.md`（每条带原因与凭据）+ 可选 `geodata.json` 试导；输出目录在库内会被拒绝，跑完自动对比库指纹证明一个字节都没写。归类口径见 [docs/VAULT_BRIDGE.md](docs/VAULT_BRIDGE.md)
- `.sitian` 缓存垃圾清理: `npm run clean-cache-junk`（默认 dry-run，`-- --apply` 才写盘；清空名地形 / 空壳底图 / 测试残留节点，删前自检「引用 / 包围盒 / 子节点」，备份落 `backups/cleanup-<ts>/`）
- **备份目录瘦身（2026-10-30 用户拍板：保留最近 3 份）**: `npm run prune-backups`（默认 dry-run，`-- --apply` 才动盘）。每个 `<项目>.sitian.backups/` 与 `<库>/.sitian/backups/` 按 mtime 留最近 N 份（`-- --keep 5` 可改），**超出的"复制 → 校验大小 → 删源"移到归档盘**（默认 `E:\归档\司天备份-<日期>`，不删）；`*.session-baseline.sitian`（打开时的样子）**不参与轮转**。应用侧同口径：`projectHandler.js#BACKUP_KEEP = 3`、`main/index.js` 缓存备份 = 3
- **隐私与署名扫描（发布门槛③，2026-11-05）**: `node scripts/privacy-scan.mjs` —— 三个作用域
  （`code` = `src/` + `scripts/`、`docs` 非归档区、`root` = README/LICENSE/package.json/构建配置）
  扫私人专名与私人路径，**必须 0 命中**；`--signature` 断言 LICENSE / README 的“暮雨”还在
  （**署名要保留**，作者名不在黑名单里）。词表存 `scripts/privacy-terms.js`（base64，明文不落库 ——
  否则扫描器自己就是最大的泄漏点）；`--self-test` 是负向探针，`unit/test_privacy_scan.js`
  把它接进回归（塞真专名必须报；词表文件里也不许出现明文）。
- **诊断包真机演练（发布门槛④，2026-11-05）**: `python scripts/tests/drill_diag_package.py` —— 起
  Vite(5180) + **真实 Electron**（CDP 9224），页面里调 `sitianAPI.diagExport({target})`（走**与按钮完全相同**
  的 IPC），再用 Python `zipfile` **真实解压**核对：两条目、版本/Electron 版本非空、项目计数原样、
  配置只有“空不空 + 盘符”、包内无盘符绝对路径与 `\Users\`。产物 `build/diag-package/`。
  ⚠️ 也会开真实窗口；Windows 重定向 stdout 默认 GBK，脚本里已 `reconfigure(encoding='utf-8')`。
- **示例项目（发布门槛②，2026-11-05）**: 仓里带一份**自造**示例 `sample/示例世界.sitian`
  （72 省 / 4 势力 / 两段时代 / 656 河 / 22,002 格；预览 `sample/示例世界-预览.png`）。
  入口：世界选择页的「示例地图项目」或项目面板的「示例项目」→ 主进程把它**复制到文档目录**再打开
  （asar 只读，直接开会保存失败）。示例带一棵小实体树（世界 → 行星 → 3 区域）。
  重新生成：`python scripts/tests/tools/make_sample_world.py --provinces 72` —— 起真实 Electron
  走产品自己的 store 入口（造陆 → 铺底 → 地形/河/注记 → 两段剧本 → 存盘），并**断言只有 sample_land**
  （否则宁可失败，防止把别的项目数据混进示例）。验收：`python scripts/tests/drill_sample_project.py`
  （复制到文档目录 / 副本能打开 72 省 2 剧本 / 仓里原件 sha256 不变）。
  ⚠️ 生成器必须用隔离的 `--user-data-dir`，且开关要放在 app 路径 **前面**（放后面会被当成 App 参数丢掉）。
  生成器日志落 `build/sample-gen/`（**不许落 sample/**：`build.files` 里是白名单
  `sample/示例世界.sitian`，日志带绝对路径、备份是重复载荷）。
- **打包链路真机演练（2026-11-05）**: `npm run dist` 之后跑 `npm run test:packaged`
  （= `python scripts/tests/drill_packaged_app.py`）—— 定义是“**验包**，不替你打包”。
  静态段用 `@electron/asar` 读 `release/win-unpacked/resources/app.asar`：示例在里面且
  `sample/` **只有示例本身**（生成器日志 / `*.backups` / 预览图都不许进）、没有
  `scripts/tests/**` 与 `__real_desite.map`、`dist/index.html` 里没有 `__SITIAN_MOCK__`；
  再用 7za 从 NSIS 安装包里取出 `resources/app.asar`，与 win-unpacked 的 **sha256 对拍**
  （用户下载的就是刚验的这份载荷）。真机段**直接启动打包版 exe**（不是 `electron .`，
  隔离 `--user-data-dir`、CDP 9226）：页面必须是 `file://`、**真实点**“示例地图项目”按钮 →
  副本打开 72 省 / 2 段剧本 / 实体树含 world → 存一次盘**字节变了**（证明副本可写、没踩 asar
  只读）→ 导诊断包核对 `packaged=true`、版本一致、无绝对路径。收尾删掉本轮复制的那份副本。
  ⚠️ 打包版里**不能** `import('/src/store/projectStore.js')`（那是 Vite 源码路径）——
  只能走 `#app.__vue_app__.config.globalProperties.$pinia._s.get('project')` 取同一个 store 实例。
- **剧本工具栏可读性闸门（2026-11-05）**: `node scripts/tests/unit/test_toolbar_ux.js` ——
  用户原话“不要再让我看到一大堆乱七八糟的按钮和根本看不懂的文字”。四条判据（都读模板 AST，秒级）：
  ① `.toolbar-more` 里**分区标题 ≥ 4** 且都写人话（省份与笔刷 / 笔刷与绘制 / 地形·底图·生成 /
  图层·着色 / 剧本·导入导出）；② 区内**每个按钮都有可见文字**（不许只有图标或 `⊞` 这类符号 ——
  那条“分辨率按钮找不到”就是只有图标造成的，`test_105` 记着）；③ 区内零内部术语
  （FMG / Azgaar / 落库 / 单源 / 格距…）；④ **整张剧本视图**的可见文字（文本 + `title`）零工程术语
  （FMG/Azgaar 是第三方产品名，在导入对话框里保留，用户反而认得）。两条负向探针验过。
  **形态（2026-11-05 第二次改向，用户：“分组把原本就紧张的地图观测空间又压扁了一大截”）**：
  「更多」是**浮在画布上的工具面板**（`position:absolute` 锚在 `.scenario-toolbar` 上，
  5 张 `section.tm-card` 排成两列，点面板外/「收起」关闭）—— 展开时画布高度**一点不动**，
  不再把地图往下推半屏。一个按钮只对应一个工具，不做“同一位置藏多种工具”的嵌套。
  ⚠️ 三个只在截图里才看见的坑：① 列容器里给标题写 `flex-basis:100%` 会变成“高度占满”
  （标题叠成一片文字重影）；② 浮层宽度用 `100vw` 会**宽出画布**（左边还有导航栏）并把整页
  拉出横向滚动条 —— 用 `calc(100% - 24px)`；③ `grid-template-columns: auto-fit` 在这里
  算不出两列（卡片里有宽行），要**显式** `repeat(2, minmax(0, 1fr))`。
- **行星视图工具坞可读性闸门（2026-11-05）**: `node scripts/tests/unit/test_toolbar_ux_planet.js` ——
  `.tool-dock` 从 46px 纯图标竖条改成「图标 + 名字」（104px，19 个工具全部有 2–3 字名字）、
  对齐/分布 8 个符号各补一个字、`重置偏移` 补“重置”、通道 `+` 补“新建”。
  判据：① dock 里每个按钮都有中文名字；② **全模板**无文字按钮只允许**通用符号**
  （× 关闭 / − ＋ 缩放 / ⤢ 适屏）、**色块**（class 含 color-btn / :style 有 background）、
  **插值**（`{{ label }}` 运行时就是文字）；③ 可见文字零工程术语；④ 三条负向探针。
  ⚠️ 两个假阳性教训：`格距` 会命中“网**格距**离”（用负向后视 `(?<!网)格距`）；
  AST 里 `{{ … }}` 是 type 5 插值节点，不认它就会把一大片**有文字**的按钮判成纯图标。
- **行星视图工具坞真机检查（2026-11-05）**: `python scripts/tests/tools/shot_planet_ux.py` ——
  Vite(5180) + 真实 Electron（隔离 profile、CDP 9224）→ 打开示例副本 → `store.selectPlanet()`
  → `editMode = true` → 量 `.tool-dock`：按钮数 / 每个都有文字 / **文字没被裁**
  （`scrollWidth <= clientWidth+1`，纯图标时代不会出现、加字之后才会 —— `.mini-reset` 就差点被 24×24 裁掉）/
  坞宽 ≤140px / 不横向压住 >15% 画布，最后截图 `build/planet-ux/dock.png`。
  ⚠️ 三个只在真机上踩到的点：① `Page.captureScreenshot` 在这张宽画布上会**超 15s 读超时**，
  用 `fromSurface:false` 才拍得到（本脚本两档都试，失败只警告不算失败）；
  ② **浮层顺序**：先关免责声明再跳新手引导 —— 反过来接受声明之后引导层会再弹一次，截图整页是弹窗；
  ③ 免责声明的勾选框是 reka-ui 的 `button[role=checkbox]`，程序化 `.click()` 不稳 ——
  直接置组件 `setupState.agreed = true` 再点“同意并继续”（仍走组件自己的 `accept()`）。
- **全仓纯图标按钮闸门（2026-11-08）**: `node scripts/tests/unit/test_icon_buttons.js` —— 扫**全部 105 个 .vue**
  （不是组件名单），口径与面板闸门同源：文字 / 通用符号（× ✕ ＋ − ⤢ ↺ ↻）/ 通用图标（x、close、plus、
  minus、chevron-*）/ 色块 / 选图 / 展开折叠 均豁免。**基线棘轮**：未登记的文件必须是 0，
  总数必须恰好等于基线之和（修掉一个就同步下调 `BASELINE`）。带 4 条反向探针。**现状 = 0**。
  **顶栏的解法（同日收口，14 → 0）**：主力动作（历史 / 提取 / 保存 / 项目 / 同步 / 书签 / 导出 / 设置）
  图标 + 2 字常驻；低频动作（打开知识库 / 图层 / 快捷键 / 变更日志 / 数据检查 / 切换主题）收进
  `App.vue` 的 `.header-more` 浮层（每一项也是图标 + 文字）。**浮层用 `v-show` 而不是 `v-if`**：
  菜单项常驻 DOM，既有那批按 `title` 找 `.toolbar-actions button` 的用例（test_04/117/124/30/32/47）不必改；
  可达性由真机判据守：`python scripts/tests/tools/shot_settings_panel.py --view header`
  （按钮全有字 / 1920 与 1280 都不横向溢出 / 浮层能开、项都有字、完整在视口内 / 点外面能收起 ——
  收起必须用**真实鼠标事件**，`body.click()` 只派发 click 不派发 mousedown 会假红）。
- **设置面板真机检查（2026-11-08）**: `python scripts/tests/tools/shot_settings_panel.py` —— 起 Vite(5180)
  + **真实 Electron**（隔离 profile、CDP 9225）+ **乱库夹具副本**（`vault-fixture-messy` 复制到 build 里，
  仓内夹具只读）→ 真点“重建索引”（不建索引时摘要行 `v-if` 不渲染，判“有没有溢出”就是**空转**）→
  量 `[data-testid=geo-parent-dirs]` 的几何：说明文字宽 ≥220（横排压扁时会变成一列字）、输入框 ≥220×48、
  三个按钮文字没被裁且没竖排、摘要行 `scrollWidth <= clientWidth+2`、待人工行标题**不是 H1 的“概述”**、
  理由没被 ellipsis 吃掉；截图 `build/settings-panel/settings.png`。
  🔴 两个只在真机上才现形的坑：① 把“说明 + 输入 + 按钮”塞进 `.setting-item`（那是横排 flex）→
  说明被压成一列字、按钮叠在一起，**源码闸门与 test_124 全绿**（用户截图才看见）；
  ② 首启免责声明是 gate 模式（滚到底 + 勾选两道门槛），程序化点 disabled 按钮是静默 no-op →
  截图整页是弹窗而 DOM 判据照绿。工具里改成“拿 `DISCLAIMER_ACK_KEY` 自己写 ack 再重载”，
  并把“免责声明已关掉”列成**硬判据**。
- emoji 审计: `python scripts/emoji_audit.py`（`--detail` 附行号上下文，`--file <path>` 单文件）
- 退出前落盘真机演练: `python scripts/tests/drill_quit_flush.py`（起真实 Electron + dist + 真实库/项目，
  **纯 UI 驱动 + 读盘核对**；P1 强杀做负向探针 / P2 Ctrl+Q / P3 点 ×；跑前自动备份并还原项目与配置。
  ⚠️ 只在**没有真实任务在跑**时用：它会短暂开一个真实窗口）
  - **P4 = 剧本专用演练（2026-10-07 加）**：`--phase p4`（或 `all`）。空底图下第一次落笔懒建底图 → 建省 → 定位该省 → **拆分改边界** → Ctrl+Z 撤销 → 真右键菜单删省 → 剧本 增·改·删，**每一步都读项目文件核对落盘**（判据只有磁盘，因为剧本/地图各有 300ms + 800ms 两层防抖）。与 p1~p3 不同：**不要求空项目**（全程相对基线，可在有内容的项目上跑），跑完由 main() 还原项目文件。
    - ⚠️ **四个只在真机上才暴露的坑（改这段前必读）**：① **Vue 的 DOM 更新是异步的** —— 同一个 tick 里 `querySelector('.props-name')` 永远是空、`btn.disabled` 永远是旧值，读 DOM 前一律 `await new Promise(r => setTimeout(r, 0))`；② 对 **`:disabled` 按钮 `el.click()` 是静默 no-op**（既不执行也不报错）—— 填完表单必须等一拍再点，并回传 `disabled` 供诊断；③ 按 title 找工具按钮时 **片段必须唯一**：写 `'选择'` 会先命中 **「返回世界选择」**（排在最前）→ 一次点击直接退出剧本视图，必须写 `'选择 (V)'`；④ **CDP 客户端的读超时是 15s** —— 任何"扫描式"探测都要自带**墙钟上限**（本段取 8s）并在超限时**返回可读失败**，否则演练会崩在 `WebSocketTimeoutException` 上而不是给结论。另：底图是懒建的，**必须在落笔之后再读 `.basemap-select`**，用空键查盘会永远查不到（曾导致一条断言期望值也是 0 → **空转通过**）。
- **019 重导真机演练（2026-10-25）**: `python scripts/tests/drill_reimport_019.py` —— 起 **Vite(5180) + 真实 Electron(9224)**
  + **真实项目副本**（默认 `示例项目.sitian`，415 省 / 13 段剧本），两段判据**全读盘**：
  A 原样重导 `__real_desite.map` → 89 处并省冲突被拒、磁盘 sha256 一字节不变；
  B id 直配（403 省）→ 新底图/旧底图归档/ownerKey 迁移落盘 → **一次 Ctrl+Z 磁盘回基线**。
  跑前备份并还原配置、删副本；⚠️ 也会开真实窗口（不要在别的人工任务进行时跑）。
  数据侧另有一条**只读**审计：`node scripts/audit-reimport-019.mjs`（415 省 × 真实 .map 的映射/归属/事件守恒，产物 `build/reimport-019/`）。
- **终验自测链（第 6 件，2026-10-24）**: `python scripts/tests/drill_final_acceptance.py` —— **副本制**
  （真实 415 省项目只读：跑前/跑后 sha256 一致；动作全在副本上）+ 三步齐（涂归属 / 拖时间轴 / 导切片 PNG）
  + 手感五件（一笔多格 / 吸管 / 多选批量 / 撤销重做 / 标签联动）+ 415 省数据不丢（逐省
  culture·coast·biome·kind·color + 顶点指纹 + **逐省**易主条数）+ 3 枚反向探针 + 读盘判据
  （落盘载荷原样写盘再从磁盘读回）+ 三张互不相同的无头截图；产物在 `build/final-acceptance/`
  （`report.md` + 三张截图 + 切片 PNG + `roundtrip.sitian`）。
  ⚠️ 它自己要 Vite(5180)+Edge(9222)，**不要与 `run_tests.py` 同时跑**。真实 Electron 的磁盘链路
  （退出落盘 / 强杀）仍由 `drill_quit_flush.py` 守，两者不重复。
- 保存链真机诊断: `python scripts/tests/diag_t2_save.py`（dev 模式起真实 Electron，可读 `projectStore` 的
  `dirty/saveStatus/lastError`；用**工作副本**打开项目 → 真实项目只读、跑前备份跑后还原配置）
- **快照回滚深度实测（D01 验收，2026-11-15）**: `node scripts/tests/tools/probe_snapshot_depth.mjs`
  —— **只读**真实项目（跑前跑后 sha256 比对），量"改一条河 / 改一个省 / 涂一笔归属 / 整表重算地形"
  各能退几步，并**逐份 restore 核对内容**（不是只数个数）；产物 `build/snapshot-depth/{result.json,summary.md}`。
  读数（415 省 / 7.87 MB）：6 MB 上限下 **50 / 50 / 50 / 14 步**（补丁 10 KB / 11 KB / 367 B / 394 KB），
  3 MB 上限下整表重算只剩 **3 步** —— 那份"改一次就只剩 4 步"的传闻出自这里。
  守门 `scripts/tests/unit/test_snapshot_depth.js`（8 条，含"上限压到 1 字节只留最新 1 份""去掉 id 退回整表替换"两条负向探针）。
- **房间材质 / 吊顶真机演练（A23/A15，2026-11-15）**: `python scripts/tests/drill_room_materials.py`
  —— Vite(5180) + Edge(9333)。2D 用 `canvas.toDataURL`（每次拍前**切层再切回**强制重建）；
  3D 用整页截图，但拍之前要**调组件自己的 `tick()` 踢一帧** —— headless 下 `startLoop()` 里的 raf
  会挂住不触发，`rebuild()` 明明换了场景、两张截图却 **0 像素差**（看起来像"材质没接进 3D"）。
  判据 20 条：2D 材质占 48.74% / 同设置复拍 0 px / 吊顶注记 3699 px / 3D 瓷砖 vs 纯色 8.89% /
  只改一间 8.83% / 吊顶 28.75% / 统计条 / store 回读 / 一次 undo / 零报错。产物 `build/room-materials/`。
- **N1 像素基线（渲染层接口化的判据）**: `python scripts/tests/drill_scenario_pixels.py --tag before` 留底、
  `--tag after` 再拍一次、`--compare before after` 比 —— 起 Vite(5180)+Edge(9222)，用**自带底图（3 省）**固定取景，
  落 `build/pixel-baseline/<tag>.json`（整图 FNV-1a + **关标注**后的几何层指纹 + camera）与同名 PNG。
  非 0 退出 = 逐像素判据没过。⚠️ 不要与 `run_tests.py` / 其它要 5180/9222 的演练同时跑
  - **当前基线 = `v20261108l`**（2026-11-08 立，`hash 9910bd4` / `hashNoLabels 80b07d44` /
    **`riverHash 7be13ef5`**）。变化来自**渲染批处理**（只为性能，不改观感，量的证据见下）：
    省界第一遍合成一条 `Path2D` 一次描（3000 省 3000 次 `stroke` → 1 次）、导入河按**精确线宽**分桶描。
    两张帧的实测差：主帧 **83 px / 480,600（0.017%）**、最大通道差 **21**、差异只落在共边描边的
    抗锯齿覆盖上（热图 `build/pixel-baseline/diff-v20261108k-v20261108l.png`）；河层帧 5.0 万 px 有差
    但**最大通道差 6 / p99 = 1 / 平均 0.048**（合并路径后重叠边缘少叠一次）——即"变淡一点点"，不是错位。
    量差工具：`<bundled python> scripts/tests/tools/diff_pixel_baseline.py <a.png> <b.png>`
    （Pillow 读 IHDR，不手写 `reshape` —— 上一版的假数字就是这么来的）。
  - `v20261108k`（`hash 372350fc` / `4cc0feb0` / **`riverHash b7c599ef`** / riverCamera scale 3.5）**作废**
    （`l` 的批处理改了共边抗锯齿）。它那轮做的事仍然有效：**视口块默认开**（`scenario/viewBake.js`）——
    相机静止 260ms 且无手势时，只为**可见世界矩形**烘一块（≤1024px），叠在整幅底图上补清晰度。
    适屏档按“每世界单位像素数”判据跳过（所以主帧与前两版逐像素一致），只有河层帧（3.5×）被更清晰的块覆盖。
    开/关两块的真机对比：逐像素平均通道差 **4**、8×8 块平均 **1.5** = 只是变锐，不是偏色/错位
    （左糊右锐：`build/regen-terrain/patch-ab.png`）。
  - `v20261108j`（`hash 372350fc` / `4cc0feb0` / `riverHash b107ace5`）**作废**（河层帧变清晰了）。
    它那轮做的事仍然有效：整幅底图宽度上限 1,536（视口块关时才回到 1,536，开着时是 1,152）。
  - 🔴 **一条工具纪律（2026-11-08 踩到并修）**：对比截图必须按 PNG 的 IHDR 取 `colorType`
    （CDP 截图是 **2 = RGB 3 字节/像素**，`canvas.toDataURL` 是 6 = RGBA 4 字节）。
    按 RGBA 硬解 RGB 图会得到**满屏噪点**，据此算出的“差 21 万像素 / 平均通道差 206”是**假的**；
    正确解码后真实值是“平均 4 / 块平均 1.5”。**以后写像素对比脚本先读 colorType**。
  - `v20261108i`（`hash 372350fc` / `4cc0feb0` / `riverHash 51c89973`）**作废**（河层帧背景变了）。
    它立的时候做的事仍然有效：**烘焙宽度按缩放定**（`需要宽度 = 世界宽 × 缩放 × 1.15`，
    512…4096 → 后收口成 512…1,536），修掉了“固定 4096 让每张图白背 14 秒满载”（用户听到风扇）。
  - **风扇那件事的结论**（2026-11-08 用户：“我风扇转很快……点进来看你都在 bake”）：根因是**烘焙策略**，
    不是架构 —— 固定 4096 = 9.9 百万像素 ≈ 7 秒单核满载/张、一次开图烘两张。现在适屏档 1152 宽、
    最长主线程阻塞 753ms（此前 14,755ms）。**还欠**：放大档的视口块（`viewBake.js` 机制已写、
    默认未接 —— 接上之后主帧整张都变了 27 万像素，成因没拆干净就先不默认开）。
  - `v20261108h`（`hash 4d95ee60` / `2cc687fd` / `riverHash 5b1c4d70`）**作废**：底档固定 4096 宽那版
    （代价太大）。它那轮做的事仍然有效：**分块烘焙**（先 1/10 粗档铺底 + 24ms/片精修 +
    `canvas.__sitianBake` / `window.__SITIAN_BAKE_LOG__` 排障口）。
  - `v20261108g`（`hash a2295d1d` / `ff6f62e4` / `riverHash b9f4949c`）**作废**（烘焙分辨率变了）。
    它立的时候做的事仍然有效：**气候模型 v2** —— 降水补纬度干旱轴（副热带沙漠带 ≈27° / 赤道雨林带 /
    极地偏干），温度换成现实纬向年均值表（赤道 26.5℃ → 90° −25℃），群系规则让 `glacier` /
    `temperate_rainforest` 真的可达（旧规则里这两档**永远不会被返回**）。
  - `v20261108a`（`hash a93511e8` / `7bc1d601` / `riverHash a8887c30`）**作废**（气候改了颜色）。
    它立的时候做的事仍然有效：那次是**画布高了一像素**（壳层顶栏加字 + “更多”浮层，
    画布 444 → 445、`fitToView` 1.1375 → 1.1406），内容层两拍一致（`v20261108b` 不带焊接缓存 / `v20261108a` 带）。
  - `v20261105f`（2026-11-05，`hash f60036f4` / `hashNoLabels 443de52c` / `riverHash 71434f74`）
    **作废**（画布高度变了）；它立的时候做的事仍然有效：
    新增一枚**河层指纹** —— 以前 fixture 铺底时把 `baseMaps[key].rivers` 换成了两条手画河，
    生成河从来不在像素基线里，于是河线几何/河宽改了多少轮都“逐像素一致”：不是没坏，是**判据看不见河**。
    现在每拍一次会再生成一次地形（河一起落库）、关掉河以外的层、相机钉在最长那条河上（3.5×）；
    拍前做负向探针（最宽 20 条河压细 40% → 指纹必须变），并断言 `river_gen_*` > 20 条。
    `--no-river-frame` 可关河层帧；两次连拍逐字节一致。
  - `v20261104e`（2026-11-04 21:41）：**浮雕海岸不再跨海陆混色** —— 按插值高度在
    `RASTER_SEA_LEVEL` 处把海/陆分开取色，海侧只吃海深场、陆侧只在陆格上归一化双线性；
    最低陆色带再暖一档 `rgb(148,137,112)` → `rgb(176,158,122)`（`hash f60036f4` / 颜色数 4,096）。
    更早 `v20261104d`（`hash 6a4d1aad` / `hashNoLabels 8447d6cb`，河网汇流焊接 + 端点半切样条）。
    再上一版 `v20261104c`：地形浮雕底修整 —— **山体阴影 1.25→0.85**、
    明暗区间 0.80~1.03 → **0.90~1.02**、最低陆色带从灰橄榄 `rgb(92,98,82)` 换成暖砂 `rgb(148,137,112)`；
    用户点名“地图上这些奇怪的阴影，尤其是海岸边界”，二分证据：`build/regen-terrain/coast-on-zoom.png`
    与 `coast-off-zoom.png`（同一机位关掉 `window.__SITIAN_SCENARIO_RELIEF__`）。
    `hash a6beab4c` / `hashNoLabels c1581028`）。
    上一版 `v20261104b`（`hash 69398d98`，生成即出地形注记）、`v20261105b`（`hash 7306f2b4`，
    默认地形 = 分级河网 + 260 丘陵、丘陵盆比例 0.16→0.10）、`v20261105a`（`hash 79af1fe0`）、
    `v20261104a`（`hash 9800b3e0`）已作废。
    改动观感后**必须重立**，并在这里写新 tag —— 旧基线一比就是"到处都变了"。
    `v20261103a|b|c|d|e|f|g` 已作废。
  - 基线覆盖：地形浮雕底（`relief` 专用色带）/ 政治水洗 / 海岸带 / 国界 / 航道 / 文字层（fixture 在铺完省之后调
    `synthesizeBaseMapTerrain(KEY,{seed:7})` 生成高度图，并有判据守着"确实有高度图"）。
    浮雕的开/关两帧另有 `scripts/tests/drill_scenario_relief.py` 单独守。
  - **`--raster <landsea|height|temp|prec>`（2026-11-03 第 6 刀）**：拍到哪一层网格数据。
    默认 `landsea`（政治档）—— 这之前的**所有**地形观感讨论都建立在政治档截图上，等于没有地形判据。
    地形层的参考帧：`build/pixel-baseline/terrain-on.png`（`--raster height`，含等高线，`hash afe60c81`）
    与对照帧 `terrain-off.png`（等高线关，`hash b26fa4b8`）。改地形观感必须重拍这两张并并排看。
- **浮层直判（外交表等）**: `python scripts/tests/drill_diplomacy_overlay.py` —— 整页加载（不是 HMR）后
  点「更多 → 外交」与势力色板那条捷径，断言 `[data-testid=diplomacy-panel]` **真的在 DOM 里**、
  **收起「更多」后仍在**、关掉后零节点；顺带复测 `Teleport` 落点（`body > [data-testid=fmg-wrap]`）。
  截图走 `Page.captureScreenshot`（DOM 浮层只有它能拍），落 `build/diplomacy-overlay/open.png`。
  ⚠️ 这类断言必须查 **DOM**，不能查状态：2026-11-03 的 bug 正是 `open:true / panel:false`
  （浮层被写在 `.toolbar-more`（`v-if=moreOpen`）里，下拉一关整个子树就不存在）。
- **外交关系可写的端到端判据（A1，2026-11-05）**: `npm run test:diplomacy-write`
  （`drill_diplomacy_write.py`）—— 真机 + 项目**副本**（默认仓内示例 `sample/示例世界.sitian`，
  源文件只读：跑前后 sha256 一致；隔离 profile、CDP 9228），全走产品入口：
  面板里填甲 / 乙 / 类型 / 起止 → 点“记下这条” → ① 面板当场变同盟 ② **读磁盘**核对
  `scenarios.<id>.timelineEvents` ③ 真按 Ctrl+Z → ④ **内存与磁盘都退回基线**。
  另带反向探针（起止颠倒必须整条拒绝、事件表一条都不许多）与“栈顶就是这条录入”的前置断言。
  产物 `build/diplomacy-write/<ts>/{result.json,summary.md}`。
  ⚠️ 两个真机坑：① 色板行的外交入口只在 `viewMode==='scenario' && selectedScenario` 时渲染，
  卡片进来没选中剧本时它不在 DOM —— 脚本回落“更多 → 外交”，不是缺陷；
  ② **CDP 的按键事件需要前台页**：窗口没被 OS 聚焦时 `Input.dispatchKeyEvent` 一条都到不了渲染进程
  （页面里挂的 keydown 探针收到 0 条），读起来像“撤销没生效”。按之前先点一下面板标题区（给窗口焦点）
  并 `Page.bringToFront`；另注意**程序化 `.click()` 不移动焦点**，而 App 的全局 Ctrl+Z 在
  INPUT/TEXTAREA 上**故意让路** —— 两件都要处理（本脚本留了页面内 KeyboardEvent 兜底，
  并在汇总里写明走的是哪条路）。
- **标记 / 剧本 ↔ 资料笔记绑定（B1，2026-11-05）**: `npm run test:note-binding`（`drill_note_binding.py`）——
  真机 + 项目**副本** + **资料库副本**（`vault-fixture-messy` 复制到 build 里建索引；仓内 fixture
  跑前后**同指纹**；隔离 profile、CDP 9229，配置里 `vaultPath` 指向副本）。
  判据：面板“资料”段按标记名搜到笔记 → 点“绑定” → 标记 `notePath` + 面板“已绑定” + **读盘核对** →
  真按 Ctrl+Z → **内存与磁盘一起回**；反向探针（绑一个不存在的路径 → 面板必须“找不到了”，
  绑回真笔记 → 提示消失；非字符串的 notePath 整条拒绝）；剧本侧 `setScenarioNotePath` 同形状。
  ⚠️ 判“这篇还在不在”要用 **全库索引路径**（新 IPC `vault-index-paths`），**不能**用
  `listVaultNotes()` —— 那个只列“扫描范围内的地图笔记”，会把绑得好好的资料笔记误报成“找不到了”
  （真机第一跑就是这么红的）。
  ⚠️ **标记的撤销以前不落盘**：`put()` / `spliceBack`（undo/redo 共用的落点）里没排保存，
  改了标记再 Ctrl+Z、关掉重开又回来 —— 这轮把调度收口进那两个写入函数（与事件表同一个坑）。
- **演变过渡（A2，2026-11-05）**: `npm run test:era-smooth`（`drill_era_smooth.py`）——
  Vite(5180) + Edge headless(9222) + **两代自建剧本**（时代 I 全归甲国红 → 时代 II 全归乙国蓝，
  两代显式不同 `lineage`，所以**整代全部省**都是变化省）。页面内 rAF 采样器每帧读**同一个省中心**
  的画布像素 + `window.__SITIAN_ERA_FADE__`，采样 180ms 后把 `tlDate` 推到 2016 触发换代，采满 1.9s
  一次性取回。判据：① 过渡期采到**中间色**（逐通道落在两端之间）② 末样本 = 新主色（过渡会结束）
  ③ **负向探针**：`__SITIAN_ERA_FADE_MS__ = 0` 同一套动作**一个中间色都没有**（硬跳）
  ④ 过渡进行中 `makeLayerView({ snapshot: true })` 取到的已是新主色（**导出永不带过渡**）。
  产物 `build/era-smooth/<ts>/{result.json,summary.md,mid.png}`。实测 17/17；过渡期 61 条中间色样本。
  - 覆盖口：`window.__SITIAN_ERA_FADE_MS__`（默认 **320ms**，0 = 关、上限 3000；**每次换代现读**）。
    🔴 真机判据抓到的坑：把时长缓存成模块级常量后，页面里再改覆盖口要等重载才生效
    （drill 读到的 `dur` 一直是 320，读起来像"覆盖口没接上"）。
  - 实现：纯函数 `utils/eraTransition.js`（进度 smoothstep / 颜色混合 / 时长口径）；取色口
    `province.js#provinceColorAt(prov, eraIndex)` 按**指定代号**可查（上一代的颜色才算得出来），
    `getProvinceColor(prov, fade)` 在 `t∈(0,1)` 时混合、`t=1` 直接返回新色；
    `makeLayerView({ snapshot: true })` 把过渡钉死为 null（`exportPNG` 六处全走它）。
  - 静态帧**一个像素没变**：`drill_scenario_pixels --tag v20261105g` 与 `v20261105f` 完全一致
    （`hash f60036f4` / `hashNoLabels 443de52c` / `riverHash 71434f74`），基线不重立。
  - 边界（刻意）：过渡只影响**画布那一帧的颜色**，不改数据、不是"新势力"；过渡色只是两端插值，
    中间色不代表任何一方。年内逐日落定的单省变色的跳变不做过渡（播放一代 1300ms，那一下很小）。
- **跨剧本集“只读总览”（A3，2026-11-05）**: `python scripts/tests/run_tests.py test_164_group_overview`
  + `unit/test_scenario_group_overview.js`（11 条）—— 左栏剧本集那一行多了“看全部”：
  打开后按组分段列出**全部**剧本（当前组在前，显示年代与规模），当前组可点；
  **别组的剧本是只读的**（点它只给回执、不改选中目标），要编辑就点那一行的“切到这一组”（明确动作，
  不会悄悄换掉当前编辑目标）。组件 `ScenarioGroupOverview.vue` 自包含（模板/样式/逻辑，不占 ScenarioMap 行数）。
  - 口径单源：`utils/scenarioGroups.js#scenarioOverviewRows`（纯函数：当前组在前 / 空组不出现 /
    组内保持入参顺序 / 孤儿组不消失）+ `scenarioMetaText`（左栏与总览同一份摘要，原先只在 timeline.js 里）。
  - 真机判据（`test_164`，真点 DOM）：面板真在 DOM、两组两段、只有当前组标“当前”、
    点别组剧本**选中目标不变**且回执含“只读总览”、点“切到这一组”后 `activeGroupId` 真的变、
    关掉后总览**零节点**且当前组列表回来。
  - ⚠️ 两个坑：① 总览与当前组列表**必须二选一**（`v-else` 包裹）—— 否则同屏两个世界；
    ② 组件**不碰 store**，只 emit（`select` / `switch-group` / `msg`），只读分支里绝不能出现 `emit('select')`
    （单测 b1 守着，带负向探针）。
  - 顺带收口：`BIOME_COLORS` 从 `ScenarioMap` 与 `PlanetMap` 两份定义抽成 `utils/biomeColors.js`
    —— 两份已经漂移（行星那份漏了 `land`）。
- **撤销/重做也落盘（B2，2026-11-05）**: `python scripts/tests/run_tests.py test_165_undo_persist`
  + `unit/test_undo_persist_hook.js`（7 条）—— `store/undo.js` 加**统一落盘钩子**：
  `setHistoryPersistHook(fn)`（由 `geodata.js` 注册），`undo()/redo()` 成功后调
  `persistAfterHistory()` → `scheduleAutoSaveScenarios()`（剧本层 300ms）+ `scheduleAutoSave()`
  （画布层 800ms）。写口自己的保存**不删**（它们覆盖首次 execute）；钩子抛错**不影响撤销本身**
  （内存已回退，磁盘下一拍还会补）；两条链各自的“只读 / 自动保存关闭 / 手势闸门”照旧生效（钩子不绕过）。
  - 清点工具：`node scripts/tests/tools/audit-undo-persist.js` —— store 里 **162 处 `execute()`**、
    **137 处**闭包里没有安排保存（保存靠调用方在 execute 之后补一次，撤销时没人补）。
    所以修在**时序**上，不逐条打补丁（事件表 / 标记 / 019 重导都曾单独补过，还会再犯）。
  - 判据 `test_165_undo_persist`（mock IPC）：剧本元信息域 + 实体属性域，**撤销后出现新的保存调用**，
    重做同样；单测 7 条含“钩子抛错不影响撤销”“写闸门拒绝零副作用”两条负向探针。
  - 🔴 踩坑：第一跑把**写口自己那次保存的延迟**（300+800ms 链路）算到了撤销头上 → 假绿。
    用例里改成“先等改名那次保存落完，再取基线”，否则撤销前后是同一个 save 计数。
    实测链路：剧本域撤销 → 约 1.1s 落盘；画布域撤销 → 约 1.6s（800+800）。判据窗口取 2.6s。
  - 没做（刻意）：撤销**栈本身**不跨会话持久化（重开项目历史为空）—— 要序列化命令闭包，另一个命题。
  - ⚠️ `drill_quit_flush.py --phase p4` 当时在本机 dist 上红（点“历史剧本”页签后画布 30s 不挂载）
    —— **已在 `5521d37` 修**：点完页签要点第一张卡片才进编辑器；定位不到新建的小省时**显式跳过**
    拆分/删省并打印原因（生产构建读不到相机，别指望组件 setupState）。
- **底图重导的“待人工冲突”口径（B3，2026-11-05）**: `test_150_basemap_reimport`（扩了 f1b 逐条裁决）
  + `unit/test_reimport_conflicts.js`（10 条）—— 并省冲突（多个旧省并成一个新省）以前只能**整单放弃**
  （对话框上“有冲突，不能重导”），用户没有任何出路。现在每处冲突**逐条三选一**：
  归属取某一个旧省 / 合并（按旧省顺序，后者覆盖）/ 都不要（新省无主）。
  - 🔴 **默认仍然是拒绝**：`conflictChoices` 一条没选 → `unresolvedConflicts` 非空 → 零写入。
    “不替用户选”这条线不动，只是不再“不给用户选”（单测 c1 守着，带负向）。
  - 口径单源：`utils/basemapIdentity.js#unresolvedConflicts / applyConflictChoices / describeConflicts`
    （纯函数；单测守“入参 mapping 不许被改”“拆省的一对多映射一个字不许动”）。
  - 对话框搬成独立组件 `ReimportDialog.vue`（自包含样式，ScenarioMap 回到 **6,970 行**）：
    冲突行摆出**省名** + “这个旧省在各剧本里归谁” + 候选下拉；未映射清单也给人话（可展开全部）。
    组件只 emit（`apply`/`close`/`choose`/`toggle-reference`），不碰 store、不直接改 props。
  - ⚠️ 源码守卫教训：`lib/rsrc.py#render_src()` 只拼 ScenarioMap + layers + interaction + styles，
    **不含其它 components** —— 对话框搬成组件后 test_150 的守卫会“假红”（说没有对话框），
    用例里必须显式把组件文件拼进合集。
  - ⚠️ 真机 `drill_reimport_019.py` 本轮 **8/10**：A 段（冲突拒绝 + 磁盘一字节不变）全绿；
    B 段两条红是既有判据问题（把其它底图的剧本也算进“归属键”+ Ctrl+Z 靠 CDP 按键但窗口未聚焦），
    已建卡 `drill_reimport_019-两-a9be8e2f`，与本改动无关。**2026-11-05 晚已修并 11/11 全绿**（见上一条）。
- **行星/区域/建筑三层文字样式收口（A5，2026-11-05）**: `unit/test_map_text_unified.js`（5 条）——
  历史剧本层的六类文字早已收口到 `utils/mapTextStyles.js`，但那三层还各自硬编码 `'10px sans-serif'`
  （同一个软件两套字体口径：剧本层中文走雅黑/苹方，那三层退回浏览器默认 sans-serif，小字号下发虚）。
  现在三层统一走 `mapTextStyles.js#canvasFont(size, { bold, family })`：**字号仍由各层自己给**
  （各层信息密度不同，不该强行同号），**字体族只有一份**（复用 `fontFamilyCss`）。
  - 改动：`planetDrawing.js` 18 处 → 0、`AreaMap.vue` 4 → 0、`InteriorView.vue` 1 → 0 的
    `px sans-serif` 字面量换成了 `canvasFont(N)` / `canvasFont(N, { bold: true })`；
    行星侧那处模板字符串也改成 `canvasFont(size, { bold: weight === 'bold' })`。
  - 判据：`canvasFont` 逐档输出精确（**加粗必须在前缀** —— `10px bold` 不是合法 CSS）、
    三层源码 **0 处**硬编码字体、三层都真的用到（import 了没用也算红）、剧本层 5 类默认值没丢。
  - 功能回归：`test_16`（行星渲染 / 拖拽 avg 8.0ms）、`test_36`（区域 6/6）、`test_37`（建筑 5/5）全过；
    **105 个 Node 单测全过**。
  - 没做（刻意）：三层**观感逐层对拍（截图基线）**没建 —— 这三个视图不在像素基线里；
    先把“一条样式入口 + 功能判据”做掉，截图基线留给以后（`drill_scenario_pixels` 目前只覆盖剧本视图）。
- **视觉/浮层演练套件（2026-11-03，一条命令跑完 5 步）**: `npm run test:visual`
  （= `python scripts/tests/drill_visual_suite.py`）。顺序跑：浮雕开/关 → 星域航道远景/近景 →
  六个浮层**在不在 DOM** → 六个浮层**看得清吗**（层级/遮挡/暗色对比度/逐张截图）→ 像素基线（拍 + 与
  `v20261105f` 对拍）。日志与汇总落 `build/visual-suite/<时间戳>/summary.md`；任一步非 0 → 整体非 0。
  `--list` 列步骤、`--only relief,pixels` 跑子集、`--no-compare` 只拍不比。⚠️ 独占 5180/9222。
- **真实项目截图（2026-11-04，一条命令）**: `python scripts/tests/tools/shot_real_project.py --zoom 6 --focus longest`
  —— Vite(5180)+Edge headless(9222)+mock IPC，`projectStore.openProject()` 与 Electron **同一个** adopt 路径；
  **只读**（不写项目文件），产物 `build/regen-terrain/<tag>.png` 与 `<tag>-zoom.png`（按 `--focus longest|center|x,y`
  居中放大），并打印各阶段耗时 / 页面错误 / 心跳空洞。实测真实 415 省项目（7.6MB / 16,984 格 / 573 河）：
  adopt 215–364ms、进剧本→画布 <1s、最长一帧 964ms、console 错误 0。
  - **排障口（2026-11-04 第十九修，专治“截图和几何对不上”）**：`--dump-rivers` 把**本帧真正要描的折线**
    导出成 `<tag>-drawn.json`；`--set key=value` 直接改 setupState 做二分；`--probe-capture` 在**同一页面里**
    做“画布指纹 × 截图哈希”四态对照（base → 关河流 → 抽掉河数据 → 放回），画布变而 PNG 不变才叫“截图旧了”；
    `--probe-cross` 用渲染器自己的 camera 把**页内算出的真横穿**画成红圈再截图。
    配套 `window.__SITIAN_FRAME_LOG__`（最近 120 帧：帧号 / 耗时 / 是否贴基帧 / 相机 / 河流几何版本 `riverVer`）。
    ⚠️ `--set` 里写 **ref**（如 `showRivers`），别写 computed（`showRiverBase` 赋值抛 readonly，看着像“改了没生效”）。
  🔴 写这类脚本的三条纪律（2026-11-04 连踩三次，最后被误判成“渲染器崩溃”）：① 往页面塞大载荷时表达式
  **只回标量** —— `window.x += 块` 的返回值是累积整串，`returnByValue` 会一路回传 300KB→8MB，注入 8MB 项目
  从 0.2s 变 28s，看着像卡死；② 大动作**先发起、再轮询一句短话**，别把大 adopt 包进 `awaitPromise`
  （15s WS 超时会被读成“挂了”）；③ **stdout/stderr 分开落盘**（`1>out.log 2>err.log`）：PowerShell 的
  `Tee-Object` 只收 stdout，Python traceback 在 stderr，只看日志会把异常退出读成“静默死亡”。
- **规模帧时间探针（2026-11-08 晚，性能账的唯一入口）**: `python scripts/tests/tools/probe_scale_frames.py
  --project build/eu4-scale/bench-p3000-g512.sitian --key sample_land --profile --profile-open`
  —— Vite(5180)+Edge headless(9222)+mock IPC，**只读**。它量四段并给**逐层明细**：
  ① `openProject` 落地毫秒（adopt）② 点「历史剧本」→ 画布出现（用户感知的“开图”）③ 暖帧 / 平移帧 /
  放大帧各 8–12 拍的中位+最大 ④ `--profile` 的 CPU 自耗时、`--profile-open` 的开图段采样。
  默认走**产品口径**（分块烘焙 + 视口块开）；`--sync-bake` / `--no-view-patch` 只用来量最坏情况。
  压测项目生成：`node scripts/tests/tools/make_bench_project.mjs --provinces 3000 --grid 512`
  → `build/eu4-scale/bench-p3000-g512.sitian`（3000 省 / 15.4 万格 / 656 河）。
  **2026-11-08 晚的读数（本机，1080×634）**：
  | 场景 | 修之前 | 修之后 |
  |---|---|---|
  | 3000 省 开图（点页签→画布） | 5.4s | **2.4s** |
  | 3000 省 暖帧 | 285ms | **14ms** |
  | 3000 省 平移帧 | 291ms | **25ms** |
  | 3000 省 放大一档 | 2817ms | **23ms** |
  | 415 省（真实项目副本）开图 | ~1.4s | **0.8s** |
  | 415 省 暖帧 | — | **14.6ms** |
  🔴 **2026-11-16 扩容复核（用户：“5000 起步，几万省完全可能”）——3000 不是一个够用的上限**：
  `make_bench_project.mjs --provinces N --grid G` 造 1 万/2 万省，同一探针实测（1080×634）：

  | 省份数 | 项目 | 开图 | 暖帧 | 平移 | 最长主线程空洞 |
  |---|---|---|---|---|---|
  | 3,000 | 10.7 MB | 4.1s | 24.1ms | 29.7ms | 3.4s |
  | 10,000 | 26.4 MB | 9.3s | 292ms | 326ms | 8.6s |
  | 20,000 | 48.5 MB | ~15s（开图段 CPU 采样 14.8s） | 646ms | 618ms | 10.3s |

  归因（2 万省，15 帧 6472ms）：restore 34.3% + save 13.6% + stroke 13.1% + isDirty 8.7%，
  `fill` 只 4.6% —— **61% 是“每省两对 save/restore 加一次同色描边”的固定开销**，不是画了多少像素。
  开图段（`--profile-open`）：`createReactiveObject` 964ms（Vue 给 80 万个顶点建代理）、
  等深线 701ms、GC 559ms、海深场 555ms、浮雕烘焙 497+315+260ms、河流 483ms。
  🔴 **已落地（`aaa04fd`）**：`drawProvincesLayer` 整层一对 save/restore + `px()`/`politicalWash` 提循环外
  + outline 档的 `changed.includes` 改 Set → JS 侧 CPU **-33%**、放大档 **291~295ms → 28~69ms**，
  **适屏档没动**（292 → 293~306ms，瓶颈是原生光栅化：1 万次 stroke ≈ 180ms/帧）。
  逐像素一致（`drill_scenario_pixels --tag p20261116c`：9910bd4 / 80b07d44 / 7be13ef5 三项与基线全等）。
  🔴 **试过并否决的写法**：同色描边按颜色合成 4 条 Path2D 一次描 —— 像素差 28px/最大 1，
  但 **stroke 45ms/帧 → 250ms/帧**（一条路径里 2500 个闭合子路径，Skia 描边贵约 5 倍）；
  整帧同样变慢：1 万省暖帧 **301.6 → 575.6ms**（两组读数：`frames/p10000-hoist.json` vs `p10000-batch.json`）。
  合批只对**一次性**几何（省界第一遍）有效，对每帧都要描的路径反而更贵；结论已写进 `provinces.js` 文件头。
  ➡️ 2 万省以上的解法是**换画法**（适屏档省色块位图化 + 视口剔除），卡在方寸：
  `task-20261116-001`（位图化/剔除）、`-002`（几何换平面数组 + 保存链）、`-003`（开图分段）、
  `-004`（缩略图烘旧口径）、`-005`（浮雕唯一同步段 + rasterCache 挂实例）。
  🔴 **四条归因（都靠采样，不靠猜）**：
  ① `worldWidthOf` 每帧遍历 15.4 万格算一个**永远不变**的世界宽度 —— 占整帧 21%（≈63ms），
     加上被它带出来的 Vue 响应式开销（`get` / `reactive` / `isDirty`）合计 ≈150ms/帧。
     修法 = 按高度图对象 `WeakMap` 记忆化（`scenario/rasterRefine.js`）。
  ② 浮雕整幅栅格的缓存键里带**当前缩放算出的烘焙宽度** → 适屏时重烘一张、放大跨档再重烘一张
     （实测 2.76s）。修法 = `scenario/reliefRasterSlot.js` 的「只长不缩」槽：手里那张够宽就复用，
     缩小时用大图 `drawImage` 缩下来；只有真需要更宽或高度图换对象才重烘。
  ③ 省界第一遍 / 导入河：**一个颜色一个线宽**却逐省逐块 `stroke`（数千次原生调用，`stroke` 占 32%）。
     修法 = `Path2D.addPath` 合成后一次描（河还按精确线宽分桶）。
  ④ **上一条卡的“每帧重建 3000 条 Path2D（6.4ms）”是误判**：`provincePathFor` 的引用比较一直在命中，
     那 6.4ms 就是 3000 次 `fill`+`stroke` 的原生开销。修完 ① 之后它只剩 3.5–6.5ms，
     所以“省色块走位图”这件事的收益远小于它的复杂度 —— **先修量错的尺子，再谈架构**。
  ⚠️ 探针的两个口径坑：`Page.captureScreenshot` 与 `canvas.toDataURL` 的 PNG `colorType` 不同
  （2 = RGB / 6 = RGBA，见上一条纪律）；`__SITIAN_RASTER_SYNC__ = true` 会把“先粗后精”变成同步烘，
  读数会看到放大器级的假冻结 —— 报数前先确认口径。
- **六个浮层的视觉直判**: `npm run test:overlays`（`drill_scenario_overlays_visual.py`）—— 每块面板 9 条：
  包装节点**恰好 1 个**（重复 = 两块面板精确重叠，2026-11-03 真实踩到）、可见面积、完整在视口内、
  `elementFromPoint(面板中心)` 没被盖、背景不透明、正文对比度 ≥4.5:1（暗色）、不整块挡死画布、
  关掉后零节点、关掉后画布可再命中；每块面板留一张整页截图 `build/overlays-visual/<panel>.png`。
- **一笔“涂归属”的端到端时延（A4，2026-11-05 收口）**: `npm run test:owner-latency`
  （`drill_owner_latency.py`）—— **真实 Electron + 真实 415 省项目的工作副本**（原项目只读：跑前后
  sha256 一致），量四段：松手同步段（口径 ≤50ms）/ 交给项目 / 松手→磁盘（含 800ms 自动保存防抖）/
  显式 flush→磁盘；并从**磁盘**核对归属、`changeEvents`、一笔一组的 `groupId`。
  产物 `build/owner-latency/<ts>/{result.json,summary.md,profile-*.json}`。
  - 读数（本机 / 8.2MB 真实项目）：松手同步段 **51.65ms → 3.25ms**；松手→下一帧 **80.95 → 58.95ms**。
  - 归因（`--profile` → `profile-stroke.json`，按“最后一笔松手 + 260ms”窗口聚合）：那 51ms **既不是**
    写口（`batchSetOwnership` 只占 3.3ms）**也不是**原生光栅化 —— 是 `buildTimeline` 整条重算：
    `buildLedger` 13.1ms + `groupMap` 11.6ms + `computeEraChanges` 7.1ms + 日期归一 4.9ms。
  - 两刀：① **去掉重复整图重绘** —— 归属一改 `scenarios` 换引用，`watch(sortedScenarios)` 会在同一帧
    pre-flush 重画一次，`pointer.js` 里那次 `render()` 是第二遍（与自由绘制 2026-10-24 同一个坑）；
    只有 noop / 失败 / 空笔才自己补一帧（笔刷预览圈画在主画布上，必须擦）。② **时间轴重算的纯函数缓存**：
    `groupMap` 按 `ownership` 引用、`normalizeScenarioDates` 按剧本对象缓存（写口一律换引用 → 12/13 段命中）。
  - 🔴 这枚判据要看**两段时间**：同步段变短可能只是“把重绘挪到微任务”（假绿）。所以 drill 另加
    ①「松手 → 下一帧」读数、②**画布中心像素真的变了**（第 ⑧ 条）—— 像素没变 = 重绘丢了，直接红。
  - ⚠️ `--profile` 期间**不判时间**：采样会改变读数（同机同项目 50ms → 53.85ms）。口径只在 `--no-profile` 下算。
  - 还剩的：58.95ms 的“到下一帧”全是一次整图重绘（timeline 重算已缓存，剩下是光栅化）——
    再往下要分层/脏区渲染（`buildLedger` 也可按代缓存，本轮没做）。
- **撤销/重做的端到端时延（C2，2026-11-05）**: `npm run test:undo-latency`（`drill_undo_latency.py`）——
  真机（Vite 5180 + 真实 Electron（隔离 profile、CDP 9227）+ **真实 415 省项目副本**，原项目只读），
  量四类撤销：涂归属一笔（账本组撤）/ 编辑省份（快照 + 整图重绘）/ 添加标记 / 连续撤销。
  口径：同步段（`undo` 回调）、**按键到下一帧**、撤销本身长任务、撤销后 300ms 自动保存、掉帧；
  另采 A1 与 D 两段 CPU 样本（`profile-*.json`，按"按键后 220ms"窗口聚合）。
  读数（本机 / 8.2MB 真实项目副本）：同步段 **0.9~4.7ms**（撤销命令本身一点都不慢）；到下一帧
  **39~107ms**（大头是整图重绘）；连续撤销的"每一步都出帧 + 单段 ≤200ms"**已设闸门**（见下一条：
  保存链分块化把它们从"1~3 秒主线程占满 / 5 步全零帧"压到"单段 ≤74ms / 5 步全出帧"）。
  产物 `build/undo-latency/<ts>/{result.json,summary.md,profile-*.json}`。
  ⚠️ 帧时刻**必须用回调里的 `performance.now()`**，不能用 rAF 的 vsync 参数 —— 后者会把 75ms 读成 8ms
  （主线程被占住时回调拿到的仍是原定的帧起点）；⚠️ CPU 采样窗口的坐标是 `performance.now()`，
  混用 `Date.now()` 会一条样本都留不下。
  ⚠️ 演练的两个环境坑：**窗口被别的窗口盖住时 rAF 会停**（Windows 遮挡检测 + 后台节流 → 整段"零帧"，
  历史读数好/坏交替就是这么来的；启动参数带 `--disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding --disable-background-timer-throttling
  --disable-features=CalculateNativeWinOcclusion`）；A 段"目标省"以**画布中心命中**的省为准
  （小省居中后会偏出中心点，旧判据一红一绿随机翻）。
- **保存链分块化（C2 余项，2026-11-05）**: `unit/test_save_chain_chunked.js`（11 条）+
  `python scripts/tests/tools/probe_save_chain.py`；细节（分段读数 / 四刀 / 两个真机坑）见
  [docs/plan/HANDOFF_20261105_SAVE_CHAIN.md](docs/plan/HANDOFF_20261105_SAVE_CHAIN.md)。
  一句话：连按撤销卡 1~3 秒的真因是**保存链上一串同步工作首尾相接 + 两份保存并行**（不是撤销命令，它 1~5ms）；
  现在保存**串行**、深拷/序列化**分块并让出一拍**（产物与 `toIpcJson(整份)` **逐字节相同**）、
  快照侧三处白干的活去掉（体积一份只量一次 / 顺序保存免重放 / 重字段先剔再拷）、另加 20s 看门狗。
  读数：连按 5 次撤销 **5/5 步都出帧**、单段长任务 **≤57ms**（以前 5/5 步零帧、305~953ms）。
  ⚠️ 改这条链必读：`MessageChannel` 必须 `onmessage` + 显式 `start()` —— 用 `addEventListener` 在这台
  Electron 里**收不到消息**，第一版因此把保存整个卡死（`saveProject` 永不返回、零字节落盘、无任何报错）；
  "改了没落盘"别靠时延读数判断，用 `probe_save_chain.py` 直接问 store。
- **示例星系的验收（自建临时世界，不碰 harness）**: `npm run test:sample-galaxy`（`drill_sample_galaxy.py`）
  —— 只读态断言 → 新建临时项目 + **用例自建世界** → 生成（4 星域 / 120 恒星 / 175 航道）→ 整页截图
  `build/sample-galaxy/generated.png` → 一次撤销精确回退 → **反面对照**：harness 基线项目从头到尾没被
  创建/保存（`__projects` / `__projectCalls` 双查）。
- 图标一致性校验: `python scripts/icon_check.py`（校验所有被引用的图标名在 `Icon.vue` 中有定义）
- 结构清单再生成: `python scripts/gen_architecture_map.py`（详见下节）

## 架构速查 (Quick Facts)

> 只放**慢变量**（几个月才变一次的事实）。历史条目在 `docs/agents-archive/`（见文末索引）。

- **七层视图链**（全部已实现）: world → domain → system → system_detail → planet → area → interior，对应组件 WorldSelector → GalaxyMap → SystemView → SystemDetailView → PlanetMap → AreaMap → InteriorView

- **store 结构**: `store/geodata.js` 是壳（defineStore + 装配），真实逻辑在 `store/geodataModules/` 9 个模块：mapDataEditing（最大）/ areaEditing / scenarioEditing / provinceEditing（省份归属标签网格）/ interior / search / spaceEditing / channelBrush（文化·宗教逐格通道笔刷）/ loreBinding（笔记↔节点稳定绑定，2026-11-02）

- **剧本集（2026-10-25）**: `scenario.group` + 项目级 `scenarios.groups`；一组 = 一条独立时间线，左栏/时间轴/播放/切片「全部剧本」都只取当前组；组判定/选项/计数单源 = `utils/scenarioGroups.js`（`test_146` / `unit/test_scenario_groups.js` 守）。删除组不删剧本，组内剧本退回默认组。
- **undo 纪律**: `store/undo.js` 的 `execute()` 内部立即调用 `command.redo()` 完成首次写入——数据修改必须放在 redo 回调内，禁止在 execute 之前手动改数据（会造成双写）

- **图标系统**: `src/renderer/src/components/Icon.vue`（152 个内联 SVG 图标）+ `src/renderer/src/utils/canvasIcon.js`（Canvas 矢量绘制适配），已替换全部 emoji（含 ScenarioMap 的 15 个地貌/标记预设：**预设里存图标名，不存 emoji 字面量**，双端各自渲染；旧数据里的 emoji 仍由 `drawIconOrEmoji` 的 fillText 兜底）；`python scripts/icon_check.py` 校验引用名均有定义

- **开发规则全集**: 60+ 条铁律与踩坑复盘（composable 接线、getState ref 解包、SFC 结构标签、发布验收等）在 Hermes skill `obsidian/sitian-development`，动代码前先加载；本文件不复制规则，防双源漂移

- **交互模式全集**: pan / move / draw / region / marker / route（含自动寻路=道路编辑器，Shift+J）/ settle / text / cluster / height / terrain / political / **relief（R）** / **river（Shift+R）** / **culture（Shift+C）** / **religion（Shift+G）**

- **文档权威顺序**: 代码 > `docs/ARCHITECTURE_MAP.md`（脚本生成部分）> 本文件 > `docs/guides/20261023/00-…`（指南包）> `docs/plan/SITIAN_GUIDE_DIGEST_20261023.md`（仓内对账）> 其余（历史，在 `docs/archive/`）

- **现行规划（2026-10-30 起：`docs/plan/PLAN_AUDIT_20261030.md` 是唯一施工依据）**：
  - **UI/UX 交接页（2026-11-05）**：[docs/plan/HANDOFF_20261105_UIUX.md](docs/plan/HANDOFF_20261105_UIUX.md)
    —— 用户四条硬要求 / 已完成六个提交 / 六张“可读性闸门”命令（含两张真机：行星 18/18、区域 10/10）/
    剩下的 74 个纯图标按钮与剧本 10 条 / 十个真机坑（浮层宽度、flex-basis、auto-fit、裁字、截图超时…）/ 下一步顺序。
    **动任何工具栏或面板按钮之前先读它。**
  - **现状一页纸 = [docs/plan/STATUS_20261103.md](docs/plan/STATUS_20261103.md)**（接手先读这个：
    能力 / 数字 / 性能口径 / 没做到的 / 下一轮三件）；**逐项怎么测 = [docs/plan/TEST_CHECKLIST_20261103.md](docs/plan/TEST_CHECKLIST_20261103.md)**。
  - **总入口** = [docs/plan/PLAN_AUDIT_20261030.md](docs/plan/PLAN_AUDIT_20261030.md)（阶段门 N0/N1/N2/N3/N4 + 判据 + 已拍板事项）；
    **接手先读** [docs/plan/BREAKPOINT_20261102.md](docs/plan/BREAKPOINT_20261102.md)（当前断点：**把在列的活全部做掉** ——
    星域边界所有权场 φ 软融合 / 航道稀疏化 / 恒星系轨道分级 + 日冕 / N3a-1 provenance / N3a-2 外交表 /
    N3a-3 读料桥稳定 ID / N3b-1 侵蚀层 / N3b-2 简易模式；没做到的也逐条写在那一页第三节）。
  - **本地参照图库 `refs/`（2026-11-01）**：动任何视觉之前先读 `refs/MANIFEST.md`。
    目录只有 `README.md` + `MANIFEST.md` 入库，**图片一律 gitignore**（用户截图/第三方画面，不入库）；
    新增参看图必须同时在清单里写「要抄的事实 + 吸收状态」，否则下一轮等于没喂过。
  - 参照件（不是施工令）：`docs/guides/20261023/00-…`（路线/红线）、`docs/plan/SITIAN_GUIDE_DIGEST_20261023.md`（仓内对账）、
    `docs/plan/CHASSIS_BASELINE_20261023.md`（性能基线）、`docs/plan/INTEGRATION_AUDIT_20261030.md`（模块集成审计）。
  - **已被取代的规划/交接件已全部移入 [`docs/archive/`](docs/archive/)**（TODO_REMAINING_20261028 / REMAINING_BACKLOG_20261027 /
    NEXT_STAGE_20261025 / 各 HANDOFF 等 14 份；只作证据，不再具备施工效力）。
  - 415 省孤本 `<用户目录>\Documents\SiTianProjects\示例项目.sitian`（6.5MB / 415 省 / 13 剧本）施工前后各留底一份
    （2026-10-23 已留：`…_施工留底\示例项目-20261023-203520.sitian`，SHA256 一致）。
  - 已完成的历史条目（3D 观景 / 阶段 0-1 欠账 / FMG 管线 / 保存链提速…）见 `docs/archive/TODO_REMAINING_20261028.md` 与
    本文件「文档权威顺序」以下各节。


### 当前红线（跨模块、动手之前必须知道）

- **无项目 = 只读**：一切落盘写必须过 `guardWrite()`；新增"直接改世界观数据"的函数必须登记进
  `store/writeGate.js` 的 `MEMORY_WRITE_CALLSITES`（`test_47`/`test_54` 读源码反查）。
- **画布 → 项目只有一个写者**（`projectStore`）：`geodata` 只产出载荷、不碰磁盘、不 import projectStore
  （经 `store/canvasBridge.js` 通信，`test_46` 守）。
- **保存诚实**：`persisted === true` 才说「已保存到磁盘」；项目态只到 `staged`
  （`utils/saveStatusText.js` 是唯一实现）。
- **数据安全优先于手感**：退出 / 关项目 / 显式保存一律绕过自动保存的手势闸门（`utils/interactionGate.js` 口径①）。
- **不接入任何云端 AI（硬承诺，2026-11-07 拍板，推翻 2026-11-05 的“可选 AI”口径）**：
  `utils/disclaimer.js` 的 `LOCAL_ONLY_SUMMARY` 是**唯一口径**（默认不联网 / 无账号 / 无遥测 /
  只有“检查更新 + 自配 Git 同步”两处联网 / **不接入任何云端 AI**）。`AI_STANCE` 已删除，
  **不许再写“将来若提供可选 AI”/“显式开启”/“自带密钥”这类留回头路的话** —— 想加 AI 必须重新拍板 + 升条款版本。
  条款实质变更必须升 `DISCLAIMER_VERSION`（当前 **1.2.0 / 2026-11-07**，老 ack 才会失效）。
  守门：`unit/test_disclaimer_copy.js`（7 条 + 三条负向探针，**判据方向与 1.1.0 那一版相反**）。
  理由记在方寸卡：当初让路的唯一理由是“没 AI 想不出怎么提取设定”，而自动提取已被砍（2026-11-07）。
- **不许把结构变成填表门槛**（2026-11-07 用户提醒；读料 / 模板 / 分类类工作的红线）：
  模板、字段、类型**一律可选**，留空必须能用 —— 缺 `层级` 靠路径与文件名兜底，缺 `上层区域` 靠双链/路径推断，
  推断不出进“待人工”清单交人补；**不许弹窗逼填，不许“字段不全就不能保存 / 不能入树”**。
  新建条目允许“先有名字、后补字段”；读料（`vault-scan` / `vaultClassify`）的产物同样只是**候选**，
  确认权在人。理由：同类产品（World Anvil 的 Autolinker + to-do、Novelcrafter 的 Codex 提及识别）
  走的都是“先写，再连，缺口交给人”，不是“先填表再进世界”。
  **未写引用不算待人工**（2026-11-07 用户：“那个词条是我根本没空写，等我全写完要三年”）：
  frontmatter 指向库里还没有的条目时，按 **Obsidian 未解析链接**对待 —— 单列“未写引用”
  （`report.unwritten`，`geo` 行带 `parentUnwritten`），**不进 `needsHuman`、不弹窗、不挡任何操作**。
  待人工只放“机器判不了、要人给一句话”的（分类信号全无 / 坏 YAML），不混入“人还没写”。
  读料桥本来就会按索引文件造出世界节点（例：`粘土世界` 在 `01 索引/地理系统索引.md` 里，
  4 个星域挂在它下面），所以**结构不缺，缺的是内容**。
- **按钮必须有名字、文案必须说人话**（2026-11-05 用户拍板：“不要再让我看到一大堆乱七八糟的按钮和
  根本看不懂的文字”）：① 工具栏/面板里的按钮**不许只有图标**（只有 `title` 不算 —— 要悬停才知道，
  用户实测“找了五分钟没找到”）；② 用户可见文字里不许出现**工程内部术语**
  （`provenance` / `落库` / `单源` / `格距` / `回执` / `幂等` / `N3a` / `φ`），第三方产品名
  （Azgaar / FMG）只在**导入向导这类确实需要指路**的地方保留。守门：`unit/test_toolbar_ux.js`（剧本视图）、
  `unit/test_toolbar_ux_planet.js`（行星）、`unit/test_toolbar_ux_area.js`（区域）、
  `unit/test_toolbar_ux_panels.js`（面板类 **20 个**组件：对象列表 / 节点详情 / 地点簇 / 缩放 / 小地图 /
  设置 / 项目 / 建筑内部 / 派生 / FMG 模板 / 造陆 / 图层 / **剧本视图整页 + 七个拆出来的子视图**
  （含省份/标记属性面板），另含“行内操作不许退回悬停才出现”——口径是
  **任何 `*-row-actions`**，不许只写 `.row-actions`，那样 `.pp-row-actions` 同病却全绿；术语白名单
  `jargonAllow` 只给 FmgPanel 放 `FMG`/`Azgaar`、给 ScenarioMap 放 `Azgaar`（.map 导入指路），别顺手扩大）；
  **`ScenarioMap.vue` 的行数闸门 = ≤6,120**（`unit/test_scenario_map_split.js` m1；历史 8,554 → 6,625 → 6,611 → 6,301 → **6,106 行**，2026-11-07 工具栏九步拆分收口）：
  往里加东西之前先想“能不能放进 `scenario/panels/` 或 `scenario/{layers,interaction}`”；
  拆出去的浮层**样式跟着组件走**（m7 守着双源，唯一例外是 `.scenario-map-container.xxx ...` 这种
  容器级规则 —— 它靠父 scope id 命中子组件根节点，搬走反而失效）；
  **两个组件共用一套样式就写一份 `.css` 让两边 `<style scoped src>`**（省份/标记面板的 `props-panel.css`），
  别各抄一份；**跨组件抓 DOM 会静默拿到 null**（父组件的 `ref` 指向子组件里的 `<input>` 时），
  要用 `defineExpose({ focusName })` 让子组件自己负责；
  子视图统一放 `src/renderer/src/scenario/panels/`，`scripts/tests/lib/rsrc.py` 会把该目录并进
  “渲染层源码”，不并进去源码闸门会在搬家当天假红；**闸门跟着代码走但不许放宽**：
  组件里拿到的是 prop（`readOnly` / `baseMaps`）时，源码闸门除了认新写法，
  还要反查“父组件确实把 `store.isReadOnly` / `store.baseMaps` 传进来了”；
  真机两张：`tools/shot_planet_ux.py`（18/18，工具坞 + 对象面板「文字有没有被裁」）与
  `tools/shot_planet_ux.py --view area`（10/10，区域工具栏 + 截图）；
  **搬家后的视觉留影**：`drill_moved_panels_visual.py`（7 块面板逐一打开 + 按元素裁切截图）+
  `tools/diff_panel_shots.py`（搬前/搬后逐像素判 `identical / text-only / layout-shift`）——
  改 ScenarioMap 的浮层/面板时必须留这一组证据（scoped 样式搬家只在屏幕上现形）；
  **工具栏怎么拆已决断**：见 `docs/plan/DECISION_TOOLBAR_SPLIT_20261106.md`
  （按行拆 + 显式 props；**不用** `provide/inject`、**不把**状态搬进 store）；
  工具栏各行**共用** `scenario-map.css` 的 `.toolbar-row/.tool-group`，`m7` 的"老 class 不许留在主表"
  不适用于它们 —— 别再给工具栏行抄一份 CSS；改其它视图时照此扩一张「每个按钮都有文字」的判据。
  **2026-11-07 九步已全部落地**：`scenario/panels/toolbar/` 下 15 个行组件 + `settings/` 下 14 个设置组，
  每步都留了“搬前/搬后真机 computedStyle 对拍 0 差异”的读数（累计 12 档 / 250 条）。
  🔴 **但共用样式必须写成 `:deep(类)`**（2026-11-07 真机抓到）：`<style scoped>` 的父 scope id
  **只贴在子组件根节点上**，行拆进 `scenario/panels/toolbar/*.vue` 后，根**里面**的
  `<button>`/`<label>`/`.tool-group` 一条父表规则都拿不到 —— 试点那 3 个按钮当场退回浏览器默认样式
  （h=23px / Arial / 白底），而源码闸门与浮层视觉演练**全都看不见**。两条硬规矩：
  ① 写 `:deep(类)`（编译成 `[data-v-父] 类`，与原 `.类[data-v-父]` 等权重）；
  ② **`:deep()` 前不加 `.scenario-toolbar` 之类的前缀**（多一个 class 会改变优先关系，
     实测把 `.back-btn` 的 padding 顶掉了；唯一例外是 `.scenario-toolbar :deep(button)`，不加限定会命中整个视图）。
  守门 = `unit/test_scenario_map_split.js` 的 m8/m8b（负向探针验过）；
  **动工具栏 CSS 一律先跑 `tools/probe_toolbar_row_styles.py` 留底、改完 `--compare` 对拍**
  （84 个按钮的 computedStyle + 尺寸，别靠"看起来一样"）。
- **改观感就得让人看得见**（2026-11-08 用户：“所以你的截图呢？我这边一张图都看不到”）：
  像素基线 / 侵蚀 / 河流 / 地形 / 工具栏这类**图形**改动，收工回复必须**把对照图嵌进消息**
  （`![说明](<build/xxx.png>)`）+ 一句“这张图里该看什么”；落盘的图放 `build/<主题>/`（已 gitignore）。
  **只报 hash、只列文件路径 = 没给证据** —— hash 证明的是“没变”，证明不了“变好了”；
  对照图要**并排/上下**放，单张“好看的新图”看不出改了什么。看图之后要写下“图里我确认了什么、
  没确认什么”（例：侵蚀那张图能看到河更长，但看不到平行条纹变好 —— 与扇状度 0.893→0.899 一致）。
- **画布算出来的派生字段只许单向**（2026-11-16，A21 建筑占地 `footprint`）：由画布算出的字段
  （占地 / 坐标）以**画布为准**；项目实体里那份只是保存时刻的快照，`entityNodeFields` /
  `refreshEntitiesFromProject` **不许把它写回画布**（`watch(entities)` 是 `flush:'sync'`，
  一次在途保存就能把刚撤销的值改回去 —— 真机实测：撤销瞬间字段 924、0.9s 后变回 1224，
  而墙已经回到 924，界面靠 `readFootprint` 兜底才没显示错数）。派生字段若要带缓存，
  必须同时有**指纹**（几何算出来的 stamp）+ **唯一刷新点** + **读侧现算兜底**，三条缺一条就会陈旧。
- **同一能力只许一份实现**（画河几何、河宽换算、导出参考图、保存文案、`.map` 导入…）：
  两份实现不会报错，只会"改一处另两处不变"。
- **方寸：过程与结论写任务卡，不写执行日志**（2026-11-04 用户拍板）：`create_log` 的条目是**用户自己调度**用的，
  agent 写进去会把工作台搅乱（原话：“分不清哪个派了哪个做完了”）。做完事的留痕 = `update_task` 补正文 + `move_status`；
  新问题 = `create_task`。日志默认**只读**（除非用户明确要求）。
- **问之前先查档**（2026-11-04 用户拍板）：任何“要不要做 X / 选哪一档”的问题，先 `grep` 决策档
  （[docs/plan/DECISIONS_20261104.md](docs/plan/DECISIONS_20261104.md)、`LICENSE`、`README.md`、本文件）与代码，
  **已有拍板的不许再问**（2026-11-04 我把“免费开源”和“没有示例世界”两条写错，LICENSE 与 `sampleData.js` 都在仓里）。
  问卷/裁决题里的【现状】必须带一条本仓证据（grep 结果或文件路径）贴在题上。
- **直角引号 `「」` 不是中文标点**（2026-11-02 用户拍板）：界面文案、回执、注释都不许拿它当引用/强调，
  该用中文双引号 `“ ”` 与单引号 `‘ ’`（代码里的英文引号除外）。**新写的代码/文案一律不许再用**。
  **2026-11-03 已清完 product + 用例 + docs 非归档区**：`src/` + `scripts/` 共 **10,269 处 / 498 文件**、
  `docs/`（除归档）**864 处 / 21 文件**；`node scripts/quote-audit.mjs` 的「界面 0 / 代码 0」。
  清理器 `node scripts/fix-quote-marks.mjs`（默认 dry-run，`--apply` 才写，
  `--scope src|tests|docs-live|docs`，正则字面量行自动跳过交人工）。
  **红线有守门**：`unit/test_quote_marks.js` 直接跑 audit 并断言 0/0（负向探针验过：塞一个就红）。
  只剩 **docs 归档 1,559 处**（`agents-archive` 写着"原文一字未改"，按历史证据保留；要清用
  `--scope docs`，会一起改掉"未改"的承诺，先想清楚）。
- **「涂归属」只改势力归属**（2026-10-20）：日常行的 `ownerBrush` = 给碰到的省改 `ownership`
  （一笔一条 undo），**绝不碰省界多边形**；改省界形状是「底图编辑 → 改省界」（`provinceBrush`）。
  两个同名按钮曾让用户以为在"生造省份"——不要再合并回去（`test_131` / `test_120` 守）。
- **两本账不双写**（2026-10-22）：`scenario.changeEvents` 只记「某省某日归谁」，
  `scenario.timelineEvents` 只记「谁和谁、什么事、起止」。查归属走 `initialOwnership + changeEvents`，
  查关系走 `utils/scenarioEventLedger.js`；**不许**把归属复制进事件表（或反过来）——
  两份真值迟早漂移，且归属回放会被无关事件拖慢（`test_132` / `unit/test_scenario_event_ledger.js` 守）。
- **读料必须只读**（2026-10-22）：扫知识库（`vaultIndex.buildIndex` / `vault-scan.mjs` / `vault-classify-report`）一律 `write:false` / `writeCache:false`，**连 `.sitian` 都不碰**；要产物就写 `--out` 指定的库外目录。归类/推断只有一份实现（`scripts/lib/vaultClassify.js`），认不出就进「待人工」，不许默认成地点（`unit/test_vault_classify.js` 用库指纹快照守）。
- **库的目录习惯不许写进代码**（2026-11-08，用户原话：“这样永远只能我一个人用，不是通用的”）：
  “哪个目录算地名容器”是**每个库自己的习惯**，不许硬编码（上一版把 `02 场景地点` / `11 地理系统` /
  `杂项` / `移动设施` 写进代码，只有这台机器能用，已删）。规则是参数：
  `dirParentCandidate(path, { containerDirs, skipDirNames })`，**默认空 = 不猜**；给一次配置才生效
  （`config.json` 的 `geoContainerDirs` / `vault-scan --container`）；拿不到配置时只打印
  “建议当容器”的目录（`report.containerSuggestions`），**不许自动应用**。内置的只有语言层面的
  层级词（世界/星域/星系…）与占位名（待补充/未命名…）。
  守门：`unit/test_import_preflight.js` 第九条（不配置就不许猜）+ `test_124`（面板只填不保存）。
- **重新导入按 `sourcePath` 更新机器字段**（2026-11-08 用户选 A，**取代 2026-09-27 的 A-2**）：
  `mergeVaultPayload` 按源路径认亲 → 只更新 `layer` / `layerLabel` / `parentId` / `placeType` /
  `tags` / `wikilinks` / `status`；**保留** `name`（司天里改过的显示名）、`coordinate`、`uuid`、时间戳；
  载荷里没有的条目一个字段都不许动。别再按“机器属性一律以项目为准”改回去（`test_58` c3 段守着）。
- **对账 / 重连层（C2）保留，砍联动时不许连带删**（2026-11-08 裁决，依据
  [docs/plan/ANALYSIS_20261108_LORE_BRIDGE.md](docs/plan/ANALYSIS_20261108_LORE_BRIDGE.md) §九）：
  `utils/vaultRelink.js`（`detectBrokenLinks` / `scoreCandidate`）与
  `projectStore.scanBrokenLinks` / `relinkEntity` **留**。B/D 层（全库索引、内置阅读器、跳转、绑定 UI）
  将来要砍时，**它不是同一批东西** —— 搬家之后库一改名/一删笔记，只有它会把“项目里那条对不上库了”
  说出来；砍了它，“140 个实体搬进来”就变成“搬进来那天的快照，之后库怎么改司天都不知道”。
  守门：`unit/test_vault_relink.js` + `test_75_broken_link_relink`（改 tombstone / 候选打分别放宽）。
- **数据层两条判据：空值不落盘 + 没有完成态**（2026-11-08，报告 §3-2 / §3-3）：
  ① 实体落盘前过 `stripEmptyEntityValues()`（`utils/projectSchema.js`）—— `sourcePath: ''` /
  `parentId: null` / `tags: []` / 空坐标**不写进文件**；它只改磁盘形态，内存仍是完整形状，
  载入时 `validateProject` 把默认值补回来，所以读侧一行不用改。② 实体上**不许有**
  `complete` / `progress` / `missing` 这类完成度字段（“不许把结构变成填表门槛”的落地）。
  守门：`unit/test_entity_empty_values.js`（11 条，含“y=0 不是空值”与“塞 progress 必须红”两条探针）。
- **判湖要读降水，别只看几何**（2026-11-08）：`detectBasinLakes`（`utils/lakes.js`）只按面积/深度判湖，
  它不知道“水从哪来”—— 于是雨林里一个浅坑成湖、沙漠里一个更深的盆地反而不成湖。现在生成链在
  **气候刚算出来**的位置过一遍 `classifyLakesByClimate(lakes, prec)`（同一份 `lakes.js`）：
  降水 ≥ `minPrec`（默认 40 / FMG 0…100 标尺）→ 淡水湖**原样不动**（连字段都不加）；
  更干 → 面积门槛按缺水量放大（`minArea × minPrec/meanPrec`，封顶 `salineAreaFactor`），
  过不了门槛就丢掉，过了就标 `saline: true`，渲染层用咸青色 `SALT_LAKE_COLOR`
  （`ctx.salineLakes` 只在读地形的档上叠）。**只降级、不新建**；拿不到 `prec` 时行为一字不变。
  ⚠️ 默认值故意落在“常规地形什么都不改”的位置（暖和的地方降水恒 ≥60，只有寒冷内陆/高山湖区才低于 40
  —— 那正是现实里盐湖最密的地方），所以**不重立像素基线**；改 `LAKE_CLIMATE` 就要重拍。
  守门：`unit/test_lake_climate.js`（13 条，含“淡水湖同一个引用”“不给 prec 原样返回”“陆地格守恒”三条负向）。
- **不要整读大文件**：`ScenarioMap.vue`（**6,106 行**，2026-11-03 把 1,649 行样式搬到
  `scenario-map.css`，原来 8,554 行）/ `PlanetMap.vue`（4,559 行）是全仓最大的两个 SFC —— 先 `grep` 定位再读窗口
  （行数以 `docs/ARCHITECTURE_MAP.md` 为准；这条也是 token 成本的纪律）。
  `ScenarioMap` 的体量与浮层落点有闸门：`unit/test_scenario_map_split.js`（≤6,120 行 + 六个浮层各恰好一次 +
  模板 AST 祖先链里不许出现 `v-if="moreOpen"`，带负向探针）。

### 索引：历史条目去哪了

`AGENTS.md` 只留**慢变量 + 红线 + 索引**；每一轮的"改了什么 / 踩了什么坑 / 判据是什么"
按主题归档在 `docs/agents-archive/`（**原文未改**）。**需要细节时只读对应那一份**，不要通读全部：

| 主题 | 什么时候读它 | 文件 |
|---|---|---|
| 卡顿与性能 | 帧间隔 / 基帧缓存 / 空间索引 / 自动保存占住主线程 / 测量方法 | [perf-jank](docs/agents-archive/perf-jank.md)（3 条） |
| 河流与地形 | 河流画法与橡皮 / 河网路由 / 地形推演 / 高度图与笔刷 / 海岸线 / 地形注记与沿路径排字 / 缩放分层 / 汇流台阶 / 粗格图等深线 | [map-river-terrain](docs/agents-archive/map-river-terrain.md)（31 条） |
| 省份与顶点 | 省份绘制与布尔 / 顶点与共边 / 骨架吸附 / 框选与分割 / 省界观感 | [map-province](docs/agents-archive/map-province.md)（11 条） |
| 底图与导入导出 | .map 导入 / 参考图 / 标记与聚落 / 道路 / 导出 / 底图编辑模式 / 导出地形底图 | [map-basemap](docs/agents-archive/map-basemap.md)（8 条） |
| 项目文件与保存链 | 写闸门 / 快照 / 落盘与恢复 / 只读 / 备份 / 退出落盘 / git 同步 | [project-save](docs/agents-archive/project-save.md)（12 条） |
| 剧本与时间轴 | 剧本装载语义 / 时间切片 / 态势 / 卡片墙 / 标注与事件 | [scenario](docs/agents-archive/scenario.md)（12 条） |
| 视图层 | 星系·星域·行星·区域·室内 / 图层开关 / 拖拽与命中 / 画布单位与淡出 / **星系 3D 观景（three 动态加载）** | [views](docs/agents-archive/views.md)（8 条） |
| 知识库与数据 | 提取 / 迁移 / 坐标 / fixture 专名 / 笔记重连 / 实体 id | [vault-data](docs/agents-archive/vault-data.md)（10 条） |
| UI 与测试工具 | UI 基座 / 免责声明 / 图标与配色 / 测试纪律 / 演练 / 方寸联动 | [ui-tooling](docs/agents-archive/ui-tooling.md)（11 条） |
| 规划与决策 | 排期定案 / 批次收口 / 阶段性取舍（当时的判断，不是现状） | [misc](docs/agents-archive/misc.md)（2 条） |

> 归档是**历史**（"当时为什么这么做"）；当下口径以代码 + 回归用例为准（下面「锚点」就是为此）。
> 检索用 `grep -rn "<关键词>" docs/agents-archive/`，不要整读。

### 锚点（读文档后先核对 2-3 个，不符以代码为准）

| 锚点 | 期望值 | 核对方式 |
|---|---|---|
| 测试用例数 | 178 | `ls scripts/tests/cases/test_*.py \| wc -l` |
| Node 单测文件数 | 135 | `ls scripts/tests/unit/*.js \| wc -l` |
| store 模块数 | 9 | `ls src/renderer/src/store/geodataModules/` |
| App.vue 异步面板 | 25 | `grep -c defineAsyncComponent src/renderer/src/App.vue` |
| IPC handle 数 | 49 | `grep -c "ipcMain.handle" src/main/index.js` |
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

> 两套绘制风格独立维护：GalaxyMap 用 `galaxy/{sky,starArt,labels}.js`（2026-11-01 内化自 SP-1025 原型，**画布与「导出 PNG(全图)」共用同一份**，`test_117` 守）+ `utils/galaxyLayout.js`（布局/配色/航道的唯一实现）；SystemView / SystemDetailView 用 `composables/spaceBackground.js`；PlanetMap 用 `composables/planetDrawing.js`。禁止互相套用。

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
- **读源码的用例必须先归一化换行**：本仓 index 是 LF、工作树是 CRLF（git autocrlf），用 `'\n}\n'` 之类
  切片会**匹配不到 → 切片为空 → 判据假红**（2026-11-03 `test_simple_mode_contract` d3 真踩：一次 `git checkout`
  把文件还原成 CRLF 就红了，代码其实没改坏）。读文件后一律 `.replace(/\r\n/g, '\n')` 再做字符串判据。

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
