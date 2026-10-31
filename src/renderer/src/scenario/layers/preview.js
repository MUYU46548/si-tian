// scenario/layers/preview.js — 剧本视图「交互预览层」（N1 刀 2 收尾，2026-10-31）
//
// 这是 `ScenarioMap.vue` 里最大的一块绘制函数（原 317 行）：**所有"正在做但还没落库"的预览**。
// 它与静态层正交：只有对应的工具/手势在跑时才有内容，所以判据是"不在那个工具里就一个像素都不多画"。
//
// 内容（按原顺序，一条都没改）：
//   ① 折线切割：已点折线 + 橡皮筋 + 两块几何预览（绿=保留原身份 / 橙=新生块）
//   ② 批量铺底：种子点 + Voronoi 预览
//   ③ 自由绘制：手感线 + **将要落库的地块**（与落库同一套几何 —— 旧实现只有手感线，
//      松手后形状会"跳"成另一个，那正是"描点连线模拟器"的观感来源）
//   ④ 描点、吸附标记、笔刷圈、道路预览、拆分点
//   ⑤ 河流橡皮的擦除轨迹（半径与判据同一个常量，画小了会"看起来没碰到却被擦掉"）
//   ⑥ 河流编辑预览（走与落库同一条画法）+ 节点手柄（点数/缩放闸门，否则几十个点糊成虚线）
//   ⑦ 地形注记手绘预览
//
// `view` 字段：px, tool, freeTraceActive, freeTrace, drawPoints, polySplitPoints, polySplitPreview,
//   polySplitKeepStart, polySplitHover, batchSeeds, batchPreviewCells, batchPreviewInside, snapMarker,
//   brushPreview, roadPath, splitStep, splitPoints, riverEraseStroke, riverDraft, terrainLabelPick,
//   selectedRiver, riverActiveNode, cameraScale,
//   tracePath, traceShapePath, previewTraceRing, riverPreviewNodes, drawOneHandRiver, riverNodesForRender,
//   RIVER_ERASE_RADIUS_PX, RIVER_WIDTH_DEFAULT, RIVER_HANDLE_MAX, RIVER_HANDLE_MIN_ZOOM

export function drawPreviewOverlayLayer(c, view) {
  // ── A 折线切割：已点的折线 + 橡皮筋 + 两块几何预览 ────────────────────────
  if (view.tool === 'polySplit') {
    const pts = view.polySplitPoints;
    const pv = view.polySplitPreview;
    if (pv) {
      // 「绿 = 保留原省份身份，橙 = 新生块」—— 不需要用户理解 a/b 或左右，看颜色即可
      const halves = [
        { mp: view.polySplitKeepStart ? pv.a : pv.b, fill: 'rgba(34, 197, 94, 0.26)', line: '#22c55e', dash: [] },
        { mp: view.polySplitKeepStart ? pv.b : pv.a, fill: 'rgba(249, 115, 22, 0.22)', line: '#f97316', dash: [view.px(5), view.px(4)] },
      ];
      for (const h of halves) {
        c.save();
        c.beginPath();
        for (const poly of h.mp || []) {
          for (const ring of poly || []) {
            if (!ring || ring.length < 3) continue;
            c.moveTo(ring[0][0], ring[0][1]);
            for (let i = 1; i < ring.length; i++) c.lineTo(ring[i][0], ring[i][1]);
            c.closePath();
          }
        }
        c.fillStyle = h.fill;
        c.fill('evenodd');
        c.strokeStyle = h.line;
        c.lineWidth = view.px(1.6);
        c.setLineDash(h.dash);
        c.stroke();
        c.restore();
      }
    }
    if (pts.length) {
      c.save();
      c.strokeStyle = '#f8fafc';
      c.lineWidth = view.px(2);
      c.lineJoin = 'round';
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      c.stroke();
      // 橡皮筋：从最后一点到鼠标
      if (view.polySplitHover) {
        c.setLineDash([view.px(6), view.px(5)]);
        c.strokeStyle = 'rgba(248, 250, 252, 0.7)';
        c.beginPath();
        c.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        c.lineTo(view.polySplitHover.x, view.polySplitHover.y);
        c.stroke();
        c.setLineDash([]);
      }
      for (let i = 0; i < pts.length; i++) {
        c.fillStyle = i === 0 ? '#22c55e' : '#f8fafc';
        c.beginPath();
        c.arc(pts[i].x, pts[i].y, view.px(3.5), 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }
  }

  // ── B 批量铺底：种子点 + Voronoi 预览（只画不裁，真切分会与陆地求交）──────
  if (view.tool === 'voronoi' && view.batchSeeds.length) {
    c.save();
    c.strokeStyle = 'rgba(34, 211, 238, 0.45)';
    c.lineWidth = view.px(1);
    for (const ring of view.batchPreviewCells) {
      if (!ring || ring.length < 3) continue;
      c.beginPath();
      c.moveTo(ring[0][0], ring[0][1]);
      for (let i = 1; i < ring.length; i++) c.lineTo(ring[i][0], ring[i][1]);
      c.stroke();
    }
    for (let i = 0; i < view.batchSeeds.length; i++) {
      const p = view.batchSeeds[i];
      const inside = view.batchPreviewInside[i] !== false;
      c.fillStyle = inside ? '#22d3ee' : 'rgba(148, 163, 184, 0.75)';
      c.beginPath();
      c.arc(p.x, p.y, view.px(inside ? 2.6 : 2), 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  // 「绘制」工具的自由绘制实时轨迹（一笔跟着走，松手才简化成型）
  // 🔴 这里画**两样东西**：① 手感线（细、淡）② **将要落库的地块**（与落库同一套几何）
  if (view.freeTraceActive && view.freeTrace && view.freeTrace.length > 1) {
    const isOutline = view.tool === 'outline';
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.strokeStyle = isOutline ? 'rgba(34, 211, 238, 0.85)' : 'rgba(221, 214, 254, 0.9)';
    c.lineWidth = view.px(2.2);
    c.beginPath();
    view.tracePath(c, view.freeTrace, false);
    c.stroke();
    const previewRing = view.previewTraceRing();
    if (previewRing && previewRing.length >= 3) {
      c.beginPath();
      view.traceShapePath(c, previewRing, true);
      c.fillStyle = isOutline ? 'rgba(34, 211, 238, 0.10)' : 'rgba(196, 181, 253, 0.14)';
      c.fill();
      c.strokeStyle = isOutline ? '#22d3ee' : '#c4b5fd';
      c.lineWidth = view.px(1.8);
      c.stroke();
    }
    c.restore();
  }
  if (view.tool === 'draw' && view.drawPoints.length > 0) {
    c.strokeStyle = '#7c3aed';
    c.fillStyle = 'rgba(124, 58, 237, 0.15)';
    c.lineWidth = view.px(2);
    c.beginPath();
    c.moveTo(view.drawPoints[0].x, view.drawPoints[0].y);
    for (let i = 1; i < view.drawPoints.length; i++) {
      c.lineTo(view.drawPoints[i].x, view.drawPoints[i].y);
    }
    if (view.drawPoints.length >= 3) c.closePath();
    c.fill();
    c.stroke();
    for (const p of view.drawPoints) {
      c.fillStyle = '#a78bfa';
      c.beginPath();
      c.arc(p.x, p.y, view.px(3), 0, Math.PI * 2);
      c.fill();
    }
  }

  // 吸附标记（网格绿十字 / 边界青环）
  if (view.snapMarker) {
    const mx = view.snapMarker.x;
    const my = view.snapMarker.y;
    const isEdge = view.snapMarker.kind === 'edge';
    const arm = view.px(7);
    c.strokeStyle = isEdge ? '#22d3ee' : '#34d399';
    c.lineWidth = view.px(1.5);
    c.beginPath();
    c.moveTo(mx - arm, my);
    c.lineTo(mx + arm, my);
    c.moveTo(mx, my - arm);
    c.lineTo(mx, my + arm);
    c.stroke();
    c.beginPath();
    c.arc(mx, my, view.px(2.5), 0, Math.PI * 2);
    c.stroke();
    if (isEdge) {
      c.beginPath();
      c.arc(mx, my, view.px(6), 0, Math.PI * 2);
      c.stroke();
    }
  }

  // 笔刷预览（hover 时显示）
  if (view.brushPreview && ['height', 'lake', 'biome', 'culture', 'religion'].includes(view.tool)) {
    const bp = view.brushPreview;
    c.beginPath();
    c.arc(bp.x, bp.y, bp.radius, 0, Math.PI * 2);
    let color = 'rgba(74, 158, 255, 0.8)';
    if (view.tool === 'biome') color = 'rgba(255, 107, 107, 0.8)';
    else if (view.tool === 'culture') color = 'rgba(255, 215, 0, 0.8)';
    else if (view.tool === 'religion') color = 'rgba(167, 139, 250, 0.8)';
    c.strokeStyle = color;
    c.lineWidth = view.px(2);
    c.setLineDash([view.px(5), view.px(5)]);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = color.replace('0.8', '0.1');
    c.fill();
  }

  // 道路预览
  if (view.tool === 'road' && view.roadPath.length >= 2) {
    c.strokeStyle = '#ffd700';
    c.lineWidth = view.px(2);
    c.setLineDash([view.px(4), view.px(4)]);
    c.beginPath();
    c.moveTo(view.roadPath[0].x, view.roadPath[0].y);
    for (let i = 1; i < view.roadPath.length; i++) {
      c.lineTo(view.roadPath[i].x, view.roadPath[i].y);
    }
    c.stroke();
    c.setLineDash([]);
    // 起终点标记
    c.fillStyle = '#ffd700';
    c.beginPath();
    c.arc(view.roadPath[0].x, view.roadPath[0].y, view.px(4), 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(view.roadPath[view.roadPath.length - 1].x, view.roadPath[view.roadPath.length - 1].y,
      view.px(4), 0, Math.PI * 2);
    c.fill();
  }

  if (view.tool === 'split' && view.splitStep === 1 && view.splitPoints.length === 1) {
    c.fillStyle = '#fbbf24';
    c.beginPath();
    c.arc(view.splitPoints[0].x, view.splitPoints[0].y, view.px(5), 0, Math.PI * 2);
    c.fill();
  }

  // ── 河流橡皮的擦除轨迹 ────────────────────────────────────────────────────
  // 只画光标圈的话，用户**看不到自己已经抹过哪里**。这里画的是**将擦掉的范围**：
  // 半径 = 橡皮半径的半透明粗轨迹 + 当前笔尖的圈 —— 与 `planRiverErase` 的判据形状一致。
  if (view.tool === 'riverErase') {
    const rW = view.px(view.RIVER_ERASE_RADIUS_PX);
    const trail = view.riverEraseStroke || [];
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (trail.length > 1) {
      c.strokeStyle = 'rgba(248, 113, 113, 0.28)';
      c.lineWidth = rW * 2;
      c.beginPath();
      c.moveTo(trail[0].x, trail[0].y);
      for (let i = 1; i < trail.length; i++) c.lineTo(trail[i].x, trail[i].y);
      c.stroke();
    }
    if (trail.length) {
      const head = trail[trail.length - 1];
      c.strokeStyle = '#f87171';
      c.lineWidth = view.px(1.5);
      c.beginPath();
      c.arc(head.x, head.y, rW, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = 'rgba(248, 113, 113, 0.12)';
      c.fill();
    }
    c.restore();
  }

  // 河流编辑器预览：走**与落库完全同一条画法**（曲线 + 变宽 + 岸线）+ 落库那个宽度
  if (view.tool === 'river' && view.riverDraft.length > 1) {
    const previewPts = view.riverPreviewNodes();
    if (previewPts.length >= 2) {
      view.drawOneHandRiver(c, previewPts, { width: view.RIVER_WIDTH_DEFAULT }, { alpha: 0.85 });
      const head = previewPts[0];
      c.fillStyle = '#f59e0b';
      c.beginPath();
      c.arc(head.x, head.y, view.px(3.2), 0, Math.PI * 2);
      c.fill();
    }
  }

  // 地形注记手绘预览：颜色按类别区分（山系橙 / 海域蓝 / 平原黄）
  if (view.terrainLabelPick && view.terrainLabelPick.points.length) {
    const p = view.terrainLabelPick;
    const pts = p.points;
    const color = p.kind === 'sea' ? '#38bdf8' : (p.kind === 'plain' ? '#fbbf24' : '#f97316');
    c.save();
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = view.px(1.6);
    c.setLineDash(p.kind === 'plain' ? [] : [view.px(6), view.px(4)]);
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.stroke();
    c.setLineDash([]);
    const marks = p.kind === 'plain' ? [pts[0]] : [pts[0], pts[pts.length - 1]];
    for (const q of marks) {
      c.beginPath();
      c.arc(q.x, q.y, view.px(p.kind === 'plain' ? 5 : 3), 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  // ── 河流节点编辑的**可见性** ─────────────────────────────────────────────
  // 手柄只在**点数不多、且放大到看得清**时画；否则一条 480 点的河会糊成一条虚线。
  if (view.tool === 'river' && view.selectedRiver) {
    const nodes = view.riverNodesForRender(view.selectedRiver);
    const showAll = nodes.length <= view.RIVER_HANDLE_MAX && view.cameraScale >= view.RIVER_HANDLE_MIN_ZOOM;
    c.save();
    for (let i = 0; i < nodes.length; i++) {
      const active = i === view.riverActiveNode;
      if (!showAll && !active) continue;
      const p = nodes[i];
      c.beginPath();
      c.arc(p.x, p.y, view.px(active ? 6 : 3.2), 0, Math.PI * 2);
      c.fillStyle = active ? '#fbbf24' : '#0b1220';
      c.fill();
      c.lineWidth = view.px(active ? 2 : 1.2);
      c.strokeStyle = active ? '#fde68a' : '#e2e8f0';
      c.stroke();
    }
    c.restore();
  }
}
