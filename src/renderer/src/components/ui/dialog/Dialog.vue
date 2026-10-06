<script setup>
// shadcn-vue Dialog 的 Root 薄包装（reka-ui 的 DialogRoot）。
// `modal` 默认 true —— 这是「真锁模态」的来源（配合 DialogContent 的 trapFocus + aria-modal）。
import { DialogRoot } from 'reka-ui';

const props = defineProps({
  open: { type: Boolean, default: undefined },
  defaultOpen: { type: Boolean, default: false },
  modal: { type: Boolean, default: true },
});
const emits = defineEmits(['update:open']);
</script>

<template>
  <DialogRoot
    :open="props.open"
    :default-open="props.defaultOpen"
    :modal="props.modal"
    @update:open="emits('update:open', $event)"
  >
    <slot />
  </DialogRoot>
</template>
