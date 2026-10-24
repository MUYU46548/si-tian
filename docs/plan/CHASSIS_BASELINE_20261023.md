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
| 136 项回归 | ✅ **136/136**（含 52 个 Node 单测 —— 新增 `unit/test_project_plain.js` 9/9 守序列化边界） |

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

---

## 八、1-b 收口：松手 ≤50ms 达成（2026-10-24 09:5x）

判据只剩"松手 ≤50ms"没达标（99ms）。按 §7.5 的定位，**动的不是保存，是重绘与 deep watch**：

| 改哪 | 改成什么 | 依据 |
|---|---|---|
| `ScenarioMap` 的 `watch(baseMap, …, {deep:true})` | **去掉 deep**（只认"这张底图换对象了"） | 本仓所有底图写入都是整体替换（`baseMaps.value = {...[key]: {...bm, …}}`，60+ 处；高度图走 `commitHeightmap` 同样换对象）；`baseMap = computed(() => store.baseMaps[key])` → 换对象必触发，写别的底图不误触发。deep 的代价是每次变化 `traverse` 整份底图 **77ms** |
| `onMouseUp` 自由绘制分支的 `render()` | 只在**没换引用**（数据没变：太短 / 压叠取消）时才补一帧 | 几何变了的话同一帧里 `watch(baseMap)` 本来就会重画 → 原来那次是同一份内容画第二遍 |

**复测（同机 / 同 200 省底图 / 同一份 `_probe_land_breakdown.js`）**：

| 读数 | 1-b 前 | 载荷去深拷后 | 收口后 |
|---|---:|---:|---:|
| **建省松手 p50** | 257ms | 99ms | **35.6ms**（max 130 是 GC 尖峰；最好一次 26ms） |
| 松手那一下同步重绘次数 | 1 | 1 | **0**（成功分支） |
| 一次松手总重绘遍数 | 3~4 | 3~4 | **1**（`_probe_land_repaint.js` 数 `clearRect`） |

> 剩下的 35ms 里，**压叠闸门 ~25ms**（1600 格心 × 点在内判定）+ 暂存 5ms + 描轮廓 2ms；
> 那次唯一的重绘（冷帧 ~35ms）已经挪到同一帧的 watcher 里，不再是同步段的一部分。

**"省了帧但画面不动"的反证（`_probe_land_repaint.js`，判据是像素不是代码）**：松手 → 等两帧 → 取画布校验和
→ 再手动 `render()` 一遍 → **校验和必须完全相同**。4 次建省全部 `sameAfterForceReRender: true`；
取消分支（压叠确认点「取消」，数据没变）同步补了 1 帧、预览擦净、强制重绘后校验和也相同。
另：`test_121` 的逐像素等价断言（683640 像素，差异 0）与 `test_63`（自由绘制色值/顶点）都照旧通过。

**代价 / 边界（如实记）**：
‑ deep→引用 的成立前提是"底图几何一律换对象写"。若将来出现**就地改**（`prov.points[i].x = …`），这里会漏一次重绘
  —— 注释已写在 watcher 上：那种写法本身就是本仓禁区，该改写法而不是把 deep 加回来。
‑ **"每画一个省镜头自己重新适屏"没动**（实测 `_probe_land_camera.js`：0.3549→0.4894）。它属于**镜头语义**
  （导入同一张底图也要靠它适屏），要单独一刀 + 单独判据。

### 7.6 探针（全部只测量，不进用例集）

`scripts/tests/tools/`：`_probe_land_breakdown.js`（主读数表）、`_probe_land_breakdown3.js`（消融）、
`_probe_land_variants.js`（三种载荷写法对拍）、`_probe_land_clean.js`（数一次松手重绘几遍）、
`_probe_land_sinkoff.js`（把"画布→项目"入水口架空 —— **负结果**：松手没变快，证明暂存不是那 188ms）、
`_probe_land_readback.js`（读盘判据）、`_probe_land_camera.js`（镜头会不会自己适屏）、
`_probe_land_repaint.js`（收口后：松手耗时 + `clearRect` 计重绘遍数 + **"画面是不是最新的"校验和反证**）、
`_probe_1c_area_interior.js`（1-c：区域笔刷 / 拖家具，附"不拖也不动"的对照组）、
`_probe_land_profile.py`（CPU 自耗时，采样窗口要紧）。
驱动照旧：`python scripts/tests/tools/_lab.py up` → `python scripts/tests/tools/_probe_jank_real.py <js> <GLOBAL>`。

---

## 九、1-c 量测结论：AreaMap / InteriorView **都不需要做**（2026-10-24 10:0x）

判据照旧：连画连拖零帧 >50ms（本段各取 20s / 10s，两者都不是主战场）。探针 `_probe_1c_area_interior.js`，
**每段都带"真的改了吗"**：区域笔刷要建出区域（0→1 ✔）、家具要真的位移（28.3 ✔，网格吸附后的值）。

| 视图 / 手势 | 帧数 | p50 | p95 | max | >33ms | >50ms | handler/事件 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **区域地图 · 区域笔刷连涂 20s**（凸包那条链） | 1200（满帧） | 16.7 | **18.6** | 30.0 | 0 | **0** | 0.10ms |
| 区域笔刷松手合区域 | — | — | — | — | — | — | 17.9ms |
| **室内 · 拖家具 10s** | 595 | 16.7 | 18.3 | 89.4 | 2 | 2 | 0.13ms |
| ↳ **对照组：同样密度 mousemove、什么都不拖** | 599 | 16.6 | 17.9 | 76.0 | 2 | **1** | 0.20ms |

**结论**：
‑ **AreaMap 区域笔刷达标**（20s 里零帧 >33ms，handler 0.1ms/事件）—— 指南 03 担心的"凸包卡顿"在当前实现上不存在
  （落点按笔刷半径 1/4 抽稀 + `requestRender` 帧合并 + 松手才做一次凸包/简化），**不做**。
‑ **InteriorView 拖家具达标**：p95 18.3ms、handler 0.13ms；窗口里那 2 帧 >50ms
  **在"什么都不拖"的对照组里同样出现（同一时刻、76ms）** → 归因不是拖拽，而是**后台那次 800ms 防抖落盘**。
  所以室内也**不做**（真正该动的是落盘，见下）。
‑ 顺带给下一段留了证据：那 76~89ms 的帧正好落在"一次 `saveProject`（≈380ms）"上 —— 1-b 把它的**同步段**从 585 压到 373，
  但**它仍然是一整块主线程工作**。下一刀按 digest §三③ 的两步走：**IPC 传字符串**（省掉主进程侧 stringify + 3.6MB 结构化克隆），
  再决定要不要把保存搬 Worker。

### 第 1 件收口状态

| 子件 | 状态 | 判据 |
|---|---|---|
| 1-a 省份命中空间索引 | ✅ | 涂归属 30s 零帧 >50ms（10/23） |
| 1-b 保存载荷去深拷 + 序列化去代理 | ✅ | 松手 **35.6ms ≤50**、读盘判据（保存→关闭→重开）通过 |
| 1-c AreaMap / InteriorView 先量再定 | ✅ **量了，两处都不用动** | 上表 |
| 原「搬基帧缓存到 PlanetMap」 | ❌ 砍掉（量过无收益） | §二 A 段 |

---

## 十、第 2 件首落：散布笔的 L2 笔迹层（2026-10-24 10:3x）

按指南 04 §三（L2 首落选散布笔）做**第一件事**：拖动中把这一笔的真实路径画成淡色轨迹，松手消失。

| 改哪 | 改成什么 |
|---|---|
| `composables/planetDrawing.js` | 新增 `drawReliefTrail(ctx, path, {erase, size})`：**外圈宽而淡 + 内芯细而实**两层描边（软笔迹），点数超 320 按步长抽稀（只在画的时候抽，路径数据不动），尾点必画到 |
| `components/PlanetMap.vue` | 编辑态 + 正在散布时：先画轨迹、再画图标（图标在上，不被轨迹糊住） |
| `composables/useReliefBrush.js` | 松手/取消时 `renderer.markFullRedraw()` —— 轨迹是**瞬态**的，只 `requestRender()` 擦不掉轨迹以外那些像素（脏矩形只覆盖这一笔碰到的图标矩形） |

**判据（探针 `_probe_relief_trail.py`，判据是像素 + 拖动中截图，不是读代码）**：

| 判据 | 读数 |
|---|---|
| 按下即出痕 | 松手瞬间 **8258 个像素变暗**（= 那条淡白轨迹被擦掉），差值即轨迹；截图里可见 |
| 松开即消失 | 同上（`changed 8275 / 总 64320`，几乎全是"变暗"） |
| 图标照落、一笔一条 undo | 0 → 16 个图标；undo label = 「散布地貌图标」 |
| 拖动密度不掉 | 10s 连拖 **597 帧 / p50 16.7 / p95 18.7 / 1 帧 >50ms**（§二A 基线 596 / 18.2 / 1 —— 持平），handler 0.17 → **0.27ms**/事件 |
| 输入→上屏 | 轨迹与图标在**同一个** `onRender` 里画（同一帧），无额外调度 |

**代价/边界**：每帧按整条路径重描（点数封顶 320，超了抽稀）—— 一条 10s 的长笔迹每帧只多不到 0.2ms；
轨迹是纯渲染，**零写口**（落库仍只有松手那一条 undo）。右键擦除的轨迹用暖色（`erase:true`），一次拖动的
"擦掉谁"仍由 `reliefEraseRadius` 决定，本层不参与判定。

⚠️ 这还不是第 2 件的全部：四笔一表里还有"实例可选中可移动"与其余三支笔的接线（见指南 04 §二）。

---

## 十一、镜头语义一刀：画省不再抢镜头（2026-10-24 10:5x）

§七.5 量到的另一处浪费：`watch([baseMapKey, terrain.length])` 把"省数变了"当成**该适屏了**，
只豁免 `provincePaint`（笔刷建省），自由绘制没豁免。实测（`_probe_land_camera.js`）：
镜头先在 `{x:67.6, y:-53.5, scale:0.3549}`，画一个省，**松手后 800ms 内自己变成**
`{x:45.3, y:-50.3, scale:0.4894}` —— 既是第三遍全量重绘，也是"手一松镜头就跳"。

**改法**：这条 watch 只在**换底图**（`baseMapKey` 变）时适屏，同一张图上增减省份一律只重绘。
为什么敢这么砍 —— 真正需要适屏的入口**本来就各自显式调了 `fitToView()`**：

| 入口 | 谁负责适屏 |
|---|---|
| 打开 / 切换底图 / 项目装载（组件重挂） | `onMounted` 首帧 + `watch(immersive)` + 本 watch 的 `mapChanged` 分支 |
| 导入 `.map`（含"刷新底图数据"） | 导入流程末尾 `setTimeout(fitToView, 50)`（与写数据同一个函数，不会漏） |
| 用户按 F / 滚轮 / 拖拽 | 用户自己说了算 |

**判据**：

| 判据 | 读数 |
|---|---|
| 画一个省之后镜头不动 | ✅ `before = afterMouseUp = afterSettle = {x:67.6, y:-53.5, scale:0.3549}`，`cameraJumped: false`（原：0.3549→0.4894） |
| 换底图仍适屏 | ✅ `mapChanged` 分支一字未动；`test_61` 首帧相机断言照旧（`[595.07, 330.51, 0.4684]` 已适屏） |
| 导入仍适屏 | ✅ 导入流程里那一行显式 `fitToView` 未动；`test_96` / `test_94` 全绿 |
| 这一刀不碰数据 | ✅ 9 个最相关的场景用例（52/61/63/73/79/90/94/96/121）全过，无写口变化 |

> 计数（`lastFitKey` / `lastFitCount`）仍然记账 —— 切走工具后不会"还欠一次适屏"而突然跳一下。

---

## 十二、第 2 件续：地貌图标「实例可选中可移动」（2026-10-24 11:0x）

第 2 件判据里明写的一项（指南 04 §二：**拖动中 = 笔迹轨迹 + 图标；松手 = 图标入库**；实例可选中可移动）。

| 改哪 | 改成什么 |
|---|---|
| `store/geodataModules/mapDataEditing.js` | 新增 `moveReliefIcons(planetId, [{id,x,y}])`：**快照式 undo**（与散布/擦除同一套），一次拖动 = 一条命令；`execute` 前先算 before/after → 函数首行 `guardWrite`（已登记 `MEMORY_WRITE_CALLSITES`） |
| `composables/useReliefBrush.js` | 命中/选中/拖动预览：`hitReliefInstance`（后画的优先，半径 = 图标半边长×0.8）、`beginInstanceDrag` / `moveInstanceDrag`（**只改预览、不碰存储**）/ `endInstanceDrag`（真动过才落库）、`reliefInstanceIcons`（预览列表）、`selectedReliefIcon` |
| `composables/planetInteractions.js` | 左键先问"点中图标了吗"：点中 → 拖它（抑制平移）；点空白 → 照旧开始散布。松手落库 + 只读态回音 |
| `composables/planetDrawing.js` | `drawReliefSelection`：双同心圆 + 虚线外环（不用方框 —— 图标是圆的，方框会和邻居挤在一起） |

**判据（新用例 `test_137`，每条都带反证）**：

| 判据 | 读数 |
|---|---|
| 点中 = 选中，**零写入** | `selectedReliefId` 有值；undo label 与图标数一个没变 |
| 拖动 = 位置变、条数不变、**一条 undo** | `(-216, -27)` → `(-126, 22)`；label「移动地貌图标」；10 颗还是 10 颗 |
| 撤销 = 逐位回原位 | 撤销后 `(-216, -27.442469…)` **逐位相等**（不是"差不多"） |
| 点空白收选中，且不误挪 | `selected` 变 null，图标数与位置都不动 |
| 只读态诚实 | 拖得动预览，松手后**图标留在原位**、undo 栈没有"移动"命令、状态栏回音「地貌图标没移动：当前是只读态…」 |

**踩到并修掉的两个坑（都写进注释了）**：
1. **点击信用要"下次按下复位"，不能靠 click 消费** —— 程序化派发（用例/演练）常常只有 mousedown+mouseup，
   click 永不到来；信用一直挂着 → 下一次点空白清不掉选中（探针当场抓到）。
2. **状态回音不能传对象** —— `setStatus({toolLabel:…})` 会被渲染成 `[object Object]`；该通道只吃字符串
   （`exportStatus` 直接进模板插值）。

> 拖动的**落库边界**：拖动中只动预览（只读态零半截写入）；`moveReliefIcons` 还顺手挡掉"没有一项真动过"的空命令。
> 新用例同时把「点空白仍是散布、不会误挪」一起钉住；`test_31`（散布/擦除/undo/落盘载荷）照旧全绿。

---

## 十三、第 2 件续：高度笔 / 地形笔接 L2 笔迹层（2026-10-24 11:3x）

笔迹层从散布笔**抽成一份实现**（`planetDrawing.drawBrushTrail`），散布笔退成它的一个参数预设；
再把高度笔、地形笔各接一条。两支笔原本只有"格子/色带在变 + 一个预览圈"，看不到"这一笔扫过哪里"。

| 改哪 | 改成什么 |
|---|---|
| `composables/planetDrawing.js` | `drawBrushTrail(ctx, path, {color,width,outerAlpha,innerAlpha,coreRatio})` —— **四支笔共用**；`drawReliefTrail` 变成它的预设（白/暖、宽 = size×0.95）。点数 >320 抽稀、尾点必画、线宽必须落在各笔脏矩形半径内 |
| `composables/usePlanetHeightBrush.js` | `strokePath`（拖动中攒点，按"半径 8%"抽稀、320 封顶）；`endHeightStroke` / `strokeAborted` 清路径 + `markFullRedraw()` 收口 |
| `composables/useTerrainCanvasBrush.js` | 同上（抽稀按"半个格宽"）；`endTerrainBrush` / `clearTerrainBrush` 清路径 + `markFullRedraw()` |
| `components/PlanetMap.vue` | 高度笔/地形笔绘制：先画笔迹、再画预览圈（线宽压在脏矩形半径内，否则局部重绘会裁边） |

**判据（探针 `_probe_brush_trails.py`，判据是像素 + 截图 + 帧统计）**：

| 判据 | 高度笔 | 地形笔 |
|---|---|---|
| 拖动中攒出笔迹路径 | 25 点 | 25 点 |
| 数据真的变了 | 高度和 153434 → 153771.9 | 已涂格 1778 → 1811 / gridSum 变 |
| 松手后路径清空 | 0 | 0 |
| **不留鬼影**（松手取校验和 → 强制全量重绘 → 必须相同） | ✅ 3295945593 = 3295945593 | ✅ 650658983 = 650658983 |
| 10s 连拖帧数 / p95 / >50ms | 592 / **20.7** / 1 | 597 / **23.2** / 1 |
| handler/事件 | 0.19ms | 0.11ms |

> 基线（§二A 高度笔）是 30s：1801 帧 / p95 19.2 / 1 帧 >50ms —— 加了笔迹后 p95 +1.5ms，帧数持平；
> 地形笔此前没量过，这次顺手留了基线（597 帧 / 23.2）。
> 截图 `.lab-height-trail.png` / `.lab-terrain-trail.png`（人眼确认：一条半透明色带跟着手走，松手消失）。

**两个"读数陷阱"（探针里已写注释）**：
1. 地形笔拖动中必须读**组件本地网格**（`terrainCanvasBrush.terrainGrid`）—— store 里那份要等松手
   `saveTerrainGrid()` 才回写，读 store 会得到"涂了但没变"的假读数（第一版当场假红）。
2. 笔迹是**瞬态层**，只 `requestRender()` 擦不掉：两支笔的 end/abort 都补了 `markFullRedraw()`，
   并用"松手校验和 == 强制重绘校验和"做反证（鬼影会立刻被抓出来）。

⏳ **四笔还剩一支**：归属笔（`useProvinceBrush`，剧本侧）—— 指南 04 §二把它评为"最重一刀"，
且它长在账本上（松手产出事件组），按施工序**并到第 4 件**做，不在这里顺手改。

---

## 十四、第 3 件：账本引擎 `src/ledger/`（纯数据层，2026-10-24 12:0x）

**形状**（digest §三-① 已定的口径）：一条事件流
`{ id, worldId, epochId, day, type, groupId, provenance, payload }`；`day` = **该剧本内的绝对日**（可负，
由 `CalendarConfig` 换算）；`groupId` = 「一笔/一次操作」的身份；`provenance` = brush / ui / import / ai / migrate。
`initialOwnership` / `changeEvents` / `ownership` 降级为**投影缓存**（由引擎重算）。

| 文件 | 职责 |
|---|---|
| `src/ledger/schema.js` | 事件形状 + `dayOfDate/dateOfDay`（360 天/年、30 天/月，可负年份）+ `validateEvent` |
| `src/ledger/replay.js` | `projectOwnership(ledger, {atDay})` —— **全仓"某省某天归谁"的唯一实现**；`eventsFromV2` 是 v2 形状适配器；`diffOwnership` |
| `src/ledger/groups.js` | 整笔撤销：`groupIds/groupInfo/removeGroup/insertGroup`（**基线没有 groupId，结构上撤不掉**） |
| `src/ledger/migrate.js` | v2 剧本 → 账本（基线 + 事件；合成事件标 `migrate`）+ `verifyMigration`（逐省对拍）+ `toV2Projection`（缓存重算） |
| `src/ledger/index.js` | 公开面 + `assertLedgerShape` + `makeEmptyLedger` |

**"只有一份回放"不是口号**：`utils/scenarioLedgerV2.deriveFrom` 现在**改为**把 v2 形状喂给
`ledger/replay.js`（原来那份 cmpDate 排序实现删掉了）。等价性由 `a5` 段拿两份实现**逐省对拍**守着。

**判据（新单测 `unit/test_ledger_core.js`，6/6）**：

| 段 | 判据 | 读数 |
|---|---|---|
| a1 | 日换算（负年份 / 缺省月日 / 越界夹紧）+ 事件校验 | 8 条换算 + 1 合法 + **4 条坏事件全被拒** |
| a2 | 回放：基线 / 切片 / 最后赢 / `null` 删键 / 同日按流内先后 | 5 条口径全对 |
| a3 | **400 省 × 2000 事件回放 < 50ms** | **0.6ms** |
| a4 | 组撤销：整笔摘下再放回**逐省还原**；基线永远摘不掉 | 6 组、事件顺序也一致 |
| a5 | 与 v2 `deriveFrom` **逐省对拍** | 4 份样本（负年份 / 无月日 / null 无主 / 同日两条）0 处不一致 |
| a6 | 纯数据层守卫（`src/ledger/*` 不 import vue/store/组件、不碰 DOM）+ **反向探针** | 5 个文件零外部依赖；把 null 删键改成挂 null → 结论立刻不同 |

**415 省孤本试算（只读）**：`node scripts/ledger-dryrun.mjs --project <绒花计划.sitian>`
——13 段、**冲突 0**、11ms、跑完文件大小/mtime 未变（只读自证在脚本里）；
事件量与日区间见表格（例：玦王朝 158 事件 / -148680..-51840）。

**踩到的坑（都写进注释）**：
1. `EVENT_TYPES['epoch.baseline']` 取到的是**中文标签**不是键 → 基线一条都不认、整段归属为空。
   现在类型键是常量 `EVENT_BASELINE` / `EVENT_OWNER_CHANGED`。
2. `Number(null) === 0` 且 `isInteger` 为真 → "没给月份"被当成 1 月、`d` 还生效（`{y:5,m:null,d:9}` 算成 5 年 9 日）。
   先判"有没有值"再归一。
3. 单元测试的 ESM 复制加载器原来只处理**同目录** `./x`；`scenarioLedgerV2` 现在跨目录 import `../../../ledger/replay`
   → 改成**按仓库相对结构**复制（否则用例整片红，而产品是好的）。

⏳ **第 3 件还没完**：笔画对象模型（`{strokeId, generator, params, rawPoints, geometry}`）与四笔总装
（第 4 件）尚未落地；归属笔的写口要等这一步把 groupId 接上。

---

## 十五、第 3 件续：笔画对象模型（`src/ledger/stroke.js`，2026-10-24 12:3x）

按 digest §一-C 的三处改法落码：**落事件不落状态**、**原始点与简化参数都存**、**命名拆开三支笔**。

| 形状 | 说明 |
|---|---|
| `{strokeId, kind, generator, params, rawPoints, geometry, geometryDigest, epochId, day, provenance, createdAt}` | `kind` = `outline`（轮廓勾画）/ `terrain`（地形笔刷填充）/ `scatter`（散布笔刷实例分布）；`generator` 是**名字**，真正的生成器由调用方在回放时传进来（渲染层那几份 `simplifyPath` / `scatterAlongPath` / 网格填充）——本层不复制几何算法 |

四个入口：
- `makeStroke`：唯一构造口（rawPoints **原样保留**，不去重不抽稀）
- `validateStroke`：kind 登记过 / 有 generator / rawPoints ≥2 且逐点合法 / **散布必须带 seed**（没 seed 不可复现，静默故障）
- `replayStroke(stroke, generate)`：用调用方生成器重算 geometry，与 `geometryDigest` 比对
- `strokeEvent`：落一条 `stroke.committed`（payload 只带这笔本身；`groupId` 默认 = `strokeId` → 一笔一组便于撤销）

**判据（单测 a7 / a8，真实生成器）**：

| 段 | 读数 |
|---|---|
| a7 轮廓（RDP，`geometry.simplifyPath`） | 400 点 → **26 点**，回放指纹一致；rawPoints 仍是 400 点（没被生成物覆盖） |
| a7 散布（`reliefIcons.scatterAlongPath`，seed=7） | 16 个实例，回放指纹一致；JSON 往返后指纹不变 |
| a7 地形（填充型生成器，27 格） | 回放指纹一致 —— 本层不关心生成器内部是路径还是填充 |
| a8 反向探针 | 改 `tolerance` / 改一个原始点 / 换 `seed` → 指纹**必变**；缺 seed 的散布**被拒** |

**一个必须剔除的假红**：散布实例带 `id`（`nextReliefId()` 每次不同）——那是运行时标识、不是几何，
进指纹会让"同一笔回放两次"永远判失败。所以指纹按 kind 投影：`scatter` 只取 `{type,x,y,size,rotation}`；
轮廓/地形原样（`strokeGeometryView`）。

> 至此第 3 件的两半（引擎五件 + 笔画模型）都齐了。**剩的是接线**：归属笔写口按 `groupId` 落事件、
> 装载口把 `changeEvents` 变成投影 —— 那是第 4 件（四笔总装）的活。

---

## 十六、收落盘 380ms：IPC 传字符串（2026-10-24 13:0x）

digest §三③ 的第二刀。落盘那条路原来是**三份开销**：
渲染侧 `JSON.stringify`+`JSON.parse`（造对象）→ `ipcRenderer.invoke` 用 V8 把 3.6MB **对象图**克隆一遍
→ 主进程再 `JSON.stringify` 一遍写盘。

| 改哪 | 改成什么 |
|---|---|
| `utils/projectSchema.js` | 新增 `toIpcJson(value)`（**文本版**下载口，与 `toIpcPlain` 同一 `unwrapRaw`+`jsonSafeReplacer`）；`toIpcPlain` 改为 `JSON.parse(toIpcJson(value))` —— 序列化口径**只有一份** |
| `store/projectStore.js` | `projectSave({ filePath, projectJson: toIpcJson(withSnapshot) })` —— 只序列化一次，递字符串 |
| `main/handlers/projectHandler.js` | 拆出 `atomicWriteText`；`atomicWriteJson` 变薄壳；`writeProjectFile` 接受**文本或对象**；`project-save` 认 `projectJson`（字符串）优先、`project`（对象）兼容 |
| 测试侧 | mock 两种形态都照真边界检查（字符串 → `JSON.parse` 存 mock 库；对象 → 仍 `structuredClone`，代理照旧被拒）；harness 的记录口先把 `projectJson` 解析回 `p.project`，**29 处读 `.project` 的用例一个字不改** |

**复测（同机 / 同 200 省底图 / `_probe_save_tick.js`）**：

| 读数 | 改前 | 改后 |
|---|---:|---:|
| `saveProject` 整条（p50） | 372.9ms | **≈ 63ms**（两次独立采样 63.9 / 62.7） |
| 落盘那一下**长任务** | — | **61 / 76ms**（一次） |
| 其中 `pushSnapshot` | 32.3 | ~18 |
| 其中 mock 的 `projectSave`（生产里换成"主进程直接写盘"） | — | ~12 |
| 其中 `toIpcJson`（3.6MB 原始树） | — | ~15-25 |

> **读数陷阱（探针里已写注释）**：`toIpcJson` 在探针里对 `{...ps.project}`（代理树）量出来是 **117ms**，
> 但真实落盘路径喂给它的是 `mergeCanvasPayload` 产出的**原始树**（1-b 的 toRaw 修复），所以真实成本 ~20ms。
> 拿错对象量，会把"代理读"的账算到序列化头上 —— 与 1-b 同一个坑。

**生产与模拟的差别（如实记）**：mock 收到字符串后仍要 `JSON.parse` 一次（`__projects` 要按对象回给
`projectOpen`），生产里主进程**只写文本**、没有这一下。所以真机应比 63ms 再少 ~12ms，约 **50ms 上下**；
本机模拟环境不再多测（要真机读数得等 `diag_t2_save.py` 那一档）。

**判据对账**：`test_85`（IPC 边界）改为守"走 `toIpcJson` 文本 + 反证不许回到对象/代理"，
g1 探针仍证明**代理会被拒**；`test_55` / `test_115` / `test_91` / `test_46` 全绿。

---

## 十七、第 4 件第一刀：归属笔 → 账本（2026-10-24 13:2x）

接线点选在 `batchSetOwnership`（笔刷与批量条共用）——**一笔一组**（`groupId` = 这一笔的 `strokeId`），
事件落 `scenario.ledger`；v2 的 `ownership` / `changeEvents` **照旧写**（缓存），
并且**每次把账本投影与缓存逐省对拍**，一致才带上账本（不一致就退回"只写缓存"）。

为什么先对拍而不是直接让账本当真源：v2 这边还有别的写口（props 面板的 `setOwnership` 等）没接线，
账本可能落后于缓存；此时若拿投影覆盖，会**悄悄丢掉**那些编辑。等第 4 件把写口收齐，才把顺序反过来。

| 判据（新用例 **test_138**） | 读数 |
|---|---|
| 一笔 2 省 → 账本 | 3 条事件（1 基线 + 2 变更）、**同一 groupId**、`provenance=brush`、`day=378000`（1050 年） |
| 投影 vs 缓存 | **逐省 0 处不同**（探针侧另用 `src/ledger` 独立再算一遍） |
| 撤销 / 重做 | 3 → **0** → 3（账本整笔回滚，不是只回缓存） |
| **无日期编辑** | 不入账（3 → 3），但缓存照写 —— 与未接线写口共存，不造假账 |
| 落盘 + 重开 | 载荷里 3 条 + groupId 不变；**重开后仍是 3 条** |
| 源码守卫 | 接线点含迁移/投影/对拍三件；组件把 `strokeId` 传下去 |

**踩到的坑**：`ledgerNext` 必须是**三态**（对象 = 换 / `undefined` = 这刀不碰账本 / `null` = 撤销回"当时没有账本"）。
第一版只写了"null = 删"，于是**无日期编辑把整本账删了**（3 → 0）——用例当场抓住。

⏳ 下一步（第 4 件续）：把其余归属写口（props 面板 / 油桶 / 批量条）也接上，然后**把顺序反过来**
（账本当真源、缓存由投影重算），再给 Ctrl+Z 做"两栈分派"（成分账本组撤销 / 几何走既有栈）。

---

## 十八、第 4 件第二刀：归属写口收口 + 真源反转 + 双栈撤销（2026-10-24 14:0x）

三件事一起落，因为它们互为前提（写口不收齐 → 反转会丢编辑；不反转 → 组撤销没有缓存可回）。

**① 唯一落库口**：`scenarioEditing.ownershipCommand()` —— 油漆桶 / 属性面板（`setOwnership`）、
清归属（`clearOwnership`）、笔刷与批量条（`batchSetOwnership`）四个入口全部走它。
`provenance` 按来源分派（`strokeId` → `brush`，否则 `ui`），`groupId` 缺省自动生成
（`own-<ts>-<seq>`，不用随机数）。

**② 渐进反转**（判据 = 账本解释得了缓存，即 `project(base)` 逐省 == 缓存）：

| 情形 | 缓存来源 | 是否入账 |
|---|---|---|
| 账本解释得了 + 有日期（产品常态） | **`toV2Projection(账本)` 现算**（真源反转） | 入账（一笔一组） |
| 账本解释不了（改省界/合并/铺底迁移了归属 id；或旧档只写缓存） | 手算（与第一刀前逐字段一致） | **投影对拍上了才入账**，否则只写缓存并 warn |
| 无日期 | 手算（只动 `ownership`/`changeEvents`） | 不入账（账本按日回放，编不出日期就不写） |

反转后 `ownership` = 账本**终态投影**（同日按流内先后、`null` = 删键）。与旧行为唯一的可见差异：
**乱序上色时终态缓存是"最后一条事件"而不是"最后一次点击"** —— 这正与重开项目后
`normalizeLedgerDict` 的派生结果一致（原来两者会不一致，重开才"变"）。

**③ 双栈撤销**：归属条目在历史里带 `stack: 'ledger'`，undo = `removeGroup(groupId)`（整笔摘下）→ 缓存按投影重算；
redo = `insertGroup` 插回原位。几何/河流/道路等仍是 `stack: 'snapshot'` 的快照闭包。
两种条目共用**一条操作时序**（`store/undo.js` 的线性历史）——
digest 原话是"按最后一次操作属于哪个栈分派"，落码时改成"每条条目自带所属栈"：
两个独立栈指针**无法还原交织顺序**（几何 A → 归属 B → 几何 C 之后连撤两次，光看"最后一次属哪栈"会退错），
而单一时序天然正确，且 `jumpTo`（历史面板）照旧可用。

顺带修掉一个静默缺陷：原来 `execute()` 的 undo 不触发自动保存 —— 撤销归属后不落盘
（只有再编辑一次才顺带保存）。现在 `writeLedger`/`writeCache` 都调 `scheduleAutoSaveScenarios()`。

| 判据（test_138 扩到 8 组） | 读数 |
|---|---|
| 属性面板写口 | `ledger` +1 条、`provenance=ui`、**自动 groupId**（不复用笔刷的）、day=381600（1060 年） |
| 反转 | 投影 vs 缓存 **0 处不同**（探针侧独立再算） |
| 账本组撤 | 3 → **0**（连账本键一起回到"当时没有账本"）→ 3 |
| 双栈交织 | 涂归属(账本) → 改谱系(快照) → 撤/撤/重做/重做：账本 4→4→3→4→4，谱系只在快照那一步进退，**互不回滚** |
| 无日期编辑 | 不入账（4 → 4）但缓存照写；**重开后仍在**（v1 形状不主动长出 `initialOwnership`，装载口就不会按账本覆盖它） |
| 落盘 + 重开 | 4 条 + 笔刷 groupId 仍在 + 重开 4 条 |

另一处补漏（同刀）：`toV2Projection` 原来把月日**写死成 `Math.floor(day/360)`**、丢掉合成事件、
同日不去重 —— 反转一开始用就会"事件表里的 1050 年 6 月变成 1 月"。现在：
月日优先取 `payload.at`（写口当时给的原形，`m/d` 缺省仍留 null），迁移事件按历法 `dateOfDay` 换算；
合成事件照旧带 `synthesized: true`；同日收成一条（v2 的 `findEventIndex` 就是这个口径）。

**已知缺口（本刀刻意留着，下刀再收）**：改省界 / 合并 / 批量铺底会把归属**迁移到新省 id**（`provinceEditing.buildOwnershipAfter`），
这条路径不写账本 → 之后该剧本的归属编辑会一直落在"账本解释不了"的降级分支（**不写假账，但也不入账**）。
要收它得让账本事件跟着 id 迁移改写 payload（含 v2 的 `initialOwnership`，那里现在也没迁移 —— 是个更早的隐患）。

---

## 十九、第 4 件第二刀续：把"账本会停在降级分支"这条隐患收掉（2026-10-24 15:0x）

§十八 留的缺口不是"少个功能"，是**会静默退化**：改一次省界，这个剧本从此再也不进账。
这一刀把它连同"其它写口绕过账本"一起收掉 —— 现在归属的**键**和**事件表**都有唯一落点。

**① 纯函数层（`src/ledger/migrate.js`，Node 单测 a9 守）**

| 函数 | 干什么 | 关键口径 |
|---|---|---|
| `remapOwnershipDict` / `remapChangeEventsDict` | 归属字典/事件表的键改名、删省 | 无改动**返回原引用**（调用方可跳过写盘） |
| `remapLedgerIds` | 账本：基线 payload 的键、事件 payload 的 `provinceId` | 省没了 → **整条事件摘掉**（留着会让那个省在投影里永不消失） |
| `remapScenarioOwnership` | 上面四件事一次做完（ownership / initialOwnership / changeEvents / ledger） | 只改缓存不改账本 = 断链，反向探针钉住 |
| `forkScenarioProvince` | 一省拆多省：新省继承源省的归属 + v2 事件 + 账本历史 | **保留源事件 + 追加副本**（第一版写成"改名"，第一次 fork 就把源事件吃了 → 后几个新省没历史）；副本 id 必须唯一 |
| `replaceProvinceEvents` | 易主日期面板：整列表替换某省的显式事件 | 先摘该省全部 `province.owner.changed` 再按新表追加 |
| `setLedgerBaselineOwner` | 清空显式日期时把基线改成本代当前归属 | v2 语义本来就是"没有事件的省，本代开始时就是这个主人" |

**② 接线（四个曾绕过账本的写口）**

- `provinceEditing.buildOwnershipAfter` / `collectOwnershipBefore` / `applyOwnership`：快照里**连 initialOwnership 与 ledger 一起抓**，
  铺底时走 `forkScenarioProvince` + `remapScenarioOwnership(remove)`；undo 直接放回引用（O(1)）。
- `removeBaseProvince` 级联：删省时账本/基线一起摘；undo 用捕获的四个引用还原（`changeEvents` 的旧值也补回来了 —— 这条曾被 test_77 抓红）。
- `removePolity` 级联：同一条路（`provinceRemove = affected`）。
- **易主日期面板**（`setChangeEvents` / `setChangeEventsBulk`）：新增唯一落库口 `changeEventsCommand()` ——
  账本解释得了缓存就替换该省的账本段（undo = 整本账的引用快照），否则退回只写缓存。
  不接的话，面板刚录的日期会被**下一次归属编辑按投影重算时抹掉**（这是反转带来的新风险，`test_139` 直接钉住）。

**③ 自愈**：`ownershipLedgerBase` 发现手里的账本解释不了缓存时，**按 v2 事实重建**一本并 warn（旧 groupId 失效、
历史条目撤销会退回缓存快照），而不是继续拿落后的账往下走。剩下任何没接线的写口最多让账本"落后一次"。

**④ 顺带修的真缺陷**：批量条「统一设为该日 / 固化推算值」只传 `{y,m,d}` 不传 owner → 事件变成"那天起无主"。
平时看不出来（v2 缓存 ownership 没跟着改），但账本按事件回放时那一片**直接变无主**（test_78 的 f3 因此崩在找不到按钮）。
单省输入框一直是对的，批量条漏了；现在 `yearRows` 带 `owner`，两个批量动作都写回。

| 判据（新用例 **test_139**，端到端） | 读数 |
|---|---|
| v2 剧本涂一笔 | 账本 0 → 3 条（基线 + 继承事件 + 这一笔），投影 0 处不同 |
| **批量铺底** 1 省 → 2 块 | 基线 / 事件 / initialOwnership 三处旧 id 清零、新省全继承、投影一致 |
| 铺底后**再涂一笔** | 4 → 5 条、groupId 是新的 → **账本没退化**（这是本刀的核心判据） |
| 删省 | 账本 5 → 4 条、p139b 在 ownership/基线/事件三处清零 |
| 面板改日期后再涂一笔 | 面板那条**还在**（没被投影抹掉）；撤销面板能回上一层（1050） |
| 落盘 + 重开 | 5 条 + 归属键不变 + 投影一致 |

另：`test_77`（删省级联 undo 要还原易主日期）、`test_78`（批量日期 + 固化）这两条**是这一刀修完才绿的**
（它们本来就在守真缺陷，只是以前走的是另一条不会暴露问题的路径）。全量 **139/139** + 53 个 Node 单测 + `npm run build` 全绿。

---

## 二十、第 4 件第二刀收尾：装载口也认账本（真源闭环，2026-10-24 17:0x）

§十九 之后，"账本是真源"只在**写口**成立：`normalizeLedgerDict`（装载口）仍只认 v2 的
`initialOwnership + changeEvents`，`scenario.ledger` 被完全忽略。后果很具体：手改文件、半途迁移、
旧版本写盘造出的**陈旧缓存**，会在重开项目时把账本盖回去 —— 真源只在内存里成立一次。
（这也是本仓最怕的那类缺陷：不报错，只在"重开一次"之后表现为"我的编辑少了一块"。）

**改法**（`utils/scenarioLedgerV2.normalizeLedgerDict`）：两级事实源

1. `scenario.ledger` 存在且 `assertLedgerShape` 通过 → `ownership` / `changeEvents`（以及已有 v2 的
   `initialOwnership`）一律按 `toV2Projection(ledger)` 重算；不一致就**覆盖并点名**（warn）。
   装载口**不动账本**（只读它）。
2. 没有账本，或账本形状坏了（如缺基线）→ 回落 v2 派生；**坏账本绝不用来覆盖缓存**
   （用坏数据盖好数据比不盖更糟），只 warn + 点名。
3. 一致时**不换对象引用**（避免每次打开项目都白换引用 / 触发无谓重渲染）。

| 判据 | 读数 |
|---|---|
| Node 单测 **a10** | 账本优先（坏缓存被纠正并点名）/ 形状坏了不覆盖（构造一个"会投影出不同结果"的坏账本，确认听的是 v2）/ 一致时不换引用 / v2 回落原样 |
| **test_139 ⑦**（端到端反向探针） | 内存里把缓存清空 → 走产品自己的装载口 `applyScenarioState({fresh:true})` → 归属键按账本恢复 2 个、`changeEvents` 重建、**账本 5 条一条没动** |

全量 **139/139** + 53 个 Node 单测文件（账本 10/10 项）+ `npm run build` 全绿。

---

## 二十一、第 4 件四笔总装 · 地形笔的 L3「将涂格」（2026-10-24 17:3x）

04 号指南对地形笔的要求是**预览后提交**：「拖动中 = 真笔迹 + 将涂格高亮；松手才批量写格 ——
松手前你先看见这笔下去会填哪些格，再决定认不认」。此前是边拖边写：用户看到的永远是"已经涂上"，
没有反悔的余地，误笔只能靠 Ctrl+Z 才发现。

**改法**（三处，只有一份格枚举）：

| 位置 | 改动 |
|---|---|
| `utils/terrainBrush.js` | 抽出 `forEachCell` / `forEachInterpolatedCell`（**不写数据**）；`paint` / `paintInterpolated` 改成复用它 —— 预览与落库从此是同一份扫描逻辑 |
| `composables/useTerrainCanvasBrush.js` | 拖动中只把"这一笔会碰到的格"记进 `pending`（无界格点，起笔时钉原点）；`drawTerrainPendingToCtx` 按行合并成连续段半透明叠色；**抬手**才 `commitPendingStroke()` 沿**原始落点**重放写格 |
| `components/PlanetMap.vue` | 地形块里先画「将涂格」，再画笔迹、再画预览圈（图层顺序：数据 → 将涂 → 轨迹 → 指示器） |

三条容易踩的口径：
1. **落库回放用原始落点**，不是 L2 显示用的抽稀路径 —— 抽稀会丢中间点，回放的折线与预览扫过的折线不同，
   边角上必然对不上（"高亮了却没涂上"）。
2. **笔刷类型固定在起笔时**：拖动中改类型会让预览混两色、落库全按最后一种。
3. **扩网格挪到抬手**：拖动中不写数据 → 不需要扩；起笔仍扩一次，让预览原点落在网格内
   （扩网格只平移整数格，世界格对齐不变，所以预览格与落库格是同一批）。

顺带一个白捡的好处：以前"按下后中途取消/切工具"会先写进格子再靠快照丢弃；现在拖动中没写过，
取消就是干净取消。

| 判据（新用例 **test_140**，真实 UI 事件） | 读数 |
|---|---|
| 拖动中**不写格** | 5 步、每步快照对比：网格**逐字节未变**（0 步变化）、类型计数 0→0 |
| 拖动中确有「将涂格」 | 按下 32 个 → 最后一段 356 个（单调增长） |
| **所见即所得** | 抬手上，356 个预览格**全部**落成这一笔的类型（越界 0 / 漏 0） |
| 抬手收口 | pending 清空、落库 0→356、**一条 undo**、撤销**逐字节**回到按下前（含几何）、重做 356 |
| 像素证据 | 第一段中点像素差 > 12（被高亮盖住变色）；远离笔迹的对照点**差 0** |
| 源码守卫 | 预览与落库共用 `forEachCell`/`forEachInterpolatedCell`；`moveTerrainBrush` 里**不许**出现 `paint*` |

全量 **140/140** + 53 个 Node 单测文件 + `npm run build` 全绿。




