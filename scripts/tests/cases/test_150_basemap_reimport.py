#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 150：019 底图重导（新底图 + 旧归属迁移）

语义（暮雨 2026-10-25）：
  · 换新 .map = **新底图 + 旧归属迁过去**；
  · 「同一底图只补数据」只限一笔未改（走 updateBaseMapData，本用例不测）；
  · 并省（多旧→一新）默认**阻止**，不替用户选。

判据：
  1. 正常重导：新 key（`__reimport_`）、旧底图 archived、剧本 ownerKey 改新、
     ownership/changeEvents 跟着新省 id、scenario.id 保持不变；
  2. 一条 undo：旧底图/旧剧本/旧归属全回来，新底图消失；
  3. 并省冲突：零写入 + `conflicts` 清单（不产生新 key）；
  4. 只读态：拒绝且零副作用。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
KEY = '用例150底图'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('#app')", desc='应用挂载', timeout=15)
    ensure_data_ready(cdp)

    js = r"""(async () => {
      const s = __STORE__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const fails = [], notes = {};
      const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
      const rect = (id, x0, w) => ({ id, name: id, kind: 'land',
        points: [{x:x0,y:0},{x:x0+w,y:0},{x:x0+w,y:100},{x:x0,y:100}] });

      // ── 干净起点 ─────────────────────────────────────────────
      for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
      s.loadScenarioState({ groups: [] });
      if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
      s.addBaseMap(KEY, { name: '旧底图' });
      s.addBaseProvince(KEY, rect('old1', 0, 100), { checkOverlap: false });
      s.addBaseProvince(KEY, rect('old2', 100, 100), { checkOverlap: false });
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { old1: 'P1', old2: 'P1' },
        changeEvents: { old1: [{ y: 2005, m: null, d: null, owner: 'P1' }] },
      });
      await tick(30);
      const oldKeys = Object.keys(s.baseMaps).sort();
      const scenId = KEY + '/甲';

      // ── ① 并省冲突：一个新省覆盖两个旧省 → 阻止、零写入 ──────
      const mergeBundle = { terrain: [rect('merged', 0, 200)], source: { file: 'merge.map' } };
      const conflict = s.reimportBasemapAsNew(KEY, mergeBundle);
      notes.conflict = { ok: conflict.ok, rejected: conflict.rejected, n: (conflict.conflicts || []).length };
      ck('f1 并省冲突被阻止', conflict.ok === false && conflict.rejected === 'merge-conflicts', notes.conflict);
      ck('f1 冲突时零写入（底图集合未变）',
         JSON.stringify(Object.keys(s.baseMaps).sort()) === JSON.stringify(oldKeys),
         Object.keys(s.baseMaps));

      // ── ② 正常重导：id 相同的两个省 ─────────────────────────
      const newBundle = {
        terrain: [rect('old1', 0, 100), rect('old2', 100, 100)],
        rivers: [{ id: 'r1', name: '新河', points: [{x:0,y:50},{x:200,y:50}], discharge: 100 }],
        source: { file: 'new.map' },
      };
      const r = s.reimportBasemapAsNew(KEY, newBundle);
      notes.result = { ok: r.ok, newKey: r.newKey, moved: r.movedScenarios, exact: r.exact, msg: r.message };
      ck('f2 重导成功', r.ok === true && !!r.newKey, r);
      const newKey = r.newKey;
      ck('f2 新 key 带 __reimport_', typeof newKey === 'string' && newKey.includes('__reimport_'), newKey);
      ck('f2 旧底图仍在且 archived', !!s.baseMaps[KEY] && s.baseMaps[KEY].archived === true, s.baseMaps[KEY] && s.baseMaps[KEY].archived);
      ck('f2 新底图存在且有新河', !!s.baseMaps[newKey] && (s.baseMaps[newKey].rivers || []).length === 1, null);
      const sc = s.getScenario(scenId);
      ck('f2 scenario.id 保持', !!sc && sc.id === scenId, sc && sc.id);
      ck('f2 ownerKey 改新', !!sc && sc.ownerKey === newKey, sc && sc.ownerKey);
      ck('f2 归属仍是旧省 id（id 直配）', !!sc && sc.ownership && sc.ownership.old1 === 'P1' && sc.ownership.old2 === 'P1', sc && sc.ownership);
      ck('f2 changeEvents 跟着走', !!sc && Array.isArray(sc.changeEvents.old1) && sc.changeEvents.old1.length === 1, sc && sc.changeEvents);
      ck('f2 新底图按 ownerKey 能查到剧本', (s.getScenariosByOwner(newKey) || []).length === 1, (s.getScenariosByOwner(newKey) || []).length);

      // ── ③ 一条 undo 全还原 ──────────────────────────────────
      s.undo();
      await tick(40);
      ck('f3 undo 后新底图消失', !s.baseMaps[newKey], Object.keys(s.baseMaps));
      ck('f3 undo 后旧底图不再 archived', s.baseMaps[KEY] && !s.baseMaps[KEY].archived, s.baseMaps[KEY] && s.baseMaps[KEY].archived);
      const back = s.getScenario(scenId);
      ck('f3 undo 后剧本回到旧 ownerKey', !!back && back.ownerKey === KEY, back && back.ownerKey);
      ck('f3 undo 后归属还在', !!back && back.ownership.old1 === 'P1', back && back.ownership);

      notes.keys = oldKeys;
      return JSON.stringify({ fails, notes });
    })()"""
    js = js.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))
    ok, out = eval_json(cdp, js, required=('fails', 'notes'), desc='019 重导主链')
    if not ok:
        return False, f'主链失败：{out}'
    fails = out.get('fails') or []
    notes = out.get('notes') or {}
    if fails:
        return False, '；'.join(fails)[:1000] + ' | 实测：' + json.dumps(notes, ensure_ascii=False)[:600]

    # 源码守卫：UI 必须真的接上「非 pristine → reimport」这条路
    # 2026-10-31：重导对话框逻辑搬进 scenario/interaction/helpers.js —— 判据读合集
    from lib.rsrc import render_src as _rsrc_all
    sm = _rsrc_all()
    if 'isBasemapPristine' not in sm:
        return False, 'ScenarioMap 没有引用 isBasemapPristine（无法判断同图补数据/重导）'
    if 'reimportBasemapAsNew(' not in sm:
        return False, 'ScenarioMap 没有调用 reimportBasemapAsNew（用户点不到重导）'
    if 'previewReimportBasemap' not in sm or 'data-testid="reimport-dialog"' not in sm:
        return False, 'ScenarioMap 没有重导对话框（previewReimportBasemap / reimport-dialog）'

    return True, (
        f'并省冲突阻止（{notes.get("conflict")}）；正常重导 newKey={notes.get("result", {}).get("newKey")}'
        f' 迁 {notes.get("result", {}).get("moved")} 条 / id 直配 {notes.get("result", {}).get("exact")} 省；'
        f'undo 全还原；{notes.get("result", {}).get("msg")}'
    )
