// interaction/misc.js — 剧本视图（N1 第三阶段批处理，2026-10-31）
//
// 由 `build/_extract_batch.mjs` 从 ScenarioMap.vue 原样搬出：ctxDeleteProvince / clearAllScenarios / getAutoRiverNetwork / getDisplayRivers / finishDraw / removeSelectedRiverNode / riversInBox / traceShapePath / findBurgAt / polityLabelSources / switchGroup / onDeletePolity / applyLandmassResult / synthesizeBaseMapTerrainFromShape。
// 依赖约定：`st` = 手势/工具期的普通 `let`（组件侧带 get/set，读写同一份）；
//   其余 ref / const / 函数走 `ctx`；纯函数工具直接 import。

import { DEFAULT_SCENARIO_GROUP } from '../../utils/scenarioGroups';
import { buildSkeleton, conformToSkeleton } from '../../utils/provinceShape';
import { clipPolylinesToCoast, clipSegmentToLand } from '../../utils/coastline';
import { collapseReversedRiverPoints } from '../../utils/riverRender';
import { currentOwnerRef, isStriped } from '../../utils/scenarioTimeline';
import { nextProvinceColor } from '../../utils/scenarioPalette';

export function createMiscActions(ctx) {
  const { st, ...rest } = ctx;
  const {
    BURG_HIT_RADIUS,
    SNAP_EDGE_THRESHOLD,
    activeGroupId,
    addProvinceWithOverlapGate,
    allSortedScenarios,
    autoRiverSegments,
    autoRivers,
    baseMap,
    baseMapHasHeightmap,
    baseMapKey,
    burgs,
    cameraScale,
    cameraX,
    cameraY,
    contextMenu,
    drawPoints,
    focusNewProvince,
    getLandMask,
    groupNameOf,
    landmassOpen,
    makeRiverLandCheck,
    rasterCache,
    rasterLayer,
    render,
    riverActiveNode,
    riverNodesForRender,
    scenarios,
    segmentHitsBox,
    selectScenarioAt,
    selectedPolity,
    selectedProvince,
    selectedRiver,
    selectedScenario,
    showProps,
    sortedScenarios,
    statusMsg,
    store,
    terrainShade,
    timeline,
    tlDate,
    tlDiffMode,
    tlEra,
    tlPlaying,
    vx,
    vy,
  } = rest;

function ctxDeleteProvince() {
  const prov = selectedProvince.value;
  if (!prov) { contextMenu.value.show = false; return; }
  if (!confirm(`确定删除省份「${prov.name}」？\n\n该省在各剧本里的势力归属与易主年份会一并清空（可用 Ctrl+Z 整体撤回）。`)) {
    contextMenu.value.show = false;
    return;
  }
  if (store.isReadOnly) {
    statusMsg(`删除省份已停用：${store.readOnlyReason || '只读：未打开项目'}`);
    contextMenu.value.show = false;
    return;
  }
  const r = store.removeBaseProvince(baseMapKey.value, prov.id);
  statusMsg(r && r.cascadedScenarios
    ? `已删除省份「${prov.name}」（连带清理 ${r.cascadedScenarios} 个剧本里的归属键，可 Ctrl+Z 撤回）`
    : `已删除省份「${prov.name}」`);
  selectedProvince.value = null;
  showProps.value = false;
  render();
  contextMenu.value.show = false;
}

function clearAllScenarios() {
  if (store.isReadOnly) {
    statusMsg(`清空剧本已停用：${store.readOnlyReason || '只读：未打开项目'}`);
    return;
  }
  const n = allSortedScenarios.value.length;
  if (!n) return;
  const okGo = window.confirm(
    `清空全部 ${n} 条剧本（所有剧本集）？\n\n`
    + '只删剧本本身（名称 / 年份 / 势力归属 / 易主记录 / 标注与标记）。\n'
    + '**底图与省份边界一个都不动** —— 省份还在，可以直接用「批量铺底 (A)」重切。\n'
    + '剧本集本身保留（只是会变成空组）。\n\n'
    + '这一步可以用 Ctrl+Z 撤销。'
  );
  if (!okGo) { statusMsg(`已取消清空（仍有 ${n} 条剧本）`); return; }
  store.removeAllScenarios();
  // 选中引用必须重指向：清空后所有剧本都没了，留着旧对象会让属性区读一个已不存在的剧本
  selectedScenario.value = sortedScenarios.value[0] || null;
  render();
  statusMsg(`已清空 ${n} 条剧本（底图、省份与剧本集保留）—— Ctrl+Z 可撤销`);
}

function getAutoRiverNetwork() {
  const rivers = autoRivers.value || [];
  const terrain = baseMap.value?.terrain || null;
  if (st.autoRiverNetCache.rivers === rivers && st.autoRiverNetCache.terrain === terrain) return st.autoRiverNetCache.out;
  const raw = autoRiverSegments.value || [];
  const mask = getLandMask();
  let out = raw;
  const isLand = makeRiverLandCheck(mask);
  if (isLand && raw.length) {
    // 只对"末端在海里"的段做裁剪（绝大多数段两端都在陆地 = 一次判定就放过）
    const kept = [];
    for (const seg of raw) {
      if (!seg.endInSea) { kept.push(seg); continue; }
      const clipped = clipSegmentToLand(seg, isLand);
      if (clipped) kept.push(clipped);
    }
    out = kept;
  }
  st.autoRiverNetCache = { terrain, rivers, out };
  return out;
}

function getDisplayRivers() {
  const rivers = baseMap.value?.rivers || [];
  const terrain = baseMap.value?.terrain || null;
  // 🔴 2026-10-21：`.map` 导入的河是「去 + 原路回」的闭合往返（160/160 实测），
  //    不折成中心线就会画成两条平行线（用户截图里的"从某个节点开始分支"）。
  //    在**显示列表**里折，不改用户数据；手画河（river_ 前缀）原样。
  // 🔴 缓存检查必须在**折叠/裁剪之前**：160 条河的全点折叠是每帧 20~25ms（CPU 采样实测），
  //    之前放在命中判断前 = 缓存白做。
  if (st.displayRiverCache.rivers === rivers && st.displayRiverCache.terrain === terrain) return st.displayRiverCache.out;
  const imported = rivers
    .filter((r) => r && String(r.id || '').indexOf('river_') !== 0)
    .map((r) => ({ ...r, points: collapseReversedRiverPoints(r.points) }));
  let out = imported;
  const mask = getLandMask();
  if (mask && imported.length) {
    // keepOvershoot = 0.6 格：让河口"咬"住海面一点点，贴死在岸线上会显得河没入海
    out = clipPolylinesToCoast(imported, mask.lookup, { keepOvershoot: 8 }).list;
  }
  st.displayRiverCache = { terrain, rivers, out };
  return out;
}

function finishDraw() {
  const id = `prov_${Date.now()}`;
  // ① 先贴**共享边界骨架**（P0 第二块）：相邻省份的轮廓走同一条线 → 零缝。
  //    只吸端点会在两省之间斜切一条缝，`conformToSkeleton` 是「整段插中间顶点」。
  const rawPts = drawPoints.value.map(p => ({ x: p.x, y: p.y }));
  const skeleton = buildSkeleton(baseMap.value?.terrain || []);
  const conformed = skeleton.length ? conformToSkeleton(rawPts, skeleton, SNAP_EDGE_THRESHOLD) : rawPts;
  // ② T8：不再自动写贝塞尔控制点 —— 数据多边形 = 渲染边界 = 布尔/命中几何。
  //    想要平滑轮廓时，用户点顶点（withBezierControls，/6 夹紧）显式加手柄。
  const points = conformed;
  const count = baseMap.value?.terrain?.length || 0;
  const name = `新省份 ${count + 1}`;
  const prov = { id, name, kind: 'land', color: nextProvinceColor(count), points };
  // 描点路径同样走压叠闸门（两条建省路径必须同一套判定 —— 只守一条 = 另一条照样压上去）
  const created = addProvinceWithOverlapGate(prov);
  drawPoints.value = [];
  if (!created) { render(); return; }
  focusNewProvince(id, prov);
  render();
}

function removeSelectedRiverNode(index = -1) {
  const r = selectedRiver.value;
  if (!r) return false;
  const nodes = r.points || [];
  const i = index >= 0 ? index : (riverActiveNode.value >= 0 ? riverActiveNode.value : -1);
  if (i < 0 || i >= nodes.length) {
    statusMsg('删节点：先用鼠标点一下要删的那个节点（或把光标移到它上面），再按 Delete');
    return false;
  }
  const res = store.updateBaseMapRiver(baseMapKey.value, r.id, {}, { removeNodeAt: i });
  if (res && res.ok && res.changed) {
    riverActiveNode.value = -1;
    statusMsg(`已删掉第 ${i + 1} 个节点（剩 ${res.nodeCount} 个，已重新平滑）—— Ctrl+Z 可撤回，Delete 空手再按一次=删整条河`);
    render();
    return true;
  }
  statusMsg(`节点没删掉：${(res && res.message) || '未知原因'}`);
  render();
  return false;
}

function riversInBox(box) {
  const out = [];
  for (const r of (baseMap.value?.rivers) || []) {
    const pts = riverNodesForRender(r);
    if (!pts || pts.length < 2) continue;
    let hit = false;
    for (let i = 0; i < pts.length && !hit; i++) {
      const p = pts[i];
      const inBox = p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
      if (inBox) { hit = true; break; }
      if (i + 1 < pts.length) {
        const q = pts[i + 1];
        if (segmentHitsBox(p.x, p.y, q.x, q.y, box)) hit = true;
      }
    }
    if (hit) out.push(r.id);
  }
  return out;
}

function traceShapePath(c, points, close = true) {
  const n = points.length;
  if (n < 2) return;
  c.moveTo(vx(points[0]), vy(points[0]));
  const last = close ? n : n - 1;
  for (let i = 1; i <= last; i++) {
    const prev = points[(i - 1) % n];
    const cur = points[i % n];
    const o = prev.controlOut;
    const k = cur.controlIn;
    if (!st.altStraight && o && k) {
      c.bezierCurveTo(vx(prev) + o.x, vy(prev) + o.y, vx(cur) + k.x, vy(cur) + k.y, vx(cur), vy(cur));
    } else {
      c.lineTo(vx(cur), vy(cur));
    }
  }
}

function findBurgAt(sx, sy) {
  const list = burgs.value;
  if (!list.length) return null;
  const r2 = BURG_HIT_RADIUS * BURG_HIT_RADIUS;
  let best = null;
  let bestD = Infinity;
  for (let pass = 1; pass >= 0; pass--) {
    for (const b of list) {
      if ((b.capital ? 1 : 0) !== pass) continue;
      const dx = cameraX.value + b.x * cameraScale.value - sx;
      const dy = cameraY.value + b.y * cameraScale.value - sy;
      const d = dx * dx + dy * dy;
      if (d <= r2 && d < bestD) { bestD = d; best = b; }
    }
    if (best) return best;
  }
  return null;
}

function polityLabelSources() {
  const tl = timeline.value;
  const k = tlEra.value;
  const at = tlDate.value;
  if (tl.scenarios.length) {
    const ownerRefOf = (pid) => {
      if (tlDiffMode.value === 'eu4' && isStriped(tl, k, pid, at)) {
        return { owner: tl.scenarios[k - 1]?.ownership?.[pid], era: k - 1 };
      }
      return currentOwnerRef(tl, k, pid, at);
    };
    return { ownerRefOf, polityOfEra: (era, owner) => tl.scenarios[era]?.polities?.find(p => p.id === owner) || null };
  }
  const sc = selectedScenario.value;
  return {
    ownerRefOf: (pid) => ({ owner: sc?.ownership?.[pid], era: -1 }),
    polityOfEra: (_era, owner) => sc?.polities?.find(p => p.id === owner) || null,
  };
}

function switchGroup(gid) {
  const id = String(gid || DEFAULT_SCENARIO_GROUP);
  if (id === activeGroupId.value) return;
  activeGroupId.value = id;
  const list = sortedScenarios.value;
  if (list.length) {
    selectScenarioAt(list[0]);
  } else {
    selectedScenario.value = null;
    selectedPolity.value = null;
    tlEra.value = 0;
    tlPlaying.value = false;
    tlDate.value = { y: 0, m: null, d: null };
    render();
  }
  statusMsg(`已切到剧本集「${groupNameOf(id)}」${list.length ? `（${list.length} 条剧本）` : '（空）'}`);
}

function onDeletePolity() {
  const polity = selectedPolity.value;
  const sc = selectedScenario.value;
  if (!polity || !sc) return;
  // 二次确认必须**点名影响面**：删势力会连带清掉它占着的省份归属（一条 undo 可整体还原）
  const owned = Object.values(sc.ownership || {}).filter(pid => pid === polity.id).length;
  const msg = owned
    ? `删除势力「${polity.name}」？\n\n它当前占着 ${owned} 个省份 —— 这些省的归属会一并清空（画布上变灰）。\n可用 Ctrl+Z 整体撤回。`
    : `删除势力「${polity.name}」？\n\n它当前没有占任何省份。可用 Ctrl+Z 撤回。`;
  if (!confirm(msg)) return;
  const r = store.removePolity(sc.id, polity.id);
  if (!r || !r.success) { statusMsg('删除势力失败'); return; }
  selectedPolity.value = null;
  statusMsg(`已删除势力「${r.name}」（连带清空 ${r.affected} 个省的归属，可 Ctrl+Z 撤回）`);
  render();
}

function applyLandmassResult(r) {
  rasterCache.clear();  // v4.3（2026-10-26）：造陆现在会顺手落一张**地形高度图**（合成地形），所以画布可以直接
  // 切到"高度"着色 —— 用户点完就能看见山，而不是一张纯色扁平图。
  // 高度图不在（旧数据 / 被拒写）时退回"陆海"底色，行为与以前一致。
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  const hasHm = !!(hm && hm.grid && (hm.grid.points || []).length);
  rasterLayer.value = hasHm ? 'height' : 'landsea';
  // 同时打开「立体」（山体阴影）：高度图只有分层设色时，山地与平地同样是"一片色"，
  // 用户原话「看不出地形」。⚠️ 全局默认仍是**关**（既有底图不擅自改观感，
  // 见 `terrainShade` 的注释）；这里只是在"刚造完陆、正在看地形"的这一刻替用户打开。
  if (hasHm) terrainShade.value = true;
  landmassOpen.value = false;
  statusMsg(hasHm
    ? `${(r && r.message) || '已造陆'}（已切到「高度」着色 + 开启「立体」）`
    : ((r && r.message) || '已造陆'));
  render();
}

function synthesizeBaseMapTerrainFromShape() {
  const had = !!baseMapHasHeightmap.value;
  if (had && !confirm(
    '这张底图已经有地形高度图了。\n\n'
    + '「按轮廓生成地形」会用**推演结果替换**现有地形（可 Ctrl+Z 撤回）。\n'
    + '已有的手工涂改会一并被替换。\n\n'
    + '继续吗？',
  )) return;
  const r = store.synthesizeBaseMapTerrain(baseMapKey.value, { force: had });
  if (!r || r.ok === false) {
    statusMsg((r && r.message) || '生成地形失败');
    return;
  }
  rasterCache.clear();          // 地形换了 → 栅格缓存必须失效（否则画布还是旧图）
  rasterLayer.value = 'height'; // 生成完直接切到"地形高度"，让用户看见结果
  statusMsg(r.message);
  render();
}

  return { ctxDeleteProvince, clearAllScenarios, getAutoRiverNetwork, getDisplayRivers, finishDraw, removeSelectedRiverNode, riversInBox, traceShapePath, findBurgAt, polityLabelSources, switchGroup, onDeletePolity, applyLandmassResult, synthesizeBaseMapTerrainFromShape };
}
