<script setup>
// shadcn-vue Button（落地版，2026-10-06 UI 基座试点）
// 与官方源码的差异只有三处，都在 tailwind.css / tailwind.config.js 的注释里写了原因：
//   ① 颜色走 `--ui-*` 变量（R7：接司天主题，不用 shadcn 自己的调色板）；
//   ② 不加 `border`（preflight 关掉了，border-style 需要 shim 才可见）；
//   ③ 不用 `/90` 这类透明度修饰符 —— Tailwind 对「值是 CSS 变量」的颜色算不出 alpha，
//      会静默退化成不透明；hover 改用 `opacity-90`，效果等价且确定。
import { computed } from 'vue';
import { Primitive } from 'reka-ui';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
        outline: 'border border-solid border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

const props = defineProps({
  variant: { type: String, default: 'default' },
  size: { type: String, default: 'default' },
  as: { type: [String, Object], default: 'button' },
  asChild: { type: Boolean, default: false },
  class: { type: [String, Array, Object], default: undefined },
});

const classes = computed(() => cn(buttonVariants({ variant: props.variant, size: props.size }), props.class));
</script>

<template>
  <Primitive :as="as" :as-child="asChild" :class="classes">
    <slot />
  </Primitive>
</template>
