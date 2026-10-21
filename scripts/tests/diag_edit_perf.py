#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机测帧：真实 415 省项目里 `render()` 与「拖一个顶点 20 步」的耗时。

用法：python scripts/tests/diag_edit_perf.py（工作副本，跑完还原配置）
产物：docs/assets/diag-edit-perf-20261021/result.json
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
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const cvs = sm.canvas;
  const rect = cvs.getBoundingClientRect();
  const provs = (sm.baseMap && sm.baseMap.terrain) || [];
  sm.setTool('select');
  sm.render();
  await new Promise(r => setTimeout(r, 80));
  const t = [];
  for (let i = 0; i < 12; i++) { const a = performance.now(); sm.render(); t.push(performance.now() - a); }
  const sorted = t.slice().sort((a, b) => a - b);

  // 顶点拖动：走产品路径——先把相机对准一个陆地省的重心、点选它，再对准第一个顶点
  let drag = null;
  let diag = null;
  {
    let pick = null;
    for (const p of provs) {
      if (p && p.kind !== 'sea' && Array.isArray(p.points) && p.points.length > 2) { pick = p; break; }
    }
    if (pick) {
      let cxs = 0, cys = 0;
      for (const q of pick.points) { cxs += q.x; cys += q.y; }
      const cx = cxs / pick.points.length, cy = cys / pick.points.length;
      const sx0 = rect.left + rect.width / 2;
      const sy0 = rect.top + rect.height / 2;
      sm.cameraScale = 1;
      sm.cameraX = rect.width / 2 - cx;
      sm.cameraY = rect.height / 2 - cy;
      const mk = (type, x, y) => new MouseEvent(type, {
        clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0,
      });
      const click = (t2, x, y) => cvs.dispatchEvent(mk(t2, x, y));
      sm.setTool('select');
      sm.render();
      await new Promise(r => setTimeout(r, 100));
      click('mousedown', sx0, sy0); click('mouseup', sx0, sy0); click('click', sx0, sy0);
      await new Promise(r => setTimeout(r, 150));
      const prov = sm.selectedProvince;
      diag = { tool: sm.tool, pick: pick.id, selected: prov && prov.id,
               hit: sm.findProvinceAt ? (sm.findProvinceAt(cx, cy) || {}).id : 'n/a' };
      if (prov && Array.isArray(prov.points) && prov.points.length > 1) {
        const v = prov.points[0];
        sm.cameraScale = 2;
        sm.cameraX = rect.width / 2 - v.x * 2;
        sm.cameraY = rect.height / 2 - v.y * 2;
        sm.setTool('vertex');
        sm.render();
        await new Promise(r => setTimeout(r, 120));
        const times = [];
        click('mousedown', sx0, sy0);
        const started = !!sm.draggingVertex;
        for (let i = 1; i <= 20; i++) {
          const a = performance.now();
          click('mousemove', sx0 + i * 1.5, sy0 + i * 0.8);
          times.push(performance.now() - a);
        }
        click('mouseup', sx0 + 30, sy0 + 16);
        const sortedD = times.slice().sort((a, b) => a - b);
        drag = { province: prov.id, started,
                 median: Math.round(sortedD[10] * 10) / 10,
                 max: Math.round(sortedD[19] * 10) / 10,
                 all: times.map(v2 => Math.round(v2 * 10) / 10) };
        sm.setTool('select');
      }
    }
  }
  return JSON.stringify({
    provinces: provs.length,
    render: { median: Math.round(sorted[6] * 10) / 10, min: Math.round(sorted[0] * 10) / 10,
              max: Math.round(sorted[11] * 10) / 10, all: t.map(v => Math.round(v * 10) / 10) },
    drag,
    diag,
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
    bak = os.path.join(ROOT, 'backups', 'diag-edit-perf-' + ts)
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
        raw = cdp.eval(PROBE)
        data = json.loads(raw) if isinstance(raw, str) else raw
        out = os.path.join(ROOT, 'docs', 'assets', 'diag-edit-perf-20261021')
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print(json.dumps(data, ensure_ascii=False, indent=1))
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
