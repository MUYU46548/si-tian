<template>
  <div
    v-if="state.visible"
    class="sitian-context-menu"
    :style="{ left: state.x + 'px', top: state.y + 'px' }"
    @mousedown.stop
    @contextmenu.prevent
  >
    <template v-for="(item, i) in state.items" :key="item.key || i">
      <div v-if="item.separator" class="menu-separator" />
      <div
        v-else
        class="menu-item"
        :class="{ danger: item.danger, disabled: item.disabled }"
        @click="onSelect(item)"
      >
        <span v-if="item.icon" class="menu-icon">{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </div>
    </template>
  </div>
</template>

<script setup>
// U3: 统一右键菜单组件 — 配合 useContextMenu 使用，定位状态由 composable 管理
const props = defineProps({
  state: { type: Object, required: true },
});
const emit = defineEmits(['close']);

function onSelect(item) {
  if (item.disabled) return;
  emit('close');
  item.action?.();
}

function onGlobalMouseDown(e) {
  if (props.state.visible && !e.target.closest('.sitian-context-menu')) {
    emit('close');
  }
}
function onGlobalKeydown(e) {
  if (e.key === 'Escape' && props.state.visible) emit('close');
}

window.addEventListener('mousedown', onGlobalMouseDown, true);
window.addEventListener('keydown', onGlobalKeydown, true);
</script>

<style>
/* 全局样式（非 scoped）：菜单 DOM 需要被 composable 的 querySelector 查到 */
.sitian-context-menu {
  position: absolute;
  z-index: 5000;
  min-width: 168px;
  padding: 4px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md, 8px);
  box-shadow: var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.4));
  user-select: none;
}
.sitian-context-menu .menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--text-primary);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  white-space: nowrap;
}
.sitian-context-menu .menu-item:hover {
  background: var(--accent-bg, rgba(100, 150, 200, 0.15));
}
.sitian-context-menu .menu-item.danger {
  color: #ff7b72;
}
.sitian-context-menu .menu-item.danger:hover {
  background: rgba(255, 123, 114, 0.12);
}
.sitian-context-menu .menu-item.disabled {
  opacity: 0.45;
  cursor: default;
}
.sitian-context-menu .menu-item.disabled:hover {
  background: transparent;
}
.sitian-context-menu .menu-icon {
  width: 16px;
  text-align: center;
}
.sitian-context-menu .menu-separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--panel-border);
}
</style>
