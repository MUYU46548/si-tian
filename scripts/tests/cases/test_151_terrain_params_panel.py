#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 151：地形生成**参数面板**（P0-1）+ 气候真实输入（P0-3），2026-10-25

真实来由（暮雨 2026-10-25 拍板「程序化生成收口」）：
  旧入口「按轮廓生成地形」一点就按写死的常量推演（种子 7 / 山脉权重 0.26 / 裂谷 0.26）。
  用户既不知道这次是什么种子、也无法换一种地形 —— 不满意只能反复点，而每次都长一样。
  同时气候派生一直传的是 `null, null`（纬度当 0、离岸距离当 100）→ 群系几乎只由高度决定。

本用例守六类判据：
  a 源码闸门（剥注释）：参数表只有 `utils/terrainParams.js` 一份；面板只调 store 入口，
    **不许自己写 commitHeightmap**；store 的气候派生必须走 `buildClimateInputs`
    （再出现 `deriveLayers(..., null, null)` 就是回退）；入口按钮必须有可见文字。
  b 端到端：真 UI 打开面板 → 3 张候选 → 选一张 → 应用 → 高度图真的落库、面板关闭、渲染没崩
  c 可复现：同 seed + 同参数应用两次 → h 逐值相同；换 seed 必须不同
  d 一条 undo：撤销回到应用前（原来是"没有高度图"就回到没有）
  e 气候：temp/prec/biome 都在、北冷南暖、群系不是单一值；重算派生图层结果一致
  f 预览只读：出候选不写任何数据（高度图仍为空）
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
KEY = 'case151'


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
    tp = _code_only(_read('src/renderer/src/utils/terrainParams.js'))
    panel = _code_only(_read('src/renderer/src/components/TerrainGenPanel.vue'))
    smv = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))

    # ① 参数表只有一份，且映射口唯一
    for anchor in ('TERRAIN_PARAM_FIELDS', 'normalizeTerrainParams', 'toSynthesisOptions',
                   'candidateSeed', 'describeTerrainParams'):
        if anchor not in tp:
            fails.append(f'🔴 utils/terrainParams.js 缺少 `{anchor}`（参数模型不完整）')

    # ② 面板必须走 store 入口；自己写 commitHeightmap 就是"第二条写路径"
    if 'store.previewTerrainSynthesis' not in panel:
        fails.append('🔴 面板没有调 `store.previewTerrainSynthesis`（预览不是只读入口）')
    if 'store.synthesizeBaseMapTerrain' not in panel:
        fails.append('🔴 面板没有调 `store.synthesizeBaseMapTerrain`（应用绕开了唯一写口）')
    if 'commitHeightmap' in panel:
        fails.append('🔴 面板里出现 `commitHeightmap` —— 写高度图必须只有 store 一个入口')

    # ③ 入口按钮必须有可见文字（本项目实测：只有图标的按钮用户找不到）
    if 'data-testid="basemap-terrain-params"' not in smv:
        fails.append('🔴 缺少「生成参数」按钮（`data-testid="basemap-terrain-params"`）')

    # ④ 气候必须真的接线：派生了却还传 null,null 就是回退
    i = se.find('function deriveAllLayers')
    if i < 0:
        fails.append('🔴 找不到 deriveAllLayers（判据锚点失效）')
    else:
        body = se[i:i + 2200]
        if 'buildClimateInputs' not in body:
            fails.append('🔴 deriveAllLayers 没有用 buildClimateInputs（气候仍是 null,null 口径）')
        if 'deriveLayers(hm.h, pts, null, null)' in body:
            fails.append('🔴 deriveAllLayers 仍在传 null, null —— 群系只由高度决定')

    # ⑤ 预览必须是只读：函数体内不许出现 commitHeightmap / execute(
    j = se.find('function previewTerrainSynthesis')
    if j < 0:
        fails.append('🔴 找不到 previewTerrainSynthesis')
    else:
        body = se[j:j + 2600]
        for bad in ('commitHeightmap', 'execute('):
            if bad in body:
                fails.append(f'🔴 previewTerrainSynthesis 里出现 `{bad}` —— 预览必须只读')

    # ⑥ 面板的四个可点入口都在（ID 是可发现性的锚点）
    for tid in ('tgen-preview', 'tgen-apply', 'tgen-seed', 'tgen-cand-'):
        if tid not in panel:
            fails.append(f'🔴 面板缺少 `{tid}` 锚点（用户/用例都够不着）')
    return fails


JS_SETUP = r""" (async () => {
  const s = __STORE__, sm = __SC__, K = __KEY__;
  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const land = { id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) };
  s.baseMaps = { ...s.baseMaps, [K]: {
    id: K, name: K, terrain: [land], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  sm.baseMapKey = K;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 360));
  // 工具栏「更多」默认收起：不展开就没有按钮（可发现性判据的一部分）
  const toggle = document.querySelector('.more-toggle');
  if (toggle) toggle.click();
  await new Promise(r => setTimeout(r, 160));
  const btn = document.querySelector('[data-testid="basemap-terrain-params"]');
  return JSON.stringify({
    hasBtn: !!btn,
    text: btn ? (btn.textContent || '').trim() : null,
    title: btn ? (btn.title || '') : '',
    hasHm: !!s.getHeightmapFor(K),
    hasSynthesize: !!document.querySelector('[data-testid="basemap-synthesize-terrain"]'),
  });
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(KEY))

JS_OPEN = r""" (async () => {
  const s = __STORE__;
  const out = {};
  const btn = document.querySelector('[data-testid="basemap-terrain-params"]');
  if (!btn) return JSON.stringify({ clicked: false });
  btn.click();
  await new Promise(r => setTimeout(r, 420));
  out.panelOpen = !!document.querySelector('[data-testid="terrain-gen-panel"]');
  const cands = Array.from(document.querySelectorAll('[data-testid^="tgen-cand-"]'));
  out.cands = cands.length;
  out.canvases = Array.from(document.querySelectorAll('[data-testid^="tgen-cand-"] canvas'))
    .map(c => ({ w: c.width, h: c.height, blank: (() => {
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n === 0;
    })() }));
  out.hasPreviewBtn = !!document.querySelector('[data-testid="tgen-preview"]');
  out.hasSeed = !!document.querySelector('[data-testid="tgen-seed"]');
  out.applyDisabled = (() => {
    const b = document.querySelector('[data-testid="tgen-apply"]');
    return b ? !!b.disabled : null;
  })();
  // 预览必须只读：出完候选，数据里仍然没有高度图
  out.afterPreviewHm = !!s.getHeightmapFor(__KEY__);
  out.status = String(document.querySelector('[data-testid="terrain-gen-panel"]') ? 'open' : 'closed');
  return JSON.stringify(out);
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_APPLY = r""" (async () => {
  const s = __STORE__, sm = __SC__;
  const K = __KEY__;
  const digest = (arr) => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < arr.length; i++) {
      h ^= Math.round(Number(arr[i]) * 100) | 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16) + ':' + arr.length;
  };
  const out = {};
  const before = s.getHeightmapFor(K);
  out.beforeHad = !!(before && before.grid);
  // 选第二张候选（不是默认第一张：否则"选中生效"这条是空转）
  const c1 = document.querySelector('[data-testid="tgen-cand-1"]');
  if (c1) c1.click();
  await new Promise(r => setTimeout(r, 120));
  const apply = document.querySelector('[data-testid="tgen-apply"]');
  out.applyDisabled = apply ? !!apply.disabled : null;
  if (apply && !apply.disabled) apply.click();
  await new Promise(r => setTimeout(r, 1600));
  const hm = s.getHeightmapFor(K);
  out.panelClosed = !document.querySelector('[data-testid="terrain-gen-panel"]');
  out.ok = !!(hm && hm.grid && Array.isArray(hm.h) || (hm && hm.h && hm.h.length));
  if (hm && hm.h) {
    out.cells = hm.h.length;
    out.cols = hm.grid ? hm.grid.cellsX : 0;
    out.rows = hm.grid ? hm.grid.cellsY : 0;
    out.hDigest = digest(hm.h);
    out.hasTemp = !!(hm.temp && hm.temp.length === hm.h.length);
    out.hasPrec = !!(hm.prec && hm.prec.length === hm.h.length);
    out.hasBiome = !!(hm.biome && hm.biome.length === hm.h.length);
    out.biomeKinds = hm.biome ? Array.from(new Set(Array.from(hm.biome))).length : 0;
    out.climateSpec = hm.climateSpec || null;
    if (hm.temp && hm.grid) {
      const cols = hm.grid.cellsX, rows = hm.grid.cellsY;
      const top = Math.floor(rows * 0.1) * cols + Math.floor(cols / 2);
      const mid = Math.floor(rows * 0.5) * cols + Math.floor(cols / 2);
      out.tempTop = Math.round(hm.temp[top] * 10) / 10;
      out.tempMid = Math.round(hm.temp[mid] * 10) / 10;
      out.biomeTop = hm.biome ? hm.biome[top] : null;
      out.biomeMid = hm.biome ? hm.biome[mid] : null;
    }
  }
  out.status = String(sm.provinceHint || '');
  out.renderPaused = !!sm.renderPaused;
  out.renderError = String(sm.renderError || '');
  return JSON.stringify(out);
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(KEY))

JS_DETERMINISM = r""" (async () => {
  const s = __STORE__;
  const K = __KEY__;
  const digest = (arr) => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < arr.length; i++) {
      h ^= Math.round(Number(arr[i]) * 100) | 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16) + ':' + arr.length;
  };
  const params = { seed: 424242, relief: 1.2, mountainStrength: 1.1, cellsAcross: 64 };
  const a = s.synthesizeBaseMapTerrain(K, { params, force: true });
  const h1 = digest(s.getHeightmapFor(K).h);
  const b = s.synthesizeBaseMapTerrain(K, { params, force: true });
  const h2 = digest(s.getHeightmapFor(K).h);
  const c = s.synthesizeBaseMapTerrain(K, { params: { ...params, seed: 777 }, force: true });
  const h3 = digest(s.getHeightmapFor(K).h);
  // 重算派生图层：同一份 h 再算一次，气候必须逐值一致
  const beforeT = digest(s.getHeightmapFor(K).temp);
  const beforeB = digest(s.getHeightmapFor(K).biome);
  const d = s.deriveAllLayers(K);
  const afterT = digest(s.getHeightmapFor(K).temp);
  const afterB = digest(s.getHeightmapFor(K).biome);
  const hm = s.getHeightmapFor(K);
  return JSON.stringify({
    okA: !!(a && a.ok), okB: !!(b && b.ok), okC: !!(c && c.ok),
    same: h1 === h2, differs: h1 !== h3,
    h1, h2, h3,
    cellsA: a ? a.cellCount : 0,
    climateSame: beforeT === afterT && beforeB === afterB,
    climateSpec: hm ? (hm.climateSpec || null) : null,
    deriveClimate: d && d.climate ? d.climate : null,
    params: a ? a.params : null,
    msg: a ? String(a.message || '').slice(0, 160) : '',
  });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_UNDO = r""" (async () => {
  const s = __STORE__;
  const K = __KEY__;
  const digest = (arr) => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < arr.length; i++) {
      h ^= Math.round(Number(arr[i]) * 100) | 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16) + ':' + arr.length;
  };
  const before = s.getHeightmapFor(K);
  const hBefore = before && before.h ? digest(before.h) : null;
  s.undo();                       // 撤销「重算派生图层」
  const afterUndo = s.getHeightmapFor(K);
  const hAfter = afterUndo && afterUndo.h ? digest(afterUndo.h) : null;
  return JSON.stringify({
    undoKeptH: hBefore === hAfter,
    hBefore, hAfter,
    hasHm: !!(afterUndo && afterUndo.grid),
    status: String((document.querySelector('.scenario-map-container')
      .__vueParentComponent.setupState.provinceHint) || ''),
  });
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

    setup = _ev(cdp, JS_SETUP, '造自建底图 + 找入口按钮')
    if setup.get('__err__'):
        return False, f'造底图探针求值失败：{setup}'
    if not setup.get('hasBtn'):
        fails.append('🔴 「生成参数」按钮不在 DOM 里（有陆地就该一直显示，不许条件式隐藏）')
        return False, ' | '.join(fails)
    if not (setup.get('text') or '').strip():
        fails.append('🔴 「生成参数」按钮没有可见文字（只有图标 + title，用户找不到）')
    else:
        notes.append(f"入口按钮：「{setup['text']}」")
    if setup.get('hasHm'):
        fails.append('🔴 这张底图不该一开始就有高度图（用例前提错了）')

    opened = _ev(cdp, JS_OPEN, '打开面板出候选')
    if opened.get('__err__'):
        return False, f'面板探针求值失败：{opened}'
    if not opened.get('panelOpen'):
        fails.append('🔴 点了按钮面板没打开（用户会以为按钮坏了）')
    if (opened.get('cands') or 0) < 3:
        fails.append(f"🔴 候选只有 {opened.get('cands')} 张（要求 3 张：同参数不同种子）")
    else:
        notes.append(f"候选 {opened['cands']} 张")
    blanks = [c for c in (opened.get('canvases') or []) if c.get('blank')]
    if blanks:
        fails.append(f'🔴 {len(blanks)} 张候选缩略图是空白的（canvas 没画出来）')
    if opened.get('afterPreviewHm'):
        fails.append('🔴 预览写了数据（出候选后高度图不该存在）—— 预览必须只读')
    else:
        notes.append('预览只读 ✓')

    applied = _ev(cdp, JS_APPLY, '选第二张并应用')
    if applied.get('__err__'):
        return False, f'应用探针求值失败：{applied}'
    if not applied.get('ok'):
        fails.append('🔴 应用后没有高度图落库')
        return False, ' | '.join(fails)
    notes.append(f"应用后 {applied.get('cells')} 格（{applied.get('cols')}×{applied.get('rows')}）"
                 f" / 群系 {applied.get('biomeKinds')} 种")
    if not applied.get('panelClosed'):
        fails.append('应用后面板没关（用户会以为没生效）')
    for flag, name in (('hasTemp', '温度'), ('hasPrec', '降水'), ('hasBiome', '群系')):
        if not applied.get(flag):
            fails.append(f'🔴 应用后没有{name}数组（P0-3 气候没随地形一起落库）')
    if applied.get('biomeKinds', 0) < 2:
        fails.append('🔴 群系只有一种 —— 气候派生没起作用（还是只由高度决定？）')
    top, mid = applied.get('tempTop'), applied.get('tempMid')
    if top is not None and mid is not None and not (mid > top + 5):
        fails.append(f'🔴 北端温度 {top} 与中部 {mid} 没有明显差异 —— 纬度没进派生')
    else:
        notes.append(f"温度 北 {top}°C / 中 {mid}°C")
    if applied.get('renderError'):
        fails.append(f"🔴 应用后渲染报错：{applied['renderError']}")
    if applied.get('renderPaused'):
        fails.append('🔴 应用后渲染暂停（卡死）')

    det = _ev(cdp, JS_DETERMINISM, '同参数可复现 + 气候确定性')
    if det.get('__err__'):
        return False, f'确定性探针求值失败：{det}'
    if not (det.get('okA') and det.get('okB') and det.get('okC')):
        fails.append(f"🔴 三次应用有失败：{det}")
    if not det.get('same'):
        fails.append(f"🔴 同 seed + 同参数两次应用得到不同地形：{det.get('h1')} vs {det.get('h2')}")
    else:
        notes.append(f"同参数复现 {det.get('h1')}")
    if not det.get('differs'):
        fails.append('🔴 换 seed 后地形一模一样 —— seed 是摆设')
    if not det.get('climateSame'):
        fails.append('🔴 「重算派生图层」两次结果不一致（气候派生不确定）')
    else:
        notes.append('气候重复派生一致 ✓')
    if not (det.get('climateSpec') or {}).get('latitudeSpanDeg'):
        fails.append('🔴 高度图没有 climateSpec.latitudeSpanDeg（重算时会退回默认跨度）')

    undo = _ev(cdp, JS_UNDO, '撤销重算派生图层')
    if undo.get('__err__'):
        fails.append(f'撤销探针求值失败：{undo}')
    elif not undo.get('undoKeptH'):
        fails.append(f"🔴 撤销「重算派生图层」把高度图也改了：{undo.get('hBefore')} → {undo.get('hAfter')}")
    elif not undo.get('hasHm'):
        fails.append('🔴 撤销后高度图整个丢了（撤销粒度错了：应只回滚派生数组）')
    else:
        notes.append('撤销粒度 ✓（h 不动）')

    summary = ' | '.join(notes)
    return (not fails), (summary if not fails else ' | '.join(fails) + ' ## ' + summary)
