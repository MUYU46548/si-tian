<template>
  <div class="tree-navigation" :class="{ collapsed: collapsed }">
    <div class="tree-header">
      <h4>导航</h4>
      <button class="toggle-btn" @click="collapsed = !collapsed" :title="collapsed ? '展开' : '收起'">
        {{ collapsed ? '▶' : '◀' }}
      </button>
    </div>
    <div v-if="!collapsed" class="tree-body">
      <div v-if="tree.length === 0" class="tree-empty">暂无节点</div>
      <tree-item
        v-for="node in tree"
        :key="node.id"
        :node="node"
        :depth="0"
        :selected-id="store.selectedNode?.id || null"
        @select="handleSelect"
        @jump="handleJump"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useNodeNavigation } from '../composables/useNodeNavigation';
import TreeItem from './TreeItem.vue';

const store = useGeodataStore();
const { jumpToNode } = useNodeNavigation();
const collapsed = ref(false);

const tree = computed(() => store.tree);

// 单击=选中并打开详情面板（所有层级统一语义，批次A4）
function handleSelect(node) {
  store.selectNode(node);
}

// 双击=跳转到节点对应视图（含镜头聚焦与详情面板恢复，逻辑与搜索直达共用）
function handleJump(node) {
  jumpToNode(node);
}
</script>

<style scoped>
.tree-navigation {
  width: 200px;
  min-width: 200px;
  background: var(--nav-bg);
  border-right: 1px solid var(--nav-border);
  display: flex;
  flex-direction: column;
  transition: width 0.2s, min-width 0.2s;
  overflow: hidden;
}

.tree-navigation.collapsed {
  width: 36px;
  min-width: 36px;
}

.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--nav-border);
  background: var(--toolbar-bg);
}

.tree-header h4 {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 600;
  white-space: nowrap;
}

.collapsed .tree-header h4 {
  display: none;
}

.toggle-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 10px;
  padding: 2px 4px;
  border-radius: 2px;
}

.toggle-btn:hover {
  background: var(--btn-bg);
  color: var(--text-secondary);
}

.tree-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.tree-empty {
  padding: 16px 10px;
  text-align: center;
  font-size: 11px;
  color: var(--separator);
}

/* 滚动条样式 */
.tree-body::-webkit-scrollbar {
  width: 6px;
}

.tree-body::-webkit-scrollbar-track {
  background: transparent;
}

.tree-body::-webkit-scrollbar-thumb {
  background: var(--nav-border);
  border-radius: 3px;
}

.tree-body::-webkit-scrollbar-thumb:hover {
  background: var(--separator);
}
</style>
