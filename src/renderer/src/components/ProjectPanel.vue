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
        <div class="pp-row pp-name-row" @click="focusNameInput">
          <input
            ref="nameInputEl"
            v-model="newName"
            class="pp-input"
            placeholder="项目名称"
            aria-label="项目名称"
            @keydown.enter="doCreate"
          />
          <button class="pp-btn primary" :disabled="!canCreate" @click="doCreate">新建</button>
        </div>
        <div class="pp-row">
          <button
            class="pp-btn"
            :disabled="!canCreate || !vaultSeed.available || seeding"
            :title="vaultSeed.hint"
            @click="doCreateFromVault"
          >{{ seeding ? '导入中…' : '新建并导入知识库内容' }}</button>
        </div>
        <div class="pp-hint pp-seed">
          {{ vaultSeed.hint }}
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
            <button
              class="pp-btn"
              title="把项目所在目录当作 git 仓库提交一次快照。⚠️ 司天不会自动初始化 git 仓库：目录不是仓库时会跳过（如需 git 备份，请自行在项目目录 git init）"
              @click="doGitSnapshot"
            >Git 快照</button>
            <button class="pp-btn" @click="doReveal">定位文件</button>
            <button class="pp-btn danger" @click="doClose">关闭</button>
          </template>
        </div>
        <!-- 「导入知识库内容」（2026-09-22 用户实测反馈）：
             新建的空项目此前**没有任何入口**把知识库既有内容带进来（「新建并导入知识库内容」只管新建那条路，
             而「重新提取」在项目态被正确拒绝）→ 用户卡在"项目里空空的"。这里补上唯一的缺口。 -->
        <div v-if="proj.isOpen" class="pp-row">
          <button
            class="pp-btn primary"
            data-testid="import-from-vault"
            :disabled="!vaultImport.available || importing"
            :title="vaultImport.hint"
            @click="doImportFromVault"
          >{{ importing ? '导入中…' : '导入知识库内容' }}</button>
        </div>
        <div v-if="proj.isOpen" class="pp-hint" data-testid="import-hint">{{ vaultImport.hint }}</div>
        <div v-if="proj.isOpen" class="pp-hint pp-file">
          文件：<span class="pp-path" :title="proj.filePath">{{ proj.filePath }}</span>
        </div>

        <!-- 笔记改名 → 断线检测与重连（R15 / A-0，2026-09-27）
             项目态下知识库的 add/unlink 事件被整条拦掉（防两套事实源混流）→ 用户在 Obsidian 里
             改名/移动笔记，司天既不知道也不提示；下次「导入知识库内容」会把新名当新实体补进来、
             旧实体成孤儿。这里把它**显式化**：查一次 → 给出可读理由 → 点一下重连。
             重连保持实体 id 不变，所以坐标与编辑成果（地图/区域/建筑内部）天然全部保留。 -->
        <div v-if="proj.isOpen" class="pp-row">
          <button
            class="pp-btn"
            data-testid="check-broken-links"
            :disabled="scanning"
            title="对账「项目实体指向的笔记」与「库里现有的笔记」，找出被改名 / 移动的笔记"
            @click="doScanBrokenLinks"
          >{{ scanning ? '检查中…' : '检查笔记改名' }}</button>
          <span
            v-if="brokenScan && brokenScan.clean"
            class="pp-broken-clean"
            data-testid="broken-clean"
          >未发现断线（{{ brokenScan.notes }} 篇笔记全部对得上）</span>
        </div>

        <div v-if="brokenScan && !brokenScan.clean" class="pp-broken" data-testid="broken-list">
          <div class="pp-hint">
            发现 <b>{{ brokenScan.dangling.length }}</b> 处断线：这些实体指向的笔记已不在库里（改名 / 移动 / 删除）
          </div>
          <div v-for="d in brokenScan.dangling" :key="d.id" class="pp-broken-item" :data-testid="'broken-' + d.id">
            <div class="pp-broken-head">
              <span class="pp-badge">{{ d.name }}</span>
              <span class="pp-path" :title="d.sourcePath">{{ d.sourcePath }}</span>
            </div>
            <div v-if="(brokenScan.suggestions[d.id] || []).length" class="pp-broken-cand">
              <select v-model="relinkChoice[d.id]" :data-testid="'relink-select-' + d.id">
                <option v-for="c in brokenScan.suggestions[d.id]" :key="c.sourcePath" :value="c.sourcePath">
                  {{ c.name }}（{{ describeCand(c) }}）{{ c.recommended ? ' — 推荐' : '' }}
                </option>
              </select>
              <button class="pp-btn primary" :data-testid="'relink-' + d.id" @click="doRelink(d)">重连</button>
            </div>
            <div v-else class="pp-hint">库里没有无主笔记可以重连（笔记可能已被删除，或改名后的笔记还没建）</div>
          </div>
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
          <!-- 只看空白（A-3 补刀②）：**按层级判空白** —— 真 ROSA 实测 placeType 空 45 个里 39 个是
               宇宙层（本就不携带该字段）、parentId 空 9 个里 4 个是 world（本就该顶层）；
               不分层就过滤 = 用户点开「类型为空」看到 39 行无意义噪音，过滤器等于没做。
               空白口径的唯一实现在 utils/placeTypes.js（matchesGap），这里只负责显示。 -->
          <div class="pp-gap-row">
            <select
              v-model="gapMode"
              class="pp-gap-filter"
              data-testid="gap-filter"
              :disabled="isReadOnly"
              :title="isReadOnly ? READONLY_REASON : '只显示「该填却没填」的实体；空白口径按层级判定（utils/placeTypes.js）'"
            >
              <option v-for="m in GAP_MODES" :key="m.value" :value="m.value">
                {{ m.label }}{{ m.value === 'all' ? '' : '（' + gapCount(m.value) + '）' }}
              </option>
            </select>
            <span v-if="gapMode !== 'all'" class="pp-gap-count" data-testid="gap-count">
              显示 {{ visibleRows.length }} / {{ flatTree.length }}
            </span>
          </div>
          <div
            v-if="draggingId"
            class="pp-drop-root"
            @dragover.prevent="dropTargetId = ''"
            @drop.prevent="onDropRoot"
          >松开以移到顶层</div>
          <div class="pp-tree">
            <div
              v-for="row in visibleRows"
              :key="row.id"
              :data-id="row.id"
              class="pp-node-row"
              :class="{
                sel: selectedId === row.id,
                multi: selectedIds.length > 1 && selectedIds.includes(row.id),
                drop: dropTargetId === row.id,
                dragging: draggingId === row.id,
                forbid: !!draggingId && !canDropInto(row.id),
              }"
              :style="{ paddingLeft: (8 + row.depth * 14) + 'px' }"
              :draggable="editingId !== row.id"
              title="拖动到别的行可改父级；双击名称可改名；Ctrl/⌘ 点击可多选"
              @click="select(row, $event)"
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
              <!-- 叙事状态徽标（2026-09-24）：**只对非 active 显示** —— 满屏「存在」是噪音。
                   背景：用户决策「毁灭只是叙事状态，不是数据删除」，实体保留 + 状态标记。 -->
              <span
                v-if="hasNonDefaultStatus(row)"
                class="pp-status-badge"
                :title="rowStatusHint(row)"
                data-testid="pp-status-badge"
              >{{ rowStatusBadge(row) }}</span>
              <!-- 地点类型下拉（A-3 中文点选糙版 + 补刀①）：
                   显示条件 = 该填的层级（facility/location/region）**或**已带值的行；
                   选项 = 8 枚举 ∪ 当前值（placeTypeOptions 单源）—— 只给 8 枚举的话，
                   笔记手写的第 9 种值一打开下拉就静默消失（与 A-2 防的静默覆盖同族）。
                   改动走 proj.updateEntity（undo 栈 + 落 .sitian），不直接改内存。 -->
              <select
                v-if="showsPlaceTypeControl(row)"
                class="pp-type"
                :data-testid="'place-type-' + row.id"
                :value="row.placeType || ''"
                :disabled="isReadOnly"
                :title="isReadOnly ? READONLY_REASON : '地点类型（决定图标配色）；改动写进 .sitian，Ctrl+Z 可撤销'"
                @click.stop
                @change="onPlaceTypeChange(row, $event)"
              >
                <option value="">未设置</option>
                <option v-for="t in placeTypeOptions(row.placeType)" :key="t" :value="t">{{ t }}</option>
              </select>
              <span v-if="editingId !== row.id" class="pp-row-actions">
                <button class="icon-btn" title="改名" @click.stop="startRename(row)"><Icon name="pencil" :size="12" /></button>
                <button class="icon-btn" title="删除（含子实体）" @click.stop="askDelete(row)"><Icon name="trash" :size="12" /></button>
              </span>
            </div>
          </div>
          <div v-if="gapMode !== 'all' && !visibleRows.length" class="pp-empty" data-testid="gap-empty">
            没有符合条件的实体（这项空白已经填完了）
          </div>
          <div v-if="selectedIds.length > 1" class="pp-batch" data-testid="pp-batch-bar">
            <span class="pp-batch-count">已选 {{ selectedIds.length }} 个</span>
            <!-- 批量改父级同样是写入口（一条 undo + 落 .sitian）：只读态必须灰禁，
                 与详情面板父级下拉 / 行内类型下拉 / 空白过滤器同口径（A-3 收尾，待决①）。 -->
            <select v-model="batchParentId" class="pp-parent" :disabled="isReadOnly"
                    :title="isReadOnly ? READONLY_REASON : '选择目标父级'">
              <option value="">（顶层）</option>
              <option v-for="e in batchParentOptions" :key="e.id" :value="e.id">{{ e.name }}（{{ e.layerLabel }}）</option>
            </select>
            <button class="pp-btn primary" :disabled="isReadOnly" @click="doBatchMove">移到此父级</button>
            <button class="pp-btn" @click="clearMulti">取消多选</button>
            <div class="pp-batch-hint">把散落的设施/地点一次归入城市或区域（一条 undo）</div>
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
            <!-- 父级挂靠同样是写入口（走 proj.updateEntity → undo + 落 .sitian）：只读态必须灰禁
                 并给出去处，与行内类型下拉 / 空白过滤器同一口径（A-3；2026-10-01 摘取在线版增量）。 -->
            <select
              class="pp-parent"
              :value="selectedEntity.parentId || ''"
              :disabled="isReadOnly"
              :title="isReadOnly ? READONLY_REASON : '更改挂靠父级（可撤销）；列表行也可直接拖动'"
              @change="onParentChange($event)"
            >
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
        <!-- 快照范围必须写明（A1/R1，2026-09-25）：高度图等重字段**不进快照**（一份 1.2 MB，
             每涂一笔就整份进 patch → 满 50 份 38 MB）。回滚不恢复它们，但也不会删掉它们。 -->
        <div data-testid="snapshot-scope-note" style="font-size: 11px; line-height: 1.5; color: #4a5568; margin: 2px 0 6px;">
          快照记的是实体 / 航道 / 剧本结构；<b>不含地形高度图与参考图</b>（体积考量）。
          地形另有「备份」按钮的整文件副本（保留 10 份），回滚不会改动它。
        </div>
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

import { computed, nextTick, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import PanelShell from './PanelShell.vue';
import EntityCreator from './EntityCreator.vue';
import { useProjectStore } from '../store/projectStore';
import { isReadOnly as gateReadOnly, writeMode as gateWriteMode } from '../store/writeGate';
import { describeCanvasBridge, gotoEntity } from '../store/canvasBridge';
// A-3 中文点选糙版：地点类型的枚举 / 选项 / 空白过滤**只有一份实现**（utils/placeTypes.js），
// 本组件与 NodeDetailPanel、geodata 都从那里取 —— 组件里再写一份 `['自然', '宗教', …]` 就是第二套事实源。
import { GAP_MODES, matchesGap, placeTypeOptions, showsPlaceTypeControl } from '../utils/placeTypes';
// R15/A-0：候选**理由**的措辞与检测实现同源（避免 UI 与计算各写一套说法）
import { describeCandidate } from '../utils/vaultRelink';

// ⚠️ 挂载语义：本面板由 App.vue 用 `v-if="panelsStore.isOpen('project')"` 控制**挂载**，
//    所以**不要**再传 `open` —— PanelShell 的 `open` 默认 true，传了反而会因父级未传值而默认 false
//    导致整个面板不渲染（实测坑：App.vue 只挂载不传 open → PanelShell 根节点 v-if 恒假、静默空白）。
//    `title` 是 PanelShell 的必填 prop（不传会有 Vue 警告），图标用 title 具名插槽覆盖。
defineEmits(['close']);

const proj = useProjectStore();
const isReadOnly = gateReadOnly;
const writeMode = gateWriteMode;

const newName = ref('');
const nameInputEl = ref(null);
const tip = ref('');
const tipKind = ref('ok');
const selectedId = ref('');
// 多选（2026-09-21）：Ctrl/⌘ 点击加选 → 出现「批量改父级」操作条。
// 用途：把散落在行星下的设施/地点一次性归入城市或区域（用户反馈「建筑物散落在行星地图上」）。
const selectedIds = ref([]);
const batchParentId = ref('');
const creatorOpen = ref(false);

/**
 * 面板一挂载就把焦点放进「项目名称」输入框。
 *
 * 为什么必须这样（用户实测反馈：打开面板后**点不进**这个输入框，乱点一通才偶然能输入）：
 * 面板是 `defineAsyncComponent` + `v-if` 挂载的，从点工具栏按钮到 DOM 出现之间有加载窗口，
 * 这期间的点击落到底下的画布/世界选择视图上（用户看到的就是「点不了」）。
 * 自动聚焦让这个入口**不依赖点击**：面板一出现就能直接打字。同理 `.pp-name-row` 整行可点。
 */
onMounted(() => { nextTick(() => nameInputEl.value?.focus?.()); });

/** 点「项目名称」这一行的空白处也聚焦输入框（扩大命中区；点到按钮时不抢焦点） */
function focusNameInput(e) {
  if (e && e.target && e.target.tagName === 'BUTTON') return;
  nameInputEl.value?.focus?.();
}

// 实体树交互状态（改名 / 删除 / 拖动改父级）
const editingId = ref('');          // 正在内联改名的行
const editName = ref('');
const renameInputEl = ref(null);
const draggingId = ref('');         // 拖动中的实体（HTML5 DnD）
const dropTargetId = ref('');
const pendingDelete = ref(null);    // { id, name, kids } —— 两段式删除确认（不用原生 confirm：headless 下会被自动拒绝）

const canCreate = computed(() => !!newName.value.trim());   // 项目文件的新建不受「世界观数据落盘」闸门管辖：
                                                            // 无项目=只读时若也灰禁，就永远打不开第一个项目（死锁）

const seeding = ref(false);
const importing = ref(false);

// ── R15/A-0：笔记改名断线检测（2026-09-27）──────────────────────────────
const scanning = ref(false);
const brokenScan = ref(null);        // proj.scanBrokenLinks() 的只读结果；null = 还没查过
const relinkChoice = ref({});        // { [entityId]: sourcePath } —— 每条断线当前选中的候选

/**
 * 「新建并导入知识库内容」的可用性与说明。
 * 走画布桥的 describe()（本面板不直接依赖 geodata，test_48 有静态断言守），
 * ⚠️ canvasBridge 是命令式注册表、自身不响应式 → 显式依赖 proj.isOpen 触发重算。
 */
const vaultSeed = computed(() => {
  void proj.isOpen;
  const d = describeCanvasBridge();
  const available = d.attached === true && d.source === 'vault' && (d.nodes || 0) > 0;
  let hint;
  if (!d.attached) hint = '画布桥未就绪，暂不能导入知识库内容';
  else if (d.source !== 'vault') hint = '已打开项目 —— 先关闭项目，才能以知识库为基底新建';
  else if (available) hint = `以当前知识库为基底：${d.nodes} 个词条 / ${d.hyperlanes || 0} 条航道 / ${d.maps || 0} 张行星图（导入可用 Ctrl+Z 撤销）`;
  else hint = '当前知识库里没有可导入的内容';
  return { available, hint };
});

/**
 * 「导入知识库内容」的可用性与说明（2026-09-22）。
 * 项目态下画布是项目自己的节点，所以可用性看的是**打开项目时留下的知识库留底**（vaultNodes）。
 * 同样只经 canvasBridge 描述（本面板不直接依赖 geodata，test_48 有静态断言守）。
 */
const vaultImport = computed(() => {
  void proj.isOpen;
  const d = describeCanvasBridge();
  const available = !!proj.isOpen && d.attached === true && d.hasVaultSnapshot === true && (d.vaultNodes || 0) > 0;
  let hint;
  if (!proj.isOpen) hint = '先新建或打开一个项目，才能把知识库内容导入进来';
  else if (!d.attached) hint = '画布桥未就绪，暂不能导入知识库内容';
  else if (!d.hasVaultSnapshot) hint = '这次打开项目时知识库是空的（没有留底）—— 先关闭项目，确认知识库有内容后再打开';
  else if ((d.vaultNodes || 0) === 0) hint = '这次打开项目时知识库是空的（没有留底）—— 先关闭项目，确认知识库有内容后再打开';
  else hint = `把知识库现有内容合并进当前项目：约 ${d.vaultNodes} 个词条 / ${d.vaultHyperlanes || 0} 条航道 / ${d.vaultMaps || 0} 张行星图`
    + '（只补缺、不覆盖项目里已有的；导入可用 Ctrl+Z 撤销）';
  return { available, hint };
});

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

// ── 只看空白（A-3）＋ 行内类型下拉 ──────────────────────────────────────────
// 空白口径（matchesGap）在 utils/placeTypes.js 单源；这里只做显示与写入。
const gapMode = ref('all');
const READONLY_REASON = '只读：当前没有打开项目 —— 先在上方「新建项目」或「打开已有项目」再编辑';

const visibleRows = computed(() =>
  (gapMode.value === 'all' ? flatTree.value : flatTree.value.filter(r => matchesGap(r, gapMode.value))));

/** 过滤器选项后面括号里的计数（不含 all —— 那个数字随时都在，写成「全部」即可） */
function gapCount(mode) {
  if (mode === 'all') return flatTree.value.length;
  return flatTree.value.filter(r => matchesGap(r, mode)).length;
}

/**
 * 行内改地点类型：**只走 proj.updateEntity**（undo 栈 + 落 .sitian），绝不直接改内存 ——
 * 直接改内存 = 撤不掉、且与「项目为准」的读优先级打架。
 * 失败（只读 / 实体不存在）时回滚下拉显示并把原因说出来，不静默。
 */
function onPlaceTypeChange(row, ev) {
  const next = ev.target.value || null;
  const prev = row.placeType || null;
  if (next === prev) return;
  const res = proj.updateEntity(row.id, { placeType: next });
  if (!res.success) {
    ev.target.value = prev || '';
    setTip(res.error || '设置地点类型失败', 'err');
    return;
  }
  setTip(next
    ? `已把「${row.name}」的地点类型设为「${next}」（写入 .sitian，Ctrl+Z 可撤销）`
    : `已清除「${row.name}」的地点类型（Ctrl+Z 可撤销）`, 'ok');
}

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

/** 以当前知识库为基底新建项目（实体树 / 航道 / 地图 / 编辑器容器 / 剧本一并带进来） */
async function doCreateFromVault() {
  if (!canCreate.value || seeding.value) return;
  seeding.value = true;
  try {
    const res = await proj.createProjectFromVault({ name: newName.value.trim() });
    if (res.success) {
      const s = res.seeded || {};
      newName.value = '';
      setTip(`已新建「${proj.meta.name}」并导入知识库：${s.entities || 0} 个词条 / ${s.hyperlanes || 0} 条航道 / ${s.maps || 0} 张行星图（Ctrl+Z 可撤销导入）`, 'ok');
      await refresh();
    } else {
      setTip(res.error || '导入知识库失败', 'err');
    }
  } finally {
    seeding.value = false;
  }
}

/** 「导入知识库内容」：把知识库（打开项目时的留底）合并进**当前**项目，一条 undo */
async function doImportFromVault() {
  if (!vaultImport.available || importing.value) return;
  importing.value = true;
  try {
    const res = await proj.importFromVault();
    if (res.success && res.nothingNew) {
      setTip('项目里已经有知识库的全部内容了，无需重复导入', 'ok');
    } else if (res.success) {
      const m = res.merged || {};
      setTip(`已导入：${m.entities || 0} 个词条 / ${m.hyperlanes || 0} 条航道 / ${m.maps || 0} 张行星图`
        + `${(m.baseMaps || m.scenarios) ? ` / ${m.baseMaps || 0} 张底图 / ${m.scenarios || 0} 个剧本` : ''}`
        + '（Ctrl+Z 可撤销导入）', 'ok');
      await refresh();
    } else {
      setTip(res.error || '导入知识库内容失败', 'err');
    }
  } finally {
    importing.value = false;
  }
}

/**
 * 查一次断线（R15/A-0）。**只读**：不改任何数据，只把对账结果摆出来。
 *
 * 检查后**立刻回一句话**（「未发现断线」也算回音）—— 静默是这条缺陷的本体：
 * 旧行为是"改名之后什么都不说"，所以修复的第一半必须是**每次检查都有可见结论**。
 *
 * @param {{silent?: boolean}} opts silent=true 时只刷新清单、**不动提示条**
 *   （重连成功后要留着重连回执，不能被这次重查的「发现 N 处断线」盖掉 —— 实测踩到）
 */
async function doScanBrokenLinks({ silent = false } = {}) {
  if (scanning.value) return;
  scanning.value = true;
  try {
    const res = await proj.scanBrokenLinks();
    if (!res.success) {
      brokenScan.value = null;
      if (!silent) setTip(res.error || '断线检查失败', 'err');
      return;
    }
    brokenScan.value = res;
    // 默认选中：推荐项优先，否则分最高的一条（分数已由纯函数排好序）
    const pick = {};
    for (const d of res.dangling) {
      const list = res.suggestions[d.id] || [];
      const best = list.find(c => c.recommended) || list[0];
      if (best) pick[d.id] = best.sourcePath;
    }
    relinkChoice.value = pick;
    if (silent) return;
    if (res.clean) setTip(`未发现断线：${res.notes} 篇笔记全部对得上`, 'ok');
    else setTip(`发现 ${res.dangling.length} 处断线，确认候选后点「重连」`, 'warn');
  } finally {
    scanning.value = false;
  }
}

/** 把一条断线重连到选中的笔记（id 不变 → 坐标与编辑成果保留），完成后刷新清单并保留回执 */
async function doRelink(d) {
  const target = relinkChoice.value[d.id];
  if (!target) return;
  const res = proj.relinkEntity(d.id, { sourcePath: target });
  if (res.success) {
    // 先静默重查（把刚处理掉的那条从清单里去掉），再写回执 —— 顺序反了回执就被覆盖
    await doScanBrokenLinks({ silent: true });
    setTip(`已把「${d.name}」重连到 ${res.to}（id 与坐标、地图/区域/建筑内部数据都保留；Ctrl+Z 可撤销）`, 'ok');
  } else {
    setTip(res.error || '重连失败', 'err');
  }
}

/** 候选理由文案（走纯函数单源，UI 不另写一套措辞） */
function describeCand(c) {
  return describeCandidate(c);
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

/**
 * Git 快照（显式触发，从不自动提交）。
 * ⚠️ 司天**不会**替用户 `git init`：把整个项目目录变成仓库要额外维护一套仓库与提交历史，
 *    属用户自己的选择（后期也可以装 Obsidian/司天 的 git 备份插件）。目录不是 git 仓库时，
 *    主进程返回 skipped + 原因，这里原样告诉用户「怎么才能用」。
 */
async function doGitSnapshot() {
  const res = await proj.gitSnapshot('司天快照');
  if (res && res.success) setTip('已提交一次 git 快照', 'ok');
  else if (res && res.skipped) setTip(`${res.reason} —— 如需 git 备份：在项目目录里自行 git init（司天不会自动初始化仓库）`, 'err');
  else setTip((res && res.error) || 'Git 快照失败', 'err');
}

async function doReveal() {
  const res = await proj.revealProject();
  if (!res || !res.success) setTip((res && res.error) || '定位失败', 'err');
}

/**
 * 关闭项目。**先保存、再关闭**（数据安全）：
 * 未落盘的改动若被静默丢弃，用户无从知道那些手绘时间去哪了 —— 所以
 * ① 有改动 → 先保存（projectStore 内部 flush），保存成功才关；
 * ② 保存失败 → **拒绝关闭**并把原因显示出来（数据仍在内存，可重试保存 / 先备份）。
 */
async function doClose() {
  setTip('正在保存并关闭…');
  const res = await proj.closeProject();
  if (!res || res.success !== true) {
    setTip((res && res.error) || '关闭失败（未保存的改动已保留）', 'err');
    return;
  }
  selectedId.value = '';
  cancelRename();
  pendingDelete.value = null;
  setTip(res.saved ? '已保存并关闭项目' : '项目已关闭', 'ok');
}

// ── 实体树：选中 / 改名 / 删除 / 拖动改父级 ────────────────────────────────
// 三个操作全部走 `projectStore`（内部走 undo.js 的 execute），因此都可用 Ctrl+Z 撤销，
// 且本组件不碰 IPC / 文件系统（接线属 Phase 2.4）。

function select(row, ev) {
  const additive = !!(ev && (ev.ctrlKey || ev.metaKey));
  if (additive) {
    const list = selectedIds.value.includes(row.id)
      ? selectedIds.value.filter(id => id !== row.id)
      : [...selectedIds.value, row.id];
    selectedIds.value = list;
    selectedId.value = list.includes(row.id) ? row.id : (list[list.length - 1] || '');
  } else {
    selectedIds.value = [row.id];
    selectedId.value = row.id;
  }
  pendingDelete.value = null;
}

function clearMulti() {
  selectedIds.value = selectedId.value ? [selectedId.value] : [];
  batchParentId.value = '';
}

/** 批量改父级的候选父级：对所有选中实体取「合法父级」的交集 */
const batchParentOptions = computed(() => {
  if (selectedIds.value.length < 2) return [];
  let cand = null;
  for (const id of selectedIds.value) {
    const ids = proj.parentCandidates(id).map(e => e.id);
    cand = cand === null ? new Set(ids) : new Set([...cand].filter(x => ids.includes(x)));
  }
  return cand ? proj.entityList.filter(e => cand.has(e.id)) : [];
});

/** 批量改父级（一条 undo）：把选中的多个实体挂到同一父级下 */
function doBatchMove() {
  const ids = selectedIds.value.slice();
  if (ids.length < 2) return;
  const target = batchParentId.value;
  const targetName = target ? (proj.getEntity(target)?.name || target) : '顶层';
  const res = proj.moveEntities(ids, target || null);
  if (!res.success) return setTip(res.error || '批量改父级失败', 'err');
  const moved = (res.moved || []).length;
  setTip(moved
    ? `已把 ${moved} 个实体移到「${targetName}」（Ctrl+Z 可撤销）`
    : `这 ${ids.length} 个实体已经在「${targetName}」下了`, 'ok');
}

// ── 叙事状态徽标（2026-09-24）────────────────────────────────────────────────
// 用户决策：毁灭只是叙事状态，实体保留 + 状态标记（不建实体的情况走「底图自持高度图」）。
// 只对非 active 显示徽标：正常状态满屏标一遍是噪音。
import { resolveStatus, statusBadge, statusMeta, DEFAULT_STATUS } from '../utils/entityStatus';

function hasNonDefaultStatus(row) {
  return !!(row && resolveStatus(row.status) !== DEFAULT_STATUS);
}
function rowStatusBadge(row) { return statusBadge(row && row.status); }
function rowStatusHint(row) { return statusMeta(row && row.status).hint; }

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
    // R7：连带清掉的地图 / 区域 / 建筑内部数据要**说出来**（静默删数据是本项目最忌讳的一类）
    const cleaned = res.cleanedData
      ? `，并清理了它名下的 ${res.cleanedData} 份地图/区域/内部数据` : '';
    setTip(`已删除「${pd.name}」${pd.kids ? `及 ${pd.kids} 个子实体` : ''}${cleaned}（Ctrl+Z 可撤销）`, 'ok');
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
  selectedIds.value = [entity.id];
  nextTick(() => {
    const row = document.querySelector('.project-panel .pp-node-row.sel');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  });
  // 直达画布：项目面板不 import geodata（test_48 静态守），经 canvasBridge 的注册口请求画布切视图
  const nav = gotoEntity(entity.id);
  if (nav && nav.ok) {
    setTip(`已选中「${entity.name}」并把画布切到${nav.viewLabel || nav.view}：可在下方改父级、用行内铅笔改名或删除`, 'ok');
  } else {
    setTip(`已选中「${entity.name}」（画布未能定位：${(nav && nav.error) || '未知原因'}）`
      + '；可在下方改父级、用行内铅笔改名或删除', 'err');
  }
}

function doRestore(s) {
  const res = proj.restoreProjectSnapshot(s.index);
  setTip(res.success ? `已回滚到「${s.label || '快照 ' + (s.index + 1)}」（可用 Ctrl+Z 撤销；地形高度图不在快照范围内，未被改动）` : (res.error || '回滚失败'),
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
/* 「项目名称」整行都是点击区（面板刚打开时用户不用精确点中 24px 高的输入框） */
.pp-name-row { cursor: text; }
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
/* 聚焦必须**看得见**：浅色卡面上只改 border 颜色太弱（用户会以为没点中）→ 加深色描边 */
.pp-input:focus {
  outline: 2px solid #2f5fd0;
  outline-offset: 1px;
  border-color: #2f5fd0;
  background: #ffffff;
}
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
/* 「新建并导入知识库内容」的说明：要写清「会导入什么」，不能只留一个按钮 */
.pp-seed {
  white-space: normal;
  line-height: 1.5;
  margin: 4px 0 2px;
  color: #1c4fa1;
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
.pp-tip.warn { color: #8a5a00; border-color: #8a6a2a; background: rgba(230, 180, 60, 0.12); }

/* ── R15/A-0：笔记改名断线清单 ─────────────────────────────────────────
   每条断线 = 一块（实体名 + 原路径 + 候选下拉 + 「重连」按钮）。
   候选的**理由**直接写在下拉选项文本里（措辞与纯函数同源），不另加小字 —— 面板本来就窄。 */
.pp-broken-clean { font-size: 11.5px; color: #1b6b3a; }
.pp-broken {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid #d29922;
  border-radius: var(--radius-sm);
  background: rgba(210, 153, 34, 0.10);
}
.pp-broken-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px;
  border-left: 3px solid #d29922;
  border-radius: var(--radius-sm);
  background: var(--planet-btn-bg);
}
.pp-broken-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.pp-broken-cand { display: flex; gap: 6px; align-items: center; }
.pp-broken-cand select {
  flex: 1;
  min-width: 0;
  padding: 3px 5px;
  font-size: 11.5px;
  color: var(--planet-text);
  background: var(--planet-btn-bg);
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
}
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
/* 多选（Ctrl/⌘ 点击）：比单选更明显的整体高亮，方便确认「要归位的是哪几个」 */
.pp-node-row.multi { background: rgba(47, 95, 208, 0.14); box-shadow: inset 2px 0 0 #2f5fd0; }
.pp-batch {
  margin: 6px 0 0;
  padding: 8px;
  border: 1px solid #2f5fd0;
  border-radius: 5px;
  background: rgba(47, 95, 208, 0.06);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.pp-batch-count { font-size: 11px; color: #1c4fa1; font-weight: 600; }
.pp-batch-hint { flex-basis: 100%; font-size: 10px; color: #1c4fa1; opacity: 0.85; }
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
/* 叙事状态徽标（2026-09-24）
   ⚠️ 类名必须与既有的 `.pp-status`（当前项目状态区，见模板第 16 行）**错开** ——
      同名会让我的 padding/边框/背景套到那个区块上，把 `.pp-status-sub` 的对比度打下去（test_58 抓到）。
   ⚠️ 面板是**浅色卡面**：强调色必须用深色 —— 浅色系在白底上对比度只有 1.4~1.6 = 看不见 */
.pp-status-badge {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10.5px;
  font-weight: 600;
  color: #8a4b00;
  background: rgba(210, 153, 34, 0.18);
  border: 1px solid rgba(210, 153, 34, 0.45);
  white-space: nowrap;
  flex-shrink: 0;
}
/* ── A-3 中文点选糙版：行内类型下拉 + 只看空白过滤 ─────────────────────────
   面板是浅色卡面：控件底色用主题变量、文字继承 planet 文本色（与 .pp-parent 同一套） */
.pp-gap-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
}
.pp-gap-filter {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--planet-text);
  background: var(--planet-btn-bg);
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  padding: 1px 3px;
}
.pp-gap-count {
  font-size: 10px;
  color: var(--planet-text-secondary);
  white-space: nowrap;
}
.pp-type {
  flex: 0 1 auto;
  min-width: 44px;
  max-width: 88px;
  font-size: 10.5px;
  color: var(--planet-text);
  background: var(--planet-btn-bg);
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  padding: 0 2px;
}
.pp-type:disabled,
.pp-gap-filter:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
