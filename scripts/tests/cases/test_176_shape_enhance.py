#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 176：自绘增强 —— 顶点微调 / 平滑曲线 / 形状模板（2026-11-15）

三件都是"画完之后"的事：
  a) 画歪一个点不用重画 —— 直接拖那个顶点
  b) 方方正正的折线太硬 —— 一键平滑（数据仍是点，可切回）
  c) 一排同样的柜子 —— 存成模板，套到别的家具上（中心不动）

  a) 拖动已有顶点 → 坐标改变，点数不变
  b) 平滑开关在绘制态可见，保存后 custom.smooth=true，再进绘制态仍为 true
  c) 存为模板：prompt 给名字 → localStorage 里有、下拉框出现、条目带尺寸
  d) 套用模板：另一件家具拿到同样的点数与尺寸，且中心不变
  e) 删除模板：列表少一条、localStorage 同步
"""
import json
import sys
import os
import time

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
      if (!d || !(d.floors || []).length) s.addFloor(bid, '自绘增强层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      (f.furniture || []).slice().forEach(x => s.removeFurniture(bid, f.id, x.id));
      try { localStorage.removeItem('sitian:interior-shape-templates'); } catch (e) {}
      iv.shapeTemplates = [];
      iv.pickedTemplateId = '';
      const a = s.addFurniture(bid, f.id, { name: '自绘甲', type: 'generic', x: -300, y: -50, width: 120, height: 60 });
      const b = s.addFurniture(bid, f.id, { name: '自绘乙', type: 'generic', x: 60, y: -50, width: 80, height: 40 });
      iv.editMode = false;
      iv.fitToFloor && iv.fitToFloor();
      return JSON.stringify({ fid: f.id, a: a && a.id, b: b && b.id });
    })()""" % (STORE, IV, json.dumps(bid)))
    fid, ida, idb = prep.get('fid'), prep.get('a'), prep.get('b')
    if not (fid and ida and idb):
        return False, '准备家具失败：%s' % prep

    results = []
    try:
        wait_for(cdp, "(() => %s.renderer.getViewTransform().scale > 0)()" % IV, timeout=6, desc='相机就绪')

        # a) 拖动顶点：进绘制态画 4 点（家具甲 120×60 @ (-300,-50)），拖第 2 点
        a = _j(cdp, """(() => {
      const s = %s, iv = %s;
      const f = iv.currentFloor;
      const it = f.furniture.find(x => x.id === %s);
      iv.selectedFurniture = it;
      iv.startShapeEdit();
      iv.shapeEdit.points = [
        { x: -300, y: -50 }, { x: -180, y: -50 }, { x: -180, y: 10 }, { x: -300, y: 10 },
      ];
      const before = JSON.parse(JSON.stringify(iv.shapeEdit.points[1]));
      // 走真实拖拽管线（handleDragStart 返回顶点模式）
      const info = iv.handleDragStart(-180, -50, 0, false, false, false);
      iv.handleDragMove(-150, -80, info);
      iv.handleDragEnd(-150, -80, info);
      const after = JSON.parse(JSON.stringify(iv.shapeEdit.points[1]));
      return JSON.stringify({
        mode: info && info.mode, nodeId: info && info.nodeId,
        before, after, n: iv.shapeEdit.points.length,
      });
    })()""" % (STORE, IV, json.dumps(ida)))
        ok_a = (a.get('mode') == 'node' and str(a.get('nodeId', '')).startswith('shape-vertex:')
                and a.get('after') == {'x': -150, 'y': -80} and a.get('n') == 4
                and a.get('before') == {'x': -180, 'y': -50})
        results.append(('a 拖已有顶点 → 只动这个点，点数不变', ok_a, a))

        # b) 平滑：切 smooth → 保存 → custom.smooth
        b = _j(cdp, """(() => {
      const s = %s, iv = %s;
      const btn = document.querySelector('[data-testid=shape-smooth]');
      const found = !!btn;
      iv.shapeEdit.smooth = true;
      const ok = iv.finishShapeEdit();
      const f = iv.currentFloor;
      const it = f.furniture.find(x => x.id === %s);
      // 再进绘制态，看是否记住平滑
      iv.selectedFurniture = it;
      iv.startShapeEdit();
      const remembered = iv.shapeEdit.smooth;
      iv.cancelShapeEdit();
      return JSON.stringify({
        found, ok, smooth: it && it.custom ? it.custom.smooth : null,
        n: it && it.custom ? it.custom.points.length : 0, remembered,
      });
    })()""" % (STORE, IV, json.dumps(ida)))
        ok_b = bool(b.get('found')) and b.get('ok') is True and b.get('smooth') is True \
            and b.get('n') == 4 and b.get('remembered') is True
        results.append(('b 平滑：开关可见 → 保存 smooth=true → 再进仍记得', ok_b, b))

        # c) 存为模板：prompt 给名字
        _j(cdp, "(() => { window.prompt = () => '异形柜'; return JSON.stringify({}); })()")
        c = _j(cdp, """(() => {
      const s = %s, iv = %s;
      const f = iv.currentFloor;
      const it = f.furniture.find(x => x.id === %s);
      iv.selectedFurniture = it;
      return JSON.stringify({ hasFn: typeof iv.saveAsShapeTemplate === 'function' });
    })()""" % (STORE, IV, json.dumps(ida)))
        _j(cdp, """(() => {
      const iv = %s;
      iv.saveAsShapeTemplate();
      return JSON.stringify({});
    })()""" % IV)
        # saveAsShapeTemplate 是 async（要等对话框）：给它一拍再读 localStorage
        time.sleep(0.3)
        c2 = _j(cdp, """(() => {
      const iv = %s;
      let raw = [];
      try { raw = JSON.parse(localStorage.getItem('sitian:interior-shape-templates') || '[]'); } catch (e) {}
      const opt = document.querySelector('[data-testid=shape-tpl-select]');
      const it = iv.currentFloor.furniture.find(x => x.id === %s);
      return JSON.stringify({
        fn: typeof iv.saveAsShapeTemplate, n: iv.shapeTemplates.length,
        stored: (raw || []).length, first: (raw || [])[0] ? { name: raw[0].name, w: raw[0].width, h: raw[0].height } : null,
        select: !!opt,
        picked: iv.pickedTemplateId,
        itemW: it ? it.width : null, itemH: it ? it.height : null,
      });
    })()""" % (IV, json.dumps(ida)))
        ok_c = c2.get('n') == 1 and c2.get('stored') == 1 \
            and (c2.get('first') or {}).get('name') == '异形柜' \
            and c2.get('first', {}).get('w') == c2.get('itemW') and c2.get('first', {}).get('h') == c2.get('itemH') \
            and c2.get('select') is True and bool(c2.get('picked'))
        results.append(('c 存为模板 → localStorage + 下拉框都出现（带尺寸）', ok_c, c2))

        # d) 套用模板到家具乙：点数一致、尺寸变成模板的、中心不变
        d = _j(cdp, """(() => {
      const s = %s, iv = %s;
      const f = iv.currentFloor;
      const it = f.furniture.find(x => x.id === %s);
      const center0 = { x: it.x + it.width / 2, y: it.y + it.height / 2 };
      iv.selectedFurniture = it;
      iv.pickedTemplateId = iv.shapeTemplates[0].id;
      iv.applyShapeTemplate();
      const after = f.furniture.find(x => x.id === %s);
      const center1 = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
      return JSON.stringify({
        n: after.custom ? after.custom.points.length : 0,
        w: after.width, h: after.height,
        smooth: after.custom ? !!after.custom.smooth : null,
        center0, center1,
      });
    })()""" % (STORE, IV, json.dumps(idb), json.dumps(idb)))
        tpl = (c2.get('first') or {})
        ok_d = d.get('n') == 4 and d.get('w') == tpl.get('w') and d.get('h') == tpl.get('h') and d.get('smooth') is True \
            and abs(d['center1']['x'] - d['center0']['x']) < 0.01 \
            and abs(d['center1']['y'] - d['center0']['y']) < 0.01
        results.append(('d 套用模板 → 点数/尺寸/平滑都对，中心不动', ok_d, d))

        # e) 删除模板
        e = _j(cdp, """(() => {
      const iv = %s;
      iv.pickedTemplateId = iv.shapeTemplates[0].id;
      iv.removeShapeTemplate();
      let raw = [];
      try { raw = JSON.parse(localStorage.getItem('sitian:interior-shape-templates') || '[]'); } catch (err) {}
      return JSON.stringify({ n: iv.shapeTemplates.length, stored: (raw || []).length });
    })()""" % IV)
        ok_e = e.get('n') == 0 and e.get('stored') == 0
        results.append(('e 删除模板 → 列表与本机存储同步清空', ok_e, e))
    finally:
        _j(cdp, """(() => {
      const iv = %s;
      if (iv.cancelShapeEdit) iv.cancelShapeEdit();
      iv.pickedTemplateId = '';
      iv.editMode = false;
      try { localStorage.removeItem('sitian:interior-shape-templates'); } catch (e) {}
      return JSON.stringify({});
    })()""" % IV)

    for name, ok, detail in results:
        print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '  ← ' + json.dumps(detail, ensure_ascii=False)[:400]))
    bad = [r for r in results if not r[1]]
    return (len(bad) == 0), '%d/%d 子项通过' % (len(results) - len(bad), len(results))
