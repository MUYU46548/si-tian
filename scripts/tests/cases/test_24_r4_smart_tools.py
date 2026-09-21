#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 24：R4 智能工具 —— 自动寻路（A* 沿等高线）+ 智能聚落（自动吸附最优位）
覆盖：
  a) 智能聚落：点击 → 生成 draft 城市节点，坐标吸附到点击点附近的最优格（非点击点本身），
     节点被选中；undo 可撤销
  b) 自动寻路：路线工具内开「自动寻路」→ 两次点击生成道路（多点折线，非两点直线）；
     **性能**：第二次点击（含 A* 计算）必须在 3s 内完成 —— 守住 placement.js 的
     O(n²)→空间哈希+堆 重写（旧实现 27k 格要 7 亿次 hypot，点一下卡死）
  c) 两者都走 store undo 栈
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet, enter_edit, click_canvas_at_world

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def land_points(cdp, count=2, gap=250):
    """挑 count 个「落在当前视口内」的陆地世界点（海拔 25~65，彼此间距 ≥gap），确定性扫描。

    注意：不能只按网格顺序取陆地 —— 地图边缘的陆地在 zoomFit 之后可能在视口外，
    点击会被 click_canvas_at_world 判为 out-of-view。这里用当前 viewTransform 把候选
    逐个换算成屏幕坐标并要求落在画布留白内。
    """
    return _j(cdp, f"""(() => {{
      const pm = {PM};
      const hm = pm.planetHeightBrush.ensureHeightmap();
      if (!hm || !hm.grid || !hm.grid.points || !hm.h) return JSON.stringify({{ err: 'no-heightmap' }});
      const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      if (!c) return JSON.stringify({{ err: 'no-canvas' }});
      const vt = pm.renderer.viewTransform;
      const cw = c.clientWidth, ch = c.clientHeight;
      const toSX = wx => wx * vt.scale + vt.x + cw / 2;
      const toSY = wy => wy * vt.scale + vt.y + ch / 2;
      const pts = hm.grid.points;
      const gx = i => Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const gy = i => Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const out = [];
      for (let i = 0; i < pts.length && out.length < {count}; i++) {{
        const h = hm.h[i];
        if (h < 25 || h > 65) continue;
        const x = gx(i), y = gy(i);
        const sx = toSX(x), sy = toSY(y);
        if (sx < 50 || sx > cw - 50 || sy < 50 || sy > ch - 50) continue;
        if (out.every(p => Math.hypot(p.x - x, p.y - y) >= {gap})) out.push({{ x, y, h }});
      }}
      return JSON.stringify({{ points: out, n: pts.length, cw, ch, scale: vt.scale }});
    }})()""")


def sink_land_spot(cdp, radius=45, sink_h=5):
    """在视口内指定一个陆地格，并把它半径内的格子临时改成海（h=sink_h），返回还原数据。

    为什么合成：zoomFit 拟合的是地形多边形包围盒，视野内可能全是可以建址的陆地，
    没有真实海/山可用 —— 而「点到不可建址处会挪位」正是智能聚落的核心语义。
    高度只改内存（mock 不写盘，用例结束后页面重载即还原），且这里显式备份原值。
    """
    return _j(cdp, f"""(() => {{
      const pm = {PM};
      const hm = pm.planetHeightBrush.ensureHeightmap();
      if (!hm || !hm.grid || !hm.grid.points) return JSON.stringify({{ err: 'no-heightmap' }});
      const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      const vt = pm.renderer.viewTransform;
      const cw = c.clientWidth, ch = c.clientHeight;
      const toSX = wx => wx * vt.scale + vt.x + cw / 2;
      const toSY = wy => wy * vt.scale + vt.y + ch / 2;
      const pts = hm.grid.points;
      const gx = i => Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const gy = i => Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      let target = -1;
      for (let i = 0; i < pts.length; i++) {{
        const h = hm.h[i];
        if (h < 30 || h > 60) continue;
        const sx = toSX(gx(i)), sy = toSY(gy(i));
        if (sx < 60 || sx > cw - 60 || sy < 60 || sy > ch - 60) continue;
        target = i; break;
      }}
      if (target < 0) return JSON.stringify({{ err: 'no-land-in-view' }});
      const tx = gx(target), ty = gy(target);
      const saved = [];
      for (let j = 0; j < pts.length; j++) {{
        if (Math.hypot(gx(j) - tx, gy(j) - ty) <= {radius}) {{
          saved.push([j, hm.h[j]]);
          hm.h[j] = {sink_h};
        }}
      }}
      return JSON.stringify({{ x: tx, y: ty, idx: target, sunk: saved.length, saved }});
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    r = goto_planet(cdp, '曜川星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')", desc='行星画布挂载')
    enter_edit(cdp)
    time.sleep(0.8)

    # 适屏 + 取陆地候选点（确保落在画布内）
    cand = _j(cdp, f"""(() => {{
      const pm = {PM};
      pm.zoomFit();
      return 'ok';
    }})()""")
    time.sleep(0.6)
    picks = land_points(cdp, count=2, gap=250)
    if not isinstance(picks, dict) or 'points' not in picks:
        return False, f'高度图不可用 {picks}'
    pts = picks['points']
    if len(pts) < 2:
        return False, f'陆地候选点不足 {picks}'

    # ============ a) 智能聚落 ============
    before = _j(cdp, f"JSON.stringify({{ n: {STORE}.nodes.length }})")
    _j(cdp, f"(() => {{ {PM}.setInteractionMode('settle'); return 'ok'; }})()")
    time.sleep(0.3)
    hit = click_canvas_at_world(cdp, pts[0]['x'], pts[0]['y'])
    if hit == 'out-of-view':
        return False, f'聚落点击点超出视口 {pts[0]}'
    time.sleep(0.8)
    settled = _j(cdp, f"""(() => {{
      const s = {STORE};
      const planet = s.currentPlanet ? s.currentPlanet.id : null;
      const fresh = s.nodes.filter(n => n.parentId === planet && !n.sourcePath && n.layer === 'city');
      const n = fresh[fresh.length - 1];
      return JSON.stringify({{
        count: s.nodes.length,
        node: n ? {{ id: n.id, name: n.name, layer: n.layer, draft: n.draft === true, x: n.coordinate.x, y: n.coordinate.y }} : null,
        selected: s.selectedNode ? s.selectedNode.id : null,
      }});
    }})()""")
    if not isinstance(settled, dict):
        return False, f'智能聚落链路异常 {settled}'
    if settled['count'] != before['n'] + 1 or not settled['node']:
        return False, f'智能聚落未创建节点 {settled}'
    n = settled['node']
    if not (n['layer'] == 'city' and n['draft']):
        return False, f'聚落节点形状异常（应为 draft city） {n}'
    off = ((n['x'] - pts[0]['x']) ** 2 + (n['y'] - pts[0]['y']) ** 2) ** 0.5
    if off > 120:
        return False, f'聚落吸附位置离点击点过远（{off:.0f} > 120） {n}'
    if settled['selected'] != n['id']:
        return False, f'放置后未选中新聚落 {settled}'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    undon = _j(cdp, f"JSON.stringify({{ n: {STORE}.nodes.length }})")
    if undon['n'] != before['n']:
        return False, f'智能聚落 undo 未回退 {undon}'

    # ============ a2) 点到不可建址处（合成海）→ 必须挪到可建陆地（真·吸附语义） ============
    water = sink_land_spot(cdp)
    if not isinstance(water, dict) or 'x' not in water:
        return False, f'视口内找不到可合成的陆地样本 {water}'
    _j(cdp, f"(() => {{ {PM}.setInteractionMode('settle'); return 'ok'; }})()")
    time.sleep(0.3)
    if click_canvas_at_world(cdp, water['x'], water['y']) == 'out-of-view':
        return False, f'合成海点点击超出视口 {water}'
    time.sleep(0.8)
    shifted = _j(cdp, f"""(() => {{
      const s = {STORE};
      const pm = {PM};
      const planet = s.currentPlanet ? s.currentPlanet.id : null;
      const fresh = s.nodes.filter(n => n.parentId === planet && !n.sourcePath && n.layer === 'city');
      const n = fresh[fresh.length - 1];
      if (!n) return JSON.stringify({{ err: 'no-node' }});
      const hm = pm.planetHeightBrush.ensureHeightmap();
      const pts = hm.grid.points;
      let bi = -1, bd = Infinity;
      for (let i = 0; i < pts.length; i++) {{
        const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        const d = Math.hypot(px - n.coordinate.x, py - n.coordinate.y);
        if (d < bd) {{ bd = d; bi = i; }}
      }}
      return JSON.stringify({{ x: n.coordinate.x, y: n.coordinate.y, h: bi >= 0 ? hm.h[bi] : null, id: n.id }});
    }})()""")
    if not isinstance(shifted, dict) or 'x' not in shifted:
        return False, f'海点放置链路异常 {shifted}'
    dx = ((shifted['x'] - water['x']) ** 2 + (shifted['y'] - water['y']) ** 2) ** 0.5
    if dx < 5:
        return False, f'点到不可建址处时聚落未挪动（偏移 {dx:.1f}m）—— 吸附逻辑失效 {shifted}'
    if shifted['h'] is None or shifted['h'] < 20 or shifted['h'] > 70:
        return False, f'聚落落在了不可建址处（海拔 {shifted["h"]}） {shifted}'
    # 还原被合成的海（内存态）
    _j(cdp, f"""(() => {{
      const pm = {PM};
      const hm = pm.planetHeightBrush.ensureHeightmap();
      const saved = {json.dumps(water['saved'])};
      for (const [i, v] of saved) hm.h[i] = v;
      return 'ok';
    }})()""")
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)

    # ============ b) 自动寻路 ============
    routes_before = _j(cdp, f"""JSON.stringify({{ n: (({STORE}.mapData['曜川星'] || {{}}).routes || []).length }})""")
    _j(cdp, f"(() => {{ {PM}.setInteractionMode('route'); {PM}.autoRoadEnabled = true; return 'ok'; }})()")
    time.sleep(0.3)
    click_canvas_at_world(cdp, pts[0]['x'], pts[0]['y'])   # 起点
    time.sleep(0.4)
    t0 = time.time()
    click_canvas_at_world(cdp, pts[1]['x'], pts[1]['y'])   # 终点 → 触发 A*
    time.sleep(0.2)
    road = _j(cdp, f"""(() => {{
      const s = {STORE};
      const md = s.mapData['曜川星'] || {{}};
      const rs = md.routes || [];
      const r0 = rs[rs.length - 1];
      return JSON.stringify({{
        n: rs.length,
        len: r0 ? r0.points.length : 0,
        name: r0 ? r0.name : null,
        first: r0 && r0.points.length ? r0.points[0] : null,
        last: r0 && r0.points.length ? r0.points[r0.points.length - 1] : null,
        allFinite: r0 ? r0.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) : false,
      }});
    }})()""")
    elapsed = time.time() - t0
    if not isinstance(road, dict):
        return False, f'自动寻路链路异常 {road}'
    if road['n'] != routes_before['n'] + 1:
        return False, f'未生成道路 {road}'
    if road['len'] < 3:
        return False, f'道路路径点过少（应沿等高线多点，非两点直线） {road}'
    if not road['allFinite']:
        return False, f'道路含非法坐标 {road}'
    # 端点应贴合所点位置（最近网格点）
    for end, want in ((road['first'], pts[0]), (road['last'], pts[1])):
        d = ((end['x'] - want['x']) ** 2 + (end['y'] - want['y']) ** 2) ** 0.5
        if d > 60:
            return False, f'道路端点偏离所点位置（{d:.0f}） {road}'
    if elapsed > 3.0:
        return False, f'自动寻路耗时 {elapsed:.1f}s —— placement 性能退化（应为 <3s）'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    undone = _j(cdp, f"""JSON.stringify({{ n: (({STORE}.mapData['曜川星'] || {{}}).routes || []).length }})""")
    if undone['n'] != routes_before['n']:
        return False, f'道路 undo 未回退 {undone}'

    _j(cdp, f"(() => {{ {PM}.setInteractionMode('pan'); return 'ok'; }})()")
    return True, (f'R4 智能工具通过：智能聚落（点陆地吸附偏移 {off:.0f}m；点合成海自动挪到陆地 {dx:.0f}m 且海拔 {shifted["h"]:.0f}，'
                  f'draft city + 选中 + undo）；自动寻路生成 {road["len"]} 点道路，耗时 {elapsed:.2f}s（<3s 性能闸门），undo 正常')
