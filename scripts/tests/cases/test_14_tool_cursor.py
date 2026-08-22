#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 14：工具光标反馈（批次A2）—— 工具切换/空格拖手/平移拖动中 光标形态正确"""
import sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet, enter_edit, set_pm_state


def canvas_cursor(cdp):
    return cdp.eval("(() => { const c = document.querySelector('.planet-map-container canvas'); return c ? c.style.cursor : 'no-canvas'; })()")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.2)

    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.5)

    # 1) 默认 pan 工具 → grab
    set_pm_state(cdp, "pm.setInteractionMode('pan'); return 'ok';")
    time.sleep(0.3)
    c1 = canvas_cursor(cdp)
    if c1 != 'grab':
        return False, f'pan 工具光标应为 grab ({c1})'

    # 2) 绘制工具 → crosshair；文本工具 → text
    set_pm_state(cdp, "pm.setInteractionMode('draw'); return 'ok';")
    time.sleep(0.3)
    c2 = canvas_cursor(cdp)
    set_pm_state(cdp, "pm.setInteractionMode('text'); return 'ok';")
    time.sleep(0.3)
    c3 = canvas_cursor(cdp)
    if c2 != 'crosshair' or c3 != 'text':
        return False, f'创建类工具光标异常 draw={c2} text={c3}'

    # 3) 空格临时拖手覆盖当前工具光标 → grab，松开恢复
    set_pm_state(cdp, "pm.setInteractionMode('draw'); pm.isSpacebarDown = true; return 'ok';")
    time.sleep(0.3)
    c4 = canvas_cursor(cdp)
    set_pm_state(cdp, "pm.isSpacebarDown = false; return 'ok';")
    time.sleep(0.3)
    c5 = canvas_cursor(cdp)
    if c4 != 'grab' or c5 != 'crosshair':
        return False, f'空格拖手光标异常 按下={c4} 松开={c5}'

    # 4) pan 工具下 mousedown 平移 → grabbing，mouseup 恢复 grab
    set_pm_state(cdp, "pm.setInteractionMode('pan'); return 'ok';")
    time.sleep(0.2)
    seq = cdp.eval("""(() => {
      const c = document.querySelector('.planet-map-container canvas');
      const r = c.getBoundingClientRect();
      const opts = { bubbles: true, clientX: r.left + 200, clientY: r.top + 200, button: 0 };
      c.dispatchEvent(new MouseEvent('mousedown', opts));
      const during = c.style.cursor;
      c.dispatchEvent(new MouseEvent('mouseup', opts));
      const after = c.style.cursor;
      return during + '|' + after;
    })()""")
    during, after = seq.split('|')
    if during != 'grabbing' or after != 'grab':
        return False, f'平移光标异常 按下={during} 松开={after}'

    return True, '工具光标反馈正常（pan=grab·draw=crosshair·text=text·空格=grab·拖动=grabbing）'
