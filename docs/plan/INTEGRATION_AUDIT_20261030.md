# 司天 · 模块集成审计（2026-10-30）

> **触发**：用户 2026-10-30 报障 ——「下载文件夹里堆了一堆司天 PNG，全是画得很难看的星系地图；
> 哪怕抄之前那个模块都比这个生成效果好，说明根本没集成」+ 要求「检查之前那些司天相关模块是否都完成集成」。
> **口径**：与 `PLAN_AUDIT_20261030.md` 一致 —— **代码 + 用例 + 实测为准**，文档只作线索。
> **审计时点**：`1d2e349`（2026-10-30 19:0x，`main` 已与 `origin/main` 同步）。
> **一句话结论**：**功能模块没有孤儿**（全部接上了线），但**渲染层确实存在"第二套实现"，用户看到的就是它**；
> 另外 UI 基座（shadcn-vue 试点）18 个文件、5 个依赖，**产品里 0 处使用**。

---

## 一、方法（可复验，不是印象）

| 探针 | 做什么 | 命令 |
|---|---|---|
| `build/_probe_dead_modules.mjs` | 扫 `src/` 全部 262 个 `.js/.vue/.mjs` 的 import / `export … from` / `import()`，找"没有任何消费方"的文件 | `node build/_probe_dead_modules.mjs` |
| `build/_probe_component_usage.mjs` | 比对 `App.vue` 里 import 的组件与模板里真正出现的标签（PascalCase + kebab-case 都认） | `node build/_probe_component_usage.mjs` |
| `build/_probe_export_bounds.mjs` | 用**真实 415 省项目**复算「导出 PNG(全图)」的图幅，对比"按 coordinate"与"按布局"两种口径 | `node build/_probe_export_bounds.mjs` |

> 三个脚本都在 `build/_*`（已进 `.gitignore`）：它们是**证据**，不是产品代码。

---

## 二、集成现状：功能模块**没有孤儿**

`src/` 262 个文件里，只有 8 个没有任何消费方，逐个核对后**全是合理的**：

| 文件 | 为什么没有消费方 |
|---|---|
| `src/main/index.js` | 主进程入口（Electron `main` 字段直接指它） |
| `src/preload/index.js` | 预加载入口（`webPreferences.preload` 指它） |
| `src/renderer/src/main.js` | 渲染进程入口（`index.html`） |
| `src/renderer/src/workers/deriveWorker.js` | 由 `deriveClient.js` 以 `?worker` 后缀 import（Vite worker 语法，静态扫描认不出） |
| `src/renderer/src/components/ui/{button,card,dialog}/index.js` | **UI 基座的桶文件——见下一节，产品里 0 处 import** |
| `src/renderer/src/lib/utils.js` | shadcn 的 `cn()` 辅助，同上 |

**结论**：FMG 生成管线、造陆/高度图、河网、湖泊水位、Voronoi 邻接、3D 星系观景、事件账本 v3、
读料桥、剧本四笔……**没有一个是"写完了没接线"的**。`App.vue` 的 9 个静态组件 + 23 个异步组件，
模板里**全部**有对应标签（0 个 unused）。

> ⚠️ 注意"接上线"≠"用户能看到"：真正的断点在**渲染一致性**（下一节），不在"有没有 import"。

---

## 三、用户看到的"没集成"：星系导出的**第三套实现**

### 3.1 现象复算

21 份 `sitian-full-*.png` **SHA256 完全相同**（布局是确定性的，同一份数据每次导出必然一样），
每份 17.9 MB / 5468×5518，共 359 MB —— 也就是说用户点了 21 次，每次都**没被问过存哪**，
也没覆盖，只是往「下载」文件夹里又堆一份。

### 3.2 根因（两处，都在 `App.vue#handleExportFullPNG`）

| # | 修前 | 后果（真实 415 省项目实测，`_probe_export_bounds.mjs`） |
|---|---|---|
| ① 图幅算错对象 | `placed` 里塞了 `nodes`（**所有世界**的 planet/city/facility…），图幅取它们的 `coordinate` | 这些坐标来自提取器的同心圆布局（实测 x∈[-617,1817]、y∈[-880,1579]），而星域环形半径只有 630 → 图幅被撑到 **2734×2759**，星系挤在一角、其余大片空白 |
| ② 画的对象不对 | `drawList` 同样包含那些更深层节点，按自己的 `coordinate` 画 | 画布（`GalaxyMap`）**从不画**它们 → 导出图上多出 90+ 个与星系视图无关的点，10px 标签在 5468px 位图里几乎不可读 |

> 一句话：**导出的图和屏幕上的不是一回事**，而画布那套（`useCanvasRenderer` + `galaxyLayout`）
> 明明已经存在。用户说"没集成"——从结果看，这个判断是对的：**导出没有复用画布的绘制/取景口径**。

### 3.3 修法（2026-10-30）

- 图幅与绘制对象**只取星域 + 星系**（= 画布画的那一堆），位置统一走 `posOf`（先布局 `x/y`，再回落 `coordinate`）；
- 字号 / 节点半径 / 标签衬底**随图幅缩放**（`uiScale`，1–2.5×），不再固定 10px；
- 位图上限 ≈ 36MP，超了先降 `dpr` 再画（旧口径一张 30MP / 17.9MB）；
- 落盘改走**主进程保存对话框**（`window.sitianAPI.saveExportFile`），文件名 `sitian-full-YYYY-MM-DD.png`（可覆盖，不再带毫秒戳）。

### 3.4 判据（`test_117` 已加，已跑绿）

```
✅ test_117_galaxy_export_same_source
   节点圆 14 个 vs 期望 14 个（对上 14） · 深层节点误画 0/94
   · 落盘 saveExportFile 1 次（sitian-full-2026-10-30.png）
   · f2 像素：3617×3274 · 金色像素 0 · 星系色像素 53247
```

新增三条闸门：
1. **更深层节点的坐标上不许再出现节点圆**（`deepDrawn = 0/94`）—— 挡住"图幅被旧坐标撑开"复发；
2. **导出必须调 `saveExportFile`**，且默认文件名是 `.png`、**不带 13 位毫秒戳**；
3. 原有的"节点圆 = 共享布局位置"逐点比对保留（星域/星系各一条明确点）。

---

## 四、下载文件夹堆积：同一条根因的另一个出口

`App.vue` 里**三条**导出（当前视图 PNG / 全图 PNG / 当前视图 SVG）原先都各自写一遍
`a.download` —— 那是浏览器默认下载目录：**不问路径、不记上次目录、文件名带毫秒时间戳、永不覆盖**。
行星侧（`composables/useFullMapExport.js`）早就走 `saveExportFile` 保存对话框，**两条链路各写一套**，
正是本项目「同一能力只许一份实现」红线反复踩的形态。

现在三条统一走一份 `savePngBlob()`（`App.vue`，全仓唯一实现），SVG 走 `saveTextFile(kind:'svg')`；
纯浏览器（`npm run dev` 无 Electron API）才回退 `a.download`。

**已清理**：`C:\Users\muyu\Downloads` 下 21 份重复 PNG → 删 20 份，**保留 1 份**作证据
（`build/_downloads-evidence/sitian-full-1793264346736.png`，已 gitignore；想删随时删）。
释放 **359 MB**。

---

## 五、UI 基座（shadcn-vue 试点）**从未落地**

| 证据 | 读数 |
|---|---|
| `src/renderer/src/components/ui/` | 18 个文件（button / card / dialog） |
| 全仓对 `components/ui`（含 `@/` 别名）的引用 | **0 处** |
| `package.json` 依赖 | `reka-ui` / `tailwindcss` / `class-variance-authority` / `clsx` / `tailwind-merge` 5 个 |
| `lib/utils.js`（shadcn 的 `cn()`） | 只被自己引用 |

判定：**试点没走出第一步**。它不产生运行时开销（没 import 就被 tree-shake），但会误导后来者
（"我们有 UI 基座"）并占着 5 个依赖。
**建议**（不擅自做）：要么在 N3 挑一个面板真做一次迁移（判据：该面板零自定义 CSS 且回归全绿），
要么把这 18 个文件 + 5 个依赖删掉，写进 `docs/archive/`。二选一，别挂着。

---

## 六、结论与对 `PLAN_AUDIT_20261030` 的影响

1. **N0 的"内测包"多了一条非看不可的东西**：星系导出观感（图幅/字号/落盘路径）。
   这条不改，用户拿到的仍是"一坨"。
2. **N1（渲染层接口化）的动机更硬了**：星系导出就是"第三套绘制实现"的活证据 ——
   `ScenarioMap` 的 28 个 `draw*` 是同一个病，只是还没被导出这种"第二个消费者"照出来。
   接口化之后，导出应当变成"复用注册表 + 换个 view 变换"，而不是再写一份。
3. **本轮的改动在 N0 之前**（属"用户报障直修"，不占阶段门），已跑
   `test_117` 单绿 + `npm run build` 通过；全量回归见提交信息。
