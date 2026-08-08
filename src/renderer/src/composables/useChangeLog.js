import { ref, computed, onMounted, onUnmounted } from 'vue';

/**
 * 变更日志面板
 * 显示编辑操作的历史记录
 */
const CHANGE_LOG_KEY = 'sitian-change-log';
const MAX_LOG_ENTRIES = 100;

export function useChangeLog() {
  const logs = ref([]);
  const panelVisible = ref(false);

  function load() {
    try {
      const data = localStorage.getItem(CHANGE_LOG_KEY);
      if (data) {
        logs.value = JSON.parse(data);
      }
    } catch (e) {
      console.error('[ChangeLog] 加载失败:', e);
      logs.value = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(CHANGE_LOG_KEY, JSON.stringify(logs.value));
    } catch (e) {
      console.error('[ChangeLog] 保存失败:', e);
    }
  }

  function addLog(entry) {
    logs.value.unshift({
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      timestamp: Date.now(),
      ...entry,
    });
    if (logs.value.length > MAX_LOG_ENTRIES) {
      logs.value.pop();
    }
    save();
  }

  function clearLog() {
    logs.value = [];
    save();
  }

  function togglePanel() {
    panelVisible.value = !panelVisible.value;
  }

  function formatTime(timestamp) {
    const d = new Date(timestamp);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  load();

  return {
    logs,
    panelVisible,
    addLog,
    clearLog,
    togglePanel,
    formatTime,
  };
}
