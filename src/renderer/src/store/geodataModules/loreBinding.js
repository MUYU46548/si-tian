// store/geodataModules/loreBinding.js — 读料桥的**写口**：节点 ↔ 笔记的稳定绑定 / 解绑 / 候选导入
// （N3a-3，2026-11-02）
//
// 为什么单独一个模块：`store/geodata.js` 已经 2100+ 行，而这三件事只碰 `nodes` + `execute`；
// 放进壳里会让本就最大的文件更难读（本仓的分模块口径见 geodata.js 的“领域子模块组装”）。
//
// ── 三条纪律 ────────────────────────────────────────────────────────────────
//   ① 每个写口**首行** `guardWrite()`（无项目 = 只读，拒绝时零副作用、并通过 writeGate 留回音）；
//      三个函数都登记在 `store/writeGate.js#MEMORY_WRITE_CALLSITES`（id 12）——
//      `test_54` 会**逐函数**读源码反查，漏登记或漏守卫都会红。
//   ② **一次操作 = 一条 undo**：数据写入只发生在 `execute()` 的 `redo()` 里（undo.js 的纪律：
//      调用前不许手动改数据，否则双写）。`importVaultCandidate` 的唯一写入点仍然是既有的
//      `addNode()`（一条 undo + 自动保存），**不写第二个建节点函数**（同一能力只许一份实现）。
//   ③ 拒绝要说人话：返回值一律 `{ ok, error }`（只读时多一个 `readOnly: true`），
//      UI 直接把 `error` 显示出来，绝不"点了没反应"。
//
// ── 与 `node.notePaths` 的关系（别混！）───────────────────────────────────
//   · `node.notePaths`（关联资料，NodeDetailPanel 的“+ 绑定笔记”）= **可挂多篇**、只存路径、
//     给"这篇设定的补充材料"用；它不参与改名对账。
//   · `node.lore`（本模块）= **主词条的那一篇**，带稳定身份快照 `{noteId,path,title,at,key,fingerprint}`，
//     供 `utils/loreBinding.js#reconcileBindings` 判"改名/失联"。
//   两种能力、两份字段，不是同一个东西的两套实现。
import { guardWrite } from '../writeGate';
import { candidateToNodeDraft, noteRefOf, sameNoteRef } from '../../utils/loreBinding';

/**
 * @param {{nodes: import('vue').Ref<Array>, execute: Function, scheduleAutoSave: Function,
 *          addNode: Function, layerLabels: Object<string,string>}} ctx
 */
export function createLoreBindingModule(ctx) {
  const { nodes, execute, scheduleAutoSave, addNode, layerLabels } = ctx;

  function findNode(nodeId) {
    return (nodes.value || []).find((n) => n && n.id === nodeId) || null;
  }

  /** redo/undo 共用的落点：按 id **重新查**节点（撤销顺序可能换过数组） */
  function applyLore(nodeId, value) {
    const node = findNode(nodeId);
    if (!node) return;
    if (value) node.lore = { ...value }; else delete node.lore;
  }

  /** 层级：只接受 `layerLabels` 里的 id 或它的中文标签；认不出 → 'unknown'（不猜） */
  function resolveLayer(raw) {
    const v = String(raw || '').trim();
    if (!v) return 'unknown';
    if (layerLabels && layerLabels[v]) return v;
    const id = Object.keys(layerLabels || {}).find((k) => layerLabels[k] === v);
    return id || 'unknown';
  }

  /**
   * 把节点绑到一篇库内笔记上（**一条 undo**）。
   *
   * @param {string} nodeId 画布节点 id
   * @param {{path?:string,title?:string,noteId?:string,sitianId?:string,aliases?:string[],
   *          key?:string,fingerprint?:string}} noteRef 搜索结果行 / 索引条目 / 已有绑定都行
   * @returns {{ok:true, nodeId:string, lore:object, replaced:object|null, unchanged?:boolean}
   *          | {ok:false, error:string, readOnly?:boolean}}
   */
  function bindNodeToNote(nodeId, noteRef) {
    const gate = guardWrite('绑定资料笔记');
    if (!gate.ok) return { ok: false, readOnly: true, error: gate.error };
    const node = findNode(nodeId);
    if (!node) return { ok: false, error: `节点不存在：${nodeId}` };
    const next = noteRefOf(noteRef || {}, new Date().toISOString());
    if (!next) return { ok: false, error: '笔记引用不完整（至少要一条路径或标题）——不予绑定，避免挂上空指针' };
    const prev = node.lore ? { ...node.lore } : null;
    if (prev && sameNoteRef(prev, next)) {
      // 重复绑同一篇：不进 undo（否则撤销栈里全是"没变化的操作"）
      return { ok: true, nodeId, lore: prev, replaced: prev, unchanged: true };
    }
    execute({
      type: 'bind-lore',
      label: '绑定资料笔记',
      category: 'property',
      undo: () => applyLore(nodeId, prev),
      redo: () => applyLore(nodeId, next),
    });
    scheduleAutoSave();
    return { ok: true, nodeId, lore: next, replaced: prev };
  }

  /**
   * 解除节点的笔记绑定（**一条 undo**）。
   * @param {string} nodeId
   * @returns {{ok:true, nodeId:string, unbound:object} | {ok:false, error:string, readOnly?:boolean}}
   */
  function unbindNodeNote(nodeId) {
    const gate = guardWrite('解绑资料笔记');
    if (!gate.ok) return { ok: false, readOnly: true, error: gate.error };
    const node = findNode(nodeId);
    if (!node) return { ok: false, error: `节点不存在：${nodeId}` };
    const prev = node.lore ? { ...node.lore } : null;
    if (!prev) return { ok: false, error: '该节点还没有绑定笔记' };
    execute({
      type: 'unbind-lore',
      label: '解绑资料笔记',
      category: 'property',
      undo: () => applyLore(nodeId, prev),
      redo: () => applyLore(nodeId, null),
    });
    scheduleAutoSave();
    return { ok: true, nodeId, unbound: prev };
  }

  /**
   * 把一条“读料候选”导入成草稿节点（**一条 undo**，复用 `addNode`）。
   *
   * 为什么是草稿：候选是**机器认出来的**，还没经过人确认；草稿节点虚线边框、可再编辑/转正，
   * 这正是"认不出/拿不准就交给人"的形状。`sourcePath` 直接写上 = 节点已经指向那篇笔记。
   *
   * 幂等：id 由绑定键派生（见 `utils/loreBinding.js#candidateToNodeDraft`），
   * 同一篇笔记导第二次会命中已存在的 id → **拒绝**并返回那个节点（不产生第二个）。
   *
   * @param {{path?:string,title?:string,layer?:string,layerHint?:string,sitianId?:string,aliases?:string[]}} candidate
   * @param {{layer?:string, parentId?:string|null}} [opts] `parentId` = 挂在哪个节点下（通常是当前选中的实体）
   * @returns {{ok:true, node:object} | {ok:false, error:string, readOnly?:boolean, already?:boolean, node?:object}}
   */
  function importVaultCandidate(candidate, opts = {}) {
    const gate = guardWrite('导入知识库候选');
    if (!gate.ok) return { ok: false, readOnly: true, error: gate.error };
    const c = candidate || {};
    const parentId = opts && opts.parentId ? String(opts.parentId) : null;
    if (parentId && !findNode(parentId)) return { ok: false, error: `上层节点不存在：${parentId}` };
    const layer = resolveLayer((opts && opts.layer) || c.layer || c.layerHint);
    const draft = candidateToNodeDraft(c, { layer, parentId });
    if (!draft) return { ok: false, error: '这条候选没有可用的名字或身份（无法生成稳定 id），未导入' };
    const exists = findNode(draft.id);
    if (exists) return { ok: false, already: true, node: exists, error: `已经导入过：节点“${exists.name}”` };
    // 唯一写入点 = 既有的 addNode（一条 undo + 自动保存）。这里只补上节点需要的显示字段。
    const node = addNode({
      ...draft,
      layerLabel: (layerLabels && layerLabels[draft.layer]) || draft.layer,
      coordinate: { x: null, y: null },
    });
    return { ok: true, node };
  }

  return { bindNodeToNote, unbindNodeNote, importVaultCandidate };
}
