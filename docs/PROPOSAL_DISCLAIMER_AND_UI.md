# 司天 · 待评审方案：免责声明 + UI 选型

> 2026-10-05 ｜ 状态：**方案（未落地代码）** ｜ 关联：`AGENTS.md`「月日精度 + 切片点书签」条目
> 两件事都是暮雨 2026-10-05 会话提出的次要诉求。核心件（月日精度 + 切片书签）已在做，
> 本文件把这两件做成**可直接评审、可转交执行**的方案，避免它们只存在于会话里。

---

## 一、免责声明（用户不得违法违规 / 内容不代表作者立场 / 知情同意 + 可重新查询）

### 1.1 姊妹项目实证（先说清「参考了什么、没参考什么」）

「绒花墨坊」**不是一个独立仓库目录**，而是 `E:\CODE\CangKu\NovelForge` 这个仓库的**产品名**
（`console/package.json` 的 `name: ronghuamofang-console`、`productName: 绒花墨坊`）。
它的免责声明已落地，可参考的真实文件：

- `NovelForge/console/src/disclaimer.js`（161 行，**文案单一事实源**）
- `NovelForge/console/src/DisclaimerDialog.vue`（209 行，强制弹窗 + 完整版）
- `NovelForge/docs/disclaimer-template.md`（62 行，结构 / 版本 / 复用指南）
- `C:\Users\muyu\Downloads\绒花墨坊-免责声明-终稿-20261005.md`（终稿文案）

**值得照搬的 6 条工程做法**（不是照抄文案）：

| # | 做法 | 出处 | 为什么值得照搬 |
|---|---|---|---|
| 1 | **A/B 双版**：短版首启强制确认 + 完整版常驻可查 | `disclaimer.js:29-30/75-76`、`DisclaimerDialog.vue:24-27/138-160` | 首启读不完 13 条，但「同意」必须是对**全文**的同意 → 短版给要点、全文一键可看 |
| 2 | **版本化重确认**：`DISCLAIMER_VERSION` 进 ack 键名 | `disclaimer.js:21-22/26-27` | 条款实质变更 → 升版本号 → 全员重新确认。**不要拿应用版本号代替**（语义不同） |
| 3 | **强制模式三件套**：滚到底才可勾选；Tab 困在弹窗内 + Esc 不关；「不同意并退出」 | `DisclaimerDialog.vue:35-39/67-96/142`、`:62-65/146` | 这是「知情同意」真正有证据力的部分：能证明用户**看到了全文**才点的同意 |
| 4 | **弹窗内可切看完整版** | `DisclaimerDialog.vue:139-159` | 不强迫「先同意才给看全文」 |
| 5 | **文案与组件分离** | `disclaimer.js:1-8`、`template:4-5/26` | 改字只动一个数据文件，组件零改动；也便于以后做多语言 |
| 6 | **诚实口径**：联网行为逐条对照代码实测，不做假承诺 | `template:33-37` | 直接用在司天的**数据安全**条款上：有自动保存/备份机制，但**绝不承诺不丢** |

**不适用、必须整块删掉的**：AI / 大模型 / API Key / 厂商协议 / 本地模型 / 订阅封号 /
厂商对照表（`disclaimer.js:104-114`）—— **司天无 LLM、无云端、无账号**（身份级边界）。

**必须重写而不能照搬的**：联网范围。司天只在两处联网：① 检查/下载更新（electron-updater）；
② 用户**自己配置**的 Git 远程仓库同步（主动触发）。照搬「联网条款」会写成假承诺。

**一处需要产品方拍板的差异**：绒花墨坊终稿里暮雨**主动删掉了「未成年人使用」条款**；
本次诉求明确要求覆盖。下面的草稿**保留**该条，标注为待决。

### 1.2 司天侧条款骨架（13 节，可直接作为文案文件的结构）

| 节 | 标题 | 司天特有要点（与绒花墨坊的关键差异） |
|---|---|---|
| 1 | 总则与确认方式 | 确认与查看入口分开写：首启勾选 = 同意；`关于 → 免责声明` = 随时重看 |
| 2 | **软件性质** | **本地桌面工具；不含大语言模型、不接入云端 AI、无账号、无遥测**；仅两处联网（更新 / 用户自配 Git 同步） |
| 3 | **用户内容与合规责任** | 不得利用本软件创作/存储/导出/传播违法违规内容（列举 5 类）；责任由用户自负 |
| 4 | **立场声明** | 用户内容不代表本软件及作者立场；不参与、不预审、不背书；虚构设定与真实人物/团体/事件相似属巧合 |
| 5 | 未成年人使用（**待拍板**） | 需监护人知情同意；监护人担责 |
| 6 | **数据安全与备份**（最重要、也最需要诚实） | 见下方 1.3 —— 逐条列出**已有的**保护机制，然后明确「均不构成不丢的保证」+ 风险自担清单 |
| 7 | 按「现状」提供，不作担保 | 适销性/适用性/无中断/无错误/数据不丢失/导出结果符合预期 全部免责 |
| 8 | 责任限制 | 不承担间接/附带/后果性损失；**上限 = 用户实付费用（免费则为零）**；保留法定不得排除的责任 |
| 9 | 第三方组件与素材 | Electron / Vue / Pinia / Vite / marked / gray-matter / chokidar（MIT 类）逐项点名；导出内容含第三方素材由用户确保授权 |
| 10 | 导出与对外传播 | 导出只做本地写盘，不代为发布；商用/投稿/二次分发自行合规 |
| 11 | **条款更新与通知** | `DISCLAIMER_VERSION` 升号 → 下次启动重新提示确认；可查看当前生效版本与自己的确认时间 |
| 12 | 适用法律与争议解决 | **留占位符** `【待定：司法辖区】`（绝不编造法院/辖区） |
| 13 | 其他 | 条款可分性；不构成法律意见；联系方式占位 |

### 1.3 第 6 节的写法（这一节写虚了整份声明就白写）

**先如实列出司天已有的机制**（都能在代码里指出出处）：

1. **自动保存**：编辑后短暂延迟内自动写入项目文件；
2. **写前整文件备份 + 轮转**：`<项目名>.sitian.backups/` 保留最近 10 份；
3. **会话基线**：每次「打开项目」另存 1 份、**不参与轮转**（高频自动保存刷不掉它）；
4. **原子写盘**：先写 `.tmp-<ts>` 再 rename（断电不留半个 JSON）；
5. **项目内快照**：可回滚历史状态，但 🔴 **不含地形高度图 / 涂色网格 / 参考底图**
   （`SNAPSHOT_HEAVY_FIELDS`；设计取舍见 `A1_DATA_MODEL_DECISION.md` §八 R1）；
6. **退出前落盘**：退出时尝试写完未保存改动，**失败会用原生对话框告知**并给「留在窗口」出口；
7. **令牌加密保管**：同步令牌经系统加密能力（Windows=DPAPI）落盘；无加密能力时**只留内存、绝不写明文**。

**然后明确「不保证」与风险自担**（这一段是关键，不要写得含糊）：

- 备份与项目文件**在同一台电脑（通常同一磁盘）** → 磁盘故障 / 误删 / 格式化 / 重装 /
  勒索软件 / 清理工具 / 网盘覆盖式同步，可能**同时损毁主文件与备份**；
- 未纳入快照的字段（高度图/网格/参考图）**无法通过快照找回**；
- 软件缺陷、异常退出、断电、系统或第三方软件干预导致的损坏或丢失；
- 用户自配 Git 远程仓库的可用性/可见性（公开 or 私有）/安全性由用户负责，
  **一旦推到公开仓库内容即可能被他人获取**。

**结论句**：强烈建议对重要成果定期另行备份（导出 JSON、复制到其他磁盘或自己的远程仓库），
并**自行验证备份可用**。

### 1.4 落地形态建议（推荐方案 A；含三个必须处理的坑）

**方案 A（推荐）—— 与姊妹项目同构，落点已在本仓核对过**

| 步 | 落点 | 说明 |
|---|---|---|
| 1 | 新建 `src/renderer/src/utils/disclaimer.js` | 导出 `DISCLAIMER_VERSION` / `DISCLAIMER_ACK_KEY = 'sitian_disclaimer_ack_v' + VERSION` / `DISCLAIMER_SHORT` / `DISCLAIMER_FULL` / `hasAckedDisclaimer()` / `ackedDisclaimerAt()`。**改字只动这个文件** |
| 2 | 新建 `src/renderer/src/components/DisclaimerDialog.vue` | 强制三件套（滚到底才可勾选 / 焦点陷阱 + Esc 不关 / 不同意即退出）；补 `role="dialog" aria-modal="true"` —— **本仓目前零 focus trap、零 aria-modal**，这会是第一个真锁模态 |
| 3 | 挂点 | `App.vue` 按既有 async 组件范式注册，模板放在现有浮层那一组旁；`onMounted` 读 ack 决定是否强制打开 |
| 4 | **随时可查** | `AboutPanel.vue` 新增「免责声明」节（F1 直达关于面板的通道已有）；`SettingsPanel` 的「通用」段加一个按钮即可（不必新增页） |
| 5 | 版本化 | 升 `DISCLAIMER_VERSION` → ack 键变化 → 全员重新确认。⚠️ **不要用 `package.json` 的版本号代替** |

**方案 B（最省代码，不推荐）**：只写 `docs/DISCLAIMER.md` + 用 `OnboardingGuide.vue` 的套路加一屏。
缺点：改文案要动组件；**条款更新无法强制重新取得同意** —— 与「条款可更新」的诉求直接冲突。

**方案 C（中间态）**：不新建弹窗，完整声明塞进 `AboutPanel`，首启自动打开关于面板。
缺点：无勾选、无阻断、无版本化，**知情同意的证据链最弱**；只适合作为「随时可查」的补充。

**首启必须处理的三个坑**（会直接导致「用户看不到声明就进了主界面」）：

1. **与新手引导抢屏**：`OnboardingGuide.vue` 在挂载后 **1 秒**自动弹出（判据
   `localStorage['sitian-first-run-complete']`）→ 免责声明必须**在它之前且阻断它**，
   否则两层浮层同屏。
2. **Esc 会漏**：`App.vue` 的全局 Escape 会 `panelsStore.closeAll()` → 强制模式必须在
   **捕获阶段** `preventDefault + stopPropagation`。
3. **启动顺序**：放 `App.vue` 的 `onMounted` 且**在 `store.loadGeodata()` 之前**更稳
   （否则 splash 淡出后闪一下主界面）。`localStorage` 在 Electron 用户数据目录下持久化 →
   **清用户数据目录 = 重新弹**，这条可直接当验收断言。

### 1.5 顺手发现的两件事（不在本方案范围内，但建议同批处理）

1. **`版权与许可证.md` 已过期**，而新声明第 9 节要引用它 —— 现在它写版本 `0.1.0`
   （实际 `package.json` 是 `0.1.7`）、依赖表漏了 electron-updater / electron-log / marked /
   lucide-vue-next / electron-builder，还引用已不存在的 `composables/useMapExport.js`。
   **不修它 = 声明里「见随附清单」指向一份错的文档。**
2. 仓库根 `index.html`（194 行）是**遗留 dev 产物**（有两份重复 mock、引用不存在的 hash），
   而 Vite 的真正入口是 `src/renderer/index.html`。以后加 PostCSS/Tailwind 入口别改错文件。

---

## 二、UI 选型：把「有轮子不造」从口头规矩变成仓库资产

### 2.1 现状审计（实证，非推断）

**结论：司天目前一个 UI 组件库都没有。**

- `package.json` dependencies（8 个）：chokidar / electron-log / electron-updater / gray-matter /
  **lucide-vue-next** / marked / pinia / vue。devDependencies（7 个）：@vitejs/plugin-vue /
  concurrently / cross-env / electron / electron-builder / vite / wait-on。
- Tailwind / Naive UI / Element Plus / PrimeVue / shadcn-vue / radix-vue / headlessui：**全部没有**
  （依赖、devDeps、Vite 插件、配置文件四处都无）。
- 唯一的「类 UI 库」`lucide-vue-next` **源码零引用**，且 lock 已标弃用
  （`Please use @lucide/vue instead`）。图标是**手写 153 分支**的 `Icon.vue`。
- 样式方案 = **全局 CSS 变量 + 组件 `<style scoped>`**，无预处理器（无 sass/less）。
  主题 token 定义在 `App.vue`（暗色 / 亮色两套）。
- **没有 PostCSS 管道**：唯一的全局 reset 写在 `src/renderer/index.html` 的内联 `<style>` 里
  （`* { margin:0; padding:0; box-sizing:border-box }`）—— 不经过 Vite/PostCSS。
- 自研件规模：`components/` **41 个 .vue / 31,845 行**。对话框/面板壳/图标/右键菜单全套自研；
  **55 个原生 `<select>`**、**416 处 `title=`**、**499 个 `<button>` 中 155 个无 class**。
- 焦点管理**几乎空白**：全仓仅 5 处 `.focus()`、`tabindex` 0 处、`aria-modal` 0 处、
  **没有任何 focus trap**。

### 2.2 推荐选型：shadcn-vue + Tailwind（理由按权重排）

1. **AI 语料量**：这套模式在 Vue 组件库里属第一档 —— 对 AI 工作流而言，
   「AI 认不认识这轮子」比「轮子排名」更决定生成稳定度。
2. **审美对齐**：Rosé Pine / Raycast / Linear 系的工作区 + 命令面板审美就是它的原生风格。
3. **源码进仓库、不是黑盒依赖**：组件是拷进 `components/ui/` 的源码，可读可改；
   而键盘导航、焦点陷阱、无障碍这些边角坑由底层 primitives 替你踩完。

**备选**：Naive UI（不想引 Tailwind 时）。

### 2.3 共存风险清单（按「必现 × 影响面」排序）

| # | 风险 | 证据 | 处置 |
|---|---|---|---|
| **R1** | 🔴 **Markdown 正文列表符号消失**（唯一「必现」项） | `NodeDetailPanel.vue` 的 `.markdown-body ul/ol` 只设 `padding-left`/`margin`，**没设 `list-style`**（靠浏览器默认）→ preflight 的 `ol,ul{list-style:none}` 直接抹掉笔记详情页的列表符号。全仓手工 `<ul>` 只 1 个且已 `list-style:none` → 风险**只从 Markdown 这条路进来** | 引 Tailwind 时**显式补** `.markdown-body ul{list-style:disc}` 等，或只引 utilities 不引 base |
| **R2** | 全局 `line-height` 由 `normal` 变 `1.5` | preflight 有 `html{line-height:1.5}`，而司天**全仓没有任何全局 line-height** → 所有面板行高/按钮高度/工具条换行阈值整体漂移 | 若引 base，需为受影响容器定点复位；否则只引 utilities |
| **R3** | 表单控件继承字体（`font:inherit`） | 司天有 55 个 `<select>` + 90 个无 class 的 `<input>`；抽查显示常见控件都显式写了 `font-size` | 风险中低，但需逐条核 |
| **R4** | `button` 默认样式被重写 | 155 个无 class 的 `<button>` 靠祖先后代选择器塑形；后代选择器特异性高于 preflight 元素选择器 → 抽查**三处都没事**，另有 0 处「`border:Npx` 不写 style」 | 属「需前置全量比对」而非「已知会坏」 |
| **R5** | Canvas 容器 | preflight 的 `img,video{max-width:100%;height:auto}` **不含 canvas**；7 个画布早已显式 `canvas{display:block}` | 风险最低。⚠️ 真风险来自**容器尺寸**：DPR 位图按 `clientWidth` 算，谁给 wrapper 加 padding/border 谁触发重算 |
| **R6** | **双 reset 双源** | 内联 `index.html` 的 reset 与 preflight 语义不同；冲突时由「Vite 注入 CSS 在内联 `<style>` 之后」决定 | **不要靠顺序博弈**：要么禁用 preflight，要么显式分层 |
| **R7** | 🔴 **shadcn-vue 的 token/暗色体系与司天不接** | 司天 token 挂在 **App 根元素**（编译成 `.theme-dark[data-v-…]`），shadcn-vue 约定 `:root` 变量 + `html.dark`。后果：① shadcn 组件走自己的调色板 → **观感割裂**；② 司天切主题**不会**切到 shadcn 暗色分支；③ teleport 到 body 的内容拿不到司天变量（既有先例：导出遮罩只能写死颜色） | 试点时把司天 token 映射进 shadcn 的变量名，或先只用**无配色依赖**的组件（Dialog / 焦点管理） |

### 2.4 试点落点建议

**首选 `components/AboutPanel.vue`**（625 行）：纯只读、无画布、无 store 写入，
**且没有 CDP 用例的 testid 契约**（已核：`settings-tab`→test_30、`marker-types`→test_32、
`lineage-panel`→test_43、`slice-export`→test_78，均与 AboutPanel 无关）。

**次选 `ScenarioSliceExport.vue`**（175 行，但 test_78 有 8 处引用）。

**⚠️ 切勿先动 `ScenarioMap.vue`（5,7xx 行）/ `PlanetMap.vue`（3,9xx 行）** ——
大量像素断言与 testid 契约。

**试点范围（关键）**：只引 `@tailwind utilities`、**不引 `@tailwind base`**；
用 shadcn-vue 的 Button / Dialog / Card 三件，在 AboutPanel 里做一个「免责声明」入口。
这样 **R1/R2/R3 全部不触发**，风险面只剩 R4/R7。

**试点同时验证一件事**：把「免责声明」这个真实功能作为试点的第一个用例 ——
它天然需要 Dialog + 焦点陷阱 + 滚动容器 + 按钮，正好覆盖选型的三件套，
而不是为了试点而试点。

### 2.5 让规矩变成仓库资产（四层，按投入从小到大）

| 层 | 内容 | 成本 | 产出 |
|---|---|---|---|
| **0** | **规则文件**：在每个项目根 `AGENTS.md` 写死「UI 一律用指定组件库；禁手搓按钮/弹窗/下拉/焦点管理」，并划清 **轮子区**（面板 / 对话框 / 快捷键系统：禁造）与 **造轮子区**（司天的 Canvas 地图编辑是产品本体：必须造） | ≈0，今天就能做 | AI 写第一行代码前就撞见规则，不再靠会话级提醒 |
| **1** | **统一选型**：一次决策、三应用共用（司天 / 绒花墨坊 / 方寸），**带退出条件** | 一次决策 | 三应用不再各造一套 |
| **2** | **交互字典** `interactions.md`：**别形容外观，点名模式**（例：「命令面板：Ctrl/Cmd+K 唤起；居中浮层；即时模糊搜索；↑↓ 选择、Enter 执行、Esc 关闭；结果按操作/跳转/设置分组；空态给引导。参考 VSCode / Raycast」） | 每加一条几分钟 | 越养越厚 = 私有提示词资产（**长远复利主要在这**） |
| **3** | **参考流水线**：你找参考（视频截图 / 产品页）→ 视觉模型拆成规格（色彩/间距/圆角/密度 + 布局 + 交互字典条目）→ 组件库落地 → 你按老规矩评审「治没治实质问题」 | 每轮一次 | 治「不会画画」：你出裁判技能，AI 出画手技能 |

**终态（3–6 个月）**：三应用收敛到同一私有基座 —— 工作区布局 / 命令面板 / 设置页 /
快捷键注册 / 主题 tokens 抽成模板；新应用前端 = 基座 + 领域层。

### 2.6 这一节与司天本轮的接口

司天当前的 UI 现状里，**最值得先被「基座」吃掉的三样**（按收益排）：

1. **对话框**：全仓 14 个组件各自手写 overlay + `@click.self` 关闭，**全部没有焦点陷阱**。
   免责声明弹窗会是第一个真锁模态 —— 正好用它把 Dialog primitives 引进仓库。
2. **面板壳**：`PanelShell.vue` 已成为事实标准（header 拖拽 / 折叠 / 关闭），
   但样式与交互仍是自研；换基座时它是**唯一需要保留的抽象**（其余面板都该吃它）。
3. **快捷键**：`App.vue` 的全局 handler + `useKeyboardShortcuts.js` 两处并存，
   且没有「注册 / 冲突检测 / 帮助浮层自动生成」—— 命令面板要落地就得先统一这一层。

*整理：企鹅 · 2026-10-05 · 证据路径均可复验*
