/**
 * composables/planetDrawing.js — 行星地图 Canvas 绘制函数（批次 2a：从 PlanetMap.vue 拆分）
 *
 * 纯绘制函数集合：不持有状态，通过 createPlanetDrawing(getState) 工厂注入状态访问器。
 * getState() 每次渲染时调用，返回解包后的最新状态对象（ref 已在组件侧 .value 解包）。
 * 拆分原则：绘制只读状态 + 渲染，交互/修改留在组件。
 */
import { getTexturePattern } from '../utils/textures';

// ===== 样式常量（从 PlanetMap.vue 迁移） =====
const NODE_COLORS = { city: '#5B8DEF', town: '#4ECDC4', village: '#4ECDC4', location: '#95E1D3', facility: '#B8A6D9' };
const NODE_RADIUS = { city: 10, town: 7, village: 7, location: 5, facility: 5 };
const LABEL_SIZE = { city: 13, town: 12, village: 12, location: 11, facility: 11 };
const LABEL_WEIGHT = { city: 'bold', town: 'normal', village: 'normal', location: 'normal', facility: 'normal' };
const PLACE_TYPE_COLORS = {
  '自然': '#4CAF50', '宗教': '#9B59B6', '皇室': '#F1C40F', '商业': '#E67E22',
  '工业': '#7F8C8D', '居住': '#1ABC9C', '公共': '#3498DB', '特殊': '#E91E63',
};
const PLACE_TYPE_ICONS = {
  '自然': '⛰', '宗教': '⛪', '皇室': '🏯', '商业': '🏪',
  '工业': '🏭', '居住': '🏠', '公共': '🏛', '特殊': '✦',
};

// ===== 视口裁剪（批次C1）：视口为世界坐标可见矩形，null 表示不过滤 =====
function pointsBBox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function bboxInViewport(bbox, vp, margin = 0) {
  if (!vp) return true;
  return bbox.maxX >= vp.minX - margin && bbox.minX <= vp.maxX + margin
    && bbox.maxY >= vp.minY - margin && bbox.minY <= vp.maxY + margin;
}

function pointInViewport(x, y, vp, margin = 0) {
  if (!vp) return true;
  return x >= vp.minX - margin && x <= vp.maxX + margin
    && y >= vp.minY - margin && y <= vp.maxY + margin;
}

export function createPlanetDrawing(getState) {
  // ===== 辅助函数（纯函数，不依赖 getState） =====
  function getNodeColor(layer) { return NODE_COLORS[layer] || '#95E1D3'; }
  function getNodeRadius(layer) { return NODE_RADIUS[layer] || 5; }
  function getLabelSize(layer) { return LABEL_SIZE[layer] || 11; }
  function getLabelWeight(layer) { return LABEL_WEIGHT[layer] || 'normal'; }
  function getPlaceIcon(place) { return place.placeType ? PLACE_TYPE_ICONS[place.placeType] : null; }
  function getPlaceColor(place) {
    if (place.placeType && PLACE_TYPE_COLORS[place.placeType]) return PLACE_TYPE_COLORS[place.placeType];
    return getNodeColor(place.layer);
  }
  // 批次C1：接受预建索引，避免每个成员 O(n) find（大图上簇多时每帧 O(成员×地点)）
  function getClusterMembers(cluster, placeById) {
    return cluster.memberIds
      .map(id => placeById.get(id))
      .filter(Boolean);
  }

function drawReferenceImage(ctx) {
  const s = getState(); // 每次渲染取最新状态
  const refs = s.referenceImages;
  if (!refs || refs.length === 0) return;
  
  refs.forEach((refImg, idx) => {
    if (!refImg || !refImg.dataUrl) return;
    const img = s.refImageObjs[refImg.id];
    if (!img) return;
    
    const w = (refImg.width || img.width) * (refImg.scale || 1);
    const h = (refImg.height || img.height) * (refImg.scale || 1);
    const rot = (refImg.rotation || 0) % 4; // 0/1/2/3 = 0/90/180/270°
    const flipH = !!refImg.flipH;
    const cx = refImg.offsetX;
    const cy = refImg.offsetY;
    // 旋转后绘制尺寸交换（90/270 时宽高互换）
    const drawW = rot % 2 === 0 ? w : h;
    const drawH = rot % 2 === 0 ? h : w;
    
    ctx.save();
    ctx.globalAlpha = refImg.opacity ?? 0.5;
    ctx.translate(cx, cy);
    ctx.rotate(rot * Math.PI / 2);
    if (flipH) ctx.scale(-1, 1);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
    
    // 未锁定且拖动模式开启时，只对当前选中图显示虚线边框提示（与图片同变换）
    if (s.editMode && !refImg.locked && s.refDragMode && idx === s.activeRefIndex) {
      ctx.save();
      ctx.strokeStyle = '#4A90D9';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.translate(cx, cy);
      ctx.rotate(rot * Math.PI / 2);
      if (flipH) ctx.scale(-1, 1);
      ctx.strokeRect(-drawW / 2, -drawH / 2, drawW, drawH);
      ctx.setLineDash([]);
      ctx.fillStyle = '#4A90D9';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`参考底图（可拖动）${refs.length > 1 ? ` · ${idx + 1}/${refs.length}` : ''}`, -drawW / 2, -drawH / 2 - 8);
      ctx.restore();
    }
  });
}

// 迷雾占位符：地图未编辑时的探索态视觉（参考原神未探索区域）
function drawFog(ctx, w, h) {
  const s = getState(); // 每次渲染取最新状态
  ctx.save();
  // 轻微压暗（不再是整图变暗），仅作"未绘制"提示
  const fogGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1200);
  fogGradient.addColorStop(0, 'rgba(20, 30, 40, 0.08)');
  fogGradient.addColorStop(1, 'rgba(10, 15, 22, 0.14)');
  ctx.fillStyle = fogGradient;
  ctx.fillRect(-2000, -2000, 4000, 4000);
  
  // 迷雾边缘晕染（模拟云层，透明度降低）
  for (let i = 0; i < 20; i++) {
    const x = ((i * 137 + 53) % 3000) - 1500;
    const y = ((i * 89 + 67) % 3000) - 1500;
    const r = 80 + (i % 5) * 40;
    const cloud = ctx.createRadialGradient(x, y, 0, x, y, r);
    cloud.addColorStop(0, 'rgba(180, 200, 220, 0.03)');
    cloud.addColorStop(1, 'transparent');
    ctx.fillStyle = cloud;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  
  // 提示文字
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(120, 140, 160, 0.5)';
  ctx.fillText('这片区域尚未绘制 — 点击「编辑地图」开始探索', 0, 0);
  ctx.restore();
}

function drawBackground(ctx, w, h) {
  const s = getState();
  // 只填充可见区域（避免每帧填充 4000x4000 像素）
  const topLeft = s.screenToWorld(0, 0);
  const bottomRight = s.screenToWorld(w, h);
  
  const bgGradient = ctx.createRadialGradient(
    (topLeft.x + bottomRight.x) / 2, (topLeft.y + bottomRight.y) / 2, 0,
    (topLeft.x + bottomRight.x) / 2, (topLeft.y + bottomRight.y) / 2,
    Math.max(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y) * 0.7
  );
  bgGradient.addColorStop(0, '#E8F4F8');
  bgGradient.addColorStop(0.5, '#C8E6C9');
  bgGradient.addColorStop(1, '#FFF9C4');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  
  // 网格线（间距可配，随 gridSize 变化；编辑模式更亮辅助对齐）
  const gs = s.gridSize;
  const gridAlpha = s.editMode ? 0.28 : 0.15;
  ctx.lineWidth = 0.5;
  
  const startX = Math.floor(topLeft.x / gs) * gs;
  const startY = Math.floor(topLeft.y / gs) * gs;
  
  for (let gx = startX; gx <= bottomRight.x; gx += gs) {
    const isMajor = gx % 500 === 0;
    ctx.strokeStyle = isMajor ? `rgba(120, 160, 190, ${gridAlpha + 0.12})` : `rgba(150, 180, 200, ${gridAlpha})`;
    ctx.beginPath();
    ctx.moveTo(gx, topLeft.y);
    ctx.lineTo(gx, bottomRight.y);
    ctx.stroke();
  }
  for (let gy = startY; gy <= bottomRight.y; gy += gs) {
    const isMajor = gy % 500 === 0;
    ctx.strokeStyle = isMajor ? `rgba(120, 160, 190, ${gridAlpha + 0.12})` : `rgba(150, 180, 200, ${gridAlpha})`;
    ctx.beginPath();
    ctx.moveTo(topLeft.x, gy);
    ctx.lineTo(bottomRight.x, gy);
    ctx.stroke();
  }
}

function drawTerrain(ctx) {
  const s = getState(); // 每次渲染取最新状态
  const terrain = s.currentMapData?.terrain || [];
  const vp = s.viewport;

  terrain.forEach(poly => {
    if (!poly.points || poly.points.length < 3) return;
    if (!bboxInViewport(pointsBBox(poly.points), vp)) return; // 批次C1：视口外的多边形整块跳过

    const terrainColor = s.terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC';
    const isSelected = s.selectedProvince?.id === poly.id;
    
    ctx.beginPath();
    ctx.moveTo(poly.points[0].x, poly.points[0].y);
    for (let i = 1; i < poly.points.length; i++) {
      ctx.lineTo(poly.points[i].x, poly.points[i].y);
    }
    ctx.closePath();
    
    // 填充（不透明实色：地形"唯一值"，后画的地形直接覆盖先画的，无透明度叠加）
    ctx.fillStyle = terrainColor;
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.globalAlpha = 1;

    // 程序化纹理（P2-4）：LOD 高时叠加细节增强 EU4 省份质感；低缩放纯色省性能
    // 拖拽（fastMode）不跳过纹理：pattern 是缓存的一次 fill，成本低（2026-08-16 用户反馈拖拽时纹理消失）
    if (s.lodRef > 0.55) {
      const pattern = getTexturePattern(poly.type, terrainColor, ctx);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.globalAlpha = 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    
    // 边界线
    ctx.strokeStyle = isSelected ? '#FFD700' : darkenColor(terrainColor, 20);
    ctx.lineWidth = isSelected ? 3 : 1.5;
    ctx.stroke();
  });
}

function drawRegions(ctx) {
  const s = getState(); // 每次渲染取最新状态
  const regions = s.currentMapData?.regions || [];
  // 自动生成的区域边界始终显示（辅助理解区域划分），编辑模式下更淡
  const showAuto = s.autoRegions.length > 0;
  const vp = s.viewport;
  const fast = s.isFastMode; // 批次C1：拖拽中跳过名称标签

  regions.forEach(region => {
    if (!region.points || region.points.length < 3) return;
    if (!bboxInViewport(pointsBBox(region.points), vp)) return;

    const color = region.color || '#FF6B6B';
    const isSelected = s.selectedRegion?.id === region.id;
    
    ctx.beginPath();
    ctx.moveTo(region.points[0].x, region.points[0].y);
    for (let i = 1; i < region.points.length; i++) {
      ctx.lineTo(region.points[i].x, region.points[i].y);
    }
    ctx.closePath();
    
    ctx.fillStyle = color;
    ctx.globalAlpha = isSelected ? 0.5 : 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    if (region.name && s.lodRef > 0.3 && !fast) {
      const center = getPolygonCenter(region.points);
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(region.name, center.x, center.y);
    }
  });

  if (showAuto) {
    s.autoRegions.forEach(region => {
      if (!region.points || region.points.length < 3) return;
      if (!bboxInViewport(pointsBBox(region.points), vp)) return;
      const color = region.color || '#FF6B6B';
      
      ctx.save();
      // 编辑模式下更淡，避免干扰绘制
      ctx.globalAlpha = s.editMode ? 0.08 : 0.18;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(region.points[0].x, region.points[0].y);
      for (let i = 1; i < region.points.length; i++) {
        ctx.lineTo(region.points[i].x, region.points[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.moveTo(region.points[0].x, region.points[0].y);
      for (let i = 1; i < region.points.length; i++) {
        ctx.lineTo(region.points[i].x, region.points[i].y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      
      if (region.name && s.lodRef > 0.3 && !fast) {
        const center = getPolygonCenter(region.points);
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(`⏳ ${region.name}`, center.x, center.y);
      }
    });
  }
}

function drawPlaces(ctx) {
  const s = getState(); // 每次渲染取最新状态
  const vp = s.viewport;
  const fast = s.isFastMode; // 批次C1：拖拽中跳过光晕/图标/文字（最贵的逐元素效果）
  s.places.forEach(place => {
    const x = place.coordinate?.x || 0;
    const y = place.coordinate?.y || 0;
    // margin 覆盖标签与光环的绘制范围（约半径+标签行+徽标行）
    if (!pointInViewport(x, y, vp, 120)) return;
    const color = getPlaceColor(place);
    const radius = getNodeRadius(place.layer);
    const isHovered = s.hoveredNode?.id === place.id;
    const icon = getPlaceIcon(place);

    ctx.fillStyle = color;
    if (!fast) {
      ctx.shadowColor = color;
      ctx.shadowBlur = isHovered ? 12 : 6;
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (icon && !fast && s.lodRef > 0.6) {
      // 高缩放：地点类型图标覆盖中心
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';
      ctx.globalAlpha = 0.95;
      ctx.fillText(icon, x, y + 0.5);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#FFFFFF';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    
    if (place.name && !fast && s.lodRef > 0.4) {
      ctx.font = `${getLabelWeight(place.layer)} ${getLabelSize(place.layer)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#2D3436';
      ctx.fillText(place.displayName || place.name, x, y + radius + 4);
    }

    // 锁定标记
    if (place.locked && !fast) {
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#E67E22';
      ctx.fillText('🔒', x + radius + 5, y - radius - 5);
    }
    
    // 多选高亮
    if (s.selectedPlaceIds.has(place.id)) {
      ctx.save();
      ctx.strokeStyle = '#58A6FF';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    
    // 暂存地点（draft=true）：虚线边框标记
    if (place.draft) {
      ctx.save();
      ctx.strokeStyle = '#888888';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    
    // 刚放置高亮（金色双层光环 + 名称衬底，提示"这就是刚放的地点"）
    if (s.highlightedPlaceId === place.id) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, radius + 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.45)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(x, y, radius + 20, 0, Math.PI * 2);
      ctx.stroke();
      // 名称带衬底，任何缩放都可见
      const labelText = place.displayName || place.name;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const m = ctx.measureText(labelText);
      ctx.fillStyle = 'rgba(15, 22, 35, 0.85)';
      ctx.beginPath();
      ctx.roundRect(x - m.width / 2 - 6, y - radius - 24, m.width + 12, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#FFD700';
      ctx.fillText(labelText, x, y - radius - 21);
      ctx.restore();
    }
    
    // 区域归属徽标（近缩放时显示所属区域名）
    // fastMode 下 getState 传入空 Map：既跳过绘制，也避免读取 computed 触发全量 pointInPolygon 重算
    const ownedRegion = s.placeRegionMap.get(place.id);
    if (ownedRegion?.name && s.lodRef > 0.75 && !fast) {
      const badgeY = y + radius + (place.name ? 18 : 4);
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const badgeText = `📍 ${ownedRegion.name}`;
      const metrics = ctx.measureText(badgeText);
      const padding = 3;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.beginPath();
      ctx.roundRect(
        x - metrics.width / 2 - padding,
        badgeY - 1,
        metrics.width + padding * 2,
        12,
        4
      );
      ctx.fill();
      ctx.fillStyle = '#888';
      ctx.fillText(badgeText, x, badgeY);
    }
  });
}

function drawMarkers(ctx) {
  const s = getState(); // 每次渲染取最新状态
  if (!s.currentMapData?.markers) return;
  const vp = s.viewport;
  const fast = s.isFastMode; // 批次C1：拖拽中退化为纯色点

  s.currentMapData.markers.forEach(marker => {
    if (!pointInViewport(marker.x, marker.y, vp, 60)) return;
    // markerTypes 由 PlanetMap 经 getState 注入（修复：此前裸引用未导入的标识符，markers 非空即 ReferenceError）
    const preset = (s.markerTypes || []).find(m => m.type === marker.type);
    const color = marker.color || preset?.color || '#FFD700';
    const icon = marker.icon || preset?.icon || '📍';
    const isSelected = s.selectedMarker?.id === marker.id;

    if (!fast) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (!fast) {
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon, marker.x, marker.y);
    }

    if (isSelected) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 名称标签
    if (marker.name && !fast && s.lodRef > 0.4) {
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#2D3436';
      ctx.fillText(marker.name, marker.x, marker.y + 10);
    }
  });
}

// 路线渲染
function drawRoutes(ctx) {
  const s = getState(); // 每次渲染取最新状态
  const routes = s.currentMapData?.routes || [];
  const vp = s.viewport;
  const fast = s.isFastMode; // 批次C1：拖拽中跳过沿路径文字（每帧逐字排版，最贵的路线成本）

  // 绘制中的路线草稿
  if (s.interactionMode === 'route' && s.routeDraftPoints.length > 0) {
    drawRoutePolyline(ctx, s.routeDraftPoints, s.routeColor, s.routeDashed, true);
    s.routeDraftPoints.forEach(p => {
      ctx.fillStyle = '#FF6B6B';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  routes.forEach(route => {
    if (!route.points || route.points.length < 2) return;
    if (!bboxInViewport(pointsBBox(route.points), vp, 40)) return;
    const color = route.color || '#E67E22';
    const isSelected = s.selectedRoute?.id === route.id;

    drawRoutePolyline(ctx, route.points, color, route.dashed, isSelected);

    // 文字标签：优先沿路径排布，路径过短时回退中点居中
    if (route.label && !fast && s.lodRef > 0.3) {
      const offsetX = route.labelOffsetX || 0;
      const offsetY = route.labelOffsetY || 0;
      const ok = drawTextOnPath(ctx, route.label, route.points, 11, color, '#2D3436', offsetX, offsetY);
      if (!ok) {
        const mid = route.points[Math.floor(route.points.length / 2)];
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labelText = route.label;
        const metrics = ctx.measureText(labelText);
        const padding = 4;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.beginPath();
        ctx.roundRect(mid.x - metrics.width / 2 - padding + offsetX, mid.y - 10 + offsetY, metrics.width + padding * 2, 20, 4);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#2D3436';
        ctx.fillText(labelText, mid.x + offsetX, mid.y + offsetY);
      }
    }
  });
  
  // 选中路线的顶点手柄
  if (s.selectedRoute?.points) {
    s.selectedRoute.points.forEach((p, i) => {
      const isHovered = s.hoveredVertex?.vertexIndex === i;
      ctx.fillStyle = isHovered ? '#FF6B6B' : '#FFD700';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

function drawRoutePolyline(ctx, points, color, dashed, highlight) {
  const s = getState(); // 每次渲染取最新状态
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = highlight ? 4 : 2.5;
  if (dashed) ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  
  // 端点圆点
  const first = points[0];
  const last = points[points.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(first.x, first.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// 沿路径排布文字：先画连续白色底带盖住线，再逐字符沿切线旋转绘制
// 返回是否成功（文本过长则回退居中）
function drawTextOnPath(ctx, text, points, fontSize, color, labelColor, offsetX = 0, offsetY = 0) {
  const s = getState(); // 每次渲染取最新状态
  if (!text || points.length < 2) return false;
  
  // 计算各段长度与累计
  const segs = [];
  let totalLen = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len, start: totalLen });
    totalLen += len;
  }
  
  // 估算文本总宽（CJK 字符宽度 ≈ fontSize，半角 ≈ fontSize/2）
  let textWidth = 0;
  for (const ch of text) {
    textWidth += (ch.charCodeAt(0) > 255 ? fontSize : fontSize * 0.55);
  }
  const spacing = textWidth / text.length;
  
  // 路径太短：无法沿路径显示
  if (totalLen < fontSize * 0.8) return false;
  
  ctx.save();
  ctx.font = `bold ${fontSize}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  // 起始偏移：让文字居中于路径
  const startOffset = Math.max(0, (totalLen - textWidth) / 2);
  
  // 字符位置数组
  const charPositions = [];
  for (let i = 0; i < text.length; i++) {
    const charPos = startOffset + i * spacing + spacing / 2;
    if (charPos < 0 || charPos > totalLen) continue;
    
    let seg = null;
    for (const s of segs) {
      if (charPos >= s.start && charPos <= s.start + s.len) { seg = s; break; }
    }
    if (!seg) { seg = segs[segs.length - 1]; }
    const t = Math.min(1, Math.max(0, (charPos - seg.start) / (seg.len || 1)));
    charPositions.push({
      x: seg.a.x + (seg.b.x - seg.a.x) * t,
      y: seg.a.y + (seg.b.y - seg.a.y) * t,
      angle: Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x),
    });
  }
  
  if (charPositions.length === 0) { ctx.restore(); return false; }
  
  // 第一步：沿路径画连续白色底带（lineWidth 高于字符，完全盖住路线）
  // 底带与字符共用同一 offset，保证偏移时背景同步移动
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = fontSize + 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < charPositions.length; i++) {
    const p = charPositions[i];
    if (i === 0) ctx.moveTo(p.x + offsetX, p.y + offsetY);
    else ctx.lineTo(p.x + offsetX, p.y + offsetY);
  }
  ctx.stroke();
  
  // 第二步：逐字符绘制（带 offset 整体平移）
  charPositions.forEach((p, i) => {
    ctx.save();
    ctx.translate(p.x + offsetX, p.y + offsetY);
    ctx.rotate(p.angle);
    ctx.fillStyle = labelColor || '#2D3436';
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  });
  
  ctx.restore();
  return true;
}

// 地形名称标注（独立图层，可切换）
function drawTerrainLabels(ctx) {
  const s = getState();
  const terrain = s.currentMapData?.terrain || [];

  // 仅在 LOD > 0.3 时绘制，与 drawTerrain 的名称标签 LOD 同步（避免重叠）
  if (s.lodRef <= 0.3) return;
  if (s.isFastMode) return; // 批次C1：拖拽中整层跳过
  const vp = s.viewport;

  terrain.forEach(poly => {
    if (!poly.points || poly.points.length < 3 || !poly.name) return;
    if (!bboxInViewport(pointsBBox(poly.points), vp)) return;
    
    const terrainColor = s.terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC';
    const center = getPolygonCenter(poly.points);
    
    ctx.font = `${getLabelWeight(poly.layer)} ${getLabelSize(poly.layer)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = getContrastColor(terrainColor);
    ctx.fillText(poly.name, center.x, center.y);
  });
}

// 地点簇渲染：虚线边界 + 成员高亮/闪烁 + 折叠聚合
function drawClusters(ctx) {
  const s = getState(); // 每次渲染取最新状态
  const clusters = s.currentMapData?.clusters || [];
  const time = performance.now() / 1000;
  const fast = s.isFastMode; // 批次C1：拖拽中跳过凸包重算与标签（松手即恢复）
  // 批次C1：一次 O(n) 建地点索引，替代每成员 O(n) find
  const placeById = new Map((s.places || []).map(p => [p.id, p]));

  clusters.forEach(cluster => {
    if (!cluster.memberIds?.length) return;
    const color = cluster.color || '#FF6B6B';
    const members = getClusterMembers(cluster, placeById);
    if (members.length === 0) return;
    
    const isActive = s.activeClusterId === cluster.id;
    const hasHover = s.hoverMemberId && cluster.memberIds.includes(s.hoverMemberId);
    
    // 折叠：聚合为一个气泡标记
    if (cluster.collapsed) {
      let cx = 0, cy = 0;
      members.forEach(m => { cx += m.coordinate.x; cy += m.coordinate.y; });
      cx /= members.length;
      cy /= members.length;
      
      // 聚合气泡
      const pulse = 10 + Math.sin(time * 2) * 2;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // 数字
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(members.length), cx, cy + 0.5);
      // 标签
      if (s.lodRef > 0.3 && !fast) {
        ctx.font = '10px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#2D3436';
        ctx.fillText(`⛁ ${cluster.name} (${members.length})`, cx, cy + 12);
      }
      ctx.restore();
      return;
    }

    // 展开：虚线范围框（凸包或包围盒）
    // fastMode 跳过：凸包每帧 O(n log n) 重算，拖拽中暂隐、松手即恢复
    if (members.length >= 2 && !fast) {
      const hull = convexHull(members.map(m => ({ x: m.coordinate.x, y: m.coordinate.y })));
      if (hull.length >= 3) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = isActive ? 0.12 : 0.06;
        ctx.beginPath();
        ctx.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        
        ctx.strokeStyle = color;
        ctx.lineWidth = isActive ? 2.5 : 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // 簇名称标签（活动簇显示）
        if (isActive && cluster.name && s.lodRef > 0.3) {
          const center = getPolygonCenter(hull);
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          const metrics = ctx.measureText(cluster.name);
          ctx.beginPath();
          ctx.roundRect(center.x - metrics.width / 2 - 4, center.y - 11, metrics.width + 8, 20, 4);
          ctx.fill();
          ctx.fillStyle = '#2D3436';
          ctx.fillText(cluster.name, center.x, center.y + 0.5);
        }
        ctx.restore();
      }
    }
    
    // 仅悬停成员时闪烁（避免与凸包视觉重复）
    if (hasHover && !fast) {
      const hoverMember = members.find(m => m.id === s.hoverMemberId);
      if (hoverMember) {
        const x = hoverMember.coordinate.x;
        const y = hoverMember.coordinate.y;
        const blink = Math.sin(time * 8) * 0.5 + 0.5;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.4 + blink * 0.6;
        ctx.beginPath();
        ctx.arc(x, y, getNodeRadius(hoverMember.layer) + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  });
  
  // cluster 模式框选预览
  if (s.interactionMode === 'cluster' && s.clusterBoxStart && s.clusterBoxEnd) {
    const start = s.clusterBoxStart;
    const end = s.clusterBoxEnd;
    ctx.save();
    ctx.strokeStyle = '#58A6FF';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y)
    );
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(88, 166, 255, 0.08)';
    ctx.fillRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y)
    );
    ctx.restore();
  }
}

// 浮动文本渲染
function drawTextLabels(ctx) {
  const s = getState(); // 每次渲染取最新状态
  const labels = s.currentMapData?.textLabels || [];
  const vp = s.viewport;

  labels.forEach(label => {
    if (!label?.text) return;
    if (!pointInViewport(label.x, label.y, vp, 250)) return; // 批次C1：margin 覆盖长文本宽度
    const fontSize = label.fontSize || 16;
    const color = label.color || '#2D3436';
    const isSelected = s.selectedTextLabel?.id === label.id;
    
    ctx.save();
    ctx.font = `${fontSize}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // 半透明背景提高可读性
    const metrics = ctx.measureText(label.text);
    const padding = fontSize * 0.4;
    ctx.fillStyle = isSelected ? 'rgba(255, 215, 0, 0.35)' : 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.roundRect(
      label.x - metrics.width / 2 - padding,
      label.y - fontSize / 2 - padding / 2,
      metrics.width + padding * 2,
      fontSize + padding,
      fontSize * 0.3
    );
    ctx.fill();
    
    if (isSelected) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    ctx.fillStyle = color;
    ctx.fillText(label.text, label.x, label.y);
    ctx.restore();
  });
}

function drawEditHelpers(ctx) {
  const s = getState(); // 每次渲染取最新状态
  // 对称轴虚线（P2）：镜像模式开启时显示（沿 X=偏移 或 Y=偏移）
  if (s.mirrorMode && s.editMode) {
    const off = s.mirrorAxisOffset || 0;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (s.mirrorAxis === 'y') {
      ctx.moveTo(off, -2000);
      ctx.lineTo(off, 2000);
    } else {
      ctx.moveTo(-2000, off);
      ctx.lineTo(2000, off);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 拆分模式：切割线起点标记（2026-08-16）
  if (s.splitSelectMode && s.editMode) {
    ctx.save();
    ctx.strokeStyle = '#FFD700';
    ctx.fillStyle = '#FFD700';
    ctx.lineWidth = 2;
    if (s.splitPoints.length === 1) {
      const p = s.splitPoints[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  
  // 笔刷预览：当前笔画落点圆形
  if (s.isBrushing && s.brushMode) {
    const brushColor = s.terrainTypes.find(t => t.type === s.selectedTerrain)?.color || '#000';
    ctx.save();
    ctx.strokeStyle = brushColor;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    s.brushStrokePoints.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, s.brushSize / 2, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  
  // 绘制中的路径
  if (s.isDrawing) {
    ctx.strokeStyle = s.terrainTypes.find(t => t.type === s.selectedTerrain)?.color || '#000';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(s.currentPath[0].x, s.currentPath[0].y);
    for (let i = 1; i < s.currentPath.length; i++) {
      ctx.lineTo(s.currentPath[i].x, s.currentPath[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    
    s.currentPath.forEach(p => {
      ctx.fillStyle = '#FF6B6B';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
    
    // 对称镜像路径预览（P2）：金色虚线
    if (s.mirrorMode && s.currentPath.length >= 2) {
      const mp = s.currentPath.map(mirrorPoint);
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(mp[0].x, mp[0].y);
      for (let i = 1; i < mp.length; i++) {
        ctx.lineTo(mp[i].x, mp[i].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      mp.forEach(p => {
        ctx.fillStyle = 'rgba(255, 200, 50, 0.9)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
  
  // 边缘吸附预览（P1-3）：金色小圆提示将吸附到的已有边界
  if (s.edgeSnapPreview && (s.isDrawing || (s.drawingPolygon && s.drawingPolygon.points.length > 0))) {
    const ep = s.edgeSnapPreview;
    ctx.save();
    ctx.fillStyle = '#FFD700';
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ep.x, ep.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 从最后落点到吸附点的虚线提示
    const last = s.currentPath[s.currentPath.length - 1]
      || (s.drawingPolygon?.points && s.drawingPolygon.points[s.drawingPolygon.points.length - 1]);
    if (last && (last.x !== ep.x || last.y !== ep.y)) {
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(ep.x, ep.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
  
  // 描点模式：绘制中的多边形预览
  if (s.drawingPolygon && s.drawingPolygon.points.length > 0) {
    const pts = s.drawingPolygon.points;
    const strokeColor = s.drawingPolygon.type === 'region'
      ? (s.drawingPolygon.color || '#FF6B6B')
      : (s.terrainTypes.find(t => t.type === s.drawingPolygon.type)?.color || '#000');
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    if (pts.length >= 3) {
      ctx.closePath();
    }
    ctx.stroke();
    ctx.setLineDash([]);
    
    pts.forEach(p => {
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    
    // 描点模式对称镜像预览（P2）
    if (s.mirrorMode && pts.length >= 2) {
      const mp = pts.map(mirrorPoint);
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(mp[0].x, mp[0].y);
      for (let i = 1; i < mp.length; i++) {
        ctx.lineTo(mp[i].x, mp[i].y);
      }
      if (mp.length >= 3) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      mp.forEach(p => {
        ctx.fillStyle = 'rgba(255, 200, 50, 0.9)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
  
  // 选中省份的顶点
  if (s.selectedProvince || s.selectedRegion) {
    const poly = s.selectedProvince || s.selectedRegion;
    poly.points.forEach((p, i) => {
      const isHovered = s.hoveredVertex?.vertexIndex === i;
      ctx.fillStyle = isHovered ? '#FF6B6B' : '#FFD700';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
  
  // 选中省份的边（用于插入顶点）
  if ((s.selectedProvince || s.selectedRegion) && s.hoveredVertex === null) {
    const poly = s.selectedProvince || s.selectedRegion;
    const n = poly.points.length;
    for (let i = 0; i < n; i++) {
      const a = poly.points[i];
      const b = poly.points[(i + 1) % n];
      ctx.strokeStyle = s.selectedRegion ? (s.selectedRegion.color || '#FF6B6B') : 'rgba(255, 215, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  
  // 多选框选预览（Shift+拖动）
  if (s.isBoxSelecting && s.boxSelectStart && s.boxSelectEnd) {
    const start = s.boxSelectStart;
    const end = s.boxSelectEnd;
    ctx.save();
    ctx.strokeStyle = '#58A6FF';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y)
    );
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(88, 166, 255, 0.08)';
    ctx.fillRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y)
    );
    ctx.restore();
  }
}

function drawSelectedHighlight(ctx) {
  const s = getState(); // 每次渲染取最新状态
  if (s.selectedProvince) {
    const poly = s.selectedProvince;
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(poly.points[0].x, poly.points[0].y);
    for (let i = 1; i < poly.points.length; i++) {
      ctx.lineTo(poly.points[i].x, poly.points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ===== 工具函数 =====
function getPolygonCenter(points) {
  const s = getState(); // 每次渲染取最新状态
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function darkenColor(hex, amount) {
  const s = getState(); // 每次渲染取最新状态
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (num >> 16) - amount);
  const g = Math.max(0, ((num >> 8) & 0x00FF) - amount);
  const b = Math.max(0, (num & 0x0000FF) - amount);
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

function getContrastColor(hex) {
  const s = getState(); // 每次渲染取最新状态
  const num = parseInt(hex.replace('#', ''), 16);
  const r = num >> 16;
  const g = (num >> 8) & 0xFF;
  const b = num & 0xFF;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#2D3436' : '#FFFFFF';
}

  return {
    drawReferenceImage,
    drawFog,
    drawBackground,
    drawTerrain,
    drawTerrainLabels,
    drawRegions,
    drawPlaces,
    drawMarkers,
    drawRoutes,
    drawRoutePolyline,
    drawTextOnPath,
    drawClusters,
    drawTextLabels,
    drawEditHelpers,
    drawSelectedHighlight,
    getPolygonCenter,
    darkenColor,
    getContrastColor,
  };
}
