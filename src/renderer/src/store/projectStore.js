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
import { execute } from './undo';
// 单一写闸门（Phase 2）：打开项目 = 切到 'project' 写模式；关闭 = 回到无项目默认模式
import { setWriteMode, resetWriteMode } from './writeGate';
// 画布接线（Phase 2.4）：打开/保存/关闭项目时驱动 geodata 侧切换事实源。
// 反向依赖也是经本注册表（geodata 不 import 本文件），无循环。
import { getCanvasAdapter, setProjectSink } from './canvasBridge';
// 退出前落盘（数据安全）：注册到中立注册表（App 只跟注册表打交道，不 import 本 store）
import { registerFlush } from './quitFlush';
import {
  createEmptyProject,
  createEntity as createEntityShape,
  validateProject,
  migrateProject,
  pushSnapshot,
  restoreSnapshot as restoreSnapshotState,
  snapshotSummaries,
  snapshotState,
  projectStats,
  entityIdFromName,
  forbiddenParentIds,
  LAYER_LABELS,
  LAYER_ORDER,
  SNAPSHOT_DIFF_KEYS,
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

  function api() {
    return (typeof window !== 'undefined' && window.sitianAPI) ? window.sitianAPI : null;
  }

  function setSaveStatus(status, ttl = 0) {
    saveStatus.value = status;
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
    // Phase 2.4 接线：画布切到项目文件（实体树/航道/地图/剧本），并保留关闭时的回退留底
    const adapter = getCanvasAdapter();
    if (adapter && typeof adapter.applyProject === 'function') {
      adapter.applyProject(project.value);
    }
    return { success: true, problems: migrated.problems, steps: migrated.steps };
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

  async function openProject(path = '') {
    const a = api();
    if (!a || !a.projectOpen) return { success: false, error: API_MISSING };
    const res = await a.projectOpen(path);
    if (!res) return { success: false, error: '打开项目失败' };
    if (res.canceled) return { success: false, canceled: true };
    if (!res.success) return { success: false, error: res.error || '打开项目失败' };
    return adopt(res);
  }

  /** 保存项目（先追加一份快照，再落盘；主进程另存整文件备份） */
  async function saveProject({ label = '', keep } = {}) {
    if (!project.value) return { success: false, error: '没有打开的项目' };
    const a = api();
    if (!a || !a.projectSave) return { success: false, error: API_MISSING };
    setSaveStatus('saving');
    try {
      // Phase 2.4：落盘前把画布当前状态并进项目（画布是用户看到的真相，项目文件必须与之一致）
      const adapter = getCanvasAdapter();
      const merged = (adapter && typeof adapter.exportCanvas === 'function')
        ? mergeCanvasPayload(project.value, adapter.exportCanvas())
        : project.value;
      const withSnapshot = pushSnapshot(merged, { label, keep });
      const res = await a.projectSave({ filePath: filePath.value, project: withSnapshot });
      if (!res || !res.success) throw new Error((res && res.error) || '写入失败');
      project.value = withSnapshot;
      dirty.value = false;
      lastSavedAt.value = new Date().toISOString();
      setSaveStatus('saved', 3000);
      return { success: true, bytes: res.bytes, backupPath: res.backupPath };
    } catch (err) {
      lastError.value = err.message || String(err);
      setSaveStatus('error', 5000);
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
        setSaveStatus('error', 5000);
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
    const before = snapshotState(project.value, keys);
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
    execute({
      type: 'project-delete-entity',
      label: `删除实体「${before[id].name}」${doomed.length > 1 ? `（含 ${doomed.length - 1} 个子实体）` : ''}`,
      category: 'property',
      undo: () => { project.value = { ...project.value, entities: prevEntities, hyperlanes: prevHyper }; dirty.value = true; scheduleAutoSave(); },
      redo: () => { project.value = { ...project.value, entities: after.entities, hyperlanes: after.hyperlanes }; dirty.value = true; scheduleAutoSave(); },
    });
    return { success: true, deleted: doomed, orphaned: orphans.map(o => o.id) };
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
    // computed
    isOpen, meta, entities, entityList, entityTree, entityCount, snapshots, stats,
    // project CRUD
    createProject, createProjectFromVault, seedFromPayload, openProject, saveProject, scheduleAutoSave, flushSave, closeProject,
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
