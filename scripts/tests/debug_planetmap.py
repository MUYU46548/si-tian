#!/usr/bin/env python3
"""PlanetMap 渲染层排查脚本"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tests'))
from lib.cdp import CDP

CDP_PORT = 9222
VITE_PORT = 5180

def main():
    cdp = CDP()
    cdp.start(edge=True)
    try:
        # 导航到行星
        r = cdp.eval("""(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const nodes = s.nodes;
          let w = nodes.find(n => n.layer === 'world' && nodes.some(c => c.layer === 'star_domain' && c.parentId === n.id));
          if (!w) w = nodes.find(n => n.layer === 'world');
          const d = nodes.find(n => n.layer === 'star_domain' && n.parentId === w.id);
          const g = nodes.find(n => n.layer === 'galaxy' && n.parentId === d.id);
          const p = nodes.find(n => n.name === '乐园星' && n.layer === 'planet');
          s.selectWorld(w); s.selectDomain(d); s.selectSystem(g); s.selectPlanet(p);
          return JSON.stringify({ viewLevel: s.viewLevel, planetId: p.id, planetName: p.name });
        })()""")
        print("导航结果:", r)
        time.sleep(2.0)

        # 检查 store.mapData
        state = cdp.eval("""(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const pid = s.currentPlanet ? s.currentPlanet.id : null;
          const md = s.mapData || {};
          const keys = Object.keys(md);
          const planetData = md[pid];
          return JSON.stringify({
            currentPlanet: pid,
            mapDataKeys: keys,
            hasPlanetData: !!planetData,
            terrainCount: planetData ? (planetData.terrain || []).length : -1,
            sample: planetData ? (planetData.terrain || []).slice(0,2) : null
          });
        })()""")
        print("store.mapData 状态:", state)

        # 检查 DOM
        dom = cdp.eval("""(() => {
          const pm = document.querySelector('.planet-map-container');
          const canvas = pm ? pm.querySelector('canvas') : null;
          return JSON.stringify({
            pmExists: !!pm,
            canvasExists: !!canvas,
            canvasSize: canvas ? { w: canvas.width, h: canvas.height } : null
          });
        })()""")
        print("DOM 状态:", dom)

        # 检查 Vue 组件 setupState
        setup = cdp.eval("""(() => {
          const pm = document.querySelector('.planet-map-container');
          if (!pm || !pm.__vueParentComponent) return 'no-setup';
          const st = pm.__vueParentComponent.setupState;
          return JSON.stringify({
            hasCurrentMapData: !!st.currentMapData,
            terrainCount: st.currentMapData ? (st.currentMapData.terrain || []).length : -1,
            placesCount: st.places ? st.places.length : -1,
            hasRenderer: !!st.renderer,
            viewTransform: st.renderer ? st.renderer.viewTransform : null
          });
        })()""")
        print("组件 setupState:", setup)

    finally:
        cdp.stop()

if __name__ == '__main__':
    main()
