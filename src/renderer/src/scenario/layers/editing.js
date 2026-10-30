// scenario/layers/editing.js — 剧本视图「编辑期覆盖层」（N1 刀 2，2026-10-30）
//
// 从 `ScenarioMap.vue` 搬出两块**只在你动手时才出现**的层：
//   · 顶点手柄：跟随移动的邻省环 / 当前激活顶点的切线手柄 / 顶点圆点 / 顶点与河流的框选矩形；
//   · 笔刷圈：涂归属的势力色预览 + 笔刷圆、笔刷建省的笔迹带（圆盘 ∪ 胶囊）、套索轨迹。
//
// 为什么单独一刀：它们的 `when` 全是"正在某个编辑手势里"，与地形/省界那套静态层正交；
// 判据也清楚 —— 不在编辑态时**一个像素都不许多画**（像素基线里这些分支必须整体不触发）。
//
// `view` 字段：
//   px, vx, vy
//   dragPreview, vertexEditMode, selectedProvince, currentProvince(), resolvePoints(prov),
//   activeVertexIdx, vertexSelection, altStraight, draggingVertex, vertexMarquee, riverMarquee,
//   normalizeBox(box)
//   provBrushPreview, tool, clearOwnerMode, selectedPolity, ownerStrokeIds, baseMap,
//   provinceRings, ownerBrushWorldRadius(), provBrushWorldRadius, store, provLassoPoints,
//   provLassoActive, tracePath(c, pts, closed)

/** 顶点手柄 + 框选矩形（编辑态才出现） */
export function drawVertexHandlesLayer(c, view) {
  // P1：跟随移动的邻省环要在**任何情况下**都画出来（它是"边界整体移动"的唯一视觉证据），
  // 所以放在最前面、且不依赖"当前选中省"是否还存在。
  const linked = (view.dragPreview && view.dragPreview.linked) || [];
  if (linked.length) {
    c.save();
    c.setLineDash([view.px(5), view.px(4)]);
    c.lineWidth = view.px(2);
    c.strokeStyle = '#f59e0b';
    for (const g of linked) {
      for (const r of g.rings) {
        if (!r.points || r.points.length < 3) continue;
        c.beginPath();
        r.points.forEach((p, i) => {
          const x = view.vx(p), y = view.vy(p);
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        });
        c.closePath();
        c.stroke();
      }
    }
    c.restore();
  }

  if (view.vertexEditMode && view.selectedProvince) {
    const prov = view.currentProvince();
    const points = prov ? view.resolvePoints(prov) : null;
    if (points) {
      const r = view.px(4);
      const hR = view.px(3.5);
      const active = view.activeVertexIdx;
      const selected = view.vertexSelection || [];

      // P0-T1：仅对当前选中顶点画切线手柄（大省份全画会遮满屏幕）
      if (active >= 0 && active < points.length && !view.altStraight) {
        const p = points[active];
        const cx = view.vx(p), cy = view.vy(p);
        const out = p.controlOut;
        const inn = p.controlIn;
        if (out || inn) {
          c.save();
          c.setLineDash([view.px(3), view.px(3)]);
          c.strokeStyle = 'rgba(167,139,250,0.8)';
          c.lineWidth = view.px(1);
          if (out) { c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + out.x, cy + out.y); c.stroke(); }
          if (inn) { c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + inn.x, cy + inn.y); c.stroke(); }
          c.setLineDash([]);
          c.fillStyle = '#38bdf8';
          c.strokeStyle = '#ffffff';
          if (out) { c.beginPath(); c.arc(cx + out.x, cy + out.y, hR, 0, Math.PI * 2); c.fill(); c.stroke(); }
          if (inn) { c.beginPath(); c.arc(cx + inn.x, cy + inn.y, hR, 0, Math.PI * 2); c.fill(); c.stroke(); }
          c.restore();
        }
      }

      points.forEach((p, i) => {
        const sx = view.vx(p);
        const sy = view.vy(p);
        // P1：框选中的顶点用青色（与省份多选的描边同色系），正在拖的是金色，当前激活的是粉色
        const isSel = selected.indexOf(i) >= 0;
        c.fillStyle = view.draggingVertex?.vertexIdx === i
          ? '#ffd700'
          : (i === active ? '#f472b6' : (isSel ? '#22d3ee' : '#a78bfa'));
        c.strokeStyle = '#fff';
        c.lineWidth = view.px(1);
        c.beginPath();
        c.arc(sx, sy, isSel ? r * 1.25 : r, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      });
    }
  }

  // P1：框选矩形（世界坐标 → 屏幕；虚线，不参与任何导出与命中）
  const box = view.vertexMarquee;
  if (box) {
    const x0 = view.vx({ x: Math.min(box.x0, box.x1), y: 0 });
    const y0 = view.vy({ x: 0, y: Math.min(box.y0, box.y1) });
    const x1 = view.vx({ x: Math.max(box.x0, box.x1), y: 0 });
    const y1 = view.vy({ x: 0, y: Math.max(box.y0, box.y1) });
    c.save();
    c.fillStyle = 'rgba(34,211,238,0.12)';
    c.strokeStyle = '#22d3ee';
    c.lineWidth = view.px(1.5);
    c.setLineDash([view.px(4), view.px(3)]);
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
    c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    c.restore();
  }
  // 第五轮：河流框选（同款虚线框，颜色用河高亮的青白，与顶点框选区分开）
  const rbox = view.riverMarquee;
  if (rbox) {
    const nb = view.normalizeBox(rbox);
    const x0 = view.vx({ x: nb.minX, y: 0 });
    const y0 = view.vy({ x: 0, y: nb.minY });
    const x1 = view.vx({ x: nb.maxX, y: 0 });
    const y1 = view.vy({ x: 0, y: nb.maxY });
    c.save();
    c.fillStyle = 'rgba(223,243,255,0.10)';
    c.strokeStyle = 'rgba(223,243,255,0.9)';
    c.lineWidth = view.px(1.5);
    c.setLineDash([view.px(6), view.px(4)]);
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
    c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    c.restore();
  }
}

/** 笔刷圈 / 笔迹带 / 套索轨迹（编辑态才出现） */
export function drawProvinceBrushOverlayLayer(c, view) {
  const p = view.provBrushPreview;
  if (p && view.tool === 'ownerBrush') {
    // 涂归属：笔刷圈 + **这笔已经碰到的省**（半透明势力色）—— 抬手前就能看出会改哪些
    const polColor = view.clearOwnerMode
      ? '#94a3b8'
      : ((view.selectedPolity && view.selectedPolity.color) || '#fbbf24');
    if (view.ownerStrokeIds.size) {
      const terr = (view.baseMap && view.baseMap.terrain) || [];
      c.save();
      c.globalAlpha = 0.45;
      c.fillStyle = polColor;
      for (const prov of terr) {
        if (!prov || !view.ownerStrokeIds.has(prov.id)) continue;
        const rings = view.provinceRings(prov);
        if (!rings.length) continue;
        c.beginPath();
        for (const ring of rings) {
          const pts = ring && ring.points;
          if (!pts || pts.length < 2) continue;
          c.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
          c.closePath();
        }
        c.fill('evenodd');
      }
      c.restore();
    }
    c.save();
    c.strokeStyle = polColor;
    c.lineWidth = view.px(1.4);
    c.setLineDash([view.px(3), view.px(3)]);
    c.beginPath();
    c.arc(p.x, p.y, view.ownerBrushWorldRadius(), 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
  if (p && view.tool === 'provinceBrush' && view.provBrushRadius > 0) {
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = view.px(1.2);
    c.beginPath();
    c.arc(p.x, p.y, view.provBrushWorldRadius, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
  // ── 笔刷建省（2026-10-22）：笔迹带**就是**最终形状（圆盘 ∪ 胶囊），不画任何"预测环" ──
  //    为什么用「粗描边 + 圆头」而不是把 ring 算出来再填：算环要走布尔（每帧白算一次，
  //    正是「画省份」那条路上一团交叉白线的来源）；粗描边在覆盖范围上与
  //    `traceBrushRings`（每点一个圆盘 + 每段一个胶囊）一致，观感就是笔。
  if (view.tool === 'provincePaint') {
    const path = view.store.getProvinceStrokePath();
    if (path && path.length) {
      const rad = view.provBrushWorldRadius;
      c.save();
      c.strokeStyle = 'rgba(250, 204, 21, 0.34)';
      c.fillStyle = 'rgba(250, 204, 21, 0.34)';
      c.lineJoin = 'round';
      c.lineCap = 'round';
      c.lineWidth = rad * 2;
      c.beginPath();
      if (path.length === 1) {
        c.arc(path[0].x, path[0].y, rad, 0, Math.PI * 2);
        c.fill();
      } else {
        c.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) c.lineTo(path[i].x, path[i].y);
        c.stroke();
      }
      c.restore();
    }
    if (p) {
      c.save();
      c.strokeStyle = 'rgba(255,255,255,0.8)';
      c.lineWidth = view.px(1.2);
      c.beginPath();
      c.arc(p.x, p.y, view.provBrushWorldRadius, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
  }
  const pts = view.provLassoPoints;
  if (pts && pts.length > 1) {
    c.save();
    c.setLineDash([view.px(5), view.px(4)]);
    c.strokeStyle = '#c4b5fd';
    c.lineWidth = view.px(1.6);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    // 平滑轨迹（中点二次曲线）：手绘一圈就应该是曲线，逐点 lineTo 会读成「描点连线」
    view.tracePath(c, pts, !view.provLassoActive);
    c.stroke();
    if (!view.provLassoActive) { c.fillStyle = 'rgba(196,181,253,.18)'; c.fill(); }
    c.setLineDash([]);
    c.restore();
  }
}
