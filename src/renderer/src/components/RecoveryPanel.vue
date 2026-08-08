<template>
  <div v-if="showRecovery" class="recovery-overlay">
    <div class="recovery-panel">
      <div class="recovery-icon">⚠️</div>
      <h3>检测到未保存的编辑</h3>
      <p class="recovery-desc">
        上次使用时检测到未保存的地图编辑数据，可能是异常退出导致。
      </p>
      <div class="recovery-info">
        <div class="info-item">
          <span class="info-label">备份时间</span>
          <span class="info-value">{{ backupTime }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">备份大小</span>
          <span class="info-value">{{ backupSize }}</span>
        </div>
      </div>
      <div class="recovery-actions">
        <button class="btn-discard" @click="discardBackup">丢弃备份</button>
        <button class="btn-recover" @click="recoverData">恢复数据</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';

const store = useGeodataStore();
const showRecovery = ref(false);
const backupTime = ref('');
const backupSize = ref('');

let backupInterval = null;
const BACKUP_KEY = 'sitian-session-backup';
const CLEAN_SHUTDOWN_KEY = 'sitian-clean-shutdown';

function checkForRecovery() {
  // 检查是否是正常关闭
  const cleanShutdown = localStorage.getItem(CLEAN_SHUTDOWN_KEY);
  
  if (cleanShutdown !== 'true') {
    // 异常退出，检查是否有备份
    const backup = localStorage.getItem(BACKUP_KEY);
    if (backup) {
      try {
        const data = JSON.parse(backup);
        if (data.mapData && Object.keys(data.mapData).length > 0) {
          showRecovery.value = true;
          backupTime.value = new Date(data.timestamp).toLocaleString('zh-CN');
          backupSize.value = formatBytes(new Blob([backup]).size);
        }
      } catch (e) {
        console.warn('Failed to parse backup:', e);
        localStorage.removeItem(BACKUP_KEY);
      }
    }
  }
  
  // 重置标记
  localStorage.setItem(CLEAN_SHUTDOWN_KEY, 'false');
}

function startPeriodicBackup() {
  backupInterval = setInterval(() => {
    saveBackup();
  }, 30000); // 每30秒备份一次
}

function saveBackup() {
  const mapData = store.mapData;
  if (!mapData || Object.keys(mapData).length === 0) return;
  
  const backup = {
    timestamp: Date.now(),
    mapData,
  };
  
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
  } catch (e) {
    console.warn('Failed to save backup:', e);
  }
}

function recoverData() {
  const backup = localStorage.getItem(BACKUP_KEY);
  if (!backup) {
    showRecovery.value = false;
    return;
  }
  
  try {
    const data = JSON.parse(backup);
    if (data.mapData) {
      // 合并备份数据到 store
      for (const [planetId, mapData] of Object.entries(data.mapData)) {
        store.mapData[planetId] = mapData;
      }
    }
    localStorage.removeItem(BACKUP_KEY);
    showRecovery.value = false;
    alert('✅ 数据已恢复！');
  } catch (e) {
    console.error('Failed to recover:', e);
    alert('恢复失败: ' + e.message);
  }
}

function discardBackup() {
  localStorage.removeItem(BACKUP_KEY);
  showRecovery.value = false;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function handleBeforeUnload() {
  // 正常关闭时设置标记
  localStorage.setItem(CLEAN_SHUTDOWN_KEY, 'true');
  saveBackup();
}

onMounted(() => {
  checkForRecovery();
  startPeriodicBackup();
  window.addEventListener('beforeunload', handleBeforeUnload);
});

onUnmounted(() => {
  if (backupInterval) clearInterval(backupInterval);
  window.removeEventListener('beforeunload', handleBeforeUnload);
});
</script>

<style scoped>
.recovery-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  backdrop-filter: blur(4px);
}

.recovery-panel {
  width: 400px;
  background: #0d1117;
  border: 1px solid #f85149;
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  padding: 28px;
  text-align: center;
}

.recovery-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.recovery-panel h3 {
  font-size: 16px;
  font-weight: 600;
  color: #f0f6fc;
  margin: 0 0 8px;
}

.recovery-desc {
  font-size: 12px;
  color: #8b949e;
  line-height: 1.5;
  margin: 0 0 20px;
}

.recovery-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 24px;
  padding: 14px;
  background: #161b22;
  border-radius: 6px;
  border: 1px solid #30363d;
}

.info-item {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.info-label {
  color: #8b949e;
}

.info-value {
  color: #e2e8f0;
  font-weight: 500;
}

.recovery-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.btn-recover {
  padding: 10px 20px;
  background: #238636;
  border: 1px solid #2ea043;
  border-radius: 6px;
  color: #f0f6fc;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}

.btn-recover:hover {
  background: #2ea043;
}

.btn-discard {
  padding: 10px 20px;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #8b949e;
  cursor: pointer;
  font-size: 13px;
}

.btn-discard:hover {
  background: #30363d;
  color: #e2e8f0;
}
</style>
