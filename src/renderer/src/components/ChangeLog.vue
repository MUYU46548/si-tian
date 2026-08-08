<template>
  <div v-if="visible" class="change-log-overlay" @click.self="close">
    <div class="change-log-panel">
      <div class="change-log-header">
        <h2>变更日志</h2>
        <button class="close-btn" @click="close">×</button>
      </div>
      <div class="change-log-filters">
        <button 
          v-for="cat in categories" 
          :key="cat.value"
          class="filter-btn"
          :class="{ active: activeFilter === cat.value }"
          @click="activeFilter = cat.value"
        >{{ cat.label }}</button>
      </div>
      <div class="change-log-content">
        <div v-if="filteredLogs.length === 0" class="empty-hint">
          暂无变更记录
        </div>
        <div 
          v-for="log in filteredLogs" 
          :key="log.index"
          class="log-item"
        >
          <div class="log-icon">{{ getCategoryIcon(log.category) }}</div>
          <div class="log-info">
            <span class="log-label">{{ log.label }}</span>
            <span class="log-time">{{ formatTime(log.timestamp) }}</span>
          </div>
          <span class="log-type">{{ log.type }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { getHistory } from '../store/undo';

const visible = ref(false);
const activeFilter = ref('all');

const categories = [
  { value: 'all', label: '全部' },
  { value: 'coordinate', label: '坐标' },
  { value: 'hyperlane', label: '航道' },
  { value: 'terrain', label: '地形' },
  { value: 'region', label: '区域' },
  { value: 'property', label: '属性' },
];

const logs = computed(() => getHistory());

const filteredLogs = computed(() => {
  if (activeFilter.value === 'all') return logs.value;
  return logs.value.filter(log => log.category === activeFilter.value);
});

function open() {
  visible.value = true;
}

function close() {
  visible.value = false;
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
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

defineExpose({ open, close });
</script>

<style scoped>
.change-log-overlay {
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

.change-log-panel {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 12px;
  width: 500px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.change-log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #30363d;
}

.change-log-header h2 {
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
  border-radius: 4px;
  transition: all 0.15s;
}

.close-btn:hover {
  color: #f0f6fc;
  background: #21262d;
}

.change-log-filters {
  display: flex;
  gap: 6px;
  padding: 12px 20px;
  border-bottom: 1px solid #30363d;
}

.filter-btn {
  padding: 4px 12px;
  border: 1px solid #30363d;
  border-radius: 12px;
  background: #21262d;
  color: #c9d1d9;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.filter-btn:hover {
  background: #30363d;
}

.filter-btn.active {
  background: rgba(88, 166, 255, 0.2);
  border-color: #58a6ff;
  color: #58a6ff;
}

.change-log-content {
  padding: 12px 20px;
  overflow-y: auto;
  flex: 1;
}

.empty-hint {
  padding: 32px;
  text-align: center;
  font-size: 13px;
  color: #8b949e;
}

.log-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(48, 54, 61, 0.5);
}

.log-item:last-child {
  border-bottom: none;
}

.log-icon {
  font-size: 18px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #21262d;
  border-radius: 6px;
  flex-shrink: 0;
}

.log-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.log-label {
  font-size: 12px;
  color: #e2e8f0;
}

.log-time {
  font-size: 10px;
  color: #8b949e;
}

.log-type {
  font-size: 10px;
  color: #8b949e;
  padding: 2px 6px;
  background: #21262d;
  border-radius: 4px;
}
</style>
