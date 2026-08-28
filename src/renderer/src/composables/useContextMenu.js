// U3: 右键上下文菜单统一框架 — 各画布只声明"对 X 类型显示哪些项"
// 用法：
//   const ctxMenu = useContextMenu();
//   ctxMenu.open(items, { x, y }, containerEl);  // items: [{ key, label, icon?, danger?, action?, disabled? }]
//   <ContextMenu :state="ctxMenu.state" @close="ctxMenu.close()" @select="..." />
// 边界钳制由本框架负责（相对 container 定位，默认 document.body）

import { reactive } from 'vue';

export function useContextMenu() {
  const state = reactive({
    visible: false,
    x: 0,
    y: 0,
    items: [],
    container: null,
  });

  function close() {
    state.visible = false;
    state.items = [];
    state.container = null;
  }

  function open(items, pos, containerEl) {
    if (!items?.length) {
      close();
      return;
    }
    state.items = items;
    state.container = containerEl || document.body;
    state.visible = true;
    // 打开后再钳制：等下一帧拿到菜单实际尺寸
    requestAnimationFrame(() => {
      if (!state.visible) return;
      const rect = state.container.getBoundingClientRect();
      const menu = document.querySelector('.sitian-context-menu');
      const w = menu?.offsetWidth || 180;
      const h = menu?.offsetHeight || 120;
      state.x = Math.min(pos.x, rect.width - w - 8);
      state.y = Math.min(pos.y, rect.height - h - 8);
      if (state.x < 0) state.x = 8;
      if (state.y < 0) state.y = 8;
    });
    state.x = pos.x;
    state.y = pos.y;
  }

  // 按命中类型过滤菜单定义：def = [{ types: ['galaxy'], ...item }]
  function resolveItems(defs, targetType, ctx) {
    return defs
      .filter((d) => !d.types || d.types.includes(targetType))
      .map((d) => ({
        ...d,
        disabled: typeof d.disabled === 'function' ? d.disabled(ctx) : d.disabled,
      }))
      .filter((d) => !d.hidden);
  }

  return { state, open, close, resolveItems };
}
