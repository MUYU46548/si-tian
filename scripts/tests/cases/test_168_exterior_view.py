#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 168：建筑外观（3D，2026-11-14）

之前司天只有"建筑内部"（2D 平面图）—— 房子从外面看是什么样，程序里没有任何地方能回答。
本次加了外观：**同一份楼层数据**（墙/门窗/层高）挤出成体块 + 屋顶，用 three 渲染。

本用例守的是**接线与不崩**（几何精度由 `unit/test_building_shell.js` 13 条纯函数单测守）：
  a) 没有墙 → 按钮灰禁，且 title 说明"为什么点不了"（不许点了没反应）
  b) 4 面墙 + 1 门 1 窗 → 按钮可点
  c) 真实点击（先查 elementFromPoint 命中，防被压住）→ 外观浮层出现
  d) 顶栏统计与数据一致：1 层 / 4 面墙 / 2 处门窗（统计走纯函数，没有 WebGL 也算得出来）
  e) canvas 与"WebGL 不可用"退路二选一，且页面零 JS 报错（不许白屏）
  f) Esc 关闭
  g) 再开一次只有一个浮层（关闭时要真的销毁，不留残壳）
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for                                       # noqa: E402
from lib.helpers import ensure_data_ready, ensure_test_building    # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"
BTN = "Array.from(document.querySelectorAll('.interior-container .header-actions button')).find(b => b.textContent.trim() === '外观')"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def run(cdp):
    ensure_data_ready(cdp)
    # 页面错误收集：3D 起不来常常是渲染层抛错被吞掉，页面只会白屏
    cdp.eval("window.__exErrs = []; window.addEventListener('error', e => window.__exErrs.push(String(e.message || e))); 1")
    okb, binfo = ensure_test_building(cdp)
    if not okb:
        return False, '建筑 fixture 失败：%s' % str(binfo)[:200]
    bid = binfo['id']
    wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图挂载')

    # 准备：一层、清墙（前面用例可能留过）
    prep = _j(cdp, """(() => {
      const s = %s; const bid = %s;
      let d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) s.addFloor(bid, '外观层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      (f.doors || []).slice().forEach(o => s.removeDoor(bid, f.id, o.id));
      (f.windows || []).slice().forEach(o => s.removeWindow(bid, f.id, o.id));
      return JSON.stringify({ fid: f.id });
    })()""" % (STORE, json.dumps(bid)))
    fid = prep.get('fid')
    if not fid:
        return False, '准备楼层失败：%s' % prep

    results = []
    try:
        # a) 无墙 → 灰禁 + 说清原因
        a = _j(cdp, """(() => {
      const b = %s;
      if (!b) return JSON.stringify({ err: 'no-button' });
      return JSON.stringify({ disabled: !!b.disabled, title: b.getAttribute('title') || '' });
    })()""" % BTN)
        ok_a = a.get('disabled') is True and ('画墙' in (a.get('title') or ''))
        results.append(('a 无墙时灰禁且说明原因', ok_a, a))

        # b) 4 面墙 + 1 门 1 窗
        b = _j(cdp, """(() => {
      const s = %s, iv = %s, bid = %s, fid = %s;
      iv.editMode = true; iv.selectFloor(fid);
      const pts = [[-200,-150],[200,-150],[200,150],[-200,150]];
      for (let i = 0; i < 4; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) %% 4];
        s.addWall(bid, fid, { start: {x:p0[0],y:p0[1]}, end: {x:p1[0],y:p1[1]}, thickness: 12, height: 280 });
      }
      const d = s.interiorData[bid]; const f = d.floors.find(x => x.id === fid);
      const w0 = f.walls[0], w1 = f.walls[1];
      s.addDoor(bid, fid, { wallId: w0.id, position: 0.5, width: 90, height: 200 });
      s.addWindow(bid, fid, { wallId: w1.id, position: 0.5, width: 120, height: 140, sillHeight: 90 });
      iv.editMode = false;
      return JSON.stringify({
        walls: f.walls.length,
        doors: (f.doors || []).length,
        windows: (f.windows || []).length,
      });
    })()""" % (STORE, IV, json.dumps(bid), json.dumps(fid)))
        ok_b = b.get('walls') == 4 and b.get('doors') == 1 and b.get('windows') == 1
        results.append(('b 4 面墙 + 1 门 1 窗', ok_b, b))

        wait_for(cdp, "(() => { const b = %s; return !!b && !b.disabled; })()" % BTN,
                 timeout=5, desc='外观按钮解禁')

        # c) 真实点击（elementFromPoint 命中判据：按钮被别的层压住时 el.click() 会假绿）
        c = _j(cdp, """(() => {
      const b = %s;
      if (!b) return JSON.stringify({ err: 'no-button' });
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const reachable = !!hit && (hit === b || b.contains(hit));
      b.click();
      return JSON.stringify({ reachable, hitTag: hit && hit.tagName, hitText: hit && (hit.textContent || '').trim().slice(0, 8) });
    })()""" % BTN)
        ok_c = c.get('reachable') is True
        results.append(('c 按钮真实可点（未被遮挡）', ok_c, c))

        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-view]')", timeout=10, desc='外观浮层出现')
        # three 动态加载 + 首帧要时间
        wait_for(cdp, """(() => {
          const v = document.querySelector('[data-testid=exterior-view]');
          if (!v) return false;
          return !!v.querySelector('[data-testid=exterior-canvas]') || !!v.querySelector('[data-testid=exterior-fallback]');
        })()""", timeout=25, desc='3D 画布或退路出现')

        # d) 顶栏统计 = 数据（统计走纯函数，没有 WebGL 也算得出来）
        d = _j(cdp, """(() => {
      const el = document.querySelector('[data-testid=exterior-stats]');
      return JSON.stringify({ text: el ? el.textContent.trim() : '' });
    })()""")
        txt = d.get('text') or ''
        ok_d = ('1 层' in txt) and ('4 面墙' in txt) and ('2 处门窗' in txt)
        results.append(('d 统计与数据一致（1 层 / 4 面墙 / 2 处门窗）', ok_d, d))

        # e) canvas 或退路二选一 + 零 JS 报错
        e = _j(cdp, """(() => {
      const v = document.querySelector('[data-testid=exterior-view]');
      return JSON.stringify({
        canvas: !!v && !!v.querySelector('[data-testid=exterior-canvas]'),
        fallback: !!v && !!v.querySelector('[data-testid=exterior-fallback]'),
        errs: (window.__exErrs || []).slice(0, 3),
      });
    })()""")
        ok_e = (e.get('canvas') or e.get('fallback')) and not (e.get('errs') or [])
        results.append(('e canvas 或退路二选一 + 零报错', ok_e, e))

        # f) Esc 关闭
        cdp.eval("""(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 1;
    })()""")
        wait_for(cdp, "!document.querySelector('[data-testid=exterior-view]')", timeout=5, desc='Esc 关闭浮层')
        results.append(('f Esc 关闭', True, None))

        # g) 再开一次只有一个浮层（关闭要真销毁，不留残壳）
        _j(cdp, "(() => { %s.click(); return JSON.stringify({}); })()" % BTN)
        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-view]')", timeout=10, desc='二次打开')
        g = _j(cdp, """(() => JSON.stringify({
      views: document.querySelectorAll('[data-testid=exterior-view]').length,
      canvases: document.querySelectorAll('[data-testid=exterior-canvas]').length,
    }))()""")
        ok_g = g.get('views') == 1 and g.get('canvases') <= 1
        results.append(('g 二次打开只有一个浮层', ok_g, g))
        cdp.eval("""(() => {
      const v = document.querySelector('[data-testid=exterior-view]');
      if (v) {
        const btn = Array.from(v.querySelectorAll('button')).find(x => x.textContent.trim() === '关闭');
        if (btn) btn.click();
      }
      return 1;
    })()""")
        wait_for(cdp, "!document.querySelector('[data-testid=exterior-view]')", timeout=5, desc='收尾关闭')
    finally:
        # 清掉本用例造的墙/门窗（下游用例看到多余墙会红）
        _j(cdp, """(() => {
      const s = %s, bid = %s, fid = %s;
      const d = s.interiorData[bid]; const f = d && (d.floors || []).find(x => x.id === fid);
      if (!f) return JSON.stringify({});
      (f.walls || []).slice().forEach(w => s.removeWall(bid, fid, w.id));
      return JSON.stringify({});
    })()""" % (STORE, json.dumps(bid), json.dumps(fid)))

    fails = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print('  %s  %s%s' % ('ok  ' if ok else 'FAIL', name, '' if ok else '  —— %s' % json.dumps(detail, ensure_ascii=False)[:200]))
    if fails:
        return False, '%d/%d 子项失败：%s' % (len(fails), len(results), ' / '.join(f[0] for f in fails))
    return True, '%d/%d 子项通过' % (len(results), len(results))
