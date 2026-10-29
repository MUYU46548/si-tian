#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 152：**造陆**（P0-2，2026-10-25）—— 参数生成大陆轮廓 + 铺底切省 + 一条 undo

背景（暮雨 2026-10-25 拍板「程序化生成收口」）：
  此前「从零开始」的第一步是让用户自己画大陆：手画多是圆饼，而且永远只有一块中央大陆。
  P0-2 要补的是**陆地轮廓本身**：陆块数 / 陆地占比 / 形状 / 崎岖度 / 大小差异 → 一组闭合环，
  再用现有 Voronoi 铺底管线切成省 —— **一条 Ctrl+Z 全部退回**。

本用例守六类判据：
  a 源码闸门（剥注释）：轮廓生成只有 `utils/landmass.js` 一份；铺底仍是 `batchSubdivide`
    （`planOnly` + `targetShapes`），**不许出现第二套 Voronoi**；面板只调 store，不直接写 terrain；
    入口按钮有可见文字；`generate-landmass` 是唯一命令类型。
  b 端到端：空底图 → 打开造陆面板 → 3 张候选（canvas 非空白）→ 设铺底块数 → 应用 →
    真的落出省份、面板关闭、状态栏有回执、渲染没崩。
  c 一条 undo：撤销后陆地回到 0（不是"退回一半"）。
  d 可复现：同参数两次预览环点逐点相同；换 seed 必不同。
  e 形状口径：长条大陆**整片陆地**的归一化包围盒比明显大于圆润（不用单块 PCA：会被近圆的
    半岛骗到）；群岛环数 > 陆块数。
  f 规模：400 省量级一次造陆 + 铺底 < 30s（会分批让帧），且撤销仍是**一条**。
  g 手绘地形（A5，2026-10-29）：图上已有手绘高度 → 同种子重生成**按图幅相对位置搬过去**
    （回执照写保留格数、逐格核对写回值）；关掉「保留手绘地形」→ 一条不留且回执写明。
"""
import base64
import json
import os
import pathlib
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state   # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
KEY = 'case152'


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    out, in_block = [], False
    for line in src.split('\n'):
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


def source_gates():
    fails = []
    lm = _code_only(_read('src/renderer/src/utils/landmass.js'))
    tp = _code_only(_read('src/renderer/src/utils/terrainParams.js'))
    pe = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    panel = _code_only(_read('src/renderer/src/components/LandmassPanel.vue'))
    smv = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))

    if 'export function generateLandmass' not in lm:
        fails.append('🔴 utils/landmass.js 缺少 generateLandmass（轮廓生成层缺失）')
    if 'Math.random' in lm:
        fails.append('🔴 landmass.js 里出现 Math.random（同参数无法复现）')
    # 轮廓层不许自己写 Voronoi：切省必须复用铺底管线
    if 'voronoi' in lm.lower() and 'makeRng' not in lm:
        fails.append('🔴 landmass.js 里出现了自己的 Voronoi（切省只能有一份实现）')
    for anchor in ('LAND_PARAM_FIELDS', 'normalizeLandParams', 'toLandmassOptions', 'describeLandParams'):
        if anchor not in tp:
            fails.append(f'🔴 terrainParams.js 缺少造陆参数锚点 `{anchor}`')

    # 铺底管线必须支持"只算不写"与"外部形状"（造陆一条 undo 的前提）
    if 'opts.planOnly' not in pe or 'planOnly: true' not in pe:
        fails.append('🔴 batchSubdivide 不支持 planOnly（造陆无法与铺底合成一条 undo）')
    if 'opts.targetShapes' not in pe or 'targetShapes: shapes' not in pe:
        fails.append('🔴 batchSubdivide 不支持 targetShapes（造陆只能先落库再切 → 两条 undo）')
    if 'function previewLandmass' not in pe or 'async function generateLandmass' not in pe:
        fails.append('🔴 store 没有暴露 previewLandmass / generateLandmass')
    if "type: 'generate-landmass'" not in pe:
        fails.append('🔴 造陆命令类型不是 generate-landmass（撤销历史里认不出来）')

    # 面板只调 store，不许自己写 terrain / 自己切分
    if 'store.previewLandmass' not in panel or 'store.generateLandmass' not in panel:
        fails.append('🔴 造陆面板没有走 store 的预览/应用入口')
    if 'setTerrain' in panel or 'batchSubdivide' in panel:
        fails.append('🔴 面板里出现 setTerrain / batchSubdivide —— 写口与切分都必须在 store')
    if 'data-testid="basemap-generate-landmass"' not in smv:
        fails.append('🔴 缺少「造陆」按钮（data-testid="basemap-generate-landmass"）')
    for tid in ('lgen-preview', 'lgen-apply', 'lgen-seed', 'lgen-cand-', 'lgen-provinceCount'):
        if tid not in panel:
            fails.append(f'🔴 面板缺少 `{tid}` 锚点')
    # A5（2026-10-29）：造陆 = 整张换掉高度图，但手绘地形必须能搬过去（同种子）或**显式丢弃**
    if 'transferHandEdits' not in pe or 'keepHandEdits !== false' not in pe:
        fails.append('🔴 造陆没有接手绘地形（A5）：store 应走 transferHandEdits + opts.keepHandEdits')
    if 'lgen-keep-hand' not in panel or 'keepHandEdits: keepHandEdits.value' not in panel:
        fails.append('🔴 造陆面板缺少「保留手绘地形」开关（A5）：lgen-keep-hand → store.keepHandEdits')
    # 图幅必须记在高度图上：不记 → 每次重跑按省份包围盒重推，大陆每次缩 ≈9.5%
    if 'genBBox' not in pe or 'recordedLandBBox' not in pe:
        fails.append('🔴 造陆没把图幅（genBBox）记到高度图 —— 重跑会越造越小')
    return fails


JS_SETUP = r""" (async () => {
  const s = __STORE__, sm = __SC__, K = __KEY__;
  // 干净的空底图（没有陆地、没有高度图）
  s.baseMaps = { ...s.baseMaps, [K]: {
    id: K, name: K, terrain: [], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  sm.baseMapKey = K;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 380));
  const toggle = document.querySelector('.more-toggle');
  if (toggle) toggle.click();
  await new Promise(r => setTimeout(r, 160));
  const btn = document.querySelector('[data-testid="basemap-generate-landmass"]');
  return JSON.stringify({ hasBtn: !!btn, text: btn ? (btn.textContent || '').trim() : null,
    terrain: (s.baseMaps[K].terrain || []).length });
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(KEY))

JS_OPEN = r""" (async () => {
  const s = __STORE__;
  const out = {};
  const btn = document.querySelector('[data-testid="basemap-generate-landmass"]');
  if (!btn) return JSON.stringify({ clicked: false });
  btn.click();
  await new Promise(r => setTimeout(r, 500));
  out.panelOpen = !!document.querySelector('[data-testid="landmass-panel"]');
  const cands = Array.from(document.querySelectorAll('[data-testid^="lgen-cand-"]'));
  out.cands = cands.length;
  out.blank = cands.map((el) => {
    const c = el.querySelector('canvas');
    if (!c) return 'no-canvas';
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n === 0;
  });
  out.hasPreview = !!document.querySelector('[data-testid="lgen-preview"]');
  out.hasApply = !!document.querySelector('[data-testid="lgen-apply"]');
  out.applyText = (() => { const b = document.querySelector('[data-testid="lgen-apply"]'); return b ? (b.textContent || '').trim() : null; })();
  // 🔴 命中检查（2026-10-25 用户实测「按钮根本点不了」）：
  //    `el.click()` 会绕过命中测试 —— 只有 elementFromPoint 才能发现"被别的元素盖住"。
  const hitBtn = document.querySelector('[data-testid="lgen-apply"]');
  if (hitBtn) {
    const r = hitBtn.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    out.hit = {
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      top: top ? (top.tagName + '.' + String(top.className || '').split(' ').slice(0, 3).join('.')) : null,
      topTestId: top && top.getAttribute ? top.getAttribute('data-testid') : null,
      covered: !(top === hitBtn || (top && hitBtn.contains(top))),
      disabled: !!hitBtn.disabled,
    };
  }
  return JSON.stringify(out);
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_APPLY = r""" (async () => {
  const s = __STORE__, sm = __SC__, K = __KEY__;
  const out = {};
  // 把铺底块数调到 60（真 UI：range 的 input 事件）
  const range = document.querySelector('[data-testid="lgen-provinceCount"]');
  if (range) { range.value = '60'; range.dispatchEvent(new Event('input', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 120));
  const t0 = performance.now();
  const apply = document.querySelector('[data-testid="lgen-apply"]');
  out.disabled = apply ? !!apply.disabled : null;
  if (apply && !apply.disabled) apply.click();
  // 铺底是异步的（会 await 让帧）：最多等 12s
  const deadline = performance.now() + 12000;
  let terrain = [];
  while (performance.now() < deadline) {
    terrain = (s.baseMaps[K] && s.baseMaps[K].terrain) || [];
    if (terrain.length >= 40) break;
    await new Promise(r => setTimeout(r, 200));
  }
  out.ms = Math.round(performance.now() - t0);
  out.count = terrain.length;
  out.allHavePoints = terrain.every((p) => (p.points || []).length >= 3 && (p.kind || 'land') !== 'sea');
  out.panelClosed = !document.querySelector('[data-testid="landmass-panel"]');
  out.status = String(sm.provinceHint || '');
  out.renderError = String(sm.renderError || '');
  out.undoLabel = (() => { try { return String(sm.undoLabel || ''); } catch (e) { return ''; } })();
  // v4.2：造陆同时写河网（同一批命令）—— 这里看它有没有真的落库
  out.rivers = ((s.baseMaps[K] || {}).rivers || []).length;
  // 地形高度图：造陆顺手落库（地图上才有山；高度笔刷/群系/自动河流也才不空转）
  const hmA = s.getHeightmapFor(K);
  out.hmCells = hmA && hmA.grid && hmA.grid.points ? hmA.grid.points.length : 0;
  // 画布是否真的画出了地形：着色档 + 画面上的不同颜色数（纯色扁平图只有几种）
  out.rasterLayer = String(sm.rasterLayer || '');
  out.canvasColors = (() => {
    const cv = document.querySelector('.scenario-map-container canvas');
    if (!cv) return 0;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  })();
  // 可选：把画面本身带回去（只在 SITIAN_SHOT_DIR 设了的时候），用于人眼看"实际长什么样"
  if (__SHOT__) {
    const cv2 = document.querySelector('.scenario-map-container canvas');
    out.shot = cv2 ? cv2.toDataURL('image/png') : '';
  }
  return JSON.stringify(out);
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(KEY))

JS_UNDO = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  const before = ((s.baseMaps[K] || {}).terrain || []).length;
  s.undo();
  await new Promise(r => setTimeout(r, 400));
  const after = ((s.baseMaps[K] || {}).terrain || []).length;
  const riversAfter = ((s.baseMaps[K] || {}).rivers || []).length;
  const hmB = s.getHeightmapFor(K);
  const hmCellsAfter = hmB && hmB.grid && hmB.grid.points ? hmB.grid.points.length : 0;
  return JSON.stringify({ before, after, riversAfter, hmCellsAfter });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_DETERMINISM = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  const hash = (r) => (r.candidates || []).map((c) => `${c.seed}:`
    + c.rings.map((x) => (x.points || []).map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';')).join('|')).join('||');
  const params = { seed: 1234, continentCount: 2, shape: 'archipelago', landRatio: 0.3, provinceCount: 60 };
  const a = s.previewLandmass(K, params);
  const b = s.previewLandmass(K, params);
  const c = s.previewLandmass(K, { ...params, seed: 4321 });
  const shapes = {};
  for (const shape of ['continent', 'elongated', 'archipelago']) {
    const r = s.previewLandmass(K, { ...params, shape, continentCount: 3, landRatio: 0.3 });
    const cand = (r.candidates || [])[0] || { rings: [], stats: {} };
    const rings = cand.rings || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) for (const p of ring.points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    // 最大陆块的主轴细长比（旋转不变；bbox 会被簇状布局骗到）
    const biggest = rings.slice().sort((a, b) => {
      const area = (pts) => { let q = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) q += pts[j].x * pts[i].y - pts[i].x * pts[j].y; return Math.abs(q) / 2; };
      return area(b.points) - area(a.points);
    })[0];
    let pca = 1;
    if (biggest) {
      const pts = biggest.points;
      const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const disc = Math.max(0, (tr * tr) / 4 - det);
      const l1 = tr / 2 + Math.sqrt(disc), l2 = Math.max(1e-9, tr / 2 - Math.sqrt(disc));
      pca = Math.sqrt(l1 / l2);
    }
    // v3 起用"面积加权陆地主轴比"（与 unit/test_landmass.js 同口径）：
    // 单块 PCA 会被近圆的半岛骗到；包围盒会被散岛撑满（三种形状都 ≈1.0）；面积加权后
    // 大块陆地主导向，散岛权重趋近于零。
    const meanOf = (pts) => pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
    let A = 0, mx = 0, my = 0;
    for (const r of rings) { const m = meanOf(r.points); A += r.area; mx += m.x * r.area; my += m.y * r.area; }
    let landPCA = 1;
    if (A > 0) {
      mx /= A; my /= A;
      let sxx = 0, syy = 0, sxy = 0;
      for (const r of rings) {
        const w = r.area / r.points.length;
        for (const p of r.points) {
          const dx = p.x - mx, dy = p.y - my;
          sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy;
        }
      }
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const disc = Math.max(0, (tr * tr) / 4 - det);
      const l1 = tr / 2 + Math.sqrt(disc), l2 = Math.max(1e-9, tr / 2 - Math.sqrt(disc));
      landPCA = Math.sqrt(l1 / l2);
    }
    shapes[shape] = { rings: rings.length, pca, landPCA, land: cand.stats.landRatio };
  }
  return JSON.stringify({ okA: !!a.ok, same: hash(a) === hash(b), differs: hash(a) !== hash(c), shapes });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_SCALE = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  const params = { seed: 99, continentCount: 4, shape: 'continent', landRatio: 0.42, provinceCount: 400 };
  const t0 = performance.now();
  const r = await s.generateLandmass(K, params, { force: true });
  const ms = Math.round(performance.now() - t0);
  const n = ((s.baseMaps[K] || {}).terrain || []).length;
  const before = n;
  s.undo();
  await new Promise(r => setTimeout(r, 300));
  const after = ((s.baseMaps[K] || {}).terrain || []).length;
  return JSON.stringify({ ok: !!(r && r.ok), created: r && r.created, ms, n, after,
    message: r ? String(r.message || '').slice(0, 120) : '' });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))


JS_KEEP_HAND = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  const out = {};
  const hmA = s.getHeightmapFor(K);
  const ptsA = hmA && hmA.grid && hmA.grid.points;
  if (!ptsA || !ptsA.length) return JSON.stringify({ stage: 'no-heightmap' });
  const xy = (p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);
  const span = (b) => (b && Number.isFinite(b.maxX)
    ? `${Math.round((b.maxX - b.minX) * 100) / 100}x${Math.round((b.maxY - b.minY) * 100) / 100}` : null);
  out.frame0 = span(hmA.genBBox);
  // 在陆格上手绘 12 格（抬高到 77），并登记 handEdits —— 与高度笔刷落库后的形状一致
  const picked = [];
  for (let k = 1; k <= 12; k++) {
    const i = Math.floor(ptsA.length * k / 14);
    if (!(hmA.h[i] >= 20)) continue;
    const [x, y] = xy(ptsA[i]);
    hmA.h[i] = 77;
    picked.push({ x, y, h: 77 });
  }
  hmA.handEdits = picked;
  out.painted = picked.length;
  const seed = Number.isFinite(hmA.genSeed) ? hmA.genSeed : null;
  out.seed = seed;
  if (!picked.length) return JSON.stringify(out);

  // ① 同种子重生成 + 保留手绘
  const r = await s.generateLandmass(K, { seed, provinceCount: 60 }, { force: true, keepHandEdits: true });
  out.okKeep = !!(r && r.ok);
  out.handKeep = r ? r.handKept : null;
  out.handBefore = r ? r.handBefore : null;
  out.msgKeep = r ? String(r.message || '').slice(-160) : '';
  const hmB = s.getHeightmapFor(K);
  out.frame1 = span(hmB && hmB.genBBox);
  const kept = (hmB && hmB.handEdits) || [];
  out.storedKeep = kept.length;
  const byKey = new Map();
  for (let i = 0; i < hmB.grid.points.length; i++) { const [x, y] = xy(hmB.grid.points[i]); byKey.set(`${x},${y}`, i); }
  out.valuesOk = kept.every((e) => {
    const i = byKey.get(`${e.x},${e.y}`);
    return i !== undefined && Math.abs(Number(hmB.h[i]) - 77) < 1e-3;
  });

  // ② 关掉开关 + 同种子 → 一条都不留（且回执写明）
  const r2 = await s.generateLandmass(K, { seed, provinceCount: 60 }, { force: true, keepHandEdits: false });
  out.okDrop = !!(r2 && r2.ok);
  out.handDrop = r2 ? r2.handKept : null;
  out.dropBefore = r2 ? r2.handBefore : null;
  out.msgDrop = r2 ? String(r2.message || '').slice(-160) : '';
  const hmC = s.getHeightmapFor(K);
  out.storedDrop = ((hmC && hmC.handEdits) || []).length;

  // 探针自己把这两条命令撤回去（否则后面「一次 undo 归零」的判据会被探针污染）
  s.undo();
  s.undo();
  await new Promise(r => setTimeout(r, 420));
  out.backTerrain = ((s.baseMaps[K] || {}).terrain || []).length;
  return JSON.stringify(out);
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))


def _ev(cdp, js, desc):
    r = eval_json(cdp, js, required=None, desc=desc)
    if isinstance(r, tuple) and r[0]:
        return r[1]
    return {'__err__': r}


def run(cdp):
    fails = source_gates()
    notes = []

    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'用例基线项目未就绪：{info}'
    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.2)

    setup = _ev(cdp, JS_SETUP, '空底图 + 找造陆按钮')
    if setup.get('__err__'):
        return False, f'造底图失败：{setup}'
    if not setup.get('hasBtn'):
        fails.append('🔴 「造陆」按钮不在 DOM 里（有底图就该一直显示）')
        return False, ' | '.join(fails)
    if not (setup.get('text') or '').strip():
        fails.append('🔴 「造陆」按钮没有可见文字')
    else:
        notes.append(f"入口：「{setup['text']}」")
    if setup.get('terrain'):
        fails.append('🔴 起始底图不该有陆地（用例前提错了）')

    opened = _ev(cdp, JS_OPEN, '打开造陆面板')
    if opened.get('__err__'):
        return False, f'面板探针失败：{opened}'
    if not opened.get('panelOpen'):
        fails.append('🔴 点了「造陆」面板没打开')
    if (opened.get('cands') or 0) < 3:
        fails.append(f"🔴 候选只有 {opened.get('cands')} 张（要求 3 张）")
    else:
        notes.append(f"候选 {opened['cands']} 张")
    if any(b is True for b in (opened.get('blank') or [])):
        fails.append('🔴 有候选缩略图是空白的（canvas 没画出来）')
    if not opened.get('hasApply'):
        fails.append('🔴 面板没有应用按钮')
    hit = opened.get('hit') or {}
    if hit.get('covered'):
        fails.append(f"🔴 「造陆」按钮被别的元素盖住，真人点不到：{hit.get('top')} (testid={hit.get('topTestId')}) rect={hit.get('rect')}")
    elif hit:
        notes.append(f"按钮命中正常（{hit.get('rect', {}).get('w')}×{hit.get('rect', {}).get('h')}，disabled={hit.get('disabled')}）")

    applied = _ev(cdp, JS_APPLY.replace('__SHOT__', 'true' if os.environ.get('SITIAN_SHOT_DIR') else 'false'), '设 60 省并应用')
    if applied.get('__err__'):
        return False, f'应用探针失败：{applied}'
    if not applied.get('count'):
        fails.append(f"🔴 造陆后没有省份（回执={applied.get('status')!r}）")
        return False, ' | '.join(fails)
    shot_dir = os.environ.get('SITIAN_SHOT_DIR')
    if shot_dir and applied.get('shot'):
        try:
            out_dir = pathlib.Path(shot_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            b64 = str(applied['shot']).split(',', 1)[-1]
            (out_dir / 'landmass-after.png').write_bytes(base64.b64decode(b64))
            notes.append(f"截图 {shot_dir}/landmass-after.png")
        except Exception as e:                       # 截图失败不许影响判据
            notes.append(f"截图失败：{e}")
    notes.append(f"铺出 {applied['count']} 省 / {applied.get('ms')} ms")
    if applied.get('count', 0) > 70:
        fails.append(f"🔴 铺底块数滑块没生效：设了 60 却铺出 {applied.get('count')} 省（用了候选里的旧参数）")
    if not (applied.get('rivers') or 0) >= 1:
        fails.append(f"造陆没有写河网（rivers={applied.get('rivers')}）—— 地形长不出谷还是河道没落库？")
    else:
        notes.append(f"河网 {applied['rivers']} 条")
    if str(applied.get('rasterLayer') or '') != 'height':
        fails.append(f"造陆后着色档不是 height（是 {applied.get('rasterLayer')!r}）—— 用户看不到地形")
    if (applied.get('canvasColors') or 0) < 12:
        fails.append(f"画布只有 {applied.get('canvasColors')} 种颜色 —— 地形没画出来（纯色扁平图）")
    if not (applied.get('hmCells') or 0) >= 5000:
        fails.append(f"造陆没有落地形高度图（hmCells={applied.get('hmCells')}）—— 地图上只会是纯色扁平图")
    else:
        notes.append(f"地形高度图 {applied['hmCells']} 格 / 着色 {applied.get('rasterLayer')} / 画面 {applied.get('canvasColors')} 色")
    if not applied.get('allHavePoints'):
        fails.append('🔴 有省份没有顶点（几何没落库）')
    if not applied.get('panelClosed'):
        fails.append('🔴 应用后面板没关（用户会以为没生效）')
    if '造陆' not in (applied.get('status') or ''):
        fails.append(f"🔴 状态栏没有造陆回执：{applied.get('status')!r}")
    if applied.get('renderError'):
        fails.append(f"🔴 渲染报错：{applied['renderError']}")

    keep = _ev(cdp, JS_KEEP_HAND, '本图手绘 → 重生成保留 / 关掉丢弃（A5）')
    if keep.get('__err__'):
        fails.append(f'手绘保留探针失败：{keep}')
    elif keep.get('stage'):
        fails.append(f"手绘保留探针前置失败：{keep.get('stage')}（造陆后应先有高度图）")
    elif not keep.get('painted'):
        fails.append('手绘保留探针没有可挑的陆格（造陆后的高度图里没有陆地？）')
    else:
        if not keep.get('okKeep'):
            fails.append(f"🔴 同种子重生成失败：{keep.get('msgKeep')}")
        elif keep.get('handKeep') != keep.get('painted'):
            fails.append(
                f"🔴 同种子 + 同图幅应当逐格全中：画了 {keep.get('painted')} 格，只搬过去 {keep.get('handKeep')} 格"
            )
        elif not keep.get('valuesOk'):
            fails.append('🔴 保留的手绘没写回新高度图（按 handEdits 逐格核对 h != 手绘值）')
        else:
            notes.append(f"手绘保留 {keep.get('handKeep')}/{keep.get('painted')} 格（逐格核对写回值）")
        if '手绘' not in (keep.get('msgKeep') or ''):
            fails.append(f"🔴 造陆回执没提手绘：{keep.get('msgKeep')!r}")
        if not keep.get('okDrop'):
            fails.append(f"🔴 关掉开关那次造陆失败：{keep.get('msgDrop')}")
        elif (keep.get('storedDrop') or 0) != 0 or (keep.get('handDrop') or 0) != 0:
            fails.append(f"🔴 关掉「保留手绘」后仍留了手绘：stored={keep.get('storedDrop')} handKept={keep.get('handDrop')}")
        elif '未保留' not in (keep.get('msgDrop') or ''):
            fails.append(f"🔴 关掉开关后回执没写明未保留：{keep.get('msgDrop')!r}")
        else:
            notes.append(f"关掉开关：{keep.get('dropBefore')} 格手绘如实丢弃（回执写明）")
        if (keep.get('backTerrain') or 0) == 0:
            fails.append('🔴 手绘保留探针没有把状态还回去（它自己那两条 undo 丢失了本图）')
        frames = [keep.get('frame0'), keep.get('frame1')]
        if all(frames) and frames[0] != frames[1]:
            fails.append(f"🔴 重跑造陆把图幅改了（{frames[0]} → {frames[1]}）—— 会越造越小 / 手绘逐格漂移")
        elif frames[0]:
            notes.append(f"图幅稳定 {frames[0]}")

    undo = _ev(cdp, JS_UNDO, '一次撤销')
    if undo.get('__err__'):
        fails.append(f'撤销探针失败：{undo}')
    elif (undo.get('hmCellsAfter') or 0) != 0:
        fails.append(f"一次撤销没把高度图退回（还剩 {undo.get('hmCellsAfter')} 格）")
    elif (undo.get('riversAfter') or 0) != 0:
        fails.append(f"一次撤销没把河网退回（还剩 {undo.get('riversAfter')} 条）—— 造陆应是同一条命令")
    elif undo.get('after') != 0:
        fails.append(f"🔴 一次撤销没退回：{undo.get('before')} → {undo.get('after')} 省（造陆+铺底应是同一条命令）")
    else:
        notes.append(f"一条 undo：{undo.get('before')} → 0")

    det = _ev(cdp, JS_DETERMINISM, '可复现 + 形状口径')
    if det.get('__err__'):
        fails.append(f'确定性探针失败：{det}')
    else:
        if not det.get('same'):
            fails.append('🔴 同参数两次预览的环点不一致（不可复现）')
        if not det.get('differs'):
            fails.append('🔴 换 seed 后候选一模一样（seed 没起作用）')
        shapes = det.get('shapes') or {}
        c = shapes.get('continent') or {}
        e = shapes.get('elongated') or {}
        a = shapes.get('archipelago') or {}
        if not (c and e and a):
            fails.append(f'🔴 形状口径探针不完整：{shapes}')
        else:
            if not (e.get('landPCA', 1) > c.get('landPCA', 0) * 1.15):
                fails.append(f"🔴 长条大陆整体不够扁长：面积加权主轴比 {e.get('landPCA')} vs 圆润 {c.get('landPCA')}")
            if not (a.get('rings', 0) > c.get('rings', 0)):
                fails.append(f"🔴 群岛环数 {a.get('rings')} 未多于圆润 {c.get('rings')}")
            notes.append(f"形状：圆润 {c.get('landPCA', 0):.2f} / 长条 {e.get('landPCA', 0):.2f} / 群岛 {a.get('rings')} 环")

    scale = _ev(cdp, JS_SCALE, '400 省规模 + 撤销')
    if scale.get('__err__'):
        fails.append(f'规模探针失败：{scale}')
    else:
        if not scale.get('ok'):
            fails.append(f"🔴 400 省造陆失败：{scale.get('message')}")
        if (scale.get('n') or 0) < 300:
            fails.append(f"🔴 400 省规模只铺出 {scale.get('n')} 省")
        if (scale.get('ms') or 99999) > 30000:
            fails.append(f"🔴 400 省造陆耗时 {scale.get('ms')}ms（> 30s）")
        if scale.get('after') != 0:
            fails.append(f"🔴 400 省那次撤销没退回：{scale.get('n')} → {scale.get('after')}")
        notes.append(f"400 省：{scale.get('n')} 省 / {scale.get('ms')} ms / 一条 undo 归零")

    summary = ' | '.join(notes)
    return (not fails), (summary if not fails else ' | '.join(fails) + ' ## ' + summary)
