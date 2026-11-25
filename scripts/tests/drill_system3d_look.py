#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单星系 3D 观景：现状截图 + **大气/日冕的机检判据**（2026-11-25）

## 为什么要有它

用户 2026-11-25 定论："这版非常丑，不如纯 2D 平面（司天现状）"——
说的是**星域级 3D 原型**。同时明确："**单星系内部本来就是我要的**"。

所以在动 `System3DView` 之前，先拍一张**它现在长什么样**。
上一轮的教训：做了一堆原型却从没和现状比过，结果做出来的不如现状。**这次先拍，再改。**

2026-11-25 第二轮（用户："继续做。顺便很多行星根本没有大气"）起，它不只是拍照了：
**它是一条真判据** —— 大气边缘光只能用"画出来的像素"验证，单测只能验参数表。

## 四条判据

| # | 判据 | 口径 |
|---|---|---|
| A | 每颗行星都有大气壳层 | `stats.atmospheres == stats.planets > 0` |
| B | 行星轮廓**外**一圈真的亮起来了 | 聚焦一颗行星，环带 1.06R~1.18R 的平均亮度 − 关掉大气后同一环带 > 6 |
| C | **反向探针**：只改轮廓外那一圈 | 开着/关掉两张逐像素比：明显变化（≥8）的像素 ≥90% 落在 0.95R~1.35R，且 1.6R 以外**一个像素都不许变** |
| D | 恒星有日冕光针（不是一团对称的雾） | 1.3R~2.2R 环带的**角向变异系数** ≥ 0.10，且 ≥ 2.5× 同一张图上 6R~8R 背景环的变异系数 |

B/C 是 A/B 对照：两次截图**只差大气这一项**（先按 P 暂停，行星与日冕都不动），
所以背景里有什么（星云、星点、藏在行星旁边的恒星强光晕）都被抵消掉了 ——
C 特意不再用"关掉后 ≈ 远处背景"那种口径：行星脚边可能正好是恒星的强光晕，
两处背景亮度差几倍，那样会假红（2026-11-25 踩过）。

## 怎么进

走**产品自己的入口**（与 `test_163_system_3d.py` 同一条路）：
  ① mock 数据 → ② Vite → ③ Edge headless → ④ `store.enterSystemDetail(system)`
  → ⑤ 点 `[data-testid=system-3d-open]` → ⑥ 截图 / 采样

## 口径（都是踩过的）

· `Page.captureScreenshot` 必须 `fromSurface: True`：WebGL 画布用 `False` 会拍成全黑。
· 截图前要**主动踢一帧**（组件 `exposed.tick()`）：headless 下 rAF 可能挂住，
  场景换了但画面没刷 → 两张图 0 像素差，看起来像"3D 没生效"。
· 采样坐标用组件自己投出来的 `bodyScreenRect` / `starScreenRect`（含画布偏移与 DPR），
  不要在 Python 里猜行星在哪 —— 镜头每次都不一样。
· 等 three 动态下载完（`wait_for` 画布出现 + 2.8s）。

用法：
  python scripts/tests/drill_system3d_look.py
产物：build/system3d/*.png + build/system3d/report.json
退出码：0 = 四条全过；1 = 有判据红；2 = 环境/Pillow 没起来（不是产品结论）
"""
import base64
import json
import math
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:      # noqa: BLE001
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

import run_tests as rt                                        # noqa: E402
from lib.cdp import CDP, wait_for, eval_json                  # noqa: E402
from lib.helpers import ensure_data_ready                     # noqa: E402

OUT_DIR = os.path.join(ROOT, 'build', 'system3d')
ROOT_SEL = '[data-testid="system-3d"]'
CANVAS_SEL = '[data-testid="system-3d-canvas"]'
OPEN_SEL = '[data-testid="system-3d-open"]'

# 判据阈值（2026-11-25 量出来的，不是拍的数：见 report.json 里的实测值）
HALO_GAIN_MIN = 6.0      # B：开着大气 vs 关掉，同一环带至少要亮这么多（0~255 灰度）
HALO_OFF_MAX = 0        # C：反向探针只许改轮廓外那一圈 —— 1.6R 以外必须一个像素都不变（max diff == 0）
CORONA_CV_MIN = 0.35     # D：日冕净贡献的角向变异系数下限（光针 → 明暗差得开）
CORONA_MEAN_MIN = 1.5    # D：日冕净增量均值下限（0~255 灰度；"有日冕"的最低证物）


def _s3d(js_body):
    """把一段 JS 包成"取 3D 组件实例"的表达式（统一入口，别处不要各写一份）。"""
    return """(() => {
      const el = document.querySelector('%s');
      const inst = el && el.__vueParentComponent;
      const ex = (inst && inst.exposed) || {};
      const st = (inst && inst.setupState) || {};
      %s
    })()""" % (ROOT_SEL, js_body)


def jget(cdp, expr, desc=''):
    """eval_json 的薄封装：**永远返回 dict**（异常时返回 {'fails': [...]}）。

    ⚠️ `eval_json` 的签名是 (ok, obj) 二元组，不是 dict ——
       第一版直接 `.get()` 会 AttributeError: 'tuple' object has no attribute 'get'。
       这里统一成 dict，调用方不用每次拆包。
    """
    ok, obj = eval_json(cdp, expr, desc=desc)
    if not ok:
        return {'fails': [str(obj)], '_raw': obj}
    return obj if isinstance(obj, dict) else {'fails': [f'返回的不是对象：{obj!r}']}


def shoot(cdp, name, wait_ms=420):
    """拍一张（fromSurface 必须 True，否则 WebGL 全黑）。"""
    # 主动踢一帧：headless 下 rAF 可能挂住不触发
    cdp.eval(_s3d("""
      try { if (typeof ex.tick === 'function') ex.tick(); } catch (e) {}
      return 1;
    """))
    time.sleep(wait_ms / 1000.0)
    res = cdp.send('Page.captureScreenshot', {
        'format': 'png', 'fromSurface': True, 'captureBeyondViewport': False,
    })
    data = res.get('data')
    if not data:
        print(f'  ❌ {name}: 无数据')
        return None
    path = os.path.join(OUT_DIR, f'{name}.png')
    with open(path, 'wb') as fh:
        fh.write(base64.b64decode(data))
    print(f'  ✅ {name}.png ({os.path.getsize(path)} B)')
    return path


# ══════════════════════════════════════════════════════════════════════════
# 像素采样（PIL）
# ══════════════════════════════════════════════════════════════════════════

def _lum(px):
    return 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]


def mean_ring(img, cx, cy, r_in, r_out, n_ang=180, n_rad=6):
    """(cx,cy) 周围 [r_in, r_out] 环带的平均亮度（0~255）。

    ⚠️ 采样点是**像素中心**整数坐标，不做插值：环带里有一两千个点，平均下来够了。
    """
    w, h = img.size
    tot = 0.0
    n = 0
    for i in range(n_ang):
        a = (i / n_ang) * math.tau
        ca, sa = math.cos(a), math.sin(a)
        for j in range(n_rad):
            r = r_in + (r_out - r_in) * (j / max(1, n_rad - 1))
            x = int(round(cx + ca * r))
            y = int(round(cy + sa * r))
            if 0 <= x < w and 0 <= y < h:
                tot += _lum(img.getpixel((x, y)))
                n += 1
    return tot / max(1, n)


def ring_cv(img, cx, cy, r_in, r_out, n_ang=180, n_rad=4):
    """环带亮度的**角向变异系数**（标准差/均值）。

    为什么用它可以判"有没有光针"：一团径向对称的光晕（径向渐变）在这个环上
    每度亮度几乎一样 → CV 很小；日冕那 26 根光针一转，环上就是明显的明暗相间 → CV 大。
    """
    w, h = img.size
    means = []
    for i in range(n_ang):
        a = (i / n_ang) * math.tau
        ca, sa = math.cos(a), math.sin(a)
        tot, n = 0.0, 0
        for j in range(n_rad):
            r = r_in + (r_out - r_in) * (j / max(1, n_rad - 1))
            x = int(round(cx + ca * r))
            y = int(round(cy + sa * r))
            if 0 <= x < w and 0 <= y < h:
                tot += _lum(img.getpixel((x, y)))
                n += 1
        if n:
            means.append(tot / n)
    if not means:
        return 0.0
    m = sum(means) / len(means)
    if m <= 0.5:
        return 0.0
    var = sum((v - m) ** 2 for v in means) / len(means)
    return math.sqrt(var) / m


def diff_localization(img_a, img_b, cx, cy, r, box_mul=2.0, hot=8.0):
    """两张图（只差一个开关）的差异**落在哪里**。

    判据 C 的口径：反向探针只许改动行星轮廓外那一圈，
      · 轮廓外 1.6R 以外（同一块裁切里）**一个像素都不许变**（max diff == 0）；
      · 明显变化（≥ hot）的像素要 ≥ 90% 落在 0.95R~1.35R 的环带里。

    为什么不用"关掉后环带 ≈ 远处背景"：行星旁边可能正好是恒星的强光晕，
    远处背景环的亮度跟行星脚边的背景差着好几倍 —— 那个口径会假红（2026-11-25 踩过）。

    ⚠️ 裁切盒只能取 **2R**：取 3R 时画面里另一颗行星（当时在 2.24R 处）也在盒子里，
    而 `setAtmosphereScale(0)` 关的是**所有**行星的气 —— 它会合法地变，判据就成了假红。
    """
    left = max(0, int(cx - r * box_mul))
    top = max(0, int(cy - r * box_mul))
    right = min(img_a.size[0], int(cx + r * box_mul))
    bottom = min(img_a.size[1], int(cy + r * box_mul))
    a = img_a.crop((left, top, right, bottom)).convert('RGB')
    b = img_b.crop((left, top, right, bottom)).convert('RGB')
    pa, pb = list(a.getdata()), list(b.getdata())
    W = right - left
    H = bottom - top
    n_hot = 0
    n_hot_rim = 0
    max_out = 0.0
    for idx in range(W * H):
        x0 = idx % W
        y0 = idx // W
        dist = math.hypot(left + x0 - cx, top + y0 - cy) / max(1e-6, r)
        # ⚠️ 只统计**半径 2R 以内**：裁切是方的，四个角伸到 2.83R ——
        #    另一颗行星的运动会从那几个角漏进来（2026-11-25 就是这么假红的）。
        if dist > 2.0:
            continue
        d = max(abs(pa[idx][0] - pb[idx][0]),
                abs(pa[idx][1] - pb[idx][1]),
                abs(pa[idx][2] - pb[idx][2]))
        if dist > 1.6:
            max_out = max(max_out, d)
        if d >= hot:
            n_hot += 1
            if 0.95 <= dist <= 1.35:
                n_hot_rim += 1
    return {
        'hot': n_hot,
        'hot_in_rim': n_hot_rim,
        'rim_fraction': (n_hot_rim / n_hot) if n_hot else 0.0,
        'max_diff_outside': max_out,
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    try:
        from PIL import Image, ImageChops
    except Exception as e:      # noqa: BLE001
        print(f'❌ 没有 Pillow（{e}）：像素判据跑不了。用系统 Python（python scripts/tests/drill_system3d_look.py）')
        return 2

    handles = []
    report = {'checks': [], 'shots': []}
    try:
        print('1/6 注入 mock 数据…')
        rt.setup_mock()

        print('2/6 启动 Vite…')
        rt.free_port(rt.DEV_PORT)
        dev = rt.subprocess.Popen(
            ['cmd', '/c', 'npm', 'run', 'dev'] if os.name == 'nt' else ['npm', 'run', 'dev'],
            cwd=rt.ROOT, stdout=rt.subprocess.DEVNULL, stderr=rt.subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT):
            print('❌ Vite 起不来（端口被占？见 run_tests.py 的提示）')
            return 2

        print('3/6 启动 Edge headless…')
        rt._launch_edge(handles)

        print('4/6 进单星系 3D…')
        cdp = CDP()
        rt._boot_page(cdp)
        ensure_data_ready(cdp)
        time.sleep(0.8)

        # 找一个有行星的恒星系，走产品自己的 enterSystemDetail
        info = jget(cdp, """(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const planets = s.nodes.filter((n) => n.layer === 'planet');
          const host = planets[0];
          if (!host) return JSON.stringify({ fails: ['没有行星节点'] });
          const system = s.nodes.find((n) => n.id === host.parentId);
          if (!system) return JSON.stringify({ fails: ['行星没有父恒星系'] });
          s.enterSystemDetail(system);
          return JSON.stringify({
            fails: [],
            system: system.name,
            planets: planets.filter((p) => p.parentId === system.id).length,
            level: s.viewLevel,
          });
        })()""", desc='进单系详情')
        if info.get('fails'):
            print(f'  ❌ {info["fails"]}')
            return 1
        print(f'   恒星系 {info.get("system")}（{info.get("planets")} 颗行星）· '
              f'viewLevel={info.get("level")}')
        time.sleep(1.2)

        opened = jget(cdp, """(() => {
          const b = document.querySelector('%s');
          if (!b) return JSON.stringify({ fails: ['找不到 3D 观景按钮'] });
          if (b.disabled) return JSON.stringify({ fails: ['按钮被禁用：' + (b.title||'')] });
          b.click();
          return JSON.stringify({ fails: [] });
        })()""" % OPEN_SEL, desc='点 3D 观景')
        if opened.get('fails'):
            print(f'  ❌ {opened["fails"]}')
            return 1

        wait_for(cdp, f"!!document.querySelector('{CANVAS_SEL}')", timeout=30, desc='3D 画布出现')
        time.sleep(2.8)   # 等 three 下载 + 首帧 + 行星公转稳定

        print('5/6 截图 + 采样…')
        shots = [shoot(cdp, 'system3d-current')]

        # 🔴 恒星的屏幕位置**必须在全景机位就读**：后面 focusBody/zoomTo 动过相机，
        #    再读到的 rect 与 system3d-current.png 对不上（第一版就是这么错的）。
        srect = jget(cdp, _s3d("""
          const r = ex.starScreenRect();
          return JSON.stringify({ fails: [], rect: r });
        """), desc='取恒星屏幕rect').get('rect')

        # ── 判据 D 的对照张：同一机位把日冕关掉再拍一张（A/B，不是跟远处背景比）──
        cdp.eval(_s3d("try { ex.setCoronaScale(0); } catch (e) {}\nreturn 1;"))
        shots.append(shoot(cdp, 'system3d-current-nocorona'))
        cdp.eval(_s3d("try { ex.setCoronaScale(1); } catch (e) {}\nreturn 1;"))
        time.sleep(0.3)

        # ── 判据 A：每颗行星都有大气壳层 ───────────────────────────────
        st = jget(cdp, _s3d("""
          const fn = ex.getStats || st.getStats;
          return JSON.stringify({ fails: [], stats: typeof fn === 'function' ? fn() : null });
        """), desc='读数')
        stats = st.get('stats') or {}
        atmo_n = stats.get('atmospheres')
        planet_n = stats.get('planets')
        ok_a = bool(atmo_n and planet_n and atmo_n == planet_n)
        report['checks'].append({
            'id': 'A', 'ok': ok_a,
            'detail': f"atmospheres={atmo_n} planets={planet_n}",
        })
        print(f"   A 每颗行星都有大气：atmospheres={atmo_n} planets={planet_n} → {'✅' if ok_a else '❌'}")

        # ── 近景：拉近一档再拍（**必须在 focusBody 之前**：focusBody 会把相机拉到
        #     minDistance=4，之后再 zoomTo 会被夹回同一个距离 → 两张图字节相同）。
        cdp.eval(_s3d("try { ex.zoomTo(2.2); } catch (e) {}\nreturn 1;"))
        time.sleep(0.8)
        shots.append(shoot(cdp, 'system3d-close'))
        cdp.eval(_s3d("try { ex.zoomTo(1 / 2.2); } catch (e) {}\nreturn 1;"))
        time.sleep(0.4)

        # ── 暂停公转（行星与日冕一起停，A/B 两张图只差大气这一项）──────
        cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', {code:'KeyP', key:'p', bubbles:true}))")
        time.sleep(0.4)

        # ── 聚焦第一颗行星 ────────────────────────────────────────────
        focus = jget(cdp, _s3d("""
          const bodies = (typeof ex.listBodies === 'function') ? ex.listBodies() : [];
          const body = bodies.find((b) => b.kind === 'planet');
          if (!body) return JSON.stringify({ fails: ['没有可聚焦的行星'] });
          const ok = ex.focusBody(body.id, 3.2);
          if (!ok) return JSON.stringify({ fails: ['focusBody 失败'] });
          const rect = ex.bodyScreenRect(body.id);
          return JSON.stringify({ fails: [], id: body.id, name: body.name, rect });
        """), desc='聚焦行星')
        if focus.get('fails'):
            print(f'  ❌ 聚焦失败：{focus["fails"]}')
            return 1
        print(f"   聚焦：{focus.get('name')} rect={focus.get('rect')}")
        time.sleep(0.6)
        shots.append(shoot(cdp, 'system3d-planet'))

        # 采样几何（开着大气那一张）
        rect_on = jget(cdp, _s3d("""
          const r = ex.bodyScreenRect('%s');
          return JSON.stringify({ fails: [], rect: r });
        """ % focus.get('id')), desc='取行星屏幕rect').get('rect')
        if not rect_on or not rect_on.get('pageR'):
            print('  ❌ 拿不到行星屏幕位置（bodyScreenRect 没返回）')
            return 1
        print(f"   采样几何（拍完那一帧）：cx={rect_on['pageCx']:.1f} cy={rect_on['pageCy']:.1f} "
              f"r={rect_on['pageR']:.1f}")

        # ── 反向探针：关掉大气，同一机位再拍 ──────────────────────────
        scaled = jget(cdp, _s3d("""
          const v = ex.setAtmosphereScale(0);
          return JSON.stringify({ fails: [], scale: v });
        """), desc='关掉大气')
        print(f"   反向探针：setAtmosphereScale(0) → {scaled.get('scale')}")
        time.sleep(0.5)
        shots.append(shoot(cdp, 'system3d-planet-off'))

        # 近景（拉近看整体：恒星日冕 / 轨道线 / 行星）—— 上面已经拍过，这里只恢复大气
        cdp.eval(_s3d("try { ex.setAtmosphereScale(1); } catch (e) {}\nreturn 1;"))
        time.sleep(0.3)

        # ── 判据 B/C：像素环带 + 差异定位 ────────────────────────────
        img_on = Image.open(os.path.join(OUT_DIR, 'system3d-planet.png')).convert('RGB')
        img_off = Image.open(os.path.join(OUT_DIR, 'system3d-planet-off.png')).convert('RGB')
        cx, cy, r = rect_on['pageCx'], rect_on['pageCy'], rect_on['pageR']
        # 环带：紧贴轮廓外（大气壳层 1.25R，光晕在 1.06~1.18 最明显）
        halo_on = mean_ring(img_on, cx, cy, r * 1.06, r * 1.18)
        halo_off = mean_ring(img_off, cx, cy, r * 1.06, r * 1.18)
        gain = halo_on - halo_off
        ok_b = gain >= HALO_GAIN_MIN
        loc = diff_localization(img_on, img_off, cx, cy, r)
        ok_c = (loc['hot'] > 0 and loc['rim_fraction'] >= 0.90
                and loc['max_diff_outside'] <= HALO_OFF_MAX)
        report['checks'].append({
            'id': 'B', 'ok': ok_b,
            'detail': f'halo_on={halo_on:.2f} halo_off={halo_off:.2f} gain={gain:.2f} (>= {HALO_GAIN_MIN})',
        })
        report['checks'].append({
            'id': 'C', 'ok': ok_c,
            'detail': (f"hot={loc['hot']} 环内占比={loc['rim_fraction']:.3f} (>= 0.90) "
                       f"轮廓外最大差={loc['max_diff_outside']} (<= {HALO_OFF_MAX})"),
        })
        report['pixels'] = {
            'r': round(r, 2), 'halo_on': round(halo_on, 2), 'halo_off': round(halo_off, 2),
            'gain': round(gain, 2), **loc,
        }
        print(f'   B 轮廓外真的亮了：{halo_on:.1f} → 关掉后 {halo_off:.1f}（差 {gain:.1f}，'
              f"要求 ≥ {HALO_GAIN_MIN}）→ {'✅' if ok_b else '❌'}")
        print(f"   C 反向探针只改了那一圈：明显变化 {loc['hot']} px，其中 {loc['rim_fraction'] * 100:.1f}% 在环带里"
              f"（要求 ≥ 90%），轮廓外最大差 {loc['max_diff_outside']}（要求 ≤ {HALO_OFF_MAX}）"
              f"→ {'✅' if ok_c else '❌'}")

        # ── 判据 D：恒星日冕的角向起伏（A/B：同一机位，日冕开 / 关）──
        #
        # ⚠️ 为什么量"两张之差"而不是直接量恒星周围的环带：那一圈里有**轨道线**
        #    （最内圈轨道的投影半径 143~244px，正好从采样环里穿过），环带本身的角向起伏
        #    会被轨道线主导 —— 实测"关掉日冕"那张的 CV 反而更大（0.323 vs 0.120，判据当场红）。
        #    两张相减之后轨道线/星云/背景星全部抵消，剩下的**只有日冕自己的贡献**。
        #    判据 = 这份贡献得真的有（均值为正）**且角向不均匀**（光针；对称光晕的 CV ≈ 0）。
        ok_d = False
        cv_diff = 0.0
        mean_diff = 0.0
        if srect and srect.get('pageR'):
            img_full = Image.open(os.path.join(OUT_DIR, 'system3d-current.png')).convert('RGB')
            img_nocor = Image.open(os.path.join(OUT_DIR, 'system3d-current-nocorona.png')).convert('RGB')
            d_img = ImageChops.difference(img_full, img_nocor)
            sr = srect['pageR']
            cv_diff = ring_cv(d_img, srect['pageCx'], srect['pageCy'], sr * 1.3, sr * 2.2)
            mean_diff = mean_ring(d_img, srect['pageCx'], srect['pageCy'], sr * 1.3, sr * 2.2)
            ok_d = mean_diff >= CORONA_MEAN_MIN and cv_diff >= CORONA_CV_MIN
            report['corona'] = {'r': round(sr, 2), 'mean_diff': round(mean_diff, 2),
                                'cv_diff': round(cv_diff, 3)}
        report['checks'].append({
            'id': 'D', 'ok': ok_d,
            'detail': (f'corona mean_diff={mean_diff:.2f} (>= {CORONA_MEAN_MIN}) '
                       f'cv_diff={cv_diff:.3f} (>= {CORONA_CV_MIN})'),
        })
        print(f"   D 恒星日冕有光针：日冕净增量均值 {mean_diff:.1f}（要求 ≥ {CORONA_MEAN_MIN}），"
              f"角向变异系数 {cv_diff:.3f}（要求 ≥ {CORONA_CV_MIN}）→ {'✅' if ok_d else '❌'}")

        report['shots'] = [os.path.basename(s) for s in shots if s]
        report['stats'] = stats
        with open(os.path.join(OUT_DIR, 'report.json'), 'w', encoding='utf-8') as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)

        bad = [c for c in report['checks'] if not c['ok']]
        print()
        print('=' * 62)
        print(f"统计：{stats}")
        print(f"判据：{len(report['checks']) - len(bad)}/{len(report['checks'])} 通过")
        print(f'图与读数在：{OUT_DIR}')
        for s in report['shots']:
            print('  ' + s)
        print('=' * 62)
        return 1 if bad else 0
    finally:
        for h in handles:
            try:
                h.stop()
            except Exception:      # noqa: BLE001
                pass
        try:
            rt.free_port(rt.DEV_PORT)
            rt.free_port(rt.CDP_PORT)
            rt.teardown_mock()
        except Exception:          # noqa: BLE001
            pass


if __name__ == '__main__':
    sys.exit(main())
