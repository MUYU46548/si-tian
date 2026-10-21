#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机取证：河流放大后「两条蓝线夹一条缝」到底存不存在、在哪一档出现。

方法（不猜）：
  · 用真实项目的工作副本起 Electron + Vite（不碰真实项目）；
  · 取最长的 N 条导入河，在 1×/2×/4×/8×/16× 下把相机对准河中段；
  · 沿河道每 ~6 屏幕像素取一条**法线横截面**（±14px），统计：
      - 有水的站点数
      - "水…陆…水"（中间出现 ≥1px 非水）的站点数 = 用户说的"两条线夹一条缝"
      - 每个站点水带总宽 / 峰值数
  · 同时截 8×/16× 图供肉眼复核。

用法：python scripts/tests/diag_river_scan.py
产物：docs/assets/diag-river-hollow-20261021/
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

SCAN = r"""
(async () => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const cvs = sm.canvas;
  const g = cvs.getContext('2d', { willReadFrequently: true });
  const rivers = ((sm.baseMap || {}).rivers || [])
    .filter(r => r && r.points && r.points.length >= 6 && String(r.id || '').indexOf('river_') !== 0)
    .map(r => {
      let L = 0;
      for (let i = 0; i + 1 < r.points.length; i++) L += Math.hypot(r.points[i+1].x-r.points[i].x, r.points[i+1].y-r.points[i].y);
      return { r, L };
    })
    .sort((a, b) => b.L - a.L)
    .slice(0, 6)
    .map(x => x.r);

  sm.setTool('select');
  sm.selectedRiverId = null;
  if (typeof sm.render !== 'function') return JSON.stringify({ err: 'no-render' });

  const isWater = (d) => d[2] > 115 && (d[2] - d[0]) > 25 && (d[2] - d[1]) > -30;
  const out = { zooms: {}, rivers: rivers.map(r => r.id), canvas: [cvs.width, cvs.height] };

  for (const z of [1, 2, 4, 8, 16]) {
    const stat = { stations: 0, wet: 0, gap: 0, gapSamples: [], multiPeak: 0, widths: [] };
    for (const r of rivers) {
      const pts = r.points;
      // 取中段 40% 的区间（避开被海岸线裁掉的河口）
      const i0 = Math.floor(pts.length * 0.3), i1 = Math.floor(pts.length * 0.7);
      const mid = pts[Math.floor((i0 + i1) / 2)];
      const rect = cvs.getBoundingClientRect();
      sm.cameraScale = z;
      sm.cameraX = rect.width / 2 - mid.x * z;
      sm.cameraY = rect.height / 2 - mid.y * z;
      sm.render();
      await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));
      // 每 ~6 屏幕像素一个站点
      let acc = 0;
      for (let i = i0 + 1; i < i1; i++) {
        const a = pts[i - 1], b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.y - a.y) * z;
        acc += seg;
        if (acc < 6) continue;
        acc = 0;
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.max(1e-9, Math.hypot(dx, dy));
        const nx = -dy / L, ny = dx / L;
        const cx = sm.cameraX + b.x * z, cy = sm.cameraY + b.y * z;
        const pattern = [];
        for (let t = -14; t <= 14; t++) {
          const sx = Math.round(cx + nx * t), sy = Math.round(cy + ny * t);
          if (sx < 0 || sy < 0 || sx >= cvs.width || sy >= cvs.height) { pattern.push(null); continue; }
          const d = g.getImageData(sx, sy, 1, 1).data;
          pattern.push(isWater(d) ? 1 : 0);
        }
        if (!pattern.includes(1)) continue;
        stat.stations++;
        stat.wet++;
        // 找水 run
        const runs = [];
        let run = 0;
        for (const v of pattern) {
          if (v === 1) run++;
          else if (run) { runs.push(run); run = 0; }
        }
        if (run) runs.push(run);
        const total = runs.reduce((a, b) => a + b, 0);
        stat.widths.push(total);
        if (runs.length >= 2) {
          stat.multiPeak++;
          // 只有"两条窄带"才像用户说的（总宽 < 14px 且中间缝 < 6px）
          if (runs.length === 2 && total <= 14) {
            stat.gap++;
            if (stat.gapSamples.length < 8) stat.gapSamples.push({ river: r.id, i, total, runs, pattern: pattern.join('') });
          }
        }
      }
    }
    stat.widthMedian = stat.widths.length ? stat.widths.slice().sort((a,b)=>a-b)[Math.floor(stat.widths.length/2)] : 0;
    stat.widthMax = stat.widths.length ? Math.max(...stat.widths) : 0;
    delete stat.widths;
    out.zooms[z] = stat;
  }
  return JSON.stringify(out);
})()
"""

SHOT_JS = r"""
(async () => {
  const z = %d;
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const cvs = sm.canvas;
  const rivers = ((sm.baseMap || {}).rivers || []).filter(r => r && r.points && r.points.length >= 6
      && String(r.id || '').indexOf('river_') !== 0);
  let best = null, bl = -1;
  for (const r of rivers) {
    let L = 0;
    for (let i = 0; i + 1 < r.points.length; i++) L += Math.hypot(r.points[i+1].x-r.points[i].x, r.points[i+1].y-r.points[i].y);
    if (L > bl) { bl = L; best = r; }
  }
  const p = best.points[Math.floor(best.points.length * 0.5)];
  const rect = cvs.getBoundingClientRect();
  sm.setTool('select');
  sm.selectedRiverId = null;
  sm.cameraScale = z;
  sm.cameraX = rect.width / 2 - p.x * z;
  sm.cameraY = rect.height / 2 - p.y * z;
  sm.render();
  await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));
  return JSON.stringify({ river: best.id, zoom: z, at: [p.x, p.y] });
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
    bak = os.path.join(ROOT, 'backups', 'diag-river-scan-' + ts)
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

        raw = cdp.eval(SCAN)
        data = json.loads(raw) if isinstance(raw, str) else raw
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, 'scan.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print('rivers:', data.get('rivers'), 'canvas:', data.get('canvas'))
        for z, s in (data.get('zooms') or {}).items():
            print('== zoom %s  stations=%s  双带=%s  中间有缝=%s  宽度中位=%s 最大=%s'
                  % (z, s.get('stations'), s.get('multiPeak'), s.get('gap'),
                     s.get('widthMedian'), s.get('widthMax')))
            for g in (s.get('gapSamples') or [])[:4]:
                print('     gap:', g['river'], g['i'], 'total', g['total'], 'runs', g['runs'])
                print('          ', g['pattern'])

        for z in (8, 16):
            info = cdp.eval(SHOT_JS % z)
            if isinstance(info, str):
                try:
                    info = json.loads(info)
                except Exception:
                    pass
            time.sleep(0.8)
            shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
            p = os.path.join(OUT, 'river-%dx.png' % z)
            open(p, 'wb').write(base64.b64decode(shot['data']))
            print('shot', info, '->', p)
        return 0
    finally:
        if el is not None:
            subprocess.run(['taskkill', '/PID', str(el.pid), '/T', '/F'], capture_output=True)
        if dev is not None:
            subprocess.run(['taskkill', '/PID', str(dev.pid), '/T', '/F'], capture_output=True)
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            f.write(cfg_text)
        print('已还原配置；工作副本留在：%s' % bak)


if __name__ == '__main__':
    sys.exit(main())
