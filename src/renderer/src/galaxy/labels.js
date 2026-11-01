// galaxy/labels.js —— 星域视图标签层（**吸收自 SP-1025 `src/render/labels.ts`，MIT，自研**）
//
// 修的是另一条老毛病：原先**每颗星都挂一块深色圆角底框**，远景几十个框糊成一片黑砖，
// 近景又把星点盖住；而 EU4 参考图（`refs/src/20261027-08-eu4-1518.jpg`）里国名是**墨字无框**、
// 字号按领土分层。所以这里：
//   ① **LOD 门控**：远景不画名字（只剩星点与归属光晕），中景只留枢纽/匹配项，近景全量；
//   ② **无底框**：字 + 暗描边（深色底）或亮描边（浅色底），星点不被遮；
//   ③ **贪心避让**：同屏重叠时保留优先级高的（枢纽 → 度数高 → 名字字典序），其余丢弃 —— 丢弃是画法，不是丢数据。
//
// 画布与导出共用本模块（导出传 `exportMode` + `uiScale`）。

/** 缩放 → 标签档位 */
export function labelLodFor(scale) {
  if (scale < 0.35) return { band: 'none', fontPx: 12 };
  if (scale < 0.7) return { band: 'major', fontPx: 12 };
  return { band: 'all', fontPx: 13 };
}

/**
 * 收集候选标签（按优先级排序）。
 * @param {Array} stars [{ id, x, y, name, degree, matched, current }]
 * @param {{scale:number, toScreen?:Function}} opts
 */
export function collectStarLabels(stars, opts = {}) {
  const { band } = labelLodFor(opts.scale || 1);
  if (band === 'none') return [];
  const out = [];
  for (const s of stars || []) {
    const text = s.displayName || s.name;
    if (!text) continue;
    const degree = s.degree || 0;
    const major = !!s.matched || degree >= 4;
    if (band === 'major' && !major) continue;
    out.push({
      id: s.id, text, x: s.x, y: s.y, degree, major,
      matched: !!s.matched, current: !!s.current,
      priority: (s.matched ? 100 : 0) + degree,
    });
  }
  out.sort((a, b) => b.priority - a.priority || String(a.text).localeCompare(String(b.text), 'zh'));
  return out;
}

/**
 * 贪心避让（屏幕空间矩形相交测试）。被挡住的直接丢弃。
 * @param {Array} labels collectStarLabels 的结果
 * @param {CanvasRenderingContext2D} ctx 用于 measureText（字体由本函数设置）
 * @param {{scale:number, fontPx:number}} opts
 */
export function cullStarLabels(labels, ctx, opts = {}) {
  const fontPx = opts.fontPx || 12;
  ctx.save();
  ctx.font = `${fontPx}px "Segoe UI", system-ui, "Microsoft YaHei", sans-serif`;
  const rects = [];
  const kept = [];
  for (const l of labels) {
    const w = ctx.measureText(l.text).width;
    const h = fontPx + 2;
    // 名字放星点右侧（原型同款），留 6px 间距
    const x1 = l.x + 6;
    const y1 = l.y - h / 2;
    const box = { x1, y1, x2: x1 + w + 2, y2: y1 + h };
    const clash = rects.some(r => box.x1 < r.x2 && box.x2 > r.x1 && box.y1 < r.y2 && box.y2 > r.y1);
    if (clash) continue;
    rects.push(box);
    kept.push(l);
  }
  ctx.restore();
  return kept;
}

/**
 * 画标签（无底框，字 + 描边）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} labels
 * @param {{scale:number, fontPx:number, isDark?:boolean, exportMode?:boolean, uiScale?:number}} opts
 * @returns {number} 画了几条
 */
export function paintStarLabels(ctx, labels, opts = {}) {
  const scale = opts.scale || 1;
  const fontPx = opts.fontPx || 12;
  const isDark = opts.isDark !== false;
  const fs = fontPx / scale;  // 世界字号 = 屏幕字号 / scale
  const gap = 6 / scale;

  ctx.save();
  ctx.font = `${fs}px "Segoe UI", system-ui, "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const l of labels) {
    const rawName = l.text;
    const x = l.x + gap;
    // 描边（深色底 → 深描边 + 亮字；浅色底反过来）
    ctx.strokeStyle = isDark ? 'rgba(4,7,14,0.85)' : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3 / scale;
    ctx.strokeText(rawName, x, l.y);
    ctx.fillStyle = l.matched
      ? (l.current ? '#ffd766' : '#ffb648')
      : (isDark ? (l.major ? 'rgba(255,255,255,0.96)' : 'rgba(214,227,250,0.86)') : 'rgba(28,32,38,0.92)');
    ctx.fillText(rawName, x, l.y);
  }
  ctx.restore();
  return labels.length;
}
