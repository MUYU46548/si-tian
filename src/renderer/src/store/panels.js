import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 全局面板互斥注册表（P0-2 面板管理系统）
 *
 * 解决多浮层面板互相遮挡问题：同一时刻只允许一个"浮层面板"处于打开状态。
 * - 模态面板（About/Settings/快捷键/日志/Onboarding，全屏遮罩）不注册，天然覆盖一切；
 *   打开模态面板时通过 closeAll() 关闭浮层。
 * - 注册的面板：export（导出菜单）、bookmarks（书签）、layers（图层面板）。
 * - PlanetMap 的簇/对象/快照面板保持组件内部互斥，打开时派发 'sitian:panel-open'
 *   事件关闭 App 层浮层；本 store 打开其他面板时 PlanetMap 通过 watch 关闭本地面板。
 */
export const usePanelsStore = defineStore('panels', () => {
  // 当前打开的浮层面板 id（null = 无）
  const openPanelId = ref(null);

  function open(id) {
    openPanelId.value = id;
  }

  function toggle(id) {
    openPanelId.value = openPanelId.value === id ? null : id;
  }

  function close(id) {
    if (openPanelId.value === id) openPanelId.value = null;
  }

  function closeAll() {
    openPanelId.value = null;
  }

  function isOpen(id) {
    return openPanelId.value === id;
  }

  return { openPanelId, open, toggle, close, closeAll, isOpen };
});
