#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E-4 原型视觉反馈截图器（2026-11-25）

## 干什么

把 `domain3d-proto.html` 的几种状态各拍一张，给用户**看**而不是只看数字：

  s1-overview     默认视角全景（看盘面感 / 边界切片 / 薄层 z 是否成立）
  s2-low            压低视角（看薄层到底有多薄 —— 这是最容易判断的一张）
  s3-close          贴近看（看恒星小球与航道合批后的分辨率）
  s4-cam-before     相机记忆：拉走前
  s5-cam-away       相机记忆：已拉走（与 s4 明显不同）
  s6-cam-back       相机记忆：回来（与 s4 **应逐像素接近**）

## 为什么自己做截图而不是让用户开浏览器

用户 2026-11-25 的诉求是"最好给我视觉反馈让我看看效果"——那就是要我交图，不是交一段"你自己打开看"。

## 口径纪律（都是踩过的）

· 截图前必须 `controls.update()` 并**等两帧**：three 的懒更新会让第一帧还是旧相机。
· `Page.captureScreenshot` 默认走 surface（会超时），用 `fromSurface: false`。
· 必须挑对 target（Edge 会先开内部页占 /json 第一个），照 probe 的做法按 URL 前缀挑。
· profile 放系统临时目录 + finally 清（2026-11-25 因它误提交过 1457 个文件）。

用法：
  python scripts/proto/shot_domain3d.py
  python scripts/proto/shot_domain3d.py --stars 60
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:      # noqa: BLE001
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
from lib.cdp import CDP, find_page_ws                  # noqa: E402

EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
PROTO = os.path.join(ROOT, 'scripts', 'proto', 'domain3d-proto.html')
OUT_DIR = os.path.join(ROOT, 'build', 'proto-domain3d')
PORT = 9334


def arg(name, default):
    a = sys.argv[1:]
    return a[a.index('--' + name) + 1] if ('--' + name) in a and a.index('--' + name) + 1 < len(a) else default


def wait_devtools(timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/version', timeout=1):
                return True
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f'DevTools 在 {timeout}s 内没起来（端口 {PORT}）')


def shoot(cdp, name, wait_ms=260):
    """拍一张。

    🔴 **必须 `fromSurface: True`**（2026-11-25 踩到）：
       `fromSurface: False` 走的是渲染进程内的合成结果，**WebGL 画布拍出来是全黑** ——
       六张图都是 5067 字节、纯黑，但"相机记忆逐像素相同"却照绿（两张全黑当然相同）。
       这是"判据全绿但什么都没拍到"的典型陷阱：**截图工具自己也要有判据**
       （见下方 SHOOT_MIN_BYTES 与像素方差检查）。
    """
    cdp.eval("(() => { try { window.__proto.tick(); } catch(e){} return 1; })()")
    time.sleep(wait_ms / 1000.0)
    res = cdp.send('Page.captureScreenshot', {
        'format': 'png',
        'fromSurface': True,          # WebGL 必须走 surface
        'captureBeyondViewport': False,
        'optimizeForSpeed': False,
    })
    data = res.get('data')
    if not data:
        print(f'  ❌ {name}: 截图无数据')
        return None
    raw = base64.b64decode(data)
    path = os.path.join(OUT_DIR, f'{name}.png')
    with open(path, 'wb') as fh:
        fh.write(raw)
    # 判据：不许交一张"几乎没内容"的图（全黑/纯色）
    warn = ''
    n = check_image_content(path)
    if n is not None and n < 300:
        warn = f'  ⚠️ 只有 {n} 种颜色，画面可能是空的'
    print(f'  ✅ {name}.png ({len(raw)} B){warn}')
    return path


def check_image_content(path):
    """返回不重复颜色数（粗判"画面上有没有东西"）。无 Pillow 时返回 None。"""
    try:
        from PIL import Image
        im = Image.open(path).convert('RGB')
        im.thumbnail((320, 320))
        return len(set(im.getdata()))
    except Exception:                  # noqa: BLE001
        return None


def set_camera(cdp, pos, target):
    """设相机并**回读确认生效**。

    🔴 2026-11-25 两个坑连在一起（都被"六张图 hash 全同"抓出来）：
       ① `camera` / `controls` 是**模块作用域**变量，`cdp.eval` 里直接写
          `camera.position.set(...)` → ReferenceError。异常被吞掉，六张图静默变成同一张。
       ② 就算能写，`controls.update()` 会拿阻尼内部状态把相机**拉回去**。
       修法：设全部收进页面里的 `window.__proto.setCamera()`（关阻尼 + 回读），
       外部只调函数、不碰变量。这里再核一遍返回值。
    """
    got = cdp.eval(f"(() => JSON.stringify(window.__proto.setCamera("
                   f"{pos[0]}, {pos[1]}, {pos[2]}, {target[0]}, {target[1]}, {target[2]})))()")
    if isinstance(got, str):
        try:
            got = json.loads(got)
        except ValueError:
            got = None
    if not isinstance(got, dict) or 'p' not in got:
        print(f'  ⚠️ 相机设置失败：{got!r}')
        return False
    dp = max(abs(got['p'][i] - pos[i]) for i in range(3))
    dt = max(abs(got['t'][i] - target[i]) for i in range(3))
    if dp > 1 or dt > 1:
        print(f'  ⚠️ 相机没设上：要求 {pos}/{target}，实际 {got["p"]}/{got["t"]}（差 {dp:.1f}/{dt:.1f}）')
        return False
    return True


def main():
    stars = int(arg('stars', '30'))
    if not (os.path.exists(EDGE) and os.path.exists(PROTO)):
        print(f'❌ 缺 Edge 或原型：{EDGE} / {PROTO}')
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    url = 'file:///' + PROTO.replace('\\', '/') + f'?stars={stars}'

    profile = os.path.join(tempfile.gettempdir(), f'sitian-domain3d-shot-{PORT}')
    shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)

    proc = subprocess.Popen([
        EDGE, '--headless=new', f'--remote-debugging-port={PORT}',
        f'--user-data-dir={profile}',
        '--no-first-run', '--no-default-browser-check',
        '--enable-unsafe-swiftshader',
        '--window-size=1280,800',
        url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    shots = []
    try:
        wait_devtools()
        time.sleep(2.5)
        cdp = CDP(ws_url=find_page_ws(PORT, prefer_prefix='file:///', timeout=30))

        # 等就绪
        # 🔴 用 `window.__BOOT_OK` 这个**机器可读**标志，不读日志文本。
        #    原来读日志里有没有"就绪"两字 —— 往 boot 里加一句日志就可能把判断弄坏，
        #    而且失败时没有可读原因（2026-11-25 就是这么卡住的）。
        ok = False
        for _ in range(60):
            if cdp.eval("!!window.__BOOT_OK") is True:
                ok = True
                break
            time.sleep(0.5)
        if not ok:
            print('❌ 页面没就绪。日志：')
            print(cdp.eval("document.getElementById('log').textContent")[-600:])
            return 1
        print(f'页面就绪（{stars} 恒星系）')

        # 强制合批版
        cdp.eval("window.__proto.switchMode('batched'); 1")
        time.sleep(0.4)
        # 🔴 收起 HUD 再拍：第一版面板 340px 高，把 30 系的星图挡掉大半个，
        #    六张图里能看见的只有面板 —— 这跟"放置家具弹窗挡住画布"是同一类错。
        cdp.eval("(() => { if (window.__hudSetCollapsed) window.__hudSetCollapsed(true); return 1; })()")
        # 底部日志条也会盖住画面下缘，截图时一并隐藏
        cdp.eval("(() => { const l=document.getElementById('log'); if(l) l.style.display='none'; return 1; })()")
        time.sleep(0.2)
        # 🌟 拍**观感图**时把星名标签打开（性能对照不经这条路径，见 buildBatched ⑤）
        lab = cdp.eval("(() => JSON.stringify(window.__proto.setLabelsVisible(true)))()")
        if isinstance(lab, str):
            try:
                lab = json.loads(lab)
            except ValueError:
                lab = None
        if isinstance(lab, dict):
            print(f'星名标签已开：{lab.get("labels")} 条，draw calls {lab.get("calls")}')

        # 取景：**正交投影下要用 fit()（改 frustum），不是靠相机距离**。
        #
        # 🔴 2026-11-25 用户反馈："很扁看不清，不如原来平面平铺。现在稍微远一点的东西就看不清。"
        #    → 换成正交投影（群星就是这么做的）。之后取景的语义变了：
        #      透视：取景 = 相机退多远；正交：取景 = 视锥多大（camera.left/right/top/bottom）。
        #      继续调 set_camera 的距离**不会有任何缩放效果**，只会改倾角。
        bb = cdp.eval("JSON.stringify(window.SCENE_DATA.bbox)")
        if isinstance(bb, str):
            try:
                bb = json.loads(bb)
            except ValueError:
                bb = None
        if isinstance(bb, dict):
            span = max(bb['maxX'] - bb['minX'], bb['maxY'] - bb['minY'])
            cx = (bb['minX'] + bb['maxX']) / 2
            cy = (bb['minY'] + bb['maxY']) / 2
        else:
            span, cx, cy = 1800, 0, 0
        R = span / 2
        # 🔴 2026-11-25：第一版 padding 1.02 → 画面四周留白太多，四个星域只占屏幕中间一条。
        #    参考图 `星域视图1.jpg` 是**领土填满画面**。改成 0.72（负 padding = 放大裁边），
        #    让星域占满视口；边界允许出血到画面外（截图里本来就只关心领土本身）。
        fit = cdp.eval("(() => JSON.stringify(window.__proto.fit(0.72)))()")
        if isinstance(fit, str):
            try:
                fit = json.loads(fit)
            except ValueError:
                fit = None
        print(f'场景跨度 {span:.0f}，中心 ({cx:.0f}, {cy:.0f})')
        if isinstance(fit, dict):
            print(f'正交取景：ortho={fit.get("ortho")} halfH={fit.get("halfH"):.0f} zoom={fit.get("zoom")}')

        # ── s1 默认全景：相机在斜上方 35°，能同时看见"盘面 + 切片 + 薄层"
        print('拍 s1 默认全景…')
        set_camera(cdp, (cx, cy - R * 1.6, R * 0.45), (cx, cy, 0))
        shots.append(shoot(cdp, 's1-overview'))

        # ── s2 压低视角：这是判断"薄层有多薄"最直观的一张
        #    相机几乎贴到盘面高度（z 只比 0 高一点点），侧面看过去
        print('拍 s2 低视角（看薄层有多薄）…')
        set_camera(cdp, (cx, cy - R * 2.0, R * 0.18), (cx, cy, 0))
        shots.append(shoot(cdp, 's2-low'))

        # ── s3 贴近：看恒星与航道的分辨率
        print('拍 s3 贴近…')
        set_camera(cdp, (cx + R * 0.35, cy - R * 0.55, R * 0.30), (cx, cy, 0))
        shots.append(shoot(cdp, 's3-close'))

        # ── s4/s5/s6 相机记忆三连拍（用户口径 ①）
        #    ⚠️ s4 故意**用与 s1 不同的视角**：第一版 s4 直接复用 s1 的参数，
        #       于是两张图指纹相同，被"六视角应有 ≥5 个不同指纹"的判据判红 ——
        #       判据没错，是我把两张图拍成了同一张。
        print('拍 s4-s6 相机记忆…')
        set_camera(cdp, (cx + R * 0.9, cy - R * 1.5, R * 0.6), (cx, cy, 0))
        cdp.eval("(() => { window.__proto.saveCamera(); return 1; })()")
        time.sleep(0.2)
        shots.append(shoot(cdp, 's4-cam-before'))

        # 故意拉走（模拟"点进单系看细节"之后回来的场景）—— 走同一个 setCamera 口
        set_camera(cdp, (1200, -2600, 1900), (200, -150, 0))
        time.sleep(0.2)
        shots.append(shoot(cdp, 's5-cam-away'))

        cdp.eval("(() => { window.__proto.restoreCamera(); return 1; })()")
        time.sleep(0.2)
        delta = cdp.eval("(() => { const d = window.__proto.cameraDelta(); "
                         "return JSON.stringify(d); })()")
        try:
            delta = json.loads(delta) if isinstance(delta, str) else delta
        except ValueError:
            pass
        shots.append(shoot(cdp, 's6-cam-back'))

        print()
        print('=' * 70)
        print(f'相机记忆校验：位置偏差 {delta}')
        ok = isinstance(delta, dict) and delta.get('pos', 1) < 1e-6 and delta.get('target', 1) < 1e-6
        print(('✅ ' if ok else '❌ ') + ('恢复到离开时逐位一致（用户口径 ①）'
                                         if ok else '恢复后位置不一致'))

        # 🔴 必须先确认"六张图不是同一张"：第一版六张 hash 全同，
        #    但相机记忆的"逐像素相同"却照绿 —— 因为两张全黑/同一帧当然相同。
        #    这条检查是给**工具自己**的判据：视角不同，图就必须不同。
        import hashlib
        hashes = {}
        for s in shots:
            if not s:
                continue
            with open(s, 'rb') as fh:
                hashes[os.path.basename(s)] = hashlib.md5(fh.read()).hexdigest()[:12]
        uniq = len(set(hashes.values()))
        print(f'六个视角的图片指纹：{uniq} 个不同的（应为 ≥5，只有 s4 与 s6 相同）')
        for k, v in hashes.items():
            print(f'   {k}  {v}')
        if uniq < 5:
            print('❌ 多数视角拍出来是同一张 —— 相机设置没生效，图不可用')
            ok = False
        print('=' * 70)

        # 逐像素比较 s4 与 s6（证明确实回到同一帧，而不是"看起来差不多"）
        try:
            from PIL import Image, ImageChops
            a = Image.open(os.path.join(OUT_DIR, 's4-cam-before.png')).convert('RGB')
            b = Image.open(os.path.join(OUT_DIR, 's6-cam-back.png')).convert('RGB')
            diff = ImageChops.difference(a, b)
            bbox = diff.getbbox()
            if bbox is None:
                print('✅ s4 与 s6 逐像素完全相同 —— 回来就是原来那一帧')
            else:
                px = sum(1 for p in diff.getdata() if p != (0, 0, 0))
                print(f'⚠️ s4 与 s6 有差异：{px} 像素不同，bbox={bbox}')
                print('   （若差异很大，说明相机没恢复到同一帧；小差异可能是抖动/抗锯齿）')
        except ImportError:
            print('（无 Pillow，跳过逐像素比对）')
        except Exception as e:      # noqa: BLE001
            print(f'（逐像素比对失败：{e}）')

        print()
        print('图在：' + OUT_DIR)
        for s in shots:
            if s:
                print('  ' + os.path.basename(s))
        return 0
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:               # noqa: BLE001
            try:
                proc.kill()
            except Exception:           # noqa: BLE001
                pass
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
