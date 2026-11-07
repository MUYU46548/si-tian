<template>
  <!-- 省份行 · 描轮廓（`outline` 工具的选项组），2026-11-07 拆分第 8 步。
       根元素是原来的 `<div class="tool-group brush-settings">`（`v-if` 与 `data-testid` 留在父组件）。
       ⚠️ `.row-hint` / `.check-label` / `.brush-settings` 的样式都在父组件 scoped 表里，
       父表对它们都有 `:deep()` 入口 —— 见 `scenario-map.css` 开头那段“为什么必须 :deep”。 -->
  <div class="tool-group brush-settings">
    <span class="row-hint"
          title="这套语义是“先并给目标省、再从被碰到的省挖掉”：贴着边界描时基本无缝；区域若探进别省地盘，那块地会两省各留一份（会如实提示百分比）">
      沿边界拖一圈 → 松手改判
    </span>
    <label class="check-label" data-testid="outline-to-neighbor"
           title="开（默认）：围住的那块地改判给**贴着描的那个邻省**——这是“把这块地划过去”。关：归**它原本所属的省**（等于原地修形状，通常看不出变化）">
      <input type="checkbox" :checked="toNeighbor" @change="$emit('update:toNeighbor', $event.target.checked)" /> 改判给邻省
    </label>
  </div>
</template>

<script setup>
defineProps({
  /** 围住的那块地改判给“贴着描的邻省”（开）还是“它原本所属的省”（关） */
  toNeighbor: { type: Boolean, default: true },
});
defineEmits(['update:toNeighbor']);
</script>
