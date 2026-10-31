#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 106：剧本底图的**河流节点编辑**（2026-10-17）

真实来由（读代码 + 真机探针核实，不是猜的）：
  用户定调「保底也要做，强化地图编辑器本身，让用户可以随心所欲画河流」，
  并明确要「流畅的笔刷绘制 + 事后可编辑可撤除」。核实后底图侧的真实状态是：
    ① `onMouseMove` 里**根本没有 river 分支** → 「按住拖出笔迹」画不出来
       （`onMouseDown` 每按一下落一个点，移动过程零采样）；
    ② `finishRiverDraft` **只挂在小双击上** → 画布写着"按住拖"，松手却什么也不发生；
    ③ 底图侧只有 add / remove，**没有 update** → 画完之后想微调（拖节点 / 加拐点 /
       删单个节点）在数据层与交互层**两个地方都没有出口**，只能删掉整条重画
       （重画会换 id/名字、丢掉调好的 width）；
    ④ `onCanvasClick` 的 river 分支排在 `if (viewMode !== 'scenario' …) return` **之后**，
       而 `viewMode` 初值就是 `'base'` → 底图模式下这一整条链一次都进不去。

本用例守四类判据：
  a 源码闸门（剥注释）：单源纪律（拖节点/命中判定走共享纯函数）+ 关键接线在场
  b store CRUD：`updateBaseMapRiver` 改点/删点各一条 undo、只改目标那条河、
    点太少时明确拒绝（不静默）、字段口径是 `points`（写错会"改了画布不动"）
  c 端到端（**真鼠标事件驱动画布**）：拖笔 → 松手成河并落库；点河身 → 加拐点；
    悬停 + 拖节点 → 坐标真的变了、且**拖动期间预览与草稿一致**；
    悬停 + Delete → 删单个节点；`Delete` 空手 → 删整条
  d 反向探针：只剩 2 点时删节点必须被拒；拖动期间 store **不许**被改（松手才一条 undo）
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉 // 与 /* */ 注释（判据必须看代码，不能看注释里的说明文字）"""
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
    # 2026-10-31：抬手收口搬进 scenario/interaction/pointer.js —— 判据把那份源码一起读
    # 2026-10-31：河相关动作搬进 scenario/interaction/* —— 判据读合集
    from lib.rsrc import render_src_code_only as _rsrc_all
    sc = _rsrc_all()
    sc += '\n' + _code_only(_read('src/renderer/src/scenario/interaction/pointer.js'))
    pm = _code_only(_read('src/renderer/src/components/PlanetMap.vue'))
    pd = _code_only(_read('src/renderer/src/composables/planetDrawing.js'))
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))
    rv = _code_only(_read('src/renderer/src/utils/rivers.js'))

    checks = [
        # ── store：新增的「改已有河」写口（底图侧此前只有 add / remove）────────
        (se, 'function updateBaseMapRiver(', 'store：改已有河流的写口'),
        (se, 'removeNodeAt', 'store：支持「删单个节点」这一路'),
        (wg, "'updateBaseMapRiver'", '写口契约：改河流已登记（否则只读态会漏网）'),
        # ── 组件：三个手势必须都接上 ────────────────────────────────────────
        (sc, 'finishRiverDraft(true)', '组件：**松手**成河（不是只有双击）'),
        (sc, 'store.updateBaseMapRiver(', '组件：节点编辑走 store（不是改组件本地副本）'),
        (sc, 'store.removeBaseMapRiver(', '组件：删整条走 store'),
        (sc, 'function hitRiverNodeIndex(', '组件：节点命中'),
        (sc, 'riverNodesForRender', '组件：拖动期间画草稿（预览与落库同一份点列）'),
        (sc, 'data-testid="river-del-node"', '可发现性：面板上有可见的「删这个节点」'),
        (sc, 'data-testid="river-del-all"', '可发现性：面板上有可见的「删整条河」'),
        # ⚠️ 2026-10-18 第十八修·四：预览不再走 `smoothWhileDrawing(riverDraft.value, …)` ——
        #    那条链与落库**不是同一条**（形状与粗细都会跳，用户报的"描点连线模拟器"的一半）。
        #    现在预览与落库共用 `riverNodesFromDraft`。判据的**意思没变**：画的时候必须看得见
        #    预览，且预览就是最终几何。
        (sc, 'function riverNodesFromDraft(', '组件：预览与落库的**唯一**几何链'),
        (sc, 'riverPreviewNodes()', '组件：笔迹预览（画的时候就看得见，且就是落库那条）'),
        # ── 单源纪律：判定必须走共享纯函数，不许在组件里再写一份 ────────────────
        (sc, 'hitTestRiver(', '组件：河身命中走共享纯函数'),
        (sc, 'findRiverSegment(', '组件：段定位走共享纯函数'),
        (rv, 'export function hitTestRiver(', '纯函数层：hitTestRiver 存在'),
        (rv, 'export function distanceToPolyline(', '纯函数层：distanceToPolyline 存在'),
        (pm, 'distanceToPolyline, hitTestRiver,', '行星图也改用同一份（不再是私有副本）'),
        # ── 行星图：拖笔时画布上必须**看得见**（此前只进 riverBrushEnd，绘制层看不见）──
        (pm, 'const riverDraftPreview = computed(', '行星图：草稿预览的统一口径'),
        (pm, 'riverDraftPreview: riverDraftPreview.value', '行星图：预览真的喂给了绘制层'),
        (pd, 's.riverDraftPreview', '绘制层读的是预览点列（拖笔期间才看得见）'),
        (pm, 'smoothWhileDrawing(riverBrushPath.value', '行星图：拖笔预览也走平滑'),
    ]
    for src, needle, label in checks:
        if needle not in src:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')

    # 🔴 红线一：组件里不许再出现"自己算点到折线距离"的私有副本（那正是漂移的来源）
    if 'export function distanceToPolyline' in sc or 'function distanceToPolyline(' in sc:
        fails.append('🔴 ScenarioMap 里又出现了私有 distanceToPolyline（单源被破坏）')
    # 🔴 红线二：底图河的节点数组字段必须是 `points`（写成 nodes 会"改了画布不动"）
    if 'updateBaseMapRiver(baseMapKey.value, hit.id, { nodes }' in sc:
        fails.append('🔴 组件用 `nodes` 调 updateBaseMapRiver —— 底图河存的是 `points`（数据改了画布不会动）')

    notes.append(f'源码闸门 {len(checks)} 项 + 2 条红线' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


JS_STORE = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const KEY = 'case106';
  const mk = () => ({ id: KEY, name: '用例106底图', terrain: [], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  s.baseMaps = { ...s.baseMaps, [KEY]: mk() };
  sc.baseMapKey = KEY;
  await new Promise((r) => setTimeout(r, 80));
  const rivers = () => (s.baseMaps[KEY].rivers || []);

  // b) updateBaseMapRiver：改点 / 删点 / 边界
  const add = s.addBaseMapRiver(KEY, { points: [{ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 0 }], name: '用例河' });
  ok('b0 先有一条河', !!(add && add.ok) && rivers().length === 1, JSON.stringify(add));
  const id0 = rivers()[0].id;

  // b1 改点：只改目标那条；一条 undo 回得去
  const pts0 = JSON.stringify(rivers()[0].points);
  const up = s.updateBaseMapRiver(KEY, id0, { points: [{ x: 0, y: 0 }, { x: 60, y: 40 }, { x: 100, y: 0 }] });
  ok('b1 改点成功', !!(up && up.ok && up.changed), JSON.stringify(up));
  ok('b1 点真的变了', JSON.stringify(rivers()[0].points) !== pts0, JSON.stringify(rivers()[0].points));
  ok('b1 字段口径是 points（不是 nodes）',
     Array.isArray(rivers()[0].points) && rivers()[0].nodes === undefined,
     JSON.stringify(Object.keys(rivers()[0])));
  s.undo();
  ok('b2 一条 undo 把点改回去', JSON.stringify(rivers()[0].points) === pts0, JSON.stringify(rivers()[0].points));
  ok('b2 撤销没有把河删掉（不是"整条删了重加"）', rivers().length === 1 && rivers()[0].id === id0);

  // b3 删单个节点：点数 -1，且线宽随点数重算
  const n0 = rivers()[0].points.length;
  const del = s.updateBaseMapRiver(KEY, id0, {}, { removeNodeAt: 1 });
  ok('b3 删单节点成功', !!(del && del.ok && del.changed && del.nodeCount === n0 - 1), JSON.stringify(del));
  ok('b3 点数 -1', rivers()[0].points.length === n0 - 1, rivers()[0].points.length);
  ok('b3 线宽按新点数重算（与落库同一口径）',
     Math.abs(Number(rivers()[0].width) - Math.max(0.4, Math.min(1.6, 0.3 + (n0 - 1) * 0.05))) < 1e-9,
     rivers()[0].width);
  ok('b3 删点带回了被删的坐标（回执可核对）',
     !!(del.removed && Number.isFinite(del.removed.x)), JSON.stringify(del.removed));
  s.undo();
  ok('b4 一条 undo 把节点放回去', rivers()[0].points.length === n0, rivers()[0].points.length);

  // b5 反向探针：只剩 2 点时删节点必须明确拒绝（不是静默、也不是删成 1 点）
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...mk(), rivers: [{ id: 'r2', name: '两点河', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }] } };
  const bad = s.updateBaseMapRiver(KEY, 'r2', {}, { removeNodeAt: 0 });
  ok('b5 只剩 2 点 → 明确拒绝', !!(bad && bad.ok === false && bad.rejected === 'too-few-points' && bad.message), JSON.stringify(bad));
  ok('b5 被拒时数据一字节没动', s.baseMaps[KEY].rivers[0].points.length === 2);
  const nf = s.updateBaseMapRiver(KEY, 'no-such', { name: 'x' });
  ok('b5 找不到的 id → not-found（不静默）', !!(nf && nf.ok === false && nf.rejected === 'not-found'), JSON.stringify(nf));
  const nb = s.updateBaseMapRiver('no-such-basemap', 'r2', { name: 'x' });
  ok('b5 底图不存在 → no-basemap', !!(nb && nb.ok === false && nb.rejected === 'no-basemap'), JSON.stringify(nb));
  // b6 幂等：同样的点再写一次 → changed:false，且不往撤销栈里塞空条目
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...mk(), rivers: [{ id: 'r3', name: 'x', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }] } };
  const same = s.updateBaseMapRiver(KEY, 'r3', { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] });
  ok('b6 点位没变 → changed:false（不产生空撤销）', !!(same && same.ok && same.changed === false), JSON.stringify(same));

  notes.store = 'updateBaseMapRiver 6 类边界都对';
  return JSON.stringify({ fails, notes });
})()"""


JS_UI = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const KEY = 'case106ui';
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例106UI底图', terrain: [], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise((r) => setTimeout(r, 150));
  const cvs = sc.canvas;
  if (!cvs) return JSON.stringify({ fails: ['画布不在 DOM 里'], notes: {} });
  // 🔴 每次都重读 rect：切换到河流工具会多出一行「河流编辑」→ 工具栏变高 →
  //    canvas 下移。用旧 rect 算出来的点击位置会整体偏一行（我为此白查过一轮）。
  const R = () => cvs.getBoundingClientRect();
  const ev = (t, x, y) => {
    const r = R();
    return new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0,
      buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  };
  const click = (p) => { cvs.dispatchEvent(ev('mousedown', p.x, p.y)); cvs.dispatchEvent(ev('mouseup', p.x, p.y)); cvs.dispatchEvent(ev('click', p.x, p.y)); };
  const rivers = () => (s.baseMaps[KEY].rivers || []);
  const R0 = () => rivers()[0] || { points: [] };
  const scr = (w) => sc.worldToScreen(w.x, w.y);
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

  sc.setTool('river');
  await tick(60);
  ok('c0 工具切到河流', sc.tool === 'river', String(sc.tool));

  // c1 拖笔 → 松手成河
  cvs.dispatchEvent(ev('mousedown', 200, 200));
  for (let i = 1; i <= 14; i++) {
    cvs.dispatchEvent(ev('mousemove', 200 + i * 12, 200 + Math.round(8 * Math.sin(i / 2))));
  }
  const draftDuring = sc.riverDraft.length;
  // 记下笔迹两端的世界坐标（用来核对"端点没被抽稀挪走"）
  const draftEnds = { x0: sc.riverDraft[0].x, y0: sc.riverDraft[0].y,
    x1: sc.riverDraft[sc.riverDraft.length - 1].x, y1: sc.riverDraft[sc.riverDraft.length - 1].y };
  cvs.dispatchEvent(ev('mouseup', 368, 200));
  cvs.dispatchEvent(ev('click', 368, 200));
  await tick();
  ok('c1 拖动期间真的在采点（不是"只能一格一格点"）', draftDuring >= 10, String(draftDuring));
  ok('c1 松手就成河（不再要求双击）', rivers().length === 1, String(rivers().length));
  // 🔴 2026-10-17 第六修：判据从"平滑后点数必须变多"改成"**点数必须落在受控区间**"。
  //    旧判据本身就是那个 bug 的帮凶 —— 它奖励"点数越多越好"，而用户看到的正是
  //    "一堆点而不是线"（Chaikin 2 轮 → 点数 ×4 → 节点手柄糊成虚线）。
  //    现在守恒的是**控制点数**（按弧长/期望间距算，夹在 6~72），而不是点数增长。
  const nn = R0().points.length;
  const minGapPx = (() => {
    let m = Infinity;
    for (let i = 0; i + 1 < nn; i++) {
      m = Math.min(m, Math.hypot(R0().points[i + 1].x - R0().points[i].x,
        R0().points[i + 1].y - R0().points[i].y) * sc.cameraScale);
    }
    return m;
  })();
  ok('c1 控制点数落在受控区间（6~72，不再由拖动时长决定）', nn >= 6 && nn <= 72, String(nn));
  ok('c1 相邻控制点的**屏幕间距**不小于 8px（"一堆点"的直接判据）',
     minGapPx >= 8, 'minGap=' + (Math.round(minGapPx * 10) / 10));
  ok('c1 首末控制点仍落在笔迹两端（源头/河口没被挪走）',
     Math.abs(R0().points[0].x - draftEnds.x0) < 1e-6 && Math.abs(R0().points[0].y - draftEnds.y0) < 1e-6
     && Math.abs(R0().points[nn - 1].x - draftEnds.x1) < 1e-6 && Math.abs(R0().points[nn - 1].y - draftEnds.y1) < 1e-6,
     JSON.stringify({ first: R0().points[0], last: R0().points[nn - 1], ends: draftEnds }));
  ok('c1 落库的点不含 h（底图河没有海拔，不许伪造）',
     R0().points.every((p) => !('h' in p)), JSON.stringify(R0().points[0]));
  ok('c1 画完即选中（紧接着就能改）', !!sc.selectedRiver && sc.selectedRiver.id === R0().id);
  ok('c1 草稿已清空', sc.riverDraft.length === 0);

  // c2 点河身 → 加拐点（第一次点=选中，第二次点=插点）
  const mid = scr(R0().points[Math.floor(R0().points.length / 2)]);
  click(mid);
  await tick();
  const nAfterSelect = R0().points.length;
  const third = scr(R0().points[Math.floor(R0().points.length / 3)]);
  click(third);
  await tick();
  ok('c2 点河身加拐点：点数 +1', R0().points.length === nAfterSelect + 1,
     nAfterSelect + ' → ' + R0().points.length);
  ok('c2 加拐点走的是一条 undo', (() => { s.undo(); const n = R0().points.length; s.redo(); return n === nAfterSelect; })());

  // c3 悬停 → 拖节点（预览 = 草稿；store 只在松手时变）
  const idx = 5;
  const n1 = { ...R0().points[idx] };
  const sp = scr(n1);
  cvs.dispatchEvent(ev('mousemove', sp.x, sp.y));
  await tick(15);
  ok('c3 悬停把节点标成"活动"（Delete 删的就是它）', sc.riverActiveNode === idx, String(sc.riverActiveNode));
  cvs.dispatchEvent(ev('mousedown', sp.x, sp.y));
  await tick(0);
  ok('c3 按在节点上进入拖动（不是开始画新河）',
     !!sc.riverDrag && sc.riverDrag.index === idx && sc.riverDraft.length === 0,
     JSON.stringify({ drag: !!sc.riverDrag, i: sc.riverDrag && sc.riverDrag.index, draft: sc.riverDraft.length }));
  cvs.dispatchEvent(ev('mousemove', sp.x + 50, sp.y + 30));
  await tick(0);
  const liveStore = JSON.stringify(R0().points[idx]);
  const liveDraft = sc.riverDrag ? JSON.stringify(sc.riverDrag.points[idx]) : 'null';
  ok('c3 拖动期间 store 不动（松手才一条 undo）', liveStore === JSON.stringify(n1), liveStore);
  ok('c3 拖动期间预览走草稿（画的就是手指底下那个位置）', liveDraft !== liveStore, liveDraft + ' vs ' + liveStore);
  cvs.dispatchEvent(ev('mouseup', sp.x + 50, sp.y + 30));
  await tick(30);
  const moved = JSON.stringify(R0().points[idx]);
  ok('c3 松手后坐标真的落到 store 里', moved !== JSON.stringify(n1), moved + ' vs ' + JSON.stringify(n1));
  s.undo();
  await tick(20);
  ok('c3 一次拖动 = 一条撤销，且回到原位', JSON.stringify(R0().points[idx]) === JSON.stringify(n1),
     JSON.stringify(R0().points[idx]));

  // c4 悬停 + Delete → 删单个节点
  const idx2 = Math.min(3, R0().points.length - 3);
  const p2 = scr(R0().points[idx2]);
  cvs.dispatchEvent(ev('mousemove', p2.x, p2.y));
  await tick(15);
  const beforeDel = R0().points.length;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await tick();
  ok('c4 Delete 删的是那一个节点（不是整条河）',
     rivers().length === 1 && R0().points.length === beforeDel - 1,
     rivers().length + ' 条 / ' + beforeDel + ' → ' + R0().points.length);

  // c5 面板：可见文字 + 状态正确
  const row = document.querySelector('[data-testid="river-edit-row"]');
  const dNode = document.querySelector('[data-testid="river-del-node"]');
  const dAll = document.querySelector('[data-testid="river-del-all"]');
  ok('c5 河流编辑行在 DOM 里（且不在默认收起的「更多」里）',
     !!row && !!dAll && !!dNode, JSON.stringify({ row: !!row, delNode: !!dNode, delAll: !!dAll }));
  ok('c5 按钮有可见文字（可发现性纪律：图标+title 不算）',
     !!dAll && /删/.test(dAll.textContent || ''), dAll ? dAll.textContent.trim() : 'null');
  cvs.dispatchEvent(ev('mousemove', 900, 560));
  await tick(15);
  ok('c5 鼠标离开节点后「删这个节点」自动禁用（删哪个一清二楚）',
     !!dNode && dNode.disabled === true, String(dNode && dNode.disabled));

  // c6 Delete 空手 → 删整条
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await tick();
  ok('c6 没有活动节点时 Delete 删整条河', rivers().length === 0, String(rivers().length));
  s.undo();
  await tick(20);
  ok('c6 删整条也能一条撤销回滚', rivers().length === 1, String(rivers().length));

  notes.ui = '拖笔成河 / 加拐点 / 拖节点 / 删单节点 / 删整条 全部真事件驱动通过';
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
    import time
    time.sleep(1.5)

    ok, res = eval_json(cdp, JS_STORE.replace('__STORE__', STORE).replace('__SC__', SC), desc='106 store 探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    notes += list(res.get('notes', {}).values())

    ok, res2 = eval_json(cdp, JS_UI.replace('__STORE__', STORE).replace('__SC__', SC), desc='106 UI 探针')
    if not ok:
        return False, res2
    fails += res2.get('fails', [])
    notes += list(res2.get('notes', {}).values())

    if fails:
        return False, ' | '.join(fails)
    return True, ' | '.join(notes)
