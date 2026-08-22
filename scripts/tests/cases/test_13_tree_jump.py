#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 13：树导航双击跳转（批次A4）—— 单击=选中开面板（不跳视图），双击=下钻对应视图"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for


def tree_state(cdp):
    """返回 { level, domain, system, planet, selected, panel }"""
    raw = cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; return JSON.stringify({ level: s.viewLevel, domain: s.currentDomain ? (s.currentDomain.displayName || s.currentDomain.name) : null, system: s.currentSystem ? (s.currentSystem.displayName || s.currentSystem.name) : null, planet: s.currentPlanet ? (s.currentPlanet.displayName || s.currentPlanet.name) : null, selected: s.selectedNode ? (s.selectedNode.displayName || s.selectedNode.name) : null, panel: !!document.querySelector('.detail-panel') }); })()")
    return json.loads(raw)


def act_on_node(cdp, name, event):
    """在树上按名称找节点行并触发 click / dblclick"""
    return cdp.eval(f"""(() => {{
      const names = Array.from(document.querySelectorAll('.tree-navigation .tree-node .node-name'));
      const el = names.find(n => n.textContent.trim() === '{name}');
      if (!el) return false;
      const row = el.closest('.tree-node');
      row.dispatchEvent(new MouseEvent('{event}', {{ bubbles: true }}));
      return true;
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, "document.querySelectorAll('.tree-navigation .tree-node').length > 0", desc='树节点渲染')

    # 1) 单击星域节点：仅选中开详情面板，不跳视图
    if not act_on_node(cdp, '净土星域', 'click'):
        return False, '树上未找到星域节点 净土星域'
    time.sleep(0.5)
    st = tree_state(cdp)
    if st['level'] != 'world' or st['selected'] != '净土星域' or not st['panel']:
        return False, f'单击应只选中不跳转 ({json.dumps(st, ensure_ascii=False)})'

    # 2) 双击星域节点 → system 视图 + 面板保持打开（选中恢复）
    if not act_on_node(cdp, '净土星域', 'dblclick'):
        return False, '双击星域节点失败'
    time.sleep(0.8)
    st = tree_state(cdp)
    if st['level'] != 'system' or st['domain'] != '净土星域' or not st['panel']:
        return False, f'双击星域应下钻 system 且面板保留 ({json.dumps(st, ensure_ascii=False)})'

    # 3) 双击恒星系节点 → system_detail 视图（enterSystemDetail 补齐面包屑）
    if not act_on_node(cdp, '乐园星系', 'dblclick'):
        return False, '树上未找到星系节点 乐园星系'
    time.sleep(0.8)
    st = tree_state(cdp)
    if st['level'] != 'system_detail' or st['system'] != '乐园星系' or st['domain'] != '净土星域':
        return False, f'双击星系应下钻 system_detail 且面包屑完整 ({json.dumps(st, ensure_ascii=False)})'

    # 4) 双击行星节点 → planet 视图
    if not act_on_node(cdp, '乐园星', 'dblclick'):
        return False, '树上未找到行星节点 乐园星'
    time.sleep(1.0)
    st = tree_state(cdp)
    if st['level'] != 'planet' or st['planet'] != '乐园星':
        return False, f'双击行星应下钻 planet ({json.dumps(st, ensure_ascii=False)})'

    return True, '树导航单击选中/双击下钻（星域→system·星系→system_detail·行星→planet）正常'
