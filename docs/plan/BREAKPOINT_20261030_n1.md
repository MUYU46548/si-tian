# 断点（2026-10-30 22:4x，N1 刀 1/刀 2 进行中）

> 用户在这一轮末尾叫停：「时间不够了，为我保存进度，总结断点与未完成内容」。
> 本文是**接手用**的一页纸：现在在哪、还差什么、怎么继续、哪些坑别重踩。

---

## 一、此刻的仓库状态

- 分支 `main`，与 `origin/main` 同步到 **`d151192`**（本轮 features 那刀尚未提交，见下）。
- 工作树**只有**本轮未提交的改动：`src/renderer/src/scenario/layers/features.js`（新）、
  `src/renderer/src/components/ScenarioMap.vue`（删 174 行 + 接线）、`scripts/tests/drill_scenario_pixels.py`（基线场景加地图要素）。
- `ScenarioMap.vue`：**13,009 行**（起点 14,277）；`draw*` 剩 7 个左右未迁。

### 已提交的四个 N1 提交（都逐像素验证过）
| 提交 | 内容 |
|---|---|
| `8799d52` | 渲染层注册表 + 六层顺序变成数据（`scenarioLayerRegistry.js`） |
| `060b26c` | 底图 / 海岸浅滩 / 省界三层绘制体搬出 |
| `877d173` | 文字标注层搬出（`labels.js`，四层迁完） |
| `ac84cf2` | 刀 2：屏幕空间浮层 4 块（`overlays.js`：小地图 / 图例 / 分布图 / 悬浮卡） |
| `d151192` | 刀 2：顶点手柄 / 框选 / 笔刷圈（`editing.js`） |

### 未提交（本轮做到一半、已验证像素一致，只差回归）
- `scenario/layers/features.js`：**道路/航路 / 手画河 / 城镇（含首都星标）**
- 判据：`feat_before` 与 `feat_after2` 两枚指纹全同（`c65ed170` / 关标注 `60a2654c`，1080×484、1039 色）
  —— 注意这是**真 A/B**（把 SFC 单独退回头一个提交跑的），因为基线场景原本没有城镇/道路/手画河，
  这几层根本不触发；本轮已把它们加进 drill 的 base 场景。
- 回归：`python scripts/tests/run_tests.py` 正在跑；**绿了才可以提交**，红了先看是哪条源码闸门要跟着搬
  （大概率是 `test_73`/`test_65` 那类"函数体搬家"的闸门）。

---

## 二、N1 判据的当前状态

| # | 判据 | 状态 |
|---|---|---|
| 1 | 重构前后同机位**逐像素一致** | ✅ 静态场景 `6993c0bc`、编辑态 `df13eec4`、含地图要素 `c65ed170`，三组 A/B 全同 |
| 2 | p95 帧时**不退化** | ✅ 三档 25.0→25.3 / 18.0→18.0 / 18.0→18.0（`_probe_jank_real.py` 同机同数据 A/B） |
| 3 | 163 CDP + 72 单测**全绿** | ✅ 最后一次全量 163/163（`d151192`）；本轮 features 跑完需再确认 |
| 4 | `ScenarioMap.vue` **≤8,500** | ❌ 现 **13,009**。实算：脚本顶层函数全搬走 = **7,416**，所以可达，但那是 N1.5 |
| 5 | 刀 1 完**出内测包** | ✅ `release-internal/win-unpacked/司天.exe`（21:19 构建，含刀 1 四层）；**用户尚未验** |

**卡点**：判据 4 需要用户拍板口径 —— 走「4a：≤12,700 + 每层 view 契约」再另立 N1.5 冲 8,500，
还是把 8,500 当刀 1 硬门（那要连编辑交互一起拆）。这条从第 2 轮问到现在（第 5 轮），**尚未回答**。

---

## 三、接着干什么（按顺序）

1. **收尾本轮**：回归绿 → 提交 features（提交信息草稿在 `build/_commit_n2c_*.txt` 思路见上），push。
2. **继续搬剩余 `draw*`**（还剩约 7 个）：
   - `drawRivers`（导入河，~90 行；依赖 `displayRiverPlanCache` / `riverRunCache` / `buildRiverRun`，
     都要随函数一起进模块，并在 view 里回调 `labelLayers.drawPlanned(['river'])`）
   - `drawSelectedRiverHighlight`（~114 行；依赖 `riverSelIds` / `riverWidthSeries` / 偏移数学，
     注意 `test_112` 的源码闸门要求"不许出现裸数值线宽"）
   - `drawPreviewOverlay`（**317 行，最大的一块**；预览态/拖拽态，接刀 2 的"预览层"）
   - `drawRasterLayer`（12）、`drawReliefIcons`、`drawScenarioMarkers`、`drawBurgTooltip` 已在浮层
3. 全部搬完 = 我提议的 **判据 4a 达成**（≤12,700 早已满足，实际会到 ~12,3xx）。
4. **然后停**，等用户对 4/8,500 的口径拍板，再决定是否开 N1.5。

---

## 四、踩过的坑（别重踩）

1. **PowerShell 批量替换会毁编码**：`Set-Content -Encoding UTF8` 对 14k 行 SFC 做替换会把整份中文注释
   写成乱码（编码往返）。已改用 `node` 脚本 + `utf8` 读写；且**必须先判 CRLF**（文件是 CRLF，
   按 `\n` 拼的字符串匹配不上）。
2. **`git switch --detach` 在有未提交改动时会拒绝**，只打一行 `M xxx`。第一次 A/B 因此跑的是同一份代码，
   得到"全同"的**假绿**。A/B 的正确做法：只 `git checkout <rev> -- <单文件>`。
3. **`git checkout HEAD -- <file>` 会丢弃该文件未提交的改动** —— 本轮一度把自己刚写的接线冲掉，
   靠重跑 `build/_rewire_*.cjs` + `_strip_fn.mjs` 复原（已再次验证像素一致）。
4. **像素基线要覆盖到才会真判**：文字层、编辑态、城镇/道路/河各补过一次场景；否则那些刀是"空判据"。
5. **源码闸门会跟着函数搬家而失效**：`test_61/62/65/73/121/156` 都改过口径（判据落到模块里，
   原意不变）。新搬一块前先 `grep` 一遍函数名在 `scripts/tests/` 里的出现。

---

## 五、工具与文件索引

| 用途 | 路径 |
|---|---|
| 渲染层注册表引擎 | `src/renderer/src/utils/scenarioLayerRegistry.js`（+ `scripts/tests/unit/test_scenario_layer_registry.js`） |
| 已迁出的层 | `src/renderer/src/scenario/layers/{background,coast,provinces,labels,overlays,editing,features}.js` |
| 像素基线 drill | `python scripts/tests/drill_scenario_pixels.py --tag X [--scene edit]` / `--compare A B`；产物 `build/pixel-baseline/` |
| 行数实算 | `node build/_measure_draw_lines.mjs` / `node build/_measure_sfc_blocks.mjs` |
| 帧时 A/B | `_lab.py up` → `python scripts/tests/tools/_probe_jank_real.py _probe_baseline_scenario_map.js __SCBASE` |
| 批量改 SFC 的安全手法 | `build/_strip_fn.mjs`（按函数名删，含注释块）+ `build/_rewire_*.cjs`（CRLF 安全替换） |
| 规划与判据 | `docs/plan/PLAN_AUDIT_20261030.md`（N1 判据区 + 4a/N1.5 建议） |
| 集成审计 | `docs/plan/INTEGRATION_AUDIT_20261030.md` |

---

## 六、给用户的一句话

刀 1 四层**已迁完**、判据 1/2/3 全绿、内测包已出；刀 2 也已搬了 6 块（浮层 / 编辑态 / 地图要素）。
**只剩两件需要你**：① 判据 4 的口径（4a + N1.5，还是硬冲 8,500）；② 内测包那三件事的观感确认。
