<template>
  <div
    v-if="open"
    ref="rootEl"
    class="panel-shell"
    :style="dragPos ? { left: dragPos.x + 'px', top: dragPos.y + 'px' } : undefined"
    @mousedown="stopMouseDown && $event.stopPropagation()"
  >
    <div class="panel-header" @mousedown="onHeaderMouseDown">
      <h3>{{ title }}</h3>
      <div class="header-actions">
        <slot name="actions" />
        <button
          v-if="collapsible"
          class="fold-btn"
          :title="collapsed ? '展开面板' : '折叠面板'"
          @click="collapsed = !collapsed"
        >{{ collapsed ? '▸' : '▾' }}</button>
        <button class="close-btn" title="关闭面板" @click="$emit('close')">×</button>
      </div>
    </div>
    <div v-if="!collapsed" class="panel-shell-body">
      <slot />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

/**
 * 统一浮窗面板外壳（批次0-3 PanelShell）
 *
 * 职责：header 拖拽移动（含边界钳制）、关闭（$emit('close')，开关状态归父组件）、
 * 可选折叠。定位（left/bottom/z-index 等）由使用方通过 class 穿透传入，
 * 拖拽后切换为 left/top 内联定位并记住位置（面板关闭重开不丢失）。
 *
 * 约束：不在此处管理互斥（互斥归 PlanetMap 本地状态 / panels store）。
 */

const props = defineProps({
  title: { type: String, required: true },
  open: { type: Boolean, default: true },
  collapsible: { type: Boolean, default: true },
  // 根节点是否拦截 mousedown 冒泡（SnapshotPanel 等历史行为保留）
  stopMouseDown: { type: Boolean, default: false },
});

defineEmits(['close']);

const rootEl = ref(null);
const collapsed = ref(false);
// 拖拽后的 left/top（相对 offsetParent）；null = 仍用 CSS class 初始定位
const dragPos = ref(null);

function onHeaderMouseDown(e) {
  // header 内交互元素（按钮/输入框等）不触发拖拽
  if (e.target.closest('button, input, select, textarea, a, label')) return;
  const panel = rootEl.value;
  if (!panel) return;
  e.preventDefault();

  const startX = e.clientX;
  const startY = e.clientY;
  // getBoundingClientRect 取视觉位置，不受初始 right/bottom 定位影响
  const rect = panel.getBoundingClientRect();
  const containerRect = panel.parentElement?.getBoundingClientRect() || { left: 0, top: 0 };
  const origLeft = rect.left - containerRect.left;
  const origTop = rect.top - containerRect.top;
  dragPos.value = { x: origLeft, y: origTop };

  function onMove(ev) {
    if (!panel || !panel.parentElement) return;
    const cr = panel.parentElement.getBoundingClientRect();
    // 钳制在容器内，面板不会被拖出视野丢失
    const x = Math.min(Math.max(origLeft + ev.clientX - startX, 0), Math.max(0, cr.width - rect.width));
    const y = Math.min(Math.max(origTop + ev.clientY - startY, 0), Math.max(0, cr.height - rect.height));
    dragPos.value = { x, y };
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
</script>

<style scoped>
.panel-shell {
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.panel-shell .panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border);
  background: var(--panel-header-bg);
  cursor: move;
  user-select: none;
}

.panel-shell .panel-header h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.panel-shell .header-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.panel-shell .fold-btn {
  background: none;
  border: 1px solid var(--panel-border);
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 10px;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  line-height: 1;
}

.panel-shell .fold-btn:hover {
  color: var(--text-primary);
  background: var(--btn-bg);
}

.panel-shell .close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
  line-height: 1;
}

.panel-shell .close-btn:hover {
  color: var(--text-primary);
}

.panel-shell-body {
  overflow-y: auto;
  min-height: 0;
}
</style>
