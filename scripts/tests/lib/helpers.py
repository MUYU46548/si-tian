#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试辅助函数（阶段 2 回归测试基线）
"""
import json
import time


def store(cdp):
    """注意：不要序列化整个 Pinia store（proxy 返回空 {}）。用 view_level/node_count 等具体函数"""
    return None


def view_level(cdp):
    return cdp.eval("document.querySelector('#app').__vue_app__._instance.setupState.store.viewLevel")


def node_count(cdp):
    return cdp.eval("document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length")


def planet_map(cdp):
    """获取 PlanetMap 组件 setupState（DOM 最近实例）"""
    return cdp.eval("(() => { const el = document.querySelector('.planet-map-container'); return el ? el.__vueParentComponent.setupState : null; })()")


def goto_planet(cdp, planet_name='乐园星'):
    """直接导航到指定行星地图（世界→星域→星系→行星）"""
    expr = f"""(() => {{
      const app = document.querySelector('#app').__vue_app__;
      const s = app._instance.setupState.store;
      const nodes = s.nodes;
      const w = nodes.find(n => n.layer === 'world');
      const d = nodes.find(n => n.layer === 'star_domain' && n.parentId === w.id);
      const g = nodes.find(n => n.layer === 'galaxy' && n.parentId === d.id);
      const p = nodes.find(n => n.name === '{planet_name}' && n.layer === 'planet');
      if (!p) return 'no-planet';
      s.selectWorld(w); s.selectDomain(d); s.selectSystem(g); s.selectPlanet(p);
      return s.viewLevel;
    }})()"""
    return cdp.eval(expr)


def enter_edit(cdp):
    """进入行星地图编辑模式"""
    return cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '✏️ 编辑地图'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()")


def sample_colors(cdp, count=600):
    """采样画布唯一颜色数（判断渲染内容丰富度）"""
    expr = f"""(() => {{
      const c = document.querySelector('.canvas-wrapper canvas');
      if (!c) return 0;
      const ctx = c.getContext('2d');
      const w = c.width, h = c.height;
      const colors = new Set();
      for (let i = 0; i < {count}; i++) {{
        const x = Math.floor((i * 37) % w);
        const y = Math.floor((i * 61) % h);
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (d[3] > 0) colors.add((d[0] << 16) | (d[1] << 8) | d[2]);
      }}
      return colors.size;
    }})()"""
    return cdp.eval(expr)


def terrain_names(cdp):
    """当前行星地形名称列表"""
    return cdp.eval("(() => { const pm = document.querySelector('.planet-map-container')?.__vueParentComponent.setupState; return pm ? JSON.stringify(pm.currentMapData.terrain.map(t => t.name)) : '[]'; })()")


def terrain_count(cdp):
    return cdp.eval("(() => { const pm = document.querySelector('.planet-map-container')?.__vueParentComponent.setupState; return pm ? pm.currentMapData.terrain.length : -1; })()")


def click_canvas_at_world(cdp, wx, wy, press=True, release=True):
    """在世界坐标 (wx, wy) 处模拟点击（自动转屏幕坐标）"""
    expr = f"""(() => {{
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const c = document.querySelector('.canvas-wrapper canvas');
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const sx = {wx} * vt.scale + vt.x + c.clientWidth/2;
      const sy = {wy} * vt.scale + vt.y + c.clientHeight/2;
      if (sx < 0 || sx > r.width || sy < 0 || sy > r.height) return 'out-of-view';
      const mk = (x, y, t) => new MouseEvent(t, {{ clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0 }});
      {'c.dispatchEvent(mk(sx, sy, "mousedown"));' if press else ''}
      {'c.dispatchEvent(mk(sx, sy, "mouseup"));' if release else ''}
      return JSON.stringify({{ sx, sy }});
    }})()"""
    return cdp.eval(expr)


def confirm_yes(cdp):
    cdp.eval("window.confirm = () => true;")


def confirm_no(cdp):
    cdp.eval("window.confirm = () => false;")


def fit_world(cdp):
    """适屏整个世界（确保世界坐标可见；PlanetMap 的 zoomFit）"""
    return cdp.eval("(() => { const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState; if (!pm) return 'no-pm'; pm.zoomFit(); return 'ok'; })()")


def set_pm_state(cdp, code):
    """在 PlanetMap setupState 上下文执行 JS 片段（变量 pm 已绑定，code 返回串行化结果）"""
    return cdp.eval(f"(() => {{ const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState; if (!pm) return 'no-pm'; {code} }})()")


def drag_canvas_polyline(cdp, points, shift=False, ctrl=False):
    """按世界坐标折线拖拽（真实事件链路：mousedown → mousemove×N → mouseup）。

    points: [(x, y), ...]，至少 2 点；首点 mousedown、中间点逐个 mousemove、末点 mousemove+mouseup。
    shift/ctrl: 拖拽全程携带修饰键（框选需要 shift）。
    """
    pts_js = json.dumps(points)
    expr = f"""(() => {{
      const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState;
      const c = document.querySelector('.canvas-wrapper canvas');
      if (!pm || !c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const toSX = wx => wx * vt.scale + vt.x + c.clientWidth / 2;
      const toSY = wy => wy * vt.scale + vt.y + c.clientHeight / 2;
      const mk = (sx, sy, t) => new MouseEvent(t, {{ clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 0, shiftKey: {'true' if shift else 'false'}, ctrlKey: {'true' if ctrl else 'false'} }});
      const pts = {pts_js};
      c.dispatchEvent(mk(toSX(pts[0][0]), toSY(pts[0][1]), 'mousedown'));
      for (let i = 1; i < pts.length; i++) {{
        c.dispatchEvent(mk(toSX(pts[i][0]), toSY(pts[i][1]), 'mousemove'));
      }}
      const last = pts[pts.length - 1];
      c.dispatchEvent(mk(toSX(last[0]), toSY(last[1]), 'mouseup'));
      return 'ok';
    }})()"""
    return cdp.eval(expr)


def dblclick_canvas_at_world(cdp, wx, wy):
    """世界坐标双击（描点模式收尾 / 路线完成）"""
    expr = f"""(() => {{
      const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState;
      const c = document.querySelector('.canvas-wrapper canvas');
      if (!pm || !c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const sx = {wx} * vt.scale + vt.x + c.clientWidth / 2;
      const sy = {wy} * vt.scale + vt.y + c.clientHeight / 2;
      c.dispatchEvent(new MouseEvent('dblclick', {{ clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 0 }}));
      return 'ok';
    }})()"""
    return cdp.eval(expr)
