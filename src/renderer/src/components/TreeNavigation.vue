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
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useGeodataStore } from '../store/geodata';
import TreeItem from './TreeItem.vue';

const store = useGeodataStore();
const collapsed = ref(false);

const tree = computed(() => store.tree);

function handleSelect(node) {
  store.selectNode(node);
  
  // 根据节点层级自动跳转视图
  if (node.layer === 'world') {
    store.selectWorld(node);
  } else if (node.layer === 'star_domain') {
    // 找到所属世界并进入
    const world = store.nodes.find(n => n.id === node.parentId);
    if (world) {
      store.selectWorld(world);
      store.selectDomain(node);
    }
  } else if (node.layer === 'galaxy') {
    const domain = store.nodes.find(n => n.id === node.parentId);
    if (domain) {
      const world = store.nodes.find(n => n.id === domain.parentId);
      if (world) {
        store.selectWorld(world);
        store.selectDomain(domain);
        store.selectSystem(node);
      }
    }
  }
}
</script>

<style scoped>
.tree-navigation {
  width: 200px;
  min-width: 200px;
  background: #161b22;
  border-right: 1px solid #30363d;
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
  border-bottom: 1px solid #30363d;
  background: #0d1117;
}

.tree-header h4 {
  font-size: 12px;
  color: #8b949e;
  font-weight: 600;
  white-space: nowrap;
}

.collapsed .tree-header h4 {
  display: none;
}

.toggle-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 10px;
  padding: 2px 4px;
  border-radius: 2px;
}

.toggle-btn:hover {
  background: #21262d;
  color: #c9d1d9;
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
  color: #484f58;
}

/* 滚动条样式 */
.tree-body::-webkit-scrollbar {
  width: 6px;
}

.tree-body::-webkit-scrollbar-track {
  background: transparent;
}

.tree-body::-webkit-scrollbar-thumb {
  background: #30363d;
  border-radius: 3px;
}

.tree-body::-webkit-scrollbar-thumb:hover {
  background: #484f58;
}
</style>
