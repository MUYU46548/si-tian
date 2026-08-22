#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 15：节点详情面板三 tab 重排（批次A5）—— 概览默认 + frontmatter 默认折叠 + 关系/编辑切换"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for


def q(cdp, expr):
    return cdp.eval(f"(() => {{ {expr} }})()")


def jload(val, step):
    if val is None:
        raise AssertionError(f'{step}: eval 返回 None')
    return json.loads(val)


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, "document.querySelectorAll('.tree-navigation .tree-node').length > 0", desc='树节点渲染')

    # 选中乐园星系（galaxy，有行星子节点）
    clicked = q(cdp, """
      const names = Array.from(document.querySelectorAll('.tree-navigation .tree-node .node-name'));
      const el = names.find(n => n.textContent.trim() === '乐园星系');
      if (!el) return 'no-node';
      el.closest('.tree-node').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    """)
    if clicked != 'ok':
        return False, '未找到 乐园星系 树节点'

    wait_for(cdp, "!!document.querySelector('.detail-panel')", desc='详情面板打开')
    time.sleep(1.0)  # 等笔记异步加载

    # 1) tab 栏存在且默认概览：高频操作按钮常驻可见
    t = jload(q(cdp, """
      const btns = Array.from(document.querySelectorAll('.detail-tab-btn')).map(b => b.textContent.trim());
      const active = document.querySelector('.detail-tab-btn.active');
      return JSON.stringify({ tabs: btns, active: active ? active.textContent.trim() : null,
        actions: !!document.querySelector('.actions-section-top') });
    """), 'step1')
    if not t['actions'] or t['active'] != '概览' or len(t['tabs']) != 3:
        return False, f'tab 栏异常 ({t})'

    # 2) 概览下 frontmatter 默认折叠（存在「展开详情」按钮），点击后展开
    has_collapse = q(cdp, """
      const b = Array.from(document.querySelectorAll('.frontmatter-block .expand-btn'))
        .find(x => x.textContent.includes('展开详情'));
      if (!b) return 'no-btn';
      const was = b.closest('.frontmatter-block').classList.contains('collapsed');
      b.click();
      return was ? 'was-collapsed' : 'not-collapsed';
    """)
    if has_collapse != 'was-collapsed':
        return False, f'frontmatter 应默认折叠且可展开 ({has_collapse})'

    # 3) 切到关系 tab：relations/reparent 可见、概览的 meta 不可见
    r1 = q(cdp, """
      const b = Array.from(document.querySelectorAll('.detail-tab-btn')).find(x => x.textContent.includes('关系'));
      if (!b) return 'no-rel-tab';
      b.click();
      return 'ok';
    """)
    if r1 != 'ok':
        return False, f'关系 tab 未找到 ({r1})'
    time.sleep(0.3)
    v = jload(q(cdp, "return JSON.stringify({ rel: !!document.querySelector('.relations-section'), reparent: !!document.querySelector('.reparent-section'), meta: !!document.querySelector('.meta-section') });"), 'step3')
    if not (v['rel'] and v['reparent'] and not v['meta']):
        return False, f'关系 tab 内容异常 ({v})'

    # 4) 切到编辑 tab：属性/坐标可见、关系区不可见
    r2 = q(cdp, """
      const b = Array.from(document.querySelectorAll('.detail-tab-btn')).find(x => x.textContent.trim().startsWith('编辑'));
      if (!b) return 'no-edit-tab';
      b.click();
      return 'ok';
    """)
    if r2 != 'ok':
        return False, f'编辑 tab 未找到 ({r2})'
    time.sleep(0.3)
    v2 = jload(q(cdp, "return JSON.stringify({ prop: !!document.querySelector('.property-section'), coord: !!document.querySelector('.coordinate-section'), rel: !!document.querySelector('.relations-section') });"), 'step4')
    if not (v2['prop'] and v2['coord'] and not v2['rel']):
        return False, f'编辑 tab 内容异常 ({v2})'

    # 5) 切换节点 → tab 重置回概览
    q(cdp, """
      const names = Array.from(document.querySelectorAll('.tree-navigation .tree-node .node-name'));
      const el = names.find(n => n.textContent.trim() === '净土星域');
      if (el) el.closest('.tree-node').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    """)
    time.sleep(0.5)
    active = q(cdp, "const a = document.querySelector('.detail-tab-btn.active'); return a ? a.textContent : 'none';")
    if '概览' not in str(active):
        return False, f'切换节点后 tab 未重置概览 ({active})'

    return True, '详情面板三 tab（概览默认·frontmatter 默认折叠·关系/编辑切换·节点切换重置）正常'
