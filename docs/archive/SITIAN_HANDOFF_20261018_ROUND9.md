# 司天：第九轮（④ 收尾：星域位置持久化 + `faction` 写入路径 + 三处未登记写口）2026-10-18

> 上一轮：`docs/SITIAN_HANDOFF_20261018_ROUND8.md`（④ 的前四条：右键门控 / 势力改色 / 星域可命中 / 坐标链路 + 颜色 alpha）。
> 本轮把 ④ 剩下的两件（**星域位置持久化**、**`faction` 写入路径**）做掉，并补上一轮侦察出的**三处未登记写口**。

---

## 0. 结论

| # | 事 | 结果 | 判据（`test_116` 第 5~7 段） |
|---|---|---|---|
| 1 | **星域位置不持久**（原 6 bug 的第 3 条） | **修**：布局只在 `userMoved`（或拖动期）才采信 `coordinate`；星域可拖、位置可存 | 初始布局在环形上（\|pos\|=630）且**不等于**遗留坐标；拖动 Δ=(50,40) 期望 (50,40)；用户 `userMoved=true`；**该星域下未手动摆过的恒星 Δx=50 跟着走**；一次 undo 后坐标、`userMoved`、环形位置全部还原 |
| 2 | **`faction` 无写入路径**（表现层这一半） | **修**：图例里每个星域一个「势力名」输入 → `updateNode` 落库 → 配色按名字自动分开 | `#6b5b95 → hsl(125,70%,60%)`、画布 17655 像素变化、`node.faction` 落库、一次 undo 复原 |
| 3 | **三处未登记写口**（上一轮侦察发现） | **修**：`removeHyperlane` / `updateHyperlane` 首行 `guardWrite`；新增 `setDomainBorderPoints` 唯一写口（原来组件直写 store ref：无闸门无 undo） | 只读态写口被拒且**零副作用**；可写态一条 undo 把顶点还原；三者都进 `MEMORY_WRITE_CALLSITES`（id 10/11，`test_54` 反向扫描也守） |

## 1. 星域位置持久化：为什么"看起来小、其实有坑"

- **数据事实（必须先量）**：提取器给**每个**星域都写了 `coordinate`（实测 fixture **8/8** 都有），
  但那是"文件夹扫描时的遗留值"、从没人摆过。**无条件采信 = 老项目一次性全部错位**。
  → 所以持久化的关键不是"读 coordinate"，而是**读之前判 `userMoved`**（判据：初始布局必须仍在环形上、
  且不等于遗留坐标）。
- **拖动的手柄是名称标签**：浏览态鼠标落在星域中心命中的是 `domain-label`（标签盒），编辑态才是
  `domain`（多边形命中）—— 两个都要接，否则"拖域中心"会走成平移。
- **整簇移动**：拖动中写 `coordinate` 并 `applyStableLayout()`，该星域下**未手动摆过**的恒星按
  `parentDomain.x + 偏移` 重算 → 整簇跟着走（已被手动摆过的恒星保留自己的绝对坐标，文档写明）。
- 🔴 **顺带修掉一个真缺陷：`userMoved` 必须一起进 undo/redo**。
  `endNodePositionCapture` 原先把它写在 `execute()` **外面** → 撤销只还原坐标、`userMoved` 仍是 true
  → **撤销后节点瞬移到那个从没显示过的遗留坐标**（拖动一个从未摆过的节点时最明显；
  判据：撤销后坐标回旧值 + `userMoved` 回旧值 + 重排回环形）。`endMultiNodePositionCapture` 同样处理。

## 2. `faction` 写入路径（表现层这一半）

- 事实：`faction` 此前**一个写口都没有**（提取器不产、建笔记不写、store 无 setter）
  → `getFactionColor()` 恒走 `!faction → '#6b5b95'` → 图例/画布/鹰眼/**全图导出**全是同一个默认色，
  "势力区分"能力为零。
- 现在：图例里每个星域一个 `legend-faction-input`（占位「势力名」），`change` → `commitFaction`
  → `store.updateNode(id, { faction })`（**有闸门 + 一条 undo**；同值 = 空操作不压栈）→
  配色经 `resolveDomainColor` 自动按名字分开。
- ⚠️ **仍未做**：提取器读 frontmatter（如 `阵营:`）、迁移、势力系统本身（UI 列表 / 势力色板 / 势力在两个模块间的共享）。
  这些要先定"势力"这个数据概念的归属，**不在表现层能拍**。

## 3. 三处未登记写口

| 写口 | 原先 | 现在 |
|---|---|---|
| `geodata.removeHyperlane` | 先 `splice` 再 `execute`，首行无守卫 | 首行 `guardWrite('删除航道')` |
| `geodata.updateHyperlane` | 先 `Object.assign` 再 `execute`，首行无守卫 | 首行 `guardWrite('更新航道')` |
| `GalaxyMap` 的势力边界 | 组件直写 `store.domainBorderOverrides[id]`（**无闸门、无 undo**：只读态拖顶点静默改内存） | 新增 `geodata.setDomainBorderPoints(domainId, points, { preview })` ＝**唯一写口**；组件只调它 |

`{ preview: true }` 是拖动期的**起始快照**：过闸门但**不压栈** —— 否则"拖一个顶点"会变成两条撤销
（一条起始快照、一条提交），用户按一次撤销看不到变化。提交那一次才 `execute`（一条 undo）。
三者都登记进 `writeGate.js` 的 `MEMORY_WRITE_CALLSITES`（id 10 / 11）。

## 4. 判据与反向验证

`scripts/tests/cases/test_116_galaxy_bugs.py` 从 4 段扩到 **7 段**（f0 源码闸门 + f1~f7），f5~f7 是本轮新增。
**两轮反向验证（临时改坏再跑，一枚一验）**：

- **① 拆掉星域持久化的两道门**（布局无条件采信 coordinate + 撤销不还原 userMoved）→ **四条具名红**：
  「初始布局用了遗留 coordinate (737,131)」「星域没落在环形布局上（749 vs 630）」
  「一次 undo 没把 userMoved 还原」「撤销后重排没回到环形布局」；
- **② 拆掉 faction 落库 + 边界写口闸门** → **六条具名红**：源码闸门「势力名没有走 updateNode 落库」
  + f6「势力名没落库」「配色没变」「仍是默认色」+ f7「只读态写口没有拒绝」「只读态竟然写进了 domainBorderOverrides」。

### 本轮踩到的两条**判据自身的坑**（都写进用例注释了）

1. **基线必须规范化**：f4 拖动恒星后撤销，撤销只改数据、**不会触发重排**（组件没有 watch 撤销栈）
   → 布局副本里还留着那次的拖动位置。f5 拿它当基线，得出"恒星没跟着走 Δx=-10"的**假红**；
   实测诊断（`galCoord/domainBefore/domainAfter`）才看清：产品行为是对的，基数是陈旧的
   → f5 开头先 `applyStableLayout()` 规范化。
2. **手柄类型**：浏览态命中星域得到的是 `domain-label` 而不是 `domain` —— 只接 `domain` 的话
   "拖域中心"会走成平移（源码闸门里专门钉了这一条）。

## 5. 收尾读数（实测）

- **全量 CDP**：**116/116 通过**（`py -3 -u scripts/tests/run_tests.py`）；`test_116` 七段全绿：
  f5 环形 `|pos|=630` / 拖动 Δ=(50,40) / 恒星 Δx=50 / 撤销后 `|pos|=630`；
  f6 `#6b5b95 → hsl(125,70%,60%)` + 画布 20445 像素变化；f7 只读被拒零副作用 + 一条 undo 还原 + 收尾清键
- **Node 单测**：35/35 文件全过
- **`npm run build`**：通过（`dist/` 已重建）
- **`docs/ARCHITECTURE_MAP.md`**：已再生成（296 个文件）
- 反向验证两轮（各 4 条 / 6 条具名红）见 §4

## 6. 目标达成度（据实说）

原目标 ④ = 「星系表现层 **6 个** bug + `faction` 字段写入路径」。到本轮为止：

| 6 个 bug | 状态 |
|---|---|
| ① 画布改坐标死代码 | ✅ 第十修（拖手/移动工具接通） |
| ② 势力改色不重绘 | ✅ 第十修（预览重排 + 落库 + 单一取色口） |
| ③ 星域位置不持久 | ✅ **本轮**（`userMoved` 门 + 拖动接通 + 撤销语义） |
| ④ 导出与画布不同源 | ❌ **仍未做**（`App.vue` 第三套实现；修法见 §6 第 1 条） |
| ⑤ hitTest domain 不可达 | ✅ 第十修 |
| ⑥ 右键不查 editMode | ✅ 第十修 |

`faction` 字段：**写入路径已存在**（图例输入 → `updateNode` → 项目文件，带闸门与一条 undo）；
提取器字段 / 迁移 / 势力系统本身未做（要先定数据概念归属）。

⇒ **目标还差 1 条**（导出与画布同源），goal 继续留给下一轮。

## 6. 下一步（④ 只剩最后一条）

1. **导出 PNG(全图) 与画布同源**（原 6 bug 的第 4 条，也是 ④ 唯一剩下的）：`App.vue` 的
   `handleExportFullPNG` 是**第三套实现**（坐标源用 `node.coordinate` 而画布用布局坐标；势力配色按名字哈希
   而画布用 `resolveDomainColor`；凸包扩张 25 vs 50；星云重掷）。修法：把 GalaxyMap 的绘图层
   （`drawStarfield` / `drawFactionBorders` / `drawHyperlanes` / `drawGalaxyNodes` / `convexHull` / 取色）
   抽成 `utils/galaxyDraw.js` 供两侧共用；**先上源码守卫**（`App.vue` 不许再出现 `getDomainColorForExport` /
   `convexHullForExport` / 自带 nebula 常量），再动实现。判据建议：同一相机下导出 PNG 与画布
   `toDataURL` 逐像素近似（或按区域比对）。
2. **`faction` 的另一半**（提取器字段 + 迁移 + 势力系统）——要先定数据概念归属。
3. **行星视图观感**（暮雨点名：轮廓模糊 / 颜色瘆人 / **"神秘轮廓爬行"**）——
   最后那条像**渲染残留/脏矩形**类真 bug，建议先诊断。
4. **`ScenarioMap.vue`** 技术债；**验收指南**仍等历史剧本模块收口。
5. ⚠️ **本轮未改的已知毛边**：撤销一次移动后，自动布局的节点要等下一次重排才回位（组件不 watch 撤销栈；
   数据正确、画面滞后）。要修就给它一个"撤销/重做后重排"的钩子（watch undo 栈的深度或指纹）——
   本轮为控制面没有动，记在这里免得下一轮当成新 bug 重新查。
