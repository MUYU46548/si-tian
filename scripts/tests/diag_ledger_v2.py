#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机验证：账本 v2 项目（真实 415 省、已迁移）在司天里能被正确加载与派生。

判据（读真实 store / 真实 utils，不读源码）：
  ① 剧本都带 `initialOwnership`（v2 已落盘）；
  ② 装载后 `ownership` 与账本派生一致（0 mismatch）；
  ③ era 0 的事件省：第一条事件之前 = 无主，之后 = 新主（定案 A 在真数据上生效）；
  ④ `buildTimeline` 能产出 `tl.ledger`（12 代）。

用法：python scripts/tests/diag_ledger_v2.py（工作副本，跑完还原配置）
"""
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

PROBE = r"""
(async () => {
  const st = document.querySelector('#app').__vue_app__._instance.setupState;
  const TL = await import('/src/utils/scenarioTimeline.js');
  const V2 = await import('/src/utils/scenarioLedgerV2.js');
  const arr = st.store.getScenariosByOwner('desite') || [];
  const tl = TL.buildTimeline(arr);
  let withInitial = 0, mismatch = 0, checked = 0;
  const samples = [];
  for (const s of arr) {
    if (s && s.initialOwnership) withInitial++;
    const v = V2.verifyScenarioLedger(s);
    if (v.reason === 'mismatch') {
      mismatch++;
      if (samples.length < 3) samples.push({ id: s.id, diffs: v.diffs.slice(0, 3) });
    }
    if (s && s.initialOwnership) checked++;
  }
  // era 0 事件省：拿第一条事件做前后对照
  let era0 = null;
  const s0 = tl.ledger.eras[0];
  for (const pid of Object.keys(s0.byPid)) {
    const ev = s0.byPid[pid][0];
    if (!ev) continue;
    const before = TL.ledgerOwnerAt(tl.ledger, 0, pid, { y: ev.y - 1 });
    const on = TL.ledgerOwnerAt(tl.ledger, 0, pid, { y: ev.y, m: ev.m, d: ev.d });
    era0 = { pid, first: ev, before: before.owner, on: on.owner };
    break;
  }
  return JSON.stringify({
    scenarios: arr.length, withInitial, mismatch, checked,
    ledgerEras: tl.ledger ? tl.ledger.eras.length : 0,
    era0, samples,
    bulk: { dayLast: Object.keys(arr[0] && arr[0].ownership || {}).length },
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
    bak = os.path.join(ROOT, 'backups', 'diag-ledger-v2-' + ts)
    os.makedirs(bak, exist_ok=True)
    shutil.copy2(APP_CFG, os.path.join(bak, 'config.json'))
    work = os.path.join(bak, 'work-copy.sitian')
    shutil.copy2(real, work)
    print('真实项目（只读）：%s' % real)

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
        raw = cdp.eval(PROBE)
        data = json.loads(raw) if isinstance(raw, str) else raw
        out = os.path.join(ROOT, 'docs', 'assets', 'diag-ledger-v2-20261021')
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print(json.dumps(data, ensure_ascii=False, indent=1))
        fails = []
        if data.get('withInitial') != data.get('scenarios'):
            fails.append('有剧本没有 initialOwnership（迁移没覆盖全）')
        if data.get('mismatch'):
            fails.append('装载后 ownership 与账本派生不一致')
        if not data.get('ledgerEras'):
            fails.append('buildTimeline 没有产出 ledger')
        e0 = data.get('era0') or {}
        if e0 and e0.get('before') is not None:
            fails.append('era 0 第一条事件之前应为无主，实际 %r' % e0.get('before'))
        if e0 and not e0.get('on'):
            fails.append('era 0 事件当天应有新主')
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
