#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_93_vertex_overlap_gate — 顶点编辑的**压叠闸门**（2026-10-11）

背景（这是 2026-10-01 明确写进文档的一条「已知边界」）：
    「顶点编辑造成的压叠不在任何闸门范围内」—— 因为拖顶点是细粒度动作，
    当时判断"拖到一半弹确认更坏"，于是干脆不守。代价：把 A 省的一个顶点拖到 B 省肚子里，
    两个省就压在一起了，而**点选 / 归属上色 / 势力标签三处都会开始互相打架**
    （命中口径 `findProvinceAt` 是自顶向下，视觉上被压在下面的那个才点得到）。

本轮的收口方式（不是"拖到一半弹窗"，恰好相反）：
    · 判定点放在**抬手那一帧、写库之前** —— 候选几何 `{...prov, ...patch}` 还没进 store，
      用户点「取消」就什么都不发生，形状原地保持拖动前（不需要"写完再撤销"那套，
      也就不会给一次拖拽留下两条历史）。
    · 只在**这次拖动让它更压**时才问（`after.ratio > 阈值 且 恶化量 > 5%`）：
      真实数据里有**本来就互相压着**的省份（格点时代留下的），见谁都弹 = 把既存问题
      算到用户这一下手势头上，很快就会练成"闭眼点确定"。

判据分两段：
    g) 源码闸门（先剥注释）
    h) 真机行为：造两个省 → 真的派发 mousedown/mousemove/mouseup → 看几何有没有被写、
       以及 confirm 弹了几次、弹窗里写了什么
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json            # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉行注释与块注释（本仓纪律：判据先剥注释，否则注释里的旧名字会把守卫判红）。"""
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
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    ov = _code_only(_read('src/renderer/src/utils/provinceOverlap.js'))
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))

    # g1 判定单源：组件**只能**走 store 的预检口（`test_79` f0 已硬断言组件里连
    #    `measureProvinceOverlap` 这个名字都不许出现 —— 这条是同一纪律的反面表述）
    for needle, label in [
        ('store.previewProvinceOverlap(', '组件经 store 预检（判定不在组件里）'),
        ('function confirmVertexMoveOverlap(', '顶点编辑闸门函数在场'),
    ]:
        if needle not in sc:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    if 'measureProvinceOverlap' in sc:
        fails.append('组件里又出现了度量函数本身（判定必须留在 store / 纯函数层单源）')

    # g1b store 侧必须真的提供这个只读预检口，并且**导出到 store**（否则组件调不到）
    if 'function previewProvinceOverlap(' not in se:
        fails.append('store 侧没有 previewProvinceOverlap（顶点的压叠预检没有落点）')
    if 'previewProvinceOverlap,' not in se:
        fails.append('previewProvinceOverlap 没有进 store 的导出表（组件会调不到）')

    # g2 判据位置：`writeRingPoints` 出来的 patch **必须先过闸门**才交给 updateBaseProvince
    #    （写成"先写库再问要不要撤销"也能跑，但那会给一次拖拽留下两条历史）
    # 2026-10-31：抬手收口搬进 scenario/interaction/pointer.js —— 判据把那份源码一起读
    _ptr = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'src', 'renderer', 'src', 'scenario', 'interaction', 'pointer.js')
    with open(_ptr, encoding='utf-8') as f:
        _ptr_src = _code_only(f.read()) if '_code_only' in globals() else f.read()
    if 'confirmVertexMoveOverlap(prov, { ...prov, ...patch })' not in (sc + '\n' + _ptr_src):
        fails.append('源码闸门缺失：顶点拖拽的写库必须被 confirmVertexMoveOverlap 守卫（先量后写）')

    # g3 「只对恶化发问」这条语义必须在场（否则既存压叠会天天弹窗）
    if 'VERTEX_OVERLAP_WORSEN_MARGIN' not in sc:
        fails.append('源码闸门缺失：VERTEX_OVERLAP_WORSEN_MARGIN（只对"这次拖动让它更压"发问）')

    # g4 闸门必须把**自己**排除（skipId），否则连"什么都没压"的省都会 100% 压在自己身上
    if 'skipId' not in sc:
        fails.append('源码闸门缺失：闸门没有 skipId（会把自己算成占用者 → 次次必拦）')

    # g5 纯函数层仍提供 skipId 语义（被 g4 依赖）
    if 'opts.skipId' not in ov:
        fails.append('provinceOverlap.js 不再支持 skipId（顶点编辑闸门会失去判据）')

    notes.append(f'源码闸门 {6 - len(fails)} 项' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


JS = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

  // 🔴 纪律：本用例会走到 confirm —— headless 里没人点 = CDP 命令永不返回。
  //    这里装一个**可控**的 confirm：计数 + 记文案 + 按开关返回。
  const realConfirm = window.confirm;
  window.__c93 = { calls: 0, last: '', answer: false };
  window.confirm = (msg) => { window.__c93.calls++; window.__c93.last = String(msg || ''); return window.__c93.answer; };

  const KEY = 'case93';
  const sq = (x, y, w, h, id, name) => ({
    id, name, kind: 'land',
    points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  });
  const A = sq(0, 0, 600, 600, 'g93a', '大省甲');
  const B = sq(700, 0, 100, 100, 'g93b', '小省乙');
  // 底图直接写进 store（画布只认 baseMapKey 指向的那张）
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例93底图', terrain: [A, B], provinceLabels: undefined } };
  sc.baseMapKey = KEY;
  sc.setTool('vertex');
  sc.selectedProvince = { id: 'g93b' };
  sc.activeRingIdx = 0;
  // 🔴 关掉两种吸附：50px 网格吸附会把「拖到 710」变成「拖到 709.57」，
  //    而下一次 mousedown 按 700 找顶点就落空（距离 9.57 > px(8) 阈值）→
  //    拖拽根本没开始，闸门自然不会被触发（首版实测 h2/h3 双双假红）。
  //    用例要测的是**闸门**，不是吸附 —— 吸附另有 test_66/72 守。
  sc.snapToGridEnabled = false;
  sc.snapToEdgeEnabled = false;
  await tick(80);

  const R = () => s.baseMaps[KEY].terrain;
  const B0 = () => R().find((p) => p.id === 'g93b');
  // 只看**位置**：首次选中顶点时组件会补一次贝塞尔切线（控制点进 points），那不改形状
  const pos = (p) => JSON.stringify((p.points || []).map((q) => [q.x, q.y]));

  // 世界坐标 → 屏幕坐标（screenToWorld 的逆；相机三件套都在 setupState 上）
  const cv = document.querySelector('.scenario-map-container canvas');
  ok('h0 找得到剧本画布', !!cv);
  if (!cv) { window.confirm = realConfirm; delete s.baseMaps[KEY]; return JSON.stringify({ fails, notes }); }
  const rect = cv.getBoundingClientRect();
  const S = (w) => ({ cx: rect.left + w.x * sc.cameraScale + sc.cameraX, cy: rect.top + w.y * sc.cameraScale + sc.cameraY });
  const ev = (type, pt, extra) => new MouseEvent(type, Object.assign({ clientX: pt.cx, clientY: pt.cy, button: 0, bubbles: true }, extra || {}));
  const drag = (from, to) => {
    sc.activeVertexIdx = -1;                       // 关掉切线手柄命中分支（只测顶点拖拽）
    const a = S(from), b = S(to);
    sc.onMouseDown(ev('mousedown', a));
    sc.onMouseMove(ev('mousemove', b));
    sc.onMouseUp(ev('mouseup', b));
  };
  // 目标顶点 = B 的**当前** points[0]（每轮都重新取：上一轮拖过之后位置就变了，
  // 写死初值会让 mousedown 落在顶点之外 → 拖拽没开始 → 闸门不被触发 = 假红）
  const V0 = () => { const p = (B0().points || [])[0]; return { x: p.x, y: p.y }; };

  // ── h1 小挪一下（根本不碰甲省）→ 不许弹窗，且必须真的写进去 ─────────────
  {
    const before = pos(B0());
    window.__c93.calls = 0;
    const q = V0();
    drag(q, { x: q.x + 10, y: q.y });
    await tick(60);
    ok('h1 不构成压叠的拖动**不弹窗**（不打扰）', window.__c93.calls === 0, window.__c93.calls + ' 次');
    ok('h1 不构成压叠时拖动**真的生效**（不是"一律不写"的假绿）', pos(B0()) !== before, pos(B0()).slice(0, 60));
  }

  // ── h2 拖进甲省（一个顶点拖到 x=0）→ 必须弹窗；回答「取消」= 一个字都不准写 ──
  let afterDecline = '';
  {
    const before = pos(B0());
    window.__c93.calls = 0;
    window.__c93.answer = false;
    const q = V0();
    drag(q, { x: 0, y: q.y });
    await tick(60);
    ok('h2 会把省拖到别人身上 → 弹一次确认', window.__c93.calls === 1, window.__c93.calls + ' 次');
    ok('h2 弹窗点名占用者与百分比（用户要知道压到了谁）',
       /大省甲/.test(window.__c93.last) && /\d+%/.test(window.__c93.last), window.__c93.last.slice(0, 90));
    ok('h2 「取消」= 形状原地保持拖动前（先量后写，不需要撤销兜底）',
       pos(B0()) === before, pos(B0()).slice(0, 60));
    afterDecline = pos(B0());
    notes.decline = (window.__c93.last.match(/\d+%/g) || []).join('/');
  }

  // ── h3 同一动作回答「确定」→ 必须写进去（闸门是"问"，不是"硬拒"）─────────
  {
    window.__c93.calls = 0;
    window.__c93.answer = true;
    const q = V0();
    drag(q, { x: 0, y: q.y });
    await tick(60);
    ok('h3 确认后弹窗只问一次', window.__c93.calls === 1, window.__c93.calls + ' 次');
    ok('h3 「确定」= 真的应用这次移动', pos(B0()) !== afterDecline, pos(B0()).slice(0, 60));
    ok('h3 应用后乙省确实伸进了甲省（几何真的变了，不是同一形状换了个壳）',
       (B0().points || []).some((q) => q.x <= 5), JSON.stringify((B0().points || []).map((q) => [q.x, q.y])));
  }

  // ── h4 已经压着了，再微调 → 不许再弹（"只对恶化发问"）────────────────────
  {
    const now = B0();
    const q0 = now.points[1] || { x: 800, y: 0 };     // 右上角
    window.__c93.calls = 0;
    drag({ x: q0.x, y: q0.y }, { x: q0.x + 6, y: q0.y });
    await tick(60);
    ok('h4 本来就压着 + 微调 → 不再弹窗（不把既存压叠算到这一下头上）',
       window.__c93.calls === 0, window.__c93.calls + ' 次');
    notes.preexisting = '微调后仍未打扰';
  }

  // ── h5 一次拖拽 = **一条** undo（闸门不能把一次拖拽拆成两条历史）──────────
  //    顺序很重要：h3「确认后应用」与 h4「微调」各是一条命令，所以第一次撤销还原的是 h4。
  {
    s.undo();
    await tick(40);
    const q1 = (B0().points || [])[1];
    ok('h5 撤销一次 = 还原上一轮微调（一次拖拽只压一条命令）',
       !!q1 && Math.abs(q1.x - 800) < 1e-6, JSON.stringify(q1));
    s.undo();
    await tick(40);
    ok('h5 再撤一次 = 连「确认后应用」那次移动也还原（闸门不给一次拖拽留两条历史）',
       !(B0().points || []).some((q) => q.x <= 5),
       JSON.stringify((B0().points || []).map((q) => [q.x, q.y])).slice(0, 80));
  }

  // ── h6 清空全部剧本（2026-10-11 接活死入口 removeAllScenarios）──────────
  //    这条闸门的价值在于**语义边界**：只删剧本，底图与省份一个字都不许动。
  {
    // 造一条剧本 + 一个底图，然后走「清空全部剧本」的组件函数
    s.scenarios = { ...s.scenarios, [KEY + '/甲']: { id: KEY + '/甲', ownerKey: KEY, name: '甲', ownership: { g93a: 'pol_x' } } };
    sc.showScenarioManager = true;
    await tick(80);
    const btn = document.querySelector('[data-testid="scenario-clear-all"]');
    ok('h6 「清空全部剧本」按钮在剧本管理对话框里', !!btn);
    const terrainBefore = JSON.stringify((s.baseMaps[KEY].terrain || []).map((p) => p.id));
    // ⚠️ confirm 是在 click() 里**同步**调用的 → 返回值必须在 click **之前**设好
    window.__c93.answer = false;          // 第一次：取消 → 什么都不该发生
    window.__c93.calls = 0;
    if (btn) btn.click();
    await tick(60);
    const n1 = Object.keys(s.scenarios || {}).length;
    window.__c93.answer = true;           // 第二次：确认
    if (btn) btn.click();
    await tick(60);
    const n2 = Object.keys(s.scenarios || {}).length;
    ok('h6 取消时不清空', n1 >= 1, n1 + ' 条');
    ok('h6 确认后剧本被清空', n2 === 0, n2 + ' 条');
    ok('h6 🔴 底图与省份一个字都没动（清剧本 ≠ 清地图）',
       JSON.stringify((s.baseMaps[KEY].terrain || []).map((p) => p.id)) === terrainBefore,
       ((s.baseMaps[KEY].terrain || []).length) + ' 省');
    s.undo();
    await tick(40);
    ok('h6 一条撤销把剧本找回来', Object.keys(s.scenarios || {}).length >= 1, Object.keys(s.scenarios || {}).length + ' 条');
    sc.showScenarioManager = false;
    notes.clearAll = '清空 ' + n2 + ' 条 / 省份保留 / 一条撤销可回';
  }

  window.confirm = realConfirm;
  delete s.baseMaps[KEY];
  delete s.scenarios[KEY + '/甲'];
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
    time.sleep(1.2)

    ok, res = eval_json(cdp, JS.replace('__SC__', SC).replace('__STORE__', STORE), desc='93 顶点压叠闸门')
    if not ok:
        return False, f'探针求值失败：{res}'
    fails += res.get('fails', [])
    n = res.get('notes', {})
    if n.get('decline'):
        notes.append(f'拒绝时文案里的百分比：{n["decline"]}')
    if n.get('preexisting'):
        notes.append(n['preexisting'])

    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
