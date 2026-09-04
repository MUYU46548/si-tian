/**
 * GalaxyMap 绘制逻辑模块
 * 从 GalaxyMap.vue 拆分的绘制函数，便于维护和复用
 */

// ===== 数学工具 =====

export function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;
  return Math.hypot(px - closestX, py - closestY);
}

// ===== 凸包算法（Graham Scan）=====

export function convexHull(points) {
  if (points.length < 3) return points;
  
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ===== 背景绘制 =====

export function drawStarfield(ctx, w, h) {
  // 1. 基础深空渐变 — 从中心微亮到边缘暗角
  const bgGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 3500);
  bgGradient.addColorStop(0, '#1a2035');
  bgGradient.addColorStop(0.4, '#141828');
  bgGradient.addColorStop(0.7, '#0e1220');
  bgGradient.addColorStop(1, '#0a0e18');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(-5000, -5000, 10000, 10000);
  
  // 2. 星云层 — 更多层、更低 opacity、有机分布
  const nebulae = [
    { x: 300, y: -200, r: 600, color: 'rgba(60, 90, 180, 0.06)' },
    { x: -400, y: 300, r: 500, color: 'rgba(120, 60, 150, 0.05)' },
    { x: 100, y: 400, r: 400, color: 'rgba(60, 150, 120, 0.04)' },
    { x: -200, y: -350, r: 450, color: 'rgba(150, 100, 60, 0.04)' },
    { x: 600, y: 100, r: 550, color: 'rgba(80, 120, 200, 0.05)' },
    { x: -600, y: -100, r: 480, color: 'rgba(100, 80, 160, 0.04)' },
    { x: 0, y: -500, r: 350, color: 'rgba(120, 180, 100, 0.03)' },
    { x: -500, y: -500, r: 400, color: 'rgba(180, 120, 80, 0.03)' },
  ];
  
  for (const neb of nebulae) {
    const nebGradient = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.r);
    nebGradient.addColorStop(0, neb.color);
    nebGradient.addColorStop(0.4, neb.color.replace(/[\d.]+\)$/, (parseFloat(neb.color.match(/[\d.]+\)$/)[0]) * 0.5) + ')'));
    nebGradient.addColorStop(1, 'transparent');
    ctx.fillStyle = nebGradient;
    ctx.fillRect(neb.x - neb.r, neb.y - neb.r, neb.r * 2, neb.r * 2);
  }
  
  // 3. 网格线 — 更暗、更细腻
  ctx.strokeStyle = 'rgba(60, 80, 120, 0.12)';
  ctx.lineWidth = 0.5;
  const gridSize = 200;
  for (let gx = -2500; gx <= 2500; gx += gridSize) {
    ctx.beginPath();
    ctx.moveTo(gx, -2500);
    ctx.lineTo(gx, 2500);
    ctx.stroke();
  }
  for (let gy = -2500; gy <= 2500; gy += gridSize) {
    ctx.beginPath();
    ctx.moveTo(-2500, gy);
    ctx.lineTo(2500, gy);
    ctx.stroke();
  }
  
  // 4. 星空粒子 — 多层、不同大小和亮度
  for (let layer = 0; layer < 5; layer++) {
    const alpha = 0.08 + layer * 0.04;
    const count = 150 + layer * 60;
    const sizeBase = 0.3 + layer * 0.3;
    const seedOffset = layer * 234;
    ctx.fillStyle = `rgba(220, 230, 245, ${alpha})`;
    for (let i = seedOffset; i < count + seedOffset; i++) {
      const x = ((i * 97 + 23 + layer * 137) % 3500) - 1750;
      const y = ((i * 61 + 41 + layer * 89) % 3500) - 1750;
      const size = sizeBase + (i % 5) * 0.2;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  // 5. 亮星 — 少量高亮星星带光晕
  for (let i = 0; i < 20; i++) {
    const x = ((i * 137 + 53) % 3000) - 1500;
    const y = ((i * 89 + 67) % 3000) - 1500;
    // 光晕
    const starGlow = ctx.createRadialGradient(x, y, 0, x, y, 4);
    starGlow.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
    starGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = starGlow;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    // 核心
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath();
    ctx.arc(x, y, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  
  // 6. 暗角 — 增加深度感
  const vignette = ctx.createRadialGradient(0, 0, 1000, 0, 0, 4000);
  vignette.addColorStop(0, 'transparent');
  vignette.addColorStop(1, 'rgba(5, 8, 16, 0.4)');
  ctx.fillStyle = vignette;
  ctx.fillRect(-5000, -5000, 10000, 10000);
}

// ===== 势力边界绘制 =====

export function computeFactionBorders(galaxyNodes, domainNodes, getBorderPoints) {
  const borders = [];
  const domainGalaxyMap = new Map();
  
  for (const galaxy of galaxyNodes) {
    if (!domainGalaxyMap.has(galaxy.domainId)) {
      domainGalaxyMap.set(galaxy.domainId, []);
    }
    domainGalaxyMap.get(galaxy.domainId).push(galaxy);
  }
  
  for (const domain of domainNodes) {
    const galaxies = domainGalaxyMap.get(domain.id);
    const override = getBorderPoints(domain.id);
    
    if (override) {
      borders.push({
        domainId: domain.id,
        name: domain.name,
        color: domain.factionColor,
        points: override,
        center: { x: domain.x, y: domain.y },
      });
      continue;
    }
    
    if (!galaxies || galaxies.length < 3) {
      const center = { x: domain.x, y: domain.y };
      const radius = domain.radius || 200;
      const circlePoints = [];
      const segments = 12;
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        circlePoints.push({
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        });
      }
      borders.push({
        domainId: domain.id,
        name: domain.name,
        color: domain.factionColor,
        points: circlePoints,
        center,
      });
      continue;
    }
    
    const points = galaxies.map(g => ({ x: g.x, y: g.y }));
    const hull = convexHull(points);
    
    const center = { x: 0, y: 0 };
    for (const p of hull) { center.x += p.x; center.y += p.y; }
    center.x /= hull.length;
    center.y /= hull.length;
    
    const expandedHull = hull.map(p => {
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const dist = Math.hypot(dx, dy) || 1;
      return {
        x: p.x + (dx / dist) * 50,
        y: p.y + (dy / dist) * 50,
      };
    });
    
    borders.push({
      domainId: domain.id,
      name: domain.name,
      color: domain.factionColor,
      points: expandedHull,
      center,
    });
  }
  
  return borders;
}

export function drawFactionBorders(ctx, lod, borders, editingBoundary) {
  for (const border of borders) {
    if (border.points.length < 3) continue;
    
    const isEditing = editingBoundary?.domainId === border.domainId;
    
    ctx.save();
    ctx.shadowColor = border.color;
    ctx.shadowBlur = isEditing ? 50 : 35;
    ctx.beginPath();
    ctx.moveTo(border.points[0].x, border.points[0].y);
    for (let i = 1; i < border.points.length; i++) {
      ctx.lineTo(border.points[i].x, border.points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = border.color + '12';
    ctx.fill();
    ctx.restore();
    
    const gradient = ctx.createRadialGradient(
      border.center.x, border.center.y, 0,
      border.center.x, border.center.y, 400
    );
    gradient.addColorStop(0, border.color + '35');
    gradient.addColorStop(0.5, border.color + '22');
    gradient.addColorStop(1, border.color + '10');
    
    ctx.beginPath();
    ctx.moveTo(border.points[0].x, border.points[0].y);
    for (let i = 1; i < border.points.length; i++) {
      ctx.lineTo(border.points[i].x, border.points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    
    ctx.strokeStyle = border.color + '60';
    ctx.lineWidth = isEditing ? 8 : 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(border.points[0].x, border.points[0].y);
    for (let i = 1; i < border.points.length; i++) {
      ctx.lineTo(border.points[i].x, border.points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    ctx.strokeStyle = border.color + (isEditing ? 'FF' : 'CC');
    ctx.lineWidth = isEditing ? 3.5 : 2.5;
    ctx.beginPath();
    ctx.moveTo(border.points[0].x, border.points[0].y);
    for (let i = 1; i < border.points.length; i++) {
      ctx.lineTo(border.points[i].x, border.points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    if (lod > 0.4) {
      const cx = border.center.x;
      const cy = border.center.y;
      
      ctx.font = `bold ${Math.round(14 * lod)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const text = border.name;
      const metrics = ctx.measureText(text);
      const padding = 10;
      
      ctx.fillStyle = border.color + 'EE';
      ctx.beginPath();
      ctx.roundRect(
        cx - metrics.width / 2 - padding,
        cy - 14 * lod,
        metrics.width + padding * 2,
        28 * lod,
        8
      );
      ctx.fill();
      
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1.0;
      
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(text, cx, cy);
    }
  }
}

export function drawBoundaryEditHelpers(ctx, borders, hoveredBoundaryVertex) {
  for (const border of borders) {
    for (let i = 0; i < border.points.length; i++) {
      const p = border.points[i];
      const isHovered = hoveredBoundaryVertex?.domainId === border.domainId && 
                        hoveredBoundaryVertex?.vertexIndex === i;
      
      ctx.save();
      ctx.shadowColor = isHovered ? '#FF6B6B' : border.color;
      ctx.shadowBlur = isHovered ? 15 : 8;
      ctx.fillStyle = isHovered ? '#FF6B6B' : border.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 10 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 10 : 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ===== 航道绘制 =====

export function drawHyperlanes(ctx, hyperlanes, galaxyNodes, animationTime, editMode, hoveredHyperlane) {
  const nodeMap = new Map(galaxyNodes.map(g => [g.id, g]));
  
  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) return;
    
    const isHovered = hoveredHyperlane === h.id;
    const isUserCreated = !h.id.startsWith('auto_');
    
    let baseColor, glowColor, lineWidth;
    
    if (h.type === 'cross_domain') {
      baseColor = isHovered ? 'rgba(230, 160, 255, 1.0)' : 'rgba(200, 140, 255, 0.65)';
      glowColor = 'rgba(200, 140, 255, 0.5)';
      lineWidth = isHovered ? 3 : 2;
    } else if (h.type === 'hyperjump') {
      baseColor = isHovered ? 'rgba(255, 130, 130, 1.0)' : 'rgba(255, 110, 110, 0.55)';
      glowColor = 'rgba(255, 110, 110, 0.5)';
      lineWidth = isHovered ? 3 : 2;
    } else {
      if (isUserCreated) {
        baseColor = isHovered ? 'rgba(100, 255, 200, 1.0)' : 'rgba(100, 255, 180, 0.7)';
        glowColor = 'rgba(100, 255, 180, 0.5)';
        lineWidth = isHovered ? 2.5 : 2;
      } else {
        baseColor = isHovered ? 'rgba(130, 210, 255, 0.9)' : 'rgba(100, 200, 255, 0.5)';
        glowColor = 'rgba(100, 200, 255, 0.35)';
        lineWidth = isHovered ? 2 : 1.5;
      }
    }
    
    // 1. 外层发光（更宽、更柔和）
    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = isHovered ? 25 : 15;
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = lineWidth + 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    if (h.controlPoints && h.controlPoints.length === 1) {
      ctx.quadraticCurveTo(h.controlPoints[0].x, h.controlPoints[0].y, to.x, to.y);
    } else if (h.controlPoints && h.controlPoints.length >= 2) {
      ctx.bezierCurveTo(
        h.controlPoints[0].x, h.controlPoints[0].y,
        h.controlPoints[1].x, h.controlPoints[1].y,
        to.x, to.y
      );
    } else {
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
    ctx.restore();
    
    // 2. 中层光晕（无 shadow，半透明叠加）
    ctx.save();
    ctx.strokeStyle = glowColor;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = lineWidth + 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    if (h.controlPoints && h.controlPoints.length === 1) {
      ctx.quadraticCurveTo(h.controlPoints[0].x, h.controlPoints[0].y, to.x, to.y);
    } else if (h.controlPoints && h.controlPoints.length >= 2) {
      ctx.bezierCurveTo(
        h.controlPoints[0].x, h.controlPoints[0].y,
        h.controlPoints[1].x, h.controlPoints[1].y,
        to.x, to.y
      );
    } else {
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
    ctx.restore();
    
    // 3. 主线
    ctx.strokeStyle = baseColor;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (h.type === 'cross_domain') {
      ctx.setLineDash([5, 10]);
      ctx.lineDashOffset = -animationTime * 25;
    } else if (h.type === 'hyperjump') {
      ctx.setLineDash([10, 5]);
      ctx.lineDashOffset = -animationTime * 35;
    } else if (isUserCreated) {
      ctx.setLineDash([]);
    } else {
      ctx.setLineDash([4, 8]);
      ctx.lineDashOffset = -animationTime * 15;
    }
    
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    
    if (h.controlPoints && h.controlPoints.length > 0) {
      if (h.controlPoints.length === 1) {
        ctx.quadraticCurveTo(h.controlPoints[0].x, h.controlPoints[0].y, to.x, to.y);
      } else {
        ctx.bezierCurveTo(
          h.controlPoints[0].x, h.controlPoints[0].y,
          h.controlPoints[1].x, h.controlPoints[1].y,
          to.x, to.y
        );
      }
    } else {
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    
    // 4. 编辑模式 hover 控制点
    if (editMode && isHovered) {
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      
      if (!h.controlPoints || h.controlPoints.length === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(midX, midY, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      
      if (h.controlPoints && h.controlPoints.length > 0) {
        h.controlPoints.forEach((cp, i) => {
          ctx.fillStyle = 'rgba(255, 200, 50, 0.95)';
          ctx.shadowColor = 'rgba(255, 200, 50, 0.9)';
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          
          ctx.strokeStyle = 'rgba(255, 200, 50, 0.4)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          if (i === 0) {
            ctx.moveTo(from.x, from.y);
          } else {
            ctx.moveTo(h.controlPoints[i-1].x, h.controlPoints[i-1].y);
          }
          ctx.lineTo(cp.x, cp.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });
        
        if (h.controlPoints.length === 1) {
          ctx.strokeStyle = 'rgba(255, 200, 50, 0.4)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(h.controlPoints[0].x, h.controlPoints[0].y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  });
}

// ===== 恒星节点绘制 =====

export function drawGalaxyNodes(ctx, lod, galaxyNodes, animationTime, store, editMode, dragSourceNode, targetNode) {
  galaxyNodes.forEach(galaxy => {
    const isSource = editMode && dragSourceNode && dragSourceNode.id === galaxy.id;
    const isTarget = editMode && targetNode && targetNode.id === galaxy.id;
    const matched = store.isNodeMatched(galaxy.id);
    const isCurrent = store.isCurrentMatch(galaxy.id);
    
    const baseColor = galaxy.factionColor || '#4a90d9';
    const isHighlighted = isSource || isTarget || matched;
    
    let starColor = baseColor;
    if (isSource || isTarget) starColor = '#7affb4';
    if (matched) starColor = isCurrent ? '#ffd700' : '#ffaa00';
    
    const baseRadius = matched ? 8 : 6;
    
    if (lod < 0.35) {
      ctx.fillStyle = starColor;
      ctx.shadowColor = starColor;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(galaxy.x, galaxy.y, baseRadius + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      return;
    }
    
    const flicker = 0.88 + Math.sin(animationTime * 4 + galaxy.x * 0.05) * 0.12;
    
    // 外层光晕 — 更大、更柔和
    const glowRadius = baseRadius * (matched ? 14 : 10) * flicker;
    const glowGradient = ctx.createRadialGradient(
      galaxy.x, galaxy.y, 0,
      galaxy.x, galaxy.y, glowRadius
    );
    glowGradient.addColorStop(0, starColor + 'CC');
    glowGradient.addColorStop(0.2, starColor + '88');
    glowGradient.addColorStop(0.5, starColor + '33');
    glowGradient.addColorStop(0.75, starColor + '11');
    glowGradient.addColorStop(1, 'transparent');
    ctx.fillStyle = glowGradient;
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();
    
    // 星光射线 — 高亮时显示
    if (lod > 0.45 && isHighlighted) {
      const spikeLength = glowRadius * 2.0 * flicker;
      const spikeWidth = 1.5;
      ctx.strokeStyle = starColor + '60';
      ctx.lineWidth = spikeWidth;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(galaxy.x - spikeLength, galaxy.y);
      ctx.lineTo(galaxy.x + spikeLength, galaxy.y);
      ctx.moveTo(galaxy.x, galaxy.y - spikeLength);
      ctx.lineTo(galaxy.x, galaxy.y + spikeLength);
      ctx.stroke();
      
      const diagLength = spikeLength * 0.5;
      ctx.strokeStyle = starColor + '40';
      ctx.lineWidth = spikeWidth * 0.7;
      ctx.beginPath();
      ctx.moveTo(galaxy.x - diagLength, galaxy.y - diagLength);
      ctx.lineTo(galaxy.x + diagLength, galaxy.y + diagLength);
      ctx.moveTo(galaxy.x + diagLength, galaxy.y - diagLength);
      ctx.lineTo(galaxy.x - diagLength, galaxy.y + diagLength);
      ctx.stroke();
    }
    
    // 恒星核心 — 径向渐变（白→原色→暗边）
    const coreGradient = ctx.createRadialGradient(
      galaxy.x - baseRadius * 0.2, galaxy.y - baseRadius * 0.2, 0,
      galaxy.x, galaxy.y, baseRadius
    );
    coreGradient.addColorStop(0, '#FFFFFF');
    coreGradient.addColorStop(0.3, starColor);
    coreGradient.addColorStop(1, shadeColor(starColor, -40));
    ctx.fillStyle = coreGradient;
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, baseRadius, 0, Math.PI * 2);
    ctx.fill();
    
    // 高光点
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(galaxy.x - baseRadius * 0.3, galaxy.y - baseRadius * 0.3, baseRadius * 0.25, 0, Math.PI * 2);
    ctx.fill();
    
    // 标签
    if (lod > 0.65 && galaxy.name) {
      const labelY = galaxy.y + baseRadius + 12;
      
      ctx.font = `${matched ? 'bold ' : ''}10px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      
      const text = galaxy.name;
      const metrics = ctx.measureText(text);
      const padding = 5;
      
      // 半透明背景板
      ctx.fillStyle = 'rgba(10, 14, 24, 0.85)';
      ctx.beginPath();
      ctx.roundRect(
        galaxy.x - metrics.width / 2 - padding,
        labelY - 2,
        metrics.width + padding * 2,
        14,
        3
      );
      ctx.fill();
      
      ctx.fillStyle = isHighlighted ? starColor : 'rgba(230, 240, 255, 0.95)';
      ctx.fillText(text, galaxy.x, labelY);
    }
  });
}

function shadeColor(color, percent) {
  const num = parseInt(color.replace('#', ''), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.max(0, Math.min(255, (num >> 16) + amt));
  const G = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + amt));
  const B = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
  return '#' + (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
}

// ===== 拖拽预览绘制 =====

export function drawDragPreview(ctx, editMode, dragSourceNode, dragMousePos, targetNode) {
  if (!editMode || !dragSourceNode) return;
  
  ctx.save();
  ctx.shadowColor = 'rgba(100, 255, 180, 0.6)';
  ctx.shadowBlur = 15;
  ctx.strokeStyle = 'rgba(100, 255, 180, 0.8)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(dragSourceNode.x, dragSourceNode.y);
  ctx.lineTo(dragMousePos.x, dragMousePos.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  
  ctx.save();
  ctx.shadowColor = 'rgba(100, 255, 180, 0.9)';
  ctx.shadowBlur = 20;
  ctx.strokeStyle = 'rgba(100, 255, 180, 1.0)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(dragSourceNode.x, dragSourceNode.y, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  
  if (targetNode) {
    ctx.save();
    ctx.shadowColor = 'rgba(100, 255, 180, 0.9)';
    ctx.shadowBlur = 20;
    ctx.strokeStyle = 'rgba(100, 255, 180, 1.0)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(targetNode.x, targetNode.y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
