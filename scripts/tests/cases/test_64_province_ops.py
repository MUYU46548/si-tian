#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 64：P2 —— 变更归属 / 分割（侧符号）/ 合并（共边抵消）/ 点击填充（面积闸门）

对应验收行（P2）：
  面积守恒 / 顶点数守恒 / 一次 undo / 连续 5 次操作不膨胀 / 填充超阈值被拒

外加两条 P2 明写的语义：
  * 笔刷与套索**只作用于多边形**（网格只是中间层 → 抬手必须写回多边形，写回环带 fromGrid 标记）
  * 分割的**侧符号**：哪一半占原位序号由 side（Shift）决定 —— 序号 = 时间轴/归属里「那块地」的身份

与本用例无关但必须守住的边界：只读态一律拒绝（gate），且拒绝时**零副作用**。
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
    return '\n'.join(l for l in src.split('\n')
                     if not l.strip().startswith(('//', '*', '/*')))


def _js(cdp, src):
    ok, obj = eval_json(cdp, src)
    if not ok:
        return {'ERR': str(obj)[:400]}
    return obj if isinstance(obj, dict) else {'fails': [], 'notes': obj}


def source_gates():
    fails, notes = [], []
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    se = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    checks = [
        (se, 'function splitProvince(key, provinceId, p1, p2, { side = 1 } = {})', 'store：拆分带侧符号'),
        (se, 'const keptPick = keepA ? res.a : res.b;', 'store：侧符号真的换「哪一半占原位」'),
        (se, 'id: orig.id, name: orig.name', 'store：占原位的一半**继承原 id/名字**（身份不换人）'),
        (se, 'side: keepA ? 1 : -1', 'store：回报实际生效的侧'),
        (se, 'const nextTerrain = reprojectRings(key, entry, touched)', '套索/填充写回多边形（不走网格渲染）'),
        (se, 'opts.maxShare ?? FILL_AREA_SHARE', '填充默认面积闸门'),
        (se, 'mergeProvinceShapes(', '合并走精确并集（纯函数层）'),
        (sc, 'handleSplitClick(world, shiftKey)', '组件：拆分工具读 Shift'),
        (sc, 'side: shiftKey ? -1 : 1', '组件：Shift = 换边保留序号'),
    ]
    for src, needle, label in checks:
        if needle not in src:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    # 凸包合并必须已消失（会把两省之间的凹陷连同邻居一起吞掉）
    for src, name in ((se, 'provinceEditing.js'), (sc, 'ScenarioMap.vue')):
        if 'convexHull' in src.lower():
            fails.append(f'{name} 里还残留凸包实现（合并必须走共边抵消）')
    notes.append(f'源码闸门 {len(checks)} 项' + ('全过' if not fails else '有缺'))
    return fails, notes


JS = r"""(() => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const P = window.__provShape;
  const KEY = 'case64';

  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例64底图' });
  const rect = (id, name, x0, x1) => ({ id, name, kind: 'land',
    points: [{ x: x0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: 120 }, { x: x0, y: 120 }] });
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], provinces: undefined, provinceLabels: undefined,
    terrain: [rect('c64a', '用例64甲', 0, 100), rect('c64b', '用例64乙', 100, 200)] } };
  const seeded = s.rebuildProvinceGrid(KEY);
  ok('前置：两省栅格化', seeded && seeded.owned > 0, JSON.stringify(seeded));

  const A = () => s.baseMaps[KEY].terrain;
  // 🔴 面积必须用**净面积**：gross（provinceArea）是各环绝对值之和，带洞时会把洞算两份地，
  //    「面积守恒」会被洞误判成「涨了 12%」（本用例第一版实测 26957 vs 24000 就是它）。
  const area = (p) => P.provinceNetArea(p);
  const verts = (p) => P.provinceRings(p).reduce((n, r) => n + r.points.length, 0);
  const totalArea = () => A().reduce((n, p) => n + area(p), 0);
  const totalVerts = () => A().reduce((n, p) => n + verts(p), 0);
  const snapPts = () => JSON.stringify(A().map((p) => p.points));
  const labelsData = () => JSON.stringify(s.baseMaps[KEY].provinceLabels.data);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  const baseArea = totalArea();
  const baseVerts = totalVerts();
  const areaOfA = area(A()[0]);
  const vertsOfA = verts(A()[0]);
  notes.base = Math.round(baseArea) + ' / ' + baseVerts;

  // ── ① 分割：面积守恒 + 顶点数守恒 + 一条 undo ────────────────────────────
  const cut = [{ x: 40, y: -10 }, { x: 40, y: 130 }];
  const sp = s.splitProvince(KEY, 'c64a', cut[0], cut[1]);
  ok('① 分割成功', sp && sp.a && sp.b, JSON.stringify(sp && { side: sp.side }));
  ok('① 分割后省份数 3', A().length === 3, A().length);
  const halfArea = area(A()[0]) + area(A()[2]);
  ok('① 面积守恒（分割）', near(halfArea, areaOfA, areaOfA * 0.02),
     Math.round(halfArea) + ' vs ' + Math.round(areaOfA));
  const halfVerts = verts(A()[0]) + verts(A()[2]);
  ok('① 顶点数守恒（分割，不膨胀）', halfVerts <= vertsOfA + 8, halfVerts + ' vs ' + vertsOfA);
  ok('① 总体面积不变', near(totalArea(), baseArea, baseArea * 0.01),
     Math.round(totalArea()) + ' vs ' + Math.round(baseArea));
  s.undo();
  ok('① 一条 undo 回到 2 省', A().length === 2, A().length);

  // ── ② 侧符号：哪一半占原位序号 ──────────────────────────────────────────
  // 语义：**原位序号的「身份」永远属于原省**（id 不换人 —— 时间轴/归属都挂在 id 上），
  // 侧符号决定**哪一半地坐在那个序号上**。
  const ptsBefore = snapPts();
  const spA = s.splitProvince(KEY, 'c64a', cut[0], cut[1], { side: 1 });
  const idAtA = A()[0].id, areaAtA = area(A()[0]);
  const tailA = A()[A().length - 1];
  s.undo();
  const spB = s.splitProvince(KEY, 'c64a', cut[0], cut[1], { side: -1 });
  const idAtB = A()[0].id, areaAtB = area(A()[0]);
  const tailB = A()[A().length - 1];
  ok('② 原位序号的 id 始终是原省（身份不换人）', idAtA === 'c64a' && idAtB === 'c64a', idAtA + '/' + idAtB);
  ok('② side=+1 → 坐在原位的是 a 侧',
     near(areaAtA, area(spA.a), 1), Math.round(areaAtA) + ' vs a=' + Math.round(area(spA.a)));
  ok('② side=-1 → 坐在原位的是 b 侧（真的换边）',
     near(areaAtB, area(spB.b), 1), Math.round(areaAtB) + ' vs b=' + Math.round(area(spB.b)));
  ok('② 两半不一样大（换边是可观测的）', !near(area(spA.a), area(spA.b), 1),
     Math.round(area(spA.a)) + ' vs ' + Math.round(area(spA.b)));
  ok('② 追加到表尾的新省拿新 id', tailA && tailA.id !== 'c64a' && tailA.id === spA.appendedId, tailA && tailA.id);
  ok('② side=-1 时表尾换成另一半', tailB && tailB.id === spB.appendedId && tailB.id !== tailA.id, tailB && tailB.id);
  ok('② 两个侧回报正确', spA.side === 1 && spB.side === -1, spA.side + '/' + spB.side);
  s.undo();
  ok('② 撤销后几何完全还原', snapPts() === ptsBefore);

  // ── ③ 合并：多环 + 共边抵消（不是凸包）──────────────────────────────────
  const vA = verts(A()[0]), vB = verts(A()[1]);
  const areaOfB = area(A()[1]);
  const mg = s.mergeProvinces(KEY, ['c64a', 'c64b'], { name: '用例64合' });
  ok('③ 合并成功', mg && mg.method, JSON.stringify(mg && { m: mg.method, loops: mg.loops }));
  ok('③ 合并走共边抵消', mg && mg.method === 'cancel', mg && mg.method);
  ok('③ 合并后 1 个省', A().length === 1, A().length);
  const mArea = area(A()[0]), mVerts = verts(A()[0]);
  ok('③ 面积 = 两块之和（没吃掉邻居 / 没有翻倍）',
     near(mArea, areaOfA + areaOfB, Math.max(areaOfA, areaOfB) * 0.03),
     Math.round(mArea) + ' vs ' + Math.round(areaOfA + areaOfB));
  ok('③ 顶点数不膨胀（共边被抵消掉）', mVerts < vA + vB, mVerts + ' < ' + (vA + vB));
  ok('③ 合并 = 一条 undo', (s.undo(), A().length === 2), A().length);

  // ── ④ 套索：只作用于多边形（写回 + fromGrid 标记）+ 一条 undo ────────────
  const beforeLasso = snapPts();
  const lasso = [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const ls = s.applyProvinceLasso(KEY, lasso, 2);
  ok('④ 套索受理', ls && ls.changed > 0, JSON.stringify(ls));
  ok('④ 套索把结果写回多边形', ls && ls.reprojected > 0, ls && ls.reprojected);
  const touchedIds = A().filter((p) => p.fromGrid);
  ok('④ 写回的环带 fromGrid 标记', touchedIds.length > 0, touchedIds.length);
  const lassoArea = totalArea();
  ok('④ 总面积不变（只换归属，不改面积）', near(lassoArea, baseArea, baseArea * 0.05),
     Math.round(lassoArea) + ' vs ' + Math.round(baseArea));
  s.undo();
  ok('④ 套索一条 undo → 几何还原', snapPts() === beforeLasso);

  // ── ⑤ 连续 5 次操作不膨胀（面积 / 顶点数都稳）────────────────────────────
  // 每次循环：把 0 号省沿自己的包围盒中线切成两半，再把两半合回去 —— 干净的一来一回。
  // 「膨胀」的两种表现都在这里被量：面积漂移（吃掉了别人的地）与顶点数单调增长（每次合并
  // 都留一圈多余顶点 / 环没被抵消）。
  const bboxOf = (p) => {
    const xs = [], ys = [];
    for (const r of P.provinceRings(p)) for (const q of r.points) { xs.push(q.x); ys.push(q.y); }
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  };
  const seq = [];
  const rounds = 5;
  for (let i = 0; i < rounds; i++) {
    const first = A()[0];
    const bb = bboxOf(first);
    const mx = (bb.minX + bb.maxX) / 2;
    const l1 = { x: mx, y: bb.minY - 5 }, l2 = { x: mx, y: bb.maxY + 5 };
    const sp2 = s.splitProvince(KEY, first.id, l1, l2, { side: i % 2 === 0 ? 1 : -1 });
    seq.push(sp2 && sp2.appendedId ? 'split' : 'split-fail');
    const ta1 = totalArea(), tv1 = totalVerts();
    if (!near(ta1, baseArea, baseArea * 0.03)) fails.push(`⑤ 第 ${i + 1} 轮分割后面积漂移：${Math.round(ta1)} vs ${Math.round(baseArea)}`);
    if (tv1 > baseVerts * 3) fails.push(`⑤ 第 ${i + 1} 轮分割后顶点数膨胀：${tv1} vs ${baseVerts}`);
    if (sp2 && sp2.appendedId) {
      const mg2 = s.mergeProvinces(KEY, [first.id, sp2.appendedId], { name: '用例64环' + i });
      seq.push(mg2 && mg2.method ? 'merge' : 'merge-fail');
      const ta2 = totalArea(), tv2 = totalVerts();
      if (!near(ta2, baseArea, baseArea * 0.03)) fails.push(`⑤ 第 ${i + 1} 轮合并后面积漂移：${Math.round(ta2)} vs ${Math.round(baseArea)}`);
      if (tv2 > baseVerts * 3) fails.push(`⑤ 第 ${i + 1} 轮合并后顶点数膨胀：${tv2} vs ${baseVerts}`);
      if (A().length !== 2) fails.push(`⑤ 第 ${i + 1} 轮合并后省份数 ${A().length} ≠ 2`);
    }
  }
  notes.seq = seq.join(' → ');
  notes.after5 = Math.round(totalArea()) + ' / ' + totalVerts();

  // ── ⑥ 点击填充：默认闸门（>25% 全图）拒绝 + 零副作用 ─────────────────────
  const gateIds = A().map((p) => p.id);
  const mg2 = s.mergeProvinces(KEY, gateIds, { name: '用例64闸门' });
  ok('⑥ 前置：合并成一大块', mg2 && A().length === 1, A().length + ' ids=' + gateIds.join('/'));
  s.ensureProvinceGrid(KEY);        // 预热：别把「网格重建」当成填充的副作用
  const labelsBefore = labelsData();
  const ptsBeforeFill = snapPts();
  const big = s.fillProvinceRegion(KEY, { x: 100, y: 60 }, 1);
  ok('⑥ 填充超阈值被拒（默认 25% 闸门）', big && big.rejected === 'area-gate', JSON.stringify(big));
  ok('⑥ 拒绝时零副作用（网格未变）', labelsData() === labelsBefore);
  ok('⑥ 拒绝时零副作用（几何未变）', snapPts() === ptsBeforeFill);
  s.undo();

  // 收场
  delete s.baseMaps[KEY];
  notes.paletteSize = (sc.PROVINCE_PALETTE || []).length;
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

    # 纯几何层：由页面的 Vite 模块图提供（Node 单测已单独覆盖，这里只用它的度量函数）
    prep = _js(cdp, """(async () => {
      const P = await import('/src/utils/provinceShape.js');
      window.__provShape = P;
      return JSON.stringify({ fails: [], notes: Object.keys(P).length });
    })()""")
    if 'ERR' in prep:
        return False, f'provinceShape 模块加载失败：{prep["ERR"]}'

    res = _js(cdp, JS.replace('__SC__', SC).replace('__STORE__', STORE))
    if 'ERR' in res:
        return False, f'P2 探针失败：{res["ERR"]}'
    fails += res.get('fails', [])
    n = res.get('notes', {})
    notes.append(
        f'P2 探针：基准 {n.get("base")}（净面积/顶点）；5 轮「切—合」{n.get("seq")} → {n.get("after5")}；'
        f'色板 {n.get("paletteSize")} 色'
    )
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
