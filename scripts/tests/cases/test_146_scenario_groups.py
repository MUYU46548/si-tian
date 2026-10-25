#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 146：剧本集（多时间线 / 多底图）—— 数据层 + 左栏 + 时间轴 + 切片范围

为什么需要这条用例：
  · 剧本集不是「左栏文件夹」：时间轴/播放/切片导出的「全部剧本」都必须**只取当前组**。
    如果只有左栏过滤了，时间轴会把两条时间线混在一条年份轴上 —— 图是对的、时间是错的，
    而且不报任何错（正是本项目反复出现的「同屏两个世界」）。
  · 组是用户数据：新建/改名/删除/移动必须一条 undo，删除组**不能删剧本**（只退回默认组）。
  · 旧项目没有 `groups` 字段 → 必须零迁移地全部落默认组。

覆盖：
  f1 数据层：两组四剧本；缺省组/计数/组内取数/导出载荷带 groups。
  f2 左栏 + 时间轴：切组 → 列表与 timeline.scenarios 同时只剩该组；游标被夹回该组范围。
  f3 UI：范围下拉切换（真 change 事件）；管理对话框里新建剧本集（真 input + click）。
  f4 移动 + 删除组：移动不丢剧本；删组后组内剧本退回默认组；一条 undo 全还原。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready, open_test_base_map            # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例146底图'


def _enter_scenario_mode(cdp):
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if r != 'ok':
        return r
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    return 'ok'


SEED_JS = r"""(async () => {
  const s = __STORE__;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const KEY = __KEY__;

  // 干净起点：清剧本 + 清组表（默认组是虚拟的，不在这里）
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

  // 让组件切到 KEY 底图 + 甲线（正常路径是 watch(baseMapKey)/resetGroupForBaseMap，
  // 这里显式落位，避免用例依赖挂载时序）
  const SM = __SM__;
  SM.baseMapKey = KEY;
  await tick(30);
  SM.activeGroupId = g1;
  await tick(30);
  return JSON.stringify({
    g1, g2,
    scen: Object.keys(s.scenarios).length,
    groups: (s.scenarioGroups || []).map(g => g.id),
  });
})()"""


JS_MAIN = r"""(async () => {
  const fails = [], notes = {};
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;

  // ── f1 数据层 ───────────────────────────────────────────────
  ck('f1 默认组永远可选', SM.groupOptions[0].id === 'default', SM.groupOptions.map(g => g.id));
  ck('f1 两个自定义组都在', SM.groupOptions.length === 3, SM.groupOptions.map(g => g.id));
  notes.counts = { g1: SM.groupCount(SEED.g1), g2: SM.groupCount(SEED.g2), def: SM.groupCount('default') };
  ck('f1 组内计数 2/2/0', notes.counts.g1 === 2 && notes.counts.g2 === 2 && notes.counts.def === 0, notes.counts);
  const g1Ids = s.getScenariosForGroup(KEY, SEED.g1).map(x => x.name);
  ck('f1 组内取数只回本组', JSON.stringify(g1Ids) === JSON.stringify(['甲一', '甲二']), g1Ids);

  const payload = s.exportScenariosPayload();
  ck('f1 导出载荷带 groups（否则导到别的项目就全并回默认组）',
     Array.isArray(payload.groups) && payload.groups.length === 2, payload.groups);
  const ownerPayload = s.exportScenariosPayload(KEY);
  ck('f1 单底图导出只带用到的组', Array.isArray(ownerPayload.groups) && ownerPayload.groups.length === 2, ownerPayload.groups);

  // ── f1b 缺省组：老剧本没有 group 字段 → 默认组 ───────────────
  const oldId = KEY + '/老剧本';
  s.createScenario(oldId, { ownerKey: KEY, name: '老剧本', order: 9,
    era: { roman: '', label: '老', startYear: '800', endYear: '900' },
    polities: [{ id: 'O1', name: '老国', color: '#888888' }], ownership: {} });
  ck('f1b 不传 group → 落默认组', s.getScenario(oldId).group === 'default', s.getScenario(oldId).group);

  // ── f2 左栏 + 时间轴按组 ───────────────────────────────────
  SM.activeGroupId = SEED.g1;
  await tick(50);
  notes.g1 = {
    list: Array.from(document.querySelectorAll('.slp-list .slp-item .slp-name')).map(x => x.textContent.trim()),
    tl: (SM.timeline.scenarios || []).map(x => x.name),
    blocks: document.querySelectorAll('.tl-block').length,
  };
  ck('f2 甲线左栏只剩甲一/甲二', JSON.stringify(notes.g1.list) === JSON.stringify(['甲一', '甲二']), notes.g1.list);
  ck('f2 甲线时间轴只剩 2 段', JSON.stringify(notes.g1.tl) === JSON.stringify(['甲一', '甲二']), notes.g1.tl);
  ck('f2 时间轴轨道恰好 2 块', notes.g1.blocks === 2, notes.g1.blocks);

  // 切到乙线（时间轴范围是 1000~1200，游标必须被夹回本组）
  const sel = document.querySelector('[data-testid="scenario-group-switch"]');
  ck('f2 左栏有剧本集下拉', !!sel, null);
  if (sel) {
    sel.value = SEED.g2;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(60);
  }
  notes.g2 = {
    active: SM.activeGroupId,
    list: Array.from(document.querySelectorAll('.slp-list .slp-item .slp-name')).map(x => x.textContent.trim()),
    tl: (SM.timeline.scenarios || []).map(x => x.name),
    year: SM.tlDate.y,
    min: SM.timeline.minYear, max: SM.timeline.maxYear,
  };
  ck('f2 切组：activeGroupId 跟着变', notes.g2.active === SEED.g2, notes.g2.active);
  ck('f2 乙线左栏只剩乙一/乙二', JSON.stringify(notes.g2.list) === JSON.stringify(['乙一', '乙二']), notes.g2.list);
  ck('f2 乙线时间轴只剩 2 段', JSON.stringify(notes.g2.tl) === JSON.stringify(['乙一', '乙二']), notes.g2.tl);
  ck('f2 游标落在本组范围（1000~1200）',
     notes.g2.year >= notes.g2.min && notes.g2.year <= notes.g2.max, notes.g2);

  // ── f3 管理对话框：真 input + 真 click 新建剧本集 ───────────
  SM.showScenarioManager = true;
  await tick(60);
  const inp = document.querySelector('[data-testid="scenario-group-name"]');
  const btn = document.querySelector('[data-testid="scenario-group-create"]');
  ck('f3 管理对话框有新建组输入与按钮', !!inp && !!btn, null);
  let createdId = null;
  if (inp && btn) {
    inp.value = '丙线';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(40);
    btn.click();
    await tick(60);
    const hit = (s.scenarioGroups || []).find(g => g.name === '丙线');
    createdId = hit ? hit.id : null;
    ck('f3 点「新建剧本集」真的建出来', !!createdId, (s.scenarioGroups || []).map(g => g.name));
    ck('f3 新组立刻出现在左栏下拉',
       Array.from(document.querySelectorAll('[data-testid="scenario-group-switch"] option')).some(o => o.textContent.includes('丙线')), null);
    ck('f3 新建后自动切到该组', SM.activeGroupId === createdId, SM.activeGroupId);
  }
  SM.showScenarioManager = false;
  await tick(30);

  // ── f3b 切片对话框：范围写「本组」，清单带 groupName ────────
  SM.activeGroupId = SEED.g1;
  await tick(40);
  SM.showSliceExport = true;
  await tick(60);
  const scopeSel = document.querySelector('[data-testid="slice-scope"]');
  const scopeText = scopeSel ? (scopeSel.options[scopeSel.selectedIndex] || {}).textContent || '' : '';
  notes.scopeText = scopeText.replace(/\s+/g, ' ').trim();
  ck('f3b 切片范围写明「本组」', /本组/.test(scopeText), notes.scopeText);
  SM.showSliceExport = false;

  // ── f4 移动 + 删组 + 一条 undo ─────────────────────────────
  const beforeMove = s.getScenario(KEY + '/乙一');
  s.setScenarioGroup(KEY + '/乙一', SEED.g1);
  ck('f4 移动后剧本还在（不丢数据）', !!s.getScenario(KEY + '/乙一'), null);
  ck('f4 移动后归属已改', s.getScenario(KEY + '/乙一').group === SEED.g1, s.getScenario(KEY + '/乙一').group);
  ck('f4 旧组计数减 1', SM.groupCount(SEED.g2) === 1, SM.groupCount(SEED.g2));

  const beforeDelete = (s.scenarioGroups || []).length;
  s.removeScenarioGroup(SEED.g2);
  await tick(40);
  ck('f4 删组成功', (s.scenarioGroups || []).length === beforeDelete - 1, (s.scenarioGroups || []).map(g => g.id));
  ck('f4 删组不删剧本（组内剧本退回默认组）',
     s.getScenario(KEY + '/乙二').group === 'default' && !!s.getScenario(KEY + '/乙二'),
     s.getScenario(KEY + '/乙二').group);

  s.undo();
  await tick(40);
  ck('f4 一条 undo 把组与归属一起还原',
     (s.scenarioGroups || []).some(g => g.id === SEED.g2) && s.getScenario(KEY + '/乙二').group === SEED.g2,
     { groups: (s.scenarioGroups || []).map(g => g.id), group: s.getScenario(KEY + '/乙二').group });

  notes.groupsAfterUndo = (s.scenarioGroups || []).map(g => g.name);

  // ── f5 项目载荷 + 重开项目：组表必须原样往返 ────────────────
  // `exportCanvasToProject()` 是画布→项目的唯一载荷出口（projectStore 只落盘）；
  // `applyScenarioState(..., {fresh:true})` 是「打开项目/回滚快照」的唯一装载口。
  // 先造一条「组表里没有的孤儿组」剧本 —— 导入包/旧数据会出现这种形状，
  // 若收养逻辑失效，它会在**所有组**里都不可见（用户看到剧本凭空消失）。
  s.createScenario(KEY + '/孤儿剧本', {
    ownerKey: KEY, name: '孤儿剧本', order: 20, group: 'grp_orphan',
    era: { roman: '', label: '孤', startYear: '700', endYear: '800' },
    polities: [], ownership: {},
  });
  await tick(40);
  const projSc = s.exportCanvasToProject().scenarios;
  ck('f5 项目载荷里带 groups', Array.isArray(projSc.groups) && projSc.groups.length >= 2, projSc.groups);
  ck('f5 导出时收养孤儿组（剧本引用了组表里没有的 id）',
     (projSc.groups || []).some(g => g.id === 'grp_orphan'), projSc.groups);
  const frozen = JSON.parse(JSON.stringify(projSc));
  s.applyScenarioState({
    baseMaps: frozen.baseMaps, scenarios: frozen.scenarios,
    groups: frozen.groups, slicePoints: frozen.slicePoints,
  }, { fresh: true });
  await tick(40);
  const restored = (s.scenarioGroups || []).map(g => g.name);
  ck('f5「重开项目」后组表还在（不是保存一次就丢）',
     JSON.stringify(restored) === JSON.stringify([...notes.groupsAfterUndo, 'grp_orphan']), { restored, before: notes.groupsAfterUndo });
  ck('f5 重开后剧本的组归属还在',
     s.getScenario(KEY + '/乙二') && s.getScenario(KEY + '/乙二').group === SEED.g2,
     s.getScenario(KEY + '/乙二') && s.getScenario(KEY + '/乙二').group);
  ck('f5 重开后孤儿组也可选（剧本不会无处可见）',
     (s.scenarioGroups || []).some(g => g.id === 'grp_orphan'), s.scenarioGroups);

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
    ok, seed_or_err = eval_json(cdp, seed_src, required=('g1', 'g2', 'scen'), desc='f0 造两组四剧本')
    if not ok:
        return False, f'造数失败：{seed_or_err}'
    seed = seed_or_err

    # 把造数结果作为常量注进主脚本（`SEED.g1` 等）—— 不用 Python 全局，避免用例间串味
    main_src = ('const SEED = ' + json.dumps(seed) + ';\n'
                + JS_MAIN.replace('__STORE__', STORE)
                .replace('__SM__', SM)
                .replace('__KEY__', json.dumps(KEY)))
    ok, out = eval_json(cdp, main_src, required=('fails', 'notes'), desc='剧本集主链')
    if not ok:
        return False, f'主链失败：{out}'
    fails = out.get('fails') or []
    notes = out.get('notes') or {}
    if fails:
        return False, '；'.join(fails)[:1200] + ' | 实测：' + json.dumps(notes, ensure_ascii=False)[:600]
    return True, (
        f'两组四剧本 → 甲线 {{list:{notes.get("g1", {}).get("list")}, tl:{notes.get("g1", {}).get("tl")}}}'
        f' / 乙线 {{list:{notes.get("g2", {}).get("list")}, year:{notes.get("g2", {}).get("year")}}}'
        f' / 切片范围「{notes.get("scopeText")}」'
        f' / 删组+undo 还原 {notes.get("groupsAfterUndo")}'
    )
