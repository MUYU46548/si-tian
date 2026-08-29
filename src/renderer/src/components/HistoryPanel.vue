<template>
  <panel-shell title="撤销历史" :open="open" @close="$emit('close')" class="history-panel">
    <div v-if="entries.length === 0" class="history-empty">暂无编辑历史</div>
    <div v-else class="history-list">
      <div
        v-for="entry in entries"
        :key="entry.index"
        class="history-item"
        :class="{
          current: entry.index === currentIndex,
          applied: entry.index <= currentIndex && entry.index !== currentIndex,
          future: entry.index > currentIndex,
        }"
        :title="entry.index === currentIndex
          ? '当前位置'
          : entry.index < currentIndex
            ? '点击撤销到此步骤'
            : '点击重做到此步骤'"
        @click="jumpTo(entry.index)"
      >
        <span class="history-icon">{{ getCategoryIcon(entry.category) }}</span>
        <span class="history-label">{{ entry.label }}</span>
        <span class="history-time">{{ formatTime(entry.timestamp) }}</span>
      </div>
    </div>
    <div class="history-footer">
      <span>第 {{ currentIndex + 1 }} / {{ entries.length }} 步</span>
      <span class="history-hint">点击任意步骤回到该状态；此后新操作将从该处开始新分支</span>
    </div>
  </panel-shell>
</template>

<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { getHistory, jumpTo as jumpToIndex, currentIndex } from '../store/undo';

// E2: 可交互撤销历史面板 — 点击历史项跳转到该状态（undo.js 线性历史 + 指针）
// 跳转后广播 sitian:history-jump，各画布监听后 requestRender 刷新

const props = defineProps({
  open: { type: Boolean, default: false },
});
defineEmits(['close']);

const entries = computed(() => {
  if (!props.open) return [];
  return getHistory();
});

function jumpTo(index) {
  jumpToIndex(index);
  // 跳转改变画布数据但不触发各画布的 watch，广播事件让可见画布重绘
  window.dispatchEvent(new CustomEvent('sitian:history-jump'));
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function getCategoryIcon(category) {
  const icons = {
    coordinate: '📍',
    hyperlane: '🛤',
    terrain: '🗺',
    region: '🗂',
    property: '✏️',
  };
  return icons[category] || '📝';
}
</script>

<style>
.history-panel {
  position: absolute;
  left: 12px;
  top: 60px;
  z-index: 60;
  width: 320px;
}
.history-panel .panel-shell-body {
  max-height: 60vh;
  overflow: auto;
}
.history-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 12.5px;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  color: var(--text-primary);
}
.history-item:hover {
  background: var(--accent-bg, rgba(100, 150, 200, 0.15));
}
.history-item.current {
  background: var(--accent-bg, rgba(88, 166, 255, 0.2));
  font-weight: 600;
}
.history-item.current::before {
  content: '▶';
  font-size: 9px;
  color: var(--accent);
  margin-right: 2px;
}
.history-item.future {
  opacity: 0.42;
}
.history-icon {
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}
.history-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-time {
  color: var(--text-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.history-footer {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-top: 1px solid var(--panel-border);
  color: var(--text-tertiary);
  font-size: 11px;
}
.history-hint {
  line-height: 1.4;
}
</style>
