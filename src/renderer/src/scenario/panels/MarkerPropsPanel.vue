<template>
  <!-- 标记属性面板（2026-10-24；2026-11-06 从 ScenarioMap.vue 拆出，拆分第四批）
       命中测试在 `utils/markerHitTest.js`（唯一实现，只读）；本面板只发事件，
       写仍走父组件的 store 写口（`updateScenarioMarker` / `removeScenarioMarker`），
       模板里不直改 marker 对象。
       样式与省份面板共用 `props-panel.css`（标记面板本来就复用省份面板的定位与行样式）。 -->
  <div v-if="marker && open" class="province-props marker-props" data-testid="marker-props">
    <div class="props-header">
      <input :value="marker.name || ''" class="props-name" placeholder="标记名称"
             data-testid="marker-name" @change="$emit('name', $event)" />
      <button class="props-close" data-testid="marker-close" title="收起面板（标记本身不动）"
              @click="$emit('close')">×</button>
    </div>
    <div class="props-row">
      <label>类型：</label>
      <select :value="marker.type || 'custom'" data-testid="marker-type" @change="$emit('type', $event)">
        <option v-for="t in types" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>
    </div>
    <div class="props-row">
      <label>坐标：</label>
      <input class="coord-input" type="number" step="1" data-testid="marker-x"
             :value="coords.x" title="世界坐标（地图内部单位；改完立刻生效，一条撤销可退回）"
             @change="$emit('coord', 'x', $event)" />
      <input class="coord-input" type="number" step="1" data-testid="marker-y"
             :value="coords.y" title="世界坐标（地图内部单位；改完立刻生效，一条撤销可退回）"
             @change="$emit('coord', 'y', $event)" />
    </div>
    <div class="props-row">
      <label>剧本：</label>
      <span class="marker-belong">{{ scenarioName || '（未选剧本）' }}</span>
    </div>
    <div class="props-stats">
      标记 {{ ordinal }} / {{ total }} · 点图标即选中，改动一次一条撤销
    </div>
    <div class="props-row">
      <button class="props-mini danger" data-testid="marker-delete" :disabled="readOnly"
              :title="readOnly ? (readOnlyReason || '只读：未打开项目')
                : '删除这个标记（可 Ctrl+Z 撤回；底图与省份不动）'"
              @click="$emit('delete')">删除标记</button>
    </div>
    <!-- 资料：同一份实现（与省份面板共用一个组件）——按标记名查索引；绑定走父面板写口（B1） -->
    <VaultLoreSection testid="marker-vault" :query="marker.name || ''"
                      :binding="{ path: marker.notePath || '', label: '这个标记' }"
                      :bind-fn="bindNote" :unbind-fn="unbindNote" />
  </div>
</template>

<script setup>
import VaultLoreSection from '../../components/VaultLoreSection.vue';

defineProps({
  marker: { type: Object, default: null },
  open: { type: Boolean, default: false },
  /** 标记类型表（父组件的 MARKER_TYPES） */
  types: { type: Array, default: () => [] },
  /** 世界坐标（父组件的 markerCoords，已取整） */
  coords: { type: Object, default: () => ({ x: 0, y: 0 }) },
  scenarioName: { type: String, default: '' },
  ordinal: { type: [Number, String], default: '?' },
  total: { type: Number, default: 0 },
  readOnly: { type: Boolean, default: false },
  readOnlyReason: { type: String, default: '' },
  bindNote: { type: Function, default: null },
  unbindNote: { type: Function, default: null },
});

defineEmits(['close', 'name', 'type', 'coord', 'delete']);
</script>

<style scoped src="./props-panel.css"></style>
