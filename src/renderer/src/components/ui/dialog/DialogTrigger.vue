<script setup>
import { DialogTrigger as RekaDialogTrigger } from 'reka-ui';

const props = defineProps({
  asChild: { type: Boolean, default: true },
  class: { type: [String, Array, Object], default: undefined },
});
</script>

<template>
  <RekaDialogTrigger :as-child="props.asChild" :class="props.class">
    <slot />
  </RekaDialogTrigger>
</template>
