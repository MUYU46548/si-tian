// interaction/provinceOps.js — 剧本视图（N1 第三阶段批处理，2026-10-31）
//
// 由 `build/_extract_batch.mjs` 从 ScenarioMap.vue 原样搬出：handleSplitClick / ctxDuplicateProvince / addProvinceWithOverlapGate / buildProvincePath / confirmVertexBatchOverlap / beginVertexLinkContext / confirmVertexMoveOverlap / buildLinkedPreview。
// 依赖约定：`st` = 手势/工具期的普通 `let`（组件侧带 get/set，读写同一份）；
//   其余 ref / const / 函数走 `ctx`；纯函数工具直接 import。

import { findLinkedVertices, shiftPoints } from '../../utils/vertexSharing';
import { pointInProvince, provinceBBox, provinceRings, ringPointsForRender, shapePatch } from '../../utils/provinceShape';

export function createProvinceOps(api) {
  const { st, ...rest } = api;
  const {
    VERTEX_OVERLAP_WORSEN_MARGIN,
    activeRingIdx,
    baseMap,
    baseMapKey,
    coincidentIndexFor,
    contextMenu,
    ctx: ctxRef,
    effectiveVertexSelection,
    provIdxOf,
    provinceBrush,
    px,
    render,
    resolvePoints,
    selectedProvince,
    splitPoints,
    splitStep,
    statusMsg,
    store,
    vx,
    vy,
  } = rest;

function handleSplitClick(world, shiftKey) {
  if (splitStep.value === 0) {
    splitPoints.value = [world];
    splitStep.value = 1;
    statusMsg('拆分：再点第二个点定义切割线（按住 Shift = 让另一侧保留原序号）');
    render();
    return;
  }
  const p1 = splitPoints.value[0];
  const p2 = world;
  splitStep.value = 0;
  splitPoints.value = [];
  if (store.isReadOnly) { statusMsg(`拆分已停用：${store.readOnlyReason}`); render(); return; }
  // 目标省份：两点之一落在它里面即可（多环 / 带洞口径由纯函数层统一）
  const target = (baseMap.value?.terrain || []).find(
    (q) => provinceRings(q).length
      && (pointInProvince(p1.x, p1.y, q) || pointInProvince(p2.x, p2.y, q)));
  if (!target) { statusMsg('拆分：两个点要落在同一个省份上'); render(); return; }
  const res = store.splitProvince(baseMapKey.value, target.id, p1, p2, { side: shiftKey ? -1 : 1 });
  if (!res || res.blocked || res.rejected) {
    statusMsg((res && res.message) || '拆分失败：切割线没有穿过这个省份（两点要落在它两侧）');
    render();
    return;
  }
  provinceBrush.invalidateBorders();
  const which = res.side === -1 ? '另一侧' : '起始侧（a）';
  statusMsg(`已把「${target.name}」拆成两块：${which}保留原序号「${target.name}」，`
    + '另一半追加到表尾 — 一次拆分 = 1 条撤销（按住 Shift 可换边）');
  render();
}

function ctxDuplicateProvince() {
  if (!selectedProvince.value) return;
  const prov = selectedProvince.value;
  // 偏移量取「包围盒 span 的 5%，但不小于 20 屏幕像素」——旧实现固定 `px(20)`：
  // 该省的边界在屏幕上只有几个像素的位移，副本几乎**完全压在原省身上**（看不见、点不到、
  // 又要过压叠闸门），"复制省份"等于没复制。现在至少挪开可见的一段。
  const bb = provinceBBox(prov);
  const span = bb ? Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) : 0;
  const offset = Math.max(px(20), span * 0.05);
  // 🔴 `fromGrid` 必须跟着走：丢了它，渲染端会认为这是"手绘环"→ **不做 Chaikin 平滑**
  //    （手绘/贝塞尔环故意不平滑），于是"复制一个网格派生的省"得到一个马赛克台阶省。
  const rings = provinceRings(prov).map((r) => ({
    kind: r.kind,
    fromGrid: !!r.fromGrid,
    points: r.points.map(q => ({ x: vx(q) + offset, y: vy(q) + offset })),
  }));
  const id = `prov_${Date.now()}`;
  // 复制是**明确的用户动作**（本来就要一个副本），且已挪开可见距离 → 不再过压叠闸门
  const r = store.addBaseProvince(baseMapKey.value, {
    id, name: prov.name + ' 副本', ...shapePatch(rings),
    biome: prov.biome, culture: prov.culture,
  }, { allowOverlap: true });
  statusMsg(r && r.success === false
    ? `复制省份失败：${r.message || r.rejected}`
    : `已复制「${prov.name}」→「${prov.name} 副本」（偏移 ${Math.round(offset)} 世界单位，可 Ctrl+Z 撤回）`);
  render();
  contextMenu.value.show = false;
}

function addProvinceWithOverlapGate(prov) {
  const r = store.addBaseProvince(baseMapKey.value, prov);
  if (r && r.rejected === 'overlap') {
    const pct = Math.round((r.ratio || 0) * 100);
    const names = (r.offenders || []).slice(0, 3).map(o => o.name).join('、');
    // 🔴 压叠率很高时，**「再建一个」根本不是正解** —— 说明这块地已被一个省占满
    //    （真实案例：导入的底图把整块大陆做成一个省，用户在图里画哪儿都 100% 压叠，
    //    连试几次都只能点「确定」硬压，然后以为「司天不能画省份」）。
    //    这时该引导他去**拆分**那个大省，而不是批准又一次叠罗汉。
    const tip = pct >= 80
      ? '（这块地已被一个省占满 —— 更合适的做法是用「拆分」(X) 把它切开，而不是叠一个新省上去）'
      : '（创建后可用「改形状」(G) 调整，或用「删除」(E) 去掉）';
    if (!confirm(`${r.message}\n\n压叠 ${pct}%${names ? `（${names}）` : ''}。仍要在这里创建吗？\n${tip}`)) {
      statusMsg(`已取消创建：「${prov.name}」压在已有省份上（${pct}%）`);
      return null;
    }
    const r2 = store.addBaseProvince(baseMapKey.value, prov, { allowOverlap: true });
    statusMsg(`已按确认创建「${prov.name}」——与已有省份压叠 ${pct}%，记得稍后调整`);
    return r2;
  }
  if (r && r.success === false) {
    statusMsg(`新建省份失败：${r.message || r.rejected || '未知原因'}`);
    return null;
  }
  return r;
}

function buildProvincePath(prov, straight) {
  const rings = provinceRings(prov);
  const path = new Path2D();
  let any = false;
  for (const r of rings) {
    const pts = ringPointsForRender(r);
    if (!pts || pts.length < 3) continue;
    const n = pts.length;
    path.moveTo(vx(pts[0]), vy(pts[0]));
    for (let i = 1; i <= n; i++) {
      const prev = pts[(i - 1) % n];
      const cur = pts[i % n];
      const o = prev.controlOut;
      const k = cur.controlIn;
      if (!straight && o && k) {
        path.bezierCurveTo(vx(prev) + o.x, vy(prev) + o.y, vx(cur) + k.x, vy(cur) + k.y, vx(cur), vy(cur));
      } else {
        path.lineTo(vx(cur), vy(cur));
      }
    }
    path.closePath();
    any = true;
  }
  return any ? path : null;
}

function confirmVertexBatchOverlap(entries) {
  const worsened = [];
  for (const e of (entries || [])) {
    const after = { ...e.prov, ...e.patch };
    const res = store.previewProvinceOverlap(baseMapKey.value, after, { skipId: e.prov.id });
    if (!res || !res.blocked) continue;
    const prev = store.previewProvinceOverlap(baseMapKey.value, e.prov, { skipId: e.prov.id });
    const prevRatio = (prev && prev.ok) ? prev.ratio : 0;
    const delta = res.ratio - prevRatio;
    if (delta <= VERTEX_OVERLAP_WORSEN_MARGIN) continue;
    const names = (res.offenders || []).slice(0, 3)
      .map((o) => `${o.name}${o.kind === 'sea' ? '（海域）' : ''}`).join('、');
    worsened.push({ name: e.prov.name || e.prov.id, pct: Math.round(res.ratio * 100), prevPct: Math.round(prevRatio * 100), names });
  }
  if (!worsened.length) return true;
  const lines = worsened.slice(0, 4).map((w) => `「${w.name}」压叠 ${w.pct}%（拖动前 ${w.prevPct}%）${w.names ? `：${w.names}` : ''}`).join('\n');
  const okApply = window.confirm(
    `这次拖动会让跟随移动的邻省压到别的省身上：\n\n${lines}\n\n`
    + '压叠会让点选、归属上色和势力标签互相打架。\n\n'
    + '点「确定」= 应用这次移动；点「取消」= 放弃（目标省与邻省都保持拖动前，什么都不写）。'
  );
  if (okApply) return true;
  statusMsg(`已放弃这次顶点移动（会让 ${worsened.length} 个邻省压到别人身上）`);
  return false;
}

function beginVertexLinkContext(prov, vertexIdx) {
  const terrain = baseMap.value?.terrain || [];
  const provIdx = provIdxOf(prov);
  if (provIdx < 0) return null;
  const selection = effectiveVertexSelection(vertexIdx);
  const built = coincidentIndexFor(terrain);
  const found = findLinkedVertices(terrain, { provIdx, ringIdx: activeRingIdx.value }, selection, built);
  return {
    provId: prov.id,
    provIdx,
    ringIdx: activeRingIdx.value,
    selection,
    basePoints: resolvePoints(prov).map((p) => {
      const q = { x: vx(p), y: vy(p) };
      if (p && p.controlIn) q.controlIn = { ...p.controlIn };
      if (p && p.controlOut) q.controlOut = { ...p.controlOut };
      return q;
    }),
    links: found.links,
    truncated: found.truncated,
    sharedCount: found.sharedCount,
  };
}

function confirmVertexMoveOverlap(before, after) {
  const res = store.previewProvinceOverlap(baseMapKey.value, after, { skipId: before.id });
  if (!res || !res.blocked) return true;
  const prev = store.previewProvinceOverlap(baseMapKey.value, before, { skipId: before.id });
  const worsened = res.ratio - ((prev && prev.ok) ? prev.ratio : 0);
  if (worsened <= VERTEX_OVERLAP_WORSEN_MARGIN) return true;
  const pct = Math.round(res.ratio * 100);
  const prevPct = Math.round(((prev && prev.ok) ? prev.ratio : 0) * 100);
  const names = (res.offenders || []).slice(0, 3)
    .map(o => `${o.name}${o.kind === 'sea' ? '（海域）' : ''}`).join('、');
  const okApply = window.confirm(
    `这次顶点移动让「${before.name || before.id}」与已有省份压叠 ${pct}%`
    + `（拖动前 ${prevPct}%）${names ? `：${names}` : ''}。\n\n`
    + '压叠会让点选、归属上色和势力标签互相打架。\n\n'
    + '点「确定」= 应用这次移动；点「取消」= 放弃这次移动（形状保持拖动前）。'
  );
  if (okApply) {
    statusMsg(`已应用顶点移动 —— 与「${names || '已有省份'}」压叠 ${pct}%（拖动前 ${prevPct}%），记得稍后调整`);
    return true;
  }
  statusMsg(`已放弃这次顶点移动（会把「${before.name || before.id}」压到「${names || '已有省份'}」上 ${pct}%）`);
  return false;
}

function buildLinkedPreview(prov, delta) {
  const ctxRef = st.vertexLinkCtx;
  if (!ctxRef || !ctxRef.links.length || ctxRef.provId !== prov.id) return [];
  const terrain = baseMap.value?.terrain || [];
  const groups = new Map();   // provId → { rings: Map<ringIdx, moves[]> }
  for (const l of ctxRef.links) {
    const p = terrain[l.provIdx];
    if (!p) continue;
    let g = groups.get(p.id);
    if (!g) { g = { rings: new Map() }; groups.set(p.id, g); }
    let moves = g.rings.get(l.ringIdx);
    if (!moves) { moves = []; g.rings.set(l.ringIdx, moves); }
    // 差量 = 参考顶点的位移 + 两侧本来的偏差（本仓纪律：差量平移，不写同一个绝对坐标）
    moves.push({ idx: l.vertexIdx, dx: delta.x + l.dx, dy: delta.y + l.dy });
  }
  const out = [];
  for (const [provId, g] of groups) {
    const p = terrain.find((x) => x.id === provId);
    if (!p) continue;
    const rings = provinceRings(p);
    const ringsOut = [];
    for (const [ringIdx, moves] of g.rings) {
      const ring = rings[ringIdx] || rings[0];
      if (!ring) continue;
      ringsOut.push({ ringIdx, points: shiftPoints(ring.points, moves) });
    }
    if (ringsOut.length) out.push({ provId, rings: ringsOut });
  }
  return out;
}

  return { handleSplitClick, ctxDuplicateProvince, addProvinceWithOverlapGate, buildProvincePath, confirmVertexBatchOverlap, beginVertexLinkContext, confirmVertexMoveOverlap, buildLinkedPreview };
}
