# 司天：第八轮（④ 星系表现层 4 个 bug + 颜色 alpha 静默缺陷）2026-10-18

> 上一轮：`docs/SITIAN_HANDOFF_20261018_ROUND7.md`（③ 自动河流遗留：路由四候选被否 + 推演地形有结构）。
> 本轮做上一轮交接 §6 排在最前的 **④ 星系表现层 bug**（侦察结论在 §6 那张表里）。
> 暮雨本轮没有再追加要求；§6 的建议顺序是「右键门控 → 势力改色 → 星域可命中 → 坐标链路」。

---

## 0. 先说结论

| # | 事 | 结果 | 判据 |
|---|---|---|---|
| ① | 坐标拖拽是**死代码**（提示文案骗人） | **接通**（照 `SystemView` 的形态补「拖手 / 移动」工具） | `test_116` f4：拖手模式 Δ=0（对照）/ 移动工具 Δ=(60.0,39.5) 期望 (60,40) / `userMoved` 真 / 一次 undo 复原 |
| ② | 势力改色既不重绘也不落库 | **修**（单一取色口 + 预览/落库分流） | f2：预览像素变化 418025 / **布局快照**=新色 / 节点 `factionColor` 落库 / 一次 undo 复原 |
| ③ | 星域在编辑模式下不可命中 | **修**（点落在边界多边形内 → `{type:'domain'}`） | f3：`hitType=domain` / 右键菜单含「删除该节点」/ 节点数 120→119→120（一次 undo） |
| ④ | 右键不看 editMode | **修**（`GalaxyMap` + `SystemView` 各一行） | f1：浏览态 0 项 / 编辑态 2 项 / 点空白收起 0 项 |
| ⑤ | `color + '12'` 拼 alpha 对 `hsl()` 是**非法 CSS**（静默沿用上一个颜色） | **修**（新 `utils/colorUtil.js` = 唯一实现；`InteriorView` 同族写法一并改） | Node `test_color_util.js` **8/8**（含"拼接必须非法"的反向探针） |

⚠️ **据实说的两处"文档校正"**：`SystemDetailView` 的右键门控**早就有**（那一层不是 bug，是本次的对照组）；
`当前视图` 的 PNG/SVG 导出与画布**同源**，只有「导出 PNG(全图)」是第三套实现。

## 1. 各条的修法与踩到的判据坑

### ① 坐标拖拽：从"文案承诺"到"真的能拖"
- 事实：`onDragStart` 从不返回 `{mode:'node'}` → `onDragMove/onDragEnd` 的两条分支不可达、`isDraggingMultiple` 恒 false。
- 修法：浏览态补两个工具（与 `SystemView` 同形）——**拖手**（默认，防误触）/ **移动**（`data-testid="galaxy-move-tool"`）。
  `move` 下拖恒星 → `beginNodePositionCapture` + `{mode:'node'}`；多选（>1 选中）→ `beginMultiNodePositionCapture`；
  收尾 `endNodePositionCapture()`（置 `userMoved` + **一条 undo**）。**两条死分支就此复活**。
- 🔴 **判据坑（我自己踩的）**：拖拽把 `coordinate` 设成"它**画在**的地方 + 位移"——
  自动布局的恒星画在**布局坐标**上（实测 (737,31) 的 coordinate vs 画出来的 (95.5,−600.4)）。
  第一版拿 `g.x` 当基准 → 它被拖拽**就地改掉**了 → Δ 恒为 0 的**假红**。**基准必须先快照**。

### ② 势力改色：三个消费者，一个取色口
- 事实：`setFactionColor` 只写组件局部 ref；键还用 `domain.faction`，而真实库该值是 `undefined`
  → 所有星域共用一个键「undefined」，**改一个色 = 改全部**。
- 修法：`resolveDomainColor(domain)`（override（**按 domain.id**）→ 节点 `factionColor` → 名字哈希）＝ 图例 / 布局 / 边界三处**唯一取色口**；
  `input` → `previewFactionColor`（内存 + `applyStableLayout()` + `requestRender()`，不落库），
  `change` → `commitFactionColor`（`store.updateNode(id, { factionColor })` = 有闸门 + 一条 undo，随 `entityExtras()` 进项目文件）。
- 🔴 **两条判据坑**：①**只重绘不重排**会"画布变了、颜色还是旧的"（渲染恒星读的是布局期副本）→ 判据必须**分别**打在
  "预览后布局快照是新色"与"像素确实变"上；②快照必须**在 `input` 之后、`change` 之前读**——
  反向验证实测：读晚了（`change` 已重排）这条判据**永远绿**。

### ③ 星域可命中
- 事实：`hitTest` 只返回 `galaxy`/`domain-label`/`boundary-vertex`，而 `domain-label` 被 `!editMode` 门控
  → 编辑模式下星域**一个分支都命中不到**，`type === 'domain'` 的四处消费（锁定 / 选中 / 右键目标 / 删除菜单项）**全是死代码**。
- 修法：编辑模式补「点落在势力边界多边形内 → `{type:'domain', node, border}`」（`pointInPolygon` 射线法）。

### ④ 右键门控
- `GalaxyMap.onContextMenu` / `SystemView.onContextMenu` 首行补 `if (!editMode.value) return;`（照抄 `SystemDetailView` 的既有写法）。
- 判据用**真实 `contextmenu`**（合成 `click{button:2}` 绕不过真机路径 —— test_88 的教训）。

### ⑤ 颜色 alpha（顺带修掉的静默缺陷）
- `border.color + '12'` 只对 6 位 hex 成立；`getFactionColor()` 对**不在硬编码表里的势力名**返回 `hsl(...)`
  → `hsl(210, 70%, 60%)12` 是**非法 CSS**，`fillStyle`/`addColorStop` 被**静默忽略**（沿用上一个颜色 = 星域颜色串了，不报错）。
  真实库的势力名必然不在表里 → **必然走到**。
- 修法：新 `utils/colorUtil.js`（`parseColor` / `withAlpha` / `toHex6`），GalaxyMap 七处 + InteriorView 一处改走它；
  `withAlpha` 吃历史写法（`'12'` = 两位十六进制 ≈7%、`'FF'`=100%）也吃小数。
  ⚠️ 写的时候自己踩了一条：`parseColor` 把 CSS 里的 `1` 当成"单字符十六进制"读成 1/15 ——
  **CSS 的 alpha 分量永远是十进制**，已拆出 `cssAlpha()` 并有用例守。

## 2. 判据与机器基线

- **新增 CDP 用例** `scripts/tests/cases/test_116_galaxy_bugs.py`（f0 源码闸门 + f1~f4 四段真事件驱动），
  每段都带**反向对照**（浏览 vs 编辑、拖手 vs 移动、预览 vs 落库）。
- **新增 Node 单测** `scripts/tests/unit/test_color_util.js`（8 条）→ Node 文件数 **34 → 35**；CDP 用例 **115 → 116**。
- **反向验证（一枚一验，都是临时改坏再跑）**：
  - 去掉 `hitTest` 的星域分支 → **f3 四条具名红**（`hitTest 返回 null` / 没有「删除该节点」项 / 节点数没减 / 命中到别的节点），
    且带回现场 `["删除控制点","删除航道"]` —— 说明那个位置原本命中的是**航道**，星域确实点不到；
  - 去掉预览的 `applyStableLayout()` → **f2 根因判据红**（`预览后布局快照没跟上：#6b5b95`）。
- 收尾读数见 §5。

## 3. 本轮改动清单

- **新增**：`src/renderer/src/utils/colorUtil.js`、`scripts/tests/unit/test_color_util.js`、
  `scripts/tests/cases/test_116_galaxy_bugs.py`
- **改**：`components/GalaxyMap.vue`（提示文案 / 拖手·移动工具 / `interactionMode` / 取色单源 + 预览·落库 /
  `hitTest` 星域分支 / `pointInPolygon` / 右键门控 / 拖动链路 / 七处 `withAlpha`）、
  `components/SystemView.vue`（右键门控）、`components/InteriorView.vue`（`withAlpha`）、
  `AGENTS.md`（新增本轮条目 + 用例数 115→116、Node 34→35）
- **没动**：`utils/colorUtil.js` 之外的颜色代码、导出链、星域位置布局

## 4. 本轮**没做**的（据实说，都已写进 AGENTS）

1. **星域位置持久化**（原 6 bug 里的第 3 条）：`applyStableLayout` 里星域永远按 index 环形现算、`radius:350` 硬编码，
   **既不读也不写** `star_domain.coordinate`（星系那条分支早就有 `userMoved + coordinate` 的语义）。
   要动它得先定 `userMoved` 语义 + 旧数据遗留坐标的迁移判定 —— **属数据层，建议单独一轮**。
   （本轮 UI 上明确说了"星域位置目前由布局决定、不可拖动"，不留假动作。）
2. **导出 PNG(全图) 与画布同源**（第 4 条）：`App.vue` 里那套是第三套实现（坐标源 / 势力配色 / 凸包扩张 / 星云都不同）。
   修法是把 GalaxyMap 的绘图层抽成 `utils/galaxyDraw.js` 共用 —— 跨文件重构，先落"禁止第二套配色/凸包"的源码守卫再动。
3. **`faction` 真写入路径**：本轮只落了**表现层**的 `factionColor`（改色能存、能跨视图活）。
   真正的"势力系统"要 UI 入口（如详情面板）+ 提取器读 frontmatter + 迁移。
4. **三处未登记的写口**（`test_54` 的函数级契约同类缺口）：
   `GalaxyMap.setBorderPoints` 直写 `store.domainBorderOverrides`（无 `guardWrite`、未登记）；
   `geodata.removeHyperlane` / `updateHyperlane` 先改内存再 `execute` 且**首行无 `guardWrite`**。
   ⚠️ 这三处**只读态能改内存**（保存时才被拒）—— 与「内存编辑也要收口」那条纪律不符，建议下一轮补。

## 5. 收尾读数（实测）

- **全量 CDP**：**116/116 通过**（`py -3 -u scripts/tests/run_tests.py`）；新增的 `test_116` 在整跑里同样绿
  （f1 浏览 0/编辑 2/收起 0 项 · f2 预览 418025 像素 + 落库 + undo · f3 `hitType=domain` + 120→119→120 ·
  f4 拖手不动（对照）/ 移动工具 Δ=(60.0,39.5) 期望 (60,40)）
- **Node 单测**：**35/35 文件全过**（新增 `test_color_util.js` 8/8）
- **`npm run build`**：通过（`dist/` 已重建）
- **`docs/ARCHITECTURE_MAP.md`**：已再生成（296 个文件）
- 收尾卫生：无临时文件残留（本轮没生成出图产物；判据全部落在 `test_116` 与 `test_color_util.js` 里）

## 6. 目标达成度（据实说）

本目标要求 ④ = 「星系表现层 **6 个** bug + `faction` 写入路径」。本轮：
- **4 个 bug 已修并有判据**（上表 ①②③④ —— 也就是侦察报告建议的"一批修完"那四条）；
- **2 个 bug 未修**（星域位置持久化 / 导出与画布同源），原因与前置条件写在 §4；
- **`faction` 只落了表现层一半**（改色能存、能跨视图活）；"真写入路径"（UI 入口 + 提取器字段 + 迁移）未做。

⇒ **目标未完成**，继续留在下一轮（建议先做 §6 的第 1 条：三处未登记写口 + `guardWrite`）。

## 6. 下一步（按价值排序）

1. **补那三处未登记的写口 + `guardWrite`**（小、判据清晰、属"静默丢数据"类，`test_54` 会一起守）；
2. **星域位置持久化**（数据层：`userMoved` + 迁移判定 + `applyStableLayout` 读回）；
3. **导出与画布同源**（抽 `utils/galaxyDraw.js`，先上源码守卫）；
4. **行星视图观感**（暮雨点名：轮廓模糊 / 颜色瘆人 / **"神秘轮廓爬行"**）——
   最后那条像**渲染残留/脏矩形**那类真 bug（第六轮出图时抓到过同族问题），建议先诊断再修；
5. **`ScenarioMap.vue` 10200+ 行**技术债；
6. **验收指南**：仍是「整个历史剧本模块收口后再单独出」。
