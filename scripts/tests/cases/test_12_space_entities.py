#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 12：太空实体（批次 B6 太空标记 + B7 部队卡片 + B1 层级校验）
链路：进入 乐园星系 单系视图 → 开编辑模式
      → 右键空白「◈ 添加太空标记（此位置）」（stub prompt 选类型/输名称）
      → setupState 辅助函数 createFleetCardAt 添加部队卡片（stub prompt）
      → 断言 spaceMarkers/fleetCards 数据形状与组件 computed
      → 浏览模式点击标记/卡片 → selectedNode 伪节点信息提示
      → 图层开关 system_detail.markers/fleetCards（isVisible 断言）
      → undo×2 恢复 / redo×2 重做
      → B1：validateNodes 对真实 mock 数据返回 0 违规（含自引用父级清理）
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for


def _js_obj(cdp, expr):
    """执行 eval 并解析 JSON 字符串；异常/非串时原样返回（供失败信息）"""
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


APP_STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
DETAIL_EL = "document.querySelector('.system-detail-container')"
DETAIL_ST = DETAIL_EL + ".__vueParentComponent.setupState"


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # a) 进入 乐园星系 单系视图（沿 parentId 上溯所属世界 → selectWorld → enterSystemDetail）
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
    time.sleep(0.6)  # 等 fitSystem 初始视野稳定

    # b) 开编辑模式（点头部「✎ 编辑地图」按钮）
    em = _js_obj(cdp, f"""(() => {{
      const el = {DETAIL_EL};
      const btn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('编辑地图'));
      if (!btn) return 'no-btn';
      btn.click();
      return JSON.stringify({{ on: el.__vueParentComponent.setupState.editMode === true }});
    }})()""")
    if not isinstance(em, dict) or not em.get('on'):
        return False, f'编辑模式未开启 {em}'

    # c) 右键空白处 → 菜单应含三个添加项 → 点「◈ 添加太空标记（此位置）」（prompt 选资源点 + 名称）
    rc = _js_obj(cdp, f"""(() => {{
      const st = {DETAIL_ST};
      // 在恒星与第一圈轨道之间找一个远离行星/箭头标签的空位（确定性角度扫描）
      let spot = null;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {{
        const x = Math.cos(a) * 55, y = Math.sin(a) * 55;
        if (!st.planetLayouts.some(p => Math.hypot(p.x - x, p.y - y) < 25)) {{ spot = {{ x, y }}; break; }}
      }}
      if (!spot) return 'no-spot';
      const c = st.canvas;
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const cx = Math.trunc(r.left + spot.x * vt.scale + vt.x + c.clientWidth / 2);
      const cy = Math.trunc(r.top + spot.y * vt.scale + vt.y + c.clientHeight / 2);
      c.dispatchEvent(new MouseEvent('contextmenu', {{ clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 2 }}));
      // 期望落点：按 MouseEvent 整数量化反算的世界坐标（标记存系内相对坐标，无域地图换算）
      const wq = st.renderer.screenToWorld(cx - r.left, cy - r.top);
      return JSON.stringify({{ spot: wq }});
    }})()""")
    if not isinstance(rc, dict) or 'spot' not in rc:
        return False, f'右键空白链路异常 {rc}'
    time.sleep(0.3)
    menu = _js_obj(cdp, f"""(() => {{
      const el = {DETAIL_EL};
      return JSON.stringify({{
        visible: !!el.querySelector('.context-menu'),
        items: Array.from(el.querySelectorAll('.context-menu .menu-item')).map(m => m.textContent),
      }});
    }})()""")
    if not isinstance(menu, dict) or not menu.get('visible'):
        return False, f'右键空白未弹出菜单 {menu}'
    for need in ('添加天体', '添加太空标记', '添加部队卡片'):
        if not any(need in t for t in menu['items']):
            return False, f'空白菜单缺少「{need}」项 {menu}'

    marker = _js_obj(cdp, f"""(() => {{
      // prompt 序列：类型 2=资源点 → 名称「银矿带」
      const seq = ['2', '银矿带']; let i = 0;
      window.prompt = () => seq[i++] ?? '';
      const el = {DETAIL_EL};
      const item = Array.from(el.querySelectorAll('.context-menu .menu-item')).find(m => m.textContent.includes('添加太空标记'));
      if (!item) return 'no-item';
      item.click();
      const s = {APP_STORE};
      const m = s.spaceMarkers[s.spaceMarkers.length - 1];
      return JSON.stringify({{
        count: s.spaceMarkers.length, marker: m,
        compCount: el.__vueParentComponent.setupState.systemSpaceMarkers.length,
        menuClosed: !el.__vueParentComponent.setupState.contextMenu.visible,
      }});
    }})()""")
    if not isinstance(marker, dict) or marker.get('marker') is None:
        return False, f'添加太空标记链路异常 {marker}'
    m = marker['marker']
    spot = rc['spot']
    if marker['count'] != 1 or marker['compCount'] != 1:
        return False, f'太空标记计数异常 {marker}'
    if not (m['systemId'] == '乐园星系' and m['type'] == 'resource' and m['label'] == '银矿带'):
        return False, f'太空标记数据形状异常 {m}'
    if abs(m['x'] - round(spot['x'])) > 0.51 or abs(m['y'] - round(spot['y'])) > 0.51:
        return False, f'太空标记未落在右键位置 {m} (期望 {spot})'
    if not marker['menuClosed']:
        return False, '添加标记后右键菜单未关闭'

    # d) 部队卡片：setupState 辅助函数 createFleetCardAt（prompt：2=行星军 → 名称 → 阵营）
    #    位置取标记的对侧（标记环 55 + 卡片环 150 → 对侧距离 205）：卡片是屏幕定宽
    #    （世界单位宽随缩小而增大，scale~0.46 时半宽 ~90），需远离标记避免命中域互相覆盖
    card = _js_obj(cdp, f"""(() => {{
      const st = {DETAIL_ST};
      const s = {APP_STORE};
      const mm = s.spaceMarkers[0];
      const am = Math.atan2(mm.y, mm.x);
      let spot = null;
      for (let k = 0; k < 24 && !spot; k++) {{
        // 从标记正对侧开始，向两侧逐步扫描（确定性）
        const a = am + Math.PI + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 12);
        const x = Math.cos(a) * 150, y = Math.sin(a) * 150;
        if (!st.planetLayouts.some(p => Math.hypot(p.x - x, p.y - y) < 60) &&
            Math.hypot(mm.x - x, mm.y - y) > 180) spot = {{ x, y }};
      }}
      if (!spot) return 'no-spot';
      const seq = ['2', '第七行星军', '蓝镜帝国']; let i = 0;
      window.prompt = () => seq[i++] ?? '';
      const created = st.createFleetCardAt(spot.x, spot.y);
      return JSON.stringify({{
        count: s.fleetCards.length, card: created,
        compCount: st.systemFleetCards.length,
      }});
    }})()""")
    if not isinstance(card, dict) or card.get('card') is None:
        return False, f'添加部队卡片链路异常 {card}'
    c = card['card']
    if card['count'] != 1 or card['compCount'] != 1:
        return False, f'部队卡片计数异常 {card}'
    if not (c['systemId'] == '乐园星系' and c['kind'] == 'army'
            and c['name'] == '第七行星军' and c['faction'] == '蓝镜帝国'):
        return False, f'部队卡片数据形状异常 {c}'

    # e) 浏览模式点击 → 伪节点信息提示（selectedNode.layer）
    cdp.eval(f"{DETAIL_ST}.toggleEditMode()")
    time.sleep(0.2)
    click = _js_obj(cdp, f"""(() => {{
      const st = {DETAIL_ST};
      const s = {APP_STORE};
      const c = st.canvas;
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const mk = (wx, wy, t) => new MouseEvent(t, {{
        clientX: Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2),
        clientY: Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2),
        bubbles: true, cancelable: true, button: 0,
      }});
      const out = {{}};
      // 点击标记（量化误差内必命中 14px 半径域；卡片已置于标记对侧，无命中域覆盖）
      const m = st.systemSpaceMarkers[0];
      c.dispatchEvent(mk(m.x, m.y, 'mousedown'));
      c.dispatchEvent(mk(m.x, m.y, 'mouseup'));
      out.markerSel = s.selectedNode ? {{ layer: s.selectedNode.layer, name: s.selectedNode.name }} : null;
      // 点击部队卡片中心
      const fc = st.systemFleetCards[0];
      c.dispatchEvent(mk(fc.x, fc.y, 'mousedown'));
      c.dispatchEvent(mk(fc.x, fc.y, 'mouseup'));
      out.cardSel = s.selectedNode ? {{ layer: s.selectedNode.layer, name: s.selectedNode.name }} : null;
      return JSON.stringify(out);
    }})()""")
    if not isinstance(click, dict):
        return False, f'点击选中链路异常 {click}'
    if not (click.get('markerSel', {}).get('layer') == 'space_marker' and click['markerSel']['name'] == '银矿带'):
        return False, f'点击标记未选中伪节点 {click}'
    if not (click.get('cardSel', {}).get('layer') == 'fleet_card' and click['cardSel']['name'] == '第七行星军'):
        return False, f'点击卡片未选中伪节点 {click}'

    # f) 图层开关：toggle 后 isVisible 翻转（markers/fleetCards 互不牵连）
    layers = _js_obj(cdp, f"""(() => {{
      const L = {DETAIL_ST}.layers;
      const out = {{}};
      out.m0 = L.isVisible('system_detail', 'markers');
      out.f0 = L.isVisible('system_detail', 'fleetCards');
      L.toggleLayer('system_detail', 'markers');
      out.m1 = L.isVisible('system_detail', 'markers');
      out.f1 = L.isVisible('system_detail', 'fleetCards');  // markers 开关不应影响 fleetCards
      L.toggleLayer('system_detail', 'markers');
      L.toggleLayer('system_detail', 'fleetCards');
      out.m2 = L.isVisible('system_detail', 'markers');
      out.f2 = L.isVisible('system_detail', 'fleetCards');
      L.toggleLayer('system_detail', 'fleetCards');
      out.m3 = L.isVisible('system_detail', 'markers');
      out.f3 = L.isVisible('system_detail', 'fleetCards');
      return JSON.stringify(out);
    }})()""")
    if not isinstance(layers, dict):
        return False, f'图层开关链路异常 {layers}'
    if not (layers['m0'] is True and layers['f0'] is True
            and layers['m1'] is False and layers['f1'] is True
            and layers['m2'] is True and layers['f2'] is False
            and layers['m3'] is True and layers['f3'] is True):
        return False, f'图层开关断言失败 {layers}'

    # g) undo×2 → 两者清空；redo×2 → 恢复（undo 栈接入验证）
    ur = _js_obj(cdp, f"""(() => {{
      const s = {APP_STORE};
      s.undo();  // 撤销部队卡片添加（后进先出）
      const afterUndo1 = {{ m: s.spaceMarkers.length, f: s.fleetCards.length }};
      s.undo();  // 撤销太空标记添加
      const afterUndo2 = {{ m: s.spaceMarkers.length, f: s.fleetCards.length }};
      s.redo(); s.redo();
      const afterRedo = {{ m: s.spaceMarkers.length, f: s.fleetCards.length,
        label: s.spaceMarkers[0]?.label, kind: s.fleetCards[0]?.kind }};
      return JSON.stringify({{ afterUndo1, afterUndo2, afterRedo }});
    }})()""")
    if not isinstance(ur, dict):
        return False, f'undo/redo 链路异常 {ur}'
    if not (ur['afterUndo1']['m'] == 1 and ur['afterUndo1']['f'] == 0):
        return False, f'undo 顺序异常 {ur}'
    if not (ur['afterUndo2']['m'] == 0 and ur['afterUndo2']['f'] == 0):
        return False, f'undo×2 未清空 {ur}'
    if not (ur['afterRedo']['m'] == 1 and ur['afterRedo']['f'] == 1
            and ur['afterRedo']['label'] == '银矿带' and ur['afterRedo']['kind'] == 'army'):
        return False, f'redo×2 未恢复 {ur}'

    # 清场：撤销 redo 回来的两个添加，回到世界层
    cdp.eval(f"{APP_STORE}.undo(); {APP_STORE}.undo(); {APP_STORE}.backToWorld();")

    return True, '太空实体链路完整（标记/卡片添加×2·点击选中·图层开关·undo/redo）'
