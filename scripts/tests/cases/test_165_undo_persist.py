#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 165：撤销/重做也要落盘（B2，2026-11-05）

为什么需要这条用例：
  `store/undo.js` 的 `undo()/redo()` 本身不落盘，纪律是"每个写口自己安排保存"。
  但那只覆盖了**第一次 execute**（调用方在 execute 之后补一次 save），撤销时没人补 ——
  于是"改了 → Ctrl+Z → 关掉重开又回来"这类数据安全 bug 会反复出现
  （事件表 / 标记 / 019 重导都踩过，每次都单独打补丁）。
  这一轮把落盘收口成**统一钩子**（undo/redo 成功后调度一次保存），本条用例守它。

覆盖两个不同数据域（两域都中招过，别只修一半）：
  p1 剧本元信息（`updateScenario` 改名）→ 撤销 → 内存回基线 **且**项目里出现新的 save 调用。
  p2 实体属性（`updateNode` 改名）→ 撤销 → 同样两条。
  p3 重做（redo）同样落盘（否则"撤销落盘、重做不落盘"更坏：磁盘停在撤销后的样子）。

判据为什么查"save 调用"而不是磁盘：本用例跑在 run_tests 的 mock IPC 里（没有真磁盘），
真磁盘那条由 `drill_quit_flush.py --phase p4` + 新增的真机 drill 守。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import open_test_base_map                              # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例165底图'


def _enter_scenario_mode(cdp):
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if r != 'ok':
        return False, r
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    return True, ''


SEED_JS = r"""(async () => {
  const s = __STORE__;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const KEY = __KEY__;

  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  s.loadScenarioState({ groups: [] });
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  const bm = s.baseMaps[KEY];
  bm.terrain.length = 0;
  const mk = (id, x0) => ({ id, name: '省' + id.slice(-1), kind: 'land',
    points: [{x:x0,y:150},{x:x0+140,y:150},{x:x0+140,y:290},{x:x0,y:290}] });
  s.addBaseProvince(KEY, mk('prov_a', 200), { checkOverlap: false });
  s.addBaseProvince(KEY, mk('prov_b', 400), { checkOverlap: false });

  const SC = KEY + '/撤销落盘剧本';
  s.createScenario(SC, {
    ownerKey: KEY, name: '撤销落盘剧本', order: 1,
    era: { roman: '', label: '一', startYear: '2000', endYear: '2010' },
    polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
    ownership: { prov_a: 'P1', prov_b: 'P1' },
  });
  const SM = __SM__;
  SM.baseMapKey = KEY;
  await tick(30);
  const node = (s.nodes || [])[0];
  return JSON.stringify({ ok: true, SC, KEY, nodeId: node ? node.id : '', nodeName: node ? node.name : '' });
})()"""


JS_MAIN = r"""(async () => {
  const fails = [], notes = {};
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
  const s = __STORE__;

  /** 数一下 mock 至今收到几次项目保存（op = 'save'） */
  const saves = () => (window.__projectCalls || []).filter((c) => c && c.op === 'save').length;
  /** 等「撤销后 1.5s 内磁盘必须变」——两层防抖上限（剧本 300ms + 画布 800ms） */
  const waitSaves = async (before, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (saves() > before) return true;
      await tick(60);
    }
    return false;
  };

  // ── p1 剧本元信息域：改名 → 撤销 ────────────────────────────
  const scBefore = s.getScenario(SEED.SC);
  ck('p1 前置：剧本在', !!scBefore, null);
  const name0 = scBefore ? scBefore.name : '';
  // 🔴 前置必须等"写口自己那次保存"真的落完，否则它会在 undo 之后才到，
  //    把它的保存数算到撤销头上（第一跑就是这么假绿的）。
  const b1 = saves();
  s.updateScenario(SEED.SC, { name: '被改过的名字' });
  const firstSaved = await waitSaves(b1, 2600);
  ck('p1 改名的保存已落盘（前置）', firstSaved, { before: b1, after: saves() });
  ck('p1 改名生效（内存）', s.getScenario(SEED.SC).name === '被改过的名字', s.getScenario(SEED.SC).name);
  const save0 = saves();
  s.undo();
  await tick(20);
  ck('p1 撤销后内存回到原名', s.getScenario(SEED.SC).name === name0, s.getScenario(SEED.SC).name);
  const p1Saved = await waitSaves(save0, 2600);
  ck('p1 🔴 撤销后项目里出现新的保存调用', p1Saved, { before: save0, after: saves() });
  notes.p1 = { save0, after: saves() };

  // ── p2 实体属性域：改名 → 撤销 ──────────────────────────────
  if (!SEED.nodeId) {
    ck('p2 前置：有实体', false, null);
  } else {
    const n0 = s.nodes.find((n) => n.id === SEED.nodeId);
    const nName0 = n0 ? n0.name : '';
    const b2 = saves();
    s.updateNode(SEED.nodeId, { name: '被改过的实体名' });
    await waitSaves(b2, 2600);
    const save1 = saves();
    s.undo();
    await tick(20);
    const n1 = s.nodes.find((n) => n.id === SEED.nodeId);
    ck('p2 撤销后内存回到原实体名', !!n1 && n1.name === nName0, n1 && n1.name);
    const p2Saved = await waitSaves(save1, 2600);
    ck('p2 🔴 撤销后项目里出现新的保存调用', p2Saved, { before: save1, after: saves() });
    notes.p2 = { save1, after: saves() };

    // ── p3 重做也要落盘（否则磁盘停在“撤销后”的样子）──────────
    const save2 = saves();
    s.redo();
    await tick(20);
    const n2 = s.nodes.find((n) => n.id === SEED.nodeId);
    ck('p3 重做后内存是改过的名字', !!n2 && n2.name === '被改过的实体名', n2 && n2.name);
    const p3Saved = await waitSaves(save2, 2600);
    ck('p3 🔴 重做后项目里出现新的保存调用', p3Saved, { before: save2, after: saves() });
    notes.p3 = { save2, after: saves() };
    s.undo();      // 收场：把实体名撤回去，别把改动留给后续用例
    await tick(60);
  }

  // ── p4 只读态不落盘（钩子不许绕过写闸门）───────────────────
  // 钩子里调的是 scheduleAutoSaveScenarios / scheduleAutoSave，它们各自有只读闸门；
  // 这里只做源码级确认（运行态切只读要动项目生命周期，代价远大于收益）。
  notes.hookWiring = 'undo/redo → persistAfterHistory → geodata 钩子';

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    ok, info = _enter_scenario_mode(cdp)
    if not ok:
        return False, f'进入历史剧本失败：{info}'
    ok_bm, binfo = open_test_base_map(cdp, KEY)
    if not ok_bm:
        return False, f'底图 fixture 失败：{binfo}'

    seed_src = (SEED_JS.replace('__STORE__', STORE)
                .replace('__SM__', SM)
                .replace('__KEY__', json.dumps(KEY)))
    got, seed = eval_json(cdp, seed_src, required=('ok',), desc='造剧本/实体场景')
    if not got or not seed.get('ok'):
        return False, f'造数失败：{seed}'

    main_src = ('const SEED = ' + json.dumps(seed) + ';\n'
                + JS_MAIN.replace('__STORE__', STORE).replace('__SM__', SM))
    got2, out = eval_json(cdp, main_src, required=('fails', 'notes'), desc='撤销落盘主链')
    if not got2:
        return False, f'主链失败：{out}'
    fails = out.get('fails') or []
    notes = out.get('notes') or {}
    if fails:
        return False, '；'.join(fails)[:1200] + ' | 实测：' + json.dumps(notes, ensure_ascii=False)[:600]
    return True, (
        f'剧本域撤销后 save {notes.get("p1", {}).get("save0")}→{notes.get("p1", {}).get("after")}'
        f' · 实体域 {notes.get("p2", {}).get("save1")}→{notes.get("p2", {}).get("after")}'
        f' · 重做 {notes.get("p3", {}).get("save2")}→{notes.get("p3", {}).get("after")}'
    )
