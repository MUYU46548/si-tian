<template>
  <div class="batch-import-overlay" v-if="isOpen" @mousedown.self="close">
    <div class="batch-import-panel">
      <div class="panel-header">
        <h3>📥 批量导入笔记</h3>
        <button class="close-btn" @click="close" title="关闭">×</button>
      </div>
      <div class="panel-body">
        <p class="hint">
          纯创建式导入：<strong>只创建不修改</strong> —— 同名笔记已存在时自动跳过，绝不覆盖已有内容。
        </p>

        <div class="form-row">
          <label>世界</label>
          <select v-model="worldName">
            <option value="">（未分类）</option>
            <option v-for="w in worlds" :key="w.id" :value="w.name">{{ w.name }}</option>
          </select>
        </div>

        <div class="form-row">
          <label>层级</label>
          <select v-model="layer">
            <option value="location">地点</option>
            <option value="city">城市</option>
            <option value="town">城镇</option>
            <option value="village">村庄</option>
            <option value="facility">设施</option>
            <option value="region">区域</option>
            <option value="star_domain">星域</option>
            <option value="galaxy">星系</option>
            <option value="planet">行星</option>
          </select>
        </div>

        <div class="form-row">
          <label>上层区域</label>
          <input v-model="parentName" placeholder="可选，如：乐园星（写入 frontmatter 上层区域）" />
        </div>

        <div class="form-row textarea-row">
          <label>笔记名</label>
          <textarea
            v-model="namesText"
            rows="8"
            placeholder="每行一个笔记名，如：&#10;风神城&#10;风神大社&#10;复仇神殿"
          ></textarea>
        </div>

        <div v-if="formError" class="result-box error">
          <p>✗ {{ formError }}</p>
        </div>

        <div v-if="result" class="result-box" :class="{ error: result.failed }">
          <template v-if="result.failed">
            <p>✗ 导入失败：{{ result.error }}</p>
          </template>
          <template v-else>
            <p>✓ 创建 {{ result.created.length }} 个 / 跳过 {{ result.skipped.length }} 个（已存在）/ 失败 {{ result.errors.length }} 个</p>
            <p class="result-path">目标目录：{{ result.targetDir }}</p>
            <p v-if="result.skipped.length" class="result-detail">跳过：{{ result.skipped.map(s => s.name).join('、') }}</p>
            <p v-if="result.errors.length" class="result-detail error-text">失败：{{ result.errors.map(e => `${e.name}(${e.reason})`).join('、') }}</p>
          </template>
        </div>

        <p class="import-tip">导入后需在设置面板执行「🔄 重新提取数据」，新节点才会出现在地图中。</p>
      </div>
      <div class="panel-footer">
        <button class="btn-secondary" @click="close">取消</button>
        <button class="btn-primary" @click="runImport" :disabled="importing">
          {{ importing ? '导入中...' : '开始导入' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useGeodataStore } from '../store/geodata';

const store = useGeodataStore();
const isOpen = ref(false);
const importing = ref(false);
const worldName = ref('');
const layer = ref('location');
const parentName = ref('');
const namesText = ref('');
const result = ref(null);
const formError = ref('');

const worlds = computed(() => store.worlds || []);

function open() {
  isOpen.value = true;
  // 重置表单（保留上次世界/层级选择减少重复输入）
  namesText.value = '';
  parentName.value = '';
  result.value = null;
  formError.value = '';
}

function close() {
  isOpen.value = false;
}

async function runImport() {
  const names = namesText.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (names.length === 0) {
    // 内联提示（不用 alert——阻塞式弹窗在自动化测试环境会挂起主线程）
    formError.value = '请至少输入一个笔记名';
    return;
  }
  formError.value = '';
  importing.value = true;
  result.value = null;
  try {
    const res = await window.sitianAPI.batchImportNotes({
      worldName: worldName.value,
      layer: layer.value,
      parentName: parentName.value.trim(),
      names,
    });
    result.value = res?.success
      ? res
      : { failed: true, error: res?.error || '未知错误' };
  } catch (e) {
    result.value = { failed: true, error: e.message };
  } finally {
    importing.value = false;
  }
}

defineExpose({ open, close });
</script>

<style scoped>
.batch-import-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}
.batch-import-panel {
  width: 560px;
  max-width: 92vw;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg, #1b2130);
  border: 1px solid var(--panel-border, #2c3547);
  border-radius: var(--radius-lg, 10px);
  box-shadow: var(--shadow-lg, 0 12px 40px rgba(0, 0, 0, 0.4));
  overflow: hidden;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--panel-border, #2c3547);
  cursor: move;
}
.panel-header h3 { margin: 0; font-size: 15px; }
.close-btn {
  background: none; border: none; color: var(--text-dim, #8b94a7);
  font-size: 18px; cursor: pointer; padding: 2px 8px; border-radius: 4px;
}
.close-btn:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.panel-body {
  padding: 14px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hint {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--text-dim, #8b94a7);
  line-height: 1.6;
}
.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.form-row label {
  width: 76px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-dim, #aab3c5);
}
.form-row select, .form-row input {
  flex: 1;
  padding: 6px 10px;
  background: var(--input-bg, #121826);
  border: 1px solid var(--panel-border, #2c3547);
  border-radius: 6px;
  color: var(--text-main, #e2e8f0);
  font-size: 13px;
}
.textarea-row { align-items: flex-start; }
.textarea-row textarea {
  flex: 1;
  padding: 8px 10px;
  background: var(--input-bg, #121826);
  border: 1px solid var(--panel-border, #2c3547);
  border-radius: 6px;
  color: var(--text-main, #e2e8f0);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  font-family: inherit;
}
.result-box {
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(46, 160, 67, 0.1);
  border: 1px solid rgba(46, 160, 67, 0.3);
  font-size: 13px;
  color: #7ee2a8;
}
.result-box.error {
  background: rgba(248, 81, 73, 0.1);
  border-color: rgba(248, 81, 73, 0.3);
  color: #ffa198;
}
.result-box p { margin: 2px 0; }
.result-path { font-size: 12px; opacity: 0.8; word-break: break-all; }
.result-detail { font-size: 12px; opacity: 0.8; }
.error-text { color: #ffa198; }
.import-tip {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim, #8b94a7);
}
.panel-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--panel-border, #2c3547);
}
.btn-secondary, .btn-primary {
  padding: 7px 16px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--panel-border, #2c3547);
}
.btn-secondary { background: transparent; color: var(--text-dim, #aab3c5); }
.btn-secondary:hover { background: rgba(255, 255, 255, 0.06); }
.btn-primary {
  background: #3b82f6;
  color: #fff;
  border-color: #3b82f6;
}
.btn-primary:hover { background: #2f6fe0; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
