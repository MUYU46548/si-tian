// store/geodataModules/scenarioEditing.js — 剧本地图 store 模块
// ctx: { execute, scheduleAutoSave, saveScenarios }
// 所有 mutation 走 execute（redo 内写入，防双写铁律）


import { ref, toRaw } from 'vue';
// 内存编辑闸门：本模块有 2 个「不走 execute()」的直接写（剧本导入 / .map 图层同步），只读态必须同样拦
import { guardWrite } from '../writeGate';

// ── A1/M1（2026-09-24）：高度图归属访问 ──────────────────────────────────────
// 规则与理由见 utils/heightmapAccess.js 与 docs/A1_DATA_MODEL_DECISION.md。
// ⚠️ 纪律：本模块内**任何**高度图读写都必须经 getHeightmapFor / commitHeightmap ——
//    直接摸 `baseMaps.value[k].heightmap` 在底图绑定行星后会读到/写到一份**没人看的数据**（静默分裂）。
import {
  boundPlanetId, resolveHeightmap, hasGrid,
  planBindBaseMapToPlanet, planUnbindBaseMap, buildGridFromTerrain,
} from '../../utils/heightmapAccess';
import {
  brushFalloff, deriveLayers, SEA_LEVEL,
} from '../../utils/heightMath';
import {
  scheduleDerive, isWorkerAvailable, getAsyncThreshold, getDeriveStats,
} from '../../utils/deriveClient';
// 参考图层映射（provinces/states/cultures/religions → azgaar*）的唯一实现：
// 行星视图的 `.map` 导入也用它，两处各写一份会让同一个 .map 在两处得到不同的 id 口径。
import { buildAzgaarReferenceLayers } from '../../utils/planetMapBundle';
// 新建省份的压叠度量（纯函数，Node 有单测）—— 判定单源，store 只做策略
import { measureProvinceOverlap, describeOverlap } from '../../utils/provinceOverlap';
// ── 月日精度（2026-10-05）：易主日期的规整 / 比较 / 校验 ──────────────────────
// 🔴 `changeYears[pid] = 1993` → `changeEvents[pid] = [{y,m,d,owner}, …]` 的迁移**唯一实现**
//    在 `utils/scenarioDates.js`。本模块只做「何时搬」与「搬到哪」，绝不自己写第二套日期逻辑：
//    自己写一份 `m || 1` 就会出现「入库 1-1、比较按 null」这类只在边界暴露的静默不一致。
import {
  normalizeScenarioDict, normalizeDate, cmpDate, dateKey,
} from '../../utils/scenarioDates';
import { validateChangeDateInRange } from '../../utils/scenarioSlices';
// 账本 v2（2026-10-21）：装载口把 `ownership` 从 `initialOwnership + changeEvents` 派生。
import { normalizeLedgerDict } from '../../utils/scenarioLedgerV2';
// 事件账本（2026-10-22，三刀序列·第一刀）：`scenario.timelineEvents` 的纯函数层。
// 🔴 校验 / 排序 / 关系查询 / 冲突检出**只有一份**（`utils/scenarioEventLedger.js`），
//    本模块只做「走 undo 写进哪个剧本」—— 在这里再写一遍日期窗口比较，就是第二套真值。
import {
  appendEvent, replaceEvent, removeEvent, timelineEventsOf,
  relationBetween, describeRelation, findConflicts,
} from '../../utils/scenarioEventLedger';
// ── 自动河流（2026-10-14 重写）──────────────────────────────────────────────
// 🔴 算法与口径的**单一实现**在 `utils/riverTrace.js`（纯函数 + Node 单测）。
//    本模块只做「取哪份高度图 / 把不算数的情况变成可读回执」——
//    在这里再写一遍追踪逻辑，就是本项目反复踩的"两条实现慢慢不一样且不报错"。
import { traceRivers } from '../../utils/riverTrace';
// 陆地掩膜（省份多边形 → 射线法判定）：画布侧裁导入河、store 侧挡"海边起步"的源头都用它。
// ⚠️ 掩膜按 terrain **引用**缓存 —— 真实底图 415 个环 / 24018 个顶点，每次点按钮重建一次
//    就是白花的几十毫秒；而 terrain 一改就换引用，缓存不会陈旧。
import { buildLandMask } from '../../utils/coastline';
// 🔴 2026-10-17 第八修·改向（暮雨：「司天自身的编辑能力必须过硬，不要指望靠用户导出
//    高度数据地图来救河流生成」）：**按陆地轮廓推演地形** —— 自建底图没有高度图时，
//    自动河流不再直接拒绝，而是用这条推演结果当输入（只读、不写数据）。
import { synthesizeHeightmapFromTerrain } from '../../utils/terrainSynthesis';
// ── 高度图分辨率（2026-10-14）───────────────────────────────────────────────
// 🔴 「地形模模糊糊」的**唯一**解药是把格子变密（每格有自己的高度），而这件事的算法、
//    性能护栏、内存估算全在 `utils/heightmapResample.js`（纯函数 + Node 单测）。
//    本模块只做「走 undo 落盘 + 回执」。**绝不**在这里现写一份插值。
import {
  resampleHeightmap, smoothHeightmapGrid, estimateResampleCost, fmtBytes,
} from '../../utils/heightmapResample';

export function createScenarioEditingModule(ctx) {
  const {
    execute, scheduleAutoSave, saveScenarios, scheduleAutoSaveScenarios, mapData, scheduleAutoSaveMap,
    // 省份网格联动的**延迟注入槽**（geodata.js 在 provinceEditing 造好之后填进来 ——
    // 两个模块的创建顺序是 scenario 先、province 后，不能直接互相 import，否则就是循环依赖）
    provinceGridOps,
  } = ctx;

  const baseMaps = ref({});
  const scenarios = ref({});

  // P2-4：派生计算世代号。异步派生回来时必须确认「这仍是当前这条命令的结果」，
  // 否则会把旧 h 的派生值写到新 h 上（脏写）。
  const deriveEpoch = {};

  // 底图级笔刷的 merge 谓词必须带上 baseMapKey —— 否则在两张底图上交替涂抹会被合并成
  // 同一条命令（merge 无 key 判定），撤销时按"最旧那条的 undo"回滚，把另一张底图的
  // 高度图一起改掉。test_39-e 用交叉涂抹复现过这个坑。

  // ============================================================
  // BaseMaps CRUD（全走 execute，undo 支持）
  // ============================================================
  
  // ══ 高度图归属访问（A1/M1，2026-09-24）══════════════════════════════════════
  // 决策：**以行星的高度图为单一真源，剧本底图按 planetId 绑定"代理"过去**（不复制）。
  // 未绑定 → 用底图自己那份（自建底图 / 旧项目，行为与从前完全一致）。

  /** 取该底图**实际使用**的高度图（绑定行星 → 行星那份；否则 → 底图自己那份）。 */
  function getHeightmapFor(baseMapKey) {
    return resolveHeightmap(baseMaps.value[baseMapKey], mapData.value).heightmap;
  }

  /** 该底图绑定到的行星 id（没绑定 → null）。 */
  function getBoundPlanetId(baseMapKey) {
    return boundPlanetId(baseMaps.value[baseMapKey]);
  }

  /**
   * **哪些底图正绑定到这颗行星**（A1/R4，2026-09-25）。
   *
   * 用途：行星侧在高度图损坏时会用「地形多边形的 `elevation` 估值」**重建**它
   * （`usePlanetHeightBrush.ensureHeightmap`）。绑定之后那份数据是**共享的** ——
   * 重建不是行星自己的私事，它会把共用这份地形的剧本一起改掉。
   * 所以重建的提示必须点名受影响的底图，否则用户只会看到「剧本的地形怎么变了」。
   */
  function getBaseMapsBoundToPlanet(planetId) {
    if (!planetId) return [];
    const out = [];
    for (const [key, bm] of Object.entries(baseMaps.value || {})) {
      if (bm && boundPlanetId(bm) === planetId) out.push({ key, name: bm.name || key });
    }
    return out;
  }

  /**
   * 写入该底图的高度图 —— **绑定了行星就写行星那份**。
   *
   * 🔴 为什么必须有这个函数：底图侧原来的写入模式是「整体替换 baseMap 对象」
   *    （`{ ...baseMap, heightmap: {...} }`），**天然与"共享引用"冲突** —— 一写就把引用换掉了。
   *    绑定之后若还这么写，就会写到一份**无人读取的副本**上（静默分裂：用户以为改了，画布不变）。
   *    所以：绑定后的读与写都必须落在行星那份上，二者必须**同时**走本模块。
   *
   * 注：底图侧（self）不在此处排自动保存 —— 由调用方的 `saveScenarios()` 负责（保持原行为）。
   */
  function commitHeightmap(baseMapKey, nextHeightmap, { touch = true } = {}) {
    const bm = baseMaps.value[baseMapKey];
    if (!bm) return { owner: 'none' };
    const pid = boundPlanetId(bm);
    // `touch=false` 供 undo 使用：撤销回填不打时间戳 —— 与 M1b 之前「undo 闭包里不写 updatedAt」逐字段一致。
    const stamp = touch ? { updatedAt: new Date().toISOString() } : {};
    if (pid) {
      const planet = mapData.value[pid];
      if (planet) {
        mapData.value[pid] = { ...planet, heightmap: nextHeightmap, ...stamp };
        scheduleAutoSaveMap(pid);   // 绑定后落盘归行星侧管
        return { owner: 'planet', planetId: pid, dangling: false };
      }
      // 🔴 **悬空绑定**（行星已被删除 / 改名而未级联）：与 `resolveHeightmap` 的 dangling 口径保持一致 ——
      //    回落到底图自身写入。**绝不静默 return**：那等于把用户刚涂的一笔直接丢掉，且没有任何反馈
      //    （底图侧那份在绑定期被 delete 掉了，所以必须在这里把 newHeightmap 落到底图侧）。
      baseMaps.value = { ...baseMaps.value, [baseMapKey]: { ...bm, heightmap: nextHeightmap, ...stamp } };
      return { owner: 'self', planetId: pid, dangling: true };
    }
    baseMaps.value = { ...baseMaps.value, [baseMapKey]: { ...bm, heightmap: nextHeightmap, ...stamp } };
    return { owner: 'self', planetId: null, dangling: false };
  }

  /**
   * 为底图创建高度图网格 —— **未绑定行星时的"从零开始画"入口**（A1，2026-09-24）。
   *
   * 🔴 为什么必须有这个入口：底图的高度图此前**只有 `.map` 导入一条来源**
   *    （全仓 `ScenarioMap.vue` / 本文件里没有任何创建 heightmap 的代码）。
   *    后果是：用户新建一张底图后，高度笔刷 / 群系 / 文化 / 宗教 / 一键派生**全部**因为
   *    `!hasGrid(hm)` 而直接 return —— 表现为「工具点了没反应」，而且几乎没有反馈。
   *    这也正是「剧情上已毁灭、不打算再建行星的星球」唯一可走的路径：
   *    **不绑定行星，底图自己持有一份高度图**（不是兼容兜底，是一等场景）。
   *
   * 范围：优先按底图已有地形的包围盒外扩；空底图给一个默认方框（之后用笔刷涂即可）。
   */
  function createBaseMapHeightmap(baseMapKey, { spacing, margin } = {}) {
    if (!guardWrite('创建底图高度图').ok) return { ok: false, error: '只读：未打开项目' };
    const bm = baseMaps.value[baseMapKey];
    if (!bm) return { ok: false, error: '底图不存在' };
    if (boundPlanetId(bm)) {
      return { ok: false, error: '该底图已绑定行星 —— 高度图由行星侧提供，请到行星地图里编辑（或先解绑）' };
    }
    if (hasGrid(getHeightmapFor(baseMapKey))) return { ok: false, error: '该底图已有高度图了' };

    const grid = buildGridFromTerrain(bm.terrain || [], spacing || 14.4, margin == null ? 2 : margin);
    const count = grid.points.length;
    const before = bm.heightmap || null;
    const after = {
      grid,
      h: new Float32Array(count),
      temp: new Float32Array(count),
      prec: new Float32Array(count),
      biome: new Uint8Array(count),
    };

    execute({
      type: 'create-basemap-heightmap',
      label: `为底图创建高度图（${grid.cellsX}×${grid.cellsY}）`,
      undo: () => { commitHeightmap(baseMapKey, before); },
      redo: () => { commitHeightmap(baseMapKey, after); },
    });
    saveScenarios();
    return { ok: true, cells: count, cellsX: grid.cellsX, cellsY: grid.cellsY };
  }

  /**
   * 把底图绑定到行星（A1/M1）。含**一次性迁移**；两边都有高度图时**拒绝**并回报冲突
   * （绝不静默选一边丢掉另一边 —— 那可能是用户几小时的手工地形）。
   */
  function bindBaseMapToPlanet(baseMapKey, planetId) {
    if (!guardWrite('绑定底图到行星').ok) return { ok: false, error: '只读：未打开项目' };
    const bm = baseMaps.value[baseMapKey];
    const plan = planBindBaseMapToPlanet(bm, planetId, mapData.value, baseMaps.value);
    if (!plan.ok) return plan;
    const migratePid = plan.migrate ? plan.migrate.planetId : null;
    execute({
      type: 'bind-basemap-planet',
      label: '底图绑定到行星',
      undo: () => {
        if (migratePid && mapData.value[migratePid]) {
          const { heightmap: _dropped, ...rest } = mapData.value[migratePid];
          mapData.value[migratePid] = rest;   // 迁移的那份退回底图侧
        }
        baseMaps.value = { ...baseMaps.value, [baseMapKey]: bm };
      },
      redo: () => {
        if (migratePid && mapData.value[migratePid]) {
          mapData.value[migratePid] = {
            ...mapData.value[migratePid],
            heightmap: plan.migrate.heightmap,
            updatedAt: new Date().toISOString(),
          };
        }
        baseMaps.value = { ...baseMaps.value, [baseMapKey]: plan.nextBaseMap };
      },
    });
    saveScenarios();
    if (migratePid) scheduleAutoSaveMap(migratePid);
    return { ok: true, migrated: !!plan.migrate };
  }

  /** 解绑（行星侧那份保持不动；底图侧从"没有高度图"开始，由 ensure 懒创建） */
  function unbindBaseMap(baseMapKey) {
    if (!guardWrite('解除底图与行星的绑定').ok) return { ok: false, error: '只读：未打开项目' };
    const bm = baseMaps.value[baseMapKey];
    if (!bm) return { ok: false, error: '底图不存在' };
    const plan = planUnbindBaseMap(bm);
    execute({
      type: 'unbind-basemap-planet',
      label: '解除底图与行星的绑定',
      undo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: bm }; },
      redo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: plan.nextBaseMap }; },
    });
    saveScenarios();
    return { ok: true };
  }

  // ══ M1c「导入并冻结」（2026-09-25）══════════════════════════════════════════
  // 🔴 为什么必须有这条路径（而不是让大家都用「跟随行星」）：
  //    「跟随」= 共用同一份数据 → 行星后来怎么改，剧本跟着变。这对**正在与行星同步构建的
  //    当代地图**是对的；但对**历史存档剧本**是灾难 —— 存档要的就是「冻住」。
  //    A1 文档最初否掉「复制」方案，理由是「复制即双源、漂移必然回归」；那条判断在**同步构建**
  //    场景下成立，在**存档**场景下恰恰相反：漂移才是要防的，冻结才是目的。
  //    用户决策（2026-09-25）：**两种模式并存，冻结为默认，跟随需显式选择。**

  /**
   * 深拷贝一份高度图（冻结导入用）。
   *
   * ⚠️ 必须逐数组复制：直接引用会让「副本」与行星那份共享同一个 TypedArray ——
   *    之后在剧本里涂山照样会改到行星（看起来像绑定了，却没有任何绑定的提示）。
   * ⚠️ 不复制 `_spatialIndex`（运行期缓存，与 grid 绑定，用时会按需重建）。
   */
  function cloneHeightmapForFreeze(hm) {
    const n = hm.h ? hm.h.length : 0;
    const out = {
      grid: JSON.parse(JSON.stringify(hm.grid)),
      h: new Float32Array(hm.h || new Float32Array(n)),
      temp: new Float32Array((hm.temp && hm.temp.length === n) ? hm.temp : new Float32Array(n)),
      prec: new Float32Array((hm.prec && hm.prec.length === n) ? hm.prec : new Float32Array(n)),
      biome: new Uint8Array((hm.biome && hm.biome.length === n) ? hm.biome : new Uint8Array(n)),
    };
    if (hm.culture && hm.culture.length === n) out.culture = new Uint8Array(hm.culture);
    if (hm.religion && hm.religion.length === n) out.religion = new Uint8Array(hm.religion);
    return out;
  }

  /** 删除底图自持的 heightmap 字段（冻结导入的 undo 用：原本没有就该回到「没有」，而不是留个 null） */
  function dropHeightmap(baseMapKey) {
    const bm = baseMaps.value[baseMapKey];
    if (!bm) return;
    const next = { ...bm };
    delete next.heightmap;
    baseMaps.value = { ...baseMaps.value, [baseMapKey]: next };
  }

  /** 写/清「这份地形冻结自行星 X」的**标注**（纯展示，不是真相、不是引用 —— 真相只有 planetId） */
  function setFrozenNotice(baseMapKey, frozen) {
    const bm = baseMaps.value[baseMapKey];
    if (!bm) return;
    const next = { ...bm };
    if (frozen) next.terrainFrozenFrom = frozen;
    else delete next.terrainFrozenFrom;
    baseMaps.value = { ...baseMaps.value, [baseMapKey]: next };
  }

  /**
   * 把行星当前的高度图**复制**一份到底图 —— M1c 的「导入并冻结」。
   *
   * @param {string} baseMapKey
   * @param {string} planetId
   * @param {{ force?: boolean, planetName?: string }} [opts]
   *   `force`：底图已有地形时是否确认覆盖（默认 false → 返回 conflict 由 UI 问一次）
   *   `planetName`：仅用于展示标注（UI 侧本来就有行星列表，不必让 store 反查节点）
   */
  function importHeightmapFromPlanet(baseMapKey, planetId, { force = false, planetName = '' } = {}) {
    if (!guardWrite('导入行星地形（冻结）').ok) return { ok: false, error: '只读：未打开项目' };
    const bm = baseMaps.value[baseMapKey];
    if (!bm) return { ok: false, error: '底图不存在' };
    if (!planetId) return { ok: false, error: '没有指定要导入的行星' };
    if (boundPlanetId(bm)) {
      return {
        ok: false,
        error: '该底图正在「跟随」行星 —— 已经是同一份地形了，不需要再导入；'
             + '想改成独立副本，请先「解绑」再导入',
      };
    }
    const planet = mapData.value[planetId];
    if (!planet || !hasGrid(planet.heightmap)) {
      return { ok: false, error: `行星「${planetName || planetId}」还没有地形可导入（先到行星地图里画一张或导入）` };
    }
    if (hasGrid(bm.heightmap) && !force) {
      return {
        ok: false,
        conflict: true,
        conflictKind: 'basemap-has-terrain',
        error: '这张底图已经有自己的地形了 —— 导入会把它**覆盖**成行星的副本（原地形将丢失）。确认覆盖吗？',
      };
    }

    const before = bm.heightmap || null;
    const beforeNotice = bm.terrainFrozenFrom || null;
    const after = cloneHeightmapForFreeze(planet.heightmap);
    const afterNotice = { name: planetName || planetId, at: new Date().toISOString() };

    execute({
      type: 'import-planet-terrain',
      label: '从行星导入地形（冻结）',
      undo: () => {
        if (before) commitHeightmap(baseMapKey, before, { touch: false });
        else dropHeightmap(baseMapKey);
        setFrozenNotice(baseMapKey, beforeNotice);
      },
      redo: () => {
        commitHeightmap(baseMapKey, after);
        setFrozenNotice(baseMapKey, afterNotice);
      },
    });
    saveScenarios();
    return {
      ok: true,
      cells: after.grid.count,
      cellsX: after.grid.cellsX,
      cellsY: after.grid.cellsY,
      frozenFrom: afterNotice.name,
    };
  }

  /** 这份底图的「地形来源」状态（UI 显示用；真相仍是 `planetId` 与 `heightmap`） */
  function describeBaseMapTerrain(baseMapKey) {
    const bm = baseMaps.value[baseMapKey];
    if (!bm) return { mode: 'none' };
    const pid = boundPlanetId(bm);
    if (pid) {
      // 悬空绑定（行星已不存在）要点出来 —— 否则用户只看到「地形空了」，不知道是绑定失效
      const dangling = !mapData.value[pid];
      return { mode: 'following', planetId: pid, dangling };
    }
    if (hasGrid(bm.heightmap)) {
      return { mode: 'frozen', from: bm.terrainFrozenFrom || null };
    }
    return { mode: 'empty' };
  }

  function addBaseMap(baseMapKey, baseMap) {
    const newMap = {
      id: baseMapKey,
      name: baseMap.name || baseMapKey,
      terrain: [],
      referenceImages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...baseMap,
    };
    
    execute({
      type: 'add-basemap',
      label: '新建底图',
      undo: () => {
        const { [baseMapKey]: _, ...rest } = baseMaps.value;
        baseMaps.value = rest;
      },
      redo: () => {
        baseMaps.value = { ...baseMaps.value, [baseMapKey]: newMap };
      },
    });
    
    saveScenarios();
  }

  function removeBaseMap(baseMapKey) {
    const oldMap = baseMaps.value[baseMapKey];
    if (!oldMap) return;
    
    const associatedScenarios = Object.fromEntries(
      Object.entries(scenarios.value).filter(([_, s]) => s.ownerKey === baseMapKey)
    );
    
    execute({
      type: 'remove-basemap',
      label: '删除底图',
      undo: () => {
        baseMaps.value = { ...baseMaps.value, [baseMapKey]: oldMap };
        scenarios.value = { ...scenarios.value, ...associatedScenarios };
      },
      redo: () => {
        const { [baseMapKey]: _, ...rest } = baseMaps.value;
        baseMaps.value = rest;
        scenarios.value = Object.fromEntries(
          Object.entries(scenarios.value).filter(([_, s]) => s.ownerKey !== baseMapKey)
        );
      },
    });
    
    saveScenarios();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 底图数据刷新（B2，2026-10-11）：把 FMG `.map` 里的**底图级数据**补进一张已存在的底图
  //
  // 为什么需要它（真实事故，不是设想）：暮雨的 `desite` 底图是 **2026-09-10** 那次导入建的，
  // 而当时那版解析器**只会读 SVG 里的省份多边形**（`git show d07c1d1`：返回对象只有
  // terrain / polities / ownership / labels / markers）—— 高度图、河流、道路、城镇
  // **根本没有被读出来**（parser 直到 `1c2a4d2` 才具备网格数据能力）。
  // 于是那份底图里 `heightmap` 从来没有存在过：地图是纯色扁平图、"沿山脊精修"无从下手、
  // 河流道路一条都没有 —— 而**今天的解析器完全能读出这些**（实测 desite.map：
  // 9975 格高度、98 种取值、160 条河流、496 条道路）。
  //
  // 所以问题不是"数据丢了"，而是**没有路把新数据补进一张已经在用的底图**：
  // `.map` 导入走的 `applyScenarioState` 是「同 key 整体替换」，会把用户攒下的省份边界、
  // 归属、易主记录一起覆盖掉 —— 那条路绝不能用来"补数据"。
  //
  // 🔴 三条不许违反：
  //   ① **绝不动 `terrain` / `provinceLabels` / `planetId`** —— 已切好的省份（`desite` 现在
  //      415 块）与归属是用户几小时的活，刷新只加不改；这一点是本函数存在的全部理由。
  //   ② **只补缺**：目标底图已有的字段（哪怕是一份旧高度图）不覆盖；要换高度图是另一个
  //      显式动作（`importHeightmapFromPlanet({force:true})` / 重切），不藏在"刷新"里。
  //   ③ **绑定了行星的底图不许写底图侧高度图** —— 高度图的家在行星侧（A1/M1b），
  //      在底图侧再写一份就是"读行星那份 / 写自己那份"的静默分裂。此时**明确拒绝**并指路。
  //
  // @param {string} baseMapKey 目标底图
  // @param {object} bundle      FMG 产物（`buildScenariosJson(json).baseMaps[名字]` 那个对象）
  // @param {{groups?:string[], sourceNote?:string}} [opts] groups 缺省 = 全部可补项
  // @returns {{ok:true,...}|{ok:false,rejected:string,message:string}}
  // ══════════════════════════════════════════════════════════════════════════

  /** 河流归一：画布 `drawRivers` 读的是 `{ points:[{x,y}], width, discharge }` */
  function normalizeBaseMapRivers(list, startAt = 0) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((r, i) => {
      if (!r) return;
      const pts = (r.points || r.nodes || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length < 2) return;
      const rw = Number(r.width);
      out.push({
        id: String(r.id || `river_fmg_${startAt + i}`),
        name: r.name || '',
        points: pts.map((p) => ({ x: p.x, y: p.y })),
        // ⚠️ `undefined` 会让 `drawRivers` 的 `(r.width || 0.2)` 走默认值；写 null 也一样。
        width: Number.isFinite(rw) ? rw : undefined,
        discharge: Number.isFinite(Number(r.discharge)) ? Number(r.discharge) : undefined,
      });
    });
    return out;
  }

  /** 道路归一：`drawRoutes` 读 `{ points:[{x,y}], group, color, width, dash }` */
  function normalizeBaseMapRoutes(list, startAt = 0) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((r, i) => {
      if (!r) return;
      const pts = (r.points || r.nodes || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length < 2) return;
      const w = Number(r.width);
      out.push({
        id: String(r.id || `route_fmg_${startAt + i}`),
        group: r.group || 'roads',
        name: r.name || '',
        points: pts.map((p) => ({ x: p.x, y: p.y })),
        ...(r.color ? { color: r.color } : {}),
        ...(Number.isFinite(w) ? { width: w } : {}),
        ...(Array.isArray(r.dash) ? { dash: r.dash } : {}),
      });
    });
    return out;
  }

  /**
   * 空底图上直接把 FMG 数据装成一张新底图（.map 导入的"该走"，与 refresh 的"补数据"分开）。
   * 只有 `terrain` 来自 bundle —— 那正是"新底图"的省份。
   */
  function buildBaseMapFromBundle(baseMapKey, bundle, name) {
    const now = new Date().toISOString();
    const b = bundle || {};
    return {
      id: baseMapKey,
      name: name || baseMapKey,
      terrain: Array.isArray(b.terrain) ? b.terrain : [],
      landFeatures: Array.isArray(b.landFeatures) ? b.landFeatures : [],
      burgs: Array.isArray(b.burgs) ? b.burgs : [],
      rivers: normalizeBaseMapRivers(b.rivers),
      routes: normalizeBaseMapRoutes(b.routes),
      ...((b.heightmap && (b.heightmap.h || []).length) ? { heightmap: b.heightmap } : {}),
      referenceImages: [],
      ...(b.source ? { source: b.source } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  function updateBaseMapData(baseMapKey, bundle, opts = {}) {
    if (!guardWrite('刷新底图数据').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许写入' };
    const target = baseMaps.value[baseMapKey];
    if (!target) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    if (!bundle || typeof bundle !== 'object') return { ok: false, rejected: 'no-source', message: '没有可刷新的数据源' };

    const has = (k) => target[k] !== undefined && target[k] !== null;
    const src = {
      heightmap: bundle.heightmap || null,
      rivers: normalizeBaseMapRivers(bundle.rivers, 0),
      routes: normalizeBaseMapRoutes(bundle.routes, 0),
      burgs: Array.isArray(bundle.burgs) ? bundle.burgs : [],
      source: bundle.source || null,
      landFeatures: Array.isArray(bundle.landFeatures) ? bundle.landFeatures : [],
    };

    // 底图级"可补项"：只补缺（②）
    const plan = {
      heightmap: !!(src.heightmap && !has('heightmap')),
      rivers: !!(src.rivers.length && !(target.rivers || []).length),
      routes: !!(src.routes.length && !(target.routes || []).length),
      burgs: !!(src.burgs.length && !(target.burgs || []).length),
      landFeatures: !!(src.landFeatures.length && !(target.landFeatures || []).length),
    };
    // 纯信息字段（合并语义，不进"可补组"清单）
    const metaAdd = {};
    if (src.source && !has('source')) metaAdd.source = src.source;
    if (Array.isArray(bundle.referenceImages) && bundle.referenceImages.length && !(target.referenceImages || []).length) {
      // 刻意不搬参考图：那是一张被用户校准过的图，不属于"底图数据"
    }

    const requested = Array.isArray(opts.groups) && opts.groups.length ? opts.groups : Object.keys(plan);
    const blocked = [];
    if (requested.includes('heightmap') && plan.heightmap) {
      const bound = getBoundPlanetId(baseMapKey);
      if (bound) {
        plan.heightmap = false;
        blocked.push({
          group: 'heightmap',
          reason: 'basemap-bound-to-planet',
          message: `这张底图绑定了行星「${bound}」，高度图的家在行星侧 —— 刷新底图数据不会往底图写第二份。`
            + '要地形请用「地形：跟随该行星」或「冻结导入」（工具栏「更多 → 地形」）。',
        });
      }
    }

    const metaAddable = Object.keys(metaAdd);
    const anyPlan = Object.keys(plan).some((k) => plan[k]) || metaAddable.length > 0 || blocked.length > 0;
    if (!anyPlan) {
      return {
        ok: true,
        changed: false,
        baseMapKey,
        added: { heightmap: false, rivers: 0, routes: 0, burgs: 0, landFeatures: 0 },
        skipped: { rivers: src.rivers.length, routes: src.routes.length, burgs: src.burgs.length },
        blocked: [],
        message: '这张底图的底图级数据已经齐了（高度图 / 河流 / 道路 / 城镇都已有），无需刷新',
      };
    }

    const after = { ...target };
    if (plan.heightmap) after.heightmap = src.heightmap;
    if (plan.rivers) after.rivers = src.rivers;
    if (plan.routes) after.routes = src.routes;
    if (plan.burgs) after.burgs = src.burgs;
    if (plan.landFeatures) after.landFeatures = src.landFeatures;
    for (const k of metaAddable) after[k] = metaAdd[k];
    after.updatedAt = new Date().toISOString();

    const added = {
      heightmap: plan.heightmap,
      rivers: plan.rivers ? src.rivers.length : 0,
      routes: plan.routes ? src.routes.length : 0,
      burgs: plan.burgs ? src.burgs.length : 0,
      landFeatures: plan.landFeatures ? src.landFeatures.length : 0,
    };

    execute({
      type: 'refresh-basemap-data',
      label: `刷新底图数据：${baseMapKey}`,
      undo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: target }; },
      redo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: after }; },
    });

    saveScenarios();
    return {
      ok: true,
      changed: true,
      baseMapKey,
      added,
      // 如实交代"源里有、但没补进去"的部分（目标已有 → 刻意不覆盖）
      skipped: {
        rivers: plan.rivers ? 0 : src.rivers.length,
        routes: plan.routes ? 0 : src.routes.length,
        burgs: plan.burgs ? 0 : src.burgs.length,
      },
      kept: {
        terrain: (target.terrain || []).length,
        provinceLabels: !!target.provinceLabels,
        planetId: target.planetId || null,
      },
      blocked,
      message: `已刷新「${baseMapKey}」的底图数据：`
        + [
          added.heightmap ? '高度图' : '',
          added.rivers ? `${added.rivers} 条河流` : '',
          added.routes ? `${added.routes} 条道路` : '',
          added.burgs ? `${added.burgs} 个城镇` : '',
        ].filter(Boolean).join(' / ')
        + `（省份边界 ${(target.terrain || []).length} 块一字未动）`,
    };
  }

  /**
   * 压叠**预检**（只读，不写任何数据）—— 给「顶点编辑」用（2026-10-11）。
   *
   * 为什么放在 store 而不是组件里直接调度量函数：
   *   本仓有一条硬纪律（`test_79` f0 源码守卫会判红）—— **判定必须在 store / 纯函数层单源**，
   *   `ScenarioMap.vue` 里连 `measureProvinceOverlap` 这个函数名都不许出现。组件只负责"问人"。
   * 顶点编辑与新建省份的差别只在**时机**：新建是"先量后建"，顶点是"拖完了、还没落库时量一次"。
   *
   * @param {string} baseMapKey
   * @param {object} province 候选省份（可以是还没落库的 `{...prov, ...patch}`）
   * @param {{ skipId?: string, ratio?: number }} [opts] `skipId` 必须传被编辑省份自己的 id
   *        —— 不排除自己 = 自己压自己 100%，那样每次拖顶点都会被拦。
   * @returns {object|null} 度量结果（`utils/provinceOverlap.measureProvinceOverlap` 的形状）
   */
  function previewProvinceOverlap(baseMapKey, province, opts = {}) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap || !province) return null;
    try {
      return measureProvinceOverlap(province, baseMap.terrain || [], {
        ratio: opts.ratio,
        skipId: opts.skipId,
      });
    } catch (e) {
      return null;                  // 度量失败绝不能挡住用户的编辑（宁可不判也不误拒）
    }
  }

  /**
   * 新建省份。
   *
   * 🔴 **压叠闸门（2026-10-02）**：省份之间没有任何排他约束，画一个压住邻居的新省完全合法，
   *    而画布按 terrain 数组序依次 fill → 数组靠后的盖在上面。后果是三重的：命中口径与
   *    视觉不一致（「点中的是被压在下面的那个」，命中侧另修 `findProvinceAt` 自顶向下）、
   *    归属上色看不出谁是谁、势力标签的面积加权质心被拽到别人的地界里。
   *
   * 判定在纯函数层 `utils/provinceOverlap.js`（Node 可测），这里只做**策略**：
   *   · 默认度量，超过阈值 → 返回 `{success:false, rejected:'overlap', …}` 且**零副作用**
   *     （与点击填充的面积闸门同一协议：`{rejected, message}` + 不动数据）；
   *   · 用户确认后由调用方带 `{ allowOverlap: true }` 重试（UI 负责弹确认）；
   *   · 批量/程序化路径（导入、复制省份、`addBrushProvince`）显式 `{ checkOverlap: false }`。
   *
   * @returns {{success:true,id:string,overlap?:object}|{success:false,rejected:string,message:string}}
   */
  function addBaseProvince(baseMapKey, province, opts = {}) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return { success: false, rejected: 'no-basemap', message: '底图不存在' };

    const newProv = {
      id: province.id || `prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: province.name || 'New Province',
      type: 'polygon',
      points: province.points || province.d || [],
      biome: province.biome || 'temperate',
      culture: province.culture || '未分类',
      coast: province.coast ?? true,
      ...province,
    };

    let overlap = null;
    if (opts.checkOverlap !== false && !opts.allowOverlap) {
      try {
        overlap = measureProvinceOverlap(newProv, baseMap.terrain || [], {
          ratio: opts.overlapShare,
          skipId: newProv.id,
        });
      } catch (e) {
        overlap = null;              // 度量失败绝不能挡住建省（宁可不判也不误拒）
      }
      if (overlap && overlap.blocked) {
        return {
          success: false, rejected: 'overlap', overlap,
          ratio: overlap.ratio, offenders: overlap.offenders,
          message: describeOverlap(overlap),
        };
      }
    }

    execute({
      type: 'add-province',
      label: '绘制省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain.filter(p => p.id !== newProv.id),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: [...baseMaps.value[baseMapKey].terrain, newProv],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    saveScenarios();
    return { success: true, id: newProv.id, overlap: overlap && overlap.total ? overlap : null };
  }

  function updateBaseProvince(baseMapKey, provinceId, updates) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldProv = baseMap.terrain.find(p => p.id === provinceId);
    if (!oldProv) return;
    
    execute({
      type: 'update-province',
      label: '编辑省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain.map(p =>
              p.id === provinceId ? oldProv : p
            ),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain.map(p =>
              p.id === provinceId ? { ...p, ...updates } : p
            ),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function removeBaseProvince(baseMapKey, provinceId) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldProv = baseMap.terrain.find(p => p.id === provinceId);
    if (!oldProv) return;

    // 🔴 级联（2026-10-01，2026-10-05 随月日精度改名）：`scenarios[*].ownership` 的**键就是省份 id**
    //    （不是节点 id —— 见 `idRefDicts()` 的注释），`changeEvents` 同理。删省不摘这两个键 =
    //    留下指向不存在省份的孤儿键：画布上看不见（渲染按 `terrain` 遍历），却仍参与 `groupMap`
    //    分组、`summarizeLineages` 的省列表与谱系继承的重叠度计算 → 观感是「势力继承
    //    关系莫名断裂/粘连」。与 R7「删节点清孤儿数据」同一条纪律：**级联必须同一条 undo**。
    const cascadeBefore = {};
    for (const [scId, sc] of Object.entries(scenarios.value || {})) {
      if (!sc || sc.ownerKey !== baseMapKey) continue;
      const own = sc.ownership || {};
      const ev = sc.changeEvents || {};
      const hasOwner = Object.prototype.hasOwnProperty.call(own, provinceId);
      const hasEV = Object.prototype.hasOwnProperty.call(ev, provinceId);
      if (hasOwner || hasEV) {
        cascadeBefore[scId] = {
          hasOwner, owner: own[provinceId],
          hasEV, events: ev[provinceId] ? JSON.parse(JSON.stringify(ev[provinceId])) : undefined,
        };
      }
    }
    const applyCascade = (mode) => {
      const ids = Object.keys(cascadeBefore);
      if (!ids.length) return;
      const next = { ...scenarios.value };
      for (const scId of ids) {
        const sc = next[scId];
        if (!sc) continue;
        const ownership = { ...(sc.ownership || {}) };
        const changeEvents = { ...(sc.changeEvents || {}) };
        const rec = cascadeBefore[scId];
        if (mode === 'remove') {
          delete ownership[provinceId];
          delete changeEvents[provinceId];
        } else {
          if (rec.hasOwner) ownership[provinceId] = rec.owner;
          if (rec.hasEV) changeEvents[provinceId] = rec.events;
        }
        next[scId] = { ...sc, ownership, changeEvents };
      }
      scenarios.value = next;
    };

    // 删除时的**序号**：撤销要放回原位（不是追加到表尾）。
    //   🔴 为什么必须原位：归属标签网格的序号 = terrain 下标 + 1。网格的重编号/回灌按序号对齐，
    //   把省份挪到表尾会让「回灌的标签」指向别的省份（几何集合虽相同，语义全错）。
    //   顺带也让 `terrain` 顺序在 undo 后与删除前逐项一致。
    const idx = (baseMap.terrain || []).findIndex(p => p.id === provinceId);
    const removeTerrain = (terrain) => ({
      ...baseMaps.value,
      [baseMapKey]: {
        ...baseMaps.value[baseMapKey],
        terrain,
        updatedAt: new Date().toISOString(),
      },
    });
    const insertAt = (terrain, prov, at) => {
      const next = terrain.slice();
      next.splice(at < 0 ? next.length : at, 0, prov);
      return next;
    };
    // 网格：删除后**就地重编号**（省掉整表重新栅格化）；撤销时把整表快照灌回去。
    //   不 execute —— 这一步必须和上面的 terrain/级联同属**一条** undo（test_77 f2）。
    const gridOps = provinceGridOps || {};
    let gridSnapshot = null;

    execute({
      type: 'remove-province',
      label: '删除省份',
      undo: () => {
        const cur = baseMaps.value[baseMapKey];
        if (!cur) return;
        baseMaps.value = removeTerrain(insertAt(cur.terrain || [], oldProv, idx));
        applyCascade('restore');
        if (gridSnapshot && typeof gridOps.restore === 'function') {
          try { gridOps.restore(baseMapKey, gridSnapshot); } catch (e) { /* 网格是派生数据：失败只影响性能，不阻断撤销 */ }
        }
      },
      redo: () => {
        const cur = baseMaps.value[baseMapKey];
        if (!cur) return;
        // ① **先**按旧 terrain 校验并重编号网格（签名此刻仍相符），② 再换 terrain，
        //    ③ 最后盖上与新 terrain 相符的签名 —— 顺序错了就会判成 stale（白作废一次网格）。
        if (typeof gridOps.shiftForDelete === 'function') {
          try {
            const g = gridOps.shiftForDelete(baseMapKey, idx);
            gridSnapshot = (g && g.snapshot) ? g.snapshot : null;
          } catch (e) { gridSnapshot = null; }
        }
        baseMaps.value = removeTerrain((cur.terrain || []).filter(p => p.id !== provinceId));
        applyCascade('remove');
        if (gridSnapshot && typeof gridOps.stamp === 'function') {
          try { gridOps.stamp(baseMapKey); } catch (e) { /* 网格是派生数据：失败只影响性能 */ }
        }
      },
    });

    saveScenarios();
    return {
      success: true,
      cascadedScenarios: Object.keys(cascadeBefore).length,
      gridShifted: !!gridSnapshot,
    };
  }

  function splitBaseProvince(baseMapKey, originalId, poly1, poly2) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const original = baseMap.terrain.find(p => p.id === originalId);
    if (!original) return;
    
    const newProv1 = { ...original, id: poly1.id || `prov_${Date.now()}_a`, name: poly1.name || original.name + ' A', points: poly1.points || poly1.d, area: poly1.area };
    const newProv2 = { ...original, id: poly2.id || `prov_${Date.now()}_b`, name: poly2.name || original.name + ' B', points: poly2.points || poly2.d, area: poly2.area };
    
    execute({
      type: 'split-province',
      label: '拆分省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain
              .filter(p => p.id !== newProv1.id && p.id !== newProv2.id)
              .concat([original]),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain
              .filter(p => p.id !== originalId)
              .concat([newProv1, newProv2]),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function mergeBaseProvinces(baseMapKey, provinceIds, mergedProvince) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldProvinces = baseMap.terrain.filter(p => provinceIds.includes(p.id));
    if (oldProvinces.length === 0) return;
    
    const merged = {
      id: mergedProvince.id || `prov_${Date.now()}`,
      name: mergedProvince.name || 'Merged Province',
      type: 'polygon',
      points: mergedProvince.points || mergedProvince.d || [],
      biome: mergedProvince.biome || 'temperate',
      culture: mergedProvince.culture || '未分类',
      coast: mergedProvince.coast ?? true,
      area: mergedProvince.area || 0,
    };
    
    execute({
      type: 'merge-provinces',
      label: '合并省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain
              .filter(p => p.id !== merged.id)
              .concat(oldProvinces),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain
              .filter(p => !provinceIds.includes(p.id))
              .concat([merged]),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function addBaseReferenceImage(baseMapKey, refImage) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const newRef = {
      id: refImage.id || `ref_${Date.now()}`,
      name: refImage.name || 'Reference',
      dataUrl: refImage.dataUrl || '',
      opacity: refImage.opacity ?? 0.5,
      locked: refImage.locked ?? false,
      offsetX: refImage.offsetX ?? 0,
      offsetY: refImage.offsetY ?? 0,
      scale: refImage.scale ?? 1,
      rotation: refImage.rotation ?? 0,
      flipH: refImage.flipH ?? false,
      width: refImage.width || 0,
      height: refImage.height || 0,
      ppm: refImage.ppm || 0,
      calibrated: refImage.calibrated ?? false,
    };
    
    execute({
      type: 'add-refimage',
      label: '添加参考图',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: baseMaps.value[baseMapKey].referenceImages.filter(r => r.id !== newRef.id),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: [...(baseMaps.value[baseMapKey].referenceImages || []), newRef],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function updateBaseReferenceImage(baseMapKey, refId, updates) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldRef = (baseMap.referenceImages || []).find(r => r.id === refId);
    if (!oldRef) return;
    
    execute({
      type: 'update-refimage',
      label: '编辑参考图',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: baseMaps.value[baseMapKey].referenceImages.map(r =>
              r.id === refId ? oldRef : r
            ),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: baseMaps.value[baseMapKey].referenceImages.map(r =>
              r.id === refId ? { ...r, ...updates } : r
            ),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function removeBaseReferenceImage(baseMapKey, refId) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldRef = (baseMap.referenceImages || []).find(r => r.id === refId);
    if (!oldRef) return;
    
    execute({
      type: 'remove-refimage',
      label: '删除参考图',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: [...(baseMaps.value[baseMapKey].referenceImages || []), oldRef],
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: (baseMaps.value[baseMapKey].referenceImages || []).filter(r => r.id !== refId),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  // ============================================================
  // Scenarios CRUD
  // ============================================================
  
  function createScenario(scenarioId, scenario) {
    const now = new Date().toISOString();
    const newScenario = {
      id: scenarioId,
      ownerKey: scenario.ownerKey,
      name: scenario.name || 'New Scenario',
      era: scenario.era || { roman: '', label: '', startYear: '', endYear: '' },
      order: scenario.order || Object.keys(scenarios.value).length + 1,
      description: scenario.description || '',
      // hook = 卡片墙的钩子文案（1-2 句，ScenarioPicker 卡片上两行截断显示）。
      // 与 description 分工：description 是长注记（编辑器属性区），hook 是给"选剧本"那一屏看的。
      hook: scenario.hook || '',
      sourceNote: scenario.sourceNote || '',
      polities: scenario.polities || [],
      ownership: scenario.ownership || {},
      labels: scenario.labels || [],
      markers: scenario.markers || [],
      createdAt: now,
      updatedAt: now,
      ...scenario,
    };
    
    execute({
      type: 'create-scenario',
      label: '创建剧本',
      undo: () => {
        const { [scenarioId]: _, ...rest } = scenarios.value;
        scenarios.value = rest;
      },
      redo: () => {
        scenarios.value = { ...scenarios.value, [scenarioId]: newScenario };
      },
    });
    
    saveScenarios();
  }

  function updateScenario(scenarioId, updates) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    execute({
      type: 'update-scenario',
      label: '编辑剧本',
      undo: () => {
        scenarios.value = { ...scenarios.value, [scenarioId]: scenario };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenario, ...updates, updatedAt: new Date().toISOString() },
        };
      },
    });
    
    saveScenarios();
  }

  function removeScenario(scenarioId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    execute({
      type: 'remove-scenario',
      label: '删除剧本',
      undo: () => {
        scenarios.value = { ...scenarios.value, [scenarioId]: scenario };
      },
      redo: () => {
        const { [scenarioId]: _, ...rest } = scenarios.value;
        scenarios.value = rest;
      },
    });
    
    saveScenarios();
  }

  function inheritScenario(newScenarioId, baseScenarioId, overrides = {}) {
    const base = scenarios.value[baseScenarioId];
    const now = new Date().toISOString();

    // ⚠️ 刻意**不**继承 `changeEvents`（2026-10-02 定，2026-10-05 随月日精度维持原行为）：
    //    易主日期的语义是「该省在**本剧本年代区间内**哪一天换的主」。继承来的日期一律落在
    //    **上一个**剧本的区间里，对新剧本而言按定义就是越界数据
    //    （`utils/scenarioSlices.js#changeDateStats` 会把它标出来）。
    //    与其造一批越界日期，不如让新剧本走自动推算，由用户在「势力谱系管理 → 易主日期」里录真值。
    const newScenario = {
      id: newScenarioId,
      ownerKey: base?.ownerKey || overrides.ownerKey,
      name: overrides.name || 'New Era',
      era: overrides.era || { roman: '', label: '', startYear: '', endYear: '' },
      order: (base?.order || 0) + 1,
      description: overrides.description || '',
      sourceNote: overrides.sourceNote || '',
      polities: overrides.polities || base?.polities || [],
      ownership: JSON.parse(JSON.stringify(base?.ownership || {})),
      labels: JSON.parse(JSON.stringify(base?.labels || [])),
      markers: JSON.parse(JSON.stringify(base?.markers || [])),
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    
    execute({
      type: 'inherit-scenario',
      label: '继承剧本',
      undo: () => {
        const { [newScenarioId]: _, ...rest } = scenarios.value;
        scenarios.value = rest;
      },
      redo: () => {
        scenarios.value = { ...scenarios.value, [newScenarioId]: newScenario };
      },
    });
    
    saveScenarios();
  }

  // ============================================================
  // Ownership（EU4 省份染色）—— 月日精度（2026-10-05）
  // ============================================================
  //
  // 数据形状（现行）：
  //   `scenario.ownership[pid]`   = 该省在本剧本快照里的归属（= 本剧本**结束**时的状态）
  //   `scenario.changeEvents[pid]`= [{ y, m, d, owner }, …]（**按日期升序**，同省同年可多条）
  // m/d 为 null 语义 = 该年 1 月 1 日。旧键 `changeYears` 由 `normalizeScenarioDates` 迁移。

  /**
   * 该省在本剧本内的易主事件（升序副本）。**没有**时返回空数组（不写空键）。
   * 所有写入口都走它 —— 「读一份、改、写回」三处各写一遍 = 迟早有一处忘排序。
   */
  function eventsOf(scenario, provinceId) {
    const raw = scenario?.changeEvents?.[provinceId];
    return Array.isArray(raw) ? raw.map(e => ({ y: e.y, m: e.m ?? null, d: e.d ?? null, owner: e.owner ?? null })) : [];
  }

  /** 把事件列表塞回剧本（空数组 = 删键，不留空壳） */
  function putEvents(changeEvents, provinceId, list) {
    if (Array.isArray(list) && list.length) changeEvents[provinceId] = list;
    else delete changeEvents[provinceId];
  }

  /** 在某省的易主列表里按**日期**定位（月日精度：同日即同一条） */
  function findEventIndex(list, date) {
    const k = dateKey(date);
    return list.findIndex(e => dateKey(e) === k);
  }

  /** 当前剧本的年代区间（数字）；缺失/非法时返回 null（调用方据此跳过校验，宁可少判不误拒） */
  function eraRangeOf(scenario) {
    const a = Number(scenario?.era?.startYear);
    const b = Number(scenario?.era?.endYear);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { start: a, end: b };
  }

  /** 日期合法性（校验实现单源在 scenarioSlices；区间取自剧本自身） */
  function checkDateInEra(scenario, date) {
    const r = eraRangeOf(scenario);
    if (!r) return { ok: true };                       // 区间缺失 → 不拦（宁可不判也不误拒）
    return validateChangeDateInRange(date, r.start, r.end);
  }

  /**
   * 指派势力。可选 `changeDate`（`{y,m,d}` 或裸年份）：把「易主日期」一并记为显式值 ——
   * 这是日期最自然的录入路径：把游标拖到某日再上色 = 该日易主。
   *
   * 语义（月日精度后明确下来）：
   *   · 该日**已有**事件 → 只更新它的 owner（同一时刻不会有两个主人）；
   *   · 没有 → 追加一条（同省同年多次易主因此天然成立）。
   */
  function setOwnership(scenarioId, provinceId, polityId, changeDate) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { success: false, reason: 'no-scenario' };

    // 🔴 越界日期**写不进库**（与面板内联提示同一份判定）：用户拖到剧本区间外再上色
    //    会造出一条必然 outOfRange 的显式事件 —— 切片对话框会把它当「数据该修」列出来。
    //    宁可这次不记日期（并回报原因），也不要写一条自己都知道是错的数据。
    const date = normalizeDate(changeDate);
    if (changeDate !== undefined && changeDate !== null && changeDate !== '' && !date) {
      return { success: false, reason: '日期无法识别（需要年份）' };
    }
    if (date) {
      const chk = checkDateInEra(scenario, date);
      if (!chk.ok) return { success: false, reason: chk.reason };
    }

    const oldOwner = scenario.ownership?.[provinceId] || null;
    const oldEvents = eventsOf(scenario, provinceId);

    execute({
      type: 'set-ownership',
      label: date ? '指派势力（含易主日期）' : '指派势力',
      undo: () => {
        const sc = scenarios.value[scenarioId];
        const changeEvents = { ...(sc.changeEvents || {}) };
        if (oldEvents.length) changeEvents[provinceId] = oldEvents;
        else delete changeEvents[provinceId];
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: oldOwner },
            changeEvents,
          },
        };
      },
      redo: () => {
        const sc = scenarios.value[scenarioId];
        const changeEvents = { ...(sc.changeEvents || {}) };
        if (date) {
          const list = eventsOf(sc, provinceId);
          const at = findEventIndex(list, date);
          const rec = { y: date.y, m: date.m, d: date.d, owner: polityId ?? null };
          if (at >= 0) list[at] = rec; else list.push(rec);
          list.sort(cmpDate);
          putEvents(changeEvents, provinceId, list);
        }
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: polityId },
            changeEvents,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    // 2026-10-20：与 batchSetOwnership 同口径 —— 油漆桶单击不再同步导出整份画布载荷
    scheduleAutoSaveScenarios();
    return { success: true };
  }

  function clearOwnership(scenarioId, provinceId, changeDate) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldOwner = scenario.ownership?.[provinceId];
    if (!oldOwner) return;

    const oldEvents = eventsOf(scenario, provinceId);
    const date = normalizeDate(changeDate);
    const writeDate = !!date;

    execute({
      type: 'clear-ownership',
      label: '清除归属',
      undo: () => {
        const sc = scenarios.value[scenarioId];
        const changeEvents = { ...(sc.changeEvents || {}) };
        if (oldEvents.length) changeEvents[provinceId] = oldEvents;
        else delete changeEvents[provinceId];
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: oldOwner },
            changeEvents,
          },
        };
      },
      redo: () => {
        const sc = scenarios.value[scenarioId];
        const { [provinceId]: _, ...rest } = sc.ownership;
        const changeEvents = { ...(sc.changeEvents || {}) };
        if (writeDate) {
          // 清归属仍要记「何时易主（到无主）」—— 时间轴上「这一年这块地没人了」是真事件
          const list = eventsOf(sc, provinceId);
          const at = findEventIndex(list, date);
          const rec = { y: date.y, m: date.m, d: date.d, owner: null };
          if (at >= 0) list[at] = rec; else list.push(rec);
          list.sort(cmpDate);
          changeEvents[provinceId] = list;
        }
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: rest,
            changeEvents,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    // 2026-10-20：同 batchSetOwnership —— 清归属也不再同步导出整份画布载荷
    scheduleAutoSaveScenarios();
  }

  /**
   * 批量指派 / 批量清归属（**一条 undo**）—— 省份多选的落库口（2026-10-02 接活）。
   *
   * 此前这里是**零调用的死入口**，且有三处语义不完整（都已补齐，逐条都有回归断言）：
   *   ① `polityId` 为假值时旧实现写 `ownership[id] = null` —— **留键**。而 `clearOwnership` 是
   *      `delete` 真删键，`groupMap` / 谱系重叠度判的是「键在不在」，于是"清空"会留下
   *      一堆指向 `null` 的孤儿键（画布看不出、谱系统计却算进去）。现在统一成**真删键**，
   *      并连带清该省的 `changeEvents`（与 `clearOwnership` 同口径）。
   *   ② **海域必须跳过**：单省油漆桶在 UI 侧拒 sea（海不参与势力归属、不进时间轴/谱系），
   *      批量若照写就会出现「有些海莫名其妙有了归属」。跳过并回报数量。
   *   ③ 空 / 无改动时**不压栈**（旧实现照样 execute + save = 无操作噪音）。
   * 另加**回执**（`changed` / `cleared` / `skippedSea` / `skippedMissing`）供 UI 点名。
   *
   * @param {string} scenarioId
   * @param {string[]} provinceIds 省份 id 列表（自动去重；不存在的 id 计入 skippedMissing）
   * @param {string|null} polityId 假值 = 清归属（删键）
   * @param {object|number} [changeDate] `{y,m,d}`（或裸年份）才写显式易主日期
   * @returns {{success:boolean, changed?:number, cleared?:number, skippedSea?:number,
   *            skippedMissing?:number, noop?:boolean, affected?:number, reason?:string}}
   */
  function batchSetOwnership(scenarioId, provinceIds, polityId, changeDate) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { success: false, reason: 'no-scenario' };

    // 省份表：用来判「存在」与「是不是海域」（ownerKey → baseMaps[key].terrain）
    const terrain = baseMaps.value?.[scenario.ownerKey]?.terrain || [];
    const byId = new Map(terrain.map(p => [p.id, p]));

    const beforeOwnership = { ...(scenario.ownership || {}) };
    // 🔴 2026-10-20：**不再整表深拷 `changeEvents`**。真实 415 省项目里这个对象
    //    序列化后是 MB 级，JSON.parse(JSON.stringify(...)) 一次要 100ms+ ——
    //    用户按一下油漆桶/涂一笔就卡一下，卡的就是这一行。
    //    只做浅拷贝 + 对**被碰到的省**单独克隆事件数组（下面 list.map 已经是新对象），
    //    未碰到的省在 undo/redo 之间共享同一份引用是安全的（谁都不会原地改它）。
    const beforeChangeEvents = { ...(scenario.changeEvents || {}) };
    const nextOwnership = { ...beforeOwnership };
    const nextChangeEvents = { ...beforeChangeEvents };

    const clearing = !polityId;
    const date = normalizeDate(changeDate);
    const writeDate = !!date;
    const seen = new Set();
    let changed = 0;
    let cleared = 0;
    let skippedSea = 0;
    let skippedMissing = 0;

    for (const rawId of (provinceIds || [])) {
      if (!rawId || seen.has(rawId)) continue;
      seen.add(rawId);
      const prov = byId.get(rawId);
      if (!prov) { skippedMissing++; continue; }
      if (prov.kind === 'sea') { skippedSea++; continue; }
      const had = Object.prototype.hasOwnProperty.call(beforeOwnership, rawId);
      if (clearing) {
        if (!had) continue;                       // 本来就没归属 → 不算改动
        delete nextOwnership[rawId];
        delete nextChangeEvents[rawId];
        cleared++;
      } else {
        const list = Array.isArray(nextChangeEvents[rawId])
          ? nextChangeEvents[rawId].map(e => ({ ...e })) : [];
        const at = writeDate ? findEventIndex(list, date) : -1;
        const alreadySame = beforeOwnership[rawId] === polityId
          && (!writeDate || (at >= 0 && list[at].owner === polityId));
        if (alreadySame) continue;                // 值没变 → 不算改动
        nextOwnership[rawId] = polityId;
        if (writeDate) {
          // 同日在 → 改 owner；不在 → 追加（同省同年多次易主）
          const rec = { y: date.y, m: date.m, d: date.d, owner: polityId ?? null };
          if (at >= 0) list[at] = rec; else list.push(rec);
          list.sort(cmpDate);
          putEvents(nextChangeEvents, rawId, list);
        }
        changed++;
      }
    }

    if (!changed && !cleared) {
      return {
        success: true, changed: 0, cleared: 0, skippedSea, skippedMissing,
        noop: true, affected: 0,
      };
    }

    const apply = (ownership, changeEvents, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const next = { ...cur, ownership, changeEvents };
      if (touch) next.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: next };
    };

    execute({
      type: 'batch-ownership',
      label: clearing ? `批量清除归属（${cleared} 省）` : `批量指派（${changed} 省）`,
      undo: () => apply(beforeOwnership, beforeChangeEvents, false),
      redo: () => apply(nextOwnership, nextChangeEvents, true),
    });

    // 2026-10-20：走 300ms 合并的自动保存（与其它写口同一条路），而不是同步 saveScenarios()。
    // 项目态下 saveScenarios → syncCanvasToProject 要导出并合并整份画布载荷，
    // 415 省实测 **一次 100ms+** —— 每点一下油漆桶就卡一下，卡的就是这一下。
    // 退出/显式保存仍走 flushSave（它会先把 scenarioSaveTimer 落掉），不丢改动。
    scheduleAutoSaveScenarios();
    return {
      success: true, changed, cleared, skippedSea, skippedMissing,
      affected: changed + cleared, polityId: polityId || null,
      date: date ? { y: date.y, m: date.m, d: date.d } : null,
    };
  }

  // ============================================================
  // 势力谱系（P2：时间轴的人工纠正入口）
  // ============================================================

  /**
   * 设置势力的谱系信息（走 undo）。
   * successorOf: 承自某**前代势力**的 polity id（语义最自然，推荐）
   * lineage:     显式谱系标签（同名即同谱系）
   * 传空字符串 / null 表示清除该项。
   */
  function setPolityLineage(scenarioId, polityId, { successorOf, lineage } = {}) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    const idx = (scenario.polities || []).findIndex(p => p.id === polityId);
    if (idx < 0) return;

    const oldPolities = JSON.parse(JSON.stringify(scenario.polities));
    const next = scenario.polities.map(p => {
      if (p.id !== polityId) return p;
      const np = { ...p };
      if (successorOf !== undefined) {
        if (successorOf) np.successorOf = successorOf; else delete np.successorOf;
      }
      if (lineage !== undefined) {
        if (lineage) np.lineage = lineage; else delete np.lineage;
      }
      return np;
    });

    execute({
      type: 'set-polity-lineage',
      label: '设置势力谱系',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenarios.value[scenarioId], polities: oldPolities },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenarios.value[scenarioId], polities: next, updatedAt: new Date().toISOString() },
        };
      },
    });

    saveScenarios();
  }

  /**
   * 修改势力的显示信息（`name` / `abbr` / `color`），走 undo。
   *
   * A8（2026-09-26 暮雨定案）：「自定义显示的势力名称」的**唯一写入口**。
   * `abbr` = 可选简称 —— 缩小到只画势力名时优先用它；没填回落全名。
   * **绝不自动截断**：机器截断会造出「大明帝国 → 大明」这类看着合理、实则臆造的名字。
   *
   * ⚠️ 走 `execute()` 而非裸写 —— `execute` 就是内存写的总闸门（只读态拒绝在这里生效）。
   *    所以本函数**不需要**补 `guardWrite`、也**不该**登记进 `MEMORY_WRITE_CALLSITES`
   *    （该表只收「自己改内存」与「先改内存后 execute」两类，见 `writeGate.js` 注释）。
   * ⚠️ 撤销必须**显式回填旧值**（照采集期记录的对象整体写回），不做反向推断 —— 与
   *    `changeNodeId` 同一条纪律：改名的补丁不可逆，推断必然漏。
   */
  function updatePolity(scenarioId, polityId, patch = {}) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { success: false, reason: 'no-scenario' };
    const list = scenario.polities || [];
    const idx = list.findIndex(p => p.id === polityId);
    if (idx < 0) return { success: false, reason: 'no-polity' };

    const before = { ...list[idx] };
    const next = { ...before };
    for (const k of ['name', 'abbr', 'color']) {
      if (patch[k] === undefined) continue;
      const raw = patch[k];
      const v = typeof raw === 'string' ? raw.trim() : raw;
      // name 是必填：清空视为「没输入」，保留原名（不留无名势力 → 标签整条消失且无法解释）
      if (k === 'name' && (v === '' || v === null)) continue;
      if (v === '' || v === null) { delete next[k]; continue; }
      next[k] = v;
    }

    const changed = ['name', 'abbr', 'color'].some((k) => before[k] !== next[k]);
    if (!changed) return { success: true, changed: false };

    const apply = (target, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const arr = (cur.polities || []).slice();
      const at = arr.findIndex(p => p.id === polityId);
      if (at < 0) return;
      arr[at] = target;
      const nextSc = { ...cur, polities: arr };
      if (touch) nextSc.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
    };

    execute({
      type: 'update-polity',
      label: '修改势力名称',
      undo: () => apply(before, false),   // touch=false：撤销不打 updatedAt（与改动前逐字段一致）
      redo: () => apply(next, true),
    });

    saveScenarios();
    return { success: true, changed: true };
  }

  // ── 势力的增删（2026-10-01）──────────────────────────────────────────────
  // 此前这条链只有 `updatePolity`（改名/简称）一个写入口，`polities` **只能由 Azgaar .map
  // 导入带进来**（`azgaar-parser.js` 的 states → polities，id = FMG 的 state 序号）。
  // 后果：自建底图 + 自建剧本 = `polities: []` → 势力色板空空、油漆桶点了什么都不发生
  // （旧实现里那个分支没有 else，属于**静默无反应**）。删除同样没有 → 错导入的 FMG
  // 国名永久留在地图与谱系里，唯一的"取消"手段是逐省用别的势力盖掉。
  //
  // 纪律（与本文件其余写入口一致）：走 `execute()`（= 内存写总闸门，只读态自动拒绝），
  // **撤销显式回填旧值**、不做反向推断；删势力必须**连带清反向索引**（见 `removePolity`）。
  let politySeq = 0;
  /** polity id 只需**本剧本内**唯一（跨剧本 id 本来就不通用，见 scenarioTimeline 头部注释） */
  function makePolityId() {
    politySeq += 1;
    return `pol_${Date.now().toString(36)}_${politySeq}`;
  }
  /** 新建势力的默认配色（FMG 导入的势力自带 color，自建时按序轮转，避免撞色成一片） */
  const POLITY_PALETTE = ['#c94f4f', '#4f7fc9', '#4fa96b', '#c9a24f', '#8a5fc9', '#4fb3c9', '#c95f9e', '#7f8c8d'];

  function addPolity(scenarioId, { name = '', color = '', abbr = '' } = {}) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { success: false, reason: 'no-scenario' };
    const list = scenario.polities || [];
    const id = makePolityId();
    const finalName = String(name || '').trim() || `势力 ${list.length + 1}`;
    const finalColor = color || POLITY_PALETTE[list.length % POLITY_PALETTE.length];
    const polity = { id, name: finalName, color: finalColor };
    if (String(abbr || '').trim()) polity.abbr = String(abbr).trim();

    const before = JSON.parse(JSON.stringify(list));
    const next = [...list, polity];

    const apply = (arr, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const nextSc = { ...cur, polities: arr };
      if (touch) nextSc.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
    };

    execute({
      type: 'add-polity',
      label: `新建势力：${finalName}`,
      undo: () => apply(before, false),
      redo: () => apply(next, true),
    });

    saveScenarios();
    return { success: true, id, name: finalName, color: finalColor };
  }

  /**
   * 删除势力（走 undo）。
   *
   * 🔴 **必须连带清反向索引**：`ownership` 的值就是 polityId（键是省份 id），
   *    `changeEvents` 同理按省份 id 记显式易主日期。只把 polity 从数组里摘掉，
   *    那些省的归属会指向一个不存在的势力 —— 画布上回落 `#4a5568` 灰、
   *    标签因 `labelTextFor(null) === ''` 被**静默跳过**（一片没名字的灰块），
   *    而时间轴 / 谱系照样给它留槽位。与 R7「删节点清孤儿数据」同一条纪律。
   *
   * 返回 `affected`（受影响的省数）供 UI 二次确认时点名。
   */
  function removePolity(scenarioId, polityId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { success: false, reason: 'no-scenario' };
    const list = scenario.polities || [];
    const target = list.find(p => p.id === polityId);
    if (!target) return { success: false, reason: 'no-polity' };

    const beforePolities = JSON.parse(JSON.stringify(list));
    const beforeOwnership = JSON.parse(JSON.stringify(scenario.ownership || {}));
    const beforeChangeEvents = JSON.parse(JSON.stringify(scenario.changeEvents || {}));
    const nextPolities = list.filter(p => p.id !== polityId);

    const affected = Object.entries(beforeOwnership)
      .filter(([, pid]) => pid === polityId)
      .map(([provId]) => provId);
    const nextOwnership = { ...beforeOwnership };
    const nextChangeEvents = JSON.parse(JSON.stringify(beforeChangeEvents));
    for (const provId of affected) {
      delete nextOwnership[provId];
      delete nextChangeEvents[provId];
    }

    // 事件账本级联（2026-10-22）：势力的战争/同盟事件里若出现被删势力，那条事件就**不成立**了
    // （参与方缺一个，`EVENT_TYPES` 的 minActors 校验会红）。与 ownership/changeEvents 同一条纪律：
    // 删势力 = 把它在剧本里的所有痕迹一起清掉，**一条 undo 全部还原**，并把条数回报给 UI。
    const beforeTimelineEvents = timelineEventsOf(scenario).slice();
    const nextTimelineEvents = beforeTimelineEvents.filter((ev) => {
      const actors = ev && Array.isArray(ev.actors) ? ev.actors : [];
      return !actors.some((a) => String(a) === String(polityId));
    });
    const affectedEvents = beforeTimelineEvents.length - nextTimelineEvents.length;

    const apply = (polities, ownership, changeEvents, timelineEvents, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const nextSc = { ...cur, polities, ownership, changeEvents, timelineEvents };
      if (touch) nextSc.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
    };

    execute({
      type: 'remove-polity',
      label: `删除势力：${target.name || polityId}`,
      undo: () => apply(beforePolities, beforeOwnership, beforeChangeEvents, beforeTimelineEvents, false),
      redo: () => apply(nextPolities, nextOwnership, nextChangeEvents, nextTimelineEvents, true),
    });

    saveScenarios();
    return {
      success: true,
      affected: affected.length,
      affectedProvinceIds: affected,
      affectedEvents,
      name: target.name || polityId,
    };
  }

  /**
   * 显式设置 / 清除某省的易主**日期列表**（走 undo）—— 易主日期面板的单省入口。
   *
   * @param {Array|null} list 完整的事件列表（`[{y,m,d,owner}]`）；null/空数组 = **删除显式值**
   *                          （该省回到「按谱系变化推算」的合成日期）
   * 为什么整列表替换而不是「逐条增删」：面板上用户可能一次改日期 + 改归属，
   * 拆成多条命令会让「一条 undo 撤回这次编辑」失效。列表本身是个位数，整表快照不心疼。
   */
  function setChangeEvents(scenarioId, provinceId, list) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { success: false, reason: 'no-scenario' };

    const before = JSON.parse(JSON.stringify(scenario.changeEvents || {}));
    const next = JSON.parse(JSON.stringify(before));
    const old = eventsOf(scenario, provinceId);

    const cleaned = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      if (raw === null || raw === undefined) continue;
      const n = normalizeDate(raw);
      if (!n) return { success: false, reason: '日期无法识别（需要年份）' };
      const chk = checkDateInEra(scenario, n);
      if (!chk.ok) return { success: false, reason: chk.reason };
      const owner = (raw && raw.owner !== undefined && raw.owner !== null) ? String(raw.owner) : null;
      const at = findEventIndex(cleaned, n);
      const rec = { y: n.y, m: n.m, d: n.d, owner };
      if (at >= 0) cleaned[at] = rec; else cleaned.push(rec);
    }
    cleaned.sort(cmpDate);
    putEvents(next, provinceId, cleaned);

    const same = JSON.stringify(old) === JSON.stringify(cleaned);
    if (same) return { success: true, changed: 0, removed: 0, noop: true };

    const apply = (changeEvents, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const nextSc = { ...cur, changeEvents };
      if (touch) nextSc.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
    };

    execute({
      type: 'set-change-events',
      label: cleaned.length ? `设置易主日期（${cleaned.length} 条）` : '清除易主日期（回到自动推算）',
      undo: () => apply(before, false),
      redo: () => apply(next, true),
    });

    saveScenarios();
    return { success: true, changed: cleaned.length, removed: old.length };
  }

  /**
   * 批量写 / 清易主日期（**一条 undo**）—— 日期录入的批量入口。
   *
   * 为什么必须有批量口：`computeEraChanges` 在缺显式值时会在区间内**均匀铺开**一个合成日期。
   * 一个一个改（`setChangeEvents`）会出现：① N 个省 = N 条 undo（`MAX_HISTORY=100`
   * 会把更早的几何操作静默挤出栈）；② 「把这一代都定在某日」这类操作要写 N 遍。
   *
   * @param {string} scenarioId
   * @param {Record<string, object|number|Array|null>} patch 省 id → 日期（`{y,m,d}` / 裸年份 /
   *        事件数组）；null = **删除**显式值（回到自动推算）
   * @returns {{success:boolean, changed?:number, cleared?:number, noop?:boolean, reason?:string}}
   */
  function setChangeEventsBulk(scenarioId, patch) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { success: false, reason: 'no-scenario' };

    const before = JSON.parse(JSON.stringify(scenario.changeEvents || {}));
    const next = JSON.parse(JSON.stringify(before));
    let changed = 0;
    let cleared = 0;
    const rejected = [];
    for (const [pid, raw] of Object.entries(patch || {})) {
      const had = Object.prototype.hasOwnProperty.call(before, pid);
      if (raw === null || raw === undefined) {
        if (!had) continue;                   // 本来就没有显式值 → 没什么可清
        delete next[pid];
        cleared++;
        continue;
      }
      // 允许 {y,m,d} / 裸年份 / 数组（数组 = 整列表替换，支持同省多条）
      const list = Array.isArray(raw) ? raw : [raw];
      const cleaned = [];
      let bad = '';
      for (const item of list) {
        const n = normalizeDate(item);
        if (!n) { bad = '日期无法识别（需要年份）'; break; }
        const chk = checkDateInEra(scenario, n);
        if (!chk.ok) { bad = chk.reason; break; }
        const owner = (item && item.owner !== undefined && item.owner !== null) ? String(item.owner) : null;
        const at = findEventIndex(cleaned, n);
        const rec = { y: n.y, m: n.m, d: n.d, owner };
        if (at >= 0) cleaned[at] = rec; else cleaned.push(rec);
      }
      if (bad) { rejected.push({ provinceId: pid, reason: bad }); continue; }
      cleaned.sort(cmpDate);
      if (JSON.stringify(before[pid] || null) === JSON.stringify(cleaned.length ? cleaned : null)) continue;
      putEvents(next, pid, cleaned);
      changed++;
    }
    if (!changed && !cleared) {
      return { success: true, changed: 0, cleared: 0, noop: true, rejected };
    }

    // 整表快照式 undo（与 removePolity 同形）：改的是「别的键」，差量还原不了
    const apply = (changeEvents, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const nextSc = { ...cur, changeEvents };
      if (touch) nextSc.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
    };

    execute({
      type: 'set-change-events-bulk',
      label: `批量设置易主日期（改 ${changed} / 清 ${cleared} 省）`,
      undo: () => apply(before, false),
      redo: () => apply(next, true),
    });

    saveScenarios();
    return { success: true, changed, cleared, rejected };
  }

  // ============================================================
  // 事件账本（timelineEvents）—— 谁和谁 / 什么事 / 起止（2026-10-22）
  // ============================================================
  //
  // 为什么是**第二张表**而不是塞进 changeEvents：
  //   `changeEvents[provinceId]` 是「这块地归谁」（每省一本小账）；外交/战争/同盟的主体是
  //   **势力对**，语义与键都不同。混在一起，归属回放要把非归属事件全过滤一遍，
  //   两边的校验也会互相误伤。两本账各管一件事，查询时按需合读，绝不双写。
  //
  // 纪律（与本文件其它写口一致）：
  //   · 全部走 `execute()` —— 只读态拒绝、Ctrl+Z 可回滚、落盘由 `saveScenarios()` 调度；
  //   · 因此**不需要** `guardWrite`，也**不登记** `MEMORY_WRITE_CALLSITES`（execute 是内存写总闸门）。
  //   · 校验/排序/关系计算全在 `utils/scenarioEventLedger.js`（唯一实现），这里只搬数据。

  /** 把一张新的事件表写回剧本（供 undo/redo 共用；`touch=false` 时不动 updatedAt） */
  function applyTimelineEvents(scenarioId, events, touch = true) {
    const cur = scenarios.value[scenarioId];
    if (!cur) return;
    const nextSc = { ...cur, timelineEvents: events };
    if (touch) nextSc.updatedAt = new Date().toISOString();
    scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
  }

  /** 本剧本的势力名解析（默认标题 / 查询文案用；找不到就原样显示 id，不编名字） */
  function polityNameOf(scenario, id) {
    const hit = (scenario.polities || []).find((p) => String(p.id) === String(id));
    return (hit && hit.name) || String(id);
  }

  /**
   * 录入一条历史事件（**一条 undo**）。
   *
   * @param {string} scenarioId
   * @param {object} draft `{ type, actors, from, to, title, note, data }`
   *        `from`/`to` 可以是 `{y,m,d}`、裸年份、或 `'1348-06-01'` 文本
   * @returns {{ok:boolean, event?:object, events?:Array, errors?:string[], warnings?:string[]}}
   *   校验不过 = `ok:false` + 逐条中文原因（**不静默丢弃**，也不写半条）
   */
  function addTimelineEvent(scenarioId, draft) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { ok: false, errors: ['剧本不存在'], warnings: [] };
    // `.slice()`：undo 存的是**当时那份快照**，不能存活数组的引用（以后谁改成就地 push 就回滚错）
    const before = timelineEventsOf(scenario).slice();
    const r = appendEvent(scenario, draft, {
      polities: scenario.polities || [],
      era: scenario.era || {},
      nameOf: (id) => polityNameOf(scenario, id),
    });
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings || [] };

    execute({
      type: 'add-timeline-event',
      label: `录入事件：${r.event.title}`,
      undo: () => applyTimelineEvents(scenarioId, before, false),
      redo: () => applyTimelineEvents(scenarioId, r.events, true),
    });

    saveScenarios();
    return { ok: true, event: r.event, events: r.events, warnings: r.warnings || [] };
  }

  /**
   * 修改一条事件（按 id；返回新数组，**一条 undo**）。
   * 找不到 id = `ok:false, reason:'missing'`（绝不静默新建一条）。
   */
  function updateTimelineEvent(scenarioId, eventId, patch = {}) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { ok: false, reason: 'no-scenario', errors: ['剧本不存在'] };
    // `.slice()`：undo 存的是**当时那份快照**，不能存活数组的引用（以后谁改成就地 push 就回滚错）
    const before = timelineEventsOf(scenario).slice();
    const r = replaceEvent(scenario, eventId, patch, {
      polities: scenario.polities || [],
      era: scenario.era || {},
      nameOf: (id) => polityNameOf(scenario, id),
    });
    if (!r.ok) {
      return { ok: false, reason: r.reason || 'invalid', errors: r.errors || [], warnings: r.warnings || [] };
    }

    execute({
      type: 'update-timeline-event',
      label: `修改事件：${r.event.title}`,
      undo: () => applyTimelineEvents(scenarioId, before, false),
      redo: () => applyTimelineEvents(scenarioId, r.events, true),
    });

    saveScenarios();
    return { ok: true, event: r.event, events: r.events, warnings: r.warnings || [] };
  }

  /** 删除一条事件（按 id；**一条 undo**） */
  function removeTimelineEvent(scenarioId, eventId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { ok: false, reason: 'no-scenario' };
    // `.slice()`：undo 存的是**当时那份快照**，不能存活数组的引用（以后谁改成就地 push 就回滚错）
    const before = timelineEventsOf(scenario).slice();
    const r = removeEvent(scenario, eventId);
    if (!r.ok) return { ok: false, reason: 'missing' };

    execute({
      type: 'remove-timeline-event',
      label: '删除事件',
      undo: () => applyTimelineEvents(scenarioId, before, false),
      redo: () => applyTimelineEvents(scenarioId, r.events, true),
    });

    saveScenarios();
    return { ok: true, events: r.events, removed: before.length - r.events.length };
  }

  /**
   * 整表替换（导入剧本包 / 批量录入用）。**全有或全无**：
   * 任何一条不合规就整体拒绝并逐条点名 —— 半批写进去比不写更难查。
   * 传入的 id 保留（导入要能对齐外部引用）；没 id 的按现有表递增分配。
   */
  function setTimelineEvents(scenarioId, drafts) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { ok: false, reason: 'no-scenario' };
    // `.slice()`：undo 存的是**当时那份快照**，不能存活数组的引用（以后谁改成就地 push 就回滚错）
    const before = timelineEventsOf(scenario).slice();
    const events = [];
    const errors = [];
    const warnings = [];
    const usedIds = new Set(before.map((ev) => (ev && ev.id !== undefined ? String(ev.id) : '')));
    for (let i = 0; i < (Array.isArray(drafts) ? drafts.length : 0); i++) {
      const made = appendEvent({ timelineEvents: events }, drafts[i], {
        polities: scenario.polities || [],
        era: scenario.era || {},
        nameOf: (id) => polityNameOf(scenario, id),
      });
      if (!made.ok) {
        errors.push(`第 ${i + 1} 条：${(made.errors || []).join('；')}`);
        continue;
      }
      const id = String(made.event.id);
      if (usedIds.has(id)) {
        errors.push(`第 ${i + 1} 条：事件 id「${id}」与已有事件重复`);
        continue;
      }
      usedIds.add(id);
      events.push(made.event);
      for (const w of (made.warnings || [])) warnings.push(`第 ${i + 1} 条：${w}`);
    }
    if (errors.length) return { ok: false, errors, warnings };
    execute({
      type: 'set-timeline-events',
      label: `设置事件表（${events.length} 条）`,
      undo: () => applyTimelineEvents(scenarioId, before, false),
      redo: () => applyTimelineEvents(scenarioId, events, true),
    });
    saveScenarios();
    return { ok: true, events, warnings };
  }

  /**
   * 只读查询：「`at` 这一刻，a 与 b 是什么关系」（命令行 / 面板共用同一实现）。
   * @returns {{ok:boolean, relation?:string, label?:string, text?:string, since?:object,
   *            until?:object, eventId?:string|null, title?:string, type?:string|null}}
   */
  function queryRelationAt(scenarioId, a, b, at) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { ok: false, reason: 'no-scenario' };
    const events = timelineEventsOf(scenario);
    const names = {};
    for (const p of (scenario.polities || [])) names[p.id] = p.name || p.id;
    const r = relationBetween(events, a, b, at);
    return {
      ok: true,
      ...r,
      text: describeRelation(events, a, b, at, { names }),
    };
  }

  /** 只读体检：本剧本事件表的冲突/可疑清单（导入后、落盘前给人看） */
  function auditTimelineEvents(scenarioId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { ok: false, reason: 'no-scenario' };
    const r = findConflicts(timelineEventsOf(scenario), {
      polities: scenario.polities || [],
      era: scenario.era || {},
    });
    return { ok: true, errors: r.errors, warnings: r.warnings, total: timelineEventsOf(scenario).length };
  }

  // ============================================================
  // 切片书签（slicePoints）—— 项目级「人指定的时间点」（2026-10-05）
  // ============================================================
  //
  // 为什么放在这里而不是新建一个 store：书签是**时间轴上的点**，与剧本同一份语义
  // （日期、区间归属都由 scenarioTimeline/scenarioDates 判定）。
  // 🔴 区间归属**不落盘**（运行时由 `eraIndexOfYear` 判），避免「剧本边界改了、书签上的
  //    区间却还是旧的」这种静默不一致。
  //
  // 存储位置：`slicePoints` 是**顶层 ref**（不进 scenarios 字典）—— 因为 scenarios 字典
  // 的键是「底图 key/剧本名」，把书签混进去会被画布与导出链当成一个剧本遍历。
  // 落盘由 geodata 的载荷构造带上（见 `exportCanvasToProject`）。

  const slicePoints = ref([]);

  /** 规整并写回（脏值/乱序一律在这一处收口） */
  function sanitizeSlicePoints(list) {
    const out = [];
    const seen = new Set();
    for (const p of (Array.isArray(list) ? list : [])) {
      if (!p || typeof p !== 'object') continue;
      const n = normalizeDate(p.date && typeof p.date === 'object' ? p.date : { y: p.y ?? p.year, m: p.m, d: p.d });
      if (!n) continue;
      const id = String(p.id || '');
      if (id && seen.has(id)) continue;                 // 同 id 只留第一条
      if (id) seen.add(id);
      out.push({
        id,
        label: typeof p.label === 'string' ? p.label : '',
        y: n.y, m: n.m, d: n.d,
      });
    }
    out.sort((a, b) => cmpDate(a, b) || String(a.id).localeCompare(String(b.id)));
    return out;
  }

  function nextSlicePointId() {
    // 与 makeId 同法：时间戳 + 模块内计数器（同毫秒连续两次也撞不上）
    return `sp_${Date.now().toString(36)}_${(slicePointSeq++).toString(36)}`;
  }
  let slicePointSeq = 0;

  /** 替换整表（走 undo）—— 所有增删改都经它，保证「一条 undo 撤回一次编辑」 */
  function commitSlicePoints(next, label) {
    const before = JSON.parse(JSON.stringify(slicePoints.value || []));
    const after = sanitizeSlicePoints(next);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { success: true, noop: true, count: after.length };
    }
    execute({
      type: 'slice-points',
      label,
      undo: () => { slicePoints.value = JSON.parse(JSON.stringify(before)); },
      redo: () => { slicePoints.value = JSON.parse(JSON.stringify(after)); },
    });
    saveScenarios();
    return { success: true, count: after.length };
  }

  /**
   * 新增切片点。`date` 可给 `{y,m,d}` 或裸年份；`label` 空则显示时退回日期文本。
   * @returns {{success:boolean, id?:string, reason?:string}}
   */
  function addSlicePoint(date, label = '') {
    if (!guardWrite('新增切片点').ok) return { success: false, reason: 'readonly' };
    const n = normalizeDate(date);
    if (!n) return { success: false, reason: '日期无法识别（需要年份）' };
    const id = nextSlicePointId();
    const next = [...(slicePoints.value || []), { id, label: String(label || ''), y: n.y, m: n.m, d: n.d }];
    const r = commitSlicePoints(next, `新增切片点${label ? '：' + label : ''}`);
    return { ...r, id };
  }

  /** 改名（日期不动）。空 label = 退回显示日期文本 */
  function renameSlicePoint(id, label) {
    if (!guardWrite('重命名切片点').ok) return { success: false, reason: 'readonly' };
    const key = String(id || '');
    if (!key) return { success: false, reason: 'no-id' };
    const list = slicePoints.value || [];
    if (!list.some(p => p.id === key)) return { success: false, reason: 'not-found' };
    const next = list.map(p => (p.id === key ? { ...p, label: String(label || '') } : p));
    return commitSlicePoints(next, `重命名切片点：${label || '（改回日期）'}`);
  }

  /** 改日期（走它就必须重新校验：区间归属是运行时判的，越界日期要让用户看见） */
  function updateSlicePoint(id, date) {
    if (!guardWrite('修改切片点日期').ok) return { success: false, reason: 'readonly' };
    const key = String(id || '');
    const n = normalizeDate(date);
    if (!key) return { success: false, reason: 'no-id' };
    if (!n) return { success: false, reason: '日期无法识别（需要年份）' };
    const list = slicePoints.value || [];
    if (!list.some(p => p.id === key)) return { success: false, reason: 'not-found' };
    const next = list.map(p => (p.id === key ? { ...p, y: n.y, m: n.m, d: n.d } : p));
    return commitSlicePoints(next, '修改切片点日期');
  }

  function removeSlicePoint(id) {
    if (!guardWrite('删除切片点').ok) return { success: false, reason: 'readonly' };
    const key = String(id || '');
    const list = slicePoints.value || [];
    const target = list.find(p => p.id === key);
    if (!target) return { success: false, reason: 'not-found' };
    const next = list.filter(p => p.id !== key);
    const r = commitSlicePoints(next, `删除切片点：${target.label || '（未命名）'}`);
    return { ...r, label: target.label || '' };
  }

  // ============================================================
  // 导出 / 导入（P0）
  // ============================================================

  /**
   * 导出为 .sitian/scenarios.json 同构的载荷。
   * ownerKey 为空则导出全部底图与剧本。
   */
  function exportScenariosPayload(ownerKey = null) {
    if (!ownerKey) {
      return {
        version: 1,
        baseMaps: JSON.parse(JSON.stringify(baseMaps.value || {})),
        scenarios: JSON.parse(JSON.stringify(scenarios.value || {})),
        updatedAt: new Date().toISOString(),
      };
    }
    const bm = {};
    if (baseMaps.value?.[ownerKey]) bm[ownerKey] = JSON.parse(JSON.stringify(baseMaps.value[ownerKey]));
    const sc = {};
    for (const [k, v] of Object.entries(scenarios.value || {})) {
      if (v?.ownerKey === ownerKey || String(k).startsWith(ownerKey + '/')) {
        sc[k] = JSON.parse(JSON.stringify(v));
      }
    }
    return { version: 1, baseMaps: bm, scenarios: sc, updatedAt: new Date().toISOString() };
  }

  /** 导出前体检：返回给人看的警告清单 */
  function auditScenariosPayload(payload) {
    const warns = [];
    const scen = payload?.scenarios || {};
    const maps = payload?.baseMaps || {};
    const keys = Object.keys(scen);
    if (!keys.length) warns.push('没有任何剧本');
    if (!Object.keys(maps).length) warns.push('没有任何底图（剧本将没有省份可渲染）');
    for (const [k, s] of Object.entries(scen)) {
      const owner = s?.ownerKey;
      if (!owner) { warns.push(`剧本「${s?.name || k}」缺 ownerKey`); continue; }
      if (!maps[owner]) warns.push(`剧本「${s?.name || k}」指向的底图「${owner}」不在导出范围内`);
      if (!Array.isArray(s?.polities) || !s.polities.length) warns.push(`剧本「${s?.name || k}」没有势力`);
      const own = Object.keys(s?.ownership || {}).length;
      if (!own) warns.push(`剧本「${s?.name || k}」没有省份归属`);
      if (s?.era?.startYear === undefined || s?.era?.startYear === '') warns.push(`剧本「${s?.name || k}」缺起始年份`);
    }
    return warns;
  }

  /**
   * 导入 scenarios.json 载荷。
   * mode='merge'（默认）按 key 合并；mode='replace' 整体替换 baseMaps/scenarios。
   * 整个导入是**一条 undo**（快照 + 整体替换，见铁律 #108）。
   */
  function importScenariosPayload(data, { mode = 'merge' } = {}) {
    if (!data || typeof data !== 'object') return { success: false, error: '不是合法的 JSON 对象' };
    const inMaps = data.baseMaps && typeof data.baseMaps === 'object' ? data.baseMaps : null;
    const inScen = data.scenarios && typeof data.scenarios === 'object' ? data.scenarios : null;
    if (!inMaps && !inScen) return { success: false, error: '缺少 baseMaps / scenarios 字段' };

    const snapMaps = JSON.parse(JSON.stringify(baseMaps.value || {}));
    const snapScen = JSON.parse(JSON.stringify(scenarios.value || {}));
    const snapPts = JSON.parse(JSON.stringify(slicePoints.value || []));
    // 🔴 导入的剧本可能是**旧格式**（外部包/老备份）→ 必须过迁移，否则这份数据一进来
    //    就被当成「没有显式日期」，全部退回合成值。
    const inScenMigrated = inScen ? normalizeScenarioDatesDict(JSON.parse(JSON.stringify(inScen))) : null;
    const nextMaps = mode === 'replace'
      ? JSON.parse(JSON.stringify(inMaps || {}))
      : { ...snapMaps, ...JSON.parse(JSON.stringify(inMaps || {})) };
    const nextScen = mode === 'replace'
      ? JSON.parse(JSON.stringify(inScenMigrated || {}))
      : { ...snapScen, ...JSON.parse(JSON.stringify(inScenMigrated || {})) };
    // 书签随包往返：替换 = 用包里的（没有就清空）；合并 = 追加去重
    const inPts = Array.isArray(data.slicePoints) ? data.slicePoints : null;
    const nextPts = mode === 'replace'
      ? sanitizeSlicePoints(inPts || [])
      : sanitizeSlicePoints([...snapPts, ...(inPts || [])]);

    const addedMaps = Object.keys(nextMaps).filter(k => !snapMaps[k]).length;
    const addedScen = Object.keys(nextScen).filter(k => !snapScen[k]).length;

    const gate = execute({
      type: 'import-scenarios',
      label: mode === 'replace' ? '导入剧本（替换）' : '导入剧本（合并）',
      undo: () => {
        baseMaps.value = snapMaps;
        scenarios.value = snapScen;
        slicePoints.value = snapPts;
      },
      redo: () => {
        baseMaps.value = nextMaps;
        scenarios.value = nextScen;
        slicePoints.value = nextPts;
      },
    });
    // 只读态：execute 被闸门拒绝 → 绝不回报「导入成功」（否则用户看到「导入完成」却什么都没进来）
    if (gate && gate.ok === false) return { success: false, error: gate.error };

    saveScenarios();
    return {
      success: true,
      mode,
      baseMaps: Object.keys(nextMaps).length,
      scenarios: Object.keys(nextScen).length,
      slicePoints: nextPts.length,
      addedMaps,
      addedScenarios: addedScen,
    };
  }

  /** 清空全部剧本（保留底图）—— 替换式导入前的显式动作 */
  function removeAllScenarios() {
    const snap = JSON.parse(JSON.stringify(scenarios.value || {}));
    execute({
      type: 'remove-all-scenarios',
      label: '清空剧本',
      undo: () => { scenarios.value = snap; },
      redo: () => { scenarios.value = {}; },
    });
    saveScenarios();
  }

  // ============================================================
  // Labels & Markers
  // ============================================================
  
  function addScenarioLabel(scenarioId, label) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const newLabel = {
      id: label.id || `label_${Date.now()}`,
      x: label.x,
      y: label.y,
      text: label.text || '',
      size: label.size || 12,
      color: label.color || '#3c4150',
    };
    
    execute({
      type: 'add-label',
      label: '添加地名',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            labels: scenarios.value[scenarioId].labels.filter(l => l.id !== newLabel.id),
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            labels: [...(scenarios.value[scenarioId].labels || []), newLabel],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function removeScenarioLabel(scenarioId, labelRef) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { ok: false, reason: 'no-scenario' };
    const list = scenario.labels || [];
    // 🔴 2026-10-07：`labelRef` 可以是 **id**（司天新建的条目都带 id）或 **下标**。
    //    为什么必须有下标这条路：FMG `.map` 导入的标签只有 `{x,y,text,size,color}` ——
    //    **没有 id**（见 `utils/azgaar-parser.js` 的 labels 构造）。按 id 匹配时
    //    `undefined === undefined` 会命中的是**任意第一条无 id 的标签** → 点第 3 条删掉第 1 条，
    //    而且不报错。这是本项目最讨厌的一类静默错删，故此处显式分派。
    const idx = typeof labelRef === 'number' ? labelRef : list.findIndex(l => l.id === labelRef);
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return { ok: false, reason: 'no-target' };
    const oldLabel = list[idx];
    // 撤销必须**放回原位**（`splice` 到 idx，不是 push 到表尾）：标签顺序就是渲染层叠顺序，
    // 追加到末尾会让"撤销后这一条压到别人上面"，与改动前不逐字段一致。
    const spliceBack = () => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const arr = [...(cur.labels || [])];
      arr.splice(Math.min(idx, arr.length), 0, oldLabel);
      scenarios.value = { ...scenarios.value, [scenarioId]: { ...cur, labels: arr } };
    };
    execute({
      type: 'remove-label',
      label: '删除地名',
      undo: () => { spliceBack(); },
      redo: () => {
        const cur = scenarios.value[scenarioId];
        if (!cur) return;
        const arr = [...(cur.labels || [])];
        const at = arr.indexOf(oldLabel);
        if (at >= 0) arr.splice(at, 1);
        else if (arr[idx] === oldLabel) arr.splice(idx, 1);
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...cur, labels: arr, updatedAt: new Date().toISOString() },
        };
      },
    });

    saveScenarios();
    return { ok: true, removed: oldLabel };
  }

  function addScenarioMarker(scenarioId, marker) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const newMarker = {
      id: marker.id || `marker_${Date.now()}`,
      x: marker.x,
      y: marker.y,
      name: marker.name || '',
      type: marker.type || 'default',
      // 🔴 icon / color 必须带上：ScenarioMap 放置标记时按「预设类型」取图标与颜色，
      //    而画布用 m.icon / m.color 渲染 —— 只存 type 的话图标与颜色全部落回兜底值，
      //    用户看到的永远是同一个图标（"选了类型但没变化"，2026-09-22 修）。
      icon: marker.icon || '',
      color: marker.color || '',
    };
    
    execute({
      type: 'add-marker',
      label: '添加标记',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            markers: scenarios.value[scenarioId].markers.filter(m => m.id !== newMarker.id),
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            markers: [...(scenarios.value[scenarioId].markers || []), newMarker],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function removeScenarioMarker(scenarioId, markerRef) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { ok: false, reason: 'no-scenario' };
    const list = scenario.markers || [];
    // `markerRef` = id 或下标 —— 理由同 `removeScenarioLabel`：FMG 导入的 markers
    // 只有 `{x,y,name,type}`，**没有 id**，按 id 匹配会误删第一条无 id 的标记。
    const idx = typeof markerRef === 'number' ? markerRef : list.findIndex(m => m.id === markerRef);
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return { ok: false, reason: 'no-target' };
    const oldMarker = list[idx];
    // 撤销放回**原位**（标记顺序 = 绘制层叠顺序）
    const spliceBack = () => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const arr = [...(cur.markers || [])];
      arr.splice(Math.min(idx, arr.length), 0, oldMarker);
      scenarios.value = { ...scenarios.value, [scenarioId]: { ...cur, markers: arr } };
    };
    execute({
      type: 'remove-marker',
      label: '删除标记',
      undo: () => { spliceBack(); },
      redo: () => {
        const cur = scenarios.value[scenarioId];
        if (!cur) return;
        const arr = [...(cur.markers || [])];
        const at = arr.indexOf(oldMarker);
        if (at >= 0) arr.splice(at, 1);
        else if (arr[idx] === oldMarker) arr.splice(idx, 1);
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...cur, markers: arr, updatedAt: new Date().toISOString() },
        };
      },
    });

    saveScenarios();
    return { ok: true, removed: oldMarker };
  }

  // ============================================================
  // Import/Load
  // ============================================================
  
  /**
   * 剧本数据 → 画布（外部 `.json` 与知识库缓存两条来源共用）。
   * @param {object} data
   * @param {{fillMissingOnly?:boolean}} opts 见 `applyScenarioState`。
   *   🔴 **隐式**载入（进入「历史剧本」时读知识库缓存）必须传 `true`：
   *      默认的「新值赢」合并会覆盖项目里已有的剧本与底图（静默丢编辑）。
   */
  function importFromScenariosJson(data, opts = {}) {
    if (!guardWrite('导入剧本').ok) return null;
    // 外部 .json 可能是旧格式 → 走统一装载口（内部已含迁移）
    const r = applyScenarioState(data, { fresh: false, ...opts });
    // 只有真的改了内存才排保存：隐式载入在「无事可补」时是纯 no-op，
    // 不该把项目标脏、更不该触发一次写盘 + 备份轮转。
    if (r && r.ok && r.changed !== false) saveScenarios();
    return r;
  }

  /**
   * 将 Azgaar .map 中的政治/文化/宗教数据同步到指定行星的 mapData
   * 供 PlanetMap 渲染参考图层使用
   *
   * ⚠️ 字段映射（provinces → azgaarProvinces 等）在 `utils/planetMapBundle.buildAzgaarReferenceLayers`
   *    —— 行星视图的 `.map` 导入也要同一份口径，两处各写一份就会「同一个 .map 在两处导出不同 id」。
   */
  function importPlanetLayerData(planetId, data) {
    if (!guardWrite('导入 .map 图层').ok) return;
    if (!planetId || !data) return;
    const map = mapData.value?.[planetId];
    if (!map) return;

    const layers = buildAzgaarReferenceLayers(data);
    for (const [k, v] of Object.entries(layers)) map[k] = v;

    // 触发响应式更新
    mapData.value = { ...mapData.value, [planetId]: { ...map } };
    scheduleAutoSaveMap(planetId);
  }

  function loadScenarioState(data) {
    if (data.baseMaps) baseMaps.value = data.baseMaps;
    if (data.scenarios) scenarios.value = normalizeScenarioDatesDict(data.scenarios);
  }

  // ============================================================
  // 装载口（**唯一的日期迁移入口**）
  // ============================================================
  //
  // 🔴 为什么必须有这个函数：`changeYears` → `changeEvents` 的兼容是**读时迁移**，
  //    于是「要不要迁移」取决于**入口有没有想起来**。入口有三类，各自最容易漏：
  //      ① 打开项目（geodata.applyProjectToCanvas）
  //      ② 快照回滚 / 知识库快照还原（vaultSnapshot 里存的是旧格式）
  //      ③ 撤销栈回放（旧命令闭包捕获的是迁移**之前**的对象）
  //    漏掉任何一处，症状都是同一句：「我明明录过易主日期，时间轴上却全是合成值」（不报错）。
  //    所以装载一律走这里，而不是在各处各写一遍 normalize。
  //
  // ⚠️ `list` 可能是**数组**（时间轴）也可能是**字典**（项目文件里的 scenarios）——
  //    `normalizeScenarioDict` 保持同形往返。无改动的条目**保持原引用**
  //    （避免整表换新对象 → 触发无谓重渲染 / 让「就地改字段」的纪律失效）。

  /** 剧本字典/数组 → 迁移后的同形结果（带迁移点名） */
  function normalizeScenarioDatesDict(list) {
    // 2026-10-21（B v2）：装载口同时做**账本派生** —— `initialOwnership + changeEvents`
    // 是事实源，`ownership` 只是缓存；缓存不一致时按账本覆盖并留一条 warn（不静默）。
    const dated = normalizeScenarioDict(list).scenarios;
    const led = normalizeLedgerDict(dated);
    if (led.mismatched) {
      console.warn(`[ledger] ${led.mismatched} 个剧本的 ownership 与账本派生不一致，已按账本覆盖：`,
        led.mismatchIds.slice(0, 5));
    }
    return led.dict;
  }

  /**
   * 装载整份剧本状态（底图 + 剧本 + 切片书签）—— **所有剧本数据的唯一装载口**。
   *
   * @param {{baseMaps?:object, scenarios?:object, slicePoints?:Array}} data
   * @param {{fresh?:boolean, fillMissingOnly?:boolean}} opts 三种语义，**必须显式选一种**：
   *   · `fresh:true`      —— 整体替换（打开项目 / 知识库快照还原）。内存被入参完全接管。
   *   · `fillMissingOnly` —— **内存里已有的优先，只补缺**（知识库 → 画布的**隐式**载入）。
   *   · 两者都不给         —— 合并且**新值赢**（`{...旧, ...新}`）。这是**显式**导入
   *     外部剧本包（`.json`）的既有语义，按钮 title 就写着「合并：同 key 覆盖」。
   *
   * 🔴 `fillMissingOnly` 的存在理由（2026-10-06 修的**真缺陷**，不是洁癖）：
   *   `App.enterScenarioMode()` 在打开「历史剧本」时会从**知识库缓存**
   *   （`<库>/.sitian/scenarios.json`）载入并走合并。项目态下画布事实源是**项目文件**，
   *   而那条路径用的是「新值赢」的合并 → 库里同名的剧本与底图会**整体替换**项目里那一份，
   *   紧接着 `saveScenarios()` 把覆盖结果推给项目并落盘 =
   *   **用户一进「历史剧本」就把自己的剧本/底图编辑静默回退**（每次启动后第一次进入都会回退一次）。
   *   隐式载入的语义只能是「补缺」；要覆盖必须由用户在剧本工具栏**明确按下**导入按钮。
   *
   * ⚠️ 无改动时**保持原引用**（`fillMissingOnly` 分支无事可补就不换对象）——
   *    调用方据此判断「要不要排一次保存」，避免每次进「历史剧本」都把项目标脏 + 触发写盘与备份轮转。
   */
  function applyScenarioState(data, { fresh = false, fillMissingOnly = false } = {}) {
    if (!data || typeof data !== 'object') return { ok: false, error: '没有剧本数据' };
    const prevBaseMaps = baseMaps.value;
    const prevScenarios = scenarios.value;
    const prevSlicePoints = slicePoints.value;

    if (data.baseMaps) {
      if (fresh) {
        baseMaps.value = data.baseMaps;
      } else if (fillMissingOnly) {
        const missing = Object.keys(data.baseMaps).filter((k) => !(k in (baseMaps.value || {})));
        if (missing.length) {
          baseMaps.value = { ...baseMaps.value, ...Object.fromEntries(missing.map((k) => [k, data.baseMaps[k]])) };
        }
      } else {
        baseMaps.value = { ...baseMaps.value, ...data.baseMaps };
      }
    }
    if (data.scenarios) {
      const migrated = normalizeScenarioDatesDict(data.scenarios);
      if (fresh) {
        scenarios.value = migrated;
      } else if (fillMissingOnly) {
        const missing = Object.keys(migrated).filter((k) => !(k in (scenarios.value || {})));
        if (missing.length) {
          scenarios.value = { ...scenarios.value, ...Object.fromEntries(missing.map((k) => [k, migrated[k]])) };
        }
      } else {
        scenarios.value = { ...scenarios.value, ...migrated };
      }
    }
    // 切片点是**项目级**：
    //  · 整体替换语义下必须跟着走（否则切项目会串味）；没有该字段则清空；
    //  · 合并语义下追加（显式导入外部剧本包时把对方书签也带进来，UI 会显示数量）；
    //  · `fillMissingOnly`（知识库隐式载入）**一律不碰** —— 书签的家是项目文件，不是知识库缓存。
    if (!fillMissingOnly) {
      if (data.slicePoints !== undefined) {
        const pts = sanitizeSlicePoints(data.slicePoints);
        slicePoints.value = fresh ? pts : sanitizeSlicePoints([...(slicePoints.value || []), ...pts]);
      } else if (fresh) {
        slicePoints.value = [];
      }
    }
    return {
      ok: true,
      // 调用方用它决定「要不要排一次保存」：只有引用变了才算真的改了内存
      changed: baseMaps.value !== prevBaseMaps
        || scenarios.value !== prevScenarios
        || slicePoints.value !== prevSlicePoints,
      baseMaps: Object.keys(baseMaps.value || {}).length,
      scenarios: Object.keys(scenarios.value || {}).length,
      slicePoints: (slicePoints.value || []).length,
    };
  }

  // ============================================================
  // Height Map Brush (v2 data-driven editing)
  // ============================================================

  function applyHeightBrush(baseMapKey, cx, cy, radius, strength, mode) {
    // ⚠️ 本函数**先改内存、后 execute**（涂抹期直接写 baseMaps）→ 只读态必须守函数首行，
    //    否则「拒绝」发生在数据已经改完之后（改了不落盘 = 静默丢数据）
    if (!guardWrite('高度笔刷').ok) return;
    if (!hasGrid(getHeightmapFor(baseMapKey))) return;

    const hm = getHeightmapFor(baseMapKey);
    const grid = hm.grid;
    // 热循环去响应式（2026-09-24）：`pts` 来自 baseMaps 的响应式对象，逐点读 `.x/.y`
    // 每次都要过 proxy trap；smooth 模式还会对每个命中格再全量扫一遍 pts（O(n²) 读）。
    // toRaw 只影响**读**的路径，写入仍走本地的 `newH` 副本 + 后续响应式赋值，语义不变。
    const pts = toRaw(grid.points);
    const spacing = grid.spacing || 14.4;
    const newH = new Float32Array(hm.h);

    // 性能优化：空间索引（构建一次，复用多次）
    if (!hm._spatialIndex) {
      const cellSize = spacing * 2;
      let minX = Infinity, minY = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
      }
      const cellMap = new Map();
      for (let i = 0; i < pts.length; i++) {
        const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        const cxi = Math.floor((px - minX) / cellSize);
        const cyi = Math.floor((py - minY) / cellSize);
        const key = `${cxi},${cyi}`;
        if (!cellMap.has(key)) cellMap.set(key, []);
        cellMap.get(key).push(i);
      }
      hm._spatialIndex = { cellSize, minX, minY, cellMap };
    }

    const idx = hm._spatialIndex;
    const minCx = Math.floor((cx - radius - idx.minX) / idx.cellSize);
    const maxCx = Math.floor((cx + radius - idx.minX) / idx.cellSize);
    const minCy = Math.floor((cy - radius - idx.minY) / idx.cellSize);
    const maxCy = Math.floor((cy + radius - idx.minY) / idx.cellSize);

    for (let ci = minCx; ci <= maxCx; ci++) {
      for (let cj = minCy; cj <= maxCy; cj++) {
        const cell = idx.cellMap.get(`${ci},${cj}`);
        if (!cell) continue;
        for (const i of cell) {
          const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
          const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
          const dx = px - cx;
          const dy = py - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= radius) continue;

          const falloff = brushFalloff(radius, dist);
          const delta = strength * falloff;

          if (mode === 'raise') {
            newH[i] = Math.min(100, newH[i] + delta);
          } else if (mode === 'lower') {
            newH[i] = Math.max(0, newH[i] - delta);
          } else if (mode === 'smooth') {
            let sum = 0, count = 0;
            for (let j = 0; j < pts.length; j++) {
              const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
              const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
              const ddx = qx - px, ddy = qy - py;
              if (Math.abs(ddx) < spacing * 1.5 && Math.abs(ddy) < spacing * 1.5) {
                sum += hm.h[j];
                count++;
              }
            }
            newH[i] = count > 0 ? sum / count : newH[i];
          }
        }
      }
    }

    // 重新派生温度/降水/生物群系
    // P2-4：小网格同步（一次 postMessage 往返的开销 ≥ 计算量本身），大网格把派生挪到 Worker。
    // 大网格时本帧先复用「上一条命令的派生数组」（派生是 h 的纯函数，短时陈旧无害），
    // 真值由 redo 里的 scheduleDerive 在 300ms 防抖后回写，主线程不再被 O(n) 循环占住。
    const canDefer = newH.length > getAsyncThreshold()
      && isWorkerAvailable()
      && !!(hm.temp && hm.prec && hm.biome)
      && hm.temp.length === newH.length
      && hm.prec.length === newH.length
      && hm.biome.length === newH.length;
    const derived = canDefer
      ? { temperature: hm.temp, precipitation: hm.prec, biome: hm.biome }
      : deriveLayers(newH, pts, null, null);
    const oldH = new Float32Array(hm.h);
    const oldTemp = hm.temp ? new Float32Array(hm.temp) : null;
    const oldPrec = hm.prec ? new Float32Array(hm.prec) : null;
    const oldBiome = hm.biome ? new Uint8Array(hm.biome) : null;

    const cmd = {
      type: 'height-brush',
      baseMapKey,
      mode,
      label: mode === 'raise' ? '抬高地形' : mode === 'lower' ? '降低地形' : '平滑地形',
      merge: (prev) => prev.type === 'height-brush' && prev.mode === mode && prev.baseMapKey === baseMapKey,
      undo: () => {
        // A1/M1b：改走 commitHeightmap —— 绑定行星时写行星那份，未绑定时写底图自己那份（与原表达式等价）。
        // touch:false 与改动前一致（原 undo 不打 updatedAt）
        commitHeightmap(baseMapKey, { ...hm, h: oldH, temp: oldTemp, prec: oldPrec, biome: oldBiome }, { touch: false });
      },
      redo: () => {
        commitHeightmap(baseMapKey, {
          ...hm,
          h: new Float32Array(newH),
          temp: derived.temperature,
          prec: derived.precipitation,
          biome: derived.biome,
        });
        // P2-4：异步派生挂在 redo 内 —— execute() 首帧与后续 redo 都会走到，
        // 所以「撤销后再重做」同样能拿回正确派生值（否则重做会留下陈旧图层）。
        if (canDefer) {
          const epoch = (deriveEpoch[baseMapKey] = (deriveEpoch[baseMapKey] || 0) + 1);
          scheduleDerive(newH, (res) => {
            if (!res || deriveEpoch[baseMapKey] !== epoch) return; // 已被更新的命令取代
            const cur = getHeightmapFor(baseMapKey);
            if (!cur || !cur.h || cur.h.length !== res.n) return;
            // 派生数组直接回写（不进 undo 栈：它是 h 的纯函数、可随时重算；
            // undo/redo 闭包里各自持有自己那一代的值，回写只影响"当前"这一代）
            cur.temp = res.temperature;
            cur.prec = res.precipitation;
            cur.biome = res.biome;
            // R5：落盘通道必须按归属分流 —— 绑定行星后这份数据住在 mapData[pid]，
            //    排剧本保存等于没保存（行星侧要等下一次别的写动作才落盘 → 派生图层静默丢失）
            const ownerPid = boundPlanetId(baseMaps.value[baseMapKey]);
            if (ownerPid) scheduleAutoSaveMap(ownerPid);
            else scheduleAutoSaveScenarios();
          });
        }
      },
    };
    execute(cmd);

    scheduleAutoSaveScenarios();
  }

  // 生物群系 key → Uint8 编码
  const BIOME_KEY_INDEX = {
    ocean: 0, hot_desert: 1, cold_desert: 2, savanna: 3, grassland: 4,
    tropical_seasonal: 5, temperate_deciduous: 6, tropical_rainforest: 7,
    temperate_rainforest: 8, taiga: 9, tundra: 10, glacier: 11, wetland: 12,
  };

  function applyBiomeBrush(baseMapKey, cx, cy, radius, biomeKey) {
    // ⚠️ 本函数**先改内存、后 execute**（涂抹期直接写 baseMaps）→ 只读态必须守函数首行，
    //    否则「拒绝」发生在数据已经改完之后（改了不落盘 = 静默丢数据）
    if (!guardWrite('生物群系笔刷').ok) return;
    if (!hasGrid(getHeightmapFor(baseMapKey))) return;

    const hm = getHeightmapFor(baseMapKey);
    // 这里的循环是**全量遍历** pts（每次涂抹 O(n) 次 proxy 读）→ toRaw 收益最明显（2026-09-24）
    const pts = toRaw(hm.grid.points);
    const oldBiome = hm.biome ? new Uint8Array(hm.biome) : new Uint8Array(pts.length);
    const newBiome = new Uint8Array(oldBiome);
    const idx = BIOME_KEY_INDEX[biomeKey] ?? 0;

    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      if (dist >= radius) continue;
      const falloff = brushFalloff(radius, dist);
      if (falloff < 0.1) continue;
      newBiome[i] = idx;
    }

    const cmd = {
      type: 'biome-brush',
      baseMapKey,
      biomeKey,
      label: '生物群系笔刷',
      merge: (prev) => prev.type === 'biome-brush' && prev.biomeKey === biomeKey && prev.baseMapKey === baseMapKey,
      undo: () => { commitHeightmap(baseMapKey, { ...hm, biome: oldBiome }, { touch: false }); },
      redo: () => { commitHeightmap(baseMapKey, { ...hm, biome: new Uint8Array(newBiome) }); },
    };
    execute(cmd);

    saveScenarios();
  }



  // ============================================================
  // Getters
  // ============================================================
  
  function getBaseMap(baseMapKey) { return baseMaps.value[baseMapKey]; }
  function getScenario(scenarioId) { return scenarios.value[scenarioId]; }
  function getScenariosByOwner(ownerKey) { return Object.values(scenarios.value).filter(s => s.ownerKey === ownerKey); }
  function getBaseMapsList() { return Object.values(baseMaps.value); }
  function getAllScenarios() { return Object.values(scenarios.value); }

  // ── 高度查询：取最近网格点 ──
  function addBaseMapBurg(baseMapKey, burg) {
    // 2026-10-08（B0）：补首行守卫 + 登记契约（此前是未登记写口）
    if (!guardWrite('放置聚落').ok) return;
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;

    execute({
      type: 'add-burg',
      label: '放置聚落',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMap,
            burgs: (baseMap.burgs || []).filter(b => b.id !== burg.id),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMap,
            burgs: [...(baseMap.burgs || []), burg],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    // 🔴 2026-10-17 暮雨实测「点一下卡一下」：这里原来是**同步** `saveScenarios()` ——
    //    每画/删一条河都全量 `JSON.parse(JSON.stringify(整个项目载荷))`（真实项目 415 省 +
    //    2.7 万点 + 高度图 → 一次几百 ms 主线程阻塞）。高频小编辑一律走 300ms 防抖
    //    （`scheduleAutoSaveScenarios`），退出前 `flushSave()` 会兜底真正落盘。
    scheduleAutoSaveScenarios();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 底图侧的河流 / 道路 CRUD（D，2026-10-11）
  //
  // 为什么必须补这一层（都是实测出来的，不是"顺手重构"）：
  //   ① **手画的河从来没落过盘**：组件里 `finishRiverDraft` 只把路径 push 进一个**组件本地数组**
  //      (`riverPaths`)，全仓没有任何一处把它写进 store —— 重开应用河就没了，还不报错。
  //   ② **手画的路绕过了 undo 与自动保存**：组件直接 `store.baseMaps = {...}`（手搓替换），
  //      这既不在撤销栈里，也不触发 `scheduleAutoSaveScenarios`，只能"碰巧"赶上别的保存。
  //   ③ 底图侧原本只有 `addBaseMapBurg` 一个"非省份"写口；河流/道路是同一类数据，该同一套规矩。
  //
  // 🔴 纪律：与省份编辑同源 —— 全部经 `execute()`（redo 内写、undo 回滚），首行 `guardWrite`。
  //    这样只读态被拦、Ctrl+Z 生效、落盘由 `saveScenarios()` 统一调度。
  // ══════════════════════════════════════════════════════════════════════════

  /** 往底图加一条河流（points 为世界坐标点列；至少 2 点） */
  function addBaseMapRiver(baseMapKey, river) {
    if (!guardWrite('绘制河流').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许写入河流' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const pts = ((river && river.points) || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) return { ok: false, rejected: 'too-few-points', message: '河流至少要 2 个点' };
    const list = bm0.rivers || [];
    const item = {
      id: (river && river.id) || `river_${Date.now().toString(36)}_${list.length}`,
      name: (river && river.name) || `河流 ${list.length + 1}`,
      points: pts.map((p) => ({ x: p.x, y: p.y })),
      ...(Number.isFinite(Number(river && river.width)) ? { width: Number(river.width) } : {}),
      ...(Number.isFinite(Number(river && river.discharge)) ? { discharge: Number(river.discharge) } : {}),
      // T7/H2：速度→宽度因子（可选数组，与 points 等长；导入河/自动河没有）
      ...(Array.isArray(river && river.widthFactors)
        ? { widthFactors: river.widthFactors.filter((x) => Number.isFinite(Number(x))).slice(0, 4000) }
        : {}),
    };
    const before = bm0;
    execute({
      type: 'add-basemap-river',
      label: item.name,
      undo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: before }; },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: { ...before, rivers: [...(before.rivers || []), item], updatedAt: new Date().toISOString() },
        };
      },
    });
    scheduleAutoSaveScenarios();   // 防抖（高频小编辑；同 addBaseMapBurg 的注释）
    return { ok: true, id: item.id, count: list.length + 1 };
  }

  /** 删一条河流（按 id；找不到 → 明确回执，不静默） */
  function removeBaseMapRiver(baseMapKey, riverId) {
    if (!guardWrite('删除河流').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许改河流' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const list = bm0.rivers || [];
    const idx = list.findIndex((r) => r && r.id === riverId);
    if (idx < 0) {
      return { ok: false, rejected: 'not-found', message: `这条河流不在这张底图上（id=${riverId}）—— 列表可能已经变了，请刷新后重试` };
    }
    const removed = list[idx];
    execute({
      type: 'remove-basemap-river',
      label: `删除${removed.name || '河流'}`,
      undo: () => {
        const cur = baseMaps.value[baseMapKey] || {};
        const next = [...(cur.rivers || [])];
        next.splice(Math.min(idx, next.length), 0, removed);      // 放回**原位**（渲染层叠顺序）
        baseMaps.value = { ...baseMaps.value, [baseMapKey]: { ...cur, rivers: next } };
      },
      redo: () => {
        const cur = baseMaps.value[baseMapKey] || {};
        if (!cur.rivers || !cur.rivers.some((r) => r && r.id === riverId)) return;   // 幂等：已不在则不动
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: { ...cur, rivers: cur.rivers.filter((r) => !(r && r.id === riverId)), updatedAt: new Date().toISOString() },
        };
      },
    });
    scheduleAutoSaveScenarios();   // 防抖 —— 连删多条时只做一次全量序列化（暮雨实测的卡顿源）
    return { ok: true, removed: removed.name || riverId };
  }

  /**
   * **批量**删河（框选 / 多选之后一次删掉）—— 与 `removeBaseMapRiver` 同一条口径，
   * 区别只有一个：**整批 = 一条撤销**（用户的心理模型是"我删了这次选中的 5 条"，
   * 不是"5 步操作"；分成 5 条 undo 的话要按 5 次 Ctrl+Z 才能回来）。
   *
   * @param {string} baseMapKey
   * @param {string[]} riverIds
   * @returns {{ok:true,count:number,removed:string[],missing:string[]}|{ok:false,rejected:string,message:string}}
   */
  function removeBaseMapRivers(baseMapKey, riverIds) {
    if (!guardWrite('删除河流').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许改河流' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const ids = [...new Set((riverIds || []).filter((x) => typeof x === 'string' && x))];
    if (!ids.length) return { ok: false, rejected: 'no-ids', message: '没有要删的河流（先框选或点选几条）' };
    const list0 = bm0.rivers || [];
    const wanted = new Set(ids);
    const removed = list0.filter((r) => r && wanted.has(r.id));
    const missing = ids.filter((id) => !list0.some((r) => r && r.id === id));
    if (!removed.length) {
      return { ok: false, rejected: 'not-found', message: '选中的河流都不在这张底图上（列表可能已经变了）' };
    }
    const before = bm0;
    const removedIds = new Set(removed.map((r) => r.id));
    execute({
      type: 'remove-basemap-rivers',
      label: `删除 ${removed.length} 条河流`,
      undo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: before }; },
      redo: () => {
        const cur = baseMaps.value[baseMapKey] || {};
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...cur,
            // 保序：按原列表顺序过滤（渲染层叠顺序 = 数组顺序，不能靠 Set 重排）
            rivers: (cur.rivers || []).filter((r) => !(r && removedIds.has(r.id))),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    scheduleAutoSaveScenarios();
    return { ok: true, count: removed.length, removed: removed.map((r) => r.name || r.id), missing };
  }

  /**
   * **批量**改河（一次撤销）：`patches = [{ id, patch }]` —— 裁海岸线这类"一次动作改多条"用它。
   * 语义与逐条 `updateBaseMapRiver` 一致（同样只认 `points`，同样走 `execute`），
   * 但**整批一条 undo**，且 `changed` 为 false 时**一条栈都不压**（空操作不污染撤销栈）。
   *
   * @returns {{ok:true,changed:number,ids:string[]}|{ok:false,rejected:string,message:string}}
   */
  function applyBaseMapRiverPatches(baseMapKey, patches) {
    if (!guardWrite('编辑河流').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许改河流' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const list0 = bm0.rivers || [];
    const byId = new Map(list0.filter((r) => r && r.id).map((r) => [r.id, r]));
    const applied = [];
    for (const p of patches || []) {
      const old = p && byId.get(p.id);
      if (!old) continue;
      const next = { ...old, ...(p.patch || {}), id: old.id };
      if (next.points && !Array.isArray(next.points)) continue;
      if (next.points && next.points.length < 2) continue;      // 河至少要 2 点（与 add 同一口径）
      applied.push({ id: old.id, before: old, after: next });
    }
    if (!applied.length) return { ok: true, changed: 0, ids: [] };
    const before = bm0;
    const appliedById = new Map(applied.map((a) => [a.id, a.after]));
    execute({
      type: 'patch-basemap-rivers',
      label: `编辑 ${applied.length} 条河流`,
      undo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: before }; },
      redo: () => {
        const cur = baseMaps.value[baseMapKey] || {};
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...cur,
            rivers: (cur.rivers || []).map((r) => (r && appliedById.has(r.id) ? appliedById.get(r.id) : r)),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    scheduleAutoSaveScenarios();
    return { ok: true, changed: applied.length, ids: applied.map((a) => a.id) };
  }

  /**
   * **一次动作 = 一条撤销**的河流批量写口（改 / 加 / 删三样一起，原子）。
   *
   * 🔴 2026-10-18 第十八修·三补这个口，是为了两件**产品里真的发生**的事：
   *   ① **河流橡皮**：擦断一条河 = 「改这条（留下的第一段）+ 加几条（其余段）+ 删掉没被擦到的…
   *      不，是被擦干净的那些」。三个动作必须同进同退 —— 分成 3 条 undo 的话，用户按一次
   *      Ctrl+Z 只回一半，画面变成"半擦"的怪状态（本仓在 `applyBaseMapRiverPatches` 的注释里
   *      已经写明过这条心理模型：「我做了**一次**擦除」）。
   *   ② **画支流**：此前是 `addBaseMapRiver` + `updateBaseMapRiver` **两条 undo**
   *      （代码里诚实记着"要在数据层做成一条 undo 得加批量写口 —— 本轮没做"）。现在做了。
   *
   * 语义与逐条写口**逐字一致**（只认 `points`、`points` 少于 2 点不成立、`changed=0` 不压栈），
   * 顺序也钉死：**先删 → 再改 → 最后加**（同一条河被擦断时，剩下的段使用原 id，
   * 新段排到列表末尾；渲染层叠顺序 = 数组顺序，所以这个顺序是可见的，不能随意换）。
   *
   * @param {string} baseMapKey
   * @param {{patches?:Array<{id:string,patch:object}>, adds?:Array<object>, removes?:string[]}} edit
   * @returns {{ok:true,changed:number,updated:string[],added:string[],removed:string[]}
   *          |{ok:false,rejected:string,message:string}}
   */
  function applyBaseMapRiverEdit(baseMapKey, edit = {}) {
    if (!guardWrite('编辑河流').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许改河流' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const list0 = bm0.rivers || [];
    const byId = new Map(list0.filter((r) => r && r.id).map((r) => [r.id, r]));
    const removeIds = [...new Set((edit.removes || []).filter((x) => typeof x === 'string' && byId.has(x)))];
    const removeSet = new Set(removeIds);
    const applied = [];
    for (const p of edit.patches || []) {
      const old = p && byId.get(p.id);
      if (!old || removeSet.has(old.id)) continue;               // 同一条既删又改 → 删赢（避免僵尸）
      const next = { ...old, ...(p.patch || {}), id: old.id };
      if (next.points && !Array.isArray(next.points)) continue;
      if (next.points && next.points.length < 2) continue;       // 与 add 同一口径：河至少 2 点
      applied.push({ id: old.id, after: next });
    }
    const stamp = Date.now().toString(36);
    const adds = [];
    let n = 0;
    for (const a of edit.adds || []) {
      const pts = ((a && a.points) || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length < 2) continue;
      n += 1;
      adds.push({
        id: (a && a.id) || `river_${stamp}_${list0.length + n}`,
        name: (a && a.name) || `河流 ${list0.length + n}`,
        points: pts.map((p) => ({ x: p.x, y: p.y })),
        ...(Number.isFinite(Number(a && a.width)) ? { width: Number(a.width) } : {}),
        ...(Number.isFinite(Number(a && a.discharge)) ? { discharge: Number(a.discharge) } : {}),
        ...(Array.isArray(a && a.widthFactors)
          ? { widthFactors: a.widthFactors.filter((x) => Number.isFinite(Number(x))).slice(0, 4000) }
          : {}),
      });
    }
    const changed = removeIds.length + applied.length + adds.length;
    if (!changed) return { ok: true, changed: 0, updated: [], added: [], removed: [] };
    const before = bm0;
    const appliedById = new Map(applied.map((x) => [x.id, x.after]));
    execute({
      type: 'edit-basemap-rivers',
      label: removeIds.length && !adds.length ? `擦除 ${removeIds.length + applied.length} 处河流` : `编辑 ${changed} 条河流`,
      undo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: before }; },
      redo: () => {
        const cur = baseMaps.value[baseMapKey] || {};
        const kept = (cur.rivers || []).filter((r) => !(r && removeSet.has(r.id)));
        const mapped = kept
          .map((r) => (r && appliedById.has(r.id) ? appliedById.get(r.id) : r))
          .filter((r) => !(r && removeSet.has(r.id)));
        // 幂等：已加过的（同 id）不重复加 —— redo 可能被连续调用
        const have = new Set(mapped.filter((r) => r && r.id).map((r) => r.id));
        const toAdd = adds.filter((a) => !have.has(a.id));
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...cur,
            // 保序：删除/替换按原序过滤，新段追加在末尾（渲染层叠顺序 = 数组顺序）
            rivers: [...mapped, ...toAdd],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    scheduleAutoSaveScenarios();
    return {
      ok: true,
      changed,
      updated: applied.map((x) => x.id),
      added: adds.map((x) => x.id),
      removed: removeIds,
    };
  }

  /**
   * 改一条**已有**的手画河（节点移动 / 加拐点 / 删单个节点 / 改宽·名）。
   *
   * 🔴 2026-10-17 补这个写口的原因（与 `insertNodeBetween` 那次同源，属同一个缺口）：
   *    底图侧此前只有 `add` 与 `remove` —— **没有 update**。于是「画完之后想微调」
   *    在数据层根本没有出口：拖节点、加拐点、删一个点，全都只能「删掉整条重画」，
   *    而重画会换 id/名字、丢掉调好的 width（这就是行星图早就有的 `updateRiver`）。
   *
   * 入口只有一条（`opts.removeNodeAt` 与 `patch.nodes` 互斥，见下方），
   * 全部走 `execute()`：一次编辑 = 一条 undo，`undo` 恢复 `before` 整份河流列表快照。
   *
   * @param {string} baseMapKey
   * @param {string} riverId
   * @param {object} patch           要改的字段（**`points`** / width / name …）
   * @param {{removeNodeAt?:number}} [opts]
   * @returns {{ok:true,changed:boolean,nodeCount?:number}|{ok:false,rejected:string,message:string}}
   *
   * ⚠️ **字段名是 `points` 不是 `nodes`**：底图河的唯一载荷口径由
   *    `normalizeBaseMapRivers` / `addBaseMapRiver` / `drawRiverPaths` 三方共同约定为
   *    `{ points:[{x,y}], width?, discharge? }`（行星图那边才叫 `nodes`）。
   *    传错的后果很隐蔽：**数据确实改了、画布一动不动**（渲染读的是 points）——
   *    本函数因此显式把 `nodes` 归一到 `points`，两个名字进来都能用。
   */
  function updateBaseMapRiver(baseMapKey, riverId, patch, opts = {}) {
    if (!guardWrite('编辑河流').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许改河流' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const list0 = bm0.rivers || [];
    const idx = list0.findIndex((r) => r && r.id === riverId);
    if (idx < 0) {
      return { ok: false, rejected: 'not-found', message: `这条河流不在这张底图上（id=${riverId}）—— 列表可能已经变了，请刷新后重试` };
    }
    const old = list0[idx];
    const next = { ...old, ...(patch || {}), id: old.id };
    // 归一口径：进来的 `nodes` 一律落到 `points`（并抹掉另一个名字，避免"两份点列"）
    if (next.nodes && !next.points) next.points = next.nodes;
    delete next.nodes;
    if (next.points && !Array.isArray(next.points)) {
      return { ok: false, rejected: 'bad-points', message: 'points 必须是数组' };
    }

    // ── 删单个节点：与 patch.points 互斥（以 removeNodeAt 为准）────────────────
    // 为什么删点要在 store 内算：删点必须**从当前点列算起**。组件侧若自己先算再传 points，
    // 同一份数据就有两条算路（本项目反复踩过：改一处、另一处不变，且不报错）。
    const removeAt = Number(opts && opts.removeNodeAt);
    let removedPoint = null;
    if (Number.isInteger(removeAt) && removeAt >= 0) {
      const clean = (arr) => (arr || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      const cur = clean(next.points || old.points);
      const clamped = Math.min(removeAt, cur.length - 1);
      removedPoint = cur[clamped];
      const kept = cur.filter((_, i) => i !== clamped);
      if (kept.length < 2) {
        return { ok: false, rejected: 'too-few-points', message: '这条河只剩 2 个点了 —— 再删就不成一条河，请直接删整条（Delete）' };
      }
      next.points = kept;
      // 线宽按**点数**分级（与 `addBaseMapRiver` 落库时同一口径）——
      // 否则删点会让「越长越宽」悄悄失真
      next.width = Math.max(0.4, Math.min(1.6, 0.3 + kept.length * 0.05));
    }

    if (JSON.stringify(next) === JSON.stringify(old)) return { ok: true, changed: false };

    // 整份河流列表快照当撤销档：与 `updateBaseMapBurg` 同款 ——
    // 「就地只改这一条」在 undo 时无法还原**位置**（数组顺序 = 渲染层叠顺序）
    const before = bm0;
    execute({
      type: removeAt >= 0 ? 'remove-basemap-river-node' : 'update-basemap-river',
      label: next.name || old.name || '编辑河流',
      undo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: before }; },
      redo: () => {
        const cur = baseMaps.value[baseMapKey] || before;
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...cur,
            rivers: (cur.rivers || []).map((r) => (r && r.id === riverId ? next : r)),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    scheduleAutoSaveScenarios();   // 防抖 —— 拖节点松手也是高频动作
    return {
      ok: true,
      changed: true,
      nodeCount: Array.isArray(next.points) ? next.points.length : undefined,
      ...(removedPoint ? { removed: { x: removedPoint.x, y: removedPoint.y } } : {}),
    };
  }

  /** 往底图加一条道路（样式由调用方给：color / width / dash / group） */
  function addBaseMapRoute(baseMapKey, route) {
    if (!guardWrite('绘制道路').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许写入道路' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const pts = ((route && route.points) || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) return { ok: false, rejected: 'too-few-points', message: '道路至少要 2 个点' };
    const list = bm0.routes || [];
    const item = {
      id: (route && route.id) || `road_${Date.now().toString(36)}_${list.length}`,
      group: (route && route.group) || 'roads',
      name: (route && route.name) || `道路 ${list.length + 1}`,
      points: pts.map((p) => ({ x: p.x, y: p.y })),
      ...(route && route.style ? { style: route.style } : {}),
      ...(route && route.color ? { color: route.color } : {}),
      ...(Number.isFinite(Number(route && route.width)) ? { width: Number(route.width) } : {}),
      ...(route && Array.isArray(route.dash) ? { dash: route.dash } : {}),
    };
    const before = bm0;
    execute({
      type: 'add-basemap-route',
      label: item.name,
      undo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: before }; },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: { ...before, routes: [...(before.routes || []), item], updatedAt: new Date().toISOString() },
        };
      },
    });
    scheduleAutoSaveScenarios();   // 防抖（同上）
    return { ok: true, id: item.id, count: list.length + 1 };
  }

  /** 删一条道路（按 id；找不到 → 明确回执） */
  function removeBaseMapRoute(baseMapKey, routeId) {
    if (!guardWrite('删除道路').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许改道路' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const list = bm0.routes || [];
    const idx = list.findIndex((r) => r && r.id === routeId);
    if (idx < 0) {
      return { ok: false, rejected: 'not-found', message: `这条道路不在这张底图上（id=${routeId}）` };
    }
    const removed = list[idx];
    execute({
      type: 'remove-basemap-route',
      label: `删除${removed.name || '道路'}`,
      undo: () => {
        const cur = baseMaps.value[baseMapKey] || {};
        const next = [...(cur.routes || [])];
        next.splice(Math.min(idx, next.length), 0, removed);
        baseMaps.value = { ...baseMaps.value, [baseMapKey]: { ...cur, routes: next } };
      },
      redo: () => {
        const cur = baseMaps.value[baseMapKey] || {};
        if (!cur.routes || !cur.routes.some((r) => r && r.id === routeId)) return;
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: { ...cur, routes: cur.routes.filter((r) => !(r && r.id === routeId)), updatedAt: new Date().toISOString() },
        };
      },
    });
    scheduleAutoSaveScenarios();   // 防抖（同上）
    return { ok: true, removed: removed.name || routeId };
  }

  /**
   * 改一个聚落（D 同批补口：聚落编辑此前也是组件直改 store，绕开撤销与落盘调度）
   *
   * @param {object} [opts]
   * @param {Array} [opts.materialize] 这个 id 在底图上**还不存在**时，先把这批聚落落进来再改
   *   （2026-10-13「旧数据里的聚落」）。为什么需要：早期 `.map` 导入只把首都写进**剧本 markers**，
   *   底图侧根本没有 `burgs`，组件于是把 markers 派生出来当城镇**显示** —— 用户看得见、点得开编辑器，
   *   一按保存却报「这个聚落不在这张底图上」，等于**改不了**（2026-10-11 轮 1 留下的尾巴）。
   *
   *   🔴 与编辑**同一条 undo**：拆成两次 `execute` 后 Ctrl+Z 只退一半 —— 名字回退了、
   *      多出来的城镇还在（"半吊子状态"比不做更坏）。所以登记与改写在同一个 redo 里。
   */
  function updateBaseMapBurg(baseMapKey, burgId, patch, opts = {}) {
    if (!guardWrite('编辑聚落').ok) return { ok: false, rejected: 'readonly', message: '只读态不允许改聚落' };
    const bm0 = baseMaps.value[baseMapKey];
    if (!bm0) return { ok: false, rejected: 'no-basemap', message: `底图不存在：${baseMapKey}` };
    const list = bm0.burgs || [];
    const idx = list.findIndex((b) => b && b.id === burgId);
    if (idx < 0) {
      const seeds = (Array.isArray(opts.materialize) ? opts.materialize : []).filter((b) => b && b.id);
      if (!seeds.length) return { ok: false, rejected: 'not-found', message: `这个聚落不在这张底图上（id=${burgId}）` };
      const ids = new Set(seeds.map((b) => String(b.id)));
      const patched = seeds.map((b) => (String(b.id) === String(burgId)
        ? { ...b, ...(patch || {}), id: b.id }
        : { ...b }));
      const mkAfter = () => {
        const cur = baseMaps.value[baseMapKey] || bm0;
        // 幂等：同名 id 先剔除再追加（重复点保存不会越攒越多）
        const kept = (cur.burgs || []).filter((b) => b && !ids.has(String(b.id)));
        return { ...cur, burgs: [...kept, ...patched], updatedAt: new Date().toISOString() };
      };
      execute({
        type: 'promote-legacy-burgs',
        label: `登记旧数据里的 ${seeds.length} 个聚落`,
        undo: () => {
          const cur = baseMaps.value[baseMapKey] || bm0;
          baseMaps.value = {
            ...baseMaps.value,
            [baseMapKey]: { ...cur, burgs: (cur.burgs || []).filter((b) => !(b && ids.has(String(b.id)))) },
          };
        },
        redo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: mkAfter() }; },
      });
      scheduleAutoSaveScenarios();   // 防抖（同上）
      return { ok: true, changed: true, materialized: seeds.length };
    }
    const old = list[idx];
    const next = { ...old, ...(patch || {}), id: old.id };
    if (JSON.stringify(next) === JSON.stringify(old)) return { ok: true, changed: false };
    const before = bm0;
    const mkAfter = () => {
      const cur = baseMaps.value[baseMapKey] || before;
      return {
        ...cur,
        burgs: (cur.burgs || []).map((b) => (b && b.id === burgId ? next : b)),
        updatedAt: new Date().toISOString(),
      };
    };
    execute({
      type: 'update-burg',
      label: `编辑聚落 ${old.name || ''}`.trim(),
      undo: () => {
        const cur = baseMaps.value[baseMapKey] || before;
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: { ...cur, burgs: (cur.burgs || []).map((b) => (b && b.id === burgId ? old : b)) },
        };
      },
      redo: () => { baseMaps.value = { ...baseMaps.value, [baseMapKey]: mkAfter() }; },
    });
    scheduleAutoSaveScenarios();   // 防抖（同上）
    return { ok: true, changed: true };
  }

  function applyCultureBrush(baseMapKey, cx, cy, radius, cultureKey) {
    // ⚠️ 2026-10-08（B0）：本函数此前**既没有首行守卫、也没登记进写口契约** ——
    //    它是靠 `execute()` 的总闸门兜住的（功能没坏，但契约表看不见它，属结构性漏网）。
    //    补首行守卫的理由与 applyHeightBrush 一致：涂抹期的准备动作不该发生在拒绝之后。
    if (!guardWrite('文化笔刷').ok) return;
    const hm = getHeightmapFor(baseMapKey);
    if (!hasGrid(hm)) return;

    const pts = hm.grid.points;
    const oldCultures = hm.culture ? new Uint8Array(hm.culture) : new Uint8Array(pts.length);
    const newCultures = new Uint8Array(oldCultures);
    const idx = parseInt(cultureKey, 10) || 0;

    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist >= radius) continue;
      const falloff = brushFalloff(radius, dist);
      if (falloff < 0.1) continue;
      newCultures[i] = idx;
    }

    execute({
      type: 'culture-brush',
      baseMapKey,
      cultureKey,
      label: '文化笔刷',
      merge: (prev) => prev.type === 'culture-brush' && prev.cultureKey === cultureKey && prev.baseMapKey === baseMapKey,
      undo: () => { commitHeightmap(baseMapKey, { ...hm, culture: oldCultures }, { touch: false }); },
      redo: () => { commitHeightmap(baseMapKey, { ...hm, culture: new Uint8Array(newCultures) }); },
    });
    saveScenarios();
  }

  function applyReligionBrush(baseMapKey, cx, cy, radius, religionKey) {
    if (!guardWrite('宗教笔刷').ok) return;   // 同上（2026-10-08，B0）
    const hm = getHeightmapFor(baseMapKey);
    if (!hasGrid(hm)) return;

    const pts = hm.grid.points;
    const oldReligions = hm.religion ? new Uint8Array(hm.religion) : new Uint8Array(pts.length);
    const newReligions = new Uint8Array(oldReligions);
    const idx = parseInt(religionKey, 10) || 0;

    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist >= radius) continue;
      const falloff = brushFalloff(radius, dist);
      if (falloff < 0.1) continue;
      newReligions[i] = idx;
    }

    execute({
      type: 'religion-brush',
      baseMapKey,
      religionKey,
      label: '宗教笔刷',
      merge: (prev) => prev.type === 'religion-brush' && prev.religionKey === religionKey && prev.baseMapKey === baseMapKey,
      undo: () => { commitHeightmap(baseMapKey, { ...hm, religion: oldReligions }, { touch: false }); },
      redo: () => { commitHeightmap(baseMapKey, { ...hm, religion: new Uint8Array(newReligions) }); },
    });
    saveScenarios();
  }

  function getHeightAt(baseMapKey, worldX, worldY) {
    // 🐞 旧实现漏了 `pts` 的定义就直接 `pts[i]` —— 一旦本函数被调用即 ReferenceError
    //    （而且没有任何 UI 回执）。这里补上定义，并加网格存在性防御（2026-09-24 修）。
    const hmSelf = getHeightmapFor(baseMapKey);
    const grid = hmSelf?.grid;
    const pts = grid?.points;
    if (!Array.isArray(pts) || pts.length === 0) return null;
    const spacing = grid.spacing || 14.4;
    const h = hmSelf.h;
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const d = Math.hypot(px - worldX, py - worldY);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI < 0 || bestD > spacing) return null;
    return {
      h: h[bestI],
      temp: hmSelf.temp?.[bestI],
      prec: hmSelf.prec?.[bestI],
      biome: hmSelf.biome?.[bestI],
    };
  }

  // ============================================================
  // River Generation (v2)
  // ============================================================

  /** 陆地掩膜缓存（按 terrain 引用；同一份省集不可能"内容变了引用没变"） */
  let landMaskCacheRef = null;
  let landMaskCache = null;
  function landMaskFor(terrain) {
    if (landMaskCacheRef === terrain && landMaskCache) return landMaskCache;
    landMaskCache = buildLandMask(terrain);
    landMaskCacheRef = terrain;
    return landMaskCache;
  }

  function generateRivers(baseMapKey, opts = {}) {
    // 🔴 2026-10-14 重写：旧实现是「每个源头格全表扫描找最低邻居」= O(源头 × 格数 × 步数)。
    //    真实底图实测量级（desite 9975 格 / 399 源头；行星 26910 格 / 281 源头，
    //    单点全表 7.46 ms）→ **分钟级**，而它是同步跑的：点下按钮主线程就不再响应，
    //    用户看到"毫无征兆直接卡住"。算法与口径全部搬到纯函数层 `utils/riverTrace.js`
    //    （有独立的 Node 单测），这里只负责「取哪份高度图 + 注入陆地判定」。
    //
    // 🔴 2026-10-14 第二修（用户实测「河流依旧随机出海」）：把**陆地判定**注入追踪器，
    //    源头必须离海 ≥ 2 格。高程是格心采样，海岸线从格子里穿过 → 一批泡在水里的格子
    //    高度 ≥ 20，够高时就被当源头，河道从海边起步直接射进大洋。判定用省份多边形
    //    （= 画布上真正画出来的陆地；`utils/coastline.js` 的同一份实现，掩膜按 terrain
    //    引用缓存，不会每次点按钮都重建 415 个环的索引）。
    const hm = getHeightmapFor(baseMapKey);
    let hmForTrace = hm;
    let synthesized = null;
    if (!hasGrid(hm)) {
      // 🔴 2026-10-17 第八修·改向（暮雨原话：「司天自身的编辑能力必须过硬，
      //    **不要指望靠用户导出高度数据地图来救河流生成**」）。
      //    旧行为：`!hasGrid(hm)` → 直接 `no-heightmap` 拒绝。
      //    后果：用户在司天里自己画了一块大陆（有省份多边形 = 有陆地），点「自动河流」
      //    却被告知"没有地形"—— 等于核心能力只对**外部导入**的地图可用。
      //    现在：**按陆地轮廓推演一份地形**（`utils/terrainSynthesis.js`）当作追踪输入。
      //    ⚠️ 只读推演、**不写数据**（不碰 commitHeightmap / undo 栈）—— 用户没要求造地形，
      //       就不该悄悄改他的底图；回执里如实说明"这是按轮廓推的"。
      //    ⚠️ 想真正落库（进 undo、能被笔刷再编辑），走下面独立的
      //       `synthesizeBaseMapTerrain()`，那是**显式**动作。
      const terrain = baseMaps.value[baseMapKey]?.terrain;
      const mask = Array.isArray(terrain) && terrain.length ? landMaskFor(terrain) : null;
      synthesized = synthesizeHeightmapFromTerrain(terrain, {
        isLand: mask ? mask.lookup : undefined,
      });
      if (!synthesized) {
        return {
          rivers: [], ok: false, reason: 'no-terrain',
          message: '这张底图既没有地形高度图、也没有画好的陆地 —— 自动河流不知道从哪里流起。'
            + ' 先用「自由绘制 / 套索」画出一块大陆，再点自动河流。',
        };
      }
      hmForTrace = synthesized;
    }
    const passed = { ...opts };
    if (!passed.isLand) {
      const terrain = baseMaps.value[baseMapKey]?.terrain;
      if (Array.isArray(terrain) && terrain.length) passed.isLand = landMaskFor(terrain).lookup;
    }
    const r = traceRivers(hmForTrace, passed);
    // `synthesized` 透传给 UI：回执必须说清"地形是按轮廓推的"，不能让人以为数据里有地形
    return { ...r, ok: true, ...(synthesized ? { synthesized } : {}) };
  }

  /**
   * **按陆地轮廓生成并落库一份地形高度图**（2026-10-17 第八修·改向）。
   *
   * 与 `generateRivers` 里那次"临时推演"的区别：这是**显式动作**，结果写进底图
   * （走 `commitHeightmap` = 一条 undo），此后：
   *   · 「底图图层 → 地形高度 / 陆海底色」能看见地形；
   *   · 地形笔刷 / 平滑 / 分辨率调整 / 自动河流全都正常工作；
   *   · 用户可以在推演结果上继续手改（推演只是个**起点**，不是最终答案）。
   *
   * 为什么需要它（暮雨 2026-10-17）：「不要指望靠用户导出高度数据地图来救河流生成」——
   * 自建底图必须有本地起点：画完大陆 → 一键有地形 → 有河 → 再手调。
   *
   * @returns {{ok:boolean, reason?:string, message:string, cellCount?:number, spacing?:number}}
   */
  function synthesizeBaseMapTerrain(baseMapKey, opts = {}) {
    if (!guardWrite('按轮廓生成地形').ok) return { ok: false, reason: 'readonly', message: '只读：未打开项目' };
    const bm = baseMaps.value[baseMapKey];
    if (!bm) return { ok: false, reason: 'no-basemap', message: '先选一张底图' };
    if (hasGrid(getHeightmapFor(baseMapKey)) && !opts.force) {
      return {
        ok: false, reason: 'has-terrain',
        message: '这张底图已经有地形高度图了 —— 再生成会覆盖它（想覆盖请显式确认）。'
          + ' 想从零重来，先「底图图层」里检查现有地形，或新建一张底图。',
      };
    }
    const terrain = bm.terrain;
    const mask = Array.isArray(terrain) && terrain.length ? landMaskFor(terrain) : null;
    const syn = synthesizeHeightmapFromTerrain(terrain, {
      isLand: mask ? mask.lookup : undefined,
      cellSize: opts.cellSize,
    });
    if (!syn) {
      return {
        ok: false, reason: 'no-terrain',
        message: '还没有画好的陆地 —— 先用「自由绘制 / 套索」画出一块大陆，再生成地形。',
      };
    }
    const prev = getHeightmapFor(baseMapKey);
    const had = hasGrid(prev);
    // 🔴 2026-10-17 第八修·再修（用户实测：「现在地图上的改动全都无法撤销，撤销是灰色的」）：
    //    第一版我在这里**直接调 `commitHeightmap`**，没有套 `execute()` ——
    //    那是本项目明令禁止的写法（`undo.js` 的契约：数据修改必须发生在 redo 回调里）。
    //    后果：这次写盘**不进 undo 栈**，而且它与 undo 栈里记录的"旧高度图"对不上，
    //    用户随后就发现「撤销灰了、什么都没法撤」。
    //    现在按 `smoothBaseMapHeightmap` 的同一套写法收口：
    //      · `undo` 把**原来那份**（可能是 null）填回去，`touch:false` 不打时间戳；
    //      · `redo` 写入推演结果；
    //      · 之后 `saveScenarios()`。
    execute({
      type: 'synthesize-terrain',
      label: '按轮廓生成地形',
      undo: () => { commitHeightmap(baseMapKey, had ? prev : null, { touch: false }); },
      redo: () => { commitHeightmap(baseMapKey, syn); },
    });
    saveScenarios();
    // 回执要把**结构**也说清：v2 起推演地形不再是"坡面 + 噪声"，而是带山脉走向 / 高原面 / 裂谷。
    // 用户看不到这句就会以为"还是老样子"（而这三样正是他点名要的）。
    const st = syn.structure
      ? `，含山脉走向 ${syn.structure.rangeAxisDeg}° / 裂谷 ${syn.structure.rifts} 条 / 高原面 ${syn.structure.plateauCells} 格`
      : '';
    return {
      ok: true,
      cellCount: syn.cellCount,
      spacing: syn.effectiveCellSize,
      had,
      structure: syn.structure || null,
      message: `已按陆地轮廓生成地形：${syn.cellCount} 格 / 格距 ${syn.effectiveCellSize}`
        + `（最内陆 ${syn.maxInlandCells} 格）${st} —— 可用 Ctrl+Z 撤回，也可以拿地形笔刷继续改。`,
    };
  }

  /**
   * 🔴 **高度图分辨率**（P5，2026-10-14）—— 用户实测第 5、2 条：
   *    「地形模模糊糊」/「高度图分辨率帮我调整。注意性能」。
   *
   * 为什么必须做：真实底图的源网格是 **133×75 / spacing 14.4**（FMG 生成的），画到
   * 1900×1080 上**每格约 3.6 屏幕像素**，放大到 400% 时一格占满一屏。渲染侧其实已经在做
   * 子格双线性（`heightmapRaster` 平滑档），但**每一格的颜色是固定的** → 放大就是马赛克。
   * 唯一能真正改善的做法是让格子变密，即本函数。
   *
   * 三条纪律：
   *   ① **走 `commitHeightmap`**（绑定行星时写行星那份）—— 直接替换 `baseMaps[k].heightmap`
   *      就会在绑定态下"写进一份没人读的副本"（A1 的静默分裂，本项目踩过）；
   *   ② **一条 undo**，且撤销打 `touch:false`（不把 `updatedAt` 改脏 —— 与撤销语义一致）；
   *   ③ **先算账再动手**（`preview` 先给格数/内存/耗时档），超上限**拒绝**并给可行的倍数，
   *      绝不"先分配 60MB 再说"。
   *
   * ⚠️ **分辨率不增加信息**：双线性放大只是让同一片地形被更细地表达（海岸线不再沿格子走
   *    方块，河流追踪也能走得更细）。实测：1→2→4 倍时河条数 57→287→1089，而**最长河的世界
   *    长度几乎不变（111→120→110）**。要真正"更长的大河"，只能换更高分辨率的**源数据**。
   *
   * @param {string} baseMapKey
   * @param {number} factor 放大倍数（2~8）
   * @param {{dryRun?:boolean}} [opts]
   */
  function resampleBaseMapHeightmap(baseMapKey, factor, opts = {}) {
    const f = Math.round(Number(factor) || 0);
    const hm = getHeightmapFor(baseMapKey);
    if (!hasGrid(hm)) {
      return { ok: false, reason: 'no-heightmap', message: '这张底图还没有地形高度图 —— 没有东西可以放大分辨率' };
    }
    const cost = estimateResampleCost(hm, f);
    if (!cost.ok) return { ok: false, reason: 'cost', message: cost.message, cost };
    if (opts.dryRun) return { ok: true, dryRun: true, cost, message: cost.message };

    if (!guardWrite('调整高度图分辨率').ok) return { ok: false, reason: 'readonly', message: '只读：未打开项目' };
    const rr = resampleHeightmap(hm, f);
    if (!rr.ok) return { ok: false, reason: rr.reason, message: rr.message, cost };

    // 绑定行星时，引用会换 → 画布侧的陆地掩膜/空间索引缓存必须自己认出"引用变了"
    // （它们都按引用缓存，这里不需要额外做失效）。
    execute({
      type: 'resample-heightmap',
      label: `高度图分辨率 ×${f}（${fmtBytes(cost.dstBytes)}）`,
      undo: () => { commitHeightmap(baseMapKey, hm, { touch: false }); },
      redo: () => { commitHeightmap(baseMapKey, rr.heightmap); },
    });
    saveScenarios();
    return {
      ok: true,
      factor: f,
      cells: rr.stats.dstCells,
      cellsX: rr.heightmap.grid.cellsX,
      cellsY: rr.heightmap.grid.cellsY,
      spacing: rr.heightmap.grid.spacing,
      bytes: cost.dstBytes,
      message: `分辨率已改为 ${rr.heightmap.grid.cellsX}×${rr.heightmap.grid.cellsY}`
        + `（${rr.stats.dstCells} 格 / 格距 ${rr.heightmap.grid.spacing.toFixed(2)} 世界单位，约 ${fmtBytes(cost.dstBytes)}）`,
    };
  }

  /**
   * 地形平滑（P5 配套）—— 「地形模模糊糊、一块一块」的另一半。
   *
   * ⚠️ 只平滑 `h`；`temp/prec/biome` 是**派生量**，平滑完地形应让用户自己点「重算派生图层」。
   *    在这里顺手改气候/群系，会让"平滑地形"变成一次静默的气候改动（本项目最忌讳的那类）。
   * ⚠️ 「双击平滑」那条老路径（`heightMath.smoothHeightmap`）是 O(n²) 且**零调用** ——
   *    本轮不接它，接的是 `heightmapResample.smoothHeightmapGrid`（分离式盒滤波，O(n·半径)）。
   */
  function smoothBaseMapHeightmap(baseMapKey, { radius = 1, passes = 1 } = {}) {
    if (!guardWrite('平滑地形').ok) return { ok: false, reason: 'readonly', message: '只读：未打开项目' };
    const hm = getHeightmapFor(baseMapKey);
    if (!hasGrid(hm)) return { ok: false, reason: 'no-heightmap', message: '这张底图还没有地形高度图' };
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const rr = smoothHeightmapGrid(hm, { radius, passes });
    if (!rr.ok) return { ok: false, reason: rr.reason, message: rr.message };
    execute({
      type: 'smooth-heightmap',
      label: `平滑地形（半径 ${rr.stats.radius} × ${rr.stats.passes} 次）`,
      undo: () => { commitHeightmap(baseMapKey, hm, { touch: false }); },
      redo: () => { commitHeightmap(baseMapKey, rr.heightmap); },
    });
    saveScenarios();
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return {
      ok: true,
      cells: rr.stats.cells,
      elapsedMs: Math.round(t1 - t0),
      message: `已平滑地形（半径 ${rr.stats.radius} 格 × ${rr.stats.passes} 次，${rr.stats.cells} 格，${Math.round(t1 - t0)} ms）`
        + ` —— 气候/群系是派生量，需要的话请点「重算派生图层」`,
    };
  }

  function deriveAllLayers(baseMapKey) {
    if (!guardWrite('重算派生图层').ok) return null;   // 2026-10-08（B0）：补首行守卫 + 登记契约
    if (!hasGrid(getHeightmapFor(baseMapKey))) return null;
    const hm = getHeightmapFor(baseMapKey);
    const pts = hm.grid.points;
    const oldTemp = hm.temp ? new Float32Array(hm.temp) : null;
    const oldPrec = hm.prec ? new Float32Array(hm.prec) : null;
    const oldBiome = hm.biome ? new Uint8Array(hm.biome) : null;
    const derived = deriveLayers(hm.h, pts, null, null);

    execute({
      type: 'derive-layers',
      label: '重算派生图层',
      undo: () => { commitHeightmap(baseMapKey, { ...hm, temp: oldTemp, prec: oldPrec, biome: oldBiome }, { touch: false }); },
      redo: () => { commitHeightmap(baseMapKey, { ...hm, temp: derived.temperature, prec: derived.precipitation, biome: derived.biome }); },
    });
    saveScenarios();
    return derived;
  }

  return {
    baseMaps,
    getHeightmapFor,
    commitHeightmap,
    createBaseMapHeightmap,
    getBoundPlanetId,
    getBaseMapsBoundToPlanet,
    bindBaseMapToPlanet,
    unbindBaseMap,
    importHeightmapFromPlanet,
    describeBaseMapTerrain, scenarios,
    addBaseMap, removeBaseMap, addBaseProvince, updateBaseProvince, removeBaseProvince,
    // 底图级数据（高度图 / 河流 / 道路 / 城镇）的装载与**只补缺刷新**（B2，2026-10-11）
    buildBaseMapFromBundle, updateBaseMapData,
    // 底图侧河流 / 道路 CRUD（D，2026-10-11）：此前手画的河从不落盘、手画的路绕过 undo
    addBaseMapRiver, removeBaseMapRiver, updateBaseMapRiver,
    removeBaseMapRivers, applyBaseMapRiverPatches, applyBaseMapRiverEdit,
    addBaseMapRoute, removeBaseMapRoute,
    updateBaseMapBurg,
    // 压叠预检（只读）：顶点编辑在**落库前**量一次，判定单源仍在纯函数层
    previewProvinceOverlap,
    splitBaseProvince, mergeBaseProvinces,
    addBaseReferenceImage, updateBaseReferenceImage, removeBaseReferenceImage,
    createScenario, updateScenario, removeScenario, inheritScenario,
    setOwnership, clearOwnership, batchSetOwnership,
    setPolityLineage, setChangeEvents, setChangeEventsBulk, updatePolity, addPolity, removePolity,
    // 事件账本（2026-10-22，三刀序列·第一刀）：外交/战争/同盟的录入、修改、删除与只读查询
    // （全部一条 undo；校验/排序/关系计算在 utils/scenarioEventLedger.js）
    addTimelineEvent, updateTimelineEvent, removeTimelineEvent, setTimelineEvents,
    queryRelationAt, auditTimelineEvents,
    // 切片书签（项目级时间点）：CRUD 各走一条 undo；区间归属运行时判定、不落盘
    slicePoints, sanitizeSlicePoints,
    addSlicePoint, renameSlicePoint, updateSlicePoint, removeSlicePoint,
    // 项目装载/快照回放/导入的**统一迁移口**（内部已带 normalizeScenarioDates，绝不要另写一份）
    applyScenarioState,
    exportScenariosPayload, auditScenariosPayload, importScenariosPayload, removeAllScenarios,
    addScenarioLabel, removeScenarioLabel, addScenarioMarker, removeScenarioMarker,
    importFromScenariosJson, importPlanetLayerData, loadScenarioState,
    applyHeightBrush, applyBiomeBrush, getHeightAt, generateRivers, deriveAllLayers,
    // 2026-10-17 第八修·改向：自建底图的**本地地形起点**（按陆地轮廓生成，落库进 undo）
    synthesizeBaseMapTerrain,
    // P5（2026-10-14）：高度图分辨率与平滑 —— 「地形模模糊糊」的入口
    resampleBaseMapHeightmap, smoothBaseMapHeightmap, estimateResampleCost,
    getDeriveStats,
    addBaseMapBurg, applyCultureBrush, applyReligionBrush,
    getBaseMap, getScenario, getScenariosByOwner, getBaseMapsList, getAllScenarios,
  };
}
