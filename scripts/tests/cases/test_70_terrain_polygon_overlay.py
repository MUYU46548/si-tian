#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 70：M2/A2 第二步 —— `terrain[]` 降为**可选覆盖物**（地形改由高度图驱动）

背景（`docs/A1_DATA_MODEL_DECISION.md` §十 · M2 第二步）：
PlanetMap 此前以 `terrain[]` 多边形为**地形主表示**（不透明实色），高度图只是默认关闭的叠加层
—— 这是 ROADMAP「A2 / 手绘几何编辑器观感」的根因。本步把地形改为**高度图驱动**，
多边形退为**可选覆盖物**，并让**命中测试与导出随动**。

有三件事必须同时成立，缺一条就不算完成：

  f0 源码守卫：渲染（PlanetMap）/ 命中（planetHitTest）/ 导出（useFullMapExport）三处
     **读同一份判定** `utils/terrainRepresentation.js`，且 PlanetMap 里没有残留的旧 `if`
     （各写一套 = 又一个双源，而且不会报错）
  f1 像素级（画布）：有高度图的行星默认以高度图为主表示、多边形**不画**；打开「多边形」覆盖物
     → 画面确实变了；关掉 → **逐像素复原**（沿用 test_66/test_69 的三帧法）
  f2 命中随动：覆盖物关着时点不到多边形（**看得见才点得到**）；打开后能点中，且返回 `province`
  f3 导出随动：默认 SVG 含**高度图**（内联位图）；打开覆盖物后地形 path 出现
     —— 本轮之前导出链**完全没有高度图**，导出图与画布不一致

⚠️ 为什么 f1/f2/f3 必须各打各的：f0 只能证明"三处都引了同一个模块"，证明不了
   「画面上真的画了」「真的点得到」「导出真的带上了」。这三条只能各自观测。
⚠️ 各段**累积**失败而非 fail-fast（反向探针实测过：前面段一红就 return，
   后面段的探针看起来"没生效"）。
"""
import sys, os, io, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import goto_planet  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

POLY_LAYER = 'terrainPolygons'


def _static_guard():
    """源码守卫：三处共用同一份判定，且没有残留的旧判定。"""
    problems = []
    p_shared = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'terrainRepresentation.js')
    p_pm = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'PlanetMap.vue')
    p_hit = os.path.join(ROOT, 'src', 'renderer', 'src', 'composables', 'planetHitTest.js')
    p_exp = os.path.join(ROOT, 'src', 'renderer', 'src', 'composables', 'useFullMapExport.js')

    if not os.path.isfile(p_shared):
        return ['判定模块 utils/terrainRepresentation.js 不存在']
    shared = io.open(p_shared, encoding='utf-8').read()
    for sym in ['resolveTerrainRepresentation', 'hasHeightmapContent', 'POLYGON_OVERLAY_ALPHA']:
        if sym not in shared:
            problems.append(f'判定模块缺少 {sym}')

    pm = io.open(p_pm, encoding='utf-8').read()
    if 'utils/terrainRepresentation' not in pm:
        problems.append('PlanetMap 未引用共享判定模块')
    if 'const terrainRep = computed(' not in pm:
        problems.append('PlanetMap 缺少 terrainRep 判定')
    # 旧判定残留：高度图图层已在本次删除（它的职责被「地形」总开关吸收）
    if "'planet', 'heightmap'" in pm:
        problems.append("PlanetMap 仍残留旧的高度图图层判定 ('planet', 'heightmap')")
    # 地形槽位必须走 rep，不能又回到"直接看图层开关就 drawTerrain"
    if "if (layers.isVisible('planet', 'terrain')) drawing.drawTerrain(ctx);" in pm:
        problems.append('PlanetMap 地形槽位仍是旧判定（未走 terrainRep）')

    hit = io.open(p_hit, encoding='utf-8').read()
    if 's.terrainHit' not in hit:
        problems.append('planetHitTest 未使用 terrainHit（命中未随动）')
    if "isEditable('planet', 'terrain')" in hit:
        problems.append("planetHitTest 仍残留旧命中判定 isEditable('planet','terrain')")

    exp = io.open(p_exp, encoding='utf-8').read()
    if 'terrainRepresentation' not in exp:
        problems.append('useFullMapExport 未引用共享判定模块（导出未随动）')
    if 'rep.drawHeightmap' not in exp or 'rep.drawPolygons' not in exp:
        problems.append('useFullMapExport 地形槽位未走 rep（导出仍只有 drawTerrain？）')
    return problems


JS_MAIN = r"""(async () => {
  const fails = [];
  const notes = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));

  const el = document.querySelector('.planet-map-container');
  const pm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
  ck('装置：PlanetMap 已挂载', !!pm, null);
  if (!pm) return JSON.stringify({ fails, notes });

  const cv = document.querySelector('.planet-map-container .canvas-wrapper canvas');
  ck('装置：画布已就绪', !!cv, null);
  if (!cv) return JSON.stringify({ fails, notes });
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const snap = () => new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);
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

  // 把图层拨到"默认态"（用例之间共享同一个页面，图层是全局单例，可能被前面的用例改过）
  const P = pm.layers.layers.planet;
  if (!P.terrain.visible) pm.layers.toggleLayer('planet', 'terrain');
  if (P[%POLY_JSON%].visible) pm.layers.toggleLayer('planet', %POLY_JSON%);
  await tick(500);

  // ---------- f1 画布：高度图驱动 + 覆盖物开关 ----------
  const rep1 = pm.terrainRep;
  ck('f1 装置：当前行星有高度图（前置，否则本用例前提不成立）',
     !!(pm.currentMapData && pm.currentMapData.heightmap && pm.currentMapData.heightmap.h && pm.currentMapData.heightmap.h.length),
     null);
  ck('f1 ★ 默认以**高度图**为主表示（不再是多边形）', rep1.source === 'heightmap', { source: rep1.source });
  ck('f1 ★ 多边形默认**不画**（已降为可选覆盖物）', rep1.drawPolygons === false, null);
  ck('f1 主表示高度图**不透明**（半透明会透出画布背景 = 看起来"脏"）',
     rep1.heightmapAlpha === 1, { alpha: rep1.heightmapAlpha });

  const before = snap();
  pm.layers.toggleLayer('planet', %POLY_JSON%);      // 打开覆盖物
  await tick(700);
  const rep2 = pm.terrainRep;
  ck('f1 打开覆盖物后判定随之变化', rep2.drawPolygons === true, null);
  ck('f1 覆盖物**半透明**（否则它把高度图遮死 = 打开等于回到旧观感）',
     rep2.polygonAlpha > 0 && rep2.polygonAlpha < 1, { alpha: rep2.polygonAlpha });
  const mid = snap();
  pm.layers.toggleLayer('planet', %POLY_JSON%);      // 关回
  await tick(700);
  const after = snap();

  const d1 = diff(before, mid);
  const d2 = diff(before, after);
  notes.push('画布 ' + W + 'x' + H + '；开覆盖物差异像素 ' + d1.n + ' maxDelta=' + d1.maxD + '；关回后差异 ' + d2.n);
  ck('f1 ★ 打开覆盖物后画布**确实变了**（像素级证据）', d1.n > 0, { diffPixels: d1.n });
  ck('f1 差异显著（不是抗锯齿噪声）', d1.maxD >= 10, { maxDelta: d1.maxD });
  // ★ 最强断言：关回去必须一模一样（排除相机移动 / 整体重绘差异等一切其他解释）
  ck('f1 ★ 关回覆盖物后画面**逐像素复原**', d2.n === 0, { diffPixels: d2.n });

  // ---------- f2 命中随动：看得见才点得到 ----------
  const md = pm.currentMapData;
  const polys = (md && md.terrain) || [];
  ck('f2 装置：该行星有地形多边形（前置）', polys.length > 0, { count: polys.length });
  if (polys.length) {
    // 取一个多边形的质心（顶点均值即在其内部——凸多边形；fixture 的多边形都是凸的）
    let pick = null;
    for (const poly of polys) {
      const pts = poly.points || [];
      if (pts.length < 3) continue;
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p.x; sy += p.y; }
      pick = { poly, x: sx / pts.length, y: sy / pts.length };
      break;
    }
    ck('f2 装置：取到可用多边形', !!pick, null);
    if (pick) {
      // 关掉会抢命中的其它图层（标记/地点/路线/区域/文本/簇），测完还原
      const others = ['markers', 'places', 'routes', 'regions', 'textLabels', 'clusters'];
      const saved = {};
      for (const k of others) { saved[k] = P[k].visible; if (P[k].visible) pm.layers.toggleLayer('planet', k); }
      await tick(300);

      const h1 = pm.hitTestModule.hitTest(pick.x, pick.y);
      ck('f2 ★ 覆盖物关着时**点不到**那片多边形（看不见的东西不该被点中）',
         !h1 || h1.type !== 'province', h1 ? { type: h1.type } : null);

      pm.layers.toggleLayer('planet', %POLY_JSON%);
      await tick(400);
      const h2 = pm.hitTestModule.hitTest(pick.x, pick.y);
      ck('f2 ★ 打开覆盖物后能点中多边形（返回 province）',
         !!h2 && h2.type === 'province', h2 ? { type: h2.type } : null);
      ck('f2 命中的正是那一片（对象身份一致）', !!h2 && h2.polygon === pick.poly, null);

      pm.layers.toggleLayer('planet', %POLY_JSON%);
      for (const k of others) { if (P[k].visible !== saved[k]) pm.layers.toggleLayer('planet', k); }
      await tick(300);
      const h3 = pm.hitTestModule.hitTest(pick.x, pick.y);
      ck('f2 关回后恢复"点不到"（图层状态真的还原了）',
         !h3 || h3.type !== 'province', h3 ? { type: h3.type } : null);
    }
  }

  // ---------- f3 导出随动：默认带高度图，覆盖物打开后带地形 path ----------
  const r1 = pm.buildFullMapSVG();
  const img1 = (r1.svg.match(/<image /g) || []).length;
  const p1 = (r1.svg.match(/<path /g) || []).length;
  ck('f3 ★ 默认导出含**高度图**（内联位图）—— 本轮之前导出链里根本没有高度图',
     img1 >= 1, { images: img1 });
  ck('f3 默认导出**不含**地形多边形 path（它已退为覆盖物，默认关）',
     p1 < (md.terrain || []).length, { paths: p1, polys: (md.terrain || []).length });

  pm.layers.toggleLayer('planet', %POLY_JSON%);
  const r2 = pm.buildFullMapSVG();
  const p2 = (r2.svg.match(/<path /g) || []).length;
  pm.layers.toggleLayer('planet', %POLY_JSON%);
  ck('f3 ★ 打开覆盖物后导出里出现地形 path（导出与画布同一份判定）',
     p2 >= (md.terrain || []).length && p2 > p1, { before: p1, after: p2, polys: (md.terrain || []).length });
  const r3 = pm.buildFullMapSVG();
  const p3 = (r3.svg.match(/<path /g) || []).length;
  ck('f3 关回后导出复原', p3 === p1, { before: p1, restored: p3 });

  return JSON.stringify({ fails, notes });
})()""".replace('%POLY_JSON%', json.dumps(POLY_LAYER))


def run(cdp):
    fails = []

    problems = _static_guard()
    if problems:
        fails.append('f0：' + '；'.join(problems))

    level = goto_planet(cdp)
    if level != 'planet':
        return False, f'导航行星失败: {level}'
    wait_for(cdp, "!!document.querySelector('.planet-map-container')", desc='PlanetMap 挂载', timeout=15)

    ok, res = eval_json(cdp, JS_MAIN, desc='地形表示与导出随动')
    if not ok:
        fails.append(f'求值：{res}')
    elif res.get('fails'):
        fails.extend([str(x) for x in res['fails'][:10]])

    notes = (res.get('notes') or []) if isinstance(res, dict) else []
    if fails:
        return False, f'M2 第二步断言失败 {len(fails)} 项：' + '；'.join(fails[:10])

    return True, ('三处共用同一份判定（无残留旧 if）；默认高度图主表示且多边形不画；'
                  '开覆盖物→画布变、命中通、导出含地形 path；关回→逐像素复原'
                  + ('；' + '；'.join(notes) if notes else ''))
