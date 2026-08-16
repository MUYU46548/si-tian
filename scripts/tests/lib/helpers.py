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
