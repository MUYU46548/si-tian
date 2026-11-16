#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：建筑平面图「出图」（2026-11-14，第 4 刀）

检查的是"**一张能贴的图**"，不是"能画"：
  1) 真实点「出图」按钮 → 走 `saveExportFile` 同一条 IPC（这里 stub 掉，只为拿到 dataUrl）；
  2) 把导出的 PNG 落盘到 `build/plan-sheet/`，解出尺寸与"四要素区域是否有墨"：
     标题栏 / 指北针 / 图例 / 房间面积表 —— 任何一块空白都算失败；
  3) 版面必须能看见墙（中间图面带深色像素）与房间名（中图区有文字级墨点）。

用法：
  python scripts/tests/drill_plan_export.py
"""
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D  # noqa: E402  复用起环境/造楼/截图的那套
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for, fetch_string  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

OUT_DIR = os.path.join(D.ROOT, 'build', 'plan-sheet')


def log(msg):
    print(msg, flush=True)


def png_regions(data):
    """解 PNG（8bit RGB/RGBA）→ 尺寸 + 若干区域的白像素占比。不引第三方库。"""
    import struct
    import zlib

    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return {'ok': False, 'reason': 'not-png'}
    pos = 8
    width = height = ctype = bitd = None
    idat = b''
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            width, height, bitd, ctype = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        pos += 12 + ln
    if bitd != 8 or ctype not in (2, 6):
        return {'ok': False, 'reason': 'color-type-%s/%s' % (ctype, bitd)}
    raw = zlib.decompress(idat)
    bpp = 4 if ctype == 6 else 3
    stride = width * bpp
    prev = bytearray(stride)
    rows = []
    p = 0
    for _y in range(height):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        prev = line
        rows.append(bytes(line))

    def ink(x0, y0, x1, y1):
        """区域内"非白"像素占比（灰度 < 235 算有墨）"""
        x0 = max(0, int(x0)); y0 = max(0, int(y0))
        x1 = min(width, int(x1)); y1 = min(height, int(y1))
        if x1 <= x0 or y1 <= y0:
            return 0.0
        dark = 0
        total = 0
        for y in range(y0, y1):
            line = rows[y]
            for x in range(x0, x1, 2):
                o = x * bpp
                g = (line[o] + line[o + 1] + line[o + 2]) / 3
                total += 1
                if g < 235:
                    dark += 1
        return round(dark / max(1, total), 4)

    # rows / bpp 一并带出去：轴测插图那条演练要比两张图（关掉比例人再出一张），
    # 逐像素对照得拿到原始行（以前只回 ink，看图的人没得比）
    return {'ok': True, 'w': width, 'h': height, 'ink': ink, 'rows': rows, 'bpp': bpp}


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
        log('  · 启动 Edge（允许 WebGL，出图不需要但它顺带验一遍）…')
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
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层退出')
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

        house = D.build_house(cdp, bid)
        log('  · 造楼：%s' % json.dumps(house, ensure_ascii=False))
        # 房间要有名字，面积表才不是一片"未命名"
        cdp.eval("""(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          iv.recalcRooms && iv.recalcRooms();
          return 1;
        })()""")
        time.sleep(0.6)

        # stub 保存通道：只取 dataUrl，不弹对话框
        cdp.eval("""(() => {
          window.__saved = null;
          window.sitianAPI.saveExportFile = async (o) => {
            window.__saved = o && o.dataUrl;
            window.__savedName = o && o.defaultName;
            return { success: true, path: 'X:/tmp/' + (o && o.defaultName) };
          };
          return 1;
        })()""")

        clicked = cdp.eval("""(() => {
          const b = Array.from(document.querySelectorAll('.interior-container .header-actions button'))
            .find(x => x.textContent.trim() === '出图');
          if (!b) return 'no-button';
          if (b.disabled) return 'disabled';
          b.click();
          return 'ok';
        })()""")
        if clicked != 'ok':
            fails.append('出图按钮不可用：%s' % clicked)
        else:
            wait_for(cdp, "!!window.__saved", timeout=25, desc='导出完成')
            name = cdp.eval("window.__savedName || ''")
            log('  · 文件名：%s' % name)
            if '平面图' not in (name or ''):
                fails.append('导出名不像平面图：%r' % name)

            total = cdp.eval("window.__saved.length") or 0
            b64 = fetch_string(
                cdp, 'window.__saved.length',
                lambda i, j: 'window.__saved.slice(%d, %d)' % (i, j),
                desc='平面图 dataUrl',
            )
            data = base64.b64decode(b64.split(',', 1)[1] if b64.startswith('data:') else b64)
            path = os.path.join(OUT_DIR, 'plan-A4.png')
            with open(path, 'wb') as f:
                f.write(data)
            log('  · 落盘 %s（%.1f KB, base64 %s 字符）' % (path, len(data) / 1024, total))

            info = png_regions(data)
            log('  · PNG：%s×%s' % (info.get('w'), info.get('h')))
            if not info.get('ok'):
                fails.append('PNG 解析失败：%s' % info)
            else:
                # 2 倍 A4（1122×794）→ 2244×1588
                if (info['w'], info['h']) != (2244, 1588):
                    fails.append('尺寸应为 2244×1588，实际 %s×%s' % (info['w'], info['h']))
                ink = info['ink']
                regions = {
                    '标题栏': ink(60, 1350, 2180, 1520),
                    '图例': ink(1620, 1200, 2160, 1470),
                    '房间面积表': ink(1620, 170, 2160, 700),
                    '中间图面': ink(100, 200, 1560, 1300),
                    '指北针': ink(1350, 180, 1500, 330),
                }
                log('  · 各区域墨量：%s' % json.dumps(regions, ensure_ascii=False))
                for k, v in regions.items():
                    if v < 0.002:
                        fails.append('「%s」区域几乎空白（ink=%s）' % (k, v))
                if regions['中间图面'] < 0.02:
                    fails.append('中间图面太空（没画出平面图？ink=%s）' % regions['中间图面'])

        if fails:
            log('\n❌ 失败：')
            for f in fails:
                log('  - %s' % f)
            return 1
        log('\n✅ 平面图出图成功：%s' % os.path.join(OUT_DIR, 'plan-A4.png'))
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
            except Exception as e:
                log('  ⚠️ mock 收尾失败（请手工还原 index.html）：%s' % e)


if __name__ == '__main__':
    sys.exit(main())
