<template>
  <!-- 图层锁定面板（2026-11-06 从 ScenarioMap.vue 拆出）
       为什么拆：`ScenarioMap.vue` 一度 6,969 行（闸门 ≤7,000），一个浮层塞在大文件里
       既改不动也没人敢改。这个面板完全自包含（只读图层表 + 两件事：关、切锁定），
       所以连同它那 70 行样式一起搬出来，样式跟着组件走（scoped），不再挤在 scenario-map.css。

       对外只三样：`open`（显隐）/ `layers`（{ id: { label, locked } }）/ 两个事件。
       父组件仍持有状态与写口（`toggleLayerLock` 走 store 的那条路），这里不碰数据。 -->
  <div v-if="open" class="layer-lock-panel" data-testid="layer-lock-panel">
    <div class="layer-lock-header">
      <span>图层锁定</span>
      <button class="layer-lock-close" title="关闭图层锁定面板" @click="$emit('close')">×</button>
    </div>
    <div class="layer-lock-list">
      <div v-for="(layer, id) in layers" :key="id" class="layer-lock-row">
        <span class="layer-lock-label">{{ layer.label }}</span>
        <button
          class="layer-lock-btn"
          :class="{ locked: layer.locked }"
          :title="layer.locked ? '解锁图层' : '锁定图层（不可编辑）'"
          @click="$emit('toggle', id)"
        >
          <Icon :name="layer.locked ? 'lock' : 'unlock'" :size="13"/> {{ layer.locked ? '已锁定' : '锁定' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import Icon from '../../components/Icon.vue';

defineProps({
  open: { type: Boolean, default: false },
  layers: { type: Object, default: () => ({}) },
});
defineEmits(['close', 'toggle']);
</script>

<style scoped>
.layer-lock-panel {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 200px;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 12px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.layer-lock-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.layer-lock-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
  font-size: 14px;
  line-height: 1;
}

.layer-lock-close:hover { color: #e2e8f0; }

.layer-lock-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.layer-lock-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 6px;
  border-radius: 4px;
}

.layer-lock-row:hover { background: #334155; }

.layer-lock-label {
  font-size: 12px;
  color: #cbd5e1;
}

.layer-lock-btn {
  background: none;
  border: 1px solid #475569;
  border-radius: 3px;
  cursor: pointer;
  padding: 1px 5px;
  opacity: 0.75;
  color: #94a3b8;
  font-size: 11px;
  line-height: 1.4;
  /* 2026-11-05：从纯锁图标改成“图标 + 锁定/已锁定”（纯图标只有 title，要悬停才知道）。 */
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}

.layer-lock-btn:hover { opacity: 1; }

.layer-lock-btn.locked {
  opacity: 1;
  color: #fbbf24;
  border-color: #fbbf24;
}
</style>
