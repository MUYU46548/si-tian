// lib/utils.js —— shadcn-vue 约定的类名合并工具（`cn`）。
// clsx 负责条件拼接，tailwind-merge 负责「后写的同类 utility 覆盖先写的」，
// 这样调用方传进来的 class 永远能覆盖组件默认样式（shadcn 的既有约定）。
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
