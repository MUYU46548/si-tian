#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实底图出图（**不是回归用例**）：把 `docs/mockups/desite.map` 走**产品自己的导入链**
导入，再出卡片墙 / 编辑器 / 拖笔预览的图。

为什么单独做一份：上一版故事线用的是**程序合成的 400 个波浪斑块**（为了压测烘焙耗时），
暮雨看完的评价是「比菌斑还丑，太怪了」—— 那是我的测试数据丑，不是司天画得丑。
这一版用真实底图（真实海岸线 + 133×75 高度图 + 160 条自带河 + 415 块省份），
图才代表产品实际长相。

做法：临时把 .map 放进 Vite 的 public 目录（`src/renderer/public/__real_desite.map`）让页面 fetch，
跑完（无论成败）删掉 —— 4.5MB 的临时件不许留在仓库里。
用法：py -3 scripts/tests/tools/_shot_story_real_20261017.py
输出：docs/assets/story-20261017-real/*.png
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
OUT_DIR = os.path.join(ROOT, 'docs', 'assets', 'story-20261017-real')
PIDFILE = os.path.join(ROOT, '.lab-pids.json')
PUBLIC_DIR = os.path.join(ROOT, 'src', 'renderer', 'public')
TMP_MAP = os.path.join(PUBLIC_DIR, '__real_desite.map')
SRC_MAP = os.path.join(ROOT, 'docs', 'mockups', 'desite.map')

STORY = r"""
(() => {
(async () => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const info = {};
  window.__storyInfo = info;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const S = async (name) => {
    window.__shots.push(name);
    const n = window.__shotAck + 1;
    const t0 = Date.now();
    while (window.__shotAck < n && Date.now() - t0 < 20000) await tick(40);
  };
  const sc = () => {
    const el = document.querySelector('.scenario-map-container');
    return el ? el.__vueParentComponent.setupState : null;
  };
  const clickText = (txt) => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes(txt));
    if (b) { b.click(); return true; }
    return false;
  };
  try {
    // ── ① 走产品的导入链把真实底图装进来 ──
    const AP = await import('/src/utils/azgaar-parser.js');
    const text = await (await fetch('/__real_desite.map')).text();
    info.mapBytes = text.length;
    const parsed = AP.parseMapFile(text);
    const NAME = '德斯特';
    const json = AP.buildScenariosJson(parsed, NAME, '当前');
    const bundle = json.baseMaps[NAME];
    info.bundle = { provinces: (bundle.terrain || []).length,
                    rivers: (bundle.rivers || []).length,
                    hCells: (bundle.heightmap && bundle.heightmap.h || []).length };
    s.importFromScenariosJson(json);
    await tick(2500);
    const sm = sc();
    sm.baseMapKey = NAME;
    if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
    await tick(1200);
    if (typeof sm.fitToView === 'function') sm.fitToView();
    await tick(600);
    info.imported = { baseMapKeys: Object.keys(s.baseMaps || {}),
                      terrain: (s.baseMaps[NAME] && s.baseMaps[NAME].terrain || []).length,
                      rivers: (s.baseMaps[NAME] && s.baseMaps[NAME].rivers || []).length };

    // ── ② 造 4 个时代：按省份 x 坐标分带指派势力（看起来像真历史地图）──
    const terrain = (s.baseMaps[NAME].terrain || []).filter((p) => p && p.kind !== 'sea' && p.id);
    let minX = Infinity, maxX = -Infinity;
    for (const p of terrain) for (const q of (p.points || [])) {
      const x = q.x === undefined ? q[0] : q.x;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
    }
    const span = Math.max(1, maxX - minX);
    const POL = [
      [{ id: 'E1', name: '西陵', color: '#c23b3b', abbr: '西' },
       { id: 'E2', name: '东海', color: '#4a90d9', abbr: '东' }],
      [{ id: 'F1', name: '北庭', color: '#5b8c5a', abbr: '北' },
       { id: 'F2', name: '南梁', color: '#b58a2b', abbr: '南' },
       { id: 'F3', name: '中州', color: '#7c5cbf', abbr: '中' }],
      [{ id: 'G1', name: '大晟', color: '#c23b3b', abbr: '晟' }],
      [{ id: 'H1', name: '后梁', color: '#4a90d9', abbr: '梁' },
       { id: 'H2', name: '西凉', color: '#5b8c5a', abbr: '凉' }],
    ];
    const ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'];
    const HOOK = ['西陵与东海隔河对峙，边镇岁岁易手。',
                  '三足鼎立：北庭据山，南梁拥江，中州守中原。',
                  '大晟一统，却把赋税压到了极限。',
                  '旧朝崩解，两镇各立朝廷。'];
    const OWN = [];
    POL.forEach((list, idx) => {
      const own = {};
      terrain.forEach((p, i) => {
        const pts = p.points || [];
        const cx = pts.reduce((a, q) => a + (q.x === undefined ? q[0] : q.x), 0) / Math.max(1, pts.length);
        const t = (cx - minX) / span;
        // 每代用不同的分带方式（有的东西对峙、有的三分、有的一统）
        let k = 0;
        if (list.length === 2) k = t < 0.45 ? 0 : 1;
        else if (list.length === 3) k = t < 0.33 ? 0 : (t < 0.66 ? 1 : 2);
        else k = 0;
        own[p.id] = list[k].id;
      });
      OWN.push(own);
    });
    s.removeAllScenarios();
    for (let i = 0; i < 4; i++) {
      const id = NAME + '/era' + i;
      s.createScenario(id, {
        ownerKey: NAME, name: '第' + (i + 1) + '纪', order: i + 1,
        era: { roman: ROMAN[i], label: '纪', startYear: String(1200 + i * 60), endYear: String(1260 + i * 60) },
        polities: POL[i], ownership: OWN[i], hook: HOOK[i],
      });
    }
    await tick(1200);
    info.scenarios = Object.keys(s.scenarios || {}).length;

    // ── ③ 回世界 → 进卡片墙（产品默认路径）──
    const back = document.querySelector('.scenario-toolbar .back-btn');
    if (back) { back.click(); await tick(600); }
    window.__SKIP_SCENARIO_PICKER = false;
    clickText('历史剧本');
    await tick(200);
    info.capsule = (() => {
      const el = document.querySelector('[data-testid="sp-progress"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim().replace(/\s+/g, ' '),
               cx: Math.round(r.left + r.width / 2), bottomGapPx: Math.round(innerHeight - r.bottom) };
    })();
    await S('01-real-picker-baking');
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if (!document.querySelector('[data-testid="sp-progress"]')
          && !document.querySelector('.sp-baking')) break;
      await tick(120);
    }
    info.bakedMs = Date.now() - t0;
    info.cards = document.querySelectorAll('[data-testid="sp-cards"] .sp-card').length;
    info.thumbColors = (() => {
      const cv = document.querySelector('[data-testid="sp-cards"] .sp-thumb canvas');
      if (!cv) return 0;
      const g = cv.getContext('2d');
      const d = g.getImageData(cv.width / 4, cv.height / 4, cv.width / 2, cv.height / 2).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    })();
    await S('02-real-picker-baked');

    // ── ④ 点第一张卡进编辑器（真实地形 + 势力着色）──
    const cards = Array.from(document.querySelectorAll('[data-testid="sp-cards"] .sp-card'));
    if (cards[0]) cards[0].click();
    await tick(2200);
    const sm2 = sc();
    info.editor = { terrain: (s.baseMaps[NAME].terrain || []).length,
                    scenario: sm2 && sm2.selectedScenario ? sm2.selectedScenario.name : null,
                    viewMode: sm2 && sm2.viewMode };
    await S('03-real-editor');

    // ── ⑤ 真实底图上拖一笔：预览 = 地块（本轮 WYSIWYG 的观感证据）──
    //    画在海面上（海区没有省份顶点 → 不触发压叠闸门，省得回答 confirm）
    sm2.setTool('draw');
    sm2.showMinimap = false;
    await tick(300);
    const cvs = sm2.canvas;
    const rc = cvs.getBoundingClientRect();
    const cx = rc.width * 0.30, cy = rc.height * 0.66, R = Math.min(rc.width, rc.height) * 0.16;
    const mk = (t, x, y) => new MouseEvent(t, { clientX: rc.left + x, clientY: rc.top + y,
      button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
    cvs.dispatchEvent(mk('mousedown', cx + R, cy));
    for (let i = 1; i <= 80; i++) {
      const a = (i / 80) * Math.PI * 2;
      const rr = R * (1 + 0.05 * Math.sin(a * 6));
      cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
    }
    await tick(200);
    const raw = (sm2.freeTrace || []).map((p) => ({ x: p.x, y: p.y }));
    const shape = sm2.freeTraceRing(raw, { snap: true });
    info.drawing = { rawPoints: raw.length, previewPts: shape ? shape.ring.length : 0 };
    await S('04-real-drawing-preview');
    // ⚠️ 到这里就收工：**不派发 mouseup**。真实底图 200 省 + 9975 格高度图下，落库会走
    //    「压叠闸门（200 省逐点多边形判定）→ 一条 undo → 全量项目保存（序列化 4.5MB 量级）」
    //    这条重链，实测会把页面主线程占用到 CDP 读超时（出图工具不值得为一张"落库后"的图
    //    冒这个风险；而且"落库 = 预览"已由 `test_113` 逐点相等证明）。
    window.__done = true;
  } catch (e) {
    window.__storyErr = String((e && e.stack) || e);
    window.__done = true;
  }
})();
return 'started';
})()
"""


def _start_edge():
    import run_tests as RT
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
    RT.setup_mock()
    _start_edge()
    try:
        cdp = CDP()
        # 🔴 `lib/cdp.py` 的读超时是 15s（回归用例刻意要短，超时就该红）。这个出图工具不同：
        #    真实底图（4.5MB / 200 省 / 9975 格高度）导入 + 4 条剧本的归属写入会**同步**占用
        #    主线程好几秒，轮询 eval 的响应有时超过 15s → 表现为 WebSocketTimeoutException。
        #    只在**本工具**里放宽读超时（不改共享 client，免得回归用例失去超时保护）。
        cdp.ws.settimeout(180)
        cdp.navigate('http://localhost:5180/?storyreal=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        ok, pinfo = open_harness_project(cdp)
        print('harness project:', ok, str(pinfo)[:140])
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本模式')
        time.sleep(1.0)
        ditched = cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                           ".find((x) => (x.textContent || '').includes('丢弃备份'));"
                           " if (b) { b.click(); return true; } return false; })()")
        print('recovery overlay dismissed:', ditched)
        time.sleep(0.6)
        cdp.eval("window.__shots = []; window.__shotAck = 0; window.__done = false; 'ok'")
        cdp.eval(STORY)
        deadline = time.time() + 420
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
                    print('🔴 故事线异常：', st['err'][:1200])
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
            os.rmdir(PUBLIC_DIR)     # 只在空目录时删得掉（本来就是临时建的）
        except OSError:
            pass


if __name__ == '__main__':
    sys.exit(main())
