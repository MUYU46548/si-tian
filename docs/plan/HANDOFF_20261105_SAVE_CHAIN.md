# 交接页：保存链分块化（2026-11-05）

> 起因是这张卡：**“撤销连按被保存链拖住：主线程占满 1~3 秒”**（真机读数 + 8.2MB 真实项目）。
> 现状一页纸：[STATUS_20261103.md](STATUS_20261103.md)｜总入口：[PLAN_AUDIT_20261030.md](PLAN_AUDIT_20261030.md)。
> 动 `store/projectStore.js#saveProject`、`utils/projectSchema.js` 的快照/序列化之前，先读完这一页。

## 一、现象与归因（不是撤销命令的账）

工具 `npm run test:undo-latency`（`scripts/tests/drill_undo_latency.py`），环境：真实 Electron +
Vite(5180) + **真实 415 省项目副本**（8.2MB / 415 省 / 27,067 顶点 / 573 河 / 14 段剧本）。

- 单次撤销**没问题**：撤销命令同步段 1~5ms，按键到下一帧 39~107ms（大头是整图重绘）。
- 出问题的是**连按**（0.3s 一步 × 5，就是用户连敲 Ctrl+Z）：3 秒窗口里 **rAF 一帧都没有**，
  单段长任务 250~953ms。
- 分段归因（`saveProject` 每段打点 → `window.__SITIAN_SAVE_LOG__`；离线基准 `scripts/tests/tools/bench_save_stages.mjs`）：

| 段 | 成本（8.2MB 项目） | 说明 |
|---|---|---|
| `exportCanvas` | 1~6ms | 1-b 已改成"只换壳不深拷" |
| `snapshotState` | 55ms（**真机 150ms**） | 4 个键的深拷；旧顺序是**先深拷、再剔重字段** → 1.2MB 高度图白拷一遍 |
| `pushSnapshot` | 92ms | `replayTo`（深拷 base）+ diff + **逐份数体积**（最多 50 份、3MB 上限） |
| `toIpcJson` | 88ms | 整份 8MB 一次 `JSON.stringify` |
| IPC 写盘 | 43ms | 主进程 `atomicWriteText` |

连按时还有第二层放大：**剧本层 300ms + 项目层 800ms 两层防抖交错**，会出现两份保存同时在跑
（一份 `await IPC`、另一份已经开始快照/序列化），同步段首尾相接 → 主线程被连续占满。

## 二、四刀（都在 `projectSchema.js` / `projectStore.js` 里）

1. **串行**：`projectStore` 里 `saveChain`，同一时刻只有一条保存流水线（`saveProject` 只排队，
   真活在 `saveProjectNow`）。
2. **分块 + 让出一拍**：
   - `snapshotStateChunked(project, keys, { yieldFn })` —— 逐键深拷，键与键之间让出一拍。
   - `toIpcJsonChunked(value, { yieldFn, onPiece })` —— 按**结构边界**切块
     （顶层键 → `scenarios.baseMaps.*` → 每个基底自己的字段；`maps.mapData.*`；`snapshots` 逐份），
     每块仍用**原生** `JSON.stringify`，块之间让出。
   - 🔴 **产物必须与整份 `toIpcJson` 逐字节相同**：`unit/test_save_chain_chunked.js` 的 a1/a2 直接对拍
     （混合夹具踩 JSON 转义 / `undefined` 键 / TypedArray / 数字边界），a3 是负向探针（改一个值必须不等）。
     自己写流式序列化器迟早和原生漂移（孤代理对、控制字符、数字格式），所以**只切边界、不改口径**。
3. **快照侧去掉三处白干的活**：
   - 体积**一份只量一次**（`WeakMap<快照条目, 字节>`）；`snapshots.slice()` 取代 `map(s => ({...s}))`
     —— 条目本就不改，克隆一次就让缓存永远 miss。
   - 顺序保存时"上一份快照的状态"**就是上一次刚算出来的 state** → 直接复用（`lastSnapshotStateCache`，
     按"快照数组引用 + 最后一份条目引用"判定），免掉 `replayTo` 的整份深拷；回滚/重开/外部改动换数组 → 老实重放。
   - 重字段**先剔再拷**（`stripHeavyForClone`）：真机 `snapshotState` 150ms → 44ms。
4. **看门狗**：`SAVE_WATCHDOG_SEC = 20`，超时就把失败摆到界面（`setSaveStatus('error')` +
   `reportSaveFailure`）。理由是下面那条真机事故：保存链挂住时界面**一点提示都没有**。

## 三、真机读数（本机 / 8.2MB 真实项目副本）

| 项 | 改前 | 改后 |
|---|---|---|
| 连按 5 次撤销：窗口里出帧 | **5/5 步零帧** | **5/5 步都出帧**（121/112/93/74/55 帧） |
| 连按 5 次撤销：单段最长长任务 | 305 / 953ms | **53 / 53 / 57 / 57ms** |
| 单次撤销的长任务（撤销本身窗口） | 54~757ms | 0~101ms |
| 一次自动保存总时长 | —（三份并行更久） | 243~409ms（分段见下表） |

一次保存的分段（`__SITIAN_SAVE_LOG__`，探针读数）：`exportCanvas` 1.4~6ms / `snapshotState` 44~150ms /
`pushSnapshot` 11~80ms / 分块序列化 90~200ms / IPC 42~88ms。

## 四、两个只在真机上才发现的坑（改这条链必读）

1. 🔴 **`MessageChannel` 必须 `onmessage` + 显式 `start()`**。
   第一版用 `port1.addEventListener('message', …)`：在这台 Electron 的渲染进程里**收不到消息**
   （页面内实测 race 3s 超时；同一条通道换成 `onmessage` + `start()` 立刻 0ms）。
   后果是**保存整个卡死**：`saveProject()` 永不 resolve、`saveStatus` 永远 `saving`、一个字节都没落盘，
   而且**界面上没有任何报错** —— 演练读数里只看到"零帧"，很容易误判成性能问题。
   现在 `yieldToEventLoop()` 带 8ms 墙钟兜底（消息不投递也照样醒），连续 3 次走兜底就永久退
   `setTimeout(0)`；单测 g/h 把这两条钉住（假通道 6 拍必须都在 200ms 内返回；真通道 <5ms/拍）。
2. 🔴 **排查"改了没落盘"不要靠时延演练**（它只看帧与长任务）。用
   `python scripts/tests/tools/probe_save_chain.py` 直接问 store：它会打印 `saveProject` 的返回、
   `dirty` / `saveStatus` / `lastError`、`__SITIAN_SAVE_LOG__`、以及**磁盘 mtime 是否真的变了**。
   （探针自带 8s 墙钟上限，保存卡住时会返回 `timeout` 而不是崩在 CDP 15s 读超时上。）

另有两个**演练环境**的坑（不是产品缺陷，已写进 AGENTS.md）：

- 窗口被别的窗口盖住时 rAF 会停（Windows 遮挡检测 + Chromium 后台节流）→ 整段"零帧"，
  历史读数好/坏交替就是这么来的。`drill_undo_latency.py` 启动 Electron 时带了四个禁用开关。
- A 段"目标省"以**画布中心命中**的省为准：小省居中后会偏出中心点，旧判据（扫描省 == 中心省）
  曾一红一绿随机翻（`_229` vs `_194`）。

## 五、命令与产物

- 判据（秒级）：`node scripts/tests/unit/test_save_chain_chunked.js` —— 11 条（逐字节对拍 / 分块粒度 /
  分块与整串等价 / 快照缓存正确性 / 入参不改 / 让出一拍的兜底）。
- 真机时延：`npm run test:undo-latency` —— D 段**已补闸门**（`--budget-chain` 默认 200ms + 每步必须出帧），
  `result.json`/`summary.md` 里多了一张**保存链分段表**。
- 保存落盘探针：`python scripts/tests/tools/probe_save_chain.py [--project <file.sitian>] [--keep]`。
- 离线分段基准（只读项目文件，不写盘）：`node scripts/tests/tools/bench_save_stages.mjs [<file.sitian>]`；
  CPU 样本分桶：`node scripts/tests/tools/agg_save_profile.cjs <profile.json> [桶宽ms]`（把演练的样本按 100ms 分桶读）。

## 六、还剩的（不在本轮范围）

- `pushSnapshot` 仍是**同步**一段（真机 11~80ms，大头是 diff）；要更细就得把 `diffStates` 也分块/按代缓存。
- 反过来的"到下一帧 39~107ms"全在**整图重绘**（时间轴重算已缓存），再往下要分层/脏区渲染
  （与 A4“涂归属”卡的余项同源）。
- 保存链的**分段读数目前只落页面全局**（`__SITIAN_SAVE_LOG__`），还没进诊断包（`diagExport`）。
  要排真实用户的卡顿，下一步应把它带进诊断包。
