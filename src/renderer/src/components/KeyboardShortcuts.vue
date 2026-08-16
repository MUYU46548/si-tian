<template>
  <div v-if="visible" class="keyboard-shortcuts-overlay" @click.self="close">
    <div class="keyboard-shortcuts-panel">
      <div class="shortcuts-header">
        <h2>键盘快捷键</h2>
        <button class="close-btn" @click="close">×</button>
      </div>
      <div class="shortcuts-content">
        <div class="shortcut-group">
          <h3>导航</h3>
          <div class="shortcut-item">
            <kbd>F1</kbd>
            <span>打开帮助面板</span>
          </div>
          <div class="shortcut-item">
            <kbd>L</kbd>
            <span>切换图层面板</span>
          </div>
          <div class="shortcut-item">
            <kbd>Esc</kbd>
            <span>关闭弹窗 / 取消绘制</span>
          </div>
        </div>
        <div class="shortcut-group">
          <h3>编辑</h3>
          <div class="shortcut-item">
            <kbd>Ctrl</kbd> + <kbd>Z</kbd>
            <span>撤销</span>
          </div>
          <div class="shortcut-item">
            <kbd>Ctrl</kbd> + <kbd>Y</kbd>
            <span>重做</span>
          </div>
          <div class="shortcut-item">
            <kbd>Delete</kbd>
            <span>删除选中省份/区域</span>
          </div>
        </div>
        <div class="shortcut-group">
          <h3>搜索</h3>
          <div class="shortcut-item">
            <kbd>Ctrl</kbd> + <kbd>F</kbd>
            <span>聚焦搜索框</span>
          </div>
          <div class="shortcut-item">
            <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd>
            <span>展开类型过滤</span>
          </div>
          <div class="shortcut-item">
            <kbd>Enter</kbd>
            <span>跳转到下一个匹配</span>
          </div>
        </div>
        <div class="shortcut-group">
          <h3>视图</h3>
          <div class="shortcut-item">
            <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd>
            <span>切换性能面板</span>
          </div>
          <div class="shortcut-item">
            <kbd>?</kbd>
            <span>显示快捷键列表</span>
          </div>
        </div>
        <div class="shortcut-group">
          <h3>画布</h3>
          <div class="shortcut-item">
            <kbd>Space</kbd>
            <span>临时拖手模式</span>
          </div>
          <div class="shortcut-item">
            <kbd>Wheel</kbd>
            <span>缩放画布</span>
          </div>
          <div class="shortcut-item">
            <kbd>Double Click</kbd>
            <span>在 Obsidian 中打开节点</span>
          </div>
        </div>
      </div>
      <div class="shortcuts-footer">
        <span class="hint">按 <kbd>Ctrl</kbd> + <kbd>?</kbd> 或点击右上角 ? 按钮再次打开</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const visible = ref(false);

function open() {
  visible.value = true;
}

function close() {
  visible.value = false;
}

function handleKeydown(e) {
  // Ctrl+? or Ctrl+/
  if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.key === '?')) {
    e.preventDefault();
    visible.value = !visible.value;
  }
  // Escape closes
  if (e.key === 'Escape' && visible.value) {
    e.preventDefault();
    close();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});

defineExpose({ open, close });
</script>

<style scoped>
.keyboard-shortcuts-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.keyboard-shortcuts-panel {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: var(--radius-xl);
  width: 500px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
}

.shortcuts-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #30363d;
}

.shortcuts-header h2 {
  font-size: 16px;
  color: #f0f6fc;
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  transition: all 0.15s;
}

.close-btn:hover {
  color: #f0f6fc;
  background: #21262d;
}

.shortcuts-content {
  padding: 16px 20px;
  overflow-y: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.shortcut-group h3 {
  font-size: 12px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 10px 0;
}

.shortcut-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #c9d1d9;
}

kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: var(--radius-sm);
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 11px;
  color: #e2e8f0;
  white-space: nowrap;
  box-shadow: 0 1px 0 #30363d;
}

.shortcuts-footer {
  padding: 12px 20px;
  border-top: 1px solid #30363d;
  text-align: center;
}

.shortcuts-footer .hint {
  font-size: 11px;
  color: #8b949e;
}
</style>
