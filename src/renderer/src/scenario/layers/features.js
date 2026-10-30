// scenario/layers/features.js — 剧本视图「地图要素」层（N1 刀 2，2026-10-30）
//
// 从 `ScenarioMap.vue` 搬出：道路/航路、手画河、城镇（含首都星标）。
// 这三块都是**世界坐标**里的普通要素层，和省份/文字/HUD 正交，但都有各自的"档位节流"
// （far→close 只出主干/首都），所以它们是刀 2 里最容易在观感上翻车的一块 —— 判据必须逐像素。
//
// 口径原样保留（一条都没改）：
//   · 道路：`utils/routeDensity.js` 分档渐显；海路按陆地掩膜切段 + 深色底衬（否则浅海面上等于没画）；
//   · 手画河：全部走 `drawOneHandRiver`（曲线 + 源头细→河口粗 + 岸线），不再自己 beginPath；
//   · 城镇：两趟绘制（普通在下、首都在上），far/mid 只留首都、near 只留人口 ≥20；
//     617 个城镇全画就是"一层白芝麻"（用户 B1 报障的技术成因）。
//
// `view` 字段：w,h,px,vx,vy,screenToWorld,baseMap,burgs,hoveredBurg,selectedBurg,BURG_SIZES,
//   polylineInView,labelDetail(),arterialLengthThreshold,shouldDrawRoute,getLandMask,
//   riverNodesForRender,drawOneHandRiver

/** 配色/样式对齐 Azgaar FMG 默认：道路棕色实线、小径棕色虚线、海路白色虚线 */
export const ROUTE_STYLES = {
  roads: { color: '#d06324', width: 0.9, dash: null, alpha: 0.95 },
  trails: { color: '#d06324', width: 0.5, dash: [2, 3], alpha: 0.85 },
  // 2026-10-27（用户「海路图还不如之前那个独立模块」）：0.5px + 1.5/3 的短虚线在浅色海面上
  // 几乎看不见，压在陆地上又像划痕。加宽到 0.9、虚线拉到 5/4，并加一层深色底衬。
  searoutes: { color: '#eaf4fb', width: 0.9, dash: [5, 4], alpha: 0.8 },
};

/** 道路 / 航路 */
export function drawRoutesLayer(c, view) {
  const list = view.baseMap && view.baseMap.routes;
  if (!list || !list.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(40);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  // 档位节流（C5）：496 条路/航路整图可见时会糊成一张网 —— 判据在 `utils/routeDensity.js`
  const detail = view.labelDetail();
  const arterialLen = view.arterialLengthThreshold(list, detail);

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const r of list) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    if (!view.shouldDrawRoute(r, detail, arterialLen)) continue;
    if (!view.polylineInView(pts, minX, minY, maxX, maxY)) continue;
    // 优先使用道路自带样式（P1-T3），回退到 group 默认
    const st = r.color
      ? { color: r.color, width: r.width || 1, dash: r.dash || null, alpha: 0.95 }
      : ROUTE_STYLES[r.group] || ROUTE_STYLES.roads;
    const isSea = r.group === 'searoutes';
    // 海路**只画在海面**：FMG 的 sea route 会横穿陆地（白色虚线切过省界），按陆地掩膜切段
    let runs = [pts];
    if (isSea) {
      const mask = view.getLandMask();
      if (mask) {
        runs = [];
        let cur = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          const mx = (pts[i - 1].x + pts[i].x) / 2;
          const my = (pts[i - 1].y + pts[i].y) / 2;
          if (mask.lookup(mx, my)) {
            if (cur.length >= 2) runs.push(cur);
            cur = [pts[i]];
          } else {
            cur.push(pts[i]);
          }
        }
        if (cur.length >= 2) runs.push(cur);
      }
    }
    for (const run of runs) {
      c.globalAlpha = st.alpha;
      c.strokeStyle = st.color;
      c.lineWidth = st.width;
      c.setLineDash(st.dash || []);
      c.beginPath();
      c.moveTo(view.vx(run[0]), view.vy(run[0]));
      for (let i = 1; i < run.length; i++) c.lineTo(view.vx(run[i]), view.vy(run[i]));
      // 海路：先画一层深色底衬，再画浅色虚线（否则浅海面上等于没画）
      if (isSea) {
        c.save();
        c.globalAlpha = 0.38;
        c.setLineDash([]);
        c.strokeStyle = 'rgba(16, 44, 64, 1)';
        c.lineWidth = st.width + 1.7;
        c.stroke();
        c.restore();
        c.globalAlpha = st.alpha;
        c.strokeStyle = st.color;
        c.lineWidth = st.width;
        c.setLineDash(st.dash || []);
      }
      c.stroke();
    }
  }
  c.setLineDash([]);
  c.restore();
}

/** 手画河（id 前缀 `river_`；导入河由 drawRivers 负责 —— 两边都画会把同一份数据画两遍） */
export function drawRiverPathsLayer(c, view) {
  const list = ((view.baseMap && view.baseMap.rivers) || [])
    .filter((r) => r && String(r.id || '').indexOf('river_') === 0);
  if (!list.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(40);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const r of list) {
    const path = view.riverNodesForRender(r);
    if (path.length < 2) continue;
    if (!view.polylineInView(path, minX, minY, maxX, maxY)) continue;
    view.drawOneHandRiver(c, path, r);
  }
  c.restore();
}

/** 浮雕图标（山/火山等；矢量名走 Path2D，历史 emoji 由 drawIconOrEmoji 内部 fillText 兜住） */
export function drawReliefIconsLayer(c, view) {
  const icons = view.reliefIcons;
  if (!icons || !icons.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(30);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const fontSize = Math.max(12, view.px(16));
  c.font = `${fontSize}px "PingFang SC", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const r of icons) {
    if (r.x < minX || r.x > maxX || r.y < minY || r.y > maxY) continue;
    view.drawIconOrEmoji(c, r.icon, r.x, r.y, Math.max(14, view.px(18)), r.color || '#FFFFFF');
  }
  c.textAlign = 'start';
  c.textBaseline = 'alphabetic';
}

/** 剧本标记（图标 + 名称；选中时金色虚线圈 —— 面板在右侧、圈在图上，用户能确认"改的就是这一个"） */
export function drawScenarioMarkersLayer(c, view) {
  const markers = view.selectedScenario && view.selectedScenario.markers;
  if (view.mode !== 'scenario' || !markers || !markers.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(30);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const fontSize = Math.max(12, view.px(14));
  c.font = `${fontSize}px "PingFang SC", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const m of markers) {
    if (m.x < minX || m.x > maxX || m.y < minY || m.y > maxY) continue;
    if (view.selectedMarker && m === view.selectedMarker) {
      const r = Math.max(12, view.px(16)) * 0.95;
      c.beginPath();
      c.arc(m.x, m.y, r, 0, Math.PI * 2);
      c.strokeStyle = '#fbbf24';
      c.lineWidth = view.px(1.6);
      if (c.setLineDash) c.setLineDash([view.px(3), view.px(3)]);
      c.stroke();
      if (c.setLineDash) c.setLineDash([]);
    }
    // 图标/颜色缺省时按「标记类型」补 —— 导入的数据往往只带 type
    const typeDef = view.MARKER_TYPES.find(t => t.id === m.type);
    view.drawIconOrEmoji(c, m.icon || (typeDef && typeDef.icon) || 'map-pin', m.x, m.y,
      Math.max(12, view.px(16)), m.color || (typeDef && typeDef.color) || '#FFFFFF');
    // 名称标签：与导出共用一份样式 + 默认深色描边
    const nameStyle = view.markerLabelTextStyle(m);
    view.drawStyledLabel(c, m.name || '', m.x, m.y + fontSize * 0.8, nameStyle, {
      align: 'center', baseline: 'middle', screenScale: view.cameraScale,
    });
  }
  c.textAlign = 'start';
  c.textBaseline = 'alphabetic';
}

/** 首都星标（十角星；城镇层内部用） */
function drawCapitalStar(c, view, x, y, r) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fillStyle = '#ffd700';
  c.fill();
  c.strokeStyle = 'rgba(20,24,34,0.65)';
  c.lineWidth = view.px(1);
  c.stroke();
}

/** 城镇（两趟：普通在下、首都在上；按档位节流 + 视口裁剪） */
export function drawBurgsLayer(c, view) {
  const list = view.burgs;
  if (!list || !list.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(24);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  // 617 个城镇全画 = 一层白芝麻（把地形、省界、河名全盖住）→ 按同一套档位节流
  const detail = view.labelDetail();
  const dotR = view.px(1.9);
  const starR = view.px(4.6);
  const hoverId = view.hoveredBurg ? view.hoveredBurg.id : null;
  const selectedId = view.selectedBurg ? view.selectedBurg.id : null;

  // 两趟绘制（普通城镇在下、首都在上）；不新建数组，避免渲染循环内分配
  for (let pass = 0; pass <= 1; pass++) {
    for (const b of list) {
      if ((b.capital ? 1 : 0) !== pass) continue;
      if (b.x < minX || b.x > maxX || b.y < minY || b.y > maxY) continue;
      if (pass === 1) {
        drawCapitalStar(c, view, b.x, b.y, starR);
      } else {
        // 档位节流：far/mid 只留首都；near 只留人口 ≥20 的；close 全出
        if (detail === 'far' || detail === 'mid') continue;
        if (detail === 'near' && Number(b.population || 0) < 20) continue;
        // 根据聚落规模调整大小（P1-T4）
        const sizeDef = view.BURG_SIZES.find(s => s.id === b.size) || view.BURG_SIZES[1];
        const r = dotR * (sizeDef.radius / 3.5);
        c.fillStyle = sizeDef.color;
        c.globalAlpha = 0.62;
        c.beginPath();
        c.arc(b.x, b.y, r, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
      }
      if (b.id === selectedId || b.id === hoverId) {
        c.strokeStyle = b.id === selectedId ? '#34d399' : '#ffffff';
        c.lineWidth = view.px(1.5);
        c.beginPath();
        c.arc(b.x, b.y, starR * 1.8, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }
}
