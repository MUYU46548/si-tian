#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 169：建筑平面图「出图」（2026-11-14，第 4 刀 / 台账 A19）

之前这块只能看：一屏深底、亮蓝房间，截屏贴进设定集不像一张图。
现在点「出图」得到一张 A4 横版图纸：图框 / 标题栏 / 比例尺 / 指北针 / 图例 / 房间面积表。

本用例守**接线与结果形状**（版式数字由 `unit/test_plan_sheet.js` 15 条纯函数单测守）：
  a) 没有墙 → 按钮灰禁且说明原因
  b) 4 面墙 + 1 门 1 窗 → 可点
  c) 真实点击 → 走 saveExportFile 通道，拿到 PNG dataUrl + 合理文件名
  d) PNG 头里读尺寸 = 2244×1588（A4 1122×794 的 2 倍 = 约 192dpi）
  e) 用户取消保存 → 不弹错误、按钮回到可用（不许把"取消"当失败）
  f) 保存失败（磁盘错误）→ 页面上出现**看得见**的错误（本项目的"失败要看得见"纪律）
"""
import base64
import json
import struct
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for                                    # noqa: E402
from lib.helpers import ensure_data_ready, ensure_test_building  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"
BTN = ("Array.from(document.querySelectorAll('.interior-container .header-actions button'))"
       ".find(b => b.textContent.trim() === '出图')")


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
    okb, binfo = ensure_test_building(cdp)
    if not okb:
        return False, '建筑 fixture 失败：%s' % str(binfo)[:200]
    bid = binfo['id']
    wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图挂载')

    prep = _j(cdp, """(() => {
      const s = %s; const bid = %s;
      let d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) s.addFloor(bid, '出图层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      (f.doors || []).slice().forEach(o => s.removeDoor(bid, f.id, o.id));
      (f.windows || []).slice().forEach(o => s.removeWindow(bid, f.id, o.id));
      return JSON.stringify({ fid: f.id, floors: d.floors.length });
    })()""" % (STORE, json.dumps(bid)))
    fid = prep.get('fid')
    if not fid:
        return False, '准备楼层失败：%s' % prep

    results = []
    try:
        # a) 无墙 → 灰禁
        a = _j(cdp, """(() => {
      const b = %s;
      if (!b) return JSON.stringify({ err: 'no-button' });
      return JSON.stringify({ disabled: !!b.disabled, title: b.getAttribute('title') || '' });
    })()""" % BTN)
        ok_a = a.get('disabled') is True and ('没有墙' in (a.get('title') or ''))
        results.append(('a 无墙时灰禁且说明原因', ok_a, a))

        # b) 造墙 + 门窗
        b = _j(cdp, """(() => {
      const s = %s, iv = %s, bid = %s, fid = %s;
      iv.editMode = true; iv.selectFloor(fid);
      const pts = [[-200,-150],[200,-150],[200,150],[-200,150]];
      for (let i = 0; i < 4; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) %% 4];
        s.addWall(bid, fid, { start: {x:p0[0],y:p0[1]}, end: {x:p1[0],y:p1[1]}, thickness: 24, height: 280 });
      }
      const d = s.interiorData[bid]; const f = d.floors.find(x => x.id === fid);
      s.addDoor(bid, fid, { wallId: f.walls[0].id, position: 0.5, width: 90, height: 200 });
      s.addWindow(bid, fid, { wallId: f.walls[1].id, position: 0.5, width: 120, height: 140, sillHeight: 90 });
      iv.recalcRooms();
      iv.editMode = false;
      return JSON.stringify({ walls: f.walls.length, rooms: (f.rooms || []).length });
    })()""" % (STORE, IV, json.dumps(bid), json.dumps(fid)))
        ok_b = b.get('walls') == 4 and (b.get('rooms') or 0) >= 1
        results.append(('b 4 面墙 + 1 门 1 窗 + 房间自动围合', ok_b, b))

        wait_for(cdp, "(() => { const x = %s; return !!x && !x.disabled; })()" % BTN,
                 timeout=5, desc='出图按钮解禁')

        # c) 成功路径：stub 保存通道，只取 dataUrl
        _j(cdp, """(() => {
      window.__saved = null; window.__savedName = null; window.__calls = 0;
      window.sitianAPI.saveExportFile = async (o) => {
        window.__calls++;
        window.__saved = o.dataUrl; window.__savedName = o.defaultName;
        return { success: true, path: 'X:/tmp/plan.png' };
      };
      return JSON.stringify({});
    })()""")
        click = _j(cdp, """(() => {
      const b = %s;
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const reachable = !!hit && (hit === b || b.contains(hit));
      b.click();
      return JSON.stringify({ reachable });
    })()""" % BTN)
        wait_for(cdp, "!!window.__saved", timeout=25, desc='导出完成')
        c = _j(cdp, """(() => JSON.stringify({
      calls: window.__calls,
      name: window.__savedName || '',
      head: (window.__saved || '').slice(0, 22),
      len: (window.__saved || '').length,
    }))()""")
        ok_c = (click.get('reachable') is True and c.get('calls') == 1
                and c.get('head', '').startswith('data:image/png;base64,')
                and '平面图' in (c.get('name') or '')
                and (c.get('len') or 0) > 50000)
        results.append(('c 真实点击 → 走保存通道、拿到 PNG 与合理文件名', ok_c,
                        {'click': click, 'saved': c}))

        # d) PNG 头尺寸
        head = _j(cdp, """(() => JSON.stringify({ b64: window.__saved.slice(22, 22 + 40) }))()""")
        raw = base64.b64decode(head.get('b64') or '')
        w, h = struct.unpack('>II', raw[16:24]) if len(raw) >= 24 else (0, 0)
        ok_d = (w, h) == (2244, 1588)
        results.append(('d PNG 尺寸 = A4 横版 ×2（2244×1588）', ok_d, {'w': w, 'h': h}))

        # e) 取消保存 → 不弹错误
        _j(cdp, """(() => {
      window.sitianAPI.saveExportFile = async () => ({ success: false, canceled: true });
      return JSON.stringify({});
    })()""")
        _j(cdp, "(() => { %s.click(); return JSON.stringify({}); })()" % BTN)
        wait_for(cdp, "(() => { const b = %s; return !!b && !b.disabled; })()" % BTN,
                 timeout=15, desc='取消后按钮复位')
        e = _j(cdp, """(() => JSON.stringify({
      msg: (document.querySelector('.interior-container .export-msg') || {}).textContent || '',
      err: !!document.querySelector('.interior-container .export-msg.err'),
    }))()""")
        ok_e = (e.get('err') is False) and ('失败' not in (e.get('msg') or ''))
        results.append(('e 用户取消 → 不当作失败', ok_e, e))

        # f) 保存失败 → 错误提示必须看得见
        _j(cdp, """(() => {
      window.sitianAPI.saveExportFile = async () => ({ success: false, error: '磁盘已满' });
      return JSON.stringify({});
    })()""")
        _j(cdp, "(() => { %s.click(); return JSON.stringify({}); })()" % BTN)
        wait_for(cdp, "!!document.querySelector('.interior-container .export-msg.err')",
                 timeout=15, desc='错误提示出现')
        f = _j(cdp, """(() => JSON.stringify({
      msg: (document.querySelector('.interior-container .export-msg') || {}).textContent || '',
    }))()""")
        ok_f = '磁盘已满' in (f.get('msg') or '')
        results.append(('f 保存失败 → 错误看得见（带原因）', ok_f, f))
    finally:
        _j(cdp, """(() => {
      const s = %s, bid = %s, fid = %s;
      const d = s.interiorData[bid]; const f = d && (d.floors || []).find(x => x.id === fid);
      if (!f) return JSON.stringify({});
      (f.walls || []).slice().forEach(w => s.removeWall(bid, fid, w.id));
      try { window.sitianAPI.saveExportFile = async () => ({ success: false, canceled: true }); } catch (e) {}
      return JSON.stringify({});
    })()""" % (STORE, json.dumps(bid), json.dumps(fid)))

    fails = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print('  %s  %s%s' % ('ok  ' if ok else 'FAIL', name,
                              '' if ok else '  —— %s' % json.dumps(detail, ensure_ascii=False)[:220]))
    if fails:
        return False, '%d/%d 子项失败：%s' % (len(fails), len(results), ' / '.join(f[0] for f in fails))
    return True, '%d/%d 子项通过' % (len(results), len(results))
