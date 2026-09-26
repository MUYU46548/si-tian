// E11: 底部状态栏 — 模块级单例，各画布在既有事件回调（onHover/onWheel 等）中调用
// setStatus 更新局部响应式 state，不进渲染循环（红线 3）

import { reactive } from 'vue';

const state = reactive({
  visible: false,
  viewLabel: '',
  toolLabel: '',
  mouseWorld: null, // { x, y }
  zoom: null, // 百分比数值
  selectionCount: 0,
  snap: '', // 吸附状态描述，空串隐藏
  // 保存状态（B5，2026-09-24）：{ kind: 'ok'|'warn'|'err'|'busy', text, title } | null
  saveState: null,
});

/**
 * 保存状态（B5，2026-09-24）—— 由 `store/projectStore` 在每次落盘尝试后写入。
 *
 * 为什么必须放**常驻状态栏**而不是只在项目面板里：
 *   面板可能是关着的，用户在行星图里连着画几小时时，落盘失败**完全看不出来**
 *   （旧实现把失败写进项目面板的 statusLine，5 秒后自动回 idle）。而「我这几小时的成果到底存没存」
 *   是用户最需要常驻可见的信息。失败状态**不自动消失**，由用户下一次成功保存来清。
 */
export function setSaveState(next) {
  state.saveState = next || null;
}

let throttleTimer = null;
let pendingUpdate = null;

// 高频路径（鼠标移动）合并到 rAF 节拍，一帧最多一次响应式更新
export function setStatusThrottled(partial) {
  pendingUpdate = { ...(pendingUpdate || {}), ...partial };
  if (throttleTimer) return;
  throttleTimer = requestAnimationFrame(() => {
    throttleTimer = null;
    if (pendingUpdate) {
      Object.assign(state, pendingUpdate);
      pendingUpdate = null;
    }
  });
}

// 低频字段（视图/工具/选中数）立即更新
export function setStatus(partial) {
  Object.assign(state, partial);
}

export function showStatusBar(viewLabel) {
  setStatus({ visible: true, viewLabel: viewLabel || state.viewLabel });
}

export function hideStatusBar() {
  setStatus({ visible: false, mouseWorld: null });
}

export function useStatusBarState() {
  return state;
}

export function formatWorldCoord(x, y) {
  if (x == null || y == null) return '—';
  const fx = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${Math.round(v)} m`);
  return `${fx(x)}, ${fx(y)}`;
}
