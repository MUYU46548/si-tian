// scenario/layers/coast.js — 剧本视图“海岸浅滩”层（N1 刀 1，2026-10-30）
//
// 两档海岸，**互斥**（由 `when` 判，不在这里 if）：
//   · `landsea`（政治档）：外侧 3px 浅海光带 + 1.1px 深青海岸线 → 让陆地"浮"在水上；
//   · `height`（地形档）：细等深线（0.6px）+ 海岸线（1.7px）→ 海岸属地形，压在省界以下。
// 两档都吃 `view.getSeaDetail()`（高精度 `landFeatures` 环），不是另算一套海岸。
//
// `view` 字段：rasterLayer, getSeaDetail(), screenToWorld, w, h, px, polylineInView, strokeWorldPolyline

function viewportBounds(view) {
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(24);
  return { minX: tl.x - pad, maxX: br.x + pad, minY: tl.y - pad, maxY: br.y + pad };
}

/** 地形档：等深线 + 海岸线（只在 `height` 档画；温度/降水/文化是专题图，加海深会被读成地形） */
export function drawSeaDetailLayer(c, view) {
  const d = view.getSeaDetail();
  if (!d || (!d.isobaths.length && !d.coasts.length)) return;
  const { minX, minY, maxX, maxY } = viewportBounds(view);

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = view.px(0.6);
  c.strokeStyle = 'rgba(48, 96, 128, 0.14)';
  for (const ln of d.isobaths) {
    if (!view.polylineInView(ln, minX, minY, maxX, maxY)) continue;
    view.strokeWorldPolyline(c, ln);
  }
  // 海岸线压在省界**下面**，只露一圈蓝边（省界会盖住中心 0.9px）——“蓝海岸 + 灰省界”的层叠
  // 2026-11-03（用户实测第 2 刀）：1.7px/0.45 在这张图上就是"地图糊成一团、线却无比清晰"里的那条线。
  // 地形档的陆地/海色差本身已经分了界，描边只该补一点点定义，不该抢戏 → 1.1px / 0.30。
  c.lineWidth = view.px(1.1);
  c.strokeStyle = 'rgba(44, 92, 122, 0.30)';
  for (const ln of d.coasts) {
    if (!view.polylineInView(ln, minX, minY, maxX, maxY)) continue;
    view.strokeWorldPolyline(c, ln, true);
  }
  c.restore();
}

/**
 * 政治档：海侧浅海光带 + 海岸线。
 * 画在省份填色**之前** —— 陆地一侧会被省份盖住，只留下海侧的带和线。
 */
export function drawPoliticalCoastLayer(c, view) {
  const d = view.getSeaDetail();
  if (!d || !d.coasts || !d.coasts.length) return;
  const { minX, minY, maxX, maxY } = viewportBounds(view);

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  // 浅海光带（2026-11-03：0.55 → 0.38 → **0.18 / 3px**）。
  // 用户实测原话：“有疑似海岸线的线条倒是无比清晰，但是这玩意根本没必要存在吧？”
  // 真机截图（build/pixel-baseline/probe1.png）复核：5px 宽、0.38 alpha 的青带在深色底上会**发光**，
  // 像给陆地套了一圈塑料边 —— 它压过了地形本身，正是“好几张地图叠在一起”的来源之一。
  // 现在的口径：只要海侧有一点点更亮的浅水，不许成环、不许发亮。
  c.lineWidth = view.px(3);
  c.strokeStyle = 'rgba(120, 180, 190, 0.18)';
  for (const ln of d.coasts) {
    if (!view.polylineInView(ln, minX, minY, maxX, maxY)) continue;
    view.strokeWorldPolyline(c, ln, true);
  }
  // 2026-11-03 三级线宽：海岸 1.6 > 国界 1.2 > 省界 0.7 —— 海岸最重，因为它是"地形/海"的界，
  // 也是 EU4 里最粗的一级（原先 1.1 与省界 0.9 几乎一样粗，读不出层级）。
  c.lineWidth = view.px(1.2);
  c.strokeStyle = 'rgba(44, 92, 122, 0.42)';
  for (const ln of d.coasts) {
    if (!view.polylineInView(ln, minX, minY, maxX, maxY)) continue;
    view.strokeWorldPolyline(c, ln, true);
  }
  c.restore();
}
