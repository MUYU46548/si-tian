#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 122：**河流橡皮 + 预览＝落库**（2026-10-18 第十八修·三/四）

暮雨原话：
  「而且节点的设计是不是本来就有问题？有变成描点连线模拟器的风险。河流要不要尝试其他画法？
    应该更偏向手绘吗（**甚至有橡皮擦来擦除**）。事实上整个司天所有涉及地图编辑的地方，
    都应该优先参考现成各类绘图软件，而不是放着一堆现成的东西都抄不好。」

本轮照抄两件现成的东西：
  ① **绘图软件的分层笔迹** —— 预览就是"你将得到的那条河"。
     修前：拖动预览走 `smoothWhileDrawing(…, 1, 18)`、宽度写死 `0.7`；抬手落库走
     「抽稀 → 按弧长压到目标点数 → Chaikin」、宽度 `RIVER_WIDTH_DEFAULT`(3.5) ——
     **形状与粗细都不是同一条**（画一条细发丝，松手变成 8.4 屏幕像素的宽河）。
     修后：两边共用 `riverNodesFromDraft()`，宽度也共用 `RIVER_WIDTH_DEFAULT`。
  ② **橡皮擦** —— 按住抹过去就擦掉那一段，不需要先选中对象、不需要挑节点、不需要 Delete。
     擦断的河**断成两条**（切口落在橡皮圈边上）；整条擦净就删掉；一次擦除 = **一条撤销**。
     只擦**手画的河**（导入河是别人 .map 的数据、自动河是推演产物 —— 擦了要么毁数据、
     要么下次生成又回来）。

本用例判据：
  a 源码闸门：工具/图标/单源几何/原子写口/写闸门登记/预览与落库共用一条链；
  b 🔴 **预览逐点 = 落库**：拖一条河，抬手前取预览节点，抬手后取落库节点 —— 逐点相同；
  c 🔴 **擦断 = 两条河 + 一条撤销**：竖河被横着抹断 → 原 id 变短 + 多出一条新河；
     按**一次** Ctrl+Z → 条数、id、逐点坐标全部回原样；
  d **只擦手画的**：抹过导入河 → 数据一字未动，且状态栏明说"只擦手画的河"（不静默）；
  e 空手不压栈：抹在没有河的地方 → 撤销栈不增长。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                   # noqa: E402
from lib.helpers import ensure_case_state                                 # noqa: E402

SMC = "document.querySelector('.scenario-map-container')"
SM = SMC + ".__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
ROOT = os.path.join(os.path.dirname(__file__), '..', '..', '..')


def _code_only(src):
    src = re.sub(r'<style[\s\S]*?</style>', '', src)
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


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return _code_only(f.read())


def source_gates():
    fails = []
    sm = _read('src/renderer/src/components/ScenarioMap.vue')
    se = _read('src/renderer/src/store/geodataModules/scenarioEditing.js')
    wg = _read('src/renderer/src/store/writeGate.js')
    icon = _read('src/renderer/src/components/Icon.vue')

    # ① 橡皮的接线：工具、图标、几何单源、原子写口、抬手落库
    if "id: 'riverErase'" not in sm:
        fails.append("🔴 BASEMAP_TOOLS 里没有 riverErase —— 橡皮在底图编辑行里够不着")
    if "name === 'eraser'" not in icon:
        fails.append('🔴 Icon.vue 没有 eraser 图标（按钮上会是一个空白方块）')
    if 'planRiverErase' not in sm:
        fails.append('🔴 组件没有用纯函数层的 planRiverErase（几何另写一份 = 双源）')
    if 'applyBaseMapRiverEdit' not in sm:
        fails.append('🔴 橡皮没有走**原子**写口 applyBaseMapRiverEdit（改/加/删会各压一条 undo）')
    if 'commitRiverErase' not in sm or 'if (riverEraseStroke.value.length)' not in sm:
        fails.append('🔴 抬手没有收口橡皮（`commitRiverErase` 没接在 mouseup 上）')
    # 2026-10-31：快捷键搬进 `scenario/interaction/keyboard.js` —— 判据跟着搬家
    kbd = _read('src/renderer/src/scenario/interaction/keyboard.js')
    if "(event.key === 'w' || event.key === 'W') && event.shiftKey" not in kbd:
        fails.append('🔴 没有 Shift+W 的入口（且必须判在普通 w 之前）')
    # ② 预览＝落库：唯一几何链
    if 'function riverNodesFromDraft(' not in sm:
        fails.append('🔴 没有 riverNodesFromDraft（预览与落库各写一条链 → 松手形状会跳）')
    i = sm.find('function finishRiverDraft(')
    if i < 0 or 'riverNodesFromDraft(draft)' not in sm[i:i + 3200]:
        fails.append('🔴 落库没走 riverNodesFromDraft（预览与落库不同源）')
    j = sm.find('function riverPreviewNodes(')
    if j < 0 or 'riverNodesFromDraft(draft)' not in sm[j:j + 900]:
        fails.append('🔴 预览没走 riverNodesFromDraft（松手后形状会跳）')
    # ⚠️ 判据要**指到那一句**：`width: 0.7` 在小径样式里合法存在（同文件 2169 行），
    #    只搜 "width: 0.7" 会假红（本轮实测）。
    if '{ width: 0.7 }, { alpha' in sm:
        fails.append('🔴 预览里还写死着 `width: 0.7`（画出来比落库细一大截 = 预览不是最终样子）')
    # 2026-10-31：预览绘制体搬进 `scenario/layers/preview.js`（形参改成 view）
    if 'drawOneHandRiver(c, previewPts, { width: view.RIVER_WIDTH_DEFAULT }' not in sm and 'drawOneHandRiver(c, previewPts, { width: view.RIVER_WIDTH_DEFAULT }' not in _read('src/renderer/src/scenario/layers/preview.js'):
        fails.append('🔴 预览没有用落库那个宽度（RIVER_WIDTH_DEFAULT）')
    # ③ 支流 = 一条撤销（同一批：加河 + 改母河 走同一个原子口）
    if 'store.updateBaseMapRiver(baseMapKey.value, parentId' in sm:
        fails.append('🔴 支流仍在用第二条 undo（updateBaseMapRiver）—— 「加河 + 插母河拐点」必须原子')
    # ④ store 侧：新写口存在、只有一处 execute、首行守卫、写闸门已登记
    if 'function applyBaseMapRiverEdit(' not in se:
        fails.append('🔴 store 没有 applyBaseMapRiverEdit（原子写口缺失）')
    else:
        k = se.find('function applyBaseMapRiverEdit(')
        body = se[k:k + 4200]
        if body.count('execute(') != 1:
            fails.append(f"🔴 applyBaseMapRiverEdit 里有 {body.count('execute(')} 处 execute —— 必须是**一条**撤销")
        if 'guardWrite(' not in body[:260]:
            fails.append('🔴 applyBaseMapRiverEdit 首行没有 guardWrite（只读态会被写穿）')
    if 'applyBaseMapRiverEdit' not in wg:
        fails.append('🔴 新写口没有登记进 writeGate 的 MEMORY_WRITE_CALLSITES（test_54 会反向查）')
    return fails


SETUP = r"""
(async () => {
  const s = __STORE__;
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ err: '剧本编辑器没挂载' });
  const sm = el.__vueParentComponent.setupState;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 80));
  const KEY = 'case122';
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例122底图', terrain: [], referenceImages: [],
    rivers: [], routes: [], burgs: [], markers: [], labels: [] } };
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(400);
  sm.showMinimap = false;
  sm.rasterLayer = 'none';
  sm.cameraScale = 1;
  sm.cameraX = 60; sm.cameraY = 60;
  sm.render();
  await tick(150);
  const cvs = sm.canvas; const rc = cvs.getBoundingClientRect();
  const toScreen = (p) => ({ x: sm.cameraX + p.x * sm.cameraScale, y: sm.cameraY + p.y * sm.cameraScale });
  window.__C122 = { sm, cvs, toScreen, tick, KEY };
  return JSON.stringify({ ok: true, key: KEY, terrain: (s.baseMaps[KEY].terrain || []).length,
    canvas: [Math.round(rc.width), Math.round(rc.height)], fails: [] });
})()
"""

# b：拖一条河 → 预览 vs 落库逐点比对
JS_WYSIWYG = r"""
(async () => {
  const C = window.__C122, sm = C.sm, cvs = C.cvs, tick = C.tick;
  const s = __STORE__;
  const out = { fails: [] };
  const mk = (t, p) => {
    const rc = cvs.getBoundingClientRect();
    return new MouseEvent(t, { clientX: rc.left + p.x, clientY: rc.top + p.y, button: 0,
      buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  };
  sm.setTool('river');
  await tick(120);
  // 一条带抖动的笔迹（真实手绘必然不光滑）
  const raw = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    raw.push({ x: 120 + t * 520, y: 200 + Math.sin(t * 7) * 40 + Math.sin(t * 23) * 6 });
  }
  cvs.dispatchEvent(mk('mousedown', C.toScreen(raw[0])));
  for (let i = 1; i < raw.length; i++) cvs.dispatchEvent(mk('mousemove', C.toScreen(raw[i])));
  await tick(150);
  out.draftPts = (sm.riverDraft || []).length;
  // 🔴 抬手前的预览节点 = 用户此刻**看到的**那条河
  const preview = (sm.riverPreviewNodes() || []).map(p => ({ x: +p.x.toFixed(9), y: +p.y.toFixed(9) }));
  out.previewPts = preview.length;
  cvs.dispatchEvent(mk('mouseup', C.toScreen(raw[raw.length - 1])));
  await tick(400);
  const list = s.baseMaps[C.KEY].rivers || [];
  out.riverCount = list.length;
  const landed = list.find(r => String(r.id || '').indexOf('river_') === 0);
  const landedPts = landed ? (landed.points || []).map(p => ({ x: +p.x.toFixed(9), y: +p.y.toFixed(9) })) : [];
  out.landedPts = landedPts.length;
  out.equal = JSON.stringify(preview) === JSON.stringify(landedPts);
  if (!out.equal) {
    let firstDiff = -1;
    for (let i = 0; i < Math.max(preview.length, landedPts.length); i++) {
      const a = preview[i], b = landedPts[i];
      if (!a || !b || a.x !== b.x || a.y !== b.y) { firstDiff = i; break; }
    }
    out.firstDiff = firstDiff;
    out.previewHead = preview.slice(0, 3);
    out.landedHead = landedPts.slice(0, 3);
  }
  out.landedWidth = landed ? landed.width : null;
  sm.setTool('select');
  return JSON.stringify(out);
})()
"""

# c + d + e：橡皮擦断（一条撤销）/ 只擦手画的 / 空手不压栈
JS_ERASE = r"""
(async () => {
  const C = window.__C122, sm = C.sm, cvs = C.cvs, tick = C.tick;
  const s = __STORE__;
  const out = { fails: [] };
  const bm = () => s.baseMaps[C.KEY];
  const river = (id) => (bm().rivers || []).find(r => r.id === id);
  const add = (id, pts, width) => s.addBaseMapRiver(C.KEY, { id, points: pts, width: width });
  const snap = () => (bm().rivers || []).map(r => ({ id: r.id, n: (r.points || []).length,
    head: (r.points || [])[0], tail: (r.points || [])[r.points.length - 1] }));
  // 一条竖河（节点间距 40）+ 一条导入河（id 不带 river_ 前缀，橡皮不许碰）
  const v = [];
  for (let i = 0; i < 16; i++) v.push({ x: 400, y: 100 + i * 40 });
  add('river_v', v, 3.5);
  add('imp_river', [{ x: 100, y: 100 }, { x: 100, y: 700 }], 2);
  await tick(200);
  // ⚠️ 基准必须在**加完这两条之后**取：加河各自压了一条 undo，
  //    拿加河之前的状态当基准会让"一次 Ctrl+Z 回原样"这条判据永远红（本轮实测踩到）。
  const before = snap();
  out.before = before.map(r => r.id + ':' + r.n);
  const mk = (t, p) => {
    const rc = cvs.getBoundingClientRect();
    return new MouseEvent(t, { clientX: rc.left + p.x, clientY: rc.top + p.y, button: 0,
      buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  };
  sm.setTool('riverErase');
  await tick(120);
  const rect = cvs.getBoundingClientRect();
  // ① 横着抹过竖河的中段（y=400 附近）
  const p0 = C.toScreen({ x: 330, y: 400 }), p1 = C.toScreen({ x: 470, y: 400 });
  cvs.dispatchEvent(mk('mousedown', p0));
  for (let i = 1; i <= 8; i++) {
    cvs.dispatchEvent(mk('mousemove', { x: p0.x + (p1.x - p0.x) * i / 8, y: p0.y }));
  }
  await tick(150);
  out.trailPts = (sm.riverEraseStroke || []).length;
  cvs.dispatchEvent(mk('mouseup', p1));
  await tick(400);
  const afterErase = snap();
  out.afterErase = afterErase.map(r => r.id + ':' + r.n);
  out.statusErase = (document.querySelector('.scenario-line') || document.querySelector('.draw-hint') || {}).textContent || '';
  const vNow = river('river_v');
  out.vShorter = !!vNow && (vNow.points || []).length < 16;
  out.newPieces = (bm().rivers || []).filter(r => r.id !== 'river_v' && String(r.id).indexOf('river_') === 0).length;
  const imp = river('imp_river');
  out.impUntouched = !!imp && (imp.points || []).length === 2
    && imp.points[0].x === 100 && imp.points[1].y === 700;
  // ② 一次 Ctrl+Z → 全部回原样（逐点）
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick(400);
  const afterUndo = snap();
  out.afterUndo = afterUndo.map(r => r.id + ':' + r.n);
  out.undoRestores = JSON.stringify(afterUndo) === JSON.stringify(before);
  // ③ 只擦手画的：抹过导入河 → 数据不动 + 状态栏明说
  const q0 = C.toScreen({ x: 30, y: 400 }), q1 = C.toScreen({ x: 170, y: 400 });
  const impBefore = JSON.stringify(river('imp_river').points);
  const undoBefore = sm.undoCount !== undefined ? sm.undoCount : null;
  cvs.dispatchEvent(mk('mousedown', q0));
  for (let i = 1; i <= 8; i++) cvs.dispatchEvent(mk('mousemove', { x: q0.x + (q1.x - q0.x) * i / 8, y: q0.y }));
  await tick(120);
  cvs.dispatchEvent(mk('mouseup', q1));
  await tick(300);
  out.impAfterErase = JSON.stringify(river('imp_river').points) === impBefore;
  out.statusNoHit = (document.querySelector('.scenario-line') || document.querySelector('.draw-hint') || {}).textContent || '';
  out.undoBefore = undoBefore;
  // ④ 空手不压栈：抹在空地
  const e0 = C.toScreen({ x: 800, y: 800 }), e1 = C.toScreen({ x: 900, y: 800 });
  cvs.dispatchEvent(mk('mousedown', e0));
  for (let i = 1; i <= 6; i++) cvs.dispatchEvent(mk('mousemove', { x: e0.x + (e1.x - e0.x) * i / 6, y: e0.y }));
  cvs.dispatchEvent(mk('mouseup', e1));
  await tick(250);
  // 再撤一次：如果上面那次空手压了栈，这里会把"擦导入河"撤销成一个变化
  const beforeEmptyUndo = JSON.stringify(snap());
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick(300);
  out.emptyStrokeNoPush = JSON.stringify(snap()) !== beforeEmptyUndo;   // 真的撤到了别的动作 = 空手没压栈
  out.statusEmpty = (document.querySelector('.scenario-line') || document.querySelector('.draw-hint') || {}).textContent || '';
  sm.setTool('select');
  return JSON.stringify(out);
})()
"""


def _ev(cdp, js, desc):
    v = cdp.eval(js)
    if isinstance(v, dict) and '__err__' in v:
        raise RuntimeError(f'{desc} 求值异常：{str(v)[:300]}')
    return v


def _json(cdp, js, desc):
    v = _ev(cdp, js, desc)
    if not isinstance(v, str):
        raise RuntimeError(f'{desc} 没返回 JSON：{str(v)[:200]}')
    return json.loads(v)


def run(cdp):
    fails = source_gates()
    notes = ['源码闸门 %d 组' % (9)]
    ensure_case_state(cdp)
    cdp.eval("window.confirm = () => true; 'ok'")
    _ev(cdp, "(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
             " if (b) b.click(); return 'ok'; })()", '点历史剧本')
    wait_for(cdp, "!!" + SMC, timeout=25, desc='剧本编辑器挂载')
    time.sleep(0.8)

    setup = _json(cdp, SETUP.replace('__STORE__', STORE), '造底图')
    if setup.get('err'):
        return False, '底图准备失败：' + str(setup)

    # ── b 预览 = 落库 ──
    w = _json(cdp, JS_WYSIWYG.replace('__STORE__', STORE), '拖一条河')
    if w.get('draftPts', 0) < 10:
        fails.append(f"笔迹没收上（{w.get('draftPts')} 点）—— 后面整段判据不成立")
    if not w.get('riverCount'):
        fails.append('河流没落库（拖笔没画出河）')
    if not w.get('equal'):
        fails.append(f"🔴 预览与落库**不是同一条几何**：预览 {w.get('previewPts')} 点 / "
                     f"落库 {w.get('landedPts')} 点，首个不同在第 {w.get('firstDiff')} 个"
                     f"（预览头 {w.get('previewHead')} / 落库头 {w.get('landedHead')}）")
    notes.append('b 预览=落库：预览 %s 点 / 落库 %s 点（宽 %s）'
                 % (w.get('previewPts'), w.get('landedPts'), w.get('landedWidth')))

    # ── c/d/e 橡皮 ──
    e = _json(cdp, JS_ERASE.replace('__STORE__', STORE), '橡皮擦断')
    if (e.get('trailPts') or 0) < 2:
        fails.append(f"擦除轨迹没收到（{e.get('trailPts')} 点）—— 橡皮手势没接上")
    if not e.get('vShorter'):
        fails.append(f"🔴 橡皮没把竖河擦短（擦后 {e.get('afterErase')}）")
    if (e.get('newPieces') or 0) < 1:
        fails.append(f"🔴 擦断之后没有产生新河（断口应各自成为一条河，实际 {e.get('afterErase')}）—— "
                     '用户擦一下就"整条不见"或"没反应"')
    if not e.get('impUntouched'):
        fails.append('🔴 导入河被擦到了（橡皮只许擦手画的河）')
    if not e.get('undoRestores'):
        fails.append(f"🔴 **一次** Ctrl+Z 没能把擦除整个撤回：擦前 {e.get('before')} / 撤后 {e.get('afterUndo')}"
                     '（若被拆成多条命令，这里只会回一半）')
    if not e.get('impAfterErase'):
        fails.append('🔴 抹过导入河时数据被改了（应一字未动）')
    if '只擦' not in (e.get('statusNoHit') or ''):
        fails.append(f"🔴 抹到导入河上时状态栏没有说明「只擦手画的河」：{e.get('statusNoHit')!r}（静默 no-op）")
    if not e.get('emptyStrokeNoPush'):
        fails.append('🔴 空手一抹压了撤销栈（撤销撤到的不是上一条真实动作）')
    notes.append('c 擦断：擦前 %s → 擦后 %s；一次 Ctrl+Z 回原样=%s'
                 % ('/'.join(e.get('before') or []), '/'.join(e.get('afterErase') or []), e.get('undoRestores')))
    notes.append('d 只擦手画的：导入河未动=%s 回执=%r' % (e.get('impAfterErase'), (e.get('statusNoHit') or '')[:40]))
    notes.append('e 空手不压栈：%s' % e.get('emptyStrokeNoPush'))

    _ev(cdp, "(() => { const b = document.querySelector('.scenario-toolbar .back-btn');"
             " if (b) b.click(); return 'ok'; })()", '返回世界')
    time.sleep(0.5)

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes)
