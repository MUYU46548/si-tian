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
- 回归测试: `python scripts/tests/run_tests.py`（**163 用例**；须用系统 Python，Hermes 自带 venv 缺 `websocket-client`）
  - 数据源默认 = **仓库内合成 fixture**（`scripts/tests/fixtures/vault-fixture/`，由 `fixtures/make_vault_fixture.py` 生成：层级结构同构、内容全虚构、地图几何程序合成）→ **用户改自己的世界观数据不会让用例变红**；要对着真实库跑加 `--real-data`
  - 该命令会先跑 `scripts/tests/unit/*.js`（**93 个** Node 单元测试文件：主进程文件 I/O + 真实 git 同步 + 令牌加密保管 + 纯函数层若干，CDP 用例的 mock 覆盖不到），失败计为 1 个失败用例
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
- **「涂归属」一笔的端到端时延**: `npm run test:owner-latency`（`drill_owner_latency.py`）—— **真实 Electron +
  真实 415 省项目的工作副本**（原项目只读：跑前后 sha256 一致），量四段：松手同步段（口径 ≤50ms）/
  交给项目 / 松手→磁盘（含 800ms 自动保存防抖）/ 显式 flush→磁盘；并从**磁盘**核对归属、`changeEvents`、
  一笔一组的 `groupId`。产物 `build/owner-latency/<ts>/{result.json,summary.md}`。
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
- **不要整读大文件**：`ScenarioMap.vue`（**6,920 行**，2026-11-03 把 1,649 行样式搬到
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
| 测试用例数 | 163 | `ls scripts/tests/cases/test_*.py \| wc -l` |
| Node 单测文件数 | 93 | `ls scripts/tests/unit/*.js \| wc -l` |
| store 模块数 | 9 | `ls src/renderer/src/store/geodataModules/` |
| App.vue 异步面板 | 25 | `grep -c defineAsyncComponent src/renderer/src/App.vue` |
| IPC handle 数 | 48 | `grep -c "ipcMain.handle" src/main/index.js` |
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
