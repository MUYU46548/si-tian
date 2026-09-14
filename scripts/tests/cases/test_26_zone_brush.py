#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 26：R5-2 AreaMap 区域笔刷 —— 涂抹落点合并成一块**命名**区域（一条 undo）
覆盖：
  a) 笔刷模式拖动 → 恰好新增 1 块区域，名称自动生成（笔刷区域 N），顶点数 ≥3
  b) 区域顶点贴合涂抹范围（不散架：都在落点包围盒 + 笔刷半径内）
  c) 一条 undo 撤销整块区域；redo 恢复
  d) 描边模式仍可用（老路径不被破坏）
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
AREA_EL = "document.querySelector('.area-map-container')"
AREA_ST = AREA_EL + ".__vueParentComponent.setupState"
CANVAS = "document.querySelector('.area-map-container .canvas-wrapper canvas')"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def zone_brush_stroke(cdp, pts, brush_size=60, mode='brush'):
    """真实事件链路：mousedown → mousemove×N → mouseup（一次涂抹/描边）

    pts 为世界坐标折线；准备状态与派发事件放在**同一个 eval** 内，
    避免多段 eval 之间组件重渲染导致交互态丢失。
    """
    return _j(cdp, f"""(async () => {{
      const st = {AREA_ST};
      const s = {STORE};
      const c = {CANVAS};
      if (!st || !c) return JSON.stringify({{ err: 'no-canvas' }});
      const areaId = st.props.areaNode ? st.props.areaNode.id : null;
      if (!areaId) return JSON.stringify({{ err: 'no-area' }});
      const before = (s.areaZones[areaId] || []).length;

      st.editMode = true;
      st.interactionMode = 'zone';
      st.zoneBrushMode = {str(mode == 'brush').lower()};
      st.zoneBrushSize = {brush_size};
      st.zoneColor = '#4ECDC4';
      await new Promise(r => setTimeout(r, 60));

      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const toSX = wx => Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const toSY = wy => Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t, wx, wy) => new MouseEvent(t, {{ clientX: toSX(wx), clientY: toSY(wy),
        bubbles: true, cancelable: true, button: 0 }});
      const pts = {json.dumps(pts)};
      c.dispatchEvent(mk('mousedown', pts[0][0], pts[0][1]));
      for (let i = 1; i < pts.length; i++) c.dispatchEvent(mk('mousemove', pts[i][0], pts[i][1]));
      const last = pts[pts.length - 1];
      c.dispatchEvent(mk('mouseup', last[0], last[1]));
      await new Promise(r2 => setTimeout(r2, 150));

      const zones = (s.areaZones[areaId] || []);
      const z = zones[zones.length - 1];
      return JSON.stringify({{
        areaId, before, after: zones.length,
        zone: z ? {{ name: z.name, color: z.color, n: z.points.length, points: z.points }} : null,
      }});
    }})()""")


def zones_of(cdp, area_id):
    return _j(cdp, f"""(() => {{
      const s = {STORE};
      const zs = s.areaZones[{json.dumps(area_id)}] || [];
      return JSON.stringify({{ n: zs.length, names: zs.map(z => z.name) }});
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    setup = _j(cdp, f"""(() => {{
      const s = {STORE};
      const area = s.nodes.find(n => n.layer === 'region');
      if (!area) return JSON.stringify({{ err: 'no-region-node' }});
      s.selectArea(area);
      return JSON.stringify({{ id: area.id, level: s.viewLevel }});
    }})()""")
    if not isinstance(setup, dict) or 'id' not in setup:
        return False, f'未找到区域节点 {setup}'
    wait_for(cdp, f"!!{CANVAS}", desc='区域画布挂载')
    time.sleep(0.8)

    area_id = setup['id']

    # a+b) 笔刷涂抹：一条折线扫过
    stroke = [(0, 0), (60, 20), (120, 40), (180, 30), (220, 0)]
    res = zone_brush_stroke(cdp, stroke, brush_size=60, mode='brush')
    if not isinstance(res, dict) or 'after' not in res:
        return False, f'区域笔刷链路异常 {res}'
    if res['after'] != res['before'] + 1:
        return False, f'涂抹后区域数异常（{res["before"]} → {res["after"]}，期望 +1）'
    z = res['zone']
    if not z:
        return False, f'未取到新区域 {res}'
    if not (z['name'] or '').startswith('笔刷区域'):
        return False, f'笔刷区域未自动命名（得到 {z["name"]!r}）—— 又变成无名垃圾多边形？'
    if z['n'] < 3:
        return False, f'区域顶点数不足 {z}'
    if z['color'] != '#4ECDC4':
        return False, f'区域未使用所选颜色 {z}'

    # 顶点应贴合涂抹范围：x ∈ [min-dx-r, max-dx+r]，y 同理（半径 = 60/2 = 30，留容差）
    xs = [p['x'] for p in z['points']]
    ys = [p['y'] for p in z['points']]
    sx = [p[0] for p in stroke]
    sy = [p[1] for p in stroke]
    if min(xs) < min(sx) - 40 or max(xs) > max(sx) + 40:
        return False, f'区域横向超出涂抹范围 x:{min(xs)}~{max(xs)}（涂抹 {min(sx)}~{max(sx)}）'
    if min(ys) < min(sy) - 40 or max(ys) > max(sy) + 40:
        return False, f'区域纵向超出涂抹范围 y:{min(ys)}~{max(ys)}（涂抹 {min(sy)}~{max(sy)}）'
    # 凸包应覆盖涂抹两端（不是退化的一小团）
    if max(xs) - min(xs) < 100:
        return False, f'区域过小（宽度 {max(xs) - min(xs)}），涂抹未被完整合并'

    # c) 一条 undo
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    undone = zones_of(cdp, area_id)
    if undone['n'] != res['before']:
        return False, f'一次撤销未撤掉整块区域（{undone}）'
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.4)
    redone = zones_of(cdp, area_id)
    if redone['n'] != res['before'] + 1:
        return False, f'重做未恢复区域（{redone}）'

    # d) 描边模式仍可用（老路径）
    stroke2 = [(0, 120), (80, 140), (140, 120), (200, 150)]
    res2 = zone_brush_stroke(cdp, stroke2, mode='stroke')
    if not isinstance(res2, dict) or res2.get('after') != redone['n'] + 1:
        return False, f'描边模式被破坏 {res2}'

    # 清场
    _j(cdp, f"(() => {{ const s = {STORE}; s.undo(); s.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    return True, (f'区域笔刷通过：涂抹 → 自动命名「{z["name"]}」{z["n"]} 顶点单块区域'
                  f'（颜色 {z["color"]}、贴合涂抹范围）、一次 undo 全撤 + redo 恢复、描边模式仍正常')
