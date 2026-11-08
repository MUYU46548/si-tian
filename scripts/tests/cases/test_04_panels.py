#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 04：面板互斥（导出↔书签、Esc 关闭）+ 设置面板库路径

⚠️ 2026-11-08 两处修正（都是判据自己的脆弱点，不是产品缺陷）：
  ① 导航改成**走 store**（`selectWorld`），不再点首屏 `.world-card`：
     打开项目时首屏是世界选择页的“项目态”，根本没有 `.world-card` ——
     旧写法 `document.querySelector('.world-card').click()` 是**静默 no-op**（求值异常没人看），
     于是视图停在 world，而顶栏的“书签”按钮现在是 `v-if="viewLevel !== 'world'"` → 找不到 → 红。
  ② 按 title 找按钮改成**找不到就报错**：`Array.from(...).find(...).click()` 在找不到时抛异常，
     而 `cdp.eval` 会把异常包成 `{'__err__':…}` 返回给 Python —— 旧写法把返回值丢掉，等于
     “点了但什么都没发生”也能算走到下一步（上面那条就是这么静默到最后的）。
"""
import json
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for

APP = "document.querySelector('#app').__vue_app__"


def _click_by_title(cdp, title):
    """按 title 点顶栏按钮；**找不到返回 False**（不许静默 no-op）"""
    raw = cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('.toolbar-actions button'))
        .find(x => (x.getAttribute('title') || '') === %s);
      if (!b) return 'MISSING';
      b.click();
      return 'OK';
    })()""" % json.dumps(title, ensure_ascii=False))
    return raw == 'OK'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    # 进入 domain 视图（书签按钮要在；它只在非 world 视图渲染）
    lvl = cdp.eval("""(() => {
      const s = %s._instance.setupState.store;
      const w = s.nodes.find(n => n.layer === 'world');
      if (w) s.selectWorld(w);
      return s.viewLevel;
    })()""" % APP)
    if lvl not in ('domain', 'system', 'system_detail', 'planet', 'area', 'interior'):
        return False, f'没能进入非 world 视图（viewLevel={lvl}）'

    wait_for(cdp, "!!Array.from(document.querySelectorAll('.toolbar-actions button'))"
                  ".find(b => (b.getAttribute('title')||'') === '视口书签')", desc='书签按钮出现')
    time.sleep(0.3)

    # 导出菜单打开
    if not _click_by_title(cdp, '导出'):
        return False, '顶栏找不到“导出”按钮（title === 导出）'
    time.sleep(0.5)
    if not cdp.eval("!!document.querySelector('.export-menu')"):
        return False, '导出菜单未打开'

    # 书签打开 → 导出自动关闭（互斥）
    # ⚠️ 2026-11-08 第三处修正：`BookmarkPanel` 是 `defineAsyncComponent`（App.vue 里动态 import），
    #    点完按钮要等**那一块 JS 下载 + 编译**才进 DOM —— 旧写法 `time.sleep(0.5)` 就是在赌它够快，
    #    赌输的表现是“书签没打开 / 导出还开着”（看起来像面板互斥坏了，其实是判据没等）。
    #    设成等条件成立（上限 10s），找不到才是真坏。
    if not _click_by_title(cdp, '视口书签'):
        return False, '顶栏找不到“视口书签”按钮（title === 视口书签）'
    try:
        wait_for(cdp, "!!document.querySelector('.bookmarks-panel')", timeout=10, desc='书签面板挂载')
        bm_open = True
    except RuntimeError:
        bm_open = False
    exp_closed = cdp.eval("!document.querySelector('.export-menu')")
    if not (exp_closed and bm_open):
        return False, f'面板互斥失败 (export关闭={exp_closed}, bookmarks打开={bm_open})'

    # Esc 全部关闭（等它真的消失，别赌固定延时）
    cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    try:
        wait_for(cdp, "!document.querySelector('.bookmarks-panel')", timeout=5, desc='Esc 关闭书签面板')
    except RuntimeError:
        return False, 'Esc 未关闭书签面板'

    # 设置面板：打开 + 库路径显示（同样是等条件成立 —— 别赌 800ms）
    if not _click_by_title(cdp, '设置'):
        return False, '顶栏找不到“设置”按钮（title === 设置）'
    try:
        wait_for(cdp, "!!document.querySelector('.settings-panel')", timeout=10, desc='设置面板挂载')
    except RuntimeError:
        return False, '设置面板未打开'
    path_text = cdp.eval("document.querySelector('.vault-path-text')?.textContent?.trim() || ''")
    has_btn = cdp.eval("!!document.querySelector('.vault-btn')")
    if not path_text or not has_btn:
        return False, f'库路径显示异常 (path={path_text}, btn={has_btn})'
    return True, f'面板互斥 + Esc + 设置库路径 ({path_text})'
