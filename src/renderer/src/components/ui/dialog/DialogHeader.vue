<script setup>
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps({ class: { type: [String, Array, Object], default: undefined } });
const classes = computed(() => cn('flex flex-col gap-1.5', props.class));
</script>

<template>
  <div :class="classes"><slot /></div>
</template>
