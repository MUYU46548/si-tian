# 司天：第七轮（自动河流遗留 ③ —— 路由四个候选被否 + 推演地形有结构）2026-10-18

> 上一轮：`docs/SITIAN_HANDOFF_20261017_ROUND6.md`（行星视图 `.map` 导入 + 保存诚实）。
> 本轮做的是上一轮交接 §6 排在最前的 **③ 自动河流遗留**（路由层平局打破 + 推演地形要有山脉走向/高原面/裂谷）。
> 暮雨本轮的原话仍是「继续帮我做剩下内容」；另加一句**范围声明**：
> 「行星地图视图下依然很丑，轮廓模糊 + 颜色瘆人 + 神秘轮廓爬行。不过这不是历史剧本模块的施工范围，你知道一下就行。」
> → **本轮没碰行星视图观感**（只记在 §6 待办里）。
>
> 两份过程文档（本文是索引，数都在那两份里）：
> - `docs/RIVER_ROUTING_NEGATIVE_RESULTS_20261018.md` —— 路由层四个候选的**实测否定**结论
> - `docs/RIVER_TERRAIN_STRUCTURE_20261018.md` —— 推演地形 v2 的结构与判据
> 观感存档：`docs/assets/terrain-structure-20261018/`（v1/v2 的地形与水系各一张 SVG）

---

## 0. 先说结论

| 事项 | 事实 | 判据 |
|---|---|---|
| ① 交接把「路由层平局打破」当 ③ 的第一件 | **用数否掉了**：平局打破（哈希）、最小代价出流、双线性放大 2~8×、放大＋分形细节 —— 四种口径对河网几何**都没有改善** | 链节中位 **26u 四位小数都不动**；`_probe_routing_v2.mjs` |
| ② 那"河太碎"由什么决定 | **这份高度图本身的信息量**（2876 陆格 / 格距 14.4 / 高程量化 0~100）。要更长的河只有两条路：换源数据（用户已否）或**自己推演出更好的地形** | 同上 |
| ③ 推演地形 v2：山脉走向 / 高原面 / 裂谷 | **做出来了**，默认生效 | Node `test_terrain_structure.js` **15/15** |
| ④ 结构带来的排水改善 | 最长主河 **737/870/779u → 1645/1941/1701u**；汇流上界 **333~430 → 1073~1329** | 同上一枚用例的 b1/b2 |
| ⑤ 判据自身踩了四个坑 | 各向异性要在**高频残差**上算、裂谷要**走廊带 vs 对照带**、高原面要**连片规模**、高原检测不能只扫"深内陆" | 每条判据都带 v1 反向对照（c7：v1 在 9/9 条上红） |

---

## 1. ③ 的河流侧：四个候选**全部**被否（有数）

判据换成**与分辨率无关的"链节长度"**：从每格沿流向下游走到**下一个汇流点（入度≥2）或河口**的世界距离。
（⚠️ 我第一版用产品 `buildRiverPaths` 的链统计做对比，得出过"放大 3 倍就把短棍消掉了"的**假结论** ——
原因是它按流量截到 `maxPaths=1200`，细网格下只统计流量最高那批，中位链长被系统性拉高。这条写进 AGENTS 了。）

| 口径（真实 `desite` 底图） | 链节中位 | < 20u 占比 |
|---|---|---|
| 现状（水位→高度→格号） | 26u | 26% |
| 平局 → 空间哈希抖动 | 26u | **35%**（更碎） |
| 最小代价出流（Dijkstra from outlets） | 26u | 28% |
| 双线性放大 2×/3×/4×/6×/8× | **26u（一位不动）** | 36~42% |
| 放大 3× + 分形细节 amp=2/4 | **17u / 15u** | 58% / 65% |

**结论**：路由层不是杠杆。文件里那张"梳齿"的说法在数据上也站不住（轴对齐直链指数实测 0.2%）。
详见 `docs/RIVER_ROUTING_NEGATIVE_RESULTS_20261018.md`。

---

## 2. ③ 的地形侧：推演地形 v2（本轮真正的施工件）

`utils/terrainSynthesis.js` 在**同一个骨架**（离岸距离场 + chamfer + priority-flood 填洼）上叠三样成因：

1. **山脉走向**：各向异性脊线噪声（垂直走向频率 8.5 vs 沿走向 2.6），叠次走向（0.12）+ 域扭曲（0.16）；
2. **高原面**：低频场**按 p62~p80 分位**圈地 → 强混合（0.92）到同一个面，面内只留 0.015 残差；
3. **裂谷**：1~2 条由 seed 决定的折线（走向跟着山脉 ±15°）+ 距离剖面下切（深度 0.26、半宽 0.055）。

| 指标（3 个 seed） | v1 对照 | v2 结构 |
|---|---|---|
| 各向异性（高频残差结构张量） | 4.4% / 17.8% / 3.7% | **70.1% / 76.3% / 35.3%** |
| 走向误差（量出 vs 自述） | — | 5° / 12° / 19° |
| 高原面最大连片平高块 | 70 / 20 / 114 格 | **221 / 260 / 470 格** |
| 裂谷下切（走廊 − 对照，高度单位） | 2.2 / 0.7 / 0.5 | **8.0 / 12.9 / 6.7** |
| 最长主河 | 737 / 870 / 779u | **1645 / 1941 / 1701u** |
| 汇流上界 | 430 / 333 / 430 | **1147 / 1073 / 1329** |
| 陆地均值 / >60 占比 | 46,45,48 / 7,11,20% | 44,42,44 / 18,15,21% |
| 单次推演 | — | 14~28ms（7081 格，test_109 实测追踪 404ms） |

🔴 **三条踩过的硬口径**（都写进代码注释 + 用例注释）：高原掩膜**必须按分位**（固定阈值实测圈住 64% 陆地
→ "处处是高原"= 没有高原）；裂谷**走向必须跟着山脉**（随机取向后走向判据实测差 49°）；
裂谷**落点要用 `spanY/spanX`**（否则放到陆地外面，判据量空气）。
🔴 **高度预算**：结构权重第一版把陆地均值从 45.6 抬到 63.1、**85% 陆格在源头闸门（60）之上** → 一点自动河流
就是 2400 个源头；现在压回与 v1 同量级，有判据守（c3）。

接线：**默认开**；`structure:false` 只给对照组（且不带 `structure` 自述字段）；
`synthesizeBaseMapTerrain` 的回执加一句结构自述（走向 / 裂谷数 / 高原格数）——否则用户以为还是老样子。

---

## 3. 判据与机器基线（本轮收尾实测）

- **新增 Node 单测**：`scripts/tests/unit/test_terrain_structure.js` —— **15 条**，含
  a1/a2/a3/a4（结构，每条带 v1 反向对照）、b1/b2/b3（排水）、c1~c8（不变量 / 确定性 / 高度预算 / 性能 /
  自述字段 / 退化输入 / 反向探针 / 裂谷几何）→ **15/15 通过**；Node 文件数 **33 → 34**；
- **CDP**：`test_109_self_built_river` 单跑通过（源码闸门 6 组 + 推演 7081 格 / 追踪 404ms → 河 457 条 /
  段 4653 / 汇流上界 1154 / 最长路径 67；对照组全 0 平地 = 0 条，判别力在场）；
- **全量回归**：见 §5 的收尾读数（本轮跑完即填）；
- **`npm run build`**：见 §5。

探针与出图（临时件，`scripts/tests/tools/`）：
`_probe_routing_v2.mjs`（路由四口径 + 链节度量）、`_probe_terrain_structure.mjs`（结构/排水度量）、
`_render_terrain_structure.mjs`（纯 Node 出 SVG，无依赖，产物进 `docs/assets/`）。

---

## 4. 本轮改动清单

- **新增**：`docs/RIVER_ROUTING_NEGATIVE_RESULTS_20261018.md`、`docs/RIVER_TERRAIN_STRUCTURE_20261018.md`、
  `scripts/tests/unit/test_terrain_structure.js`、`scripts/tests/tools/_probe_routing_v2.mjs`、
  `scripts/tests/tools/_probe_terrain_structure.mjs`、`scripts/tests/tools/_render_terrain_structure.mjs`、
  `docs/assets/terrain-structure-20261018/{README.md,v1-terrain.svg,v1-rivers.svg,v2-terrain.svg,v2-rivers.svg}`
- **改**：`src/renderer/src/utils/terrainSynthesis.js`（v2 结构地形；`TERRAIN_SYNTHESIS_VERSION = 2`；
  `TERRAIN_STRUCTURE` 参数单一事实源；导出 `makeRiftSegments` / `rangeAxisFromSeed`）、
  `src/renderer/src/store/geodataModules/scenarioEditing.js`（生成地形的回执加结构自述 + 回报 `structure`）、
  `AGENTS.md`（新增本轮条目 + Node 用例数 33 → 34）
- **没动**：行星/星系的任何渲染代码；路由层**一行没改**（四个候选被否，改它没有依据）

---

## 5. 收尾读数（实测）

- **全量 CDP**：**115/115 通过**（`py -3 -u scripts/tests/run_tests.py`，收尾第 5 步清理环境完成）；
  与本轮相关的三条读数：`test_109`（自建底图长河）推演 7081 格 / 追踪 399ms → 河 457 条 / 段 4653 /
  **汇流上界 1154**；`test_103`（自动河流）地形 75×75 / 点一次 2072 条 318ms（走导入高度图，未受影响）；
  `test_110`（可发现性）按钮「按轮廓生成地形」在位。
- **Node 单测**：**34/34 文件全过**（含新增 `test_terrain_structure.js` 的 **15/15**）
- **`npm run build`**：通过（`dist/` 已重建）
- **`docs/ARCHITECTURE_MAP.md`**：已再生成（294 个文件）
- 收尾卫生：无临时 `.map` / mock / 日志残留；探针临时脚本留在 `scripts/tests/tools/`（本仓惯例，
  是"证据链"而不是垃圾）；诊断用的 `_dbg_plateau.mjs` 已删

⚠️ **本轮发生的一次真实事故（写进 AGENTS 了）**：我用 PowerShell 的 `Set-Content -NoNewline` 改
`terrainSynthesis.js` 的四个参数，**把 UTF-8 中文写成了 ANSI（GBK）** → 之后 `import` 直接报
`Illegal return statement`（编码坏了 + 看起来像语法错）。救回来的办法：探针每跑一次都会把依赖源码
拷到 `%TEMP%/sitian-ts-*/`，那一份是干净的 UTF-8（内容对应上一次成功实测的状态）。
**纪律：改源码一律走编辑工具，不用 PowerShell 写文件。**

---

## 6. 下一步（按交接顺序）

**④ P2 星系：6 个表现层 bug + `faction` 写入路径**（本轮已做完**只读侦查**，结论如下，可直接开工）：

| # | 条目 | 侦查结论 | 最小修法 |
|---|---|---|---|
| 1 | 画布改坐标死代码（提示文案骗人） | **真实，但只在 `GalaxyMap`**：`onDragStart` 从不返回 `{mode:'node'}`，两条 `dragInfo?.mode==='node'` 分支不可达；`SystemView:576-583` / `SystemDetailView:1077-1081` 的同款链路是**活的** | 二选一：给 GalaxyMap 加 `move` 工具并接 `beginNodePositionCapture` + `{mode:'node'}`；或删掉 `GalaxyMap.vue:10` 的骗人文案并加源码守卫 |
| 2 | 势力改色不重绘 | **真实**：`factionColorOverrides` 无 watch 无 `requestRender()`，且渲染取色读的是布局期快照（`:369`/`:413`/`:489`）；键用 `domain.faction` 而真实库该值 **undefined** → 所有星域共用一个键「undefined」，改一个色 = 改全部 | `setFactionColor` 内 `applyStableLayout() + renderer.requestRender()`，取色改 override 优先；`change` 时落库走 `store.updateNode(domain.id, { factionColor })`（`factionColor` 不在 `ENTITY_SHAPE_KEYS` → 会随 `entityExtras()` 进项目文件） |
| 3 | 星域位置不持久 | **真实**：`applyStableLayout` 星域永远按 index 环形现算（`radius:350` 硬编码），既不读也不写 `star_domain.coordinate`；而 galaxy 分支（`:392-407`）已经支持 `userMoved + coordinate` | 含数据层语义（`userMoved`）+ 旧数据遗留判定 → **建议放到 bug 5 之后单独做** |
| 4 | 导出与画布不同源 | **只对「导出 PNG(全图)」成立**（`App.vue:795` 第三套实现：坐标源 / 势力配色 / 凸包扩张 / 星云全不一样）；`当前视图` 的 PNG/SVG 两条是同源的 | 把 GalaxyMap 的绘图层抽成 `utils/galaxyDraw.js` 共用；先落"禁止第二套配色/凸包"的源码守卫 |
| 5 | hitTest domain 分支不可达 | **真实**：`hitTest` 只返回 `galaxy`/`domain-label`/`boundary-vertex`；4 处 `type==='domain'` 恒假，且 `domain-label` 被 `!editMode` 门控 → **编辑模式下星域完全点不到** | 编辑模式分支补"点落在 border 多边形内 → `{type:'domain'}`"（这也是 bug 3 的前置） |
| 6 | 右键不检查 editMode | **部分过期**：`SystemDetailView.vue:1145` **已有闸门**；`GalaxyMap.vue:1515`、`SystemView.vue:657` 确实没有 | 首行各加 `if (!editMode.value) return;`；判据**必须用真实 `contextmenu` 事件**（合成 `click{button:2}` 绕不过真机路径，test_88 的教训） |
| + | `faction` 无写入路径 | **真实（星域侧）**：提取器 / 建笔记 / 任何 store 写口都不产 `faction`；唯一写入口是**部队卡片**（另一个对象） | 表现层先落 `factionColor`（bug 2 已含）；真"势力系统"要 UI 入口 + 提取器字段 + 迁移 |

**建议本轮顺序**：6（一行一处，最便宜）→ 2（改色重绘 + 落库）→ 5（星域可命中）→ 1（坐标链路或删文案）。
3 与 4 属"先动数据层/共享层"那一档。

**再往后**：
5. `ScenarioMap.vue` 已 10200+ 行（技术债）；
6. 行星视图观感（暮雨本轮点名：**轮廓模糊 / 颜色瘆人 / "神秘轮廓爬行"**）——
   ⚠️ "神秘轮廓爬行"听起来像**渲染残留/脏矩形**那类真 bug（第六轮出图时抓到过同族问题：
   在渲染器背后改 `mapData` 会留下旧像素），值得单独一轮**先诊断再修**，别只当观感问题；
7. **验收指南**：仍是「整个历史剧本模块收口后再单独出」。
