#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 181：行星侧 Azgaar 参考图层的四条图层函数**真的能跑**（0.5.1 回归）

为什么单独立一条（2026-11-24）：
  0.5.1 用户实测弹 `getState is not defined`，堆栈指到 `PlanetMap-*.js` 的
  `drawPoliticalBorders`。根因是这四条图层函数（政治边界 / 群系轮廓 / 海岸山脊 /
  文化宗教）在 `planetDrawing.js` 被**落在了 `createPlanetDrawing` 工厂外面**，
  而它们都要 `getState()` —— 工厂参数只在工厂体内可见，于是：
    · `npm run build` 成功（未声明标识符在 JS 里合法）；
    · 当时 178 条用例**全绿** —— 因为 fixture 底图**没有 `azgaarProvinces`**，
      每个函数的**第一行**就 `if (!azgaarProvinces.length) return`，一次都没走到 `getState()`。

  所以判据必须是「**给足数据**让它真的往下跑」，而不是「开了图层没报错」：
    A. 给当前行星的 mapData 塞进真实的 azgaarProvinces / heightmap(biome+h) 数据
    B. 四个图层开关全部打开、开编辑模式（政治图层走"可点击"那一路，多覆盖一次 fill）
    C. 强制重绘一帧（`render()`），并断言画布**像素真的变了**（不是空转）
    D. 断言页面**没有弹错误面板**（`errorReport.js` 的 #sitian-error-overlay）
    E. 反向探针：把 azgaarProvinces 清空后再画一帧，像素必须**回退**（证明 C 那步的差异
       确实来自这四层，而不是别的东西在变）

⚠️ 为什么用像素而不是"函数返回 undefined"：这四条都是 `void` 函数，正常返回和
   「抛异常被吞掉」在返回值上完全一样 —— 只有画面与错误面板分得清。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402

APP_STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
PLANET_ST = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
PLANET_EL = "document.querySelector('.planet-map-container')"
# layers 是 Pinia store（`store/layers.js`），**不在组件 setupState 上** ——
# 只能从 #app 的 pinia 实例里取同一个单例。它的写口是 `toggleLayer`（没有 setVisible）。
LAYER_STORE = "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('layers')"


def _hash_canvas(cdp, expr_sel):
    """画布内容指纹（FNV-1a over 采样像素）—— 采样步长 7px，够灵敏也不会太慢。"""
    return cdp.eval(f"""(() => {{
      const c = document.querySelector('{expr_sel}').querySelector('canvas');
      if (!c) return 'no-canvas';
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261 >>> 0;
      for (let i = 0; i < d.length; i += 7 * 4) {{
        h ^= d[i]; h = Math.imul(h, 16777619) >>> 0;
        h ^= d[i + 1]; h = Math.imul(h, 16777619) >>> 0;
        h ^= d[i + 2]; h = Math.imul(h, 16777619) >>> 0;
      }}
      return h.toString(16);
    }})()""")


def _error_panel(cdp):
    """页面上的错误面板文本（没有则空串）。这是本用例的核心判据之一。"""
    raw = cdp.eval("""(() => {
      const el = document.getElementById('sitian-error-overlay');
      if (!el) return '';
      const pre = el.querySelector('[data-role=detail]');
      return (pre && pre.textContent ? pre.textContent : '(无详情)').slice(0, 600);
    })()""")
    return raw if isinstance(raw, str) else ''


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # ---- a) 进入某颗行星的行星图（挑一个带行星的世界） ----
    nav = cdp.eval(f"""(() => {{
      const s = {APP_STORE};
      const planet = s.nodes.find(n => n.layer === 'planet');
      if (!planet) return 'no-planet';
      s.selectPlanetOrNode ? s.selectPlanetOrNode(planet) : s.selectPlanet(planet);
      return JSON.stringify({{ level: s.viewLevel, id: planet.id }});
    }})()""")
    if not (isinstance(nav, str) and nav.startswith('{')):
        return False, f'未能进入行星视图 ({nav})'
    info = json.loads(nav)
    if info.get('level') != 'planet':
        return False, f'视图层级不是 planet（{info}）'
    wait_for(cdp, "!!document.querySelector('.planet-map-container canvas')", desc='行星画布挂载')
    time.sleep(0.6)
    planet_id = info['id']

    # ---- b) 注入真实形状的 Azgaar 底图数据（fixture 里没有，必须自己造） ----
    #      形状照 src/renderer/src/composables/planetDrawing.js 的真实读法：
    #        azgaarProvinces[].{points:[{x,y}],color,cultureColor,religionColor}
    #        heightmap.{biome:Uint8Array-ish[], h:[], grid:{cellsX,cellsY,points:[{x,y}],spacing}}
    #      grid 取 12×12 就够：drawBiomeContours / drawCoastlineAndRidges 都按 cellsX*cellsY 走一遍。
    seeded = cdp.eval(f"""(() => {{
      const s = {APP_STORE};
      const md = s.mapData['{planet_id}'] || {{ planetId: '{planet_id}', version: 1 }};
      const COLS = 12, ROWS = 12, SP = 60;
      const pts = [];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) pts.push({{ x: c * SP, y: r * SP }});
      const biome = new Array(COLS * ROWS).fill(0);
      const h = new Array(COLS * ROWS).fill(0);
      for (let i = 0; i < biome.length; i++) {{
        const c = i % COLS, r = (i / COLS) | 0;
        // 左半边低（海）/ 右半边高（陆）→ 保证 h=20 的海岸线一定有交点
        h[i] = c < COLS / 2 ? 5 : 45;
        biome[i] = c < COLS / 2 ? 1 : 4;
        // 右半再抬一块，制造 >30 的高度差 → 山脊线也会真的出线段
        if (c > COLS - 3 && r > 2 && r < 8) h[i] = 90;
      }}
      const ring = (x0, y0, x1, y1) => [
        {{ x: x0, y: y0 }}, {{ x: x1, y: y0 }}, {{ x: x1, y: y1 }}, {{ x: x0, y: y1 }},
      ];
      const provs = [
        {{ id: 'p1', points: ring(20, 20, 300, 300), color: '#e74c3c',
           cultureColor: '#3498db', religionColor: '#f1c40f' }},
        {{ id: 'p2', points: ring(320, 20, 640, 300), color: '#2ecc71',
           cultureColor: '#9b59b6', religionColor: '#e67e22' }},
        {{ id: 'p3', points: ring(20, 320, 640, 620), color: '#f39c12',
           cultureColor: '#1abc9c', religionColor: '#c0392b' }},
      ];
      md.azgaarProvinces = provs;
      md.heightmap = {{ biome, h, grid: {{ cellsX: COLS, cellsY: ROWS, points: pts, spacing: SP }} }};
      // 整体换引用 = 触发 computed / watch 的那条路（就地改字段画布不认）
      const next = Object.assign({{}}, s.mapData);
      next['{planet_id}'] = md;
      s.mapData = next;
      return JSON.stringify({{ provs: provs.length, cells: biome.length,
        hasAzgaar: !!(s.mapData['{planet_id}'] || {{}}).azgaarProvinces }});
    }})()""")
    if not (isinstance(seeded, str) and seeded.startswith('{')):
        return False, f'注入 Azgaar 底图数据失败 ({seeded})'
    sd = json.loads(seeded)
    if not sd.get('hasAzgaar'):
        return False, f'注入后 mapData 仍无 azgaarProvinces（被 store 挡了？）{seeded}'
    time.sleep(0.4)

    # ---- c) 打开四个图层 + 进编辑模式（政治层走"可点击"分支，多覆盖一次 fill） ----
    toggled = cdp.eval(f"""(() => {{
      const st = {PLANET_ST};
      const names = ['politicalBorders', 'biomeContours', 'coastlineRidges', 'cultureReligion'];
      const done = {{}};
      const layers = {LAYER_STORE};
      if (!layers || !layers.toggleLayer) return 'no-layers-api';
      for (const n of names) {{
        try {{
          if (!layers.isVisible('planet', n)) layers.toggleLayer('planet', n);   // 只有 toggle，先读再拨
          done[n] = layers.isVisible('planet', n);
        }}
        catch (e) {{ done[n] = 'err:' + e.message; }}
      }}
      if (st.editMode && st.editMode.value === false) st.editMode.value = true;
      return JSON.stringify(done);
    }})()""")
    if toggled == 'no-layers-api':
        return False, '取不到 layers store 的 toggleLayer（判据要跟着改）'
    if not (isinstance(toggled, str) and toggled.startswith('{')):
        return False, f'图层开关失败 ({toggled})'
    tv = json.loads(toggled)
    off = [k for k, v in tv.items() if v is not True]
    if off:
        return False, f'这四个图层没能全部打开：{off}（读数 {toggled}）'
    time.sleep(0.3)

    # ---- d) 播一帧：先关掉再打开，确保这四层的绘制不是走缓存/上一帧 ----
    def repaint():
        cdp.eval(f"""(() => {{
          const st = {PLANET_ST};
          const names = ['politicalBorders', 'biomeContours', 'coastlineRidges', 'cultureReligion'];
          const layers = {LAYER_STORE};
          for (const n of names) if (layers.isVisible('planet', n)) layers.toggleLayer('planet', n);
          if (typeof st.render === 'function') st.render();
          return 'ok';
        }})()""")
        time.sleep(0.45)     # 等一帧（raf 在 headless 下不一定立刻触发）
        h_off = _hash_canvas(cdp, '.planet-map-container')
        cdp.eval(f"""(() => {{
          const st = {PLANET_ST};
          const names = ['politicalBorders', 'biomeContours', 'coastlineRidges', 'cultureReligion'];
          const layers = {LAYER_STORE};
          for (const n of names) if (!layers.isVisible('planet', n)) layers.toggleLayer('planet', n);
          if (typeof st.render === 'function') st.render();
          return 'ok';
        }})()""")
        time.sleep(0.45)
        h_on = _hash_canvas(cdp, '.planet-map-container')
        return h_off, h_on

    h_off, h_on = repaint()

    # ---- e) 核心判据 1：页面不许弹错误面板（0.5.1 的两种崩溃都会弹） ----
    panel = _error_panel(cdp)
    if panel:
        return False, f'绘制 Azgaar 四层时抛了未捕获异常：{panel}'

    # ---- f) 核心判据 2：这四层必须**真的画出了东西**（像素差） ----
    if not (isinstance(h_off, str) and isinstance(h_on, str) and h_off != 'no-canvas' and h_on != 'no-canvas'):
        return False, f'读不到画布指纹（off={h_off!r} on={h_on!r}）'
    if h_off == h_on:
        return False, ('四层开关前后画布**逐像素相同** —— 说明它们根本没画（多半又是'
                       '"第一行就 return"那种空转），本用例没有验到任何东西')

    # ---- g) 反向探针：清掉 azgaarProvinces 后，那两层必须不再画（像素要回到另一种样子） ----
    cleared = cdp.eval(f"""(() => {{
      const s = {APP_STORE};
      const md = s.mapData['{planet_id}'];
      if (!md) return 'no-md';
      const next = Object.assign({{}}, s.mapData);
      next['{planet_id}'] = Object.assign({{}}, md, {{ azgaarProvinces: [] }});
      s.mapData = next;
      return (s.mapData['{planet_id}'].azgaarProvinces || []).length;
    }})()""")
    if cleared != 0:
        return False, f'清空 azgaarProvinces 失败（{cleared!r}）'
    time.sleep(0.45)
    cdp.eval(f"""(() => {{
      const st = {PLANET_ST};
      if (typeof st.render === 'function') st.render();
      return 'ok';
    }})()""")
    time.sleep(0.45)
    h_clear = _hash_canvas(cdp, '.planet-map-container')
    if h_clear == h_on:
        return False, ('清空 azgaarProvinces 后画布**没变** —— 政治边界/文化宗教这两层'
                       '要么没画、要么画的是别的数据（像素判据失去分辨力）')
    panel2 = _error_panel(cdp)
    if panel2:
        return False, f'清空数据重绘时又抛异常：{panel2}'

    return True, (f'Azgaar 四层真的画出来了（{sd["provs"]} 个省 / {sd["cells"]} 个格点；'
                  f'开关前后 {h_off}≠{h_on}，清空后回退到 {h_clear}，全程零错误面板）')
