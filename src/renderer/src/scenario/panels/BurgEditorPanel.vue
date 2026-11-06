<template>
  <!-- 聚落编辑器面板（2026-11-06 从 ScenarioMap.vue 拆出）
       为什么拆：`ScenarioMap.vue` 里这个浮层大约 36 行模板 + 90 行样式，全都只服务这一处。
       拆出来之后本文件不再需要 `.burg-editor-*` 这套样式（已随组件搬走，scoped）。

       数据口径（**刻意保持不变**）：`burg` 是父组件里的草稿对象（`editingBurg`），
       这里直接改它的字段 —— 与拆分前 `v-model="editingBurg.xxx"` 逐字同效；
       保存仍由父组件走 `saveBurgEditor`（唯一写口，一条撤销），本组件不碰 store。 -->
  <div v-if="open && burg" class="burg-editor-panel" data-testid="burg-editor">
    <div class="burg-editor-header">
      <span>聚落编辑</span>
      <button class="burg-editor-close" title="关闭聚落编辑面板" @click="$emit('close')">×</button>
    </div>
    <div class="burg-editor-body">
      <div class="burg-editor-row">
        <label>名称：</label>
        <input v-model="burg.name" placeholder="聚落名称" />
      </div>
      <div class="burg-editor-row">
        <label>规模：</label>
        <select v-model="burg.size">
          <option v-for="size in sizes" :key="size.id" :value="size.id">{{ size.name }}</option>
        </select>
      </div>
      <div class="burg-editor-row">
        <label>人口：</label>
        <input v-model.number="burg.population" type="number" min="0" />
      </div>
      <div class="burg-editor-row">
        <label>文化：</label>
        <input v-model="burg.culture" placeholder="文化归属" />
      </div>
      <div class="burg-editor-row checkbox-row">
        <label>首都：</label>
        <input type="checkbox" v-model="burg.capital" :true-value="1" :false-value="0" />
      </div>
      <div class="burg-editor-actions">
        <button class="burg-save-btn" @click="$emit('save')">保存</button>
        <button @click="$emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  open: { type: Boolean, default: false },
  burg: { type: Object, default: null },
  sizes: { type: Array, default: () => [] },
});
defineEmits(['save', 'close']);
</script>

<style scoped>
.burg-editor-panel {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 280px;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 16px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.burg-editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
}

.burg-editor-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
  font-size: 14px;
  line-height: 1;
}

.burg-editor-close:hover { color: #e2e8f0; }

.burg-editor-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.burg-editor-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.burg-editor-row label {
  min-width: 60px;
  font-size: 12px;
  color: #94a3b8;
}

.burg-editor-row input[type="text"],
.burg-editor-row input[type="number"],
.burg-editor-row select {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 4px 8px;
  color: #e2e8f0;
  font-size: 12px;
}

.burg-editor-row.checkbox-row label {
  min-width: auto;
}

.burg-editor-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}

.burg-editor-actions button {
  padding: 6px 16px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.burg-editor-actions button.burg-save-btn {
  background: #5b21b6;
  border-color: #7c3aed;
}
</style>
