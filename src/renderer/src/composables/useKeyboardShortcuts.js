// src/renderer/src/composables/useKeyboardShortcuts.js
// 键盘快捷键：方向键微调、Ctrl+C/V/D、Esc 取消

export function useKeyboardShortcuts({ store, props, emit, renderer, selectedProvince, selectedMarker, selectedTextLabel, exportStatus, splitSelectMode, mergeSelectMode, editMode, copySelection, pasteClipboard }) {
  let snapCtrlHeld = false;

  // 方向键微调
  function handleKeydown(e) {
    // Ctrl 按住：临时关闭网格吸附（精细微调），不受编辑模式限制
    if (e.key === 'Control') { snapCtrlHeld = true; return; }
    // Esc：取消拆分/合并模式（不依赖编辑模式）
    if (e.key === 'Escape') {
      if (splitSelectMode.value || mergeSelectMode.value) {
        splitSelectMode.value = false;
        mergeSelectMode.value = false;
        exportStatus.value = '';
        renderer.requestRender();
        return;
      }
    }
    if (!editMode.value) return;
    // E1: 克隆 / 复制粘贴（编辑模式下生效；App 全局键不处理 C/V/D，无冲突）
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (k === 'c') { e.preventDefault(); copySelection(); return; }
      if (k === 'v') { e.preventDefault(); pasteClipboard(); return; }
    }
    const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (!arrows.includes(e.key)) return;
    // 输入框/文本框聚焦时不拦截
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -1;
    else if (e.key === 'ArrowRight') dx = 1;
    else if (e.key === 'ArrowUp') dy = -1;
    else if (e.key === 'ArrowDown') dy = 1;
    const step = e.shiftKey ? 10 : 1;
    dx *= step;
    dy *= step;

    let moved = false;

    // 选中标记微调
    if (selectedMarker.value) {
      const marker = selectedMarker.value;
      e.preventDefault();
      store.updateMarker(props.planet.id, marker.id, {
        x: (marker.x || 0) + dx,
        y: (marker.y || 0) + dy,
      });
      renderer.requestRender();
      moved = true;
    } else if (selectedTextLabel.value) {
      const label = selectedTextLabel.value;
      e.preventDefault();
      store.updateTextLabel(props.planet.id, label.id, {
        x: (label.x || 0) + dx,
        y: (label.y || 0) + dy,
      });
      renderer.requestRender();
      moved = true;
    }

    if (moved) emit('dirty', true);
  }

  // Ctrl 松开 → 恢复网格吸附
  function handleKeyup(e) {
    if (e.key === 'Control') snapCtrlHeld = false;
  }

  function duplicateSelection() {
    copySelection();
    pasteClipboard();
  }

  return {
    handleKeydown,
    handleKeyup,
    isSnapCtrlHeld: () => snapCtrlHeld,
  };
}
