// src/renderer/src/composables/useFullMapExport.js
// 全图高清导出：离屏 canvas 重绘全部对象，2x 缩放

import { ref } from 'vue';

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
        exportStatus.value = `✅ 导出成功：${result.path}`;
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
      exportStatus.value = '✅ 已下载（浏览器回退模式）';
      setTimeout(() => { exportStatus.value = ''; }, 3000);
    }
  }

  return {
    exportStatus,
    computeFullBounds,
    exportFullMapPNG,
    niceStepForScale,
  };
}
