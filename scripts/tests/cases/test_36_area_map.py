#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 36：P2-1 AreaMap 独立测试（区域地图专项）

此前 AreaMap 无独立用例（仅有 test_26 覆盖 R5-2 区域笔刷一条路径）。本用例把
「进入区域地图 → 区域 / 道路 / 标记 / 文本 四类编辑」拉成一条完整链路：

  a) 基础导航：selectArea(region) → viewLevel=area + 画布挂载
  b) 区域笔刷：涂抹 → 恰好 +1 块「笔刷区域 N」+ 一条 undo 全撤
  c) 多边形编辑：点空白命中区域面 → 选中；拖顶点 → 坐标变化；一条 undo 复原
  d) 道路工具：连点 3 点 → 双击收尾 → areaRoutes +1（顶点数=3）+ 一条 undo
  e) 标记放置：点击 → areaMarkers +1，落点与点击世界坐标一致
  f) 文本标签：点击 → 输入对话框 → 确定 → areaTextLabels +1（内容/字号正确）

子测试彼此独立：任一失败只记录原因、继续跑后面的（最后汇总），不清空整条链路。
所有写操作都走 store 的 undo 命令，用例结束统一回滚，对真实数据零污染
（mock 的 saveMapData 本就不落盘）。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
AREA_EL = "document.querySelector('.area-map-container')"
AM = AREA_EL + ".__vueParentComponent.setupState"
CANVAS = "document.querySelector('.area-map-container .canvas-wrapper canvas')"

# 现有真实库中 乐园星 下的区域节点（geodata：庆云岛 / 两城流域）
DEFAULT_AREA = '庆云岛'


def _j(cdp, expr):
    """eval 并解析 JSON 串；非串/解析失败原样返回（供失败信息）"""
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def goto_area_map(cdp, area_name=DEFAULT_AREA):
    """导航到指定区域地图（世界/行星层由 store 直接选中，不依赖 UI 层级跳转）。

    返回 dict：{ id, name, level, canvas }；失败返回 {'err': ...}
    """
    return _j(cdp, f"""(() => {{
      const s = {STORE};
      const regions = s.nodes.filter(n => n.layer === 'region');
      const area = regions.find(n => n.name === {json.dumps(area_name)}) || regions[0];
      if (!area) return JSON.stringify({{ err: 'no-region-node', regions: [] }});
      s.selectArea(area);
      const el = document.querySelector('.area-map-container');
      return JSON.stringify({{
        id: area.id, name: area.name, level: s.viewLevel,
        canvas: !!(el && el.querySelector('.canvas-wrapper canvas')),
        regions: regions.map(n => n.name),
      }});
    }})()""")


def zone_ids(cdp, area_id):
    return _j(cdp, f"""(() => {{
      const zs = {STORE}.areaZones[{json.dumps(area_id)}] || [];
      return JSON.stringify({{ n: zs.length, names: zs.map(z => z.name) }});
    }})()""")


def counts(cdp, area_id):
    return _j(cdp, f"""(() => {{
      const s = {STORE};
      const id = {json.dumps(area_id)};
      return JSON.stringify({{
        zones: (s.areaZones[id] || []).length,
        routes: (s.areaRoutes[id] || []).length,
        markers: (s.areaMarkers[id] || []).length,
        texts: (s.areaTextLabels[id] || []).length,
      }});
    }})()""")


# ─────────────────────────────────────────────────────────────
# a) 基础导航
# ─────────────────────────────────────────────────────────────
def sub_navigation(cdp):
    nav = goto_area_map(cdp)
    if not isinstance(nav, dict) or 'id' not in nav:
        return False, f'未找到区域节点 {nav}', None
    if nav['level'] != 'area':
        return False, f'选中区域后未切到区域视图（viewLevel={nav["level"]}）', None
    wait_for(cdp, f"!!{CANVAS}", desc='区域画布挂载')
    time.sleep(0.6)
    # 画布确已挂载 + 渲染器可用（后续子测试依赖 viewTransform）
    info = _j(cdp, f"""(() => {{
      const st = {AM};
      const c = {CANVAS};
      if (!st || !c) return JSON.stringify({{ err: 'no-canvas' }});
      const vt = st.renderer.viewTransform;
      return JSON.stringify({{
        areaId: st.props.areaNode ? st.props.areaNode.id : null,
        w: c.clientWidth, h: c.clientHeight,
        scale: vt.scale,
      }});
    }})()""")
    if not isinstance(info, dict) or 'scale' not in info:
        return False, f'区域画布/渲染器不可用 {info}', nav['id']
    if info['areaId'] != nav['id']:
        return False, f'画布 props.areaNode 与选中区域不一致 {info}', nav['id']
    if info['w'] < 100 or info['h'] < 100:
        return False, f'区域画布尺寸异常 {info}', nav['id']
    return True, f'导航通过：region「{nav["name"]}」→ viewLevel=area，画布 {info["w"]}×{info["h"]}、scale={info["scale"]:.2f}', nav['id']


# ─────────────────────────────────────────────────────────────
# b) 区域笔刷
# ─────────────────────────────────────────────────────────────
def zone_brush_stroke(cdp, pts, brush_size=60, mode='brush'):
    """真实事件链路：mousedown → mousemove×N → mouseup（一次涂抹/描边）"""
    return _j(cdp, f"""(async () => {{
      const st = {AM};
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
      st.gridSnapEnabled = false;
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
        zone: z ? {{ id: z.id, name: z.name, color: z.color, n: z.points.length, points: z.points }} : null,
      }});
    }})()""")


def sub_zone_brush(cdp, area_id):
    stroke = [(0, 0), (60, 20), (120, 40), (180, 30), (220, 0)]
    res = zone_brush_stroke(cdp, stroke, brush_size=60, mode='brush')
    if not isinstance(res, dict) or 'after' not in res:
        return False, f'区域笔刷链路异常 {res}', None
    if res['after'] != res['before'] + 1:
        return False, f'涂抹后区域数异常（{res["before"]} → {res["after"]}，期望 +1）', None
    z = res['zone']
    if not z:
        return False, f'未取到新区域 {res}', None
    if not (z['name'] or '').startswith('笔刷区域'):
        return False, f'区域未自动命名「笔刷区域 N」（得到 {z["name"]!r}）', None
    if z['n'] < 3:
        return False, f'区域顶点数不足 {z}', None
    if z['color'] != '#4ECDC4':
        return False, f'区域未使用所选颜色 {z}', None
    xs = [p['x'] for p in z['points']]
    ys = [p['y'] for p in z['points']]
    sx = [p[0] for p in stroke]
    sy = [p[1] for p in stroke]
    if min(xs) < min(sx) - 40 or max(xs) > max(sx) + 40 or min(ys) < min(sy) - 40 or max(ys) > max(sy) + 40:
        return False, f'区域顶点超出涂抹范围 x:{min(xs)}~{max(xs)} y:{min(ys)}~{max(ys)}', z
    if max(xs) - min(xs) < 100:
        return False, f'区域过小（宽 {max(xs) - min(xs)}），涂抹未被合并', z
    # 一条 undo
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    undone = zone_ids(cdp, area_id)
    if undone['n'] != res['before']:
        return False, f'一次撤销未撤掉整块笔刷区域 {undone}', z
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.35)
    redone = zone_ids(cdp, area_id)
    if redone['n'] != res['before'] + 1:
        return False, f'重做未恢复笔刷区域 {redone}', z
    return True, (f'区域笔刷通过：涂抹 → 自动命名「{z["name"]}」{z["n"]} 顶点单块区域'
                  f'（颜色 {z["color"]}、贴合涂抹范围）、一条 undo 全撤 + redo 恢复'), z


# ─────────────────────────────────────────────────────────────
# c) 多边形顶点编辑
# ─────────────────────────────────────────────────────────────
def sub_zone_vertex(cdp, area_id, zone):
    """点空白命中区域面 → 选中；拖顶点 → 坐标变化且持久化；一条 undo 复原"""
    zid = zone['id']
    # 选一个离区域质心最远的顶点来拖（离其它子节点更远，减少干扰）
    pts = zone['points']
    cx = sum(p['x'] for p in pts) / len(pts)
    cy = sum(p['y'] for p in pts) / len(pts)
    idx, far = 0, -1
    for i, p in enumerate(pts):
        d = (p['x'] - cx) ** 2 + (p['y'] - cy) ** 2
        if d > far:
            far, idx = d, i
    v0 = pts[idx]

    # ① 清空选中 → 点区域内部（用质心，避开顶点手柄与子节点）→ 应重新选中该区域
    picked = _j(cdp, f"""(async () => {{
      const st = {AM};
      const c = {CANVAS};
      if (!st || !c) return JSON.stringify({{ err: 'no-canvas' }});
      st.editMode = true;
      st.interactionMode = 'pan';
      st.gridSnapEnabled = false;
      st.selectedZone = null;
      await new Promise(r => setTimeout(r, 60));
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const wx = {cx}, wy = {cy};
      const sx = Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const sy = Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t) => new MouseEvent(t, {{ clientX: sx, clientY: sy, bubbles: true, cancelable: true, button: 0 }});
      c.dispatchEvent(mk('mousedown'));
      c.dispatchEvent(mk('mouseup'));
      await new Promise(r2 => setTimeout(r2, 120));
      const sz = st.selectedZone;
      return JSON.stringify({{ pickedId: sz ? sz.id : null, want: {json.dumps(zid)} }});
    }})()""")
    if not isinstance(picked, dict) or picked.get('pickedId') != zid:
        return False, f'点击区域内部未进入编辑态（选中 {picked}，期望 {zid}）'

    # ② 拖顶点（真实事件链路）—— 期望值由**量化后的屏幕像素**反解，
    # 否则 1px 截断误差 ÷ scale(0.25) = 4 世界单位，精确断言必然偶发失败
    dx, dy = 90, 70
    before = _j(cdp, f"""(() => {{
      const z = (({STORE}.areaZones[{json.dumps(area_id)}]) || []).find(z => z.id === {json.dumps(zid)});
      const p = z.points[{idx}];
      return JSON.stringify({{ x: p.x, y: p.y }});
    }})()""")
    dragged = _j(cdp, f"""(async () => {{
      const st = {AM};
      const c = {CANVAS};
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const toSX = wx => Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const toSY = wy => Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const fromSX = sx => (sx - r.left - c.clientWidth / 2 - vt.x) / vt.scale;
      const fromSY = sy => (sy - r.top - c.clientHeight / 2 - vt.y) / vt.scale;
      const mk = (t, sx, sy) => new MouseEvent(t, {{ clientX: sx, clientY: sy,
        bubbles: true, cancelable: true, button: 0 }});
      const x0 = {v0['x']}, y0 = {v0['y']};
      const eSX = toSX(x0 + {dx}), eSY = toSY(y0 + {dy});
      const expect = [fromSX(eSX), fromSY(eSY)];
      c.dispatchEvent(mk('mousedown', toSX(x0), toSY(y0)));
      c.dispatchEvent(mk('mousemove', toSX(x0 + {dx // 3}), toSY(y0 + {dy // 3})));
      c.dispatchEvent(mk('mousemove', toSX(x0 + {2 * dx // 3}), toSY(y0 + {2 * dy // 3})));
      c.dispatchEvent(mk('mousemove', eSX, eSY));
      c.dispatchEvent(mk('mouseup', eSX, eSY));
      await new Promise(r2 => setTimeout(r2, 150));
      const z = (({STORE}.areaZones[{json.dumps(area_id)}]) || []).find(z => z.id === {json.dumps(zid)});
      const p = z.points[{idx}];
      return JSON.stringify({{ x: p.x, y: p.y, n: z.points.length, expect }});
    }})()""")
    if not isinstance(dragged, dict) or 'x' not in dragged:
        return False, f'顶点拖拽链路异常 {dragged}'
    exp = dragged.get('expect') or [v0['x'] + dx, v0['y'] + dy]
    if abs(dragged['x'] - exp[0]) > 2 or abs(dragged['y'] - exp[1]) > 2:
        return False, (f'顶点未跟随拖拽（{before} → ({dragged["x"]:.1f},{dragged["y"]:.1f})，'
                       f'期望 ({exp[0]:.1f},{exp[1]:.1f})）')
    if dragged['n'] != len(pts):
        return False, f'拖顶点改变了顶点数（{len(pts)} → {dragged["n"]}）'

    # ③ 一条 undo 复原
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    back = _j(cdp, f"""(() => {{
      const z = (({STORE}.areaZones[{json.dumps(area_id)}]) || []).find(z => z.id === {json.dumps(zid)});
      const p = z.points[{idx}];
      return JSON.stringify({{ x: p.x, y: p.y, n: z.points.length }});
    }})()""")
    if abs(back['x'] - v0['x']) > 1 or abs(back['y'] - v0['y']) > 1:
        return False, f'顶点拖拽的撤销未复原（{dragged} → {back}，期望 {v0}）'
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.25)
    return True, (f'多边形编辑通过：点击区域面选中（id 命中）→ 拖顶点 {idx} 位移 '
                  f'({v0["x"]:.0f},{v0["y"]:.0f})→({dragged["x"]:.0f},{dragged["y"]:.0f})、顶点数不增、'
                  f'一条 undo 复原、redo 可重放')


# ─────────────────────────────────────────────────────────────
# d) 道路工具
# ─────────────────────────────────────────────────────────────
def sub_route(cdp, area_id):
    before = counts(cdp, area_id)['routes']
    pts = [(300, 300), (420, 360), (520, 300)]
    res = _j(cdp, f"""(async () => {{
      const st = {AM};
      const s = {STORE};
      const c = {CANVAS};
      if (!st || !c) return JSON.stringify({{ err: 'no-canvas' }});
      const areaId = st.props.areaNode.id;
      const b = (s.areaRoutes[areaId] || []).length;
      st.editMode = true;
      st.interactionMode = 'route';
      st.routeColor = '#F39C12';
      st.gridSnapEnabled = false;
      await new Promise(r => setTimeout(r, 60));
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const toSX = wx => Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const toSY = wy => Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t, wx, wy) => new MouseEvent(t, {{ clientX: toSX(wx), clientY: toSY(wy),
        bubbles: true, cancelable: true, button: 0 }});
      const pts = {json.dumps(pts)};
      for (const [wx, wy] of pts) {{
        c.dispatchEvent(mk('mousedown', wx, wy));
        c.dispatchEvent(mk('mouseup', wx, wy));
        await new Promise(r3 => setTimeout(r3, 40));
      }}
      const draft = st.routeDraftPoints.length;
      // 双击收尾（dblclick 不派发 click，直接用已落顶点）
      c.dispatchEvent(new MouseEvent('dblclick', {{ clientX: toSX(pts[2][0]), clientY: toSY(pts[2][1]),
        bubbles: true, cancelable: true, button: 0 }}));
      await new Promise(r2 => setTimeout(r2, 150));
      const routes = (s.areaRoutes[areaId] || []);
      const rt = routes[routes.length - 1];
      return JSON.stringify({{ before: b, after: routes.length, draft,
        route: rt ? {{ name: rt.name, color: rt.color, n: rt.points.length, points: rt.points, dashed: !!rt.dashed }} : null }});
    }})()""")
    if not isinstance(res, dict) or 'after' not in res:
        return False, f'道路绘制链路异常 {res}'
    if res['draft'] != 3:
        return False, f'连点未落顶点（draft={res["draft"]}，期望 3）'
    if res['after'] != before + 1:
        return False, f'道路未生成（{before} → {res["after"]}，期望 +1）'
    rt = res['route']
    if not rt or rt['n'] != 3:
        return False, f'道路顶点数与点击不符 {rt}'
    if rt['color'] != '#F39C12':
        return False, f'道路未使用所选颜色 {rt}'
    if not (rt['name'] or '').startswith('道路'):
        return False, f'道路未自动命名（{rt["name"]!r}）'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    after_undo = counts(cdp, area_id)['routes']
    if after_undo != before:
        return False, f'道路未走 undo（撤销后 {after_undo}，期望 {before}）'
    return True, (f'道路工具通过：连点 3 点（draft=3）→ 双击收尾生成「{rt["name"]}」'
                  f'{rt["n"]} 顶点道路（颜色 {rt["color"]}）、一条 undo 撤销')


# ─────────────────────────────────────────────────────────────
# e) 标记放置
# ─────────────────────────────────────────────────────────────
def sub_marker(cdp, area_id):
    before = counts(cdp, area_id)['markers']
    mx, my = 260, -180
    res = _j(cdp, f"""(async () => {{
      const st = {AM};
      const s = {STORE};
      const c = {CANVAS};
      if (!st || !c) return JSON.stringify({{ err: 'no-canvas' }});
      const areaId = st.props.areaNode.id;
      const b = (s.areaMarkers[areaId] || []).length;
      st.editMode = true;
      st.interactionMode = 'marker';
      st.markerIcon = 'map-pin';
      st.gridSnapEnabled = false;
      await new Promise(r => setTimeout(r, 60));
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const wx = {mx}, wy = {my};
      const sx = Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const sy = Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t) => new MouseEvent(t, {{ clientX: sx, clientY: sy, bubbles: true, cancelable: true, button: 0 }});
      c.dispatchEvent(mk('mousedown'));
      c.dispatchEvent(mk('mouseup'));
      await new Promise(r2 => setTimeout(r2, 150));
      const ms = (s.areaMarkers[areaId] || []);
      const m = ms[ms.length - 1];
      return JSON.stringify({{ before: b, after: ms.length,
        marker: m ? {{ id: m.id, icon: m.icon, x: m.x, y: m.y }} : null }});
    }})()""")
    if not isinstance(res, dict) or 'after' not in res:
        return False, f'标记放置链路异常 {res}'
    if res['after'] != before + 1:
        return False, f'标记未生成（{before} → {res["after"]}，期望 +1）'
    m = res['marker']
    if not m:
        return False, f'未取到新标记 {res}'
    # 落点 = 点击处的世界坐标（1 屏幕像素在 scale 下等价的世界单位）
    tol = 1 / max(0.05, abs(_j(cdp, f"{AM}.renderer.viewTransform.scale") or 1)) + 1
    if abs(m['x'] - mx) > tol or abs(m['y'] - my) > tol:
        return False, f'标记落点偏移（期望 ({mx},{my})，得到 ({m["x"]},{m["y"]})，容差 {tol:.1f}）'
    if m['icon'] != 'map-pin':
        return False, f'标记图标未使用所选类型 {m}'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    after_undo = counts(cdp, area_id)['markers']
    if after_undo != before:
        return False, f'标记未走 undo（撤销后 {after_undo}，期望 {before}）'
    return True, (f'标记放置通过：点击 → 标记落点 ({m["x"]:.1f},{m["y"]:.1f}) 与点击世界坐标一致'
                  f'（容差 {tol:.1f}）、图标 {m["icon"]}、一条 undo 撤销')


# ─────────────────────────────────────────────────────────────
# f) 文本标签
# ─────────────────────────────────────────────────────────────
def sub_text(cdp, area_id):
    before = counts(cdp, area_id)['texts']
    tx, ty, TEXT = 140, 240, '测试区域标签'
    res = _j(cdp, f"""(async () => {{
      const st = {AM};
      const s = {STORE};
      const c = {CANVAS};
      if (!st || !c) return JSON.stringify({{ err: 'no-canvas' }});
      const areaId = st.props.areaNode.id;
      const b = (s.areaTextLabels[areaId] || []).length;
      st.editMode = true;
      st.interactionMode = 'text';
      st.textFontSize = 16;
      st.textColor = '#FFFFFF';
      st.gridSnapEnabled = false;
      await new Promise(r => setTimeout(r, 60));
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const wx = {tx}, wy = {ty};
      const sx = Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const sy = Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t) => new MouseEvent(t, {{ clientX: sx, clientY: sy, bubbles: true, cancelable: true, button: 0 }});
      c.dispatchEvent(mk('mousedown'));
      c.dispatchEvent(mk('mouseup'));
      // 等 Vue 渲染出输入对话框（下一个 tick）
      await new Promise(r2 => setTimeout(r2, 150));
      const dlg = document.querySelector('.area-map-container .modal-dialog');
      const opened = !!dlg;
      const input = dlg ? dlg.querySelector('input') : null;
      if (!input) {{
        return JSON.stringify({{ before: b, after: (s.areaTextLabels[areaId] || []).length,
          opened, err: 'no-input' }});
      }}
      // 受控输入：必须走原型 setter + input 事件，直接赋值不会同步到 v-model
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, {json.dumps(TEXT)});
      input.dispatchEvent(new Event('input', {{ bubbles: true }}));
      const confirm = Array.from(dlg.querySelectorAll('button')).find(x => x.textContent.trim() === '确定');
      const clicked = !!confirm;
      if (confirm) confirm.click();
      await new Promise(r3 => setTimeout(r3, 200));
      const ls = (s.areaTextLabels[areaId] || []);
      const l = ls[ls.length - 1];
      return JSON.stringify({{
        before: b, after: ls.length, opened, clicked,
        closed: !document.querySelector('.area-map-container .modal-dialog'),
        label: l ? {{ text: l.text, x: l.x, y: l.y, fontSize: l.fontSize, color: l.color }} : null,
      }});
    }})()""")
    if not isinstance(res, dict) or 'after' not in res:
        return False, f'文本标签链路异常 {res}'
    if not res.get('opened'):
        return False, f'点击后未弹出输入对话框 {res}'
    if not res.get('clicked'):
        return False, f'对话框缺少「确定」按钮 {res}'
    if res['after'] != before + 1:
        return False, f'文本标签未生成（{before} → {res["after"]}，期望 +1）{res}'
    lb = res['label']
    if not lb or lb['text'] != TEXT:
        return False, f'文本内容不符（期望 {TEXT!r}，得到 {lb}）'
    tol = 1 / max(0.05, abs(_j(cdp, f"{AM}.renderer.viewTransform.scale") or 1)) + 1
    if abs(lb['x'] - tx) > tol or abs(lb['y'] - ty) > tol:
        return False, f'文本落点偏移（期望 ({tx},{ty})，得到 ({lb["x"]},{lb["y"]})）'
    if lb['fontSize'] != 16 or lb['color'] != '#FFFFFF':
        return False, f'文本样式未跟随工具栏设置 {lb}'
    if not res.get('closed'):
        return False, f'确定后对话框未关闭 {res}'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    after_undo = counts(cdp, area_id)['texts']
    if after_undo != before:
        return False, f'文本标签未走 undo（撤销后 {after_undo}，期望 {before}）'
    return True, (f'文本标签通过：点击 → 输入对话框（含确定）→ 内容「{lb["text"]}」落位 '
                  f'({lb["x"]:.1f},{lb["y"]:.1f})、字号 {lb["fontSize"]}、颜色 {lb["color"]}、'
                  f'对话框关闭、一条 undo 撤销')


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    results = []
    ok, detail, area_id = sub_navigation(cdp)
    results.append(('a 基础导航', ok, detail))
    if not area_id:
        return False, '\n    '.join(f'{n}: {"✅" if o else "❌"} {d}' for n, o, d in results)

    # b) 区域笔刷 —— 同时为 c) 备好一块区域
    ok, detail, zone = sub_zone_brush(cdp, area_id)
    results.append(('b 区域笔刷', ok, detail))
    if not (ok and zone):
        return False, '\n    '.join(f'{n}: {"✅" if o else "❌"} {d}' for n, o, d in results)

    # c) 多边形顶点编辑（复用 b 的笔刷区域）
    ok, detail = sub_zone_vertex(cdp, area_id, zone)
    results.append(('c 多边形编辑', ok, detail))

    for name, fn in (('d 道路工具', sub_route), ('e 标记放置', sub_marker), ('f 文本标签', sub_text)):
        try:
            ok, detail = fn(cdp, area_id)
        except Exception as e:  # 子测试异常不阻断后续
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    # 统一回滚（b/c 留下的区域 + 可能残留的命令）
    _j(cdp, f"(() => {{ const s = {STORE}; for (let i = 0; i < 8; i++) s.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    left = counts(cdp, area_id)

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    tail = (f' | 清场后残留 zones={left["zones"]} routes={left["routes"]} '
            f'markers={left["markers"]} texts={left["texts"]}')
    if failed:
        return False, '区域地图 ' + f'{len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    ' + '\n    '.join(failed)
    return True, (f'AreaMap 独立测试 {len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results) + tail)
