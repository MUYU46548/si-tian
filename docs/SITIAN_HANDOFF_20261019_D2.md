# 司天交接：D2 资料线·应用内阅读器 / 绑定 / 全库搜索 / 库变更（2026-10-19）

> 上接 D1 [`SITIAN_HANDOFF_20261019_D1.md`](SITIAN_HANDOFF_20261019_D1.md)（全库索引 + 候选）。
> 这一轮把“大号 Obsidian 启动器”那条链补上：**任意笔记在司天里读、双链应用内跳、图能看、
> 节点能挂附加笔记、全库正文能搜、库里改笔记索引自己更新**。仍只读，不写笔记、不碰画布。

---

## 1. 一行账

**阅读器/双链/返回栈/附件、节点绑定 notePaths、全库正文搜索、整库 .md 索引 watcher 全部落地；
真实库 resolve/搜索/附件 8–13ms，watcher 改一篇 239ms 重建；41 Node 单测 + 6 定向 CDP 全绿。**

---

## 2. 改了什么

### 2.1 阅读器（新增 `components/NoteReader.vue` + `utils/noteReader.js`）

- 任意 `.md` 在司天内部渲染（marked + 表格/标题）；`[[双链]]` 应用内跳（主进程 `vault-note-resolve` 按标题/别名/文件名/相对路径解析，重名给候选数）；返回栈；`![[图.png]]` 与相对路径图片走 `vault-asset-read` → dataUrl。
- 入口：
  - 任何组件可 `openNote(path)`（CustomEvent `sitian:open-note`）；
  - 节点面板新增「在资料阅读器中打开」；
  - 全库搜索点结果直接进阅读器。
- 附件限制：库根 containment、8MB 上限、MIME 白名单；不注册自定义协议（避免多一层 Electron 权限）。

### 2.2 全库正文搜索（`vaultIndex.searchIndexDeep` + `NoteSearchPanel.vue`）

- 元数据命中优先（标题/别名/标签/小标题/首段），再按需读正文；结果带 `matchedIn: meta|content` 与 snippet。
- 入口：设置 → 资料索引 → 「全库搜索」；`openNoteSearch()` 也可被任意组件调用。
- 真实库实测：`searchIndexDeep('暮雨')` 8ms（50 条，元数据优先）；正文扫描只在无元数据命中/未满时进行。

### 2.3 节点绑定附加笔记（`NodeDetailPanel.vue` + `NotePicker.vue`）

- 节点的**主笔记仍是 `sourcePath`**；附加笔记存 `node.notePaths`（数组），随项目实体往返（`entityExtras` 自动保留未知字段）。
- 面板「关联资料」：列出已绑定笔记（点开进阅读器）+ 解除绑定；「+ 绑定笔记」打开搜索选择器，已绑定的置灰。
- **不写笔记**、不新建笔记；只是项目文件里的路径引用。
- 只读态灰禁（`store.isReadOnly`），写走 `updateNode`（undo 栈 + 自动保存）。

### 2.4 库变更 → 索引自更新（新增 `src/main/vaultIndexWatcher.js`）

- 监听**整库** `.md`（忽略 `.git/.obsidian/.sitian/node_modules` 与非 `.md` 附件），`add/change/unlink` → **250ms 防抖** → 增量重建索引 → 主进程发 `vault-index-updated`。
- 与 `vault-watcher.js` 严格分工：那个只覆盖两个地理目录、驱动画布；本 watcher **只重建只读索引**，不碰画布、不写笔记。
- 换库时 `restartIndexWatcher()` 收旧开新；启动失败只 warn，不影响主流程。
- 实测（`test_vault_index_watcher.js`）：新增 `.md` → **239ms** 重建（total +1）；修改 → **241ms** change；`close()` 后零回调。

### 2.5 IPC / preload / 测试面

新增 3 条 IPC + 1 个事件：`vault-note-resolve` / `vault-note-search` / `vault-asset-read` / `vault-index-updated`。
IPC handle 42 → **45**；preload 对应 8 个 `vault*` 方法 + `onVaultIndexUpdated`。

---

## 3. 判据与证据

| 层 | 内容 | 结果 |
|---|---|---|
| Node 单测 | `test_vault_index.js` **11/11**（新增 resolve / 正文搜索 / 附件 containment）；`test_vault_index_watcher.js` **4/4** | 全仓 **41 个 Node 单测文件全过** |
| CDP 新增 | `test_125_note_reader.py`：阅读器正文 + 附件图 + 双链跳 + 返回栈 + 全库搜索进阅读器 + 节点绑定 notePaths | **1/1** |
| CDP 回归 | `test_04` / `test_54` / `test_75` / `test_123` / `test_124` / `test_125` | **6/6** |
| 构建 | `npm run build` | 通过 |
| 真实库 | `resolveNote('乐园星')` → `03 设定/11 地理系统/行星/乐园星.md`；`readAsset('age_01.jpg')` → 56,570B / image/jpeg / 13ms；`searchIndexDeep('暮雨')` 8ms | 主进程函数级实测 |

---

## 4. 明确没做（不是漏掉）

1. **剧本/地图标记（scenario marker/label）绑定**：本轮只做“节点（聚落/地点/设施…）”。
   标记是剧本数据、不是节点；要加 `notePath` 得改剧本 schema + ScenarioMap 标记编辑器，单独一轮。
2. **候选勾选 → 导入项目**：D1 的候选仍只读；导入要走 `projectStore` 的实体写入口，不能裸写。
3. **笔记编辑/新建**：维持“不做第二个 Obsidian”，阅读器只读。
4. **附件自定义协议**：现在 dataUrl（简单、可测、无需协议注册）；大图多图会有内存峰值，D3 可换 `vault-asset://`。
5. **全量 125 用例**：本轮只跑定向 6 例 + 41 Node 单测；全量仍待收尾时一次跑。
6. **真实 Electron IPC 端到端**：本轮 CDP 仍是 mock；真机 `dev:watch` 下阅读器/附件一次未跑（下一轮建议顺带跑）。

---

## 5. 本轮踩的坑

1. **`MOCK_SCRIPT` 里的 JS 换行**：Python 字符串会把 `\n` 变真换行 → 整个 mock 语法错误 → 应用退回 `dev-standalone`（数据 0 / 项目打不开）。写 JS 字符串必须 `\\n`。
2. **Vue DOM 异步**：点「重建索引」后立刻找「查看候选」找不到；组件成功后会自动展开候选，测试应等 `.vault-candidate`。
3. **watcher 忽略规则**：只忽略目录不够，附件（png/jpg）也会被 chokidar 监听；已加“非 `.md` 扩展名一律忽略”，真实库启动/关闭正常。
4. **绑定字段的往返**：`notePaths` 是项目实体的未知字段，靠 `entityExtras` 自动保留；若以后把它加进 `ENTITY_SHAPE_KEYS` 反而会丢，别加。

---

## 6. 下一步（H1：手绘线安全与几何）

按 A 串行，资料线到 D2 收口；下一轮进 **H1 轮 1**：

1. **D10 描轮廓安全**：落笔前高亮将被挖/被并的省，给“影响 N 省 / 面积 X”；省数/面积闸门；默认 `toNeighbor=false`。
2. **D11 空省剪枝**：`difference` 挖空后从 terrain 移除（级联清 ownership/标签），或标 empty 并过滤。
3. **T8 去 `/3` 过冲**：不用控制点或按段长夹紧；布尔结果不二次平滑；旧 `fromGrid` 一次性迁移。
4. **T10 画布最小尺寸**：<700×400 提示收起面板；参数浮层化。
5. 判据：描轮廓“影响 N 省”预览 + 挖空不残留；渲染 vs 数据偏差 <1px；12 笔刷矩阵复跑。

---

*D2 完成于 2026-10-19；本轮未提交 git（沿用前几轮工作区）。*
