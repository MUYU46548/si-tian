<script setup>
import { computed } from 'vue';
import { DialogTitle as RekaDialogTitle } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps({ class: { type: [String, Array, Object], default: undefined } });
const classes = computed(() => cn('text-base font-semibold leading-none tracking-tight', props.class));
</script>

<template>
  <RekaDialogTitle :class="classes"><slot /></RekaDialogTitle>
</template>
