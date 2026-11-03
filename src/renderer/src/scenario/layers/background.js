// scenario/layers/background.js — 剧本视图「底图」层（N1 刀 1，2026-10-30）
//
// 从 `ScenarioMap.vue` 搬出来的第一批：**画布底色 + 网格** 与 **生物群系图例**。
// 依赖一律从 `view` 取（不 import Vue、不碰组件状态）—— 这是 N1 的全部意义：
// 每层的输入写得出来，才能在"层之上再叠一层质感"时不返工。
//
// `view` 里本层用到的字段（由 `ScenarioMap.makeLayerView()` 提供）：
//   w, h               画布 CSS 尺寸（未乘 DPR）
//   px(v)              屏幕像素 → 世界单位的换算
//   screenToWorld(x,y) 屏幕 → 世界
//   baseMap            当前底图（含 heightmap.biomes）
//   GRID_STEP          网格步长（世界单位）
//   showRelief         是否画地形浮雕底（政治档 + 底图有高度图时才为真）
//   reliefRaster()     高度图浮雕栅格 `{canvas,minX,minY,w,h}`（与导出共用同一份缓存）

/** 底色 + 地形浮雕底 + 世界坐标网格（空底图时也画，用户据此判断"这块地是没有数据还是没加载"） */
export function drawBackgroundLayer(c, view) {
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  c.fillStyle = '#1a2a3a';
  c.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // ── 地形浮雕底（2026-11-03，EU4 构图比例）────────────────────────────────
  // 用户对照 EU4 的原话：一屏约 65% 地形纹理 + 25% 政治水洗；我们原先 90% 是平涂色块，
  // 所以"参数怎么调都不像"。这里把高度图的山体阴影 + 地形色铺在**政治色之下**，
  // 省份填色由 `provinces.js` 按 view.politicalWash（~0.42）水洗上去。
  // 只在政治档画：height/temp/prec 等栅格档自己就是地形图，再叠一层会糊。
  drawRelief(c, view);

  c.strokeStyle = 'rgba(255,255,255,0.03)';
  c.lineWidth = view.px(1);
  const step = view.GRID_STEP;
  const startX = Math.floor(tl.x / step) * step;
  const startY = Math.floor(tl.y / step) * step;
  const endX = br.x + step;
  const endY = br.y + step;
  for (let x = startX; x <= endX; x += step) {
    c.beginPath();
    c.moveTo(x, startY);
    c.lineTo(x, endY);
    c.stroke();
  }
  for (let y = startY; y <= endY; y += step) {
    c.beginPath();
    c.moveTo(startX, y);
    c.lineTo(endX, y);
    c.stroke();
  }
}

/** 浮雕底（一张预渲染栅格，drawImage 直接贴；不逐格重绘，见 heightmapRaster 的缓存口径） */
export function drawRelief(c, view) {
  if (!view.showRelief || typeof view.reliefRaster !== 'function') return;
  let r = null;
  try { r = view.reliefRaster(); } catch (_) { r = null; }
  if (!r || !r.canvas) return;
  c.save();
  c.globalAlpha = view.reliefAlpha == null ? 1 : view.reliefAlpha;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(r.canvas, r.minX, r.minY, r.w, r.h);
  c.restore();
}

/** 生物群系图例（只有底图带 biomes 时才画；最多列 10 条） */
export function drawBiomeLegendLayer(c, view) {
  const biomes = view.baseMap && view.baseMap.heightmap && view.baseMap.heightmap.biomes;
  if (!biomes || !biomes.length) return;

  const legendX = view.screenToWorld(view.w - 150, view.h - 300).x;
  const legendY = view.screenToWorld(view.w - 150, view.h - 300).y;
  c.font = `${11}px "PingFang SC", sans-serif`;
  c.fillStyle = 'rgba(0,0,0,0.7)';
  c.fillRect(legendX - 5, legendY - 15, 140, biomes.length * 18 + 20);
  c.fillStyle = '#fff';
  c.fillText('生物群系', legendX, legendY);
  biomes.forEach((b, i) => {
    if (i < 10) {
      c.fillStyle = b.color || '#888';
      c.fillRect(legendX, legendY + 5 + i * 18, 12, 12);
      c.fillStyle = '#ccc';
      c.fillText(b.name || `Biome ${i}`, legendX + 16, legendY + 15 + i * 18);
    }
  });
}
