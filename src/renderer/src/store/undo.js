// store/undo.js — 通用撤销/重做栈，所有编辑器共用
import { ref, computed } from 'vue';

// 命令结构
// {
//   type: string,      // 命令类型：'move-node' | 'add-terrain' | 'remove-terrain' | 'move-control-point' | ...
//   label: string,     // 人类可读描述（tooltip 用）
//   undo: () => void,
//   redo: () => void,
//   merge?: (prev) => boolean,  // 返回 true 时合并到前一条命令（用于拖拽连续操作）
// }

const past = ref([]);
const future = ref([]);
const MAX_HISTORY = 100;

export const canUndo = computed(() => past.value.length > 0);
export const canRedo = computed(() => future.value.length > 0);

// 获取最近一次操作的 label（用于 tooltip）
export function getLastCommandLabel() {
  return past.value.length ? past.value[past.value.length - 1].label : '';
}

// 执行新命令
export function execute(command) {
  command.redo();
  past.value.push(command);
  future.value = [];
  if (past.value.length > MAX_HISTORY) {
    past.value.shift();
  }
}

// 撤销
export function undo() {
  if (!past.value.length) return null;
  const cmd = past.value.pop();
  cmd.undo();
  future.value.unshift(cmd);
  return cmd;
}

// 重做
export function redo() {
  if (!future.value.length) return null;
  const cmd = future.value.shift();
  cmd.redo();
  past.value.push(cmd);
  return cmd;
}

// 清空历史
export function clearHistory() {
  past.value = [];
  future.value = [];
}

// 获取历史长度（调试用）
export function getHistorySize() {
  return { past: past.value.length, future: future.value.length };
}
