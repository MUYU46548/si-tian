<template>
  <!-- “更多”浮层**面板本体**（2026-11-07 拆分第 9 步）：标题条 + “收起” + 5 张工具卡片。
       卡片由父组件通过**默认插槽**传进来 —— 卡片里的 props 仍写在父组件，契约照样源码可搜。

       🔴 2026-11-05 第二次改向：这块不再是“往下推的抽屉”，而是**浮在画布上的工具面板**。
       用户原话：“分组把原本就紧张的地图观测空间又压扁了一大截，显然不是好主意。”
       所以：地图不动、面板浮层 + 按用途分卡片（5 张自适应多列），并给一个明确的“收起”。

       ⚠️ **必须单根**：`.toolbar-more` 的浮层样式（`position:absolute` / 宽度 / 两列网格）在父组件
       的 scoped 表里，父 scope id 只贴在子组件**根**节点上。要是把背景遮罩也搬进来变成双根，
       这两个根都拿不到 scope id——面板会变成文档流里的一整块，把画布推下去（正是用户骂过的那个形态）。
       所以遮罩留在父组件，这里只出面板。
       ⚠️ `v-if="moreOpen"` 也留在父组件（遮罩与面板要一起出现/消失）。 -->
  <div class="toolbar-more">
    <div class="tm-head">
      <strong>工具</strong><span class="tm-sub">按用途分组；最常用的四个留在上面那条工具栏上</span>
      <button class="tm-close" data-testid="more-close" @click="$emit('close')" title="收起工具面板">收起</button>
    </div>
    <slot />
  </div>
</template>

<script setup>
// 外壳只做一件事：把“收起”接住、把 5 张卡片摆出来。工具状态一律不碰。
defineEmits(['close']);
</script>
