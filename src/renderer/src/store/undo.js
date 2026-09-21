// store/undo.js — 通用撤销/重做历史，所有编辑器共用（E2 重构：线性历史数组 + 指针）
import { ref, computed } from 'vue';
// 单一写闸门：只读态（无项目）下内存编辑同样拒绝，见 execute() 注释
import { guardWrite } from './writeGate';

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
// 语义：pointer 指向"最后一条已应用"命令索引；-1 = 初始态
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
// 🔴 只读态（无项目）：内存编辑同样拒绝（2026-09-21）——
//    改内存但不落盘 = 用户以为改成了、其实什么都没保存，比报错更坏。
//    拒绝时不碰数据、不进历史（零副作用），并通过 guardWrite 留下回音供 UI 提示。
//    ⚠️ 项目文件的生命周期操作（新建/打开/恢复快照）都在切到 project 模式之后才写内存，
//       因此不需要、也**不允许**在这里开后门（保持单一判定点）。
export function execute(command) {
  const label = (command && command.label) || '编辑数据';
  const gate = guardWrite(label);
  if (!gate.ok) return gate;
  command.timestamp = Date.now();
  // 合并连续相同类型操作（如笔刷拖拽）：保留最旧的 undo，用新的 redo 覆盖，避免堆栈爆炸
  if (command.merge && pointer.value >= 0) {
    const prev = history.value[pointer.value];
    if (command.merge(prev)) {
      command.undo = prev.undo; // 保留拖拽开始前的状态
      command.redo();           // 执行新状态的写入
      history.value[pointer.value] = command;
      return;
    }
  }
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

// ===== 网格快照撤销支持 =====
/**
 * 为网格编辑创建 undo 命令（单次笔刷 = 一次 undo）
 * 用法：在笔刷 stroke 开始前调用 beginGridSnapshot，stroke 结束时调用 endGridStroke
 * 
 * 模式：按下鼠标时保存快照，拖动时实时修改网格 + 渲染，抬起时压入 undo 栈
 */
const _gridStrokeState = new Map(); // gridRef -> { before: Uint8Array, type, label }

export function beginGridSnapshot(grid, type, label) {
  _gridStrokeState.set(grid, {
    before: new Uint8Array(grid),
    type,
    label,
  });
}

export function endGridStroke(grid, afterApply) {
  const state = _gridStrokeState.get(grid);
  if (!state) return;
  _gridStrokeState.delete(grid);
  
  const { before, type, label } = state;
  const after = new Uint8Array(grid);
  
  execute({
    type,
    label,
    undo: () => { grid.set(before); },
    redo: () => { grid.set(after); },
  });
  
  if (afterApply) afterApply();
}

// 获取历史长度（调试用）
export function getHistorySize() {
  return { past: pointer.value + 1, future: history.value.length - 1 - pointer.value };
}
