// composables/useSaveDisplay.js — 保存状态的**唯一显示入口**（2026-10-17）
//
// 历史剧本曾自己写过一份 `saveDisplay` computed（2026-10-09，把 geodata 与 projectStore
// 两条保存链合并显示），行星地图则完全没接 —— 它的「保存地图」按钮只看 `result.success`
// 就报「保存成功」，而项目态下那句话是不成立的（只是交给了项目，还没进磁盘）。
//
// 现在一个实现供三处共用：`ScenarioMap`（工具条保存 chip）、`PlanetMap`（保存横幅）、
// `StatusBar`（底部常驻）。⚠️ 不要再在组件里写第二份 `computed` 合成 ——
// 「保存到底成没成」一旦有两套口径，先变的那一套会静默把另一套变成谎言。
//
// 依赖方向：composable → store（geodata）+ 全局状态栏单例（projectStore 写）。
// 反向不成立（store 不 import 本文件），所以没有环。

import { computed, unref } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useStatusBarState } from './useStatusBar';
import { resolveSaveDisplay } from '../utils/saveStatusText';

export function useSaveDisplay() {
  const store = useGeodataStore();
  const sbState = useStatusBarState();

  return computed(() => resolveSaveDisplay({
    project: {
      // 只有 projectStore 写这两个字段（见 store/projectStore.js#setSaveStatus / savePending）
      saveState: sbState.saveState,
      pending: !!sbState.savePending,
      lastSavedAt: sbState.savedAt || '',
    },
    canvas: {
      // ⚠️ `store.saveStatus` / `store.lastSaveError` 是**已解包**的值（Pinia setup store）——
      //    写 `.value` 会拿到 undefined（2026-10-09 实测踩过，见 test_91 历史记录）。
      //    用 `unref` 对"ref"与"已解包的值"两种形态都安全。
      status: unref(store.saveStatus),
      error: unref(store.lastSaveError),
    },
  }));
}
