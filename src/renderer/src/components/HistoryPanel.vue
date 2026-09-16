<template>
  <panel-shell title="撤销历史" :open="open" @close="$emit('close')" class="history-panel">
    <template #actions>
      <span class="history-count" :title="`共 ${entries.length} 步`">{{ currentIndex + 1 }}/{{ entries.length }}</span>
    </template>
    <div v-if="entries.length === 0" class="history-empty" data-testid="history-empty">
      暂无编辑历史
      <div class="history-empty-hint">在地图上做一次编辑（拖动/绘制/放置）后这里会出现记录</div>
    </div>
    <div v-else class="history-list" ref="listEl" data-testid="history-list">
      <div
        v-for="entry in entries"
        :key="entry.index"
        class="history-item"
        :data-testid="'history-item'"
        :data-index="entry.index"
        :data-state="stateOf(entry.index)"
        :class="{
          current: entry.index === currentIndex,
          applied: entry.index <= currentIndex && entry.index !== currentIndex,
          future: entry.index > currentIndex,
        }"
        :title="entry.index === currentIndex
          ? '当前位置'
          : entry.index < currentIndex
            ? '点击撤销到此步骤'
            : '点击重做到此步骤'"
        @click="jumpTo(entry.index)"
      >
        <span class="history-seq">{{ entry.index + 1 }}</span>
        <span class="history-icon"><Icon :name="getCategoryIcon(entry.category)" :size="13"/></span>
        <span class="history-label">{{ operationLabel(entry) }}</span>
        <span class="history-time">{{ formatTime(entry.timestamp) }}</span>
      </div>
    </div>
    <div class="history-footer">
      <span>第 {{ currentIndex + 1 }} / {{ entries.length }} 步<span v-if="futureCount > 0">（{{ futureCount }} 步可重做）</span></span>
      <span class="history-hint">点击任意步骤回到该状态；此后新操作将从该处开始新分支</span>
    </div>
  </panel-shell>
</template>

<script setup>
import Icon from './Icon.vue';
import { computed, ref, watch, nextTick } from 'vue';
import PanelShell from './PanelShell.vue';
import { getHistory, jumpTo as jumpToIndex, currentIndex } from '../store/undo';

// E2: 可交互撤销历史面板 — 点击历史项跳转到该状态（undo.js 线性历史 + 指针）
// 跳转后广播 sitian:history-jump，各画布监听后 requestRender 刷新
//
// P0-3 补强：
//   1. 操作名称兜底 —— 命令未写 label 时显示「未命名操作 #N」，不再出现空白行
//   2. header 内显示步数（折叠后仍可见当前进度）
//   3. 面板展开/历史变化时自动把"当前步"滚进可视区（历史长了不用手翻）
//   4. data-testid / data-index / data-state 供回归测试无歧义定位（不依赖文案与 emoji）

const props = defineProps({
  open: { type: Boolean, default: false },
});
defineEmits(['close']);

const listEl = ref(null);

const entries = computed(() => {
  if (!props.open) return [];
  return getHistory();
});

const futureCount = computed(() =>
  props.open ? Math.max(0, entries.value.length - 1 - currentIndex.value) : 0);

function stateOf(index) {
  if (index === currentIndex.value) return 'current';
  return index < currentIndex.value ? 'applied' : 'future';
}

/** 操作名称：命令自带 label 优先（当前所有命令均已中文化），缺失时给出可读兜底 */
function operationLabel(entry) {
  const raw = typeof entry?.label === 'string' ? entry.label.trim() : '';
  return raw || `未命名操作 #${entry.index + 1}`;
}

function jumpTo(index) {
  jumpToIndex(index);
  // 跳转改变画布数据但不触发各画布的 watch，广播事件让可见画布重绘
  window.dispatchEvent(new CustomEvent('sitian:history-jump'));
}

function formatTime(timestamp) {
  if (!timestamp) return '--:--:--';
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// category → Icon.vue 图标名（未定义分类回落 file-text，不抛错）
const CATEGORY_ICONS = {
  coordinate: 'map-pin',
  hyperlane: 'route',
  terrain: 'map',
  region: 'folder-open',
  property: 'pencil',
  marker: 'map-pin',
  object: 'box',
  cluster: 'folder-open',
  interior: 'armchair',
  scenario: 'flag',
  label: 'type',
};

function getCategoryIcon(category) {
  return CATEGORY_ICONS[category] || 'file-text';
}

/** 把当前步滚动到可视区中央（面板打开、步数变化、跳转后都调用） */
function scrollCurrentIntoView() {
  nextTick(() => {
    const el = listEl.value?.querySelector('.history-item.current');
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}

watch([() => props.open, () => entries.value.length, currentIndex], scrollCurrentIntoView, { flush: 'post' });
</script>

<style>
.history-panel {
  position: absolute;
  left: 12px;
  top: 60px;
  z-index: 60;
  width: 320px;
}
.history-panel .panel-shell-body {
  max-height: 60vh;
  overflow: auto;
}
.history-count {
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  padding: 1px 6px;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
}
.history-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 12.5px;
}
.history-empty-hint {
  margin-top: 6px;
  font-size: 11px;
  opacity: 0.75;
  line-height: 1.5;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  color: var(--text-primary);
}
.history-item:hover {
  background: var(--accent-bg, rgba(100, 150, 200, 0.15));
}
.history-item.current {
  background: var(--accent-bg, rgba(88, 166, 255, 0.2));
  font-weight: 600;
}
.history-item.current::before {
  content: '';
  display: inline-block;
  vertical-align: middle;
  width: 0;
  height: 0;
  border-left: 5px solid var(--accent);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  margin-right: 2px;
}
.history-item.future {
  opacity: 0.42;
}
.history-seq {
  width: 18px;
  flex-shrink: 0;
  text-align: right;
  color: var(--text-tertiary);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.history-item.current .history-seq {
  color: var(--accent);
}
.history-icon {
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}
.history-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-time {
  color: var(--text-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.history-footer {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-top: 1px solid var(--panel-border);
  color: var(--text-tertiary);
  font-size: 11px;
}
.history-hint {
  line-height: 1.4;
}
</style>
