#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机 CPU 采样：415 省项目里连续 render 20 次，按函数聚合自耗时。

用法：python scripts/tests/diag_edit_profile.py（工作副本，跑完还原配置）
产物：docs/assets/diag-edit-perf-20261021/profile.json + 控制台 Top 表
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
CDP_PORT = 9226
DEV_PORT = 5180
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
OUT = os.path.join(ROOT, 'docs', 'assets', 'diag-edit-perf-20261021')


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
    bak = os.path.join(ROOT, 'backups', 'diag-edit-profile-' + ts)
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
                               cwd=ROOT, stdout=open(os.path.join(bak, 'vite.log'), 'w'), stderr=subprocess.STDOUT)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('vite 没起来')
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
            print('electron CDP 没起来')
            return 1
        from lib.cdp import CDP, wait_for
        import run_tests as RT
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='应用挂载')
        RT.apply_viewport(cdp)
        time.sleep(2.0)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本'));"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(2.0)
        cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click();"
                 " return c ? 'ok' : 'none'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='编辑器')
        time.sleep(1.5)
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(1.0)
        cdp.eval("(() => { const sm = document.querySelector('.scenario-map-container')"
                 ".__vueParentComponent.setupState; sm.setTool('select'); sm.render(); return 'ok'; })()")
        cdp.send('Profiler.enable', {})
        cdp.send('Profiler.setSamplingInterval', {'interval': 100})
        cdp.send('Profiler.start', {})
        cdp.eval("(() => { const sm = document.querySelector('.scenario-map-container')"
                 ".__vueParentComponent.setupState; for (let i = 0; i < 20; i++) sm.render(); return 'ok'; })()")
        prof = cdp.send('Profiler.stop', {})['profile']
        nodes = {n['id']: n for n in prof.get('nodes', [])}
        # 用 timeDeltas（微秒）算**真实**自耗时；只按样本数 × 固定间隔会把总量算错
        samples = prof.get('samples') or []
        deltas = prof.get('timeDeltas') or []
        per = {}
        for nid, dt in zip(samples, deltas):
            per[nid] = per.get(nid, 0) + (dt or 0)
        rows = []
        for nid, us in per.items():
            n = nodes.get(nid)
            if not n:
                continue
            f = n.get('callFrame') or {}
            rows.append({
                'ms': round(us / 1000.0, 1),
                'fn': f.get('functionName') or '(anonymous)',
                'file': (f.get('url') or '').split('/')[-1],
                'line': f.get('lineNumber'),
            })
        rows.sort(key=lambda r: -r['ms'])
        total = sum(deltas) / 1000.0
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, 'profile.json'), 'w', encoding='utf-8') as f:
            json.dump({'totalMs': round(total, 1), 'rows': rows}, f, ensure_ascii=False, indent=1)
        print('采样总耗时 %.1fms / 20 帧（≈%.1fms/帧）' % (total, total / 20))
        for r in rows[:25]:
            print('  %7.1fms  %-34s %s:%s' % (r['ms'], r['fn'][:34], r['file'], r['line']))
        return 0
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
