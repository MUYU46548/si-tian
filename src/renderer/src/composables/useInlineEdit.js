// src/renderer/src/composables/useInlineEdit.js
// 内联文本编辑：双击画布文本 → 原位覆盖层编辑

import { ref, nextTick } from 'vue';

export function useInlineEdit({ store, props, emit, renderer, currentMapData, canvas }) {
  const inlineEdit = ref(null);        // { id, sx, sy, value, fontSize, color }
  const inlineEditInput = ref(null);

  function startInlineTextEdit(label) {
    const cvs = canvas.value;
    if (!cvs) return;
    const vt = renderer.viewTransform;
    const sx = label.x * vt.scale + cvs.clientWidth / 2 + vt.x;
    const sy = label.y * vt.scale + cvs.clientHeight / 2 + vt.y;
    inlineEdit.value = {
      id: label.id,
      sx, sy,
      value: label.text || '',
      fontSize: (label.fontSize || 16) * vt.scale,
      color: label.color || '#2D3436',
    };
    nextTick(() => {
      const el = inlineEditInput.value;
      if (el) { el.focus(); el.select(); }
    });
  }

  function commitInlineEdit() {
    const ed = inlineEdit.value;
    if (!ed) return;
    inlineEdit.value = null;
    const label = currentMapData.value?.textLabels?.find(l => l.id === ed.id);
    if (label && ed.value !== label.text && ed.value.trim()) {
      store.updateTextLabel(props.planet.id, ed.id, { text: ed.value }, { text: label.text });
      emit('dirty', true);
    }
    renderer.requestRender();
  }

  function cancelInlineEdit() {
    inlineEdit.value = null;
    renderer.requestRender();
  }

  return {
    inlineEdit,
    inlineEditInput,
    startInlineTextEdit,
    commitInlineEdit,
    cancelInlineEdit,
  };
}
