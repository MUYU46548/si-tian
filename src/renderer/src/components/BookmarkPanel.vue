<template>
  <div class="bookmarks-panel">
    <div class="bookmarks-header">
      <h3>视口书签</h3>
      <button class="close-btn" @click="$emit('close')">×</button>
    </div>
    <div class="bookmarks-content">
      <div v-if="bookmarks.length === 0" class="empty-hint">
        暂无书签。点击 "+" 保存当前视图位置。
      </div>
      <div 
        v-for="(bm, index) in bookmarks" 
        :key="bm.id"
        class="bookmark-item"
        :class="{ current: index === currentIndex }"
        @click="$emit('navigate', bm)"
      >
        <div class="bookmark-info">
          <span class="bookmark-name">{{ bm.name }}</span>
          <span class="bookmark-meta">{{ bm.viewLevel }} · {{ formatDate(bm.createdAt) }}</span>
        </div>
        <button class="remove-btn" @click.stop="$emit('remove', bm.id)">×</button>
      </div>
    </div>
    <div class="bookmarks-footer">
      <button @click="$emit('add')" title="添加当前视图为书签">+ 添加书签</button>
      <button @click="$emit('clear')" :disabled="bookmarks.length === 0">清空全部</button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const props = defineProps({
  bookmarks: { type: Array, default: () => [] },
  currentIndex: { type: Number, default: -1 },
});

defineEmits(['close', 'navigate', 'add', 'remove', 'clear']);

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
</script>

<style scoped>
.bookmarks-panel {
  position: fixed;
  top: 50px;
  right: 16px;
  width: 280px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  z-index: 200;
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
}

.bookmarks-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.bookmarks-header h3 {
  font-size: 13px;
  color: var(--text-primary);
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  font-size: 18px;
  cursor: pointer;
  padding: 2px 6px;
}

.close-btn:hover {
  color: var(--text-primary);
}

.bookmarks-content {
  max-height: 300px;
  overflow-y: auto;
  padding: 8px 0;
}

.empty-hint {
  padding: 16px;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
}

.bookmark-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
  transition: background 0.15s;
}

.bookmark-item:hover {
  background: var(--btn-bg-hover);
}

.bookmark-item.current {
  background: var(--accent-bg);
}

.bookmark-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bookmark-name {
  font-size: 12px;
  color: var(--text-primary);
}

.bookmark-meta {
  font-size: 10px;
  color: var(--text-tertiary);
}

.remove-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  opacity: 0;
  transition: all 0.15s;
}

.bookmark-item:hover .remove-btn {
  opacity: 1;
}

.remove-btn:hover {
  color: #ff7b72;
}

.bookmarks-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--panel-border);
}

.bookmarks-footer button {
  flex: 1;
  padding: 6px 12px;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  background: var(--btn-bg);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.bookmarks-footer button:hover:not(:disabled) {
  background: var(--btn-bg-hover);
}

.bookmarks-footer button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
