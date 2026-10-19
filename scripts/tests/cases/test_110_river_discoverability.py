#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 110：河流的**可发现性**与**可删性**（2026-10-17，暮雨实测三条）

用户原话（三条，都指向"做不到"而不是"做得不好"）：
  ① 「工具「更多」没找到按轮廓生成地形，不知道点哪个」
  ② 「河流逐条点根本点不中」
  ③ 「之前画的测试河流无法删除」

定性（都是**条件式隐藏 / 门控过窄**造成的"能力存在但用户够不着"）：
  ① 第一版「按轮廓生成地形」的显示条件里含 `!baseMapHasHeightmap` ——
     于是**正好在用户找它的时候把它藏了**（他的底图有导入的高度图）。
     这是本项目第 N 次同一类错误：**条件式隐藏 = 等于没做**。
  ②③ 河流的命中判定与 `Delete` 处理此前**只在河流工具里**（`tool === 'river'`）。
     用户用「选择」工具点河 = 什么都没发生；`selectedRiver` 为空 → `Delete` 不删。
     → 画错的河**没法删**。

本用例守四件事（全部走**真事件**，不直接改 setupState）：
  a 源码闸门：按钮条件里**不许**再出现"没有高度图"这种把按钮藏掉的条件；
     选择工具的点击分支里必须有河流命中；`Delete` 处理必须覆盖非河流工具。
  b 按钮真能找到：切到「更多」面板后，`[data-testid="basemap-synthesize-terrain"]`
     存在、**有可见文字**、可点。
  c 河真能点中：在「选择」工具下对河身中点派发真 mousedown/up/click → `selectedRiverId` 命中。
  d 河真能删：按 `Delete` → store 里那条河消失，另一条**不受影响**（不能一把全删）。
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state    # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SMV = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')


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
    fails = []
    with open(SMV, encoding='utf-8') as f:
        smv = _code_only(f.read())

    # a① 按钮条件不许再"因为已有高度图而隐藏"
    i = smv.find('const baseMapCanSynthesizeTerrain = computed(')
    if i < 0:
        fails.append('🔴 找不到 `baseMapCanSynthesizeTerrain` 的定义（判据失效，需同步本用例）')
    else:
        seg = smv[i:i + 400]
        if 'baseMapHasHeightmap' in seg and '!' not in seg.split('baseMapHasHeightmap')[0][-3:]:
            fails.append('🔴 按钮条件里仍用「没有高度图」来隐藏 —— 正好在用户找它时藏掉')

    # a② 选择工具分支里必须有河流命中
    j = smv.find("if (tool.value === 'select') {\n    // 🔴 2026-10-17")
    if j < 0 and 'hitTestRiver(' not in smv:
        fails.append('🔴 「选择」工具里没有河流命中判定（`hitTestRiver`）—— 点不中河')
    # a③ Delete 必须覆盖非河流工具
    if 'tool.value !== \'river\' && selectedRiver.value' not in smv:
        fails.append('🔴 `Delete` 只在河流工具里生效 —— 在「选择」里选中河也删不掉')
    return fails


JS_BUTTON = r"""
(async () => {
  const more = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').trim().includes('更多'));
  if (more) { more.click(); await new Promise(r => setTimeout(r, 220)); }
  const el = document.querySelector('[data-testid="basemap-synthesize-terrain"]');
  return JSON.stringify({
    exists: !!el,
    text: el ? (el.textContent || '').trim() : null,
    disabled: el ? !!el.disabled : null,
  });
})()
"""

JS_MAKE = r"""
(async () => {
  const store = __STORE__;
  const sc = __SC__;
  const KEY = 'case110';
  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const land = { id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) };
  store.baseMaps = { ...store.baseMaps, [KEY]: {
    id: KEY, name: KEY, terrain: [land], referenceImages: [],
    rivers: [
      { id: 'river_test1', points: [{ x: -600, y: 0 }, { x: -300, y: 80 }, { x: 0, y: 20 }, { x: 300, y: 100 }], width: 3.5 },
      { id: 'river_test2', points: [{ x: -600, y: 300 }, { x: -200, y: 330 }, { x: 200, y: 290 }, { x: 500, y: 340 }], width: 3.5 },
    ],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise(r => setTimeout(r, 320));
  // 真按钮：切到「选择」
  const sel = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').includes('选择 (V)') || (b.textContent || '').trim() === '选择');
  if (sel) sel.click();
  await new Promise(r => setTimeout(r, 180));
  return JSON.stringify({ tool: sc.tool, rivers: (store.baseMaps[KEY].rivers || []).length });
})()
"""

JS_CLICK_DELETE = r"""
(async () => {
  const store = __STORE__;
  const sc = __SC__;
  const KEY = 'case110';
  const out = {};
  const cvs = sc.canvas, rect = cvs.getBoundingClientRect();
  const wrap = cvs.parentElement;
  // 相机：框住大陆
  sc.cameraScale = Math.min(wrap.clientWidth / 2400, wrap.clientHeight / 1800);
  sc.cameraX = wrap.clientWidth / 2;
  sc.cameraY = wrap.clientHeight / 2;
  sc.render();
  await new Promise(r => setTimeout(r, 180));
  const sp = sc.worldToScreen(0, 20);            // river_test1 的第三个节点附近（河身中点）
  const ev = (t, x, y) => cvs.dispatchEvent(new MouseEvent(t, {
    clientX: rect.left + x, clientY: rect.top + y,
    button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true }));
  // 🔴 判据必须模拟**真人的手**：按下与抬起差 1px，浏览器**不会**派发 `click`
  //    （click 要求同一元素且无拖动）。旧实现把命中放在 click 里 → 真机永远选不中。
  ev('mousedown', sp.x, sp.y);
  ev('mouseup', sp.x + 1, sp.y + 1);
  await new Promise(r => setTimeout(r, 220));
  out.selected = sc.selectedRiverId || null;
  // 操作栏必须出现（有可见的删除入口，而不是"只能猜着按 Delete"）
  const row = document.querySelector('[data-testid="river-selected-row"]');
  const delBtn = document.querySelector('[data-testid="river-selected-delete"]');
  out.rowExists = !!row;
  out.deleteText = delBtn ? (delBtn.textContent || '').trim() : null;
  out.before = (store.baseMaps[KEY].rivers || []).length;
  // 走**可见按钮**删除（这是用户能发现的那条路）
  if (delBtn) { delBtn.click(); }
  else { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); }
  await new Promise(r => setTimeout(r, 280));
  const left = store.baseMaps[KEY].rivers || [];
  out.after = left.length;
  out.leftIds = left.map(r => r.id);
  return JSON.stringify(out);
})()
"""


def _ev(cdp, js, desc):
    r = eval_json(cdp, js.replace('__STORE__', STORE).replace('__SC__', SC),
                  required=None, desc=desc)
    if isinstance(r, tuple) and r[0]:
        return r[1]
    return {'__err__': r}


def run(cdp):
    fails = source_gates()
    notes = ['源码闸门 3 组']
    ensure_case_state(cdp)
    eval_json(cdp,
              "(() => { const b = Array.from(document.querySelectorAll('button'))"
              ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()",
              required=None, desc='点「历史剧本」')
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    time.sleep(1.2)

    mk = _ev(cdp, JS_MAKE, '造底图 + 两条测试河 + 切到选择工具')
    if not isinstance(mk, dict) or mk.get('__err__'):
        fails.append(f'🔴 造场景失败：{mk}')
        return False, ' | '.join(fails)
    if mk.get('rivers') != 2:
        fails.append(f"🔴 测试河没造出来（{mk.get('rivers')} 条，应为 2）")
    if mk.get('tool') != 'select':
        fails.append(f"🔴 没切到「选择」工具（tool={mk.get('tool')}）")

    # b 按钮真能找到
    btn = _ev(cdp, JS_BUTTON, '「更多」里的按轮廓生成地形')
    if not isinstance(btn, dict) or btn.get('__err__'):
        fails.append(f'🔴 按钮探测失败：{btn}')
    else:
        if not btn.get('exists'):
            fails.append('🔴 「更多」里找不到 `basemap-synthesize-terrain` 按钮')
        if not (btn.get('text') or '').strip():
            fails.append('🔴 按钮没有可见文字（只靠图标 = 用户找不到，暮雨实测过这个坑）')
        if btn.get('disabled'):
            fails.append('🔴 按钮是禁用的（存在但点不了 = 等于没有）')

    # c/d 点中 + 删除
    cd = _ev(cdp, JS_CLICK_DELETE, '选择工具里点河 + Delete')
    if not isinstance(cd, dict) or cd.get('__err__'):
        fails.append(f'🔴 点选/删除求值失败：{cd}')
        return False, ' | '.join(fails)
    if cd.get('selected') != 'river_test1':
        fails.append(f"🔴 「选择」工具点河没选中（selectedRiverId={cd.get('selected')}）"
                     " —— 用户报的「逐条点根本点不中」"
                     "（判据用的是 mousedown+1px 抖动、不派发 click，即真人的手）")
    if not cd.get('rowExists'):
        fails.append('🔴 选中河之后没有出现操作栏（`river-selected-row`）—— 用户看不到任何可操作的入口')
    if not (cd.get('deleteText') or '').strip():
        fails.append('🔴 操作栏里没有可见的「删除这条河」按钮')
    if cd.get('after') != 1:
        fails.append(f"🔴 删除没生效（{cd.get('before')} → {cd.get('after')}）"
                     " —— 用户报的「测试河流无法删除」")
    ids = cd.get('leftIds') or []
    if 'river_test2' not in ids:
        fails.append(f'🔴 删一条时把别的河也删了（剩 {ids}）—— 必须只删选中的那条')

    notes.append(f"按钮={btn.get('text') if isinstance(btn, dict) else '?'}"
                 f"(存在={btn.get('exists') if isinstance(btn, dict) else '?'}) / "
                 f"点中={cd.get('selected')}(操作栏={cd.get('rowExists')}) / "
                 f"删除 {cd.get('before')}→{cd.get('after')} 剩 {cd.get('leftIds')}")
    if fails:
        return False, ' | '.join(fails) + ' ‖ ' + ' + '.join(notes)
    return True, ' + '.join(notes)
