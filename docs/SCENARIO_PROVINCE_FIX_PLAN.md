# 历史剧本 · 省份绘制修复方案

> **实施状态（2026-10-09）**：暮雨拍板「**直接 P2，格点=不可用**」→ **P2 已落地并交付**：
> 归属改矢量级（涂抹 = 对多边形做布尔）、格点层整体退役、合并无阈值无降级、`reprojectRings` 已删除。
> 落地细节见 `.workbuddy/memory/2026-10-09.md` 的「第十一轮续」；三条不许再犯的纪律见项目 `MEMORY.md`。
> 下文保留为**方案推导过程**（为什么这么改、当时的三条路线与取舍）。
>
> 日期：2026-10-09 · 基线：CDP 91 用例 / Node 单测 20 文件
> 结论一句话：**真凶不是「拆分」，是「涂归属/圈选/点填」抬手时的 `reprojectRings` 写回**——
> 它用 14.4 世界单位的格点轮廓覆盖了 10525 点的真实海岸线。合并在大数据量下还有第二条降级路径。
> 91 用例全绿是**假绿**：`test_62` 把退化行为当成了正确行为来断言。

---

## 0. 先救命（独立于本方案，随时可执行）

两条路都已验证过，任选其一：

| 方式 | 操作 | 前提 |
|---|---|---|
| A. 项目内快照 | 项目面板 → 快照 → 选 **14:33:08** 那份（拆分前） | 不用关软件 |
| B. 覆盖备份 | 关闭司天，用 `…\绒花计划.sitian.backups\绒花计划-2026-10-09T06-33-09-804.sitian` 覆盖项目 | 更彻底 |

**恢复校验判据**：选中 `Province 2`，右侧属性面板应显示「顶点数 **10525**」。显示几十 = 没恢复对。

---

## 1. 事实层（代码级，可逐条复核）

| 触发动作 | 代码路径 | 对几何做了什么 |
|---|---|---|
| 涂归属笔刷 抬手 | `provinceEditing.js:360 endProvinceStroke` → `:290 reprojectRings` | ✅ **覆盖**（`fromGrid:true` 格点轮廓） |
| 自由轮廓套索 | `provinceEditing.js:401 applyProvinceLasso` → `:290 reprojectRings` | ✅ **覆盖** |
| 点击填充 | `provinceEditing.js:475 fillProvinceRegion` → `:290 reprojectRings` | ✅ **覆盖** |
| 拆分 | `provinceEditing.js:541 splitProvince` → `provinceShape.js:412 splitProvinceShape` | ❌ 不动原环，**对原多边形做直线裁剪** |
| 合并 | `provinceEditing.js:581 mergeProvinces` → `provinceShape.js:695 mergeProvinceShapes` | ⚠️ 精确并集；**规模超限时退回栅格重采样** |
| 新建省份 | `provinceEditing.js:634 addBrushProvince` | 空 `points:[]`，由 labels 提取（预期行为） |

`reprojectRings` 关键三行（`provinceEditing.js:299-307`）：

```js
const loops = byLabel.get(idx) || [];
const patch = loops.length
  ? shapePatch(loops.map((pts) => ({ points: pts, kind, fromGrid: true })))  // ← 覆盖原多边形
  : { points: [], extraRings: undefined, fromGrid: false };
```

`fromGrid: true` 是**唯一**写进主环的标记，来源只有这一个函数 → 你看到的 `fromGrid: true` 就是它干的。

**「10525 → 22」的量化解释**：网格 `DEFAULT_GRID_CELL = 14.4` 世界单位（`provinceGrid.js:19`），
`buildLabelOutlines(eps=0.75)` + `collapseCollinearXY` 把格点台阶塌成直线。
→ 一个省在网格上的边界上限 = **一个格子一条边**。格子之外的形状信息**在模型里根本不存在**，
所以不是"算法不够聪明"，是**信息被丢弃**。

---

## 2. 根因（三层，从深到浅）

**① 模型层（真正的病根）**
司天同时维护两套几何粒度：
- 矢量级：`terrain[].points`（几何事实源，渲染唯一来源，可到上万点）
- 格点级：`provinceLabels`（归属事实源，14.4 单位一格）

两者精度天然不对等。当多边形远精细于网格时，"编辑归属"**无法**用格点表达 → 代码只能反向降级几何。
**这个张力不解决，剧本模块的绘制永远别扭**——改一个补丁，另一个场景再犯。

**② 验证层（为什么没人发现）**
`test_62_province_rings.py:256-257`：

```python
ok('写回：多边形非空（不再只有网格）', … points.length >= 3, …)
same('写回：标记网格派生（渲染端据此平滑）', provB.fromGrid, True)
```

用例把「写回格点轮廓 + fromGrid=true」当成**正确行为**来断言 → 91 用例全绿 ≠ 数据安全。
**全仓没有任何用例守「高精度多边形不被覆盖」，也没有任何用例量「顶点数不下降」。**

**③ 算法层（第二条降级路）**
`mergeProvinceShapes` 的精确共边抵消有 `maxWork = 2e7` 上限；真实库前两大省 10525 × 10071 点
→ `work ≈ 1.06e8` → `overflow` → 退回 `unionRingsByRaster({ maxDim: 220 })`
→ 上万点的省被重采样成 220 分辨率轮廓。UI 只提示"精度降级"，**不阻止**。

---

## 3. 修复方案（按优先级）

### P0 — 止血：停止"静默毁数据"（可当天完成）

**P0-1　`reprojectRings` 加精度保护**（核心，一处改动止住三条路径）

`provinceEditing.js:290` 改为返回 `{ terrain, preserved:Set<number> }`；对每个 touched 省份：

```
origCount = Σ provinceRings(p)[*].points.length
gridCount = Σ loops[*].length
if (origCount >= 200 && gridCount * 5 < origCount)  →  保留原环（不覆盖），记入 preserved
```

三个调用点（`:372 / :446 / :510`）适配返回值，并在状态栏播报：
> 「已改归属 N 格；「Province 2」的边界为高精度导入（10525 点），已**保留原始边界**」

**语义**：涂抹继续改归属标签，但**不碰矢量几何**。这直接消灭 10525 → 22。

**P0-2　归属层可见（否则 P0-1 用户以为坏了）**

现状：`provinceLabels` 只在涂抹时用，**不参与渲染** —— 所以 P0-1 之后"涂了看不到变化"。
必须在 `ScenarioMap` 的绘制流程里加一个**半透明归属覆盖层**（可开关）：
- 复用 `buildLabelOutlines(labels, grid, …)` → 逐省半透明填充（alpha≈0.35）
- **不写入任何几何**，纯显示
- 层开时：色块 = 归属，海岸线 = 几何，两者各归其位
- 需要 `watch` 归属变化 → `requestRender()`（照 test_69 的教训：改档位不重绘 = 下拉没反应）

**P0-3　合并拒绝静默降级**

`provinceEditing.js:581` / `mergeProvinces`：当 `cost.overflow` 为真且参与省份总点数超阈时，
**默认返回 `{ rejected:'too-detailed', message }`**，不再静默走栅格。UI 给 `confirm()`
（"这次合并会重采样边界，原 N 点 → 约 220 点，是否继续"），用户明确同意才带 `allowRaster:true` 继续。
—— 宁可"做不到"，不要"做到了但数据降级"。

**P0-4　测试改判据 + 新增守卫**

- **改** `test_62` 第 256-257 行：判据从「写回格点轮廓」→「高精度多边形**被保留**（点数不降、`fromGrid` 不为 true）」。
- **新增** `test_91_province_geometry_preservation.py`：
  - 构造 ≥1000 点多边形 → 分别走 笔刷 / 套索 / 点填 → 断言 `points.length` **不下降**、`fromGrid !== true`
  - 构造大点数两省 → 走合并 → 断言要么精确并集、要么被**拒绝**（绝不静默栅格）
  - 源码守卫：`reprojectRings` 内不得出现无保护的 `shapePatch(loops.map(…))`
- 同步补 `run_tests.py` 的 `MOCK_SCRIPT`（若新暴露 `sitianAPI` 能力）。

### P1 — 让"能做到"变成"做得好"（可选，取决于路线选择）

**P1-1　合并算法降复杂度**
`splitEdgesAtNodes`（`provinceShape.js:460`）是 `for 每条边 × 全部节点` = O(E×N)，这才是 `maxWork` 爆掉的原因。
用**均匀网格哈希**（按 `QKEY` 所在桶只比邻桶节点）降到近线性 → 真实库 1.06e8 有望降到 ~1e6，精确并集可覆盖真实数据。

**P1-2　网格分辨率自适应**
`DEFAULT_GRID_CELL = 14.4` 是常数 → 大图网格天然粗。
改为按底图 bbox 与目标格数（如 ~300×300）自适应求 `cell`。
⚠️ 这只是**缓解**：格子永远表达不了 10525 点海岸线，不能当主解法。

### P2 — 治本：矢量级归属（真正"在地图上绘制边界"）

把"归属"从**格点级**改成**矢量级**：涂归属 = 对目标省份多边形做**并集/差集**，**完全不经过网格**。
- 拆分已经走这条（`splitProvinceShape`）——把它推广到涂归属即可，路径是现成的
- 需要多边形裁剪：自研（Greiner–Hormann / Martinez）或引入 `polygon-clipping`（引依赖要同步 `版权与许可证.md`）
- 收益：涂抹即改边界、精度不降、撤销语义干净（一条命令改一块几何）
- 代价：工作量最大；`provinceLabels` 可能整体退化为纯索引/优化结构

**推荐路线**：**P0（立即）→ P2（正解）**；P1-1 顺手做，P1-2 只在 P2 未落地前做过渡。

---

## 4. 明确不改（避免改错地方）

- **拆分** `splitProvince` / `splitProvinceShape` —— 对原多边形做直线裁剪，**保留精度，是对的**。
- **自由绘制 (B)** / **改形状 (G)** —— 自由顶点，不经过格子。
- **`shapeSignature` 自愈机制** —— 设计正确（网格作废靠指纹而非"十几处手工作废"），保留。
- **抬手 diff 手感**（涂抹期只改内存、不换数组引用）—— 保留。

---

## 5. 验证判据（可复验，不靠"我觉得"）

| 层级 | 判据 |
|---|---|
| 单测 | 新增 `test_91` 全绿；`test_62` 改判据后全绿；`test_64 / test_79 / test_81` 不回归 |
| 真机 | `drill_quit_flush.py --phase p4` 通过（脚本跑前备份跑后还原） |
| 数据 | 涂归属后读项目文件，`Province 2` 顶点数**仍为 10525** |
| 可见 | 归属覆盖层开关能显示色块；关掉后海岸线原样 |
| 交付 | `npm run dist` 打包，`release-inst/…exe` 的 `app.asar` 时间戳晚于本次改动（**exe 时间 ≠ 代码时间 = 没交付**） |

---

## 6. 风险与顺序

- **P0-1 的风险**：保留几何后，`provinceLabels` 与多边形**不再同源**。需确认 `shapeSignature` 不因此误判
  （判据是"网格是否由当前多边形派生"，多边形没变 → 签名不变 → 不会误重建）。这是 P0 唯一的验证重点。
- **顺序**：P0-1 → P0-2 → P0-4（先止血再补守卫）→ P0-3 → 打包交付 → 再决定 P2。
- **绝不**在没有 P0-2 的情况下单独上 P0-1：用户会看到"涂了没反应"，比降级更困惑。

---

## 附：待你拍板的一个取舍

「归属」到底该是**格点级**还是**矢量级**？这决定 P0-2 与 P2 的形态：

- **A. 保持格点级 + 独立显示层（P0 路线）**：改动小、风险低；但"涂归属"改的始终是一层掩膜，
  与矢量边界天然对不齐（色块可能略超出海岸线）。
- **B. 改成矢量级（P2 路线）**：涂归属 = 直接改边界多边形，所见即所得、精度不降；
  但工作量最大，且要重定义归属语义（`provinceLabels` 可能退化成索引）。

我的判断：**你想"在地图上绘制边界"，要的是 B；A 只是止血。** 建议 P0 立即上马止住数据损毁，同时按 B 排期。
