// store/geodataModules/provinceEditing.js — 省份编辑 store 模块（**P2 矢量级归属**，2026-10-09）
//
// ctx: { execute, baseMaps, scheduleAutoSaveScenarios, guardWrite, isReadOnly }
//   `baseMaps` 是 scenarioEditing 模块持有的 ref（省份定义表就住在 baseMaps[key].terrain 里）。
//
// ── P2 之后的分工（**只有一个几何表示：多边形**）─────────────────────────────
//   · **多边形（`terrain[].points` + `extraRings`）是省份的唯一事实源**，画布只渲染它。
//   · 涂抹（笔刷 / 套索 / 点填） = 对多边形做**布尔运算**（并集 / 差集），完全不经网格：
//       - 笔刷 / 套索 → 笔迹多边形 → 目标省 `union`、相交省 `difference`（`applyRegionToTerrain`）
//       - 点填       → 「把点击处那个省整块给目标省」（复用 `mergeProvinces`）
//   · 几何算法在 `utils/polygonBool.js`（纯转换 + 注入式布尔引擎，Node 有单测）。
//
// 🔴 **为什么必须删掉旧的「网格 → 多边形写回」**：旧实现（`reprojectRings`）在抬手时把
//    「归属格轮廓」反向写成多边形 —— 精度上限 = 一个格子一条边（`DEFAULT_GRID_CELL = 14.4`
//    世界单位）→ 10525 点的真实海岸线**一次涂抹就变 ~22 点**。这是用户实测「一绘制整张图
//    就退化、很丑」的根因。详见 `docs/SCENARIO_PROVINCE_FIX_PLAN.md`。
//
// ⚠️ **`provinceLabels` 网格（下方 ensure/rebuild/clear/remove 一族）保留但已"退役"**：
//    它不再参与任何编辑或渲染，只为**兼容旧项目里的存量数据**与既有用例而留着。
//    新代码**不要**再往它里面写东西 —— 它一旦重新成为几何来源，退化就会回来。
//
// 🔴 **只读态（无项目）下的纪律**：画布编辑入口暂不灰禁，但**绝不能产生意外改动** ——
//   本模块的每个写操作都先过 `guardWrite`，被拒时返回「什么都没发生」。这样「看着能画」
//   也不会留下任何会污染知识库/项目文件的状态。UI 侧另给一句能力说明（见 ScenarioMap）。
//
// 设计要点：
//   · **不另建省份定义表**：`labels` 的值 = `terrain[]` 下标 + 1（仅网格时代遗留）。
//   · **涂抹期不碰数据**：一笔拖动只累积轨迹点，抬手时才做一次布尔并压成**一条** undo 命令。
//   · 🔴 **会重编号的操作（删除省份 / 清空归属）必须记整表快照**：删除时 `labels[i] > idx`
//     的格子会被减 1，动的是「未被删除的格子」，差量记录还原不了。
//   · **分割 / 合并也在这里**：分割走多边形直线裁剪（`splitProvinceShape`），
//     合并走布尔并集（`unionMulti`）—— 都已**不再经网格**。

import {
  gridFromProvinces, rasterizeProvinces, serializeLabels, normalizeStoredGrid,
  renumberAfterDelete, countOwned, usedIndices, gridCellCount,
} from '../../utils/provinceGrid';
import {
  shapeSignature, shapePatch, normalizeProvince, splitProvinceShape, provinceRings, provinceBBox, pointInProvince,
} from '../../utils/provinceShape';
// 🔴 P2（2026-10-09）：归属改**矢量级** —— 涂抹 = 对多边形做并集/差集，不再经格点轮廓反向覆盖。
//    `polygon-clipping` 是**纯 default 导出**（`export { index as default }`）→ 必须 default import；
//    写成 `import * as pc` 会得到 `{ default: {…} }`，`pc.union` 是 undefined（静默失效）。
import polygonClipping from 'polygon-clipping';
import {
  ringToXY, provinceToMulti, multiToShape, isEmptyMulti,
  traceBrushRings, ringsToMulti, unionMulti, differenceMulti, intersectsMulti, rdpSimplify,
  multiBBox as boolMultiBBox, multiNetArea, countMultiPoints, robustOp, splitProvinceByPolyline,
  pointInMulti,   // F：海岸线重建里判"这个省是否整块都在陆地内部"（可整省跳过）
} from '../../utils/polygonBool';
// 笔刷建省（2026-10-22）：一笔涂抹 → 一块新省的纯几何（Node 有单测，引擎注入）
import { paintProvinceShape } from '../../utils/brushProvince';
// B 方案（批量铺底）：Voronoi 播种 + 区域探针（纯几何，Node 有单测）
import {
  voronoiCells, autoSeedsInRegion, makeRegionProbe, ringBBox,
} from '../../utils/voronoiBatch';
// P0-2（2026-10-25）：造陆 —— 大陆/群岛轮廓的纯几何层 + 参数模型（两份都在 utils，Node 可测）
import { generateLandmass as buildLandmass } from '../../utils/landmass';
import {
  normalizeLandParams, toLandmassOptions, describeLandParams, candidateSeed,
  normalizeCultureParams, describeCultureParams,
} from '../../utils/terrainParams';
// P0-4（2026-10-25）：文化/宗教/势力派生的纯函数层（最远点采样 + 省份摘要 + 势力方案）
import { deriveCultureLayers, planPolities } from '../../utils/cultureDerive';
import { SEA_LEVEL } from '../../utils/heightMath';
import { nextProvinceColor } from '../../utils/scenarioPalette';
// 套索采样点简化：鼠标 mousemove 每动一次落一点（去重阈值 1e-6 世界单位 ≈ 必落）
// → 长按拖一大圈会有上千点。矢量布尔虽是 O(n log n)，但上千点仍不值得 → 复用同一条简化管线。
import { simplifyClosedTrace } from '../../utils/regionTrace';
import { toRaw } from 'vue';
// 归属键迁移（2026-10-24 第 4 件第二刀续）：一省拆多省 / 删省时，**账本与基线**也必须跟着改
// （只迁 `ownership`/`changeEvents` 会让"账本投影 == 缓存"断掉，之后归属编辑永远进不了账）。
// 纯数据层实现只有一份，在 `src/ledger/migrate.js`。
import { forkScenarioProvince, remapScenarioOwnership } from '../../../../ledger/index';

/**
 * 套索的**面积闸门**：轮廓包围盒占「全部省份包围盒」的比例上限。
 * 套索是**刻意画**出来的，所以阈值宽松（允许圈半个图）；但「一口吞掉全图」几乎总是误操作。
 * 🔴 P2 起语义变了：旧值按「格数」衡量并搭 `MAX_LASSO_CELLS`；矢量模型下没有格子，
 *    改为**面积占比**（`applyProvinceLasso` 仍保证「拒绝 = 零副作用」）。
 */
export const LASSO_AREA_SHARE = 0.5;
/**
 * ⚠️ **已退役（P2）**：格点时代的闸门常量。
 * `applyRegionToTerrain` / `mergeProvinces` 都是**精确布尔**（不存在"一口吞掉整片海"的机制），
 * 点击填充的语义也已改成「吞并点击处的那个省份」。保留导出只为不打断旧用例的 import；
 * **新代码不要再用**（保留它们当"闸门"= 把栅格思维带回来）。
 */
export const MAX_FILL_CELLS = 60000;
export const FILL_AREA_SHARE = 0.25;
export const MAX_LASSO_CELLS = 60000;
/**
 * 描轮廓的**面积闸门**：笔迹围住的面积 / 全部省份包围盒面积 的上限。
 * 超出几乎总是误操作（比如描到一半松手、把半个大陆圈进来）→ 拒绝且**零副作用**。
 */
export const OUTLINE_AREA_SHARE_DEFAULT = 0.5;

export function createProvinceEditingModule(ctx) {
  const { execute, baseMaps, scheduleAutoSaveScenarios } = ctx;
  const guardWrite = ctx.guardWrite || (() => ({ ok: true }));
  const isReadOnly = ctx.isReadOnly || { value: false };
  const isRO = () => !!(isReadOnly && isReadOnly.value);
  // P0-4：文化/宗教派生要写逐格网格 —— 只经 scenarioEditing 的这两个唯一入口
  const getHeightmapFor = ctx.getHeightmapFor || (() => null);
  const commitHeightmap = ctx.commitHeightmap || (() => {});
  /**
   * 剧本容器（**批量铺底要迁移归属/易主**，见 `batchSubdivide`）。
   * ⚠️ 只在「批量切分」这一条链上读它 —— 省份几何本身仍然只住 `baseMaps[key].terrain`。
   */
  const scenarios = ctx.scenarios || { value: {} };

  /** 只读态统一拒绝：返回「什么都没发生」的结果 */
  function blocked(action) {
    const gate = guardWrite(action);
    return { blocked: true, readOnly: true, changed: 0, message: gate.error || `${action}被拒绝（只读）` };
  }

  /** 涂抹期活数据（非响应式）：key → { grid, labels, shape } —— 网格已退役，仅为旧数据兼容保留 */
  const cache = {};
  /** 当前这一笔：{ key, path:[{x,y}], tool, target, radius }（矢量语义下只记轨迹，不碰数据） */
  let stroke = null;

  const bm = (key) => (baseMaps.value || {})[key] || null;

  /** 省份定义表（terrain[] = 省份；序号 = 下标 + 1） */
  function provincesOf(key) {
    const m = bm(key);
    return (m && Array.isArray(m.terrain)) ? m.terrain : [];
  }

  /**
   * 去响应式的省份定义表 —— **只用于热循环**（栅格化 / 包围盒推导）。
   *
   * 🔴 为什么必须这么写：栅格化是 O(格数 × 点数) 的双重循环，逐点读 `points[i].x` 时
   *    若对象是 Vue 响应式代理，每次读都要过一层 proxy trap。CDP 实测（6 个省份 / 3600 点
   *    / 3124 格）：走代理 **838.6ms**，同一份数据去代理后只要几十毫秒 ——
   *    真实库 desite 是 21 省 / 25930 点，量级差一个数量级就是「卡死几十秒」。
   *    两层 toRaw：容器与被元素都可能是代理（`{...m, terrain}` 这种展开会把代理原样带走）。
   *    P0 第二块起还要把 `extraRings`（多环）一起剥 —— 只剥主环会让带飞地的省退回代理读取。
   */
  function rawProvinces(key) {
    const list = toRaw(provincesOf(key));
    if (!Array.isArray(list)) return [];
    return list.map((p) => {
      const rp = toRaw(p);
      if (!rp || typeof rp !== 'object') return rp;
      const out = { ...rp };
      const pts = toRaw(rp.points);
      if (Array.isArray(pts)) out.points = toRaw(pts).map((q) => (q && typeof q === 'object') ? toRaw(q) : q);
      const extra = toRaw(rp.extraRings);
      if (Array.isArray(extra)) {
        out.extraRings = extra.map((r) => {
          const rr = toRaw(r);
          if (!rr || typeof rr !== 'object') return rr;
          const epts = toRaw(rr.points);
          return Array.isArray(epts)
            ? { ...rr, points: toRaw(epts).map((q) => (q && typeof q === 'object') ? toRaw(q) : q) }
            : rr;
        });
      }
      return out;
    });
  }

  // ── 形状签名：网格「是不是这套多边形派生的」的唯一判据 ────────────────────
  //    WeakMap 按 terrain 数组记忆化：本模块与 scenarioEditing 的每次写入都**整体替换**数组
  //    （`{...m, terrain: next}`）→ 换数组即换签名，天然失效，且零额外开销。
  const sigCache = new WeakMap();
  function terrainShape(key) {
    const terrain = bm(key)?.terrain;
    if (!Array.isArray(terrain)) return 0;
    let s = sigCache.get(terrain);
    if (s === undefined) {
      s = shapeSignature(rawProvinces(key));
      sigCache.set(terrain, s);
    }
    return s;
  }

  /** 让缓存条目的签名跟上当前 terrain（每次写 terrain / labels 后都要调，见文件头说明） */
  function stampShape(key) {
    const entry = cache[key];
    if (entry) entry.shape = terrainShape(key);
    return entry;
  }

  /** 把 labels 写回 store（整体替换对象 → 保证响应式；并调度落盘） */
  function commit(key, { save = true } = {}) {
    const entry = cache[key];
    const m = bm(key);
    // 只读态下绝不写 store（防御：即便调用方漏了 guardWrite，也不产生状态改动）
    if (isRO()) return;
    if (!entry || !m) return;
    const shape = terrainShape(key);
    entry.shape = shape;
    baseMaps.value = {
      ...baseMaps.value,
      [key]: {
        ...m,
        provinceLabels: {
          cols: entry.grid.cols, rows: entry.grid.rows, cell: entry.grid.cell,
          ox: entry.grid.ox, oy: entry.grid.oy,
          shape,
          data: serializeLabels(entry.labels),
        },
        updatedAt: new Date().toISOString(),
      },
    };
    if (save) scheduleAutoSaveScenarios();
  }

  /** 作废网格缓存（几何被外部改过时由签名检查自动完成，这里给显式入口） */
  function invalidateProvinceGrid(key) {
    delete cache[key];
  }

  /**
   * 懒建 + 自愈：已有合法网格**且与当前多边形同源**（shape 相符）就用它；
   * 否则按省份多边形栅格化一副新的并落盘。
   */
  function ensureProvinceGrid(key) {
    const shape = terrainShape(key);
    const hit = cache[key];
    if (hit && hit.shape === shape) return hit;
    const m = bm(key);
    if (!m) return null;
    const provinces = provincesOf(key);
    const stored = normalizeStoredGrid(m.provinceLabels, provinces);
    // 签名一致 → 直接用；**签名缺失（旧版数据 / 旧字段）→ 一次性信任并盖章**：
    // 宁可少一次自愈，也绝不把用户在旧版里画好的归属当场丢掉（本仓第一原则：破坏性更新
    // 只许破坏代码、不许破坏用户数据）。盖过章之后，后续一律由指纹严格管辖。
    const storedShape = m.provinceLabels ? m.provinceLabels.shape : undefined;
    if (stored && (storedShape === undefined || storedShape === shape)) {
      cache[key] = { grid: stored.grid, labels: stored.labels, shape };
      return cache[key];
    }
    const raw = rawProvinces(key);              // 热循环必须去响应式（见 rawProvinces 注释）
    const grid = gridFromProvinces(raw);
    const labels = rasterizeProvinces(raw, grid);   // 已收口到 provinceShape（多环 / 带洞口径）
    cache[key] = { grid, labels, shape };
    commit(key);          // 只读态下 commit 直接返回 → 网格只在内存里（只读 ≠ 看不了）
    return cache[key];
  }

  /** 供渲染读取（活数据引用，不要改它）。几何被外部改过（签名不符）→ 返回 null，等重建。 */
  function getProvinceGrid(key) {
    const entry = cache[key];
    if (!entry) return null;
    if (entry.shape !== terrainShape(key)) return null;
    return entry;
  }

  /**
   * 按省份多边形重新栅格化（导入底图 / 手工改了多边形之后调）
   */
  function rebuildProvinceGrid(key) {
    if (isRO()) return blocked('重建省份网格');
    if (!bm(key)) return null;
    const before = cache[key]
      ? { grid: cache[key].grid, labels: new Uint8Array(cache[key].labels), shape: cache[key].shape }
      : null;
    const raw = rawProvinces(key);              // 热循环必须去响应式（见 rawProvinces 注释）
    const grid = gridFromProvinces(raw);
    const labels = rasterizeProvinces(raw, grid);
    const shape = terrainShape(key);
    cache[key] = { grid, labels, shape };
    execute({
      type: 'province-grid-rebuild',
      label: '重建省份网格',
      undo: () => {
        if (before) cache[key] = { ...before, labels: new Uint8Array(before.labels) };
        else delete cache[key];
        commit(key);
      },
      redo: () => {
        cache[key] = { grid, labels: new Uint8Array(labels), shape };
        commit(key);
      },
    });
    return { grid, owned: countOwned(labels) };
  }

  /**
   * 删除省份后**就地重编号**缓存网格（2026-10-02 接活）。
   *
   * 为什么需要它：`removeBaseProvince`（在 scenarioEditing）只换 terrain 数组 → 形状签名失配 →
   * 下次用网格时**整表重新栅格化**（真实库 21 省 / 25930 点实测 170~368ms 的主线程停顿），
   * 而且用户涂过的格子会被重采样一次。这里把「自身格置 0 + 序号 > idx 的减 1」就地做完并盖上
   * **新签名**，网格保持有效 → **省掉那次重建**。
   *
   * 🔴 **不 `execute`**：调用方的删除命令要把这一步包进**同一条 undo**（test_77 f2 断言
   * 「一条 undo 把省份 + ownership + changeYears 一起还原」；这里再压一条会把它拆成两条）。
   * 因此重编号动过的格子要交回**整表快照**（差量还原不了 —— 动的是别的省份的格）。
   * 签名不符（这份网格本来就是别的几何派生的）→ 不硬改，交给既有的自愈重建。
   * @returns {{snapshot:Uint8Array, cleared:number, renumbered:number}|{skipped:string}}
   */
  function shiftProvinceGridForDelete(key, deletedIdx) {
    const entry = cache[key];
    if (!entry) return { skipped: 'no-grid' };
    // ⚠️ 必须在**调用方换掉 terrain 之前**调：签名校验比的是「当前 terrain」，
    //    换完再调必然是 stale（首版实测 gridShifted:false、网格被白白作废）。
    if (entry.shape !== terrainShape(key)) return { skipped: 'stale' };
    const snapshot = new Uint8Array(entry.labels);
    const { cleared, renumbered } = renumberAfterDelete(entry.labels, deletedIdx + 1);
    return { snapshot, cleared, renumbered };     // 不 stamp：等调用方写好新 terrain 再由 stampProvinceGrid 盖
  }

  /** 给当前网格盖上与**当前 terrain** 相符的签名并落盘（不 execute —— 属于调用方的命令） */
  function stampProvinceGrid(key) {
    const entry = cache[key];
    if (!entry) return { skipped: 'no-grid' };
    stampShape(key);
    commit(key);
    return { stamped: true };
  }

  /** 撤销删除：把整表快照灌回网格（调用方要**先**把 terrain 还原，这里才会盖对签名） */
  function restoreProvinceGrid(key, snapshot) {
    const entry = cache[key];
    if (!entry || !snapshot) return { skipped: 'no-grid' };
    entry.labels.set(snapshot);
    stampShape(key);
    commit(key);
    return { restored: snapshot.length };
  }

  // ============================================================
  // 涂抹 → 多边形（**矢量布尔**）：归属的唯一表示是多边形
  // ============================================================
  //
  // 🔴 P2（2026-10-09）**删掉了旧的 `reprojectRings`** —— 它把「归属格轮廓」反向写回多边形，
  //    精度上限 = 一个格子一条边（`DEFAULT_GRID_CELL = 14.4` 世界单位）→ 10525 点的真实海岸线
  //    一次涂抹就变 ~22 点（用户实测「退化 / 恶心」的根因，见 docs/SCENARIO_PROVINCE_FIX_PLAN.md）。
  //    现在：笔迹 → 多边形 → 对目标省 union、对相交省 difference。
  //    **几何只可能变精细，永不被格点重采样。**

  /**
   * MultiPolygon 的世界包围盒（预筛用；null = 空）。
   * 🔴 唯一实现已上移到 `utils/polygonBool.js`（`multiBBox`）：批量铺底那侧也要用它，
   *    两处各写一份 = 迟早一处改了另一处没改（本项目在高度图 / 参考图 / 势力名上各付过一次代价）。
   */
  const multiBBox = boolMultiBBox;

  const bboxHit = (a, b) => !!a && !!b
    && !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);

  /** 省份 kind 归一（'sea' 只有海域省才写） */
  const kindOf = (p) => (p && p.kind === 'sea' ? 'sea' : 'land');

  /**
   * 把一块几何（笔迹轮廓 / 套索多边形）**并进目标省**、并从其他相交省里**挖掉**。
   *
   * @param {Array} brushRings Ring 列表（每项 = [[x,y],…] 闭合）
   * @param {number} targetIdx 1-based 目标省序号；**0 = 只挖不并**（等价「抹除」）
   * @returns {{ terrain:Array, ops:Array<{id,op,emptied?}> }|null} null = 什么都没碰到
   *
   * 性能：先按**包围盒**预筛（真实数据里通常只剩 1~3 个省），再用 `intersectsMulti` 真判相交 ——
   *   对 10525 点的省做一次差集是几十毫秒量级，不能对每个省无脑跑。
   */
  function applyRegionToTerrain(key, brushRings, targetIdx, opts = {}) {
    const terrain = provincesOf(key);
    if (!terrain.length) return null;
    // 几何兜底时的**人话回音**（不静默降级，也不炸整笔）—— 见下面的装配处
    let geomWarn = '';
    let brushMulti = ringsToMulti(brushRings);
    if (!brushMulti.length) return null;
    let bb = multiBBox(brushMulti);

    // 🔴 **锁定海岸线**（默认开；2026-10-09 暮雨要求）：
    //    「海岸线就应该只靠专门的底图编辑调整，平时维持锁定状态」。
    //    做法：把笔迹**裁剪到「已有省份的并集」之内** —— 涂抹只能在大陆内部易手，
    //    永远不会往海面 / 空白区扩张（旧行为：笔迹压到海岸线上，轮廓就跟着被改掉）。
    //    ⚠️ 连带效果：新建省份（空省，不在并集里）也只能**从已有大陆里挖一块**，
    //    不会再画出一块悬在海上、与大陆无关的地。
    if (opts.lockCoast !== false) {
      const near = [];
      for (const p of terrain) {
        const pbox = provinceBBox(p);
        if (!pbox || !bboxHit(pbox, bb)) continue;
        const m = provinceToMulti(p);
        if (m.length) near.push(m);
      }
      if (!near.length) return null;                       // 附近没有任何省份 → 不动（不扩张海岸线）
      // 🔴 2026-10-17 第八修（用户真机崩溃：圈选批量删河直接抛异常）：
      //    `unionMulti` / 下面的 `intersection` 原来都是**裸调** `polygonClipping`。
      //    手画笔迹的自交环会让引擎抛 `Unable to complete output ring …`，
      //    于是整笔操作炸掉（异常一路冒到 `window.onerror`）。
      //    现在：`unionMulti` 自己带兜底（先自交净化→再逐个并→失败回报），
      //    `intersection` 走 `robustOp`（失败时吸附坐标重算，仍失败则当"没碰到"处理，
      //    而不是把整笔操作炸掉）。
      const covered = near.length === 1
        ? near[0]
        : unionMulti(polygonClipping, near[0], near.slice(1), {
          onFail: (info) => { geomWarn = (geomWarn || '') + (geomWarn ? '；' : '') + info.label; },
        });
      const interRes = robustOp(polygonClipping, 'intersection', brushMulti, covered);
      if (!interRes.multi) {
        // 兜底：几何退化到算不了。**明确回报**（不静默、也不炸整笔）
        return {
          changed: 0, rejected: 'geometry-failed',
          message: `这块笔迹的轮廓自交了，几何引擎算不出来（${String(interRes.error || '').slice(0, 80)}）。`
            + ' 请把圈画得简单一些再试，或用「变更归属」涂一笔。',
        };
      }
      if (interRes.snapped) geomWarn = (geomWarn || '') + (geomWarn ? '；' : '') + '轮廓已吸附坐标后重算';
      const clipped = interRes.multi;
      if (isEmptyMulti(clipped)) return null;              // 笔迹全在省外 → 什么都不做
      brushMulti = clipped;
      const bb2 = multiBBox(brushMulti);
      if (bb2) bb = bb2;                                   // 裁剪后包围盒更准（预筛更省）
    }

    const ops = [];
    let changed = false;

    const next = terrain.map((p, i) => {
      const idx = i + 1;
      const kind = kindOf(p);

      // 🔴 目标省**不做包围盒预筛**：涂/圈在别人地盘上、与目标省并不相邻时，它本来就该
      //    长出一块「飞地」。预筛一挡，这一笔就变成「从原省挖掉、却没人接」＝**凭空少一块地**
      //    （实跑抓到：套索划给不相邻的省 → 总面积少了一整块）。
      if (idx === targetIdx) {
        // 并集也走兜底（`unionMulti` 内部：自交净化 → 逐个并 → 失败回报，不抛）
        const merged = unionMulti(polygonClipping, provinceToMulti(p), [brushMulti], {
          onFail: (info) => { geomWarn = (geomWarn || '') + (geomWarn ? '；' : '') + info.label; },
        });
        changed = true;
        ops.push({ id: p.id, op: 'union' });
        const patch = multiToShape(merged, kind);
        return normalizeProvince({ ...p, ...patch, empty: !patch.points.length });
      }

      const pbox = provinceBBox(p);
      if (!pbox || !bboxHit(pbox, bb)) return p;                 // 其他省：包围盒不相交 → 整省跳过
      const base = provinceToMulti(p);
      if (!base.length) return p;
      // 🔴 这几个也**逐个兜底**：任何一个几何退化都不该让整笔操作炸掉
      //    （用户实测就是"圈选批量操作直接报错"，异常一路冒到 window.onerror）。
      const interHit = robustOp(polygonClipping, 'intersection', base, brushMulti);
      if (!interHit.multi || isEmptyMulti(interHit.multi)) return p;   // 算不出/真不相交 → 跳过差集
      const cutRes = robustOp(polygonClipping, 'difference', base, brushMulti);
      if (!cutRes.multi) { geomWarn = (geomWarn || '') + (geomWarn ? '；' : '') + `差集失败(${p.name || idx})`; return p; }
      const patch = multiToShape(cutRes.multi, kind);
      changed = true;
      ops.push({ id: p.id, op: 'difference', emptied: !patch.points.length });
      return normalizeProvince({ ...p, ...patch, empty: !patch.points.length });
    });

    if (!changed) return null;
    // `geomWarn` 随结果回传：调用方把它并进用户可见的回执（不静默降级）
    return { terrain: next, ops, ...(geomWarn ? { geomWarn } : {}) };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 描轮廓（E，2026-10-11）：用户**沿边界描一圈** → 被围住那块地并进目标省、  // 从它原来所属的省挖掉（相邻省自动重算）。这就是"线跟着笔走、邻居自己更新"。
  //
  // 与既有三条路的分工（**别混**）：
  //   · 顶点编辑：拖一个点（只改被拖那一个省，会压叠/留缝）
  //   · 省份笔刷：**粗带**扫过就划归（`traceBrushRings` 生成胶囊带）
  //   · 套索：圈目标地**从未知省手里抢过来**（区域 = 圈，目标 = 用户先选的那个省）
  //   · 描轮廓（本函数）：区域 = **笔迹自己围出的那块**，目标 = 围住区域里的那个省
  // 🔴 为什么不是"把描出的线直接当新边界"：那是"用一串离散点替换整条环"，
  //    对真实底图（10525 点海岸线）必然把海岸线一起重采样 —— 本项目踩过（见文件头 P2 说明）。
  //    布尔语义下**未碰到的边界一个点都不动**，海岸线天然保住。
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 把一个点集按"落在哪个候选省里"计数（描轮廓用来判定**改判给谁**）。
   * ⚠️ 只读，不写任何数据。用**原始笔迹点**（未简化的）—— 笔迹密集，靠近边界的那几个
   * 点会把"贴着谁描"如实反映出来。
   */
  function countPointsInside(key, pts, candidates) {
    const counts = new Map();
    for (const p of candidates) counts.set(p.id, 0);
    for (const q of pts) {
      for (const p of candidates) {
        if (pointInProvince(q.x, q.y, p)) counts.set(p.id, (counts.get(p.id) || 0) + 1);
      }
    }
    return counts;
  }

  /**
   * 把**一条闭合笔迹**变成"要把哪块地交给谁"。
   *
   * 🔴 目标省的默认取向（2026-10-11 实测纠偏，**这一条最容易想反**）：
   *    「围住的那块地」本来就在**原主**手里，所以"区域里占比最高的省"**永远**是原主 ——
   *    而用户描一条边界，想要的恰恰是**改判给邻省**。首版就是按"占比最高"选的，
   *    结果 `targetIdx` 恒等于原主 → 只有 union、没有 difference，画面纹丝不动
   *    （test_97 c 段当场抓到：`{"t":1,"cov":1,"area":3000,"out":0}`）。
   *    现在的规则：
   *      · `opts.targetIdx` 显式给了 → 用它（用户在下拉里选的那个省）
   *      · `opts.toNeighbor === false` → 归**原主**（"把这块划回给它自己"= 修形状，不是换主）
   *      · 默认 → 判给**笔迹贴得最紧的那个邻省**（数原始笔迹点落在谁里面最多）；
   *        一个邻省都没碰到（完全围在原主内部）→ 归原主（此时改判等于原地不动，
   *        要"切一块出去"应当用拆分；这条也如实回报出去）
   *
   * @returns {{ ring:Array, area:number, ownerIdx:number, targetIdx:number, switched:boolean }|{rejected:string,...}|null}
   */
  function resolveOutlineRegion(key, path, opts = {}) {
    const terrain = provincesOf(key);
    if (!terrain.length) return null;
    const raw = Array.isArray(path) ? path.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
    if (raw.length < 3) return null;
    // 闭合：把最后一个点连回第一个点。描轮廓的手感就是"描一圈"，
    // 起点与终点之间的那段弦由笔迹两端直接相连（UI 会画出来）。
    let ring = rdpSimplify(raw.map((p) => ({ x: p.x, y: p.y })), opts.tol || 0).map((p) => [p.x, p.y]);
    if (ring.length < 3) return null;
    ring.push([ring[0][0], ring[0][1]]);          // 显式闭合（布尔引擎要求首尾相同）
    const regionMulti = ringsToMulti([ring]);
    if (!regionMulti.length) return null;
    const area = Math.abs(multiNetArea(regionMulti));
    if (!(area > 0)) return null;

    // 面积闸门（与套索**同一套回报口径**：`rejected:'area-gate'` + `share` + 可读文案，
    // 拒绝时零副作用 —— 在改任何东西之前判）
    const share = opts.maxShare != null ? opts.maxShare : OUTLINE_AREA_SHARE_DEFAULT;
    let allBox = null;
    for (const p of terrain) {
      const b = provinceBBox(p);
      if (!b) continue;
      allBox = allBox ? {
        minX: Math.min(allBox.minX, b.minX), minY: Math.min(allBox.minY, b.minY),
        maxX: Math.max(allBox.maxX, b.maxX), maxY: Math.max(allBox.maxY, b.maxY),
      } : { ...b };
    }
    const total = allBox ? Math.abs((allBox.maxX - allBox.minX) * (allBox.maxY - allBox.minY)) : 0;
    if (share > 0 && total > 0 && area / total > share) {
      return { rejected: 'area-gate', share: area / total, area, ring };
    }

    const rbox = multiBBox(regionMulti);
    // 原主 = 「这块地的多大比例是它的」最高者（区域跨省时按占比，不按绝对面积）
    let owner = -1, ownerShare = 0, ownerInter = 0;
    const near = [];
    for (let i = 0; i < terrain.length; i++) {
      const p = terrain[i];
      const b = provinceBBox(p);
      if (!b || !rbox || !bboxHit(b, rbox)) continue;
      const m = provinceToMulti(p);
      if (!m.length) continue;
      // 🔴 2026-10-17 第八修：几何调用一律走兜底（`robustOp` 失败时吸附重算，仍失败则
      //    当"没相交"跳过这一步）。裸调会在自交环上抛 `Unable to complete output ring`
      //    并把整笔操作炸到 `window.onerror`（用户实测："圈选批量删除直接报错"）。
      const interRes = robustOp(polygonClipping, 'intersection', m, regionMulti);
      if (!interRes.multi) continue;
      const inter = interRes.multi;
      if (isEmptyMulti(inter)) continue;
      const a = Math.abs(multiNetArea(inter));
      near.push({ idx: i + 1, prov: p, inside: a });
      const s = area > 0 ? a / area : 0;
      if (s > ownerShare) { ownerShare = s; owner = i; ownerInter = a; }
    }
    if (owner < 0) return { rejected: 'no-target', area, ring };

    // 邻省 = 笔迹点落进去最多的那些（原主之外）
    const others = near.filter((n) => n.idx !== owner + 1);
    const counts = countPointsInside(key, raw, others.map((n) => n.prov));
    let neighborIdx = -1, neighborHits = 0;
    for (const n of others) {
      const c = counts.get(n.prov.id) || 0;
      if (c > neighborHits) { neighborHits = c; neighborIdx = n.idx; }
    }
    const explicit = opts.targetIdx && opts.targetIdx > 0 ? opts.targetIdx : 0;
    const wantOwner = opts.toNeighbor === false;
    let targetIdx = owner + 1;
    let switched = false;
    if (explicit) {
      targetIdx = explicit;
      switched = explicit !== owner + 1;
    } else if (!wantOwner && neighborIdx > 0) {
      targetIdx = neighborIdx;
      switched = true;
    }
    return {
      ring, area, regionMulti,
      ownerIdx: owner + 1,
      targetIdx,
      switched,
      ownerShare,
      coveredRatio: ownerShare,           // 兼容旧字段名（= 原主占比）
      neighborIdx: neighborIdx > 0 ? neighborIdx : null,
      neighborHits,
      touched: near.map((n) => n.idx),
      // D10：这一笔会碰到几个省（预览/闸门/回执都用它；S0 实测一笔 12 省就是这里）
      affected: near.length,
      affectedIds: near.map((n) => n.prov.id),
      targetId: (terrain[targetIdx - 1] || {}).id || null,
      ownerId: (terrain[owner] || {}).id || null,
      neighborId: neighborIdx > 0 ? ((terrain[neighborIdx - 1] || {}).id || null) : null,
    };
  }

  /**
   * 描轮廓落库：区域并进目标省、从其他相交省挖掉（**一整笔 = 一条 undo**）。
   * @param {Array<{x,y}>} path 笔迹（世界坐标）
   */
  function applyProvinceOutline(key, path, opts = {}) {
    if (isRO()) return blocked('描轮廓');
    const terrain = provincesOf(key);
    if (!terrain.length) return { changed: 0, message: '这张底图还没有省份' };
    const resolved = resolveOutlineRegion(key, path, opts);
    if (!resolved) return { changed: 0, message: '这条笔迹围不出有效形状（至少要画出一圈）' };
    if (resolved.rejected === 'area-gate') {
      return {
        changed: 0, rejected: 'area-gate', share: resolved.share,
        message: `这条笔迹围住了全图约 ${Math.round((resolved.share || 0) * 100)}% 的地（超过闸门）`
          + '——多半是描到一半松手、或想把整块大陆圈进来。请只沿要改的那一条边界描一圈',
      };
    }
    if (resolved.rejected === 'no-target') {
      return { changed: 0, rejected: 'no-target', message: '没围住任何省份（描的圈要落在陆地上）' };
    }
    // D10 安全闸门（S0 实测：笔迹在边界密集处一笔碰到 12 个省、清空 3 个）：
    // 默认最多影响 6 个省；超过就拒绝，由调用方**明确问人**后再带 allowMany 重试。
    const maxAffected = Number.isFinite(opts.maxAffected) ? opts.maxAffected : 6;
    if (!opts.allowMany && resolved.affected > maxAffected) {
      const names = (resolved.affectedIds || []).slice(0, 6)
        .map((id) => { const p = terrain.find((x) => x.id === id); return p ? p.name : id; })
        .join('、');
      return {
        changed: 0, rejected: 'province-gate',
        affected: resolved.affected, affectedIds: resolved.affectedIds,
        message: `描轮廓会同时影响 ${resolved.affected} 个省（上限 ${maxAffected}）：${names}${resolved.affected > 6 ? ' 等' : ''}。`
          + ' 请只贴着要改的那一条边界描；确实要一次改这么多，再点「仍要执行」。',
      };
    }
    const targetIdx = opts.targetIdx && opts.targetIdx > 0 ? opts.targetIdx : resolved.targetIdx;
    const res = applyOutlineToTerrain(key, resolved.ring, targetIdx, opts);
    if (!res) return { changed: 0, rejected: 'no-effect', message: '这一描没有改变任何边界（可能正好与现有边界重合，或整块地本来就属于目标省）' };

    // 如实回报：**有没有别的省也压在这块被转移的地上**（无新增压叠的自证）。
    // 🔴 一定要拿**运算后**的 `res.terrain` 去比 —— 首版比的是运算前的旧数组，
    //    于是目标省（它现在当然含着这块地）被算成"压叠"、量出来正好等于转移量
    //    （test_97 当场量出 1428.57 = transfer），看起来像几何错了，其实是度量写错了。
    let preOverlap = 0;
    for (let i = 0; i < res.terrain.length; i++) {
      if (i === targetIdx - 1) continue;
      const m = provinceToMulti(res.terrain[i]);
      if (!m.length) continue;
      // 几何兜底（同 §第八修）：算不出就当"没重叠"——这只影响一个**度量**，不该炸操作
      const interRes = robustOp(polygonClipping, 'intersection', m, res.transferMulti);
      if (!interRes.multi) continue;
      const inter = interRes.multi;
      if (isEmptyMulti(inter)) continue;
      preOverlap = Math.max(preOverlap, Math.abs(multiNetArea(inter)));
    }

    execute({
      type: 'province-outline',
      label: opts.label || '描轮廓',
      undo: () => setTerrain(key, terrain),
      redo: () => setTerrain(key, res.terrain),
    });
    return {
      changed: res.ops.length,
      ops: res.ops,
      targetIdx,
      affected: resolved.affected,
      affectedIds: resolved.affectedIds,
      targetId: resolved.targetId,
      ownerId: resolved.ownerId,
      // 原主 / 是否换主（UI 要据此说人话："从「甲」改判给「乙」"）
      ownerIdx: resolved.ownerIdx,
      switched: !!resolved.switched,
      neighborIdx: resolved.neighborIdx || null,
      detail: describeRegionOps(key, res.ops),
      area: resolved.area,
      coveredRatio: resolved.coveredRatio,
      // 真正搬动的面积（= 目标省净得的面积 = 邻省们失去的面积，逐字节一致）
      transferArea: res.transferArea,
      preOverlap,
      regionMulti: resolved.regionMulti,
    };
  }

  /**
   * 🔴 描轮廓专用的落库几何（E，2026-10-11）：**按 transfer 做精确划分**，而不是"先并后挖"。
   *
   * 为什么不能直接用 `applyRegionToTerrain`（首版就是那样，test_97 c 段量出数字才看出来）：
   *   那条路是「先给目标省并上 region、再从被碰到的省挖掉 region」。区域跨过边界时，
   *   目标省拿到的其实只有 `region ∩ 目标省`（并集里已经有的部分不变），而邻省被挖掉的是
   *   `region ∩ 邻省` —— 用户**描出来的那块并没有整块过去**：
   *   实测 3000 的区域只搬过去 1429（乙涨 1429、甲掉 1429，各自守恒但"意图没实现"）。
   *
   * 这里的定义（transfer = 区域 − 目标省原有地）满足四条，正是改边界该有的性质：
   *   ① 目标是**净得**（transfer 与目标省不相交 → 并集严格变大）；
   *   ② 邻省只失去**被转移的那部分**（transfer ⊆ region，所以不会多挖）；
   *   ③ 面积**精确守恒**（转移量与邻省减少量逐字节一致）；
   *   ④ 不可能产生新压叠（转移量要么归目标、要么留在原地，是**划分**不是叠加）。
   * ⚠️ `applyRegionToTerrain`（笔刷 / 套索 / 批量）**保持原样不动** —— 那三条路的语义
   *    是"把这一带划给它"（并集 + 差集），改成划分会动到 test_79/80/92 的既有断言。
   */
  function applyOutlineToTerrain(key, ring, targetIdx, opts = {}) {
    const terrain = provincesOf(key);
    if (!terrain.length) return null;
    const target = terrain[targetIdx - 1];
    if (!target) return null;
    let regionMulti = ringsToMulti([ring]);
    if (!regionMulti.length) return null;
    const kind = kindOf(target);

    if (opts.lockCoast !== false) {
      const bb = multiBBox(regionMulti);
      const near = [];
      for (const p of terrain) {
        const pbox = provinceBBox(p);
        if (!pbox || !bb || !bboxHit(pbox, bb)) continue;
        const m = provinceToMulti(p);
        if (m.length) near.push(m);
      }
      if (!near.length) return null;
      const covered = near.length === 1
        ? near[0]
        : unionMulti(polygonClipping, near[0], near.slice(1));
      const clipRes = robustOp(polygonClipping, 'intersection', regionMulti, covered);
      if (!clipRes.multi) return null;   // 兜底也失败了：这笔操作不动（而不是炸）
      const clipped = clipRes.multi;
      if (isEmptyMulti(clipped)) return null;
      regionMulti = clipped;
    }

    // transfer = 区域 − 目标省原有地（= 目标省这一笔真正**新得到**的地）
    // 🔴 层数不能错：`differenceMulti(clip, baseMulti, cutMultis)` 的 `cutMultis` 是
    //    **MultiPolygon 的列表**（`[multiA, multiB]`），不是 `[polygon]`。
    //    写成 `[provinceToMulti(p)]` 时基元是 `[[ring]]`、与乘法器期望的 `[[[ring]]]` 差一层 →
    //    引擎"减了个寂寞"，转移块仍与目标省原有地重叠（test_97 的 `preOverlap` 当场量出 1428.57）。
    const differenceFromBase = (base, cutMulti) => {
      if (!(base && base.length && cutMulti && cutMulti.length)) return base;
      // 几何兜底：差集失败时**退还 base**（宁可"这一块没减掉"，也不炸整笔）
      const r = robustOp(polygonClipping, 'difference', base, cutMulti);
      return r.multi || base;
    };
    const targetBase = provinceToMulti(target);
    const transfer = targetBase.length ? differenceFromBase(regionMulti, targetBase) : regionMulti;
    const transferArea = isEmptyMulti(transfer) ? 0 : Math.abs(multiNetArea(transfer));
    if (!(transferArea > 0)) return null;                    // 区域全在目标省里 → 没有可转移的地

    const ops = [];
    let changed = false;
    const next = terrain.map((p, i) => {
      if (i === targetIdx - 1) {
        const merged = unionMulti(polygonClipping, provinceToMulti(p), [transfer]);
        changed = true;
        ops.push({ id: p.id, op: 'union' });
        const patch = multiToShape(merged, kind);
        return normalizeProvince({ ...p, ...patch, empty: !patch.points.length });
      }
      const base = provinceToMulti(p);
      if (!base.length) return p;
      if (!intersectsMulti(polygonClipping, base, transfer)) return p;   // 不相交 → 整省跳过
      const cut = differenceMulti(polygonClipping, base, [transfer]);
      const patch = multiToShape(cut, kind);
      changed = true;
      ops.push({ id: p.id, op: 'difference', emptied: !patch.points.length });
      return normalizeProvince({ ...p, ...patch, empty: !patch.points.length });
    });
    if (!changed) return null;
    return { terrain: next, ops, transferArea, transferMulti: transfer };
  }

  /** 写 terrain（新数组 → 响应式）+ 同步签名 */
  function setTerrain(key, terrain, { save = true } = {}) {
    const m = bm(key);
    if (!m) return;
    baseMaps.value = { ...baseMaps.value, [key]: { ...m, terrain, updatedAt: new Date().toISOString() } };
    // 序号语义变了（长度可能变短）→ 越界标签置无主，别让取色函数越界
    const entry = cache[key];
    if (entry) {
      const maxIdx = terrain.length;
      let fixed = false;
      for (let i = 0; i < entry.labels.length; i++) {
        if (entry.labels[i] > maxIdx) { entry.labels[i] = 0; fixed = true; }
      }
      stampShape(key);
      if (fixed) commit(key, { save: false });
    }
    if (save) scheduleAutoSaveScenarios();
  }

  // ============================================================
  // P1（2026-10-13）：顶点编辑 —— **一批**省份的形状一起改（一次拖动 = 一条 undo）
  // ============================================================

  /**
   * 把若干省份的形状补丁**作为一条命令**写下去。
   *
   * 为什么必须是一条：拖动共边顶点时，动的是「目标省 + 跟着走的邻省」两到三家，
   * 而在用户心里那是**一件事**。若沿用 `updateBaseProvince`（一次一个省），
   * 拖一下要按 N 次 Ctrl+Z 才退得回去 —— 与 0.2.7 折线切割"每省一条 undo"同类；
   * 那次的结论是**如实告诉用户**，但形状微调比切分频繁得多，如实告知也没法用，所以做成一条。
   *
   * undo 用**整表快照**（`setTerrain(key, terrain0)`）：与描轮廓/合并同一条路 ——
   * 差量还原在"几个省的环同时变了"时最容易漏（本项目「撤销看着执行了、数据没变」踩过两次）。
   *
   * @param {Array<{id:string, patch:object}>} patches 每个 = 「改哪个省 + 它的补丁」
   * @param {{label?:string}} [opts]
   * @returns {{changed:number, message?:string, rejected?:string}}
   */
  function updateProvincesBatch(key, patches, opts = {}) {
    const label = (opts && opts.label) || '编辑省界';
    if (isRO()) return blocked(label);
    if (!bm(key)) return { changed: 0, rejected: 'no-basemap', message: `底图不存在：${key}` };
    const terrain0 = provincesOf(key);
    if (!terrain0.length) return { changed: 0, rejected: 'empty', message: '这张底图还没有省份' };
    // 同一省份出现多次 → 合并补丁（后写的字段赢），不产生两条命令
    const byId = new Map();
    for (const p of (patches || [])) {
      if (!p || !p.id || !p.patch) continue;
      byId.set(p.id, { ...(byId.get(p.id) || {}), ...p.patch });
    }
    if (!byId.size) return { changed: 0, message: '没有要改的省份' };
    let changed = 0;
    const next = terrain0.map((p) => {
      const patch = byId.get(p.id);
      if (!patch) return p;
      changed++;
      return normalizeProvince({ ...p, ...patch });
    });
    if (!changed) return { changed: 0, rejected: 'not-found', message: '这些省份不在该底图上（id 对不上）' };
    execute({
      type: 'province-shape-batch',
      label,
      undo: () => setTerrain(key, terrain0),
      redo: () => setTerrain(key, next),
    });
    return { changed };
  }

  // ============================================================
  // 笔刷 / 套索（一笔 = 一条 undo；**矢量布尔**，不经网格）
  // ============================================================

  function beginProvinceStroke() {
    stroke = { key: null, path: [], tool: 'paint', target: 0, radius: 60 };
  }

  /**
   * 一次落点：**只累积轨迹**（不碰任何数据）。
   *
   * 🔴 与旧实现的关键差别：旧版每个 mousemove 都往格子里 stamp，抬手再按格轮廓重投影几何；
   *    现在落点只记「笔走过哪里」，抬手时一次性把轨迹变成多边形再做布尔 ——
   *    **涂抹期零几何运算**，帧预算与「抬手 diff」的手感与 `channelBrush` 一致。
   * @param radius 笔刷半径（**世界单位**；不再以"格"计 —— 网格已不是归属的表示）
   */
  function applyProvinceStroke(key, { x, y, radius = 60, strength = 0.8, tool = 'paint', target = 0 } = {}) {
    if (isRO()) { blocked('省份笔刷划归'); return 0; }   // 只读：连轨迹都不记
    if (!bm(key)) return 0;
    const r = Number.isFinite(radius) && radius > 0 ? radius : 60;
    if (!stroke || stroke.key !== key) stroke = { key, path: [], tool, target, radius: r };
    stroke.tool = tool; stroke.target = target; stroke.radius = r;
    const last = stroke.path[stroke.path.length - 1];
    // 采样过滤：与上一点距离不足 0.35r 不落点（否则拖一屏会累积上千点）
    if (!last || Math.hypot(last.x - x, last.y - y) >= r * 0.35) stroke.path.push({ x, y });
    return stroke.path.length;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 用新 .map 的海岸线重建现有省份的外环（F，2026-10-11）
  //
  // 要解决的问题（暮雨实测）：现有底图的省份边界是**退化轮廓**（原始 10525 点被简化成 778 点、
  // 而省份本身只有几十个点），地图上的海岸线又糙又不对；而生成器导出的新 .map 里有**完整海岸线**。
  // 但直接"重导为新底图"会把几百块省份与归属全丢掉 —— 他要的是**换掉海岸线那一段**，不作废省份。
  //
  // 做法（复用既有几何单源，不新写一套）：
  //   新陆地 = ∪ 新 .map 的 `landFeatures`（parser 已给，实测 desite.map 20 块 / 最大 10525 点）
  //   每个省 = 省 ∩ 新陆地
  // 四条性质：
  //   ① 只动**跨过海岸线**的省 —— 完全落在陆地内部的省 `∩` 之后逐点不变（布尔是精确的），
  //      所以内陆边界与相邻关系不受影响；
  //   ② 相邻省**仍然无缝**（对每个省取同一个 L 的交集，划分关系被保持）；
  //   ③ 海岸线那一段换成新 .map 的**原顶点**（不是重采样出来的）；
  //   ④ 一整次 = 一条 undo；如实回报「变了几个省 / 面积增减 / 有没有省被清空」。
  //
  // ⚠️ 依赖：必须在 parser 之前读到的 `landFeatures` 上做（`buildScenariosJson` 已经把它们
  //    带进 `baseMaps[key].landFeatures`）。老底图没有这个字段 → 明确拒绝，并告诉用户去选一份 .map。
  // ══════════════════════════════════════════════════════════════════════════

  /** 海岸线重建的安全闸门：面积变化超过这个比例就拒绝（多半是拿错了 .map） */
  const COASTLINE_MAX_AREA_DRIFT = 0.6;

  /**
   * 把一批陆地轮廓并成一个 MultiPolygon（= 新的"陆地"范围）。
   * 纯几何，独立出来便于单测；`features` 支持 `{points:[{x,y}]}` 或 ring 数组两种形状。
   */
  function buildLandMulti(features) {
    const multis = [];
    for (const f of features || []) {
      const pts = Array.isArray(f) ? f : (f && f.points);
      if (!Array.isArray(pts) || pts.length < 3) continue;
      const ring = pts.map((q) => (Array.isArray(q) ? [q[0], q[1]] : [q.x, q.y]))
        .filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
      if (ring.length < 3) continue;
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
        ring.push([ring[0][0], ring[0][1]]);
      }
      const m = ringsToMulti([ring]);
      if (m.length) multis.push(m);
    }
    if (!multis.length) return null;
    if (multis.length === 1) return multis[0];
    // 分块并（一次并 20 块会触发退化几何抛错，见 robustOp 那条记录）
    let acc = multis[0];
    for (let i = 1; i < multis.length; i++) {
      const r = robustOp(polygonClipping, 'union', acc, multis[i]);
      if (r.multi) acc = r.multi;
    }
    return acc;
  }

  /**
   * 用给定的陆地轮廓重建省份海岸线（**只裁不加**）。
   *
   * @param {Array} features 新 .map 的 `landFeatures`
   * @param {{maxDrift?:number, onProgress?:Function, yieldEvery?:number, token?:object}} [opts]
   */
  async function rebuildCoastline(key, features, opts = {}) {
    if (isRO()) return blocked('重建海岸线');
    const terrain = provincesOf(key);
    if (!terrain.length) return { ok: false, rejected: 'no-provinces', message: '这张底图还没有省份' };
    const land = buildLandMulti(features);
    if (!land) {
      return {
        ok: false, rejected: 'no-land',
        message: '这份数据里没有可用的陆地轮廓（海岸线）—— 请选一份生成器导出的 .map；'
          + '老底图里没有这个字段',
      };
    }
    const landBox = multiBBox(land);
    const landArea = Math.abs(multiNetArea(land));

    const before = terrain.map((p) => ({ id: p.id, area: Math.abs(multiNetArea(provinceToMulti(p))) }));
    const beforeTotal = before.reduce((n, b) => n + b.area, 0);

    const report = (done, total) => {
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress({ phase: 'coast', done, total, message: `正在重建海岸线 ${done} / ${total} 个省…` }); } catch (e) { /* 回调不该影响主流程 */ }
      }
    };
    const yieldEvery = opts.yieldEvery != null ? opts.yieldEvery : 8;
    const cancelled = () => !!(opts.token && opts.token.cancelled);
    const yieldToPaint = () => new Promise((r) => {
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      raf(() => r());
    });

    const next = [];
    let changed = 0, emptied = 0, skippedInside = 0, grew = 0, shrank = 0;
    let afterTotal = 0;
    const detail = [];
    for (let i = 0; i < terrain.length; i++) {
      const p = terrain[i];
      const base = provinceToMulti(p);
      const box = provinceBBox(p);
      // 完全不与陆地相交的省（飞地 / 海域）→ 原样保留（不裁）
      if (!box || !landBox || !bboxHit(box, landBox)) { next.push(p); afterTotal += before[i].area; continue; }
      // 完全落在陆地内部 → 布尔之后逐点不变，直接跳过省一次大运算（**纯优化**，不影响结果）。
      // ⚠️ 不能用"点在边界上"判（`pointInMulti` 对边界点行为不可依赖）：这里判的是
      //    「省的包围盒完全在**放大一圈**的陆地包围盒内」——保守，宁可多算几个省也不误跳。
      const pad = Math.max((box.maxX - box.minX), (box.maxY - box.minY)) * 0.01;
      const insideBox = box.minX >= landBox.minX + pad && box.maxX <= landBox.maxX - pad
        && box.minY >= landBox.minY + pad && box.maxY <= landBox.maxY - pad;
      if (insideBox) {
        next.push(p); afterTotal += before[i].area; skippedInside++;
        continue;
      }
      // 几何兜底：算不出就**保留原省不动**（不炸；这是"重建海岸线"的批量操作，
      // 一个省算不出来不该让整批失败）
      const clipRes = robustOp(polygonClipping, 'intersection', base, land);
      if (!clipRes.multi) {
        next.push(p); afterTotal += before[i].area; skippedInside++;
        continue;
      }
      const clipped = clipRes.multi;
      const empty = isEmptyMulti(clipped);
      const patch = empty ? { points: [], extraRings: undefined, kind: kindOf(p), fromGrid: false }
        : multiToShape(clipped, kindOf(p));
      const a2 = empty ? 0 : Math.abs(multiNetArea(clipped));
      afterTotal += a2;
      const a1 = before[i].area;
      const d = a2 - a1;
      if (empty) { emptied++; changed++; detail.push({ id: p.id, name: p.name, removed: true, delta: -a1 }); }
      else if (Math.abs(d) > Math.max(1e-6, a1 * 1e-9)) {
        changed++;
        if (d > 0) grew++; else shrank++;
        detail.push({ id: p.id, name: p.name, delta: d });
      }
      next.push(normalizeProvince({ ...p, ...patch }));

      if (yieldEvery > 0 && (i + 1) % yieldEvery === 0) {
        report(i + 1, terrain.length);
        await yieldToPaint();
        if (cancelled()) return { ok: false, rejected: 'cancelled', message: '已取消：海岸线未改动' };
        if (!bm(key)) return { ok: false, rejected: 'changed', message: '底图在过程中被换掉了，已放弃（数据未改动）' };
      }
    }

    // 安全闸门：面积漂移过大 → 拒绝且零副作用（多半是选错了 .map）
    const maxDrift = opts.maxDrift != null ? opts.maxDrift : COASTLINE_MAX_AREA_DRIFT;
    const drift = beforeTotal > 0 ? (afterTotal - beforeTotal) / beforeTotal : 0;
    if (Math.abs(drift) > maxDrift) {
      return {
        ok: false, rejected: 'area-gate', drift,
        message: `这次重建会让省份总面积变化 ${(drift * 100).toFixed(1)}%（超过 ${(maxDrift * 100).toFixed(0)}% 闸门）`
          + '——看起来像选错了 .map（换了另一张地图的海岸线）。数据未改动',
      };
    }
    if (!changed) {
      return { ok: true, changed: 0, message: '省份边界与新海岸线已经一致，无需重建', drift, landArea };
    }

    execute({
      type: 'rebuild-coastline',
      label: '按新海岸线重建省份外环',
      undo: () => setTerrain(key, terrain),
      redo: () => setTerrain(key, next),
    });
    return {
      ok: true,
      changed,
      emptied,
      grew,
      shrank,
      skippedInside,
      drift,
      landArea,
      landBox,
      beforeTotal,
      afterTotal,
      // 逐省前后面积（只留变化最大的 20 个）—— 诊断"到底裁掉了谁"时靠它，不靠猜
      perProvince: before.map((b, i) => ({
        id: b.id,
        before: b.area,
        after: Math.abs(multiNetArea(provinceToMulti(next[i]))),
      })).filter((x) => Math.abs(x.after - x.before) > Math.max(1e-6, x.before * 1e-9))
        .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 20),
      detail: detail.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 20),
      message: `已按新海岸线重建 ${changed} 个省的边界`
        + `（面积 ${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(2)}%`
        + `${skippedInside ? `，${skippedInside} 个内陆省逐点未动` : ''}`
        + `${emptied ? `，⚠️ ${emptied} 个省被清空` : ''}）`,
    };
  }

  /** 从当前底图已存的 `landFeatures` 重建（导入 .map 时 parser 已把它带进来） */
  function rebuildCoastlineFromBaseMap(key, opts = {}) {
    const m = bm(key);
    const feats = (m && Array.isArray(m.landFeatures)) ? m.landFeatures : [];
    if (!feats.length) {
      return Promise.resolve({
        ok: false, rejected: 'no-land',
        message: '这张底图里没有陆地轮廓数据 —— 老底图没有这个字段；'
          + '请点「地形/数据」区的刷新按钮选一份生成器导出的 .map',
      });
    }
    return rebuildCoastline(key, feats, opts);
  }

  /** 把一组 region ops 讲成人话（供状态栏："并入 X、从 Y 挖去"） */
  function describeRegionOps(key, ops) {
    if (!ops || !ops.length) return '';
    const list = provincesOf(key);
    return ops.map((o) => {
      const p = list.find((q) => q.id === o.id);
      const name = (p && p.name) || o.id;
      return o.op === 'union' ? `并入「${name}」` : `从「${name}」挖去${o.emptied ? '（已清空）' : '一块'}`;
    }).join('、');
  }

  /**
   * 抬手：把整笔压成**一条 undo**。
   * @returns {{ changed:number, label:string, ops:Array, detail:string }|null}
   */
  function endProvinceStroke(label = '省份笔刷', opts = {}) {
    const s = stroke;
    stroke = null;
    if (!s || !s.path.length) return null;
    const key = s.key;
    // 🔴 只读态第二道门：`applyProvinceStroke` 已经不记轨迹，这里是防御性的 ——
    //    本模块的每个写操作都必须能回答「只读态下会不会改内存 / 落盘」（test_54 的写口契约）。
    if (isRO()) return blocked(label);
    if (!bm(key)) return null;

    // 「笔刷建省」（2026-10-22）：这一笔**不是**改已有省份，而是长出一个新省 —— 走另一条落库路。
    if (s.tool === 'provincePaint') return createProvinceFromBrush(key, s, label, opts);

    // 「平滑」在矢量语义下 = 对边界做 RDP 简化（格点时代那个"3×3 邻域众数"已无对象）
    if (s.tool === 'smooth') return smoothProvinceBoundary(key, s, label);

    const target = s.tool === 'erase' ? 0 : (s.target || 0);
    if (target === 0 && s.tool !== 'erase') {
      return { changed: 0, label, ops: [], detail: '没有选中目标省份（先在工具栏选一个省）' };
    }
    const brushRings = traceBrushRings(s.path, s.radius);
    const before = provincesOf(key);
    const res = applyRegionToTerrain(key, brushRings, target, opts);
    if (!res) return { changed: 0, label, ops: [], detail: '这一笔没有碰到任何省份' };

    execute({
      type: 'province-brush',
      label,
      undo: () => setTerrain(key, before),
      redo: () => setTerrain(key, res.terrain),
    });
    return { changed: res.ops.length, label, ops: res.ops, detail: describeRegionOps(key, res.ops) };
  }

  /** 「平滑」工具：RDP 简化目标省边界（容差 = 笔刷半径的 15%） */
  function smoothProvinceBoundary(key, s, label) {
    const terrain = provincesOf(key);
    const idx = (s.target || 0) - 1;
    if (idx < 0 || !terrain[idx]) return { changed: 0, label, ops: [], detail: '没有选中目标省份' };
    const tol = (s.radius || 60) * 0.15;
    const p = terrain[idx];
    const rings = provinceRings(p);
    const before = terrain;
    const kept = rings
      .map((r) => ({ points: rdpSimplify(r.points, tol), kind: r.kind }))
      .filter((r) => r.points.length >= 3);
    if (!kept.length) return { changed: 0, label, ops: [], detail: '简化后没有有效边界' };
    const patch = shapePatch(kept);
    const after = before.map((q, i) => (i === idx ? normalizeProvince({ ...q, ...patch }) : q));
    const ptsBefore = rings.reduce((n, r) => n + r.points.length, 0);
    const ptsAfter = kept.reduce((n, r) => n + r.points.length, 0);
    if (ptsAfter >= ptsBefore) return { changed: 0, label, ops: [], detail: '边界已经足够简洁' };
    execute({
      type: 'province-smooth',
      label,
      undo: () => setTerrain(key, before),
      redo: () => setTerrain(key, after),
    });
    return { changed: 1, label, ops: [{ id: p.id, op: 'smooth' }], detail: `边界顶点 ${ptsBefore} → ${ptsAfter}` };
  }

  /**
   * 笔刷建省（2026-10-22）：一笔涂抹 → **一个省**。
   *
   * 用户原话：「按住左键像涂色一样抹，松手自动把抹过的范围长成一个省（不用闭合、不会出现
   * 一团自交线，涂抹过程就是最终形状）。」—— 这是"画图软件的手感"，和「画省份（描轮廓）」
   * 是两件事：描轮廓要求"画一圈"，笔刷要求"抹一条"。
   *
   * 与既有四条路的分工（**别混**）：
   *   · 画省份 / 描点   → 新建一个省，区域 = **画出来的轮廓**（要闭合、会贴骨架）
   *   · **笔刷建省（本函数）** → 新建一个省，区域 = **笔迹扫过的范围**（不闭合、不贴骨架）
   *   · 改省界（paint）  → **改已有省**的边界（目标省并集、相交省差集）
   *   · 涂归属（ownerBrush）→ 只改势力归属，一根线都不动
   *
   * 🔴 为什么"新省只长在空地上"（减掉已有省份）而不像描点那样弹确认框问人：
   *    笔刷是高频手势，每笔弹一次确认 = 完全没法用。所以改成**不覆盖**：
   *    已有省份的地涂不上（用户看得见），要改那些地的形状就走「改省界」。
   *    这样既没有压叠（点选/上色/标签三处口径一致），也不需要任何弹窗。
   *
   * @param {object} s 这一笔：`{ path:[{x,y}], radius, tool }`（来自 `applyProvinceStroke`）
   * @returns {{changed:number, label:string, rejected?:string, message?:string, ...}}
   *   拒绝分支**零副作用**（没建省、没进 undo 栈）。
   */
  function createProvinceFromBrush(key, s, label = '笔刷建省', opts = {}) {
    if (isRO()) return blocked(label);
    if (!bm(key)) return { changed: 0, label, rejected: 'no-basemap', message: '底图不存在' };
    const path = (s && s.path) || [];
    // 半径兜底与 `applyProvinceStroke` 一致（60 世界单位 = 旧默认）
    const radius = (s && Number.isFinite(s.radius) && s.radius > 0) ? s.radius : 60;
    const before = provincesOf(key);
    // 几何兜底时的**人话回音**（不静默降级，也不炸整笔）—— 与 `applyRegionToTerrain` 同一条纪律
    let geomWarn = '';
    const res = paintProvinceShape(polygonClipping, path, radius, before, {
      onWarn: (m) => { if (m) geomWarn = (geomWarn || '') + (geomWarn ? '；' : '') + m; },
    });
    if (res.rejected) {
      return {
        changed: 0, label, rejected: res.rejected, message: res.message,
        paintedArea: res.paintedArea, cutRatio: res.cutRatio,
      };
    }
    const patch = multiToShape(res.multi, 'land');
    if (!patch.points || patch.points.length < 3) {
      return { changed: 0, label, rejected: 'degenerate', message: '这一笔的形状退化（有效顶点不足 3 个），没有建省' };
    }
    const prov = normalizeProvince({
      id: `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: (opts && opts.name) || `新省份 ${before.length + 1}`,
      kind: 'land',
      color: (opts && opts.color) || nextProvinceColor(before.length),
      coast: true,
      ...patch,
    });
    const after = [...before, prov];
    // 整表快照 undo（与描轮廓/合并同一条路）：一笔 = 一条撤销
    execute({
      type: 'province-brush-create',
      label,
      undo: () => setTerrain(key, before),
      redo: () => setTerrain(key, after),
    });
    const pct = Math.round((res.cutRatio || 0) * 100);
    return {
      changed: 1, label,
      provinceId: prov.id, name: prov.name,
      area: Math.round(res.area || 0), paintedArea: Math.round(res.paintedArea || 0),
      cutRatio: res.cutRatio || 0, cut: res.cut || 0,
      points: patch.points.length, strokePoints: path.length,
      ...(geomWarn ? { geomWarn } : {}),
      detail: `「${prov.name}」${patch.points.length} 个顶点`
        + (pct > 0 ? `；笔迹有 ${pct}% 压在已有省份上，那部分没算进来` : '')
        + (geomWarn ? `；⚠️ ${geomWarn}` : ''),
    };
  }

  /**
   * 自由轮廓（套索）：圈出的多边形 → **并进目标省 / 从相交省挖掉**（矢量布尔）。
   *
   * 与旧实现的两点差别：
   *   ① 不再有「格数闸门」——那是栅格概念；改为**面积闸门**（轮廓包围盒 > 全图包围盒的
   *      `LASSO_AREA_SHARE` → 拒绝），仍然保证"拒绝必须零副作用"。
   *   ② 目标合法性校验保留（`target = 0` 会把圈住的地静默擦成无主 —— 这是曾经的裸奔缺口）。
   */
  function applyProvinceLasso(key, worldPoly, target, label = '自由轮廓划归', opts = {}) {
    if (isRO()) return blocked('自由轮廓划归');
    const provs = provincesOf(key);
    if (!(target >= 1 && target <= provs.length)) {
      return { changed: 0, rejected: 'no-target', message: '请先在上方选择要划归到的省份' };
    }
    const raw = (worldPoly || []).filter((p) => p && isFinite(p.x) && isFinite(p.y));
    if (raw.length < 3) {
      return { changed: 0, rejected: 'too-few-points', message: '轮廓至少要有 3 个点（贴着地面拖一圈再松手）' };
    }
    const poly = simplifyClosedTrace(raw);
    const ring = ringToXY(poly);
    if (!ring) return { changed: 0, rejected: 'too-few-points', message: '轮廓退化（有效点不足 3 个）' };

    // 面积闸门：套索包围盒 vs 全部省份的包围盒（零副作用 —— 在改任何东西之前判）
    const maxShare = opts.maxShare ?? LASSO_AREA_SHARE;
    const polyBox = multiBBox(ringsToMulti([ring]));
    let all = null;
    for (const p of provs) {
      const b = provinceBBox(p);
      if (!b) continue;
      all = all
        ? {
          minX: Math.min(all.minX, b.minX), minY: Math.min(all.minY, b.minY),
          maxX: Math.max(all.maxX, b.maxX), maxY: Math.max(all.maxY, b.maxY),
        }
        : { ...b };
    }
    if (polyBox && all) {
      const w = Math.max(all.maxX - all.minX, 1e-6), h = Math.max(all.maxY - all.minY, 1e-6);
      const share = ((polyBox.maxX - polyBox.minX) * (polyBox.maxY - polyBox.minY)) / (w * h);
      if (share > maxShare) {
        return {
          changed: 0, rejected: 'area-gate', share,
          message: `这一次圈住了全图约 ${Math.round(share * 100)}%（超过 ${Math.round(maxShare * 100)}%）`
            + '——多半是圈歪了或想整块陆地，请改小轮廓，或用「涂归属」笔刷分次涂',
        };
      }
    }

    const before = provincesOf(key);
    const res = applyRegionToTerrain(key, [ring], target, opts);
    if (!res) {
      return { changed: 0, label, ops: [], simplified: { from: raw.length, to: poly.length }, detail: '这个轮廓没有覆盖到任何省份' };
    }
    execute({
      type: 'province-lasso',
      label,
      undo: () => setTerrain(key, before),
      redo: () => setTerrain(key, res.terrain),
    });
    return {
      changed: res.ops.length, label, ops: res.ops,
      simplified: { from: raw.length, to: poly.length },
      detail: describeRegionOps(key, res.ops),
    };
  }

  /**
   * 点击填充：把**点击处所属的省份**整块并入目标省（矢量语义）。
   *
   * 🔴 语义变更（P2）：格点时代它是「把点击处所在的**连通格子区域**整块划归」——
   *    但"连通格子区域"只有栅格才存在。矢量模型下等价的、且更有用的语义是
   *    **「把这一整块地给某个省」**：目标省吸收被点中的省（保留目标省自己的 id 与名字，
   *    因为 id 是它在时间轴 / 势力归属里的身份）。
   *    复用 `mergeProvinces`（精确并集 + 一条 undo），不再有"一点吞掉整片海"的风险 ——
   *    吞并的对象是**一个有边界的省份**，不是无限的连通区域。
   */
  function fillProvinceRegion(key, { x, y }, target) {
    if (isRO()) return blocked('点击填充');
    const provs = provincesOf(key);
    if (!(target >= 1 && target <= provs.length)) {
      return { changed: 0, rejected: 'no-target', message: '请先在上方选择要填充到的省份' };
    }
    const hitIdx = provs.findIndex((p) => provinceRings(p).length && pointInProvince(x, y, p));
    if (hitIdx < 0) {
      return {
        changed: 0, rejected: 'no-province',
        message: '这里没有省份（点在空白或海洋上）——先用「画省份」画一块，或点到别的省份上',
      };
    }
    if (hitIdx + 1 === target) return { changed: 0, message: '这一块已经属于该省份' };
    const targetProv = provs[target - 1];
    const hitProv = provs[hitIdx];
    const res = mergeProvinces(key, [targetProv.id, hitProv.id], { name: targetProv.name });
    if (!res || res.blocked || res.rejected) return res || { changed: 0, message: '填充失败' };
    return {
      changed: 2,
      label: `点击填充：「${hitProv.name || hitProv.id}」并入「${targetProv.name || targetProv.id}」`,
      swallowed: hitProv.name || hitProv.id,
      into: targetProv.name || targetProv.id,
    };
  }

  // ============================================================
  // 分割 / 折线切割 / 合并（几何在纯函数层；这里只管「一条 undo + 网格作废」）
  // ============================================================

  /**
   * 把「切成两半」的结果落成**一条 undo**（直线分割与折线切割共用）。
   *
   * 🔴 占原位的那一半必须**连 id 一起继承**：省份 id 是它在时间轴 / 归属 / 引用里的身份，
   *    换了 id 等于「那块地换了一个省」—— 历史归属会整段对不上（这类静默错数据最难发现）。
   *    `side`（+1 / -1）决定**哪一半占原位序号**：序号决定「时间轴 / 归属里那条历史的省
   *    还是不是这块地」，所以用户必须能选边。
   *
   * ⚠️ 本函数**不含** `guardWrite`/`blocked`：它自己不改任何数据，写入全在 `execute` 的
   *    redo 回调里（`execute` 内部先过闸门）。写口契约（test_54）因此不登记它 —— 登记了反而
   *    会让「函数首行守卫」那条判据把一次**只读**操作算成写口。
   */
  function commitSplit(key, idx, res, side, label) {
    const terrain = provincesOf(key);
    const keepA = side >= 0;
    const orig = terrain[idx];
    const keptPick = keepA ? res.a : res.b;
    const otherPick = keepA ? res.b : res.a;
    const atIndex = { ...keptPick, id: orig.id, name: orig.name || keptPick.name };   // 占原位序号的那一半
    const appended = { ...otherPick, id: otherPick.id, name: otherPick.name };        // 追加到表尾的新省（新 id / 新名）
    const before = terrain;
    const after = terrain.map((p, i) => (i === idx ? atIndex : p)).concat([appended]);
    const apply = (next) => {
      invalidateProvinceGrid(key);          // 几何换了 → 网格按新多边形重建（签名检查也会兜住）
      setTerrain(key, next, { save: false });
      scheduleAutoSaveScenarios();
    };
    execute({
      type: 'province-split',
      label,
      undo: () => apply(before),
      redo: () => apply(after),
    });
    return {
      a: res.a, b: res.b, index: idx + 1, newIndex: after.length,
      side: keepA ? 1 : -1, keptId: atIndex.id, appendedId: appended.id,
    };
  }

  /**
   * 沿切割线把省份一分为二（**保留多环与 land/sea**）。
   * 默认原省占原位（序号不变 → 标签继续有效），新省追加到表尾（新序号原本无主）。
   *
   * **侧符号（P2）**：`side`（+1 / -1）决定**哪一半占原位序号** ——
   * 序号决定「时间轴 / 归属里那条历史的省还是不是这块地」，所以用户必须能选边：
   * 默认 a 侧留原位，`side:-1` 则 b 侧留原位（另一侧拿新序号）。
   *
   * 网格按新多边形重建（几何变化很大，增量改格没有意义）。
   */
  function splitProvince(key, provinceId, p1, p2, { side = 1 } = {}) {
    if (isRO()) return blocked('分割省份');
    const terrain = provincesOf(key);
    const idx = terrain.findIndex((p) => p.id === provinceId);
    if (idx < 0) return null;
    const res = splitProvinceShape(terrain[idx], p1, p2);
    if (!res) return { rejected: 'no-cut', message: '切割线没有穿过这个省份（两点要落在它的两侧）' };
    return commitSplit(key, idx, res, side, `分割省份「${terrain[idx].name || provinceId}」`);
  }

  /**
   * 沿**折线**把省份切成两半（A 方案：`splitProvinceShape` 只能切直线，见 polygonBool 头注）。
   * 与直线分割共用 `commitSplit` —— 「哪一半继承原 id」的规则只此一处。
   */
  function splitProvinceAlong(key, provinceId, polyline, { side = 1 } = {}) {
    if (isRO()) return blocked('折线切割');
    const terrain = provincesOf(key);
    const idx = terrain.findIndex((p) => p.id === provinceId);
    if (idx < 0) return { rejected: 'not-found', message: '要切的省份已不存在' };
    const res = splitProvinceByPolyline(polygonClipping, rawProvinces(key)[idx], polyline);
    if (!res) return { rejected: 'no-cut', message: '这条折线没有把这个省份切成两块（折线要横穿它，两端可以落在省外）' };
    const r = commitSplit(key, idx, res, side, `折线切割「${terrain[idx].name || provinceId}」`);
    return { ...r, snapped: !!res.snapped, cutPoints: res.cutPoints, runs: res.runs };
  }

  /**
   * 折线在某个省**内部**的那一段（沿用笔迹走向；没穿进去则 null）。
   *
   * 做法：逐段取**中点**判"在不在这个省里"（顶点可能正落在边界上 ⇒ 中点更稳），
   * 把连续落在内部的段收成 run、取最长的一段；两端再沿切向**外扩半个段长**，
   * 保证端点落在省外（延长本来就是 `splitProvinceByPolyline` 的前提）。
   */
  function extractInsideSegment(polyline, prov) {
    if (!Array.isArray(polyline) || polyline.length < 2) return null;
    const inside = [];
    for (let i = 1; i < polyline.length; i++) {
      const mx = (polyline[i - 1].x + polyline[i].x) / 2;
      const my = (polyline[i - 1].y + polyline[i].y) / 2;
      inside.push(pointInProvince(mx, my, prov));
    }
    let bestFrom = -1, bestTo = -1, from = -1;
    for (let i = 0; i <= inside.length; i++) {
      if (i < inside.length && inside[i]) { if (from < 0) from = i; continue; }
      if (from >= 0) {
        if (bestFrom < 0 || (i - from) > (bestTo - bestFrom)) { bestFrom = from; bestTo = i; }
        from = -1;
      }
    }
    if (bestFrom < 0) return null;
    const a = { x: polyline[bestFrom].x, y: polyline[bestFrom].y };
    const b = { x: polyline[bestTo].x, y: polyline[bestTo].y };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > 1e-9)) return null;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const pad = Math.max(len * 0.5, 1e-3);
    return {
      from: { x: a.x - ux * pad, y: a.y - uy * pad },
      to: { x: b.x + ux * pad, y: b.y + uy * pad },
      points: polyline.slice(bestFrom, bestTo + 1).map((p) => ({ x: p.x, y: p.y })),
    };
  }

  /** 折线穿过了哪些省（按折线上出现的先后顺序返回下标；判据 = 段中点在省里） */
  function provincesCrossedByPolyline(key, polyline) {
    const terrain = rawProvinces(key);
    const hits = [];
    for (let i = 1; i < polyline.length; i++) {
      const mx = (polyline[i - 1].x + polyline[i].x) / 2;
      const my = (polyline[i - 1].y + polyline[i].y) / 2;
      for (let j = 0; j < terrain.length; j++) {
        const p = terrain[j];
        if (!provinceRings(p).length) continue;
        if (!pointInProvince(mx, my, p)) continue;
        if (hits.indexOf(j) < 0) hits.push(j);
      }
    }
    return hits;
  }

  /**
   * **一次切多块**：一条折线横穿几个省，就把这几个省都切开。
   *
   * 为什么现在可以（原先"一次只切一个"的理由已不成立）：单省切分只改 `terrain[idx]` +
   * **表尾追加**新省 ⇒ 既有下标一个都不动，逐个切互不干扰。每个省用的是
   * 「折线**在它内部**的那一段」而不是整条折线 —— 否则延长段会替邻居做决定，
   * 那正是当初要防的事。
   *
   * ⚠️ **undo 粒度**：每个省一条 undo（复用 `commitSplit`，不另造批量命令）——
   *    切了 N 个省就要按 N 次 Ctrl+Z，回执里如实写明。
   */
  function splitProvincesAlong(key, polyline, { side = 1, maxProvinces = 24 } = {}) {
    if (isRO()) return blocked('折线切割');
    if (!provincesOf(key).length) return { ok: false, changed: 0, results: [], skipped: [], message: '这张底图还没有省份' };
    const pts = (Array.isArray(polyline) ? polyline : []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) return { ok: false, changed: 0, results: [], skipped: [], message: '折线至少要两个点' };

    const crossed = provincesCrossedByPolyline(key, pts);
    if (!crossed.length) {
      return { ok: false, changed: 0, results: [], skipped: [], rejected: 'no-cut', message: '这条折线没有横穿任何省份（要真的穿过去，不能只贴着边走）' };
    }
    if (crossed.length > maxProvinces) {
      return {
        ok: false, changed: 0, results: [], skipped: [], rejected: 'too-many', count: crossed.length,
        message: `这条折线横穿了 ${crossed.length} 个省（超过上限 ${maxProvinces}）—— `
          + '多半是画歪了或想切整块大陆；请缩短折线，或分几笔切',
      };
    }

    const results = [];
    const skipped = [];
    for (let n = crossed.length - 1; n >= 0; n--) {
      const idx = crossed[n];
      const prov = provincesOf(key)[idx];
      if (!prov) { skipped.push({ idx: idx + 1, reason: 'gone' }); continue; }
      const seg = extractInsideSegment(pts, rawProvinces(key)[idx]);
      if (!seg) { skipped.push({ idx: idx + 1, name: prov.name, reason: 'no-inside' }); continue; }
      const r = splitProvinceAlong(key, prov.id, seg.points, { side });
      if (!r) { skipped.push({ idx: idx + 1, name: prov.name, reason: 'no-cut' }); continue; }
      if (r.rejected || r.blocked) {
        skipped.push({ idx: idx + 1, name: prov.name, reason: r.rejected || 'blocked', message: r.message });
        continue;
      }
      results.push({ idx: idx + 1, name: prov.name, keptId: r.keptId, appendedId: r.appendedId, cutPoints: r.cutPoints });
    }

    if (!results.length) {
      return { ok: false, changed: 0, results, skipped, rejected: 'no-cut', message: '这几刀都没成功（折线可能贴着边界走，没能真正横穿）' };
    }
    return {
      ok: true,
      changed: results.length,
      results,
      skipped,
      crossed: crossed.length,
      side,
      message: `已切开 ${results.length} 个省`
        + (skipped.length ? `（跳过 ${skipped.length} 个）` : '')
        + ` —— 每个省一条撤销，要按 ${results.length} 次 Ctrl+Z 逐个回退`,
    };
  }

  /**
   * 合并若干省份为一个**多环实体** —— 多边形布尔**精确并集**。
   *
   * 🔴 P2 换掉了 `mergeProvinceShapes`（共边抵消）：它有 `maxWork = 2e7` 上限，
   *    真实库前两大省（10525 × 10071 点）→ work ≈ 1.06e8 → overflow → 退回
   *    `unionRingsByRaster(maxDim=220)` → 上万点的省被重采样成 220 分辨率轮廓
   *    （这是用户实测的**第二处**"退化"，与涂归属那条链独立）。
   *    布尔引擎没有这个上限，且对**不共边 / 部分重叠 / 带洞**一律正确
   *    （`mergeProvinceShapes` 仍留在 provinceShape.js 里并被单测覆盖，作为纯参考实现）。
   *
   * 结果替换第一个省份的位置（其余删除）→ 表变短；`labels` 旧序号由既有自愈逻辑接管。
   */
  function mergeProvinces(key, provinceIds, { name = '' } = {}) {
    if (isRO()) return blocked('合并省份');
    let ids = (provinceIds || []).filter(Boolean);
    ids = Array.from(new Set(ids));      // 去重：同一个省被选两次不该算「两个」（否则合并静默失败）
    if (ids.length < 2) return { rejected: 'too-few', message: '至少选择两个省份才能合并' };
    const terrain = provincesOf(key);
    const picked = terrain.filter((p) => ids.includes(p.id));
    if (picked.length < 2) return { rejected: 'not-found', message: '要合并的省份已不存在' };
    const withGeom = picked.filter((p) => provinceRings(p).length);
    if (!withGeom.length) return { rejected: 'no-geometry', message: '这些省份还没有几何（先涂抹出轮廓再合并）' };

    const kind = withGeom.every((p) => kindOf(p) === 'sea') ? 'sea' : 'land';
    const merged = unionMulti(
      polygonClipping,
      provinceToMulti(withGeom[0]),
      withGeom.slice(1).map((p) => provinceToMulti(p)),
    );
    if (isEmptyMulti(merged)) return { rejected: 'no-geometry', message: '合并后的几何为空' };
    const patch = multiToShape(merged, kind);

    const keepId = picked[0].id;
    // 占原位的那一份**连 id 一起继承**：id 是它在时间轴 / 势力归属 / 引用里的身份
    const mergedProv = normalizeProvince({
      ...picked[0],
      id: keepId,
      name: name || picked.map((p) => p.name).filter(Boolean).join('+') || '合并省份',
      ...patch,
    });
    const before = terrain;
    const after = terrain
      .map((p) => (p.id === keepId ? mergedProv : p))
      .filter((p) => !(ids.includes(p.id) && p.id !== keepId));

    const apply = (next) => {
      invalidateProvinceGrid(key);
      setTerrain(key, next);
    };
    execute({
      type: 'province-merge',
      label: `合并 ${picked.length} 个省份`,
      undo: () => apply(before),
      redo: () => apply(after),
    });
    return {
      merged: mergedProv, removed: picked.length - 1,
      method: 'bool',
      loops: 1 + (patch.extraRings ? patch.extraRings.length : 0),
      points: patch.points.length,
      mergedCount: picked.length,
    };
  }

  // ============================================================
  // B 方案：**批量铺底**（Voronoi 一次切出 N 块）
  // ============================================================
  //
  // 暮雨的最终目标：一张底图上「少说也要切四五百块省份」。`splitProvince` 一次只切一刀，
  // 切 400 块 = 400 次精确点击 —— 不可行。这里把「播种 N 个点 → Voronoi → 与陆地求交」
  // 做成一次动作。
  //
  // 🔴 三条不许违反的约束：
  //   ① **不动海岸线**：每个 cell 都与「目标省的并集」求交，切出来的边界里，
  //      海岸那一段就是**原多边形的原顶点**（布尔交集不是重采样）→ 海岸线逐点保留。
  //   ② **不丢归属**：旧省要被删掉，如果只是删，12 个剧本里 20 条归属键就成了孤儿
  //      （画布上看不见、却仍参与 groupMap / 谱系重叠度计算）。所以每个新省**承接**
  //      它落点所在旧省的 `ownership` / `changeEvents` / `initialOwnership` / 账本事件，
  //      且这一切**同属一条 undo**（2026-10-24：账本与基线也一起迁，否则账本会永久落后）。
  //   ③ **不静默失败**：进度、跳过的块数、引擎兜底吸附次数、覆盖率都要如实回报。

  /**
   * 解析批量铺底的**目标省**（只读，不写任何东西）。
   * 默认 = 全部有几何的陆地省；`provinceIds` 给定时只认这几个。
   */
  function resolveBatchTargets(key, provinceIds, targetShapes = null) {
    // P0-2（2026-10-25）：造陆时**轮廓还不存在** —— 先生成环、直接作为"目标省"喂给同一条铺底管线。
    // 这样切省仍然只有 VoronoiShop 一份实现，不需要"造陆专用切分器"。
    if (Array.isArray(targetShapes) && targetShapes.length) {
      const targets = targetShapes
        .filter((s) => s && Array.isArray(s.points) && s.points.length >= 3)
        .map((s, i) => normalizeProvince({
          id: s.id || `batch_shape_${i}`,
          name: s.name || `陆块 ${i + 1}`,
          kind: 'land',
          color: s.color || '',
          biome: '', culture: '', coast: true,
          rings: s.rings || [s.points],
          points: s.points,
        }));
      if (!targets.length) {
        return { error: { ok: false, rejected: 'no-geometry', message: '没有可用的陆块轮廓（环点数不足）' } };
      }
      return { targets, targetIds: targets.map((p) => p.id), synthetic: true };
    }
    const all = provincesOf(key);
    if (!all.length) {
      return { error: { ok: false, rejected: 'no-province', message: '这张底图还没有省份 —— 先用「自由绘制 (B)」画一块大陆，再铺底' } };
    }
    const wanted = (provinceIds && provinceIds.length)
      ? all.filter((p) => provinceIds.includes(p.id))
      : all.filter((p) => kindOf(p) !== 'sea');
    const targets = wanted.filter((p) => provinceRings(p).length);
    if (!targets.length) {
      return { error: { ok: false, rejected: 'no-geometry', message: '目标省份还没有边界 —— 先画/涂出轮廓再铺底' } };
    }
    return { targets, targetIds: targets.map((p) => p.id), synthetic: false };
  }

  /**
   * 目标省 → 铺底范围（并集）+ 区域探针。
   * 只有一个目标省时**不做并集**（真实底图上「整块大陆就是一个省」是最常见的情形，
   * 而 10525 点自并要 1 秒多 —— 没必要白花）。
   */
  function buildBatchRegion(key, targets, synthetic = false) {
    // synthetic（造陆）：目标不是底图里已有的省，直接用传进来的形状
    const raw = synthetic
      ? targets
      : rawProvinces(key).filter((p) => targets.some((t) => t.id === p.id));
    let region = null;
    if (raw.length === 1) {
      region = provinceToMulti(raw[0]);
    } else {
      const multis = raw.map((p) => provinceToMulti(p)).filter((x) => x.length);
      if (!multis.length) return { error: { ok: false, rejected: 'no-geometry', message: '目标省份没有有效几何' } };
      const u = robustOp(polygonClipping, 'union', multis[0], ...multis.slice(1));
      if (!u.multi) return { error: { ok: false, rejected: 'bool-failed', message: `范围合并失败：${u.error}` } };
      region = u.multi;
    }
    if (isEmptyMulti(region)) return { error: { ok: false, rejected: 'no-geometry', message: '目标范围是空的' } };
    const probe = makeRegionProbe(region);
    if (!probe) return { error: { ok: false, rejected: 'no-geometry', message: '目标范围是空的' } };
    return {
      region, probe,
      regionArea: multiNetArea(region),
      regionBox: multiBBox(region),
      regionPoints: countMultiPoints(region),
    };
  }

  /**
   * **只读**：折线切割的两块几何预览（画布要实时显示"切完长什么样"）。
   * ⚠️ 只算不写 —— 真正的写入在 `splitProvinceAlong` 里（一条 undo）。
   */
  function previewSplitAlong(key, provinceId, polyline) {
    const terrain = provincesOf(key);
    const idx = terrain.findIndex((p) => p.id === provinceId);
    if (idx < 0) return null;
    const res = splitProvinceByPolyline(polygonClipping, rawProvinces(key)[idx], polyline);
    if (!res) return null;
    return {
      a: provinceToMulti(res.a), b: provinceToMulti(res.b),
      aArea: res.aArea, bArea: res.bArea, cutPoints: res.cutPoints,
    };
  }

  /**
   * **只读**：批量铺底的播种（算出 N 个落在范围内、分布均匀的种子点）。
   * 自动播种必须在**范围内部**撒点 —— 否则一半种子落在海里，切出来只有一半块数。
   */
  function planBatchSeeds(key, { provinceIds = null, count = 400, seed = 1, jitter = 0.62 } = {}) {
    const t = resolveBatchTargets(key, provinceIds);
    if (t.error) return t.error;
    const r = buildBatchRegion(key, t.targets);
    if (r.error) return r.error;
    const auto = autoSeedsInRegion(r.regionBox, r.probe, count, { seed, jitter });
    return {
      ok: true, seeds: auto.seeds, attempt: auto.attempt, requested: auto.requested,
      targets: t.targets.length, targetIds: t.targetIds,
      regionPoints: r.regionPoints,
    };
  }

  /**
   * 采集要改的剧本（只认 `ownerKey === 底图 key`，与 `removeBaseProvince` 同口径）。
   * ⚠️ 2026-10-24（第 4 件第二刀续）：快照必须**连同** `initialOwnership` 与 `ledger` 一起抓 ——
   * 只抓 ownership/changeEvents 就等于"改了缓存、账本留在旧 id 上"，之后账本再也解释不了缓存。
   * 这里存的是**引用**（不改入参；撤销直接放回这几个引用，成本 O(1)）。
   */
  function collectOwnershipBefore(key) {
    const before = {};
    for (const [scId, sc] of Object.entries(scenarios.value || {})) {
      if (!sc || sc.ownerKey !== key) continue;
      const own = sc.ownership || {};
      const ev = sc.changeEvents || {};
      const init = sc.initialOwnership || {};
      const touchedIds = Object.keys(own).length + Object.keys(ev).length + Object.keys(init).length;
      if (!touchedIds && !sc.ledger) continue;
      before[scId] = {
        ownership: { ...own },
        changeEvents: { ...ev },
        initialOwnership: sc.initialOwnership ? { ...init } : undefined,
        ledger: sc.ledger || undefined,
      };
    }
    return before;
  }

  /**
   * 归属迁移：新省承接「它的落点所在旧省」的归属与易主记录；旧省的键**删掉**。
   * 四处一起迁（ownership / initialOwnership / changeEvents / 账本）——纯函数在 `src/ledger`。
   * @param before `collectOwnershipBefore` 的结果
   * @param link   `[{ newId, srcId }]`
   */
  function buildOwnershipAfter(before, targetIds, link) {
    const after = {};
    for (const [scId, rec] of Object.entries(before)) {
      // 用快照拼一个"剧本形状"的临时对象喂给纯函数（不需要 polities/era 等其它字段）
      let sc = {
        ownership: rec.ownership,
        changeEvents: rec.changeEvents,
        initialOwnership: rec.initialOwnership,
        ledger: rec.ledger,
      };
      let touched = false;
      for (const { newId, srcId } of link) {
        if (!srcId) continue;
        const forked = forkScenarioProvince(sc, newId, srcId);
        if (forked !== sc) { sc = forked; touched = true; }
      }
      const remapped = remapScenarioOwnership(sc, { provinceRemove: targetIds });
      if (remapped !== sc) { sc = remapped; touched = true; }
      if (touched) {
        after[scId] = {
          ownership: sc.ownership,
          changeEvents: sc.changeEvents,
          initialOwnership: sc.initialOwnership,
          ledger: sc.ledger,
        };
      }
    }
    return after;
  }

  /** 把归属快照写回 store（不 execute —— 必须与 terrain 同属一条 undo） */
  function applyOwnership(snapshot) {
    if (!snapshot) return;
    const ids = Object.keys(snapshot);
    if (!ids.length) return;
    const next = { ...scenarios.value };
    for (const scId of ids) {
      const sc = next[scId];
      if (!sc) continue;
      const rec = snapshot[scId];
      const nextSc = { ...sc, ownership: rec.ownership, changeEvents: rec.changeEvents };
      if (rec.initialOwnership === undefined) delete nextSc.initialOwnership;
      else nextSc.initialOwnership = rec.initialOwnership;
      if (rec.ledger === undefined) delete nextSc.ledger;
      else nextSc.ledger = rec.ledger;
      next[scId] = nextSc;
    }
    scenarios.value = next;
  }

  /**
   * 批量铺底：把 `provinceIds`（默认全部陆地省）的地盘按 Voronoi 一次切成 N 块。
   *
   * @param {object} opts
   *   · `provinceIds` 目标省 id（null / 空 = 全部有几何的陆地省）
   *   · `sites`       手动播种（`[{x,y}]`）；给了就不再自动播种
   *   · `count`       自动播种的目标块数（默认 400）
   *   · `seed`        随机种子（同种子同结果）
   *   · `jitter`      抖动强度 0~0.95（0 = 规整方格）
   *   · `onProgress`  `({phase, done, total, message}) => void`（分批让出主线程时回调）
   * @returns 汇总（created / removed / skipped / failed / coverage / points …）
   */
  async function batchSubdivide(key, opts = {}) {
    if (isRO()) return blocked('批量铺底');
    const {
      provinceIds = null, sites = null, count = 400, seed = 1, jitter = 0.62,
      onProgress = null, yieldEvery = 4, token = null,
    } = opts;
    const report = (phase, done, total, message) => {
      if (typeof onProgress === 'function') { try { onProgress({ phase, done, total, message }); } catch (e) { /* 回调不该影响主流程 */ } }
    };
    /**
     * 🔴 让出主线程并**保证浏览器画出去一帧**（C，2026-10-11）。
     *
     * 旧实现是 `await new Promise(r => setTimeout(r, 0))` —— 它只把控制权交回**定时器队列**，
     * 浏览器并不因此插进一次渲染：一次 rAF 里排的定时器回调会在下一次绘制之前被清空。
     * 暮雨实测的现象正是这条：进度提示「卡在 414 很久」（跨 400→414 的一段一直在算，
     * 中间一声不响），而如果切的是**屏幕上的**进度条，症状会更明显。
     * rAF 让出的语义就是「等下一帧」—— 一帧一个批次，进度真的会动。
     *
     * 同时把「取消」检查放在这里：用户在遮罩上点取消 → 立即返回，**不落库、不压 undo**。
     */
    const yieldToPaint = () => new Promise((r) => {
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      raf(() => r());
    });
    const cancelled = () => !!(token && token.cancelled);
    const abort = () => ({
      ok: false, rejected: 'cancelled',
      message: '已取消：这一批切分被放弃，省份与归属都没改动（可以重新播种再来）',
    });
    const m = bm(key);
    if (!m) return { ok: false, rejected: 'no-basemap', message: '底图不存在' };
    const t = resolveBatchTargets(key, provinceIds, opts.targetShapes);
    if (t.error) return t.error;
    const targets = t.targets;
    const targetIds = t.targetIds;
    const synthetic = !!t.synthetic;

    const t0 = Date.now();

    // ① 区域 = 目标省的并集（只有一个省时不必并，省掉一次大扫描）
    report('region', 0, 1, targetIds.length === 1 ? '准备范围…' : `合并 ${targetIds.length} 个省份的范围…`);
    const r0 = buildBatchRegion(key, targets, synthetic);
    if (r0.error) return r0.error;
    const region = r0.region, probe = r0.probe;
    const regionArea = r0.regionArea, regionBox = r0.regionBox;
    await yieldToPaint();
    if (cancelled()) return abort();

    // ② 播种
    let seedPts = Array.isArray(sites) && sites.length ? sites.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : null;
    let seedInfo = { attempt: 0, requested: count };
    if (!seedPts) {
      report('seeds', 0, 1, `正在大陆里播 ${Math.round(count)} 个点…`);
      await yieldToPaint();                       // 先把"正在播种"画出去，再干重活
      const auto = autoSeedsInRegion(regionBox, probe, count, { seed, jitter });
      seedPts = auto.seeds;
      seedInfo = { attempt: auto.attempt, requested: auto.requested };
    }
    if (!seedPts.length) {
      return { ok: false, rejected: 'no-seed', message: '没能播下任何种子（范围太小或形状太碎）' };
    }

    // ③ Voronoi → 逐块与范围求交
    report('cells', 0, seedPts.length, `正在切分 ${seedPts.length} 块…`);
    await yieldToPaint();
    if (cancelled()) return abort();
    const { rings } = voronoiCells(seedPts, regionBox);
    const cells = [];
    let outside = 0, skipped = 0, failed = 0, snapped = 0, inner = 0, clipped = 0;
    let cellArea = 0, cellPoints = 0;
    const failures = [];
    // 让出节奏：默认 4 块一次（真实底图单块布尔 ~38ms → 约 150ms 一次，帧率与进度观感都够）。
    // 调用方显式给 `yieldEvery: 0` 时不让出（用例里的合成小数据要可预期的同步语义）。
    const every = yieldEvery > 0 ? yieldEvery : 0;
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      if (!ring) { skipped++; continue; }
      const box = ringBBox(ring);
      let mp = null;
      if (probe.edgeNear(box)) {
        const r = robustOp(polygonClipping, 'intersection', region, [[ring]]);
        if (!r.multi) { failed++; failures.push({ i, error: r.error }); }
        else if (isEmptyMulti(r.multi)) outside++;
        else { mp = r.multi; clipped++; if (r.snapped) snapped++; }
      } else if (probe.inside(ring[0][0], ring[0][1])) {
        mp = [[ring]];                              // 整块都在范围内 → 凸 cell 原样即省份
        inner++;
      } else {
        outside++;                                  // 整块落在海里/空白
      }
      if (mp) {
        cellArea += multiNetArea(mp);
        const pts = countMultiPoints(mp);
        cellPoints += pts;
        cells.push({ index: i, site: seedPts[i], mp, points: pts });
      }
      if (every > 0 && (i + 1) % every === 0) {
        report('cells', i + 1, rings.length, `已切分 ${i + 1} / ${rings.length} 块…`);
        await yieldToPaint();                       // 等下一帧（进度提示真的会动）
        if (cancelled()) return abort();
        if (!bm(key)) return { ok: false, rejected: 'changed', message: '底图在切分过程中被换掉了，已放弃（数据未改动）' };
      }
    }
    if (!cells.length) {
      return {
        ok: false, rejected: 'empty', message: '没有切出任何一块（范围内的种子点太少 —— 提高块数或先确认省份边界）',
        skipped, outside, failed,
      };
    }

    // ④ 落库（新省 + 归属迁移，同一条 undo）
    if (cancelled()) return abort();
    report('commit', cells.length, cells.length, '正在写入省份…');
    await yieldToPaint();                       // 让"正在写入"先画出去（落库这一下也是同步的）
    if (cancelled()) return abort();
    const terrainNow = provincesOf(key);
    // synthetic（造陆）：目标形状本来就不在 terrain 里，跳过"目标是否还在"的自检
    if (!synthetic && !terrainNow.some((p) => p.id === targetIds[0])) {
      return { ok: false, rejected: 'changed', message: '底图在切分过程中变化了，已放弃（数据未改动）' };
    }
    const stamp = Date.now().toString(36);
    const remaining = synthetic ? terrainNow.length : terrainNow.length - targets.length;
    const link = [];
    const newProvs = cells.map((c, i) => {
      const id = `prov_batch_${stamp}_${i}`;
      // 归属来源 = 新省「落点」所在的旧省（种子点必定在范围内；边界上兜底用 cell 内一点）
      let src = targets.find((p) => pointInProvince(c.site.x, c.site.y, p));
      if (!src) src = targets.find((p) => pointInProvince(c.mp[0][0][0], c.mp[0][0][1], p));
      link.push({ newId: id, srcId: src ? src.id : null });
      return normalizeProvince({
        id,
        name: `新省份 ${remaining + i + 1}`,
        kind: 'land',
        color: nextProvinceColor(remaining + i),
        biome: '', culture: '', coast: false,
        ...multiToShape(c.mp, 'land'),
      });
    });

    const idset = new Set(targetIds);
    const terrainBefore = terrainNow;
    const terrainAfter = terrainNow.filter((p) => !idset.has(p.id)).concat(newProvs);
    const ownBefore = collectOwnershipBefore(key);
    const ownAfter = buildOwnershipAfter(ownBefore, targetIds, link);

    // P0-2：造陆要「造陆 + 切省」**一条 undo** —— 所以铺底只算不写，把结果交回调用方，
    // 由它拼一条命令同时恢复/写入。真实行政区也要这条：先看方案再落库。
    if (opts.planOnly) {
      return {
        ok: true,
        planOnly: true,
        created: newProvs.length,
        newProvs,
        terrainBefore: terrainNow,
        terrainAfter,
        ownBefore,
        ownAfter,
        targetIds,
        skipped, outside, failed, snapped, inner, clipped,
        coverage: regionArea > 0 ? cellArea / regionArea : 0,
        regionArea, cellArea, cellPoints,
        seeds: seedPts.length,
        elapsedMs: Date.now() - t0,
      };
    }

    const applyTerrain = (terrain) => { invalidateProvinceGrid(key); setTerrain(key, terrain, { save: false }); };
    execute({
      type: 'province-batch-subdivide',
      label: `批量铺底：${targets.length} 省 → ${newProvs.length} 块`,
      undo: () => { applyTerrain(terrainBefore); applyOwnership(ownBefore); scheduleAutoSaveScenarios(); },
      redo: () => { applyTerrain(terrainAfter); applyOwnership(ownAfter); scheduleAutoSaveScenarios(); },
    });

    return {
      ok: true,
      created: newProvs.length,
      removed: targets.length,
      targetIds,
      newIds: newProvs.map((p) => p.id),
      skipped, outside, failed, snapped, inner, clipped,
      failures: failures.slice(0, 5),
      coverage: regionArea > 0 ? cellArea / regionArea : 0,
      regionArea, cellArea, cellPoints,
      regionPoints: r0.regionPoints,
      seeds: seedPts.length, seedAttempt: seedInfo.attempt,
      ownershipMigrated: Object.keys(ownAfter).length,
      elapsedMs: Date.now() - t0,
    };
  }


  // ============================================================
  // 造陆（P0-2，2026-10-25）：轮廓生成 + 铺底切省（**一条 undo**）
  // ============================================================

  /** 没有陆地时用的默认区域（世界坐标；与剧本画布的常用范围同量级） */
  const LANDMASS_BBOX_DEFAULT = Object.freeze({ minX: -900, minY: -500, maxX: 900, maxY: 500 });

  /** 造陆区域：已有陆地就用它的包围盒外扩 4%（在原来的地方造），否则用默认区域 */
  function landmassBBox(key) {
    let box = null;
    for (const p of rawProvinces(key)) {
      const bb = provinceBBox(p);
      if (!bb) continue;
      if (!box) box = { ...bb };
      else {
        box.minX = Math.min(box.minX, bb.minX);
        box.minY = Math.min(box.minY, bb.minY);
        box.maxX = Math.max(box.maxX, bb.maxX);
        box.maxY = Math.max(box.maxY, bb.maxY);
      }
    }
    if (box && (box.maxX - box.minX) > 10 && (box.maxY - box.minY) > 10) {
      const w = box.maxX - box.minX, h = box.maxY - box.minY;
      return {
        minX: box.minX - w * 0.02, minY: box.minY - h * 0.02,
        maxX: box.maxX + w * 0.02, maxY: box.maxY + h * 0.02,
      };
    }
    return { ...LANDMASS_BBOX_DEFAULT };
  }

  /**
   * **只读**：出 1~4 张大陆轮廓候选（给面板画缩略图）。
   * 候选 id 稳定（`land-<基准种子>-<序号>`）—— 同参数永远同三张，选中哪张应用的就是哪张。
   * ⚠️ 只生成**轮廓**，不铺底、不写任何数据（铺底很贵，应该在用户点了应用之后才算）。
   */
  function previewLandmass(key, paramsIn = {}, opts = {}) {
    const m = bm(key);
    if (!m) return { ok: false, rejected: 'no-basemap', message: '先选一张底图', candidates: [] };
    const norm = normalizeLandParams(paramsIn);
    const count = Math.max(1, Math.min(4, Math.floor(Number(opts.count) || 3)));
    const bbox = landmassBBox(key);
    const candidates = [];
    for (let i = 0; i < count; i++) {
      const params = { ...norm.params, seed: candidateSeed(norm.params.seed, i) };
      const gen = buildLandmass(toLandmassOptions(params), bbox);
      candidates.push({
        id: `land-${norm.params.seed}-${i}`,
        index: i,
        seed: params.seed,
        params,
        bbox,
        // ⚠️ 洞（湖泊）必须一起回传：面板缩略图要把它挖成水面，否则预览里湖会显示成陆地
        //    （v2 就漏了这条，缩略图与实际铺底不一致）
        rings: gen.rings.map((r) => ({ id: r.id, points: r.points, holes: r.holes || [], area: r.area })),
        stats: gen.stats,
      });
    }
    return {
      ok: true,
      params: norm.params,
      warnings: norm.warnings,
      bbox,
      candidates,
      hasTerrain: provincesOf(key).length,
      message: `已出 ${candidates.length} 张大陆候选（${describeLandParams(norm.params)}）`,
    };
  }

  /**
   * **造陆 + 铺底切省**（P0-2）：轮廓由 `utils/landmass.js` 生成，切分复用 `batchSubdivide`
   * 的 `planOnly` 计划（**不是第二套切分器**），最后拼成**一条命令**落库 —— 一次 Ctrl+Z 全退回。
   *
   * 🔴 已有陆地时默认**拒绝**（`rejected:'has-terrain'`）：造陆会覆盖整张底图的省份，
   *    必须由 UI 明确问过用户再带 `force:true` 进来（与 P0-1 的覆盖语义一致）。
   */
  async function generateLandmass(key, paramsIn = {}, opts = {}) {
    if (isRO()) return blocked('造陆');
    const m = bm(key);
    if (!m) return { ok: false, rejected: 'no-basemap', message: '先选一张底图' };
    const existing = provincesOf(key);
    if (existing.length && !opts.force) {
      return {
        ok: false, rejected: 'has-terrain',
        message: `这张底图已经有 ${existing.length} 块陆地/省份 —— 造陆会整张替换（连同归属键），`
          + '确认后才能继续（旧数据可由一次 Ctrl+Z 退回）。',
      };
    }
    const norm = normalizeLandParams(paramsIn);
    const bbox = landmassBBox(key);
    const gen = buildLandmass(toLandmassOptions(norm.params), bbox);
    if (!gen.rings.length) return { ok: false, rejected: 'no-rings', message: '没生成出任何陆地轮廓' };
    const shapes = gen.rings.map((r) => ({
      id: `land_outline_${norm.params.seed}_${r.id}`,
      name: '陆块',
      points: r.points,
      // v2：环可能带洞（湖泊）—— 一起交给铺底，否则湖会被当成陆地切进省份
      rings: [r.points, ...((r.holes || []))],
    }));
    // 只算不写：铺底的 Voronoi/裁剪走同一条实现，结果交回这里拼命令
    const plan = await batchSubdivide(key, {
      targetShapes: shapes,
      count: norm.params.provinceCount,
      seed: norm.params.seed,
      planOnly: true,
      yieldEvery: 4,
      onProgress: opts.onProgress,
      token: opts.token,
    });
    if (!plan || plan.ok === false) return plan || { ok: false, rejected: 'subdivide-failed', message: '铺底计划失败' };

    const terrainBefore = plan.terrainBefore;
    const terrainAfter = plan.terrainAfter;
    execute({
      type: 'generate-landmass',
      label: `造陆：${gen.rings.length} 块陆地 / ${plan.created} 省`,
      undo: () => {
        invalidateProvinceGrid(key);
        setTerrain(key, terrainBefore, { save: false });
        applyOwnership(plan.ownBefore);
        scheduleAutoSaveScenarios();
      },
      redo: () => {
        invalidateProvinceGrid(key);
        setTerrain(key, terrainAfter, { save: false });
        applyOwnership(plan.ownAfter);
        scheduleAutoSaveScenarios();
      },
    });

    return {
      ok: true,
      changed: true,
      created: plan.created,
      removed: existing.length,
      rings: gen.rings.length,
      landRatio: gen.stats.landRatio,
      targetRatio: gen.stats.targetRatio,
      bbox,
      params: norm.params,
      elapsedMs: plan.elapsedMs,
      message: `已造陆：${gen.rings.length} 块陆地 → 铺成 ${plan.created} 省`
        + `（实际陆地占比 ${(gen.stats.landRatio * 100).toFixed(1)}% / 目标 ${(gen.stats.targetRatio * 100).toFixed(0)}%；`
        + `${describeLandParams(norm.params)}）—— 一次 Ctrl+Z 可整体退回`,
    };
  }

  // ============================================================
  // 文化 / 宗教派生（P0-4，2026-10-25）
  // ============================================================
  //
  // 数据形状（沿用导入与笔刷的同一份）：`heightmap.culture/religion` = Uint8Array（0 = 无主），
  // 列表在 `heightmap.cultures/religions`（`{i,name,color}`），省份摘要写 `terrain[].cultureId/culture/...`。
  // 两处都要改 → 一条命令里同时 `commitHeightmap` 与 `setTerrain`，一次 Ctrl+Z 全退回。

  function channelFilled(arr) {
    if (!arr || !arr.length) return 0;
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i]) n++;
    return n;
  }

  /** 只读预览：派生会得到什么、现有数据有多少（UI 据此推荐"只补空/覆盖"） */
  function previewCultureDerive(key, paramsIn = {}) {
    const m = bm(key);
    if (!m) return { ok: false, rejected: 'no-basemap', message: '先选一张底图' };
    const hm = getHeightmapFor(key);
    if (!hm || !hm.grid || !Array.isArray(hm.grid.points) || !hm.grid.points.length) {
      return {
        ok: false, rejected: 'no-heightmap',
        message: '文化/宗教是**逐格**数据：这张底图还没有高度图网格 —— 先「按轮廓生成地形」或导入 .map，再派生',
      };
    }
    const norm = normalizeCultureParams(paramsIn);
    const terrain = provincesOf(key);
    const derived = deriveCultureLayers({
      grid: hm.grid, h: hm.h, seaLevel: SEA_LEVEL, terrain, params: norm.params,
    });
    const polityPlan = planPolities(terrain, derived.provinceCulture, norm.params);
    const existing = {
      cultureCells: channelFilled(hm.culture),
      religionCells: channelFilled(hm.religion),
      cultures: Array.isArray(hm.cultures) ? hm.cultures.length : 0,
      religions: Array.isArray(hm.religions) ? hm.religions.length : 0,
      provinceCultured: terrain.filter((p) => p && p.cultureId).length,
      provinceTotal: terrain.length,
    };
    return {
      ok: true,
      params: norm.params,
      derived,
      polityPlan,
      existing,
      message: `预览：${derived.stats.cultureCount} 文化 / ${derived.stats.religionCount} 宗教（${derived.stats.landCells} 个陆格）`
        + ` · ${polityPlan.stats.polities} 势力 / ${polityPlan.stats.assigned} 省`,
    };
  }

  /**
   * 落库文化/宗教派生。
   * `strategy`：`fill-empty`（默认，只补空格/空省 —— 手改与已有数据一律不动）| `overwrite`（整层替换）。
   * ⚠️ 覆盖模式会**替换**已有文化/宗教（不只是补空）；UI 必须先问。
   */
  function applyCultureDerive(key, paramsIn = {}, opts = {}) {
    if (isRO()) return blocked('文化/宗教派生');
    const pv = previewCultureDerive(key, paramsIn);
    if (!pv.ok) return pv;
    const strategy = opts.strategy === 'overwrite' ? 'overwrite' : 'fill-empty';
    const hm = getHeightmapFor(key);
    const terrain = provincesOf(key);
    const derived = pv.derived;
    const n = hm.grid.points.length;
    const oldCulture = hm.culture && hm.culture.length === n ? new Uint8Array(hm.culture) : null;
    const oldReligion = hm.religion && hm.religion.length === n ? new Uint8Array(hm.religion) : null;
    const nextCulture = oldCulture ? new Uint8Array(oldCulture) : new Uint8Array(n);
    const nextReligion = oldReligion ? new Uint8Array(oldReligion) : new Uint8Array(n);
    let cultureCells = 0, religionCells = 0, keptCells = 0;
    for (let i = 0; i < n; i++) {
      const c = derived.cultureGrid[i] || 0;
      if (c) {
        if (strategy === 'overwrite' || !nextCulture[i]) {
          if (nextCulture[i] !== c) cultureCells++;
          nextCulture[i] = c;
        } else keptCells++;
      }
      const r = derived.religionGrid[i] || 0;
      if (r && (strategy === 'overwrite' || !nextReligion[i])) {
        if (nextReligion[i] !== r) religionCells++;
        nextReligion[i] = r;
      }
    }
    const mergeList = (oldList, gen) => {
      if (strategy === 'overwrite') return gen.map((x) => ({ ...x }));
      const out = Array.isArray(oldList) ? oldList.map((x) => ({ ...x })) : [];
      const ids = new Set(out.map((x) => x.i));
      for (const g of gen) if (!ids.has(g.i)) out.push({ ...g });
      return out;
    };
    const nextCultures = mergeList(hm.cultures, derived.cultures);
    const nextReligions = mergeList(hm.religions, derived.religions);

    let provinceChanged = 0;
    const nextTerrain = terrain.map((p) => {
      if (!p || p.kind === 'sea') return p;
      const rec = derived.provinceCulture[p.id];
      if (!rec) return p;
      if (strategy === 'fill-empty' && p.cultureId && p.religionId) return p;
      const next = {
        ...p,
        cultureId: rec.cultureId || p.cultureId || 0,
        culture: rec.culture || p.culture || '',
        cultureColor: rec.cultureColor || p.cultureColor || '',
        religionId: rec.religionId || p.religionId || 0,
        religion: rec.religion || p.religion || '',
      };
      if (next.cultureId !== p.cultureId || next.religionId !== p.religionId || next.culture !== p.culture) provinceChanged++;
      return next;
    });
    const listsChanged = nextCultures.length !== (hm.cultures || []).length
      || nextReligions.length !== (hm.religions || []).length;

    if (!cultureCells && !religionCells && !provinceChanged && !listsChanged) {
      return { ok: true, changed: false, noop: true, message: '派生结果与现有数据一致（只补空模式下没有可补的）' };
    }

    const buildHm = (culture, religion, cultures, religions) => {
      const next = { ...hm };
      if (culture) next.culture = culture; else delete next.culture;
      if (religion) next.religion = religion; else delete next.religion;
      if (cultures && cultures.length) next.cultures = cultures; else delete next.cultures;
      if (religions && religions.length) next.religions = religions; else delete next.religions;
      return next;
    };
    execute({
      type: 'derive-culture',
      label: strategy === 'overwrite'
        ? `覆盖派生文化/宗教（${derived.stats.cultureCount}/${derived.stats.religionCount}）`
        : `补空派生文化/宗教（${derived.stats.cultureCount}/${derived.stats.religionCount}）`,
      undo: () => {
        commitHeightmap(key, buildHm(oldCulture, oldReligion, hm.cultures, hm.religions));
        setTerrain(key, terrain, { save: false });
        scheduleAutoSaveScenarios();
      },
      redo: () => {
        commitHeightmap(key, buildHm(nextCulture, nextReligion, nextCultures, nextReligions));
        setTerrain(key, nextTerrain, { save: false });
        scheduleAutoSaveScenarios();
      },
    });
    return {
      ok: true,
      changed: true,
      strategy,
      cultureCells,
      religionCells,
      keptCells,
      provinces: provinceChanged,
      cultures: nextCultures.length,
      religions: nextReligions.length,
      params: pv.params,
      message: strategy === 'overwrite'
        ? `已覆盖派生：文化 ${derived.stats.cultureCount} 个 / 宗教 ${derived.stats.religionCount} 个`
          + `（改 ${cultureCells} 格文化、${religionCells} 格宗教、${provinceChanged} 省摘要）—— 一次 Ctrl+Z 可整体退回`
        : `已补空派生：文化 ${derived.stats.cultureCount} 个 / 宗教 ${derived.stats.religionCount} 个`
          + `（补 ${cultureCells} 格文化、${religionCells} 格宗教、${provinceChanged} 省摘要；`
          + `保留已有 ${keptCells} 格）—— 一次 Ctrl+Z 可整体退回`,
    };
  }

  // ============================================================
  // 省份定义表（新增 / 删除 / 清空）—— 与 terrain[] 同步
  // ============================================================

  /** 建一个「纯网格省份」（没有多边形轮廓：边界由 labels 自动提取）并返回它的序号 */
  function addBrushProvince(key, { name = '', color = '' } = {}) {
    if (isRO()) return blocked('新建省份');
    const m = bm(key);
    if (!m) return null;
    const provinces = [...provincesOf(key)];
    const idx = provinces.length + 1;
    const province = normalizeProvince({
      id: `prov_grid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: name || `省份 ${idx}`,
      points: [],                 // 空省：还没有几何，等「涂归属」把笔迹并进来
      kind: 'land',
      color: color || '#8b7355',
      biome: '', culture: '', coast: false,
      // ⚠️ 不再写 `fromGrid: true`：空省没有几何，那个标记无意义；一旦带上它，
      //    任何后来写回几何的路径都会被渲染端当成「格点派生」而 Chaikin 平滑（点 ×4 + 改形状）。
    });
    const before = provinces;
    const after = [...provinces, province];
    execute({
      type: 'add-brush-province',
      label: '新建省份',
      undo: () => { setTerrain(key, before); },
      redo: () => { setTerrain(key, after); },
    });
    return { idx, id: province.id, name: province.name };
  }

  /**
   * 删除省份（**重编号安全**）：labels 里所有 > idx 的序号减 1，并把 terrain 数组同步缩短。
   * 🔴 整表快照：重编号改动的是「别的省份的格子」，差量还原不了。
   *
   * ⚠️ 2026-10-02 修掉一条**撤销静默失效**：旧实现的 `apply` 闭包捕获了**当时的** `entry`
   *    （`ensureProvinceGrid` 的返回值），而 `commit()` 读的是 `cache[key]`。删除之后再发生
   *    重建/换底图（`cache[key]` 换成新对象）时，`entry.labels.set(...)` 写进**孤儿对象**，
   *    `commit` 却把当前（未回灌的）标签落盘 → 撤销"看着执行了、数据没变"。
   *    现在一律在 apply **内部**重新取 `cache[key]`（与 `rebuildProvinceGrid` 的写法一致）。
   *    ⚠️ 产品代码**零调用**（删除走 `removeBaseProvince` + `shiftProvinceGridForDelete`），
   *    这条只服务 test_52 与将来的批量删除入口。
   */
  function removeProvinceWithGrid(key, provinceId) {
    if (isRO()) return blocked('删除省份');
    const provinces = provincesOf(key);
    const idx = provinces.findIndex(p => p.id === provinceId);
    if (idx < 0) return null;
    const entry = ensureProvinceGrid(key);
    const before = { terrain: provinces.map(p => ({ ...p })), labels: entry ? new Uint8Array(entry.labels) : null };
    const afterTerrain = provinces.filter((_, i) => i !== idx);
    const afterLabels = entry ? new Uint8Array(entry.labels) : null;
    let cleared = 0;
    if (afterLabels) cleared = renumberAfterDelete(afterLabels, idx + 1).cleared;

    const apply = (terrain, labels) => {
      const cur = cache[key];                            // ← 就地取，不认捕获的那个
      if (cur && labels) cur.labels.set(labels);
      setTerrain(key, terrain, { save: false });         // 内部会 stampShape
      if (cache[key] && labels) commit(key, { save: false });
      scheduleAutoSaveScenarios();
    };
    execute({
      type: 'remove-province-grid',
      label: `删除省份「${provinces[idx].name || provinceId}」`,
      undo: () => apply(before.terrain, before.labels),
      redo: () => apply(afterTerrain, afterLabels),
    });
    return { removed: provinces[idx].name || provinceId, cleared, ownedAfter: afterLabels ? countOwned(afterLabels) : 0 };
  }

  /**
   * 重置省界：把所有省份的**几何**清空（省份条目保留），一条 undo。
   *
   * 🔴 P2 语义变更：旧实现清的是**归属格**（`labels`）。矢量模型下格子已退役，
   *    同一个按钮必须动**几何**才有意义 —— 否则用户点了画面毫无变化（"按了没反应"）。
   *    函数名保留（`provinceLabels` 时代的历史名），只为不打断既有调用点与用例。
   */
  function clearProvinceLabels(key) {
    if (isRO()) return blocked('重置省界');
    const before = provincesOf(key);
    if (!before.length) return { cleared: 0 };
    let n = 0;
    for (const p of before) if (provinceRings(p).length) n++;
    if (!n) return { cleared: 0 };
    const after = before.map((p) => normalizeProvince({
      ...p, points: [], extraRings: undefined, fromGrid: false,
    }));
    // 退役的网格也一并清掉（防止旧客户端/旧代码把它又当成几何来源）——
    // 🔴 必须把 labels 也纳入**同一条 undo**：只清不回滚 = "撤销看着执行了、网格还是空的"。
    const entry = cache[key];
    const labelSnap = entry ? new Uint8Array(entry.labels) : null;
    const zeroSnap = labelSnap ? new Uint8Array(labelSnap.length) : null;
    const apply = (terrain, snap) => {
      setTerrain(key, terrain);
      const cur = cache[key];
      if (cur && snap && cur.labels.length === snap.length) { cur.labels.set(snap); commit(key); }
    };
    execute({
      type: 'clear-province-shapes',
      label: '重置省界',
      undo: () => apply(before, labelSnap),
      redo: () => apply(after, zeroSnap),
    });
    return { cleared: n };
  }

  /** 统计（状态栏/用例用） */
  function provinceGridStats(key) {
    const entry = ensureProvinceGrid(key);
    if (!entry) return null;
    return {
      cols: entry.grid.cols, rows: entry.grid.rows, cell: entry.grid.cell,
      total: gridCellCount(entry.grid), owned: countOwned(entry.labels),
      used: usedIndices(entry.labels), provinces: provincesOf(key).length,
      borders: 0,
    };
  }

  /** 供诊断/用例：某省份的环数（多环 = 飞地 / 洞） */
  function provinceRingStats(key, provinceId) {
    const p = provincesOf(key).find(q => q.id === provinceId);
    if (!p) return null;
    return { rings: provinceRings(p).length, kind: p.kind || 'land' };
  }

  return {
    ensureProvinceGrid, getProvinceGrid, rebuildProvinceGrid, invalidateProvinceGrid,
    beginProvinceStroke, applyProvinceStroke, endProvinceStroke, applyProvinceLasso,
    // 笔刷建省（2026-10-22）：一笔涂抹 → 一块新省（纯几何在 utils/brushProvince.js）
    createProvinceFromBrush,
    /** 供画布预览：当前这一笔已采到的**世界坐标**轨迹（未落库；没有笔迹时返回空数组） */
    getProvinceStrokePath: () => (stroke && stroke.path ? stroke.path : []),
    // E（2026-10-11）：描轮廓 —— 笔迹围住的那块地并进目标省、从邻省挖掉（邻省自动重算）
    resolveOutlineRegion, applyProvinceOutline,
    // C（0.2.6）：折线切割「一次切多块」——按折线在各国内的局部段逐个切（每个省一条 undo）
    splitProvincesAlong,
    // F（2026-10-11）：用新 .map 的海岸线重建现有省份的外环（只裁不加，一条 undo）
    rebuildCoastline, rebuildCoastlineFromBaseMap, buildLandMulti,
    fillProvinceRegion, splitProvince, splitProvinceAlong, mergeProvinces, batchSubdivide,
    // P0-2（2026-10-25）：造陆 —— 轮廓候选（只读）+ 造陆并铺底（一条 undo）
    previewLandmass, generateLandmass,
    // P0-4（2026-10-25）：文化/宗教派生（预览只读；落库一条 undo，逐格 + 省摘要一起写）
    previewCultureDerive, applyCultureDerive,
    // P1（2026-10-13）：顶点编辑 —— 目标省 + 跟随的邻省形状一起改（一次拖动 = 一条 undo）
    updateProvincesBatch,
    previewSplitAlong, planBatchSeeds,
    addBrushProvince, removeProvinceWithGrid, clearProvinceLabels,
    // 删除省级联用（**不 execute**：由删除命令把这一步包进同一条 undo）
    shiftProvinceGridForDelete, restoreProvinceGrid, stampProvinceGrid,
    provinceGridStats, provinceRingStats,
  };
}
