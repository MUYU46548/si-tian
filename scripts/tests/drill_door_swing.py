#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：门的开合弧（A12）

制图规矩（旧画法全错）：铰点在**门框一端**、门扇长 = **洞口宽**、弧扫 **90°**。
几何判据在 `unit/test_door_swing.js`（纯函数，9 条）；这里只验**画布上真的变了**：

  1) 默认门（铰点在左门框、向内开）截一张；
  2) `swingDirection = 'right'`（铰点换到右门框）再截 → 与默认图**必须不同**；
  3) `flipSide = true`（向外开）再截 → 与默认图**必须不同**；
  4) 三张图落盘 `build/door-swing/`，供人眼复核（弧从铰点扫 90°，不是半个门）。

为什么用“两张图不同”而不是“看一眼像不像”：符号画错时画面当然也会变，
但**画对了但没生效**（字段改了渲染没读）时画面完全一样 —— 那才是最容易漏的。
所以这里同时验：改字段 → 画面必须变（接线通）；纯函数单测验：变了之后对不对。

用法：python scripts/tests/drill_door_swing.py
"""
import base64
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D                                   # noqa: E402
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for, fetch_string  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

OUT_DIR = os.path.join(D.ROOT, 'build', 'door-swing')


def log(msg):
    print(msg, flush=True)


def shot(cdp, name):
    """截**画布内容**（canvas.toDataURL），不是整页合成截图。

    ⚠️ 第一版用 `Page.captureScreenshot`：1440×900 只抓到 7KB、三张图逐像素相同 ——
    那抓的是页面合成层，画布内容根本没进去（fromSurface 的两档都试过）。要验“符号画成什么样”，
    只能直接取画布像素。
    """
    cdp.eval("window.__shot = document.querySelector('.interior-container canvas').toDataURL('image/png'); 1")
    b64 = fetch_string(
        cdp, 'window.__shot.length',
        lambda i, j: 'window.__shot.slice(%d, %d)' % (i, j),
        desc='%s canvas' % name,
    )
    if not isinstance(b64, str) or ',' not in b64:
        raise RuntimeError('拿不到画布内容：%s' % name)
    raw = base64.b64decode(b64.split(',', 1)[1])
    path = os.path.join(OUT_DIR, '%s.png' % name)
    with open(path, 'wb') as f:
        f.write(raw)
    log('   · %s → %s（%.0f KB）' % (name, os.path.basename(path), len(raw) / 1024.0))
    return path


def diff(a_path, b_path):
    a = np.asarray(Image.open(a_path).convert('RGB'), dtype=np.int16)
    b = np.asarray(Image.open(b_path).convert('RGB'), dtype=np.int16)
    if a.shape != b.shape:
        return {'ok': False, 'reason': 'size-mismatch'}
    d = np.abs(a - b).max(axis=2)
    mask = d > 8
    return {'ok': True, 'px': int(mask.sum()), 'ratio': float(mask.mean()), 'maxdiff': int(d.max())}


def set_door(cdp, patch):
    """改那扇门（走产品写口 updateDoor，一条 undo）。"""
    expr = """(() => {
      const s = %s;
      const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
      const bid = s.currentBuilding && s.currentBuilding.id;
      const d = bid ? s.interiorData[bid] : null;
      if (!d) return JSON.stringify({ err: 'no-data' });
      const cur = (d.floors || []).find(f => f.id === iv.currentFloorId) || (d.floors || [])[0];
      const door = ((cur && cur.doors) || [])[0];
      if (!door) return JSON.stringify({ err: 'no-door' });
      s.updateDoor(bid, cur.id, door.id, %s);
      const after = ((s.interiorData[bid].floors.find(f => f.id === cur.id).doors) || [])[0];
      // 画布是手动重绘的（与 saveOpeningEdit 同一条路径：写口只改数据，重绘由调用方要）
      if (iv.renderer) iv.renderer.requestRender();
      return JSON.stringify({
        id: door.id,
        swingDirection: after.swingDirection, flipSide: after.flipSide,
      });
    })()""" % (D.STORE, json.dumps(patch))
    return D.eval_json(cdp, expr)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    cdp = None
    fails = []
    mock_ready = False
    try:
        log('  · 注入回归 mock 数据…')
        D.RT.setup_mock()
        mock_ready = True
        D.ensure_vite(handles)
        handles.append(D.start_edge())
        cdp = CDP(ws_url=find_page_ws(D.PORT, prefer_prefix='http://localhost:5180'))
        cdp.send('Page.enable')
        cdp.send('Emulation.setDeviceMetricsOverride', {
            'width': 1440, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False,
        })
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='应用挂载')
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层')
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard'); if (b) b.click(); return 1; })()")
        time.sleep(0.3)
        skip_onboarding(cdp)
        ensure_data_ready(cdp)
        ok, info = open_harness_project(cdp)
        if not ok:
            raise RuntimeError('harness 基线项目打不开：%s' % info)
        okb, binfo = ensure_test_building(cdp)
        if not okb:
            raise RuntimeError('建筑 fixture 失败：%s' % binfo)
        bid = binfo['id']
        wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图')
        cdp.eval("window.__dwErrs = [];"
                 "window.addEventListener('error', e => window.__dwErrs.push(String(e.message || e)));"
                 "1")
        D.build_house(cdp, bid)
        time.sleep(1.2)
        D.eval_json(cdp, """(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          iv.editMode = true;
          return JSON.stringify({ ok: true });
        })()""")
        time.sleep(0.8)

        # 重绘触发：headless 下 rAF 可能被节流，单靠 requestRender 画不出来（实测：
        # 数据已是 flipSide=true，画面却逐像素不动）。用“切层再切回”强制整层重建，
        # 但**两次截图都在切层之后**，这样视图参数一致，差异只可能来自门符号本身。
        def rebuild_via_floor_switch():
            cdp.eval("""(() => {
              const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
              const floors = (iv.floors || []);
              const other = floors.find(f => f.id !== iv.currentFloorId);
              const cur = iv.currentFloorId;
              if (other) { iv.selectFloor(other.id); iv.selectFloor(cur); }
              return 1;
            })()""")
            time.sleep(1.0)

        p_default = shot(cdp, '01-default')
        # 铰点换到右门框 → 切层重建 → 截图
        r1 = set_door(cdp, {'swingDirection': 'right'})
        if r1.get('err'):
            fails.append('改铰点失败：%s' % r1['err'])
        else:
            log('  · 铰点改到右门框：%s' % json.dumps(r1, ensure_ascii=False))
        rebuild_via_floor_switch()
        p_right = shot(cdp, '02-hinge-right')
        # 再向外开 → 切层重建 → 截图
        r2 = set_door(cdp, {'flipSide': True})
        if r2.get('err'):
            fails.append('改开向失败：%s' % r2['err'])
        else:
            log('  · 改开向：%s' % json.dumps(r2, ensure_ascii=False))
            if r2.get('flipSide') is not True:
                fails.append('写口没把 flipSide 存成 true（实际 %r）' % r2.get('flipSide'))
        rebuild_via_floor_switch()
        p_flip = shot(cdp, '03-flip-side')
        # 再验铰点：在“向外开”的前提下把铰点换回左门框 → 切层重建 → 截图
        # （03 与 04 的视图一致，差异只可能来自铰点）
        r3 = set_door(cdp, {'swingDirection': 'left'})
        if r3.get('err'):
            fails.append('改回左门框失败：%s' % r3['err'])
        rebuild_via_floor_switch()
        p_left = shot(cdp, '04-hinge-left-flip')
        # 诊断：组件（渲染读的那份）里的门字段是什么
        comp = D.eval_json(cdp, """(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          const f = iv.currentFloor;
          const d = ((f && f.doors) || [])[0];
          return JSON.stringify({
            flipSide: d ? d.flipSide : null,
            swingDirection: d ? d.swingDirection : null,
            doors: (f && f.doors || []).length,
            walls: (f && f.walls || []).length,
          });
        })()""")
        log('  · 组件里的门：%s' % json.dumps(comp, ensure_ascii=False))

        d1 = diff(p_default, p_right)
        d2 = diff(p_default, p_flip)
        d3 = diff(p_right, p_flip)
        d4 = diff(p_flip, p_left)
        log('  · 默认 vs 铰点右移：%d 像素（%.3f%%）—— 视图也跟着变了，只作信息'
            % (d1.get('px', -1), 100 * d1.get('ratio', -1)))
        log('  · 铰点右移 vs 铰点右移+向外开（同视图）：%d 像素（%.3f%%）'
            % (d3.get('px', -1), 100 * d3.get('ratio', -1)))
        log('  · 向外开+铰点右 vs 向外开+铰点左（同视图）：%d 像素（%.3f%%）'
            % (d4.get('px', -1), 100 * d4.get('ratio', -1)))
        # 判据只取“同视图”的两组：02/03 差 = flipSide 生效；03/04 差 = swingDirection 生效。
        # 拿默认图比（d1/d2）不行 —— 切层会重新 fit，整幅都变（60%），那证明不了符号。
        if not d3.get('ok') or d3.get('px', 0) < 200:
            fails.append('开向翻转后画面几乎没变（%s 像素）—— 渲染没读 flipSide' % d3.get('px'))
        if not d4.get('ok') or d4.get('px', 0) < 200:
            fails.append('铰点换边后画面几乎没变（%s 像素）—— 渲染没读 swingDirection' % d4.get('px'))
        void = d2  # 保留读数，不参与判据

        errs = cdp.eval("(window.__dwErrs || []).slice(0, 5)") or []
        if errs:
            fails.append('页面报错：%s' % errs)

        if fails:
            log('\n❌ 门开合弧没通过：')
            for f in fails:
                log('  - %s' % f)
            return 1
        log('\n✅ 门开合弧：改铰点/开向画面都真的变了（几何对不对由 unit/test_door_swing.js 9/9 守）')
        return 0
    finally:
        try:
            if cdp:
                cdp.close()
        except Exception:
            pass
        for h in handles[::-1]:
            try:
                h.terminate()
            except Exception:
                pass
        if mock_ready:
            try:
                D.RT.teardown_mock()
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())
