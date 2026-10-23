# 司天交接：D1 资料线·全库只读索引与实体发现（2026-10-19）

> 上接 [`SITIAN_BREAKPOINT_20261019.md`](SITIAN_BREAKPOINT_20261019.md)（S0 实测）与
> [`SITIAN_PLAN_20261019.md`](SITIAN_PLAN_20261019.md)（A 串行：D1 → D2 → H1 → H2 → P0）。
> 这一轮只做 D1：**B0 修掉 + 全库索引 + 实体候选 + 设置面板入口**；阅读器/绑定/全库正文搜索留给 D2。

---

## 1. 一行账

**B0 修掉（缺索引不再整次失败）；全库 1,353 篇建立只读索引（首扫 505ms / 增量 49ms，索引 964KB）；
实体候选 174 个（乱库 22 篇也能出 8 个）；设置面板有「资料索引」入口。
40 个 Node 单测 + 5 个定向 CDP 全绿；未做阅读器/绑定/正文搜索（D2）。**

---

## 2. 改了什么

### 2.1 B0：索引缺失不再致命（`scripts/extract-data.js`）

`getIndexLines()` 从裸 `readFileSync` 改为 try/catch：读不到 `01 索引/地理系统索引.md` 时返回 `[]`，
世界/星域由目录树 + frontmatter 推；不再让前面已扫到的地理节点整次作废。

**实测**（`node scripts/tests/tools/_probe_messy_vault.js`）：

| 项 | 修前 | 修后 |
|---|---|---|
| 乱库 22 篇 | `listScannedNotes` 2 篇 → `extractGeodata` **ENOENT** | 提取成功，**2 个节点**（`假星域`/`某个地点`） |
| 世界/星域 | 整次失败 | 0 个（没有索引就不硬造），节点照常返回 |

### 2.2 全库只读索引（新增 `src/main/vaultIndex.js`）

- `walkMarkdown(root)`：全库 `.md`，跳过 `.git/.obsidian/.sitian/node_modules/...` 与符号链接。
- `buildIndex(root)`：gray-matter 解析 → `{path,name,title,dir,mtimeMs,size,tags,aliases,headings,firstLine,wikilinks,fmKeys,layerHint,parentTitle,kind}`；
  增量指纹 `mtimeMs+size`；落 `<vault>/.sitian/note-index.json`（紧凑 JSON，可删可重建）。
- `readNote(root, rel)`：只读 + **库根 containment** + 2MB 上限。
- `searchIndex(index, q)`：标题/别名/标签/小标题/首段/路径（不读正文；正文全文搜索 D2）。
- `discoverCandidates(index, rules)`：在扫描目录内 / 有「层级/上层区域/地点类型」/ 路径含层级词 → 候选；
  `confidence = high|medium|low`；**只读，不导入**。

**真实库读数**（`E:/图书馆/ROSA`）：

| 项 | 数值 |
|---|---|
| 索引篇数 | **1,353**（与全库 `.md` 计数一致） |
| 首扫 | **505ms**（索引 964,477 B） |
| 增量 | **49ms**（hits 1,353 / misses 0） |
| 解析错误 | 0 |
| 候选实体 | **174**（world 26 / galaxy 41 / star_domain 9 / planet 10 / city 5 / facility 69 / location 9 / town 1 / region 1 / building 2 / unknown 1） |
| 乱库夹具 | 22 篇 → 候选 **8**（城市/区域/设施/星域等），纯人物笔记不入候选 |

### 2.3 IPC / preload（5 条）

`vault-index-build` / `vault-index-status` / `vault-note-read` / `vault-index-search` / `vault-entity-candidates`；
preload 对应 5 个方法。主进程 `src/main/index.js` 的 IPC handle 数 37 → **42**（AGENTS 锚点已同步）。

### 2.4 UI：设置 → 资料索引（`SettingsPanel.vue`）

- 显示「N 篇 · 构建时间 · KB」；
- 「重建索引」按钮（调用真实 IPC；mock 下记 `__viBuildCalls`）；
- 候选实体计数 + 高置信数 + 「查看候选」列表（层级/标题/路径，最多 40 行）；
- 明确写「只读索引：不改笔记、不碰画布；阅读器/绑定在 D2」。

### 2.5 测试

| 层 | 内容 | 结果 |
|---|---|---|
| Node 单测 | 新增 `scripts/tests/unit/test_vault_index.js`（9 段：walk / build / 增量 / 候选 / 搜索 / containment / B0 / status / 接线） | **9/9**；全仓 Node 单测文件 **40 个全过** |
| CDP | 新增 `scripts/tests/cases/test_124_vault_index.py`（设置段在位 / 重建被调用 / 候选 2 行） | **1/1** |
| 定向回归 | `test_04_panels` / `test_54_write_gate_and_reparent` / `test_75_broken_link_relink` / `test_123_save_interaction_gate` / `test_124_vault_index` | **5/5 通过** |
| 构建 | `npm run build` | 通过（SettingsPanel 33.06 kB） |

---

## 3. 明确没做（留给 D2，不是漏掉）

1. **应用内阅读器**：现在只有 `readNote` IPC，没有面板/双链跳转/图片/返回栈。
2. **要素绑定**：候选只读；还没有「勾选候选 → 导入项目」「标记/聚落挂主笔记 + 附加笔记」。
3. **全库正文搜索**：`searchIndex` 只搜元数据 + 首段；正文全文要按需 `readNote`（并做结果缓存）。
4. **库变更自动刷新索引**：watcher 仍只驱动画布/提取缓存；索引要等用户点「重建索引」。
5. **真实 Electron 下的 IPC 端到端**：本轮的 IPC 接线由 source gate（Node 单测 t9）守；
   真机 UI 只走到 mock。D2 做阅读器时建议顺带跑一次 `dev:watch` + CDP 真机。

---

## 4. 本轮踩的坑（写给下一个人）

1. **`MOCK_SCRIPT` 是 Python 字符串**：里面写 JS 的 `'# mock\n\n正文'`，Python 会把 `\n` 解释成真换行，
   注入后的 JS 语法错误 → 整个 mock 不安装，应用退回 `dev-standalone`，表现为「数据 0 / 项目打不开」。
   写 JS 字符串里的换行必须写成 `\\n`（本轮已修 `run_tests.py` 的 `vaultNoteRead`）。
2. **新增 IPC 必须同时改 preload**：本项目真实踩过「注册了但 preload 没暴露」的假开关；
   `test_vault_index.js` t9 现在直接读两个源码文件守 5 条通道。
3. **Vue DOM 异步**：点「重建索引」后立刻找「查看候选」会找不到；组件在 build 成功后会自动展开候选，
   测试应等 `.vault-candidate` 而不是等按钮文案。
4. **索引是主进程同步读盘**：首扫 505ms 会占主线程一次；D2 若做自动刷新，建议放到 `setImmediate`/分片，
   不要在每个 watcher 事件上全量重建。

---

## 5. 下一步（D2）

1. `NoteReader.vue`：marked + 自定义 wikilink renderer + 返回栈；主进程加 `vault-asset`（图片/附件，限库根）。
2. 要素绑定：项目文件加 `notePath/notePaths`；候选勾选导入（复用 `projectStore` 的实体写入，不裸写）。
3. 全库搜索：正文按需读取 + LRU；结果分组「地图实体 / 资料」。
4. 库变更：watcher 单源化，项目态只更新索引、不碰画布；状态栏提示「索引有 N 处变化」。
5. 判据：乱库从零导入 → 资料可读 → 地标 → 正文 → 双链应用内跳 → 返回；ROSA 不回退。

---

*D1 完成于 2026-10-19；本轮未提交 git（沿用前几轮的工作区，等暮雨决定怎么分提交）。*
