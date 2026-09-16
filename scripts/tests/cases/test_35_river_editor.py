#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 35：河流编辑器 —— 手动绘制 + 保持流向（P1-1）

验收点（对应提示词 P1-1 的「验收标准」逐条）：
1. 手动绘制成功（点击多节点 → 双击完成）
2. 河流自动从高流向低 —— 故意"先点低处再点高处"，落库后必须是从高到低
3. 拖拽节点不会反向 —— 把下游节点往高处拖，被 clamp 到上游高度之下
4. 向低处拖拽有效（不高处时不拦截）
5. 一次创建 = 单条 undo；删除河流 undo 正常
6. 数据落到 mapdata.json（rivers[]，节点带高度 h）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import goto_planet, enter_edit, click_canvas_at_world, dblclick_canvas_at_world, ensure_data_ready  # noqa: E402

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


def _hi_lo(cdp):
    """视口内最高 / 最低的两个陆地格（用于构造"逆序描点"）"""
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
      let lo = null, hi = null;
      for (let i = 0; i < pts.length; i++) {{
        const h = hm.h[i];
        if (h < 5 || h > 95) continue;
        const x = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const y = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        const sx = toSX(x), sy = toSY(y);
        if (sx < 70 || sx > cw - 70 || sy < 70 || sy > ch - 70) continue;
        if (!lo || h < lo.h) lo = {{ x, y, h }};
        if (!hi || h > hi.h) hi = {{ x, y, h }};
      }}
      return JSON.stringify({{ lo, hi }});
    }})()""")


def _rivers(cdp):
    return _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const rs = md.rivers || [];
      return JSON.stringify({{ n: rs.length, list: rs.map(r => ({{
        id: r.id, name: r.name, width: r.width,
        hs: (r.nodes || []).map(p => Math.round(p.h * 100) / 100),
        pts: (r.nodes || []).length,
      }})) }});
    }})()""")


def _drag(cdp, points):
    pts = json.dumps(points)
    return cdp.eval(f"""(() => {{
      const pm = {PM};
      const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      if (!pm || !c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const toSX = wx => wx * vt.scale + vt.x + c.clientWidth / 2;
      const toSY = wy => wy * vt.scale + vt.y + c.clientHeight / 2;
      const mk = (x, y, t) => new MouseEvent(t, {{
        clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0,
      }});
      const p = {pts};
      c.dispatchEvent(mk(toSX(p[0][0]), toSY(p[0][1]), 'mousedown'));
      for (let i = 1; i < p.length; i++) c.dispatchEvent(mk(toSX(p[i][0]), toSY(p[i][1]), 'mousemove'));
      const last = p[p.length - 1];
      c.dispatchEvent(mk(toSX(last[0]), toSY(last[1]), 'mouseup'));
      return 'ok';
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # ── 1. 算法层：流向排序 / 逆流检测 / 拖拽约束 ──────────────────────
    calc = _j(cdp, """(async () => {
      const m = await import('/src/utils/rivers.js');
      const nodes = [{x:0,y:0,h:30},{x:1,y:0,h:70},{x:2,y:0,h:50}];
      const sorted = m.normalizeRiverFlow(nodes);
      const before = m.flowViolations(nodes);
      const after = m.flowViolations(sorted);
      const heightAt = (x, y) => (x === 9 ? 100 : 20);   // 9 → 高（逆流目标）
      const up = m.clampRiverNode(sorted, 2, { x: 9, y: 0 }, heightAt);
      const down = m.clampRiverNode(sorted, 2, { x: 3, y: 0 }, heightAt);
      const w1 = m.widthByFlow(5), w2 = m.widthByFlow(50);
      return JSON.stringify({
        order: sorted.map(n => n.h),
        violationsBefore: before.length,
        violationsAfter: after.length,
        clampedUp: { h: up.point.h, clamped: up.clamped, reason: up.reason },
        clampedDown: { h: down.point.h, clamped: down.clamped },
        widths: [w1, w2],
      });
    })()""")
    if not isinstance(calc, dict):
        return False, f'河流工具模块不可用 {calc}'
    if calc['order'] != [70, 50, 30]:
        return False, f'normalizeRiverFlow 未按高度降序：{calc["order"]}'
    if calc['violationsBefore'] == 0 or calc['violationsAfter'] != 0:
        return False, f'逆流检测/排序后清零不成立：{calc}'
    if not calc['clampedUp']['clamped'] or calc['clampedUp']['h'] > 50:
        return False, f'往高处拖拽未被约束住（应 ≤ 上游 50）：{calc["clampedUp"]}'
    if calc['clampedDown']['clamped']:
        return False, f'往低处拖拽被误拦截：{calc["clampedDown"]}'
    if not (calc['widths'][1] > calc['widths'][0]):
        return False, f'按流量分级线宽未生效：{calc["widths"]}'

    # ── 2. 进入行星 + Shift+R 河流模式 ─────────────────────────────────
    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')", desc='行星画布挂载')
    time.sleep(1.0)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.7)
    _j(cdp, f"(() => {{ {PM}.zoomFit(); return 'ok'; }})()")
    time.sleep(0.6)

    cdp.eval("""(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', shiftKey: true, bubbles: true }));
      return 'ok';
    })()""")
    time.sleep(0.4)
    mode = _j(cdp, f"""JSON.stringify({{
      mode: {PM}.interactionMode,
      panel: !!document.querySelector('[data-testid="river-panel"]'),
    }})""")
    if mode.get('mode') != 'river' or not mode.get('panel'):
        return False, f'Shift+R 未进入河流模式 / 面板未渲染：{mode}'

    cdp.eval("""(() => {
      window.__savedMap = [];
      const api = window.sitianAPI;
      if (api && !api.__riverMapHooked) {
        api.saveMapData = async (key, data) => { window.__savedMap.push({ key, data }); return { success: true }; };
        api.__riverMapHooked = true;
      }
      return 'ok';
    })()""")

    hl = _hi_lo(cdp)
    if not isinstance(hl, dict) or not hl.get('lo') or not hl.get('hi'):
        return False, f'视口内找不到高低落差点 {hl}'
    lo, hi = hl['lo'], hl['hi']
    if hi['h'] - lo['h'] < 5:
        return False, f'视口内高度落差太小（{lo["h"]:.1f} → {hi["h"]:.1f}），无法验证流向'

    base_n = _rivers(cdp)['n']

    # ── 3. 逆序描点（先低后高）→ 双击完成 ──────────────────────────────
    if click_canvas_at_world(cdp, lo['x'], lo['y']) == 'out-of-view':
        return False, f'低点超出视口 {lo}'
    time.sleep(0.35)
    if click_canvas_at_world(cdp, hi['x'], hi['y']) == 'out-of-view':
        return False, f'高点超出视口 {hi}'
    time.sleep(0.35)
    dblclick_canvas_at_world(cdp, hi['x'], hi['y'])
    time.sleep(0.8)

    created = _rivers(cdp)
    if created['n'] != base_n + 1:
        return False, f'双击完成未生成河流（{base_n} → {created["n"]}）'
    river = created['list'][-1]
    if river['pts'] < 2:
        return False, f'河流节点过少 {river}'
    hs = river['hs']
    if any(hs[i] < hs[i + 1] - 0.35 for i in range(len(hs) - 1)):
        return False, f'河流没有从高到低（h 序列 {hs}）—— 流向排序失效'
    if abs(hs[0] - hi['h']) > 3:
        return False, f'河流源头不等于所点最高处（源头 {hs[0]:.1f} vs 高点 {hi["h"]:.1f}）—— 未按高度排序'

    # ── 4. 一次创建 = 单条 undo ────────────────────────────────────────
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.5)
    if _rivers(cdp)['n'] != base_n:
        return False, f'撤销未回退整条河流（{_rivers(cdp)["n"]} ≠ {base_n}）—— 创建被拆成多条 undo'
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.5)
    if _rivers(cdp)['n'] != base_n + 1:
        return False, '重做未恢复河流'

    # ── 5. 选中 + 往高处拖下游节点（必须被约束） ───────────────────────
    rid = river['id']
    sel = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.rivers || []).find(x => x.id === '{rid}');
      if (!r) return JSON.stringify({{ err: 'gone' }});
      const pm = {PM};
      pm.selectedRiver = r;
      const last = r.nodes[r.nodes.length - 1];
      const prev = r.nodes[r.nodes.length - 2];
      return JSON.stringify({{ ok: true, last: last, prev: prev, n: r.nodes.length }});
    }})()""")
    if not sel.get('ok'):
        return False, f'选中河流失败 {sel}'
    time.sleep(0.5)

    # 把最后一个（下游）节点拖到视口内最高点 → 高于上游，应被 clamp
    down_node = sel['last']
    before_h = down_node['h']
    before_up_h = sel['prev']['h']
    _drag(cdp, [[down_node['x'], down_node['y']], [hi['x'], hi['y']]])
    time.sleep(0.8)
    dragged = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.rivers || []).find(x => x.id === '{rid}');
      if (!r) return JSON.stringify({{ err: 'gone' }});
      const ns = r.nodes;
      return JSON.stringify({{
        hs: ns.map(p => Math.round(p.h * 100) / 100),
        allFinite: ns.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.h)),
        hint: (document.querySelector('[data-testid="river-flow-hint"]') || {{}}).textContent || '',
      }});
    }})()""")
    if dragged.get('err'):
        return False, f'拖拽后河流消失 {dragged}'
    new_hs = dragged['hs']
    if any(new_hs[i] < new_hs[i + 1] - 0.35 for i in range(len(new_hs) - 1)):
        return False, f'往高处拖拽后河流出现逆流（h 序列 {new_hs}）—— 未做流向约束'
    if new_hs[-1] > before_up_h + 0.001:
        return False, f'下游节点被拖到了上游之上（{new_hs[-1]:.1f} > {before_up_h:.1f}）'
    if not dragged.get('allFinite'):
        return False, f'拖拽后出现非法坐标 {dragged}'

    # 往低处拖（合法）→ 位置应真的变了
    # 注意：必须从节点**当前**位置按下（第一次拖拽已把节点 clamp 到别处，按原坐标会打空）
    low_target = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.rivers || []).find(x => x.id === '{rid}');
      const pm = {PM};
      const node = r.nodes[r.nodes.length - 1];
      const hm = pm.planetHeightBrush.ensureHeightmap();
      const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      const vt = pm.renderer.viewTransform;
      const cw = c.clientWidth, ch = c.clientHeight;
      const toSX = wx => wx * vt.scale + vt.x + cw / 2;
      const toSY = wy => wy * vt.scale + vt.y + ch / 2;
      const pts = hm.grid.points;
      for (let i = 0; i < pts.length; i++) {{
        const h = hm.h[i];
        if (h > node.h - 3 || h < 5) continue;
        const x = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const y = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        const sx = toSX(x), sy = toSY(y);
        if (sx < 60 || sx > cw - 60 || sy < 60 || sy > ch - 60) continue;
        return JSON.stringify({{ from: {{ x: node.x, y: node.y }}, to: {{ x, y, h }} }});
      }}
      return JSON.stringify({{ err: 'no-lower-point' }});
    }})()""")
    if not isinstance(low_target, dict) or 'to' not in low_target:
        return False, f'视口内找不到比节点更低的可拖目标 {low_target}'
    _drag(cdp, [[low_target['from']['x'], low_target['from']['y']], [low_target['to']['x'], low_target['to']['y']]])
    time.sleep(0.7)
    moved = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.rivers || []).find(x => x.id === '{rid}');
      const p = r.nodes[r.nodes.length - 1];
      return JSON.stringify({{ h: Math.round(p.h * 100) / 100, hs: r.nodes.map(n => Math.round(n.h * 100) / 100) }});
    }})()""")
    if abs(moved.get('h', 0) - new_hs[-1]) < 0.5:
        return False, f'向低处拖拽无效（高度没变 {new_hs[-1]} → {moved}）'

    # undo 应能回退一次拖拽
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.5)
    undone_hs = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.rivers || []).find(x => x.id === '{rid}');
      return JSON.stringify({{ hs: r.nodes.map(n => Math.round(n.h * 100) / 100) }});
    }})()""")
    if undone_hs['hs'] == None:
        return False, '撤销拖拽后河流数据缺失'

    # ── 6. 线宽 + 落盘 ─────────────────────────────────────────────────
    cdp.eval("""(() => {
      const el = document.querySelector('[data-testid="river-width"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '6');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()""")
    time.sleep(0.6)
    width_now = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.rivers || []).find(x => x.id === '{rid}');
      return JSON.stringify({{ width: r.width }});
    }})()""")
    if width_now.get('width') != 6:
        return False, f'线宽未写入河流：{width_now}'

    time.sleep(1.6)
    payload = _j(cdp, f"""(() => {{
      const list = window.__savedMap || [];
      const last = list[list.length - 1];
      if (!last) return JSON.stringify({{ n: 0 }});
      const r = (last.data.rivers || []).find(x => x.id === '{rid}');
      const round = JSON.parse(JSON.stringify(last.data)).rivers.find(x => x.id === '{rid}');
      return JSON.stringify({{
        n: list.length,
        pts: r ? r.nodes.length : 0,
        hasH: r ? r.nodes.every(p => Number.isFinite(p.h)) : false,
        roundTrip: round ? round.nodes.length : 0,
      }});
    }})()""")
    if payload.get('n', 0) <= 0:
        return False, '河流编辑后没有触发保存'
    if payload.get('pts', 0) < 2 or not payload.get('hasH') or payload.get('roundTrip') != payload.get('pts'):
        return False, f'河流未正确落盘（含高度、可 JSON 往返）：{payload}'

    # ── 7. 删除 ────────────────────────────────────────────────────────
    cdp.eval("document.querySelector('[data-testid=\"river-delete\"]').click()")
    time.sleep(0.6)
    if _rivers(cdp)['n'] != base_n:
        return False, f'面板删除按钮未删除河流（{_rivers(cdp)["n"]} ≠ {base_n}）'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.5)
    if _rivers(cdp)['n'] != base_n + 1:
        return False, '删除河流 undo 未复原'

    _j(cdp, f"(() => {{ const md = {STORE}.mapData['乐园星'] || {{}}; const s = {PM}; if (s.selectedRiver) {{ md.rivers = md.rivers.filter(r => r.id !== '{rid}'); s.selectedRiver = null; }} s.setInteractionMode('pan'); return 'ok'; }})()")
    return True, (
        f'河流编辑器通过：排序算法 {calc["order"]}、逆流 {calc["violationsBefore"]}→{calc["violationsAfter"]} 对；'
        f'往高处拖被 clamp 到 {calc["clampedUp"]["h"]:.1f}（≤ 上游 50）、往低处不拦截；'
        f'逆序描点（先低 {lo["h"]:.1f} 后高 {hi["h"]:.1f}）落库后源头 = 最高点（h 序列 {hs}）；'
        f'一次创建一条 undo；拖拽后仍无逆流（{new_hs}）；线宽 {width_now["width"]}；'
        f'水流入 mapdata（{payload["pts"]} 点带高度可往返）；删除 + undo 正常'
    )
