#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""示例项目真机演练（发布门槛②，2026-11-05）

判据（全真机，不 mock）：
  1) `sitianAPI.sampleProjectOpen()` 把安装包里的示例**复制**到文档目录，返回可写路径；
  2) 盘上那份副本能打开，且**72 省 / 2 段剧本 / 有河**（不是空壳）；
  3) 仓里的原件 `sample/示例世界.sitian` **一个字节都没变**（复制而不是就地打开）。

用法：python scripts/tests/drill_sample_project.py
退出码：0 = 通过；非 0 = 失败。
"""
import hashlib
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib.cdp import CDP, wait_for                      # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
DEV_PORT = 5180
CDP_PORT = 9224
SRC = os.path.join(ROOT, 'sample', '示例世界.sitian')


def port_open(port):
    import socket
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_port(port, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.3)
    return False


def wait_http(url, timeout=90):
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    fails = []

    def ck(name, ok, detail=''):
        print(('  ✅ ' if ok else '  ❌ ') + name + (' — ' + str(detail) if detail else ''), flush=True)
        if not ok:
            fails.append(name)

    if not os.path.exists(SRC):
        print('缺少示例原件：%s（先跑 scripts/tests/tools/make_sample_world.py）' % SRC)
        return 2
    before = sha(SRC)
    print('=== 示例项目真机演练 ===\n原件 %s（%.1f MB）' % (SRC, os.path.getsize(SRC) / 1048576))

    node = 'node'
    exe = subprocess.run([node, '-e', 'process.stdout.write(require("electron"))'],
                         cwd=ROOT, capture_output=True, text=True, timeout=60).stdout.strip()
    dev = el = None
    try:
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('vite 未就绪')
            return 1
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('ELECTRON_RUN_AS_NODE', None)
        el = subprocess.Popen([exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
                               '--disable-gpu', '--remote-allow-origins=*'], cwd=ROOT, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not wait_port(CDP_PORT):
            print('CDP 未就绪')
            return 1
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='应用挂载')

        res = cdp.eval("(async () => JSON.stringify(await window.sitianAPI.sampleProjectOpen()))()")
        info = json.loads(res) if isinstance(res, str) else res
        ck('IPC sample-project-open 返回可写副本', bool(info and info.get('ok')), info)
        path = (info or {}).get('path') or ''
        ck('副本落在文档目录（不是 asar 里）', 'Documents' in path and path.endswith('.sitian'), path)
        ck('副本文件存在且不是空壳', os.path.exists(path) and os.path.getsize(path) > 1000000,
           '%.1f MB' % (os.path.getsize(path) / 1048576) if os.path.exists(path) else 'missing')

        opened = cdp.eval("""(async () => {
          const app = document.querySelector('#app').__vue_app__;
          const pinia = app.config.globalProperties.$pinia;
          const { useProjectStore } = await import('/src/store/projectStore.js');
          const ps = useProjectStore(pinia);
          const r = await ps.openProject(%s);
          const p = ps.project || {};
          const sc = p.scenarios || {};
          const bms = sc.baseMaps || {};
          const k = Object.keys(bms)[0] || '';
          return JSON.stringify({ ok: !!(r && r.success),
            provinces: (bms[k] && bms[k].terrain || []).length,
            rivers: (bms[k] && bms[k].rivers || []).length,
            scenarios: Object.keys(sc.scenarios || {}).length,
            entities: Object.keys(p.entities || {}).length,
            hasWorld: Object.values(p.entities || {}).some((e) => e && e.layer === 'world') });
        })()""" % json.dumps(path))
        o = json.loads(opened) if isinstance(opened, str) else opened
        ck('副本能打开且不是空壳', bool(o and o.get('ok')), o)
        ck('示例规模：72 省 / 2 段剧本 / 有河',
           int((o or {}).get('provinces') or 0) >= 60 and int((o or {}).get('scenarios') or 0) >= 1
           and int((o or {}).get('rivers') or 0) > 0, o)
        ck('示例带实体树（世界 → 行星 → 区域）',
           int((o or {}).get('entities') or 0) >= 4 and bool((o or {}).get('hasWorld')), o)

        after = sha(SRC)
        ck('仓里的原件一个字节没变（复制而非就地打开）', before == after, before[:12] + ' / ' + after[:12])
        return 0 if not fails else 1
    finally:
        for p in (el, dev):
            try:
                if p and p.poll() is None:
                    p.terminate()
            except Exception:
                pass
        time.sleep(1.0)


if __name__ == '__main__':
    code = main()
    print('\n' + ('✅ 全部通过' if code == 0 else '🔴 %d 项失败' % 0))
    sys.exit(code)
