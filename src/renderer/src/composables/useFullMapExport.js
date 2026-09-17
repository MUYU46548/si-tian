// src/renderer/src/composables/useFullMapExport.js
// 全图导出：PNG（离屏 canvas 重绘全部对象，2x 缩放）+ SVG（矢量，可进设计工具继续加工）

import { ref } from 'vue';
import {
  serializeSvg, svgPathD, svgPath, svgRect, svgTextEl, svgCircleEl, svgImageEl,
  svgLine, escXml, stamp,
} from '../utils/svgExport';

// 与 planetDrawing 的同名表保持一致（SVG 导出要复刻画布配色）
const PLACE_TYPE_COLORS = {
  '自然': '#4CAF50', '宗教': '#9B59B6', '皇室': '#F1C40F', '商业': '#E67E22',
  '工业': '#7F8C8D', '居住': '#1ABC9C', '公共': '#3498DB', '特殊': '#E91E63',
};
const NODE_COLORS = { city: '#5B8DEF', town: '#4ECDC4', village: '#4ECDC4', location: '#95E1D3', facility: '#B8A6D9' };

export function useFullMapExport({ store, props, emit, renderer, currentMapData, layers, drawing, referenceImage, places, provinceEditor, markerEditor, lodRef, ruler }) {
  const exportStatus = ref('');

  // 选择"漂亮"步长（1/2/5×10^n）
  function niceStepForScale(raw) {
    if (!isFinite(raw) || raw <= 0) return 100;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const rem = raw / pow;
    let n;
    if (rem <= 1) n = 1;
    else if (rem <= 2) n = 2;
    else if (rem <= 5) n = 5;
    else n = 10;
    return n * pow;
  }

  // 计算所有地图元素的世界包围盒
  function computeFullBounds() {
    const elements = [];
    for (const poly of currentMapData.value?.terrain || []) {
      if (poly.points) elements.push(...poly.points);
    }
    for (const region of currentMapData.value?.regions || []) {
      if (region.points) elements.push(...region.points);
    }
    for (const route of currentMapData.value?.routes || []) {
      if (route.points) elements.push(...route.points);
    }
    for (const marker of currentMapData.value?.markers || []) {
      elements.push({ x: marker.x, y: marker.y });
    }
    for (const label of currentMapData.value?.textLabels || []) {
      elements.push({ x: label.x, y: label.y });
    }
    for (const place of places.value) {
      if (place.coordinate?.x !== null && place.coordinate?.x !== undefined) {
        elements.push({ x: place.coordinate.x, y: place.coordinate.y });
      }
    }
    // 参考图
    const refImg = referenceImage.referenceImage;
    if (refImg && refImg.width) {
      const w = refImg.width * (refImg.scale || 1);
      const h = refImg.height * (refImg.scale || 1);
      elements.push(
        { x: refImg.offsetX - w / 2, y: refImg.offsetY - h / 2 },
        { x: refImg.offsetX + w / 2, y: refImg.offsetY + h / 2 }
      );
    }

    if (elements.length === 0) {
      return { minX: -400, maxX: 400, minY: -400, maxY: 400 };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of elements) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    const padding = 60;
    return {
      minX: minX - padding,
      maxX: maxX + padding,
      minY: minY - padding,
      maxY: maxY + padding,
    };
  }

  // 导出全图高清 PNG
  async function exportFullMapPNG() {
    const bounds = computeFullBounds();
    const scale = 2;
    const w = Math.ceil((bounds.maxX - bounds.minX) * scale);
    const h = Math.ceil((bounds.maxY - bounds.minY) * scale);

    // 尺寸保护：避免超大画布 OOM
    if (w * h > 8000 * 8000) {
      alert('地图范围过大，无法导出全图。请缩小地图范围或减少元素。');
      return;
    }

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d');

    // 背景
    const bgGradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bgGradient.addColorStop(0, '#E8F4F8');
    bgGradient.addColorStop(0.5, '#C8E6C9');
    bgGradient.addColorStop(1, '#FFF9C4');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, w, h);

    // 世界坐标 → 画布坐标变换
    ctx.save();
    ctx.translate(-bounds.minX * scale, -bounds.minY * scale);
    ctx.scale(scale, scale);

    // 强制全细节渲染（lod=1）
    const oldLod = lodRef.value;
    lodRef.value = 1;

    // 参考图
    drawing.drawReferenceImage(ctx);

    if (layers.isVisible('planet', 'terrain')) drawing.drawTerrain(ctx);
    if (layers.isVisible('planet', 'elevation')) drawing.drawElevation(ctx);
    if (layers.isVisible('planet', 'climate')) drawing.drawClimate(ctx);
    if (layers.isVisible('planet', 'precipitation')) drawing.drawPrecipitation(ctx);
    if (layers.isVisible('planet', 'terrainLabels')) drawing.drawTerrainLabels(ctx);
    if (layers.isVisible('planet', 'regions')) drawing.drawRegions(ctx);
    if (layers.isVisible('planet', 'routes')) drawing.drawRoutes(ctx);
    if (layers.isVisible('planet', 'places')) drawing.drawPlaces(ctx);
    if (layers.isVisible('planet', 'markers')) drawing.drawMarkers(ctx);
    if (layers.isVisible('planet', 'clusters')) drawing.drawClusters(ctx);
    if (layers.isVisible('planet', 'textLabels')) drawing.drawTextLabels(ctx);

    lodRef.value = oldLod;
    ctx.restore();

    // 导出时叠加指北针和比例尺（屏幕坐标）- 尊重用户设置
    if (ruler.compassVisible.value) {
      const compassX = w - 50;
      const compassY = 50;
      const compassR = 25;
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeStyle = 'rgba(58, 74, 98, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(compassX, compassY, compassR + 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = '#2a3a52';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', compassX, compassY - compassR + 8);
      ctx.fillText('S', compassX, compassY + compassR - 8);
      ctx.fillText('E', compassX + compassR - 8, compassY);
      ctx.fillText('W', compassX - compassR + 8, compassY);
      ctx.fillStyle = '#f85149';
      ctx.beginPath();
      ctx.moveTo(compassX, compassY - compassR + 2);
      ctx.lineTo(compassX - 6, compassY);
      ctx.lineTo(compassX - 3, compassY);
      ctx.lineTo(compassX - 3, compassY + compassR - 2);
      ctx.lineTo(compassX + 3, compassY + compassR - 2);
      ctx.lineTo(compassX + 3, compassY);
      ctx.lineTo(compassX + 6, compassY);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(42, 58, 82, 0.4)';
      ctx.beginPath();
      ctx.moveTo(compassX, compassY + compassR - 2);
      ctx.lineTo(compassX - 4, compassY + compassR - 8);
      ctx.lineTo(compassX + 4, compassY + compassR - 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    if (ruler.scaleBarVisible.value) {
      const scaleBarX = w - 150;
      const scaleBarY = h - 30;
      const targetPx = 100;
      const worldWidth = bounds.maxX - bounds.minX;
      const worldStep = niceStepForScale(targetPx / (w / worldWidth));
      const barPx = worldStep * (w / worldWidth);
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(scaleBarX - 10, scaleBarY - 18, barPx + 20, 36);
      ctx.strokeStyle = '#2a3a52';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(scaleBarX, scaleBarY);
      ctx.lineTo(scaleBarX + barPx, scaleBarY);
      ctx.moveTo(scaleBarX, scaleBarY - 6);
      ctx.lineTo(scaleBarX, scaleBarY + 6);
      ctx.moveTo(scaleBarX + barPx, scaleBarY - 6);
      ctx.lineTo(scaleBarX + barPx, scaleBarY + 6);
      ctx.stroke();
      ctx.font = '13px sans-serif';
      ctx.fillStyle = '#2a3a52';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const scaleLabel = worldStep >= 1000 ? (worldStep / 1000) + 'km' : worldStep + 'm';
      ctx.fillText(scaleLabel, scaleBarX + barPx / 2, scaleBarY + 10);
      ctx.restore();
    }

    // 通过保存对话框导出
    try {
      const dataUrl = tmp.toDataURL('image/png');
      const result = await window.sitianAPI.saveExportFile({
        dataUrl,
        defaultName: `sitian-${props.planet?.id || 'map'}-full-${Date.now()}.png`,
      });
      if (result?.success) {
        exportStatus.value = `导出成功：${result.path}`;
        setTimeout(() => { exportStatus.value = ''; }, 4000);
      } else if (result?.canceled) {
        exportStatus.value = '已取消导出';
        setTimeout(() => { exportStatus.value = ''; }, 2000);
      } else {
        exportStatus.value = `导出失败：${result?.error || '未知错误'}`;
        setTimeout(() => { exportStatus.value = ''; }, 4000);
      }
    } catch (e) {
      // 浏览器环境（无 Electron API）：回退下载
      tmp.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sitian-${props.planet?.id || 'map'}-full-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');
      exportStatus.value = '已下载（浏览器回退模式）';
      setTimeout(() => { exportStatus.value = ''; }, 3000);
    }
  }

  // ============================================================
  // SVG 矢量导出
  // 与 PNG 共用同一份数据源；几何忠实复刻，配色沿用画布的表
  // ============================================================

  function centroidOf(points) {
    let x = 0, y = 0, n = 0;
    for (const p of points || []) {
      const px = p.x !== undefined ? p.x : p[0];
      const py = p.y !== undefined ? p.y : p[1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      x += px; y += py; n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  function buildFullMapSVG({ legend = true, title = true } = {}) {
    const bounds = computeFullBounds();
    const W = Math.ceil(bounds.maxX - bounds.minX);
    const H = Math.ceil(bounds.maxY - bounds.minY);
    const defs = [];
    const body = [];
    const md = currentMapData.value || {};
    const vis = (id) => layers.isVisible('planet', id);

    body.push(`<g transform="translate(${Math.round(-bounds.minX)},${Math.round(-bounds.minY)})">`);

    // 参考底图（数据 URL 内联，光栅化时无需外部资源）
    const ri = referenceImage.referenceImage;
    if (ri && ri.dataUrl && ri.width) {
      const w = ri.width * (ri.scale || 1);
      const h = ri.height * (ri.scale || 1);
      const rot = (ri.rotation || 0) * 180 / Math.PI;
      body.push(`<g transform="translate(${Math.round(ri.offsetX || 0)},${Math.round(ri.offsetY || 0)}) ` +
        `rotate(${Math.round(rot)}) translate(${Math.round(-w / 2)},${Math.round(-h / 2)})">`);
      body.push(svgImageEl(0, 0, w, h, ri.dataUrl, { opacity: ri.opacity ?? 0.6 }));
      body.push('</g>');
    }

    // 地形多边形
    if (vis('terrain')) {
      for (const poly of md.terrain || []) {
        const pts = poly.points || [];
        if (pts.length < 3) continue;
        const d = svgPathD(pts, { closed: true });
        if (!d) continue;
        const col = (provinceEditor?.terrainTypes || []).find((t) => t.type === poly.type)?.color || '#A3C4BC';
        body.push(svgPath(d, {
          fill: col, 'fill-opacity': 0.92, stroke: 'rgba(0,0,0,0.28)', 'stroke-width': 0.8,
          'stroke-linejoin': 'round',
        }));
      }
    }

    // 地形名称
    if (vis('terrainLabels')) {
      for (const poly of md.terrain || []) {
        const nm = poly.name;
        if (!nm || /^\(?未命名/.test(nm)) continue;      // 匿名对象不标注
        const c = centroidOf(poly.points);
        if (!c) continue;
        body.push(svgTextEl(c.x, c.y, nm, {
          fill: '#3c4150', 'font-size': 12, 'font-family': 'Microsoft YaHei, sans-serif',
          'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: 0.9,
        }));
      }
    }

    // 区域多边形
    if (vis('regions')) {
      for (const region of md.regions || []) {
        const pts = region.points || [];
        if (pts.length < 3) continue;
        const d = svgPathD(pts, { closed: true });
        if (!d) continue;
        body.push(svgPath(d, {
          fill: region.color || '#7c3aed', 'fill-opacity': 0.3,
          stroke: region.color || '#7c3aed', 'stroke-width': 1.2, 'stroke-opacity': 0.8,
        }));
      }
    }

    // 路线 / 道路
    if (vis('routes')) {
      for (const route of md.routes || []) {
        const pts = route.points || [];
        if (pts.length < 2) continue;
        const d = svgPathD(pts, { closed: false, straight: true });
        if (!d) continue;
        body.push(svgPath(d, {
          fill: 'none', stroke: route.color || '#c9a227',
          'stroke-width': route.width || 2.5, 'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          ...(route.dashed ? { 'stroke-dasharray': '7 5' } : {}),
        }));
      }
    }

    // 河流
    if (vis('rivers')) {
      for (const river of md.rivers || []) {
        const pts = river.points || river;
        if (!Array.isArray(pts) || pts.length < 2) continue;
        const d = svgPathD(pts, { closed: false, straight: true });
        if (!d) continue;
        body.push(svgPath(d, {
          fill: 'none', stroke: river.color || '#5d97bb',
          'stroke-width': river.width || 2, 'stroke-linecap': 'round',
        }));
      }
    }

    // 标记
    if (vis('markers')) {
      for (const mk of md.markers || []) {
        const col = mk.color || '#f6ad55';
        body.push(svgCircleEl(mk.x, mk.y, 5, { fill: col, stroke: '#1a2a3a', 'stroke-width': 1.2 }));
        if (mk.name) {
          body.push(svgTextEl(mk.x, mk.y - 10, mk.name, {
            fill: '#e2e8f0', 'font-size': 10, 'font-family': 'Microsoft YaHei, sans-serif',
            'text-anchor': 'middle',
          }));
        }
      }
    }

    // 聚落 / 地点
    if (vis('places')) {
      for (const pl of places.value || []) {
        const cx = pl.coordinate?.x, cy = pl.coordinate?.y;
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        const col = (pl.placeType && PLACE_TYPE_COLORS[pl.placeType])
          || NODE_COLORS[pl.layer] || '#95E1D3';
        const r = pl.layer === 'city' ? 6 : (pl.layer === 'town' || pl.layer === 'village' ? 4.5 : 3.5);
        body.push(svgCircleEl(cx, cy, r, { fill: col, stroke: '#ffffff', 'stroke-width': 1 }));
        if (pl.name) {
          body.push(svgTextEl(cx, cy - r - 4, pl.name, {
            fill: '#dbeafe', 'font-size': 10, 'font-family': 'Microsoft YaHei, sans-serif',
            'text-anchor': 'middle',
          }));
        }
      }
    }

    // 浮动文本
    if (vis('textLabels')) {
      for (const lb of md.textLabels || []) {
        const size = (lb.fontSize || 14) * (lb.scale || 1);
        const rot = lb.rotation || 0;
        const transform = rot ? ` transform="rotate(${Math.round(rot)} ${Math.round(lb.x)} ${Math.round(lb.y)})"` : '';
        body.push(`<text x="${Math.round(lb.x)}" y="${Math.round(lb.y)}" fill="${escXml(lb.color || '#3c4150')}"` +
          ` font-size="${Math.round(size)}" font-family="Microsoft YaHei, sans-serif"` +
          ` text-anchor="middle"${transform}>${escXml(lb.text || '')}</text>`);
      }
    }

    body.push('</g>');

    // 标题（左上）
    if (title) {
      const lines = [
        props.planet?.name || props.planet?.id || '行星地图',
        `${md.terrain?.length || 0} 地形 · ${md.regions?.length || 0} 区域 · ${(places.value || []).length} 地点`,
      ];
      body.push(svgRect(12, 12, 250, 20 + lines.length * 16, {
        fill: 'rgba(15,23,42,0.86)', stroke: '#334155', 'stroke-width': 1, rx: 6,
      }));
      lines.forEach((t, i) => {
        body.push(svgTextEl(24, 32 + i * 16, t, {
          fill: i === 0 ? '#e2e8f0' : '#94a3b8', 'font-size': i === 0 ? 13 : 10,
          'font-family': 'Microsoft YaHei, sans-serif',
        }));
      });
    }

    // 图例（右上）：地形类型分布
    if (legend) {
      const counts = {};
      for (const poly of md.terrain || []) {
        if (poly.type) counts[poly.type] = (counts[poly.type] || 0) + 1;
      }
      const rows = (provinceEditor?.terrainTypes || []).filter((t) => counts[t.type]);
      if (rows.length) {
        const lw = 168;
        const lh = 20 + rows.length * 15;
        const lx = W - lw - 12;
        body.push(svgRect(lx, 12, lw, lh, {
          fill: 'rgba(15,23,42,0.86)', stroke: '#334155', 'stroke-width': 1, rx: 6,
        }));
        body.push(svgTextEl(lx + 12, 30, '地形', {
          fill: '#64748b', 'font-size': 10, 'font-family': 'Microsoft YaHei, sans-serif',
        }));
        rows.forEach((t, i) => {
          const y = 46 + i * 15;
          body.push(svgRect(lx + 12, y - 7, 9, 9, { fill: t.color || '#A3C4BC', rx: 2 }));
          body.push(svgTextEl(lx + 27, y, t.label || t.type, {
            fill: '#cbd5e1', 'font-size': 11, 'font-family': 'Microsoft YaHei, sans-serif',
          }));
          body.push(svgTextEl(W - 20, y, String(counts[t.type]), {
            fill: '#64748b', 'font-size': 10, 'font-family': 'Microsoft YaHei, sans-serif',
            'text-anchor': 'end',
          }));
        });
      }
    }

    return { svg: serializeSvg({ width: W, height: H, background: '#1a2a3a', defs, body }), width: W, height: H };
  }

  async function exportFullMapSVG() {
    try {
      const { svg } = buildFullMapSVG();
      const defaultName = `sitian-${props.planet?.id || 'map'}-full-${stamp()}.svg`;
      if (window.sitianAPI?.saveTextFile) {
        const r = await window.sitianAPI.saveTextFile({ text: svg, defaultName, kind: 'svg' });
        if (r?.success) exportStatus.value = `已导出 SVG：${r.path}`;
        else if (r?.canceled) exportStatus.value = '已取消导出';
        else exportStatus.value = `导出失败：${r?.error || '未知错误'}`;
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        a.download = defaultName;
        a.click();
        exportStatus.value = '已下载（浏览器回退模式）';
      }
      setTimeout(() => { exportStatus.value = ''; }, 5000);
      return { success: true };
    } catch (e) {
      exportStatus.value = `导出失败：${e.message}`;
      setTimeout(() => { exportStatus.value = ''; }, 5000);
      return { success: false, error: e.message };
    }
  }

  return {
    exportStatus,
    computeFullBounds,
    exportFullMapPNG,
    exportFullMapSVG,
    buildFullMapSVG,
    niceStepForScale,
  };
}
