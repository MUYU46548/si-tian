<template>
  <div v-if="visible" class="update-notification" :class="state">
    <div class="update-notification-backdrop" @click="dismiss"></div>
    <div class="update-notification-card">
      <!-- 发现新版本 -->
      <template v-if="state === 'available'">
        <div class="update-header">
          <span class="update-icon">🔄</span>
          <h3>发现新版本</h3>
        </div>
        <div class="update-body">
          <p class="update-version">
            <span class="current-version">v{{ currentVersion }}</span>
            <span class="arrow">→</span>
            <span class="new-version">v{{ newVersion }}</span>
          </p>
          <div v-if="releaseNotes" class="update-notes">
            <h4>更新说明</h4>
            <div class="notes-content">{{ releaseNotes }}</div>
          </div>
        </div>
        <div class="update-actions">
          <button class="btn-secondary" @click="dismiss">稍后更新</button>
          <button class="btn-primary" @click="startDownload">立即下载</button>
        </div>
      </template>

      <!-- 下载中 -->
      <template v-else-if="state === 'downloading'">
        <div class="update-header">
          <span class="update-icon spinning">⏳</span>
          <h3>正在下载更新</h3>
        </div>
        <div class="update-body">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: progress.percent + '%' }"></div>
          </div>
          <p class="progress-text">
            {{ formatPercent(progress.percent) }} · {{ formatSpeed(progress.bytesPerSecond) }}
          </p>
          <p class="progress-size">
            {{ formatSize(progress.transferred) }} / {{ formatSize(progress.total) }}
          </p>
        </div>
      </template>

      <!-- 下载完成 -->
      <template v-else-if="state === 'downloaded'">
        <div class="update-header">
          <span class="update-icon">✅</span>
          <h3>更新已就绪</h3>
        </div>
        <div class="update-body">
          <p>v{{ newVersion }} 已下载完成。退出应用后将自动安装。</p>
        </div>
        <div class="update-actions">
          <button class="btn-secondary" @click="dismiss">稍后安装</button>
          <button class="btn-primary" @click="installUpdate">退出并安装</button>
        </div>
      </template>

      <!-- 已是最新 -->
      <template v-else-if="state === 'up-to-date'">
        <div class="update-header">
          <span class="update-icon">✨</span>
          <h3>已是最新版本</h3>
        </div>
        <div class="update-body">
          <p>当前版本 v{{ currentVersion }} 为最新版本。</p>
        </div>
        <div class="update-actions">
          <button class="btn-primary" @click="dismiss">确定</button>
        </div>
      </template>

      <!-- 错误 -->
      <template v-else-if="state === 'error'">
        <div class="update-header">
          <span class="update-icon">⚠️</span>
          <h3>更新检查失败</h3>
        </div>
        <div class="update-body">
          <p class="error-text">{{ errorMessage }}</p>
          <p class="error-hint">请检查网络连接后重试，或访问 GitHub Release 手动下载。</p>
        </div>
        <div class="update-actions">
          <button class="btn-secondary" @click="dismiss">关闭</button>
          <button class="btn-primary" @click="retryCheck">重试</button>
        </div>
      </template>

      <!-- 检查中 -->
      <template v-else-if="state === 'checking'">
        <div class="update-header">
          <span class="update-icon spinning">🔍</span>
          <h3>正在检查更新...</h3>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue';

const visible = ref(false);
const state = ref(''); // available | downloading | downloaded | up-to-date | error | checking
const currentVersion = ref('');
const newVersion = ref('');
const releaseNotes = ref('');
const errorMessage = ref('');
const progress = reactive({
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
});

let cleanupFns = [];

function show() { visible.value = true; }
function dismiss() { visible.value = false; state.value = ''; }

function formatPercent(p) { return Math.round(p) + '%'; }
function formatSpeed(bps) {
  if (!bps) return '—';
  if (bps > 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
  if (bps > 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  return bps.toFixed(0) + ' B/s';
}
function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

async function checkForUpdates() {
  state.value = 'checking';
  show();
  try {
    await window.sitianAPI.checkForUpdates();
  } catch (e) {
    state.value = 'error';
    errorMessage.value = e.message || '检查更新失败';
  }
}

function startDownload() {
  state.value = 'downloading';
  window.sitianAPI.downloadUpdate();
}

function installUpdate() {
  window.sitianAPI.installUpdate();
}

function retryCheck() {
  checkForUpdates();
}

onMounted(() => {
  currentVersion.value = window.sitianAPI?.version || '0.1.0';

  // P0.4: 浏览器环境（无 Electron preload）无更新 API，跳过监听避免挂载报错
  if (!window.sitianAPI?.onUpdateAvailable) return;

  // 监听主进程推送的更新事件
  cleanupFns.push(
    window.sitianAPI.onUpdateAvailable((data) => {
      newVersion.value = data.version;
      releaseNotes.value = data.releaseNotes || '';
      state.value = 'available';
      show();
    })
  );

  cleanupFns.push(
    window.sitianAPI.onUpdateNotAvailable((data) => {
      currentVersion.value = data.version || currentVersion.value;
      state.value = 'up-to-date';
      show();
    })
  );

  cleanupFns.push(
    window.sitianAPI.onUpdateProgress((data) => {
      progress.percent = data.percent || 0;
      progress.bytesPerSecond = data.bytesPerSecond || 0;
      progress.transferred = data.transferred || 0;
      progress.total = data.total || 0;
    })
  );

  cleanupFns.push(
    window.sitianAPI.onUpdateDownloaded((data) => {
      newVersion.value = data.version || newVersion.value;
      state.value = 'downloaded';
      show();
    })
  );

  cleanupFns.push(
    window.sitianAPI.onUpdateError((data) => {
      errorMessage.value = data.message || '更新过程中发生错误';
      state.value = 'error';
      show();
    })
  );

  // 托盘菜单手动检查更新
  cleanupFns.push(
    window.sitianAPI.onUpdateCheckManual?.(() => {
      checkForUpdates();
    }) || (() => {})
  );
});

onUnmounted(() => {
  cleanupFns.forEach(fn => fn());
});

defineExpose({ checkForUpdates, show, dismiss });
</script>

<style scoped>
.update-notification {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.update-notification-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.update-notification-card {
  position: relative;
  background: var(--card-bg, #fff);
  color: var(--card-fg, #1a1a2e);
  border-radius: 16px;
  padding: 24px;
  min-width: 360px;
  max-width: 480px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border, rgba(0, 0, 0, 0.1));
}

.update-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.update-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.update-icon {
  font-size: 24px;
  line-height: 1;
}

.update-icon.spinning {
  animation: spin 2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.update-body {
  margin-bottom: 20px;
}

.update-version {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 16px;
  margin: 0 0 12px;
}

.current-version {
  color: var(--muted-foreground, #666);
  text-decoration: line-through;
}

.arrow {
  color: var(--accent, #9b8fc4);
  font-weight: 600;
}

.new-version {
  color: var(--accent, #9b8fc4);
  font-weight: 700;
  font-size: 18px;
}

.update-notes {
  margin-top: 12px;
}

.update-notes h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--muted-foreground, #666);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.notes-content {
  background: var(--code-bg, #f5f5f5);
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
}

.progress-bar {
  height: 8px;
  background: var(--code-bg, #eee);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 12px;
}

.progress-fill {
  height: 100%;
  background: var(--accent, #9b8fc4);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 14px;
  color: var(--muted-foreground, #666);
  margin: 0 0 4px;
}

.progress-size {
  font-size: 12px;
  color: var(--muted-foreground, #999);
  margin: 0;
}

.error-text {
  color: var(--error, #e74c3c);
  margin: 0 0 8px;
}

.error-hint {
  font-size: 13px;
  color: var(--muted-foreground, #666);
  margin: 0;
}

.update-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.btn-primary,
.btn-secondary {
  padding: 8px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--accent, #9b8fc4);
  color: #fff;
}

.btn-primary:hover {
  background: var(--accent-hover, #8a7eb3);
}

.btn-secondary {
  background: transparent;
  color: var(--muted-foreground, #666);
  border: 1px solid var(--border, #ddd);
}

.btn-secondary:hover {
  background: var(--code-bg, #f5f5f5);
}
</style>
