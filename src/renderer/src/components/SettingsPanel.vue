<template>
  <div v-if="isOpen" class="settings-overlay" @click.self="close">
    <div class="settings-panel">
      <div class="settings-header">
        <h2>⚙️ 设置</h2>
        <button class="close-btn" @click="close">×</button>
      </div>

      <div class="settings-content">
        <!-- 通用设置 -->
        <section class="settings-section">
          <h3>通用</h3>
          
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">自动保存</span>
              <span class="setting-desc">编辑后自动保存到 JSON 缓存</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.autoSave" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">边缘吸附</span>
              <span class="setting-desc">绘制省份时自动贴合相邻边界</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.snapEnabled" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">显示编辑辅助线</span>
              <span class="setting-desc">在编辑模式下显示控制点和预览</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.showEditHelpers" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">关闭时退出应用</span>
              <span class="setting-desc">关闭窗口直接退出程序（默认关闭窗口仅最小化到托盘，右键托盘可退出）</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="closeQuitsApp" @change="onCloseQuitsAppChange" />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </section>

        <!-- 视图设置 -->
        <section class="settings-section">
          <h3>视图</h3>
          
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">动画效果</span>
              <span class="setting-desc">启用画布动画（可能影响性能）</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.animateCanvas" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">显示 FPS</span>
              <span class="setting-desc">在画布角落显示帧率统计</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.showFPS" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">纹理填充</span>
              <span class="setting-desc">省份使用纹理而非纯色填充</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.useTextures" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-item" v-if="windowMode !== null">
            <div class="setting-info">
              <span class="setting-name">启动窗口</span>
              <span class="setting-desc">应用启动时的窗口模式（立即生效并记忆）</span>
            </div>
            <select class="setting-input window-mode-select" v-model="windowMode" @change="onWindowModeChange">
              <option value="maximized">最大化</option>
              <option value="fullscreen">全屏</option>
              <option value="default">默认 1600×900</option>
            </select>
          </div>
        </section>

        <!-- 数据设置 -->
        <section class="settings-section">
          <h3>数据</h3>
          
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">Vault 监听</span>
              <span class="setting-desc">监听 Obsidian 文件变更自动刷新</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.vaultWatcher" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">自动保存延迟</span>
              <span class="setting-desc">编辑后等待多久自动保存（毫秒）</span>
            </div>
            <input 
              type="number" 
              class="setting-input" 
              v-model.number="settings.autoSaveDelay" 
              @change="saveSettings"
              min="200" 
              max="5000" 
              step="100"
            />
          </div>
        </section>

        <!-- 快捷键参考 -->
        <section class="settings-section">
          <h3>快捷键参考</h3>
          <div class="shortcuts-list">
            <div class="shortcut-row">
              <kbd>Ctrl</kbd>+<kbd>Z</kbd>
              <span>撤销</span>
            </div>
            <div class="shortcut-row">
              <kbd>Ctrl</kbd>+<kbd>Y</kbd>
              <span>重做</span>
            </div>
            <div class="shortcut-row">
              <kbd>Ctrl</kbd>+<kbd>F</kbd>
              <span>搜索</span>
            </div>
            <div class="shortcut-row">
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>
              <span>搜索过滤</span>
            </div>
            <div class="shortcut-row">
              <kbd>F1</kbd>
              <span>帮助</span>
            </div>
            <div class="shortcut-row">
              <kbd>L</kbd>
              <span>图层面板</span>
            </div>
            <div class="shortcut-row">
              <kbd>Del</kbd>
              <span>删除选中</span>
            </div>
            <div class="shortcut-row">
              <kbd>Esc</kbd>
              <span>取消/关闭</span>
            </div>
            <div class="shortcut-row">
              <kbd>空格</kbd>
              <span>临时拖手</span>
            </div>
            <div class="shortcut-row">
              <kbd>/</kbd>
              <span>聚焦搜索</span>
            </div>
          </div>
        </section>

        <!-- 数据管理 -->
        <section class="settings-section">
          <h3>数据管理</h3>
          <!-- 知识库路径（2026-08-16 可配置化） -->
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">知识库路径</span>
              <span class="setting-desc">Obsidian 库根目录（需包含 .obsidian 文件夹），更改后自动重新提取</span>
            </div>
            <div class="vault-path-row">
              <span class="vault-path-text" :title="vaultPath">{{ vaultPath || '未设置（使用默认库）' }}</span>
              <button class="vault-btn" @click="chooseVaultPath" title="选择知识库目录">📂 选择</button>
            </div>
          </div>
          <div class="data-actions">
            <button class="data-btn" @click="reextractData">
              🔄 重新提取数据
            </button>
            <button class="data-btn" @click="validateData">
              🔍 数据完整性检查
            </button>
            <button class="data-btn" @click="backupCache" title="将 .sitian/ 缓存备份到 backups/（带时间戳，保留最近 10 批）">
              📦 立即备份
            </button>
            <button class="data-btn" @click="openBatchImport" title="批量创建笔记（只创建不修改，已存在自动跳过）">
              📥 批量导入
            </button>
            <button class="data-btn danger" @click="clearCache">
              🗑 清除坐标缓存
            </button>
          </div>
        </section>
      </div>

      <div class="settings-footer">
        <span>设置自动保存到本地</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const isOpen = ref(false);

// 窗口启动模式（批次A7）：null = 当前环境无 sitianAPI（纯浏览器 dev），隐藏该选项
const windowMode = ref(null);
// 关闭行为（批次A12）：点 × 直接退出应用
const closeQuitsApp = ref(false);

const settings = ref({
  autoSave: true,
  snapEnabled: true,
  showEditHelpers: true,
  animateCanvas: true,
  showFPS: false,
  useTextures: true,
  vaultWatcher: true,
  autoSaveDelay: 800,
});

function open() {
  isOpen.value = true;
  loadSettings();
  loadWindowMode();
  loadCloseQuitsApp();
}

function close() {
  isOpen.value = false;
}

function loadSettings() {
  try {
    const saved = localStorage.getItem('sitian-settings');
    if (saved) {
      Object.assign(settings.value, JSON.parse(saved));
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
}

function saveSettings() {
  try {
    localStorage.setItem('sitian-settings', JSON.stringify(settings.value));
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
}

async function loadWindowMode() {
  try {
    windowMode.value = await window.sitianAPI.getWindowMode();
  } catch (e) {
    windowMode.value = null;
  }
}

async function onWindowModeChange() {
  try {
    await window.sitianAPI.setWindowMode(windowMode.value);
  } catch (e) {
    console.warn('Failed to set window mode:', e);
  }
}

// 关闭行为（批次A12）：读取 / 切换「点 × 直接退出应用」
async function loadCloseQuitsApp() {
  try {
    closeQuitsApp.value = await window.sitianAPI.getCloseQuitsApp();
  } catch (e) {
    closeQuitsApp.value = false;
  }
}

async function onCloseQuitsAppChange() {
  try {
    await window.sitianAPI.setCloseQuitsApp(closeQuitsApp.value);
  } catch (e) {
    console.warn('Failed to set close-quits-app:', e);
  }
}

function reextractData() {
  window.dispatchEvent(new CustomEvent('sitian:reextract'));
}

// ===== 知识库路径（2026-08-16 可配置化） =====
const vaultPath = ref('');

async function loadVaultPath() {
  try {
    const res = await window.sitianAPI.getVaultPath();
    if (typeof res === 'string') vaultPath.value = res;
  } catch (e) { /* 浏览器环境忽略 */ }
}

async function chooseVaultPath() {
  try {
    const result = await window.sitianAPI.selectVaultPath();
    if (result?.success) {
      vaultPath.value = result.path;
      // 库路径已变更 → 重新提取数据
      window.dispatchEvent(new CustomEvent('sitian:reextract'));
      setTimeout(() => alert('知识库路径已更新，数据已重新提取'), 300);
    } else if (result?.error) {
      alert(result.error);
    }
  } catch (e) {
    alert('选择知识库失败：' + e.message);
  }
}

function validateData() {
  window.dispatchEvent(new CustomEvent('sitian:validate-data'));
}

function backupCache() {
  window.dispatchEvent(new CustomEvent('sitian:backup-cache'));
}

function openBatchImport() {
  window.dispatchEvent(new CustomEvent('sitian:open-batch-import'));
}

function clearCache() {
  if (confirm('确定要清除坐标缓存吗？下次启动将自动从 Obsidian 重新提取。')) {
    window.dispatchEvent(new CustomEvent('sitian:clear-cache'));
  }
}

onMounted(() => {
  loadSettings();
  loadVaultPath();
});

defineExpose({ open, close });
</script>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.settings-panel {
  width: 480px;
  max-height: 80vh;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid var(--panel-border);
  background: var(--panel-header-bg);
}

.settings-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

.settings-section {
  margin-bottom: 20px;
}

.settings-section h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--separator);
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--separator);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.setting-name {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 500;
}

.setting-desc {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* Toggle Switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  margin-left: 12px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--btn-bg-hover);
  border-radius: var(--radius-lg);
  transition: 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: var(--text-tertiary);
  border-radius: 50%;
  transition: 0.2s;
}

input:checked + .toggle-slider {
  background: #238636;
}

input:checked + .toggle-slider::before {
  transform: translateX(16px);
  background: var(--text-primary);
}

.setting-input {
  width: 80px;
  padding: 4px 8px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  text-align: center;
}

.setting-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* 窗口模式下拉（批次A7）：选项文案较长，放宽并左对齐 */
.window-mode-select {
  width: 130px;
  text-align: left;
  cursor: pointer;
}

.shortcuts-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}

.shortcut-row kbd {
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  padding: 2px 5px;
  border-radius: 3px;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  color: var(--text-primary);
}

.data-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 知识库路径（2026-08-16 可配置化） */
.vault-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.vault-path-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-tertiary);
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}
.vault-btn {
  padding: 6px 12px;
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.vault-btn:hover {
  background: var(--btn-bg-hover);
}

.data-btn {
  padding: 10px 14px;
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: background 0.1s ease;
}

.data-btn:hover {
  background: var(--btn-bg-hover);
}

.data-btn.danger {
  border-color: #f8514944;
}

.data-btn.danger:hover {
  background: #f8514922;
  border-color: #f85149;
}

.settings-footer {
  padding: 12px 24px;
  border-top: 1px solid var(--separator);
  text-align: center;
}

.settings-footer span {
  font-size: 10px;
  color: var(--text-tertiary);
}

.close-btn {
  background: var(--btn-bg);
  border: none;
  color: var(--text-tertiary);
  font-size: 18px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: var(--radius-md);
}

.close-btn:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}
</style>
