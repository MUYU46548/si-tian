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

    saveScenarios();
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

    saveScenarios();
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
    const beforeChangeEvents = JSON.parse(JSON.stringify(scenario.changeEvents || {}));
    const nextOwnership = { ...beforeOwnership };
    const nextChangeEvents = JSON.parse(JSON.stringify(beforeChangeEvents));

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

    saveScenarios();
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

    const apply = (polities, ownership, changeEvents, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const nextSc = { ...cur, polities, ownership, changeEvents };
      if (touch) nextSc.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
    };

    execute({
      type: 'remove-polity',
      label: `删除势力：${target.name || polityId}`,
      undo: () => apply(beforePolities, beforeOwnership, beforeChangeEvents, false),
      redo: () => apply(nextPolities, nextOwnership, nextChangeEvents, true),
    });

    saveScenarios();
    return { success: true, affected: affected.length, affectedProvinceIds: affected, name: target.name || polityId };
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
   */
  function importPlanetLayerData(planetId, data) {
    if (!guardWrite('导入 .map 图层').ok) return;
    if (!planetId || !data) return;
    const map = mapData.value?.[planetId];
    if (!map) return;

    // 补充省份多边形（按政治实体/文化/宗教分组）
    if (data.provinces && Array.isArray(data.provinces)) {
      map.azgaarProvinces = data.provinces.map(p => ({
        id: p.id,
        name: p.name || '',
        points: p.points || [],
        stateId: p.stateId || 0,
        cultureId: p.cultureId || 0,
        religionId: p.religionId || 0,
        color: p.color || p.stateColor || p.cultureColor || '#888888',
      }));
    }

    // 补充政治实体数据
    if (data.states && Array.isArray(data.states)) {
      map.azgaarStates = data.states.map(s => ({
        id: s.id || s.i,
        name: s.name || ('State ' + (s.id || s.i)),
        color: s.color || '#888888',
      }));
    }

    // 补充文化数据
    if (data.cultures && Array.isArray(data.cultures)) {
      map.azgaarCultures = data.cultures.map(c => ({
        id: c.id || c.i,
        name: c.name || ('Culture ' + (c.id || c.i)),
        color: c.color || '#888888',
      }));
    }

    // 补充宗教数据
    if (data.religions && Array.isArray(data.religions)) {
      map.azgaarReligions = data.religions.map(r => ({
        id: r.id || r.i,
        name: r.name || ('Religion ' + (r.id || r.i)),
        color: r.color || '#888888',
      }));
    }

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
    return normalizeScenarioDict(list).scenarios;
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
  saveScenarios();
}

function applyCultureBrush(baseMapKey, cx, cy, radius, cultureKey) {
  if (!hasGrid(getHeightmapFor(baseMapKey))) return;

  const hm = getHeightmapFor(baseMapKey);
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
  if (!hasGrid(getHeightmapFor(baseMapKey))) return;

  const hm = getHeightmapFor(baseMapKey);
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

  function generateRivers(baseMapKey) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!hasGrid(getHeightmapFor(baseMapKey))) return [];
    const hm = getHeightmapFor(baseMapKey);
    const pts = hm.grid.points;
    const n = pts.length;
    const rivers = [];
    const visited = new Set();

    const sources = [];
    for (let i = 0; i < n; i++) {
      if (hm.h[i] > 60) sources.push(i);
    }

    for (const src of sources) {
      if (visited.has(src)) continue;
      const river = [src];
      let current = src;
      let steps = 0;
      while (hm.h[current] >= SEA_LEVEL && steps < 200) {
        visited.add(current);
        const cx = Array.isArray(pts[current]) ? pts[current][0] : pts[current].x;
        const cy = Array.isArray(pts[current]) ? pts[current][1] : pts[current].y;
        let lowest = -1, lowestH = hm.h[current];
        for (let j = 0; j < n; j++) {
          if (j === current) continue;
          const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
          const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
          const d = Math.hypot(qx - cx, qy - cy);
          if (d < (hm.grid.spacing || 14.4) * 1.5 && hm.h[j] < lowestH) {
            lowestH = hm.h[j];
            lowest = j;
          }
        }
        if (lowest < 0) break;
        river.push(lowest);
        current = lowest;
        steps++;
      }
      if (river.length > 3) rivers.push(river.map(i => ({ x: pts[i][0], y: pts[i][1] })));
    }

    return rivers;
  }

  function deriveAllLayers(baseMapKey) {
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
    splitBaseProvince, mergeBaseProvinces,
    addBaseReferenceImage, updateBaseReferenceImage, removeBaseReferenceImage,
    createScenario, updateScenario, removeScenario, inheritScenario,
    setOwnership, clearOwnership, batchSetOwnership,
    setPolityLineage, setChangeEvents, setChangeEventsBulk, updatePolity, addPolity, removePolity,
    // 切片书签（项目级时间点）：CRUD 各走一条 undo；区间归属运行时判定、不落盘
    slicePoints, sanitizeSlicePoints,
    addSlicePoint, renameSlicePoint, updateSlicePoint, removeSlicePoint,
    // 项目装载/快照回放/导入的**统一迁移口**（内部已带 normalizeScenarioDates，绝不要另写一份）
    applyScenarioState,
    exportScenariosPayload, auditScenariosPayload, importScenariosPayload, removeAllScenarios,
    addScenarioLabel, removeScenarioLabel, addScenarioMarker, removeScenarioMarker,
    importFromScenariosJson, importPlanetLayerData, loadScenarioState,
    applyHeightBrush, applyBiomeBrush, getHeightAt, generateRivers, deriveAllLayers,
    getDeriveStats,
    addBaseMapBurg, applyCultureBrush, applyReligionBrush,
    getBaseMap, getScenario, getScenariosByOwner, getBaseMapsList, getAllScenarios,
  };
}
