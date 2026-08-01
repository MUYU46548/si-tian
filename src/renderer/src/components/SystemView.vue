<template>
  <div class="system-view-container">
    <div class="map-header">
      <h2>{{ domain?.name }} — 域内恒星系总览</h2>
      <p class="hint">每个恒星系显示其恒星与行星 · 滚动缩放 · 拖拽空白处平移</p>
    </div>
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';

const props = defineProps({
  domain: { type: Object, default: null },
  systems: { type: Array, default: () => [] },
  planets: { type: Array, default: () => [] },
  locations: { type: Array, default: () => [] }
});

const canvas = ref(null);
let ctx = null;
let viewTransform = { x: 0, y: 0, scale: 1 };
let isPanning = false;
let mouseDownPos = { x: 0, y: 0 };
let isDragOperation = false;
let systemLayouts = [];
let rafId = null;
let needsRender = true;
let fastMode = false;

const allBodies = computed(() => [...props.planets, ...props.locations]);

onMounted(() => {
  initCanvas();
  applyLayout();
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

function applyLayout() {
  const systems = props.systems;
  const gridSize = Math.ceil(Math.sqrt(systems.length));
  const spacing = 500;
  
  systemLayouts = systems.map((system, idx) => {
    const col = idx % gridSize;
    const row = Math.floor(idx / gridSize);
    const x = (col - (gridSize - 1) / 2) * spacing;
    const y = (row - (gridSize - 1) / 2) * spacing;
    
    const systemPlanets = allBodies.value.filter(b => b.parentId === system.id);
    
    const planetLayouts = systemPlanets.map((planet, pIdx) => {
      const orbit = Math.floor(pIdx / 3) + 1;
      const posInOrbit = pIdx % 3;
      const angle = (posInOrbit / 3) * Math.PI * 2 + orbit * 0.4;
      const orbitRadius = 40 + orbit * 35;
      return {
        ...planet,
        x: x + Math.cos(angle) * orbitRadius,
        y: y + Math.sin(angle) * orbitRadius,
        orbitRadius,
        angle
      };
    });
    
    return { ...system, x, y, planets: planetLayouts };
  });
}

function render() {
  if (!ctx || !canvas.value) return;
  const w = canvas.value.width;
  const h = canvas.value.height;
  
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2 + viewTransform.x, h / 2 + viewTransform.y);
  ctx.scale(viewTransform.scale, viewTransform.scale);
  
  // In fast mode during drag, skip expensive effects
  if (!fastMode) {
    systemLayouts.forEach(drawSystemOrbits);
  }
  drawHyperlanes();
  systemLayouts.forEach(drawSystemStar);
  systemLayouts.forEach(drawSystemPlanets);
  
  ctx.restore();
}

function drawSystemOrbits(system) {
  ctx.strokeStyle = 'rgba(100, 150, 200, 0.15)';
  ctx.lineWidth = 1;
  const maxOrbit = system.planets.reduce((max, p) => Math.max(max, p.orbitRadius || 40), 40);
  for (let r = 40; r <= maxOrbit + 30; r += 35) {
    ctx.beginPath();
    ctx.arc(system.x, system.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawHyperlanes() {
  ctx.setLineDash([3, 5]);
  for (let i = 0; i < systemLayouts.length; i++) {
    for (let j = i + 1; j < systemLayouts.length; j++) {
      const s1 = systemLayouts[i];
      const s2 = systemLayouts[j];
      const dist = Math.hypot(s1.x - s2.x, s1.y - s2.y);
      if (dist < 450) {
        ctx.strokeStyle = 'rgba(100, 150, 200, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);
}

function drawSystemStar(system) {
  if (fastMode) {
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(system.x, system.y, 7, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const gradient = ctx.createRadialGradient(system.x, system.y, 0, system.x, system.y, 25);
    gradient.addColorStop(0, 'rgba(255, 200, 50, 0.8)');
    gradient.addColorStop(0.3, 'rgba(255, 150, 50, 0.4)');
    gradient.addColorStop(1, 'rgba(255, 100, 50, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(system.x, system.y, 25, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#ffd700';
    ctx.shadowColor = '#ffd700';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(system.x, system.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(system.name, system.x, system.y + 20);
}

function drawSystemPlanets(system) {
  system.planets.forEach(planet => {
    ctx.fillStyle = getPlanetColor(planet.layer);
    ctx.beginPath();
    ctx.arc(planet.x, planet.y, getPlanetRadius(planet.layer), 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    if (!fastMode) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(planet.name, planet.x, planet.y + getPlanetRadius(planet.layer) + 10);
    }
  });
}

function getPlanetColor(layer) {
  return { planet: '#5cb85c', city: '#f0ad4e', town: '#d9853b', location: '#888888' }[layer] || '#888888';
}

function getPlanetRadius(layer) {
  return { planet: 7, city: 5, town: 4, location: 3 }[layer] || 3;
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - canvas.value.width / 2 - viewTransform.x) / viewTransform.scale,
    y: (sy - canvas.value.height / 2 - viewTransform.y) / viewTransform.scale
  };
}

function hitTest(wx, wy) {
  for (const system of systemLayouts) {
    const dx = wx - system.x;
    const dy = wy - system.y;
    if (dx * dx + dy * dy < 12 * 12) return { type: 'star', node: system };
  }
  for (const system of systemLayouts) {
    for (const planet of system.planets) {
      const dx = wx - planet.x;
      const dy = wy - planet.y;
      const r = getPlanetRadius(planet.layer) + 3;
      if (dx * dx + dy * dy < r * r) return { type: 'planet', node: planet };
    }
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

function onMouseUp() {
  isPanning = false;
  if (isDragOperation) {
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
.system-view-container { display: flex; flex-direction: column; height: 100%; }
.map-header { padding: 12px 16px; border-bottom: 1px solid #30363d; background: #161b22; }
.map-header h2 { font-size: 14px; color: #f0f6fc; margin-bottom: 4px; }
.hint { font-size: 11px; color: #8b949e; }
.canvas-wrapper { flex: 1; position: relative; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; }
</style>
