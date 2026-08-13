<template>
  <div class="cluster-panel" :class="{ open: open }">
    <div class="panel-header">
      <h3>地点簇</h3>
      <div class="header-actions">
        <button class="icon-btn" @click="$emit('create-cluster')" title="创建地点簇（框选地点后创建）">＋</button>
        <button class="close-btn" @click="$emit('close')" title="关闭面板">×</button>
      </div>
    </div>
    <div v-if="open" class="panel-body">
      <div v-if="clusters.length === 0" class="empty-hint">
        暂无地点簇<br />
        <span class="sub">框选多个地点 → 创建簇，便于统一管理</span>
      </div>
      <div
        v-for="cluster in clusters"
        :key="cluster.id"
        class="cluster-row"
        :class="{ active: activeClusterId === cluster.id }"
      >
        <div class="cluster-head" @click="$emit('focus-cluster', cluster.id)">
          <button class="fold-btn" @click.stop="$emit('toggle-collapse', cluster.id)">
            {{ cluster.collapsed ? '▶' : '▼' }}
          </button>
          <span class="cluster-color" :style="{ background: cluster.color || '#FF6B6B' }"></span>
          <span class="cluster-name">{{ cluster.name }}</span>
          <span class="cluster-count">{{ cluster.memberIds.length }}</span>
        </div>
        <div v-if="!cluster.collapsed" class="cluster-members">
          <div
            v-for="memberId in cluster.memberIds"
            :key="memberId"
            class="member-row"
            :class="{ hovered: hoverMemberId === memberId }"
            @mouseenter="$emit('hover-member', memberId)"
            @mouseleave="$emit('hover-member', null)"
            @click="$emit('select-member', memberId)"
          >
            <span class="member-dot" :style="{ background: cluster.color || '#FF6B6B' }"></span>
            {{ getMemberName(memberId) }}
          </div>
        </div>
        <div class="cluster-actions">
          <button class="mini-btn" @click="$emit('edit-cluster', cluster.id)" title="重命名/改色">✎</button>
          <button class="mini-btn" @click="$emit('disband-cluster', cluster.id)" title="解散簇（成员恢复独立）">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useGeodataStore } from '../store/geodata';

const store = useGeodataStore();

const props = defineProps({
  planet: { type: Object, default: null },
  open: { type: Boolean, default: false },
  activeClusterId: { type: String, default: null },
  hoverMemberId: { type: String, default: null },
});

defineEmits([
  'create-cluster', 'focus-cluster', 'toggle-collapse',
  'hover-member', 'select-member', 'edit-cluster', 'disband-cluster', 'close',
]);

const clusters = computed(() => {
  if (!props.planet) return [];
  const data = store.mapData[props.planet.id];
  return data?.clusters || [];
});

function getMemberName(memberId) {
  const node = store.nodes.find(n => n.id === memberId);
  return node?.name || memberId;
}
</script>

<style scoped>
.cluster-panel {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 30;
  background: rgba(22, 27, 34, 0.95);
  border: 1px solid #30363d;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  min-width: 220px;
  max-width: 280px;
  max-height: 320px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid #30363d;
  background: #0d1117;
}

.panel-header h3 {
  font-size: 12px;
  font-weight: 600;
  color: #f0f6fc;
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.header-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.icon-btn {
  background: none;
  border: 1px solid #30363d;
  color: #58a6ff;
  cursor: pointer;
  font-size: 14px;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  line-height: 1;
}

.icon-btn:hover {
  background: #21262d;
}

.close-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
  line-height: 1;
}

.close-btn:hover {
  color: #f0f6fc;
}

.panel-body {
  overflow-y: auto;
  padding: 6px;
}

.empty-hint {
  padding: 14px 10px;
  text-align: center;
  font-size: 11px;
  color: #8b949e;
  line-height: 1.6;
}

.empty-hint .sub {
  font-size: 10px;
  color: #484f58;
}

.cluster-row {
  border: 1px solid #30363d;
  border-radius: 4px;
  margin-bottom: 6px;
  background: #161b22;
  position: relative;
}

.cluster-row.active {
  border-color: #58a6ff;
  box-shadow: 0 0 6px rgba(88, 166, 255, 0.3);
}

.cluster-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 12px;
  color: #e2e8f0;
  user-select: none;
}

.cluster-head:hover {
  background: #21262d;
}

.fold-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 10px;
  padding: 0;
  width: 14px;
}

.cluster-color {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.cluster-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cluster-count {
  background: #21262d;
  color: #8b949e;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
}

.cluster-members {
  padding: 2px 8px 6px 22px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.member-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #c9d1d9;
  padding: 3px 6px;
  border-radius: 3px;
  cursor: pointer;
}

.member-row:hover,
.member-row.hovered {
  background: rgba(88, 166, 255, 0.15);
  color: #f0f6fc;
}

.member-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.cluster-actions {
  position: absolute;
  right: 6px;
  top: 6px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.cluster-row:hover .cluster-actions {
  opacity: 1;
}

.mini-btn {
  background: none;
  border: 1px solid #30363d;
  color: #8b949e;
  cursor: pointer;
  font-size: 11px;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  line-height: 1;
}

.mini-btn:hover {
  color: #f0f6fc;
  background: #21262d;
}
</style>
