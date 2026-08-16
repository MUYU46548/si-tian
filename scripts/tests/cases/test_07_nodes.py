#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 07：节点 CRUD（创建/删除/undo）——在 domain 视图创建恒星"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import view_level, node_count


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    # 进入 domain 视图
    cdp.eval("document.querySelector('.world-card').click()")
    time.sleep(0.8)
    if view_level(cdp) != 'domain':
        return False, '未进入 domain'

    # 创建恒星（store.addNode 走 undo）
    node_count_before = node_count(cdp)
    created = cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; const id = 'test_node_' + Date.now(); s.addNode({ id, name: '测试节点', layer: 'galaxy', parentId: null, tags: [], sourcePath: '', coordinate: { x: 0, y: 0 } }); return id; })()")
    if not created:
        return False, '创建节点失败'
    time.sleep(0.5)
    node_count_after = node_count(cdp)
    if node_count_after != node_count_before + 1:
        return False, f'节点数未增加 ({node_count_before}→{node_count_after})'

    # undo 删除
    cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; s.undo(); return 'u'; })()")
    time.sleep(0.5)
    node_count_undo = node_count(cdp)
    if node_count_undo != node_count_before:
        return False, f'undo 未恢复节点数 ({node_count_undo})'

    # redo 恢复
    cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; s.redo(); return 'r'; })()")
    time.sleep(0.5)
    node_count_redo = node_count(cdp)
    if node_count_redo != node_count_before + 1:
        return False, f'redo 未恢复节点 ({node_count_redo})'

    # 清理测试节点
    cdp.eval(f"(() => {{ const s = document.querySelector('#app').__vue_app__._instance.setupState.store; const n = s.nodes.find(x => x.id === '{created}'); if (n) s.removeNode('{created}'); return 'clean'; }})()")
    time.sleep(0.5)
    return True, '节点 CRUD（创建/undo/redo/删除）正常'
