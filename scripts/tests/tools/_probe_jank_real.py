#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""卡顿定位探针的驱动（**不是回归用例**，会话结束前删）。

为什么不用 `_lab.py run`：整段探针要跑 40s+，而 `cdp.eval` 的读超时是 15s →
必然 `WebSocketTimeoutException`（第一版就是这么挂的）。改成：
页面里起一个 async 任务把进度写进 `window.__JANK`，Python 侧**轮询**读。

用法（lab 必须先 up）：
    python scripts/tests/tools/_probe_jank_real.py
"""
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for      # noqa: E402
from lib.helpers import open_harness_project   # noqa: E402
import run_tests as RT                 # noqa: E402

JS = os.path.join(ROOT, 'scripts', 'tests', 'tools',
                  sys.argv[1] if len(sys.argv) > 1 else '_probe_jank_real.js')
# 页面侧结果挂在哪个全局上（探针各写各的：`__JANK` / `__SAVE` / …）
GLOBAL = sys.argv[2] if len(sys.argv) > 2 else '__JANK'
OUT = os.path.join(ROOT, '.lab-jank.json')


def main():
    print('probe js =', os.path.basename(JS))
    cdp = CDP()
    try:
        cdp.ws.settimeout(180)
        bust = int(time.time())
        cdp.navigate('http://localhost:5180/?jank=%d' % bust)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?jank=%d' % (bust + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        ok, info = open_harness_project(cdp)
        print('harness project:', ok, str(info)[:160])
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本模式')
        time.sleep(1.2)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find((x) => (x.textContent || '').includes('\u4e22\u5f03\u5907\u4efd'));"
                 " if (b) { b.click(); return true; } return false; })()")
        time.sleep(0.6)
        with open(JS, encoding='utf-8') as f:
            js = f.read()
        # 只**启动**（awaitPromise=False）：返回值立刻回来，任务在页面里继续跑
        cdp.send('Runtime.evaluate', {'expression': js, 'returnByValue': True, 'awaitPromise': False})
        deadline = time.time() + 600
        last_stage = None
        res = None
        while time.time() < deadline:
            try:
                v = cdp.eval("JSON.stringify(window.%s || null)" % GLOBAL)
            except Exception as e:
                # 落库那条重链会把渲染进程主线程占住（本项目既有事实）→ 轮询会超时。
                # 重连后继续读：探针在页面里照跑，结果一直躺在 window.__JANK 上。
                print('  轮询超时（页面主线程被占住），重连继续读…（%s）' % str(e).split('\n')[0][:80])
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
            print('🔴 没读到 ' + GLOBAL)
            return 1
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
        print('=== 读数（也写进 %s）===' % os.path.relpath(OUT, ROOT))
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
