// src/renderer/src/composables/useTextEditor.js
// 浮动文本属性编辑状态 + 函数

import { ref, watch } from 'vue';

const TEXT_COLORS = ['#2D3436', '#C0392B', '#D35400', '#16A085', '#2C3E50', '#8E44AD', '#7F8C8D', '#27AE60'];

export function useTextEditor({ store, props, emit, selectedTextLabel }) {
  const textFontSize = ref(16);
  const textColor = ref('#2D3436');
  const editingTextContent = ref('');

  watch(selectedTextLabel, (label) => {
    editingTextContent.value = label?.text || '';
    textFontSize.value = label?.fontSize || 16;
    textColor.value = label?.color || '#2D3436';
  });

  function updateTextContent() {
    if (!selectedTextLabel.value) return;
    store.updateTextLabel(props.planet.id, selectedTextLabel.value.id, { text: editingTextContent.value });
    emit('dirty', true);
  }

  function updateTextFontSize(size) {
    if (!selectedTextLabel.value) return;
    store.updateTextLabel(props.planet.id, selectedTextLabel.value.id, { fontSize: size });
    emit('dirty', true);
  }

  function updateTextColor(color) {
    if (!selectedTextLabel.value) return;
    store.updateTextLabel(props.planet.id, selectedTextLabel.value.id, { color });
    emit('dirty', true);
  }

  return {
    textFontSize,
    textColor,
    editingTextContent,
    TEXT_COLORS,
    updateTextContent,
    updateTextFontSize,
    updateTextColor,
  };
}
