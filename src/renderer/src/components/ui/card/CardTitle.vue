<script setup>
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps({ class: { type: [String, Array, Object], default: undefined } });
const classes = computed(() => cn('text-sm font-semibold leading-none tracking-tight', props.class));
</script>

<template>
  <h3 :class="classes"><slot /></h3>
</template>
