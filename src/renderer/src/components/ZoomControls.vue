<template>
  <div v-if="renderer" class="zoom-controls" @mousedown.stop @wheel.stop>
    <button class="zoom-btn" title="缩小" @click="zoomStep(-1)">−</button>
    <select
      class="zoom-select"
      :value="currentPreset"
      title="缩放百分比"
      @change="onPresetChange"
    >
      <option v-if="!presets.includes(displayPercent)" :value="displayPercent">{{ displayPercent }}%</option>
      <option v-for="p in presets" :key="p" :value="p">{{ p }}%</option>
    </select>
    <button class="zoom-btn" title="放大" @click="zoomStep(1)">＋</button>
    <button v-if="onFitAll" class="zoom-btn zoom-fit" title="适配全部" @click="onFitAll">⤢</button>
    <button v-if="onFitSelection" class="zoom-btn zoom-fit" title="适配选中" @click="onFitSelection">⊞</button>
  </div>
</template>

<script setup>
import { computed } from 'vue';

// U2: 显式缩放控件 — 统一走 renderer.setScale / fitView 入口，与滚轮缩放显示同步
// props.renderer 为 useCanvasRenderer 返回对象；适配回调由宿主画布提供（画布知道自己内容的 bounds）

const props = defineProps({
  renderer: { type: Object, required: true },
  onFitAll: { type: Function, default: null },
  onFitSelection: { type: Function, default: null },
});

const presets = [25, 50, 75, 100, 150, 200, 300, 400];
const STEP = 1.2;

const displayPercent = computed(() => Math.round(props.renderer.viewTransform.scale * 100));
const currentPreset = computed(() => (presets.includes(displayPercent.value) ? displayPercent.value : null));

function zoomStep(dir) {
  props.renderer.setScale(props.renderer.viewTransform.scale * (dir > 0 ? STEP : 1 / STEP));
}

function onPresetChange(e) {
  const p = Number(e.target.value);
  if (Number.isFinite(p) && p > 0) {
    props.renderer.setScale(p / 100);
  }
  e.target.blur();
}
</script>

<style scoped>
.zoom-controls {
  position: absolute;
  right: 16px;
  bottom: 40px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md, 8px);
  box-shadow: var(--shadow-md, 0 4px 16px rgba(0, 0, 0, 0.3));
}
.zoom-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.zoom-btn:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}
.zoom-select {
  height: 24px;
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm, 4px);
  background: var(--input-bg);
  color: var(--text-primary);
  font-size: 11.5px;
  cursor: pointer;
  outline: none;
}
</style>
