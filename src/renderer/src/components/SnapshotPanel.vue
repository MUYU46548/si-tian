<template>
  <PanelShell class="snapshot-panel" title="📸 地图快照" :open="open" :collapsible="false" :stop-mouse-down="true" @close="$emit('close')">
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
  </PanelShell>
</template>

<script setup>
import { ref } from 'vue';
import PanelShell from './PanelShell.vue';

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
/* 定位与宽度由本类提供，外观/拖拽/关闭由 PanelShell 统一处理（含 planet 主题变量） */
.snapshot-panel {
  position: absolute;
  left: 16px;
  bottom: 60px;
  width: 260px;
  z-index: 100;
  background: var(--planet-editor-bg);
  border-color: var(--planet-editor-border);
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
  border-color: var(--planet-text-link);
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
  background: var(--planet-btn-bg);
}
.snapshot-item:hover {
  background: var(--planet-btn-hover);
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
  color: var(--planet-text-link);
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
