#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 06：纹理渲染（画布颜色丰富度）+ 湖泊颜色"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet, enter_edit, sample_colors


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.5)
    enter_edit(cdp)
    time.sleep(1.0)

    # 纹理渲染：画布唯一颜色（> 30 说明有纹理/多层次，纯色会很少）
    colors = sample_colors(cdp, 900)
    if not colors or colors < 30:
        return False, f'画布颜色过少 ({colors})，纹理可能未渲染'

    # 湖泊颜色已调浅
    lake = cdp.eval("(() => { const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState; return pm.terrainTypes.find(t => t.type === 'lake')?.color; })()")
    if lake != '#6FB3C8':
        return False, f'湖泊颜色未更新 ({lake})'
    return True, f'纹理渲染正常（{colors} 色），湖泊 #6FB3C8'
