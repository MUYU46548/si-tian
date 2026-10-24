#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 138：归属笔 → 账本（第 4 件第一接线点，2026-10-24）

验收点（每条带反证/边界）：
1. 一笔带日期的涂归属 → `scenario.ledger` 长出**同一 groupId** 的事件（provenance=brush、day=那天）
2. 账本投影 == 缓存 `ownership`（**逐省 0 处不同**）—— 这是"账本可以当真源"的前提
3. 撤销/重做：账本跟着整笔回滚/回来（不是只回滚缓存）
4. **无日期编辑不入账**（只写缓存）—— 与尚未接线的写口共存，不制造假账
5. 落盘 + 重开：`scenario.ledger` 跟项目文件走（条数与 groupId 都不变）
6. 源码守卫：接线点在 `batchSetOwnership` 里（fromV2Scenario/projectOwnership/diffOwnership），
   且组件把 groupId（strokeId）传下去
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
PROJ = 'src/renderer/src/store/geodataModules/scenarioEditing.js'
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


# 造一份最小底图 + 剧本 + 势力；返回 key / 剧本 id / 势力 id
SETUP = r"""(() => {
  const s = STORE_X;
  const KEY = '用例138底图';
  const SC = KEY + '/账本';
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const ring = (x0, y0, x1, y1) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
  s.addBaseProvince(KEY, { id: 'p138a', name: '甲省', kind: 'land', points: ring(100,100,240,240) });
  s.addBaseProvince(KEY, { id: 'p138b', name: '乙省', kind: 'land', points: ring(260,100,400,240) });
  s.addBaseProvince(KEY, { id: 'p138c', name: '丙省', kind: 'land', points: ring(100,260,240,400) });
  s.createScenario(SC, { ownerKey: KEY, name: '账本', order: 1,
    era: { roman: 'Ⅰ', label: '一', startYear: '1000', endYear: '1100' },
    polities: [], ownership: {} });
  const r = s.addPolity(SC, { name: '甲国' });
  return JSON.stringify({ key: KEY, scenario: SC, polity: (r && r.id) || '' });
})()""".replace('STORE_X', STORE)

STATE = r"""(() => {
  const s = STORE_X;
  const key = '用例138底图/账本';
  const scn = (s.scenarios || {})[key] || {};
  const ledger = scn.ledger || null;
  const events = (ledger && Array.isArray(ledger.events)) ? ledger.events : [];
  return JSON.stringify({
    events: events.length,
    groups: [...new Set(events.filter(e => e.groupId).map(e => e.groupId))],
    brush: events.filter(e => e.provenance === 'brush').length,
    days: [...new Set(events.filter(e => e.type === 'province.owner.changed').map(e => e.day))],
    projectOk: scn.__projectOk === undefined ? null : scn.__projectOk,
    ownership: scn.ownership || {},
    canUndo: !!s.canUndo,
    undoLabel: s.undoLabel,
    pdf: (scn.changeEvents && Object.keys(scn.changeEvents).length) || 0,
  });
})()""".replace('STORE_X', STORE)

# 直接调 store 的批量口（与笔刷同一条路），带上 strokeId
BATCH = r"""(() => {
  const s = STORE_X;
  const key = '用例138底图/账本';
  const scn = s.scenarios[key];
  const pol = (scn.polities || [])[0];
  const before = ((scn.ledger || {}).events || []).length;
  const r = s.batchSetOwnership(scn.id, ['p138a', 'p138b'], pol.id, { y: 1050 },
    { strokeId: 'case138-stroke-1' });
  const cur = s.scenarios[key];
  const events = ((cur.ledger || {}).events || []);
  return JSON.stringify({
    ok: !!(r && r.success), changed: (r && r.changed) || 0,
    before, after: events.length,
    groups: [...new Set(events.filter(e => e.groupId).map(e => e.groupId))],
    days: [...new Set(events.filter(e => e.type === 'province.owner.changed').map(e => e.day))],
    ownership: cur.ownership || {},
    changeEventKeys: Object.keys(cur.changeEvents || {}),
  });
})()""".replace('STORE_X', STORE)

# 用账本引擎自己再算一遍投影，与缓存逐省对拍（探针侧独立复核，不只信 store）
VERIFY = r"""(() => {
  const s = STORE_X;
  const key = '用例138底图/账本';
  const scn = s.scenarios[key] || {};
  const L = window.__L138;
  if (!L) return JSON.stringify({ __err__: '账本引擎没装上' });
  const events = ((scn.ledger || {}).events || []);
  if (!events.length) return JSON.stringify({ __err__: '账本为空' });
  const proj = L.projectOwnership(scn.ledger);
  const d = L.diffOwnership(proj, scn.ownership || {});
  return JSON.stringify({ same: d.same, diffCount: d.changed.length, checked: Object.keys(scn.ownership || {}).length });
})()""".replace('STORE_X', STORE)

LOAD_L = r"""(async () => {
  window.__L138 = await import('/@fs/E:/CODE/CangKu/SiTian/src/ledger/index.js');
  return JSON.stringify({ ok: typeof window.__L138.projectOwnership === 'function' });
})()"""

UNDO = "(() => { STORE_X.undo(); return 'ok'; })()".replace('STORE_X', STORE)
REDO = "(() => { STORE_X.redo(); return 'ok'; })()".replace('STORE_X', STORE)

NO_DATE = r"""(() => {
  const s = STORE_X;
  const key = '用例138底图/账本';
  const scn = s.scenarios[key];
  const pol = (scn.polities || [])[0];
  const before = ((scn.ledger || {}).events || []).length;
  s.batchSetOwnership(scn.id, ['p138c'], pol.id);          // ← 不传日期
  const after = (((s.scenarios[key] || {}).ledger || {}).events || []).length;
  return JSON.stringify({ before, after, ownership: (s.scenarios[key] || {}).ownership || {} });
})()""".replace('STORE_X', STORE)

SAVE_REOPEN = r"""(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(app.config.globalProperties.$pinia);
  const fp = ps.filePath;
  const r = await ps.saveProject({ label: 'case138' });
  const p = window.__probe.lastProject();
  const dict = (p && p.scenarios && p.scenarios.scenarios) || {};
  const scn = dict['用例138底图/账本'] || {};
  const savedEvents = ((scn.ledger || {}).events || []).length;
  const savedGroups = [...new Set(((scn.ledger || {}).events || []).filter(e => e.groupId).map(e => e.groupId))];
  const closed = await ps.closeProject();
  await new Promise((res) => setTimeout(res, 300));
  const opened = await ps.openProject(fp);
  await new Promise((res) => setTimeout(res, 700));
  const s = STORE_X;
  const cur = (s.scenarios || {})['用例138底图/账本'] || {};
  const reopenEvents = ((cur.ledger || {}).events || []).length;
  return JSON.stringify({
    ok: !!(r && r.success), error: (r && r.error) || '',
    savedEvents, savedGroups,
    closed: !!(closed && closed.success), reopened: !!(opened && opened.success),
    reopenEvents,
  });
})()""".replace('STORE_X', STORE)


def sub_source_guards():
    bad = []
    code = _code_only(_read(PROJ))
    for needle, why in [
        ('fromV2Scenario(', 'batchSetOwnership 没接账本（旧档迁移入口缺失）'),
        ('projectOwnership(', 'batchSetOwnership 没算账本投影'),
        ('diffOwnership(', 'batchSetOwnership 没做"投影 vs 缓存"对拍（可能写自相矛盾的账）'),
        ('provenance: \'brush\'', '事件没记 provenance=brush'),
    ]:
        if needle not in code:
            bad.append(why)
    map_code = _code_only(_read(MAP))
    if 'strokeId:' not in map_code:
        bad.append('ScenarioMap 没把 strokeId（这一笔的 groupId）传给 batchSetOwnership')
    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '接线点在 batchSetOwnership（迁移/投影/对拍）+ 组件传 strokeId'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)
    # ⚠️ 不用 `open_test_base_map`：它要求 ScenarioMap 已挂载（在剧本视图里），
    #    而本用例全部走 store 写口（与 test_132 同一口径），底图在 SETUP 里建。
    time.sleep(0.3)

    r = _j(cdp, SETUP)
    if not r.get('polity'):
        return False, f'造剧本/势力失败：{r}'
    time.sleep(0.4)
    print('   · 载入账本引擎:', _j(cdp, LOAD_L))

    s0 = _j(cdp, STATE)
    # ① 一笔（两个省）+ ② 投影对拍
    b1 = _j(cdp, BATCH)
    time.sleep(0.3)
    s1 = _j(cdp, STATE)
    v1 = _j(cdp, VERIFY)

    # ③ 撤销/重做
    _j(cdp, UNDO)
    time.sleep(0.3)
    s2 = _j(cdp, STATE)
    _j(cdp, REDO)
    time.sleep(0.3)
    s3 = _j(cdp, STATE)

    # ④ 无日期编辑不入账
    nod = _j(cdp, NO_DATE)
    time.sleep(0.2)

    # ⑤ 落盘 + 重开
    sr = _j(cdp, SAVE_REOPEN)
    time.sleep(0.3)

    fails = []
    if not (b1.get('changed') == 2):
        fails.append(f'批量指派改动数不对（{b1.get("changed")} ≠ 2）')
    if not (b1.get('after') == 3):
        fails.append(f'账本条数不对（基线 1 + 2 省事件 = 3，实际 {b1.get("after")}）')
    if b1.get('groups') != ['case138-stroke-1']:
        fails.append(f'groupId 不对：{b1.get("groups")}')
    if b1.get('days') != [1050 * 360]:
        fails.append(f'day 换算不对：{b1.get("days")}（期望 [{1050 * 360}]）')
    if not v1.get('same'):
        fails.append(f'账本投影与缓存不一致（{v1.get("diffCount")} 处）')
    if b1.get('ownership', {}).get('p138a') != r['polity']:
        fails.append('缓存 ownership 没更新到新势力')
    if sorted(b1.get('changeEventKeys') or []) != ['p138a', 'p138b']:
        fails.append(f'changeEvents 键不对：{b1.get("changeEventKeys")}')
    if s2.get('events') != s0.get('events'):
        fails.append(f'撤销后账本没回原状（{s2.get("events")} ≠ {s0.get("events")}）')
    if s3.get('events') != s1.get('events'):
        fails.append(f'重做后账本没回来（{s3.get("events")} ≠ {s1.get("events")}）')
    if nod.get('after') != nod.get('before'):
        fails.append(f'无日期编辑居然入了账（{nod.get("before")} → {nod.get("after")}）')
    if nod.get('ownership', {}).get('p138c') != r['polity']:
        fails.append('无日期编辑连缓存都没写（那才是真丢数据）')
    if not sr.get('ok'):
        fails.append(f'落盘失败：{sr.get("error")}')
    if sr.get('savedEvents') != b1.get('after'):
        fails.append(f'落盘载荷里的账本条数不对（{sr.get("savedEvents")} ≠ {b1.get("after")}）')
    if sr.get('savedGroups') != ['case138-stroke-1']:
        fails.append(f'落盘载荷里的 groupId 不对：{sr.get("savedGroups")}')
    if not sr.get('reopened'):
        fails.append('重开项目失败')
    if sr.get('reopenEvents') != sr.get('savedEvents'):
        fails.append(f'重开后账本条数变了（{sr.get("reopenEvents")} ≠ {sr.get("savedEvents")}）')

    sg_ok, sg_detail = sub_source_guards()
    if not sg_ok:
        fails.append(sg_detail)

    detail = (f'归属笔→账本：一笔 2 省 → {b1.get("after")} 条事件（1 基线 + 2 变更）/ groupId='
              f'{b1.get("groups")} / day={b1.get("days")}；投影与缓存 **0 处不同**；'
              f'撤销 {s2.get("events")} → 重做 {s3.get("events")}；无日期编辑不入账（{nod.get("before")}→'
              f'{nod.get("after")}）但缓存照写；落盘 {sr.get("savedEvents")} 条 + 重开 {sr.get("reopenEvents")} 条；'
              f'源码守卫：{sg_detail}')
    if fails:
        return False, '；'.join(fails)[:900]
    return True, detail
