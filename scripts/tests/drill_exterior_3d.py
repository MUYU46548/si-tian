#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：建筑外观（3D）出图（2026-11-14）

回归用例（test_168）只守"接线与不崩"—— 它跑在 `--disable-gpu` 的 headless Edge 上，
很可能根本拿不到 WebGL，验不了"这栋房子看着像不像房子"。

这个脚本专门做那件事：**真出一张图**。它自己起 Vite、起**带 GPU（SwiftShader）**的
headless Edge，在页面里造一栋两层小楼（外墙 24cm / 层高 300cm / 一门六窗），
依次截三张：
  1) 坡顶 · 默认机位
  2) 坡顶 · 转 40° 的低角度
  3) 平顶
产物落 `build/exterior-3d/`。

判定（不靠肉眼也能失败）：
  · 每张图都不是纯色（像素方差 > 阈值）—— 白屏/黑屏会当场红；
  · 页面零 JS 报错；
  · 顶栏统计与数据一致（2 层 / 8 面墙 / 7 处门窗）。

用法：
  python scripts/tests/drill_exterior_3d.py
"""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import time
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402
# 复用回归的 mock 注入（页面在浏览器里跑，没有 Electron 主进程，`window.sitianAPI` 靠它）
sys.path.insert(0, os.path.dirname(__file__))
import run_tests as RT  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(ROOT, 'build', 'exterior-3d')
PORT = 9333   # 专用端口：不撞 9222（回归）/ 9224（诊断包）
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"

EDGE_CANDIDATES = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
]


def log(msg):
    print(msg, flush=True)


def port_open(port, host=None):
    """端口是否有人听。⚠️ Vite 默认只听 [::1]（IPv6）—— 只试 127.0.0.1 会一直判"没起来"，
    第一版就这么白等了 90 秒（服务其实早就绪）。两个族都要试。"""
    hosts = [host] if host else ['127.0.0.1', '::1', 'localhost']
    for h in hosts:
        try:
            fam = socket.AF_INET6 if ':' in h else socket.AF_INET
            with socket.socket(fam, socket.SOCK_STREAM) as s:
                s.settimeout(0.4)
                if s.connect_ex((h, port)) == 0:
                    return True
        except OSError:
            continue
    return False


def wait_port(port, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.3)
    return False


def ensure_vite(handles):
    if port_open(5180):
        log('  · Vite 已在 5180，复用')
        return
    log('  · 启动 Vite dev server…')
    cmd = ['cmd', '/c', 'npm', 'run', 'dev'] if os.name == 'nt' else ['npm', 'run', 'dev']
    p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    handles.append(p)
    if not wait_port(5180, 90):
        raise RuntimeError('Vite 启动超时（5180）')


def start_edge():
    exe = next((p for p in EDGE_CANDIDATES if os.path.exists(p)), None)
    if not exe:
        raise RuntimeError('找不到 msedge.exe')
    profile = os.path.join(ROOT, '.test-edge-profile-3d')
    args = [
        exe, '--headless=new',
        '--enable-unsafe-swiftshader',   # Chrome 120+ 软件 WebGL 必须显式开
        '--use-angle=swiftshader',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=%d' % PORT,
        '--remote-allow-origins=*',
        '--user-data-dir=%s' % profile,
        '--window-size=1440,900',
        '--no-first-run', '--no-default-browser-check',
        '--no-sandbox', 'about:blank',
    ]
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_port(PORT, 40):
        raise RuntimeError('Edge CDP 启动超时')
    return p


def eval_json(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def page_task_seconds(cdp):
    """页面渲染进程累计 CPU 秒数（CDP Performance.TaskDuration）。
    用它证明「静止时不再空转」——旧的常驻 60fps 循环静止时也在烧 CPU。"""
    try:
        r = cdp.send('Performance.getMetrics')
        for m in r.get('metrics', []):
            if m.get('name') == 'TaskDuration':
                return round(float(m.get('value') or 0), 3)
    except Exception as e:
        log('  ⚠️ CPU 采样失败：%s' % e)
    return None


def shot(cdp, name):
    r = cdp.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
    data = base64.b64decode(r['data'])
    path = os.path.join(OUT_DIR, name + '.png')
    with open(path, 'wb') as f:
        f.write(data)
    return path, png_stats(data)


def png_stats(data):
    """粗算 PNG 像素方差（只看灰度）。纯色图方差≈0 —— 白屏/黑屏当场能抓出来。"""
    # 解析 IHDR
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return {'ok': False, 'reason': 'not-png'}
    pos = 8
    width = height = None
    idat = b''
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            width, height, bitd, ctype = struct.unpack('>IIBB', body[:10])
            if bitd != 8 or ctype not in (2, 6):
                return {'ok': True, 'w': width, 'h': height, 'variance': None, 'note': 'unsupported-color-type'}
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        pos += 12 + ln
    try:
        raw = zlib.decompress(idat)
    except Exception as e:
        return {'ok': False, 'reason': 'inflate-failed:%s' % e}
    bpp = 4 if ctype == 6 else 3
    stride = width * bpp
    prev = bytearray(stride)
    total = 0
    total2 = 0
    count = 0
    p = 0
    step_y = max(1, height // 200)   # 抽样，别为算方差把整张图扫一遍
    for y in range(height):
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
        if y % step_y:
            continue
        for x in range(0, stride, bpp * 7):
            v = line[x]
            total += v
            total2 += v * v
            count += 1
    mean = total / max(1, count)
    var = total2 / max(1, count) - mean * mean
    return {'ok': True, 'w': width, 'h': height, 'variance': round(var, 1), 'mean': round(mean, 1)}


def build_house(cdp, bid):
    """两层小楼：9m × 6.5m，外墙 24cm，层高 300，一门六窗。"""
    return eval_json(cdp, """(() => {
      const s = %s, iv = %s, bid = %s;
      let d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) s.addFloor(bid, '一层');
      d = s.interiorData[bid];
      // 只留一层，再补一层（避免老数据/上次残留混进来）
      while (d.floors.length > 1) {
        const extra = d.floors[d.floors.length - 1];
        s.removeFloor(bid, extra.id);
        d = s.interiorData[bid];
      }
      const f1 = d.floors[0];
      (f1.walls || []).slice().forEach(w => s.removeWall(bid, f1.id, w.id));
      (f1.doors || []).slice().forEach(o => s.removeDoor(bid, f1.id, o.id));
      (f1.windows || []).slice().forEach(o => s.removeWindow(bid, f1.id, o.id));
      // 层高按 300 排：一层 elevation 0，二层 300
      const W = 900, D = 650, T = 24, H = 280;
      const corners = [[0,0],[W,0],[W,D],[0,D]];
      const walls1 = [];
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) %% 4];
        walls1.push(s.addWall(bid, f1.id, {
          start: {x:a[0], y:a[1]}, end: {x:b[0], y:b[1]}, thickness: T, height: H,
          color: '#d9d2c2',
        }));
      }
      // 一道内隔墙（把大厅与房间分开）
      s.addWall(bid, f1.id, { start: {x:520,y:0}, end: {x:520,y:650}, thickness: 12, height: H, color: '#cfc7b8' });
      // 一层：门开在**朝向相机那面墙**（第 2 面，z = D），否则截图里看不见门；
      // 另两扇窗放在侧面（第 1 面，x = W），正立面留两扇窗
      s.addDoor(bid, f1.id, { wallId: walls1[2].id, position: 0.5, width: 100, height: 210 });
      s.addWindow(bid, f1.id, { wallId: walls1[2].id, position: 0.15, width: 150, height: 140, sillHeight: 90 });
      s.addWindow(bid, f1.id, { wallId: walls1[1].id, position: 0.35, width: 150, height: 140, sillHeight: 90 });
      s.addWindow(bid, f1.id, { wallId: walls1[1].id, position: 0.72, width: 150, height: 140, sillHeight: 90 });

      // 二层
      const f2 = s.addFloor(bid, '二层');
      if (f2) {
        if (f2.elevation !== 300) s.updateFloor(bid, f2.id, { elevation: 300 });
        for (let i = 0; i < 4; i++) {
          const a = corners[i], b = corners[(i + 1) %% 4];
          const w = s.addWall(bid, f2.id, {
            start: {x:a[0], y:a[1]}, end: {x:b[0], y:b[1]}, thickness: T, height: H,
            color: '#d9d2c2',
          });
          if (i === 0) s.addWindow(bid, f2.id, { wallId: w.id, position: 0.3, width: 140, height: 130, sillHeight: 90 });
          if (i === 1) s.addWindow(bid, f2.id, { wallId: w.id, position: 0.5, width: 140, height: 130, sillHeight: 90 });
          if (i === 2) s.addWindow(bid, f2.id, { wallId: w.id, position: 0.7, width: 140, height: 130, sillHeight: 90 });
        }
      }
      iv.editMode = false;
      d = s.interiorData[bid];
      return JSON.stringify({
        floors: d.floors.length,
        walls: d.floors.reduce((n, f) => n + (f.walls || []).length, 0),
        openings: d.floors.reduce((n, f) => n + (f.doors || []).length + (f.windows || []).length, 0),
        elevations: d.floors.map(f => f.elevation),
      });
    })()""" % (STORE, IV, json.dumps(bid)))


def drag(cdp, x0, y0, x1, y1, steps=12):
    cdp.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x0, 'y': y0, 'button': 'left', 'clickCount': 1})
    for i in range(1, steps + 1):
        x = x0 + (x1 - x0) * i / steps
        y = y0 + (y1 - y0) * i / steps
        cdp.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y, 'button': 'left'})
        time.sleep(0.02)
    cdp.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x1, 'y': y1, 'button': 'left', 'clickCount': 1})
    time.sleep(0.4)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    edge = None
    cdp = None
    fails = []
    mock_ready = False
    try:
        log('  · 注入回归 mock 数据…')
        RT.setup_mock()
        mock_ready = True
        ensure_vite(handles)
        log('  · 启动 Edge（GPU 软件光栅，允许 WebGL）…')
        edge = start_edge()
        handles.append(edge)
        cdp = CDP(ws_url=find_page_ws(PORT, prefer_prefix='http://localhost:5180'))
        cdp.send('Page.enable')
        cdp.send('Performance.enable')
        cdp.send('Emulation.setDeviceMetricsOverride', {
            'width': 1440, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False,
        })
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='应用挂载')
        # 首启引导层会**盖在截图正中间**（第一版三张图全被它挡了）。
        # 口径同 run_tests._boot_page：写掉首启标记再重载，别靠点"跳过"（时机不一定对）。
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层已退')
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
        cdp.eval("window.__exErrs = []; window.addEventListener('error', e => window.__exErrs.push(String(e.message || e))); 1")

        house = build_house(cdp, bid)
        log('  · 造楼：%s' % json.dumps(house, ensure_ascii=False))

        clicked = eval_json(cdp, """(() => {
          const b = Array.from(document.querySelectorAll('.interior-container .header-actions button'))
            .find(x => x.textContent.trim() === '外观');
          if (!b) return JSON.stringify({ err: 'no-button' });
          if (b.disabled) return JSON.stringify({ err: 'disabled', title: b.getAttribute('title') });
          b.click();
          return JSON.stringify({ ok: true });
        })()""")
        if clicked.get('err'):
            raise RuntimeError('外观按钮不可用：%s' % clicked)

        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-view]')", timeout=15, desc='外观浮层')
        got = wait_for(cdp, """(() => {
          const v = document.querySelector('[data-testid=exterior-view]');
          if (!v) return false;
          return !!v.querySelector('[data-testid=exterior-canvas]') || !!v.querySelector('[data-testid=exterior-fallback]');
        })()""", timeout=40, desc='3D 就绪')
        state = eval_json(cdp, """(() => {
          const v = document.querySelector('[data-testid=exterior-view]');
          return JSON.stringify({
            canvas: !!v.querySelector('[data-testid=exterior-canvas]'),
            fallback: !!v.querySelector('[data-testid=exterior-fallback]'),
            fallbackText: v.querySelector('[data-testid=exterior-fallback]') ? v.querySelector('[data-testid=exterior-fallback]').textContent.trim().slice(0, 120) : '',
            stats: (v.querySelector('[data-testid=exterior-stats]') || {}).textContent,
            errs: (window.__exErrs || []).slice(0, 5),
          });
        })()""")
        log('  · 3D 状态：%s' % json.dumps(state, ensure_ascii=False))

        if not state.get('canvas'):
            fails.append('这台机器没拿到 WebGL，出不了 3D 图：%s' % state.get('fallbackText'))
        else:
            time.sleep(1.5)
            RENDERS = ("(() => { const el = document.querySelector('[data-testid=exterior-view]');"
                       " const st = el && el.__vueParentComponent && el.__vueParentComponent.exposed;"
                       " return JSON.stringify(st ? st.getStats() : { err: 'no-exposed' }); })()")
            r0 = eval_json(cdp, RENDERS)
            cpu0 = page_task_seconds(cdp)
            time.sleep(4.0)
            r1 = eval_json(cdp, RENDERS)
            cpu1 = page_task_seconds(cdp)
            idle_frames = (r1.get('renders') or 0) - (r0.get('renders') or 0) if not r0.get('err') else None
            idle_cpu = round(cpu1 - cpu0, 3) if (cpu0 is not None and cpu1 is not None) else None
            log('  · 静止 4 秒：新增帧 %s / 页面 CPU %s 秒' % (idle_frames, idle_cpu))
            if idle_frames is None:
                fails.append('拿不到渲染帧计数：%s' % r0)
            elif idle_frames > 2:
                fails.append('静止时还在空转：4 秒画了 %d 帧（按需渲染失效）' % idle_frames)
            if idle_cpu is not None and idle_cpu > 1.0:
                fails.append('静止 4 秒仍烧掉 %.2f 秒 CPU' % idle_cpu)

            p1, s1 = shot(cdp, '01-gable-default')
            log('  · %s  %s' % (os.path.basename(p1), s1))

            # 转个低角度看侧面（拖拽画布：向右上拖 = 环绕）
            before_drag = (eval_json(cdp, RENDERS).get('renders') or 0)
            drag(cdp, 720, 520, 980, 620)
            time.sleep(0.8)
            after_drag = (eval_json(cdp, RENDERS).get('renders') or 0)
            if after_drag <= before_drag:
                fails.append('拖拽时没出新帧（%s → %s）' % (before_drag, after_drag))
            else:
                log('  · 拖拽期间新增帧 %s' % (after_drag - before_drag))
            p2, s2 = shot(cdp, '02-gable-low-angle')
            log('  · %s  %s' % (os.path.basename(p2), s2))

            # 切平顶
            eval_json(cdp, """(() => {
              const sel = document.querySelector('[data-testid=exterior-roof-kind]');
              if (!sel) return JSON.stringify({ err: 'no-select' });
              sel.value = 'flat';
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              return JSON.stringify({ ok: true });
            })()""")
            time.sleep(1.0)
            p3, s3 = shot(cdp, '03-flat')
            log('  · %s  %s' % (os.path.basename(p3), s3))

            for name, st in (('01', s1), ('02', s2), ('03', s3)):
                if not st.get('ok'):
                    fails.append('%s 不是有效 PNG：%s' % (name, st))
                elif st.get('variance') is not None and st['variance'] < 20:
                    fails.append('%s 几乎纯色（variance=%s）—— 白屏/黑屏' % (name, st['variance']))

            # 统计与数据对得上（2 层 / 8 面墙 / 7 处门窗）
            stats = state.get('stats') or ''
            # 9 = 一层 4 面外墙 + 1 道内隔墙 + 二层 4 面外墙
            if '2 层' not in stats or '9 面墙' not in stats or '7 处门窗' not in stats:
                fails.append('顶栏统计不对：%r（期望 2 层 / 9 面墙 / 7 处门窗）' % stats)

            # 坡顶/平顶切换后画面必须变（不是没生效）
            if s1.get('mean') == s3.get('mean') and s1.get('variance') == s3.get('variance'):
                fails.append('切平顶后画面没变（截图统计完全相同）')

        errs = state.get('errs') or []
        if errs:
            fails.append('页面报错：%s' % errs)

        # 验收：切走再切回，外观仍能开（不留残壳）
        cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1")
        time.sleep(0.6)
        reopened = eval_json(cdp, """(() => {
          const b = Array.from(document.querySelectorAll('.interior-container .header-actions button'))
            .find(x => x.textContent.trim() === '外观');
          if (!b) return JSON.stringify({ err: 'no-button' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""")
        time.sleep(2.0)
        again = eval_json(cdp, """(() => JSON.stringify({
          views: document.querySelectorAll('[data-testid=exterior-view]').length,
        }))()""")
        if reopened.get('err') or again.get('views') != 1:
            fails.append('二次打开异常：%s / %s' % (reopened, again))

        if fails:
            log('\n❌ 失败：')
            for f in fails:
                log('  - %s' % f)
            return 1
        log('\n✅ 外观 3D 出图成功：%s' % OUT_DIR)
        log('   静止 4 秒：新增帧 %s、页面 CPU %s 秒（按需渲染：不转就不画）'
            % (locals().get('idle_frames'), locals().get('idle_cpu')))
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
                RT.teardown_mock()
            except Exception as e:
                log('  ⚠️ mock 收尾失败（请手工还原 index.html）：%s' % e)


if __name__ == '__main__':
    sys.exit(main())
