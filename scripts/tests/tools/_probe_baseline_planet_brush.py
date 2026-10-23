#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 1 件基线探针的驱动：**PlanetMap 高度笔刷连画 30 秒**的帧分布。

判据口径（指南包 02 §三 B1）：连续画 30 秒，全程**零帧 >50ms**。
本脚本只负责把机器点着、把探针跑起来、把读数落盘 —— 不修任何东西。

为什么不用 `_lab.py run`：整段 45s+，单次 `cdp.eval` 会撞 CDP 15s 读超时
（`_lab.py` 的注释也写了这条）；所以照 `_probe_jank_real.py` 的做法：
页面里起 async 任务写 `window.__PLBASE`，Python 侧轮询。

用法：
    python scripts/tests/tools/_lab.py up      # 先起常驻 Vite + Edge（项目自带 mock 注入）
    python scripts/tests/tools/_probe_baseline_planet_brush.py
    python scripts/tests/tools/_lab.py down    # 收工
    # 读数落在 .lab-planet-baseline.json（仓库根，临时文件，不进 git）

⚠️ 探针需要"行星视图 + 编辑模式已开"，这两步由本脚本用 `goto_planet` / `enter_edit`
   完成（与回归用例同一条路，不是手搓 DOM 点击）。
"""
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for          # noqa: E402
from lib.helpers import open_harness_project, goto_planet, enter_edit   # noqa: E402
import run_tests as RT                     # noqa: E402

JS = os.path.join(ROOT, 'scripts', 'tests', 'tools', '_probe_baseline_planet_brush.js')
OUT = os.path.join(ROOT, '.lab-planet-baseline.json')


def main():
    cdp = CDP()
    try:
        cdp.ws.settimeout(180)
        bust = int(time.time())
        cdp.navigate('http://localhost:5180/?plbase=%d' % bust)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?plbase=%d' % (bust + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        ok, info = open_harness_project(cdp)
        print('harness project:', ok, str(info)[:160])
        if not ok:
            print('🔴 harness 项目没打开，基线量出来没有意义')
            return 1

        view = goto_planet(cdp)
        print('goto_planet ->', view)
        if view != 'planet':
            print('🔴 没进行星视图：', view)
            return 1
        print('enter_edit ->', enter_edit(cdp))
        wait_for(cdp, "!!document.querySelector('.planet-map-container')", timeout=20, desc='行星地图挂载')
        wait_for(cdp, "!!document.querySelector('.planet-map-container canvas')", timeout=20, desc='行星画布')
        time.sleep(1.0)

        with open(JS, encoding='utf-8') as f:
            js = f.read()
        cdp.send('Runtime.evaluate', {'expression': js, 'returnByValue': True, 'awaitPromise': False})

        deadline = time.time() + 300
        last_stage, res = None, None
        while time.time() < deadline:
            try:
                v = cdp.eval("JSON.stringify(window.__PLBASE || null)")
            except Exception as e:
                print('  轮询超时（主线程被占住），重连继续读…（%s）' % str(e).split('\n')[0][:80])
                try:
                    cdp.close()
                except Exception:
                    pass
                time.sleep(5)
                cdp = CDP()
                cdp.ws.settimeout(180)
                continue
            if isinstance(v, dict) and '__err__' in v:
                print('轮询异常：', v)
                break
            if isinstance(v, str) and v and v != 'null':
                res = json.loads(v)
                if res.get('stage') != last_stage:
                    last_stage = res.get('stage')
                    print('  stage ->', last_stage, ' fails=%s' % (res.get('fails') or [])[:1])
                if res.get('stage') == 'done':
                    break
            time.sleep(2)

        if res is None:
            print('🔴 没读到 window.__PLBASE')
            return 1
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
        print('=== 读数（也写进 %s）===' % os.path.relpath(OUT, ROOT))
        print(json.dumps(res, ensure_ascii=False, indent=1))

        # 一行结论（人话），免得每次翻 JSON
        out = res.get('out') or {}
        for key, label in (('control_hover', 'hover 5s'), ('height_drag', '高度笔 30s'), ('relief_drag', '散布笔 10s')):
            s = out.get(key) or {}
            if 'frames' in s:
                print('%s：%d 帧 p50=%sms p95=%sms max=%sms >33ms=%d >50ms=%d >100ms=%d handler=%.2fms/次'
                      % (label, s['frames'], s['p50'], s['p95'], s['max'],
                         s['over33'], s['over50'], s['over100'], s['handlerMsPerEvent']))
        if out.get('land_ms') is not None:
            print('抬手落库：%.1fms' % out['land_ms'])
        return 0
    finally:
        try:
            cdp.close()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
