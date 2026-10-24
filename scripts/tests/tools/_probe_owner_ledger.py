#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 4 件第一刀（归属笔 → 账本）的验收探针（2026-10-24）。

判据（每条都带反证/边界）：
  ① 一笔涂归属之后：`scenario.ledger` 多出**同一 groupId** 的事件，provenance=brush，day = 时间轴那天
  ② 账本投影 == v2 缓存（`scenario.ownership`）**逐省一致**（0 处不同）
  ③ 撤销：账本回到这一笔之前（有则回退、无则消失），ownership 也回退；重做再回来
  ④ 落盘 + 重开：`scenario.ledger` 跟着项目文件走（事件条数与 groupId 不变）
  ⑤ 无日期编辑（不传日期）：**不入账**（只写缓存）—— 避免与未接线的写口打架

用法（lab 必须先 up）：
    python scripts/tests/tools/_probe_owner_ledger.py
"""
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for            # noqa: E402
from lib.helpers import open_harness_project  # noqa: E402
import run_tests as RT                       # noqa: E402

SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

ENTER = r"""
(async () => {
  const s = STORE_X;
  if (!s.scenarioEditingModule && !s.scenarios) return JSON.stringify({ __err__: '没有剧本容器' });
  return JSON.stringify({ ok: true });
})()
""".replace('STORE_X', STORE)

SETUP = r"""
(() => {
  const sm = SM_X;
  const s = STORE_X;
  const scn = sm.selectedScenario || (s.scenarios && Object.values(s.scenarios)[0]);
  if (!scn) return JSON.stringify({ __err__: '没有剧本' });
  const pol = (scn.polities || [])[0];
  if (!pol) return JSON.stringify({ __err__: '剧本没有势力' });
  if (typeof sm.selectPolity === 'function') sm.selectPolity(pol);
  sm.setTool('ownerBrush');
  if (typeof sm.fitToView === 'function') sm.fitToView();
  const cvs = document.querySelector('.scenario-map-container canvas');
  const r = cvs.getBoundingClientRect();
  window.__OL = {
    cvs, pol, scnKey: scn.id || scn.key || '',
    mk: (t, x, y) => {
      const rr = cvs.getBoundingClientRect();
      return new MouseEvent(t, {
        clientX: rr.left + x, clientY: rr.top + y, button: 0,
        buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
      });
    },
    ledger: null,
  };
  return JSON.stringify({ polity: pol.id || pol.name, scenario: window.__OL.scnKey, mode: sm.tool });
})()
""".replace('SM_X', SM).replace('STORE_X', STORE)

# 载入账本引擎（Vite dev 下跨 root 的文件走 /@fs/）
LOAD_LEDGER = r"""
(async () => {
  const path = '/@fs/E:/CODE/CangKu/SiTian/src/ledger/index.js';
  const L = await import(path);
  window.__OL.ledger = L;
  return JSON.stringify({ ok: typeof L.projectOwnership === 'function' });
})()
"""

# 涂一笔（真实事件链）
BRUSH = r"""
(() => {
  const T = window.__OL;
  const r = T.cvs.getBoundingClientRect();
  const y = Math.round(r.height * 0.5);
  const x0 = Math.round(r.width * 0.42), x1 = Math.round(r.width * 0.62);
  T.cvs.dispatchEvent(T.mk('mousedown', x0, y));
  for (let x = x0; x <= x1; x += 10) T.cvs.dispatchEvent(T.mk('mousemove', x, y));
  T.cvs.dispatchEvent(T.mk('mouseup', x1, y));
  return 'ok';
})()
"""

STATE = r"""
(() => {
  const s = STORE_X;
  const sm = SM_X;
  const key = window.__OL.scnKey;
  const scn = (s.scenarios || {})[key] || Object.values(s.scenarios || {})[0] || {};
  const ledger = scn.ledger || null;
  const events = (ledger && Array.isArray(ledger.events)) ? ledger.events : [];
  const L = window.__OL.ledger;
  const own = scn.ownership || {};
  const proj = (L && events.length) ? L.projectOwnership(ledger) : null;
  const diff = (L && proj) ? L.diffOwnership(proj, own) : null;
  const tl = sm.tlDate && (sm.tlDate.value || sm.tlDate);
  return JSON.stringify({
    events: events.length,
    groups: [...new Set(events.filter(e => e.groupId).map(e => e.groupId))],
    brushEvents: events.filter(e => e.provenance === 'brush').length,
    lastEvent: events.length ? events[events.length - 1] : null,
    ownershipCount: Object.keys(own).length,
    projectOk: diff ? diff.same : null,
    diffCount: diff ? diff.changed.length : null,
    tlDate: tl || null,
    undoLabel: s.undoLabel,
  });
})()
""".replace('STORE_X', STORE).replace('SM_X', SM)

UNDO = "(() => { STORE_X.undo(); return 'ok'; })()".replace('STORE_X', STORE)
REDO = "(() => { STORE_X.redo(); return 'ok'; })()".replace('STORE_X', STORE)

NO_DATE = r"""
(() => {
  const s = STORE_X;
  const key = window.__OL.scnKey;
  const scn = (s.scenarios || {})[key] || Object.values(s.scenarios || {})[0];
  const terrain = (s.baseMaps[scn.ownerKey] && s.baseMaps[scn.ownerKey].terrain) || [];
  const land = terrain.find(p => p && p.kind !== 'sea');
  if (!land) return JSON.stringify({ __err__: '没有陆地省' });
  const pol = (scn.polities || [])[0];
  const before = (scn.ledger && scn.ledger.events.length) || 0;
  const r = s.batchSetOwnership(scn.id, [land.id], pol.id);   // ← 不传日期
  const cur = s.scenarios[key] || Object.values(s.scenarios)[0];
  const after = (cur.ledger && cur.ledger.events.length) || 0;
  return JSON.stringify({ ok: !!(r && r.success), before, after, changed: !!(r && r.changed) });
})()
""".replace('STORE_X', STORE)

FLUSH = "(() => (async () => { await STORE_X.flushSave(); await window.__probe.flushProject(); return 'ok'; })())()".replace('STORE_X', STORE)

SAVED_LEDGER = r"""
(() => {
  const list = window.__savedProject || [];
  const p = window.__probe.lastProject();
  const dict = (p && p.scenarios && p.scenarios.scenarios) || {};
  const key = window.__OL.scnKey;
  const scn = dict[key] || Object.values(dict)[0] || {};
  const events = (scn.ledger && scn.ledger.events) || [];
  return JSON.stringify({
    savedCount: list.length,
    lastKeys: Object.keys(p || {}),
    scenarioKeys: Object.keys(dict).slice(0, 4),
    scnKeys: Object.keys(scn).slice(0, 8),
    events: events.length,
    groups: [...new Set(events.filter(e => e.groupId).map(e => e.groupId))],
    hasBaseline: events.some(e => e.type === 'epoch.baseline'),
  });
})()
"""


def j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, dict):
        raise RuntimeError('eval 异常：%s' % v)
    if isinstance(v, str) and v.startswith(('{', '[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def main():
    cdp = CDP()
    try:
        cdp.ws.settimeout(180)
        cdp.navigate('http://localhost:5180/?ol=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?ol=%d' % (int(time.time()) + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        open_harness_project(cdp)
        # 进剧本视图
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container canvas')", timeout=30, desc='剧本画布')
        time.sleep(1.2)

        # 装真实 200 省底图（与其它探针同一条链）
        text = None
        for url in ['/__real_desite.map', '/docs/mockups/desite.map']:
            try:
                t = cdp.eval("fetch('%s').then(r => r.ok ? r.text() : '')" % url)
                if isinstance(t, str) and len(t) > 1000000 and 'feature' in t:
                    text = t
                    break
            except Exception:
                pass
        if not text:
            print('🔴 拿不到 desite.map')
            return 1
        cdp.eval("window.__MAPTEXT = " + json.dumps(text) + "; 'ok'")
        print('import:', j(cdp, """(async () => {
          const s = STORE_X;
          const AP = await import('/src/utils/azgaar-parser.js');
          const NAME = '归属账本底图';
          s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(window.__MAPTEXT), NAME, '当前'));
          await new Promise(r => setTimeout(r, 1800));
          const sm = SM_X;
          sm.baseMapKey = NAME;
          if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
          return JSON.stringify({ provinces: (s.baseMaps[NAME].terrain || []).length });
        })()""".replace('STORE_X', STORE).replace('SM_X', SM)))
        time.sleep(0.8)

        cdp.eval("import('/src/store/projectStore.js').then(m => { window.__PS_PROBE = m.useProjectStore(document.querySelector('#app').__vue_app__.config.globalProperties.); return 'ok'; })")
        print('setup:', j(cdp, SETUP))
        print('load ledger:', j(cdp, LOAD_LEDGER))
        time.sleep(0.3)
        s0 = j(cdp, STATE)
        print('涂之前:', s0)

        print('brush:', j(cdp, BRUSH))
        time.sleep(0.9)
        s1 = j(cdp, STATE)
        print('涂之后:', s1)

        j(cdp, UNDO)
        time.sleep(0.5)
        s2 = j(cdp, STATE)
        print('撤销后:', s2)

        j(cdp, REDO)
        time.sleep(0.5)
        s3 = j(cdp, STATE)
        print('重做后:', s3)

        nod = j(cdp, NO_DATE)
        time.sleep(0.4)
        s4 = j(cdp, STATE)
        print('无日期编辑:', nod, '→', {'events': s4['events'], 'projectOk': s4['projectOk']})

        # ── 落盘 + 重开（判据是"过一遍项目文件的那一份"）──────────────────────
        # ⚠️ 这里**显式调一次 saveProject**（与 800ms 防抖走的是同一个函数）：防抖窗口在
        #    探针里会被 undo/redo/无日期编辑反复重置，靠"等一下"取到的是上一份载荷（第一版就这样假红）。
        saved_ev = j(cdp, """(async () => {
          const app = document.querySelector('#app').__vue_app__;
          const ps = (await import('/src/store/projectStore.js')).useProjectStore(app.config.globalProperties.$pinia);
          const fp = ps.filePath;
          const r = await ps.saveProject({ label: 'probe' });
          const p = window.__probe.lastProject();
          const d = (p && p.scenarios && p.scenarios.scenarios) || {};
          const scn = Object.values(d)[0] || {};
          const savedEvents = ((scn.ledger || {}).events || []).length;
          const savedGroups = [...new Set(((scn.ledger || {}).events || []).filter(e => e.groupId).map(e => e.groupId))];
          // 重开：mock 的 projectOpen 读的就是刚才落盘的那一份
          const closed = await ps.closeProject();
          await new Promise((res) => setTimeout(res, 300));
          const opened = await ps.openProject(fp);
          await new Promise((res) => setTimeout(res, 700));
          const s = STORE_X;
          const cur = Object.values(s.scenarios || {})[0] || {};
          const reopenEvents = ((cur.ledger || {}).events || []).length;
          return JSON.stringify({
            ok: !!(r && r.success), error: (r && r.error) || '',
            savedEvents, savedGroups,
            closed: !!(closed && closed.success), reopened: !!(opened && opened.success),
            reopenEvents,
          });
        })()""".replace('STORE_X', STORE))
        print('落盘+重开:', saved_ev)

        fails = []
        if not (s1['events'] > s0['events']):
            fails.append('涂一笔之后账本没长（%s → %s）' % (s0['events'], s1['events']))
        brush_groups = set(s1['groups']) - set(s0['groups'])
        if len(brush_groups) != 1:
            fails.append('这一笔应当只产生 1 个新 groupId，实际 %s' % sorted(brush_groups))
        if s1['brushEvents'] <= s0['brushEvents']:
            fails.append('没有 provenance=brush 的新事件')
        if s1['lastEvent'] and s1['lastEvent'].get('provenance') != 'brush':
            fails.append('最后一条事件不是 brush：%s' % s1['lastEvent'])
        if s1['projectOk'] is not True:
            fails.append('账本投影与缓存不一致（%s 处）' % s1['diffCount'])
        if s2['events'] != s0['events']:
            fails.append('撤销后账本没回到原状（%s ≠ %s）' % (s2['events'], s0['events']))
        if s3['events'] != s1['events']:
            fails.append('重做后账本没回来（%s ≠ %s）' % (s3['events'], s1['events']))
        if nod.get('after') != nod.get('before'):
            fails.append('无日期编辑居然入了账（%s → %s）' % (nod.get('before'), nod.get('after')))
        # ⚠️ saved 是上一段（落盘+重开）的读数
        saved = {}   # 占位：真正的读数在上一段的打印里，见 savedEvents/savedGroups 变量
        if not (saved_ev.get('savedEvents', 0) > 0):
            fails.append('落盘载荷里没有账本（没跟项目文件走）')
        if len(saved_ev.get('savedGroups') or []) < 1:
            fails.append('落盘载荷里的账本没有 groupId')
        if not saved_ev.get('reopened'):
            fails.append('重开失败：%s' % saved_ev.get('error'))
        if saved_ev.get('reopenEvents', 0) != saved_ev.get('savedEvents'):
            fails.append('重开后账本条数变了（%s ≠ %s）' % (saved_ev.get('reopenEvents'), saved_ev.get('savedEvents')))

        print('\n=== 判据 ===')
        print(json.dumps({
            'events_before': s0['events'], 'events_after_brush': s1['events'],
            'new_group_ids': sorted(brush_groups), 'last_event_day': (s1['lastEvent'] or {}).get('day'),
            'tlDate': s1['tlDate'], 'undo_label': s1['undoLabel'],
            'projection_matches_cache': s1['projectOk'],
            'events_after_undo': s2['events'], 'events_after_redo': s3['events'],
            'no_date_edit_events': [nod.get('before'), nod.get('after')],
            'saved_events': saved_ev.get('savedEvents'), 'saved_groups': saved_ev.get('savedGroups'),
            'reopen_events': saved_ev.get('reopenEvents'),
            'fails': fails,
        }, ensure_ascii=False, indent=1))
        return 0 if not fails else 1
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
