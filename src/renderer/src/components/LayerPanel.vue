<template>
  <div class="layer-panel" :class="{ open: layers.panelOpen }">
    <div class="panel-header">
      <h3>图层</h3>
      <button class="close-btn" @click="layers.togglePanel">×</button>
    </div>
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
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';

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
.layer-panel {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 30;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  min-width: 160px;
  overflow: hidden;
  transform: translateY(-10px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.layer-panel.open {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border);
  background: var(--panel-header-bg);
}

.panel-header h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary);
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
