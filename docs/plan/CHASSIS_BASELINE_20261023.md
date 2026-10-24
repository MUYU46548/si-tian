# 底盘基线（2026-10-23，第 1 件开工前实测）

> **性质**：指南包 02 §三 B1 判据（「连续画 30 秒，全程零帧 >50ms」）的**第一份实测基线**，以及据此对第 1 件的**重排**。
> **纪律**：只量不改（本文件对应的两次提交都只加探针与文档）；数值都是这台机器上的真实读数，换机器要重量。
> **复现**：见文末命令。探针在 `scripts/tests/tools/`，不进食用例集（`run_tests.py` 不会跑它们）。

---

## 一、环境（读数的前提，别忽略）

| 项 | 值 |
|---|---|
| 浏览器 | headless Edge（`--headless=new --disable-gpu`），CDP 驱动，视口 1440×900 |
| 画布 | 1080×484（剧本侧）/ 1080×476（行星侧），DPR=1 |
| 数据 | **剧本侧 = 真实 `docs/mockups/desite.map`**（200 省 / 160 河 / 6826 骨架点 / 9975 高度格）；**行星侧 = harness fixture 行星**（26,910 格） |
| 项目 | harness 基线项目（mock，**不碰 415 孤本**） |
| 探针 | `_probe_baseline_planet_brush.js` / `_probe_baseline_scenario_map.js` / `_probe_hotspots_scenario_map.js` / `_probe_land_cost.js` |

> ⚠️ headless + 无 GPU：光栅化只会比真机更慢，所以"这里干净"可以放心，"这里卡"需真机复核后再下结论。

---

## 二、读数

### A. 行星侧（PlanetMap 高度笔刷，26,910 格）

| 手势 | 帧数 | p50 | p95 | max | >33ms | >50ms | handler/事件 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 只 hover 5s | 300 | 16.6 | 17.9 | 18.6 | 0 | 0 | 0.15ms |
| **高度笔连画 30s** | 1801 | 16.7 | **19.2** | 58.5 | 1 | **1** | 0.19ms |
| 散布笔连画 10s | 596 | 16.7 | 18.2 | 96.8 | 2 | 1 | 0.17ms |

涂抹有实效（高度采样校验和 29059 → 30065；散布笔图标 0 → 33 个）。

**结论：PlanetMap 高度笔刷已经达标**（30s 里只有 1 帧 >50ms，且是启动尖峰；`markPaintDirty` 脏矩形已在用）。
→ **指南 02 的「搬基帧缓存到 PlanetMap」在当前数据上没有收益可捞，不做**（做了只是加风险）。

### B. 剧本侧（真实 200 省底图）

| 手势 | 帧数 | p50 | p95 | max | >33ms | >50ms | handler/事件 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 只 hover 5s（选择工具） | 202 | 17.0 | **49.6** | 68.7 | **56** | **7** | 2.0ms |
| **省份自由绘制连画 30s** | 1798 | 16.7 | **17.7** | 90.4 | 2 | **2** | 1.15ms |
| **涂归属连画 10s** | 222 | 19.1 | **117.6** | 120.5 | **83** | **72** | **34.45ms** |
| 建省落库（松手那一下） | — | — | — | — | — | — | **421ms**（鼠标路径）/ **299ms**（直调 `commitFreeTrace`） |

**结论**：
- **自由绘制已达标**（基帧缓存 + 抽稀在起作用），指南说的"画条线圈个地都要卡"在这条路上**已经不是事实**；
- **真痛点是两条**：① 涂归属每事件 34ms、p95 117ms（72/222 帧 >50ms）——这是日常主笔；② 每次建省松手同步阻塞 300~420ms。

### C. 热点归因（同机、同数据，纯测量）

| 被测 | 每次耗时 | 说明 |
|---|---:|---|
| `pointInProvince`（单省） | 0.10ms | 单点射线法本身不慢 |
| `provinceRings`（单省） | 0.02ms | 便宜，但**每次调用新建数组**（`sameRef:false`） |
| **`findProvinceAt`（全表 200 省）** | **20.4ms**（p50 22.4 / p95 24.2） | 线性扫到底才返回值；采样命中率只有 20% → 多数调用扫满 200 省 |
| **`ownerHitProvinceIds`（5 偏移 × 上一条）** | **96.9ms**（p50 110） | 涂归属每 mousemove 的固定成本 |
| `measureProvinceOverlap`（压叠闸门） | 9.6ms | 不是落库大头 |
| `freeTraceRing`（1788 点，贴骨架） | 5.4ms | 不是落库大头 |
| **`exportCanvasToProject`（保存载荷）** | **168ms** | 对 6 个容器各做一次 `JSON.parse(JSON.stringify())` |
| `JSON.stringify(payload)`（2.07MB） | 10.1ms | |
| `saveScenarios`（整条同步段） | **180ms** | = 载荷 168 + 序列化 10 |
| **`commitFreeTrace`（松手整条）** | **299ms** | ≈ trace 5 + 闸门 10 + **saveScenarios 180** + 其它 |

---

## 三、据此重排第 1 件（**与指南原文不同，理由在上表**）

指南原排：① 搬基帧缓存到 PlanetMap/AreaMap/InteriorView；② 笔刷进脏矩形；③ 保存修法②③。
实测后改为（同一判据，改的是靶子）：

| 序 | 改什么 | 为什么（读数） | 判据 |
|---|---|---|---|
| **1-a** | **省份命中加空间索引**（bbox 预筛 + 均匀网格；`provinceRings` 结果按省缓存） | `findProvinceAt` 20ms/次、`ownerHitProvinceIds` 97ms/次 → 涂归属 34ms/事件 | 涂归属 30s：p95 ≤33ms、**零帧 >50ms**；`ownerHitProvinceIds` ≤2ms/次 |
| **1-b** | **保存载荷去重复序列化 + 松手不同步落盘** | `exportCanvasToProject` 168ms、`commitFreeTrace` 299ms（松手同步阻塞） | 松手 ≤50ms；读盘判据（保存后重开数据真变）不掉 |
| **1-c** | **AreaMap / InteriorView 先量再定**（同一套探针改工具即可） | 本轮未量；PlanetMap 已证明"无测量就搬基帧缓存"是浪费 | 量出 >50ms 帧再动，否则记"不需做" |
| ~~原①~~ | ~~搬基帧缓存到 PlanetMap~~ | 高度笔 p95 19.2ms、1 帧尖峰 | **不做**（记录在案，防后来者照旧单重做） |

> 顺带记一条与指南一致的地方：`exportCanvasToProject` 的 168ms 正是指南 02 说的"四次 JSON 深拷贝 ≈187ms"同一件事（本仓现在是 6 个容器），**指南这条是准的**。

---

## 四、还没量（下一步，别当成已确认）

1. **AreaMap 涂抹**（03 说它"走凸包"——既是手感语义问题，也可能有卡顿）；`InteriorView` 同理；
2. **真实 415 省项目的保存载荷**（本轮是 200 省 mock；按比例估 ~350ms，需在**副本**上实测确认）；
3. **窗口版 Electron**（非 headless）复测 1-a 修完后的松手/涂归属——headless 只是下界。

---

## 五、复现命令

```powershell
python scripts/tests/tools/_lab.py up            # 常驻 Vite + headless Edge（注入 mock）
# 真实 200 省底图要先放到 public（4.5MB，已进 .gitignore）：
Copy-Item docs\mockups\desite.map src\renderer\public\__real_desite.map -Force

python scripts/tests/tools/_probe_baseline_planet_brush.py                       # → .lab-planet-baseline.json
python scripts/tests/tools/_probe_jank_real.py _probe_baseline_scenario_map.js __SCBASE   # → .lab-jank.json
python scripts/tests/tools/_probe_jank_real.py _probe_hotspots_scenario_map.js __HOT
python scripts/tests/tools/_probe_jank_real.py _probe_land_cost.js __LAND

python scripts/tests/tools/_lab.py down          # 收工：杀进程 + 还原 index.html
```

⚠️ 探针第一版踩过一个坑，写在这里防重犯：**只调 `setInteractionMode('height')` 不等于在画**
（落笔守卫是 `mode==='height' && s.editMode`）。第一版没开编辑模式，30 秒拖拽一个格都没涂，
量出来"p50 16.7 / 零卡顿"——**假基线**。现在每份探针都带"真的改了吗"的校验
（高度采样校验和 / 建成省数 / 图标数 / 归属 JSON 变化），不通过就报 fails。

---

## 六、1-a 已落地并复测（2026-10-23 21:5x）

**做了什么**：新增 `utils/provinceHitIndex.js`（包围盒 + 均匀网格 + 每省"环/嵌套符号/包围盒"建索引算一次），
`findProvinceAt` 换成索引查询；判定本身仍只走 `pointInProvince`（给它加了一个可选 `cached` 参数，
绕数规则**仍然只有一处**）。索引按 `terrain` **数组引用**缓存（几何一改就换新数组 → 自然失效，零手工失效点）。

**复测（同一台机器、同一份真实 200 省底图、同一份探针）**：

| 读数 | 改前 | 改后 | 倍数 |
|---|---:|---:|---|
| `findProvinceAt`（每次） | 20.44ms | **0.18ms**（p50 0，max 15.2 = 首次建索引） | 113× |
| `ownerHitProvinceIds`（5 偏移 / 每次） | 96.89ms | **0.25ms**（p95 1.1） | 387× |
| **涂归属 10s**：帧数 | 222（在掉帧） | **602**（满帧） | — |
| 涂归属 10s：p95 / >50ms | 117.6ms / **72 帧** | **18.8ms** / **0 帧** | 达标 |
| 涂归属 10s：handler/事件 | 34.45ms | **0.23ms** | 150× |
| 自由绘制 30s：p95 / >50ms | 17.7ms / 2 帧 | 17.7ms / 1 帧 | 不变（本来就达标） |
| 建省松手 | 421ms | 370ms | 未动（下一步 1-b） |

**代价（如实记）**：首次查询会建索引——200 省 **≈15ms**（一次，之后同引用复用）；
单元测试 8/8（含"索引 vs 朴素扫描 3000 点逐点对拍 0 处不一致"、洞/飞地/压叠顺序/巨型表/缓存/反向探针）。

**下一步（1-b）**：松手仍要 370ms（`exportCanvasToProject` 172ms + IPC）。按 §三 的 1-b 做：
单次序列化 + 松手不同步落盘；判据 = 松手 ≤50ms 且读盘判据（保存后重开数据真变）不掉。

---

## 七、1-b 已落地并复测（2026-10-24 09:0x）

### 7.1 先纠正上一轮那句「剩下 188ms 未归因」

上一轮猜的是「IPC 结构化克隆 / 主进程写盘 / 快照 diff」。**量完发现这三样都不在松手那一下**：
‑ 松手只走 `saveScenarios → syncCanvasToProject`（暂存 + 置 dirty + 排 800ms 防抖），**不碰 IPC、不写盘**；
‑ 快照 diff 与 `toIpcPlain` 都发生在**800ms 之后**那次 `saveProject` 里（所以它们要单独量，见 7.4）；
‑ 真正的钱花在**读 Vue 代理**上：同一份 2.07MB 载荷，逐属性读一遍 **160ms**，`toRaw` 之后 **3.3ms**。

消融实验（只测量：把 `JSON.stringify` 打桩成返回空壳，让 6 次深拷贝空转，其余照旧）：
**松手 308ms → 202ms**，即深拷贝在松手里占 **≈106ms**；剩下 202ms 由 trace + 压叠闸门 + 冷重绘 + 暂存构成。

### 7.2 做了什么（四处，全在「序列化边界」上）

| 改哪 | 改成什么 | 为什么 |
|---|---|---|
| `geodata.buildProjectPayload` | 6 次 `JSON.parse(JSON.stringify(容器, replacer))` → **只换壳不深拷**（字典 `{...}` / 数组 `slice()`，值直传；容器先 `toRaw`） | 深拷贝在**落盘唯一出口** `toIpcPlain` 里本来就要做一遍，载荷这份是重复的 |
| `projectStore.mergeCanvasPayload` | `{...toRaw(project)}`（原来是 `{...project}`） | 不先 toRaw，取回来的每个值又是代理 → 合并结果里全是代理，落盘/快照都要重读 |
| `projectSchema.toIpcPlain` / `deepClone` | 先 `unwrapRaw()`（读 `__v_raw`，**不 import vue**，保持模块纯） | 3.6MB 正文：237ms → 60ms；`structuredClone` 不再因代理抛错 → 129ms 的 JSON 降级变 29ms 正常路径 |
| `projectStore.createProject` | 新建前过 `toIpcPlain(draft)` | 载荷不再自带 JSON 往返后，这条 IPC 边界必须自己保证「无代理 + TypedArray 转数组」 |

连带的诚实调整：`snapshotBytes()` 也带上 `jsonSafeReplacer`（`deepClone` 现在能保住 TypedArray，
不带 replacer 数出来的字节会虚高 → 体积上限提前触发、白丢快照）。

**语义没变**：载荷仍是"能过 IPC 的纯值"，文件内容与旧实现同形（`jsonSafeReplacer` 照旧在落盘口走一遍）；
隔离保留在"换容器"这一级（画布 `mapData.value = {...}` 这类写入不会改到已并进项目的那份）；
**就地改**（`province.points.push`、`ownership[id]=x`）会共享 —— 那本来就是画布的事实，下一次保存照它重写。

### 7.3 复测（同机 / 同真实 200 省底图 / 同一份探针 `_probe_land_breakdown.js`）

| 读数 | 改前 | 改后 | 倍数 |
|---|---:|---:|---|
| `exportCanvasToProject`（载荷构造） | 164.8ms | **1.3ms** | 127× |
| `syncCanvasToProject`（+ 合并进项目） | 172.3ms | **5.3ms** | 33× |
| `saveScenarios`（项目态整条） | 173ms | **5.3ms** | 33× |
| `addBaseProvince`（不带压叠闸门） | 180ms | **6.0ms** | 30× |
| **建省松手（mouseup 同步段）p50** | **257ms**（max 368） | **99ms**（max 169） | 2.6× |
| 落盘一次 `saveProject` | 584.6ms | **372.9ms** | 1.6× |
| ↳ `toIpcPlain(project)`（3.6MB） | 236.6ms | **56.8ms** | 4.2× |
| ↳ `pushSnapshot`（快照 diff） | 129.4ms | **32.3ms** | 4× |

机制读数（`_probe_land_variants.js`，同一份数据同一台机器）：同一份底图 `JSON.stringify`
**代理 65.8ms / `toRaw` 3.3ms**；`JSON.parse(JSON.stringify(...))` **代理 68.4 / 原始 6.5**；
载荷两种造法 **现写法 160.2ms / 单次往返 44.5ms / 零拷贝 0.1ms**（选了零拷贝，理由见 7.2）。

### 7.4 判据对账

| 判据 | 结果 |
|---|---|
| 松手 ≤50ms | ❌ **未达**：99ms（干净堆时 70ms）。余量 = 描轮廓 10 + 压叠闸门 16 + **冷重绘 35 + 暂存 5**（见 7.5） |
| 读盘判据（保存后重开数据真变） | ✅ **通过**（`_probe_land_readback.js`）：建省 → 改名 → 等 800ms 防抖 → 载荷里 201 省 + 新名字，且 `JSON.stringify` 往返逐字节一致（纯值）→ **关闭项目 → 重开**：省还在、名字还是新的、16 个顶点一位不差 |
| 不谎报「已保存」 | ✅ `saveStatus` 仍是 staged → saved 两段（test_91 / test_115 全绿） |
| 136 项回归 | ✅ **136/136**（含 51 个 Node 单测） |

### 7.5 松手剩下的 99ms 在哪（下一刀的依据，别猜）

| 段 | 值 | 能不能省 |
|---|---:|---|
| `freeTraceRing`（贴骨架成环） | ~10ms | 收笔与预览走同一函数（**故意**的：预览=落库）。可试"复用最后一帧预览环" |
| 压叠闸门 `measureProvinceOverlap` | ~16ms | 已带包围盒预筛；1600 格心 × 点在内判定是算法固有成本 |
| **冷重绘 `render()`** | **~35ms**（暖帧只要 8ms） | 省不掉（新省要上屏），但**一次松手会重绘 3~4 遍**：同步 render + `watch(baseMap,{deep:true})` + 相机停稳 |
| 暂存（`syncCanvasToProject`） | 5ms | 已从 172 降到 5 |

> 🔴 **下一刀应该切的是重绘与 deep watch，不是保存**：`watch(baseMap, { deep: true })` 一次变化要
> `traverse` 整份底图，CPU 采样里 **77ms/次**（比渲染还贵）；`watch([baseMapKey, terrain.length])`
> 还会在"省数变了"时 `setTimeout(fitToView, 50)`。**已实测确认（`_probe_land_camera.js`）**：
> 先把镜头挪到 `{x:67.6, y:-53.5, scale:0.3549}` 再自由绘制一个省，松手后 800ms 内镜头变成
> `{x:45.3, y:-50.3, scale:0.4894}` —— **每画一个省，镜头会自己重新适屏**（免责只在 `provincePaint` 工具上，
> 自由绘制没豁免）。这既是第三遍重绘，也是"手一松镜头就跳"的来源；修法只需把这条例外扩到"同一张图上
> 增减省份一律只重绘"，但那是**镜头语义**，要单独一刀 + 单独判据，不在 1-b 里顺手改。

### 7.6 探针（全部只测量，不进用例集）

`scripts/tests/tools/`：`_probe_land_breakdown.js`（主读数表）、`_probe_land_breakdown3.js`（消融）、
`_probe_land_variants.js`（三种载荷写法对拍）、`_probe_land_clean.js`（数一次松手重绘几遍）、
`_probe_land_sinkoff.js`（把"画布→项目"入水口架空 —— **负结果**：松手没变快，证明暂存不是那 188ms）、
`_probe_land_readback.js`（读盘判据）、`_probe_land_camera.js`（镜头会不会自己适屏）、
`_probe_land_profile.py`（CPU 自耗时，采样窗口要紧）。
驱动照旧：`python scripts/tests/tools/_lab.py up` → `python scripts/tests/tools/_probe_jank_real.py <js> <GLOBAL>`。
