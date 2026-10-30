// scenario/layers/overlays.js — 剧本视图「屏幕空间浮层」（N1 刀 2 起手，2026-10-30）
//
// 从 `ScenarioMap.vue` 搬出四块**画在屏幕坐标系**（不受缩放影响）的浮层：
//   · 小地图（含缩略图烘到离屏 canvas 的缓存 —— 每帧只 drawImage + 画视口框）
//   · 文化/宗教图例（右下）
//   · 数据分布图（左下，文化/宗教网格点统计）
//   · 城镇悬浮卡（悬停/选中城镇时）
//
// 为什么它们单独一刀：这四块的输入几乎全是「当前状态 + 画布尺寸」，
// 与省份/地形几何无耦合，是刀 2 里最干净的一块。
//
// `view` 字段：w, h, baseMap, baseMapKey, colorMode, dataChartType, showDataChart,
//   showMinimap, showBurgs, hoveredBurg, selectedBurg, cameraX/Y/Scale,
//   screenToWorld, terrain, ringPointsList(prov), vx(p), vy(p), formatPopulation(n)
//
// ⚠️ 缓存（小地图缩略图）必须**按实例**：它按 `baseMapKey + 几何版本号` 失效，
//    跨实例共享会让两个画布互相顶掉对方的缩略图。

const MINIMAP_SIZE = 150;

function formatPopulationFallback(n) {
  const v = Number(n) || 0;
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v);
}

export function createOverlayLayers() {
  let minimapRev = 0;
  let minimapCache = { key: '', entry: null };

  /** 省份几何/底图变化时作废小地图缓存（由 SFC 的 watch 调用） */
  function invalidateMinimap() {
    minimapRev++;
  }

  /** 缩略图局部坐标系（0,0 起算，与屏幕上的摆放位置无关） */
  function minimapGeo(bounds) {
    const mw = MINIMAP_SIZE;
    const mh = MINIMAP_SIZE;
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;
    const scale = Math.min((mw - 4) / spanX, (mh - 4) / spanY);
    return {
      scale,
      offX: 2 + ((mw - 4) - spanX * scale) / 2,
      offY: 2 + ((mh - 4) - spanY * scale) / 2,
    };
  }

  function computeBounds(view) {
    const terrain = view.terrain;
    if (!terrain || !terrain.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const prov of terrain) {
      for (const pts of view.ringPointsList(prov)) {      // 多环：飞地 / 洞都要进包围盒
        for (const p of pts) {
          const px = view.vx(p);
          const py = view.vy(p);
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }
      }
    }
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  function buildThumb(view, bounds, geo) {
    const cv = document.createElement('canvas');
    cv.width = MINIMAP_SIZE;
    cv.height = MINIMAP_SIZE;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(15,26,46,0.85)';
    g.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    const terrain = view.terrain;
    if (terrain) {
      g.fillStyle = 'rgba(148,163,184,0.4)';
      for (const prov of terrain) {
        for (const pts of view.ringPointsList(prov)) {
          if (!pts || pts.length < 3) continue;
          g.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const sx = geo.offX + (view.vx(pts[i]) - bounds.minX) * geo.scale;
            const sy = geo.offY + (view.vy(pts[i]) - bounds.minY) * geo.scale;
            if (i === 0) g.moveTo(sx, sy);
            else g.lineTo(sx, sy);
          }
          g.closePath();
          g.fill();
        }
      }
    }
    return cv;
  }

  function getEntry(view) {
    const key = `${view.baseMapKey}|${minimapRev}|${MINIMAP_SIZE}`;
    if (minimapCache.key === key) return minimapCache.entry;
    const bounds = computeBounds(view);
    let entry = null;
    if (bounds) {
      const geo = minimapGeo(bounds);
      entry = { bounds, geo, thumb: buildThumb(view, bounds, geo) };
    }
    minimapCache = { key, entry };
    return entry;
  }

  /** 小地图 + 视口框（左下角） */
  function drawMinimap(c, view) {
    if (!view.showMinimap) return;
    const entry = getEntry(view);
    if (!entry) return;
    const { bounds, geo, thumb } = entry;
    const mw = MINIMAP_SIZE;
    const mh = MINIMAP_SIZE;
    const pad = 12;
    const mx = view.w - mw - pad;
    const my = view.h - mh - pad;

    c.save();
    c.drawImage(thumb, mx, my);
    c.strokeStyle = 'rgba(148,163,184,0.5)';
    c.lineWidth = 1;
    c.strokeRect(mx, my, mw, mh);

    const tl = view.screenToWorld(0, 0);
    const br = view.screenToWorld(view.w, view.h);
    const vx1 = mx + geo.offX + (tl.x - bounds.minX) * geo.scale;
    const vy1 = my + geo.offY + (tl.y - bounds.minY) * geo.scale;
    const vx2 = mx + geo.offX + (br.x - bounds.minX) * geo.scale;
    const vy2 = my + geo.offY + (br.y - bounds.minY) * geo.scale;
    c.strokeStyle = '#ffd700';
    c.lineWidth = 1.5;
    c.strokeRect(vx1, vy1, vx2 - vx1, vy2 - vy1);

    c.restore();
  }

  /** 文化/宗教图例（右下角；只列前 22 条） */
  function drawCultureLegend(c, view) {
    const hm = view.baseMap && view.baseMap.heightmap;
    const src = view.colorMode === 'culture' ? hm?.cultures : hm?.religions;
    if (!src || !src.length) return;
    const rows = src.filter(x => x && x.i > 0 && x.color);
    if (!rows.length) return;

    const rowH = 15;
    const shown = rows.slice(0, 22);
    c.font = '11px "PingFang SC", sans-serif';
    let maxW = 40;
    for (const r of shown) maxW = Math.max(maxW, c.measureText(r.name || '').width);
    const boxW = Math.min(250, maxW + 34);
    const boxH = shown.length * rowH + 12;
    const bx = view.w - boxW - 12;
    const by = view.h - boxH - 12;

    c.save();
    c.fillStyle = 'rgba(15,26,46,0.86)';
    c.strokeStyle = 'rgba(148,163,184,0.5)';
    c.lineWidth = 1;
    c.beginPath();
    if (typeof c.roundRect === 'function') c.roundRect(bx, by, boxW, boxH, 6);
    else c.rect(bx, by, boxW, boxH);
    c.fill();
    c.stroke();
    for (let i = 0; i < shown.length; i++) {
      const y = by + 6 + i * rowH;
      c.fillStyle = shown[i].color;
      c.fillRect(bx + 8, y + 3, 10, 10);
      c.fillStyle = '#cbd5e1';
      c.fillText(shown[i].name || '', bx + 24, y + 12);
    }
    c.restore();
  }

  /** 数据分布图（左下角；文化/宗教逐格统计） */
  function drawDataChart(c, view) {
    if (!view.showDataChart) return;
    const hm = view.baseMap && view.baseMap.heightmap;
    const rows = view.dataChartType === 'culture' ? hm?.cultures
      : view.dataChartType === 'religion' ? hm?.religions : null;
    if (!rows || !rows.length) return;
    const data = rows.filter(x => x && x.i > 0 && x.color);
    if (!data.length) return;

    // 统计各文化/宗教的网格点数
    const counts = {};
    const arr = view.dataChartType === 'culture' ? hm.culture : hm.religion;
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const id = arr[i];
      counts[id] = (counts[id] || 0) + 1;
    }

    const labels = data.map(r => ({ name: r.name, color: r.color, count: counts[r.i] || 0 }));
    const total = labels.reduce((s, l) => s + l.count, 0);
    if (!total) return;

    const boxW = 220;
    const boxH = labels.length * 22 + 50;
    const bx = 12;
    const by = view.h - boxH - 12;

    c.save();
    c.fillStyle = 'rgba(15,26,46,0.9)';
    c.strokeStyle = 'rgba(148,163,184,0.5)';
    c.lineWidth = 1;
    c.fillRect(bx, by, boxW, boxH);
    c.strokeRect(bx, by, boxW, boxH);

    c.font = 'bold 12px "PingFang SC", sans-serif';
    c.fillStyle = '#e2e8f0';
    c.fillText(`${view.dataChartType === 'culture' ? '文化' : '宗教'}分布`, bx + 10, by + 18);

    const maxCount = Math.max(...labels.map(l => l.count));
    for (let i = 0; i < labels.length; i++) {
      const y = by + 35 + i * 22;
      const pct = (labels[i].count / total * 100).toFixed(1);
      c.fillStyle = labels[i].color;
      c.fillRect(bx + 10, y, 12, 12);
      c.fillStyle = '#cbd5e1';
      c.font = '11px "PingFang SC", sans-serif';
      c.fillText(`${labels[i].name} ${pct}%`, bx + 28, y + 11);
      // 条形图
      const barW = 80;
      const barX = bx + 120;
      c.fillStyle = labels[i].color;
      c.fillRect(barX, y, (labels[i].count / maxCount) * barW, 12);
    }
    c.restore();
  }

  /** 城镇悬浮卡（悬停或选中的城镇；贴着圆点放，越界自动翻边） */
  function drawBurgTooltip(c, view) {
    if (!view.showBurgs) return;
    const b = view.hoveredBurg || view.selectedBurg;
    if (!b) return;
    const sx = view.cameraX + b.x * view.cameraScale;
    const sy = view.cameraY + b.y * view.cameraScale;
    const title = b.name || '未命名城镇';
    const fmt = view.formatPopulation || formatPopulationFallback;
    const sub = `${b.capital ? '首都 · ' : ''}人口 ${fmt(b.population)}`;
    c.font = '12px "PingFang SC", sans-serif';
    const w = Math.max(c.measureText(title).width, c.measureText(sub).width) + 18;
    const h = 36;
    let tx = sx + 12;
    let ty = sy - h - 6;
    if (tx + w > view.w) tx = sx - w - 12;
    if (ty < 0) ty = sy + 12;
    c.fillStyle = 'rgba(15,26,46,0.94)';
    c.strokeStyle = b.capital ? '#ffd700' : '#475569';
    c.lineWidth = 1;
    c.beginPath();
    if (typeof c.roundRect === 'function') c.roundRect(tx, ty, w, h, 6);
    else c.rect(tx, ty, w, h);
    c.fill();
    c.stroke();
    c.fillStyle = '#e2e8f0';
    c.font = '12px "PingFang SC", sans-serif';
    c.fillText(title, tx + 9, ty + 15);
    c.fillStyle = '#94a3b8';
    c.font = '11px "PingFang SC", sans-serif';
    c.fillText(sub, tx + 9, ty + 28);
  }

  return { drawMinimap, drawCultureLegend, drawDataChart, drawBurgTooltip, invalidateMinimap };
}
