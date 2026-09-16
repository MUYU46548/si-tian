#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 34：道路编辑器 —— 样式预设 + 沿等高线（P1-2）

验收点（对应提示词 P1-2 的「验收标准」逐条）：
1. 4 种样式可切换（官道/普通道路/山路/小径），绘制参数两两不同
2. 点击起点终点生成沿等高线路径（复用 A* generateRoadPath，多点而非直线）
3. style 落到 routes[]，且渲染走样式（roadDrawParams 返回 styled=true）
4. 选中道路后切换样式 = 一条 undo
5. Shift+J 进入道路模式（自动寻路开启）
6. 旧数据（无 style 字段）保持原 color/dashed 渲染 —— 向后兼容
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import goto_planet, enter_edit, click_canvas_at_world, ensure_data_ready  # noqa: E402

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


def _land_points(cdp, count=2, gap=150):
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
      const out = [];
      for (let i = 0; i < pts.length && out.length < {count}; i++) {{
        const h = hm.h[i];
        if (h < 25 || h > 65) continue;
        const x = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const y = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        const sx = toSX(x), sy = toSY(y);
        if (sx < 50 || sx > cw - 50 || sy < 50 || sy > ch - 50) continue;
        if (out.every(p => Math.hypot(p.x - x, p.y - y) >= {gap})) out.push({{ x, y, h }});
      }}
      return JSON.stringify({{ points: out }});
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # ── 1. 样式定义 + 向后兼容 ─────────────────────────────────────────
    styles = _j(cdp, """(async () => {
      const m = await import('/src/utils/roadStyles.js');
      const keys = m.ROAD_STYLE_KEYS;
      const sig = keys.map(k => { const s = m.ROAD_STYLES[k]; return `${s.color}|${s.width}|${s.dashed}`; });
      const styled = m.roadDrawParams({ style: 'highway' });
      const legacy = m.roadDrawParams({ color: '#123456', dashed: true });
      const unknown = m.roadDrawParams({ style: 'nope', color: '#654321' });
      return JSON.stringify({ keys, sig, unique: new Set(sig).size, styled, legacy, unknown });
    })()""")
    if not isinstance(styles, dict) or len(styles.get('keys') or []) < 4:
        return False, f'道路样式不足 4 种 {styles}'
    if styles['unique'] < 4:
        return False, f'样式绘制参数有重复（视觉无法区分）：{styles["sig"]}'
    if not styles['styled'].get('styled') or styles['styled'].get('color') != '#D4A017':
        return False, f'style 未生效于绘制参数：{styles["styled"]}'
    if styles['legacy'].get('styled') or styles['legacy'].get('color') != '#123456' or not styles['legacy'].get('dashed'):
        return False, f'无 style 的旧数据未沿用自身 color/dashed（向后兼容破坏）：{styles["legacy"]}'
    if not styles['unknown'].get('color') == '#654321':
        return False, f'未知 style 未回落到自身颜色：{styles["unknown"]}'

    # ── 2. 进入行星 + Shift+J 道路模式 ──────────────────────────────────
    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')", desc='行星画布挂载')
    time.sleep(1.0)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.7)
    # 只做 zoomFit（额外放大后视口内可能全是海/山，取不到可点的陆地）
    _j(cdp, f"(() => {{ {PM}.zoomFit(); return 'ok'; }})()")
    time.sleep(0.6)

    # 快捷键 Shift+J
    cdp.eval("""(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', shiftKey: true, bubbles: true }));
      return 'ok';
    })()""")
    time.sleep(0.4)
    mode = _j(cdp, f"""JSON.stringify({{
      mode: {PM}.interactionMode, autoRoad: {PM}.autoRoadEnabled,
      styleBtns: document.querySelectorAll('[data-testid^="road-style-"]').length,
    }})""")
    if mode.get('mode') != 'route' or not mode.get('autoRoad'):
        return False, f'Shift+J 未进入道路模式（自动寻路）：{mode}'
    if mode.get('styleBtns') != 4:
        return False, f'道路样式按钮应 4 个，实际 {mode.get("styleBtns")}'

    # 选官道
    cdp.eval("document.querySelector('[data-testid=\"road-style-highway\"]').click()")
    time.sleep(0.3)

    # 拦截保存载荷
    cdp.eval("""(() => {
      window.__savedMap = [];
      const api = window.sitianAPI;
      if (api && !api.__roadMapHooked) {
        api.saveMapData = async (key, data) => { window.__savedMap.push({ key, data }); return { success: true }; };
        api.__roadMapHooked = true;
      }
      return 'ok';
    })()""")

    picks = _land_points(cdp, count=2, gap=150)
    if not isinstance(picks, dict) or len(picks.get('points') or []) < 2:
        return False, f'陆地候选点不足 {picks}'
    pts = picks['points']

    before = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      return (md.routes || []).length;
    }})()""")

    # ── 3. 点起点 → 点终点生成沿等高线道路 ─────────────────────────────
    if click_canvas_at_world(cdp, pts[0]['x'], pts[0]['y']) == 'out-of-view':
        return False, f'起点超出视口 {pts[0]}'
    time.sleep(0.5)
    t0 = time.time()
    if click_canvas_at_world(cdp, pts[1]['x'], pts[1]['y']) == 'out-of-view':
        return False, f'终点超出视口 {pts[1]}'
    time.sleep(0.7)
    elapsed = time.time() - t0

    road = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const rs = md.routes || [];
      const r = rs[rs.length - 1];
      return JSON.stringify({{
        n: rs.length,
        style: r ? r.style : null,
        color: r ? r.color : null,
        dashed: r ? r.dashed : null,
        points: r ? r.points.length : 0,
        allFinite: r ? r.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) : false,
      }});
    }})()""")
    if road.get('n') != before + 1:
        return False, f'未生成道路 {road}'
    if road.get('style') != 'highway':
        return False, f'道路未带上 style 字段：{road}'
    if road.get('color') != '#D4A017' or road.get('dashed'):
        return False, f'道路颜色/虚实未取样式定义：{road}'
    if road.get('points', 0) < 3:
        return False, f'道路只有 {road.get("points")} 个点 —— 应是沿等高线的多点路径（而非两点直线）'
    if not road.get('allFinite'):
        return False, f'道路含非法坐标 {road}'
    if elapsed > 3.0:
        return False, f'A* 寻路耗时 {elapsed:.1f}s（>3s 性能闸门）'

    # ── 4. 选中后切样式 = 一条 undo ────────────────────────────────────
    sel = _j(cdp, f"""(() => {{
      const pm = {PM};
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.routes || [])[md.routes.length - 1];
      pm.selectedRoute = r;
      return JSON.stringify({{ id: r.id, style: r.style }});
    }})()""")
    if not sel.get('id'):
        return False, f'选中道路失败 {sel}'
    time.sleep(0.4)
    cdp.eval("document.querySelector('[data-testid=\"road-style-trail\"]').click()")
    time.sleep(0.5)
    changed = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.routes || []).find(x => x.id === '{sel["id"]}');
      return JSON.stringify({{ style: r.style, color: r.color, dashed: r.dashed }});
    }})()""")
    if changed.get('style') != 'trail' or not changed.get('dashed') or changed.get('color') != '#9AA5B1':
        return False, f'切换样式未生效：{changed}'

    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    undone = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const r = (md.routes || []).find(x => x.id === '{sel["id"]}');
      return JSON.stringify({{ style: r.style, color: r.color, dashed: r.dashed }});
    }})()""")
    if undone.get('style') != 'highway' or undone.get('dashed'):
        return False, f'切换样式 undo 未回退（应回到 highway 实线）：{undone}'

    # ── 5. 持久化 ──────────────────────────────────────────────────────
    time.sleep(1.6)
    payload = _j(cdp, f"""(() => {{
      const list = window.__savedMap || [];
      const last = list[list.length - 1];
      if (!last) return JSON.stringify({{ n: 0 }});
      const r = (last.data.routes || []).find(x => x.id === '{sel["id"]}');
      const round = JSON.parse(JSON.stringify(last.data)).routes.find(x => x.id === '{sel["id"]}');
      return JSON.stringify({{ n: list.length, style: r ? r.style : null, roundTrip: round ? round.style : null }});
    }})()""")
    if payload.get('n', 0) <= 0:
        return False, '生成道路后没有触发保存'
    if payload.get('style') != 'highway' or payload.get('roundTrip') != 'highway':
        return False, f'道路样式未进入保存载荷/JSON 往返丢失：{payload}'

    # 收尾
    cdp.eval(f"(() => {{ const s = {STORE}; s.removeRoute('乐园星', '{sel['id']}'); return 'ok'; }})()")
    _j(cdp, f"(() => {{ {PM}.setInteractionMode('pan'); return 'ok'; }})()")
    return True, (
        f'道路编辑器通过：4 种样式绘制参数两两不同（{styles["unique"]} 个唯一签名）；无 style 旧数据仍走自身 color/dashed；'
        f'Shift+J 进入道路模式；两点生成 {road["points"]} 点沿等高线道路（style=highway、色 #D4A017、耗时 {elapsed:.2f}s）；'
        f'选中切换 trail 生效且 undo 回退 highway；样式随 mapdata 落盘可 JSON 往返'
    )
