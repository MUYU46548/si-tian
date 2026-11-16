#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：单栋建筑**轴测插图**出图（2026-11-15；2026-11-16 加图注与比例人）

验的不是"按钮能点"，是"**出来一张能贴进设定集的图**"：
  1) 点「轴测出图」→ 走与产品按钮完全相同的路径（`saveExportFile` 在这里 stub 掉只为拿 dataUrl）；
  2) PNG 落盘 `build/axonometric/`，尺寸必须 3600×2400；
  3) 三个投影角都能出图，画面中间真的有一栋楼；
  4) **图注**：底部那条纸带上有近黑的字，而且左（图名）/ 中（层数·占地·投影·方位）/ 右（指北针＋出处）
     三段都有东西 —— 只有一片字挤在一角不算；
  5) **比例人与树**：关掉它们再出一张，两张必须**只差在楼的左前方**（证明人/树真的画上去了，
     且没有被画到右侧或者跑出画面）；
  6) 关掉图注再出一张：底部那条带子必须**几乎没有近黑像素**（反过来证明图注是画上去的，不是底图自带）。

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

# 图注条占成品高的比例 —— 与 `src/renderer/src/interior/axoProps.js` 的 AXO_SHEET.bandRatio 同口径
BAND_RATIO = 0.115


def log(msg):
    print(msg, flush=True)


def px_at(info, x, y):
    """一个像素的灰度（RGB / RGBA 的 PNG 都支持）"""
    row = info['rows'][max(0, min(info['h'] - 1, int(y)))]
    o = max(0, min(info['w'] - 1, int(x))) * info['bpp']
    return (row[o] + row[o + 1] + row[o + 2]) // 3


def dark_frac(info, box, thr=150, step=2):
    """区域内**近黑**像素占比（灰度 < thr）。

    图注的字是 #2f343b（灰度约 47），比纸底和浅色地面暗得多，
    所以 150 这个门槛能把"有字"和"浅色地面"分开 —— ink() 的 235 门槛分不开。
    """
    w, h = info['w'], info['h']
    rows, bpp = info['rows'], info['bpp']
    x0 = max(0, int(box[0])); y0 = max(0, int(box[1]))
    x1 = min(w, int(box[2])); y1 = min(h, int(box[3]))
    if x1 <= x0 or y1 <= y0:
        return 0.0
    dark = 0
    total = 0
    for y in range(y0, y1, step):
        line = rows[y]
        for x in range(x0, x1, step):
            o = x * bpp
            g = (line[o] + line[o + 1] + line[o + 2]) / 3
            total += 1
            if g < thr:
                dark += 1
    return round(dark / max(1, total), 4)


def dark_stats(info, box, thr=90, step=3):
    """区域内**很黑**的像素占比与重心（剪影是 #22262c，比墙线和墨线都实）。

    为什么要重心：只比"有没有黑"分不清"人画在楼的左边"和"人画在楼右边、甚至压在楼上"。
    剪影是**成片**的实心块，墙线只是一根根线，用 90 这个门槛就能把两者分开。
    """
    w, h = info['w'], info['h']
    rows, bpp = info['rows'], info['bpp']
    x0 = max(0, int(box[0])); y0 = max(0, int(box[1]))
    x1 = min(w, int(box[2])); y1 = min(h, int(box[3]))
    if x1 <= x0 or y1 <= y0:
        return {'frac': 0.0, 'cx': 0.0, 'cy': 0.0}
    dark = 0
    total = 0
    sx = 0
    sy = 0
    for y in range(y0, y1, step):
        line = rows[y]
        for x in range(x0, x1, step):
            o = x * bpp
            g = (line[o] + line[o + 1] + line[o + 2]) / 3
            total += 1
            if g < thr:
                dark += 1
                sx += x
                sy += y
    if not dark:
        return {'frac': 0.0, 'cx': 0.0, 'cy': 0.0}
    return {'frac': round(dark / max(1, total), 5), 'cx': sx / dark, 'cy': sy / dark}


def compare(a, b, step=3, tol=24, region=None):
    """两张同尺寸图逐像素对照（step 抽稀；tol 挡掉抗锯齿级别的噪声）。

    region=(x0,y0,x1,y1) 只看这块（比如排掉底部图注条：关掉比例人时图注里
    “比例人 1.70 m”那一行也会跟着没，那不是画面内容的差别）。
    返回 {frac, bbox}：变化像素占比 + 变化区域外接框（原图像素坐标）。
    """
    if (a['w'], a['h']) != (b['w'], b['h']):
        return {'frac': 0.0, 'bbox': None, 'reason': 'size-mismatch'}
    w, h = a['w'], a['h']
    bpp = a['bpp']
    ra_all, rb_all = a['rows'], b['rows']
    rx0, ry0, rx1, ry1 = region if region else (0, 0, w, h)
    rx0 = max(0, int(rx0)); ry0 = max(0, int(ry0))
    rx1 = min(w, int(rx1)); ry1 = min(h, int(ry1))
    changed = 0
    total = 0
    minx, maxx, miny, maxy = w, -1, h, -1
    for y in range(ry0, ry1, step):
        ra, rb = ra_all[y], rb_all[y]
        for x in range(rx0, rx1, step):
            o = x * bpp
            d = abs(ra[o] - rb[o]) + abs(ra[o + 1] - rb[o + 1]) + abs(ra[o + 2] - rb[o + 2])
            total += 1
            if d > tol:
                changed += 1
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    bbox = None if maxx < 0 else [minx, miny, maxx, maxy]
    return {'frac': round(changed / max(1, total), 5), 'bbox': bbox}


def set_opts(cdp, opts):
    """设置/清掉排障口（产品代码只读它，不写任何数据）"""
    payload = 'null' if opts is None else json.dumps(opts)
    cdp.eval('window.__SITIAN_AXO_OPTS__ = %s' % payload)


def run_one(cdp, preset, tag, fails, opts=None):
    """点一次出图，落盘并解析。返回 {path,w,h,name,img}"""
    set_opts(cdp, opts)
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

    wait_for(cdp, "!!window.__saved", timeout=90, desc='%s 出图完成' % tag)
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
    return {'path': path, 'w': info['w'], 'h': info['h'], 'name': name, 'img': info}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    cdp = None
    fails = []
    mock_ready = False
    shots = {}
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
        cdp.eval("""(() => {
          const btns = [...document.querySelectorAll('.exterior-btn, .header-actions button')];
          const b = btns.find(x => x.textContent.trim() === '外观');
          if (b && !b.disabled) b.click();
          return 1;
        })()""")
        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-view]')", timeout=20, desc='外观浮层')
        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-stats]')", timeout=20, desc='统计')
        time.sleep(1.2)

        # ① 三个投影角（都带图注与比例人）
        for preset, tag in [('iso', '01-iso'), ('dimetric', '02-dimetric'), ('high', '03-high')]:
            r = run_one(cdp, preset, tag, fails)
            if r:
                shots[tag] = r

        # ② 对照：关掉比例人 / 树
        r = run_one(cdp, 'iso', '04-noprops', fails, opts={'props': False})
        if r:
            shots['04-noprops'] = r
        # ③ 对照：关掉图注（**同时关掉比例人**：这样底部那条带子里只剩图注的差别，
        #    否则人/树的脚和影子会落进同一条带子，判据就分不清"黑的是字还是树"）
        r = run_one(cdp, 'iso', '05-nocaption', fails, opts={'props': False, 'caption': False})
        if r:
            shots['05-nocaption'] = r
        set_opts(cdp, None)

        # ── 判据 ────────────────────────────────────────────────────────
        base = shots.get('01-iso')
        if not base:
            fails.append('01-iso：没拿到图')
        else:
            info = base['img']
            w, h = info['w'], info['h']
            ink = info['ink']
            band_top = h - int(round(h * BAND_RATIO))
            whole = ink(0, 0, w, h)
            center = ink(w * 0.30, h * 0.20, w * 0.70, band_top * 0.85)
            # 2026-11-16：插图现在铺了一块与纸同色的地面板（单栋也要"落在地上"），
            # 所以四角不再要求"纸色"，改判"够亮 + 四角一致"—— 黑边 / 空画布 / 整幅跑偏照样抓得住。
            corners = [px_at(info, x, y) for (x, y) in [
                (8, 8), (w - 8, 8), (8, band_top - 8), (w - 8, band_top - 8)]]
            cmin = min(corners)
            cmax = max(corners)
            band_left = dark_frac(info, (0, band_top, w * 0.34, h))
            band_mid = dark_frac(info, (w * 0.34, band_top, w * 0.82, h))
            band_right = dark_frac(info, (w * 0.82, band_top, w, h))

            if (w, h) != (3600, 2400):
                fails.append('01-iso：尺寸应为 3600×2400，实际 %s×%s' % (w, h))
            if whole < 0.08:
                fails.append('01-iso：整幅几乎没有内容（非白占比 %.3f）' % whole)
            if center < 0.30:
                fails.append('01-iso：画面中间没有建筑（墨量 %.3f）' % center)
            if cmin < 190:
                fails.append('01-iso：四角里有暗的（最暗 %d）—— 可能整幅跑偏/被切/黑边' % cmin)
            if cmax - cmin > 30:
                fails.append('01-iso：四角颜色差太多（%d ~ %d）—— 画面可能没铺满' % (cmin, cmax))
            for name, v in (('左（图名）', band_left), ('中（层数·占地·投影·方位）', band_mid),
                            ('右（指北针＋出处）', band_right)):
                if v <= 0.0005:
                    fails.append('01-iso：图注%s那一段是空的（近黑 %.4f）' % (name, v))
            log('  · 01-iso %dx%d 整幅 %.3f 中心 %.3f 四角 %d~%d 图注条 左 %.4f 中 %.4f 右 %.4f'
                % (w, h, whole, center, cmin, cmax, band_left, band_mid, band_right))

        for tag in ('02-dimetric', '03-high'):
            r = shots.get(tag)
            if not r:
                continue
            info = r['img']
            w, h = info['w'], info['h']
            center = info['ink'](w * 0.30, h * 0.20, w * 0.70, h * 0.68)
            if (w, h) != (3600, 2400):
                fails.append('%s：尺寸应为 3600×2400，实际 %s×%s' % (tag, w, h))
            if center < 0.30:
                fails.append('%s：画面中间没有建筑（墨量 %.3f）' % (tag, center))
            log('  · %s %dx%d 中心 %.3f' % (tag, w, h, center))

        # 比例人 / 树：剪影是成片的近黑块，墙线和墨线不是 —— 用它判"真的画上去了、而且在左边"
        no_props = shots.get('04-noprops')
        if base and no_props:
            w = base['img']['w']
            h = base['img']['h']
            band_top = h - int(round(h * BAND_RATIO))
            on = dark_stats(base['img'], (0, 0, w, band_top))
            off = dark_stats(no_props['img'], (0, 0, w, band_top))
            d = compare(base['img'], no_props['img'], region=(0, 0, w, band_top))
            log('  · 比例人：近黑占比 有 %.3f%% / 无 %.3f%%；重心 x=%.0f（左半=%.0f）；逐像素差 %.2f%%'
                % (on['frac'] * 100, off['frac'] * 100, on['cx'], w * 0.5, d['frac'] * 100))
            if on['frac'] < 0.012:
                fails.append('画面里几乎没有成片的近黑（%.3f%%）—— 比例人/树没画上去？' % (on['frac'] * 100))
            if not (on['frac'] > off['frac'] * 2):
                fails.append('关掉比例人后近黑没减少（有 %.4f / 无 %.4f）—— 判据没区分力'
                             % (on['frac'], off['frac']))
            if on['cx'] > w * 0.45:
                fails.append('比例人/树的重心在画面右侧（x=%.0f / 宽 %d）—— 应摆左前方' % (on['cx'], w))
            if d['frac'] < 0.005:
                fails.append('开/关比例人的两张图几乎一模一样（差 %.3f%%）' % (d['frac'] * 100))

        # 图注：关掉之后底部那条带子必须几乎没字（两张都**没有比例人**，只差图注）
        no_cap = shots.get('05-nocaption')
        no_props_img = shots.get('04-noprops')
        if no_props_img and no_cap:
            h = no_cap['img']['h']
            w = no_cap['img']['w']
            top = h - int(round(h * BAND_RATIO))
            # 门槛取 90（不是 150）：这条带子里总有地面和投影（灰度 120~200），
            # 图注的字是 #2f343b（约 47）—— 用 90 才分得开"字"和"地面"。
            bare = dark_frac(no_cap['img'], (0, top, w, h), thr=90)
            with_cap = dark_frac(no_props_img['img'], (0, top, w, h), thr=90)
            log('  · 图注对照：有字 %.4f / 无字 %.4f' % (with_cap, bare))
            if bare > 0.001:
                fails.append('关掉图注后底部仍有近黑像素（%.4f）—— 图注不是画上去的？' % bare)
            if not (with_cap > bare * 5):
                fails.append('有图注 / 无图注的底部没拉开差距（%.4f vs %.4f）' % (with_cap, bare))

        if fails:
            log('\n❌ 轴测插图有问题：')
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
