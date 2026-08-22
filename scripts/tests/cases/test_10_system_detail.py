#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 10：单恒星系详情视图（批次 B4 + B5）
链路：GalaxyMap 点击恒星亮点 → system_detail → 邻系箭头渲染/点击跳转 → 行星下钻 → 智能返回
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import view_level


def setup_state(cdp, selector):
    return json.loads(cdp.eval(f"(() => {{ const el = document.querySelector('{selector}'); return el ? '1' : '0'; }})()"))


def click_canvas_at(cdp, selector, wx, wy):
    """在指定视图 canvas 的世界坐标处模拟一次点击（mousedown+mouseup）"""
    return cdp.eval(f"""(() => {{
      const el = document.querySelector('{selector}');
      if (!el) return 'no-el';
      const st = el.__vueParentComponent.setupState;
      const c = st.canvas;
      if (!c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = st.renderer.viewTransform;
      const sx = {wx} * vt.scale + vt.x + c.clientWidth / 2;
      const sy = {wy} * vt.scale + vt.y + c.clientHeight / 2;
      if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) return 'out-of-view';
      const mk = (x, y, t) => new MouseEvent(t, {{ clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0 }});
      c.dispatchEvent(mk(sx, sy, 'mousedown'));
      c.dispatchEvent(mk(sx, sy, 'mouseup'));
      return 'ok';
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # 1. 世界 → 星域地图
    cdp.eval("document.querySelector('.world-card').click()")
    time.sleep(0.8)
    if view_level(cdp) != 'domain':
        return False, f'未进入 domain ({view_level(cdp)})'

    # 2. GalaxyMap 点击"乐园星系"恒星亮点 → 应直接下钻单系视图（跳过域总览）
    star = cdp.eval("""(() => {
      const st = document.querySelector('.galaxy-map-container').__vueParentComponent.setupState;
      const g = st.galaxyNodes.find(n => n.id === '乐园星系');
      return g ? JSON.stringify({ x: g.x, y: g.y }) : 'no-star';
    })()""")
    if star == 'no-star':
        return False, 'GalaxyMap 布局中未找到 乐园星系'
    sx, sy = json.loads(star)['x'], json.loads(star)['y']
    # 恒星可能在默认视口外 → 先定位到该恒星再点击
    cdp.eval(f"""(() => {{
      const st = document.querySelector('.galaxy-map-container').__vueParentComponent.setupState;
      st.renderer.focusOn({sx}, {sy}, 1);
      return 'ok';
    }})()""")
    time.sleep(0.5)
    r = click_canvas_at(cdp, '.galaxy-map-container', sx, sy)
    if r != 'ok':
        return False, f'点击恒星亮点失败 ({r})'
    time.sleep(0.6)
    lv = view_level(cdp)
    if lv != 'system_detail':
        return False, f'点恒星未进入 system_detail ({lv})'

    state = cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      return JSON.stringify({
        system: s.currentSystem ? s.currentSystem.id : null,
        domain: s.currentDomain ? s.currentDomain.id : null,
        planets: s.currentSystemPlanets.length,
        mounted: !!document.querySelector('.system-detail-container'),
      });
    })()""")
    st = json.loads(state)
    if not (st['system'] == '乐园星系' and st['domain'] and st['planets'] >= 1 and st['mounted']):
        return False, f'单系视图状态异常 {state}'

    # 3. B5 邻系箭头：基于真实 hyperlanes 邻接渲染
    arrows = cdp.eval("""(() => {
      const el = document.querySelector('.system-detail-container');
      if (!el) return -1;
      const a = el.__vueParentComponent.setupState.neighborArrows;
      return a ? a.length : -1;
    })()""")
    if not (isinstance(arrows, int) and arrows >= 1):
        return False, f'邻系箭头异常 ({arrows})'

    # 4. B5 点击箭头 → 跳转相邻恒星系（仍停留单系视图）
    arrow0 = cdp.eval("""(() => {
      const el = document.querySelector('.system-detail-container');
      const a = el.__vueParentComponent.setupState.neighborArrows[0];
      return JSON.stringify({ x: a.x, y: a.y, neighborId: a.neighborId });
    })()""")
    a0 = json.loads(arrow0)
    r = click_canvas_at(cdp, '.system-detail-container', a0['x'], a0['y'])
    if r != 'ok':
        return False, f'点击箭头失败 ({r})'
    time.sleep(0.5)
    jumped = cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      return JSON.stringify({ level: s.viewLevel, system: s.currentSystem ? s.currentSystem.id : null });
    })()""")
    j = json.loads(jumped)
    if not (j['level'] == 'system_detail' and j['system'] == a0['neighborId']):
        return False, f'箭头跳转异常 {jumped} (期望 {a0["neighborId"]})'

    # 5. 行星下钻 + 智能返回（行星地图返回按钮 → 回到来源单系视图）
    nav = cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const w = s.nodes.find(n => n.id === '乐园星系');
      const p = s.nodes.find(n => n.name === '乐园星');
      if (!w || !p) return 'no-data';
      s.enterSystemDetail(w); s.selectPlanet(p);
      return s.viewLevel;
    })()""")
    if nav != 'planet':
        return False, f'行星下钻失败 ({nav})'
    time.sleep(0.5)
    cdp.eval("document.querySelector('.planet-map-container .back-btn').click()")
    time.sleep(0.5)
    back_lv = view_level(cdp)
    back_sys = cdp.eval("document.querySelector('#app').__vue_app__._instance.setupState.store.currentSystem.id")
    if not (back_lv == 'system_detail' and back_sys == '乐园星系'):
        return False, f'行星返回未回到单系视图 ({back_lv}, {back_sys})'

    # 6. 面包屑星域段 → 域总览（system 级保留）；再 backToDomain → domain
    cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      s.backToSystem(); return 'ok';
    })()""")
    time.sleep(0.4)
    if view_level(cdp) != 'system':
        return False, f'backToSystem 未回域总览 ({view_level(cdp)})'
    cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      s.backToDomain(); return 'ok';
    })()""")
    time.sleep(0.4)
    if view_level(cdp) != 'domain':
        return False, f'backToDomain 未回星域地图 ({view_level(cdp)})'

    return True, f'单系视图链路完整（下钻/箭头×{arrows}/跳转/行星返回/回退）'
