#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 114：河流编辑三件（暮雨点名要过的）—— 框选批量删河 / 多选可视反馈 / 裁到海岸线按钮

来历：暮雨在「地图编辑器」那条反馈里明确要过三件（`docs/SITIAN_PROGRESS_AND_GAPS_20261017.md` §2.1）：
  ① **框选/批量删河**（现在只能逐条点选删除）
  ② **手画河裁到海岸线**（按钮，不是自动 —— 有人就是要画三角洲）
  ③ **多条河同时选中时的可视反馈**

本用例守五段（全部真鼠标/真键盘/真按钮）：
  a 源码闸门：批量写口（`removeBaseMapRivers` / `applyBaseMapRiverPatches`，各一条 undo）+ 写闸门契约已登记；
    裁海岸线走产品自己的 `clipPolylineToCoast`（**不许另写一套**）；多选状态与高亮遍历在场；
    框选判定必须**同时**含"顶点在框内"与"线段穿过框"（只判顶点 = 框住河身中部选不中）。
  b Shift+点 = 加选（两条都进选中集，行内文字变成"共 N 条"）。
  c Shift+拖动 = 框选（框住 3 条；**框住河身中部**也算 —— 用一条河的中段做对照）。
  d 批量删除 = **一条撤销**：删 3 条 → 0；按一次 Ctrl+Z → **3 条全回来**（若被拆成 3 条命令，这里只会回 1 条）。
  e 裁到海岸线按钮：一条入海的河被裁短（点数变少 / 末端回到陆地），一条撤销可还原。
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state    # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SMV = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')
SE = os.path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules', 'scenarioEditing.js')
WG = os.path.join(ROOT, 'src', 'renderer', 'src', 'store', 'writeGate.js')
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


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


def _read(path):
    with open(path, encoding='utf-8') as f:
        return _code_only(f.read())


def source_gates():
    fails = []
    sm = _read(SMV)
    se = _read(SE)
    wg = _read(WG)
    # a① 批量写口：存在 + 组件真的用了 + 一条 undo（这两个函数体内必须只有一处 execute）
    for fn in ('removeBaseMapRivers', 'applyBaseMapRiverPatches'):
        if f'function {fn}(' not in se:
            fails.append(f'🔴 store 里没有 `{fn}`（批量删/批量改没有写口）')
        if fn not in wg:
            fails.append(f'🔴 `{fn}` 没登记进写闸门契约（test_54 的反向校验会红）')
        if f'store.{fn}(' not in sm:
            fails.append(f'🔴 组件没调用 `store.{fn}(` —— 写口存在但没人用（死入口）')
    # a② 裁海岸线必须走产品自己的实现，不许在组件里另写一套裁剪
    if 'clipPolylineToCoast' not in sm:
        fails.append('🔴 组件没引 `clipPolylineToCoast`（裁海岸线会变成第二份实现）')
    if "from '../utils/coastline'" not in sm:
        fails.append('🔴 coastline 工具没被引用（口径不单源）')
    # a③ 多选状态与高亮遍历
    if 'selectedRiverIds' not in sm or 'function riverSelIds(' not in sm:
        fails.append('🔴 没有河流多选状态（`selectedRiverIds` / `riverSelIds`）—— 批量操作无从谈起')
    i = sm.find('function drawSelectedRiverHighlight')
    seg = sm[i:i + 2600] if i >= 0 else ''
    if 'for (const id of ids)' not in seg:
        fails.append('🔴 选中高亮只画一条（多选时其余几条没有可视反馈）')
    # a④ 框选判定必须含"线段穿过框"
    if 'function segmentHitsBox(' not in sm or 'segmentHitsBox(' not in sm[sm.find('function riversInBox('):]:
        fails.append('🔴 框选只判"顶点在框内"—— 框住河身中部会选不中（判据与视觉不一致）')
    if 'riverMarquee' not in sm:
        fails.append('🔴 没有河流框选状态（Shift+拖动）')
    # a⑤ 两个入口都要有按钮（可发现性：文字按钮，不许只有快捷键）
    if 'river-clip-coast' not in sm:
        fails.append('🔴 选中行没有「裁到海岸线」按钮')
    if 'river-clip-coast-row' not in sm:
        fails.append('🔴 河流工具行没有「裁到海岸线」按钮')
    return fails


JS_SETUP = r"""
(async () => {
  const s = __STORE__;
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ err: '剧本编辑器没挂载' });
  const sm = el.__vueParentComponent.setupState;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 80));
  const KEY = 'case114';
  // 一块正方形陆地（x 0..800）：x>800 就是海 —— 用来做"裁海岸线"
  const land = { id: 'land1', name: '陆地', kind: 'land', color: '#7d8a5a',
    points: [{x:0,y:0},{x:800,y:0},{x:800,y:600},{x:0,y:600}] };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例114底图',
    terrain: [land], referenceImages: [], rivers: [], routes: [], burgs: [] } };
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(400);
  const add = (id, pts) => s.addBaseMapRiver(KEY, { id, name: id, points: pts, width: 1 });
  add('river_a', [{x:100,y:120},{x:700,y:120}]);
  add('river_b', [{x:100,y:330},{x:700,y:330}]);
  // 这条**从陆地画进海里**（末端 x=980 > 800）
  add('river_c', [{x:100,y:540},{x:500,y:520},{x:980,y:560}]);
  sm.setTool('select');
  sm.showMinimap = false; sm.rasterLayer = 'none'; sm.showRivers = true;
  sm.cameraScale = 1; sm.cameraX = 90; sm.cameraY = 120;
  sm.render();
  await tick(200);
  const cvs = sm.canvas; const rc = cvs.getBoundingClientRect();
  window.__C114 = { sm, cvs, rc, tick, KEY };
  return JSON.stringify({ ok: true, rivers: (s.baseMaps[KEY].rivers || []).map(r => r.id),
    canvas: [Math.round(rc.width), Math.round(rc.height)], cam: [sm.cameraX, sm.cameraY, sm.cameraScale] });
})()
"""

# 真鼠标点一条河（点河身中点）
JS_CLICK = r"""
(async () => {
  const C = window.__C114, sm = C.sm, cvs = C.cvs;
  const tick = C.tick;
  const s = __STORE__;
  // 🔴 每次点击都**重新量** canvas 的 rect：选中一条河之后，上面会多出「已选中河流」那一行
  //    toolbar-row，画布整体下移 ~30px —— 用开头那份 rect 会让第二次点击落到河的上方
  //    （实测症状：Shift+点 river_b 完全没命中，后面整串断言跟着错）。
  const box = () => cvs.getBoundingClientRect();
  const toScreen = (p) => ({ x: sm.cameraX + p.x * sm.cameraScale, y: sm.cameraY + p.y * sm.cameraScale });
  const river = (id) => (s.baseMaps[C.KEY].rivers || []).find(r => r.id === id);
  const mk = (t, sp, extra) => {
    const rc = box();
    return new MouseEvent(t, Object.assign({
      clientX: rc.left + sp.x, clientY: rc.top + sp.y, button: 0,
      buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true }, extra || {}));
  };
  const clickRiver = async (id, shiftKey) => {
    const r = river(id);
    const mid = r.points[Math.floor(r.points.length / 2)];
    const sp = toScreen(mid);
    cvs.dispatchEvent(mk('mousedown', sp, { shiftKey: !!shiftKey }));
    await tick(80);
    cvs.dispatchEvent(mk('mouseup', sp, { shiftKey: !!shiftKey }));
    await tick(120);
  };
  const out = {};
  // ① 单选 A
  await clickRiver('river_a', false);
  out.afterA = { single: sm.selectedRiverId, ids: sm.riverSelIds() };
  // ② Shift+点 B → 加选
  await clickRiver('river_b', true);
  out.afterShiftB = { single: sm.selectedRiverId, ids: sm.riverSelIds() };
  out.rowText = (document.querySelector('[data-testid="river-selected-row"]') || {}).textContent || '';
  // ③ Shift+拖动框选：先来一个**只切过河身、框里没有任何顶点**的小框 —— 它专门证明
  //    "线段穿过框"也算命中（只判顶点在框内的话这里会一条都选不中）。
  const a0 = river('river_a');
  const noVertexInBox = a0.points.every(p => !(p.x >= 300 && p.x <= 420 && p.y >= 40 && p.y <= 200));
  // ⚠️ 起点必须离所有河 ≥ `RIVER_SELECT_HIT_PX`(24 世界单位@1×) —— 否则按下瞬间先命中河、
  //    走的是"Shift+点加选"而不是框选（首版起在 y=100，离 A 只有 20 → 把 A 从选中集里剔掉了）。
  const p0 = toScreen({ x: 300, y: 40 }), p1 = toScreen({ x: 420, y: 200 });
  cvs.dispatchEvent(mk('mousedown', p0, { shiftKey: true }));
  for (let i = 1; i <= 8; i++) {
    const sp = { x: p0.x + (p1.x - p0.x) * i / 8, y: p0.y + (p1.y - p0.y) * i / 8 };
    cvs.dispatchEvent(mk('mousemove', sp, { shiftKey: true }));
  }
  const marqueeShown = !!sm.riverMarquee;
  cvs.dispatchEvent(mk('mouseup', p1, { shiftKey: true }));
  await tick(200);
  out.marqueeShown = marqueeShown;
  out.marqueeGone = !sm.riverMarquee;
  out.noVertexInBox = noVertexInBox;
  out.afterMarquee = sm.riverSelIds();
  out.status = (document.querySelector('.scenario-status-bar') || {}).textContent || '';
  // ④ 框住全部三条（大框）
  const q0 = toScreen({ x: 40, y: 60 }), q1 = toScreen({ x: 1000, y: 600 });
  cvs.dispatchEvent(mk('mousedown', q0, { shiftKey: true }));
  for (let i = 1; i <= 6; i++) {
    cvs.dispatchEvent(mk('mousemove', { x: q0.x + (q1.x - q0.x) * i / 6, y: q0.y + (q1.y - q0.y) * i / 6 }, { shiftKey: true }));
  }
  cvs.dispatchEvent(mk('mouseup', q1, { shiftKey: true }));
  await tick(200);
  out.afterBigMarquee = sm.riverSelIds();
  return JSON.stringify(out);
})()
"""

# 批量删除（点按钮）→ 一次撤销
JS_DELETE = r"""
(async () => {
  const C = window.__C114, sm = C.sm;
  const tick = C.tick;
  const s = __STORE__;
  const btn = document.querySelector('[data-testid="river-selected-delete"]');
  const label = btn ? (btn.textContent || '').trim() : null;
  const out = { before: (s.baseMaps[C.KEY].rivers || []).length, label };
  if (btn) btn.click();
  await tick(300);
  out.afterDelete = (s.baseMaps[C.KEY].rivers || []).length;
  out.idsAfter = sm.riverSelIds();
  out.statusDelete = (document.querySelector('.scenario-status-bar') || {}).textContent || '';
  // 一次 Ctrl+Z
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick(400);
  out.afterUndo = (s.baseMaps[C.KEY].rivers || []).map(r => r.id);
  out.statusUndo = (document.querySelector('.scenario-status-bar') || {}).textContent || '';
  return JSON.stringify(out);
})()
"""

# 裁到海岸线：选中 river_c（入海那条）→ 点按钮 → 看点数/末端
JS_CLIP = r"""
(async () => {
  const C = window.__C114, sm = C.sm, cvs = C.cvs;
  const tick = C.tick;
  const s = __STORE__;
  const box = () => cvs.getBoundingClientRect();
  const river = (id) => (s.baseMaps[C.KEY].rivers || []).find(r => r.id === id);
  const toScreen = (p) => ({ x: sm.cameraX + p.x * sm.cameraScale, y: sm.cameraY + p.y * sm.cameraScale });
  const mk = (t, sp) => {
    const rc = box();
    return new MouseEvent(t, { clientX: rc.left + sp.x, clientY: rc.top + sp.y,
      button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  };
  // 先清空选中，再点 river_c
  sm.setRiverSelection([]);
  await tick(80);
  const r0 = river('river_c');
  const mid = r0.points[Math.floor(r0.points.length / 2)];
  const sp = toScreen(mid);
  cvs.dispatchEvent(mk('mousedown', sp));
  await tick(80);
  cvs.dispatchEvent(mk('mouseup', sp));
  await tick(150);
  const out = { selected: sm.riverSelIds() };
  const before = river('river_c');
  out.beforePts = (before.points || []).length;
  out.beforeLastX = before.points[before.points.length - 1].x;
  const btn = document.querySelector('[data-testid="river-clip-coast"]');
  out.haveBtn = !!btn;
  if (btn) btn.click();
  await tick(350);
  const after = river('river_c');
  out.afterPts = (after.points || []).length;
  out.afterLastX = after.points[after.points.length - 1].x;
  out.statusClip = (document.querySelector('.scenario-status-bar') || {}).textContent || '';
  // 再点一次（应该明确说"已经在陆地上"，不再改动）
  if (btn) btn.click();
  await tick(250);
  out.statusSecond = (document.querySelector('.scenario-status-bar') || {}).textContent || '';
  out.ptsAfterSecond = (river('river_c').points || []).length;
  // 撤销还原
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick(350);
  out.afterUndoPts = (river('river_c').points || []).length;
  out.afterUndoLastX = river('river_c').points[river('river_c').points.length - 1].x;
  return JSON.stringify(out);
})()
"""


def _ev(cdp, js, desc):
    ok, obj = eval_json(cdp, js.replace('__STORE__', STORE), required=None, desc=desc)
    if ok:
        return obj
    return {'__err__': str(obj)}


def _viewport(cdp):
    try:
        cdp.send('Emulation.setDeviceMetricsOverride',
                 {'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False})
    except Exception:
        pass


def run(cdp):
    fails = source_gates()
    notes = []
    ensure_case_state(cdp)
    _viewport(cdp)
    eval_json(cdp, "(() => { const b = Array.from(document.querySelectorAll('button'))"
                   ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()",
              required=None, desc='进剧本模式')
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except Exception:
        return False, '剧本模式没挂载；' + ' | '.join(fails)
    time.sleep(1.2)

    setup = _ev(cdp, JS_SETUP, '造 1 块陆地 + 3 条河')
    if not isinstance(setup, dict) or setup.get('err') or setup.get('__err__'):
        return False, f'造数据失败：{setup} ‖ ' + ' | '.join(fails)
    if len(setup.get('rivers') or []) != 3:
        fails.append(f"🔴 河流没造出来（{setup.get('rivers')}）")

    sel = _ev(cdp, JS_CLICK, '点选 / Shift 加选 / Shift 框选')
    if not isinstance(sel, dict) or sel.get('__err__'):
        return False, f'选择求值失败：{sel} ‖ ' + ' | '.join(fails)
    a = sel.get('afterA') or {}
    if a.get('single') != 'river_a':
        fails.append(f"🔴 普通点选没选中 river_a（single={a.get('single')}）")
    b = sel.get('afterShiftB') or {}
    if sorted(b.get('ids') or []) != ['river_a', 'river_b']:
        fails.append(f"🔴 Shift+点没加选（ids={b.get('ids')}）")
    if '共 2 条' not in (sel.get('rowText') or ''):
        fails.append(f"🔴 选中 2 条时行内没显示「共 2 条」（实际：{(sel.get('rowText') or '')[:80]}）")
    if not sel.get('marqueeShown') or not sel.get('marqueeGone'):
        fails.append(f"🔴 Shift+拖动没有画框/收框（shown={sel.get('marqueeShown')} gone={sel.get('marqueeGone')}）")
    mid = sorted(sel.get('afterMarquee') or [])
    if not sel.get('noVertexInBox'):
        fails.append('🔴 用例数据自检失败：那个小框里其实有顶点，"只判顶点"的对照就失效了')
    if mid != ['river_a']:
        fails.append(f"🔴 框只切过河身（框内无顶点）时选中集不对（{mid}，应为 A —— "
                     '只判顶点在框内就会漏掉这种框法')
    big = sorted(sel.get('afterBigMarquee') or [])
    if big != ['river_a', 'river_b', 'river_c']:
        fails.append(f"🔴 大框没框住三条（{big}）")
    notes.append(f"多选：Shift 加选={b.get('ids')} 中段框={mid} 大框={big}")

    dele = _ev(cdp, JS_DELETE, '批量删除 + 一次撤销')
    if not isinstance(dele, dict) or dele.get('__err__'):
        return False, f'删除求值失败：{dele} ‖ ' + ' | '.join(fails)
    if dele.get('before') != 3:
        fails.append(f"🔴 删除前河数不对（{dele.get('before')}）")
    if '删除选中的 3 条' not in (dele.get('label') or ''):
        fails.append(f"🔴 多选时按钮文案没变成「删除选中的 N 条」（{dele.get('label')}）")
    if dele.get('afterDelete') != 0:
        fails.append(f"🔴 批量删除没删干净（剩 {dele.get('afterDelete')}）")
    if sorted(dele.get('afterUndo') or []) != ['river_a', 'river_b', 'river_c']:
        fails.append(f"🔴 **一次** Ctrl+Z 没能把 3 条一起撤回来（{dele.get('afterUndo')}）"
                     '—— 说明批量删除被拆成了 3 条命令')
    notes.append(f"批量删除：3 → {dele.get('afterDelete')}，一次撤销 → {len(dele.get('afterUndo') or [])} 条")

    clip = _ev(cdp, JS_CLIP, '裁到海岸线')
    if not isinstance(clip, dict) or clip.get('__err__'):
        return False, f'裁剪求值失败：{clip} ‖ ' + ' | '.join(fails)
    if clip.get('selected') != ['river_c']:
        fails.append(f"🔴 裁之前没选中 river_c（{clip.get('selected')}）")
    if not clip.get('haveBtn'):
        fails.append('🔴 找不到「裁到海岸线」按钮')
    if (clip.get('beforeLastX') or 0) <= 800:
        fails.append(f"🔴 用例数据有问题：river_c 末端应该在海上（lastX={clip.get('beforeLastX')}）")
    if (clip.get('afterLastX') or 999) > 800.5:
        fails.append(f"🔴 裁完末端还在海里（lastX={clip.get('afterLastX')}）")
    if (clip.get('statusClip') or '').find('裁') < 0:
        fails.append(f"🔴 裁完没有回执（{(clip.get('statusClip') or '')[:80]}）")
    if (clip.get('statusSecond') or '').find('已经在陆地上') < 0:
        fails.append(f"🔴 再点一次没有明确说「已经在陆地上」（{(clip.get('statusSecond') or '')[:80]}）")
    if (clip.get('afterUndoPts') or 0) != (clip.get('beforePts') or -1):
        fails.append(f"🔴 裁海岸线不能一条撤销（点数 {clip.get('beforePts')} → "
                     f"{clip.get('afterUndoPts')}）")
    notes.append(f"裁海岸线：末点 x {clip.get('beforeLastX')} → {clip.get('afterLastX')}，"
                 f"点数 {clip.get('beforePts')} → {clip.get('afterPts')} → 撤销回 {clip.get('afterUndoPts')}")

    if fails:
        return False, ' | '.join(fails) + ' ‖ ' + ' + '.join(notes)
    return True, ' + '.join(notes)
