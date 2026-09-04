// src/renderer/src/composables/useBrushDrawing.js
// 地形笔刷绘制状态管理

import { ref } from 'vue';
import { convexHull } from '../utils/geometry';

export function useBrushDrawing({ store, props, emit, renderer }) {
  const brushMode = ref(false);
  const brushSize = ref(40);
  const isBrushing = ref(false);
  const brushLastPoint = ref(null);
  const brushStrokePoints = ref([]);

  // 生成圆多边形（12 段）
  function makeCirclePolygon(cx, cy, r) {
    const pts = [];
    const SEGMENTS = 12;
    for (let i = 0; i < SEGMENTS; i++) {
      const angle = (i / SEGMENTS) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    return pts;
  }

  // 笔画结束：落点圆合并为凸包（单块地形，无自交、无内部重叠透明层）
  function finishBrushStroke(selectedTerrain) {
    const pts = brushStrokePoints.value;
    brushStrokePoints.value = [];
    if (pts.length === 0) return;

    const planetId = props.planet.id;
    const type = selectedTerrain.value;
    const r = brushSize.value / 2;

    // 每个落点生成圆，所有圆顶点合并为凸包
    const allVertices = [];
    pts.forEach(p => {
      allVertices.push(...makeCirclePolygon(p.x, p.y, r));
    });

    const hull = convexHull(allVertices);
    if (hull.length < 3) return;

    const poly = {
      id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      points: hull,
      type,
      name: '',
      description: '',
    };
    store.addTerrainPolygon(planetId, poly);
    emit('dirty', true);
    renderer.requestRender();
  }

  function clearBrush() {
    isBrushing.value = false;
    brushLastPoint.value = null;
    brushStrokePoints.value = [];
  }

  return {
    brushMode,
    brushSize,
    isBrushing,
    brushLastPoint,
    brushStrokePoints,
    finishBrushStroke,
    clearBrush,
  };
}
