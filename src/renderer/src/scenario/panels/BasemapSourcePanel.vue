<template>
  <!-- 从留底恢复底图面板（2026-11-06 从 ScenarioMap.vue 拆出）
       为什么拆：30 行模板 + 100 行样式只服务这一处；`ScenarioMap.vue` 已经 6,900+ 行。

       口径保持不变：这个面板**只读**（列清单 / 列原文），真正的写走父组件的
       `restoreFromSource` —— 那是与“导入 .map”同一条链，本组件不碰数据。
       `fmtBytes` / `fmtTime` 用父组件那一对（同一份格式化，别在这里再写一遍）。 -->
  <div v-if="open" class="bmsrc-panel" data-testid="basemap-source-panel">
    <div class="bmsrc-header">
      <span>从留底恢复底图</span>
      <button class="bmsrc-close" data-testid="basemap-source-close" title="关闭" @click="$emit('close')">×</button>
    </div>
    <div class="bmsrc-body">
      <div v-if="loading" class="bmsrc-hint">正在读取清单…</div>
      <div v-else-if="!files.length" class="bmsrc-hint" data-testid="basemap-source-empty">
        这里还没有留底的 .map —— 每次导入 .map 时，原文会自动留一份在项目备份目录里
      </div>
      <template v-else>
        <div class="bmsrc-hint">
          共 {{ files.length }} 份（导入 .map 时自动留底，最近 10 份）。
          恢复 = 拿它走一遍“导入 .map”：同名底图**只补缺**，你已切好的省份与归属不会被覆盖。
        </div>
        <div
          v-for="f in files"
          :key="f.name"
          class="bmsrc-row"
          :data-testid="'basemap-source-row-' + f.name"
        >
          <div class="bmsrc-meta">
            <span class="bmsrc-name" :title="f.path">{{ f.name }}</span>
            <span class="bmsrc-sub">{{ fmtBytes(f.bytes) }} · {{ fmtTime(f.mtime) }}</span>
          </div>
          <button class="bmsrc-use" :disabled="busy" @click="$emit('restore', f)">用这份恢复</button>
        </div>
      </template>
      <div v-if="dir" class="bmsrc-dir" :title="dir">{{ dir }}</div>
      <div v-if="msg" class="bmsrc-msg" data-testid="basemap-source-msg">{{ msg }}</div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  open: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  files: { type: Array, default: () => [] },
  dir: { type: String, default: '' },
  msg: { type: String, default: '' },
  fmtBytes: { type: Function, default: (n) => String(n) },
  fmtTime: { type: Function, default: (t) => String(t) },
});
defineEmits(['close', 'restore']);
</script>

<style scoped>
.bmsrc-panel {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 340px;
  max-height: 60%;
  display: flex;
  flex-direction: column;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 16px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.bmsrc-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
}

.bmsrc-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
  font-size: 14px;
  line-height: 1;
}

.bmsrc-close:hover { color: #e2e8f0; }

.bmsrc-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
}

.bmsrc-hint,
.bmsrc-msg {
  font-size: 11px;
  line-height: 1.5;
  color: #94a3b8;
}

.bmsrc-msg { color: #cbd5e1; }

.bmsrc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
}

.bmsrc-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.bmsrc-name {
  font-size: 12px;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bmsrc-sub {
  font-size: 10px;
  color: #94a3b8;
}

.bmsrc-use {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid #7c3aed;
  background: #5b21b6;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
}

.bmsrc-use:disabled { opacity: 0.5; cursor: default; }

.bmsrc-dir {
  font-size: 10px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
