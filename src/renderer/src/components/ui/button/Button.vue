<script setup>
// shadcn-vue Button（落地版，2026-10-06 UI 基座试点）
// 与官方源码的差异只有三处，都在 tailwind.css / tailwind.config.js 的注释里写了原因：
//   ① 颜色走 `--ui-*` 变量（R7：接司天主题，不用 shadcn 自己的调色板）；
//   ② 不加 `border`（preflight 关掉了，border-style 需要 shim 才可见）；
//   ③ 不用 `/90` 这类透明度修饰符 —— Tailwind 对「值是 CSS 变量」的颜色算不出 alpha，
//      会静默退化成不透明；hover 改用 `opacity-90`，效果等价且确定。
//   ④ `outline` / `ghost` 变体**显式写 `text-foreground`**。官方 shadcn 靠 preflight 里的
//      `button { color: inherit }` 拿到前景色；本仓 preflight 关闭（R1/R2）→ 这条复位缺席，
//      `<button>` 落回浏览器 UA 的 `buttontext`（Windows 浅色系统 = 近黑），
//      而 outline 底色是深色的 `--ui-background` → **黑底黑字，悬停才可见**
//      （2026-10-09 暮雨实测；test_83 量到对比度 1.11）。显式写前景色即修，且不引复位。
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
        outline: 'border border-solid border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
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
