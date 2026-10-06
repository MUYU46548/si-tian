// store/projectStore.js — `.sitian` 项目级 store（Phase 1：独立运行基础）
//
// 与 `store/geodata.js` 的关系（**Phase 1 刻意不接线**，避免改坏现有 Obsidian 链路）：
//   geodata  = 从 Obsidian 库提取的节点/坐标（现有唯一事实源，本阶段不动）
//   project  = 司天自己的项目文件（新建），Phase 2 才把七层视图切到它上面
// 本阶段任何组件都不 import 本 store，所以新增它对现有运行路径零影响。
//
// 纪律：
//   · 所有数据修改走 `undo.js` 的 execute()（redo 内写入，防双写铁律）
//   · 结构解释只走 `utils/projectSchema.js`（本文件不重复实现校验/快照算法）
//   · 磁盘 I/O 只走 `window.sitianAPI.project*`（主进程 projectHandler）

import { ref, computed, watch } from 'vue';
import { defineStore } from 'pinia';
import { execute, clearHistory } from './undo';
// 单一写闸门（Phase 2）：打开项目 = 切到 'project' 写模式；关闭 = 回到无项目默认模式
import { setWriteMode, resetWriteMode } from './writeGate';
// 画布接线（Phase 2.4）：打开/保存/关闭项目时驱动 geodata 侧切换事实源。
// 反向依赖也是经本注册表（geodata 不 import 本文件），无循环。
import { getCanvasAdapter, setProjectSink, setImportHandler } from './canvasBridge';
// 退出前落盘（数据安全）：注册到中立注册表（App 只跟注册表打交道，不 import 本 store）
import { registerFlush } from './quitFlush';
// B5（2026-09-24）：保存状态同步到底部**常驻**状态栏 —— 项目面板可能是关着的，
// 用户不能只在打开面板时才知道落盘失败。
import { setSaveState } from '../composables/useStatusBar';
// R15/A-0（2026-09-27）：笔记改名断线检测与重连 —— 纯函数与候选打分在 utils/vaultRelink.js
import { detectBrokenLinks, normalizeRelPath, baseNameOf } from '../utils/vaultRelink';
import {
  createEmptyProject,
  createEntity as createEntityShape,
  validateProject,
  migrateProject,
  pushSnapshot,
  restoreSnapshot as restoreSnapshotState,
  snapshotSummaries,
  snapshotState,
  snapshotStateWithHeavy,
  projectStats,
  entityIdFromName,
  forbiddenParentIds,
  LAYER_LABELS,
  LAYER_ORDER,
  SNAPSHOT_DIFF_KEYS,
  // 跨 IPC 载荷的统一下载口（去 Vue 代理 / TypedArray 兜底）—— 见下方 saveProject 注释
  toIpcPlain,
} from '../utils/projectSchema';

const AUTO_SAVE_DELAY = 800;
const API_MISSING = '项目文件 API 不可用（请用 Electron 运行：npm run dev:watch）';

export const useProjectStore = defineStore('project', () => {
  // ===== 状态 =====
  const project = ref(null);          // 当前项目（schema 见 utils/projectSchema.js）
  const filePath = ref('');           // 项目文件绝对路径（'' = 尚未落盘/未打开）
  const projectDir = ref('');         // 项目所在目录（创建/列表用）
  const availableProjects = ref([]);  // 目录下的 .sitian 文件列表
  const saveStatus = ref('idle');     // 'idle' | 'saving' | 'saved' | 'error'
  const lastSavedAt = ref('');
  const lastError = ref('');
  const dirty = ref(false);

  // ===== 计算属性 =====
  const isOpen = computed(() => !!project.value);
  const meta = computed(() => (project.value && project.value.meta) || null);
  const entities = computed(() => (project.value && project.value.entities) || {});
  const entityCount = computed(() => Object.keys(entities.value).length);
  const snapshots = computed(() => snapshotSummaries(project.value));
  const stats = computed(() => projectStats(project.value));

  // 实体列表（层级序 → 名称序）
  const entityList = computed(() => Object.values(entities.value).sort((a, b) => {
    const d = LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer);
    if (d !== 0) return d;
    return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
  }));

  // 实体树（Phase 2 的实体浏览器直接用）
  const entityTree = computed(() => {
    const all = entities.value;
    const wrap = new Map();
    for (const e of Object.values(all)) wrap.set(e.id, { ...e, children: [] });
    const roots = [];
    for (const e of Object.values(all)) {
      const node = wrap.get(e.id);
      if (e.parentId && wrap.has(e.parentId)) wrap.get(e.parentId).children.push(node);
      else roots.push(node);
    }
    const sortRec = (list) => {
      list.sort((a, b) => {
        const d = LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer);
        return d !== 0 ? d : String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
      });
      list.forEach(n => sortRec(n.children));
    };
    sortRec(roots);
    return roots;
  });

  // ===== 内部工具 =====
  // 实体集变更 → 同步画布（唯一集中点）：
  //   面板侧的新建/改名/删除/移动、以及 undo/redo 都会替换 `entities` 对象 → 这里统一推给画布。
  //   若不作这一步，画布会与项目脱节，而画布下一次保存又会以画布为准写回项目（撤销被静默覆盖）。
  watch(entities, (list) => {
    const a = getCanvasAdapter();
    if (!a || typeof a.refreshEntities !== 'function') return;
    // ⚠️ 只在画布确实处于项目态时推：关闭项目会先 releaseProject（画布已还原知识库工作态）
    //    再清空 project.value —— 若此时还推一次空实体集，会把刚还原的 121 个知识库节点清成 0。
    if (typeof a.source === 'function' && a.source() !== 'project') return;
    try { a.refreshEntities(list); } catch (err) { console.warn('[project] 同步画布失败:', err); }
  }, { flush: 'sync' });   // 🔴 必须同步：默认 'pre' 是异步的 → 面板刚建好的实体还没推给画布时，
                           //    一次画布保存就会以"还没有它"的画布状态覆盖项目（真实数据丢失路径）

  // 注册「画布 → 项目」入水口（geodata 的 saveGeodata/saveMapData/saveScenarios 会调它）
  setProjectSink({ syncFromCanvas });

  // 注册「把知识库内容导入当前项目」实现（canvasBridge 第四条注册口）：
  // App.vue / 面板 只发请求，不 import 本 store（App 有静态闸门守这条）
  setImportHandler(importFromVault);

  function api() {
    return (typeof window !== 'undefined' && window.sitianAPI) ? window.sitianAPI : null;
  }

  // 保存状态 → 状态栏文案（B5）。'idle' 表示无待显示信息。
  const SAVE_STATE_TEXT = {
    saving: { kind: 'busy', text: '正在保存…' },
    saved: { kind: 'ok', text: '已保存' },
    staged: { kind: 'warn', text: '已交给项目，待写入' },
    error: { kind: 'err', text: '保存失败' },
  };

  /**
   * 更新保存状态。
   * 🔴 同时同步到**底部常驻状态栏**（B5，2026-09-24）：项目面板可能关着，
   *    用户在行星图里连着画几小时时完全看不出落盘失败。
   * ⚠️ `error` **不自动消失**（旧实现给 5s TTL，失败提示一闪而过等于没提示）——
   *    由下一次成功保存（'saved'/'idle'）来清。
   */
  function setSaveStatus(status, ttl = 0) {
    saveStatus.value = status;
    try {
      const s = SAVE_STATE_TEXT[status];
      setSaveState(s
        ? {
          ...s,
          title: status === 'error'
            ? (lastError.value || '未知原因')
            : (lastSavedAt.value ? `最后保存：${lastSavedAt.value}` : ''),
        }
        : null);
    } catch (e) { /* 非浏览器环境（Node 单测）忽略 */ }
    if (ttl > 0) {
      setTimeout(() => { if (saveStatus.value === status) saveStatus.value = 'idle'; }, ttl);
    }
  }

  // 从主进程返回值装载项目（统一做「迁移 → 校验 → 装载」）
  function adopt(payload) {
    const migrated = migrateProject(payload.project);
    if (!migrated.ok) {
      return { success: false, error: (migrated.problems || []).join('；') || '项目文件无法识别' };
    }
    project.value = migrated.project;
    filePath.value = payload.filePath || '';
    if (payload.dir) projectDir.value = payload.dir;
    else if (payload.filePath) projectDir.value = String(payload.filePath).replace(/[\\/][^\\/]+$/, '');
    dirty.value = false;
    lastSavedAt.value = migrated.project.meta.updated || '';
    lastError.value = '';
    // 有项目 → 允许写（写进项目文件）
    setWriteMode('project', `已打开项目：${migrated.project.meta.name}`);
    // 🔴 P3（2026-09-25）：**接管项目时清空 undo 栈**。
    //    undo 命令的 undo/redo 闭包捕获的是「它当时操作的那个数据对象」（上一个项目 / 知识库态的
    //    `nodes.value`、`baseMaps.value`…）。不清栈就会出现「在新项目里按 Ctrl+Z，把上一个项目
    //    （或知识库工作态）的形状回滚进来」—— 而画布此刻画的是新项目的数据，用户看到的是一次
    //    无法解释的改动（文档 P3 记的正是这条）。
    //    ⚠️ 只放在这里，**不要**下沉到 geodata 的 `applyProjectToCanvas`：那个函数还被
    //    `seedFromPayload`（导入知识库内容）复用来「重新装载一次画布」，放在那里会把刚入栈的
    //    导入命令一起清掉 —— 「导入 = 一条 undo」立刻失效（test_50 实测抓到）。
    clearHistory();
    // Phase 2.4 接线：画布切到项目文件（实体树/航道/地图/剧本），并保留关闭时的回退留底
    const adapter = getCanvasAdapter();
    if (adapter && typeof adapter.applyProject === 'function') {
      adapter.applyProject(project.value);
    }
    // 🔴 主进程的告警必须传出来（2026-09-24）：典型是「会话基线未能创建」——
    //    静默吞掉会让用户以为有回滚点。App.vue 不能 import 本 store（静态闸门），
    //    所以经全局事件转达（沿用 sitian:label-styles-changed 那套）。
    if (payload.baselineWarning) {
      try {
        window.dispatchEvent(new CustomEvent('sitian:project-warning', {
          detail: { message: payload.baselineWarning },
        }));
      } catch (e) { /* 非浏览器环境（Node 单测）忽略 */ }
    }
    return { success: true, problems: migrated.problems, steps: migrated.steps, baselineWarning: payload.baselineWarning || null };
  }

  /** 让画布重新装载当前项目（maps / 剧本 / 编辑器容器不在 watch(entities) 的同步范围内） */
  function applyProjectToCanvasNow() {
    const adapter = getCanvasAdapter();
    if (adapter && typeof adapter.applyProject === 'function') adapter.applyProject(project.value);
  }

  /**
   * 把知识库载荷**合并**进项目（只补缺、绝不覆盖项目里已有的东西）。
   * 与 seedFromPayload 的区别：seedFromPayload 是「以载荷为基底重建」（新建项目时用），
   * 本函数是「往已有项目里补」—— 直接用 seedFromPayload 会把用户已经画好的内容清掉。
   *
   * 🔴 **本函数就是搬家协议定的「读优先级」**（A-2，2026-09-27 定案）：
   *    已有实体的机器属性（`layer` / `parentId` / `placeType`）**以项目文件为准**；
   *    笔记里的 `层级` / `上层区域` / `地点类型` 只在**该实体第一次进项目**时当初始值。
   *    之后用户再改笔记里的字段，司天**不再采纳**（项目态下知识库的 add/unlink/change 事件
   *    同样被整条拦掉，见 geodata 的 `handleNodeUpdated`）—— 两处行为加起来才是完整语义。
   *
   *    ⚠️ **不许改成「先查新、缺失回落旧」**：并存观察期里旧值会在新值缺失时**静默顶替**，
   *    与 A1/M1b 的「一读行星那份 / 一写自己那份」是同一个静默分裂形态。
   *    判据在 `scripts/tests/cases/test_58_import_from_vault.py` 的机器属性段（c3）。
   *
   *    ⚠️ **「新笔记的首次进料」必须继续读字段 + 目录/后缀推断** —— 报告 ⑤「发现机制照旧」
   *    不能砍：发布场景里别人的笔记**根本没有**这些字段（暮雨 2026-09-27：「用户的笔记里
   *    根本不一定有这些字段，实际中就是当作没有处理」），只能靠推断兜住。
   *
   * @returns {{next: object, merged: object}}
   */
  function mergeVaultPayload(base, payload = {}) {
    const next = { ...base };

    const entities = { ...(base.entities || {}) };
    let addedEntities = 0;
    for (const [id, e] of Object.entries(payload.entities || {})) {
      if (entities[id]) continue;                 // 已存在 → 保留项目里的版本
      entities[id] = e;
      addedEntities += 1;
    }
    next.entities = entities;

    const lanes = [...(base.hyperlanes || [])];
    const seenLane = new Set(lanes.map(l => l && l.id));
    let addedLanes = 0;
    for (const l of (payload.hyperlanes || [])) {
      if (!l || seenLane.has(l.id)) continue;
      lanes.push(l); seenLane.add(l.id); addedLanes += 1;
    }
    next.hyperlanes = lanes;

    const maps = { ...(base.maps || {}) };
    const md = { ...(maps.mapData || {}) };
    let addedMaps = 0;
    for (const [k, v] of Object.entries((payload.maps && payload.maps.mapData) || {})) {
      if (md[k]) continue;                        // 项目里已有这张行星图 → 不动
      md[k] = v; addedMaps += 1;
    }
    maps.mapData = md;
    const ed = { ...(maps.editor || {}) };
    for (const [k, v] of Object.entries((payload.maps && payload.maps.editor) || {})) {
      if (ed[k] === undefined) ed[k] = v;
    }
    maps.editor = ed;
    next.maps = maps;

    const cur = base.scenarios || { version: 2, baseMaps: {}, scenarios: {} };
    const ps = payload.scenarios || {};
    const baseMaps = { ...(cur.baseMaps || {}) };
    let addedBaseMaps = 0;
    for (const [k, v] of Object.entries(ps.baseMaps || {})) {
      if (!baseMaps[k]) { baseMaps[k] = v; addedBaseMaps += 1; }
    }
    const scenarios = { ...(cur.scenarios || {}) };
    let addedScenarios = 0;
    for (const [k, v] of Object.entries(ps.scenarios || {})) {
      if (!scenarios[k]) { scenarios[k] = v; addedScenarios += 1; }
    }
    next.scenarios = { version: 2, baseMaps, scenarios };

    return { next, merged: { entities: addedEntities, hyperlanes: addedLanes, maps: addedMaps, baseMaps: addedBaseMaps, scenarios: addedScenarios } };
  }

  /**
   * 「导入知识库内容」（2026-09-22，用户实测反馈）：
   * 用户新建了空项目后**没有任何入口**把知识库既有内容带进来 —— 「新建并导入知识库内容」只覆盖新建那条路，
   * 而「重新提取」在项目态被正确拒绝（两套事实源混流）。本函数补上唯一的缺口：
   * 项目态下从打开项目时的知识库留底（`vaultSnapshot`，经适配器 `exportVaultPayload`）取数，
   * **只补缺不覆盖**，一条 undo，导入后立刻把项目重新装载到画布。
   */
  async function importFromVault({ includeMaps = true } = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const adapter = getCanvasAdapter();
    if (!adapter || typeof adapter.exportVaultPayload !== 'function') {
      return { success: false, error: '画布桥未就绪，无法读取知识库内容' };
    }
    let payload = null;
    try {
      payload = await adapter.exportVaultPayload({ includeMaps });
    } catch (err) {
      return { success: false, error: `读取知识库内容失败：${(err && err.message) || err}` };
    }
    if (!payload) {
      return { success: false, error: '取不到知识库内容（打开项目时知识库里没有数据）：请先关闭项目、确认知识库能正常显示，再重开项目' };
    }
    const { next, merged } = mergeVaultPayload(project.value, payload);
    const total = merged.entities + merged.hyperlanes + merged.maps;
    if (total === 0) return { success: true, merged, nothingNew: true };

    const before = project.value;
    execute({
      type: 'project-import-from-vault',
      label: `导入知识库内容（${merged.entities} 个词条）`,
      category: 'property',
      undo: () => { project.value = before; dirty.value = true; applyProjectToCanvasNow(); scheduleAutoSave(); },
      redo: () => { project.value = next; dirty.value = true; applyProjectToCanvasNow(); scheduleAutoSave(); },
    });
    return { success: true, merged };
  }

  /**
   * 检测「笔记改名 / 移动」造成的断线（R15 / A-0，2026-09-27）。**只读，不改任何数据。**
   *
   * 为什么项目态必须主动检测：项目打开后，知识库的 add/unlink 事件在渲染层被整条拦掉
   * （防两套事实源混流，见 geodata 的 `handleNodeUpdated`）→ 用户在 Obsidian 里改名，
   * 司天既不知道、也不提示；下次「导入知识库内容」就把新名当新实体补进来、旧实体成孤儿。
   * 这条检测把那个洞显式化：**断线清单 + 可解释的候选**（理由由 utils/vaultRelink.js 给出）。
   *
   * @returns {Promise<{success:boolean, checked?:number, dangling?:Array, unclaimed?:Array,
   *                    suggestions?:Object, clean?:boolean, error?:string}>}
   */
  async function scanBrokenLinks() {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const adapter = getCanvasAdapter();
    if (!adapter || typeof adapter.listVaultNotes !== 'function') {
      return { success: false, error: '画布桥未就绪，读不到知识库笔记清单' };
    }
    const res = await adapter.listVaultNotes();
    if (!res || !res.success) {
      return { success: false, error: (res && res.error) || '读取知识库笔记清单失败' };
    }
    const result = detectBrokenLinks({
      entities: Object.values(project.value.entities || {}),
      notes: res.notes || [],
    });
    return { success: true, vault: res.vault || '', ...result };
  }

  /**
   * 重连：把断线实体的**来源笔记**改指到新路径（R15 / A-0）。**id 保持不变。**
   *
   * 🔴 为什么 id 必须不变：坐标 `coordinate`、`mapData[planetId]`、`areaZones[regionId]`、
   *    `interiorData[buildingId]` …这些编辑成果**全部按 id 索引**。改 id 就得走 `changeNodeId`
   *    做级联迁移（9 个容器 + 4 个字典键，任一处漏登记就是幽灵引用）；而重连的语义本来就是
   *    「同一个地点，换了篇笔记在写它」—— **身份没变**，所以只改来源、不动身份，编辑成果天然全保留。
   *
   * 与 `renameEntity` 的区别：那个改的是司天里**显示的名字**，这个改的是**认亲依据**。
   * 与本函数配套的另一半是「加回来」：被改名的旧路径若还留着笔记，它只会出现在「无主」清单里，
   * 由用户决定是重连回去还是当新笔记导入 —— 机器不替人做这个决定。
   */
  function relinkEntity(id, { sourcePath = '', name = '' } = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const before = entities.value[id];
    if (!before) return { success: false, error: `实体「${id}」不存在` };
    const nextPath = normalizeRelPath(sourcePath);
    if (!nextPath) return { success: false, error: '缺少目标笔记路径' };
    if (normalizeRelPath(before.sourcePath) === nextPath) {
      return { success: false, error: '这篇笔记就是它当前的来源，无需重连' };
    }
    // 目标已被别的实体占用 → 拒绝（保持一对一；否则两个实体指向同一篇笔记，下次导入必然又乱）
    const holder = Object.values(entities.value).find(
      (e) => e.id !== id && normalizeRelPath(e.sourcePath) === nextPath,
    );
    if (holder) {
      return { success: false, error: `该笔记已经连到「${holder.name}」`, conflictId: holder.id };
    }
    const nextName = String(name || '').trim() || baseNameOf(nextPath) || before.name;
    const from = { ...before };
    // ⚠️ `id: before.id` 是**刻意显式写出来**的（虽然 `...before` 已含 id）：
    //    重连最容易被误改成"顺手把 id 也换成新名字派生的 id"，而那样做就要级联迁移全部编辑成果。
    //    test_75 的 f0 守卫据此断言「重连不改 id」。
    const to = { ...before, id: before.id, sourcePath: nextPath, name: nextName, origin: 'obsidian', updatedAt: new Date().toISOString() };
    // ⚠️ 只改 `project.value.entities` —— 画布同步由本 store 的 `watch(entities)` 统一推送
    //    （既有的 sync flush 通道）。这里**不要**调 `applyProjectToCanvasNow()`：
    //    那会整体重装画布并 `backToWorld()`，把正在行星图上干活的用户踢回世界选择页。
    const write = (fields) => {
      project.value = { ...project.value, entities: { ...project.value.entities, [id]: fields } };
      dirty.value = true;
      scheduleAutoSave();
    };
    execute({
      type: 'relink-note',
      label: `重连笔记「${nextName}」`,
      category: 'property',
      undo: () => write(from),
      redo: () => write(to),
    });
    return { success: true, id, name: nextName, from: from.sourcePath, to: nextPath };
  }

  /**
   * 画布 → 项目：把 geodata 导出的载荷并进项目态（**不直接落盘**，交给 scheduleAutoSave）。
   * 由 geodata 的 saveGeodata/saveMapData/saveScenarios 在 project 模式下调用。
   */
  function syncFromCanvas(payload = {}, reason = '') {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    project.value = mergeCanvasPayload(project.value, payload);
    dirty.value = true;
    scheduleAutoSave();
    return { success: true, reason, entities: Object.keys(payload.entities || {}).length };
  }

  /** 把画布载荷并进项目对象（纯函数式合并：返回新对象，保持响应式替换语义） */
  function mergeCanvasPayload(project, payload = {}) {
    if (!payload || (!payload.entities && !payload.hyperlanes && !payload.maps && !payload.scenarios)) return project;
    const next = { ...project };
    if (payload.entities) next.entities = { ...payload.entities };
    if (payload.hyperlanes) next.hyperlanes = payload.hyperlanes;
    if (payload.maps) next.maps = { ...(project.maps || {}), ...payload.maps };   // mapData + editor 逐键合并
    if (payload.scenarios) next.scenarios = payload.scenarios;
    return next;
  }

  // ===== 项目级 CRUD =====
  async function createProject({ name = '未命名项目', dir = '' } = {}) {
    const a = api();
    if (!a || !a.projectCreate) return { success: false, error: API_MISSING };
    const draft = createEmptyProject({ name });
    const res = await a.projectCreate({ name, dir, project: draft });
    if (!res || !res.success) return { success: false, error: (res && res.error) || '创建项目失败' };
    // 主进程会回显项目正文；旧版/第三方主进程不回显时用本地 draft 兜底（否则新建必然失败）
    return adopt(res.project ? res : { ...res, project: draft });
  }

  /**
   * 以当前知识库工作态为基底新建项目（「从知识库导入」）—— 终态下把既有内容带进项目文件的唯一路径。
   *
   * 🔴 顺序不能反：载荷必须在 `createProject` **之前**取。`adopt()` 会立刻
   * `adapter.applyProject()` 把画布换成空项目，之后画布上就导不出知识库内容了。
   * 顺带先跑 `prepareExport()` 补齐懒加载的行星地图（否则导出的 maps 是空的）。
   */
  async function createProjectFromVault({ name = '未命名项目', dir = '' } = {}) {
    const adapter = getCanvasAdapter();
    if (!adapter || adapter.source() !== 'vault' || typeof adapter.exportCanvas !== 'function') {
      return { success: false, error: '当前画布不是知识库状态（已打开项目？）——先关闭项目再导入' };
    }
    if (typeof adapter.prepareExport === 'function') {
      try {
        await adapter.prepareExport();
      } catch (err) {
        console.warn('[project] 导入前预加载行星地图失败（继续，maps 可能不全）:', err);
      }
    }
    const payload = adapter.exportCanvas();
    const created = await createProject({ name, dir });
    if (!created.success) return created;
    const seeded = seedFromPayload(payload);
    if (!seeded.success) return { ...created, success: false, error: seeded.error };
    return { ...created, seeded: seeded.counts };
  }

  /** 把一个画布载荷并进当前项目（实体树 / 航道 / 地图 / 编辑器容器 / 剧本），一条 undo。不落盘。 */
  function seedFromPayload(payload = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const before = project.value;
    const base = {
      ...project.value,
      entities: {},
      hyperlanes: [],
      maps: {},
      scenarios: { version: 2, baseMaps: {}, scenarios: {} },
    };
    const after = mergeCanvasPayload(base, payload);
    execute({
      type: 'project-import-from-vault',
      label: '从知识库导入',
      category: 'property',
      undo: () => { project.value = before; dirty.value = true; scheduleAutoSave(); },
      redo: () => { project.value = after; dirty.value = true; scheduleAutoSave(); },
    });
    // 地图 / 剧本 / 编辑器容器不在 watch(entities) 的同步范围内 → 显式让画布重新装载一次
    const adapter = getCanvasAdapter();
    if (adapter && typeof adapter.applyProject === 'function') adapter.applyProject(project.value);
    return {
      success: true,
      counts: {
        entities: Object.keys((after && after.entities) || {}).length,
        hyperlanes: ((after && after.hyperlanes) || []).length,
        maps: Object.keys(((after && after.maps) || {}).mapData || {}).length,
      },
    };
  }

  /**
   * 启动时恢复上次打开的项目（B4，2026-09-24）。
   *
   * 背景：每次启动都从「无项目 = 只读」开始，老用户每天第一件事都是去项目面板开项目。
   * ⚠️ 这里**只负责尝试**：没有记录 / 文件已被删除或移动 / 解析失败，一律返回失败，
   *    由调用方静默回落到只读 —— **绝不阻塞启动**（启动期报错是最糟的用户体验）。
   */
  async function restoreLastProject() {
    const a = api();
    if (!a || !a.projectGetLastPath) return { success: false, reason: 'no-api' };
    let p = '';
    try {
      const r = await a.projectGetLastPath();
      p = (r && r.success && r.path) || '';
      if (!p) return { success: false, reason: (r && r.missing) ? 'missing' : 'none' };
    } catch (e) {
      return { success: false, reason: 'ipc-failed' };
    }
    const res = await openProject(p);
    if (res && res.success) return { success: true, path: p };
    return { success: false, reason: (res && res.error) || 'open-failed', path: p };
  }

  async function openProject(path = '') {
    const a = api();
    if (!a || !a.projectOpen) return { success: false, error: API_MISSING };
    const res = await a.projectOpen(path);
    if (!res) return { success: false, error: '打开项目失败' };
    if (res.canceled) return { success: false, canceled: true };
    if (!res.success) return { success: false, error: res.error || '打开项目失败' };
    return adopt(res);
  }

  /**
   * 保存失败必须**看得见**（2026-10-06，T2 真机定位）。
   *
   * 旧实现只写 `lastError` + 状态栏 —— 但 `StatusBar.vue` 的根节点是 `v-if="state.visible"`，
   * **世界选择页（没有画布）里那条"保存失败"根本不在 DOM 中**。于是「导入过 → 看着有内容 →
   * 重开是空的」这套观感里，用户从头到尾**看不到任何报错**。
   * 这里复用 App.vue 已监听的全局告警通道（`sitian:project-warning`，与「会话基线未能创建」同路），
   * 任何视图下都能提示。同时落一条 `console.error`：真机演练/诊断脚本的日志里能直接抓到。
   */
  function reportSaveFailure(message) {
    const text = String(message || '未知原因');
    try { console.error('[project] 保存失败:', text); } catch (e) { /* 非浏览器环境忽略 */ }
    try {
      window.dispatchEvent(new CustomEvent('sitian:project-warning', {
        detail: { message: `项目保存失败：${text} —— 改动仍在内存里，未写入磁盘；请先解决再关闭窗口` },
      }));
    } catch (e) { /* 非浏览器环境（Node 单测）忽略 */ }
  }

  /** 保存项目（先追加一份快照，再落盘；主进程另存整文件备份） */
  async function saveProject({ label = '', keep } = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const a = api();
    if (!a || !a.projectSave) {
      // ⚠️ 旧实现这里**直接 return**（既不设 error 状态、也不提示）—— 属于静默失败，一并补上回音
      lastError.value = API_MISSING;
      setSaveStatus('error');
      reportSaveFailure(lastError.value);
      return { success: false, error: API_MISSING };
    }
    setSaveStatus('saving');
    try {
      // Phase 2.4：落盘前把画布当前状态并进项目（画布是用户看到的真相，项目文件必须与之一致）
      const adapter = getCanvasAdapter();
      const merged = (adapter && typeof adapter.exportCanvas === 'function')
        ? mergeCanvasPayload(project.value, adapter.exportCanvas())
        : project.value;
      const withSnapshot = pushSnapshot(merged, { label, keep });
      // 🔴 竞态守卫（2026-09-24）：`await` 期间用户可能继续编辑 —— `syncFromCanvas` 会把
      //    `project.value` 换成**新对象**并置 `dirty = true`。若返回后无条件回写 `withSnapshot`
      //    并清 dirty，那批新编辑会被旧快照覆盖、且此后 `scheduleAutoSave` 看到 dirty=false 不再保存
      //    = 静默丢数据（画布突然回退到保存前）。所以先记下「落盘时的项目引用」，
      //    返回后只在**未被改动**时才确认；已改动则保留新态、维持 dirty 并立刻重排一次保存。
      const snapshotOf = project.value;
      // 🔴 IPC 边界（2026-10-06 真机定位，T2）：**不能直接传 `project.value`**。
      //    `project.value` 是 Vue 的深响应式代理，`ipcRenderer.invoke` 用 V8 ValueSerializer，
      //    **遇 Proxy 一律抛 "An object could not be cloned."** → 每一次保存都失败（连空项目也存不下），
      //    于是 `.sitian` 文件永远停在新建时的空壳，用户重开当然是空的。
      //    项目文件本来就是 JSON（主进程就是 `JSON.stringify(project)` 写盘），所以这里先把载荷
      //    降级成"将要写进文件的那一份值"：既越过克隆边界，也保证内存与磁盘同形。
      //    同一坑在 `saveGeodata`/`saveMapData`/`saveScenarios` 早已处理，**只有这条路漏了**。
      const res = await a.projectSave({ filePath: filePath.value, project: toIpcPlain(withSnapshot) });
      if (!res || !res.success) throw new Error((res && res.error) || '写入失败');
      lastSavedAt.value = new Date().toISOString();
      if (project.value !== snapshotOf) {
        // 保存期间有新编辑：以内存为准，稍后再落一次盘（本次写入的内容已成为历史）
        dirty.value = true;
        setSaveStatus('saving');
        scheduleAutoSave();
        return { success: true, bytes: res.bytes, backupPath: res.backupPath, superseded: true };
      }
      project.value = withSnapshot;
      dirty.value = false;
      setSaveStatus('saved', 3000);
      return { success: true, bytes: res.bytes, backupPath: res.backupPath };
    } catch (err) {
      lastError.value = err.message || String(err);
      setSaveStatus('error');   // B5：失败态不自动消失，由下次成功保存来清
      reportSaveFailure(lastError.value);
      return { success: false, error: lastError.value };
    }
  }

  let autoSaveTimer = null;
  function scheduleAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      if (dirty.value) saveProject({ label: '自动保存' });
    }, AUTO_SAVE_DELAY);
  }

  async function flushSave() {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    if (dirty.value) return saveProject({ label: '退出前保存' });
    return { success: true, skipped: true };
  }

  /**
   * 关闭项目。**先落盘、再还原**（2026-09-21 数据安全加固）。
   *
   * 原实现直接 `releaseProject() + 清空` —— 若此刻 `dirty`（保存失败、或正处在 800ms 自动保存窗口里），
   * 未落盘的手绘改动被**静默丢弃**：画布回到知识库态，用户看不出刚刚那些编辑去哪了。
   * 现在：dirty → 先 flush；**保存失败则拒绝关闭**（项目保持打开、内存数据不丢），由调用方提示去处。
   * `{ force: true }` 供确知可丢弃的场景（如切库）使用。
   */
  async function closeProject({ force = false } = {}) {
    let saved = false;
    if (!force && project.value && dirty.value) {
      const res = await flushSave();
      if (!res || res.success !== true) {
        const why = (res && res.error) || lastError.value || '未知错误';
        lastError.value = why;
        setSaveStatus('error');   // B5：失败态不自动消失，由下次成功保存来清
        return {
          success: false,
          error: `还有未保存的改动，且保存失败（${why}）—— 项目**未关闭**，数据仍在内存里；请重试保存（工具栏「项目」→ 保存）或先「备份」再关`,
        };
      }
      saved = true;
    }
    // Phase 2.4：先让画布回到知识库工作态（恢复打开项目前的留底），再清项目内存态
    const adapter = getCanvasAdapter();
    if (adapter && typeof adapter.releaseProject === 'function') {
      try { adapter.releaseProject(); } catch (err) { console.warn('[project] 恢复画布失败:', err); }
    }
    project.value = null;
    filePath.value = '';
    dirty.value = false;
    lastError.value = '';
    setSaveStatus('idle');
    // 回到「无项目」默认模式：READONLY_WITHOUT_PROJECT=true 时即切换为只读（决策 1）
    resetWriteMode('项目已关闭');
    // P3（2026-09-25）：关闭项目后「撤销」不该回退到项目内的编辑 —— 那些闭包指向已下线的数据对象
    clearHistory();
    return { success: true, saved };
  }

  // 退出前落盘（数据安全承诺）：只有项目处于 dirty 才写（priority 10 = 排在画布之后）。
  registerFlush('project', async () => {
    if (!project.value || !dirty.value) return { success: true, skipped: true };
    return flushSave();
  }, 10);

  // ===== 文件系统侧（列表 / 目录 / 备份 / 定位）=====
  async function refreshProjectList(dir = '') {
    const a = api();
    if (!a || !a.projectList) return { success: false, error: API_MISSING };
    const res = await a.projectList(dir || projectDir.value);
    if (res && res.success) {
      availableProjects.value = res.items || [];
      if (res.dir) projectDir.value = res.dir;
    }
    return res || { success: false, error: '列出项目失败' };
  }

  async function chooseProjectDir() {
    const a = api();
    if (!a || !a.projectPickDir) return { success: false, error: API_MISSING };
    const res = await a.projectPickDir();
    if (!res || !res.success) return res || { success: false, error: '选择目录失败' };
    projectDir.value = res.dir;
    await refreshProjectList(res.dir);
    return res;
  }

  async function revealProject() {
    const a = api();
    if (!a || !a.projectReveal || !filePath.value) return { success: false, error: '没有可定位的项目文件' };
    return a.projectReveal(filePath.value);
  }

  async function backupNow() {
    const a = api();
    if (!a || !a.projectBackupNow || !filePath.value) return { success: false, error: '没有可备份的项目文件' };
    return a.projectBackupNow(filePath.value);
  }

  async function gitSnapshot(message = '司天快照') {
    const a = api();
    if (!a || !a.projectGitSnapshot || !filePath.value) return { success: false, error: '没有可提交的项目文件' };
    return a.projectGitSnapshot({ filePath: filePath.value, message });
  }

  /** 回滚到第 index 份快照（走 undo，可撤销） */
  function restoreProjectSnapshot(index, { includeMaps = false } = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const res = restoreSnapshotState(project.value, index);
    if (!res.ok) return res;
    const keys = includeMaps ? [...SNAPSHOT_DIFF_KEYS, 'maps'] : SNAPSHOT_DIFF_KEYS;
    // ⚠️ before 必须用**含重字段**的那份：快照不管理高度图/参考图（体积），
    //    若这里用裁剪过的 snapshotState，一次「回滚 + 撤销」就会把地形吃掉。
    const before = snapshotStateWithHeavy(project.value, keys);
    const after = { ...before, ...res.state };
    execute({
      type: 'project-restore-snapshot',
      label: `回滚到快照 ${index + 1}`,
      category: 'property',
      undo: () => { project.value = { ...project.value, ...before }; dirty.value = true; scheduleAutoSave(); },
      redo: () => { project.value = { ...project.value, ...after }; dirty.value = true; scheduleAutoSave(); },
    });
    return { success: true, at: res.at, label: res.label };
  }

  // ===== 实体 CRUD =====
  function getEntity(id) {
    return entities.value[id] || null;
  }

  function descendantsOf(id) {
    const out = [];
    const stack = [id];
    const all = entities.value;
    while (stack.length) {
      const cur = stack.pop();
      for (const e of Object.values(all)) {
        if (e.parentId === cur) { out.push(e.id); stack.push(e.id); }
      }
    }
    return out;
  }

  function childrenOf(id) {
    return Object.values(entities.value).filter(e => e.parentId === id);
  }

  /** 可作为某实体父级的候选（排除自身与后代 —— 防循环） */
  function parentCandidates(id = '') {
    if (!id) return entityList.value;
    const banned = new Set(forbiddenParentIds(entities.value, id));
    return entityList.value.filter(e => !banned.has(e.id));
  }

  function createEntity(input = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const entity = createEntityShape({
      ...input,
      existingIds: Object.keys(entities.value),
    });
    if (input.id && entities.value[input.id]) {
      return { success: false, error: `实体 id「${input.id}」已存在` };
    }
    if (entity.parentId && !entities.value[entity.parentId]) {
      return { success: false, error: `父实体「${entity.parentId}」不存在` };
    }
    execute({
      type: 'project-add-entity',
      label: `新建实体「${entity.name}」`,
      category: 'property',
      undo: () => {
        const { [entity.id]: _dropped, ...rest } = project.value.entities;
        project.value = { ...project.value, entities: rest };
        dirty.value = true; scheduleAutoSave();
      },
      redo: () => {
        project.value = { ...project.value, entities: { ...project.value.entities, [entity.id]: entity } };
        dirty.value = true; scheduleAutoSave();
      },
    });
    return { success: true, entity };
  }

  /**
   * 批量创建实体（B7，2026-09-24）—— **一条 undo**。
   *
   * 为什么必须批量化：`createEntity` 逐条调会生成 N 条 undo 记录 ——
   * 用户粘 30 个城市名，要按 30 次 Ctrl+Z 才能撤回；而真实建世界观本来就是「一次建一批」。
   * 语义：**每行一个名称**；空行忽略；与已有实体同名的**跳过并回报**（不静默吞掉）。
   * @param {string[]} names
   * @param {{parentId?: string|null, layer?: string}} opts
   */
  function createEntities(names = [], { parentId = null, layer = '' } = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const wanted = (Array.isArray(names) ? names : []).map(n => String(n || '').trim()).filter(Boolean);
    if (!wanted.length) return { success: false, error: '没有可创建的名称（每行一个）' };
    if (!layer) return { success: false, error: '请先选择层级' };
    if (parentId && !entities.value[parentId]) return { success: false, error: `父实体「${parentId}」不存在` };

    const existingIds = Object.keys(entities.value);
    const usedNames = new Set(Object.values(entities.value).map(e => e.name));
    const created = [];
    const skipped = [];
    for (const nm of wanted) {
      if (usedNames.has(nm)) { skipped.push(`${nm}（同名已存在）`); continue; }
      const entity = createEntityShape({ name: nm, layer, parentId, existingIds });
      existingIds.push(entity.id);
      usedNames.add(nm);
      created.push(entity);
    }
    if (!created.length) return { success: true, created, skipped, nothingNew: true };

    execute({
      type: 'project-add-entities',
      label: `批量新建 ${created.length} 个实体`,
      category: 'property',
      undo: () => {
        const ids = new Set(created.map(c => c.id));
        const rest = {};
        Object.entries(project.value.entities).forEach(([k, v]) => { if (!ids.has(k)) rest[k] = v; });
        project.value = { ...project.value, entities: rest };
        dirty.value = true; scheduleAutoSave();
      },
      redo: () => {
        const next = { ...project.value.entities };
        created.forEach(c => { next[c.id] = c; });
        project.value = { ...project.value, entities: next };
        dirty.value = true; scheduleAutoSave();
      },
    });
    return { success: true, created, skipped };
  }

  function updateEntity(id, patch = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const before = entities.value[id];
    if (!before) return { success: false, error: `实体「${id}」不存在` };
    if (patch.parentId !== undefined && patch.parentId) {
      if (!entities.value[patch.parentId]) return { success: false, error: `目标父实体「${patch.parentId}」不存在` };
      if (forbiddenParentIds(entities.value, id).includes(patch.parentId)) {
        return { success: false, error: '不能把实体移到自己或自己的后代下（会形成循环）' };
      }
    }
    const next = { ...before, ...patch, id: before.id, updatedAt: new Date().toISOString() };
    if (patch.layer && patch.layer !== before.layer) next.layerLabel = LAYER_LABELS[patch.layer] || patch.layer;
    const prevCopy = { ...before };
    execute({
      type: 'project-update-entity',
      label: `修改实体「${before.name}」`,
      category: 'property',
      undo: () => { project.value = { ...project.value, entities: { ...project.value.entities, [id]: prevCopy } }; dirty.value = true; scheduleAutoSave(); },
      redo: () => { project.value = { ...project.value, entities: { ...project.value.entities, [id]: next } }; dirty.value = true; scheduleAutoSave(); },
    });
    return { success: true, entity: next };
  }

  /** 重命名：**不改 id**（id 是身份，改名不得级联引用） */
  function renameEntity(id, name) {
    if (!name || !String(name).trim()) return { success: false, error: '名称不能为空' };
    return updateEntity(id, { name: String(name).trim() });
  }

  /** 删除实体（默认连带后代，一条 undo 整体恢复） */
  function deleteEntity(id, { cascade = true } = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    if (!entities.value[id]) return { success: false, error: `实体「${id}」不存在` };
    const doomed = cascade ? [id, ...descendantsOf(id)] : [id];
    const doomedSet = new Set(doomed);
    // 不连带时，子实体上提到被删实体的父级，避免产生悬空 parentId
    const before = {};
    for (const eid of doomed) before[eid] = entities.value[eid];
    const orphans = cascade ? [] : Object.values(entities.value)
      .filter(e => e.parentId === id)
      .map(e => ({ id: e.id, prev: { ...e }, next: { ...e, parentId: before[id].parentId || null } }));
    const make = () => {
      const rest = { ...project.value.entities };
      for (const eid of doomed) delete rest[eid];
      for (const o of orphans) rest[o.id] = o.next;
      // 悬空航道一并清除（否则校验会丢弃它们，用户会觉得"撤销没恢复"）
      const hyperlanes = (project.value.hyperlanes || []).filter(h => !doomedSet.has(h.fromId) && !doomedSet.has(h.toId));
      return { entities: rest, hyperlanes };
    };
    const after = make();
    const prevEntities = { ...project.value.entities };
    const prevHyper = project.value.hyperlanes || [];

    // ── R7（2026-09-26）：孤儿数据 ─────────────────────────────────────────
    // 项目态下**画布才是 `mapData` / `editor` 的活副本** → 只删项目文件里的没用，
    // 下一次「画布 → 项目」保存会把画布那份原样写回去（症状：「删了行星，地图过一会儿又回来了」）。
    // 所以：redo 时让画布**清掉**这些 id 名下的数据，并把清出来的内容**暂存在本命令的闭包里**；
    // undo 时原样灌回。两半成对，撤销后数据不丢。
    const adapter = getCanvasAdapter();
    let stashedOrphanData = null;
    const pruneOrphanData = () => {
      stashedOrphanData = (adapter && typeof adapter.pruneData === 'function')
        ? adapter.pruneData(doomed) : null;
    };
    const restoreOrphanData = () => {
      if (stashedOrphanData && adapter && typeof adapter.mergeData === 'function') {
        adapter.mergeData(stashedOrphanData);
      }
      stashedOrphanData = null;
    };

    execute({
      type: 'project-delete-entity',
      label: `删除实体「${before[id].name}」${doomed.length > 1 ? `（含 ${doomed.length - 1} 个子实体）` : ''}`,
      category: 'property',
      undo: () => {
        project.value = { ...project.value, entities: prevEntities, hyperlanes: prevHyper };
        restoreOrphanData();
        dirty.value = true; scheduleAutoSave();
      },
      redo: () => {
        project.value = { ...project.value, entities: after.entities, hyperlanes: after.hyperlanes };
        pruneOrphanData();
        dirty.value = true; scheduleAutoSave();
      },
    });
    // 命令的首次执行 = redo（execute 内部会调）→ 此刻暂存内容已就位，报告清理了几份
    const cleaned = stashedOrphanData
      ? Object.entries(stashedOrphanData).reduce((n, [, v]) => n + Object.keys(v).length, 0) : 0;
    return { success: true, deleted: doomed, orphaned: orphans.map(o => o.id), cleanedData: cleaned };
  }

  function moveEntity(id, newParentId) {
    return updateEntity(id, { parentId: newParentId || null });
  }

  /**
   * 批量改父级（**一条** undo）：把多个实体挂到同一父级下。
   * 用途：把散落在行星下的设施/地点一次性归入城市或区域（用户反馈「建筑物散落在行星图上」）。
   * 校验：目标父级存在；不得把实体移到自己或自己的后代下（防循环）；已在目标下的实体跳过。
   * @returns {{ success: boolean, moved?: string[], unchanged?: string[], error?: string }}
   */
  function moveEntities(ids, newParentId) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const list = Array.from(new Set((ids || []).filter(Boolean)));
    if (!list.length) return { success: false, error: '没有选中实体' };
    const target = newParentId || null;
    if (target && !entities.value[target]) return { success: false, error: `目标父实体「${target}」不存在` };

    const unchanged = [];
    for (const id of list) {
      const e = entities.value[id];
      if (!e) return { success: false, error: `实体「${id}」不存在` };
      if ((e.parentId || null) === target) { unchanged.push(id); continue; }
      if (target && (target === id || forbiddenParentIds(entities.value, id).includes(target))) {
        return { success: false, error: `不能把「${e.name}」移到自己或自己的后代下（会形成循环）` };
      }
    }
    const moved = list.filter(id => !unchanged.includes(id));
    if (!moved.length) return { success: true, moved: [], unchanged };

    const before = { ...project.value.entities };
    const after = { ...project.value.entities };
    const stamp = new Date().toISOString();
    for (const id of moved) after[id] = { ...after[id], parentId: target, updatedAt: stamp };
    execute({
      type: 'project-move-entities',
      label: `批量改父级（${moved.length} 个实体 → ${target ? before[target].name : '顶层'}）`,
      category: 'property',
      undo: () => { project.value = { ...project.value, entities: before }; dirty.value = true; scheduleAutoSave(); },
      redo: () => { project.value = { ...project.value, entities: after }; dirty.value = true; scheduleAutoSave(); },
    });
    return { success: true, moved, unchanged };
  }

  function setEntityCoordinate(id, x, y) {
    const nx = (typeof x === 'number' && isFinite(x)) ? x : null;
    const ny = (typeof y === 'number' && isFinite(y)) ? y : null;
    return updateEntity(id, { coordinate: { x: nx, y: ny } });
  }

  // ===== 航道 CRUD（项目内，与 geodata 的航道同形）=====
  function addHyperlane(fromId, toId, type = 'local') {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    if (!entities.value[fromId] || !entities.value[toId]) return { success: false, error: '航道端点实体不存在' };
    const lane = { id: `lane_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`, fromId, toId, type };
    execute({
      type: 'project-add-hyperlane',
      label: '新建航道',
      category: 'property',
      undo: () => { project.value = { ...project.value, hyperlanes: project.value.hyperlanes.filter(h => h.id !== lane.id) }; dirty.value = true; scheduleAutoSave(); },
      redo: () => { project.value = { ...project.value, hyperlanes: [...project.value.hyperlanes, lane] }; dirty.value = true; scheduleAutoSave(); },
    });
    return { success: true, hyperlane: lane };
  }

  function removeHyperlane(id) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const lane = (project.value.hyperlanes || []).find(h => h.id === id);
    if (!lane) return { success: false, error: '航道不存在' };
    // 走 execute 并在 redo 内写入（位移式重建，保持顺序稳定）
    const before = project.value.hyperlanes || [];
    const after = before.filter(h => h.id !== id);
    execute({
      type: 'project-remove-hyperlane',
      label: '删除航道',
      category: 'property',
      undo: () => { project.value = { ...project.value, hyperlanes: before }; dirty.value = true; scheduleAutoSave(); },
      redo: () => { project.value = { ...project.value, hyperlanes: after }; dirty.value = true; scheduleAutoSave(); },
    });
    return { success: true };
  }

  // ===== 导入/导出（Phase 1 只提供「装载外部实体列表」入口，供 Phase 2 的提取结果接入）=====
  /** 用一组「已校验的实体」替换/合并进当前项目（Phase 2 接 geodata 时调用） */
  function importEntities(list, { mode = 'merge' } = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const incoming = {};
    for (const raw of (list || [])) {
      const e = createEntityShape({ ...raw, existingIds: Object.keys(entities.value) });
      // schema 之外的编辑字段（placeType / wikilinks / population …）一并保留 ——
      // 导入知识库实体时丢掉它们同样不报错，只会让图标/搜索「提及」静默退化（见 geodata 的 entityExtras）
      for (const [k, v] of Object.entries(raw || {})) {
        if (k === 'draft' || k in e) continue;
        e[k] = v;
      }
      incoming[e.id] = e;
    }
    const before = { ...project.value.entities };
    const after = mode === 'replace' ? incoming : { ...project.value.entities, ...incoming };
    execute({
      type: 'project-import-entities',
      label: `导入 ${Object.keys(incoming).length} 个实体`,
      category: 'property',
      undo: () => { project.value = { ...project.value, entities: before }; dirty.value = true; scheduleAutoSave(); },
      redo: () => { project.value = { ...project.value, entities: after }; dirty.value = true; scheduleAutoSave(); },
    });
    return { success: true, imported: Object.keys(incoming).length, mode };
  }

  // 实体 id 推导（UI 预览用：输入名称即时看到 id）
  function previewEntityId(name) {
    return entityIdFromName(name, Object.keys(entities.value));
  }

  return {
    // state
    project, filePath, projectDir, availableProjects, saveStatus, lastSavedAt, lastError, dirty,
    restoreLastProject,
    createEntities,
    // computed
    isOpen, meta, entities, entityList, entityTree, entityCount, snapshots, stats,
    // project CRUD
    createProject, createProjectFromVault, seedFromPayload, openProject, saveProject, scheduleAutoSave, flushSave, closeProject,
    importFromVault, mergeVaultPayload,
    // R15/A-0：笔记改名断线检测 + 重连（id 不变 → 编辑成果保留）
    scanBrokenLinks, relinkEntity,
    refreshProjectList, chooseProjectDir, revealProject, backupNow, gitSnapshot, restoreProjectSnapshot,
    // entity CRUD
    getEntity, childrenOf, descendantsOf, parentCandidates, createEntity, updateEntity,
    renameEntity, deleteEntity, moveEntity, moveEntities, setEntityCoordinate, previewEntityId, importEntities,
    // 画布接线（Phase 2.4）：geodata 在 project 模式下把画布状态同步进来
    syncFromCanvas, mergeCanvasPayload,
    // hyperlanes
    addHyperlane, removeHyperlane,
    // constants
    LAYER_LABELS, LAYER_ORDER,
  };
});
