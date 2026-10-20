// utils/noteReader.js — 资料阅读器的全局入口（D2）
//
// 为什么用事件而不是全局 store：阅读器可以被任何组件（节点面板 / 搜索结果 / 标记编辑器）
// 唤起，但这些组件不该互相 import；一个 CustomEvent 就够，且便于 CDP 用例直接触发。
export const OPEN_NOTE_EVENT = 'sitian:open-note';
export const OPEN_NOTE_SEARCH_EVENT = 'sitian:open-note-search';

export function openNote(path) {
  if (!path) return false;
  window.dispatchEvent(new CustomEvent(OPEN_NOTE_EVENT, { detail: { path } }));
  return true;
}

export function openNoteSearch() {
  window.dispatchEvent(new CustomEvent(OPEN_NOTE_SEARCH_EVENT));
  return true;
}
