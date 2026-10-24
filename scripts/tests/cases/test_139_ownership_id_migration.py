#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 139：归属 id 迁移 → 账本跟着迁（第 4 件第二刀续，2026-10-24）

为什么必须有这条：第 4 件第二刀把"账本投影 == 缓存"当成了换真源的前提，
而**改省界/合并/批量铺底/删省/删势力**都会动归属的**键**（省份 id）。
只要有一处只改 v2 缓存、不改账本，这个剧本的归属编辑就会**永远**掉进降级分支
（不写假账，但也不再进账）—— 这类退化不会报错，只会"账本再也不长了"。

验收点：
1. v2 剧本（initialOwnership + changeEvents）→ 涂一笔 → 账本 = 基线 + 1 条（投影 == 缓存）
2. **批量铺底**（一省拆两块）：基线/事件/initialOwnership 三处都换成了新省 id，
   旧省 id 一条不剩；投影 == 缓存
3. 铺底之后**再涂一笔** → 账本**继续长**（groupId 是新的一笔）—— 这是"没退化"的判据
4. **删省**：账本/基线/缓存三处都不再出现它；投影 == 缓存
5. **易主日期面板**改日期后再涂一笔 → 面板改的那条**没被投影抹掉**；撤销面板编辑能回上一层
6. 落盘 + 重开：账本条数与迁移后的 id 都还在，投影仍 == 缓存
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

KEY = '用例139底图'
SC = KEY + '/迁移'


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


SETUP = r"""(() => {
  const s = STORE_X;
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY_X]) s.addBaseMap(KEY_X, { name: KEY_X });
  s.baseMaps[KEY_X].terrain.length = 0;
  const ring = (x0, y0, x1, y1) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
  s.addBaseProvince(KEY_X, { id: 'p139a', name: '甲省', kind: 'land', points: ring(100,100,340,340) });
  s.addBaseProvince(KEY_X, { id: 'p139b', name: '乙省', kind: 'land', points: ring(380,100,520,340) });
  s.createScenario(SC_X, { ownerKey: KEY_X, name: '迁移', order: 1,
    era: { roman: 'Ⅰ', label: '一', startYear: '1000', endYear: '1100' },
    polities: [], ownership: {} });
  const r = s.addPolity(SC_X, { name: '甲国' });
  const pol = (r && r.id) || '';
  // v2 形状（真实项目 415 省就是它）：基线 + 一条显式易主
  s.scenarios[SC_X] = {
    ...s.scenarios[SC_X],
    initialOwnership: { p139a: pol },
    changeEvents: { p139a: [{ y: 1050, m: null, d: null, owner: pol }] },
    ownership: { p139a: pol },
  };
  return JSON.stringify({ polity: pol, ids: s.baseMaps[KEY_X].terrain.map(p => p.id), n: s.baseMaps[KEY_X].terrain.length });
})()""".replace('STORE_X', STORE).replace('KEY_X', "'" + KEY + "'").replace('SC_X', "'" + SC + "'")

STATE = r"""(() => {
  const s = STORE_X;
  const scn = (s.scenarios || {})[SC_X] || {};
  const evs = ((scn.ledger || {}).events || []);
  const baseline = (evs.find(e => e.type === 'epoch.baseline') || { payload: {} }).payload.ownership || {};
  const mine = (() => { const t = s.baseMaps[KEY_X] ? s.baseMaps[KEY_X].terrain : []; return t.map(p => p.id); })();
  return JSON.stringify({
    hasLedger: !!scn.ledger,
    events: evs.length,
    groups: [...new Set(evs.filter(e => e.groupId).map(e => e.groupId))],
    baselineKeys: Object.keys(baseline).sort(),
    eventPids: [...new Set(evs.filter(e => e.payload && e.payload.provinceId).map(e => e.payload.provinceId))].sort(),
    initialKeys: Object.keys(scn.initialOwnership || {}).sort(),
    ownership: scn.ownership || {},
    changeEvents: scn.changeEvents || {},
    provinceIds: mine,
    canUndo: !!s.canUndo,
  });
})()""".replace('STORE_X', STORE).replace('KEY_X', "'" + KEY + "'").replace('SC_X', "'" + SC + "'")

VERIFY = r"""(() => {
  const s = STORE_X;
  const scn = (s.scenarios || {})[SC_X] || {};
  const L = window.__L139;
  if (!L || !scn.ledger) return JSON.stringify({ same: false, reason: '没有账本' });
  const proj = L.projectOwnership(scn.ledger);
  const d = L.diffOwnership(proj, scn.ownership || {});
  return JSON.stringify({ same: d.same, diffCount: d.changed.length, samples: d.changed.slice(0, 3) });
})()""".replace('STORE_X', STORE).replace('SC_X', "'" + SC + "'")

LOAD = r"""(async () => {
  window.__L139 = await import('/@fs/E:/CODE/CangKu/SiTian/src/ledger/index.js');
  return JSON.stringify({ ok: typeof window.__L139.projectOwnership === 'function' });
})()"""

PAINT = r"""((function(){
  const s = STORE_X;
  const scn = s.scenarios[SC_X];
  const pol = (scn.polities || [])[0];
  const before = (((s.scenarios[SC_X] || {}).ledger || {}).events || []).length;
  const r = s.batchSetOwnership(scn.id, [PIDS_X], pol.id, { y: YEAR_X },
    { strokeId: STROKE_X });
  const cur = s.scenarios[SC_X];
  const evs = ((cur.ledger || {}).events || []);
  return JSON.stringify({
    ok: !!(r && r.success), changed: (r && r.changed) || 0,
    before, after: evs.length,
    groups: [...new Set(evs.filter(e => e.groupId).map(e => e.groupId))],
    ownership: cur.ownership || {},
    initial: Object.keys(cur.initialOwnership || {}),
    receipt: r || null,
  });
}))()""".replace('STORE_X', STORE).replace('SC_X', "'" + SC + "'")

SUBDIVIDE = r"""(async () => {
  const s = STORE_X;
  const scn = s.scenarios[SC_X];
  const before = (((scn && scn.ledger) || {}).events || []).length;
  const r = await s.batchSubdivide(KEY_X, {
    provinceIds: ['p139a'],
    sites: [{ x: 170, y: 220 }, { x: 270, y: 220 }],
    seed: 1, jitter: 0, yieldEvery: 0,
  });
  const cur = s.scenarios[SC_X];
  const evs = ((cur.ledger || {}).events || []);
  return JSON.stringify({
    ledger: evs.map(e => ({ id: e.id, t: e.type, pid: e.payload && e.payload.provinceId, d: e.day })),
    ce: Object.keys(cur.changeEvents || {}),
    ok: !!(r && r.ok), created: (r && r.created) || 0, removed: (r && r.removed) || 0,
    newIds: (r && r.newIds) || [], message: (r && r.message) || '',
    before, after: (((cur.ledger) || {}).events || []).length,
  });
})()""".replace('STORE_X', STORE).replace('KEY_X', "'" + KEY + "'").replace('SC_X', "'" + SC + "'")

REMOVE_PROV = r"""(() => {
  const s = STORE_X;
  const before = (((s.scenarios[SC_X] || {}).ledger || {}).events || []).length;
  s.removeBaseProvince(KEY_X, 'p139b');
  const cur = s.scenarios[SC_X];
  return JSON.stringify({
    before, after: (((cur.ledger) || {}).events || []).length,
    provinceIds: (s.baseMaps[KEY_X].terrain || []).map(p => p.id),
  });
})()""".replace('STORE_X', STORE).replace('KEY_X', "'" + KEY + "'").replace('SC_X', "'" + SC + "'")

SET_DATE = r"""(() => {
  const s = STORE_X;
  const scn = s.scenarios[SC_X];
  const pol = (scn.polities || [])[0];
  const r = s.setChangeEvents(scn.id, PID_X, [{ y: 1080, m: 6, d: 1, owner: pol.id }]);
  const cur = s.scenarios[SC_X];
  const evs = ((cur.ledger || {}).events || []);
  return JSON.stringify({
    ok: !!(r && r.success), changed: (r && r.changed) || 0,
    changeEvents: cur.changeEvents || {},
    ledgerDays: evs.filter(e => e.payload && e.payload.provinceId === PID_X).map(e => e.day),
    events: evs.length,
  });
})()""".replace('STORE_X', STORE).replace('SC_X', "'" + SC + "'")

UNDO = "(() => { STORE_X.undo(); return 'ok'; })()".replace('STORE_X', STORE)

UNDO_PROBE = r"""(() => {
  const s = STORE_X;
  s.undo();
  const scn = (s.scenarios || {})[SC_X] || {};
  return JSON.stringify({ label: s.undoLabel || '', back: ((scn.changeEvents || {})[PID_X]) || null, events: ((scn.ledger || {}).events || []).length });
})()""".replace('STORE_X', STORE).replace('SC_X', "'" + SC + "'")

SAVE_REOPEN = r"""(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(app.config.globalProperties.$pinia);
  const fp = ps.filePath;
  const before = (function(){
    const scn = (STORE_X.scenarios || {})[SC_X] || {};
    return {
      events: (((scn.ledger) || {}).events || []).length,
      ownership: Object.keys(scn.ownership || {}).sort(),
    };
  })();
  const r = await ps.saveProject({ label: 'case139' });
  const p = window.__probe.lastProject();
  const saved = (((p || {}).scenarios || {}).scenarios || {})[SC_X] || {};
  const closed = await ps.closeProject();
  await new Promise((res) => setTimeout(res, 300));
  const opened = await ps.openProject(fp);
  await new Promise((res) => setTimeout(res, 700));
  const cur = (STORE_X.scenarios || {})[SC_X] || {};
  const L = window.__L139;
  const d = (L && cur.ledger) ? L.diffOwnership(L.projectOwnership(cur.ledger), cur.ownership || {}) : { same: false };
  return JSON.stringify({
    ok: !!(r && r.success), error: (r && r.error) || '',
    beforeEvents: before.events, beforeOwnership: before.ownership,
    savedEvents: (((saved.ledger) || {}).events || []).length,
    savedBaseline: Object.keys(((((saved.ledger) || {}).events || []).find(e => e.type === 'epoch.baseline') || { payload: {} }).payload.ownership || {}).sort(),
    closed: !!(closed && closed.success), reopened: !!(opened && opened.success),
    reopenEvents: (((cur.ledger) || {}).events || []).length,
    reopenOwnership: Object.keys(cur.ownership || {}).sort(),
    reopenSame: !!d.same,
  });
})()""".replace('STORE_X', STORE).replace('SC_X', "'" + SC + "'")

# 装载口反向探针：把缓存故意改坏（模拟"手改文件 / 旧版本写盘 / 半途迁移"），
# 再走**产品自己的装载口** —— 账本是真源，坏缓存必须被纠正，且报点。
LOAD_TAMPERED = r"""(() => {
  const s = STORE_X;
  const key = SC_X;
  const cur = (s.scenarios || {})[key];
  if (!cur) return JSON.stringify({ __err__: '剧本不在' });
  const wantKeys = Object.keys(cur.ownership || {}).sort();
  const wantEvents = (((cur.ledger || {}).events) || []).length;
  // 把缓存清空（账本不动）→ 模拟陈旧/被手改的文件
  const tampered = { ...cur, ownership: {}, changeEvents: {} };
  s.applyScenarioState({ scenarios: { [key]: tampered } }, { fresh: true });
  const after = (s.scenarios || {})[key] || {};
  const L = window.__L139;
  const d = (L && after.ledger) ? L.diffOwnership(L.projectOwnership(after.ledger), after.ownership || {}) : { same: false };
  return JSON.stringify({
    wantKeys, gotKeys: Object.keys(after.ownership || {}).sort(),
    wantEvents, events: (((after.ledger || {}).events) || []).length,
    ce: Object.keys(after.changeEvents || {}),
    same: !!d.same,
  });
})()""".replace('STORE_X', STORE).replace('SC_X', "'" + SC + "'")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)
    time.sleep(0.3)

    r = _j(cdp, SETUP)
    if not r.get('polity'):
        return False, f'造剧本/势力失败：{r}'
    time.sleep(0.3)
    print('   · 载入账本引擎:', _j(cdp, LOAD))

    # ① v2 剧本 → 涂一笔（p139b）：账本 = 基线 + 1 条
    p1 = _j(cdp, PAINT.replace('PIDS_X', "'p139b'").replace('YEAR_X', '1060').replace('STROKE_X', "'s139-1'"))
    time.sleep(0.25)
    s1 = _j(cdp, STATE)
    v1 = _j(cdp, VERIFY)

    # ② 批量铺底：p139a 拆两块 → 归属的键整体换新
    sub = _j(cdp, SUBDIVIDE)
    time.sleep(0.35)
    s2 = _j(cdp, STATE)
    v2 = _j(cdp, VERIFY)

    fails = []
    if not (p1.get('changed') == 1 and 's139-1' in (p1.get('groups') or [])):
        fails.append(f'第一笔没入账（{p1}）')
    # 账本从 v2 事实建起（基线 + 继承来的 1050 事件）再追加这一笔 → 3 条
    if p1.get('after') != 3:
        fails.append(f'第一笔后账本条数不对（{p1.get("after")} ≠ 3）')
    if not v1.get('same'):
        fails.append(f'第一笔后投影 != 缓存（{v1}')
    if not sub.get('ok') or sub.get('created') != 2:
        fails.append(f'批量铺底失败：{sub}')
    new_ids = sub.get('newIds') or []
    if len(new_ids) != 2:
        fails.append(f'铺底没给出两个新省 id：{new_ids}')
        return False, '；'.join(fails)
    if 'p139a' in (s2.get('provinceIds') or []):
        fails.append('铺底后旧省 p139a 还在 terrain 里')
    if 'p139a' in (s2.get('baselineKeys') or []):
        fails.append(f'铺底后账本基线里还留着旧省 id：{s2.get("baselineKeys")}')
    if 'p139a' in (s2.get('eventPids') or []):
        fails.append(f'铺底后账本事件里还留着旧省 id：{s2.get("eventPids")}')
    if 'p139a' in (s2.get('initialKeys') or []):
        fails.append(f'铺底后 initialOwnership 里还留着旧省 id：{s2.get("initialKeys")}')
    for nid in new_ids:
        if nid not in (s2.get('ownership') or {}):
            fails.append(f'新省 {nid} 没继承归属（ownership={list((s2.get("ownership") or {}).keys())}）')
        if nid not in (s2.get('baselineKeys') or []):
            fails.append(f'新省 {nid} 没进账本基线')
    if not v2.get('same'):
        fails.append(f'铺底后投影 != 缓存（{v2}）')

    # ③ 铺底之后再涂一笔：账本必须**继续长**（没掉进降级分支）
    p2 = _j(cdp, PAINT.replace('PIDS_X', "'%s'" % new_ids[0]).replace('YEAR_X', '1070').replace('STROKE_X', "'s139-2'"))
    time.sleep(0.25)
    s3 = _j(cdp, STATE)
    v3 = _j(cdp, VERIFY)
    if not (p2.get('after') == s2.get('events') + 1):
        fails.append(f'铺底后归属编辑居然没入账（{s2.get("events")} → {p2.get("after")}）—— 账本退化了')
    if 's139-2' not in (s3.get('groups') or []):
        fails.append(f'新一笔的 groupId 不在账本里：{s3.get("groups")}')
    if not v3.get('same'):
        fails.append(f'第二笔后投影 != 缓存（{v3}）')

    # ④ 删省：账本/基线/缓存三处都不再出现它
    rm = _j(cdp, REMOVE_PROV)
    time.sleep(0.25)
    s4 = _j(cdp, STATE)
    v4 = _j(cdp, VERIFY)
    if 'p139b' in (rm.get('provinceIds') or []):
        fails.append('删省后 terrain 里还有 p139b')
    if not (rm.get('after') < rm.get('before')):
        fails.append(f'删省后账本没摘掉那条事件（{rm.get("before")} → {rm.get("after")}）')
    if 'p139b' in (s4.get('eventPids') or []):
        fails.append(f'删省后账本事件里还有 p139b：{s4.get("eventPids")}')
    if 'p139b' in (s4.get('baselineKeys') or []):
        fails.append(f'删省后账本基线里还有 p139b：{s4.get("baselineKeys")}')
    if 'p139b' in (s4.get('ownership') or {}):
        fails.append('删省后 ownership 里还有 p139b')
    if not v4.get('same'):
        fails.append(f'删省后投影 != 缓存（{v4}）')

    # ⑤ 易主日期面板：改日期 → 再涂一笔（不得把面板改的那条抹掉）
    pid = new_ids[1]
    D1080 = 1080 * 360 + 5 * 30    # {y:1080, m:6, d:1}（一年 360 天 / 一月 30 天）
    sd = _j(cdp, SET_DATE.replace('PID_X', "'%s'" % pid))
    time.sleep(0.25)
    s5 = _j(cdp, STATE)
    v5 = _j(cdp, VERIFY)
    if not sd.get('ok'):
        fails.append(f'面板写日期失败：{sd}')
    if D1080 not in (sd.get('ledgerDays') or []):
        fails.append(f'面板改的日期没落进账本：{sd.get("ledgerDays")}（期望含 {D1080}）')
    if not v5.get('same'):
        fails.append(f'面板写日期后投影 != 缓存（{v5}）')
    p3 = _j(cdp, PAINT.replace('PIDS_X', "'%s'" % new_ids[0]).replace('YEAR_X', '1090').replace('STROKE_X', "'s139-3'"))
    time.sleep(0.25)
    s6 = _j(cdp, STATE)
    v6 = _j(cdp, VERIFY)
    if not ((s6.get('changeEvents') or {}).get(pid)):
        fails.append(f'涂下一笔之后，面板改的事件被投影抹掉了：{s6.get("changeEvents")}')
    if int(D1080) not in [int(e.get('y', 0)) * 360 + 150 for e in ((s6.get('changeEvents') or {}).get(pid) or []) if e.get('m') == 6 and e.get('d') == 1]:
        fails.append(f'面板改的日期在缓存里丢了：{(s6.get("changeEvents") or {}).get(pid)}')
    if not v6.get('same'):
        fails.append(f'第三笔后投影 != 缓存（{v6}）')
    if not (p3.get('after') == p3.get('before') + 1):
        fails.append(f'第三笔没入账（{p3.get("before")} → {p3.get("after")}；p3={p3}）')

    # 撤销面板那一刀：回到继承来的 1050 事件
    u1 = _j(cdp, UNDO_PROBE.replace('PID_X', "'%s'" % pid))   # 撤第三笔（账本组）
    time.sleep(0.2)
    u2 = _j(cdp, UNDO_PROBE.replace('PID_X', "'%s'" % pid))   # 撤面板（账本引用快照）
    time.sleep(0.25)
    s7 = _j(cdp, STATE)
    back = (s7.get('changeEvents') or {}).get(pid) or []
    if not (len(back) == 1 and back[0].get('y') == 1050):
        fails.append(f'撤销面板编辑没回到上一层（{back}；u1={u1}；u2={u2}）')
    v7 = _j(cdp, VERIFY)
    if not v7.get('same'):
        fails.append(f'撤销面板编辑后投影 != 缓存（{v7}）')
    _j(cdp, "(() => { STORE_X.redo(); return 'ok'; })()".replace('STORE_X', STORE))
    time.sleep(0.2)
    _j(cdp, "(() => { STORE_X.redo(); return 'ok'; })()".replace('STORE_X', STORE))
    time.sleep(0.2)

    # ⑥ 落盘 + 重开
    sr = _j(cdp, SAVE_REOPEN)
    time.sleep(0.3)
    if not sr.get('ok'):
        fails.append(f'落盘失败：{sr.get("error")}')
    if sr.get('savedEvents') != sr.get('beforeEvents'):
        fails.append(f'落盘载荷里的账本条数不对（{sr.get("savedEvents")} ≠ {sr.get("beforeEvents")}）')
    if sr.get('savedBaseline') != sorted(s6.get('baselineKeys') or []):
        fails.append(f'落盘载荷里的基线键不对（{sr.get("savedBaseline")} vs {s6.get("baselineKeys")}）')
    if not sr.get('reopened'):
        fails.append('重开项目失败')
    if sr.get('reopenEvents') != sr.get('savedEvents'):
        fails.append(f'重开后账本条数变了（{sr.get("reopenEvents")} ≠ {sr.get("savedEvents")}）')
    if sr.get('reopenOwnership') != sr.get('beforeOwnership'):
        fails.append(f'重开后归属键变了（{sr.get("reopenOwnership")} ≠ {sr.get("beforeOwnership")}）')
    if not sr.get('reopenSame'):
        fails.append('重开后账本投影 != 缓存')

    # ⑦ 装载口反向探针：手动把缓存改坏 → 装载口必须按账本纠正（真源不能只在写口成立）
    lt = _j(cdp, LOAD_TAMPERED)
    time.sleep(0.3)
    if lt.get('gotKeys') != lt.get('wantKeys'):
        fails.append(f'装载口没按账本恢复归属键（{lt.get("gotKeys")} ≠ {lt.get("wantKeys")}）')
    if not lt.get('same'):
        fails.append(f'装载口纠正后投影仍 != 缓存（{lt}）')
    if lt.get('events') != lt.get('wantEvents'):
        fails.append(f'装载口不该动账本（{lt.get("events")} ≠ {lt.get("wantEvents")}）')
    if not (lt.get('ce') or []):
        fails.append(f'装载口没按账本重建 changeEvents（{lt.get("ce")}）')

    detail = (f'v2 剧本涂一笔 → {p1.get("before")}→{p1.get("after")} 条（投影 0 处不同）；'
              f'批量铺底 1→{sub.get("created")} 块：基线/事件/initial 三处旧 id 清零、新省全继承、投影一致；'
              f'铺底后再涂 → {s2.get("events")}→{p2.get("after")} 条（**没退化**，groupId=s139-2）；'
              f'删省 → 账本 {rm.get("before")}→{rm.get("after")} 条、p139b 三处清零；'
              f'面板改日期 → 账本 day={D1080}、再涂一笔后仍在、撤销回 1050；'
              f'落盘 {sr.get("savedEvents")} 条 + 重开 {sr.get("reopenEvents")} 条（投影一致）；'
              f'装载口反向探针：缓存清空后按账本恢复 {len(lt.get("gotKeys") or [])} 个归属键、账本 {lt.get("events")} 条未动')
    if fails:
        return False, '；'.join(fails)[:900]
    return True, detail
