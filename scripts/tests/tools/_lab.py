#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时实验室（**不是回归用例**，用完全删）：
常驻 Vite + Edge，反复跑一小段探针 JS，避免每次改代码都付一次 run_tests 的启动成本。

用法：
    python scripts/tests/tools/_lab.py up      # 注入 mock + 起 Vite + 起 Edge（常驻）
    python scripts/tests/tools/_lab.py run <file.js>   # 跑一段探针（自动导航 + 打开基线项目）
    python scripts/tests/tools/_lab.py down    # 杀进程 + 还原 index.html
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

DEV_PORT = 5180
CDP_PORT = 9222
EDGE_EXE = r'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
PIDFILE = os.path.join(ROOT, '.lab-pids.json')


def up():
    import run_tests as RT
    from lib.cdp import CDP, wait_for
    from lib.helpers import open_harness_project
    RT.setup_mock()
    RT.free_port(DEV_PORT)
    dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not RT.wait_port(DEV_PORT):
        raise RuntimeError('vite 起不来')
    RT.free_port(CDP_PORT)
    edge = subprocess.Popen([
        EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
        '--remote-debugging-port=%d' % CDP_PORT, '--remote-allow-origins=*',
        '--user-data-dir=%s' % os.path.join(ROOT, '.lab-edge-profile'),
        '--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--disable-features=SyncConsentUI,SigninCheckoutFlow', '--no-sandbox', 'about:blank',
    ])
    if not RT.wait_port(CDP_PORT):
        raise RuntimeError('edge 起不来')
    with open(PIDFILE, 'w') as f:
        json.dump({'dev': dev.pid, 'edge': edge.pid}, f)
    print('up ok: dev=%s edge=%s' % (dev.pid, edge.pid))


def run(jsfile):
    import run_tests as RT
    from lib.cdp import CDP, wait_for
    from lib.helpers import open_harness_project
    with open(jsfile, encoding='utf-8') as f:
        js = f.read()
    cdp = CDP()
    # 硬重载（绕过缓存）：源码刚改过时，普通 navigate 可能拿到旧模块
    # —— 我为此白查了一轮"产品缺陷"（其实是页面还跑着改之前的代码）。
    import time as _t
    bust = int(_t.time())
    cdp.navigate('http://localhost:5180/?lab=%d' % bust)
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航')
    RT.apply_viewport(cdp)
    cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
    cdp.navigate()
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载')
    RT.apply_viewport(cdp)
    wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
             timeout=30, desc='数据就绪')
    ok, info = open_harness_project(cdp)
    print('harness project:', ok, str(info)[:200])
    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    time.sleep(1.5)
    cdp.eval("window.__LABDBG = true; window.__LABLOG = [];"
             "['warn','log','error'].forEach(k => { const o = console[k].bind(console);"
             "console[k] = (...a) => { try { window.__LABLOG.push(a.map(String).join(' ')); } catch(e){} o(...a); }; }); 'ok'")
    res = cdp.eval(js)
    print('__probeMark:', cdp.eval("JSON.stringify({hasW2S: typeof (document.querySelector('.scenario-map-container').__vueParentComponent.setupState || {}).worldToScreen, mark: (document.querySelector('.scenario-map-container').__vueParentComponent.setupState || {}).__probeMark})"))
    try:
        logs = cdp.eval("JSON.stringify(window.__LABLOG || [])")
        print('--- console ---')
        print(logs)
    except Exception as e:
        print('log read failed', e)
    # 出图：**观感类结论只能看图**（本项目的老教训：靠读代码猜"哪里丑"，一击不中就得再来一轮）
    try:
        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        import base64 as _b64
        out_png = os.path.join(ROOT, 'docs', 'assets', 'lab-shot.png')
        os.makedirs(os.path.dirname(out_png), exist_ok=True)
        with open(out_png, 'wb') as f:
            f.write(_b64.b64decode(shot['data']))
        print('shot ->', out_png)
    except Exception as e:
        print('screenshot failed:', e)
    print(json.dumps(res, ensure_ascii=False, indent=1) if not isinstance(res, str) else res)
    cdp.close()


def down():
    import run_tests as RT
    if os.path.exists(PIDFILE):
        with open(PIDFILE) as f:
            pids = json.load(f)
        for k, pid in pids.items():
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
        os.remove(PIDFILE)
    RT.free_port(DEV_PORT)
    RT.free_port(CDP_PORT)
    RT.teardown_mock()
    print('down ok')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'up':
        up()
    elif cmd == 'run':
        run(sys.argv[2])
    elif cmd == 'down':
        down()
    else:
        print(__doc__)
