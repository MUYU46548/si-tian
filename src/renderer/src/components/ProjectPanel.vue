<template>
  <PanelShell
    class="project-panel"
    title="项目"
    :collapsible="true"
    :stop-mouse-down="true"
    @close="$emit('close')"
  >
    <template #title><Icon name="folder-open" :size="15" style="margin-right:6px" />项目</template>
    <template #actions>
      <button class="mini-btn" title="刷新目录中的项目列表" @click="refresh"><Icon name="refresh" :size="13" /></button>
    </template>

    <div class="pp-body">
      <!-- 当前状态 -->
      <div class="pp-status" :class="proj.isOpen ? 'ok' : (isReadOnly ? 'readonly' : 'none')">
        <div class="pp-status-name">{{ proj.isOpen ? proj.meta.name : '未打开项目' }}</div>
        <div class="pp-status-sub">{{ statusLine }}</div>
      </div>

      <!-- 新建项目 -->
      <div class="pp-section">
        <div class="pp-label">新建项目</div>
        <div class="pp-row">
          <input
            v-model="newName"
            class="pp-input"
            placeholder="项目名称（如 ROSA世界）"
            @keydown.enter="doCreate"
          />
          <button class="pp-btn primary" :disabled="!canCreate" @click="doCreate">新建</button>
        </div>
        <div class="pp-hint">
          目录：<span class="pp-path" :title="proj.projectDir">{{ proj.projectDir || '（默认：我的文档 / SiTianProjects）' }}</span>
          <button class="link-btn" @click="pickDir">更改…</button>
        </div>
      </div>

      <!-- 打开 / 当前项目操作 -->
      <div class="pp-section">
        <div class="pp-label">项目操作</div>
        <div class="pp-row wrap">
          <button class="pp-btn" @click="openExisting">打开项目…</button>
          <template v-if="proj.isOpen">
            <button class="pp-btn" :disabled="proj.saveStatus === 'saving'" @click="doSave">保存</button>
            <button class="pp-btn" @click="doBackup">备份</button>
            <button class="pp-btn" @click="doReveal">定位文件</button>
            <button class="pp-btn danger" @click="doClose">关闭</button>
          </template>
        </div>
        <div v-if="proj.isOpen" class="pp-hint pp-file">
          文件：<span class="pp-path" :title="proj.filePath">{{ proj.filePath }}</span>
        </div>
        <div v-if="tip" class="pp-tip" :class="tipKind">{{ tip }}</div>
      </div>

      <!-- 目录中的项目 -->
      <div class="pp-section">
        <div class="pp-label">
          目录中的项目（{{ proj.availableProjects.length }}）
        </div>
        <div v-if="!proj.availableProjects.length" class="pp-empty">
          这个目录里还没有 .sitian 项目文件
        </div>
        <div
          v-for="it in proj.availableProjects"
          :key="it.filePath"
          class="pp-item"
          :class="{ active: it.filePath === proj.filePath }"
          :title="it.filePath"
          @click="openAt(it)"
        >
          <div class="pp-item-main">
            <div class="pp-item-name">{{ (it.meta && it.meta.name) || it.name }}</div>
            <div class="pp-item-sub">
              {{ it.entityCount || 0 }} 实体<span v-if="it.mtime"> · {{ fmtTime(it.mtime) }}</span>
            </div>
          </div>
          <span v-if="it.error" class="pp-warn" title="文件读取失败（可能是损坏的 JSON）">!</span>
        </div>
      </div>

      <!-- 实体浏览器 -->
      <div class="pp-section">
        <div class="pp-label">
          实体（{{ proj.entityCount }}）
          <button class="link-btn" :disabled="!proj.isOpen" :title="proj.isOpen ? '' : '先新建或打开项目'" @click="creatorOpen = true">+ 新建实体</button>
        </div>
        <div v-if="!proj.isOpen" class="pp-empty">打开项目后可在这里浏览实体树</div>
        <div v-else-if="!proj.entityCount" class="pp-empty">还没有实体。点「+ 新建实体」开始。</div>
        <template v-else>
          <div
            v-if="draggingId"
            class="pp-drop-root"
            @dragover.prevent="dropTargetId = ''"
            @drop.prevent="onDropRoot"
          >松开以移到顶层</div>
          <div class="pp-tree">
            <div
              v-for="row in flatTree"
              :key="row.id"
              class="pp-node-row"
              :class="{
                sel: selectedId === row.id,
                drop: dropTargetId === row.id,
                dragging: draggingId === row.id,
                forbid: !!draggingId && !canDropInto(row.id),
              }"
              :style="{ paddingLeft: (8 + row.depth * 14) + 'px' }"
              :draggable="editingId !== row.id"
              title="拖动到别的行可改父级；双击名称可改名"
              @click="select(row)"
              @dragstart="onDragStart(row, $event)"
              @dragover.prevent="onDragOver(row)"
              @dragleave="onDragLeave(row)"
              @drop.prevent="onDrop(row)"
              @dragend="onDragEnd"
            >
              <span class="pp-badge">{{ row.layerLabel }}</span>
              <input
                v-if="editingId === row.id"
                :ref="el => { if (el) renameInputEl = el; }"
                v-model="editName"
                class="pp-rename"
                @keydown.enter="commitRename"
                @keydown.esc="cancelRename"
                @blur="commitRename"
                @click.stop
              />
              <span v-else class="pp-node-name" @dblclick.stop="startRename(row)">{{ row.name }}</span>
              <span v-if="editingId !== row.id" class="pp-row-actions">
                <button class="icon-btn" title="改名" @click.stop="startRename(row)"><Icon name="pencil" :size="12" /></button>
                <button class="icon-btn" title="删除（含子实体）" @click.stop="askDelete(row)"><Icon name="trash" :size="12" /></button>
              </span>
            </div>
          </div>
          <div v-if="pendingDelete" class="pp-confirm">
            <span class="pp-confirm-text">
              删除「{{ pendingDelete.name }}」{{ pendingDelete.kids ? `及其 ${pendingDelete.kids} 个子实体` : '' }}？
            </span>
            <button class="pp-btn danger" @click="confirmDelete">删除</button>
            <button class="pp-btn" @click="pendingDelete = null">取消</button>
          </div>
        </template>
        <div v-if="selectedEntity" class="pp-detail">
          <div><span class="pp-k">id</span>{{ selectedEntity.id }}</div>
          <div><span class="pp-k">层级</span>{{ selectedEntity.layerLabel }}（{{ selectedEntity.layer }}）</div>
          <div class="pp-parent-row">
            <span class="pp-k">父级</span>
            <select class="pp-parent" :value="selectedEntity.parentId || ''" @change="onParentChange($event)">
              <option value="">（顶层）</option>
              <option v-for="e in parentOptionsForSelected" :key="e.id" :value="e.id">{{ e.name }}（{{ e.layerLabel }}）</option>
            </select>
          </div>
          <div><span class="pp-k">标签</span>{{ selectedEntity.tags.length ? selectedEntity.tags.join('、') : '—' }}</div>
          <div><span class="pp-k">坐标</span>{{ coordText(selectedEntity) }}</div>
        </div>
      </div>

      <!-- 快照 -->
      <div v-if="proj.isOpen" class="pp-section">
        <div class="pp-label">快照（最近 50 份，保存时自动生成）</div>
        <div v-if="!proj.snapshots.length" class="pp-empty">还没有快照：保存一次即可生成第一份</div>
        <div v-for="s in recentSnapshots" :key="s.index" class="pp-item">
          <div class="pp-item-main">
            <div class="pp-item-name">{{ s.label || ('快照 ' + (s.index + 1)) }}</div>
            <div class="pp-item-sub">{{ fmtTime(s.at) }} · {{ s.changes }} 处改动</div>
          </div>
          <button class="link-btn" title="回滚到这份快照（可撤销）" @click="doRestore(s)">恢复</button>
        </div>
      </div>
    </div>

    <EntityCreator v-if="creatorOpen" :open="creatorOpen" @close="creatorOpen = false" @goto="onGoto" />
  </PanelShell>
</template>

<script setup>
// components/ProjectPanel.vue — 项目面板（Phase 2.1）
//
// 职责：`.sitian` 项目的日常操作面（新建 / 打开 / 保存 / 备份 / 关闭 / 列表）+ 实体浏览器 + 快照回滚。
// 数据全部来自 `store/projectStore.js`，本组件不直接碰 IPC / 文件系统。
//
// ⚠️ 阶段说明（2026-09-18）：Phase 2.4「接线」尚未落地 —— 打开项目只会切换写模式，
//    七层视图仍读 Obsidian 缓存。所以本面板的实体树只反映**项目文件里的实体**，
//    与当前画布内容暂时是两套。接线后二者合一。

import { computed, nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';
import PanelShell from './PanelShell.vue';
import EntityCreator from './EntityCreator.vue';
import { useProjectStore } from '../store/projectStore';
import { isReadOnly as gateReadOnly, writeMode as gateWriteMode } from '../store/writeGate';

// ⚠️ 挂载语义：本面板由 App.vue 用 `v-if="panelsStore.isOpen('project')"` 控制**挂载**，
//    所以**不要**再传 `open` —— PanelShell 的 `open` 默认 true，传了反而会因父级未传值而默认 false
//    导致整个面板不渲染（实测坑：App.vue 只挂载不传 open → PanelShell 根节点 v-if 恒假、静默空白）。
//    `title` 是 PanelShell 的必填 prop（不传会有 Vue 警告），图标用 title 具名插槽覆盖。
defineEmits(['close']);

const proj = useProjectStore();
const isReadOnly = gateReadOnly;
const writeMode = gateWriteMode;

const newName = ref('');
const tip = ref('');
const tipKind = ref('ok');
const selectedId = ref('');
const creatorOpen = ref(false);

// 实体树交互状态（改名 / 删除 / 拖动改父级）
const editingId = ref('');          // 正在内联改名的行
const editName = ref('');
const renameInputEl = ref(null);
const draggingId = ref('');         // 拖动中的实体（HTML5 DnD）
const dropTargetId = ref('');
const pendingDelete = ref(null);    // { id, name, kids } —— 两段式删除确认（不用原生 confirm：headless 下会被自动拒绝）

const canCreate = computed(() => !!newName.value.trim());   // 项目文件的新建不受「世界观数据落盘」闸门管辖：
                                                            // 无项目=只读时若也灰禁，就永远打不开第一个项目（死锁）

const statusLine = computed(() => {
  if (proj.isOpen) {
    const st = proj.saveStatus;
    if (st === 'saving') return '保存中…';
    if (st === 'saved') return '已保存';
    if (st === 'error') return `保存失败：${proj.lastError || '未知错误'}`;
    return proj.dirty ? '有未保存改动' : '已是最新';
  }
  if (isReadOnly.value) return '只读：编辑已停用（在上面新建项目，或从下方打开已有项目）';
  return `未打开项目（写模式：${writeMode.value} — 当前编辑仍写入知识库缓存）`;
});

const flatTree = computed(() => {
  const out = [];
  const walk = (list, depth) => {
    for (const n of list) {
      out.push({ ...n, depth });
      if (n.children && n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(proj.entityTree, 0);
  return out;
});

const selectedEntity = computed(() => (selectedId.value ? proj.getEntity(selectedId.value) : null));

// 选中实体的合法父级候选（`parentCandidates` 已排除自身与全部后代 —— 防循环）
const parentOptionsForSelected = computed(() =>
  selectedEntity.value ? proj.parentCandidates(selectedEntity.value.id) : []);

// 只显示最近 5 条快照（面板高度有限；完整列表属 Phase 2 后续）
const recentSnapshots = computed(() => proj.snapshots.slice(-5).reverse());

function setTip(text, kind = 'ok') {
  tip.value = text;
  tipKind.value = kind;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function coordText(e) {
  const c = e.coordinate || {};
  if (c.x === null && c.y === null) return '未落位';
  return `${c.x ?? '—'}, ${c.y ?? '—'}`;
}

async function refresh() {
  const res = await proj.refreshProjectList();
  if (!res.success) setTip(res.error || '刷新失败', 'err');
}

async function doCreate() {
  if (!canCreate.value) return;
  const res = await proj.createProject({ name: newName.value.trim() });
  if (res.success) {
    newName.value = '';
    setTip(`已新建项目「${proj.meta.name}」`, 'ok');
    await refresh();
  } else {
    setTip(res.error || '新建失败', 'err');
  }
}

async function openExisting() {
  const res = await proj.openProject();
  if (res.canceled) return;
  if (res.success) {
    setTip(`已打开「${proj.meta.name}」`, 'ok');
    await refresh();
  } else {
    setTip(res.error || '打开失败', 'err');
  }
}

async function openAt(item) {
  if (item.error) return setTip('该文件读取失败，请检查是否为损坏的 JSON', 'err');
  const res = await proj.openProject(item.filePath);
  if (res.success) setTip(`已打开「${proj.meta.name}」`, 'ok');
  else setTip(res.error || '打开失败', 'err');
}

async function doSave() {
  const res = await proj.saveProject({ label: '手动保存' });
  if (res.success) setTip(`已保存（${res.bytes ?? 0} 字节）`, 'ok');
  else setTip(res.error || '保存失败', 'err');
}

async function doBackup() {
  const res = await proj.backupNow();
  setTip(res && res.backedUp ? '已备份到 <项目文件>.backups/' : (res.error || '备份失败'), res && res.backedUp ? 'ok' : 'err');
}

async function doReveal() {
  const res = await proj.revealProject();
  if (!res || !res.success) setTip((res && res.error) || '定位失败', 'err');
}

function doClose() {
  proj.closeProject();
  selectedId.value = '';
  cancelRename();
  pendingDelete.value = null;
  setTip('项目已关闭', 'ok');
}

// ── 实体树：选中 / 改名 / 删除 / 拖动改父级 ────────────────────────────────
// 三个操作全部走 `projectStore`（内部走 undo.js 的 execute），因此都可用 Ctrl+Z 撤销，
// 且本组件不碰 IPC / 文件系统（接线属 Phase 2.4）。

function select(row) {
  selectedId.value = row.id;
  pendingDelete.value = null;
}

function startRename(row) {
  editingId.value = row.id;
  editName.value = row.name;
  nextTick(() => renameInputEl.value?.focus?.());
}

function cancelRename() {
  editingId.value = '';
  editName.value = '';
}

function commitRename() {
  const id = editingId.value;
  const next = editName.value.trim();
  const before = id ? proj.getEntity(id) : null;
  cancelRename();
  if (!id || !before || !next || before.name === next) return;
  const res = proj.renameEntity(id, next);
  setTip(res.success
    ? `已把「${before.name}」改名为「${next}」（Ctrl+Z 可撤销）`
    : (res.error || '改名失败'), res.success ? 'ok' : 'err');
}

function askDelete(row) {
  const kids = proj.descendantsOf(row.id).length;
  selectedId.value = row.id;
  pendingDelete.value = { id: row.id, name: row.name, kids };
}

function confirmDelete() {
  const pd = pendingDelete.value;
  pendingDelete.value = null;
  if (!pd) return;
  const res = proj.deleteEntity(pd.id, { cascade: true });
  if (res.success) {
    if (selectedId.value === pd.id) selectedId.value = '';
    setTip(`已删除「${pd.name}」${pd.kids ? `及 ${pd.kids} 个子实体` : ''}（Ctrl+Z 可撤销）`, 'ok');
  } else {
    setTip(res.error || '删除失败', 'err');
  }
}

/** 拖动目标是否合法（不能落到自己或自己的后代下 —— 会形成循环） */
function canDropInto(targetId) {
  if (!draggingId.value) return true;
  return proj.parentCandidates(draggingId.value).some(e => e.id === targetId);
}

function onDragStart(row, e) {
  draggingId.value = row.id;
  try {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.id);
  } catch (_) { /* 合成事件下 dataTransfer 可能为 null —— 状态已记在 draggingId */ }
}

function onDragEnd() {
  draggingId.value = '';
  dropTargetId.value = '';
}

function onDragOver(row) {
  if (!draggingId.value || draggingId.value === row.id || !canDropInto(row.id)) return;
  dropTargetId.value = row.id;
}

function onDragLeave(row) {
  if (dropTargetId.value === row.id) dropTargetId.value = '';
}

function onDrop(row) {
  if (!draggingId.value) return;
  if (draggingId.value === row.id) return onDragEnd();
  if (!canDropInto(row.id)) {
    const src = proj.getEntity(draggingId.value);
    onDragEnd();
    setTip(`不能把「${src ? src.name : draggingId.value}」移到它自己或它的后代下（会形成循环）`, 'err');
    return;
  }
  reparent(draggingId.value, row.id);
}

function onDropRoot() {
  if (!draggingId.value) return;
  reparent(draggingId.value, null);
}

function reparent(id, parentId) {
  const src = proj.getEntity(id);
  onDragEnd();
  if (!src) return;
  const res = proj.moveEntity(id, parentId);
  const toName = parentId ? ((proj.getEntity(parentId) || {}).name || parentId) : '顶层';
  setTip(res.success
    ? `已把「${src.name}」移到「${toName}」（Ctrl+Z 可撤销）`
    : (res.error || '移动失败'), res.success ? 'ok' : 'err');
}

function onParentChange(e) {
  if (!selectedEntity.value) return;
  const target = e.target.value || null;
  if ((selectedEntity.value.parentId || null) === target) return;
  reparent(selectedEntity.value.id, target);
}

/** 向导「前往编辑」落到本面板：选中新实体并滚到可见处 */
function onGoto(entity) {
  creatorOpen.value = false;
  pendingDelete.value = null;
  if (!entity) return;
  selectedId.value = entity.id;
  nextTick(() => {
    const row = document.querySelector('.project-panel .pp-node-row.sel');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  });
  setTip(`已选中「${entity.name}」：可在下方改父级、用行内铅笔改名或删除；`
    + `画布落位与边界绘制等接线（Phase 2.4 / 2.6）后再从这里直达。`, 'ok');
}

function doRestore(s) {
  const res = proj.restoreProjectSnapshot(s.index);
  setTip(res.success ? `已回滚到「${s.label || '快照 ' + (s.index + 1)}」（可用 Ctrl+Z 撤销）` : (res.error || '回滚失败'),
    res.success ? 'ok' : 'err');
}

async function pickDir() {
  const res = await proj.chooseProjectDir();
  if (res.success) setTip(`项目目录已切换`, 'ok');
}

// 面板打开时拉一次列表（未打开项目也能看到目录里有什么）
watch(() => proj.isOpen, (v) => { if (v) refresh(); });
refresh();
</script>

<style scoped>
/* 定位与宽度由本类提供；外观/拖拽/关闭由 PanelShell 统一处理（planet 主题变量） */
.project-panel {
  position: absolute;
  top: 60px;
  right: 16px;
  width: 340px;
  max-height: calc(100% - 110px);
  z-index: 200;
  background: var(--planet-editor-bg);
  border-color: var(--planet-editor-border);
  display: flex;
  flex-direction: column;
}
.pp-body {
  padding: 10px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mini-btn {
  background: transparent;
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  color: var(--planet-text-secondary);
  cursor: pointer;
  padding: 1px 5px;
  line-height: 1.2;
}
.mini-btn:hover {
  color: var(--planet-text);
  background: var(--planet-btn-hover);
}
.pp-status {
  border: 1px solid var(--planet-btn-border);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  padding: 7px 9px;
  background: var(--planet-btn-bg);
}
.pp-status.ok { border-left-color: #2ecc71; }
.pp-status.none { border-left-color: #95a5a6; }
.pp-status.readonly { border-left-color: #d29922; }
.pp-status-name {
  color: var(--planet-text);
  font-weight: 600;
  font-size: 13px;
}
.pp-status-sub {
  color: var(--planet-text-secondary);
  font-size: 11.5px;
  margin-top: 2px;
}
.pp-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pp-label {
  color: var(--planet-text-secondary);
  font-size: 11.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pp-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.pp-row.wrap { flex-wrap: wrap; }
.pp-input {
  flex: 1;
  min-width: 0;
  padding: 4px 7px;
  font-size: 12px;
  color: var(--planet-text);
  background: var(--planet-btn-bg);
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
}
.pp-input:focus { outline: none; border-color: var(--planet-text-link); }
.pp-btn {
  padding: 4px 9px;
  font-size: 12px;
  color: var(--planet-text);
  background: var(--planet-btn-bg);
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
}
.pp-btn:hover:not(:disabled) { background: var(--planet-btn-hover); }
.pp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pp-btn.primary:not(:disabled) { color: #1c4fa1; border-color: #3a6b8f; }
.pp-btn.danger:hover:not(:disabled) { color: #b3261e; border-color: #8f4a3a; }
.link-btn {
  background: none;
  border: none;
  color: #2f5fd0;   /* 面板卡面是浅色（--planet-editor-bg 两套主题都是白），链接必须用深蓝才看得清 */
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
}
.link-btn:disabled { color: var(--planet-text-secondary); cursor: not-allowed; opacity: 0.55; }
.pp-hint, .pp-path {
  color: var(--planet-text-secondary);
  font-size: 11px;
}
.pp-path {
  word-break: break-all;
  font-family: ui-monospace, Consolas, monospace;
}
.pp-tip {
  font-size: 11.5px;
  padding: 4px 7px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--planet-btn-border);
}
.pp-tip.ok { color: #1b6b3a; border-color: #2e6b48; background: rgba(46, 204, 113, 0.10); }
.pp-tip.err { color: #b3261e; border-color: #8f4a3a; background: rgba(231, 76, 60, 0.10); }
.pp-empty {
  color: var(--planet-text-secondary);
  font-size: 11.5px;
  padding: 6px 2px;
  opacity: 0.8;
}
.pp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.pp-item:hover { background: var(--planet-btn-hover); }
.pp-item.active { border-color: var(--planet-text-link); }
.pp-item-main { min-width: 0; }
.pp-item-name {
  color: var(--planet-text);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pp-item-sub { color: var(--planet-text-secondary); font-size: 10.5px; }
.pp-warn { color: #a06b00; font-weight: 700; }
.pp-tree {
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  max-height: 190px;
  overflow-y: auto;
  padding: 3px 0;
}
.pp-node-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  cursor: pointer;
}
.pp-node-row:hover { background: var(--planet-btn-hover); }
.pp-node-row.sel { background: rgba(74, 144, 217, 0.16); }
.pp-node-row.dragging { opacity: 0.45; }
.pp-node-row.drop { outline: 1px solid var(--planet-text-link); background: rgba(74, 144, 217, 0.22); }
.pp-node-row.forbid { cursor: no-drop; }
.pp-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 3px;
  color: var(--planet-text-secondary);
  border: 1px solid var(--planet-btn-border);
}
.pp-node-name {
  color: var(--planet-text);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pp-row-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.pp-node-row:hover .pp-row-actions,
.pp-node-row.sel .pp-row-actions { opacity: 1; }
.icon-btn {
  background: none;
  border: none;
  padding: 1px 2px;
  color: var(--planet-text-secondary);
  cursor: pointer;
  line-height: 1;
  display: inline-flex;
}
.icon-btn:hover { color: var(--planet-text); }
.pp-rename {
  flex: 1;
  min-width: 0;
  padding: 1px 5px;
  font-size: 12px;
  color: var(--planet-text);
  background: var(--planet-btn-bg);
  border: 1px solid var(--planet-text-link);
  border-radius: var(--radius-sm);
}
.pp-rename:focus { outline: none; }
.pp-drop-root {
  border: 1px dashed #2f5fd0;
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 11px;
  color: #2f5fd0;
  text-align: center;
}
.pp-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border: 1px solid #8f4a3a;
  border-radius: var(--radius-sm);
  background: rgba(231, 76, 60, 0.1);
}
.pp-confirm-text {
  flex: 1;
  min-width: 0;
  color: #b3261e;
  font-size: 11.5px;
}
.pp-detail {
  border: 1px dashed var(--planet-btn-border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  font-size: 11px;
  color: var(--planet-text);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pp-parent-row { display: flex; align-items: center; gap: 4px; }
.pp-parent {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--planet-text);
  background: var(--planet-btn-bg);
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  padding: 1px 3px;
}
.pp-k {
  display: inline-block;
  width: 46px;
  color: var(--planet-text-secondary);
}
</style>
