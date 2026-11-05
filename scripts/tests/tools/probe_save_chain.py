#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""保存链探针（2026-11-05）：真机开一份项目副本，直接调 `projectStore.saveProject()`，
把结果、异常、分段读数、磁盘是否真的变了**一次性**打出来。

为什么要它：`drill_undo_latency.py` 只量时延与帧，保存**失败**（抛异常被 catch 吞掉、
只写进 lastError）在那种读数里看起来只是"没动静"；排查"改了没落盘"必须直接问 store。

用法：python scripts/tests/tools/probe_save_chain.py [--project <file.sitian>] [--keep]
退出码：0 = 保存成功且磁盘变了；1 = 有别的问题（打印原因）
"""
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests', 'lib'))

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

import run_tests as RT                      # noqa: E402
from lib.cdp import CDP, wait_for, eval_json, skip_onboarding   # noqa: E402

DEV_PORT = int(os.environ.get('SITIAN_DEV_PORT', '5180'))
CDP_PORT = 9230


def port_open(port):
    import socket
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(('127.0.0.1', port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def wait_port(port, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if port_open(port):
            return True
        time.sleep(0.4)
    return False


def wait_http(url, timeout=120):
    import urllib.request
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(url, timeout=2).read(64)
            return True
        except Exception:
            time.sleep(0.4)
    return False


def resolve_project(argv):
    """项目来源：`--project` > 环境变量 `SITIAN_PROBE_PROJECT` > 文档目录里**最近改动**的 .sitian。

    ⚠️ 刻意**不写死任何项目名**：发布物与 `scripts/` 都不许出现私人专名（隐私扫描守门，
    2026-11-05 第一次写死就红了一条）。
    """
    for i, a in enumerate(argv):
        if a == '--project' and i + 1 < len(argv):
            return os.path.abspath(argv[i + 1])
    env_path = os.environ.get('SITIAN_PROBE_PROJECT', '')
    if env_path:
        return os.path.abspath(env_path)
    base = os.path.join(os.environ.get('USERPROFILE', ''), 'Documents', 'SiTianProjects')
    if not os.path.isdir(base):
        return ''
    cands = [os.path.join(base, f) for f in os.listdir(base) if f.endswith('.sitian')]
    cands = [c for c in cands if os.path.isfile(c)]
    if not cands:
        return ''
    return max(cands, key=os.path.getmtime)


YIELD_JS = r"""(async () => {
  const race = (p, ms) => Promise.race([
    Promise.resolve(p).then(() => 'ok'),
    new Promise((r) => setTimeout(() => r('timeout'), ms)),
  ]);
  const out = {};
  const t = () => performance.now();

  // ① MessageChannel + onmessage（现在实现用的那条路）
  try {
    const ch = new MessageChannel();
    const p = new Promise((res) => { ch.port1.onmessage = () => res(); });
    try { ch.port1.start?.(); } catch (e) {}
    ch.port2.postMessage({ token: 1 });
    const a = t(); out.mcOnmessage = await race(p, 1500); out.mcOnmessageMs = Math.round(t() - a);
  } catch (e) { out.mcOnmessage = 'throw: ' + e.message; }

  // ② window.postMessage 自发自收
  try {
    const p = new Promise((res) => {
      const h = (e) => { if (e.data && e.data.__yieldProbe) { window.removeEventListener('message', h); res(); } };
      window.addEventListener('message', h);
    });
    const a = t(); window.postMessage({ __yieldProbe: 1 }, '*');
    out.postMessage = await race(p, 1500); out.postMessageMs = Math.round(t() - a);
  } catch (e) { out.postMessage = 'throw: ' + e.message; }

  // ③ setTimeout(0) 基线（嵌套 8 层看看有没有 4ms 夹取）
  {
    const a = t();
    for (let i = 0; i < 8; i += 1) { await new Promise((r) => setTimeout(r, 0)); }
    out.setTimeout8Ms = Math.round(t() - a);
  }

  // ④ Node 的 setImmediate 在不在（Electron 渲染进程整合 Node 时才有）
  out.hasSetImmediate = typeof setImmediate;
  out.hasMessageChannelStart = (() => {
    try { const ch = new MessageChannel(); return typeof ch.port1.start; } catch (e) { return 'throw'; }
  })();
  return JSON.stringify({ ok: true, out });
})()"""

PROBE_JS = r"""(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const ps = useProjectStore(pinia);
  // 收集这一段时间的报错（保存失败会走 console.error + 全局告警）
  if (!window.__PROBE_ERRS__) {
    window.__PROBE_ERRS__ = [];
    const origErr = console.error;
    console.error = function () {
      try { window.__PROBE_ERRS__.push(Array.from(arguments).map(String).join(' ')); } catch (e) {}
      return origErr.apply(console, arguments);
    };
    window.addEventListener('sitian:project-warning', (e) => {
      try { window.__PROBE_ERRS__.push('warning: ' + JSON.stringify(e.detail || {})); } catch (err) {}
    });
  }
  const t0 = performance.now();
  // 自带墙钟上限：保存若卡住，CDP 的 15s 读超时会把整份探针变成 traceback，什么也留不下
  const res = await Promise.race([
    ps.saveProject({ label: '探针' }).then((r) => ({ settled: 'resolved', value: r })),
    new Promise((r) => setTimeout(() => r({ settled: 'timeout' }), 8000)),
  ]);
  return JSON.stringify({
    ok: true,
    res,
    ms: Math.round(performance.now() - t0),
    dirty: !!ps.dirty, saveStatus: ps.saveStatus, lastError: ps.lastError || '',
    filePath: ps.filePath || '',
    saveLog: (window.__SITIAN_SAVE_LOG__ || []).slice(0, 3),
    errs: (window.__PROBE_ERRS__ || []).slice(-6),
  });
})()"""


def main():
    real = resolve_project(sys.argv)
    if not real or not os.path.exists(real):
        print('❌ 找不到项目（用 --project 指定）')
        return 2
    for p in (DEV_PORT, CDP_PORT):
        if port_open(p):
            print(f'❌ 端口 {p} 被占用（先停掉正在跑的回归/演练）')
            return 2

    out_dir = os.path.join(ROOT, 'build', 'probe-save', time.strftime('%Y%m%d-%H%M%S'))
    os.makedirs(out_dir, exist_ok=True)
    work = os.path.join(out_dir, 'work-copy.sitian')
    shutil.copy2(real, work)
    profile = os.path.join(out_dir, 'userdata')
    shutil.rmtree(profile, ignore_errors=True)
    size0 = os.path.getsize(work)
    mtime0 = os.path.getmtime(work)
    print(f'项目（只读）：{real}')
    print(f'工作副本    ：{work}（{size0} 字节）')

    node = shutil.which('node')
    exe = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    dev = el = None
    code = 1
    try:
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=open(os.path.join(out_dir, 'vite.log'), 'w'),
                               stderr=subprocess.STDOUT)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('❌ Vite 没起来（看 vite.log）')
            return 1
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        el = subprocess.Popen([exe, '--user-data-dir=%s' % profile,
                               '--remote-debugging-port=%d' % CDP_PORT,
                               '--remote-allow-origins=*', '.'],
                              cwd=ROOT, env=env,
                              stdout=open(os.path.join(out_dir, 'electron.log'), 'w'),
                              stderr=subprocess.STDOUT)
        if not wait_port(CDP_PORT):
            print('❌ Electron CDP 没起来（看 electron.log）')
            return 1
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                 timeout=180, desc='应用挂载')
        RT.apply_viewport(cdp)
        time.sleep(1.0)
        cdp.eval("(() => { const b = document.querySelector('.disclaimer-dialog button, .disclaimer-accept');"
                 " if (b) b.click(); return 'ok'; })()")
        skip_onboarding(cdp)

        opened = eval_json(cdp, """(async () => {
          const app = document.querySelector('#app').__vue_app__;
          const pinia = app.config.globalProperties.$pinia;
          const { useProjectStore } = await import('/src/store/projectStore.js');
          const r = await useProjectStore(pinia).openProject(%s);
          return JSON.stringify({ ok: !!(r && r.success !== false), err: (r && r.error) || '' });
        })()""" % json.dumps(work), required=('ok',), desc='打开工作副本')[1]
        print(f'打开副本：{json.dumps(opened, ensure_ascii=False)}')
        time.sleep(1.5)
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(0.5)

        probe_y = eval_json(cdp, YIELD_JS, required=('ok',), desc='让出一拍能不能返回')[1]
        print('让出测试：' + json.dumps(probe_y, ensure_ascii=False))

        probe = eval_json(cdp, PROBE_JS, required=('ok',), desc='直接调 saveProject')[1]
        print(json.dumps(probe, ensure_ascii=False, indent=1))

        size1 = os.path.getsize(work)
        mtime1 = os.path.getmtime(work)
        changed = (size1 != size0) or (mtime1 > mtime0 + 0.001)
        print(f'\n磁盘：{size0} → {size1} 字节；mtime 变了：{mtime1 > mtime0 + 0.001}')
        ok = bool(((probe.get('res') or {}).get('value') or {}).get('success')) and changed
        print('✅ 保存真的落盘了' if ok else '🔴 保存没落盘（见上面的 res / lastError / errs）')
        code = 0 if ok else 1
        if ok and '--keep' not in sys.argv:
            for junk in (work + '.backups',):
                shutil.rmtree(junk, ignore_errors=True)
        return code
    finally:
        if el is not None:
            subprocess.run(['taskkill', '/PID', str(el.pid), '/T', '/F'], capture_output=True)
        if dev is not None:
            subprocess.run(['taskkill', '/PID', str(dev.pid), '/T', '/F'], capture_output=True)
        print(f'产物：{out_dir}')


if __name__ == '__main__':
    sys.exit(main())
