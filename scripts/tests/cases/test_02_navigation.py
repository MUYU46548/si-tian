#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 02：导航链路（世界→星域→星系→行星→返回）"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import view_level, goto_planet


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # 世界 → 星域总览（点击世界卡片）
    cdp.eval("document.querySelector('.world-card').click()")
    import time; time.sleep(0.8)
    level = view_level(cdp)
    if level != 'domain':
        return False, f'点击世界卡片未进入 domain ({level})'

    # 星域 → 恒星系总览（通过 store 直接 selectDomain 验证层级切换）
    nav = cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; const w = s.currentWorld; const d = s.currentWorldDomains[0]; if (!d) return 'no-domain'; s.selectDomain(d); return s.viewLevel; })()")
    if nav != 'system':
        return False, f'selectDomain 未进入 system ({nav})'

    # 恒星系 → 行星地图（直接导航）
    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航到行星失败 ({r})'

    # 返回（行星 → 恒星系 → 星域 → 世界）
    cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; s.backToSystem(); return 'ok'; })()")
    import time; time.sleep(0.5)
    l1 = view_level(cdp)
    cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; s.backToDomain(); return 'ok'; })()")
    time.sleep(0.5)
    l2 = view_level(cdp)
    cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; s.backToWorld(); return 'ok'; })()")
    time.sleep(0.5)
    l3 = view_level(cdp)
    if not (l1 == 'system' and l2 == 'domain' and l3 == 'world'):
        return False, f'返回链路异常 {l1}->{l2}->{l3}'
    return True, f'导航链路完整 (planet→system→domain→world)'
