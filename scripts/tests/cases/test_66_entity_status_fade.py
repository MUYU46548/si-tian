#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 66：叙事状态的“画布淡化”—— 像素级证据

前情（2026-09-24）：用户决策“**毁灭只是叙事状态，不是数据删除**”。状态在面板上有徽标，
在 5 个画布上也要做**视觉降权**（`utils/entityStatus.js` 的 `fadedAlpha`，`FADED_ALPHA = 0.45`）。
`test_entity_status` 的接线守卫能挡住“漏接”（绘制入口没调 fadedAlpha），
但挡不住“接了却画不出来”—— 本用例补的就是这一段。

**为什么这样断言**（而不是"亮度下降"）：
  ① “变暗”是方向性断言，依赖配色与主题细节，改一次配色就假红；
  ② **“改回 active 之后画面逐像素复原”** 才是不可反驳的证据：它同时排除了
     “差异来自别的副作用”（相机移动、整体重绘差异、别的节点被连带改动 —— 这些都会让复原失败）；
  ③ 再加一条“差异只出现在该节点附近”把影响范围锁死，避免"整屏都变了"也算通过。

**为什么选 PlanetMap**：复原断言要求这段窗口内画面**无动画**。
  PlanetMap 没有动画循环（无 `startAnimation`、无 flicker），背景/地貌/标签都是确定性哈希，
  且 test_38 已证明“部分重绘与全画布重绘逐像素一致”→ 复原断言可达。
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

  // ---- 关掉地形层：本用例测的是**实体状态淡化**，底图与判据无关 ----
  // 🔴 2026-11-16：地形栅格是分块烘焙的（4096 宽约 7–9 秒 CPU，先粗档后逐带精修）。
  //    before / mid / after 三次快照必然拍到不同精修档，整屏 25% 像素差（实测 537,921 字节），
  //    于是“改回 active 后逐像素复原”这条最强断言被烘焙进度打红，读起来像“淡化改不回去”。
  //    把干扰源关掉，判据只对节点图像负责。
  if (pm.layers && pm.layers.isVisible('planet', 'terrain')) {
    pm.layers.toggleLayer('planet', 'terrain');
    await tick(400);
  }

  // ---- 把探针移到画布中心并放大到 2x（保证节点占足够设备像素）----
  pm.renderer.focusOn(probe.coordinate.x, probe.coordinate.y, 2);
  await tick(400);

  const W = cv.width, H = cv.height;
  const snap = () => new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);

  /**
   * 等到画面**连续两拍完全一致**。
   *
   * 🔴 2026-11-16：地形栅格是**分块烘焙**的（2026-11-08 起：先 1/10 粗档铺底，再按 24ms/片
   * 逐带精修，4096 宽约 7–9 秒 CPU）。固定 `tick(400)` 拍下来的 before 往往还在粗档，
   * 而 1 秒后的 after 已经精修完 —— 两张图整屏不同（实测 diffPixels 53 万），
   * 于是“逐像素复原”这条最强断言被烘焙进度打红，读起来像“淡化改不回去”。
   */
  // 🔴 "连续 3 拍 + 至少 1500ms"：只等"两拍相同"会在**视口块烘焙**开始前就返回
  //    （相机静止 260ms 后才起烘，见 scenario/viewBake.js）—— before 拍到没有视口块的帧、
  //    after 拍到叠上视口块后的帧，整屏 25% 像素不同，读起来像"淡化改不回去"。
  const waitStable = async (ms = 15000, step = 300, needSame = 3, minMs = 1500) => {
    const t0 = Date.now();
    let prev = snap();
    let same = 0;
    while (Date.now() - t0 < ms) {
      await tick(step);
      const cur = snap();
      let eq = cur.length === prev.length;
      if (eq) {
        for (let i = 0; i < cur.length; i += 4) {
          if (cur[i] !== prev[i] || cur[i + 1] !== prev[i + 1] || cur[i + 2] !== prev[i + 2]) { eq = false; break; }
        }
      }
      prev = cur;
      same = eq ? same + 1 : 0;
      if (same >= needSame && (Date.now() - t0) >= minMs) return { stable: true, ms: Date.now() - t0 };
    }
    return { stable: false, ms: Date.now() - t0 };
  };
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
  const stab0 = await waitStable();      // 烘焙精修完再取基准（否则复原断言必然红）
  const dim0 = { w: cv.width, h: cv.height, vt: { ...pm.renderer.viewTransform } };
  const before = snap();
  store.updateNode(probe.id, { status: 'destroyed' });
  const rev1 = store.statusRevision;
  await tick(500);
  const mid = snap();
  store.updateNode(probe.id, { status: 'active' });
  await tick(500);
  const stab1 = await waitStable();
  const dim1 = { w: cv.width, h: cv.height, vt: { ...pm.renderer.viewTransform } };
  const after = snap();

  const d1 = diffStat(before, mid);    // 淡化前后
  const d2 = diffStat(before, after);  // 复原后

  notes.push('行星=' + planet.id + ' 探针=' + probe.id + (created ? '(新建)' : '(既有)') + ' 画布=' + W + 'x' + H);
  notes.push('指纹 +' + (rev1 - rev0) + '；淡化差异像素 ' + d1.n + '/' + (W * H) + ' maxDelta=' + d1.maxD);
  notes.push('尺寸/相机 before=' + JSON.stringify(dim0) + ' after=' + JSON.stringify(dim1));
  // 差异按行分 10 段：分块烘焙的差异是**水平带**，整屏叠加/相机变化是**均匀**的
  {
    const bands = new Array(10).fill(0);
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] !== after[i] || before[i+1] !== after[i+1] || before[i+2] !== after[i+2]) {
        const py = (i >> 2) / W | 0;
        bands[Math.min(9, Math.floor(py / H * 10))] += 1;
      }
    }
    notes.push('复原差异按行分布(像素)=' + JSON.stringify(bands));
  }
  notes.push('复原差异像素 ' + d2.n + (d1.bbox ? '；差异化区域 ' + JSON.stringify(d1.bbox) : '')
    + '；等稳定 ' + stab0.ms + 'ms/' + stab1.ms + 'ms（' + (stab0.stable && stab1.stable ? '都稳定' : '有超时') + '）');

  ck('status 变更递增指纹（画布重绘信号）', rev1 === rev0 + 1, { before: rev0, after: rev1 });
  ck('淡化后画布**确实**变了（像素级证据）', d1.n > 0, { diffPixels: d1.n });
  ck('差异足够显著（不是抗锯齿噪声）', d1.maxD >= 20, { maxDelta: d1.maxD });
  ck('差异是**局部**的（不是整屏重绘差异）', d1.n < W * H * 0.05, { ratio: +(d1.n / (W * H)).toFixed(4) });
  if (d1.bbox) {
    // 判据从“差异中心距画布中心 ≤80px”改成“差异区域**覆盖**画布中心 + 不是整屏”。
    // 理由（2026-11-16）：关掉地形层之后节点是画面上唯一的彩色元素，图标 + 名称标签一起淡化，
    // 包围盒向标签方向延伸（实测宽 263px、中心偏 107px）—— 旧容差按有底图的画面定的，已不适用。
    const [x0, y0, x1, y1] = d1.bbox;
    const coversCenter = x0 <= W / 2 && x1 >= W / 2 && y0 <= H / 2 && y1 >= H / 2;
    const areaRatio = ((x1 - x0 + 1) * (y1 - y0 + 1)) / (W * H);
    ck('差异化区域覆盖画布中心（focusOn 把该节点放在中心，差异就发生在它身上）',
       coversCenter, { bbox: d1.bbox, center: [W / 2, H / 2] });
    ck('差异化区域仍是局部的（包围盒面积 < 画布 25%）', areaRatio < 0.25, { areaRatio: +areaRatio.toFixed(3) });
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
        # 失败也要把 notes 带出来（否则"537921"这种读数无从归因）
        return False, (f'淡化断言失败 {len(fails)} 项：' + '；'.join(fails[:8])
                       + ('｜' + '；'.join(res.get('notes') or []) if res.get('notes') else ''))
    notes = res.get('notes') or []
    return True, ('改 state→画布像素确实变化（局部、显著）→ 改回后逐像素复原 —— 全部通过'
                  + ('；' + '；'.join(notes) if notes else ''))
