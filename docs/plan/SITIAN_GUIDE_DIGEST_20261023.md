# 司天·20261023 指南包 —— 仓内对账与施工拆解

> **地位**：这是 `docs/guides/20261023/00-司天-开发指南-20261023.md`（用户交付包，仓内快照）的**仓内摘要 + 与本仓实况的对账**。
> 开工时读这一份就够；细节按下表的"参照件"去翻包内原文。**路线/砍单/验收以包内 00 为准**；本文件只做两件事：① 把"与本仓代码不符的事实"纠正过来；② 把六件拆成"下一步能直接动手的一步"。
> **对账基线**：`HEAD = 56855e4`（分支 `feature/map-editing-rework`，**已推远端**；本地 `main` 已 FF 到同一提交，`origin/main` 仍停在 9f981ad 等用户点头再推），version `0.3.0`，用例 **136/136**（2026-10-23 21:15 在 56855e4 上全量复跑），Node 单测 **50 个文件**。
> **日期**：2026-10-23。

---

## 〇、三分钟速览

1. **总纲**：账本是本体、地图是视图、世界在自己硬盘上。分期纪律：**先本体，后投影；先写，后读，再演。**
2. **施工序（六件）**：0 对账留底 → 1 底盘三件 → 2 散布笔冒烟 → 3 账本引擎 → 4 四笔总装+时间轴+导出 → 5 读料桥 → 6 终验（用户出场一次）。
3. **两个判断题已按保守默认落定**（用户 10-23 18:00 授权默认值）：底盘**串行**先行、散布笔冒烟**采纳**。不需要再问。
4. **真砍的只有 5 项**（AI 生成底图 / "手绘已跑通"类宣称 / 年表 CSV 导入 / "Azgaar 自带历史层" / "vault 纯文本可读"）。**美术与 3D 不是砍，是排队**——等"渲染层接口化"（第 4 件 B6 硬约束）完成，届时自动解锁，不需要新拍板。
5. **本仓与指南包最大的一处错位**：指南包按 `9f981ad`（10-19 远端）写；本仓 `feature/map-editing-rework` 已在它之上 **52 个提交**（2026-10-23 20:55 已推 `origin/feature/map-editing-rework`；本地 `main` 已 FF 到同一提交）。所以指南里标"未动"的病灶，有两条要按本仓实况重判（见 §2）。

---

## 一、施工序与参照件（照 00 第三章）

| 件 | 干什么 | 参照 | 判据（照 00） |
|---|---|---|---|
| 0 | 对账 + 415 孤本留底 + 分支 | 00 §三-0 | git 本地=远端；备份字节数一致；分支已建 |
| 1 | 底盘三件（基帧缓存平移 / 笔刷进脏矩形 / 保存修法②③） | 02 全文 | 连画 30 秒零帧 >50ms（`_probe_jank_real.py`）；保存期照常拖笔无顿挫 |
| 2 | 散布笔冒烟（L1–L2 首落 + 底盘接缝实测） | 03 四层管线、04 散布段 | 赢画图四条及格线 + 输入→上屏 ≤2 帧 + 拖动不掉密度 + 实例可选中可移动 |
| 3 | 账本引擎（`src/ledger/`，纯数据层）+ 笔画对象模型落码 | 05 步 2–3、00 §一-C | 6 项单测全绿（含 400 省×2000 事件回放 <50ms）+ `src/ledger/` 零渲染依赖 |
| 4 | 四笔总装 + 时间轴 + 切片导出 | 05 步 4–6、04 四笔接线图 | 手感五件真机演示；events 节真长（读盘）；导出非空白；拖轴颜色与所录一致 |
| 5 | 读料桥最小闭环（只读知识库 → 点图看设定） | 00 §三-5、01 §六 | 乱目录/乱文件名/缺 frontmatter 的库也能导入；换库不崩 |
| 6 | 终验（用户唯一出场） | 00 §三-6 | 三步齐 + 五件；415 省数据不丢；自测链全绿 |

---

## 二、**仓内实况 vs 指南假设的对账**（最重要的一节）

| # | 指南怎么说 | 仓内实况（2026-10-23 实测/读码） | 结论 |
|---|---|---|---|
| 1 | 基线 `9f981ad`（"10-19 后零新 push"） | `origin/main = 9f981ad` 属实；本地 `feature/map-editing-rework` 比它**多 52 个提交**（10-19~10-23 全部工作：省份矢量化、136 用例、账本 v2、基帧缓存、笔刷建省、指南包入库） | ✅ **已推远端**（20:55，`origin/feature/map-editing-rework`）；本地 `main` 已 FF 到同一提交。**`origin/main` 仍在 9f981ad**，等用户点头再推（见 §7） |
| 2 | 415 省孤本待留底 | `C:\Users\muyu\Documents\SiTianProjects\绒花计划.sitian`，6,502,567 字节；`desite` 地图 **415 省**、13 剧本、36 势力、4968 条归属键、**1668 条 changeEvents**、21 个快照 | ✅ **已留底**：`…\_施工留底\绒花计划-20261023-203520.sitian`，SHA256 与原件一致 |
| 3 | 病灶 #1「保存整块冻结 596ms，修法①已落、②③未做」 | ①属实（`utils/interactionGate.js` 手势闸门在）；②属实：`buildProjectPayload`（`geodata.js:1743`）对 hyperlanes / mapData / editor / baseMaps / scenarios / slicePoints 做 **6 次 `JSON.parse(JSON.stringify)`** | ✅ 照做（修法②③） |
| 4 | 病灶 #3「PlanetMap / AreaMap / InteriorView 无基帧缓存」 | `grep StrokeBase\|baseFrame` 在这三个 SFC 里 **0 命中**；只有 `ScenarioMap.vue` 有 | ✅ 照做（平移） |
| 5 | 病灶 #4「全部笔刷不进基帧/脏矩形」 | `applyCultureBrush` 每次 move：**拷两份通道数组**（`oldCultures`/`newCultures`）+ 全格遍历；`applyHeightBrush` 同类 | ✅ 照做 |
| 6 | 病灶 #7「两侧笔刷不同源」 | 行星侧已有 `usePlanetChannelBrush`（落笔改内存/抬手提交）；剧本侧仍是每 move `execute()` 的快照式写入 | ✅ 照做（照抄自家 channelBrush） |
| 7 | M1 步 4 要"引入 perfect-freehand" | **已在依赖里**（`^1.2.3`），并由 `utils/strokeEngine.js` 薄封装、`ScenarioMap` 的 draw/outline 用来做**中心线稳定器**（T7, 10-19） | 🟡 不用引依赖；但**笔迹层（L2 的渲染）没接**，第 2/4 件接 |
| 8 | 散布笔 = 四笔里耦合最少 | `composables/useReliefBrush.js` 在，接线在 **PlanetMap** 工具栏（relief 系列控件） | ✅ 第 2 件就在它身上做 |
| 9 | 验收工具 `_probe_jank_real.py` 现成 | 在，但**探针驱动需先起 lab**（脚本头注："lab 必须先 up"） | 🟡 第 1 件第一动作是把探针跑通（一条目标→一个探针） |
| 10 | 基帧缓存平移"同构不同域，风险低" | `test_121_map_edit_stutter` 已经把这件事的**判据模板**写好了：源码闸门 + "1 次建基帧 + N 次贴图"计数 + **贴图帧与全量帧逐像素等价** + 相机一动即解甲 | ✅ **判据照 test_121 平移**，每个编辑器一份 |
| 11 | 账本引擎 `src/ledger/`（05 已定 schema） | **`src/ledger/` 不存在**；但仓内已有一套**账本 v2**：`scenario.initialOwnership` + `scenario.changeEvents`（1658 条实测）、`utils/scenarioEventLedger.js`、`scripts/migrate-ledger-v2.mjs`、AGENTS 红线"两本账不双写" | 🔴 **第 3 件开工前必须先定"谁是唯一真源"**（见 §3-①），否则一动手就是双写 |
| 12 | 05 schema：`provinceId: number` / `fromPolityId: number` | 真实数据是 **字符串**：省 `prov_batch_mv3p6m9d_116`、势力 `pol_ou`；`era.startYear` 也是字符串（可负：`"-1350"`） | 🔴 字段名照 05，**类型必须放宽成 string**（见 §3-②） |
| 13 | 05 schema：`day: number`（绝对天） | 现有 `changeEvents` 是 `{y, m?, d?, owner, explicit}`，**无历法、可负年** | 🔴 需要 `CalendarConfig` 做 y/m/d ↔ day 换算并随档保存（见 §3-②） |
| 14 | 顶点编辑器"待裁定：真用得上才保留" | 仓内已相当成熟：共边联动（test_102 + `utils/vertexSharing.js`）、压叠闸门（test_93）、09-27 之后又修过多轮 | 🟡 **建议保留**（不在第 1/2 件动它）；第 4 件后再按"真用得上"复判一次 |
| 15 | 01/00 的"账本=单一事件流，`epochId` M1 恒 default" | 真实项目是 **13 个独立剧本容器**（各自 `ownership`/`changeEvents`，era 起始年互不重叠），不是一个时间轴 | 🔴 见 §3-① 的 epoch 映射决策 |

---

## 三、三个必须先定的口径（不定就动手 = 返工）

### ① 账本是唯一真源，且 **M1 用"每剧本一个账本段"**

- **真源**：`src/ledger/` 的 `{worldId, epochId, day, type, groupId, provenance, payload}` 事件流是**唯一真源**；
  `scenario.initialOwnership` / `scenario.changeEvents` / `scenario.ownership` **降级为投影缓存**（只有一个写者：账本落盘后重算；其它代码只读）。
  这与仓内既有做法一脉相承（`ownership` 本来就是缓存，migrate-ledger-v2 的注释写着"ownership 保留为缓存"），也不违反 AGENTS"两本账不双写"——**缓存不是第二本账**，但必须标 `derived` 且禁止独立写入。
- **epoch 映射**：真实项目有 13 个剧本（瓯/俪/玦/列国/真/南北朝/铉/诸侯割据…），era 互不重叠、各有自己的 ownership。
  强行并成一条流必须先回答"剧本之间怎么排序"——那是 M2（时间线/外交表）的活。
  **M1 采用：一个剧本 = 一个账本段**（`epochId` = 剧本键，`day` = 该剧本内的绝对日），`worldId` 恒 `"default"`。
  **全局统一时间轴留到 M2**，届时只做"段的排序与拼接"，不改事件形状。
- **撤销栈分工**（05 要求 baseline 永不可撤，而仓内 `execute()` 是快照栈）：**归属类编辑走账本组撤（groupId）**，其它工具（几何/河流/道路/剧本元信息）继续走既有 `execute()` 栈；两栈不互相回滚对方，UI 的 Ctrl+Z 按"最后一次操作属于哪个栈"分派。这条要写进 `src/ledger/README` 与 commit 首行。

### ② schema 照 05 的**形状**，按现有数据**放宽类型**（记录理由，不改语义）

```ts
provinceId: string;            // 05 写 number —— 真实数据是 prov_batch_xxx，放宽为 string
fromPolityId: string | null;   // 同上（pol_ou）
toPolityId: string | null;
day: number;                   // 绝对天（可负），由 CalendarConfig 从 {y,m,d} 换算
```
- `CalendarConfig`（`yearLength` 默认 360）**随项目文件保存**——否则同一份账本换台机器换算出的年份会变。
- 旧档迁移：`initialOwnership` → `ledger.baseline`（day 0）；每条 `changeEvents[i]` → 一条 `province.owner.changed`（`provenance: "import"`，`groupId` 按"同一省同一年同一天"聚合）。
- 迁移必须**无损可核对**：迁移前后 `replay(events, +∞)` 与 `ownership` 逐省相等；415 孤本上跑一次（副本）。

### ③ "保存彻底挪出主线程"要拆成两步做，别一步到位

指南要"保存彻底挪出交互主线程"。**技术实况**：数据住在 Vue 响应式 store（主线程），把它搬进 Worker 要先解决"6MB 数据的跨线程表示"，一步做=高风险。
第 1 件先做**两步**，判据不变：
1. **单次序列化**：`buildProjectPayload` 的 6 次深拷贝 → 1 次（其余引用直传，`jsonSafeReplacer` 只走一次）；
2. **IPC 传字符串**：`ipcRenderer.invoke` 传已 `JSON.stringify` 的串（省掉主进程侧的第二次结构化克隆）。
做完再量：若单帧仍 >50ms，才评估 Worker（届时数据形状已经收敛，成本低得多）。

---

## 四、六件拆解（第一步 + 判据 + 风险）

### 第 0 件 · 对账与留底 —— **已完成**
- ✅ 备份 + SHA256 一致；✅ `git fetch` 对账（origin/main=9f981ad）；✅ 在 feature 分支上。
- ✅ **push**（20:55，`origin/feature/map-editing-rework` = 本地 HEAD，逐位一致）；✅ **本地 main 已 FF** 到同一提交；✅ 旧评审分支 `review/a3-online` 经核对（产物已在 main）删分支、留 tag `archive/review-a3-online`。
- ✅ **合并闸门**：HEAD 上全量回归 **136/136** + `npm run build` 通过（2026-10-23 21:15）。
- ⏳ **剩**：`origin/main` 仍是 9f981ad —— 推不推由用户点头（见 §7）。

### 第 1 件 · 底盘三件（串行先行）——**已量基线并重排，见 [CHASSIS_BASELINE_20261023.md](CHASSIS_BASELINE_20261023.md)**
- 🔴 **2026-10-23 实测结论（照原文做会白干）**：PlanetMap 高度笔刷 30s 只有 1 帧 >50ms（p95 19.2ms）→ **搬基帧缓存到 PlanetMap 不做**；剧本侧自由绘制也已达标（p95 17.7ms）。
- **真痛点在另外两处**（同机实测）：
  ① **涂归属**每事件 34ms / p95 117ms（`findProvinceAt` 全表扫 200 省 = 20ms/次，`ownerHitProvinceIds` 5 偏移 = 97ms/次）→ **省份命中加空间索引**，判据：30s 零帧 >50ms、命中 ≤2ms/次；
  ② **松手落库 299~421ms**（其中 `exportCanvasToProject` 168ms = 指南说的"四次深拷贝"同一条，本仓是 6 个容器）→ **单次序列化 + 松手不同步落盘**，判据：松手 ≤50ms 且读盘判据不掉。
- ✅ **1-a 已落地**（2026-10-23）：省份命中改空间索引（`utils/provinceHitIndex.js`）—— 涂归属 34ms/事件 → 0.23ms，10s 零帧 >50ms。
- ✅ **1-b 已落地**（2026-10-24）：**"深拷贝太慢"的真因是 Vue 代理的 get 陷阱**（`toRaw` 后同一份数据 3.3ms vs 65.8ms），
  载荷改为"只换壳不深拷"，深拷贝只留在落盘唯一出口 `toIpcPlain`；`mergeCanvasPayload`/`toIpcPlain`/`deepClone` 一律先去代理。
  读数：`exportCanvasToProject` **164.8 → 1.3ms**、`saveScenarios` 173 → 5.3ms、松手 p50 **257 → 99ms**、
  落盘一次 `saveProject` 585 → 373ms（其中 toIpcPlain 237→57、pushSnapshot 129→32）；读盘判据（保存→关闭→重开）通过。
  ⏳ **松手仍未到 50ms**：余量 = trace 10 + 压叠闸门 16 + **冷重绘 35** + 暂存 5（且一次松手会重绘 3~4 遍，见 baseline §七）。
- ✅ **1-b 收口（2026-10-24）**：按 §七 的定位切**重绘与 deep watch**（不是保存）——
  `watch(baseMap,{deep:true})` 去 deep（底图写入一律换对象，deep 的 `traverse` 77ms/次 纯浪费）+ 自由绘制松手
  不再同步重绘（数据变了的话同一帧的 watcher 本来就会画，原来那次是同一内容画第二遍）。
  **建省松手 p50 257 → 99 → 35.6ms（达标 ≤50）**；一次松手重绘 3~4 遍 → **1 遍**。
  反证走像素：松手后等两帧取画布校验和，再手动 `render()` 一遍必须**完全相同**（成功/取消两分支各验一遍，
  `_probe_land_repaint.js`）；`test_121` 的逐像素等价（683640 像素差异 0）照旧过。
  ⏳ 仍留着：「每画一个省镜头自己重新适屏」（实测 0.3549→0.4894）—— 属**镜头语义**，单独一刀。

- **AreaMap / InteriorView 先量再定**（探针模板已就绪），没量出 >50ms 帧就不动 —— 防"没病吃药"。
- ✅ **1-c 已量（2026-10-24）：两处都不需要做**——
  区域笔刷连涂 20s：1200 帧满帧、p95 18.6ms、**零帧 >33ms**、handler 0.10ms/事件（凸包在松手才做一次）；
  拖家具 10s：p95 18.3ms、handler 0.13ms，窗口里那 2 帧 >50ms **在"什么都不拖"的对照组里同样出现**
  （同刻、76ms）→ 归因是后台 800ms 防抖落盘，不是拖拽。
  ⤷ 顺带留证：那次落盘仍是一整块 ~380ms 主线程工作 → 下一刀 = **IPC 传字符串**（省主进程 stringify + 3.6MB 结构化克隆），
  再定要不要搬 Worker。
- 复现命令与读数表在 baseline 文件里（含一个假基线教训：不开编辑模式时 30s 拖拽一个格都不涂）。

### 第 2 件 · 散布笔冒烟（L2 首落）
- **第一步**：在 `useReliefBrush` 上加"拖动中真笔迹 + 松手消失"的渲染层（纯渲染、零写口），复用 `strokeEngine`（perfect-freehand）出笔迹多边形。
- **判据**：四条及格线（按下即出痕 / 拖动零确认零校验 / 松开即定稿 / 一笔一条 undo）+ 输入→上屏 ≤2 帧 + 拖动密度不掉。
- ✅ **第一步已落（2026-10-24）**：`planetDrawing.drawReliefTrail` + `PlanetMap` 先轨迹后图标 + 松手/取消 `markFullRedraw` 收口。
  判据走**像素 + 拖动中截图**（`_probe_relief_trail.py`）：松手瞬间 8258 像素变暗（= 轨迹被擦掉）、图标 0→16、undo「散布地貌图标」；
  10s 连拖 597 帧 / p95 18.7 / 1 帧 >50ms（基线 596 / 18.2 / 1，持平），handler 0.27ms/事件。
  ⏳ 剩：「实例可选中可移动」+ 其余三支笔接线（指南 04 §二）。
- ✅ **镜头语义一刀（2026-10-24）**：`watch([baseMapKey, terrain.length])` 只在**换底图**时适屏，
  同一张图上增减省份一律只重绘（原来只豁免笔刷建省）。判据：画一个省后镜头**一位不动**
  （`{67.6, -53.5, 0.3549}` → 同一组数，原先是 0.3549→0.4894 自己跳）；换底图/导入的适屏各有显式
  `fitToView()` 兜着（test_61 / test_96 / test_94 全绿）。
- **风险**：L2 与基帧缓存的层叠顺序（笔迹层必须在基帧之上、标注之下）——第 1 件做完再动，顺序反了会白改。

### 第 3 件 · 账本引擎（纯数据层）+ 笔画对象模型
- **第一步**：`src/ledger/` 五件（schema / replay / group undo-redo / migrate / index），先写 6 项单测再写 UI 接线；**第 3 件不碰任何 SFC**。
- **笔画对象模型也在这件落码**（00 §一-C 三处改法，防"先做 UI 后补模型"的返工炸弹）：
  ① **落事件不落状态**：笔画产出 `{strokeId, generator, params, rawPoints, geometry}`，落盘落这个对象+生成参数；
  ② **原始点与简化参数都存**（RDP 结果只是生成物，原始点才是回放/重调参的依据）；
  ③ **命名拆开**：轮廓勾画（矢量路径）/ 地形笔刷（笔画填充）/ 散布笔刷（实例分布）——三者共用对象模型，但生成器与验收标准不同；**不拆开派工，agent 会把"轮廓勾画"当"笔刷"做完**。
- **判据**：6 项单测全绿（含 400×2000 <50ms + baseline 不可撤 + 旧档迁移逐省一致）；`src/ledger/` 不 import 任何 `vue`/`store`/`components`；笔画对象过一遍"原始点→简化→回放"往返逐点一致。
- **风险**：与既有 `scenarioEventLedger` 的双源（§3-①）；迁移在 415 孤本副本上跑。

### 第 4 件 · 四笔总装 + 时间轴 + 导出
- **第一步**：涂归属笔改走账本（`provenance:"brush"`、一笔一组）——**这是产品本体的接线点**；配"读盘判据"（保存后重开，events 节真长了）。
  - 顺带一条好消息：2026-10-20 已经把「涂归属（只改归属）」与「改省界（只改几何）」拆成两支笔了，**正好对应指南的"归属笔=账本客户端"**，不需要再拆一次。
- 高度/地形笔按 04 接线图平移第 2 件已磨好的管线；时间轴先接"松手生效"，不做逐帧回放。
- **风险**：手感五件里"标签联动"最容易漏（归属变了但省名/图例不刷新）。

### 第 5 件 · 读料桥（可提前到第 3 件后，用户点头即可）
- 现成资产要复用：`utils/vaultIndex.js`（只读）、`scripts/vault-scan.mjs`（只读归类）、`scripts/lib/vaultClassify.js`（唯一归类实现）、`docs/VAULT_BRIDGE.md`。
- 判据：拿一个"不听话"的库（乱目录+乱文件名+部分无 frontmatter）实测；点图出设定卡；换库不崩。

### 第 6 件 · 终验（用户出场一次）
- 三步齐 + 五件 + 415 省数据不丢 + 自测链证据（副本制 / 反向探针 / 读盘 / 三张无头截图）。

---

## 五、红线落地（10 条 → 仓内机制）

| 00 的红线 | 仓内落地形式（已有就引用，没有就补） |
|---|---|
| 415 孤本不喂测试 / 不重导 / 前后留底 | 测试全走 harness mock 项目（`run_tests.py` 播种，不落盘）；备份 `_施工留底\…-20261023-203520.sitian` |
| 一切写口走 guardWrite；新 IPC 注册即探针 | `store/writeGate.js` 的 `WRITE_CALLSITES` + `MEMORY_WRITE_CALLSITES`（`test_47`/`test_54` 读源码反查）；新增 `ledger` 写口必须登记 |
| 自测三条：副本 / 反向探针 / 读盘判据 | 仓内已有 `drill_quit_flush.py`（P4 剧本演练）、`diag_t2_save.py`；新件沿用 |
| 无头截图留档（playwright `_electron.launch`） | 仓内现有 CDP 头（`lib/cdp.py`）+ 截图用例（test_45/66 等）；不必强上 playwright |
| agent 进度账不算数 | 用例/judge 以 `lib/cdp.py:eval_json` 为准（AGENTS 已钉"静默假绿"教训） |
| 每 commit 首行一行决策 | 近期提交已按此写；**继续** |
| 文档禁散 | 本次已收拢（§6） |
| AI 只当翻译官 / 产出带 provenance | `provenance` 字段（第 3 件）；AI 翻译官子件默认关（05 步 9） |
| 抄源双验（协议✓+功能实存✓） | 白名单：perfect-freehand / rough.js / Excalidraw / Azgaar（限格式/架构/编辑器层）/ obsidian-fantasy-map；tldraw 禁入 |
| 一条目标→一个探针→一个最小改动→一枚判据 | 每件的"第一步"按此写（§4） |

---

## 六、文档处置（本次已执行）

**保留在 `docs/`（现行）**：`ARCHITECTURE_MAP.md`（脚本生成）、`SCENARIO_GUIDE.md`（用户手册）、`SCENARIO_EVENT_LEDGER.md`、`VAULT_BRIDGE.md`、`SCENARIO_PROVINCE_FIX_PLAN.md`（代码注释引用）、`P1_BATCH_BOUNDARY_OPS.md`（未做项评估）、`A1_DATA_MODEL_DECISION.md`（多份单测引用）、`P0_FIRST_MAP_WALKTHROUGH.md`（终验自测链）、`RELEASE_PROCESS.md`、`guides/20261023/`（本指南包）、`plan/SITIAN_GUIDE_DIGEST_20261023.md`（本文件）。

**已移 `docs/archive/`（历史参考，见该目录 README 的映射表）**：18 份 `SITIAN_HANDOFF_*`、`SITIAN_PLAN/REBUILD_PLAN/FULL_DEV_PLAN/MODULE_REFORM_PLAN/V2_BLUEPRINT/STATUS_AND_NEXT/PROGRESS_AND_GAPS/SESSION_HANDOFF/SPEC_V1/VAULT_SPEC`、`SITIAN_BREAKPOINT_20261018/20261019`、`SITIAN_COST_LEDGER_20261019`、`ROADMAP_NEXT`、`IMPROVEMENT_BACKLOG`、`LEGACY_DATA_INVENTORY`、`PROPOSAL_DISCLAIMER_AND_UI`、`RELEASE_NOTES_0.1.3`、`AUTO_RIVER_*`、`RIVER_*`（8 份）、`TERRAIN_RENDER_SMOOTHING_PLAN`、`DEVPLAN_LLM_FEED_AND_GALAXY_3D`、`plan/SITIAN_THREE_MODULES_20261020`（三刀序列，被 00 取代）——共 47 份 + 1 份跨目录，合计 48。

**作废（永不复活，写入本文件即为备案）**：AI 生成底图/通义万相；"手绘管线已跑通"类宣称；年表 CSV 批量导入；"Azgaar 自带历史层"；"vault 纯文本=资料外部可读"。

---

## 七、待用户拍板（只有 3 件，其余按默认序自走）

1. ~~51 个提交怎么处理~~ → **已完成（2026-10-23 20:55）**：`feature/map-editing-rework` 已推 `origin`，本地 `main` 已 FF 到同一提交。**剩一件**：`origin/main` 要不要跟着推（推 = 公开发布主线更新，等你点头）。
2. **顶点编辑器**：指南判"真用得上才保留"。我的建议：**保留**（仓内共边联动/压叠闸门已经投入且有用例），第 4 件后再按"实际画图工作流"复判一次；不砍。
3. **读料桥要不要提前**：指南默认排第 5；01 §六说它是"查询阶段首件硬缺口"。提前到第 3 件后 = 一句话的事，你点头我就插队。

---

## 八、开工检查单（每次会话开头照抄）

```powershell
# 1. 对账（只读）
git log --oneline -1; git status --short; git rev-list --left-right --count HEAD...origin/main
# 2. 版本与规模（锚点）
(Get-Content package.json -Raw | ConvertFrom-Json).version
(Get-ChildItem scripts\tests\cases\test_*.py | Measure-Object).Count      # 期望 136
(Get-ChildItem scripts\tests\unit\*.js | Measure-Object).Count            # 期望 52
# 3. 孤本仍在（只读核对）
Get-Item 'C:\Users\muyu\Documents\SiTianProjects\绒花计划.sitian' | Select-Object Length,LastWriteTime
Get-ChildItem 'C:\Users\muyu\Documents\SiTianProjects\_施工留底' | Select-Object Name,Length
# 4. 全量回归（开工前基线）
python scripts/tests/run_tests.py
```

判据：136/136 + 50 单测全绿才动代码；任何一条红先修基线，不带着红开工。
