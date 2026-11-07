<template>
  <!-- “更多 → 地形 · 底图 · 生成”卡片里的**视图与保存**组（2026-11-07 拆分第 9 步）。
       根元素仍是 `<div class="tool-group">`。
       ⚠️ 保存按钮的图标跟着 `saveDisplay.state` 变（saving / staged / saved / error / 其他），
       这是“保存诚实”口径的可见部分（`persisted === true` 才说已保存到磁盘）—— 五档都保留。 -->
  <div class="tool-group">
    <button @click="$emit('fit')" title="适应画布 (F)">适应视图</button>
    <button @click="$emit('exportPng')" title="导出 PNG 图片"><Icon name="export" :size="15"/>导出整图</button>
    <button @click="$emit('save')" title="保存到磁盘" :class="{ saving: saveState === 'saving' }"
            data-testid="scenario-save-btn">
      <Icon v-if="saveState === 'saving'" name="loader" :size="15"/>
      <Icon v-else-if="saveState === 'staged'" name="clock" :size="15"/>
      <Icon v-else-if="saveState === 'saved'" name="check-circle" :size="15"/>
      <Icon v-else-if="saveState === 'error'" name="x-circle" :size="15"/>
      <Icon v-else name="save" :size="15"/>
    保存</button>
  </div>
</template>

<script setup>
import Icon from '../../../../components/Icon.vue';

defineProps({
  /** 保存状态机的当前档：saving / staged / saved / error / idle…（决定图标） */
  saveState: { type: String, default: 'idle' },
});
defineEmits(['fit', 'exportPng', 'save']);
</script>
