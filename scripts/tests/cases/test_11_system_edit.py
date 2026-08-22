#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 11：恒星系内编辑（批次 B3）
链路：进入 乐园星系 单系视图 → 开编辑模式 → 真实事件链拖拽行星编辑轨道
      （系内相对坐标 ↔ 域地图绝对坐标换算断言）→ undo 恢复
      → 头部「＋ 天体」添加（stub window.prompt，落下一轨道槽公式位）→ undo
      → 右键空白「＋ 添加天体（此位置）」原地添加 → undo
      → 右键行星「🗑 删除该节点」→ nodes.length -1 → undo 恢复
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import view_level


def _js_obj(cdp, expr):
    """执行 eval 并解析 JSON 字符串；异常/非串时原样返回（供失败信息）"""
    v = cdp.eval(expr)
    if isinstance(v, str) and v.startswith('{'):
        return json.loads(v)
    return v


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # a) 进入 乐园星系 单系视图（沿 parentId 上溯所属世界 → selectWorld → enterSystemDetail）
    nav = cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const sys = s.nodes.find(n => n.id === '乐园星系');
      if (!sys) return 'no-sys';
      let cur = s.nodes.find(n => n.id === sys.parentId);
      while (cur && cur.layer !== 'world') cur = s.nodes.find(n => n.id === cur.parentId);
      if (!cur) return 'no-world';
      s.selectWorld(cur);
      s.enterSystemDetail(sys);
      return s.viewLevel;
    })()""")
    if nav != 'system_detail':
        return False, f'未进入单系视图 ({nav})'
    wait_for(cdp, "!!document.querySelector('.system-detail-container')", desc='单系视图挂载')
    time.sleep(0.6)  # 等 fitSystem 初始视野稳定

    # b) 开编辑模式：点头部「✎ 编辑地图」按钮 → editMode=true + 编辑 hint 出现
    em = _js_obj(cdp, """(() => {
      const el = document.querySelector('.system-detail-container');
      if (!el) return 'no-el';
      const btn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('编辑地图'));
      if (!btn) return 'no-btn';
      btn.click();
      const st = el.__vueParentComponent.setupState;
      return JSON.stringify({ on: st.editMode === true });
    })()""")
    if not isinstance(em, dict) or not em.get('on'):
        return False, f'编辑模式未开启 {em}'
    time.sleep(0.3)  # 等 Vue 补丁后查 DOM
    dom = _js_obj(cdp, """(() => {
      const el = document.querySelector('.system-detail-container');
      return JSON.stringify({
        hint: !!el.querySelector('.edit-hint'),
        done: Array.from(el.querySelectorAll('button')).some(b => b.textContent.includes('完成编辑')),
        addBtn: Array.from(el.querySelectorAll('button')).some(b => b.textContent.includes('＋ 天体')),
      });
    })()""")
    if not isinstance(dom, dict) or not (dom.get('hint') and dom.get('done') and dom.get('addBtn')):
        return False, f'编辑模式 UI 未生效 {dom}'

    # c) 拖拽行星编辑轨道（真实事件链 mousedown→mousemove→mouseup）
    #    单系视图行星画的是"相对恒星"坐标 (p.x,p.y)，store 存域地图绝对坐标，
    #    断言 after == system.coordinate + (p + 拖拽偏移) —— 覆盖换算逻辑
    drag = _js_obj(cdp, """(() => {
      const el = document.querySelector('.system-detail-container');
      const st = el.__vueParentComponent.setupState;
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const p = st.planetLayouts[0];
      if (!p) return 'no-planet';
      const node = store.nodes.find(n => n.id === p.id);
      const before = { x: node.coordinate.x, y: node.coordinate.y };
      const c = st.canvas;
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const toSX = wx => wx * vt.scale + vt.x + c.clientWidth / 2;
      const toSY = wy => wy * vt.scale + vt.y + c.clientHeight / 2;
      const mk = (wx, wy, t) => new MouseEvent(t, {
        // MouseEvent clientX/Y 为 IDL long（浏览器截断为整数），与期望值量化保持一致
        clientX: Math.trunc(r.left + toSX(wx)),
        clientY: Math.trunc(r.top + toSY(wy)),
        bubbles: true, cancelable: true, button: 0,
      });
      c.dispatchEvent(mk(p.x, p.y, 'mousedown'));
      c.dispatchEvent(mk(p.x + 80, p.y + 50, 'mousemove'));
      c.dispatchEvent(mk(p.x + 80, p.y + 50, 'mouseup'));
      const base = store.nodes.find(n => n.id === '乐园星系').coordinate;
      // 期望值：按同一整数量化反算落点世界坐标，再叠加系坐标基准
      const endW = st.renderer.screenToWorld(
        Math.trunc(r.left + toSX(p.x + 80)) - r.left,
        Math.trunc(r.top + toSY(p.y + 50)) - r.top
      );
      return JSON.stringify({
        id: p.id, before,
        after: { x: node.coordinate.x, y: node.coordinate.y },
        expect: { x: base.x + endW.x, y: base.y + endW.y },
        dragging: st.dragPlanet,
        userMoved: node.userMoved,
      });
    })()""")
    if not isinstance(drag, dict) or 'after' not in drag:
        return False, f'拖拽链路异常 {drag}'
    if drag['dragging'] is not None:
        return False, '拖拽结束未清空 dragPlanet'
    ax, ay = drag['after']['x'], drag['after']['y']
    ex, ey = drag['expect']['x'], drag['expect']['y']
    if ax is None or abs(ax - ex) > 0.01 or abs(ay - ey) > 0.01:
        return False, f'拖拽坐标换算异常 after={drag["after"]} expect={drag["expect"]}'
    if (ax, ay) == (drag['before']['x'], drag['before']['y']):
        return False, '拖拽未改变 store 坐标'
    if not drag['userMoved']:
        return False, '拖拽结束未标记 userMoved'

    # c2) undo → 坐标恢复拖拽前
    rc = _js_obj(cdp, """(() => {
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      store.undo();
      const n = store.nodes.find(nn => nn.id === %s);
      return JSON.stringify({ x: n.coordinate.x, y: n.coordinate.y });
    })()""" % json.dumps(drag['id']))
    if not isinstance(rc, dict) or (rc['x'], rc['y']) != (drag['before']['x'], drag['before']['y']):
        return False, f'undo 未恢复坐标 {rc} (期望 {drag["before"]})'

    # d) 添加天体：点「＋ 天体」→ 模态选「卫星」→ 落下一轨道槽公式位（批次D1 后走 PromptDialog）
    add = _js_obj(cdp, """(async () => {
      const el = document.querySelector('.system-detail-container');
      const btn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('＋ 天体'));
      if (!btn) return 'no-btn';
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const before = store.nodes.length;
      const sysBefore = store.currentSystemPlanets.length;
      btn.click();
      await new Promise(r => setTimeout(r, 80));
      const dlg = document.querySelector('.prompt-dialog');
      if (!dlg) return 'no-dialog';
      const opt = Array.from(dlg.querySelectorAll('.prompt-choice')).find(b => b.textContent.includes('卫星'));
      if (!opt) return 'no-choice';
      opt.click();
      await new Promise(r => setTimeout(r, 80));
      const added = store.nodes[store.nodes.length - 1];
      const base = store.nodes.find(n => n.id === '乐园星系').coordinate;
      // 与组件 createBody 相同的轨道槽公式：pIdx = 现有行星数（2 颗 → 第 3 槽）
      const pIdx = sysBefore;
      const orbit = Math.floor(pIdx / 3) + 1, pos = pIdx % 3;
      const angle = (pos / 3) * Math.PI * 2 + orbit * 0.4;
      const rr = 40 + orbit * 35;
      return JSON.stringify({
        before, after: store.nodes.length,
        sysBefore, sysAfter: store.currentSystemPlanets.length,
        added: { id: added.id, layer: added.layer, parentId: added.parentId, tags: added.tags, userMoved: added.userMoved, coord: added.coordinate },
        expect: { x: base.x + Math.cos(angle) * rr, y: base.y + Math.sin(angle) * rr },
      });
    })()""")
    if not isinstance(add, dict) or 'added' not in add:
        return False, f'添加天体链路异常 {add}'
    a = add['added']
    if add['after'] != add['before'] + 1 or add['sysAfter'] != add['sysBefore'] + 1:
        return False, f'添加后计数异常 {add}'
    if not (a['layer'] == 'planet' and a['parentId'] == '乐园星系' and a['tags'][:2] == ['新创建', '卫星'] and a['userMoved']):
        return False, f'新天体属性异常 {a}'
    if abs(a['coord']['x'] - add['expect']['x']) > 0.51 or abs(a['coord']['y'] - add['expect']['y']) > 0.51:
        return False, f'新天体未落轨道槽公式位 {a["coord"]} (期望 {add["expect"]})'

    # d2) undo → 节点数恢复
    ub = _js_obj(cdp, """(() => {
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      store.undo();
      return JSON.stringify({ nodes: store.nodes.length, sys: store.currentSystemPlanets.length });
    })()""")
    if not isinstance(ub, dict) or ub['nodes'] != add['before'] or ub['sys'] != add['sysBefore']:
        return False, f'undo 添加未恢复 {ub} (期望 {add["before"]}/{add["sysBefore"]})'

    # d3) 右键空白处 → 「＋ 添加天体（此位置）」原地添加（模态选「空间站」）
    spot_info = _js_obj(cdp, """(() => {
      const el = document.querySelector('.system-detail-container');
      const st = el.__vueParentComponent.setupState;
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      // 在恒星与第一圈轨道之间找一个远离所有行星的空位（半径 55，确定性角度扫描）
      let spot = null;
      for (let a2 = 0; a2 < Math.PI * 2; a2 += Math.PI / 12) {
        const x = Math.cos(a2) * 55, y = Math.sin(a2) * 55;
        if (!st.planetLayouts.some(p => Math.hypot(p.x - x, p.y - y) < 25)) { spot = { x, y }; break; }
      }
      if (!spot) return 'no-spot';
      const c = st.canvas;
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const cx = Math.trunc(r.left + spot.x * vt.scale + vt.x + c.clientWidth / 2);
      const cy = Math.trunc(r.top + spot.y * vt.scale + vt.y + c.clientHeight / 2);
      c.dispatchEvent(new MouseEvent('contextmenu', { clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 2 }));
      // 期望落点：按 MouseEvent 整数量化反算的世界坐标
      const wq = st.renderer.screenToWorld(cx - r.left, cy - r.top);
      return JSON.stringify({ spot: wq, nodesBefore: store.nodes.length });
    })()""")
    if not isinstance(spot_info, dict) or 'spot' not in spot_info:
        return False, f'右键空白链路异常 {spot_info}'
    time.sleep(0.3)
    menu = _js_obj(cdp, """(() => {
      const el = document.querySelector('.system-detail-container');
      const items = Array.from(el.querySelectorAll('.context-menu .menu-item')).map(m => m.textContent);
      return JSON.stringify({ visible: !!el.querySelector('.context-menu'), items });
    })()""")
    if not isinstance(menu, dict) or not menu['visible'] or not any('添加天体' in t for t in menu['items']):
        return False, f'右键空白未出现添加菜单 {menu}'
    ctx_add = _js_obj(cdp, """(async () => {
      const el = document.querySelector('.system-detail-container');
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const item = Array.from(el.querySelectorAll('.context-menu .menu-item')).find(m => m.textContent.includes('添加天体'));
      if (!item) return 'no-item';
      item.click();
      await new Promise(r => setTimeout(r, 80));
      const dlg = document.querySelector('.prompt-dialog');
      if (!dlg) return 'no-dialog';
      const opt = Array.from(dlg.querySelectorAll('.prompt-choice')).find(b => b.textContent.includes('空间站'));
      if (!opt) return 'no-choice';
      opt.click();
      await new Promise(r => setTimeout(r, 80));
      const added = store.nodes[store.nodes.length - 1];
      return JSON.stringify({
        after: store.nodes.length, tags: added.tags, coord: added.coordinate, parentId: added.parentId,
        menuClosed: !el.__vueParentComponent.setupState.contextMenu.visible,
      });
    })()""")
    if not isinstance(ctx_add, dict) or 'coord' not in ctx_add:
        return False, f'原地添加链路异常 {ctx_add}'
    base = cdp.eval("""(() => {
      const n = document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.find(nn => nn.id === '乐园星系');
      return JSON.stringify({ x: n.coordinate.x, y: n.coordinate.y });
    })()""")
    b = json.loads(base)
    spot = spot_info['spot']
    if ctx_add['after'] != spot_info['nodesBefore'] + 1:
        return False, f'原地添加计数异常 {ctx_add}'
    if ctx_add['tags'][:2] != ['新创建', '空间站'] or ctx_add['parentId'] != '乐园星系':
        return False, f'原地添加属性异常 {ctx_add}'
    if abs(ctx_add['coord']['x'] - (b['x'] + spot['x'])) > 0.51 or abs(ctx_add['coord']['y'] - (b['y'] + spot['y'])) > 0.51:
        return False, f'原地添加坐标换算异常 {ctx_add["coord"]} (期望 base{b} + spot{spot})'
    if not ctx_add['menuClosed']:
        return False, '添加后右键菜单未关闭'
    cdp.eval("document.querySelector('#app').__vue_app__._instance.setupState.store.undo()")  # 清场恢复

    # e) 右键行星 → 「🗑 删除该节点」→ nodes.length -1，undo 恢复
    dele = _js_obj(cdp, """(() => {
      const el = document.querySelector('.system-detail-container');
      const st = el.__vueParentComponent.setupState;
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const p = st.planetLayouts[0];
      if (!p) return 'no-planet';
      const c = st.canvas;
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const sx = p.x * vt.scale + vt.x + c.clientWidth / 2;
      const sy = p.y * vt.scale + vt.y + c.clientHeight / 2;
      c.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 2 }));
      return JSON.stringify({ target: p.id, nodesBefore: store.nodes.length, sysBefore: store.currentSystemPlanets.length });
    })()""")
    if not isinstance(dele, dict) or 'target' not in dele:
        return False, f'右键行星链路异常 {dele}'
    time.sleep(0.3)
    menu2 = _js_obj(cdp, """(() => {
      const el = document.querySelector('.system-detail-container');
      const items = Array.from(el.querySelectorAll('.context-menu .menu-item')).map(m => m.textContent);
      return JSON.stringify({ visible: !!el.querySelector('.context-menu'), items });
    })()""")
    if not isinstance(menu2, dict) or not menu2['visible'] or not any('删除' in t for t in menu2['items']):
        return False, f'右键行星未出现删除菜单 {menu2}'
    del2 = _js_obj(cdp, """(() => {
      const el = document.querySelector('.system-detail-container');
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const item = Array.from(el.querySelectorAll('.context-menu .menu-item')).find(m => m.textContent.includes('删除'));
      if (!item) return 'no-item';
      item.click();
      return JSON.stringify({
        after: store.nodes.length, sysAfter: store.currentSystemPlanets.length,
        menuClosed: !el.__vueParentComponent.setupState.contextMenu.visible,
      });
    })()""")
    if not isinstance(del2, dict) or 'after' not in del2:
        return False, f'删除链路异常 {del2}'
    if del2['after'] != dele['nodesBefore'] - 1 or del2['sysAfter'] != dele['sysBefore'] - 1:
        return False, f'删除后计数异常 {del2} (删前 {dele})'
    if not del2['menuClosed']:
        return False, '删除后右键菜单未关闭'
    gone = cdp.eval("!document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.some(n => n.id === %s)" % json.dumps(dele['target']))
    if gone is not True:
        return False, f'目标节点未删除 ({dele["target"]})'
    restored = cdp.eval("""(() => {
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      store.undo();
      return store.nodes.some(n => n.id === %s);
    })()""" % json.dumps(dele['target']))
    if restored is not True:
        return False, 'undo 未恢复被删节点'

    return True, '恒星系内编辑链路完整（拖拽轨道换算/undo/添加×2/删除/undo）'
