<template>
  <!-- “更多 → 地形 · 底图 · 生成”卡片里的**模式**组（2026-11-07 拆分第 9 步）。
       根元素仍是 `<div class="tool-group">`。
       🔴 两个模式**工具栏是同一套**，用户看不出差别（暮雨实测：“根本看不懂”）。
       它们真正的区别在**着色与图层**：底图编辑按群系看自然面貌，剧本模式按势力看政治版图。
       所以旁边常驻一句话，省得用户来回切着猜。 -->
  <div class="tool-group">
    <label>模式：</label>
    <select :value="mode" @change="$emit('update:mode', $event.target.value); $emit('change')">
      <option value="base">底图编辑</option>
      <option value="scenario">剧本模式</option>
    </select>
    <span class="row-hint" data-testid="view-mode-hint" :title="hint">{{ hint }}</span>
  </div>
</template>

<script setup>
defineProps({
  /** 当前视图模式：base / scenario */
  mode: { type: String, default: 'base' },
  /** 这一句差异说明（父组件按模式算好传入） */
  hint: { type: String, default: '' },
});
defineEmits(['update:mode', 'change']);
</script>
