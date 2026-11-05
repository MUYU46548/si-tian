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
- 打包安装包: `npm run dist`（electron-builder → `release/SiTian Setup <版本>.exe`）
- 从 Obsidian 提取数据: `npm run extract-data`
- 回归测试: `python scripts/tests/run_tests.py`（**164 用例**；须用系统 Python，Hermes 自带 venv 缺 `websocket-client`）
  - 数据源默认 = **仓库内合成 fixture**（`scripts/tests/fixtures/vault-fixture/`，由 `fixtures/make_vault_fixture.py` 生成：层级结构同构、内容全虚构、地图几何程序合成）→ **用户改自己的世界观数据不会让用例变红**；要对着真实库跑加 `--real-data`
  - 该命令会先跑 `scripts/tests/unit/*.js`（**104 个** Node 单元测试文件：主进程文件 I/O + 真实 git 同步 + 令牌加密保管 + 纯函数层若干，CDP 用例的 mock 覆盖不到），失败计为 1 个失败用例
  - 单跑某个用例：`python scripts/tests/run_tests.py test_47`
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
- **N1 像素基线（渲染层接口化的判据）**: `python scripts/tests/drill_scenario_pixels.py --tag before` 留底、
  `--tag after` 再拍一次、`--compare before after` 比 —— 起 Vite(5180)+Edge(9222)，用**自带底图（3 省）**固定取景，
  落 `build/pixel-baseline/<tag>.json`（整图 FNV-1a + **关标注**后的几何层指纹 + camera）与同名 PNG。
  非 0 退出 = 逐像素判据没过。⚠️ 不要与 `run_tests.py` / 其它要 5180/9222 的演练同时跑
  - **当前基线 = `v20261105f`**（2026-11-05 立：**主帧一个像素没变**（与 v20261104e 同 hash），
    新增的是一枚**河层指纹** —— 以前 fixture 铺底时把 `baseMaps[key].rivers` 换成了两条手画河，
    生成河从来不在像素基线里，于是河线几何/河宽改了多少轮都“逐像素一致”：不是没坏，是**判据看不见河**。
    现在每拍一次会再生成一次地形（河一起落库）、关掉河以外的层、相机钉在最长那条河上（3.5×）；
    拍前做负向探针（最宽 20 条河压细 40% → 指纹必须变），并断言 `river_gen_*` > 20 条。
    读数：`hash f60036f4` / `hashNoLabels 443de52c` / **`riverHash 71434f74`** / riverCamera scale 3.5（v20261105e 版在河入海裁剪落地后作废）；
    `--no-river-frame` 可关河层帧；旧帧文件 `v20261104e` 并存（主帧仍然有效）。两次连拍逐字节一致。
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
  - ⚠️ `drill_quit_flush.py --phase p4` 在本机当前 dist 上**红**（点“历史剧本”后画布 30s 不挂载；
    旧 dist 同样红，与本改动无关）—— 已建卡，别把它当 B2 的判据。
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
    已建卡 `drill_reimport_019-两-a9be8e2f`，与本改动无关。
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
  读数（本机 / 8.2MB 真实项目副本）：同步段 **0.1~2.5ms**（撤销命令本身一点都不慢）；到下一帧
  **57~104ms**（大头是整图重绘）；连续撤销会被保存链拖出 **1~3 秒**主线程占满（另案，不设闸门）。
  产物 `build/undo-latency/<ts>/{result.json,summary.md,profile-*.json}`。
  ⚠️ 帧时刻**必须用回调里的 `performance.now()`**，不能用 rAF 的 vsync 参数 —— 后者会把 75ms 读成 8ms
  （主线程被占住时回调拿到的仍是原定的帧起点）；⚠️ CPU 采样窗口的坐标是 `performance.now()`，
  混用 `Date.now()` 会一条样本都留不下。
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
    —— 用户四条硬要求 / 已完成四个提交 / 三个视图的“可读性闸门”命令 / 剩下的 110 个纯图标按钮与
    剧本 10 条 / 九个真机坑（浮层宽度、flex-basis、auto-fit、裁字、截图超时…）/ 下一步顺序。
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
- **按钮必须有名字、文案必须说人话**（2026-11-05 用户拍板：“不要再让我看到一大堆乱七八糟的按钮和
  根本看不懂的文字”）：① 工具栏/面板里的按钮**不许只有图标**（只有 `title` 不算 —— 要悬停才知道，
  用户实测“找了五分钟没找到”）；② 用户可见文字里不许出现**工程内部术语**
  （`provenance` / `落库` / `单源` / `格距` / `回执` / `幂等` / `N3a` / `φ`），第三方产品名
  （Azgaar / FMG）只在**导入向导这类确实需要指路**的地方保留。守门：`unit/test_toolbar_ux.js`（剧本视图），
  改其它视图的工具栏时照此扩一张「每个按钮都有文字」的判据。
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
- **不要整读大文件**：`ScenarioMap.vue`（**6,998 行**，2026-11-03 把 1,649 行样式搬到
  `scenario-map.css`，原来 8,554 行）/ `PlanetMap.vue`（4,559 行）是全仓最大的两个 SFC —— 先 `grep` 定位再读窗口
  （行数以 `docs/ARCHITECTURE_MAP.md` 为准；这条也是 token 成本的纪律）。
  `ScenarioMap` 的体量与浮层落点有闸门：`unit/test_scenario_map_split.js`（≤7,000 行 + 六个浮层各恰好一次 +
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
| 测试用例数 | 164 | `ls scripts/tests/cases/test_*.py \| wc -l` |
| Node 单测文件数 | 104 | `ls scripts/tests/unit/*.js \| wc -l` |
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
