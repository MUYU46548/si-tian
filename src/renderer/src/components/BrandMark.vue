<!-- BrandMark.vue — 司天品牌标志（土星环系·剪影）
     几何与 build/icon.svg 同源：双环 + 紧贴行星 + 长轴偏置。
     fill 使用 currentColor，颜色跟随父级 CSS color。 -->
<template>
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 512 512"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="司天 SiTian"
  >
    <g transform="translate(256 256) rotate(-18) scale(3.1807)"><g opacity="0.74"><path d="M -49.84 0 A 49.84 15.95 0 1 0 49.84 0 A 49.84 15.95 0 1 0 -49.84 0 Z M -38.80 0 A 38.80 12.42 0 1 0 38.80 0 A 38.80 12.42 0 1 0 -38.80 0 Z M -71.92 0 A 71.92 23.01 0 1 0 71.92 0 A 71.92 23.01 0 1 0 -71.92 0 Z M -60.88 0 A 60.88 19.48 0 1 0 60.88 0 A 60.88 19.48 0 1 0 -60.88 0 Z" fill-rule="evenodd" fill="currentColor"/></g><circle cx="8.0" cy="0" r="32.0" fill="currentColor"/><path d="M -49.84 0 A 49.84 15.95 0 1 0 49.84 0 A 49.84 15.95 0 1 0 -49.84 0 Z M -38.80 0 A 38.80 12.42 0 1 0 38.80 0 A 38.80 12.42 0 1 0 -38.80 0 Z M -71.92 0 A 71.92 23.01 0 1 0 71.92 0 A 71.92 23.01 0 1 0 -71.92 0 Z M -60.88 0 A 60.88 19.48 0 1 0 60.88 0 A 60.88 19.48 0 1 0 -60.88 0 Z" fill-rule="evenodd" fill="currentColor"/></g>
  </svg>
</template>

<script setup>
defineProps({
  size: { type: [Number, String], default: 32 },
});
</script>

<style scoped>
.brand-mark {
  display: block;
  flex: none;
}
</style>
