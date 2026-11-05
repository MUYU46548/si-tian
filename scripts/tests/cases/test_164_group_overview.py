#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 164：跨剧本集“只读总览”（A3，2026-11-05）

为什么需要这条用例：
  剧本集 = 一条独立时间线，左栏/时间轴/播放/切片只取当前组（这是对的）——代价是**看不见别的
  时间线**。总览要把"还有一条乙线"摆出来，同时**别组的剧本只能看不能动**：
  一旦别组剧本被当成"可以点的"，用户就会在不知情时把当前编辑目标换掉（改了甲线却以为在看乙线），
  而且不报任何错。这条用例就是守这个边界。

覆盖：
  g1 打开总览：面板在 DOM 里、按组分段（两组两段）、当前组标"当前"、别组有"切到这一组"。
  g2 点别组剧本：**选中目标不变** + 状态栏回执说明"只读总览"（真点，不是查状态）。
  g3 点"切到这一组"：activeGroupId 真的变，且"当前"标记跟着换。
  g4 关掉总览：面板消失、当前组列表回来（两个世界不许同时显示）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import open_test_base_map                              # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例164底图'


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


# ── 造数：两组各两本剧本 + 两个省（与 test_146 同一套形状）─────────────────
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

  const P = (id, name, color) => ({ id, name, color });
  const g1 = s.addScenarioGroup({ name: '甲线' }).group.id;
  const g2 = s.addScenarioGroup({ name: '乙线' }).group.id;
  const sc = (id, name, order, start, end, group, owner) => s.createScenario(KEY + '/' + id, {
    ownerKey: KEY, name, order, group,
    era: { roman: '', label: name, startYear: String(start), endYear: String(end) },
    polities: [P(owner, owner + '国', '#c23b3b')],
    ownership: { prov_a: owner, prov_b: owner },
  });
  sc('甲一', '甲一', 1, 2000, 2010, g1, 'A1');
  sc('甲二', '甲二', 2, 2010, 2020, g1, 'A2');
  sc('乙一', '乙一', 1, 1000, 1100, g2, 'B1');
  sc('乙二', '乙二', 2, 1100, 1200, g2, 'B2');

  const SM = __SM__;
  SM.baseMapKey = KEY;
  await tick(30);
  SM.activeGroupId = g1;
  await tick(30);
  // 组件不会“自动选中”某条剧本：显式走产品入口选中甲线第一条
  // （不这样的话 g0 前置恒为 null —— 用例会以“前置没就位”而不是“功能坏了”红）
  if (!SM.selectedScenario && SM.sortedScenarios.length) SM.selectScenarioAt(SM.sortedScenarios[0]);
  await tick(60);
  return JSON.stringify({
    g1, g2, scen: Object.keys(s.scenarios).length,
    groups: (s.scenarioGroups || []).map(g => g.id),
    selected: SM.selectedScenario && SM.selectedScenario.id,
  });
})()"""


JS_MAIN = r"""(async () => {
  const fails = [], notes = {};
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
  const s = __STORE__, SM = __SM__;

  // ── g0 前置 ────────────────────────────────────────────────
  ck('g0 前置：当前在甲线', SM.activeGroupId === SEED.g1, SM.activeGroupId);
  const sel0 = SM.selectedScenario && SM.selectedScenario.id;
  ck('g0 前置：已选中甲线的一条剧本', !!sel0, sel0);

  // ── g1 打开总览 ────────────────────────────────────────────
  const btn = document.querySelector('[data-testid="scenario-group-overview"]');
  ck('g1 左栏有“看全部”按钮', !!btn, null);
  if (!btn) return JSON.stringify({ fails, notes });
  btn.click();
  await tick(40);
  const panel = document.querySelector('[data-testid="scenario-overview"]');
  ck('g1 总览面板出现在 DOM 里（不是只改状态）', !!panel, null);
  if (!panel) return JSON.stringify({ fails, notes });
  const segs = panel.querySelectorAll('.sgo-group').length;
  ck('g1 按组分段（两组 = 两段）', segs === 2, segs);
  const curTexts = Array.from(panel.querySelectorAll('.sgo-cur')).map((el) => el.textContent.trim());
  ck('g1 只有当前组标“当前”', curTexts.length === 1 && curTexts[0].indexOf('当前') >= 0, curTexts);
  const goBtns = panel.querySelectorAll('[data-testid^="scenario-overview-switch-"]').length;
  ck('g1 别组有“切到这一组”（当前组没有）', goBtns === 1, goBtns);

  // ── g2 点别组剧本 = 只读 ────────────────────────────────────
  const otherItem = panel.querySelector('[data-testid="scenario-overview-item-' + SEED.g2 + '-0"]');
  ck('g2 别组剧本条目在', !!otherItem, null);
  if (otherItem) otherItem.click();
  await tick(40);
  ck('g2 🔴 点别组剧本后**选中目标不变**', (SM.selectedScenario && SM.selectedScenario.id) === sel0,
     SM.selectedScenario && SM.selectedScenario.id);
  ck('g2 回执写明“只读总览”', String(SM.provinceHint || '').indexOf('只读总览') >= 0, SM.provinceHint);
  notes.hint = String(SM.provinceHint || '').slice(0, 80);

  // ── g3 切到这一组 = 真的切过去 ──────────────────────────────
  const go = document.querySelector('[data-testid="scenario-overview-switch-' + SEED.g2 + '"]');
  ck('g3 “切到这一组”按钮在', !!go, null);
  if (go) go.click();
  await tick(80);
  ck('g3 activeGroupId 变到乙线', SM.activeGroupId === SEED.g2, SM.activeGroupId);
  const cur2 = document.querySelector('[data-testid="scenario-overview"] .sgo-cur');
  ck('g3 切完后“当前”标记跟着换', !!cur2 && cur2.textContent.indexOf('当前') >= 0, cur2 && cur2.textContent);
  notes.activeAfterSwitch = SM.activeGroupId;

  // ── g4 关掉总览：两个世界不许同时显示 ──────────────────────
  const btn2 = document.querySelector('[data-testid="scenario-group-overview"]');
  if (btn2) btn2.click();
  await tick(40);
  ck('g4 关掉总览后面板消失（DOM 零节点）', !document.querySelector('[data-testid="scenario-overview"]'), null);
  ck('g4 当前组列表回来了', !!document.querySelector('[data-testid="scenario-list-item-0"]'), null);

  notes.groups = SEED.groups;
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
    got, seed = eval_json(cdp, seed_src, required=('g1', 'g2', 'scen'), desc='造两组四剧本')
    if not got:
        return False, f'造数失败：{seed}'

    main_src = ('const SEED = ' + json.dumps(seed) + ';\n'
                + JS_MAIN.replace('__STORE__', STORE).replace('__SM__', SM))
    got2, out = eval_json(cdp, main_src, required=('fails', 'notes'), desc='只读总览主链')
    if not got2:
        return False, f'主链失败：{out}'
    fails = out.get('fails') or []
    notes = out.get('notes') or {}
    if fails:
        return False, '；'.join(fails)[:1200] + ' | 实测：' + json.dumps(notes, ensure_ascii=False)[:600]
    return True, (
        f'两组两段 · 点别组剧本不动选择（回执“{notes.get("hint", "")}”）'
        f' · 切组后 active={notes.get("activeAfterSwitch")} · 关掉后列表回来'
    )
