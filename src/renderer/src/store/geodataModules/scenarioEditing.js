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

export function createScenarioEditingModule(ctx) {
  const { execute, scheduleAutoSave, saveScenarios, scheduleAutoSaveScenarios, mapData, scheduleAutoSaveMap } = ctx;

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

    // 🔴 级联（2026-10-01）：`scenarios[*].ownership` 的**键就是省份 id**（不是节点 id ——
    //    见 `idRefDicts()` 的注释），`changeYears` 同理。删省不摘这两个键 = 留下指向
    //    不存在省份的孤儿键：画布上看不见（渲染按 `terrain` 遍历），却仍参与 `groupMap`
    //    分组、`summarizeLineages` 的省列表与谱系继承的重叠度计算 → 观感是「势力继承
    //    关系莫名断裂/粘连」。与 R7「删节点清孤儿数据」同一条纪律：**级联必须同一条 undo**。
    const cascadeBefore = {};
    for (const [scId, sc] of Object.entries(scenarios.value || {})) {
      if (!sc || sc.ownerKey !== baseMapKey) continue;
      const own = sc.ownership || {};
      const cy = sc.changeYears || {};
      const hasOwner = Object.prototype.hasOwnProperty.call(own, provinceId);
      const hasCY = Object.prototype.hasOwnProperty.call(cy, provinceId);
      if (hasOwner || hasCY) {
        cascadeBefore[scId] = { hasOwner, owner: own[provinceId], hasCY, changeYear: cy[provinceId] };
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
        const changeYears = { ...(sc.changeYears || {}) };
        const rec = cascadeBefore[scId];
        if (mode === 'remove') {
          delete ownership[provinceId];
          delete changeYears[provinceId];
        } else {
          if (rec.hasOwner) ownership[provinceId] = rec.owner;
          if (rec.hasCY) changeYears[provinceId] = rec.changeYear;
        }
        next[scId] = { ...sc, ownership, changeYears };
      }
      scenarios.value = next;
    };

    execute({
      type: 'remove-province',
      label: '删除省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: [...baseMaps.value[baseMapKey].terrain, oldProv],
          },
        };
        applyCascade('restore');
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain.filter(p => p.id !== provinceId),
            updatedAt: new Date().toISOString(),
          },
        };
        applyCascade('remove');
      },
    });
    
    saveScenarios();
    return { success: true, cascadedScenarios: Object.keys(cascadeBefore).length };
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

    // ⚠️ 刻意**不**继承 `changeYears`（2026-10-02 复核后维持原行为）：易主年份的语义是
    //    「该省在**本剧本年代区间内**哪一年换的主」。继承来的日期一律落在**上一个**剧本的区间里，
    //    对新剧本而言按定义就是越界数据（`utils/scenarioSlices.js#changeDateStats` 会把它标出来）。
    //    与其造一批越界日期，不如让新剧本走自动推算，由用户在「势力谱系管理 → 易主年份」里录真值。
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
  // Ownership（EU4 省份染色）
  // ============================================================
  
  /**
   * 指派势力。可选 changeYear：把「易主年份」一并记为显式值 ——
   * 这是 changeYear 最自然的录入路径：把游标拖到某年再上色 = 该年易主。
   */
  function setOwnership(scenarioId, provinceId, polityId, changeYear) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldOwner = scenario.ownership?.[provinceId] || null;
    const oldCY = scenario.changeYears?.[provinceId];
    const hadOldCY = oldCY !== undefined;
    const writeCY = typeof changeYear === 'number' && Number.isFinite(changeYear);

    execute({
      type: 'set-ownership',
      label: writeCY ? '指派势力（含易主年份）' : '指派势力',
      undo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (hadOldCY) changeYears[provinceId] = oldCY; else delete changeYears[provinceId];
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: oldOwner },
            changeYears,
          },
        };
      },
      redo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (writeCY) changeYears[provinceId] = changeYear;
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: polityId },
            changeYears,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    saveScenarios();
  }

  function clearOwnership(scenarioId, provinceId, changeYear) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldOwner = scenario.ownership?.[provinceId];
    if (!oldOwner) return;

    const oldCY = scenario.changeYears?.[provinceId];
    const hadOldCY = oldCY !== undefined;
    const writeCY = typeof changeYear === 'number' && Number.isFinite(changeYear);

    execute({
      type: 'clear-ownership',
      label: '清除归属',
      undo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (hadOldCY) changeYears[provinceId] = oldCY; else delete changeYears[provinceId];
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: oldOwner },
            changeYears,
          },
        };
      },
      redo: () => {
        const sc = scenarios.value[scenarioId];
        const { [provinceId]: _, ...rest } = sc.ownership;
        const changeYears = { ...(sc.changeYears || {}) };
        if (writeCY) changeYears[provinceId] = changeYear;
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: rest,
            changeYears,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    saveScenarios();
  }

  function batchSetOwnership(scenarioId, provinceIds, polityId, changeYear) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldOwnership = { ...scenario.ownership };
    const oldChangeYears = { ...(scenario.changeYears || {}) };
    const newOwnership = { ...scenario.ownership };
    provinceIds.forEach(id => { newOwnership[id] = polityId; });
    const writeCY = typeof changeYear === 'number' && Number.isFinite(changeYear);
    const newChangeYears = { ...oldChangeYears };
    if (writeCY) provinceIds.forEach(id => { newChangeYears[id] = changeYear; });

    execute({
      type: 'batch-ownership',
      label: '批量指派',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenarios.value[scenarioId], ownership: oldOwnership, changeYears: oldChangeYears },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            ownership: newOwnership,
            changeYears: newChangeYears,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    saveScenarios();
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
   *    `changeYears` 同理按省份 id 记显式易主年份。只把 polity 从数组里摘掉，
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
    const beforeChangeYears = JSON.parse(JSON.stringify(scenario.changeYears || {}));
    const nextPolities = list.filter(p => p.id !== polityId);

    const affected = Object.entries(beforeOwnership)
      .filter(([, pid]) => pid === polityId)
      .map(([provId]) => provId);
    const nextOwnership = { ...beforeOwnership };
    const nextChangeYears = { ...beforeChangeYears };
    for (const provId of affected) {
      delete nextOwnership[provId];
      delete nextChangeYears[provId];
    }

    const apply = (polities, ownership, changeYears, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const nextSc = { ...cur, polities, ownership, changeYears };
      if (touch) nextSc.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
    };

    execute({
      type: 'remove-polity',
      label: `删除势力：${target.name || polityId}`,
      undo: () => apply(beforePolities, beforeOwnership, beforeChangeYears, false),
      redo: () => apply(nextPolities, nextOwnership, nextChangeYears, true),
    });

    saveScenarios();
    return { success: true, affected: affected.length, affectedProvinceIds: affected, name: target.name || polityId };
  }

  /** 显式设置/清除某省的易主年份（走 undo）。year=null 表示删除显式值（回到自动推算） */
  function setProvinceChangeYear(scenarioId, provinceId, year) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldCY = scenario.changeYears?.[provinceId];
    const hadOldCY = oldCY !== undefined;
    const write = typeof year === 'number' && Number.isFinite(year);

    execute({
      type: 'set-change-year',
      label: '设置易主年份',
      undo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (hadOldCY) changeYears[provinceId] = oldCY; else delete changeYears[provinceId];
        scenarios.value = { ...scenarios.value, [scenarioId]: { ...sc, changeYears } };
      },
      redo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (write) changeYears[provinceId] = year; else delete changeYears[provinceId];
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...sc, changeYears, updatedAt: new Date().toISOString() },
        };
      },
    });

    saveScenarios();
  }

  /**
   * 批量写 / 清易主年份（**一条 undo**）—— 日期录入的批量入口。
   *
   * 为什么必须有批量口：`computeEraChanges` 在缺显式值时会**均匀铺开**一个合成年份。
   * 一个一个改（`setProvinceChangeYear`）会出现：① N 个省 = N 条 undo（`MAX_HISTORY=100`
   * 会把更早的几何操作静默挤出栈）；② 「把这一代都定在某年」这类操作要写 N 遍。
   *
   * @param {string} scenarioId
   * @param {Record<string, number|null>} patch 省份 id → 年份；null / 非有限数字 = **删除**显式值
   * @returns {{success:boolean, changed?:number, cleared?:number, noop?:boolean, reason?:string}}
   */
  function setChangeYears(scenarioId, patch) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return { success: false, reason: 'no-scenario' };

    const before = { ...(scenario.changeYears || {}) };
    const next = { ...before };
    let changed = 0;
    let cleared = 0;
    for (const [pid, y] of Object.entries(patch || {})) {
      const write = typeof y === 'number' && Number.isFinite(y);
      const had = Object.prototype.hasOwnProperty.call(before, pid);
      if (write) {
        if (before[pid] === y) continue;      // 值没变就不算改动
        next[pid] = y;
        changed++;
      } else {
        if (!had) continue;                   // 本来就没有显式值 → 没什么可清
        delete next[pid];
        cleared++;
      }
    }
    if (!changed && !cleared) return { success: true, changed: 0, cleared: 0, noop: true };

    // 整表快照式 undo（与 removePolity 同形）：重编号改的是「别的键」，差量还原不了
    const apply = (changeYears, touch) => {
      const cur = scenarios.value[scenarioId];
      if (!cur) return;
      const nextSc = { ...cur, changeYears };
      if (touch) nextSc.updatedAt = new Date().toISOString();
      scenarios.value = { ...scenarios.value, [scenarioId]: nextSc };
    };

    execute({
      type: 'set-change-years',
      label: `批量设置易主年份（改 ${changed} / 清 ${cleared} 省）`,
      undo: () => apply(before, false),
      redo: () => apply(next, true),
    });

    saveScenarios();
    return { success: true, changed, cleared };
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
    const nextMaps = mode === 'replace'
      ? JSON.parse(JSON.stringify(inMaps || {}))
      : { ...snapMaps, ...JSON.parse(JSON.stringify(inMaps || {})) };
    const nextScen = mode === 'replace'
      ? JSON.parse(JSON.stringify(inScen || {}))
      : { ...snapScen, ...JSON.parse(JSON.stringify(inScen || {})) };

    const addedMaps = Object.keys(nextMaps).filter(k => !snapMaps[k]).length;
    const addedScen = Object.keys(nextScen).filter(k => !snapScen[k]).length;

    const gate = execute({
      type: 'import-scenarios',
      label: mode === 'replace' ? '导入剧本（替换）' : '导入剧本（合并）',
      undo: () => {
        baseMaps.value = snapMaps;
        scenarios.value = snapScen;
      },
      redo: () => {
        baseMaps.value = nextMaps;
        scenarios.value = nextScen;
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

  function removeScenarioLabel(scenarioId, labelId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const oldLabel = (scenario.labels || []).find(l => l.id === labelId);
    if (!oldLabel) return;
    
    execute({
      type: 'remove-label',
      label: '删除地名',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            labels: [...(scenarios.value[scenarioId].labels || []), oldLabel],
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            labels: (scenarios.value[scenarioId].labels || []).filter(l => l.id !== labelId),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
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

  function removeScenarioMarker(scenarioId, markerId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const oldMarker = (scenario.markers || []).find(m => m.id === markerId);
    if (!oldMarker) return;
    
    execute({
      type: 'remove-marker',
      label: '删除标记',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            markers: [...(scenarios.value[scenarioId].markers || []), oldMarker],
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            markers: (scenarios.value[scenarioId].markers || []).filter(m => m.id !== markerId),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  // ============================================================
  // Import/Load
  // ============================================================
  
  function importFromScenariosJson(data) {
    if (!guardWrite('导入剧本').ok) return null;
    if (data.baseMaps) {
      baseMaps.value = { ...baseMaps.value, ...data.baseMaps };
    }
    if (data.scenarios) {
      scenarios.value = { ...scenarios.value, ...data.scenarios };
    }
    saveScenarios();
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
    if (data.scenarios) scenarios.value = data.scenarios;
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
    setPolityLineage, setProvinceChangeYear, setChangeYears, updatePolity, addPolity, removePolity,
    exportScenariosPayload, auditScenariosPayload, importScenariosPayload, removeAllScenarios,
    addScenarioLabel, removeScenarioLabel, addScenarioMarker, removeScenarioMarker,
    importFromScenariosJson, importPlanetLayerData, loadScenarioState,
    applyHeightBrush, applyBiomeBrush, getHeightAt, generateRivers, deriveAllLayers,
    getDeriveStats,
    addBaseMapBurg, applyCultureBrush, applyReligionBrush,
    getBaseMap, getScenario, getScenariosByOwner, getBaseMapsList, getAllScenarios,
  };
}
