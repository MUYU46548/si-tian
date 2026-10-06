<script setup>
// shadcn-vue Card（落地版）：纯展示容器，颜色走 `--ui-*`，border 需显式 border-solid
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps({ class: { type: [String, Array, Object], default: undefined } });
const classes = computed(() => cn('rounded-lg border border-solid bg-card text-card-foreground shadow-sm', props.class));
</script>

<template>
  <div :class="classes">
    <slot />
  </div>
</template>
