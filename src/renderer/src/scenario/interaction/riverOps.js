// interaction/riverOps.js — 剧本视图（N1 第三阶段批处理，2026-10-31）
//
// 由 `build/_extract_batch.mjs` 从 ScenarioMap.vue 原样搬出：applyRiverPick / deleteSelectedRiver / commitRiverDrag / drawOneHandRiver / withBezierControls / onBatchSeedClick / updateCursor / onSetChangeDatesBulk。
// 依赖约定：`st` = 手势/工具期的普通 `let`（组件侧带 get/set，读写同一份）；
//   其余 ref / const / 函数走 `ctx`；纯函数工具直接 import。

import { RIVER_BANK_COLOR, RIVER_DRAW_COLOR, drawCurvedRiver } from '../../utils/riverRender';

export function createRiverOps(ctx) {
  const { st, ...rest } = ctx;
  const {
    PROVINCE_GRID_TOOLS,
    RIVER_CURVE_SUBDIV,
    baseMap,
    baseMapKey,
    batchSeeds,
    batchStatus,
    canvas,
    closeMarkerEditor,
    px,
    render,
    riverDrag,
    riverSelIds,
    riverWidthsFor,
    selectedProvince,
    selectedRiver,
    setRiverSelection,
    showProps,
    statusMsg,
    store,
    toggleRiverSelection,
    tool,
    vx,
    vy,
  } = rest;

function applyRiverPick(id, shift = false) {
  const r = ((baseMap.value?.rivers) || []).find((x) => x && x.id === id);
  if (!r) return false;
  if (shift) {
    const added = toggleRiverSelection(id);
    statusMsg(`已${added ? '加选' : '移出'}河流「${r.name || '未命名'}」`
      + `（当前选中 ${riverSelIds().length} 条）—— Delete 批量删 / 或点「裁到海岸线」`);
  } else {
    setRiverSelection([id], id);
    const imported = String(r.id || '').indexOf('river_') !== 0;
    statusMsg(`已选中${imported ? '导入' : ''}河流「${r.name || '未命名'}」（${(r.points || []).length} 个点）`
      + (imported
        ? ' —— 上面有一条操作栏：删除 / 裁海岸线 / 取消选中（Esc 同效）；导入河不支持拖节点'
        : ' —— 上面有一条操作栏：删除 / 编辑节点 / 裁海岸线 / 取消选中（Esc 同效）'));
  }
  selectedProvince.value = null;
  showProps.value = false;
  closeMarkerEditor();
  render();
  return true;
}

function deleteSelectedRiver() {
  const ids = riverSelIds();
  if (!ids.length) { statusMsg('没有选中的河流：先用鼠标点一下要删的那条河（或 Shift+拖动框选一批）'); return false; }
  // 多选 → 整批一条撤销（用户的心智模型是"删掉这次选中的这 N 条"）
  if (ids.length > 1) {
    const res = store.removeBaseMapRivers(baseMapKey.value, ids);
    setRiverSelection([]);
    statusMsg(res && res.ok
      ? `已删除 ${res.count} 条河流（${res.removed.slice(0, 3).join('、')}${res.count > 3 ? '…' : ''}）—— Ctrl+Z 一次性撤回`
      : `批量删除失败：${(res && res.message) || '未知原因'}`);
    render();
    return !!(res && res.ok);
  }
  const r = selectedRiver.value;
  if (!r) { statusMsg('没有选中的河流：先用鼠标点一下要删的那条河'); return false; }
  const res = store.removeBaseMapRiver(baseMapKey.value, r.id);
  setRiverSelection([]);
  statusMsg(res && res.ok
    ? `已删除河流「${res.removed || '未命名'}」—— Ctrl+Z 可撤回`
    : `删除失败：${(res && res.message) || '未知原因'}`);
  render();
  return !!(res && res.ok);
}

function commitRiverDrag() {
  const drag = riverDrag.value;
  riverDrag.value = null;
  const r = selectedRiver.value;
  if (!drag || !r || drag.riverId !== r.id) return false;
  const nodes = (drag.points || []).map((p) => ({ x: p.x, y: p.y }));
  const changed = JSON.stringify(nodes) !== JSON.stringify(drag.oldNodes);
  if (!changed) {
    render();                                       // 草稿可能动过又回来：把画面还回真值
    return false;                                   // 只是点了一下没拖 → 不留一条空撤销
  }
  const res = store.updateBaseMapRiver(baseMapKey.value, r.id, { points: nodes }, {});
  if (res && res.ok && res.changed) {
    statusMsg(`已移动第 ${drag.index + 1} 个节点（一次拖动 = 1 条撤销）`);
    render();
    return true;
  }
  if (res && !res.ok) statusMsg(`节点没移动：${res.message || '未知原因'}`);
  render();
  return false;
}

function drawOneHandRiver(c, nodes, river, opts = {}) {
  if (!nodes || nodes.length < 2) return 0;
  const widths = riverWidthsFor(river, nodes.length);
  // ⚠️ 曲线在 `drawCurvedRiver` 里生成（它内部就是 `catmullRomPoints(..., subdiv)`），
  //    这里**不要**先自己加密一遍 —— 那会变成"对已经加密过的点再加密"（点数平方级）
  const res = drawCurvedRiver(c, nodes, widths[0], widths[widths.length - 1], {
    // 🔴 2026-10-20 第十七修：把**逐点宽度**整个交给渲染器（以前只传头尾两个数）——
    //    `riverWidthsFor` 里已经算好的 `widthFactors`（速度→宽度）此前到不了画布：
    //    内部 `taperWidths` 会按头→尾重新插值，把中段的因子抹平。
    //    现在 `drawCurvedRiver` 用 `widths` 数组按曲线长度线性重采样。
    widths,
    toPx: (w) => w,
    subdiv: RIVER_CURVE_SUBDIV,
    color: opts.color || RIVER_DRAW_COLOR,
    bankColor: opts.bankColor || RIVER_BANK_COLOR,
    // 🔴 2026-10-20：默认**不画岸线**（用户反复报的「两条边夹一条缝 / 铁轨」）。
    //    需要堤岸的调用方显式传 bankPx。
    bankPx: opts.bankPx === undefined ? 0 : opts.bankPx,
    // 不透明（同 `strokeTaperedLine`）：接缝叠自己不改颜色，半透明会压出深色细芯
    alpha: opts.alpha === undefined ? 1 : opts.alpha,
  });
  return res.drawn;
}

function withBezierControls(points) {
  const n = points.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (p.controlIn && p.controlOut) { out[i] = p; continue; }
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    // 🔴 T8（S0 实测）：旧实现用 (next-prev)/3，是标准 Catmull-Rom（/6）的两倍，
    //    角上外鼓 6%~30%，且布尔/命中只按顶点算 → “看到的边界 ≠ 算到的边界”。
    //    这里改 /6，并按相邻两段长度夹紧（不均匀 RDP 点也能兜住），仍保留手工顶点平滑能力。
    let dx = (vx(next) - vx(prev)) / 6;
    let dy = (vy(next) - vy(prev)) / 6;
    const mag = Math.hypot(dx, dy);
    const cap = Math.min(
      Math.hypot(vx(p) - vx(prev), vy(p) - vy(prev)),
      Math.hypot(vx(next) - vx(p), vy(next) - vy(p)),
    ) / 3;
    if (mag > 1e-9 && mag > cap) { dx *= cap / mag; dy *= cap / mag; }
    out[i] = { x: vx(p), y: vy(p), controlOut: { x: dx, y: dy }, controlIn: { x: -dx, y: -dy } };
  }
  return out;
}

function onBatchSeedClick(world, remove) {
  if (store.isReadOnly) { statusMsg(`批量铺底已停用：${store.readOnlyReason}`); return; }
  if (remove) {
    // Alt/右键 = 删掉最近的一个种子点（够用且不会误删远处的）
    let best = -1, bd = Infinity;
    batchSeeds.value.forEach((p, i) => {
      const d = Math.hypot(p.x - world.x, p.y - world.y);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0 && bd < px(24)) {
      batchSeeds.value = batchSeeds.value.filter((_, i) => i !== best);
      batchStatus.value = `已去掉一个种子点（还剩 ${batchSeeds.value.length} 个）`;
    } else {
      statusMsg('批量铺底：这附近没有种子点');
    }
    render();
    return;
  }
  batchSeeds.value = [...batchSeeds.value, { x: world.x, y: world.y }];
  batchStatus.value = `手动种子 ${batchSeeds.value.length} 个（Alt+点击 / 右键可去掉一个）`;
  render();
}

function updateCursor() {
  if (!canvas.value) return;
  if (tool.value === 'select') canvas.value.style.cursor = 'grab';
  else if (tool.value === 'draw') canvas.value.style.cursor = 'crosshair';
  else if (tool.value === 'vertex') canvas.value.style.cursor = 'move';
  else if (tool.value === 'split') canvas.value.style.cursor = 'cell';
  else if (tool.value === 'polySplit') canvas.value.style.cursor = 'crosshair';
  else if (tool.value === 'voronoi') canvas.value.style.cursor = 'crosshair';
  else if (tool.value === 'outline') canvas.value.style.cursor = 'crosshair';   // E：描轮廓（与画省份同一手势）
  else if (tool.value === 'merge') canvas.value.style.cursor = 'pointer';
  else if (tool.value === 'paint') canvas.value.style.cursor = 'copy';
  else if (tool.value === 'label') canvas.value.style.cursor = 'text';
  else if (tool.value === 'erase') canvas.value.style.cursor = 'not-allowed';
  // 河流（2026-10-17）：十字准星＝可以画；指到节点上时换成 grab（见 onMouseMove）
  else if (tool.value === 'river') canvas.value.style.cursor = 'crosshair';
  else if (tool.value === 'riverErase') canvas.value.style.cursor = 'crosshair';
  else if (tool.value === 'height' || tool.value === 'biome' || tool.value === 'lake') canvas.value.style.cursor = 'none';
  else if (tool.value === 'ownerBrush') canvas.value.style.cursor = 'crosshair';
  else if (tool.value === 'provincePaint') canvas.value.style.cursor = 'none';   // 笔刷：由画布上的圈指示笔头
  else if (PROVINCE_GRID_TOOLS.has(tool.value)) canvas.value.style.cursor = 'crosshair';
  else canvas.value.style.cursor = 'default';
}

function onSetChangeDatesBulk({ scenarioId, patch, what = '批量设置易主日期' }) {
  if (store.isReadOnly) {
    statusMsg(`只读：${store.readOnlyReason || '未打开项目'} —— ${what}未写入`);
    return;
  }
  const r = store.setChangeEventsBulk(scenarioId, patch);
  if (!r || r.success === false) {
    statusMsg(`${what}失败：${r?.reason || '未知原因'}`);
    return;
  }
  if (r.rejected?.length) {
    // 部分省日期非法（越界/月日脏值）→ 点名说出，别让用户以为全都写进去了
    const p = r.rejected[0];
    statusMsg(`${what}：${r.rejected.length} 省被拒（例：${p.provinceId} ${p.reason}）`
      + `${r.changed ? `；其余 ${r.changed} 省已写入` : ''}`);
  } else if (r.noop) {
    statusMsg(`${what}：没有需要改动的日期`);
  } else {
    statusMsg(`${what}：改 ${r.changed} 省${r.cleared ? ` / 清 ${r.cleared} 省` : ''}（可 Ctrl+Z 撤回）`);
  }
  render();
}

  return { applyRiverPick, deleteSelectedRiver, commitRiverDrag, drawOneHandRiver, withBezierControls, onBatchSeedClick, updateCursor, onSetChangeDatesBulk };
}
