<template>
  <div v-if="dlg.state.open" class="prompt-overlay" @click.self="dlg.cancel()">
    <div class="prompt-dialog">
      <h3 class="prompt-title">{{ dlg.state.title }}</h3>
      <p v-if="dlg.state.label" class="prompt-label">{{ dlg.state.label }}</p>

      <!-- 选项模式：点选即提交 -->
      <div v-if="dlg.state.mode === 'choice'" class="prompt-choices">
        <button
          v-for="opt in dlg.state.options"
          :key="opt.key"
          class="prompt-choice"
          @click="dlg.choose(opt)"
        >{{ opt.icon ? opt.icon + ' ' : '' }}{{ opt.label }}</button>
      </div>

      <!-- 文本模式：Enter 提交 / Esc 取消 -->
      <template v-else>
        <input
          ref="inputEl"
          v-model="dlg.state.value"
          class="prompt-input"
          type="text"
          :placeholder="dlg.state.placeholder"
          @keydown.enter="dlg.submitText()"
          @keydown.esc="dlg.cancel()"
        />
        <div class="prompt-actions">
          <button class="prompt-btn primary" @click="dlg.submitText()">确定</button>
          <button class="prompt-btn" @click="dlg.cancel()">取消</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import { usePromptDialog } from '../composables/usePromptDialog';

const dlg = usePromptDialog();
const inputEl = ref(null);

watch(() => dlg.state.open, async (open) => {
  if (open && dlg.state.mode === 'text') {
    await nextTick();
    inputEl.value?.focus();
    inputEl.value?.select();
  }
});
</script>

<style scoped>
.prompt-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
}

.prompt-dialog {
  width: min(340px, calc(100vw - 48px));
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md, 10px);
  padding: 18px 20px 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}

.prompt-title {
  margin: 0 0 6px;
  font-size: 15px;
  color: var(--text-primary);
}

.prompt-label {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.prompt-choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.prompt-choice {
  padding: 9px 12px;
  text-align: left;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}

.prompt-choice:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-bg);
}

.prompt-input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 8px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-secondary, var(--btn-bg));
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  outline: none;
}

.prompt-input:focus {
  border-color: var(--accent);
}

.prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.prompt-btn {
  padding: 6px 16px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.prompt-btn:hover {
  color: var(--text-primary);
  background: var(--btn-bg-hover);
}

.prompt-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.prompt-btn.primary:hover {
  filter: brightness(1.1);
  color: #fff;
}
</style>
