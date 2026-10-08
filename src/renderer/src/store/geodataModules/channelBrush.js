// store/geodataModules/channelBrush.js — 高度图**逐格 Uint8 通道笔刷**（文化 / 宗教）
//
// ctx: { mapData, execute, scheduleAutoSaveMap, loadMapData? }
//
// ── 这个模块解决什么（2026-10-08，A3）─────────────────────────────────────────
// 行星主编辑器（`PlanetMap`）此前只有 高度 / 群系 / 地表类型 / 地貌 / 河流 几支笔刷，
// **没有文化 / 宗教**（`interactionMode` 里有 height/terrain/relief/river/political，无 culture/religion；
// 渲染侧 `drawCultureReligionRegions` 画的是 Azgaar 导入的参考数据，与用户自己的数据无关）。
// 剧本侧早就有 `applyCultureBrush` / `applyReligionBrush`，本模块把那套能力**按同一份数据模型**
// 补到行星侧。
//
// ── 为什么不是"抄一份剧本侧的实现"（设计取向）────────────────────────────────
// 剧本侧那两个函数的形态是「**每次 mousemove 都 execute 一次** + 靠 `merge` 合栈」，
// 每一次移动都会全量拷贝一遍通道数组（26910 格 × 2 次）并整体替换 heightmap 对象。
// 本模块改用**本项目自己已经验证过的**「抬手 diff」模式
// （`provinceEditing.applyProvinceStroke` / `endProvinceStroke`，2026-09-20 起在生产跑）：
//
//   1. `beginChannelStroke` —— 只建一个**非响应式**的差量账本（`Map<格下标, 旧值>`）
//   2. `applyChannelStroke` —— 涂抹期**就地**改通道数组（不换引用、不碰 Vue 响应式、不 execute）
//      每格**首见即记旧值** —— 这正是 patch 的 `from`，一笔的账本大小 = 真正改过的格数
//   3. `endChannelStroke` —— 抬手把整笔压成**一条** undo，并把结果提交落盘
//
// 为什么必须"就地改数组、不能换引用"：画布与用例持有的是同一个 `Uint8Array` 引用，
// 换新数组会让它们读到旧数据（本项目在 `provinceEditing` 的注释里已记过这条坑）。
//
// ── 数据模型（与 `biome` 同构）────────────────────────────────────────────────
//   `mapData[planetId].heightmap.culture` / `.religion` = `Uint8Array(grid.points.length)`
//     · 0 = 无主
//     · v ≥ 1 = **位置**下标，对应 `mapData[planetId].cultures[v-1]` / `.religions[v-1]`
//       （⚠️ 用位置不用 `id`：那边的 `id` 是 `Date.now()`，塞不进 Uint8Array —— 见 heightmapChannels.js）
//
// ── 唯一写口 ─────────────────────────────────────────────────────────────────
// 只有 `endChannelStroke` 会写 store（→ 已登记 `writeGate.MEMORY_WRITE_CALLSITES` id 9）。
// 涂抹期改的是内存里的通道数组，所以 `beginChannelStroke` 也做了首行 `guardWrite`：
// 没有它，只读态会「涂了一堆、看着生效、其实永不落盘」——正是本项目最忌讳的静默失败。

import { guardWrite } from '../writeGate';
import {
  CHANNEL_LABELS, CHANNEL_LIST_KEY, isChannelKey, normalizeChannel,
} from '../../utils/heightmapChannels';
import { nearestIndexAt } from '../../utils/heightmapAccess';
import { buildGridIndex, collectInRadius, pointXY } from '../../utils/gridSpatialIndex';
import { brushFalloff } from '../../utils/heightMath';

export function createChannelBrushModule(ctx) {
  const { mapData, execute, scheduleAutoSaveMap } = ctx;

  /** 当前笔画：`{ planetId, channel, cells: Map<下标, 旧值>, afterWrite }`（**非响应式**） */
  let stroke = null;
  // 空间索引缓存（只依赖 grid.points 与 spacing，与通道值无关）
  let indexCache = null;

  function labelOf(channel) {
    return (CHANNEL_LABELS[channel] || '通道') + '笔刷';
  }

  /** 行星地图数据（含可用高度图）*/
  function entryOf(planetId) {
    const md = mapData.value[planetId];
    if (!md || !md.heightmap || !md.heightmap.grid) return null;
    if (!Array.isArray(md.heightmap.grid.points) || md.heightmap.grid.points.length === 0) return null;
    return md;
  }

  function indexOf(hm) {
    const pts = hm.grid.points;
    if (indexCache && indexCache.pts === pts) return indexCache.index;
    const index = buildGridIndex(hm.grid);
    indexCache = { pts, index };
    return index;
  }

  /**
   * 取通道数组；缺失/形态不对（落盘读回是普通数组、或历史事故里的 `{0:..}`）就按长度补一条零值。
   * ⚠️ 只改内存、**不落盘** —— 落盘由 `endChannelStroke` 的唯一下载口负责。
   */
  function ensureChannelArray(hm, channel) {
    const count = hm.grid.points.length;
    const norm = normalizeChannel(hm[channel], count);
    if (norm) { hm[channel] = norm; return norm; }
    const fresh = new Uint8Array(count);
    hm[channel] = fresh;
    return fresh;
  }

  // ===== 只读：供渲染 / 图例 / 吸管 / 用例 =====

  /** 通道数组（活引用；调用方不要改它）。缺失或长度不符返回 null（**不**顺手造零值） */
  function readChannel(planetId, channel) {
    if (!isChannelKey(channel)) return null;
    const md = entryOf(planetId);
    if (!md) return null;
    return normalizeChannel(md.heightmap[channel], md.heightmap.grid.points.length);
  }

  /** 元数据列表（文化 / 宗教）：`mapData[pid].cultures` / `.religions` */
  function getChannelList(planetId, channel) {
    if (!isChannelKey(channel)) return [];
    const key = CHANNEL_LIST_KEY[channel];
    const list = mapData.value[planetId] && mapData.value[planetId][key];
    return Array.isArray(list) ? list : [];
  }

  /** 取值统计（图例 / 用例断言用）：`{ total, assigned, counts: {值: 格数} }` */
  function channelStats(planetId, channel) {
    const arr = readChannel(planetId, channel);
    if (!arr) return null;
    const counts = {};
    let assigned = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v) assigned++;
      counts[v] = (counts[v] || 0) + 1;
    }
    return { total: arr.length, assigned, counts };
  }

  /**
   * 吸管：取落点最近一格的各通道值（**纯读，不过写闸门 —— 它不是写操作**）。
   * 用 `nearestIndexAt`（`utils/heightmapAccess.js`）这个唯一实现找最近点，
   * 避免"吸管吸到的格"与"笔刷刷到的格"口径漂移。
   */
  function pickChannelCell(planetId, x, y) {
    const md = entryOf(planetId);
    if (!md) return null;
    const hm = md.heightmap;
    const i = nearestIndexAt(hm.grid, x, y);
    if (i < 0) return null;
    const at = (ch) => (hm[ch] && hm[ch].length === hm.grid.points.length ? (hm[ch][i] | 0) : 0);
    return {
      index: i,
      h: hm.h ? hm.h[i] : null,
      temp: hm.temp ? hm.temp[i] : null,
      prec: hm.prec ? hm.prec[i] : null,
      biome: hm.biome ? (hm.biome[i] | 0) : 0,
      culture: at('culture'),
      religion: at('religion'),
    };
  }

  // ===== 笔画生命周期：一次拖动 = 一条 undo =====

  /**
   * 落笔。返回 `{ ok, reason?, count?, added? }`。
   * @param {string} planetId
   * @param {'culture'|'religion'} channel
   * @param {{afterWrite?: () => void}} [opts] `afterWrite` 在 undo/redo 回放后调用（画布重绘）
   */
  function beginChannelStroke(planetId, channel, opts = {}) {
    // 首行守卫：涂抹期会就改内存，拒绝必须发生在任何写入之前
    if (!guardWrite(labelOf(channel)).ok) return { ok: false, reason: 'readonly' };
    if (!isChannelKey(channel)) return { ok: false, reason: 'bad-channel' };
    const md = entryOf(planetId);
    if (!md) return { ok: false, reason: 'no-heightmap' };
    const hm = md.heightmap;
    const existed = !!normalizeChannel(hm[channel], hm.grid.points.length);
    const arr = ensureChannelArray(hm, channel);
    stroke = { planetId, channel, cells: new Map(), afterWrite: opts.afterWrite || null };
    return { ok: true, count: arr.length, added: !existed };
  }

  /**
   * 涂抹（每次 mousemove 调用）。就地改数组 + 记账本，**不 execute、不落盘**。
   * @param {number} hardness 0~1：落笔中心的"硬边"程度（0 = 整个半径内都涂；越大越只涂中心）
   * @returns {number} 本次真正改掉的格数
   */
  function applyChannelStroke(planetId, channel, x, y, radius, hardness, value) {
    if (!stroke || stroke.planetId !== planetId || stroke.channel !== channel) return 0;
    const md = entryOf(planetId);
    if (!md) return 0;
    const hm = md.heightmap;
    const arr = ensureChannelArray(hm, channel);
    const pts = hm.grid.points;
    const idx = indexOf(hm);
    const target = (Number(value) | 0) & 0xff;
    const cut = Math.min(Math.max(Number(hardness) || 0, 0), 0.95);

    let touched = 0;
    for (const i of collectInRadius(idx, x, y, radius)) {
      const [px, py] = pointXY(pts[i]);
      const dist = Math.hypot(px - x, py - y);
      if (dist >= radius) continue;
      if (brushFalloff(radius, dist) < cut) continue;
      if (arr[i] === target) continue;
      if (!stroke.cells.has(i)) stroke.cells.set(i, arr[i]);   // 首见旧值 = patch 的 from
      arr[i] = target;                                          // 就地改，**不换引用**
      touched++;
    }
    return touched;
  }

  /**
   * 抬手：把整笔压成**一条** undo，并把结果提交落盘（本模块的唯一写口）。
   * @returns {{changed:number,label:string,channel:string,planetId:string}|null}
   */
  function endChannelStroke() {
    // 首行守卫（与 `beginChannelStroke` 成对）：落笔后若项目被关/切成只读，
    // 这里拒绝提交并把内存改回原样 —— 绝不留下"看着改了、其实永不落盘"的半截编辑。
    if (!guardWrite(stroke ? labelOf(stroke.channel) : '通道笔刷').ok) {
      const s0 = stroke; stroke = null;
      if (s0 && s0.cells.size) {
        const md0 = entryOf(s0.planetId);
        if (md0) {
          const arr0 = ensureChannelArray(md0.heightmap, s0.channel);
          for (const [i, old] of s0.cells) arr0[i] = old;
        }
      }
      return null;
    }
    const s = stroke;
    stroke = null;
    if (!s || !s.cells.size) return null;
    const md = entryOf(s.planetId);
    if (!md) return null;
    const hm = md.heightmap;
    const arr = ensureChannelArray(hm, s.channel);

    // 只保留真的变了的格（涂抹可能反复回到旧值）
    const entries = [];
    for (const [i, old] of s.cells) {
      const now = arr[i];
      if (old !== now) entries.push([i, old, now]);
    }
    if (!entries.length) return null;

    const { planetId, channel, afterWrite } = s;
    const label = labelOf(channel);

    // which: 1 = 旧值（undo） / 2 = 新值（redo）
    const applyValues = (which, touch) => {
      const mdNow = entryOf(planetId);
      if (!mdNow) return;
      const hmNow = mdNow.heightmap;
      const arrNow = ensureChannelArray(hmNow, channel);
      for (const e of entries) arrNow[e[0]] = e[which];
      // 与 commitHeightmap 同口径：undo **不打** updatedAt（逐字段与改动前一致），redo 打
      const stamp = touch ? { updatedAt: new Date().toISOString() } : {};
      mapData.value[planetId] = {
        ...mdNow,
        heightmap: { ...hmNow, [channel]: arrNow },
        ...stamp,
      };
      if (scheduleAutoSaveMap) scheduleAutoSaveMap(planetId);
      if (afterWrite) {
        try { afterWrite(); } catch (e) { /* 重绘回调失败不该影响数据 */ }
      }
    };

    const gate = execute({
      type: 'channel-brush',
      label,
      undo: () => applyValues(1, false),
      redo: () => applyValues(2, true),
    });

    if (gate && gate.ok === false) {
      // 极端：落笔后被切成只读（项目被关）→ 把内存改回原样，不留半截编辑
      for (const e of entries) arr[e[0]] = e[1];
      return null;
    }
    return { changed: entries.length, label, channel, planetId };
  }

  /** 中止笔画（Esc / 工具切换）：把内存改回原样，**不进 undo 栈** */
  function cancelChannelStroke() {
    const s = stroke;
    stroke = null;
    if (!s || !s.cells.size) return 0;
    const md = entryOf(s.planetId);
    if (!md) return 0;
    const arr = ensureChannelArray(md.heightmap, s.channel);
    for (const [i, old] of s.cells) arr[i] = old;
    return s.cells.size;
  }

  function isChannelStroking() { return !!stroke; }

  return {
    readChannel,
    getChannelList,
    channelStats,
    pickChannelCell,
    beginChannelStroke,
    applyChannelStroke,
    endChannelStroke,
    cancelChannelStroke,
    isChannelStroking,
  };
}
