#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单星系 3D 观景的现状截图（2026-11-25）

## 为什么要有它

用户 2026-11-25 定论："这版非常丑，不如纯 2D 平面（司天现状）"——
说的是**星域级 3D 原型**。同时明确："**单星系内部本来就是我要的**"。

所以在动 `System3DView` 之前，先拍一张**它现在长什么样**。
上一轮的教训：做了一堆原型却从没和现状比过，结果做出来的不如现状。**这次先拍，再改。**

## 怎么进

走**产品自己的入口**（与 `test_163_system_3d.py` 同一条路）：
  ① mock 数据 → ② Vite → ③ Edge headless → ④ `store.enterSystemDetail(system)`
  → ⑤ 点 `[data-testid=system-3d-open]` → ⑥ 截图

## 口径（都是踩过的）

· `Page.captureScreenshot` 必须 `fromSurface: True`：WebGL 画布用 `False` 会拍成全黑。
· 截图前要**主动踢一帧**（组件 `exposed.tick()`）：headless 下 rAF 可能挂住，
  场景换了但画面没刷 → 两张图 0 像素差，看起来像"3D 没生效"。
· 等 three 动态下载完（`wait_for` 画布出现 + 2.5s）。

用法：
  python scripts/proto/shot_system3d.py
产物：build/system3d/system3d-current.png + system3d-close.png
"""
import base64
import json
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


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    try:
        print('1/5 注入 mock 数据…')
        rt.setup_mock()

        print('2/5 启动 Vite…')
        rt.free_port(rt.DEV_PORT)
        dev = rt.subprocess.Popen(
            ['cmd', '/c', 'npm', 'run', 'dev'] if os.name == 'nt' else ['npm', 'run', 'dev'],
            cwd=rt.ROOT, stdout=rt.subprocess.DEVNULL, stderr=rt.subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT):
            print('❌ Vite 起不来（端口被占？见 run_tests.py 的提示）')
            return 1

        print('3/5 启动 Edge headless…')
        edge_handle = rt._launch_edge(handles)

        print('4/5 进单星系 3D…')
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

        print('5/5 截图…')
        shots = [shoot(cdp, 'system3d-current')]

        # 近景：拉近看行星细节（群星里最关键的一档）
        zoomed = jget(cdp, _s3d("""
          const fn = ex.zoomTo || st.zoomTo;
          if (typeof fn === 'function') { fn(2.2); return JSON.stringify({ fails: [], zoomed: true }); }
          return JSON.stringify({ fails: [], zoomed: false,
            keys: Object.keys(ex).concat(Object.keys(st)).slice(0, 40) });
        """), desc='拉近')
        print(f'   拉近：{zoomed}')
        time.sleep(1.5)
        shots.append(shoot(cdp, 'system3d-close'))

        print()
        print('=' * 62)
        st = jget(cdp, _s3d("""
          const fn = ex.getStats || st.getStats;
          return JSON.stringify({ fails: [], stats: typeof fn === 'function' ? fn() : null });
        """), desc='读数')
        print(f'统计：{st.get("stats")}')
        print('=' * 62)
        print(f'图在：{OUT_DIR}')
        for s in shots:
            if s:
                print('  ' + os.path.basename(s))
        return 0
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
