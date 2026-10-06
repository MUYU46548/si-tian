<template>
  <div v-if="isOpen" class="onboarding-overlay">
    <div class="onboarding-panel">
      <div class="onboarding-header">
        <h2><Icon name="hand" :size="20" style="margin-right:6px"/>欢迎来到 SiTian</h2>
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
      
      <div class="onboarding-vault">
        <button class="btn-vault" @click="chooseVault"><Icon name="folder" :size="14"/> 选择 Obsidian 知识库</button>
        <p v-if="vaultMsg" class="vault-msg" :class="{ error: vaultError }">{{ vaultMsg }}</p>
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
import Icon from './Icon.vue';
import { ref, onMounted } from 'vue';

const isOpen = ref(false);
const currentStep = ref(0);
const vaultMsg = ref('');
const vaultError = ref(false);

async function chooseVault() {
  vaultMsg.value = '';
  vaultError.value = false;
  try {
    const result = await window.sitianAPI.selectVaultPath();
    if (result?.canceled) return;
    if (result?.success) {
      // 🔴 旧实现派发 `sitian:reextract` —— 那是**落盘写**，在「无项目 = 只读」下必被写闸门拒绝：
      //    用户选完知识库什么也拿不到，只看到一句「重新提取被拒绝」（2026-09-24 修，B3）。
      //    正确路径是「以知识库为基底**新建项目**」（终态下把既有内容带进项目的唯一路径）。
      //    引导层不直连 projectStore（架构闸门），因此把用户送到项目面板的那个按钮上。
      vaultMsg.value = `已选择知识库：${result.path}。`
        + '请点右下角「开始使用」，然后在项目面板点「新建并导入知识库内容」，把库里的词条带进来。';
      window.dispatchEvent(new Event('sitian:open-project-panel'));
      // 不自动 close()（旧实现会把这句提示一起关掉，用户根本来不及看）；跳到末步便于一键结束
      currentStep.value = steps.length - 1;
    } else if (result?.error) {
      vaultError.value = true;
      vaultMsg.value = result.error;
    } else {
      vaultError.value = true;
      vaultMsg.value = '未选择知识库目录';
    }
  } catch (e) {
    vaultError.value = true;
    vaultMsg.value = '选择知识库失败：' + e.message;
  }
}

const steps = [
  { title: '先建一个项目', desc: '司天把你的编辑保存在项目文件（.sitian）里；没有项目时是只读浏览模式 —— 在「项目」面板新建或打开项目即可开始编辑' },
  { title: '浏览世界观', desc: '从世界卡片开始，逐级探索星域、星系总览和单系地图' },
  { title: '下钻行星与区域', desc: '单系地图点击行星进入行星地图，再点击聚落进入区域地图与建筑内部' },
  { title: '查看与编辑', desc: '点击节点查看百科式详情，进入编辑模式拖拽坐标、添加天体' },
  { title: '太空实体', desc: '在单系地图编辑模式下，右键添加太空标记和部队卡片（信息提示）' },
  { title: '随时求助', desc: '按 F1 或 Ctrl+? 查看帮助与快捷键' },
];

function open() {
  // 免责声明阻断期间不要抢屏：两层浮层同屏 = 声明被盖住 = 「没读过就进去了」。
  // App.vue 在用户同意后会清掉该标记并主动调一次 open() 补上引导。
  if (typeof window !== 'undefined' && window.__sitianDisclaimerGate) return;
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
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  padding: 24px;
}

.onboarding-header {
  text-align: center;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--separator);
}

.onboarding-header h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.onboarding-header p {
  font-size: 12px;
  color: var(--text-tertiary);
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
  border: 1px solid var(--separator);
  background: var(--btn-bg);
  transition: all 0.2s ease;
  opacity: 0.6;
}

.step-item.active {
  opacity: 1;
  border-color: var(--accent);
  background: var(--accent-bg);
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
  background: var(--btn-bg);
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.step-item.active .step-number {
  background: var(--accent);
  color: var(--panel-bg);
}

.step-item.completed .step-number {
  background: #238636;
  color: #f0f6fc;
}

.step-content h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 2px;
}

.step-content p {
  font-size: 11px;
  color: var(--text-tertiary);
  margin: 0;
}

.onboarding-vault {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 20px;
  padding: 12px;
  border-radius: 8px;
  border: 1px dashed var(--accent);
  background: var(--accent-bg);
}

.btn-vault {
  padding: 10px 16px;
  background: var(--accent);
  border: none;
  border-radius: var(--radius-md);
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: opacity 0.2s ease;
}

.btn-vault:hover {
  opacity: 0.9;
}

.vault-msg {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.vault-msg.error {
  color: #f85149;
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
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 12px;
}

.btn-secondary:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}
</style>
