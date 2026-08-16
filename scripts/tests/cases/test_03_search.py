#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 03：搜索直达（搜"月球"→ planet 视图）+ 无结果提示"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import store


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # 搜索"月球"（真实库存在该 planet 节点）
    cdp.eval("(() => { const input = document.querySelector('.search-input-wrapper input'); input.value = '月球'; input.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()")
    import time; time.sleep(0.8)
    results = cdp.eval("document.querySelectorAll('.result-item').length")
    if not results:
        return False, '搜索"月球"无结果'

    # 点击"月球"结果 → 直达 planet 视图
    clicked = cdp.eval("(() => { const items = Array.from(document.querySelectorAll('.result-item')); const it = items.find(i => i.querySelector('.result-name').textContent.trim() === '月球'); if (!it) return false; it.click(); return true; })()")
    if not clicked:
        return False, '未找到"月球"结果项'
    time.sleep(1.2)
    state = cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; return JSON.stringify({ level: s.viewLevel, planet: s.currentPlanet ? (s.currentPlanet.displayName || s.currentPlanet.name) : null }); })()")
    st = json.loads(state)
    if st['level'] != 'planet' or st['planet'] != '月球':
        return False, f'搜索直达失败 ({state})'

    # 搜索无结果提示（输入不存在的词）
    cdp.eval("(() => { const input = document.querySelector('.search-input-wrapper input'); input.value = '不存在的星球xyz'; input.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()")
    time.sleep(0.8)
    nores = cdp.eval("!!document.querySelector('.no-results-panel')")
    if not nores:
        return False, '无结果建议面板未显示'
    return True, '搜索直达 + 无结果提示正常'
