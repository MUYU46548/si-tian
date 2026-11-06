<template>
  <!-- 剧本管理对话框（2026-11-06 从 ScenarioMap.vue 拆出，拆分第二批）
       为什么拆：172 行模板 + 约 200 行样式只服务这一个对话框，而 `ScenarioMap.vue` 已经 6,900 行
       （SFC 行数闸门见 `unit/test_scenario_map_split.js` m1）。

       口径（**与拆分前逐字同效**）：
       · 状态仍在父组件（`newScenario` / `editingScenarioId` / `editingGroupId` / 两个名字输入框），
         这里用 `defineModel` 双向绑定 —— 不复制一份，避免"对话框里的草稿和真实草稿不是同一个对象"；
       · 写口仍全在父组件（`createGroup` / `startEditScenario` / `saveEditScenario` / `deleteScenario`
         / `clearAllScenarios` / `deleteAnnotation`… 各自都是 store 的一条 undo），这里只 `emit`；
       · 只读态由父组件传 `readOnly` / `readOnlyReason` 进来，本组件不自己去读 store 的闸门。 -->
  <div v-if="open" class="modal-overlay" data-testid="scenario-manager-overlay" @click.self="$emit('close')">
    <div class="modal-dialog scenario-manager">
      <h3>剧本管理</h3>

      <!-- 剧本集管理（2026-10-25）：一组 = 一条独立时间线。删除组**不删剧本**，只退回默认组。 -->
      <div class="scenario-groups" data-testid="scenario-groups">
        <div class="sg-head">
          <span class="sg-title">剧本集</span>
          <span class="sg-hint">切换后左栏、时间轴、播放与切片导出只显示这一组</span>
        </div>
        <div v-for="g in groups" :key="g.id" class="sg-row" :data-testid="'scenario-group-row-' + g.id">
          <template v-if="editingGroupId === g.id">
            <input v-model="editGroupName" class="sg-name-input" data-testid="scenario-group-rename-input"
                   @keydown.enter="$emit('commitRenameGroup')" @keydown.esc="$emit('cancelRenameGroup')" />
            <button class="sg-btn primary" data-testid="scenario-group-rename-save"
                    :disabled="!editGroupName.trim()" @click="$emit('commitRenameGroup')">保存</button>
            <button class="sg-btn" @click="$emit('cancelRenameGroup')">取消</button>
          </template>
          <template v-else>
            <span class="sg-name" :class="{ current: g.id === activeGroupId }">{{ g.name }}</span>
            <span class="sg-count">{{ groupCount(g.id) }} 条</span>
            <button v-if="g.id !== defaultGroup" class="sg-btn" data-testid="scenario-group-rename"
                    :disabled="readOnly" title="重命名这个剧本集"
                    @click="$emit('startRenameGroup', g)">改名</button>
            <button v-if="g.id !== defaultGroup" class="sg-btn danger" data-testid="scenario-group-delete"
                    :disabled="readOnly"
                    :title="`删除剧本集“${g.name}”—— 组内 ${groupCount(g.id)} 条剧本会退回“默认”，一条剧本都不会删`"
                    @click="$emit('deleteGroup', g)">删除</button>
          </template>
        </div>
        <div class="sg-new">
          <input v-model="newGroupName" class="sg-name-input" placeholder="新剧本集名称（如：第二时间线 / 另一张底图）"
                 data-testid="scenario-group-name" @keydown.enter="$emit('createGroup')" />
          <button class="sg-btn primary" data-testid="scenario-group-create"
                  :disabled="readOnly || !newGroupName.trim()" @click="$emit('createGroup')">新建剧本集</button>
        </div>
        <p class="sg-note">
          剧本集只决定“哪些剧本一起出现在左栏和时间轴上”；删除组只是取消分类，剧本、省份、归属一条都不动。
        </p>
      </div>

      <div class="scenario-list">
        <div v-for="s in scenarios" :key="s.id" class="scenario-item" :data-testid="'scenario-item-' + s.id">
          <span class="item-era">{{ s.era?.roman || '·' }}</span>
          <span class="item-name">{{ s.name }}</span>
          <span class="item-years">{{ s.era?.startYear || '?' }} – {{ s.era?.endYear || '?' }}</span>
          <select class="item-group" :value="scenarioGroupIdOf(s)" :disabled="readOnly"
                  :title="`把“${s.name}”移到别的剧本集（不删任何数据）`"
                  data-testid="scenario-item-group"
                  @change="$emit('moveScenarioToGroup', s, $event.target.value)">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <button class="item-edit" data-testid="scenario-edit" :disabled="readOnly"
                  :title="readOnly ? (readOnlyReason || '只读：未打开项目')
                    : '编辑剧本信息（名称 / 罗马数字 / 时代标签 / 起止年 / 描述）—— 不改动已录的省份归属与易主日期'"
                  @click="$emit('startEditScenario', s)"><Icon name="edit" :size="15"/> 编辑</button>
          <button class="item-delete" data-testid="scenario-delete" :disabled="readOnly"
                  :title="readOnly ? (readOnlyReason || '只读：未打开项目') : '删除剧本'"
                  @click="$emit('deleteScenario', s)"><Icon name="trash" :size="15"/> 删除</button>
        </div>
      </div>
      <!-- 🔴 批量清空（2026-10-11 接活死入口 `removeAllScenarios`）：真实场景是导入的年表塞了 12 条占位剧本，
           一条条点垃圾桶又慢又容易点错 —— 这里给一条撤销可回退的整批清空（只删剧本，不动底图/省份）。 -->
      <div class="scenario-bulk" data-testid="scenario-bulk">
        <button
          class="btn-clear-all"
          data-testid="scenario-clear-all"
          :disabled="readOnly || !scenarios.length"
          :title="readOnly ? (readOnlyReason || '只读：未打开项目')
            : ('删除全部 ' + scenarios.length + ' 条剧本（所有剧本集）。只删剧本本身（名称/年份/势力归属/易主记录/标注标记），'
              + '底图与省份边界一个都不动；一条撤销即可回退')"
          @click="$emit('clearAllScenarios')"
        >清空全部剧本（保留底图与省份）</button>
        <span class="bulk-hint">
          共 {{ scenarios.length }} 条（所有剧本集）· 底图与省份不受影响 · Ctrl+Z 可撤销
        </span>
      </div>
      <div class="scenario-annos" data-testid="scenario-annotations">
        <h4>“{{ selectedScenario?.name || '（未选剧本）' }}”的标注与标记</h4>
        <div v-if="!annoRows.length" class="anno-empty">
          还没有地名或标记 —— 用工具栏“更多”里的“地名 (T)”“标记 (K)”在地图上放置
        </div>
        <div v-for="row in annoRows" :key="row.key" class="anno-row" :data-testid="'anno-' + row.kind">
          <span class="anno-kind">{{ row.kind === 'label' ? '地名' : '标记' }}</span>
          <span class="anno-text">{{ row.text }}</span>
          <button class="anno-del" data-testid="anno-del" :disabled="readOnly"
                  :title="readOnly ? (readOnlyReason || '只读：未打开项目')
                    : ('删除' + (row.kind === 'label' ? '地名' : '标记') + '“' + row.text + '”（可撤销）')"
                  @click="$emit('deleteAnnotation', row)"><Icon name="trash" :size="12"/> 删除</button>
        </div>
      </div>
      <!-- B1：剧本 ↔ 笔记（候选来自同一个资料段；写口在父面板，一条撤销） -->
      <VaultLoreSection testid="scenario-vault" :query="selectedScenario?.name || ''"
                        :binding="{ path: selectedScenario?.notePath || '', label: '这个剧本' }"
                        :bind-fn="bindNote" :unbind-fn="unbindNote" />
      <div class="new-scenario-form">
        <h4>{{ editingScenarioId ? '编辑剧本' : '新建剧本' }}</h4>
        <!-- 2026-10-22：把“新剧本会绑哪张底图”摆在表单第一行。
             以前不显示，用户以为"新建剧本 = 新地图"，结果还是一张旧底图（真实困惑）。 -->
        <div class="form-row bound-row" data-testid="new-scenario-basemap">
          <label>底图：</label>
          <span class="bound-basemap" :title="baseMapKey ? `新剧本将绑定底图“${baseMapKey}”` : '还没有底图'">
            {{ baseMapKey || '（还没有底图）' }}
          </span>
          <!-- 对话框里也给出口：不管有没有底图，都能"新建一张空底图再建剧本"——
               用户的困惑就发生在这张表单前（"新建剧本怎么还是旧底图"）。 -->
          <button
            type="button"
            class="bound-add"
            data-testid="new-scenario-basemap-add"
            :disabled="readOnly"
            :title="readOnly ? `新建底图已停用：${readOnlyReason || '只读：未打开项目'}` : '新建一张空白底图，并让本剧本绑定它'"
            @click="$emit('addEmptyBaseMap')"
          >＋ 新建空底图</button>
        </div>
        <div class="form-row">
          <label>剧本集：</label>
          <select v-model="newScenario.group" data-testid="new-scenario-group" class="short-input"
                  title="新剧本落在哪条时间线；切到该组后才出现在左栏与时间轴">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>名称：</label>
          <input v-model="newScenario.name" placeholder="如：第一时代·黑暗时代" />
        </div>
        <div class="form-row">
          <label>罗马数字：</label>
          <input v-model="newScenario.roman" placeholder="如：Ⅰ" class="short-input" />
        </div>
        <div class="form-row">
          <label>时代标签：</label>
          <input v-model="newScenario.label" placeholder="如：黑暗时代" />
        </div>
        <div class="form-row">
          <label>起始年：</label>
          <input v-model="newScenario.startYear" placeholder="如：历年 2006" />
        </div>
        <div class="form-row">
          <label>结束年：</label>
          <input v-model="newScenario.endYear" placeholder="如：历年 2008" />
        </div>
        <div class="form-row">
          <label>描述：</label>
          <textarea v-model="newScenario.description" placeholder="可选说明" rows="2"></textarea>
        </div>
        <div class="form-row">
          <label title="剧本卡片墙（选剧本界面）上显示的一句钩子文案，1-2 句为宜；留空则卡片不显示这行">钩子文案：</label>
          <textarea v-model="newScenario.hook" placeholder="可选 —— 选剧本卡片上的一句话钩子，如：五雄歃血为盟又彼此提防" rows="2"></textarea>
        </div>
        <div class="form-row checkbox">
          <label>继承上一时代：</label>
          <input type="checkbox" v-model="newScenario.inherit" />
        </div>
        <div class="form-actions">
          <button v-if="editingScenarioId" data-testid="scenario-save-edit"
                  @click="$emit('saveEditScenario')" :disabled="readOnly || !newScenario.name">保存</button>
          <button v-else data-testid="scenario-create" @click="$emit('createNewScenario')"
                  :disabled="!newScenario.name || !baseMapKey || !baseMaps?.[baseMapKey] || readOnly"
                  :title="(!baseMapKey || !baseMaps?.[baseMapKey]) ? '还没有底图：先在下面点“＋ 新建空底图”，或用“＋”导入 .map' : ''">创建</button>
          <button v-if="editingScenarioId" data-testid="scenario-cancel-edit" @click="$emit('cancelEditScenario')">取消编辑</button>
          <button v-else @click="$emit('close')">关闭</button>
        </div>
        <div v-if="editingScenarioId" class="edit-hint">
          正在编辑既有剧本 —— 保存只改上面这些字段，省份归属 / 易主日期 / 标注 / 标记全部保留
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import Icon from '../../components/Icon.vue';
import VaultLoreSection from '../../components/VaultLoreSection.vue';

defineProps({
  open: { type: Boolean, default: false },
  /** 已按当前底图过滤、排好序的剧本（父组件的 allSortedScenarios） */
  scenarios: { type: Array, default: () => [] },
  /** 剧本集选项（父组件的 groupOptions） */
  groups: { type: Array, default: () => [] },
  /** 某一组有几条（父组件的 groupCount） */
  groupCount: { type: Function, default: () => 0 },
  /** 剧本属于哪一组（utils/scenarioGroups.scenarioGroupIdOf） */
  scenarioGroupIdOf: { type: Function, default: () => '' },
  activeGroupId: { type: String, default: '' },
  defaultGroup: { type: String, default: 'default' },
  selectedScenario: { type: Object, default: null },
  annoRows: { type: Array, default: () => [] },
  baseMapKey: { type: String, default: '' },
  baseMaps: { type: Object, default: () => ({}) },
  readOnly: { type: Boolean, default: false },
  readOnlyReason: { type: String, default: '' },
  bindNote: { type: Function, default: null },
  unbindNote: { type: Function, default: null },
});

// 与父组件**同一个对象**（defineModel 不复制）：拆分前就是直接读写父组件的 ref
const newScenario = defineModel('newScenario', { type: Object, default: () => ({}) });
// ⚠️ 父组件里这个 ref 初值是 `null`（不是 ''）—— 别给 String 约束，否则开发态会刷类型警告
const editingScenarioId = defineModel('editingScenarioId', { default: null });
const editingGroupId = defineModel('editingGroupId', { type: String, default: '' });
const editGroupName = defineModel('editGroupName', { type: String, default: '' });
const newGroupName = defineModel('newGroupName', { type: String, default: '' });

defineEmits([
  'close', 'createGroup', 'startRenameGroup', 'commitRenameGroup', 'cancelRenameGroup',
  'deleteGroup', 'moveScenarioToGroup', 'startEditScenario', 'deleteScenario',
  'clearAllScenarios', 'deleteAnnotation', 'saveEditScenario', 'createNewScenario',
  'cancelEditScenario', 'addEmptyBaseMap',
]);
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.modal-dialog {
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 20px;
  max-width: 500px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
  color: #e2e8f0;
}

.modal-dialog h3 { margin: 0 0 16px; font-size: 16px; }

.scenario-list { margin-bottom: 20px; }

.scenario-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #334155;
}

.item-era { font-weight: 600; color: #7c3aed; min-width: 20px; }

.item-name { flex: 1; font-size: 13px; }

.item-years { font-size: 11px; color: #64748b; }

.item-group {
  max-width: 92px;
  background: #16233a;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 4px;
  font-size: 10.5px;
  padding: 1px 3px;
  font-family: inherit;
}

.scenario-groups {
  margin: 0 0 16px;
  padding: 8px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.35);
}

.sg-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }

.sg-title { font-size: 12px; font-weight: 600; color: #e2e8f0; }

.sg-hint { font-size: 10.5px; color: #64748b; }

.sg-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-bottom: 1px solid #263449;
}

.sg-row:last-of-type { border-bottom: 0; }

.sg-name { flex: 1; font-size: 12px; color: #cbd5e1; }

.sg-name.current { color: #fff; font-weight: 600; }

.sg-count { font-size: 10.5px; color: #64748b; font-variant-numeric: tabular-nums; }

.sg-name-input {
  flex: 1;
  min-width: 0;
  background: #16233a;
  border: 1px solid #475569;
  color: #e2e8f0;
  border-radius: 4px;
  font-size: 11px;
  padding: 2px 5px;
  font-family: inherit;
}

.sg-btn {
  flex: none;
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 10.5px;
  cursor: pointer;
  font-family: inherit;
}

.sg-btn:hover:not(:disabled) { background: #334155; color: #e2e8f0; }

.sg-btn.primary { background: rgba(124, 58, 237, 0.85); border-color: #7c3aed; color: #fff; }

.sg-btn.danger:hover:not(:disabled) { background: rgba(180, 40, 50, 0.35); border-color: #a3474f; color: #fecaca; }

.sg-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.sg-new { display: flex; gap: 6px; margin-top: 6px; }

.sg-note { margin: 6px 0 0; font-size: 10.5px; line-height: 1.55; color: #64748b; }

.item-delete {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.5;
}

.item-delete:hover { opacity: 1; }

.item-edit {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.5;
}

.item-edit:hover { opacity: 1; }

.item-edit:disabled, .item-delete:disabled { opacity: 0.25; cursor: not-allowed; }

.scenario-bulk {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 14px;
}

.btn-clear-all {
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  color: #fecaca;
  background: rgba(220, 38, 38, 0.18);
  border: 1px solid #b91c1c;
  border-radius: 6px;
  cursor: pointer;
}

.btn-clear-all:hover:not(:disabled) { background: rgba(220, 38, 38, 0.32); }

.btn-clear-all:disabled { opacity: 0.4; cursor: not-allowed; }

.bulk-hint { font-size: 11px; color: #94a3b8; }

.scenario-annos {
  border-top: 1px solid #334155;
  padding-top: 12px;
  margin-bottom: 16px;
}

.scenario-annos h4 { margin: 0 0 8px; font-size: 13px; color: #cbd5e1; }

.anno-empty { font-size: 12px; color: #64748b; line-height: 1.5; }

.anno-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}

.anno-kind {
  flex: 0 0 auto;
  font-size: 11px;
  color: #a78bfa;
  border: 1px solid #4c1d95;
  border-radius: 3px;
  padding: 0 4px;
}

.anno-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.anno-del {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.55;
  color: inherit;
}

.anno-del:hover { opacity: 1; }

.anno-del:disabled { opacity: 0.25; cursor: not-allowed; }

.edit-hint { margin-top: 8px; font-size: 11px; color: #94a3b8; line-height: 1.5; }

.new-scenario-form {
  border-top: 1px solid #334155;
  padding-top: 16px;
}

.new-scenario-form h4 { margin: 0 0 12px; font-size: 14px; }

.bound-row .bound-basemap {
  flex: 1; font-size: 12px; color: var(--text-secondary, #9aa4b2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.bound-row .bound-add {
  font-size: 12px; padding: 2px 8px; cursor: pointer;
  background: transparent; border: 1px solid var(--border, #3a4350); border-radius: 4px;
  color: var(--accent, #8ab4f8);
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.form-row label {
  min-width: 80px;
  font-size: 12px;
  color: #94a3b8;
}

.form-row input[type="text"], .form-row textarea {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e2e8f0;
  font-size: 12px;
}

.form-row input.short-input { max-width: 60px; }

.form-row.checkbox label { min-width: auto; }

.form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}

.form-actions button {
  padding: 6px 16px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.form-actions button:first-child { background: #5b21b6; border-color: #7c3aed; }

.form-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
