// store/undo.js — 通用撤销/重做历史，所有编辑器共用（E2 重构：线性历史数组 + 指针）
import { ref, computed } from 'vue';

// 命令结构
// {
//   type: string,      // 命令类型：'move-node' | 'add-terrain' | 'remove-terrain' | 'move-control-point' | 'add-hyperlane' | ...
//   label: string,     // 人类可读描述（tooltip/历史面板用）
//   undo: () => void,
//   redo: () => void,
//   merge?: (prev) => boolean,  // 返回 true 时合并到前一条命令（用于拖拽连续操作）
//   timestamp: number, // 时间戳
//   category: string,  // 分类：'coordinate' | 'hyperlane' | 'terrain' | 'region' | 'property' | 'marker'（B6/B7 太空实体）
// }

// E2: 由 past/future 双栈改为线性数组 + 指针，支持按索引跳转（撤销历史面板）
// 语义：pointer 指向"最后一条已应用"的命令索引；-1 = 初始态
const history = ref([]);
const pointer = ref(-1);
const MAX_HISTORY = 100;

export const canUndo = computed(() => pointer.value >= 0);
export const canRedo = computed(() => pointer.value < history.value.length - 1);

// E2: 历史面板需要的响应式状态
export const historyLength = computed(() => history.value.length);
export const currentIndex = computed(() => pointer.value);

// 获取最近一次操作的 label（用于 tooltip）
export function getLastCommandLabel() {
  return pointer.value >= 0 ? history.value[pointer.value].label : '';
}

// 获取历史记录（用于变更日志/历史面板），保持原有字段形状
export function getHistory() {
  return history.value.map((cmd, index) => ({
    index,
    type: cmd.type,
    label: cmd.label,
    timestamp: cmd.timestamp,
    category: cmd.category,
  }));
}

// 按类型筛选历史
export function getHistoryByType(category) {
  return getHistory().filter(cmd => cmd.category === category);
}

// 执行新命令（redo 是唯一写入点——调用前不要手动改数据，避免双写）
export function execute(command) {
  command.timestamp = Date.now();
  command.redo();
  // 在中间状态执行新命令 → 新建分支，丢弃"未来"
  if (pointer.value < history.value.length - 1) {
    history.value = history.value.slice(0, pointer.value + 1);
  }
  history.value.push(command);
  if (history.value.length > MAX_HISTORY) {
    history.value.shift();
  }
  pointer.value = history.value.length - 1;
}

// 撤销
export function undo() {
  if (!canUndo.value) return null;
  const cmd = history.value[pointer.value];
  cmd.undo();
  pointer.value -= 1;
  return cmd;
}

// 重做
export function redo() {
  if (!canRedo.value) return null;
  pointer.value += 1;
  const cmd = history.value[pointer.value];
  cmd.redo();
  return cmd;
}

// E2: 跳转到历史第 index 条命令（index = 跳转后"最后一条已应用"命令）
// 复用 undo/redo 语义，保证与单步撤销完全一致的数据回放
export function jumpTo(index) {
  const target = Math.max(-1, Math.min(index, history.value.length - 1));
  while (pointer.value > target) undo();
  while (pointer.value < target) redo();
  return pointer.value;
}

// 清空历史
export function clearHistory() {
  history.value = [];
  pointer.value = -1;
}

// 获取历史长度（调试用）
export function getHistorySize() {
  return { past: pointer.value + 1, future: history.value.length - 1 - pointer.value };
}
