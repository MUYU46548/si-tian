// utils/saveStatusText.js — 「保存到底成没成」的唯一文案判定（2026-10-17）
//
// ── 要解决的问题 ─────────────────────────────────────────────────────────────
// 项目态（`.sitian`）下保存是**两段**的：
//   ① geodata 把画布改动**推给 projectStore**（返回 `{ staged: true, persisted: false }`）
//   ② projectStore 的 800ms 防抖把项目**写进磁盘**（成功才 `saveStatus = 'saved'`）
// 只要有一处把 ① 当成"存好了"，界面就会在最不该乐观的时刻乐观：
//   · 行星图「保存地图」看 `result.success` 就报「**保存成功**」—— 项目态下事实是"还在内存里"；
//   · 底部状态栏只在 ② 有变化时才动，① 与"有改动还没落盘"这段**完全看不见**。
// 暮雨的要求是「保存诚实显示（项目模式 staged/persisted 差异）」—— 本文件就是这层判定，
// 供 `composables/useSaveDisplay`（视图 chip / 状态栏）与各视图的单次保存回执共用。
//
// ⚠️ 纯函数：无 store / 无 DOM，Node 有单测（`scripts/tests/unit/test_save_status_text.js`）。

/** 失败原因在 chip 上的截断长度（放不下长错误；全文走 title） */
export const SAVE_ERR_MAX = 60;

const REASON_FALLBACK = '未知原因';

function cutReason(raw) {
  const full = String(raw == null || raw === '' ? REASON_FALLBACK : raw);
  return {
    text: full.length > SAVE_ERR_MAX ? full.slice(0, SAVE_ERR_MAX) + '…' : full,
    title: full,
  };
}

/**
 * 单次保存动作的返回值 → 显示。
 *
 * 判据用**返回值自己声明的语义**，不猜：
 *   · `persisted === true` → 真进磁盘了；
 *   · `staged === true`（且没 persisted）→ 只是交给项目，还在等磁盘；
 *   · 两者都没有（legacy：直接写 scenarios.json / 地图文件的旧路径）→ 旧行为，报「已保存」。
 * @param {{success?:boolean, staged?:boolean, persisted?:boolean, error?:string}} [result]
 * @returns {{state:string, kind:string, text:string, title:string}}
 */
export function describeSaveAction(result) {
  const r = result || {};
  if (r.success === false) {
    const c = cutReason(r.error);
    return { state: 'error', kind: 'err', text: `保存失败：${c.text}`, title: `保存失败：${c.title}` };
  }
  if (r.persisted === true) {
    return { state: 'saved', kind: 'ok', text: '已保存到磁盘', title: '' };
  }
  if (r.staged === true) {
    return {
      state: 'staged',
      kind: 'warn',
      text: '已交给项目，正在写入磁盘…',
      title: '改动已交给项目；真正的磁盘写入由项目的自动保存完成（约 1 秒内）。'
        + '失败会在底部状态栏常驻显示原因',
    };
  }
  return { state: 'saved', kind: 'ok', text: '已保存', title: '' };
}

/**
 * 组合全局保存状态 —— 底部状态栏与各视图的保存 chip 都只调这一个函数。
 *
 * 优先级（从重到轻）：
 *   ① 项目落盘失败（`project.saveState.kind === 'err'`）—— 数据**没进磁盘**，最重；
 *   ② 画布侧失败（`canvas.status === 'error'`）—— 连"交给项目"都没成；
 *   ③ 正在写入磁盘 / 正在交给项目；
 *   ④ **有改动未落盘**（`project.pending`，即 `dirty`）—— 旧的诚实缺口就在这里；
 *   ⑤ 「已交给项目，待写入」；
 *   ⑥ 已保存到磁盘；
 *   ⑦ 其余 → 空闲（显示「自动保存」）。
 *
 * @param {{project?:{saveState?:object|null, pending?:boolean, lastSavedAt?:string},
 *          canvas?:{status?:string, error?:string}}} [input]
 * @returns {{state:string, kind:string, text:string, title:string}}
 */
export function resolveSaveDisplay(input) {
  const { project = {}, canvas = {} } = input || {};
  const s = project.saveState || null;
  const savedAt = project.lastSavedAt ? `最后保存：${project.lastSavedAt}` : '';

  // ① 项目落盘失败（含原因，不自动消失 —— 由下一次成功保存来清）
  if (s && s.kind === 'err') {
    const c = cutReason(s.title || s.text);
    return { state: 'error', kind: 'err', text: `保存失败：${c.text}`, title: `保存失败：${c.title}` };
  }
  // ② 画布侧失败（推给项目这一步 / legacy 直写文件）
  if (canvas.status === 'error') {
    const c = cutReason(canvas.error);
    return { state: 'error', kind: 'err', text: `保存失败：${c.text}`, title: `保存失败：${c.title}` };
  }
  // ③ 进行中
  if (s && s.kind === 'busy') return { state: 'saving', kind: 'busy', text: '正在写入磁盘…', title: '' };
  if (canvas.status === 'saving') return { state: 'saving', kind: 'busy', text: '正在交给项目…', title: '' };
  // ④ 有改动还没落盘（项目态 dirty）—— "已保存"的绿标不能停在这里
  if (project.pending) {
    return {
      state: 'staged',
      kind: 'warn',
      text: '有改动待写入磁盘…',
      title: '内存里还有未进磁盘的改动（自动保存约 1 秒内触发）',
    };
  }
  // ⑤ 已交给项目、等待写入
  if (s && s.kind === 'warn') {
    return { state: 'staged', kind: 'warn', text: s.text || '已交给项目，待写入磁盘…', title: s.title || '' };
  }
  if (canvas.status === 'staged') {
    return {
      state: 'staged',
      kind: 'warn',
      text: '已交给项目，正在写入磁盘…',
      title: '画布改动已交给项目；磁盘写入由项目的自动保存完成',
    };
  }
  // ⑥ 成功
  if (s && s.kind === 'ok') {
    return { state: 'saved', kind: 'ok', text: s.text || '已保存到磁盘', title: s.title || savedAt };
  }
  if (canvas.status === 'saved') {
    return { state: 'saved', kind: 'ok', text: '已保存', title: savedAt };
  }
  return { state: 'idle', kind: 'idle', text: '自动保存', title: savedAt };
}
