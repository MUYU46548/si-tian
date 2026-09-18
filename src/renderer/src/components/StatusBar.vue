<template>
  <footer v-if="state.visible" class="status-bar">
    <span class="sb-item sb-view">{{ state.viewLabel }}</span>
    <!-- 单一写闸门（Phase 2）：无项目只读态必须常驻可见，否则用户会以为「保存坏了」 -->
    <span v-if="isReadOnly" class="sb-item sb-readonly" :title="readOnlyReason">{{ READONLY_BADGE }}</span>
    <span v-if="state.toolLabel" class="sb-item">工具：{{ state.toolLabel }}</span>
    <span class="sb-item sb-coord" :title="'鼠标世界坐标'">{{ coordText }}</span>
    <span v-if="state.zoom != null" class="sb-item sb-zoom">缩放 {{ Math.round(state.zoom) }}%</span>
    <span v-if="state.selectionCount" class="sb-item sb-selection">已选中 {{ state.selectionCount }} 个对象</span>
    <span v-if="state.snap" class="sb-item sb-snap">{{ state.snap }}</span>
    <span class="sb-spacer" />
  </footer>
</template>

<script setup>
import { computed } from 'vue';
import { useStatusBarState, formatWorldCoord } from '../composables/useStatusBar';
import { isReadOnly, writeModeReason, READONLY_BADGE } from '../store/writeGate';

// E11: 底部状态栏 — 数据由各画布经 useStatusBar 写入，本组件只读
// 坐标更新走 rAF 节流（useStatusBar.setStatusThrottled），不触发画布重渲染

const state = useStatusBarState();
const coordText = computed(() => formatWorldCoord(state.mouseWorld?.x, state.mouseWorld?.y));
// 只读徽标的说明文案：写闸门给的人类可读原因（含「打开项目后即可编辑」的能力说明）
const readOnlyReason = writeModeReason;
</script>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 26px;
  padding: 0 12px;
  font-size: 11.5px;
  color: var(--text-tertiary);
  background: var(--panel-bg);
  border-top: 1px solid var(--panel-border);
  user-select: none;
  flex-shrink: 0;
}
.sb-item {
  white-space: nowrap;
}
.sb-view {
  color: var(--text-primary);
  font-weight: 600;
}
.sb-coord {
  font-variant-numeric: tabular-nums;
  min-width: 130px;
}
.sb-selection {
  color: var(--accent, #4a90d9);
}
/* 只读徽标：常驻可见 + 悬停给出「打开项目后即可编辑」的能力说明（能力不减） */
.sb-readonly {
  padding: 0 8px;
  border-radius: 9px;
  color: var(--warning, #d29922);
  background: color-mix(in srgb, var(--warning, #d29922) 14%, transparent);
  font-weight: 600;
  cursor: help;
}
.sb-spacer {
  flex: 1;
}
</style>
