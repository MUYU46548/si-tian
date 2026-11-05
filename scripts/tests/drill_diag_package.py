#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断包真机演练（发布门槛④，2026-11-05）

为什么要它：单测只覆盖纯函数层（组包 / 脱敏 / ZIP 结构），**真实 Electron 里的那条链路**
（preload → ipcMain `diag-export` → electron-log 路径 → 写盘）没有被跑过 —— 而这正是
“陌生人崩了要发回来的东西”，不能只靠源码守卫。

本演练做什么：
  1) 起 Vite(5180) + 真实 Electron（dev 模式，CDP 9224）；
  2) 页面里调 `window.sitianAPI.diagExport({ target, stats })` —— target 给了就**不弹保存框**
     （handler 的测试分支），走的是与按钮完全相同的 IPC；
  3) **读盘**：zip 用 Python `zipfile` 真实解压，逐个文件核对：
     · 两个条目 `diagnostics.json` / `logs.txt`；
     · 版本 / 平台 / 项目计数对得上（计数是我们传进去的假值）；
     · 配置摘要只有“空不空 + 盘符”，**没有完整路径**；
     · 日志目录只写占位符；`logTail` 是脱敏后的行；
  4) 收尾：杀掉自己拉起的进程，产物留在 `build/diag-package/`。

⚠️ 会短暂开一个真实窗口（与其它真机演练同规矩：别在有人正画图时跑）。
用法：python scripts/tests/drill_diag_package.py
退出码：0 = 通过；非 0 = 失败（逐条打印）。
"""
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib.cdp import CDP, wait_for                      # noqa: E402

# Windows 上重定向到文件时默认是 GBK：✅/🔴 会抛 UnicodeEncodeError（本次真踩）
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
DEV_PORT = 5180
CDP_PORT = 9224
OUT = os.path.join(ROOT, 'build', 'diag-package')

fails = []


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (' — ' + str(detail) if detail else ''), flush=True)
    if not ok:
        fails.append(name + (' — ' + str(detail) if detail else ''))
    return ok


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


def node_and_electron():
    """vite 要用 **node** 跑，应用要用 **electron** 跑 —— 两个可执行文件不是同一个。"""
    node = shutil.which('node') or 'node'
    out = subprocess.run([node, '-e', 'process.stdout.write(require("electron"))'],
                         cwd=ROOT, capture_output=True, text=True, timeout=60)
    exe = (out.stdout or '').strip()
    if not (exe and os.path.exists(exe)):
        raise RuntimeError('找不到 electron（node -e require("electron") 失败）')
    return node, exe


def main():
    for p in (DEV_PORT, CDP_PORT):
        if port_open(p):
            print('端口 %d 已被占用 —— 先停掉正在跑的回归/演练' % p)
            return 2
    os.makedirs(OUT, exist_ok=True)
    ts = time.strftime('%Y%m%d-%H%M%S')
    target = os.path.join(OUT, 'diag-' + ts + '.zip')
    node, exe = node_and_electron()
    dev = el = None
    devlog = applog = None
    try:
        print('=== 诊断包真机演练 ===')
        devlog = open(os.path.join(OUT, 'vite-' + ts + '.log'), 'a', encoding='utf-8')
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=devlog, stderr=devlog)
        if not wait_http('http://localhost:%d/' % DEV_PORT, timeout=90):
            print('vite 未就绪（见 %s）' % OUT)
            return 1
        ck('Vite dev server 就绪', True)

        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        applog = open(os.path.join(OUT, 'electron-' + ts + '.log'), 'a', encoding='utf-8')
        el = subprocess.Popen(
            [exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
             '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
             '--remote-allow-origins=*'],
            cwd=ROOT, env=env, stdout=applog, stderr=applog)
        if not wait_port(CDP_PORT, timeout=90):
            print('Electron CDP 未就绪（见 %s）' % OUT)
            return 1
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='应用挂载')
        ck('真实 Electron 已挂载', True)

        stats = {'entities': 7, 'baseMaps': 2, 'provinces': 9, 'scenarios': 3,
                 'gridCells': 1234, 'rivers': 56, 'roads': 78}
        expr = ("(async () => { const r = await window.sitianAPI.diagExport({ target: %s, stats: %s });"
                " return JSON.stringify(r); })()" % (json.dumps(target), json.dumps(stats)))
        raw = cdp.eval(expr)
        if isinstance(raw, dict) and raw.get('__err__'):
            ck('IPC diag-export 可调用', False, raw['__err__'])
            return 1
        try:
            res = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            res = {'ok': False, 'error': '返回值不是 JSON：%r' % (raw,)}
        ck('IPC diag-export 可调用', bool(res and res.get('ok')), json.dumps(res, ensure_ascii=False)[:200])
        if not (res and res.get('ok')):
            return 1

        # ── 读盘：真实解压 ─────────────────────────────────────────────
        ck('zip 已落到磁盘', os.path.exists(target), target)
        if not os.path.exists(target):
            return 1
        with zipfile.ZipFile(target) as z:
            names = sorted(z.namelist())
            ck('条目齐全（diagnostics.json / logs.txt）', names == ['diagnostics.json', 'logs.txt'], names)
            diag = json.loads(z.read('diagnostics.json').decode('utf-8'))
            logs_txt = z.read('logs.txt').decode('utf-8', 'replace')

        ck('版本从真实 app 读到（不是空串）', bool(diag.get('app', {}).get('version')),
           diag.get('app', {}).get('version'))
        ck('运行时字段有 Electron 版本', bool(diag.get('runtime', {}).get('electron')),
           diag.get('runtime', {}).get('electron'))
        ck('项目计数原样进包', diag.get('project', {}).get('provinces') == 9
           and diag.get('project', {}).get('gridCells') == 1234, json.dumps(diag.get('project'), ensure_ascii=False))
        cfg = diag.get('config') or {}
        ck('配置摘要只有“空不空 + 盘符”（没有完整路径）',
           all(set(v.keys()) <= {'empty', 'drive', 'segments'} for v in cfg.values() if isinstance(v, dict)),
           json.dumps(cfg, ensure_ascii=False))
        ck('日志目录只写占位符', diag.get('logs', {}).get('dir') == '<日志目录>')
        blob = json.dumps(diag, ensure_ascii=False) + logs_txt
        ck('包内没有盘符绝对路径（除占位符）', ':\\' not in blob.replace('<路径:', ''), '')
        ck('包内没有用户目录字面量', '\\\\Users\\\\' not in blob and '/Users/' not in blob, '')

        print('\n  产物：%s（%.1f KB）' % (target, os.path.getsize(target) / 1024))
        return 0 if not fails else 1
    finally:
        for p in (el, dev):
            try:
                if p and p.poll() is None:
                    p.terminate()
            except Exception:
                pass
        for f in (applog, devlog):
            try:
                f and f.close()
            except Exception:
                pass
        time.sleep(1.0)


if __name__ == '__main__':
    code = main()
    print(('\n✅ 全部通过' if code == 0 else '\n🔴 %d 项失败' % len(fails)))
    for f in fails:
        print('  - ' + f)
    sys.exit(code)
