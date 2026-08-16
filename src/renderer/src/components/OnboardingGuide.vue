<template>
  <div v-if="isOpen" class="onboarding-overlay">
    <div class="onboarding-panel">
      <div class="onboarding-header">
        <h2>👋 欢迎来到 SiTian</h2>
        <p>世界观地理可视化编辑器</p>
      </div>
      
      <div class="onboarding-steps">
        <div 
          v-for="(step, index) in steps" 
          :key="index"
          class="step-item"
          :class="{ active: currentStep === index, completed: currentStep > index }"
        >
          <div class="step-number">{{ index + 1 }}</div>
          <div class="step-content">
            <h4>{{ step.title }}</h4>
            <p>{{ step.desc }}</p>
          </div>
        </div>
      </div>
      
      <div class="onboarding-actions">
        <button v-if="currentStep < steps.length - 1" class="btn-secondary" @click="skip">跳过</button>
        <button class="btn-primary" @click="next">
          {{ currentStep < steps.length - 1 ? '下一步' : '开始使用' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const isOpen = ref(false);
const currentStep = ref(0);

const steps = [
  { title: '浏览世界观', desc: '从世界卡片开始，逐级探索星域、星系和行星' },
  { title: '查看详情', desc: '点击任何节点查看百科式详情卡片' },
  { title: '编辑地图', desc: '进入行星地图编辑模式，绘制省份和放置标记' },
  { title: '同步 Obsidian', desc: '双击节点在 Obsidian 中打开对应笔记' },
  { title: '开始创造', desc: '按 F1 随时查看帮助' },
];

function open() {
  // 检查是否首次使用
  const isFirstRun = !localStorage.getItem('sitian-first-run-complete');
  if (isFirstRun) {
    isOpen.value = true;
    currentStep.value = 0;
  }
}

function close() {
  isOpen.value = false;
  localStorage.setItem('sitian-first-run-complete', 'true');
}

function skip() {
  close();
}

function next() {
  if (currentStep.value < steps.length - 1) {
    currentStep.value++;
  } else {
    close();
  }
}

onMounted(() => {
  // 延迟显示，等数据加载完成
  setTimeout(() => {
    open();
  }, 1000);
});

defineExpose({ open, close });
</script>

<style scoped>
.onboarding-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 900;
  backdrop-filter: blur(2px);
}

.onboarding-panel {
  width: 420px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  padding: 24px;
}

.onboarding-header {
  text-align: center;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid #21262d;
}

.onboarding-header h2 {
  font-size: 18px;
  font-weight: 600;
  color: #f0f6fc;
  margin: 0 0 4px;
}

.onboarding-header p {
  font-size: 12px;
  color: #8b949e;
  margin: 0;
}

.onboarding-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}

.step-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #21262d;
  background: #161b22;
  transition: all 0.2s ease;
  opacity: 0.6;
}

.step-item.active {
  opacity: 1;
  border-color: #58a6ff;
  background: rgba(88, 166, 255, 0.08);
}

.step-item.completed {
  opacity: 0.8;
  border-color: #238636;
  background: rgba(35, 134, 54, 0.05);
}

.step-number {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #21262d;
  color: #8b949e;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.step-item.active .step-number {
  background: #58a6ff;
  color: #0d1117;
}

.step-item.completed .step-number {
  background: #238636;
  color: #f0f6fc;
}

.step-content h4 {
  font-size: 13px;
  font-weight: 600;
  color: #f0f6fc;
  margin: 0 0 2px;
}

.step-content p {
  font-size: 11px;
  color: #8b949e;
  margin: 0;
}

.onboarding-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.btn-primary {
  padding: 8px 16px;
  background: #238636;
  border: 1px solid #2ea043;
  border-radius: var(--radius-md);
  color: #f0f6fc;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.btn-primary:hover {
  background: #2ea043;
}

.btn-secondary {
  padding: 8px 16px;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: var(--radius-md);
  color: #8b949e;
  cursor: pointer;
  font-size: 12px;
}

.btn-secondary:hover {
  background: #30363d;
  color: #e2e8f0;
}
</style>
