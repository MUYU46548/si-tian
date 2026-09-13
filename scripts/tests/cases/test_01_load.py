#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 01：数据加载 + 世界卡片"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import store


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    # mock 数据是异步注入的（geodata + 2MB mapdata），冷启动时 app-layout 先出现、数据后到
    try:
        wait_for(cdp, "document.querySelectorAll('.world-card').length > 0", timeout=45, desc='世界卡片渲染')
    except RuntimeError:
        cards = cdp.eval("document.querySelectorAll('.world-card').length")
        return False, f'世界卡片未渲染 ({cards})'
    cards = cdp.eval("document.querySelectorAll('.world-card').length")
    if not cards or cards < 1:
        return False, f'世界卡片未渲染 ({cards})'
    return True, f'世界卡片 {cards} 张'
