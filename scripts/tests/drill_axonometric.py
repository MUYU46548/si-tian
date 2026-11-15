#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：单栋建筑**轴测插图**出图（2026-11-15）

验的不是"按钮能点"，是"**出来一张能贴进设定集的图**"：
  1) 点「轴测出图」→ 走与产品按钮完全相同的路径（`saveExportFile` 在这里 stub 掉只为拿 dataUrl）；
  2) PNG 落盘 `build/axonometric/`，尺寸必须 3600×2400；
  3) 版面必须有东西：整幅非白占比、中心建筑区域墨量、画面四角必须是纸色（不能是黑边/空白画布）。

用法：
  python scripts/tests/drill_axonometric.py
"""
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D                                   # noqa: E402
import drill_plan_export as P                                   # noqa: E402  复用 PNG 解析
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for, fetch_string  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

OUT_DIR = os.path.join(D.ROOT, 'build', 'axonometric')


def log(msg):
    print(msg, flush=True)


def run_one(cdp, preset, tag, fails):
    """点一次出图，落盘并核对。返回 (信息 dict)"""
    cdp.eval("""(() => {
      window.__saved = null;
      window.savedName = null;
      window.sitianAPI.saveExportFile = async (o) => {
        window.__saved = o && o.dataUrl;
        window.savedName = o && o.defaultName;
        return { success: true, path: 'stub://' + (o && o.defaultName) };
      };
      return 1;
    })()""")
    cdp.eval("""(() => {
      const sel = document.querySelector('[data-testid=exterior-axo-preset]');
      if (sel) { sel.value = %s; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      return 1;
    })()""" % json.dumps(preset))
    time.sleep(0.2)
    clicked = cdp.eval("""(() => {
      const b = document.querySelector('[data-testid=exterior-axo-export]');
      if (!b || b.disabled) return JSON.stringify({ ok: false, disabled: !!b && b.disabled });
      b.click();
      return JSON.stringify({ ok: true });
    })()""")
    if isinstance(clicked, str) and clicked.startswith('{'):
        try:
            if not json.loads(clicked).get('ok'):
                fails.append('%s：出图按钮不可点（%s）' % (tag, clicked))
                return None
        except ValueError:
            pass

    wait_for(cdp, "!!window.__saved", timeout=60, desc='%s 出图完成' % tag)
    total = cdp.eval("window.__saved.length") or 0
    b64 = fetch_string(
        cdp, 'window.__saved.length',
        lambda i, j: 'window.__saved.slice(%d, %d)' % (i, j),
        desc='%s dataUrl' % tag,
    )
    data_url = b64 if isinstance(b64, str) else ''
    name = cdp.eval("window.savedName || ''") or ''
    if ',' not in data_url:
        fails.append('%s：拿不到 dataUrl（长度 %s）' % (tag, total))
        return None
    raw = base64.b64decode(data_url.split(',', 1)[1])
    path = os.path.join(OUT_DIR, '%s-%s.png' % (tag, preset))
    with open(path, 'wb') as f:
        f.write(raw)

    info = P.png_regions(raw)
    if not info.get('ok'):
        fails.append('%s：PNG 解析失败 %s' % (tag, info.get('reason')))
        return None
    w, h = info['w'], info['h']
    ink = info['ink']
    whole = ink(0, 0, w, h)
    center = ink(w * 0.30, h * 0.25, w * 0.70, h * 0.75)
    corner_tl = ink(0, 0, w * 0.08, h * 0.08)
    corner_br = ink(w * 0.92, h * 0.92, w, h)

    if (w, h) != (3600, 2400):
        fails.append('%s：尺寸应为 3600×2400，实际 %s×%s' % (tag, w, h))
    if whole < 0.10:
        fails.append('%s：整幅几乎没有内容（非白占比 %.3f）' % (tag, whole))
    if center < 0.35:
        fails.append('%s：画面中间没有建筑（墨量 %.3f）' % (tag, center))
    if corner_tl > 0.06 or corner_br > 0.06:
        fails.append('%s：四角不是纸色（左上 %.3f / 右下 %.3f）—— 可能整幅跑偏或被切' % (tag, corner_tl, corner_br))

    log('  · %s %dx%d 整幅 %.3f 中心 %.3f 角 %.3f/%.3f → %s'
        % (tag, w, h, whole, center, corner_tl, corner_br, os.path.basename(path)))
    return {'path': path, 'w': w, 'h': h, 'whole': whole, 'center': center, 'name': name}


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
        cdp.eval("""(() => {
          const b = document.querySelector('.recovery-overlay .btn-discard');
          if (b) b.click();
          return 1;
        })()""")
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
        D.build_house(cdp, bid)

        # 打开外观（与 drill_exterior_3d 同一条路径：真实点按钮）
        clicked = cdp.eval("""(() => {
          const btns = [...document.querySelectorAll('.exterior-btn, .header-actions button')];
          const b = btns.find(x => x.textContent.trim() === '外观');
          if (!b) return JSON.stringify({ ok: false, why: 'no-button' });
          if (b.disabled) return JSON.stringify({ ok: false, why: 'disabled' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""")
        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-view]')", timeout=20, desc='外观浮层')
        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-stats]')", timeout=20, desc='统计')
        time.sleep(1.2)

        for preset, tag in [('iso', '01-iso'), ('dimetric', '02-dimetric'), ('high', '03-high')]:
            run_one(cdp, preset, tag, fails)

        if fails:
            log('\n❌ 轴测出图有问题：')
            for f in fails:
                log('   - ' + f)
            return 1
        log('\n✅ 轴测插图出图成功：%s' % OUT_DIR)
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
