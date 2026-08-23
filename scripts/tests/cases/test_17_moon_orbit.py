#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 17：卫星轨道（批次D5）
链路：进入 乐园星系 单系视图 + 编辑模式 → 添加第二颗行星
      → 右键行星「🛰 设为卫星…」→ 选母行星
      → 断言 layer=moon + parentId=母行星 + planetLayouts 出现 isMoon 锚定项（绕母星小轨道）
      → 右键卫星「↩ 取消卫星」→ 恢复 planet + 独立轨道槽 → undo 一路回溯恢复 moon 态
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for

APP_STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
DETAIL_ST = "document.querySelector('.system-detail-container').__vueParentComponent.setupState"
DETAIL_EL = "document.querySelector('.system-detail-container')"


def _js_obj(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        return json.loads(v)
    return v


def ctx_click_planet(cdp, planet_name, menu_text):
    """右键指定名称的行星，返回执行结果字符串（ok / 诊断信息）"""
    return cdp.eval(f"""(() => {{
      const st = {DETAIL_ST};
      const target = st.planetLayouts.find(p => (p.displayName || p.name) === '{planet_name}');
      if (!target) return 'no-target';
      const c = st.canvas;
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const cx = Math.trunc(r.left + target.x * vt.scale + vt.x + c.clientWidth / 2);
      const cy = Math.trunc(r.top + target.y * vt.scale + vt.y + c.clientHeight / 2);
      c.dispatchEvent(new MouseEvent('contextmenu', {{ clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 2 }}));
      return JSON.stringify({{ vis: st.contextMenu.visible, x: cx, y: cy, rect: [r.left, r.top, r.width, r.height] }});
    }})()""")


def add_planet_via_button(cdp, type_label='行星'):
    """通过头部「＋ 天体」按钮添加天体（走 PromptDialog 选类型）"""
    result = _js_obj(cdp, f"""(async () => {{
      const el = document.querySelector('.system-detail-container');
      const btn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('＋ 天体'));
      if (!btn) return 'no-btn';
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const before = store.nodes.length;
      btn.click();
      await new Promise(r => setTimeout(r, 80));
      const dlg = document.querySelector('.prompt-dialog');
      if (!dlg) return 'no-dialog';
      const opt = Array.from(dlg.querySelectorAll('.prompt-choice')).find(b => b.textContent.includes('{type_label}'));
      if (!opt) return 'no-choice';
      opt.click();
      await new Promise(r => setTimeout(r, 80));
      const added = store.nodes[store.nodes.length - 1];
      return JSON.stringify({{ before, after: store.nodes.length, id: added.id, name: added.name, layer: added.layer, parentId: added.parentId }});
    }})()""")
    return result


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # a) 进入 乐园星系 单系视图 + 编辑模式（右键菜单仅编辑模式开放）
    nav = cdp.eval(f"""(() => {{
      const s = {APP_STORE};
      const sys = s.nodes.find(n => n.id === '乐园星系');
      if (!sys) return 'no-sys';
      let cur = s.nodes.find(n => n.id === sys.parentId);
      while (cur && cur.layer !== 'world') cur = s.nodes.find(n => n.id === cur.parentId);
      if (!cur) return 'no-world';
      s.selectWorld(cur);
      s.enterSystemDetail(sys);
      return s.viewLevel;
    }})()""")
    if nav != 'system_detail':
        return False, f'未进入单系视图 ({nav})'
    wait_for(cdp, "!!document.querySelector('.system-detail-container')", desc='单系视图挂载')
    time.sleep(0.6)
    cdp.eval(f"{DETAIL_ST}.toggleEditMode()")
    time.sleep(0.3)

    # a2) 添加第二颗行星（乐园星系默认仅 1 颗行星，需先添加才能测试「设为卫星」）
    added = add_planet_via_button(cdp, '行星')
    if not isinstance(added, dict) or 'id' not in added:
        return False, f'添加第二颗行星失败 ({added})'
    if added['after'] != added['before'] + 1 or added['parentId'] != '乐园星系':
        return False, f'添加行星后计数/属性异常 ({added})'
    time.sleep(0.3)

    # 系内至少两颗行星（乐园星 + 刚添加的行星）；优先选名字带「月/卫星」的还原用户场景
    names = _js_obj(cdp, f"""(() => JSON.stringify({DETAIL_ST}.planetLayouts
      .filter(p => !p.isMoon).map(p => p.displayName || p.name)))()""")
    if not isinstance(names, list) or len(names) < 2:
        return False, f'系内行星不足 2 颗，无法测试卫星 ({names})'
    moon_name = next((n for n in names if '月' in n or '卫星' in n), names[1])
    host_name = next(n for n in names if n != moon_name)
    # b) 右键第一颗 → 菜单应含「设为卫星…」与「查看信息」
    rc1 = ctx_click_planet(cdp, moon_name, None)
    if not (isinstance(rc1, str) and '"vis":true' in rc1.replace(' ', '')):
        return False, f'右键行星 {moon_name} 失败 ({rc1})'
    time.sleep(0.3)
    menu_raw = cdp.eval("""(() => JSON.stringify({
      visible: document.querySelectorAll('.context-menu').length > 0,
      items: Array.from(document.querySelectorAll('.context-menu .menu-item')).map(m => m.textContent),
    }))()""")
    menu = _js_obj(cdp, "1")  # placeholder to keep types stable
    try:
        menu = json.loads(menu_raw) if isinstance(menu_raw, str) else {}
    except Exception:
        menu = {'parse_error': str(menu_raw)[:200]}
    if not isinstance(menu, dict) or not menu.get('visible'):
        return False, f'右键未弹出菜单 raw={menu_raw!r} parsed={menu}'
    if not any('设为卫星' in t for t in menu['items']) or not any('查看信息' in t for t in menu['items']):
        return False, f'行星菜单缺少「设为卫星/查看信息」项 {menu["items"]}'

    # c) 点「设为卫星…」→ 菜单切到母行星列表 → 点母行星
    cdp.eval("""(() => {
      const item = Array.from(document.querySelectorAll('.context-menu .menu-item')).find(m => m.textContent.includes('设为卫星'));
      if (item) item.click();
    })()""")
    time.sleep(0.5)
    host_raw = cdp.eval("""(() => JSON.stringify({
      header: Array.from(document.querySelectorAll('.context-menu .menu-header')).map(m => m.textContent),
      hosts: Array.from(document.querySelectorAll('.context-menu .menu-item')).map(m => m.textContent),
    }))()""")
    try:
        host_menu = json.loads(host_raw) if isinstance(host_raw, str) else {}
    except Exception:
        host_menu = {'__raw__': str(host_raw)[:300]}
    if not isinstance(host_menu, dict) or not any('选择母行星' in h for h in host_menu.get('header', [])):
        return False, f'未进入母行星选择模式 raw={host_raw!r}'
    clicked = cdp.eval(f"""(() => {{
      const items = Array.from(document.querySelectorAll('.context-menu .menu-item'));
      const host = items.find(m => m.textContent.includes('{host_name}'));
      if (!host) return 'no-host';
      host.click();
      return 'ok';
    }})()""")
    if clicked != 'ok':
        return False, f'未点选母行星 {host_name} ({clicked})'
    time.sleep(0.3)

    # d) 断言：layer=moon + parentId=母行星 + 布局含 isMoon 锚定项（绕母星小轨道）
    state = _js_obj(cdp, f"""(() => {{
      const st = {DETAIL_ST};
      const s = {APP_STORE};
      const node = s.nodes.find(n => (n.displayName || n.name) === '{moon_name}');
      const host = s.nodes.find(n => (n.displayName || n.name) === '{host_name}');
      const moonLayout = st.planetLayouts.find(p => (p.displayName || p.name) === '{moon_name}');
      const hostLayout = st.planetLayouts.find(p => (p.displayName || p.name) === '{host_name}' && !p.isMoon);
      return JSON.stringify({{
        layer: node.layer, parentId: node.parentId, hostId: host.id,
        isMoon: moonLayout && moonLayout.isMoon === true,
        anchored: !!(moonLayout && hostLayout && Math.abs(Math.hypot(moonLayout.x - hostLayout.x, moonLayout.y - hostLayout.y) - moonLayout.moonOrbitRadius) < 0.001),
        inSysPlanets: s.currentSystemPlanets.some(p => p.id === node.id),
      }});
    }})()""")
    if not isinstance(state, dict):
        return False, f'卫星状态读取失败 ({state})'
    if state.get('layer') != 'moon' or state.get('parentId') != state.get('hostId'):
        return False, f'设为卫星后 layer/parentId 异常 {state}'
    if not state.get('isMoon') or not state.get('anchored'):
        return False, f'卫星未锚定母行星（布局无 isMoon 项或距离≠小轨道半径） {state}'
    if state.get('inSysPlanets'):
        return False, f'卫星仍出现在 currentSystemPlanets（应只经 systemBodies 取回） {state}'

    # e) 右键卫星 → 「取消卫星」→ 恢复 planet + 回到恒星系下
    rc2 = ctx_click_planet(cdp, moon_name, None)
    if not (isinstance(rc2, str) and '"vis":true' in rc2.replace(' ', '')):
        return False, f'右键卫星失败 ({rc2})'
    time.sleep(0.5)
    mm_raw = cdp.eval("""(() => JSON.stringify(
      Array.from(document.querySelectorAll('.context-menu .menu-item')).map(m => m.textContent)))()""")
    try:
        moon_menu = json.loads(mm_raw) if isinstance(mm_raw, str) else []
    except Exception:
        moon_menu = []
    if not isinstance(moon_menu, list) or not any('取消卫星' in t for t in moon_menu):
        return False, f'卫星菜单缺少「取消卫星」项 raw={mm_raw!r}'
    cdp.eval("""(() => {
      const item = Array.from(document.querySelectorAll('.context-menu .menu-item')).find(m => m.textContent.includes('取消卫星'));
      if (item) item.click();
    })()""")
    time.sleep(0.3)
    restored = _js_obj(cdp, f"""(() => {{
      const s = {APP_STORE};
      const node = s.nodes.find(n => (n.displayName || n.name) === '{moon_name}');
      return JSON.stringify({{ layer: node.layer, parentId: node.parentId, sysId: '乐园星系' }});
    }})()""")
    if not isinstance(restored, dict) or restored.get('layer') != 'planet' or restored.get('parentId') != '乐园星系':
        return False, f'取消卫星未恢复独立轨道 {restored}'

    # f) undo 一次（撤销「取消卫星」）→ 回到 moon 态；再 undo 一次 → 回到初始独立行星
    cdp.eval(f"{APP_STORE}.undo()")
    time.sleep(0.3)
    mid = _js_obj(cdp, f"""(() => {{
      const s = {APP_STORE};
      const node = s.nodes.find(n => (n.displayName || n.name) === '{moon_name}');
      return JSON.stringify({{ layer: node.layer, parentId: node.parentId, hostId: '{state.get("hostId")}' }});
    }})()""")
    if not isinstance(mid, dict) or mid.get('layer') != 'moon' or mid.get('parentId') != mid.get('hostId'):
        return False, f'undo×1 未恢复卫星态 {mid}'
    cdp.eval(f"{APP_STORE}.undo()")
    time.sleep(0.3)
    final = _js_obj(cdp, f"""(() => {{
      const s = {APP_STORE};
      const node = s.nodes.find(n => (n.displayName || n.name) === '{moon_name}');
      return JSON.stringify({{ layer: node.layer, parentId: node.parentId, sysId: '乐园星系' }});
    }})()""")
    if not isinstance(final, dict) or final.get('layer') != 'planet' or final.get('parentId') != '乐园星系':
        return False, f'undo×2 未回到初始独立行星 {final}'

    # g) 清场：undo 移除添加的行星 → redo×3 恢复到测试前的独立行星（与初始一致）
    cdp.eval(f"{APP_STORE}.undo()")
    cdp.eval(f"{APP_STORE}.redo()")
    cdp.eval(f"{APP_STORE}.redo()")
    cdp.eval(f"{APP_STORE}.redo()")

    return True, f'设为卫星→锚定绕行→取消→undo×2/redo×3 全链路正常（{moon_name} 绕 {host_name}）'
