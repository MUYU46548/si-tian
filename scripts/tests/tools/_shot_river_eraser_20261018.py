#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""出图（**不是回归用例**）：河流的「预览＝落库」与橡皮擦断（2026-10-18 第十八修）。

四张图：
  01 拖笔中 —— 预览就是松手会得到的那条河（宽度也是落库宽度，不再是细发丝）
  02 松手落库 —— 形状与原样一致（对比 01 的轮廓位置）
  03 橡皮擦到一半 —— 半透明红色擦除轨迹 + 笔尖圈（判据半径与视觉同一个常量）
  04 抬手 —— 河被擦断成两条（断口在橡皮圈边上），一次撤销可整体回退

底图用**真实** `docs/mockups/desite.map`（走产品导入链）—— 合成底图看着不像地图，
观感类产物必须用真数据（这是本仓的老教训）。
用法：py -3 scripts/tests/tools/_shot_river_eraser_20261018.py
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

DEV_PORT = 5180
CDP_PORT = 9222
EDGE_EXE = r'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
OUT_DIR = os.path.join(ROOT, 'docs', 'assets', 'river-eraser-20261018')
PIDFILE = os.path.join(ROOT, '.lab-pids.json')
PUBLIC_DIR = os.path.join(ROOT, 'src', 'renderer', 'public')
TMP_MAP = os.path.join(PUBLIC_DIR, '__real_desite.map')
SRC_MAP = os.path.join(ROOT, 'docs', 'mockups', 'desite.map')

STORY = r"""
(() => {
(async () => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const S = async (name) => {
    window.__shots.push(name);
    const n = window.__shotAck + 1;
    const t0 = Date.now();
    while (window.__shotAck < n && Date.now() - t0 < 20000) await tick(40);
  };
  const info = {};
  window.__storyInfo = info;
  try {
    // ① 真实底图（产品导入链）
    const AP = await import('/src/utils/azgaar-parser.js');
    const text = await (await fetch('/__real_desite.map')).text();
    const NAME = '德斯特';
    s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
    await tick(2500);
    const el = document.querySelector('.scenario-map-container');
    const sm = el.__vueParentComponent.setupState;
    sm.baseMapKey = NAME;
    if (sm.onBaseMapChange) await sm.onBaseMapChange();
    await tick(1200);
    sm.showMinimap = false;
    sm.showRoutes = false;
    sm.colorMode = 'none';        // 关掉右下角那块文化/宗教图例（它会盖住半个画布）
    if (sm.fitToView) sm.fitToView();
    await tick(500);
    // 相机：对准地图中部 + 1.4×（41% 的适屏档下河只有几个像素，观感类产物看不清）
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const t of (s.baseMaps[NAME].terrain || [])) {
      for (const q of (t.points || [])) {
        const x = q.x === undefined ? q[0] : q.x, y = q.y === undefined ? q[1] : q.y;
        if (x < mnx) mnx = x; if (y < mny) mny = y;
        if (x > mxx) mxx = x; if (y > mxy) mxy = y;
      }
    }
    const cvs0 = sm.canvas;
    const rc0 = cvs0.getBoundingClientRect();
    const SC = 1.4;
    const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    // ⚠️ 相机只按**一次**、且在拖笔之前：底图装载后的收尾逻辑会适屏（41%），
    //    而那之后再改相机会让"预览=落库"这条不变量失效 —— `px()` 跟着相机走，
    //    拖笔中途改相机 = 落库时按新相机重算（实测：预览 32 点 / 落库 72 点）。
    //    出图脚本不该制造这种假象，所以按定就位、之后一动不动。
    const applyCam = () => {
      sm.cameraScale = SC;
      sm.cameraX = rc0.width / 2 - cx * SC;
      sm.cameraY = rc0.height / 2 - cy * SC;
      sm.render();
    };
    applyCam();
    await tick(400);
    applyCam();          // 收尾逻辑若又适屏了一次，这里再按住（之后不再动相机）
    await tick(300);
    const cvs = sm.canvas;
    const rc = cvs.getBoundingClientRect();
    const mk = (t, x, y) => new MouseEvent(t, { clientX: rc.left + x, clientY: rc.top + y, button: 0,
      buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
    info.canvas = [Math.round(rc.width), Math.round(rc.height)];

    // ② 拖一条河（不松手）→ 预览就是最终形状
    sm.setTool('river');
    await tick(200);
    const pts = [];
    const x0 = rc.width * 0.14, y0 = rc.height * 0.62, x1 = rc.width * 0.58, y1 = rc.height * 0.72;
    for (let i = 0; i <= 70; i++) {
      const t = i / 70;
      pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t + Math.sin(t * 6) * 26 });
    }
    cvs.dispatchEvent(mk('mousedown', pts[0].x, pts[0].y));
    for (let i = 1; i < pts.length; i++) cvs.dispatchEvent(mk('mousemove', pts[i].x, pts[i].y));
    await tick(200);
    info.preview = (sm.riverPreviewNodes() || []).length;
    await S('01-preview-equals-landed');
    cvs.dispatchEvent(mk('mouseup', pts[pts.length - 1].x, pts[pts.length - 1].y));
    await tick(600);
    const list = (s.baseMaps[NAME].rivers || []).filter((r) => String(r.id).indexOf('river_') === 0);
    info.landed = list.length ? list[list.length - 1].points.length : 0;
    await S('02-landed');

    // ③ 橡皮擦到一半
    sm.setTool('riverErase');
    await tick(200);
    const er = list[list.length - 1];
    const mid = er.points[Math.floor(er.points.length / 2)];
    const sp = sm.worldToScreen(mid.x, mid.y);
    const a = { x: sp.x - 90, y: sp.y - 70 }, b = { x: sp.x + 90, y: sp.y + 70 };
    cvs.dispatchEvent(mk('mousedown', a.x, a.y));
    for (let i = 1; i <= 12; i++) {
      cvs.dispatchEvent(mk('mousemove', a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12));
    }
    await tick(200);
    await S('03-erase-trail');
    cvs.dispatchEvent(mk('mouseup', b.x, b.y));
    await tick(700);
    const after = (s.baseMaps[NAME].rivers || []).filter((r) => String(r.id).indexOf('river_') === 0);
    info.afterErase = after.length;
    info.status = (document.querySelector('.draw-hint') || {}).textContent || '';
    await S('04-erased-split');
    // 撤销一次验证
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick(600);
    info.afterUndo = (s.baseMaps[NAME].rivers || []).filter((r) => String(r.id).indexOf('river_') === 0).length;
    window.__done = true;
  } catch (e) {
    window.__storyErr = String((e && e.stack) || e);
    window.__done = true;
  }
})();
return 'started';
})()
"""


def _start():
    import run_tests as RT
    RT.setup_mock()
    RT.free_port(DEV_PORT)
    dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not RT.wait_port(DEV_PORT):
        raise RuntimeError('vite 起不来')
    RT.free_port(CDP_PORT)
    edge = subprocess.Popen([
        EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
        '--remote-debugging-port=%d' % CDP_PORT, '--remote-allow-origins=*',
        '--user-data-dir=%s' % os.path.join(ROOT, '.lab-edge-profile'),
        '--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--disable-features=SyncConsentUI,SigninCheckoutFlow', '--no-sandbox', 'about:blank',
    ])
    if not RT.wait_port(CDP_PORT):
        raise RuntimeError('edge 起不来')
    with open(PIDFILE, 'w') as f:
        json.dump({'dev': dev.pid, 'edge': edge.pid}, f)


def _stop():
    import run_tests as RT
    if os.path.exists(PIDFILE):
        with open(PIDFILE) as f:
            pids = json.load(f)
        for pid in pids.values():
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
        os.remove(PIDFILE)
    RT.free_port(DEV_PORT)
    RT.free_port(CDP_PORT)
    RT.teardown_mock()


def main():
    import run_tests as RT
    from lib.cdp import CDP, wait_for
    from lib.helpers import open_harness_project

    if not os.path.exists(SRC_MAP):
        print('🔴 找不到真实底图：', SRC_MAP)
        return 1
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    shutil.copyfile(SRC_MAP, TMP_MAP)
    os.makedirs(OUT_DIR, exist_ok=True)
    _start()
    try:
        cdp = CDP()
        cdp.ws.settimeout(180)
        cdp.navigate('http://localhost:5180/?erasershot=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        ok, pinfo = open_harness_project(cdp)
        print('harness project:', ok, str(pinfo)[:120])
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本模式')
        time.sleep(1.0)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find((x) => (x.textContent || '').includes('\u4e22\u5f03\u5907\u4efd'));"
                 " if (b) { b.click(); return true; } return false; })()")
        time.sleep(0.6)
        cdp.eval("window.__shots = []; window.__shotAck = 0; window.__done = false;"
                 " window.confirm = () => true; 'ok'")
        cdp.eval(STORY)
        deadline = time.time() + 300
        info = {}
        while time.time() < deadline:
            st = cdp.eval("JSON.stringify({shots: window.__shots || [], ack: window.__shotAck || 0,"
                          "done: !!window.__done, err: window.__storyErr || '',"
                          "info: window.__storyInfo || {}})")
            if isinstance(st, dict) and '__err__' in st:
                print('页面求值异常：', st)
                break
            st = json.loads(st)
            info = st['info']
            if st['ack'] < len(st['shots']):
                name = st['shots'][st['ack']]
                png = cdp.send('Page.captureScreenshot', {'format': 'png'})
                path = os.path.join(OUT_DIR, '%s.png' % name)
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(png['data']))
                print('shot ->', os.path.relpath(path, ROOT))
                cdp.eval('window.__shotAck = %d; "ok"' % (st['ack'] + 1))
            if st['done'] and st['ack'] >= len(st['shots']):
                if st['err']:
                    print('🔴 故事线异常：', st['err'][:800])
                break
            time.sleep(0.15)
        else:
            print('🔴 故事线超时（未走完）')
        print('=== 读数 ===')
        print(json.dumps(info, ensure_ascii=False, indent=1))
        cdp.close()
        return 0
    finally:
        _stop()
        try:
            os.remove(TMP_MAP)
        except OSError:
            pass
        try:
            os.rmdir(PUBLIC_DIR)
        except OSError:
            pass


if __name__ == '__main__':
    sys.exit(main())


