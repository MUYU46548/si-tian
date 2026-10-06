<script setup>
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps({ class: { type: [String, Array, Object], default: undefined } });
const classes = computed(() => cn('text-xs text-muted-foreground', props.class));
</script>

<template>
  <p :class="classes"><slot /></p>
</template>
