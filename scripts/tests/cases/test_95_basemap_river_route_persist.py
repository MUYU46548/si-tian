#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 95：底图侧的河流 / 道路 / 聚落写入必须落盘（D，2026-10-11）

真实来由（暮雨实测）：
  「河流道路之类的东西在哪里？怎么画上去？一堆图层但是好像根本没编辑入口。」
  查下来是三件事：
    ① **手画的河从来没有落过盘** —— 组件里 `finishRiverDraft` 只 push 进一个组件本地数组
       （`riverPaths`），全仓没有任何一处写进 store；重开应用河就没了，而且一声不响。
    ② **手画的路绕过了 undo 与自动保存** —— 组件直接 `store.baseMaps = {...}` 手搓替换，
       既不在撤销栈里，也不排自动保存（只能碰巧赶上别的保存）。
    ③ **聚落编辑同款**（`Object.assign` 直改 store 活对象 + 手搓替换）。
  另外，2026-09-10 那次导入建出的底图里 `rivers` / `routes` **根本不存在**（当时解析器读不出来），
  所以"画布上一条河一条路都没有"——这一点由 test_94 的刷新覆盖。

本用例守四类判据：
  a 源码闸门（剥注释）：写入只在 store 单源；组件里不许再出现「手搓 store.baseMaps」与本地 riverPaths
  b store CRUD：加/删各一条 undo；redo/undo 幂等；**删除后撤销放回原位**（层叠顺序）；
     找不到 id 时给明确回执（不静默）
  c 端到端落盘：画一条河 / 一条路 → flush → **项目文件载荷里真的有它们**（含样式字段）
  d 只读/无底图护栏：明确拒绝而不是静默 return
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
        (se, 'function addBaseMapRiver(', 'store：加河流'),
        (se, 'function removeBaseMapRiver(', 'store：删河流'),
        (se, 'function addBaseMapRoute(', 'store：加道路'),
        (se, 'function removeBaseMapRoute(', 'store：删道路'),
        (se, 'function updateBaseMapBurg(', 'store：改聚落'),
        # ⚠️ 2026-10-18 第十八修·三：组件画河改走**原子写口** `applyBaseMapRiverEdit`
        #    （「加河 + 在母河插拐点」= 一条撤销；橡皮擦断一条河也是它）。判据的**意思没变**：
        #    手画的河必须经 store，不许再出现组件本地数组。
        (sc, 'store.applyBaseMapRiverEdit(', '组件：画河流走 store（原子写口）'),
        (se, 'function applyBaseMapRiverEdit(', 'store：原子写口（改/加/删合计一条撤销）'),
        (wg, "'applyBaseMapRiverEdit'", '写口契约：原子写口已登记'),
        (sc, 'store.addBaseMapRoute(', '组件：画道路走 store'),
        (sc, 'store.updateBaseMapBurg(', '组件：改聚落走 store'),
        (wg, "'addBaseMapRiver'", '写口契约：河流已登记'),
        (wg, "'addBaseMapRoute'", '写口契约：道路已登记'),
        # 2026-10-13：旧数据里的聚落（markers 派生）必须能被编辑 —— 整批登记 + 同一条 undo
        (se, 'promote-legacy-burgs', 'store：登记旧聚落的命令（与编辑同一条 undo）'),
        (se, 'opts.materialize', 'store：改聚落支持"就地登记"这一路'),
        (sc, 'materialize: legacySeeds', '组件：旧数据聚落整批登记后再应用编辑'),
    ]:
        if needle not in src:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')

    # 🔴 红线：组件里不许再有「手搓 store.baseMaps = {...}」这条绕过路
    if 'store.baseMaps = {' in sc:
        fails.append('🔴 组件里仍存在 `store.baseMaps = {...}` 手搓替换（绕开 undo 与自动保存调度）')
    # 🔴 红线：本地 riverPaths 这条平行事实源不许复活
    # ⚠️ 判据必须**精确到"声明/赋值的本地变量"**，不能裸匹配子串：
    #    组件里合法地存在 `drawRiverPaths`（画河函数名）—— 裸子串匹配会把它一起判红。
    #    （2026-10-17 实测：我把新纯函数模块命名为 `riverPaths.js` 时，这条判据误报过一次。）
    import re as _re
    if _re.search(r'\b(?:const|let|var)\s+riverPaths\b', sc):
        fails.append('🔴 组件里又有 `const/let riverPaths` 本地数组（手画的河会再次"画完就丢"）')

    notes.append('源码闸门 13 项 + 2 条红线' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


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

    js = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  window.confirm = () => true;

  const KEY = 'case95';
  const land = { id: 'p95a', name: '用例95陆地', kind: 'land',
    points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }] };
  s.baseMaps = { ...s.baseMaps, [KEY]: {
    id: KEY, name: '用例95底图', terrain: [land], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  sc.baseMapKey = KEY;
  await new Promise((r) => setTimeout(r, 80));

  // ══ b) store CRUD：加/删各一条 undo，删除撤销放回原位 ═════════════════════
  {
    const r1 = s.addBaseMapRiver(KEY, { points: [{ x: 10, y: 10 }, { x: 40, y: 30 }, { x: 60, y: 70 }] });
    ok('b1 加河流成功', !!(r1 && r1.ok), JSON.stringify(r1));
    ok('b1 河里真的有一条了', (s.baseMaps[KEY].rivers || []).length === 1, (s.baseMaps[KEY].rivers || []).length);
    ok('b1 河流有合法几何（≥2 点，坐标均为数）', (() => {
      const r = (s.baseMaps[KEY].rivers || [])[0];
      return !!r && r.points.length >= 2 && r.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    })());
    s.undo();
    ok('b2 一条 undo 撤掉河流', (s.baseMaps[KEY].rivers || []).length === 0, (s.baseMaps[KEY].rivers || []).length);
    s.redo();
    ok('b2 redo 恢复河流', (s.baseMaps[KEY].rivers || []).length === 1);

    // 删除 → 撤销必须放回原位（渲染层叠顺序）
    const r2 = s.addBaseMapRiver(KEY, { points: [{ x: 5, y: 5 }, { x: 15, y: 25 }], name: '第二条河' });
    ok('b3 第二条河加上了', !!(r2 && r2.ok) && (s.baseMaps[KEY].rivers || []).length === 2);
    const firstId = s.baseMaps[KEY].rivers[0].id;
    const order0 = s.baseMaps[KEY].rivers.map((r) => r.id).join(',');
    const rd = s.removeBaseMapRiver(KEY, firstId);
    ok('b3 删第一条成功', !!(rd && rd.ok), JSON.stringify(rd));
    ok('b3 删完只剩一条且不是它', s.baseMaps[KEY].rivers.length === 1 && s.baseMaps[KEY].rivers[0].id !== firstId);
    s.undo();
    ok('b4 🔴 撤销把被删的河放回**原位**（不是追加到表尾）',
       s.baseMaps[KEY].rivers.map((r) => r.id).join(',') === order0,
       s.baseMaps[KEY].rivers.map((r) => r.id).join(',') + ' vs ' + order0);
    ok('b4 找不到的 id → 明确回执（不静默）', (() => {
      const x = s.removeBaseMapRiver(KEY, 'no-such-river');
      return !!(x && x.ok === false && x.rejected === 'not-found' && x.message);
    })(), JSON.stringify(s.removeBaseMapRiver(KEY, 'no-such-river')));
    ok('b4 点太少 → 明确拒绝', (() => {
      const x = s.addBaseMapRiver(KEY, { points: [{ x: 1, y: 1 }] });
      return !!(x && x.ok === false && x.rejected === 'too-few-points');
    })());

    const rt = s.addBaseMapRoute(KEY, {
      points: [{ x: 0, y: 0 }, { x: 50, y: 50 }], group: 'roads', style: 'highway',
      color: '#D4A017', width: 1.2, name: '用例路',
    });
    ok('b5 加道路成功且样式字段在', !!(rt && rt.ok) && (() => {
      const r = (s.baseMaps[KEY].routes || [])[0];
      return !!r && r.style === 'highway' && r.color === '#D4A017' && r.width === 1.2 && r.group === 'roads';
    })(), JSON.stringify((s.baseMaps[KEY].routes || [])[0]));
    s.undo();
    ok('b5 一条 undo 撤掉道路', (s.baseMaps[KEY].routes || []).length === 0);
    s.redo();
    ok('b5 redo 恢复道路', (s.baseMaps[KEY].routes || []).length === 1);
    ok('b5 删道路：找不到 id → 明确回执',
       (() => { const x = s.removeBaseMapRoute(KEY, 'nope'); return !!(x && x.ok === false && x.rejected === 'not-found'); })());

    // 聚落：改一个（此前是组件直改 store 活对象）
    s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY],
      burgs: [{ id: 1, name: '用例城', x: 10, y: 10, population: 3 }] } };
    const rb = s.updateBaseMapBurg(KEY, 1, { name: '改名后', population: 9 });
    ok('b6 改聚落成功', !!(rb && rb.ok && rb.changed), JSON.stringify(rb));
    ok('b6 名字与人口都改了', (() => {
      const b = (s.baseMaps[KEY].burgs || [])[0];
      return b.name === '改名后' && b.population === 9;
    })(), JSON.stringify((s.baseMaps[KEY].burgs || [])[0]));
    s.undo();
    ok('b6 🔴 撤销把聚落改回原名（旧实现直改活对象 → 撤销会把新值当旧值，空转）',
       (s.baseMaps[KEY].burgs || [])[0].name === '用例城', JSON.stringify((s.baseMaps[KEY].burgs || [])[0]));
    s.redo();
    ok('b6 redo 再改回新名', (s.baseMaps[KEY].burgs || [])[0].name === '改名后');

    // 🔴 b7 旧数据里的聚落（2026-10-13，2026-10-11 轮 1 留下的尾巴）
    //    早期 `.map` 导入只把首都写进**剧本 markers**，底图侧没有 `burgs` → 组件把 markers
    //    派生出来当城镇显示（看得见、点得开编辑器），可一按保存就报「这个聚落不在这张底图上」＝
    //    **用户改不了**。现在第一次编辑时把整批登记成真城镇，并与这次编辑共用**一条 undo**。
    s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], burgs: [] } };
    const seeds = [
      { id: 'marker_0', name: '旧都甲', x: 10, y: 10, capital: 1, population: 0 },
      { id: 'marker_1', name: '旧都乙', x: 30, y: 30, capital: 1, population: 0 },
    ];
    const legacy = s.updateBaseMapBurg(KEY, 'marker_0',
      { ...seeds[0], name: '旧都甲·新', population: 500 }, { materialize: seeds });
    ok('b7 登记成功且回报 materialized=2',
       !!(legacy && legacy.ok && legacy.materialized === 2), JSON.stringify(legacy));
    ok('b7 🔴 整批都登记了（只登记被编辑的那个会让其余几个从地图上消失）',
       (s.baseMaps[KEY].burgs || []).length === 2
       && (s.baseMaps[KEY].burgs || []).some((b) => b.id === 'marker_1'),
       JSON.stringify((s.baseMaps[KEY].burgs || []).map((b) => b.id)));
    ok('b7 被编辑的那个带着新值', (() => {
      const b = (s.baseMaps[KEY].burgs || []).find((x) => x.id === 'marker_0');
      return !!b && b.name === '旧都甲·新' && b.population === 500;
    })(), JSON.stringify((s.baseMaps[KEY].burgs || []).find((x) => x.id === 'marker_0')));
    const again = s.updateBaseMapBurg(KEY, 'marker_0', { name: '旧都甲·新' }, { materialize: seeds });
    ok('b7 再存一次不重复登记（幂等）',
       !!(again && again.ok) && (s.baseMaps[KEY].burgs || []).length === 2,
       JSON.stringify({ n: (s.baseMaps[KEY].burgs || []).length, r: again }));
    s.undo();
    ok('b7 🔴 一条 undo 把「登记 + 编辑」一起退回（拆两条会留下半吊子状态）',
       (s.baseMaps[KEY].burgs || []).length === 0,
       JSON.stringify((s.baseMaps[KEY].burgs || []).map((b) => b.id)));
    s.redo();
    ok('b7 redo 整批回来', (s.baseMaps[KEY].burgs || []).length === 2);
    s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], burgs: [] } };
    ok('b7 没有种子时仍明确报 not-found（不许静默）',
       (() => {
         const x = s.updateBaseMapBurg(KEY, 'marker_9', { name: 'x' });
         return !!(x && x.ok === false && x.rejected === 'not-found');
       })());
  }

  // ══ c) 端到端：组件入口 → store → 项目文件载荷 ════════════════════════════
  {
    const coastBeforeRoutes = (s.baseMaps[KEY].routes || []).length;
    const nRiversBefore = (s.baseMaps[KEY].rivers || []).length;
    // 走**组件真实入口** finishRiverDraft（画河的收口就在它里面）
    sc.riverDraft = [{ x: 20, y: 20 }, { x: 60, y: 40 }, { x: 90, y: 80 }];
    sc.finishRiverDraft();
    ok('c1 组件入口画河 → store 里有这条河（不再是组件本地数组）',
       (s.baseMaps[KEY].rivers || []).length === nRiversBefore + 1,
       JSON.stringify({ before: nRiversBefore, after: (s.baseMaps[KEY].rivers || []).length }));
    ok('c1 画河的草稿已清空', (sc.riverDraft || []).length === 0);

    // 道路：走 store 入口（组件里那段点击处理只做坐标与样式计算）
    const rc = s.addBaseMapRoute(KEY, { points: [{ x: 0, y: 0 }, { x: 30, y: 40 }], group: 'roads', style: 'trail', color: '#9AA5B1', dash: [2, 3] });
    ok('c1 道路也进了 store', !!(rc && rc.ok) && (s.baseMaps[KEY].routes || []).length === coastBeforeRoutes + 1);

    await new Promise((r) => setTimeout(r, 900));      // 等自动保存调度
    await window.__probe.flushProject();
    const payload = window.__probe.lastProject();
    const bm = payload && payload.scenarios && payload.scenarios.baseMaps
      ? payload.scenarios.baseMaps[KEY] : null;
    ok('c2 项目载荷里有这张底图', !!bm, JSON.stringify(Object.keys((payload && payload.scenarios && payload.scenarios.baseMaps) || {})));
    ok('c2 🔴 画出来的河进了项目文件载荷', !!(bm && (bm.rivers || []).length === (s.baseMaps[KEY].rivers || []).length),
       JSON.stringify(bm ? (bm.rivers || []).length : null));
    ok('c2 🔴 画出来的路进了项目文件载荷（含样式）', !!(bm && (bm.routes || []).some((r) => r.style === 'trail' && Array.isArray(r.dash))),
       JSON.stringify((bm && bm.routes || []).slice(-1)));
    ok('c2 载荷可 JSON 往返（没有循环/代理）', (() => {
      try { const r = JSON.parse(JSON.stringify(bm)); return (r.rivers || []).length > 0; } catch (e) { return false; }
    })());
    notes.persist = '载荷 rivers=' + ((bm && bm.rivers) || []).length + ' routes=' + ((bm && bm.routes) || []).length;
  }

  // ══ d) 护栏：无底图 / 只读 → 明确拒绝 ════════════════════════════════════
  {
    const x = s.addBaseMapRiver('no-such-basemap', { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    ok('d1 底图不存在 → 明确拒绝（不静默）', !!(x && x.ok === false && x.rejected === 'no-basemap'), JSON.stringify(x));
  }

  delete s.baseMaps[KEY];
  sc.baseMapKey = Object.keys(s.baseMaps)[0] || '';
  return JSON.stringify({ fails, notes });
})()"""

    js = js.replace('__STORE__', STORE).replace('__SC__', SC)
    ok, res = eval_json(cdp, js, desc='95 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    n = res.get('notes', {})
    if n.get('persist'):
        notes.append(f'persist={n["persist"]}')
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
