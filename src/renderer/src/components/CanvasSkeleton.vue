<template>
  <div class="canvas-skeleton">
    <div class="skeleton-grid" />
    <div class="skeleton-spinner" />
    <div class="skeleton-text">地图加载中…</div>
  </div>
</template>

<script setup>
// U4: 画布挂载骨架屏 — 数据就绪前占位，避免七层视图 v-if 重挂时的白/黑屏闪烁
// 由宿主画布控制显隐（首帧渲染后淡出）；样式全局导出供 transition 复用
</script>

<style>
.canvas-skeleton {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: var(--map-bg, #0c1020);
  pointer-events: all;
}
.skeleton-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(120, 150, 190, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120, 150, 190, 0.08) 1px, transparent 1px);
  background-size: 48px 48px;
  animation: skeleton-pulse 1.4s ease-in-out infinite;
}
.skeleton-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(120, 160, 220, 0.25);
  border-top-color: var(--accent, #58a6ff);
  border-radius: 50%;
  animation: skeleton-spin 0.9s linear infinite;
}
.skeleton-text {
  font-size: 12.5px;
  color: var(--text-tertiary, #8b949e);
  letter-spacing: 0.05em;
}
@keyframes skeleton-spin {
  to { transform: rotate(360deg); }
}
@keyframes skeleton-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
/* 淡出过渡：宿主画布 <transition name="skeleton-fade"> */
.skeleton-fade-leave-active {
  transition: opacity 0.28s ease;
}
.skeleton-fade-leave-to {
  opacity: 0;
}
</style>
