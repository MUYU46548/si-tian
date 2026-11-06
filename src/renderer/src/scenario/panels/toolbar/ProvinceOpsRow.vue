<template>
  <!-- 工具栏“省份与笔刷”卡片里的**拆分 / 合并 / 删除**这一行（2026-11-06 工具栏拆分试点）
       为什么先拿这块试点：它是工具栏里依赖最少的行（只有 `tool` 一个状态 + `setTool` 一个动作），
       用来验证“按行拆 + 显式 props”这条决断（见 docs/plan/DECISION_TOOLBAR_SPLIT_20261106.md）
       能落地的全链路：props / emit / DOM 一字不差 / 闸门照过。

       🔴 三条硬约束（每搬一行都一样）：
         · 根元素必须是原来那个 `<div class="toolbar-row">`，不许再包一层 wrapper
           （`test_65`/`test_97` 按 class 数“主行恰好 6 个可见控件”，包一层就数错）；
         · `data-testid` / `title` / 按钮顺序原样；
         · 状态仍归父组件：这里只读 `tool`、只 emit `setTool`，不碰 store。 -->
  <div class="toolbar-row">
    <label class="row-label">省份：</label>
    <div class="tool-group">
      <button
        :class="{ active: tool === 'split' }"
        @click="$emit('setTool', 'split')"
        title="拆分省份 (X) — 点击两个点定义分割线"
      ><Icon name="scissors" :size="15"/>拆分</button>
      <button
        :class="{ active: tool === 'merge' }"
        @click="$emit('setTool', 'merge')"
        title="合并省份 (M) — 依次点击两个省份"
      >⊕合并</button>
      <button
        :class="{ active: tool === 'erase' }"
        @click="$emit('setTool', 'erase')"
        title="删除 (E) — 点击省份删除"
      ><Icon name="trash" :size="15"/>删除</button>
    </div>
  </div>
</template>

<script setup>
import Icon from '../../../components/Icon.vue';

defineProps({
  /** 当前工具 id（父组件的 `tool`）；本行只关心 split / merge / erase 三个 */
  tool: { type: String, default: 'select' },
});
defineEmits(['setTool']);
</script>
