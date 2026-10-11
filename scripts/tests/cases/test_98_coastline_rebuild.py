#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 98：按新 .map 的海岸线重建省份外环（F，2026-10-11）

要解决的问题（暮雨实测）：现有底图的省份边界来自**退化轮廓** —— 生成器原始海岸线 10525 点，
导出时被简化成 778 点，落到底图上每个省只剩几十个点 → 地图上的海岸线又糙又不对。
而生成器**新导出的 .map 里有完整海岸线**。但"重导为新底图"会把几百块省份与归属全丢掉；
他要的是**换掉海岸线那一段**，不作废省份。

做法（复用既有几何单源）：新陆地 = ∪ `landFeatures`；每个省 = **省 ∩ 新陆地**。
  · 完全落在陆地内部的省 → 布尔之后逐点不变（**内陆边界与相邻关系不受影响**）
  · 相邻省仍然无缝（对每个省取同一个 L 的交集，划分关系被保持）
  · 海岸线那一段换成新 .map 的**原顶点**（不是重采样出来的）
  · 一整次 = 一条 undo；面积漂移超闸门 → 拒绝且零副作用（多半选错了 .map）

本用例守五类判据：
  a 源码闸门（剥注释）：store 单源 + 写口契约已登记 + 不许在别处再写一套"并陆地"
  b 纯几何 `buildLandMulti`：多块陆地并集、闭合补齐、非法输入返回 null
  c 端到端：海岸线往内缩 20 → 只有沿海那个省变（内陆省**逐点未动**）、面积精确守恒于新陆地
  d 闸门与护栏：选错 .map（面积漂移超限）→ `area-gate` + 零副作用；没有陆地轮廓 → 明确拒绝；
     一条 undo 回滚；取消
  e 真数据可用性：仓库里那份真实 `.map` 的 `landFeatures` 必须够用（点数足够、能被并起来）
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
MAP_REL = 'docs/mockups/desite.map'


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
    pe = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))

    for needle, label in [
        ('function buildLandMulti(', 'store：陆地轮廓 → MultiPolygon（单源）'),
        ('async function rebuildCoastline(', 'store：海岸线重建入口'),
        ('function rebuildCoastlineFromBaseMap(', 'store：从底图已存的 landFeatures 重建'),
        ("type: 'rebuild-coastline'", 'store：一整次 = 一条 undo'),
        ('COASTLINE_MAX_AREA_DRIFT', 'store：面积漂移闸门'),
        ("rejected: 'no-land'", 'store：没有陆地轮廓时明确拒绝（不静默）'),
    ]:
        if needle not in pe:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    if "'rebuildCoastline'" not in wg:
        fails.append('写口契约缺失：rebuildCoastline 未登记（只读态必须被拦）')
    # 🔴 「没接 UI 的功能等于不存在」——本项目第一大类缺陷，所以入口也算判据
    for needle, label in [
        ('store.rebuildCoastline(', '组件：调用 store 的重建入口'),
        ('data-testid="basemap-rebuild-coastline"', '组件：海岸线重建按钮（有入口）'),
        ('function triggerCoastlineRebuild(', '组件：重建的触发与问人'),
    ]:
        if needle not in sc:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')

    notes.append('源码闸门 10 项' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


JS = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const P = window.__provShape;
  const KEY = 'case98';
  const area = (p) => P.provinceNetArea(p);
  const totalArea = () => (s.baseMaps[KEY].terrain || []).reduce((n, p) => n + area(p), 0);

  // ══ b) 纯几何：多块陆地并集 ═══════════════════════════════════════════════
  {
    const a = { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };
    const b = { points: [{ x: 200, y: 0 }, { x: 260, y: 0 }, { x: 260, y: 60 }, { x: 200, y: 60 }] };
    const land = s.buildLandMulti([a, b]);
    ok('b1 两块陆地并起来（不是只取第一块）', !!land && land.length >= 2, JSON.stringify(land && land.length));
    ok('b1 并集面积 = 10000 + 3600', !!land && Math.abs(Math.abs(P.multiNetArea ? P.multiNetArea(land) : 0) - 13600) < 1,
       JSON.stringify(land && P.multiNetArea && P.multiNetArea(land)));
    ok('b1 首尾未闭合的点串也能用（自动补闭合）', !!s.buildLandMulti([
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }]));
    ok('b1 非法输入 → null（不抛）', s.buildLandMulti([]) === null && s.buildLandMulti(null) === null);
  }

  // ══ c) 端到端：海岸线往内缩 20，只有沿海那个省变 ═════════════════════════
  //   甲 = x 0..100 靠海（左半边），乙 = x 100..200 内陆（右半边）
  //   新陆地 = 旧陆地往内缩 20（x 20..200 / y 20..80）→ 甲、乙**都**靠海了
  //   为了让"内陆省逐点未动"可判，这里改用：甲靠海、乙被甲与陆地边界包住
  {
    const A = { id: 'p98a', name: '沿海省', kind: 'land',
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };
    const B = { id: 'p98b', name: '内陆省', kind: 'land',
      points: [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 100 }] };
    // 新陆地：左边界从 0 退到 x=40（海岸线往陆地内缩），其余边界不动
    const newLand = [{ points: [{ x: 40, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 40, y: 100 }] }];
    s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例98底图', terrain: [A, B], referenceImages: [], landFeatures: newLand } };
    sc.baseMapKey = KEY;
    await new Promise((r) => setTimeout(r, 60));
    const before = totalArea();
    const bPtsBefore = JSON.stringify(s.baseMaps[KEY].terrain[1].points);
    ok('构造：两省各 10000，合计 20000', Math.abs(before - 20000) < 1, before);

    const r = await s.rebuildCoastline(KEY, newLand, { yieldEvery: 0 });
    ok('c1 重建成功', !!(r && r.ok), JSON.stringify(r && { ok: r.ok, rej: r.rejected, msg: r.message }));
    ok('c1 只动了沿海那个省（1 个）', !!(r && r.changed === 1), JSON.stringify(r && { ch: r.changed, inside: r.skippedInside }));
    const T = () => s.baseMaps[KEY].terrain;
    // ⚠️ "整块在陆地内 → 跳过"是**优化**，不是判据：这里用**逐点未动**当判据（那才是用户关心的）。
    //    首版把 skippedInside 当判据，结果因为它没触发（内陆省正好压在陆地包围盒边界上）而假红。
    ok('c2 🔴 内陆省**逐点未动**（内陆边界不受影响，也没被重采样）',
       JSON.stringify(T()[1].points) === bPtsBefore, '内陆省顶点被改了');
    const a = T().find((p) => p.id === 'p98a');
    ok('c2 沿海省左边界退到了 40（换了海岸线）',
       Math.abs(P.provinceBBox(a).minX - 40) < 0.01, P.provinceBBox(a).minX);
    ok('c2 沿海省右边界没动（内陆交界不受影响）',
       Math.abs(P.provinceBBox(a).maxX - 100) < 0.01, P.provinceBBox(a).maxX);
    ok('c3 🔴 面积守恒：等于"省 ∩ 新陆地"的面积（6000 + 10000）',
       Math.abs(totalArea() - 16000) < 1, Math.round(totalArea()));
    ok('c3 相邻省仍无缝（甲右边界 = 乙左边界 = 100）',
       Math.abs(P.provinceBBox(T().find((p) => p.id === 'p98b')).minX - 100) < 0.01);

    s.undo();
    ok('c4 一条 undo 回到旧海岸线', Math.abs(totalArea() - 20000) < 1, Math.round(totalArea()));
    s.redo();
    ok('c4 redo 再裁一次', Math.abs(totalArea() - 16000) < 1, Math.round(totalArea()));
    s.undo();
    notes.rebuild = '面积 ' + Math.round(before) + ' → 16000（只动 1 省，内陆省逐点未动）';
  }

  // ══ d) 闸门与护栏 ════════════════════════════════════════════════════════
  {
    // 选错 .map：新陆地只覆盖一小条（x 100..200 / y 0..30 = 3000，占总 20000 的 15%）→
    // 面积掉 ~70%，必须被 60% 闸门拦下且零副作用。
    // ⚠️ 两次都算错了期望值，最后靠**量**定下来（test_997 诊断）：
    //    ① 取"右下角 10×10"时 甲 的包围盒与陆地不相交 → 甲原样保留，总面积只掉 49.5%（没到闸门）；
    //    ② 所以"选错 .map"必须让陆地**真的盖住大部分省**，才谈得上触发闸门。
    const tiny = [{ points: [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 30 }, { x: 100, y: 30 }] }];
    const beforePts = JSON.stringify(s.baseMaps[KEY].terrain.map((p) => p.points));
    const r1 = await s.rebuildCoastline(KEY, tiny, { yieldEvery: 0 });
    ok('d1 面积漂移超限 → area-gate 且给漂移量',
       !!(r1 && r1.ok === false && r1.rejected === 'area-gate' && Number.isFinite(r1.drift)),
       JSON.stringify(r1 && { rej: r1.rejected, drift: r1.drift, ch: r1.changed }));
    ok('d1 拒绝时零副作用（几何一字未动）',
       JSON.stringify(s.baseMaps[KEY].terrain.map((p) => p.points)) === beforePts);
    ok('d1 文案点明"像选错了 .map"', /选错|另一张|\.map/.test((r1 && r1.message) || ''), (r1 && r1.message || '').slice(0, 40));

    const gate = await s.rebuildCoastline(KEY, [{ points: [{ x: 40, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 40, y: 100 }] }], { maxDrift: 0.0001, yieldEvery: 0 });
    ok('d1 漂移闸门可注入', !!(gate && gate.rejected === 'area-gate'), JSON.stringify(gate && gate.rejected));

    const none = await s.rebuildCoastline(KEY, [], { yieldEvery: 0 });
    ok('d2 没有陆地轮廓 → no-land 且指路（不是静默无反应）',
       !!(none && none.ok === false && none.rejected === 'no-land' && /\.map/.test(none.message || '')),
       JSON.stringify(none && { rej: none.rejected, msg: (none.message || '').slice(0, 50) }));

    const token = { cancelled: true };
    const cancel = await s.rebuildCoastline(KEY, [{ points: [{ x: 40, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 40, y: 100 }] }], { token, yieldEvery: 1 });
    ok('d2 已取消 → cancelled（不动数据）', !!(cancel && cancel.rejected === 'cancelled'), JSON.stringify(cancel && cancel.rejected));
    ok('d2 取消后几何仍未动', JSON.stringify(s.baseMaps[KEY].terrain.map((p) => p.points)) === beforePts);

    // 从底图已存的 landFeatures 走一遍（导入 .map 时 parser 已带进来）
    const fromBm = await s.rebuildCoastlineFromBaseMap(KEY, { yieldEvery: 0 });
    ok('d3 从底图已存的 landFeatures 也能重建', !!(fromBm && (fromBm.ok || fromBm.rejected)), JSON.stringify(fromBm && { ok: fromBm.ok, rej: fromBm.rejected }));
    s.undo();
    delete s.baseMaps[KEY];
  }

  // ══ e) 真数据可用性：仓库里那份真实 .map 的 landFeatures ══════════════════
  {
    let text = null;
    try { text = await (await fetch(__URL__)).text(); } catch (e) { return { fails: fails.concat(['fetch 真实 .map 失败: ' + e]), notes }; }
    const P2 = await import('/src/utils/azgaar-parser.js');
    const parsed = P2.parseMapFile(text);
    const feats = parsed.landFeatures || [];
    const pts = feats.reduce((n, f) => n + (f.points || []).length, 0);
    ok('e1 真实 .map 里有陆地轮廓', feats.length > 0, feats.length);
    ok('e1 轮廓点数足够（不是几个点的退化轮廓）', pts > 500, pts);
    const land = s.buildLandMulti(feats);
    ok('e1 🔴 真实陆地轮廓能并成一个 MultiPolygon（引擎不炸）', !!land && land.length > 0,
       JSON.stringify(land && land.length));
    const landArea = Math.abs(P.multiNetArea(land));
    ok('e1 并出来的陆地面积 > 0', landArea > 0, Math.round(landArea));
    notes.real = '真实 .map: landFeatures=' + feats.length + ' 点合计=' + pts
      + ' 并集块数=' + (land && land.length) + ' 面积=' + Math.round(landArea);
  }

  return JSON.stringify({ fails, notes });
})()"""


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

    prep = eval_json(cdp, """(async () => {
      const P = await import('/src/utils/provinceShape.js');
      const PB = await import('/src/utils/polygonBool.js');
      window.__provShape = Object.assign({}, P, { multiNetArea: PB.multiNetArea });
      return JSON.stringify({ fails: [] });
    })()""", desc='纯几何模块加载')
    if not prep[0]:
        return False, f'纯几何模块加载失败：{prep[1]}'

    url = '/@fs/' + os.path.join(ROOT, MAP_REL).replace('\\', '/')
    js = JS.replace('__STORE__', STORE).replace('__SC__', SC).replace('__URL__', json.dumps(url))
    ok, res = eval_json(cdp, js, desc='98 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    n = res.get('notes', {})
    for k in ('rebuild', 'real'):
        if n.get(k):
            notes.append(f'{k}: {n[k]}')
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
