#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机取证：真实项目（工作副本）上，用**真实鼠标**复现「涂归属涂不了 / 河流铁轨 / 侧栏收起」。

安全措施（与 diag_t2_save.py 同一套）：
  · 绝不写真实项目：复制成 work-copy.sitian，临时改 config.lastProjectPath 指它，finally 还原；
  · 只杀自己拉起的进程（electron 按 CDP 端口，vite 按自己 pid）。
用法：python scripts/tests/diag_owner_brush.py
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

CDP_PORT = 9224
DEV_PORT = 5180
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
OUT = os.path.join(ROOT, 'docs', 'assets', 'diag-owner-20261020')

PROBE = r"""
(() => {
  const el = document.querySelector('.scenario-map-container');
  const sm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
  if (!sm) return JSON.stringify({ err: 'no-scenario-map' });
  const s = sm.store;
  const sc = sm.selectedScenario;
  return JSON.stringify({
    key: sm.baseMapKey,
    terrain: (sm.baseMap && sm.baseMap.terrain || []).length,
    tool: sm.tool,
    scenario: sc && sc.name,
    scenarioId: sc && sc.id,
    ownerKey: sc && sc.ownerKey,
    polities: (sc && sc.polities || []).map(p => ({ id: p.id, name: p.name })).slice(0, 8),
    selectedPolity: sm.selectedPolity && sm.selectedPolity.name,
    ownershipCount: Object.keys((sc && sc.ownership) || {}).length,
    swatches: document.querySelectorAll('.polity-swatch:not(.clear)').length,
    hint: String(sm.provinceHint || ''),
    canvas: (() => { const c = sm.canvas; const r = c && c.getBoundingClientRect();
      return r ? [Math.round(r.width), Math.round(r.height)] : null; })(),
  });
})()
"""

# 取视口内、有几何的省：返回 {id, name, screen:{x,y}, world:{x,y}}
PICK = r"""
(() => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const s = sm.store;
  const c = sm.canvas;
  const rc = c.getBoundingClientRect();
  const out = [];
  const terr = (sm.baseMap && sm.baseMap.terrain) || [];
  for (const p of terr) {
    if (!p || !Array.isArray(p.points) || p.points.length < 3) continue;
    if (p.kind === 'sea') continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of p.points) {
      const x = q.x !== undefined ? q.x : q[0], y = q.y !== undefined ? q.y : q[1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const wx = (minX + maxX) / 2, wy = (minY + maxY) / 2;
    const sx = sm.cameraX + wx * sm.cameraScale, sy = sm.cameraY + wy * sm.cameraScale;
    if (sx < 60 || sy < 60 || sx > rc.width - 60 || sy > rc.height - 60) continue;
    out.push({ id: p.id, name: p.name, world: [wx, wy], screen: [Math.round(rc.left + sx), Math.round(rc.top + sy)] });
    if (out.length >= 6) break;
  }
  return JSON.stringify({ canvas: [Math.round(rc.width), Math.round(rc.height)], provinces: out });
})()
"""

STATE = r"""
(() => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sc = sm.selectedScenario;
  const own = (sc && sc.ownership) || {};
  return JSON.stringify({
    count: Object.keys(own).length,
    ownSample: Object.entries(own).slice(0, 6),
    geom: JSON.stringify(((sm.baseMap && sm.baseMap.terrain) || []).map(p => p.points)),
    hint: String(sm.provinceHint || ''),
    tool: sm.tool,
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


def node_exe():
    import shutil as _sh
    node = _sh.which('node')
    cand = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    return node, cand


def main():
    cfg_text = open(APP_CFG, encoding='utf-8').read()
    cfg = json.loads(cfg_text)
    real = cfg.get('lastProjectPath', '')
    if not real or not os.path.exists(real):
        print('配置里的 lastProjectPath 不存在：%r' % real)
        return 2
    ts = time.strftime('%Y%m%d-%H%M%S')
    bak = os.path.join(ROOT, 'backups', 'diag-owner-' + ts)
    os.makedirs(bak, exist_ok=True)
    shutil.copy2(APP_CFG, os.path.join(bak, 'config.json'))
    work = os.path.join(bak, 'work-copy.sitian')
    shutil.copy2(real, work)
    print('真实项目（只读）：%s' % real)
    print('工作副本：%s' % work)

    dev = el = None
    try:
        cfg['lastProjectPath'] = work
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)

        node, exe = node_exe()
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

        # 进入历史剧本（卡片墙）→ 第一张卡进入编辑器
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        time.sleep(1.5)
        cards = cdp.eval("JSON.stringify(Array.from(document.querySelectorAll('.sp-card'))"
                         ".map(e => (e.textContent || '').trim().slice(0, 30)).slice(0, 6))")
        print('卡片候选：', cards)
        cdp.eval("(() => { const c = document.querySelector('.sp-card');"
                 " if (c) c.click(); return c ? 'ok' : 'none'; })()")
        try:
            wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='编辑器')
        except Exception:
            print('没能进入剧本编辑器；当前 DOM：')
            print(cdp.eval("document.body.innerText.slice(0, 600)"))
            return 1
        time.sleep(1.5)
        # 工作副本会带着 .backups 基线 → 恢复面板盖住画布。先丢弃（只影响副本）。
        had = cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                       " if (b) { b.click(); return 'dismissed'; } return 'none'; })()")
        if had == 'dismissed':
            time.sleep(1.2)
            print('已丢弃恢复备份（副本）')
        print('\n== 初始状态 ==')
        print(cdp.eval(PROBE))

        pick = json.loads(cdp.eval(PICK))
        print('\n视口内省份（可画的中心点）：')
        for p in pick['provinces']:
            print('  ', p['id'], p['name'], p['screen'])
        if len(pick['provinces']) < 2:
            print('视口内可画省份不足 2 个，先缩放到合适位置再试')
            return 1

        # 真鼠标：点第一个势力色块
        cdp.eval("(() => { const b = document.querySelector('.polity-swatch:not(.clear)');"
                 " if (b) b.click(); return b ? 'ok' : 'none'; })()")
        time.sleep(0.4)
        print('\n选势力后：', cdp.eval(PROBE))

        # 真鼠标：点「涂归属」
        cdp.eval("(() => { const b = document.querySelector('[data-testid=owner-brush-btn]');"
                 " if (b) b.click(); return b ? 'ok' : 'none'; })()")
        time.sleep(0.4)
        print('切工具后：', cdp.eval(PROBE))

        before = json.loads(cdp.eval(STATE))
        # ⚠️ 切工具会多出一行设置（画布高度 484→415）—— 坐标必须在**切完之后**重新取，
        #    否则点会落在画布外（第一次取证就踩了：坐标 501 > 画布高 415，静默没反应）。
        pick2 = json.loads(cdp.eval(PICK))
        print('\n切工具后视口内省份：', [p['screen'] for p in pick2['provinces']])
        if len(pick2['provinces']) < 2:
            print('视口内可画省份不足 2 个')
            return 1
        a = pick2['provinces'][0]['screen']
        b = pick2['provinces'][1]['screen']
        hit = cdp.eval("""(() => {
          const el = document.elementFromPoint(%d, %d);
          const cvs = document.querySelector('.scenario-map-container canvas');
          const r = cvs.getBoundingClientRect();
          return JSON.stringify({ top: el ? (el.tagName + '.' + el.className) : null,
            isCanvas: el === cvs, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            dpr: window.devicePixelRatio, zoom: window.outerWidth / window.innerWidth });
        })()""" % (a[0], a[1]))
        print('落点元素：', hit)
        print('\n拖动：(%s,%s) → (%s,%s)' % (a[0], a[1], b[0], b[1]))
        t0 = time.time()
        cdp.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': a[0], 'y': a[1],
                                              'button': 'left', 'buttons': 1, 'clickCount': 1})
        for i in range(1, 7):
            cdp.send('Input.dispatchMouseEvent', {
                'type': 'mouseMoved',
                'x': round(a[0] + (b[0] - a[0]) * i / 6),
                'y': round(a[1] + (b[1] - a[1]) * i / 6),
                'button': 'left', 'buttons': 1,
            })
            time.sleep(0.05)
        cdp.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': b[0], 'y': b[1],
                                              'button': 'left', 'buttons': 0, 'clickCount': 1})
        t1 = time.time()
        time.sleep(0.6)
        after = json.loads(cdp.eval(STATE))
        print('\n拖动耗时 %.0fms' % ((t1 - t0) * 1000))
        print('涂之前 ownership =', before['count'], ' 涂之后 =', after['count'])
        print('状态栏：', after['hint'])
        print('省界是否变化：', 'YES（坏了）' if after['geom'] != before['geom'] else 'NO（正确）')
        print('新增归属样例：', after['ownSample'])

        # 性能拆账：整帧 render vs 一次批量写（415 省真实数据）
        perf = cdp.eval(r"""
        (() => {
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          const s = sm.store;
          const sc = sm.selectedScenario;
          const ids = Object.keys((sm.baseMap.terrain || []).reduce((a, p) => { a[p.id] = 1; return a; }, {})).slice(0, 30);
          const times = [];
          for (let i = 0; i < 6; i++) {
            const t0 = performance.now(); sm.render(); times.push(performance.now() - t0);
          }
          times.sort((a, b) => a - b);
          const t1 = performance.now();
          const r = s.batchSetOwnership(sc.id, ids, 'pol_ou', null);
          const t2 = performance.now();
          return JSON.stringify({ frameMedian: Math.round(times[3] * 10) / 10,
            frameAll: times.map(x => Math.round(x * 10) / 10),
            batchMs: Math.round((t2 - t1) * 10) / 10, batch: r });
        })()
        """)
        print('性能：', perf)

        # 河流截图（放大 4×，对准一条河的中段）
        os.makedirs(OUT, exist_ok=True)
        shot = cdp.eval(r"""
        (async () => {
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          const rivers = (sm.baseMap && sm.baseMap.rivers) || [];
          const r = rivers[0];
          if (!r || !r.points || r.points.length < 3) return 'no-river';
          const p = r.points[Math.floor(r.points.length / 2)];
          const x = p.x !== undefined ? p.x : p[0], y = p.y !== undefined ? p.y : p[1];
          const c = sm.canvas.getBoundingClientRect();
          sm.cameraScale = 4;
          sm.cameraX = c.width / 2 - x * 4;
          sm.cameraY = c.height / 2 - y * 4;
          sm.setTool('select');
          sm.render();
          return JSON.stringify({ id: r.id, pts: r.points.length });
        })()
        """)
        time.sleep(0.8)
        print('\n河流探针：', shot, '河流数：', cdp.eval(
            "String(((document.querySelector('.scenario-map-container').__vueParentComponent.setupState.baseMap||{}).rivers||[]).length)"))
        s = cdp.send('Page.captureScreenshot', {'format': 'png'})
        shot_path = os.path.join(OUT, 'river-4x.png')
        open(shot_path, 'wb').write(base64.b64decode(s['data']))
        print('截图：', shot_path)
        # 1× 全景（用户实际看的档位）
        cdp.eval(r"""
        (() => {
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          const rivers = (sm.baseMap && sm.baseMap.rivers) || [];
          const r = rivers[0];
          const p = r.points[Math.floor(r.points.length / 2)];
          const x = p.x !== undefined ? p.x : p[0], y = p.y !== undefined ? p.y : p[1];
          const c = sm.canvas.getBoundingClientRect();
          sm.cameraScale = 1;
          sm.cameraX = c.width / 2 - x;
          sm.cameraY = c.height / 2 - y;
          sm.render();
          return 'ok';
        })()
        """)
        time.sleep(0.8)
        s2 = cdp.send('Page.captureScreenshot', {'format': 'png'})
        p2 = os.path.join(OUT, 'river-1x.png')
        open(p2, 'wb').write(base64.b64decode(s2['data']))
        print('截图：', p2)
        # 🔴 决定性探针：关掉矢量河图层再截一张。若河还在 → 我们看到的是**底图里烤进去的**
        #    （.map 的 SVG 栅格），矢量渲染根本不参与 —— 那所有"改画法"都不可能在屏幕上生效。
        cdp.eval("(() => { const sm = document.querySelector('.scenario-map-container')"
                 ".__vueParentComponent.setupState; sm.showRivers = false; sm.render(); return 'ok'; })()")
        time.sleep(0.8)
        s3 = cdp.send('Page.captureScreenshot', {'format': 'png'})
        p3 = os.path.join(OUT, 'river-1x-vector-off.png')
        open(p3, 'wb').write(base64.b64decode(s3['data']))
        print('截图（矢量河关闭）：', p3)
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
