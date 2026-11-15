#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 175：快捷键体系（2026-11-15，台账 A27）

以前快捷键散在 if 链里，没有任何地方能一次说清"有哪些键"。这一轮把表做成唯一事实源，
`?` 打开的浮层直接读它。本用例守两件事：**按得动**、**该不按的时候不按**。

  a) 点「快捷键」按钮 → 浮层出现，条目 ≥ 10、有四组标题（编辑/工具/视图/帮助）
  b) `?` 打开、Esc 关闭（再按 `?` 也关）
  c) Ctrl+Z 撤销生效（放一件家具 → 撤销 → 没了）
  d) Ctrl+Shift+Z 重做（撤掉的又回来）
  e) G 切换网格吸附（真的翻转 ref）
  f) F 铺满画布（相机 scale 变成"铺满"档，不再是手滑后的值）
  g) 输入框里按 G 不触发（否则改名字打到 g 就关掉网格）
  h) 帮助开着时按 2 → 只关帮助，不切工具
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for                                    # noqa: E402
from lib.helpers import ensure_data_ready, ensure_test_building  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def press(cdp, key, ctrl=False, shift=False, alt=False, target="window"):
    """派发真实 keydown（target=window 或 'input' 指当前聚焦元素）"""
    return _j(cdp, """(() => {
      const tgt = %s === 'window' ? window : (document.activeElement || document.body);
      const e = new KeyboardEvent('keydown', {
        key: %s, ctrlKey: %s, shiftKey: %s, altKey: %s, bubbles: true, cancelable: true,
      });
      tgt.dispatchEvent(e);
      return JSON.stringify({ fired: true, target: tgt.tagName });
    })()""" % (
        json.dumps(target), json.dumps(key),
        'true' if ctrl else 'false', 'true' if shift else 'false', 'true' if alt else 'false',
    ))


def run(cdp):
    ensure_data_ready(cdp)
    okb, binfo = ensure_test_building(cdp)
    if not okb:
        return False, '建筑 fixture 失败：%s' % str(binfo)[:200]
    bid = binfo['id']
    wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图挂载')

    prep = _j(cdp, """(() => {
      const s = %s, iv = %s, bid = %s;
      let d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) s.addFloor(bid, '快捷键层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      iv.editMode = false;
      iv.shortcutsHelpOpen = false;
      iv.interactionMode = 'pan';
      iv.fitToFloor && iv.fitToFloor();
      return JSON.stringify({ fid: f.id, furniture: (f.furniture || []).length });
    })()""" % (STORE, IV, json.dumps(bid)))
    fid = prep.get('fid')
    if not fid:
        return False, '准备楼层失败：%s' % prep

    results = []
    try:
        wait_for(cdp, "(() => %s.renderer.getViewTransform().scale > 0)()" % IV, timeout=6, desc='相机就绪')

        # a) 点「快捷键」按钮 → 浮层
        # ⚠️ 命中测试与"点完之后查 DOM"必须分两步：Vue 的 DOM 更新是异步的，
        #    在同一个 eval 里点完立刻 querySelector 一定查不到（项目里踩过多次）。
        a_hit = _j(cdp, """(() => {
      const b = document.querySelector('[data-testid=shortcuts-open]');
      if (!b) return JSON.stringify({ found: false });
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return JSON.stringify({
        found: true,
        hit: !!(el && (el === b || b.contains(el))),
        w: Math.round(r.width),
        hitTag: el ? (el.tagName + '.' + (el.className || '')) : '',
      });
    })()""")
        _j(cdp, "(() => { document.querySelector('[data-testid=shortcuts-open]').click(); return JSON.stringify({}); })()")
        a_dom = _j(cdp, """(() => {
      const dlg = document.querySelector('[data-testid=shortcuts-help]');
      return JSON.stringify({
        open: !!dlg,
        groups: [...document.querySelectorAll('.sc-group h5')].map(x => x.textContent.trim()),
        rows: document.querySelectorAll('.sc-row').length,
      });
    })()""")
        ok_a = bool(a_hit.get('found')) and bool(a_hit.get('hit')) and a_hit.get('w', 0) > 40 \
            and a_dom.get('open') is True and a_dom.get('rows', 0) >= 10 and len(a_dom.get('groups') or []) >= 4
        results.append(('a 点「快捷键」→ 浮层出现（≥10 条 / ≥4 组，按钮命中）', ok_a,
                        {'hit': a_hit, 'dom': a_dom}))

        # b) Esc 关闭 → ? 打开 → ? 再关
        press(cdp, 'Escape')
        b1 = _j(cdp, "(() => JSON.stringify({ open: !!document.querySelector('[data-testid=shortcuts-help]') }))()")
        press(cdp, '?', shift=True)
        b2 = _j(cdp, "(() => JSON.stringify({ open: !!document.querySelector('[data-testid=shortcuts-help]') }))()")
        press(cdp, '?', shift=True)
        b3 = _j(cdp, "(() => JSON.stringify({ open: !!document.querySelector('[data-testid=shortcuts-help]') }))()")
        ok_b = b1.get('open') is False and b2.get('open') is True and b3.get('open') is False
        results.append(('b Esc 关闭 / ? 打开 / ? 再关', ok_b, {'esc': b1, 'q1': b2, 'q2': b3}))

        # c) Ctrl+Z 撤销：先放一件家具
        before = _j(cdp, """(() => {
      const s = %s, iv = %s, bid = %s;
      const f = iv.currentFloor;
      const it = s.addFurniture(bid, f.id, {
        name: '快捷键测试', type: 'generic', x: 0, y: 0, width: 60, height: 40,
      });
      const floor = s.interiorData[bid].floors.find(x => x.id === f.id);
      return JSON.stringify({ n: (floor.furniture || []).length, id: it && it.id });
    })()""" % (STORE, IV, json.dumps(bid)))
        press(cdp, 'z', ctrl=True)
        c = _j(cdp, "(() => { const f = %s.currentFloor; return JSON.stringify({ n: (f.furniture || []).length }); })()" % IV)
        b0 = before.get('n')
        ok_c = (b0 is not None) and c.get('n') == b0 - 1
        results.append(('c Ctrl+Z → 刚放的家具被撤销', ok_c, {'before': b0, 'after': c.get('n')}))

        # d) Ctrl+Shift+Z 重做
        press(cdp, 'z', ctrl=True, shift=True)
        d = _j(cdp, "(() => { const f = %s.currentFloor; return JSON.stringify({ n: (f.furniture || []).length }); })()" % IV)
        ok_d = (b0 is not None) and d.get('n') == b0
        results.append(('d Ctrl+Shift+Z → 又回来', ok_d, {'after': d.get('n'), 'want': b0}))

        # e) G 切网格
        e = _j(cdp, """(() => {
      const iv = %s;
      const b0 = iv.gridSnapEnabled;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
      const b1 = iv.gridSnapEnabled;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
      const b2 = iv.gridSnapEnabled;
      return JSON.stringify({ b0, b1, b2 });
    })()""" % IV)
        ok_e = e.get('b1') == (not e.get('b0')) and e.get('b2') == e.get('b0')
        results.append(('e G → 网格吸附翻转再翻回', ok_e, e))

        # f) F 铺满：先把相机弄乱（放大 + 平移），按 F 后 scale 回到"铺满"档
        f = _j(cdp, """(() => {
      const iv = %s;
      const vt = iv.renderer.getViewTransform();
      vt.scale = 12.5; vt.x = 900; vt.y = -600;
      iv.renderer.requestRender();
      const wild = { scale: iv.renderer.getViewTransform().scale };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
      const fit = { scale: iv.renderer.getViewTransform().scale, x: iv.renderer.getViewTransform().x, y: iv.renderer.getViewTransform().y };
      return JSON.stringify({ wild, fit });
    })()""" % IV)
        ok_f = abs((f.get('fit') or {}).get('scale', 0) - 12.5) > 0.01 \
            and ((f.get('fit') or {}).get('scale') or 0) > 0
        results.append(('f F → 视角回到铺满（手滑放大后能一键找回）', ok_f, f))

        # g) 输入框里按 G 不触发
        g = _j(cdp, """(() => {
      const iv = %s;
      const inp = document.createElement('input');
      inp.type = 'text';
      document.body.appendChild(inp);
      inp.focus();
      const b0 = iv.gridSnapEnabled;
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
      const b1 = iv.gridSnapEnabled;
      inp.remove();
      return JSON.stringify({ b0, b1, focused: true });
    })()""" % IV)
        ok_g = g.get('b0') == g.get('b1')
        results.append(('g 在输入框里按 G → 网格不动（改名字不会误触发）', ok_g, g))

        # h) 帮助开着按 2 → 只关帮助，不切工具
        h = _j(cdp, """(() => {
      const iv = %s;
      iv.editMode = true;
      iv.interactionMode = 'pan';
      iv.shortcutsHelpOpen = true;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
      const r = { open: iv.shortcutsHelpOpen, mode: iv.interactionMode };
      iv.editMode = false;
      iv.interactionMode = 'pan';
      iv.shortcutsHelpOpen = false;
      return JSON.stringify(r);
    })()""" % IV)
        ok_h = h.get('open') is False and h.get('mode') == 'pan'
        results.append(('h 帮助开着按 2 → 只关帮助，不切工具', ok_h, h))
    finally:
        _j(cdp, """(() => {
      const iv = %s;
      iv.shortcutsHelpOpen = false;
      iv.interactionMode = 'pan';
      iv.editMode = false;
      return JSON.stringify({});
    })()""" % IV)

    for name, ok, detail in results:
        print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '  ← ' + json.dumps(detail, ensure_ascii=False)[:400]))
    bad = [r for r in results if not r[1]]
    return (len(bad) == 0), '%d/%d 子项通过' % (len(results) - len(bad), len(results))
