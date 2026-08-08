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
  background: rgba(22, 27, 34, 0.95);
  border: 1px solid #30363d;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
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

.close-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  line-height: 1;
}

.close-btn:hover {
  color: #f0f6fc;
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

.layer-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  width: 100%;
  font-size: 12px;
  color: #e2e8f0;
  transition: background 0.1s ease;
}

.layer-toggle:hover {
  background: #21262d;
}

.layer-toggle input[type="checkbox"] {
  accent-color: #58a6ff;
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.layer-label {
  flex: 1;
}
</style>
