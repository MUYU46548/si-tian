#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""取证：每一条导入河到底被描了几次？（回答「两条蓝线」是不是同一份数据画了两遍）

方法：在画布上下文上记录所有 stroke，按「第一段 moveTo 的坐标」匹配回原始河的首点，
统计每条河被描的 chunk 数；同一首点出现两组 → 画了两遍。

用法：python scripts/tests/diag_river_dup.py
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
OUT = os.path.join(ROOT, 'docs', 'assets', 'diag-river-hollow-20261021')

PROBE = r"""
(async () => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const P = CanvasRenderingContext2D.prototype;
  if (!window.__dupInstalled) {
    window.__dup = [];
    window.__cur = null;
    window.__curFirst = null;
    const origBegin = P.beginPath;
    P.beginPath = function (...a) { this.__curFirst = null; return origBegin.apply(this, a); };
    const origMove = P.moveTo;
    P.moveTo = function (x, y, ...rest) {
      if (!this.__curFirst) this.__curFirst = [x, y];
      return origMove.call(this, x, y, ...rest);
    };
    const origStroke = P.stroke;
    P.stroke = function (...a) {
      if (this.__curFirst) {
        window.__dup.push({ style: String(this.strokeStyle), alpha: this.globalAlpha,
                            lw: this.lineWidth, x: this.__curFirst[0], y: this.__curFirst[1] });
        this.__curFirst = null;
      }
      return origStroke.apply(this, a);
    };
    window.__dupInstalled = true;
  }

  sm.setTool('select');
  sm.selectedRiverId = null;
  sm.cameraScale = 0.35;
  sm.cameraX = 0;
  sm.cameraY = 0;
  await new Promise(r => setTimeout(r, 60));
  window.__dup = [];
  sm.render();

  const key = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
  const starts = {};
  for (const r of ((sm.baseMap || {}).rivers || [])) {
    if (!r || !r.points || r.points.length < 2) continue;
    if (String(r.id || '').indexOf('river_') === 0) continue;
    const k = key(r.points[0].x, r.points[0].y);
    (starts[k] = starts[k] || []).push(r.id);
  }
  const perRiver = {};
  let riverStrokes = 0;
  for (const rec of window.__dup) {
    if (rec.style !== '#5d97bb') continue;
    const k = key(rec.x, rec.y);
    if (!starts[k]) continue;
    riverStrokes++;
    const id = starts[k][0];
    perRiver[id] = perRiver[id] || { ids: starts[k], chunks: 0, alphas: new Set(), widths: [] };
    perRiver[id].chunks++;
    perRiver[id].alphas.add(rec.alpha);
    perRiver[id].widths.push(rec.lw);
  }
  const summary = Object.entries(perRiver).map(([id, v]) => ({
    id, chunks: v.chunks, alpha: [...v.alphas],
    wMin: Math.min(...v.widths), wMax: Math.max(...v.widths),
  }));
  return JSON.stringify({
    riversInData: Object.keys(starts).length, riversDrawn: summary.length,
    riverStrokes,
    chunkHistogram: summary.reduce((a, s) => { a[s.chunks] = (a[s.chunks] || 0) + 1; return a; }, {}),
    sample: summary.slice(0, 8),
    totalStrokes: window.__dup.length,
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
    bak = os.path.join(ROOT, 'backups', 'diag-river-dup-' + ts)
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

        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本'));"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(1.5)
        cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click();"
                 " return c ? 'ok' : 'none'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='编辑器')
        time.sleep(1.5)
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                 " if (b) { b.click(); return 'dismissed'; } return 'none'; })()")
        time.sleep(1.0)

        raw = cdp.eval(PROBE)
        data = json.loads(raw) if isinstance(raw, str) else raw
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, 'dup.json'), 'w', encoding='utf-8') as f:
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
