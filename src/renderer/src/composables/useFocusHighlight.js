// src/renderer/src/composables/useFocusHighlight.js
// 定位高亮：金色脉冲光圈 + 十字标记（来自搜索/详情面板）

import { ref } from 'vue';

export function useFocusHighlight({ renderer }) {
  const focusHighlightNode = ref(null);
  let focusHighlightTimer = null;

  function showFocusHighlight(place) {
    focusHighlightNode.value = place;
    if (focusHighlightTimer) clearTimeout(focusHighlightTimer);
    focusHighlightTimer = setTimeout(() => {
      focusHighlightNode.value = null;
      renderer.requestRender();
    }, 2000);
    renderer.requestRender();
  }

  function drawFocusHighlight(ctx, place) {
    const x = place.coordinate?.x || 0;
    const y = place.coordinate?.y || 0;
    const time = Date.now() / 1000;
    const pulse = Math.sin(time * 4) * 0.5 + 0.5;

    ctx.save();
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#FFD700';
    ctx.shadowBlur = 10 + pulse * 10;
    ctx.beginPath();
    ctx.arc(x, y, 18 + pulse * 8, 0, Math.PI * 2);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 215, 0, 0.3)';
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 22, y);
    ctx.lineTo(x - 10, y);
    ctx.moveTo(x + 10, y);
    ctx.lineTo(x + 22, y);
    ctx.moveTo(x, y - 22);
    ctx.lineTo(x, y - 10);
    ctx.moveTo(x, y + 10);
    ctx.lineTo(x, y + 22);
    ctx.stroke();
    ctx.restore();
  }

  function clearFocusHighlightTimer() {
    if (focusHighlightTimer) clearTimeout(focusHighlightTimer);
  }

  return {
    focusHighlightNode,
    showFocusHighlight,
    drawFocusHighlight,
    clearFocusHighlightTimer,
  };
}
