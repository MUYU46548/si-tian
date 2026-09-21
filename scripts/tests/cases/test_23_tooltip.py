#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 23：行星画布悬停提示（R6）
覆盖：
  a) 悬停到地点节点 → 出现提示框，标题为节点名，meta 含层级
  b) 提示框 pointer-events: none（红线：绝不能拦截画布命中/点击）
  c) 移到空白处 → 提示框消失
  d) 拖拽期间抑制（mousedown 隐藏 / mouseup 恢复）
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
CANVAS = "document.querySelector('.planet-map-container .canvas-wrapper canvas')"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def move_to_world(cdp, wx, wy, evt='mousemove'):
    """在给定世界坐标处派发鼠标事件（屏幕坐标由 viewTransform 反算）"""
    return cdp.eval(f"""(() => {{
      const pm = {PM};
      const c = {CANVAS};
      if (!pm || !c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const sx = {wx} * vt.scale + vt.x + c.clientWidth / 2;
      const sy = {wy} * vt.scale + vt.y + c.clientHeight / 2;
      c.dispatchEvent(new MouseEvent('{evt}', {{
        clientX: Math.trunc(r.left + sx), clientY: Math.trunc(r.top + sy),
        bubbles: true, cancelable: true, button: 0,
      }}));
      return 'ok';
    }})()""")


def read_tip(cdp):
    return _j(cdp, f"""(() => {{
      const tip = document.querySelector('.planet-map-container .hover-tooltip');
      if (!tip) return JSON.stringify({{ visible: false }});
      const nameEl = tip.querySelector('.hover-tooltip-name');
      const metaEl = tip.querySelector('.hover-tooltip-meta');
      const tr = tip.getBoundingClientRect();
      return JSON.stringify({{
        visible: true,
        name: nameEl ? nameEl.textContent.trim() : null,
        meta: metaEl ? metaEl.textContent.trim() : null,
        pointerEvents: getComputedStyle(tip).pointerEvents,
        transform: tip.style.transform,
        w: Math.round(tr.width), h: Math.round(tr.height),
      }});
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    r = goto_planet(cdp, '曜川星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, f"!!{CANVAS}", desc='行星画布挂载')
    time.sleep(0.8)

    # 取一个可见的地点节点（适屏后其屏幕坐标必然落在画布内）
    target = _j(cdp, f"""(() => {{
      const pm = {PM};
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      pm.zoomFit();
      const places = store.currentPlanetPlaces || [];
      const p = places.find(x => x.coordinate && x.coordinate.x !== null && x.coordinate.y !== null);
      if (!p) return JSON.stringify({{ err: 'no-place', places: places.length }});
      return JSON.stringify({{ id: p.id, name: p.displayName || p.name, x: p.coordinate.x, y: p.coordinate.y }});
    }})()""")
    if not isinstance(target, dict) or 'x' not in target:
        return False, f'未找到可悬停的地点 {target}'
    time.sleep(0.6)

    # a) 悬停 → 提示框出现
    if move_to_world(cdp, target['x'], target['y']) != 'ok':
        return False, '派发 mousemove 失败'
    time.sleep(0.4)
    tip = read_tip(cdp)
    if not isinstance(tip, dict) or not tip.get('visible'):
        return False, f'悬停地点未出现提示框 {tip}'
    if tip.get('name') != target['name']:
        return False, f'提示框标题不符（期望 {target["name"]}） {tip}'
    if not tip.get('meta'):
        return False, f'提示框缺少 meta（层级） {tip}'
    if tip.get('pointerEvents') != 'none':
        return False, f'提示框必须 pointer-events:none，否则会拦截画布命中 {tip}'
    if not tip.get('transform'):
        return False, f'提示框未定位（transform 为空） {tip}'

    # d) 拖拽期间抑制：mousedown 隐藏 → mouseup 恢复（零位移，不改变数据）
    cdp.eval(f"""(() => {{
      const c = {CANVAS};
      const r = c.getBoundingClientRect();
      const vt = {PM}.renderer.viewTransform;
      const sx = Math.trunc(r.left + {target['x']} * vt.scale + vt.x + c.clientWidth / 2);
      const sy = Math.trunc(r.top + {target['y']} * vt.scale + vt.y + c.clientHeight / 2);
      c.dispatchEvent(new MouseEvent('mousedown', {{ clientX: sx, clientY: sy, bubbles: true, cancelable: true, button: 0 }}));
      return 'ok';
    }})()""")
    time.sleep(0.3)
    during = read_tip(cdp)
    if isinstance(during, dict) and during.get('visible'):
        return False, f'拖拽（mousedown）期间提示框应隐藏 {during}'
    cdp.eval(f"""(() => {{
      const c = {CANVAS};
      const r = c.getBoundingClientRect();
      const vt = {PM}.renderer.viewTransform;
      const sx = Math.trunc(r.left + {target['x']} * vt.scale + vt.x + c.clientWidth / 2);
      const sy = Math.trunc(r.top + {target['y']} * vt.scale + vt.y + c.clientHeight / 2);
      c.dispatchEvent(new MouseEvent('mouseup', {{ clientX: sx, clientY: sy, bubbles: true, cancelable: true, button: 0 }}));
      return 'ok';
    }})()""")
    time.sleep(0.3)
    after = read_tip(cdp)
    if not isinstance(after, dict) or not after.get('visible'):
        return False, f'拖拽结束后提示框未恢复 {after}'

    # c) 移到空白处 → 消失（在 JS 内扫描候选点，直接以「提示框消失」为判据：
    #    纯按距离避让地点不够 —— 地形多边形/区域/标记同样会命中并弹出提示）
    blank = _j(cdp, f"""(async () => {{
      const c = {CANVAS};
      const r = c.getBoundingClientRect();
      const hasTip = () => !!document.querySelector('.planet-map-container .hover-tooltip');
      for (let gy = 0.06; gy <= 0.94; gy += 0.11) {{
        for (let gx = 0.06; gx <= 0.94; gx += 0.11) {{
          const sx = Math.trunc(r.width * gx), sy = Math.trunc(r.height * gy);
          c.dispatchEvent(new MouseEvent('mousemove', {{
            clientX: Math.trunc(r.left + sx), clientY: Math.trunc(r.top + sy),
            bubbles: true, cancelable: true, button: 0,
          }}));
          await new Promise(res => setTimeout(res, 40));
          if (!hasTip()) return JSON.stringify({{ sx, sy }});
        }}
      }}
      return JSON.stringify({{ err: 'no-blank-spot' }});
    }})()""")
    if not isinstance(blank, dict) or 'sx' not in blank:
        return False, f'扫不到无命中空白点（画布被完全覆盖？） {blank}'
    gone = read_tip(cdp)
    if isinstance(gone, dict) and gone.get('visible'):
        return False, f'移到空白处提示框未消失 {gone}'

    return True, (f'悬停提示正常（地点「{target["name"]}」提示 {tip["name"]} / {tip["meta"]}，'
                  f'pointer-events={tip["pointerEvents"]}，拖拽抑制 + 空白处消失均通过）')
