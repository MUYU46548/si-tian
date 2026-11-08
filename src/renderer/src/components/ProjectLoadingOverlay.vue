<template>
  <!-- 打开项目时的全屏遮罩（2026-11-08）。
       用户原话：“打开时就不该白屏，应该有加载画面。”
       ⚠️ 它必须**比重活早一帧**被画出来（`projectStore.openProject` 里 `nextPaint()` 的注释），
       否则遮罩只是躺在 DOM 里，屏幕依旧是白屏。
       ⚠️ 刻意没有按钮：加载中不该有可点的东西（误点会开两份项目）。
       文案守“按钮/文字说人话”那条：不出现术语，只说人在等什么。 -->
  <transition name="plo-fade">
    <div v-if="state.active" class="plo-mask" data-testid="project-loading-overlay" role="status" aria-live="polite">
      <div class="plo-card">
        <div class="plo-spinner" aria-hidden="true"></div>
        <div class="plo-title">{{ state.text || '正在打开项目…' }}</div>
        <div class="plo-sub">{{ subText }}</div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useProjectStore } from '../store/projectStore';

const project = useProjectStore();
const { openProgress } = storeToRefs(project);
const state = computed(() => openProgress.value || { active: false, text: '' });

// 秒数只在“已经开始卡”之后才显示（<0.4s 一闪而过时显示 0 秒反而像出错）
const subText = computed(() => {
  const started = state.value.startedAt || 0;
  if (!started) return '项目文件在本机读取，不会联网';
  const sec = (Date.now() - started) / 1000;
  if (sec < 0.4) return '项目文件在本机读取，不会联网';
  return `已等待 ${sec.toFixed(1)} 秒 · 项目文件在本机读取，不会联网`;
});
</script>

<style scoped>
.plo-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;            /* 高于所有浮层/面板；免责声明是 8xxx 档，必须压在它下面 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 14, 20, 0.62);
  /* ⚠️ 刻意**不用** `backdrop-filter: blur()`：加载那几秒是主线程最忙的时候，
     再让合成器为模糊去采样整张画布是白给的负担。实测带不带模糊都是 22s 上下
     （6000 省 / 35 万格，两次连测），所以它不是“卡”的原因 —— 但也别加回去。 */
}
.plo-card {
  min-width: 280px;
  max-width: min(520px, calc(100vw - 48px));
  padding: 22px 26px 18px;
  border-radius: 12px;
  background: #1b2230;
  color: #e8eef7;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  text-align: center;
}
.plo-spinner {
  width: 26px;
  height: 26px;
  margin: 0 auto 14px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.18);
  border-top-color: #7db3ff;
  animation: plo-spin 900ms linear infinite;
}
@keyframes plo-spin {
  to { transform: rotate(360deg); }
}
.plo-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
}
.plo-sub {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.72;
}
.plo-fade-enter-active,
.plo-fade-leave-active { transition: opacity 120ms ease; }
.plo-fade-enter-from,
.plo-fade-leave-to { opacity: 0; }
</style>
