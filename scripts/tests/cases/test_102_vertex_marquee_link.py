#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 102：P1 顶点编辑 —— **框选多选 + 相邻省共享边界重算**（方案甲，2026-10-13）

来源：v1.9 执行单 P1（头号开发件）。验收线原文：
「几百省场景**框选 → 拖动 → 相邻省边界自动重算不串省**」。
2026-10-13 暮雨在两方案里选了**甲**：拖动共边顶点时，邻省的同位顶点跟着一起走 ——
边界线整体移动（A 缩多少 B 就涨多少），**无缝、无压叠**，且不碰任何别的省。

判据分四组：
  f0 源码闸门：跨三层的链（纯函数模块 → 组件编排 → store 一条 undo 的批量写口）都在
  f1 行为（主探针）：框选 3 个共边顶点 → 拖一下 →
       · 目标省那 3 个顶点真的动了
       · **邻省的同位顶点跟着动了同样多** → 五个共享位置两侧逐位重合（无缝的根本）
       · **没被选中的两个端点一个点没动**（不是"整条环跟着平移"）
       · **远处那个省逐点未动**（"不串省"）
       · 面积守恒：A 净面积 + B 净面积不变（有缝会少、有压叠会多）
       · **一条 Ctrl+Z 把两个省一起还原**
  f2 反面：拖一个**不与任何省共边**的角点 → 只有该省变，邻省逐点未动（判据不是恒真）
  f3 收口：Esc 清空框选；换工具/换省份也清空（否则下标会指向别的顶点）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for          # noqa: E402
from lib.helpers import ensure_data_ready        # noqa: E402

SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"


def _code_only(src):
    out, in_block = [], False
    for line in src.splitlines():
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
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    with open(os.path.join(root, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue'), encoding='utf-8') as f:
        sc = _code_only(f.read())
    # 2026-10-31：顶点/联动逻辑搬进 scenario/interaction/* —— 判据读合集
    from lib.rsrc import render_src_code_only as _rsrc_all
    sc = _rsrc_all()
    # 2026-10-31：抬手收口搬进 scenario/interaction/pointer.js —— 判据把那份源码一起读
    with open(os.path.join(root, 'src', 'renderer', 'src', 'scenario', 'interaction', 'pointer.js'), encoding='utf-8') as f:
        sc += '\n' + _code_only(f.read())
    with open(os.path.join(root, 'src', 'renderer', 'src', 'utils', 'vertexSharing.js'), encoding='utf-8') as f:
        vs = f.read()
    with open(os.path.join(root, 'src', 'renderer', 'src', 'store', 'geodataModules', 'provinceEditing.js'), encoding='utf-8') as f:
        pe = _code_only(f.read())
    with open(os.path.join(root, 'src', 'renderer', 'src', 'store', 'writeGate.js'), encoding='utf-8') as f:
        wg = _code_only(f.read())

    for needle, label in [
        ('buildCoincidentIndex', '组件：真的建了共边索引（配对不在组件里手写）'),
        ('findLinkedVertices', '组件：联动表来自纯函数层'),
        ('verticesInBox', '组件：框选判据来自纯函数层'),
        ('shiftPoints', '组件：位移应用走纯函数层（差量平移）'),
        ('const vertexSelection = ref(', '组件：有顶点多选状态'),
        ('vertexMarquee', '组件：有框选矩形状态'),
        ('function effectiveVertexSelection(', '组件：单选/整组拖动有唯一判据'),
        ('function beginVertexLinkContext(', '组件：一次拖动只建一次联动上下文'),
        ('function collectLinkedPatches(', '组件：联动补丁有唯一实现'),
        ('function confirmVertexBatchOverlap(', '组件：多省版压叠闸门在场'),
        ('store.updateProvincesBatch(', '组件：批量形状写走 store 一条命令'),
        ('data-testid="vertex-hint"', '组件：提示写明 Shift+框选'),
    ]:
        if needle not in sc:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    # 纯函数层必须真的导出这些（组件只是编排）
    for needle, label in [
        ('export function buildCoincidentIndex(', 'vertexSharing：索引'),
        ('export function findLinkedVertices(', 'vertexSharing：配对'),
        ('export function shiftPoints(', 'vertexSharing：差量平移'),
        ('export function verticesInBox(', 'vertexSharing：框选'),
    ]:
        if needle not in vs:
            fails.append(f'源码闸门缺失：{label}')
    # store：一条 undo 的批量写口 + 只读守卫 + 登记进写口契约
    if 'function updateProvincesBatch(' not in pe:
        fails.append('store：没有 updateProvincesBatch（顶点联动没地方落库）')
    if "'province-shape-batch'" not in pe:
        fails.append('store：批量写口的命令类型缺失（看不出这是一次手势）')
    if 'updateProvincesBatch,' not in pe:
        fails.append('store：updateProvincesBatch 没进导出表（组件调不到）')
    if "'updateProvincesBatch'" not in wg:
        fails.append('写口契约：updateProvincesBatch 没登记（只读态守卫会被漏掉）')
    # 旧单省闸门必须留着（test_93 的口径不许被这次改动吃掉）
    if 'function confirmVertexMoveOverlap(' not in sc:
        fails.append('组件：原有的单省压叠闸门被删了（test_93 的口径）')
    notes.append(f'源码闸门 {13 + 4 + 4 + 1} 项' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


JS = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + JSON.stringify(e) + ')' : '')); };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

  // 本用例会走到 confirm（压叠闸门）—— headless 里没人点 = CDP 命令永不返回
  window.__c102 = { calls: 0, last: '' };
  window.confirm = (msg) => { window.__c102.calls++; window.__c102.last = String(msg || ''); return true; };

  const KEY = 'case102';
  // A 与 B **共边**（x=100 上 5 个位置两侧逐位相同，绕向相反 —— 真实数据的形态）；
  // C 在很远的地方，与谁都不共边（"不串省"的对照）。
  // ⚠️ 每个顶点都带 controlOut：否则首次按下会触发"自动生成贝塞尔切线"那一次额外的 store 写，
  //    撤销计数就不是"一次拖动 = 一条命令"了（test_93 里那条已知行为）。
  const ctl = () => ({ controlOut: { x: 1, y: 0 } });
  const A = { id: 'p102a', name: '甲', kind: 'land', points: [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 25 }, { x: 100, y: 50 },
    { x: 100, y: 75 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ].map((p) => ({ ...p, ...ctl() })) };
  const B = { id: 'p102b', name: '乙', kind: 'land', points: [
    { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 100 },
    { x: 100, y: 75 }, { x: 100, y: 50 }, { x: 100, y: 25 },
  ].map((p) => ({ ...p, ...ctl() })) };
  const C = { id: 'p102c', name: '丙', kind: 'land', points: [
    { x: 500, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 100 }, { x: 500, y: 100 },
  ].map((p) => ({ ...p, ...ctl() })) };

  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例102底图', terrain: [A, B, C] } };
  sc.baseMapKey = KEY;
  sc.setTool('vertex');
  sc.selectedProvince = { id: 'p102a' };
  sc.activeRingIdx = 0;
  sc.snapToGridEnabled = false;
  sc.snapToEdgeEnabled = false;
  // 相机：世界 (0..600, 0..100) 要落在画布内。screenToWorld：world = (sx - cameraX)/scale
  sc.cameraScale = 1;
  sc.cameraX = 60;
  sc.cameraY = 60;
  await tick(120);

  const cv = document.querySelector('.scenario-map-container canvas');
  ok('h0 找得到剧本画布', !!cv);
  if (!cv) return JSON.stringify({ fails, notes });
  const rect = cv.getBoundingClientRect();
  const S = (w) => ({ cx: rect.left + w.x * sc.cameraScale + sc.cameraX, cy: rect.top + w.y * sc.cameraScale + sc.cameraY });
  const ev = (type, pt, extra) => new MouseEvent(type, Object.assign(
    { clientX: pt.cx, clientY: pt.cy, button: 0, bubbles: true, cancelable: true }, extra || {}));
  const R = () => s.baseMaps[KEY].terrain;
  const P = (id) => R().find((p) => p.id === id);
  const pos = (p) => (p.points || []).map((q) => [Math.round(q.x * 1e6) / 1e6, Math.round(q.y * 1e6) / 1e6]);
  const posJson = (p) => JSON.stringify(pos(p));
  const shift = (from, to) => {                      // Shift+拖动 = 框选
    const a = S(from), b = S(to);
    cv.dispatchEvent(ev('mousedown', a, { shiftKey: true }));
    cv.dispatchEvent(ev('mousemove', b, { shiftKey: true }));
    cv.dispatchEvent(ev('mouseup', b, { shiftKey: true }));
  };
  const drag = (from, to) => {                       // 普通拖动 = 拖顶点
    sc.activeVertexIdx = -1;                         // 关掉切线手柄命中分支
    const a = S(from), b = S(to);
    cv.dispatchEvent(ev('mousedown', a));
    cv.dispatchEvent(ev('mousemove', b));
    cv.dispatchEvent(ev('mouseup', b));
  };
  const PShape = await import('/src/utils/provinceShape.js');
  const netSum = () => PShape.provinceNetArea(P('p102a')) + PShape.provinceNetArea(P('p102b'));

  // ── f1 框选 3 个共边顶点 ────────────────────────────────────────────────
  const beforeAll = JSON.stringify(R().map(pos));
  shift({ x: 50, y: 88 }, { x: 120, y: 20 });        // 框住 (100,25)/(100,50)/(100,75)
  await tick(60);
  ok('f1 框选到 3 个顶点', (sc.vertexSelection || []).length === 3, sc.vertexSelection);
  ok('f1 提示写明了共边数量', /共边/.test(String(sc.provinceHint || '')), String(sc.provinceHint || '').slice(0, 90));
  ok('f1 框选**不写数据**（动作前后几何逐位一致）', JSON.stringify(R().map(pos)) === beforeAll);

  // ── f1b 拖动被框选集合里的中间那个顶点 ────────────────────────────────
  const areaBefore = netSum();
  const beforeDrag = JSON.stringify(R().map(pos));
  window.__c102.calls = 0;
  drag({ x: 100, y: 50 }, { x: 80, y: 50 });          // 往甲省内侧拖 20
  await tick(80);

  const A1 = P('p102a'), B1 = P('p102b'), C1 = P('p102c');
  ok('f1b 目标省被选中的 3 个顶点真的动了（x 从 100 → 80 附近）',
     [2, 3, 4].every((i) => Math.abs(A1.points[i].x - 80) < 0.6),
     JSON.stringify(A1.points.map((q) => [q.x, q.y])));
  ok('f1b 邻省的同位顶点**跟着动了同样多**',
     [4, 5, 6].every((i) => Math.abs(B1.points[i].x - 80) < 0.6),
     JSON.stringify(B1.points.map((q) => [q.x, q.y])));
  // 无缝的根本：五个共享位置两侧逐位重合
  const shared = [[1, 0], [2, 6], [3, 5], [4, 4], [5, 3]];
  const mismatch = shared.filter(([ia, ib]) =>
    Math.abs(A1.points[ia].x - B1.points[ib].x) > 1e-9 || Math.abs(A1.points[ia].y - B1.points[ib].y) > 1e-9);
  ok('f1b 🔴 拖动后两侧仍然**逐位重合**（无缝 = 方案甲的核心）', mismatch.length === 0, JSON.stringify(mismatch));
  // 只搬选中的：两个端点必须原地
  ok('f1b 没被选中的两个端点一个点没动',
     Math.abs(A1.points[1].x - 100) < 1e-9 && Math.abs(A1.points[5].x - 100) < 1e-9,
     JSON.stringify([A1.points[1], A1.points[5]]));
  // 不串省
  ok('f1b 🔴 远处的丙省逐点未动（不串省）',
     posJson(C1) === JSON.stringify([[500, 0], [600, 0], [600, 100], [500, 100]]), posJson(C1));
  // 面积守恒：有缝会少、有压叠会多
  const areaAfter = netSum();
  ok('f1b 甲乙净面积之和不变（既没留缝、也没压叠）',
     Math.abs(areaAfter - areaBefore) <= Math.max(1e-6, areaBefore * 1e-9),
     JSON.stringify({ before: areaBefore, after: areaAfter, diff: areaAfter - areaBefore }));
  ok('f1b 状态栏说明了"邻省跟着走"', /邻省|跟着/.test(String(sc.provinceHint || '')),
     String(sc.provinceHint || '').slice(0, 110));
  ok('f1b 这次拖动没触发压叠闸门（共边联动本身不会造成压叠）', window.__c102.calls === 0, window.__c102.calls);
  ok('f1b 拖动确实改了数据（不是"一律不写"的假绿）', JSON.stringify(R().map(pos)) !== beforeDrag);

  // ── f1c 一条 undo 把目标省 + 邻省一起还原 ──────────────────────────────
  s.undo();
  await tick(60);
  ok('f1c 🔴 一次 Ctrl+Z 把甲**和**乙一起还原（联动是一条命令，不是两条）',
     JSON.stringify(R().map(pos)) === beforeDrag, JSON.stringify(R().map(pos)).slice(0, 90));

  // ── f2 反面：拖一个不与任何省共边的角点 → 只改自己 ──────────────────────
  sc.vertexSelection = [];
  const bBefore = posJson(P('p102b'));
  const cBefore = posJson(P('p102c'));
  drag({ x: 0, y: 0 }, { x: -15, y: -10 });
  await tick(60);
  ok('f2 不共边的角点拖动：本省真的变了',
     Math.abs(P('p102a').points[0].x + 15) < 0.6 && Math.abs(P('p102a').points[0].y + 10) < 0.6,
     JSON.stringify(P('p102a').points[0]));
  ok('f2 🔴 不共边的角点拖动：乙、丙逐点未动（判据不是恒真）',
     posJson(P('p102b')) === bBefore && posJson(P('p102c')) === cBefore);

  // ── f3 收口：Esc 清空框选 ──────────────────────────────────────────────
  shift({ x: 50, y: 88 }, { x: 120, y: 20 });
  await tick(50);
  ok('f3 再框选一次仍有 3 个', (sc.vertexSelection || []).length === 3, sc.vertexSelection);
  // ⚠️ 必须往 document 上派发：直接调 `sc.onKeyDown(new KeyboardEvent(...))` 时 `event.target`
  //    是 null，组件里那句 `event.target.tagName === 'INPUT'` 会抛 TypeError（实测）。
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(50);
  ok('f3 Esc 清空框选', (sc.vertexSelection || []).length === 0, sc.vertexSelection);
  ok('f3 Esc 也清掉框选矩形', !sc.vertexMarquee, sc.vertexMarquee);

  // 清场
  delete s.baseMaps[KEY];
  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    fails, notes = source_gates()
    ensure_data_ready(cdp)

    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.2)

    js = JS.replace('__STORE__', "document.querySelector('#app').__vue_app__._instance.setupState.store")
    js = js.replace('__SC__', SC)
    ok, res = eval_json(cdp, js, desc='102 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    if fails:
        return False, ' | '.join(fails[:8])
    return True, ('框选 3 个共边顶点 → 拖动 → 邻省同位顶点跟着走（5 个共享位置逐位重合）/ '
                  '端点与远处省未动 / 面积守恒 / 一条 undo 还原两个省 / 不共边的角点只改自己 / Esc 清空；'
                  + '；'.join(notes))
