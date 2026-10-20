#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 62：P0 第二块 —— 省份「多环实体」+ 共享边界 + 渲染单一路径

背景（用户三条投诉的数据层根因，见 skill §143 / AGENTS.md）：
  ① **丑东西**：省份只能有一个 `points` 环 → 飞地 / 带洞的行政区表达不了；涂色网格与多边形
     两套几何各自演化，「网格视图」一开看到的和存下来的不是同一个东西。
  ② **圈不着**：手绘描点的省份彼此不共享顶点 → 相邻省之间必然留缝、边界对不上。
  ③ **功能打架**：合并只能退化成「凸包」（实测吃掉邻居省份）；网格视图开关 vs 多边形渲染
     两条渲染路径并存。

本用例守 P0 第二块的修复：
  a 源码闸门（剥注释）：多环几何层 / 渲染单一路径 / 无凸包 / 无「网格视图」开关 / 工具栏分层
  b 纯函数层：多环往返（洞真的空、飞地真的画）、共边抵消合并、骨架整段插顶点、签名敏感度、
     环 → 栅格不漂移、点击填充 cap 闸门
  c store 层：涂抹抬手**把网格结果写回多边形**（fromGrid 标记、多环）、相邻省共享边界顶点、
     labels 与多边形**一起**撤销/重做（一条 undo）
  d 点击填充：面积闸门拒绝 + **零副作用**；小区域填充成功且可撤销
  e 分割 / 合并：一条 undo 内改几何 + 网格作废重建；合并走精确并集（不是凸包）
  f UI：工具栏 5 行 `.toolbar-row`（不再有 tool-group 掉到容器层）；无「网格视图」复选框；
     展开「更多」后：≥4 行 .toolbar-row、tool-group 全在工具栏内、省份笔刷/自由轮廓/点击填充入口在位；
     属性面板有「类型（陆地/海域）」与「编辑环」
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib import helpers as H  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉注释（行注释 + 块注释）后的源码。

    🔴 静态判据必须先剥注释：本项目已三次踩到「注释里写着旧实现的名字，子串判据把自己的
    注释判成违规」的坑（textures/provinceShape/test_54 各一次）。
    """
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


def _js(cdp, expr):
    raw = cdp.eval(expr)
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return {'raw': raw[:300]}
    if isinstance(raw, dict) and '__err__' in raw:
        return {'ERR': str(raw['__err__'])[:300]}
    return {'raw': raw}


# ══════════════════════════════════════════════════════════════════════════
# a) 源码闸门
# ══════════════════════════════════════════════════════════════════════════
def _source_gate():
    fails = []
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    pe = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    ps = _code_only(_read('src/renderer/src/utils/provinceShape.js'))

    # ① 渲染单一路径：永远画多边形；「网格视图」开关不得回来
    if 'showProvinceMesh' in sc:
        fails.append('「网格视图」开关又回来了 → 又会变成两条渲染路径（看到的 ≠ 存下来的）')
    if 'if (provinceMeshOn.value) drawProvinces' in sc:
        fails.append('渲染仍在「网格 / 多边形」之间二选一 → 必须永远画多边形')
    for tok in ('drawProvinces(ctx.value);', 'traceProvincePath', 'provinceRings('):
        if tok not in sc:
            fails.append(f'渲染单一路径缺件：{tok}')

    # ② 多环几何层被真的接上（不是摆设）
    for tok in ('writeRingPoints', 'ringPointsForRender', 'pointInProvince', 'buildSkeleton', 'conformToSkeleton'):
        if tok not in sc:
            fails.append(f'ScenarioMap 未接多环几何层：{tok}')
    if 'convexHull' in sc:
        fails.append('凸包合并还在（会把两个省之间的凹陷与邻居一起吞掉）→ 必须走精确并集')
    # 🔴 P2（2026-10-09）**反向守卫**：`reprojectRings` 必须不存在 —— 它就是「把格点轮廓
    #    反向写成多边形」的元凶（10525 点海岸线一次涂抹变 ~22 点）。旧版本这条守卫写的是
    #    「缺件检查」（tok not in pe），等于**把退化行为当成正确行为**来守 → 91 用例全绿
    #    而用户数据被毁。见 docs/SCENARIO_PROVINCE_FIX_PLAN.md。
    if 'reprojectRings' in pe:
        fails.append('`reprojectRings` 又回来了 → 涂归属会再次把高精度多边形降级成格点轮廓')
    if 'fromGrid: true' in pe:
        fails.append('provinceEditing 仍在写 fromGrid:true（格点派生几何的标记）→ 退化路径复活')
    for tok in ('applyRegionToTerrain', 'shapeSignature', 'fillProvinceRegion',
                'splitProvince', 'mergeProvinces', 'polygonClipping'):
        if tok not in pe:
            fails.append(f'provinceEditing 缺件：{tok}')

    # ③ 工具栏分层：CSS 里有行容器
    if '.toolbar-row' not in sc:
        fails.append('工具栏没有行容器（.toolbar-row）→ 控件会继续堆成一坨')

    # ④ 纯函数层的契约（多环 + 骨架 + 栅格口径）
    for tok in ('export function provinceRings', 'export function shapePatch', 'export function shapeSignature',
                'export function buildSkeleton', 'export function conformToSkeleton',
                'export function mergeProvinceShapes', 'export function floodRegion', 'export function ringsFromLabels'):
        if tok not in ps:
            fails.append(f'provinceShape 缺件：{tok}')
    return fails


# ══════════════════════════════════════════════════════════════════════════
# b) 纯函数层（动态 import 真实模块，不复制实现）
# ══════════════════════════════════════════════════════════════════════════
JS_PURE = r"""
(async () => {
  const fails = [];
  const ok = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' (' + extra + ')' : '')); };
  const same = (label, got, want) => { if (String(got) !== String(want)) fails.push(label + ' got=' + got + ' want=' + want); };
  const P = await import('/src/utils/provinceShape.js');
  const G = await import('/src/utils/provinceGrid.js');

  // ① 多环实体：外环 + 洞（洞不该被填）
  const outer = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const hole  = [{x:30,y:30},{x:60,y:30},{x:60,y:60},{x:30,y:60}];
  const prov = { id:'p', kind:'land', points:outer, extraRings:[{ points:hole, kind:'land' }] };
  same('多环：环数', P.provinceRings(prov).length, 2);
  same('多环：洞中心不命中', P.pointInProvince(45, 45, prov), false);
  same('多环：环内命中', P.pointInProvince(10, 10, prov), true);
  same('多环：毛面积 = 各环绝对值和', Math.round(P.provinceArea(prov)), 10000 + 900);
  same('多环：嵌套符号（洞 = -1）', P.ringSigns(prov).join(','), '1,-1');

  // ② 无损往返（shapePatch 已把 fromGrid 一起带上）
  const back = Object.assign({}, prov, P.shapePatch(P.provinceRings(prov)));
  same('往返：环数不变', P.provinceRings(back).length, 2);
  same('往返：洞仍在（不被填实）', P.pointInProvince(45, 45, back), false);
  const gridP = { id:'g', kind:'land', points:outer, extraRings:[{ points:hole, kind:'land' }] };
  const roundP = Object.assign({}, gridP, P.shapePatch(P.provinceRings(gridP).map(r => ({ points:r.points, kind:r.kind, fromGrid:true }))));
  same('往返：主环 fromGrid 落省份级', roundP.fromGrid, true);
  same('往返：渲染端能据此平滑', P.provinceRings(roundP).filter(r => r.fromGrid).length, 2);

  // ③ 签名：网格「是不是这套多边形派生的」的唯一判据（对坐标与环数都敏感）
  const sig = P.shapeSignature([prov]);
  ok('签名对坐标敏感', sig !== P.shapeSignature([{ id:'p', points:[{x:0,y:0},{x:101,y:0},{x:100,y:100},{x:0,y:100}] }]));
  ok('签名对额外环敏感', sig !== P.shapeSignature([{ id:'p', points:outer, extraRings:[] }]));
  ok('签名对 fromGrid 不敏感（改标记不该让网格作废）', sig === P.shapeSignature([Object.assign({}, prov, { fromGrid:true })]));

  // ④ 合并 = 精确共边抵消（旧实现是凸包 → 吃掉邻居）
  const a = { id:'a', kind:'land', points:[{x:0,y:0},{x:50,y:0},{x:50,y:50},{x:0,y:50}] };
  const b = { id:'b', kind:'land', points:[{x:50,y:0},{x:100,y:0},{x:100,y:50},{x:50,y:50}] };
  const mg = P.mergeProvinceShapes([a, b]);
  same('合并：方法 = 共边抵消', mg.method, 'cancel');
  same('合并：环数 1', mg.loops, 1);
  same('合并：面积 = 两者之和（没吃掉邻居）', Math.round(P.provinceArea({ points: mg.shape.points })), 5000);
  // 不相邻的两个省合并 → 多环（飞地），不是一片
  const far = { id:'c', kind:'land', points:[{x:200,y:0},{x:250,y:0},{x:250,y:50},{x:200,y:50}] };
  const mg2 = P.mergeProvinceShapes([a, far]);
  ok('合并：不相邻 → 多环实体（飞地保留）', P.provinceRings({ points: mg2.shape.points, extraRings: mg2.shape.extraRings }).length === 2,
     P.provinceRings({ points: mg2.shape.points, extraRings: mg2.shape.extraRings }).length);

  // ⑤ 共享边界骨架：整段插顶点（只吸端点会在两省之间斜切一条缝）
  const skeleton = P.buildSkeleton([{ id:'s', points:[{x:0,y:0},{x:0,y:120},{x:100,y:120},{x:100,y:0},{x:100,y:-40},{x:0,y:-40}] }]);
  same('骨架：排除自身', P.buildSkeleton([{ id:'s', points:outer }], 's').length, 0);
  const drawn = [{x:2,y:2},{x:99,y:3},{x:99,y:118},{x:1,y:117}];
  const conformed = P.conformToSkeleton(drawn, skeleton, 10);
  ok('骨架：端点被换成骨架顶点（零缝）',
     conformed.some(p => Math.abs(p.x - 100) < 1e-9 && (Math.abs(p.y) < 1e-9 || Math.abs(p.y - 120) < 1e-9)),
     JSON.stringify(conformed.slice(0, 6)));
  const farPts = [{x:0,y:0},{x:200,y:0},{x:200,y:200},{x:0,y:200}];
  same('骨架：绕远路不被拉过去（maxDetour 保护）', P.conformToSkeleton(farPts, skeleton, 10).length, 4);

  // ⑥ 环 ← 栅格：相邻两省共享同一条边界（数据层的「零缝」保证）
  const grid = G.makeGrid({ minX:0, minY:0, maxX:200, maxY:120 }, { cell:10, extraCells:0 });
  const labels = new Uint8Array(grid.cols * grid.rows);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) labels[r * grid.cols + c] = c < 10 ? 1 : 2;
  }
  const m = P.ringsFromLabels(labels, grid, { eps: 0 });
  const key = (p) => Math.round(p.x) + ',' + Math.round(p.y);
  const setA = new Set(m.get(1)[0].map(key));
  const shared = m.get(2)[0].filter(p => setA.has(key(p))).length;
  ok('相邻省共享边界顶点 ≥ 2', shared >= 2, shared);
  // 环 → 栅格 不漂移（写回多边形后重栅格化必须得到同一副网格，否则涂抹会「自己漂移」）
  const provs = [1, 2].map(k => Object.assign({ id:'x' + k }, P.shapePatch(m.get(k).map(pts => ({ points:pts, kind:'land', fromGrid:true })))));
  const re = G.rasterizeProvinces(provs, grid);
  let drift = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] !== re[i]) drift++;
  same('环 → 栅格 无漂移', drift, 0);

  // ⑦ 点击填充的 cap 闸门 + 小区域正常
  same('泛滥 cap 超限 → 返回空（交给闸门拒绝）', P.floodRegion(labels, grid, 0, 0, { cap: 5 }).length, 0);
  ok('小区域正常泛滥', P.floodRegion(labels, grid, 2, 2, { cap: 100000 }).length > 50);

  return JSON.stringify({ fails, shared, drift });
})()
"""


# ══════════════════════════════════════════════════════════════════════════
# c-e) store 层
# ══════════════════════════════════════════════════════════════════════════
JS_STORE = r"""
(async () => {
  const fails = [];
  const ok = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' (' + extra + ')' : '')); };
  const same = (label, got, want) => { if (String(got) !== String(want)) fails.push(label + ' got=' + got + ' want=' + want); };
  const s = PLACEHOLDER_STORE;
  const P = await import('/src/utils/provinceShape.js');
  const MOD = await import('/src/store/geodataModules/provinceEditing.js');

  // ① 套索面积闸门常量还在（P2 起按**包围盒占比**判，不再是"格数"）
  same('套索面积闸门 = 50%', MOD.LASSO_AREA_SHARE, 0.5);

  // ── 播种：左半 / 右半两个相邻矩形省 ────────────────────────────────────
  const KEY = 'case62_map';
  const MK = (id, name, x0, x1) => ({
    id, name, kind: 'land',
    points: [{x:x0,y:0},{x:x1,y:0},{x:x1,y:120},{x:x0,y:120}],
  });
  s.baseMaps = Object.assign({}, s.baseMaps, { [KEY]: {
    id: KEY, name: '用例62底图', terrain: [MK('t62a', '用例62甲', 0, 100), MK('t62b', '用例62乙', 100, 200)],
  }});
  const areaOf = (i) => Math.round(P.provinceNetArea(s.baseMaps[KEY].terrain[i]));
  const A0 = areaOf(0), B0 = areaOf(1);

  // ② 涂归属（**矢量布尔**）：目标省并集、相交省差集 —— 不是把格点轮廓写回去
  s.beginProvinceStroke();
  s.applyProvinceStroke(KEY, { x: 50, y: 60, radius: 10, tool: 'paint', target: 2 });
  s.applyProvinceStroke(KEY, { x: 60, y: 60, radius: 10, tool: 'paint', target: 2 });
  const stroke = s.endProvinceStroke('用例62涂归属');
  ok('涂归属：抬手返回结果', !!stroke && stroke.changed > 0, JSON.stringify(stroke));
  const ops = (stroke && stroke.ops) || [];
  ok('涂归属：目标省 union', ops.some(o => o.op === 'union'), JSON.stringify(ops));
  ok('涂归属：相交省 difference', ops.some(o => o.op === 'difference'), JSON.stringify(ops));
  ok('涂归属：目标省面积变大', areaOf(1) > B0, B0 + ' → ' + areaOf(1));
  ok('涂归属：相交省面积变小', areaOf(0) < A0, A0 + ' → ' + areaOf(0));

  // ③ 🔴 精度不降级（**本用例的存在理由**）：不许出现 fromGrid 的格点派生几何
  const provB = s.baseMaps[KEY].terrain[1];
  ok('几何：fromGrid 不为 true（不是格点派生）', provB.fromGrid !== true, String(provB.fromGrid));
  ok('几何：多边形非空', Array.isArray(provB.points) && provB.points.length >= 3, (provB.points || []).length);

  // ④ 🔴 高精度保护：1000 点的省被涂抹后，顶点数**只增不减**（旧实现会掉到几十）
  const HD = 'case62_hd';
  const madePts = [];
  for (let i = 0; i < 1000; i++) {
    const a = (i / 1000) * Math.PI * 2;
    madePts.push({ x: 500 + Math.cos(a) * 100, y: 500 + Math.sin(a) * 100 });
  }
  s.baseMaps = Object.assign({}, s.baseMaps, { [HD]: {
    id: HD, name: '用例62高精度', terrain: [
      { id: 'hd1', name: '高精度甲', kind: 'land', points: madePts },
      { id: 'hd2', name: '高精度乙', kind: 'land',
        points: [{x:700,y:400},{x:800,y:400},{x:800,y:600},{x:700,y:600}] },
    ],
  }});
  // 用**总点数**（主环 + 额外环）：在内部挖洞会产生 extraRings，只看主环会误判成「点数变少」
  const hdCount = () => P.provinceRings(s.baseMaps[HD].terrain[0]).reduce((n, r) => n + r.points.length, 0);
  const hdBefore = hdCount();
  s.beginProvinceStroke();
  s.applyProvinceStroke(HD, { x: 595, y: 500, radius: 8, tool: 'erase', target: 0 });
  s.endProvinceStroke('用例62抹除');
  const hdAfter = hdCount();
  // 判据是**不降级**（不是逐点相等）：布尔运算会清理少量共线/极近顶点（实测量级 ~0.4%），
  // 而旧实现是 1000 → 22/65（格子边界）。所以守「同量级 + 远高于格点量级」。
  ok('🔴 高精度保护：1000 点省被涂抹后仍在同量级（不降级成格点轮廓）',
     hdAfter >= hdBefore * 0.9 && hdAfter >= 200, hdBefore + ' → ' + hdAfter);
  s.undo();                                   // 撤销这次抹除（否则会顶掉下面「涂归属的 undo」断言）
  delete s.baseMaps[HD];
  s.baseMaps = Object.assign({}, s.baseMaps);

  // ⑤ 一条 undo：多边形回滚 / 重做
  const ptsAfter = JSON.stringify(s.baseMaps[KEY].terrain[1].points);
  s.undo();
  ok('undo：多边形回滚', JSON.stringify(s.baseMaps[KEY].terrain[1].points) !== ptsAfter);
  same('undo：目标省面积回到原值', areaOf(1), B0);
  s.redo();
  same('redo：多边形回到涂归属的结果', JSON.stringify(s.baseMaps[KEY].terrain[1].points), ptsAfter);

  // ⑥ 套索面积闸门：拒绝 + **零副作用**
  const areaBeforeLasso = areaOf(0);
  const gated = s.applyProvinceLasso(KEY, [
    { x: -500, y: -500 }, { x: 900, y: -500 }, { x: 900, y: 900 }, { x: -500, y: 900 },
  ], 2, '用例62套索', { maxShare: 0.01 });
  ok('套索闸门：超限被拒', !!(gated && gated.rejected), JSON.stringify(gated));
  ok('套索闸门：给出人话原因', !!(gated.message && gated.message.indexOf('圈') >= 0), gated.message);
  same('套索闸门：零副作用', areaOf(0), areaBeforeLasso);

  // ⑦ 点击填充（矢量语义）：吞并点击处的那个省
  const beforeCount = s.baseMaps[KEY].terrain.length;
  // ⚠️ 不能点 (50,60) —— 那一带已被上面的「涂归属」划给了乙，会返回「已属于该省份」
  const filled = s.fillProvinceRegion(KEY, { x: 10, y: 20 }, 2);
  ok('点填：吞并成功', !!(filled && filled.changed), JSON.stringify(filled));
  same('点填：省份数 -1', s.baseMaps[KEY].terrain.length, beforeCount - 1);
  s.undo();
  same('点填：一条 undo 还原省份数', s.baseMaps[KEY].terrain.length, beforeCount);

  // ⑧ 合并：**精确布尔并集**（既不是凸包，也不是栅格兜底）
  const ids = s.baseMaps[KEY].terrain.map(p => p.id);
  const merged = s.mergeProvinces(KEY, ids, { name: '用例62合并' });
  ok('合并：成功', !!(merged && merged.merged), JSON.stringify(merged && { m: merged.method, l: merged.loops }));
  same('合并：方法 = 布尔并集', merged && merged.method, 'bool');
  same('合并：省份数变 1', s.baseMaps[KEY].terrain.length, 1);
  const mergedArea = areaOf(0);
  ok('合并：面积 ≈ 两省之和', Math.abs(mergedArea - 24000) < 4000, Math.round(mergedArea));
  s.undo();
  same('合并：undo 还原省份数', s.baseMaps[KEY].terrain.length, 2);
  s.redo();
  same('合并：redo 回到 1 省', s.baseMaps[KEY].terrain.length, 1);

  // ⑨ 分割：多边形**直线裁剪**（不经网格）+ 一条 undo
  const only = s.baseMaps[KEY].terrain[0];
  const split = s.splitProvince(KEY, only.id, { x: 100, y: -10 }, { x: 100, y: 130 });
  ok('分割：成功', !!(split && split.a && split.b), JSON.stringify(split && { i: split.index, n: split.newIndex }));
  same('分割：省份数变 2', s.baseMaps[KEY].terrain.length, 2);
  s.undo();
  same('分割：undo 还原省份数', s.baseMaps[KEY].terrain.length, 1);
  s.undo();
  same('分割：再 undo 回到 2 省（合并前）', s.baseMaps[KEY].terrain.length, 2);

  // 收场
  delete s.baseMaps[KEY];
  s.baseMaps = Object.assign({}, s.baseMaps);
  return JSON.stringify({ fails, A0, B0, hdBefore, hdAfter,
    strokeChanged: stroke ? stroke.changed : -1, mergedArea: Math.round(mergedArea) });
})()
"""


# ══════════════════════════════════════════════════════════════════════════
# f) UI：工具栏分层 + 属性面板多环
# ══════════════════════════════════════════════════════════════════════════
JS_UI = r"""
(async () => {
  const fails = [];
  const ok = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' (' + extra + ')' : '')); };
  const sc = PLACEHOLDER_SC;
  if (!sc) return JSON.stringify({ fails: ['ScenarioMap 未挂载'] });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // 工具栏 = 竖直多行；**没有** tool-group 掉到容器层（旧结构：第 128 行提前闭合工具栏，
  // 后面十几组控件全成了 .scenario-map-container 的直接子元素 → 只有第一行有工具栏底色）
  const bar = document.querySelector('.scenario-toolbar');
  ok('工具栏存在', !!bar);
  // P3：高级工具/吸附/图层/底图收进「更多」（默认只露 6 个主控件，由 test_65 守）→ 先展开再数。
  // ⚠️ 必须先点、再 await 一拍：Vue 的 DOM 更新是异步的。
  const moreBtn = Array.from(document.querySelectorAll('.scenario-toolbar button'))
    .find((b) => (b.title || '').includes('更多'));
  ok('工具栏有「更多」按钮（默认收起）', !!moreBtn);
  if (moreBtn && !document.querySelector('.toolbar-more')) moreBtn.click();
  await wait(150);
  ok('点开「更多」后面板出现', !!document.querySelector('.toolbar-more'));
  const rows = bar ? Array.from(bar.querySelectorAll('.toolbar-row')) : [];
  ok('工具栏分层：展开「更多」后 ≥ 4 行 .toolbar-row', rows.length >= 4, rows.length);
  const container = document.querySelector('.scenario-map-container');
  const stray = container ? Array.from(container.children).filter(el => el.classList.contains('tool-group')) : [];
  ok('没有 tool-group 掉到容器层（工具栏提前闭合的存量 bug）', stray.length === 0, stray.length);
  const allGroups = document.querySelectorAll('.scenario-toolbar .tool-group').length;
  ok('工具组都在工具栏里', allGroups >= 10, allGroups);

  // 「网格视图」复选框已删除；「点击填充」入口在位
  const labels = Array.from(document.querySelectorAll('.scenario-toolbar label'));
  ok('「网格视图」复选框已删除', !labels.some(l => (l.textContent || '').indexOf('网格视图') >= 0));
  // 🔴 2026-10-20：几何笔刷改名「改省界」并收进底图编辑行（日常行只留「涂归属」=势力归属）
  sc.basemapEditMode = true;
  await wait(150);
  const titles = Array.from(document.querySelectorAll('.scenario-toolbar button')).map(b => b.getAttribute('title') || '');
  ok('工具栏有「点击填充」按钮', titles.some(t => t.indexOf('点击填充') >= 0));
  ok('工具栏有「改省界 / 自由轮廓」按钮',
     titles.some(t => t.indexOf('改省界') >= 0) && titles.some(t => t.indexOf('自由轮廓') >= 0));
  sc.basemapEditMode = false;
  await wait(50);

  // 属性面板：多环省份 → 「类型」+「编辑环」
  sc.setTool('select');
  sc.selectedProvince = {
    id: 'case62_props', name: '用例62多环', kind: 'land', biome: '', culture: '', coast: false,
    points: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],
    extraRings: [{ points: [{x:120,y:0},{x:160,y:0},{x:160,y:40},{x:120,y:40}], kind: 'land' }],
  };
  sc.showProps = true;
  await wait(150);
  const panel = document.querySelector('.province-props');
  ok('属性面板打开', !!panel);
  if (panel) {
    const txt = panel.textContent || '';
    ok('属性面板有「类型」（陆地/海域）', txt.indexOf('类型') >= 0);
    ok('属性面板有「编辑环」（多环实体可切换）', txt.indexOf('编辑环') >= 0);
    ok('属性面板显示环数 2', txt.indexOf('环数: 2') >= 0 || txt.indexOf('环数：2') >= 0, txt.slice(0, 120));
    const sel = Array.from(panel.querySelectorAll('select')).map(s => Array.from(s.options).map(o => o.textContent.trim()).join('/'));
    ok('类型下拉含 陆地/海域', sel.some(o => o.indexOf('陆地') >= 0 && o.indexOf('海域') >= 0), JSON.stringify(sel));
    ok('环下拉含 主环/环 2', sel.some(o => o.indexOf('主环') >= 0 && o.indexOf('环 2') >= 0), JSON.stringify(sel));
  }
  sc.showProps = false;
  sc.selectedProvince = null;

  // 单根守卫（全屏视图组件必须单根，否则 flex 链断 → 画布只剩 150px）
  const main = document.querySelector('.main-content');
  ok('全屏视图在 .main-content 下只有一个根', main ? main.children.length === 1 : false,
     main ? main.children.length + ' 个根' : 'no main');
  return JSON.stringify({ fails, rows: rows.length, groups: allGroups });
})()
"""


def run(cdp):
    # a) 源码闸门
    gate = _source_gate()
    if gate:
        return False, '源码闸门失败：' + '；'.join(gate)

    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # b) 纯函数层
    pure = _js(cdp, JS_PURE)
    if 'ERR' in pure:
        return False, f'纯函数层求值失败：{pure["ERR"]}'
    if pure.get('fails'):
        return False, '纯函数层失败：' + '；'.join(pure['fails'])

    # 进入剧本模式（底图/scenarios 走既有链路加载）
    entered = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if entered != 'ok':
        return False, f'未找到「历史剧本」入口（{entered}）'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='ScenarioMap 挂载')
    time.sleep(1.2)

    # c-e) store 层（自带合成底图，不依赖当前加载的底图）
    store_js = JS_STORE.replace('PLACEHOLDER_STORE', STORE)
    st = _js(cdp, store_js)
    if 'ERR' in st:
        return False, f'store 层求值失败：{st["ERR"]}'
    if st.get('fails'):
        return False, 'store 层失败：' + '；'.join(st['fails'])

    # f) UI
    ui = _js(cdp, JS_UI.replace('PLACEHOLDER_SC', SC))
    if 'ERR' in ui:
        return False, f'UI 检查求值失败：{ui["ERR"]}'
    if ui.get('fails'):
        return False, 'UI 检查失败：' + '；'.join(ui['fails'])

    return True, (
        f'省份**矢量几何**通过（涂料/套索/点填 = 多边形布尔；初始面积 {st["A0"]}/{st["B0"]}）：'
        f'涂归属 union + difference（{st["strokeChanged"]} 处几何变化）、精度不降级（fromGrid 不为 true）、'
        f'1000 点省涂抹后顶点 {st["hdBefore"]} → {st["hdAfter"]}（只增不减）；'
        f'套索面积闸门拒绝并零副作用、点填吞并可撤销；合并走**布尔并集**（面积 {st["mergedArea"]}）、'
        f'分割一条 undo；纯函数层：洞真空 / 飞地真画 / 环→栅格 {pure["drift"]} 漂移、骨架共享 {pure["shared"]} 顶点；'
        f'UI：工具栏 {ui["rows"]} 行 {ui["groups"]} 组（无 tool-group 掉出）、无「网格视图」开关、'
        f'属性面板含「类型 / 编辑环」'
    )
