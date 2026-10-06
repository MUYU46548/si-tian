<script setup>
// shadcn-vue DialogContent（落地版，2026-10-06）
//
// 与官方源码的关键差异，每条都有理由：
//
//  1. 🔴 **不套 DialogPortal**。shadcn 默认把内容 teleport 到 body —— 在司天会直接踩 R7：
//     `.theme-dark` / `.theme-light` 是 App.vue 的 scoped 规则，token 靠**继承**下发，
//     一旦离开 `.app-layout` 就拿不到 `--ui-*`，组件会变成无色。
//     就地渲染（挂在 `.app-layout` 内）即可正常继承。
//
//  2. 🔴 **显式传 `trapFocus`**。reka-ui 的 DialogContentModal 对 `trapFocus` 只声明了
//     Boolean 而**没给默认值** → 不传就是 false → FocusScope 不做焦点陷阱。
//     「Tab 困在弹窗内」是知情同意的证据力所在，不能靠默认值。
//
//  3. 🔴 **手动补 `aria-modal="true"`**。reka-ui 只给 `role="dialog"`，
//     全仓此前 0 处 aria-modal —— 这是本仓第一个真锁模态，属性由我们自己写死。
//
//  4. 位置/尺寸/动画走 assets/tailwind.css 的 `[data-sitian-dialog-content]` 钩子，
//     不用 `-translate-x-1/2` 这类 transform utility —— 免得和进场动画的 transform 打架。
import { computed } from 'vue';
import { DialogContent as RekaDialogContent } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps({
  class: { type: [String, Array, Object], default: undefined },
  /** 焦点陷阱：默认开。关掉只应出现在「非模态提示」这种场景 */
  trapFocus: { type: Boolean, default: true },
  /** 点遮罩是否关闭（默认开；强制模式由使用方传 false） */
  dismissOnOutsideClick: { type: Boolean, default: true },
  /** Esc 是否关闭（默认开；强制模式由使用方传 false） */
  dismissOnEscape: { type: Boolean, default: true },
});

const emits = defineEmits([
  'escapeKeyDown',
  'pointerDownOutside',
  'focusOutside',
  'interactOutside',
  'openAutoFocus',
  'closeAutoFocus',
]);

const classes = computed(() => cn('flex w-[560px] flex-col bg-card text-card-foreground border border-solid border-border shadow-lg focus:outline-none', props.class));

function onEscapeKeyDown(e) {
  emits('escapeKeyDown', e);
  if (!props.dismissOnEscape) e.preventDefault();
}

function onPointerDownOutside(e) {
  emits('pointerDownOutside', e);
  if (!props.dismissOnOutsideClick) e.preventDefault();
}

function onInteractOutside(e) {
  emits('interactOutside', e);
  if (!props.dismissOnOutsideClick) e.preventDefault();
}
</script>

<template>
  <RekaDialogContent
    data-sitian-dialog-content
    role="dialog"
    aria-modal="true"
    :trap-focus="props.trapFocus"
    :class="classes"
    @escape-key-down="onEscapeKeyDown"
    @pointer-down-outside="onPointerDownOutside"
    @interact-outside="onInteractOutside"
    @focus-outside="(e) => emits('focusOutside', e)"
    @open-auto-focus="(e) => emits('openAutoFocus', e)"
    @close-auto-focus="(e) => emits('closeAutoFocus', e)"
  >
    <slot />
  </RekaDialogContent>
</template>
