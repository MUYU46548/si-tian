#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 145：逐年切片导出的**范围**（本剧本 / 全部剧本）—— 2026-10-24，终验前补

为什么这一刀必须存在（真实数据实测，不是假想）：
  415 省 / 13 段剧本的真实项目里有 **1642 个易主日期**（全是自动铺开的合成值）
  → 「全部剧本」= **1088 帧** ≫ 上限 400 ⇒ 对话框按钮直接灰掉，
  「导切片 PNG 拿去真用」在真实项目上一次都做不了。按本剧本算最大那段是 184 帧（≤400），完全可导。
  所以范围不是功能加法，是真实数据下的**可用性**。

验收点：
1. 对话框有「范围」下拉；本仓的默认值由纯函数 `pickSliceScope` 判定
   （全部超限、本段没超 → 默认本段；否则保持全部 —— 夹具 4 帧，所以默认仍是全部）；
2. 切到「本剧本」→ 帧数**立刻**变成该段帧数，列表里不再有别段的帧；
3. 点导出 → 载荷 `manifest.scope = {mode:'era', era:N, eraName}`，文件数 = 对话框帧数
   （「看到的帧数」与「导出的帧数」不许对不上）；
4. 切回「全部」→ 帧数与载荷都回到全量；
5. 源码守卫：范围过滤只在 `utils/scenarioSlices` 一处，对话框与外层都只**透传** era；
   默认范围判定只有 `pickSliceScope` 一份（模板里不许写 `count > 400 ? ...`）。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例145底图'
SC_ERA1 = KEY + '/乙时代'

SLICES = 'src/renderer/src/utils/scenarioSlices.js'
DIALOG = 'src/renderer/src/components/ScenarioSliceExport.vue'
EXPORT = 'src/renderer/src/composables/useScenarioExport.js'
MAP = 'src/renderer/src/components/ScenarioMap.vue'


def _read(rel):
    import io
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, dict):
        raise RuntimeError('eval 异常：%s' % v)
    if isinstance(v, str) and v.startswith(('{', '[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


SEED = r"""(() => {
  const s = STORE, sm = SM, KEY = KEYJ;
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const mk = (id, name, x0) => ({ id, name, kind: 'land',
    points: [{x:x0,y:100},{x:x0+140,y:100},{x:x0+140,y:300},{x:x0,y:300}] });
  s.addBaseProvince(KEY, mk('p145a', '甲省', 100));
  s.addBaseProvince(KEY, mk('p145b', '乙省', 300));
  s.addBaseProvince(KEY, mk('p145c', '丙省', 500));
  s.createScenario(KEY + '/甲时代', { ownerKey: KEY, name: '甲时代', order: 1,
    era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [{ id: 'A1', name: '甲国', color: '#c23b3b' }],
    ownership: { p145a: 'A1' } });
  s.createScenario(KEY + '/乙时代', { ownerKey: KEY, name: '乙时代', order: 2,
    era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
    polities: [{ id: 'B1', name: '乙国', color: '#4a90d9' }, { id: 'B2', name: '乙南', color: '#e6a23c' },
               { id: 'B3', name: '乙东', color: '#3ba55d' }],
    ownership: { p145a: 'B1', p145b: 'B2', p145c: 'B3' } });
  window.__FRAMES_EXPORTS__ = [];
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  return JSON.stringify({ ok: true, scenarios: Object.keys(s.scenarios || {}) });
})()""".replace('STORE', STORE).replace('SM', SM).replace('KEYJ', json.dumps(KEY))

CURSOR = r"""(() => {
  const sm = SM;
  sm.tlDate = { y: 2015, m: null, d: null };
  sm.tlEra = 1;
  sm.selectedScenario = document.querySelector('#app').__vue_app__._instance.setupState.store.scenarios[SCJ];
  sm.tlDiffMode = 'off';
  sm.showSliceExport = true;
  return JSON.stringify({ era: sm.tlEra, year: sm.tlDate.y, open: sm.showSliceExport });
})()""".replace('SM', SM).replace('SCJ', json.dumps(SC_ERA1))

STATE = r"""(() => {
  const panel = document.querySelector('[data-testid="slice-export-panel"]');
  if (!panel) return JSON.stringify({ __err__: '对话框没渲染' });
  const sel = panel.querySelector('[data-testid="slice-scope"]');
  const rows = Array.from(panel.querySelectorAll('[data-testid="slice-frame-list"] tbody tr'));
  const count = panel.querySelector('[data-testid="slice-frame-count"]');
  const run = panel.querySelector('[data-testid="slice-export-run"]');
  return JSON.stringify({
    hasScope: !!sel,
    scope: sel ? sel.value : null,
    options: sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.textContent.trim() })) : [],
    scopeText: sel ? (sel.options[sel.selectedIndex] || {}).textContent : null,
    frameCount: count ? Number(String(count.textContent).trim()) : null,
    rowCount: rows.length,
    rowEras: rows.map(tr => (tr.querySelectorAll('td')[2] || {}).textContent || '').map(s => s.trim()),
    runDisabled: run ? !!run.disabled : null,
    autoHint: !!panel.querySelector('[data-testid="slice-scope-auto"]'),
    autoText: panel.querySelector('[data-testid="slice-scope-auto"]')
      ? panel.querySelector('[data-testid="slice-scope-auto"]').textContent.replace(/\s+/g, ' ').trim() : '',
    overLimit: !!panel.querySelector('[data-testid="slice-over-limit"]'),
  });
})()"""

SET_SCOPE = r"""((v) => {
  const sel = document.querySelector('[data-testid="slice-scope"]');
  if (!sel) return 'no-select';
  sel.value = v;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})(V)"""

RUN = """(() => {
  const b = document.querySelector('[data-testid="slice-export-run"]');
  if (!b) return 'no-btn';
  if (b.disabled) return 'disabled';
  window.__FRAMES_EXPORTS__ = [];
  b.click();
  return 'ok';
})()"""

EXPORTED = r"""(() => {
  const rec = (window.__FRAMES_EXPORTS__ || [])[0] || null;
  if (!rec) return JSON.stringify({ got: false });
  const m = rec.manifest || {};
  const files = rec.files || [];
  return JSON.stringify({
    got: true,
    files: files.length,
    names: files.slice(0, 4).map(f => f.name),
    scope: m.scope || null,
    frameCount: m.frameCount,
    frameEras: (m.frames || []).map(f => f.era),
    frameYears: (m.frames || []).map(f => f.year),
    dirName: rec.dirName || '',
  });
})()"""


def sub_source_guards():
    bad = []
    sl = _code_only(_read(SLICES))
    dlg = _code_only(_read(DIALOG))
    exp = _code_only(_read(EXPORT))
    mp = _code_only(_read(MAP))

    # ① 过滤只在一处：collectSliceFrames 里按 eraList 迭代
    if 'const eraList' not in sl:
        bad.append('scenarioSlices 里没有 eraList（范围过滤的唯一实现）')
    if 'export function pickSliceScope' not in sl:
        bad.append('没有 pickSliceScope（默认范围的唯一判定）')
    if 'stats.scopeEra' not in sl:
        bad.append('stats 没记 scopeEra（导出清单里就不知道这批是哪一段）')

    # ② 对话框只透传 + 用纯函数做默认，不许自己过滤帧数组
    if 'pickSliceScope(' not in dlg:
        bad.append('对话框没用 pickSliceScope（默认范围又手写了一遍）')
    if "data-testid=\"slice-scope\"" not in dlg:
        bad.append('对话框没有范围下拉（slice-scope）')
    if re.search(r'frames\.value\.filter\([^)]*\.era\s*===', dlg):
        bad.append('对话框自己 filter 帧数组（第二份范围实现）')
    for banned in ('MAX_SLICE_FRAMES * 0.9', '1088'):
        if banned in dlg:
            bad.append(f'对话框里出现 {banned}（真实数据硬编码）')

    # ③ 导出链把 era 透传给唯一实现，并把范围写进 manifest
    if '{ era: scopeEra }' not in exp:
        bad.append('useScenarioExport 没有把 era 透传给 collectSliceFrames')
    if 'scope: {' not in exp or 'eraName' not in exp:
        bad.append('manifest 没写 scope（外部工具不知道这批覆盖哪一段）')
    if 'exportSliceFrames({ png = false, scale = 2, slicePoints, era = null }' not in exp:
        bad.append('exportSliceFrames 没有 era 参数')

    # ④ 外层接线：ScenarioMap 传 current-era 并把 era 交回去
    if ':current-era="tlEra"' not in mp:
        bad.append('ScenarioMap 没给对话框传 :current-era')
    if '{ png = false, scale = 2, era = null }' not in mp:
        bad.append('onRunSliceExport 没接 era')
    if 'exportSliceFrames({ png, scale, era,' not in mp:
        bad.append('onRunSliceExport 没把 era 传给 exportSliceFrames')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '范围过滤只在 scenarioSlices 一处；对话框与导出链只透传；manifest 带 scope'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')
    time.sleep(0.8)

    seed = _j(cdp, SEED)
    if not seed.get('ok'):
        return False, f'造数失败：{seed}'
    time.sleep(0.5)     # 等过挂载后那发 300ms 的游标重置
    cur = _j(cdp, CURSOR)
    if cur.get('__err__'):
        return False, f'钉游标失败：{cur}'
    time.sleep(0.5)

    fails = []
    st_all = _j(cdp, STATE)
    if st_all.get('__err__'):
        return False, f'对话框没渲染：{st_all}'
    if not st_all.get('hasScope'):
        fails.append('对话框没有「范围」下拉')
    if st_all.get('scope') != 'all':
        fails.append(f'夹具只有 4 帧（未超限）时默认范围应是「全部」，实际 {st_all.get("scope")!r}')
    if st_all.get('autoHint'):
        fails.append('没超限却显示了"自动切到本剧本"的提示')
    if st_all.get('frameCount') != 4:
        fails.append(f'全部范围帧数应为 4，实际 {st_all.get("frameCount")}')
    opts = [o.get('v') for o in (st_all.get('options') or [])]
    if opts != ['era', 'all']:
        fails.append(f'范围选项应为 era/all，实际 {opts}')

    # ① 切到「本剧本」
    if _j(cdp, SET_SCOPE.replace('V', json.dumps('era'))) != 'ok':
        fails.append('切不到「本剧本」')
    time.sleep(0.4)
    st_era = _j(cdp, STATE)
    if st_era.get('scope') != 'era':
        fails.append(f'范围没切过去：{st_era.get("scope")!r}')
    if st_era.get('frameCount') != 3:
        fails.append(f'本剧本（乙时代）帧数应为 3（起点 + 两次易主），实际 {st_era.get("frameCount")}')
    eras = set(x for x in (st_era.get('rowEras') or []) if x)
    if eras != {'乙时代'}:
        fails.append(f'本剧本范围下列表混进了别段的帧：{sorted(eras)}')
    if st_era.get('runDisabled'):
        fails.append('本剧本范围下导出按钮却是灰的')

    # ② 点导出 → 载荷范围与文件数
    if _j(cdp, RUN) != 'ok':
        fails.append('点不到导出按钮（或按钮灰着）')
    time.sleep(1.6)
    ex1 = _j(cdp, EXPORTED)
    if not ex1.get('got'):
        fails.append('本剧本导出没走到 exportScenarioFrames')
    else:
        sc = ex1.get('scope') or {}
        if sc.get('mode') != 'era' or sc.get('era') != 1 or sc.get('eraName') != '乙时代':
            fails.append(f'载荷里的范围不对：{sc}')
        if ex1.get('files') != 3:
            fails.append(f'导出的文件数应 = 对话框帧数 3，实际 {ex1.get("files")}')
        if set(ex1.get('frameEras') or []) != {1}:
            fails.append(f'导出帧里混进了别段：{ex1.get("frameEras")}')
        if '乙时代' not in (ex1.get('dirName') or ''):
            fails.append(f'目录名没带这一段的名字：{ex1.get("dirName")!r}')

    # ③ 切回「全部」→ 帧数与载荷都回到全量
    if _j(cdp, SET_SCOPE.replace('V', json.dumps('all'))) != 'ok':
        fails.append('切不回「全部」')
    time.sleep(0.4)
    st_back = _j(cdp, STATE)
    if st_back.get('frameCount') != 4:
        fails.append(f'切回全部后帧数应回到 4，实际 {st_back.get("frameCount")}')
    if _j(cdp, RUN) != 'ok':
        fails.append('全部范围下点不到导出按钮')
    time.sleep(1.6)
    ex2 = _j(cdp, EXPORTED)
    if not ex2.get('got'):
        fails.append('全部范围导出没走到 exportScenarioFrames')
    else:
        sc2 = ex2.get('scope') or {}
        if sc2.get('mode') != 'all' or sc2.get('era') is not None:
            fails.append(f'全部范围的载荷应是 mode=all/era=null：{sc2}')
        if ex2.get('files') != 4:
            fails.append(f'全部范围应导出 4 个文件，实际 {ex2.get("files")}')

    cdp.eval("(() => { const SM = %s; SM.showSliceExport = false; return 'ok'; })()" % SM)

    sg_ok, sg_detail = sub_source_guards()
    if not sg_ok:
        fails.append(sg_detail)

    detail = (f'默认范围={st_all.get("scope")}（{st_all.get("frameCount")} 帧）；'
              f'切本剧本 → {st_era.get("frameCount")} 帧、列表只含 {sorted(eras)}、'
              f'导出 {ex1.get("files")} 个文件 scope={ex1.get("scope")}；'
              f'切回全部 → {st_back.get("frameCount")} 帧、scope={ex2.get("scope")}；'
              f'源码守卫：{sg_detail}')
    if fails:
        return False, '；'.join(fails)[:900]
    return True, detail
