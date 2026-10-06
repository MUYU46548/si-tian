<script setup>
import { DialogClose as RekaDialogClose } from 'reka-ui';

const props = defineProps({
  asChild: { type: Boolean, default: true },
  class: { type: [String, Array, Object], default: undefined },
});
</script>

<template>
  <RekaDialogClose :as-child="props.asChild" :class="props.class">
    <slot />
  </RekaDialogClose>
</template>
