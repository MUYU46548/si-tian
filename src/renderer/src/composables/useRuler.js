// src/renderer/src/composables/useRuler.js
// 画布边缘标尺：顶部 X 轴 / 左侧 Y 轴，随镜头联动

import { ref, computed, watch } from 'vue';

export function useRuler({ renderer, canvas }) {
  const rulerVisible = ref(true);
  const compassVisible = ref(true);
  const scaleBarVisible = ref(true);

  try {
    if (localStorage.getItem('sitian-ruler') === '0') rulerVisible.value = false;
    if (localStorage.getItem('sitian-compass') === '0') compassVisible.value = false;
    if (localStorage.getItem('sitian-scalebar') === '0') scaleBarVisible.value = false;
  } catch (e) { /* ignore */ }

  watch(rulerVisible, (v) => {
    try { localStorage.setItem('sitian-ruler', v ? '1' : '0'); } catch (e) { /* ignore */ }
  });
  watch(compassVisible, (v) => {
    try { localStorage.setItem('sitian-compass', v ? '1' : '0'); } catch (e) { /* ignore */ }
  });
  watch(scaleBarVisible, (v) => {
    try { localStorage.setItem('sitian-scalebar', v ? '1' : '0'); } catch (e) { /* ignore */ }
  });

  // 选择"漂亮"步长（1/2/5×10^n），使屏幕上刻度间距 ~80px
  function niceStep(raw) {
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

  // 顶部 X 轴刻度
  const hTicks = computed(() => {
    const vt = renderer.viewTransform;
    const cvs = canvas.value;
    if (!cvs) return [];
    const w = cvs.clientWidth;
    const scale = vt.scale;
    const step = niceStep(80 / scale);
    const worldLeft = -(vt.x + w / 2) / scale;
    const start = Math.floor(worldLeft / step) * step;
    const ticks = [];
    for (let wx = start; wx <= start + (w / scale) + step; wx += step) {
      ticks.push({ left: Math.round(wx * scale + vt.x + w / 2), label: wx >= 1000 ? (wx / 1000) + 'km' : Math.round(wx) + 'm' });
    }
    return ticks;
  });

  // 左侧 Y 轴刻度
  const vTicks = computed(() => {
    const vt = renderer.viewTransform;
    const cvs = canvas.value;
    if (!cvs) return [];
    const h = cvs.clientHeight;
    const scale = vt.scale;
    const step = niceStep(80 / scale);
    const worldTop = -(vt.y + h / 2) / scale;
    const start = Math.floor(worldTop / step) * step;
    const ticks = [];
    for (let wy = start; wy <= start + (h / scale) + step; wy += step) {
      ticks.push({ top: Math.round(wy * scale + vt.y + h / 2), label: wy >= 1000 ? (wy / 1000) + 'km' : Math.round(wy) + 'm' });
    }
    return ticks;
  });

  return {
    rulerVisible,
    compassVisible,
    scaleBarVisible,
    hTicks,
    vTicks,
    niceStep,
  };
}
