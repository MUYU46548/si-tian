#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 04：面板互斥（导出↔书签、Esc 关闭）+ 设置面板库路径"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    # 进入 domain 视图（图层/书签按钮可见）
    cdp.eval("document.querySelector('.world-card').click()")
    time.sleep(0.8)

    # 导出菜单打开
    cdp.eval("Array.from(document.querySelectorAll('.toolbar-actions button')).find(b => b.title === '导出').click()")
    time.sleep(0.5)
    if not cdp.eval("!!document.querySelector('.export-menu')"):
        return False, '导出菜单未打开'

    # 书签打开 → 导出自动关闭（互斥）
    cdp.eval("Array.from(document.querySelectorAll('.toolbar-actions button')).find(b => b.title === '视口书签').click()")
    time.sleep(0.5)
    exp_closed = cdp.eval("!document.querySelector('.export-menu')")
    bm_open = cdp.eval("!!document.querySelector('.bookmarks-panel')")
    if not (exp_closed and bm_open):
        return False, f'面板互斥失败 (export关闭={exp_closed}, bookmarks打开={bm_open})'

    # Esc 全部关闭
    cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    time.sleep(0.5)
    if cdp.eval("!!document.querySelector('.bookmarks-panel')"):
        return False, 'Esc 未关闭书签面板'

    # 设置面板：打开 + 库路径显示
    cdp.eval("Array.from(document.querySelectorAll('.toolbar-actions button')).find(b => b.title === '设置').click()")
    time.sleep(0.8)
    if not cdp.eval("!!document.querySelector('.settings-panel')"):
        return False, '设置面板未打开'
    path_text = cdp.eval("document.querySelector('.vault-path-text')?.textContent?.trim() || ''")
    has_btn = cdp.eval("!!document.querySelector('.vault-btn')")
    if not path_text or not has_btn:
        return False, f'库路径显示异常 (path={path_text}, btn={has_btn})'
    return True, f'面板互斥 + Esc + 设置库路径 ({path_text})'
