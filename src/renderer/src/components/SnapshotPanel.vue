<template>
  <div v-if="open" class="snapshot-panel" @mousedown.stop>
    <div class="editor-header">
      <h3>📸 地图快照</h3>
      <button class="close-btn" @click="$emit('close')">×</button>
    </div>
    <div class="snapshot-body">
      <div class="snapshot-create">
        <input v-model="name" placeholder="快照名称（留空自动命名）" @keydown.enter="take" />
        <button class="adopt-btn" @click="take">📸 拍摄</button>
      </div>
      <div v-if="snapshots.length === 0" class="snapshot-empty">暂无快照<br />绘制前拍摄一份，后续可随时恢复</div>
      <div v-for="snap in snapshots" :key="snap.id" class="snapshot-item">
        <div class="snapshot-info">
          <div class="snapshot-name">{{ snap.name }}</div>
          <div class="snapshot-time">{{ formatTime(snap.createdAt) }}</div>
        </div>
        <button class="snapshot-restore" @click="$emit('restore', snap)">↺ 恢复</button>
        <button class="snapshot-del" @click="$emit('remove', snap)" title="删除快照">×</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

defineProps({
  open: { type: Boolean, default: false },
  snapshots: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'take', 'restore', 'remove']);

const name = ref('');

function take() {
  emit('take', name.value);
  name.value = '';
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch (e) {
    return '';
  }
}
</script>

<style scoped>
.snapshot-panel {
  position: absolute;
  left: 16px;
  bottom: 60px;
  width: 260px;
  background: var(--planet-editor-bg);
  border: 1px solid var(--planet-editor-border);
  border-radius: 8px;
  box-shadow: var(--shadow-md);
  z-index: 100;
  cursor: default;
  overflow: hidden;
}
.snapshot-panel .editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.06);
  border-bottom: 1px solid var(--planet-editor-border);
}
.snapshot-panel .editor-header h3 {
  margin: 0;
  font-size: 13px;
  color: var(--planet-text);
}
.snapshot-body {
  padding: 10px;
  max-height: 320px;
  overflow-y: auto;
}
.snapshot-create {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.snapshot-create input {
  flex: 1;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  background: var(--planet-btn-bg);
  color: var(--planet-text);
  font-size: 12px;
  outline: none;
}
.snapshot-create input:focus {
  border-color: var(--planet-text-link, #4A90D9);
}
.snapshot-empty {
  text-align: center;
  color: var(--planet-text-secondary);
  font-size: 12px;
  padding: 12px 0;
  line-height: 1.6;
}
.snapshot-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  margin-bottom: 4px;
  background: rgba(255, 255, 255, 0.04);
}
.snapshot-item:hover {
  background: rgba(255, 255, 255, 0.09);
}
.snapshot-info {
  flex: 1;
  min-width: 0;
}
.snapshot-name {
  font-size: 12px;
  color: var(--planet-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.snapshot-time {
  font-size: 10px;
  color: var(--planet-text-secondary);
}
.snapshot-restore {
  padding: 3px 8px;
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  background: var(--planet-btn-bg);
  color: var(--planet-text-link, #4A90D9);
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
}
.snapshot-restore:hover {
  background: var(--planet-btn-hover);
}
.snapshot-del {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--planet-text-secondary);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.snapshot-del:hover {
  background: rgba(231, 76, 60, 0.2);
  color: #E74C3C;
}
</style>
