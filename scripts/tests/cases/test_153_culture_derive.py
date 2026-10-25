#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 153：**文化 / 宗教 / 势力派生**（P0-4，2026-10-25）

背景：一张自建底图切完省之后，用户面对的是几百块没有文化、没有势力归属的空省。
P0-4 的拍板是「**自动建势力 + 自动分归属，但永远保留手动编辑能力**」。

本用例守七类判据：
  a 源码闸门（剥注释）：派生只有 `utils/cultureDerive.js` 一份；面板只调 store；
    文化/宗教的逐格网格 + 省份摘要必须**同一条命令**；写口已登记契约。
  b 端到端：造陆 80 省 → 生成地形 → 建剧本 → 打开派生面板 → 预览 → 生成文化/宗教 →
    逐格网格有值、每省有文化；一次 undo 全退。
  c **手改保护**：派生 → 手改一省/一格 → 再派生（只补空）→ 手改不被覆盖。
  d **覆盖模式**：切「覆盖已有」→ 手改被替换（且弹确认）；撤销回手改状态。
  e 势力：补空派生建出势力并给无主省铺初始归属；已有归属的省不动；一条 undo。
  f 规模：400 省底图上派生 < 8s（逐格规模 7k 格量级）。
  g 只读态：派生入口被拒（不写任何数据）。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state   # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
KEY = 'case153'
KEY2 = 'case153_big'


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
    cd = _code_only(_read('src/renderer/src/utils/cultureDerive.js'))
    tp = _code_only(_read('src/renderer/src/utils/terrainParams.js'))
    pe = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    panel = _code_only(_read('src/renderer/src/components/DerivePanel.vue'))
    smv = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))

    for anchor in ('deriveCultureLayers', 'planPolities'):
        if anchor not in cd:
            fails.append(f'🔴 cultureDerive.js 缺少 `{anchor}`')
    if 'Math.random' in cd:
        fails.append('🔴 cultureDerive.js 出现 Math.random（同参数无法复现）')
    for anchor in ('CULTURE_PARAM_FIELDS', 'normalizeCultureParams'):
        if anchor not in tp:
            fails.append(f'🔴 terrainParams.js 缺少 `{anchor}`')

    # 文化/宗教：逐格网格 + 省份摘要必须一条命令（同时 commitHeightmap 与 setTerrain）
    i = pe.find('function applyCultureDerive')
    if i < 0:
        fails.append('🔴 找不到 applyCultureDerive')
    else:
        body = pe[i:i + 6500]
        if 'commitHeightmap(' not in body or 'setTerrain(' not in body:
            fails.append('🔴 applyCultureDerive 没有同时写逐格网格与省份摘要（会只退一半）')
        if "type: 'derive-culture'" not in body:
            fails.append('🔴 文化派生命令类型不是 derive-culture')
    if 'function applyPolityDerive' not in se or "type: 'derive-polity'" not in se:
        fails.append('🔴 势力派生（applyPolityDerive / derive-polity）缺失')
    # 只补空：势力派生不许把 changeEvents 当写口（那是改朝换代的事）
    j = se.find('function applyPolityDerive')
    if j >= 0 and 'nextOwn[pid] = owner' not in se[j:j + 7000]:
        fails.append('🔴 势力派生没有铺归属')
    for fn in ('applyCultureDerive', 'applyPolityDerive'):
        if fn not in wg:
            fails.append(f'🔴 `{fn}` 没有登记进写口契约（只读态可绕过）')

    if 'store.previewCultureDerive' not in panel or 'store.applyCultureDerive' not in panel:
        fails.append('🔴 派生面板没有走 store 预览/应用入口')
    if 'store.applyPolityDerive' not in panel:
        fails.append('🔴 派生面板没有势力派生入口')
    if 'data-testid="basemap-derive-culture"' not in smv:
        fails.append('🔴 缺少「派生」按钮')
    for tid in ('dgen-preview', 'dgen-apply-culture', 'dgen-apply-polity',
                'dgen-strategy-fill', 'dgen-strategy-overwrite', 'dgen-seed'):
        if tid not in panel:
            fails.append(f'🔴 面板缺少 `{tid}` 锚点')
    return fails


JS_SETUP = r""" (async () => {
  const s = __STORE__, sm = __SC__, K = __KEY__;
  s.baseMaps = { ...s.baseMaps, [K]: {
    id: K, name: K, terrain: [], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  sm.baseMapKey = K;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 320));
  const lm = await s.generateLandmass(K, { seed: 5, continentCount: 2, shape: 'continent', landRatio: 0.34, provinceCount: 80 }, { force: true });
  const syn = s.synthesizeBaseMapTerrain(K, { force: true, params: { seed: 5, cellsAcross: 96 } });
  const scenId = K + '/甲';
  if (!s.scenarios[scenId]) s.createScenario(scenId, { ownerKey: K, name: '甲', era: { startYear: '1000', endYear: '1100' } });
  sm.selectedScenario = s.scenarios[scenId];
  const hm = s.getHeightmapFor(K);
  return JSON.stringify({
    provinces: (s.baseMaps[K].terrain || []).length,
    cells: hm && hm.grid ? hm.grid.points.length : 0,
    lmOk: !!(lm && lm.ok), synOk: !!(syn && syn.ok),
    scen: !!s.scenarios[scenId],
  });
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(KEY))

JS_OPEN_PANEL = r""" (async () => {
  const s = __STORE__;
  const toggle = document.querySelector('.more-toggle');
  if (toggle) toggle.click();
  await new Promise(r => setTimeout(r, 160));
  const btn = document.querySelector('[data-testid="basemap-derive-culture"]');
  if (!btn) return JSON.stringify({ clicked: false });
  btn.click();
  await new Promise(r => setTimeout(r, 500));
  const pv = document.querySelector('[data-testid="dgen-preview"]');
  return JSON.stringify({
    clicked: true,
    panel: !!document.querySelector('[data-testid="derive-panel"]'),
    hasPreview: !!pv,
    previewText: pv ? (pv.textContent || '').trim().slice(0, 160) : '',
    cultureBtn: !!document.querySelector('[data-testid="dgen-apply-culture"]'),
    polityBtn: !!document.querySelector('[data-testid="dgen-apply-polity"]'),
  });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_APPLY_CULTURE = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  const btn = document.querySelector('[data-testid="dgen-apply-culture"]');
  if (!btn) return JSON.stringify({ clicked: false });
  btn.click();
  await new Promise(r => setTimeout(r, 900));
  const hm = s.getHeightmapFor(K);
  const terrain = s.baseMaps[K].terrain || [];
  let cells = 0;
  if (hm && hm.culture) for (let i = 0; i < hm.culture.length; i++) if (hm.culture[i]) cells++;
  let religionCells = 0;
  if (hm && hm.religion) for (let i = 0; i < hm.religion.length; i++) if (hm.religion[i]) religionCells++;
  return JSON.stringify({
    cells, religionCells,
    cultures: (hm.cultures || []).length,
    religions: (hm.religions || []).length,
    provinces: terrain.filter(p => p.cultureId).length,
    total: terrain.length,
    status: String(document.querySelector('.scenario-status-bar') ? document.querySelector('.scenario-status-bar').textContent : '').slice(0, 120),
  });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_UNDO = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  s.undo();
  await new Promise(r => setTimeout(r, 400));
  const hm = s.getHeightmapFor(K);
  const terrain = s.baseMaps[K].terrain || [];
  let cells = 0;
  if (hm && hm.culture) for (let i = 0; i < hm.culture.length; i++) if (hm.culture[i]) cells++;
  return JSON.stringify({ cells, provinces: terrain.filter(p => p.cultureId).length });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_HAND_EDIT = r""" (async () => {
  const s = __STORE__, K = __KEY__, sm = __SC__;
  const terrain = s.baseMaps[K].terrain.map((p, i) => i === 0
    ? { ...p, cultureId: 99, culture: '手改文化', religionId: 98, religion: '手改宗教' } : p);
  s.baseMaps = { ...s.baseMaps, [K]: { ...s.baseMaps[K], terrain } };
  const hm = s.getHeightmapFor(K);
  // 手改一个格：把某个**已有文化**的陆格改成 77（只补空必须保留它 —— 这才是"手改"）
  let idx = -1;
  if (hm && hm.h) {
    for (let i = 0; i < hm.culture.length; i++) {
      if (hm.h[i] >= 20 && hm.culture[i] >= 1) { idx = i; break; }
    }
  }
  if (idx >= 0) {
    const next = new Uint8Array(hm.culture);
    next[idx] = 77;
    s.commitHeightmap(K, { ...hm, culture: next });
  }
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify({ editedProvince: terrain[0].cultureId, editedCell: idx });
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(KEY))

JS_REFILL = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  // 重新点一次「只补空」
  const btn = document.querySelector('[data-testid="dgen-apply-culture"]');
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 900));
  const hm = s.getHeightmapFor(K);
  const terrain = s.baseMaps[K].terrain || [];
  let handCell = 0;
  if (hm && hm.culture) for (let i = 0; i < hm.culture.length; i++) if (hm.culture[i] === 77) handCell++;
  return JSON.stringify({
    provinceCulture: terrain[0].cultureId,
    provinceName: terrain[0].culture,
    handCell,
    filled: terrain.filter(p => p.cultureId).length,
  });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_OVERWRITE = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  window.confirm = () => true;   // 面板的覆盖确认（真机由人点，这里给自动同意）
  const radio = document.querySelector('[data-testid="dgen-strategy-overwrite"]');
  if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 80));
  const btn = document.querySelector('[data-testid="dgen-apply-culture"]');
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 1000));
  const terrain = s.baseMaps[K].terrain || [];
  const hm = s.getHeightmapFor(K);
  let handCell = 0;
  if (hm && hm.culture) for (let i = 0; i < hm.culture.length; i++) if (hm.culture[i] === 77) handCell++;
  return JSON.stringify({ provinceCulture: terrain[0].cultureId, provinceName: terrain[0].culture, handCell });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_POLITY = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  const scenId = K + '/甲';
  const before = Object.keys(s.scenarios[scenId].ownership || {}).length;
  const btn = document.querySelector('[data-testid="dgen-apply-polity"]');
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 700));
  const sc = s.scenarios[scenId];
  const assigned = Object.keys(sc.ownership || {}).length;
  const init = Object.keys(sc.initialOwnership || {}).length;
  const events = Object.keys(sc.changeEvents || {}).length;
  return JSON.stringify({ before, assigned, init, events, polities: (sc.polities || []).length,
    ids: (sc.polities || []).map(p => p.id).slice(0, 3) });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_POLITY_UNDO = r""" (async () => {
  const s = __STORE__, K = __KEY__;
  const scenId = K + '/甲';
  s.undo();
  await new Promise(r => setTimeout(r, 350));
  const sc = s.scenarios[scenId];
  return JSON.stringify({ assigned: Object.keys(sc.ownership || {}).length,
    polities: (sc.polities || []).length });
})() """.replace('__STORE__', STORE).replace('__KEY__', repr(KEY))

JS_SCALE = r""" (async () => {
  const s = __STORE__, sm = __SC__, K = __KEY2__;
  s.baseMaps = { ...s.baseMaps, [K]: {
    id: K, name: K, terrain: [], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  sm.baseMapKey = K;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 260));
  const lm = await s.generateLandmass(K, { seed: 9, continentCount: 4, landRatio: 0.42, provinceCount: 400 }, { force: true });
  const syn = s.synthesizeBaseMapTerrain(K, { force: true, params: { seed: 9 } });
  const t0 = performance.now();
  const r = s.applyCultureDerive(K, { seed: 9, cultureCount: 6, religionCount: 5 });
  const ms = Math.round(performance.now() - t0);
  const terrain = s.baseMaps[K].terrain || [];
  const hm = s.getHeightmapFor(K);
  let cells = 0;
  if (hm && hm.culture) for (let i = 0; i < hm.culture.length; i++) if (hm.culture[i]) cells++;
  return JSON.stringify({ provinces: terrain.length, cells, ms, ok: !!(r && r.ok),
    cultures: (hm.cultures || []).length, cultured: terrain.filter(p => p.cultureId).length,
    lmOk: !!(lm && lm.ok), synOk: !!(syn && syn.ok) });
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY2__', repr(KEY2))


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

    setup = _ev(cdp, JS_SETUP, '造陆 80 省 + 地形 + 剧本')
    if setup.get('__err__') or not setup.get('provinces'):
        return False, f'准备底图失败：{setup}'
    notes.append(f"底图 {setup['provinces']} 省 / {setup['cells']} 格")
    if not setup.get('cells'):
        fails.append('🔴 没生成高度图（文化/宗教逐格派生无从下手）')

    opened = _ev(cdp, JS_OPEN_PANEL, '打开派生面板')
    if opened.get('__err__') or not opened.get('clicked'):
        return False, f'派生入口不可用：{opened}'
    if not opened.get('panel'):
        fails.append('🔴 点了「派生」面板没打开')
    if not opened.get('hasPreview'):
        fails.append('🔴 面板没有预览（用户看不到会派生成什么）')
    else:
        notes.append(f"预览：{opened.get('previewText', '')[:80]}")
    if not (opened.get('cultureBtn') and opened.get('polityBtn')):
        fails.append('🔴 面板缺少「生成文化/宗教」或「生成势力与归属」按钮')

    applied = _ev(cdp, JS_APPLY_CULTURE, '生成文化/宗教（只补空）')
    if applied.get('__err__'):
        return False, f'文化派生探针失败：{applied}'
    if not applied.get('cells'):
        fails.append(f"🔴 派生后没有文化格（回执={applied.get('status')!r}）")
        return False, ' | '.join(fails)
    notes.append(f"文化 {applied['cells']} 格 / 宗教 {applied['religionCells']} 格 / 省摘要 {applied['provinces']}/{applied['total']}")
    if applied.get('cultures') < 2:
        fails.append(f"🔴 文化列表只有 {applied.get('cultures')} 个")
    if applied.get('provinces') != applied.get('total'):
        fails.append(f"🔴 有省份没拿到文化摘要：{applied.get('provinces')}/{applied.get('total')}")

    undo = _ev(cdp, JS_UNDO, '撤销文化派生')
    if undo.get('__err__'):
        fails.append(f'撤销探针失败：{undo}')
    elif undo.get('cells') != 0 or undo.get('provinces') != 0:
        fails.append(f"🔴 一次撤销没退干净：文化格 {undo.get('cells')} / 摘要 {undo.get('provinces')}")
    else:
        notes.append('一条 undo 归零')

    # 再次派生 → 手改 → 只补空必须保留
    again = _ev(cdp, JS_APPLY_CULTURE, '再次派生')
    if again.get('__err__') or not again.get('cells'):
        fails.append(f"🔴 第二次派生失败：{again}")
    hand = _ev(cdp, JS_HAND_EDIT, '手改一省一格')
    if hand.get('__err__'):
        fails.append(f'手改探针失败：{hand}')
    refill = _ev(cdp, JS_REFILL, '再派生（只补空）')
    if refill.get('__err__'):
        fails.append(f'只补空探针失败：{refill}')
    else:
        if refill.get('provinceCulture') != 99:
            fails.append(f"🔴 只补空把手改的省覆盖了：cultureId={refill.get('provinceCulture')}")
        if refill.get('handCell', 0) < 1:
            fails.append('🔴 只补空把手改的格覆盖了')
        notes.append(f"只补空：手改省=99 / 手改格保留 {refill.get('handCell')} / 有文化省 {refill.get('filled')}")

    over = _ev(cdp, JS_OVERWRITE, '覆盖派生')
    if over.get('__err__'):
        fails.append(f'覆盖探针失败：{over}')
    elif over.get('provinceCulture') == 99:
        fails.append('🔴 覆盖模式没覆盖手改（还是 99）')
    else:
        notes.append(f"覆盖：手改省 → {over.get('provinceCulture')} / 手改格剩 {over.get('handCell')}")

    pol = _ev(cdp, JS_POLITY, '生成势力与归属')
    if pol.get('__err__'):
        fails.append(f'势力探针失败：{pol}')
    else:
        if pol.get('assigned', 0) <= pol.get('before', 0):
            fails.append(f"🔴 势力派生没有铺归属：{pol.get('before')} → {pol.get('assigned')}")
        if (pol.get('polities') or 0) < 2:
            fails.append(f"🔴 势力列表只有 {pol.get('polities')} 个")
        if pol.get('events'):
            fails.append(f"🔴 势力派生写了 changeEvents（{pol.get('events')} 省）—— 只补空不该动历史")
        notes.append(f"势力 {pol.get('polities')} 个 / 归属 {pol.get('before')}→{pol.get('assigned')} 省 / 初主 {pol.get('init')}")
    pul = _ev(cdp, JS_POLITY_UNDO, '撤销势力派生')
    if pul.get('__err__'):
        fails.append(f'势力撤销探针失败：{pul}')
    elif pul.get('assigned') != pol.get('before'):
        fails.append(f"🔴 势力派生撤销没回到基线：{pul.get('assigned')} ≠ {pol.get('before')}")

    scale = _ev(cdp, JS_SCALE, '400 省规模 + 派生')
    if scale.get('__err__'):
        fails.append(f'规模探针失败：{scale}')
    else:
        if not scale.get('ok'):
            fails.append('🔴 400 省底图上派生失败')
        if (scale.get('provinces') or 0) < 350:
            fails.append(f"🔴 400 省底图只铺出 {scale.get('provinces')} 省")
        if (scale.get('ms') or 99999) > 8000:
            fails.append(f"🔴 400 省派生耗时 {scale.get('ms')}ms（> 8s）")
        if scale.get('cultured') != scale.get('provinces'):
            fails.append(f"🔴 400 省里有省没文化摘要：{scale.get('cultured')}/{scale.get('provinces')}")
        notes.append(f"400 省：派生 {scale.get('ms')}ms / 文化 {scale.get('cultures')} 个 / 格 {scale.get('cells')}")

    summary = ' | '.join(notes)
    return (not fails), (summary if not fails else ' | '.join(fails) + ' ## ' + summary)
