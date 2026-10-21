#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机取证：顶部模块切换（世界观 / 历史剧本）是平级的，切换不叠层。

判据（读真实 DOM / 真实组件状态，不读源码）：
  ① 世界页：module-switch 在场、世界观 tab 高亮、历史剧本 tab 不高亮；
  ② 点「历史剧本」→ 卡片墙（模块入场页）；选一张卡 → ScenarioMap 在场、WorldSelector 不在；
  ③ 点「世界观」→ ScenarioMap 消失、WorldSelector 回来、activeModule='world'（不叠层）。

用法：python scripts/tests/diag_module_shell.py（工作副本，跑完还原配置）
产物：docs/assets/diag-module-shell-20261021/{1-world,2-picker,3-editor,4-back}.png + result.json
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
CDP_PORT = 9226
DEV_PORT = 5180
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
OUT = os.path.join(ROOT, 'docs', 'assets', 'diag-module-shell-20261021')

STATE = r"""
(() => {
  const st = document.querySelector('#app').__vue_app__._instance.setupState;
  const box = (s) => { const el = document.querySelector(s); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sw = document.querySelector('[data-testid=module-switch]');
  const tabs = sw ? Array.from(sw.querySelectorAll('button')).map(b => ({
    t: (b.textContent || '').trim(), active: b.classList.contains('active') })) : [];
  return JSON.stringify({
    activeModule: st.activeModule,
    scenarioMode: st.scenarioMode,
    picker: st.scenarioPickerVisible,
    viewLevel: st.store.viewLevel,
    switchBox: box('[data-testid=module-switch]'),
    tabs,
    scenario: box('.scenario-map-container'),
    planet: box('.planet-map-container'),
    worldSelector: !!document.querySelector('.world-selector'),
    pickerDom: !!document.querySelector('.scenario-picker'),
    header: box('header.toolbar'),
  });
})()
"""


def wait_http(url, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                return r.status < 500
        except Exception:
            time.sleep(0.4)
    return False


def wait_cdp(port=CDP_PORT, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/version' % port, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def free_port(port):
    subprocess.run(['powershell', '-NoProfile', '-Command',
                    "Get-NetTCPConnection -LocalPort %d -ErrorAction SilentlyContinue | "
                    "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" % port],
                   capture_output=True, timeout=30)


def main():
    cfg_text = open(APP_CFG, encoding='utf-8').read()
    cfg = json.loads(cfg_text)
    real = cfg.get('lastProjectPath', '')
    if not real or not os.path.exists(real):
        print('配置里的 lastProjectPath 不存在：%r' % real)
        return 2
    ts = time.strftime('%Y%m%d-%H%M%S')
    bak = os.path.join(ROOT, 'backups', 'diag-module-' + ts)
    os.makedirs(bak, exist_ok=True)
    shutil.copy2(APP_CFG, os.path.join(bak, 'config.json'))
    work = os.path.join(bak, 'work-copy.sitian')
    shutil.copy2(real, work)

    dev = el = None
    try:
        cfg['lastProjectPath'] = work
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)

        node = shutil.which('node')
        exe = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
        free_port(DEV_PORT)
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=open(os.path.join(bak, 'vite.log'), 'w'),
                               stderr=subprocess.STDOUT)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('vite 没起来，看 %s/vite.log' % bak)
            return 1
        free_port(CDP_PORT)
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        el = subprocess.Popen([exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
                               '--remote-allow-origins=*'],
                              cwd=ROOT, env=env, stdout=open(os.path.join(bak, 'electron.log'), 'w'),
                              stderr=subprocess.STDOUT)
        if not wait_cdp():
            print('electron CDP 没起来，看 %s/electron.log' % bak)
            return 1

        from lib.cdp import CDP, wait_for
        import run_tests as RT
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='应用挂载')
        RT.apply_viewport(cdp)
        time.sleep(2.0)
        # 窗口被别的窗口挡住时，Electron 的 rAF/合成会被节流，Page.captureScreenshot 会一直等新帧
        # （实测 15s CDP 读超时）。先显式提到前台再截。
        try:
            cdp.send('Page.bringToFront', {})
        except Exception as e:
            print('bringToFront 失败（继续）：', e)
        time.sleep(0.5)
        os.makedirs(OUT, exist_ok=True)

        def shot(name):
            """截图是证据、不是判据：拿不到就记下来继续跑（世界页有动画时捕获可能等不到帧）。"""
            try:
                s = cdp.send('Page.captureScreenshot', {'format': 'png', 'fromSurface': False})
                p = os.path.join(OUT, name)
                open(p, 'wb').write(base64.b64decode(s['data']))
                return p
            except Exception as e:
                print('  shot 失败（继续）：%s: %s' % (name, e))
                return None

        def state():
            v = cdp.eval(STATE)
            return json.loads(v) if isinstance(v, str) else v

        fails = []
        s1 = state()
        print('1 世界页:', json.dumps(s1, ensure_ascii=False))
        print('  shot:', shot('1-world.png'))
        if not s1.get('switchBox'):
            fails.append('世界页没有模块切换条')
        if s1.get('activeModule') != 'world':
            fails.append('世界页的 activeModule 不是 world：%r' % s1.get('activeModule'))
        if not any(t['t'] == '世界观' and t['active'] for t in s1.get('tabs') or []):
            fails.append('世界页「世界观」tab 没有高亮')
        if not s1.get('worldSelector'):
            fails.append('世界页没有 WorldSelector')

        cdp.eval("(() => { const b = document.querySelector('[data-testid=module-scenario]');"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(2.5)
        s2 = state()
        print('2 点历史剧本:', json.dumps(s2, ensure_ascii=False))
        print('  shot:', shot('2-picker.png'))
        if s2.get('activeModule') != 'scenario':
            fails.append('点「历史剧本」后 activeModule 不是 scenario：%r' % s2.get('activeModule'))
        if not s2.get('pickerDom'):
            fails.append('点「历史剧本」后没有卡片墙（模块入场页）')

        cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click(); return c ? 'ok' : 'none'; })()")
        try:
            wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本编辑器')
        except Exception:
            fails.append('选卡后剧本编辑器没有挂载')
        time.sleep(1.2)
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(1.0)
        s3 = state()
        print('3 编辑器:', json.dumps(s3, ensure_ascii=False))
        print('  shot:', shot('3-editor.png'))
        if not s3.get('scenario'):
            fails.append('编辑器里没有 ScenarioMap')
        if s3.get('worldSelector'):
            fails.append('编辑器里 WorldSelector 还在（两个模块同屏）')
        if not any(t['t'] == '历史剧本' and t['active'] for t in s3.get('tabs') or []):
            fails.append('编辑器里「历史剧本」tab 没有高亮')

        cdp.eval("(() => { const b = document.querySelector('[data-testid=module-world]');"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(1.2)
        s4 = state()
        print('4 切回世界观:', json.dumps(s4, ensure_ascii=False))
        print('  shot:', shot('4-back.png'))
        if s4.get('scenario'):
            fails.append('切回世界观后 ScenarioMap 还挂着（叠层）')
        if s4.get('activeModule') != 'world':
            fails.append('切回世界观后 activeModule 不是 world')
        if not s4.get('worldSelector'):
            fails.append('切回世界观后没有回到世界选择页')

        with open(os.path.join(OUT, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump({'world': s1, 'picker': s2, 'editor': s3, 'back': s4, 'fails': fails},
                      f, ensure_ascii=False, indent=1)
        print('\n==== ' + ('PASS' if not fails else 'FAIL') + ' ====')
        for x in fails:
            print(' -', x)
        return 0 if not fails else 1
    finally:
        if el is not None:
            subprocess.run(['taskkill', '/PID', str(el.pid), '/T', '/F'], capture_output=True)
        if dev is not None:
            subprocess.run(['taskkill', '/PID', str(dev.pid), '/T', '/F'], capture_output=True)
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            f.write(cfg_text)
        print('已还原配置')


if __name__ == '__main__':
    sys.exit(main())
