<script setup>
import { computed } from 'vue';
import { DialogOverlay as RekaDialogOverlay } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps({ class: { type: [String, Array, Object], default: undefined } });
const classes = computed(() => cn('fixed inset-0 bg-black/80', props.class));
</script>

<template>
  <!-- data-sitian-dialog-overlay：动画选择器钩子（见 assets/tailwind.css）
       z-index 写在 tailwind.css 的钩子里，不用 z-[…] 任意值 -->
  <RekaDialogOverlay data-sitian-dialog-overlay :class="classes">
    <slot />
  </RekaDialogOverlay>
</template>
