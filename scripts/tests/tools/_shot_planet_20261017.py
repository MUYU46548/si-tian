#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""行星视图出图（**不是回归用例**）：第六轮两件事的**观感证据**——

  01 空态：中央卡片 + 两个真按钮（导入 .map / 从零开始画）
  02 导入后：真实 `desite.map` 走**产品导入链**装进本行星 → 地形上画布 + 底部回执横幅
  03 保存诚实（staged）：横幅必须是「已交给项目，正在写入磁盘…」**黄标**，不是「保存成功」绿标
  04 保存诚实（persisted）：真进磁盘才「已保存到磁盘」绿标

做法与 `_shot_story_real_20261017.py` 一致：真实底图临时放进 Vite public 目录让页面 fetch，
跑完（无论成败）删掉；用**真按钮点击 + 真 File 注入**走产品链路，不直接调 store。
用法：py -3 scripts/tests/tools/_shot_planet_20261017.py
输出：docs/assets/planet-20261017/*.png
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

DEV_PORT = 5180
CDP_PORT = 9222
EDGE_EXE = r'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
OUT_DIR = os.path.join(ROOT, 'docs', 'assets', 'planet-20261017')
PIDFILE = os.path.join(ROOT, '.lab-pids.json')
PUBLIC_DIR = os.path.join(ROOT, 'src', 'renderer', 'public')
TMP_MAP = os.path.join(PUBLIC_DIR, '__shot_desite.map')
SRC_MAP = os.path.join(ROOT, 'docs', 'mockups', 'desite.map')

STORY = r"""
(() => {
(async () => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const info = {};
  window.__storyInfo = info;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const S = async (name) => {
    window.__shots.push(name);
    const n = window.__shotAck + 1;
    const t0 = Date.now();
    while (window.__shotAck < n && Date.now() - t0 < 30000) await tick(40);
  };
  const pm = () => {
    const el = document.querySelector('.planet-map-container');
    return el ? el.__vueParentComponent.setupState : null;
  };
  try {
    try {
      const P0 = pm();
      if (!P0) throw new Error('PlanetMap 未挂载');
      const pid0 = P0.currentMapData.planetId;
      const planetNode = s.nodes.find((n) => n.id === pid0);
      // 清空这颗行星（出图要的是"真正空的行星"）
      s.mapData[pid0] = {
        planetId: pid0, version: 1, terrain: [], regions: [], markers: [],
        routes: [], textLabels: [], rivers: [], heightmap: null,
        referenceImages: [], azgaarProvinces: [], azgaarStates: [],
        azgaarCultures: [], azgaarReligions: [],
      };
      // 🔴 先离开再回来：让 PlanetMap **重新挂载**（新 canvas 元素）。
      //    直接在渲染器背后改 mapData 不会标记脏区，旧画布上会残留上一张图的像素
      //    （首版出图里"空态画布上还有地形色块"就是这么来的；product 自己的写口不会这样）。
      const galaxy = s.nodes.find((n) => n.layer === 'galaxy');
      if (galaxy) { s.selectSystem(galaxy); await tick(900); }
      s.selectPlanet(planetNode);
      await tick(1400);
    } catch (e) { window.__storyErr = 'remount: ' + String(e); }

    // ── ① 空态卡片（重新挂载后的干净画布）────────────────────────────────
    let P = pm();
    const pid = P.currentMapData.planetId;
    info.emptyHint = !!document.querySelector('[data-testid="planet-empty-hint"]');
    info.importBtn = !!document.querySelector('[data-testid="planet-import-map"]');
    try { if (P.renderer.markFullRedraw) P.renderer.markFullRedraw(); else P.renderer.requestRender(); } catch (e) { /* ignore */ }
    await tick(500);
    await S('01-planet-empty');
    {
      const md0 = P.currentMapData || {};
      const L0 = P.layers && P.layers.layers ? P.layers.layers.planet : {};
      let pix = null;
      try {
        const cv = document.querySelector('.planet-map-container canvas');
        const g = cv.getContext('2d');
        const d = g.getImageData(180, 40, 1, 1).data;   // 首版出图里"残影"所在的画布坐标附近
        pix = [d[0], d[1], d[2]];
      } catch (e) { pix = 'err:' + e; }
      info.emptyDiag = {
        sameObject: md0 === s.mapData[pid],
        hm: !!md0.heightmap,
        terrain: (md0.terrain || []).length,
        regions: (md0.regions || []).length,
        keys: Object.keys(md0),
        rep: P.terrainRep ? { h: P.terrainRep.drawHeightmap, p: P.terrainRep.drawPolygons } : null,
        layerOn: Object.keys(L0).filter((k) => L0[k] && L0[k].visible),
        editMode: !!P.editMode,
        interactionMode: P.interactionMode,
        pixel: pix,
        fog: !!document.querySelector('.empty-map-hint'),
      };
      // "色块"到底是什么：在画布上找一块棕/沙色像素，报它的坐标与 alpha
      try {        const cv0 = document.querySelector('.planet-map-container .canvas-wrapper canvas');
        const g0 = cv0.getContext('2d');
        const W0 = cv0.width, H0 = cv0.height;
        const d0 = g0.getImageData(0, 0, W0, H0).data;
        let hit = null, alpha = null;
        for (let i = 0; i < d0.length; i += 4) {
          const r = d0[i], gg = d0[i + 1], b = d0[i + 2];
          if (Math.abs(r - 130) < 8 && Math.abs(gg - 110) < 8 && Math.abs(b - 90) < 8) {
            const p = i / 4;
            hit = { x: p % W0, y: Math.floor(p / W0) };
            alpha = d0[i + 3];
            break;
          }
        }
        info.blobProbe = { canvasSize: [W0, H0], hit, alpha,
          canvasCount: document.querySelectorAll('.planet-map-container canvas').length,
          canvases: Array.from(document.querySelectorAll('.planet-map-container canvas')).map((c) => {
            const r = c.getBoundingClientRect();
            return {
              cls: (c.className || '').toString(),
              parent: (c.parentElement && c.parentElement.className) || '',
              rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
              size: [c.width, c.height],
              display: getComputedStyle(c).display,
              opacity: getComputedStyle(c).opacity,
            };
          }) };
      } catch (e) { info.blobProbe = 'err:' + e; }
    }
    info.emptyHint = !!document.querySelector('[data-testid="planet-empty-hint"]');
    info.importBtn = !!document.querySelector('[data-testid="planet-import-map"]');
    await S('01-planet-empty');

    // 画布帧率探针：headless 下 rAF 可能被节流 —— 若 rAF 不跑，requestRender 只是排队，
    // 截图就会拍到"上一帧"（首版出图里空态残留旧地形色块的真正原因就在这条链上）
    if (window.__SHOT_DIAG) {
      let ticks = 0;
      const t0 = performance.now();
      let stop = false;
      const loop = () => { if (stop) return; ticks++; requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      await tick(500);
      stop = true;
      info.raf = { ticks, ms: Math.round(performance.now() - t0) };
    }

    // 逐个"关掉"绘制函数（不是单独画，而是把它从这一帧里摘掉）——
    // onRender 的调用参数与我的猜测未必一致，只有这样才能确定"是谁画的"
    if (window.__SHOT_DIAG) {
      const cv = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      const g = cv.getContext('2d');
      const blobCount = () => {
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          if (Math.abs(r - 130) < 14 && Math.abs(gg - 110) < 14 && Math.abs(b - 90) < 14) n++;
          else if (Math.abs(r - 210) < 14 && Math.abs(gg - 190) < 14 && Math.abs(b - 140) < 14) n++;
        }
        return n;
      };
      const D = P.drawing || {};
      const skip = { drawBackground: 1, drawFog: 1 };
      info.fnMask = {};
      const base = blobCount();
      info.fnMask.__base = base;
      for (const k of Object.keys(D)) {
        if (typeof D[k] !== 'function' || skip[k]) continue;
        const orig = D[k];
        D[k] = () => undefined;
        if (P.renderer.markFullRedraw) P.renderer.markFullRedraw(); else P.renderer.requestRender();
        await tick(200);
        info.fnMask[k] = blobCount();
        D[k] = orig;
      }
      if (P.renderer.markFullRedraw) P.renderer.markFullRedraw(); else P.renderer.requestRender();
      await tick(200);
    }

    // ── ② 点**真按钮**导入真实 desite.map（走产品链路）─────────────────────
    // 出图只回答"看到了什么"；这一小段回答"那些色块是谁画的"——
    // 逐层关掉再比像素（首版出图里空态画布上有几块旧地形色块，成因就是靠这段查出来的）
    if (window.__SHOT_DIAG) {
      const cv = document.querySelector('.planet-map-container canvas');
      const g = cv.getContext('2d');
      const snap = () => g.getImageData(0, 0, cv.width, cv.height).data;
      // 那些色块的两种主色（首版出图取样：#826E5A 棕 / #D2BE8C 沙）
      const blobCount = (d) => {
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          if (Math.abs(r - 130) < 14 && Math.abs(gg - 110) < 14 && Math.abs(b - 90) < 14) n++;
          else if (Math.abs(r - 210) < 14 && Math.abs(gg - 190) < 14 && Math.abs(b - 140) < 14) n++;
        }
        return n;
      };
      const base = snap();
      info.blobs = { before: blobCount(base) };
      info.markFullRedrawType = typeof (P.renderer && P.renderer.markFullRedraw);
      try { if (P.renderer && P.renderer.markFullRedraw) P.renderer.markFullRedraw(); } catch (e) { info.markErr = String(e); }
      await tick(500);
      info.blobs.afterFullRedraw = blobCount(snap());
      const diff = (d) => { let n = 0; for (let i = 0; i < d.length; i += 4 * 37) { if (Math.abs(d[i] - base[i]) > 6) n++; } return n; };
      const keys = Object.keys((P.layers && P.layers.layers && P.layers.layers.planet) || {});
      info.layerBisect = {};
      for (const k of keys) {
        const L = P.layers.layers.planet[k];
        if (!L || !L.visible) continue;
        P.layers.toggleLayer('planet', k);
        await tick(180);
        info.layerBisect[k] = diff(snap());
        P.layers.toggleLayer('planet', k);
        await tick(120);
      }
      await tick(300);
      info.blobs.after = blobCount(snap());

      // ── 逐函数单独上画布：到底是谁把那几块色块画出来的（清空后单画一次，数不透明像素）──
      {
        const W = cv.width, H = cv.height;
        const vt = P.renderer.viewTransform;
        const paint = (fn) => {
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.clearRect(0, 0, W, H);
          g.save();
          g.translate(W / 2 + vt.x, H / 2 + vt.y);
          g.scale(vt.scale, vt.scale);
          try { fn(g); } catch (e) { /* 缺参数就跳过 */ }
          g.restore();
          const d = g.getImageData(0, 0, W, H).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 8) n++;
          return n;
        };
        const D = P.drawing || {};
        const calls = {
          drawBackground: (x) => D.drawBackground(x, W, H),
          drawReferenceImage: (x) => D.drawReferenceImage(x),
          drawFog: (x) => D.drawFog(x, W, H),
          drawTerrain: (x) => D.drawTerrain(x, { alpha: 1 }),
          drawHeightmap: (x) => D.drawHeightmap(x, 1),
          drawHeightmapRaster: (x) => D.drawHeightmapRaster(x, 'biome', 1),
          drawTerrainLabels: (x) => D.drawTerrainLabels(x),
          drawElevation: (x) => D.drawElevation(x),
          drawReliefIcons: (x) => D.drawReliefIcons(x),
          drawRegions: (x) => D.drawRegions(x),
          drawRivers: (x) => D.drawRivers(x),
          drawRoutes: (x) => D.drawRoutes(x),
          drawPlaces: (x) => D.drawPlaces(x),
          drawMarkers: (x) => D.drawMarkers(x),
          drawClusters: (x) => D.drawClusters(x),
          drawTextLabels: (x) => D.drawTextLabels(x),
          drawPoliticalBorders: (x) => D.drawPoliticalBorders(x),
          drawBiomeContours: (x) => D.drawBiomeContours(x),
          drawCoastlineRidges: (x) => D.drawCoastlineRidges(x),
          drawCultureReligionRegions: (x) => D.drawCultureReligionRegions(x),
        };
        info.fnPaint = {};
        for (const k of Object.keys(calls)) {
          if (typeof D[k] !== 'function') { info.fnPaint[k] = 'missing'; continue; }
          info.fnPaint[k] = paint(calls[k]);
        }
        // 复原画面（单函数试验把画布清过了）
        if (P.renderer.markFullRedraw) P.renderer.markFullRedraw(); else P.renderer.requestRender();
        await tick(300);
      }
    }
    const text = await (await fetch('/__shot_desite.map')).text();
    info.mapBytes = text.length;
    const realCreate = document.createElement.bind(document);
    document.createElement = function (tag, ...rest) {
      const el = realCreate(tag, ...rest);
      if (String(tag).toLowerCase() === 'input') {
        el.click = function () {
          setTimeout(() => {
            try { el.onchange({ target: { files: [new File([text], 'desite.map', { type: 'text/plain' })] } }); }
            catch (e) { window.__storyErr2 = String(e); }
          }, 0);
        };
      }
      return el;
    };
    const btn = document.querySelector('[data-testid="planet-import-map"]');
    if (!btn) throw new Error('空态里没有导入按钮');
    btn.click();
    document.createElement = realCreate;

    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const md = s.mapData[pid];
      if (md && (md.terrain || []).length > 0) break;
      await tick(200);
    }
    await tick(1500);                       // 等栅格/多边形画完 + 回执横幅就位
    const md2 = s.mapData[pid];
    info.imported = {
      terrain: (md2.terrain || []).length,
      rivers: (md2.rivers || []).length,
      routes: (md2.routes || []).length,
      hCells: (md2.heightmap && md2.heightmap.h && md2.heightmap.h.length) || 0,
      ms: Date.now() - t0,
    };
    // ── 诊断（出图只给"看到了什么"，这些读数给"为什么长这样"）──────────────
    {
      const hm = md2.heightmap || {};
      const hArr = hm.h ? Array.from(hm.h) : [];
      const L = P.layers && P.layers.layers ? P.layers.layers.planet : {};
      info.diag = {
        pid,
        mapKeys: Object.keys(s.mapData || {}),
        curIsOurObject: P.currentMapData === md2,
        refImgsInData: (md2.referenceImages || []).length,
        refImgsInView: (P.referenceImage && P.referenceImage.referenceImages ? P.referenceImage.referenceImages.value.length : null),
        grid: hm.grid ? { cx: hm.grid.cellsX, cy: hm.grid.cellsY, pts: (hm.grid.points || []).length } : null,
        hStats: hArr.length ? {
          min: Math.min.apply(null, hArr), max: Math.max.apply(null, hArr),
          land: hArr.filter((v) => v >= 20).length, zero: hArr.filter((v) => v === 0).length,
        } : null,
        terrainRep: P.terrainRep ? { h: P.terrainRep.drawHeightmap, p: P.terrainRep.drawPolygons } : null,
        layerVisible: { terrain: L.terrain && L.terrain.visible, polys: L.terrainPolygons && L.terrainPolygons.visible,
                        refImage: L.referenceImage && L.referenceImage.visible },
        vt: P.renderer && P.renderer.viewTransform ? { s: Math.round(P.renderer.viewTransform.scale * 1000) / 1000,
              x: Math.round(P.renderer.viewTransform.x), y: Math.round(P.renderer.viewTransform.y) } : null,
        worldBounds: P.worldBounds || null,
      };
    }
    const bannerEl = document.querySelector('[data-testid^="planet-save-banner-"]');
    info.receipt = bannerEl ? (bannerEl.textContent || '').trim().slice(0, 200) : '';
    info.receiptKind = bannerEl ? bannerEl.getAttribute('data-testid') : '';
    // 出图卫生：清掉旧选中（选中引用指向替换前的省份对象 → 画布上会留一个高亮色块），
    // 并把镜头对准**导入的省份包围盒**（fitAllContent 会把散落的地点簇也算进去，图会很小）
    try {
      P.selectedProvince = null; P.selectedRegion = null; P.selectedMarker = null;
      P.selectedRoute = null; P.selectedTextLabel = null;
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const poly of (md2.terrain || [])) {
        for (const q of (poly.points || [])) {
          const x = q.x === undefined ? q[0] : q.x;
          const y = q.y === undefined ? q[1] : q.y;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (x < mnx) mnx = x; if (x > mxx) mxx = x;
          if (y < mny) mny = y; if (y > mxy) mxy = y;
        }
      }
      if (Number.isFinite(mnx) && P.renderer.fitView) {
        P.renderer.fitView({ minX: mnx, minY: mny, maxX: mxx, maxY: mxy });
        info.fitBox = { mnx: Math.round(mnx), mny: Math.round(mny), mxx: Math.round(mxx), mxy: Math.round(mxy) };
      }
    } catch (e) { info.fitErr = String(e); }
    await tick(700);
    await S('02-planet-imported');

    // ── ②b 只看多边形（关掉「地形」总开关 → 覆盖物接管）——用来核对"省份真的进来了" ──
    if (P.layers && P.layers.toggleLayer) {
      P.layers.toggleLayer('planet', 'terrainPolygons');
      await tick(500);
      await S('02b-polygons-only');
      P.layers.toggleLayer('planet', 'terrainPolygons');
      await tick(400);
    }

    // ── ③ 保存诚实：stub 成 staged（只交给项目）── 浏览态直接调 saveMap，不弹整条编辑工具栏 ──
    const origSave = s.saveMapData;
    s.saveMapData = async () => ({ success: true, staged: true, persisted: false });
    info.saveBtn = typeof P.saveMap === 'function';
    if (typeof P.saveMap === 'function') P.saveMap();
    await tick(700);
    const b3 = document.querySelector('[data-testid^="planet-save-banner-"]');
    info.staged = { text: b3 ? (b3.textContent || '').trim() : '', testid: b3 ? b3.getAttribute('data-testid') : '' };
    const sb3 = document.querySelector('[data-testid^="save-state-"]');
    info.statusBarStaged = sb3 ? { text: (sb3.textContent || '').trim(), testid: sb3.getAttribute('data-testid') } : null;
    await S('03-save-staged');

    // ── ④ 真落盘（persisted）才绿标 ────────────────────────────────────────
    s.saveMapData = async () => ({ success: true, staged: true, persisted: true });
    if (typeof P.saveMap === 'function') P.saveMap();
    await tick(700);
    const b4 = document.querySelector('[data-testid^="planet-save-banner-"]');
    info.persisted = { text: b4 ? (b4.textContent || '').trim() : '', testid: b4 ? b4.getAttribute('data-testid') : '' };
    await S('04-save-persisted');

    s.saveMapData = origSave;
    window.__done = true;
  } catch (e) {
    window.__storyErr = String((e && e.stack) || e);
    window.__done = true;
  }
})();
return 'started';
})()
"""


def _start_edge():
    import run_tests as RT
    RT.free_port(DEV_PORT)
    dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not RT.wait_port(DEV_PORT):
        raise RuntimeError('vite 起不来')
    RT.free_port(CDP_PORT)
    edge = subprocess.Popen([
        EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
        '--remote-debugging-port=%d' % CDP_PORT, '--remote-allow-origins=*',
        '--user-data-dir=%s' % os.path.join(ROOT, '.lab-edge-profile'),
        '--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--disable-features=SyncConsentUI,SigninCheckoutFlow', '--no-sandbox', 'about:blank',
    ])
    if not RT.wait_port(CDP_PORT):
        raise RuntimeError('edge 起不来')
    with open(PIDFILE, 'w') as f:
        json.dump({'dev': dev.pid, 'edge': edge.pid}, f)


def _stop():
    import run_tests as RT
    if os.path.exists(PIDFILE):
        with open(PIDFILE) as f:
            pids = json.load(f)
        for pid in pids.values():
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
        os.remove(PIDFILE)
    RT.free_port(DEV_PORT)
    RT.free_port(CDP_PORT)
    RT.teardown_mock()


def main():
    import run_tests as RT
    from lib.cdp import CDP, wait_for
    from lib.helpers import open_harness_project, goto_planet

    if not os.path.exists(SRC_MAP):
        print('🔴 找不到底图：', SRC_MAP)
        return 1
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    shutil.copyfile(SRC_MAP, TMP_MAP)
    os.makedirs(OUT_DIR, exist_ok=True)
    RT.setup_mock()
    _start_edge()
    try:
        cdp = CDP()
        # 真实底图导入（200 省 / 近万格高度）会同步占用主线程几秒 → 本工具放宽读超时
        cdp.ws.settimeout(180)
        cdp.navigate('http://localhost:5180/?planetshot=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        ok, pinfo = open_harness_project(cdp)
        print('harness project:', ok, str(pinfo)[:120])

        level = goto_planet(cdp)
        print('planet level:', level)
        wait_for(cdp, "!!document.querySelector('.planet-map-container')", desc='PlanetMap', timeout=30)
        time.sleep(1.2)
        # 关掉可能的恢复面板（z-index 1100 全屏盖住）
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find((x) => (x.textContent || '').includes('丢弃备份')); if (b) b.click(); return !!b; })()")
        time.sleep(0.5)

        cdp.eval("window.__shots = []; window.__shotAck = 0; window.__done = false;"
                 " window.__SHOT_DIAG = %s; 'ok'" % ('true' if os.environ.get('SHOT_DIAG') else 'false'))
        cdp.eval(STORY)
        deadline = time.time() + 420
        info = {}
        while time.time() < deadline:
            st = cdp.eval("JSON.stringify({shots: window.__shots || [], ack: window.__shotAck || 0,"
                          "done: !!window.__done, err: window.__storyErr || '',"
                          "info: window.__storyInfo || {}})")
            if isinstance(st, dict) and '__err__' in st:
                print('页面求值异常：', st)
                break
            st = json.loads(st)
            info = st['info']
            if st['ack'] < len(st['shots']):
                name = st['shots'][st['ack']]
                # 连拍两张，只留第二张：headless 下 rAF 可能晚一拍，
                # 第一张常常拍到"状态已改、画面还没重绘"的旧帧（内容仍可见但会误导观感检查）
                cdp.send('Page.captureScreenshot', {'format': 'png'})
                time.sleep(0.25)
                png = cdp.send('Page.captureScreenshot', {'format': 'png'})
                path = os.path.join(OUT_DIR, '%s.png' % name)
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(png['data']))
                print('shot ->', os.path.relpath(path, ROOT))
                cdp.eval('window.__shotAck = %d; "ok"' % (st['ack'] + 1))
            if st['done'] and st['ack'] >= len(st['shots']):
                if st['err']:
                    print('🔴 故事线异常：', st['err'][:1500])
                break
            time.sleep(0.15)
        else:
            print('🔴 故事线超时（未走完）')
        print('=== 读数 ===')
        print(json.dumps(info, ensure_ascii=False, indent=1))
        cdp.close()
        return 0
    finally:
        _stop()
        try:
            os.remove(TMP_MAP)
        except OSError:
            pass
        try:
            os.rmdir(PUBLIC_DIR)
        except OSError:
            pass


if __name__ == '__main__':
    sys.exit(main())
