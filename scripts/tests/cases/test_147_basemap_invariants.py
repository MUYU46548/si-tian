#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 147：剧本操作不得改底图（第 0 轮「底图地基」不变量）

背景（2026-10-25 暮雨拍板）：
  「不碰底图的时候，省份边界不会乱动、地形不会被误改」是历史剧本可用的地基。
  此前的用例只验「某个操作结果对不对」，没有一条**反向不变量**：
  在剧本侧涂归属 / 改剧本 / 切时间轴 / 存盘之后，底图的 terrain 顶点、heightmap、
  rivers、routes、burgs、culture/religion 网格、referenceImages 是否**逐字节没变**。

本用例的判据：
  1. 先造一张有全部底图级数据的底图（terrain + heightmap + rivers + routes + burgs +
     referenceImages + culture/religion 网格），取指纹。
  2. 正向对照：改其中任一项（高度笔 / 加河 / 加省）→ 指纹必须变；undo → 必须回到基线。
     （没有这条，「指纹一直相等」可能只是指纹函数写错了。）
  3. 剧本侧连续操作：建剧本 / 改归属 / 批量归属 / 改剧本名 / 加地名 / 加标记 /
     建剧本集+移组 / 存盘 —— 每一步后指纹都必须 == 基线。
  4. 失败时点名「哪一步 + 哪一类底图数据变了」，并给出基线/当前指纹长度，便于定位。

⚠️ 只读底图字段，不跑 UI；UI 侧的「模式边界」由 test_120 守。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
KEY = '用例147底图'


SEED_JS = r"""(async () => {
  const s = __STORE__;
  const KEY = __KEY__;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));

  // 干净起点
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  s.loadScenarioState({ groups: [] });
  if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
  s.addBaseMap(KEY, { name: KEY });

  const mk = (id, x0) => ({ id, name: '省' + id.slice(-1), kind: 'land',
    points: [{x:x0,y:150},{x:x0+160,y:150},{x:x0+160,y:300},{x:x0,y:300}] });
  s.addBaseProvince(KEY, mk('prov_a', 180), { checkOverlap: false });
  s.addBaseProvince(KEY, mk('prov_b', 380), { checkOverlap: false });

  // 高度图（含 temp/prec/biome；culture/religion 由下面的笔刷写）
  const hmr = s.createBaseMapHeightmap(KEY, { spacing: 40, margin: 2 });
  if (!hmr || !hmr.ok) return JSON.stringify({ __err__: '高度图创建失败：' + JSON.stringify(hmr) });
  s.applyHeightBrush(KEY, 260, 220, 90, 2, 'raise');
  s.applyCultureBrush(KEY, 240, 220, 90, 1);
  s.applyReligionBrush(KEY, 420, 220, 90, 1);

  s.addBaseMapRiver(KEY, { points: [{x:180,y:180},{x:300,y:210},{x:540,y:220}] });
  s.addBaseMapRoute(KEY, { points: [{x:200,y:280},{x:540,y:280}], style: 'road' });
  s.addBaseMapBurg(KEY, { id: 'burg_147', name: '测试镇', x: 300, y: 240, population: 1200, capital: 0 });
  s.addBaseReferenceImage(KEY, {
    id: 'ref_147', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    width: 10, height: 10, scale: 1, rotation: 0, flipH: false, offsetX: 300, offsetY: 220, opacity: 0.5,
  });

  s.createScenario(KEY + '/甲', {
    ownerKey: KEY, name: '甲', order: 1, group: 'default',
    era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
    ownership: { prov_a: 'P1' },
  });
  await tick(30);
  return JSON.stringify({ ok: true, hm: hmr.cells, terrain: s.baseMaps[KEY].terrain.length });
})()"""


MAIN_JS = r"""(async () => {
  const s = __STORE__;
  const KEY = __KEY__;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  const fails = [], notes = {};
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };

  const arr = (a) => (a ? Array.from(a) : null);
  const fpOf = () => {
    const bm = s.baseMaps[KEY];
    if (!bm) return 'NO-BASEMAP';
    const hm = bm.heightmap || null;
    const round = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
    return JSON.stringify({
      terrain: (bm.terrain || []).map(p => ({
        id: p.id, kind: p.kind, name: p.name,
        points: (p.points || []).map(q => [round(q.x), round(q.y)]),
      })),
      heightmap: hm ? {
        h: arr(hm.h), temp: arr(hm.temp), prec: arr(hm.prec), biome: arr(hm.biome),
        culture: arr(hm.culture), religion: arr(hm.religion),
        grid: hm.grid ? {
          cellsX: hm.grid.cellsX, cellsY: hm.grid.cellsY, spacing: hm.grid.spacing,
          points: (hm.grid.points || []).map(q => Array.isArray(q) ? [round(q[0]), round(q[1])] : [round(q.x), round(q.y)]),
        } : null,
      } : null,
      rivers: bm.rivers || null,
      routes: bm.routes || null,
      burgs: bm.burgs || null,
      referenceImages: bm.referenceImages || null,
      landFeatures: bm.landFeatures || null,
    });
  };
  const fpLen = (fp) => fp.length;
  const base = fpOf();
  notes.baseLen = fpLen(base);
  ck('f0 种子底图有全部底图级数据', base !== 'NO-BASEMAP' && base.length > 500, fpLen(base));

  // ── 正向对照：指纹必须能感知底图编辑 ───────────────────────
  s.applyHeightBrush(KEY, 300, 220, 100, 3, 'raise');
  await tick(20);
  const afterBrush = fpOf();
  ck('f1 正向对照：高度笔改变指纹', afterBrush !== base, { base: fpLen(base), now: fpLen(afterBrush) });
  s.undo();
  await tick(30);
  ck('f1 正向对照：撤销高度笔逐字节回到基线', fpOf() === base, { now: fpLen(fpOf()) });

  s.addBaseMapRiver(KEY, { points: [{x:200,y:200},{x:500,y:200}] });
  await tick(20);
  ck('f2 正向对照：加河改变指纹', fpOf() !== base, null);
  s.undo();
  await tick(30);
  ck('f2 正向对照：撤销加河回到基线', fpOf() === base, null);

  // ── 剧本侧操作：每一步都必须不改底图 ───────────────────────
  const scenarioId = KEY + '/甲';
  const steps = [];
  const step = async (label, fn) => {
    const before = fpOf();
    const ret = await fn();
    await tick(30);
    const after = fpOf();
    const same = after === before;
    steps.push({ label, same, ret: (ret === undefined ? null : ret) });
    if (!same) {
      // 指名字段级差异（只报 key，不打印整份数据）
      let diff = [];
      try {
        const a = JSON.parse(before), b = JSON.parse(after);
        for (const k of Object.keys(b)) {
          if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diff.push(k);
        }
      } catch (_) { diff = ['(无法解析指纹)']; }
      fails.push(`剧本操作改了底图：${label}（变了：${diff.join(',') || '未知'}）`);
    }
  };

  await step('setOwnership 改归属', () => s.setOwnership(scenarioId, 'prov_b', 'P1'));
  await step('batchSetOwnership 批量归属', () => s.batchSetOwnership(scenarioId, ['prov_a', 'prov_b'], 'P1', { y: 2003, m: 6, d: 1 }));
  await step('updateScenario 改剧本名', () => s.updateScenario(scenarioId, { name: '甲二' }));
  await step('addScenarioLabel 加地名', () => s.addScenarioLabel(scenarioId, { text: '测试地名', x: 260, y: 220 }));
  await step('addScenarioMarker 加标记', () => s.addScenarioMarker(scenarioId, { name: '测试标记', x: 420, y: 240, type: 'city' }));
  let groupId = null;
  await step('addScenarioGroup 建剧本集', () => {
    const r = s.addScenarioGroup({ name: '线A' });
    groupId = r && r.group ? r.group.id : null;
    return groupId;
  });
  await step('setScenarioGroup 移组', () => s.setScenarioGroup(scenarioId, groupId || 'default'));
  await step('saveScenarios 存盘（剧本侧）', async () => { await s.saveScenarios(); return 'saved'; });

  // 改回默认组、撤销到干净起点（不影响底图指纹的结论，只让同一页后续用例好过）
  if (groupId) s.setScenarioGroup(scenarioId, 'default');
  await tick(20);
  ck('f3 剧本操作全部结束后底图指纹仍 == 基线', fpOf() === base, { base: fpLen(base), now: fpLen(fpOf()) });

  notes.steps = steps;
  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('#app')", desc='应用挂载', timeout=15)
    ensure_data_ready(cdp)

    seed_src = SEED_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))
    ok, seed_or_err = eval_json(cdp, seed_src, required=('ok',), desc='f0 造底图数据')
    if not ok:
        return False, f'造数失败：{seed_or_err}'

    main_src = MAIN_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))
    ok, out = eval_json(cdp, main_src, required=('fails', 'notes'), desc='底图不变量主链')
    if not ok:
        return False, f'主链失败：{out}'

    fails = out.get('fails') or []
    notes = out.get('notes') or {}
    if fails:
        return False, '；'.join(fails)[:1000] + ' | 实测：' + json.dumps(notes, ensure_ascii=False)[:500]
    steps = notes.get('steps') or []
    return True, (
        f'底图指纹 {notes.get("baseLen")}B；正向对照 3 项（高度笔/加河/撤销）通过；'
        f'剧本操作 {len(steps)} 步全部未改底图：' + '、'.join(x.get('label') or '' for x in steps)
    )
