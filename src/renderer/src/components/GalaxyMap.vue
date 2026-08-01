<template>
  <div class="galaxy-map-container">
    <div class="map-header">
      <h2>{{ world?.name }} — 银河系图</h2>
      <p class="hint">点击星域进入 · 滚动缩放 · 拖拽空白处平移</p>
    </div>
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  world: { type: Object, default: null },
  domains: { type: Array, default: () => [] },
  galaxies: { type: Array, default: () => [] }
});

const emit = defineEmits(['select', 'back']);

const canvas = ref(null);
let ctx = null;
let viewTransform = { x: 0, y: 0, scale: 1 };
let isPanning = false;
let mouseDownPos = { x: 0, y: 0 };
let isDragOperation = false;

let domainNodes = [];
let galaxyNodes = [];
let hyperlaneLinks = [];
let layoutApplied = false;
let rafId = null;
let needsRender = true;
let fastMode = false;

onMounted(() => {
  initCanvas();
  applyStableLayout();
  requestRender();
  window.addEventListener('resize', resizeCanvas);
});

onUnmounted(() => {
  window.removeEventListener('resize', resizeCanvas);
  removeCanvasListeners();
  if (rafId) cancelAnimationFrame(rafId);
});

function initCanvas() {
  ctx = canvas.value.getContext('2d');
  resizeCanvas();
  canvas.value.addEventListener('mousedown', onMouseDown);
  canvas.value.addEventListener('mousemove', onMouseMove);
  canvas.value.addEventListener('mouseup', onMouseUp);
  canvas.value.addEventListener('wheel', onWheel, { passive: false });
}

function removeCanvasListeners() {
  if (!canvas.value) return;
  canvas.value.removeEventListener('mousedown', onMouseDown);
  canvas.value.removeEventListener('mousemove', onMouseMove);
  canvas.value.removeEventListener('mouseup', onMouseUp);
  canvas.value.removeEventListener('wheel', onWheel);
}

function resizeCanvas() {
  const parent = canvas.value.parentElement;
  canvas.value.width = parent.clientWidth;
  canvas.value.height = parent.clientHeight;
  requestRender();
}

function requestRender() {
  needsRender = true;
  if (!rafId) {
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (needsRender) {
        needsRender = false;
        render();
      }
    });
  }
}

function applyStableLayout() {
  if (layoutApplied) return;
  layoutApplied = true;
  
  const domainCount = props.domains.length;
  const spacing = 500;
  
  domainNodes = props.domains.map((domain, idx) => {
    const angle = (idx / Math.max(domainCount, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = domainCount > 1 ? spacing * 0.7 : 0;
    return {
      ...domain,
      x: domainCount > 1 ? Math.cos(angle) * radius : 0,
      y: domainCount > 1 ? Math.sin(angle) * radius : 0,
      radius: 220
    };
  });
  
  galaxyNodes = [];
  const domainMap = new Map(domainNodes.map(d => [d.id, d]));
  
  props.galaxies.forEach(galaxy => {
    const parentDomain = domainMap.get(galaxy.parentId);
    if (parentDomain) {
      const domainGalaxies = props.galaxies.filter(g => g.parentId === galaxy.parentId);
      const idx = domainGalaxies.indexOf(galaxy);
      const total = domainGalaxies.length;
      const angle = (idx / Math.max(total, 1)) * Math.PI * 2 + 0.3;
      const dist = 70 + (idx % 3) * 40;
      galaxyNodes.push({
        ...galaxy,
        x: parentDomain.x + Math.cos(angle) * dist,
        y: parentDomain.y + Math.sin(angle) * dist,
        domainId: galaxy.parentId
      });
    }
  });
  
  hyperlaneLinks = [];
  for (let i = 0; i < galaxyNodes.length; i++) {
    for (let j = i + 1; j < galaxyNodes.length; j++) {
      const g1 = galaxyNodes[i];
      const g2 = galaxyNodes[j];
      const dist = Math.hypot(g1.x - g2.x, g1.y - g2.y);
      if (dist < 400) {
        hyperlaneLinks.push({ from: g1, to: g2, crossDomain: g1.domainId !== g2.domainId });
      }
    }
  }
}

function render() {
  if (!ctx || !canvas.value) return;
  const w = canvas.value.width;
  const h = canvas.value.height;
  
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2 + viewTransform.x, h / 2 + viewTransform.y);
  ctx.scale(viewTransform.scale, viewTransform.scale);
  
  drawDomainBackgrounds();
  drawHyperlanes();
  drawDomainNodes();
  drawGalaxyNodes();
  
  ctx.restore();
}

function drawDomainBackgrounds() {
  domainNodes.forEach(domain => {
    const gradient = ctx.createRadialGradient(domain.x, domain.y, 30, domain.x, domain.y, domain.radius);
    gradient.addColorStop(0, 'rgba(74, 144, 217, 0.12)');
    gradient.addColorStop(0.6, 'rgba(74, 144, 217, 0.04)');
    gradient.addColorStop(1, 'rgba(74, 144, 217, 0.01)');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(domain.x, domain.y, domain.radius, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = 'rgba(100, 180, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    ctx.fillStyle = '#a0aec0';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(domain.name, domain.x, domain.y - domain.radius - 12);
  });
}

function drawHyperlanes() {
  hyperlaneLinks.forEach(link => {
    if (link.crossDomain) {
      ctx.strokeStyle = 'rgba(150, 100, 255, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 6]);
    } else {
      ctx.strokeStyle = 'rgba(100, 150, 200, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.moveTo(link.from.x, link.from.y);
    ctx.lineTo(link.to.x, link.to.y);
    ctx.stroke();
  });
  ctx.setLineDash([]);
}

function drawDomainNodes() {
  domainNodes.forEach(domain => {
    if (fastMode) {
      ctx.fillStyle = '#6b5b95';
      ctx.beginPath();
      ctx.arc(domain.x, domain.y, 18, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.shadowColor = 'rgba(107, 91, 149, 0.6)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#6b5b95';
      ctx.beginPath();
      ctx.arc(domain.x, domain.y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#9b8bb5';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
}

function drawGalaxyNodes() {
  galaxyNodes.forEach(galaxy => {
    ctx.fillStyle = '#4a90d9';
    if (!fastMode) {
      ctx.shadowColor = 'rgba(74, 144, 217, 0.4)';
      ctx.shadowBlur = 5;
    }
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    
    if (!fastMode) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(galaxy.name, galaxy.x, galaxy.y + 14);
    }
  });
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - canvas.value.width / 2 - viewTransform.x) / viewTransform.scale,
    y: (sy - canvas.value.height / 2 - viewTransform.y) / viewTransform.scale
  };
}

function hitTest(wx, wy) {
  for (const galaxy of galaxyNodes) {
    const dx = wx - galaxy.x;
    const dy = wy - galaxy.y;
    if (dx * dx + dy * dy < 12 * 12) return { type: 'galaxy', node: galaxy };
  }
  for (const domain of domainNodes) {
    const dx = wx - domain.x;
    const dy = wy - domain.y;
    if (dx * dx + dy * dy < 22 * 22) return { type: 'domain', node: domain };
  }
  return null;
}

function onMouseDown(e) {
  const rect = canvas.value.getBoundingClientRect();
  mouseDownPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  isPanning = true;
  isDragOperation = false;
}

function onMouseMove(e) {
  if (!isPanning) return;
  
  const dx = e.clientX - mouseDownPos.x;
  const dy = e.clientY - mouseDownPos.y;
  
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
    isDragOperation = true;
    fastMode = true;
  }
  
  if (isDragOperation) {
    viewTransform.x += dx;
    viewTransform.y += dy;
    mouseDownPos = { x: e.clientX, y: e.clientY };
    requestRender();
  }
}

function onMouseUp(e) {
  isPanning = false;
  if (!isDragOperation) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const hit = hitTest(world.x, world.y);
    if (hit) {
      if (hit.type === 'domain') {
        emit('select', hit.node);
      } else if (hit.type === 'galaxy') {
        const parentDomain = domainNodes.find(d => d.id === hit.node.domainId);
        if (parentDomain) emit('select', parentDomain);
      }
    }
  } else {
    fastMode = false;
    requestRender();
  }
  isDragOperation = false;
}

function onWheel(e) {
  e.preventDefault();
  const rect = canvas.value.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.max(0.2, Math.min(3, viewTransform.scale * delta));
  
  const wx = (mx - canvas.value.width / 2 - viewTransform.x) / viewTransform.scale;
  const wy = (my - canvas.value.height / 2 - viewTransform.y) / viewTransform.scale;
  
  viewTransform.x = mx - canvas.value.width / 2 - wx * newScale;
  viewTransform.y = my - canvas.value.height / 2 - wy * newScale;
  viewTransform.scale = newScale;
  
  requestRender();
}
</script>

<style scoped>
.galaxy-map-container { display: flex; flex-direction: column; height: 100%; }
.map-header { padding: 12px 16px; border-bottom: 1px solid #30363d; background: #161b22; }
.map-header h2 { font-size: 14px; color: #f0f6fc; margin-bottom: 4px; }
.hint { font-size: 11px; color: #8b949e; }
.canvas-wrapper { flex: 1; position: relative; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; }
</style>
