#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 92：切四五百块省份的两条路 —— A 折线切割 + B Voronoi 批量铺底

背景（暮雨 2026-10-09 明确的目标）：
  「以当前德斯特星底图为例，我少说也要切四五百块省份出来。」
  旧实现只有「拆分 (X)」= 两点**直线**切一刀 —— 切 400 块 = 400 次精确点击，不可行；
  而且直线切不出沿山脊/海岸走的历史边界。于是本轮补两条路：
  · **A 折线切割**：画任意折线切开一个省（`splitProvinceByPolyline`）
  · **B 批量铺底**：播 N 个点 → Voronoi → 与陆地求交 → 一次切出 N 块（`batchSubdivide`）
  推荐组合正是「B 铺底 + A 精修」。

本用例守五类判据：
  a 源码闸门（剥注释）：两条路的关键件在位；**不许**出现凸包/格点重投影这类退化路径
  b 纯几何（页面侧同一份实现）：Voronoi **铺满、不压叠、面积守恒**（有缝/压叠在本仓是静默错数据）
  c A 折线切割端到端：面积守恒 / 原 id 由指定那半继承 / **海岸线逐点保留** / **折线拐点真的落在边界上** / 一条 undo
  d B 批量铺底端到端：块数 / 覆盖率 / 海岸线逐点保留 / **归属与易主记录迁移到新块** /
    一条 undo 把 terrain 与归属一起还原 / 进度回调分三段 / 只读态拒绝（走契约守卫）
  f UI 段：两个工具**真的接在工具栏上**（点了能切过去）、画布点击真的累积折线顶点、
    换工具清干净、播种→预览→清空整条链（本项目第一大类缺陷是"实现了但没接 UI"）

⚠️ 与 test_79/80 同一条纪律：可能弹 `confirm` 的路径在用例里一律先接管 `window.confirm`。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json            # noqa: E402
from lib import helpers as H                        # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉行注释与块注释（本项目已三次踩到「注释里的旧名字把自己的判据判红」）。"""
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
    pb = _code_only(_read('src/renderer/src/utils/polygonBool.js'))
    vb = _code_only(_read('src/renderer/src/utils/voronoiBatch.js'))
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    gate = _code_only(_read('src/renderer/src/store/writeGate.js'))

    # a①：两条路的实现都在，而且是**唯一实现**（组件不许自己再写一套）
    for src, needle, label in [
        (pe, 'function splitProvinceAlong(', 'store：折线切割入口'),
        (pe, 'async function batchSubdivide(', 'store：批量铺底入口'),
        (pe, 'function commitSplit(', 'store：分割/折线切割共用同一段落库（id 继承只此一处）'),
        (pe, 'function buildOwnershipAfter(', 'store：归属/易主迁移'),
        (pe, 'applyOwnership(ownBefore)', 'store：归属迁移与 terrain **同一条 undo**'),
        (pb, 'export function splitProvinceByPolyline(', '几何：折线切割纯函数'),
        (pb, 'export function cutRingForPolyline(', '几何：折线 → 单侧闭合环'),
        (pb, 'export function robustOp(', '几何：布尔引擎失败时的吸附兜底（不静默）'),
        (vb, 'export function voronoiCells(', '几何：Voronoi（半平面裁剪，无 Delaunay 依赖）'),
        (vb, 'export function makeRegionProbe(', '几何：区域探针（省掉大部分引擎调用）'),
        (vb, 'export function autoSeedsInRegion(', '几何：只在范围内播种'),
        (sc, "tool === 'polySplit'", '组件：折线切割工具'),
        (sc, "tool === 'voronoi'", '组件：批量铺底工具'),
        (sc, 'function finishPolySplit(', '组件：折线收口'),
        (sc, 'async function runBatchSubdivide(', '组件：批量铺底执行（带进度）'),
        (gate, "'splitProvinceAlong'", '写口契约：折线切割已登记'),
        (gate, "'batchSubdivide'", '写口契约：批量铺底已登记'),
    ]:
        if needle not in src:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')

    # a②：退化路径不许复活（凸包合并 / 格点重投影）
    for src, name in ((pe, 'provinceEditing.js'), (sc, 'ScenarioMap.vue')):
        if 'convexHull' in src:
            fails.append(f'{name} 里出现凸包（合并/切分必须走精确布尔）')
    if 'reprojectRings' in pe:
        fails.append('provinceEditing 里 reprojectRings 复活了（格点轮廓反向覆盖多边形）')

    # a③：批量铺底**必须如实回报**（进度 / 覆盖率 / 失败块数）—— 不许"看起来成功了"
    for tok in ('onProgress', 'coverage', 'failed', 'rejected'):
        if tok not in pe:
            fails.append(f'批量铺底缺少如实回报字段：{tok}')

    # a④：切分期间必须"看得见 + 能取消"（C，2026-10-11）——
    #     真实反馈：「提示已切出 415 块，实际上在 414 卡了很久」并「到处乱点，更卡」。
    #     判据两条：① 让出主线程必须是**等下一帧**（rAF），不是 setTimeout(0)
    #     （后者只回定时器队列，浏览器不保证插进一次渲染 → 进度形同不动）；
    #     ② 取消通道必须存在（store 收 token + 组件有取消按钮/遮罩）。
    if 'yieldToPaint = (' not in pe:
        fails.append('源码闸门缺失：store 没有 yieldToPaint（主线程让出应集中在唯一一处）')
    if 'requestAnimationFrame' not in pe:
        fails.append('🔴 让出主线程用的是 setTimeout 而非 requestAnimationFrame —— 进度提示不会真的刷新（实测症状：卡在某个数字很久）')
    for tok in ('token = null', "rejected: 'cancelled'", 'cancelled()'):
        if tok not in pe:
            fails.append(f'批量铺底缺少取消通道：{tok}')
    for tok in ('function cancelBatchSubdivide(', 'data-testid="scenario-busy-overlay"', 'data-testid="busy-cancel"'):
        if tok not in sc:
            fails.append(f'组件缺少"忙时可见/可取消"：{tok}')

    notes.append(f'源码闸门 20 项' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


JS = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  // 🔴 纪律：本用例的路径可能弹 confirm（批量铺底问一次）—— headless 里无人点 = CDP 命令永不返回
  window.confirm = () => true;
  const P = window.__provShape;
  const V = await import('/src/utils/voronoiBatch.js');
  const PB = await import('/src/utils/polygonBool.js');
  const KEY = 'case92';

  // ══ b) Voronoi 纯几何：铺满 / 不压叠 / 面积守恒 ══════════════════════════
  {
    const box = { minX: 0, minY: 0, maxX: 120, maxY: 80 };
    const sites = V.jitteredGridSeeds(box, 8, 6, V.makeRng(11), 0.6);
    const built = V.voronoiCells(sites, box);
    let zero = 0, multi = 0, total = 0;
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 30; j++) {
        const x = box.minX + (box.maxX - box.minX) * (i / 40);
        const y = box.minY + (box.maxY - box.minY) * (j / 30);
        let k = 0;
        for (const r of built.rings) if (PB.pointInMulti(x, y, [[r]])) k++;
        total++;
        if (k === 0) zero++;
        if (k > 1) multi++;
      }
    }
    ok('b1 Voronoi 铺满：采样点没有落空的（有缝 = 地图上会看到细缝）', zero === 0, zero + '/' + total);
    ok('b2 Voronoi 不压叠：没有采样点同时落在两块里', multi === 0, multi + '/' + total);
    let cellArea = 0;
    for (const r of built.rings) cellArea += PB.multiNetArea([[r]]);
    const rect = built.rect;
    const expect = Math.abs((rect[2][0] - rect[0][0]) * (rect[2][1] - rect[0][1]));
    ok('b3 Voronoi 面积守恒（无重叠无缺口）', Math.abs(cellArea - expect) < expect * 1e-6,
       cellArea.toFixed(3) + ' vs ' + expect.toFixed(3));
    notes.voronoi = built.rings.length + ' 块 / ' + built.facets + ' 次半平面裁剪 / ' + total + ' 采样';
  }

  // ══ 构造：一块**带锯齿海岸线**的大陆（31 个海岸顶点，逐点可断言）═══════
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例92底图' });
  const coast = [];
  for (let i = 30; i >= 0; i--) coast.push({ x: 180 + (i % 2 ? 2.5 : -2.5), y: i * 4 });
  const land = {
    id: 'c92a', name: '用例92大陆', kind: 'land',
    points: [{ x: 0, y: 0 }, { x: 0, y: 120 }, ...coast],
  };
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], provinceLabels: undefined, terrain: [land] } };
  const R = () => s.baseMaps[KEY].terrain;
  const area = (p) => P.provinceNetArea(p);
  const verts = (p) => P.provinceRings(p).reduce((n, r) => n + r.points.length, 0);
  const areaOf = (p) => P.provinceNetArea(p);
  const allPoints = () => R().flatMap((p) => P.provinceRings(p).map((r) => r.points).flat());
  const coastMissing = () => {
    const all = allPoints();
    return coast.filter((c) => !all.some((q) => Math.abs(q.x - c.x) < 1e-6 && Math.abs(q.y - c.y) < 1e-6));
  };
  const baseArea = area(land);
  const baseVerts = verts(land);
  notes.base = '面积 ' + Math.round(baseArea) + ' / 顶点 ' + baseVerts;
  ok('构造：大陆 33 个顶点（2 个左边界 + 31 个锯齿海岸点）', baseVerts === 33, baseVerts);

  // ══ c) A 折线切割：折线带一个拐点，竖着切开 ═════════════════════════════
  {
    const line = [{ x: 60, y: -20 }, { x: 60, y: 60 }, { x: 120, y: 90 }, { x: 120, y: 140 }];
    const res = s.splitProvinceAlong(KEY, 'c92a', line);
    ok('c1 折线切割成功', !!(res && res.a && res.b), JSON.stringify(res && { side: res.side, cut: res.cutPoints }));
    ok('c2 切完 2 个省', R().length === 2, R().length);
    const sum = R().reduce((n, p) => n + area(p), 0);
    ok('c3 面积守恒（两半之和 = 原省）', Math.abs(sum - baseArea) < baseArea * 0.001,
       Math.round(sum) + ' vs ' + Math.round(baseArea));
    ok('c4 占原位的那半继承原 id', R()[0].id === 'c92a', R()[0].id);
    const miss = coastMissing();
    ok('c5 🔴 海岸线逐点保留（折线切割不重采样海岸）', miss.length === 0,
       miss.length + ' 个海岸点丢了：' + JSON.stringify(miss.slice(0, 3)));
    // 🔴 切出来的边界必须**真的沿折线走** —— 只用 A→B 的直线弦也能"切成功"，
    //    但那是另一个形状；折线的拐点必须出现在某一半的顶点里（否则等于把折线拉直了）
    const bend = [{ x: 60, y: 60 }, { x: 120, y: 90 }];
    const all = allPoints();
    const bendMiss = bend.filter((b) => !all.some((q) => Math.abs(q.x - b.x) < 1e-6 && Math.abs(q.y - b.y) < 1e-6));
    ok('c5b 🔴 折线的拐点落在切出的边界上（不是被拉直成弦）', bendMiss.length === 0,
       JSON.stringify(bendMiss));
    ok('c6 顶点数不下降（切割只可能加点）', R().reduce((n, p) => n + verts(p), 0) >= baseVerts,
       R().reduce((n, p) => n + verts(p), 0) + ' vs ' + baseVerts);
    // 换边：另一侧保留原 id（Shift 的语义）
    s.undo();
    ok('c7 一条 undo 回到 1 个省', R().length === 1 && R()[0].id === 'c92a', R().length);
    const res2 = s.splitProvinceAlong(KEY, 'c92a', line, { side: -1 });
    ok('c8 side:-1 时仍切成功', !!(res2 && res2.a && res2.b));
    ok('c9 side:-1 时另一侧拿原 id', R()[0].id === 'c92a' && res2.side === -1, JSON.stringify({ side: res2.side }));
    s.undo();
    notes.split = '折线 4 点 → 两块（' + (res.cutPoints || 0) + ' 点切割环）';
  }

  // ══ d) B 批量铺底：12 个种子（规则网格，jitter=0）切 12 块 ═══════════════
  {
    const SCID = KEY + '/铺底剧本';
    const evSample = [{ year: 100, polityId: 'pol_test' }];
    s.scenarios = {
      ...s.scenarios,
      [SCID]: {
        id: SCID, name: '用例92剧本', ownerKey: KEY,
        ownership: { c92a: 'pol_test' },
        changeEvents: { c92a: JSON.parse(JSON.stringify(evSample)) },
        polities: [], labels: [], markers: [],
      },
    };
    const sites = [];
    for (let j = 1; j <= 4; j++) for (let i = 1; i <= 3; i++) sites.push({ x: i * 40, y: j * 24 });
    const phases = [];
    const r = await s.batchSubdivide(KEY, {
      provinceIds: ['c92a'], sites, seed: 1, jitter: 0, yieldEvery: 0,
      onProgress: (p) => phases.push(p.phase),
    });
    ok('d1 批量铺底成功', !!(r && r.ok), JSON.stringify(r && { rej: r.rejected, msg: r.message }));
    ok('d2 切出 12 块', r.created === 12, r.created);
    ok('d3 旧省被替换（12 块里没有 c92a）', R().length === 12 && !R().some((p) => p.id === 'c92a'), R().length);
    ok('d4 覆盖率 ≥ 99%（不留没人接手的地）', r.coverage > 0.99, r.coverage);
    ok('d5 没有失败块', r.failed === 0, r.failed + ' 块失败：' + JSON.stringify(r.failures || []));
    const miss = coastMissing();
    ok('d6 🔴 海岸线逐点保留（批量铺底与陆地精确求交）', miss.length === 0,
       miss.length + ' 个海岸点丢了：' + JSON.stringify(miss.slice(0, 3)));
    ok('d7 新省的几何都是矢量（fromGrid 不为 true）',
       R().every((p) => p.fromGrid !== true && P.provinceRings(p).length > 0));
    const total = R().reduce((n, p) => n + area(p), 0);
    ok('d8 面积守恒（新块之和 = 原陆地）', Math.abs(total - baseArea) < baseArea * 0.002,
       Math.round(total) + ' vs ' + Math.round(baseArea));
    // 归属 / 易主迁移
    const own = s.scenarios[SCID].ownership || {};
    const ev = s.scenarios[SCID].changeEvents || {};
    const ids = R().map((p) => p.id);
    ok('d9 旧省的归属键已摘掉（不留孤儿键）', !('c92a' in own), Object.keys(own).join(','));
    ok('d10 🔴 每个新块都继承了归属', ids.every((id) => own[id] === 'pol_test'), JSON.stringify(own).slice(0, 120));
    ok('d11 易主记录迁移到每一块', ids.every((id) => JSON.stringify(ev[id]) === JSON.stringify(evSample)),
       JSON.stringify(ev).slice(0, 120));
    ok('d12 进度回调分了三段（region / cells / commit）',
       phases.includes('region') && phases.includes('cells') && phases.includes('commit'),
       phases.slice(0, 6).join('>') + '…（共 ' + phases.length + ' 次）');
    // 一条 undo 把 terrain 与归属**一起**还原
    s.undo();
    const own2 = s.scenarios[SCID].ownership || {};
    const ev2 = s.scenarios[SCID].changeEvents || {};
    ok('d13 一条 undo 还原 terrain', R().length === 1 && R()[0].id === 'c92a', R().length + ' 省');
    ok('d14 🔴 同一条 undo 还原归属与易主（不留指向新块的孤儿键）',
       own2.c92a === 'pol_test' && ids.every((id) => !(id in own2)) && JSON.stringify(ev2.c92a) === JSON.stringify(evSample),
       JSON.stringify({ own: Object.keys(own2).length, ev: Object.keys(ev2).length }));
    s.redo();
    ok('d15 redo 回到 12 块', R().length === 12, R().length);
    s.undo();
    notes.batch = '12 块 / 覆盖 ' + Math.round((r.coverage || 0) * 100) + '% / ' +
      r.inner + ' 块内陆 + ' + r.clipped + ' 块贴海岸 / 用时 ' + r.elapsedMs + 'ms';
    delete s.scenarios[SCID];
  }

  // ══ e) 只读态与参数护栏 ═════════════════════════════════════════════════
  {
    const p = s.planBatchSeeds(KEY, { provinceIds: ['c92a'], count: 20, seed: 3 });
    ok('e1 planBatchSeeds 给出范围内种子', !!(p && p.ok && p.seeds.length === 20), JSON.stringify(p && { n: (p.seeds || []).length, msg: p.message }));
    const outside = (p.seeds || []).filter((q) => !P.pointInProvince(q.x, q.y, R()[0]));
    ok('e2 自动播种的点全部落在省界内', outside.length === 0, outside.length + ' 个在外面');
    const pv = s.previewSplitAlong(KEY, 'c92a', [{ x: 50, y: -10 }, { x: 50, y: 130 }]);
    ok('e3 折线预览只算不写（两块几何 + 原省未动）',
       !!(pv && pv.a && pv.b) && R().length === 1 && R()[0].id === 'c92a', JSON.stringify({ n: R().length }));
    const bad = s.splitProvinceAlong(KEY, 'c92a', [{ x: 900, y: 900 }, { x: 950, y: 950 }]);
    ok('e4 折线在省外 → 明确拒绝（no-cut）而非静默无反应', bad && bad.rejected === 'no-cut', JSON.stringify(bad));
    const empty = await s.batchSubdivide(KEY, { provinceIds: ['nonexistent'], sites: [{ x: 1, y: 1 }] });
    ok('e5 目标省不存在 → 明确拒绝', empty && empty.ok === false && !!empty.rejected, JSON.stringify(empty));
    const noProv = await s.batchSubdivide('case92-no-such-basemap', { sites: [{ x: 1, y: 1 }] });
    ok('e6 底图不存在 → 明确拒绝', noProv && noProv.ok === false, JSON.stringify(noProv));
  }

  // ══ f) 取消通道（C，2026-10-11）：取消 → 明确回执 + **零副作用** ══════════════
  {
    // ⚠️ 段 d 收尾把这个剧本删了（`delete s.scenarios[SCID]`）→ 这里自己重建一份，
    //    不要跨块引用（首版实测：`SCID is not defined`，块级 const 出了块就没了）。
    const SCID2 = KEY + '/取消剧本';
    s.scenarios = { ...s.scenarios, [SCID2]: {
      id: SCID2, name: '用例92取消剧本', ownerKey: KEY,
      ownership: { c92a: 'pol_keep' },
      changeEvents: { c92a: [{ year: 100, polityId: 'pol_keep' }] },
      polities: [], labels: [], markers: [],
    } };
    const terrainBefore = JSON.stringify(R());
    const ownBefore = JSON.stringify(s.scenarios[SCID2].ownership);
    const token = { cancelled: false };
    const sites2 = [];
    for (let j = 1; j <= 6; j++) for (let i = 1; i <= 3; i++) sites2.push({ x: i * 40, y: j * 20 });
    let cancelAt = 0;
    const rc = await s.batchSubdivide(KEY, {
      provinceIds: ['c92a'], sites: sites2, seed: 2, jitter: 0.3, token, yieldEvery: 2,
      onProgress: (p) => {
        cancelAt += 1;
        if (p.phase === 'cells' && p.done >= 4) token.cancelled = true;   // 切到一半点「取消」
      },
    });
    ok('f1 取消后被拒绝（rejected=cancelled）并有可读说明',
       !!(rc && rc.ok === false && rc.rejected === 'cancelled' && rc.message),
       JSON.stringify(rc && { ok: rc.ok, rej: rc.rejected, msg: String(rc.message || '').slice(0, 40) }));
    ok('f2 🔴 取消后省份几何一字未动（没落库）', JSON.stringify(R()) === terrainBefore,
       R().length + ' 省');
    ok('f3 取消后归属一字未动', JSON.stringify(s.scenarios[SCID2].ownership) === ownBefore);
    notes.cancel = '在处理到 ' + cancelAt + ' 次进度回调时取消 → ' + (rc && rc.rejected);
    delete s.scenarios[SCID2];
  }

  delete s.baseMaps[KEY];
  return JSON.stringify({ fails, notes });
})()"""


JS_UI = r""" (async () => {
  const sc = __SC__, s = __STORE__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));
  window.confirm = () => true;
  const bar = document.querySelector('.scenario-toolbar');
  if (!bar) return JSON.stringify({ fails: ['UI：工具栏不在 DOM 里'], notes: {} });
  const visible = (el) => !!(el && el.offsetParent !== null && el.getClientRects().length);
  const btnByTitle = (frag) => Array.from(bar.querySelectorAll('button'))
    .find((b) => visible(b) && (b.title || '').includes(frag));

  // ── f1 两个新工具的入口真的在工具栏上、点了真能切过去 ──────────────────────
  sc.moreOpen = true;                    // 「更多」展开 → 省份选项行常驻
  await tick();
  const polyBtn = btnByTitle('折线切割 (D)');
  const vorBtn = btnByTitle('批量铺底 (A)');
  ok('f1 工具栏找得到「折线切割」入口', !!polyBtn, polyBtn ? polyBtn.title.slice(0, 20) : '无');
  ok('f1 工具栏找得到「批量铺底」入口', !!vorBtn, vorBtn ? vorBtn.title.slice(0, 20) : '无');
  if (polyBtn) { polyBtn.click(); await tick(); }
  ok('f1 点「折线切割」真的切到该工具', sc.tool === 'polySplit', String(sc.tool));
  ok('f1 折线切割的设置面板出现', !!document.querySelector('[data-testid="polysplit-settings"]'));
  const fin = document.querySelector('[data-testid="polysplit-finish"]');
  ok('f1 不足两个点时「切开」是禁用的', !!fin && fin.disabled === true, fin ? String(fin.disabled) : '无按钮');

  // ── f2 画布上真点两下 = 两个顶点（折线工具的核心交互）──────────────────────
  const cv = document.querySelector('.scenario-map-container canvas');
  ok('f2 找得到画布', !!cv);
  if (cv) {
    const r = cv.getBoundingClientRect();
    const click = (dx, dy) => {
      const opt = { clientX: r.left + dx, clientY: r.top + dy, bubbles: true, button: 0 };
      sc.onCanvasClick(new MouseEvent('click', opt));
    };
    click(120, 120); click(200, 160);
    await tick();
    ok('f2 画布点击累积成折线顶点', (sc.polySplitPoints || []).length === 2,
       JSON.stringify((sc.polySplitPoints || []).length));
    const fin2 = document.querySelector('[data-testid="polysplit-finish"]');
    ok('f2 两个点后「切开」可用', !!fin2 && fin2.disabled === false, fin2 ? String(fin2.disabled) : '无按钮');
    notes.poly = '已点 ' + (sc.polySplitPoints || []).length + ' 点';
  }

  // ── f3 换工具要清干净（折线预览不许残留到别的工具上）─────────────────────
  if (vorBtn) { vorBtn.click(); await tick(); }
  ok('f3 点「批量铺底」切到该工具', sc.tool === 'voronoi', String(sc.tool));
  ok('f3 换工具后折线顶点已清空', (sc.polySplitPoints || []).length === 0);
  ok('f3 换工具后折线预览已清空', !sc.polySplitPreview || (sc.polySplitPreview.a ? false : true));
  ok('f3 批量铺底的设置面板出现', !!document.querySelector('[data-testid="voronoi-settings"]'));
  const cnt = document.querySelector('[data-testid="voronoi-count"]');
  ok('f3 块数输入框在位且有默认值', !!cnt && Number(cnt.value) >= 2, cnt ? cnt.value : '无');
  const runBtn = document.querySelector('[data-testid="voronoi-run"]');
  ok('f3 没有种子点「一键切分」是禁用的（不会空跑）', !!runBtn && runBtn.disabled === true,
     runBtn ? String(runBtn.disabled) : '无按钮');

  // ── f4 播种 → 预览出线 → 清空（不真的切，避免动 harness 基线项目）──────────
  const KEY = 'case92ui';
  const land = { id: 'c92ui', name: '用例92UI陆地', kind: 'land',
    points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 0, y: 120 }] };
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...(s.baseMaps[KEY] || { id: KEY, name: '用例92UI底图' }),
    terrain: [land], provinceLabels: undefined } };
  sc.baseMapKey = KEY;
  await tick();
  const auto = document.querySelector('[data-testid="voronoi-autoseed"]');
  ok('f4 找得到「自动播种」按钮', !!auto);
  if (auto) {
    auto.click();
    for (let i = 0; i < 40 && !(sc.batchSeeds || []).length; i++) await tick(100);
  }
  ok('f4 自动播种真的播下了点', (sc.batchSeeds || []).length > 0, (sc.batchSeeds || []).length + ' 个');
  ok('f4 播种后出现 Voronoi 预览', (sc.batchPreviewCells || []).length > 0,
     (sc.batchPreviewCells || []).length + ' 块');
  const runBtn2 = document.querySelector('[data-testid="voronoi-run"]');
  ok('f4 有种子后「一键切分」可用', !!runBtn2 && runBtn2.disabled === false,
     runBtn2 ? String(runBtn2.disabled) : '无按钮');
  notes.seeds = (sc.batchSeeds || []).length + ' 个种子 / ' + (sc.batchPreviewCells || []).length + ' 块预览';
  sc.clearBatchSeeds();
  await tick();
  ok('f4 清空种子后预览一起消失', (sc.batchSeeds || []).length === 0 && (sc.batchPreviewCells || []).length === 0);
  delete s.baseMaps[KEY];
  sc.setTool('select');
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

    # 纯几何层：由页面的 Vite 模块图提供（Node 单测另有 test_voronoi_batch.js 覆盖同一份实现）
    prep = eval_json(cdp, """(async () => {
      const P = await import('/src/utils/provinceShape.js');
      window.__provShape = P;
      return JSON.stringify({ fails: [], notes: Object.keys(P).length });
    })()""", desc='provinceShape 加载')
    if not prep[0]:
        return False, f'provinceShape 模块加载失败：{prep[1]}'

    ok, res = eval_json(cdp, JS.replace('__SC__', SC).replace('__STORE__', STORE), desc='92 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    n = res.get('notes', {})
    notes.append(f'基准 {n.get("base")}')
    notes.append(f'Voronoi：{n.get("voronoi")}')
    notes.append(f'折线切割：{n.get("split")}')
    notes.append(f'批量铺底：{n.get("batch")}')

    # UI 段：入口真的接上了吗（本项目第一大类缺陷 = "实现了但没接 UI"）
    ok2, res2 = eval_json(cdp, JS_UI.replace('__SC__', SC).replace('__STORE__', STORE), desc='92 UI 探针')
    if not ok2:
        fails.append(f'UI 段：{res2}')
    else:
        fails += res2.get('fails', [])
        un = res2.get('notes', {})
        notes.append(f'UI：{un.get("poly", "-")}；{un.get("seeds", "-")}')
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
