<template>
  <PanelShell title="图层" :open="layers.panelOpen" class="layer-panel" @close="layers.togglePanel()">
    <div class="panel-body">
      <div
        v-for="layer in currentLayers"
        :key="layer.id"
        class="layer-row"
      >
        <label class="layer-toggle">
          <input
            type="checkbox"
            :checked="layer.visible"
            @change="layers.toggleLayer(currentView, layer.id)"
          />
          <span class="layer-label">{{ layer.label }}</span>
        </label>
        <button
          class="lock-btn"
          :class="{ locked: layer.locked }"
          :title="layer.locked ? '解锁图层' : '锁定图层（不可编辑）'"
          @click="layers.toggleLayerLock(currentView, layer.id)"
        >{{ layer.locked ? '🔒' : '🔓' }}</button>
      </div>
    </div>
  </PanelShell>
</template>

<script setup>
import { computed } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import PanelShell from './PanelShell.vue';

const store = useGeodataStore();
const layers = useLayersStore();

const currentView = computed(() => {
  const level = store.viewLevel;
  if (level === 'domain') return 'domain';
  if (level === 'system') return 'system';
  if (level === 'planet') return 'planet';
  if (level === 'area') return 'area';
  if (level === 'interior') return 'interior';
  return 'domain'; // fallback
});

const currentLayers = computed(() => layers.getViewLayers(currentView.value));
</script>

<style scoped>
/* 定位/尺寸透传到 PanelShell 根节点（批次A9 收编统一外壳，header/关闭/拖拽/折叠由 PanelShell 提供） */
.layer-panel {
  top: 8px;
  left: 8px;
  z-index: 30;
  min-width: 160px;
}

.panel-body {
  padding: 6px;
  max-height: 240px;
  overflow-y: auto;
}

.layer-row {
  display: flex;
  align-items: center;
}

.lock-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  padding: 4px;
  opacity: 0.5;
  color: var(--text-tertiary);
  line-height: 1;
}

.lock-btn:hover {
  opacity: 1;
}

.lock-btn.locked {
  opacity: 1;
}

.layer-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  width: 100%;
  font-size: 12px;
  color: var(--text-primary);
  transition: background 0.1s ease;
}

.layer-toggle:hover {
  background: var(--btn-bg-hover);
}

.layer-toggle input[type="checkbox"] {
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.layer-label {
  flex: 1;
}
</style>
