<template>
  <div class="tree-item">
    <div
      class="tree-node"
      :class="{ expanded: isExpanded, selected: selectedId === node.id, 'draggable-node': isPlaceNode }"
      :style="{ paddingLeft: depth * 12 + 8 + 'px' }"
      :draggable="isPlaceNode"
      :title="`${node.displayName || node.name}（单击选中 · 双击跳转）`"
      @dragstart="onDragStart"
      @click="$emit('select', node)"
      @dblclick="$emit('jump', node)"
    >
      <span v-if="node.children && node.children.length" class="expand-toggle" @click.stop="toggle">
        {{ isExpanded ? '▼' : '▶' }}
      </span>
      <span v-else class="expand-placeholder"></span>
      <span class="node-icon" :class="node.layer"></span>
      <span class="node-name">{{ node.displayName || node.name }}</span>
    </div>
    <div v-if="isExpanded && node.children" class="tree-children">
      <tree-item
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :selected-id="selectedId"
        @select="$emit('select', $event)"
        @jump="$emit('jump', $event)"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  selectedId: { type: String, default: null },
});

defineEmits(['select', 'jump']);

const isExpanded = ref(true);

// 地点类节点可拖拽到行星地图画布放置（location/city/town/village/facility）
const isPlaceNode = computed(() =>
  ['location', 'city', 'town', 'village', 'facility'].includes(props.node.layer)
);

function onDragStart(e) {
  if (!isPlaceNode.value) return;
  e.dataTransfer.setData('text/sitian-node-id', props.node.id);
  e.dataTransfer.effectAllowed = 'copy';
  // 拖拽视觉反馈（部分浏览器需要设置 drag image，默认即可）
}

function toggle() {
  isExpanded.value = !isExpanded.value;
}
</script>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 12px;
  border-radius: 3px;
  user-select: none;
}

.tree-node:hover {
  background: var(--btn-bg-hover);
}

.tree-node.draggable-node {
  cursor: grab;
}
.tree-node.draggable-node:active {
  cursor: grabbing;
}

.tree-node.selected {
  background: var(--accent-bg);
}

.expand-toggle {
  width: 12px;
  font-size: 9px;
  color: var(--text-tertiary);
  cursor: pointer;
}

.expand-placeholder {
  width: 12px;
}

.node-icon {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  flex-shrink: 0;
}

.node-icon.world { background: #ffd700; }
.node-icon.star_domain { background: #6b5b95; }
.node-icon.galaxy { background: #4a90d9; }
.node-icon.planet { background: #5cb85c; }
.node-icon.city { background: #f0ad4e; }
.node-icon.town { background: #d9853b; }
.node-icon.location { background: #888; }
.node-icon.unknown { background: #555; }

.node-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-children {
  overflow: hidden;
}
</style>
