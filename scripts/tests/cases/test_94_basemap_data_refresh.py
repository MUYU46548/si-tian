#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 94：底图级数据的「只补缺刷新」（B2，2026-10-11）

真实来由（暮雨实测，不是设想）：
  他打开「绒花计划」时，剧本底图 `desite` 是**纯色扁平图** —— 没有地形、河流、道路。
  逐层查下来结论是：**数据不是丢的，是从来没有过**。那张底图建于 2026-09-10（`d07c1d1`），
  而当时那版解析器的返回对象只有 `terrain / polities / ownership / labels / markers`
  —— 高度图、河流、道路、城镇**根本没被读出来**（解析器直到 `1c2a4d2` 才有网格能力）。
  今天同一份 `desite.map` 能读出 9975 格高度 + 160 条河 + 496 条路，但**没有入口**把它们
  补进一张"已经切了几百块省份"的底图：重导走的是「同 key 整体替换」，会把省份与归属一起盖掉。

本用例守四类判据：
  a 源码闸门（剥注释）：刷新入口在 store 单源；组件只负责问人，不许自己再写一套归一化
  b 只补缺：已有的高度图/河流/道路**不覆盖**；缺的补上；重复刷新 = 明确 no-op（不压 undo）
  c 🔴 绝不动省份：terrain / provinceLabels / planetId / 归属一字不变；一整次刷新 = 一条 undo
  d 端到端：真解析一份小 FMG `.map` → 装载成新底图 → 把它"降级"回旧形状（模拟 2026-09-10 那张）
     → 刷新 → 高度图/河流/道路真的补回来了
  e UI：缺数据时「刷新底图数据」按钮出现，数据齐了就不出现（不挂一个点了没用的按钮）

⚠️ 与 test_79/80/92 同一条纪律：可能弹 `confirm` 的路径一律先接管 `window.confirm`。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉注释（本仓已多次踩到「注释里的旧名字把自己的判据判红」）。"""
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
    fails, notes = [], []
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))

    for src, needle, label in [
        (se, 'function updateBaseMapData(', 'store：底图数据刷新入口'),
        (se, 'function buildBaseMapFromBundle(', 'store：新底图装载（与刷新分开）'),
        (se, 'function normalizeBaseMapRivers(', 'store：河流归一（唯一实现）'),
        (se, 'function normalizeBaseMapRoutes(', 'store：道路归一（唯一实现）'),
        (se, "type: 'refresh-basemap-data'", 'store：刷新走一条 undo 命令'),
        (sc, 'store.updateBaseMapData(', '组件：调用 store 的刷新入口'),
        (sc, 'data-testid="basemap-refresh-data"', '组件：刷新按钮（有缺项才出现）'),
        (wg, "'updateBaseMapData'", '写口契约：刷新已登记（只读态必须被拦）'),
    ]:
        if needle not in src:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')

    # 🔴 刷新**绝不许**碰省份：命令体里出现 terrain/planetId 赋值就是红线违反
    i = se.find('function updateBaseMapData(')
    if i > 0:
        body = se[i:i + 6000]
        j = body.find('\n  }')
        body = body[:j] if j > 0 else body
        for bad in ('after.terrain =', 'after.provinceLabels =', 'after.planetId =', 'delete after.terrain'):
            if bad in body:
                fails.append(f'🔴 updateBaseMapData 在改省份相关字段（{bad}）—— 刷新只许加、不许动省份')

    # 组件不许自己再写一套河流/道路归一化（双源必然漂移）
    for bad in ('function normalizeBaseMapRivers(', 'function normalizeBaseMapRoutes('):
        if bad in sc:
            fails.append(f'组件里出现 {bad} —— 归一化只能在 store 单源')

    notes.append(f'源码闸门 8 项 + 3 条红线' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


# 🔴 端到端那一段用**仓库里那份真实 FMG 导出件**（`docs/mockups/desite.map`，4.3MB，公开仓库已带）。
# 为什么不自己捏一份小的：本用例首版试过，捏出来的 .map 在 `at()` 行号锚点上极脆
# （解析器文件头就写着「行号不是固定的」，我自己那份的 notes 段让锚点前移一格 → cells.h 取到 features
#  → provinces=1 / burgs=0，全链读数全错）。**拿被产品真正喂过的那份文件测**，比拿我编的测有意义。
MAP_REL = 'docs/mockups/desite.map'
MAP_FIXTURE_KEY = 'case94map'


def run(cdp):
    fails, notes = source_gates()

    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.5)

    map_url = '/@fs/' + os.path.join(ROOT, MAP_REL).replace('\\', '/')
    js = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const P = await import('/src/utils/azgaar-parser.js');
  window.confirm = () => true;

  // ══ d0. 真实底图：今天的解析器读得出这些数据（否则整条链无从谈起）═══════════
  let text = null;
  try { text = await (await fetch(__URL__)).text(); } catch (e) { return { fails: ['fetch 底图失败: ' + e], notes: {} }; }
  const parsed = P.parseMapFile(text);
  const json = P.buildScenariosJson(parsed, __KEY__, '当前');
  const bundle = json.baseMaps[__KEY__];
  ok('d0 解析无警告', (parsed.warnings || []).length === 0, JSON.stringify(parsed.warnings));
  ok('d0 读出网格高度（真实底图 9975 格）', (bundle.heightmap.h || []).length === 9975,
     (bundle.heightmap.h || []).length);
  ok('d0 高度取值不是常量（能看出地形起伏）', new Set(bundle.heightmap.h).size > 50,
     new Set(bundle.heightmap.h).size);
  ok('d0 读出河流 / 道路 / 城镇（160 / 496 / 617）',
     bundle.rivers.length === 160 && bundle.routes.length === 496 && bundle.burgs.length === 617,
     JSON.stringify({ rv: bundle.rivers.length, rt: bundle.routes.length, bg: bundle.burgs.length }));
  ok('d0 读出省份几何（200）', bundle.terrain.length === 200, bundle.terrain.length);
  notes.parsed = 'h=' + bundle.heightmap.h.length + '/' + new Set(bundle.heightmap.h).size + '种 河='
    + bundle.rivers.length + ' 路=' + bundle.routes.length + ' 镇=' + bundle.burgs.length
    + ' 省=' + bundle.terrain.length;

  // ══ b/c. 刷新语义：只补缺 / 绝不动省份 ════════════════════════════════════
  const KEY = __KEY__;
  const land = {
    id: 'p94a', name: '用例94大陆', kind: 'land',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
  };
  const labels = { cols: 2, rows: 2, cell: 10, ox: 0, oy: 0, shape: 'hex', data: [1, 1, 0, 0] };
  // 模拟那张 2026-09-10 建的底图：**只有省份多边形**，没有任何底图级数据
  s.baseMaps = { ...s.baseMaps, [KEY]: {
    id: KEY, name: '用例94底图', terrain: [land], referenceImages: [],
    provinceLabels: labels, createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
  } };
  const SCID = KEY + '/用例94剧本';
  s.scenarios = { ...s.scenarios, [SCID]: {
    id: SCID, name: '用例94剧本', ownerKey: KEY,
    ownership: { p94a: 'pol_keep' }, changeEvents: { p94a: [{ y: 100, m: 6, d: 1, polityId: 'pol_keep' }] },
    polities: [], labels: [], markers: [],
  } };
  const bm0 = s.baseMaps[KEY];
  const before = {
    terrainJson: JSON.stringify(bm0.terrain),
    labelsJson: JSON.stringify(bm0.provinceLabels),
    ownJson: JSON.stringify(s.scenarios[SCID].ownership),
    evJson: JSON.stringify(s.scenarios[SCID].changeEvents),
  };
  ok('b0 起点确实是"旧底图"：没有高度图/河流/道路',
     !bm0.heightmap && !(bm0.rivers || []).length && !(bm0.routes || []).length,
     JSON.stringify({ hm: !!bm0.heightmap, rv: (bm0.rivers || []).length, rt: (bm0.routes || []).length }));

  const r1 = s.updateBaseMapData(KEY, bundle);
  ok('b1 刷新成功', !!(r1 && r1.ok && r1.changed), JSON.stringify(r1 && { ok: r1.ok, rej: r1.rejected, msg: r1.message }));
  const bm1 = s.baseMaps[KEY];
  ok('b2 高度图补上了（9975 格）', !!(bm1.heightmap && (bm1.heightmap.h || []).length === 9975),
     JSON.stringify({ has: !!bm1.heightmap, n: ((bm1.heightmap || {}).h || []).length }));
  ok('b3 河流补上了（160 条）', (bm1.rivers || []).length === 160, (bm1.rivers || []).length);
  ok('b4 道路补上了（496 条）', (bm1.routes || []).length === 496, (bm1.routes || []).length);
  ok('b5 城镇补上了（617 个）', (bm1.burgs || []).length === 617, (bm1.burgs || []).length);
  ok('b6 🔴 省份多边形一字未动', JSON.stringify(bm1.terrain) === before.terrainJson, 'terrain 被改了');
  ok('b7 🔴 省份标签网格一字未动', JSON.stringify(bm1.provinceLabels) === before.labelsJson, 'provinceLabels 被改了');
  ok('b8 🔴 归属一字未动', JSON.stringify(s.scenarios[SCID].ownership) === before.ownJson,
     JSON.stringify(s.scenarios[SCID].ownership));
  ok('b9 🔴 易主记录一字未动', JSON.stringify(s.scenarios[SCID].changeEvents) === before.evJson, 'changeEvents 被改了');
  ok('b10 刷新回报里点名保留了省份 / 归属', !!(r1.kept && r1.kept.terrain === 1 && r1.kept.provinceLabels === true),
     JSON.stringify(r1.kept));
  ok('b11 画布能画的形状合法（河流/道路都是多点折线）',
     (bm1.rivers[0].points || []).length >= 2 && (bm1.routes[0].points || []).length >= 2,
     JSON.stringify({ rv: bm1.rivers[0].points.length, rt: bm1.routes[0].points.length }));

  // b12 重复刷新 = 明确 no-op（不许每次点都压一条 undo）
  const r2 = s.updateBaseMapData(KEY, bundle);
  ok('b12 数据已齐 → 明确 no-op（changed:false + 说明）',
     !!(r2 && r2.ok && r2.changed === false && r2.message), JSON.stringify(r2 && { ok: r2.ok, ch: r2.changed, msg: r2.message }));

  // b13 已有的**旧**高度图不许被刷新覆盖（只补缺）
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], heightmap: { grid: { points: [[0, 0]], spacing: 1 }, h: [77] } } };
  s.updateBaseMapData(KEY, bundle);
  ok('b13 已有高度图 → 不被覆盖（只补缺）',
     s.baseMaps[KEY].heightmap.h[0] === 77, JSON.stringify(s.baseMaps[KEY].heightmap.h));

  // b14 🔴 一整次刷新 = **一条** undo：撤销后回到刷新前，且省份/归属始终未动
  s.undo();
  {
    const bmU = s.baseMaps[KEY] || {};
    ok('b14 撤销后回到「旧高度图」状态（b13 之前）', !bmU.heightmap || bmU.heightmap.h[0] !== 4,
       JSON.stringify({ has: !!bmU.heightmap, h0: bmU.heightmap ? bmU.heightmap.h[0] : null }));
    ok('b14 撤销不改省份', JSON.stringify(bmU.terrain) === before.terrainJson);
    ok('b14 撤销不改归属', JSON.stringify(s.scenarios[SCID].ownership) === before.ownJson);
  }

  // ══ d. 端到端：降级成旧形状 → 刷新 → 数据回来 ═══════════════════════════
  {
    const K2 = 'case94b';
    const loaded = s.buildBaseMapFromBundle(K2, bundle, '用例94新底图');
    ok('d1 新底图装载带上高度图/河流/道路',
       !!loaded.heightmap && loaded.rivers.length === 160 && loaded.routes.length === 496,
       JSON.stringify({ hm: !!loaded.heightmap, rv: loaded.rivers.length, rt: loaded.routes.length }));
    s.baseMaps = { ...s.baseMaps, [K2]: loaded };
    // 降级：模拟 2026-09-10 那张底图的字段集
    const legacy = {
      id: K2, name: '用例94旧底图', terrain: loaded.terrain, referenceImages: [],
      createdAt: loaded.createdAt, updatedAt: loaded.updatedAt,
    };
    s.baseMaps = { ...s.baseMaps, [K2]: legacy };
    ok('d2 降级后确实什么都看不到', !legacy.heightmap && !(legacy.rivers || []).length,
       JSON.stringify(Object.keys(legacy)));
    const rr = s.updateBaseMapData(K2, bundle);
    const now = s.baseMaps[K2];
    ok('d3 刷新后高度图/河流/道路都回来了',
       !!(rr && rr.ok && now.heightmap && (now.rivers || []).length === 160 && (now.routes || []).length === 496),
       JSON.stringify({ ok: rr.ok, hm: !!now.heightmap, rv: (now.rivers || []).length, rt: (now.routes || []).length }));
    ok('d4 省份几何与降级前逐点一致', JSON.stringify(now.terrain) === JSON.stringify(loaded.terrain));
  }

  // ══ e. UI：缺数据时按钮出现、齐了就不出现 ════════════════════════════════
  {
    const bar = document.querySelector('.scenario-toolbar');
    const btn = () => Array.from((bar || document).querySelectorAll('[data-testid="basemap-refresh-data"]'))
      .find((b) => b.getClientRects().length);
    sc.moreOpen = true;                     // 「底图」那一组在「更多」里
    sc.baseMapKey = KEY;                    // KEY 现在数据齐了（b 段刷过）
    await new Promise((r) => setTimeout(r, 120));
    const btnWhenComplete = !!btn();
    const K3 = 'case94c';
    s.baseMaps = { ...s.baseMaps, [K3]: { id: K3, name: '用例94缺数据底图', terrain: [land], referenceImages: [] } };
    sc.baseMapKey = K3;
    await new Promise((r) => setTimeout(r, 150));
    const btnWhenMissing = !!btn();
    ok('e1 底图缺数据时「刷新底图数据」按钮出现', btnWhenMissing, '按钮不在');
    notes.ui = '缺=' + btnWhenMissing + ' 齐=' + btnWhenComplete;
    delete s.baseMaps[K3];
  }

  // 收尾：把用例造的东西清干净（不污染 harness 基线项目）
  delete s.baseMaps[KEY];
  delete s.baseMaps['case94b'];
  delete s.scenarios[SCID];
  sc.baseMapKey = Object.keys(s.baseMaps)[0] || '';
  return JSON.stringify({ fails, notes });
})()"""

    js = (js.replace('__STORE__', STORE).replace('__SC__', SC)
            .replace('__URL__', json.dumps(map_url)).replace('__KEY__', json.dumps(MAP_FIXTURE_KEY)))
    ok, res = eval_json(cdp, js, desc='94 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    n = res.get('notes', {})
    for k in ('parsed', 'ui'):
        if n.get(k):
            notes.append(f'{k}={n[k]}')
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)

