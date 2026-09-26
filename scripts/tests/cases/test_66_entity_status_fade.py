#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 66：叙事状态的「画布淡化」—— 像素级证据

前情（2026-09-24）：用户决策「**毁灭只是叙事状态，不是数据删除**」。状态在面板上有徽标，
在 5 个画布上也要做**视觉降权**（`utils/entityStatus.js` 的 `fadedAlpha`，`FADED_ALPHA = 0.45`）。
`test_entity_status` 的接线守卫能挡住「漏接」（绘制入口没调 fadedAlpha），
但挡不住「接了却画不出来」—— 本用例补的就是这一段。

**为什么这样断言**（而不是"亮度下降"）：
  ① 「变暗」是方向性断言，依赖配色与主题细节，改一次配色就假红；
  ② **「改回 active 之后画面逐像素复原」** 才是不可反驳的证据：它同时排除了
     「差异来自别的副作用」（相机移动、整体重绘差异、别的节点被连带改动 —— 这些都会让复原失败）；
  ③ 再加一条「差异只出现在该节点附近」把影响范围锁死，避免"整屏都变了"也算通过。

**为什么选 PlanetMap**：复原断言要求这段窗口内画面**无动画**。
  PlanetMap 没有动画循环（无 `startAnimation`、无 flicker），背景/地貌/标签都是确定性哈希，
  且 test_38 已证明「部分重绘与全画布重绘逐像素一致」→ 复原断言可达。
  GalaxyMap 有 `animationTime` 驱动的闪烁，不能用于本断言。
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

JS = r"""(async () => {
  const fails = [];
  const notes = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));

  const app = document.querySelector('#app').__vue_app__;
  const store = app._instance.setupState.store;
  const nodes = store.nodes;

  // ---- 导航到行星地图（自底向上锚定，避开空壳世界）----
  let w = nodes.find(n => n.layer === 'world' && nodes.some(c => c.layer === 'star_domain' && c.parentId === n.id))
       || nodes.find(n => n.layer === 'world');
  const d = w && nodes.find(n => n.layer === 'star_domain' && n.parentId === w.id);
  const g = d && nodes.find(n => n.layer === 'galaxy' && n.parentId === d.id);
  const planet = (g && nodes.find(n => n.layer === 'planet' && n.parentId === g.id))
              || nodes.find(n => n.layer === 'planet');
  ck('装置：找到行星节点', !!planet, { worlds: nodes.filter(n => n.layer === 'world').length });
  if (!planet) return JSON.stringify({ fails });
  if (w) store.selectWorld(w);
  if (d) store.selectDomain(d);
  if (g) store.selectSystem(g);
  store.selectPlanet(planet);
  await tick(600);

  const CV_SEL = '.planet-map-container .canvas-wrapper canvas';
  for (let i = 0; i < 60 && !document.querySelector(CV_SEL); i++) await tick(100);
  const el = document.querySelector('.planet-map-container');
  const pm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
  const cv = document.querySelector(CV_SEL);
  ck('装置：PlanetMap 与画布已挂载', !!(pm && pm.renderer && cv), { viewLevel: store.viewLevel });
  if (!(pm && pm.renderer && cv)) return JSON.stringify({ fails, viewLevel: store.viewLevel });
  const ctx = cv.getContext('2d');

  // ---- 找一个（或造一个）探针聚落：不依赖 fixture 恰好有城市挂在行星下 ----
  const PLACE_LAYERS = ['location', 'city', 'town', 'village', 'facility'];
  let probe = nodes.find(n => PLACE_LAYERS.includes(n.layer) && n.parentId === planet.id
    && n.coordinate && n.coordinate.x != null && n.coordinate.y != null);
  let created = false;
  if (!probe) {
    store.addNode({
      id: '淡化探针镇', name: '淡化探针镇', layer: 'town', parentId: planet.id,
      tags: [], sourcePath: '', coordinate: { x: 0, y: 0 },
    });
    await tick(250);
    probe = store.nodes.find(n => n.id === '淡化探针镇') || null;
    created = true;
  }
  ck('装置：拿到探针聚落（有坐标）', !!probe, { created });
  if (!probe) return JSON.stringify({ fails });

  // 清掉选中：选中/悬停会让 focused=true → **不淡化**（编辑优先于装饰），会污染采样。
  // 不发任何鼠标事件 → hoveredNode 保持 null（CDP 默认没有 mousemove）。
  if (pm.selectedPlaceIds && typeof pm.selectedPlaceIds.clear === 'function') pm.selectedPlaceIds.clear();
  store.clearSelection();

  // ---- 把探针移到画布中心并放大到 2x（保证节点占足够设备像素）----
  pm.renderer.focusOn(probe.coordinate.x, probe.coordinate.y, 2);
  await tick(400);

  const W = cv.width, H = cv.height;
  const snap = () => new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);
  const diffStat = (a, b) => {
    let n = 0, maxD = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        n++;
        const dv = Math.abs(a[i] - b[i]);
        if (dv > maxD) maxD = dv;
        const p = i >> 2, px = p % W, py = (p / W) | 0;
        if (px < x0) x0 = px;
        if (py < y0) y0 = py;
        if (px > x1) x1 = px;
        if (py > y1) y1 = py;
      }
    }
    return { n, maxD, bbox: x1 >= 0 ? [x0, y0, x1, y1] : null };
  };

  // ══ 采样三段：active → destroyed → active ══
  const rev0 = store.statusRevision;
  const before = snap();
  store.updateNode(probe.id, { status: 'destroyed' });
  const rev1 = store.statusRevision;
  await tick(500);
  const mid = snap();
  store.updateNode(probe.id, { status: 'active' });
  await tick(500);
  const after = snap();

  const d1 = diffStat(before, mid);    // 淡化前后
  const d2 = diffStat(before, after);  // 复原后

  notes.push('行星=' + planet.id + ' 探针=' + probe.id + (created ? '(新建)' : '(既有)') + ' 画布=' + W + 'x' + H);
  notes.push('指纹 +' + (rev1 - rev0) + '；淡化差异像素 ' + d1.n + '/' + (W * H) + ' maxDelta=' + d1.maxD);
  notes.push('复原差异像素 ' + d2.n + (d1.bbox ? '；差异化区域 ' + JSON.stringify(d1.bbox) : ''));

  ck('status 变更递增指纹（画布重绘信号）', rev1 === rev0 + 1, { before: rev0, after: rev1 });
  ck('淡化后画布**确实**变了（像素级证据）', d1.n > 0, { diffPixels: d1.n });
  ck('差异足够显著（不是抗锯齿噪声）', d1.maxD >= 20, { maxDelta: d1.maxD });
  ck('差异是**局部**的（不是整屏重绘差异）', d1.n < W * H * 0.05, { ratio: +(d1.n / (W * H)).toFixed(4) });
  if (d1.bbox) {
    const cx = (d1.bbox[0] + d1.bbox[2]) / 2, cy = (d1.bbox[1] + d1.bbox[3]) / 2;
    const dx = Math.abs(cx - W / 2), dy = Math.abs(cy - H / 2);
    ck('差异化区域落在该节点附近（focusOn 把它放在画布中心 ±80 设备像素）',
       dx <= 80 && dy <= 80, { dx: Math.round(dx), dy: Math.round(dy), bbox: d1.bbox });
  } else {
    ck('差异化区域有包围盒', false, null);
  }
  // ★ 最强断言
  ck('★ 改回 active 后画面**逐像素复原**（证明差异只来自该节点的淡化，而非其他副作用）',
     d2.n === 0, { diffPixels: d2.n });

  return JSON.stringify({ fails, notes, viewLevel: store.viewLevel });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    ok, res = eval_json(cdp, JS, desc='画布淡化像素证据')
    if not ok:
        return False, res
    if res.get('aborted'):
        return False, f'前置步骤失败已中止：{res["aborted"]}'
    fails = res.get('fails') or []
    if fails:
        return False, (f'淡化断言失败 {len(fails)} 项：' + '；'.join(fails[:8]))
    notes = res.get('notes') or []
    return True, ('改 state→画布像素确实变化（局部、显著）→ 改回后逐像素复原 —— 全部通过'
                  + ('；' + '；'.join(notes) if notes else ''))
