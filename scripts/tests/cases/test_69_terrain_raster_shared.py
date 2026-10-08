#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 69：M2/A2 —— 高度图栅格渲染**跨视图共享**（不再各写一套）

背景（`docs/A1_DATA_MODEL_DECISION.md` §一）：同一颗行星有**三套表示** ——
高度图 / 地形多边形 / 涂色网格。渲染侧的表现是：同一份高度图，两个视图各有一套管法：
  · ScenarioMap：逐格上色 → 离屏 canvas（`cellColor` + `fillPixelBlock` + 色带常量）
  · PlanetMap：`buildLabelOutlines` → 矢量平滑轮廓
结果同一颗行星在剧本里和在行星地图里是两个世界，且改一处配色另一处不会变。

本用例守 M2 的第一步（`utils/heightmapRaster.js` 抽取 + 两视图共用）：

  f0 源码守卫：两处都**引用同一个共享模块**，且组件里**没有留下副本**
     （色带常量 / `cellColor` / `fillPixelBlock`）—— 「又复制一份」是这类重构最常见的回退方式，
     而且它不会报错，只会让两个视图慢慢再次分叉
  f1 纯函数层：`buildHeightmapRaster` 对四种配色都产出 canvas；`landsea` 只有两色（陆/海），
     `height` 是多色（色带）—— 证明配色真的接上了，而不是"生成了个空图也能算过"
  f2 PlanetMap 行为（像素级）：切到栅格配色 → 画布**确实变了**；切回 `biome` → **逐像素复原**
     （沿用 test_66 的三帧法：复原断言一次性排除"相机移动 / 整体重绘差异"等其他解释）

⚠️ 为什么 f2 必须做像素断言：f0 只能证明"两处都调了共享函数"，证明不了"画面上真的画出来了"。
"""
import sys, os, time, json, io, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib import helpers as H  # noqa: E402
from lib.cdp import wait_for, eval_json  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _static_guard():
    """源码守卫：共享模块被真正引用，且调用方没有留下副本。"""
    problems = []
    p_shared = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'heightmapRaster.js')
    p_scen = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')
    p_draw = os.path.join(ROOT, 'src', 'renderer', 'src', 'composables', 'planetDrawing.js')

    if not os.path.isfile(p_shared):
        return ['共享模块 utils/heightmapRaster.js 不存在'], ''
    shared = io.open(p_shared, encoding='utf-8').read()
    for sym in ['buildHeightmapRaster', 'cellColor', 'fillPixelBlock', 'createRasterCache',
                'HYPSO_LAND', 'TEMP_RAMP', 'PREC_RAMP']:
        if sym not in shared:
            problems.append(f'共享模块缺少 {sym}')

    scen = io.open(p_scen, encoding='utf-8').read()
    if 'from \'../utils/heightmapRaster\'' not in scen:
        problems.append('ScenarioMap 未引用共享模块（又自带一套？）')
    for dup in ['function cellColor(', 'function fillPixelBlock(', 'const HYPSO_WATER = ',
                'const TEMP_RAMP = ', 'const PREC_RAMP = ']:
        if dup in scen:
            problems.append(f'ScenarioMap 里仍留着副本：{dup}')

    draw = io.open(p_draw, encoding='utf-8').read()
    if 'utils/heightmapRaster' not in draw:
        problems.append('planetDrawing 未引用共享模块')
    if 'function drawHeightmapRaster' not in draw:
        problems.append('planetDrawing 缺少 drawHeightmapRaster')
    return problems, shared[:200]


JS_PURE = r"""(async () => {
  const fails = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const M = await import('/src/utils/heightmapRaster.js');

  // 造一份确定性的小高度图（不平坦：一半低一半高，保证色带不会退化成单色）
  const cols = 12, rows = 12, n = cols * rows, spacing = 14.4;
  const pts = [];
  const h = new Float32Array(n);
  const temp = new Float32Array(n);
  const prec = new Float32Array(n);
  const biome = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      pts.push([c * spacing, r * spacing]);
      // ⚠️ 必须是**连续梯度**，不能只给两档（如 8 / 60）：`height` 是线性插值色带，
      //    两档数据只命中两个采样点 → 「多色」断言会失败（实测踩到，一度误判成配色没接上）。
      h[i] = (i * 7) % 100;
      temp[i] = -20 + (i % 40);
      prec[i] = (i * 3) % 100;
      biome[i] = i % 5;
    }
  }
  const hm = { h, temp, prec, biome, grid: { points: pts, spacing, cellsX: cols, cellsY: rows, count: n } };

  const kinds = ['landsea', 'height', 'temp', 'prec'];
  const built = {};
  for (const k of kinds) {
    const r = M.buildHeightmapRaster(hm, k);
    built[k] = r;
    ck('f1 ' + k + ' 产出栅格', !!(r && r.canvas && r.w > 0 && r.h > 0), r ? { w: r.w, h: r.h } : null);
  }

  if (built.landsea && built.height) {
    const uniq = (r) => {
      const d = r.canvas.getContext('2d').getImageData(0, 0, r.w, r.h).data;
      const s = new Set();
      for (let i = 0; i < d.length; i += 4) {
        // ⚠️ 必须跳过透明像素：栅格按包围盒外扩 pad 建画布，边角没被方块覆盖 → alpha=0、
        //    RGB 读出来是 (0,0,0)。把它算进去会让「landsea 只有两色」变成 3 色（实测踩到）。
        if (d[i + 3] === 0) continue;
        s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
      return s;
    };
    const seaUniq = uniq(built.landsea);
    const hygUniq = uniq(built.height);
    ck('f1 ★ landsea 只有两种颜色（陆 / 海）', seaUniq.size === 2, { colors: seaUniq.size });
    ck('f1 ★ height 是多色色带（配色真的接上了，不是空图）', hygUniq.size >= 3, { colors: hygUniq.size });
  }

  // 缓存工厂：同 key 复用、clear 后重建
  const cache = M.createRasterCache();
  const a1 = cache.get('k1', hm, 'landsea');
  const a2 = cache.get('k1', hm, 'landsea');
  ck('f1 缓存同 key 复用（同一对象）', a1 === a2, null);
  cache.clear();
  const a3 = cache.get('k1', hm, 'landsea');
  ck('f1 clear 后重建（不同对象）', a3 !== a1, null);

  return JSON.stringify({ fails });
})()"""


JS_PIXEL = r"""(async () => {
  const fails = [];
  const notes = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));

  const app = document.querySelector('#app').__vue_app__;
  const store = app._instance.setupState.store;
  const nodes = store.nodes;

  // 导航到行星地图（自底向上锚定，避开空壳世界）+ 进入编辑态
  let w = nodes.find(n => n.layer === 'world' && nodes.some(c => c.layer === 'star_domain' && c.parentId === n.id))
       || nodes.find(n => n.layer === 'world');
  const d = w && nodes.find(n => n.layer === 'star_domain' && n.parentId === w.id);
  const g = d && nodes.find(n => n.layer === 'galaxy' && n.parentId === d.id);
  const planet = (g && nodes.find(n => n.layer === 'planet' && n.parentId === g.id))
              || nodes.find(n => n.layer === 'planet');
  ck('装置：找到行星节点', !!planet, null);
  if (!planet) return JSON.stringify({ fails, notes });
  if (w) store.selectWorld(w);
  if (d) store.selectDomain(d);
  if (g) store.selectSystem(g);
  store.selectPlanet(planet);
  await tick(600);

  // 进编辑态 + 高度模式（该模式下高度图**强制显示**，无需先开图层）
  const btn = Array.from(document.querySelectorAll('button'))
    .find(x => x.classList.contains('edit-entry-btn') || (x.textContent || '').includes('编辑地图'));
  if (btn) btn.click();
  await tick(500);
  const el = document.querySelector('.planet-map-container');
  const pm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
  ck('装置：PlanetMap 已挂载', !!pm, null);
  if (!pm || typeof pm.setInteractionMode !== 'function') return JSON.stringify({ fails, notes });

  // ⚠️ 高度图挂在 **PlanetMap 的 setupState** 上（store 上没有 currentMapData）——
  //    写成 store.currentMapData 会恒为 undefined，装置断言直接假红。
  const hm = pm.currentMapData && pm.currentMapData.heightmap;
  ck('装置：当前行星有高度图（否则没有栅格可画）', !!(hm && hm.h && hm.grid), null);
  if (!(hm && hm.h && hm.grid)) return JSON.stringify({ fails, notes });

  pm.setInteractionMode('height');
  await tick(400);

  const cv = document.querySelector('.planet-map-container .canvas-wrapper canvas');
  ck('装置：画布已就绪', !!cv, null);
  if (!cv) return JSON.stringify({ fails, notes });
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const snap = () => new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);
  // 按**像素**统计（不是 RGBA 分量）—— 否则报出的"差异像素"会是 4 倍，阈值也跟着失准
  const diff = (a, b) => {
    let n = 0, maxD = 0;
    for (let i = 0; i < a.length; i += 4) {
      let changed = false, md = 0;
      for (let k = 0; k < 4; k++) {
        if (a[i + k] !== b[i + k]) { changed = true; const dd = Math.abs(a[i + k] - b[i + k]); if (dd > md) md = dd; }
      }
      if (changed) { n++; if (md > maxD) maxD = md; }
    }
    return { n, maxD };
  };

  // 着色方案下拉只在「高度模式」下渲染 → 必须在这里取（装置断言也顺带守了这条 UI 约定）
  const sel = document.querySelector('[data-testid="heightmap-raster-kind"]');
  ck('装置：着色方案下拉已渲染（高度模式下出现）', !!sel, null);
  if (!sel) return JSON.stringify({ fails, notes });

  // 走**真实用户路径**：改下拉 + 派发 change（`v-model` 绑的正是 change）——
  // 直接写 setupState 会绕过「下拉 → ref → 重绘」整条链，抓不到漏接 watch 这类缺陷。
  const setKind = async (v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, v);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(700);
  };

  await setKind('biome');       // 起点：矢量群系着色（默认）
  const before = snap();
  await setKind('landsea');     // 切到栅格配色
  const mid = snap();
  await setKind('biome');       // 切回
  const after = snap();

  const d1 = diff(before, mid);
  const d2 = diff(before, after);
  notes.push('画布 ' + W + 'x' + H + '；切到栅格差异像素 ' + d1.n + ' maxDelta=' + d1.maxD + '；切回复原差异 ' + d2.n);

  ck('f2 切到栅格配色后画布**确实变了**（像素级证据：接线真的生效）', d1.n > 0, { diffPixels: d1.n });
  ck('f2 差异显著（不是抗锯齿噪声）', d1.maxD >= 10, { maxDelta: d1.maxD });
  ck('f2 差异是**局部之上**的（栅格是整片地形，不该只动几个像素）', d1.n > W * H * 0.01,
     { ratio: +(d1.n / (W * H)).toFixed(4) });
  // ★ 最强断言：切回去必须一模一样（排除相机移动 / 整体重绘差异等一切其他解释）
  ck('f2 ★ 切回 biome 后画面**逐像素复原**', d2.n === 0, { diffPixels: d2.n });

  // UI 选项齐全（用户能自己切到每一档）
  {
    const vals = Array.from(sel.options).map(o => o.value);
    const want = ['biome', 'landsea', 'height', 'temp', 'prec', 'culture', 'religion'];
    ck('f2 UI：着色下拉选项齐全', JSON.stringify(vals) === JSON.stringify(want), vals);
  }

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    # ⚠️ 各段**累积**失败而不是 fail-fast：
    #    反向探针实测过 —— f1 一旦先红就 return，f2 根本不跑，于是 f2 的探针
    #    （删掉「切方案→重绘」接线）看起来"没生效"。多段用例必须让每段都有机会说话。
    fails = []

    problems, _ = _static_guard()
    if problems:
        fails.append('f0：' + '；'.join(problems))

    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    # f1 纯函数层
    ok, res = eval_json(cdp, JS_PURE, desc='heightmapRaster 纯函数')
    if not ok:
        fails.append(f'f1 求值：{res}')
    elif res.get('fails'):
        fails.extend(['f1：' + str(x) for x in res['fails'][:6]])

    # f2 PlanetMap 像素级
    ok2, res2 = eval_json(cdp, JS_PIXEL, desc='PlanetMap 栅格切换')
    if not ok2:
        fails.append(f'f2 求值：{res2}')
    elif res2.get('fails'):
        fails.extend(['f2：' + str(x) for x in res2['fails'][:6]])

    notes = (res2.get('notes') or []) if isinstance(res2, dict) else []
    if fails:
        return False, f'M2 断言失败 {len(fails)} 项：' + '；'.join(fails[:10])

    return True, ('共享模块守卫通过（两视图引用同一实现、无副本）；纯函数四色皆产出、landsea 双色、height 多色；'
                  'PlanetMap 切栅格→画布变化、切回→逐像素复原'
                  + ('；' + '；'.join(notes) if notes else ''))
