// src/renderer/src/composables/useZoomControls.js
// 缩放控件：滑条/按钮/输入框联动

import { ref } from 'vue';

export function useZoomControls({ renderer }) {
  const zoomPercent = ref(100);

  function applyZoom(v) { // v 为百分比
    const num = Number(v);
    if (!Number.isFinite(num) || num <= 0) return;
    const s = renderer.setScale(num / 100);
    zoomPercent.value = Math.round(s * 100);
  }

  function zoomBy(delta) {
    applyZoom(zoomPercent.value + delta * 100);
  }

  function onWheel(newScale) {
    zoomPercent.value = Math.round(newScale * 100);
  }

  // 滑条 / 数字输入框变化 → 应用缩放
  function onZoomSlider() {
    const v = Number(zoomPercent.value);
    if (!Number.isFinite(v) || v <= 0) return;
    renderer.setScale(v / 100);
  }

  return {
    zoomPercent,
    applyZoom,
    zoomBy,
    onWheel,
    onZoomSlider,
  };
}
