#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""观感验证出图（**不是回归用例**，用完全删）：一条故事线里按节点出多张图。

为什么需要它（而不是 `_lab.py run <file>`）：lab 一次只出**最后一张**图，而本轮要看的
恰恰全是**过程态** ——
  · 卡片墙刚挂载时的那枚「正在生成地图缩略图 N / M」进度胶囊（烘完就消失）；
  · 空态（没有底图）与编辑器空态里的两个真按钮；
  · 选中河流的高亮在 **1× 与 4×** 缩放下到底有多粗（上一轮改成屏幕像素口径后
    只跑过用例，暮雨还没确认过观感）。
所以出图时机由 Python 侧控制：页面把请求的图名压进 `window.__shots`，Python 轮询到就
`Page.captureScreenshot`，然后 `__shotAck++` 放行页面继续。页面侧的 async 故事线用
**不 await 的方式**启动（`(() => { (async () => …)(); return 'started'; })()`）——
`cdp.eval` 会 awaitPromise，直接 await 故事线就会把 Python 侧堵死，出图时机也就无从谈起。

用法：
    py -3 scripts/tests/tools/_shot_story_20261017.py          # 起 Vite + Edge，跑完整故事线，跑完收工
    py -3 scripts/tests/tools/_shot_story_20261017.py --keep   # 跑完**不杀**进程（手工接着看）
输出：`docs/assets/story-20261017/NN-<name>.png` + 一份读数 JSON（打到 stdout）
"""
import base64
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

DEV_PORT = 5180
CDP_PORT = 9222
EDGE_EXE = r'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
OUT_DIR = os.path.join(ROOT, 'docs', 'assets', 'story-20261017')
PIDFILE = os.path.join(ROOT, '.lab-pids.json')

# ─────────────────────────────────────────────────────────────
# 页面侧故事线（**不 await 启动**；每张图前调 S('name') 等 Python 拍完）
# ─────────────────────────────────────────────────────────────
STORY = r"""
(() => {
(async () => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const info = { steps: [] };
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
  const btn = (sel) => document.querySelector(sel);
  const clickText = (txt) => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((x) => (x.textContent || '').includes(txt));
    if (b) { b.click(); return true; }
    return false;
  };
  const waitUntil = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await tick(60); }
    return false;
  };
  try {
    // ── 造一张「有点重量」的底图：400 省 × 100 点（烘焙成本接近真实底图量级）
    //    为什么故意造重：进度胶囊只在烘焙期间存在，图太轻就永远拍不到它。
    const KEY = 'storyMap';
    const provs = [], gpts = [], h = [];
    const COLS = 100, ROWS = 60, SP = 20, GX0 = -1000, GY0 = -600;
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      gpts.push({ x: GX0 + i * SP, y: GY0 + j * SP });
      h.push(Math.max(0, Math.round(80 - Math.hypot(i - 50, j - 30) * 1.6 + 8 * Math.sin(i / 4) * Math.cos(j / 5))));
    }
    const PAL = ['#8a6b4f', '#7d8a5a', '#9a8f6a', '#6f7f5a'];
    for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
      const x0 = GX0 + i * 100, y0 = GY0 + j * 60;
      const pts = [];
      for (let k = 0; k < 100; k++) {
        const a = (k / 100) * Math.PI * 2;
        const rr = 44 + 6 * Math.sin(3 * a + i) * Math.cos(2 * a + j);
        pts.push({ x: x0 + 50 + Math.cos(a) * rr, y: y0 + 30 + Math.sin(a) * rr * 0.6 });
      }
      provs.push({ id: 'p' + j + '_' + i, name: '省' + j + '-' + i, kind: 'land',
                   color: PAL[(i + j) % PAL.length], points: pts, biome: 'temperate' });
    }
    s.baseMaps = { ...s.baseMaps, [KEY]: {
      id: KEY, name: '故事底图', terrain: provs, referenceImages: [],
      heightmap: { h, grid: { points: gpts, cellsX: COLS, cellsY: ROWS, spacing: SP } },
      rivers: [], routes: [], burgs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } };
    // 10 条剧本（卡越多，烘焙越久 → 进度胶囊越拍得到）
    for (let i = 0; i < 10; i++) {
      const id = KEY + '/era' + i;
      if (s.scenarios[id]) s.removeScenario(id);
      s.createScenario(id, {
        ownerKey: KEY, name: '第 ' + (i + 1) + ' 时代', order: i + 1,
        era: { roman: ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ'][i], label: '时代', startYear: String(1000 + i * 50), endYear: String(1050 + i * 50) },
        polities: [{ id: 'P' + i, name: '势力 ' + (i + 1), color: ['#c23b3b','#4a90d9','#5b8c5a','#b58a2b'][i % 4] }],
        ownership: Object.fromEntries(provs.filter((p, k) => k % 4 === i % 4).map((p) => [p.id, 'P' + i])),
        hook: '这是第 ' + (i + 1) + ' 个时代的钩子文案，用来验证卡片排版。',
      });
    }
    info.setup = { provinces: provs.length, scenKey: Object.keys(s.scenarios || {}).length };

    // ── b 进卡片墙（harness 的跳过开关关掉 = 走产品默认路径）──
    const back = btn('.scenario-toolbar .back-btn');
    if (back) back.click();
    await tick(500);
    window.__SKIP_SCENARIO_PICKER = false;
    clickText('历史剧本');
    await tick(150);          // 刚挂载：烘焙刚开始
    info.capsule = (() => {
      const el = btn('[data-testid="sp-progress"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim().replace(/\s+/g, ' '),
               cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
               bottomGapPx: Math.round(innerHeight - r.bottom), vw: innerWidth, vh: innerHeight };
    })();
    // 🔴 盖没盖住：用**点位命中**证明，不是看 CSS（左侧导航树中心点此刻必须被卡片墙接住）
    info.cover = (() => {
      const nav = document.querySelector('.tree-navigation') || document.querySelector('aside') || null;
      const picker = btn('[data-testid="scenario-picker"]');
      const pr = picker ? picker.getBoundingClientRect() : null;
      const navR = nav ? nav.getBoundingClientRect() : null;
      const hitAt = (x, y) => {
        const el = document.elementFromPoint(Math.round(x), Math.round(y));
        if (!el || !picker) return null;
        return picker.contains(el) ? 'picker' : (el.tagName + '.' + (el.className || ''));
      };
      return {
        hasNav: !!nav,
        navRect: navR ? [Math.round(navR.left), Math.round(navR.top), Math.round(navR.width), Math.round(navR.height)] : null,
        pickerRect: pr ? [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)] : null,
        navCenterHit: navR ? hitAt(navR.left + navR.width / 2, navR.top + navR.height / 2) : null,
        bottomLeftHit: hitAt(6, innerHeight - 6),
        inMainContent: !!(picker && picker.closest('.main-content')),
      };
    })();
    await S('01-picker-baking');

    await waitUntil(() => !btn('[data-testid="sp-progress"]') && document.querySelectorAll('.sp-baking').length === 0, 20000);
    info.bakedCards = document.querySelectorAll('[data-testid="sp-cards"] .sp-card').length;
    await S('02-picker-baked');

    // ── c 点一张卡进编辑器 ──
    const cards = Array.from(document.querySelectorAll('[data-testid="sp-cards"] .sp-card'));
    if (cards[2]) cards[2].click();
    await tick(1500);
    info.editor = { mounted: !!sc(), slpPicker: !!btn('[data-testid="slp-picker"]'),
                    imbPickerInDom: !!btn('[data-testid="imb-picker"]') };
    await S('03-editor');

    // ── d 换剧本 → 第二次进卡片墙（应纯命中缓存、立刻完整）──
    const mod = await import('/src/utils/scenarioThumb.js');
    const st0 = mod.thumbCacheStats();
    const t0 = performance.now();
    if (btn('[data-testid="slp-picker"]')) btn('[data-testid="slp-picker"]').click();
    await tick(60);
    info.secondEntry = {
      statsBefore: st0, statsAfter: mod.thumbCacheStats(),
      msToComplete: Math.round((performance.now() - t0) * 10) / 10,
      bakingLeft: document.querySelectorAll('.sp-baking').length,
      cards: document.querySelectorAll('[data-testid="sp-cards"] .sp-card').length,
      progressGone: !btn('[data-testid="sp-progress"]'),
    };
    await S('04-picker-cached');

    // ── e 空态：把底图与剧本清掉（这一张要看"没有底图时说什么"）──
    const bmSnap = JSON.parse(JSON.stringify(s.baseMaps || {}));
    const scSnap = JSON.parse(JSON.stringify(s.scenarios || {}));
    Object.keys(s.baseMaps || {}).forEach((k) => delete s.baseMaps[k]);
    Object.keys(s.scenarios || {}).forEach((k) => delete s.scenarios[k]);
    await tick(400);
    info.pickerEmpty = {
      noBasemapText: !!btn('[data-testid="sp-empty-nobasemap"]'),
      text: ((btn('.sp-empty') || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      hasEditorBtn: !!btn('[data-testid="sp-empty-editor"]'),
    };
    await S('05-picker-empty');

    // ── f 编辑器空态：两个按钮必须看得见、点得动 ──
    if (btn('[data-testid="sp-empty-editor"]')) btn('[data-testid="sp-empty-editor"]').click();
    await tick(600);
    const imp = btn('[data-testid="empty-import-map"]');
    const neu = btn('[data-testid="empty-new-basemap"]');
    info.editorEmpty = {
      hintShown: !!btn('[data-testid="scenario-empty-hint"]'),
      importBtn: !!imp, newBtn: !!neu,
      importPointerEvents: imp ? getComputedStyle(imp).pointerEvents : null,
      importRect: imp ? (() => { const r = imp.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() : null,
      // 真点得到吗：拿"按钮中心的点"去问 elementFromPoint 是谁
      importHitTarget: imp ? (() => { const r = imp.getBoundingClientRect();
        const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return el ? (el.tagName + (el === imp ? '=按钮本身' : '')) : null; })() : null,
    };
    await S('06-editor-empty');

    // 还原数据（后面还要看河，且不留脏状态）
    Object.keys(s.baseMaps || {}).forEach((k) => delete s.baseMaps[k]);
    Object.keys(s.scenarios || {}).forEach((k) => delete s.scenarios[k]);
    Object.assign(s.baseMaps, bmSnap);
    Object.assign(s.scenarios, scSnap);
    await tick(400);

    // ── g 选中河流的高亮粗细：1× 与 4× 各拍一张 ──
    //    上一轮把增量从"世界单位 +8"改成"屏幕像素 px(3.5)"，本轮第一次**量**它：
    //    沿河的法线方向数"亮芯"像素（`rgba(223,243,255,0.95)` 近乎不透明 → 判定很干净），
    //    1× 与 4× 的屏幕宽度应当**基本相等**（这才是"屏幕像素口径"的意思）。
    const sm = sc();
    sm.baseMapKey = KEY;
    if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
    await tick(400);
    // 一条横穿地图的波浪河（点列在世界坐标）
    const rv = { id: 'rv_story', name: '故事河',
                 points: Array.from({ length: 24 }, (_, k) => ({ x: GX0 + 100 + k * 60, y: GY0 + 300 + Math.sin(k / 2.2) * 90 })),
                 width: 1 };
    s.baseMaps[KEY].rivers = [rv];
    sm.setTool('select');
    sm.showMinimap = false;
    sm.autoRivers = []; sm.autoRiverSegments = [];
    sm.showRivers = true;
    await tick(200);
    // 相机对准河的中点
    const cvs = sm.canvas;
    const rc = cvs.getBoundingClientRect();
    const midW = rv.points[12];
    const aim = (scale) => { sm.cameraScale = scale;
      sm.cameraX = rc.width / 2 - midW.x * scale; sm.cameraY = rc.height / 2 - midW.y * scale; sm.render(); };
    aim(1);
    await tick(250);
    // 真鼠标事件选中（选择工具下 mousedown 就判河 —— 上一轮刚改的口径）
    const sp0 = { x: sm.cameraX + midW.x * sm.cameraScale, y: sm.cameraY + midW.y * sm.cameraScale };
    const mk = (t) => new MouseEvent(t, { clientX: rc.left + sp0.x, clientY: rc.top + sp0.y,
      button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
    cvs.dispatchEvent(mk('mousedown'));
    await tick(120);
    cvs.dispatchEvent(mk('mouseup'));
    await tick(250);
    info.riverSelect = { selected: sm.selectedRiverId, tool: sm.tool };
    if (!sm.selectedRiverId) { info.riverSelect.fail = '真鼠标按下没选中河'; }
    await S('07-river-1x');

    // 4× 放大（暮雨当初就是在放大态看到"大白虫"）
    aim(4);
    await tick(350);
    info.riverZoom4 = { scale: sm.cameraScale, selected: sm.selectedRiverId };
    await S('08-river-4x');

    // ── 高亮"屏幕宽度"的真判据：同相机同缩放下**选中 vs 未选中**逐像素比对，
    //    沿河的法线数"有差异"的像素（差异像素 = 高亮本身，与地形底色无关）。
    //    屏幕像素口径意味着 1× 与 4× 的宽度应当**基本相等**；旧的世界单位常数会 4 倍。
    const diffWidthAt = (wx, wy, nx, ny) => {
      const c = sm.canvas;
      const ctx = c.getContext('2d');
      const dpr = c.width / rc.width;
      const sx = (sm.cameraX + wx * sm.cameraScale) * dpr;
      const sy = (sm.cameraY + wy * sm.cameraScale) * dpr;
      const half = 24;                 // 屏幕像素（够包住光晕：光晕 = 河宽 + 3.5px）
      const at = [];
      for (let t = -half; t <= half; t += 1) {
        at.push([Math.round(sx + nx * t * dpr), Math.round(sy + ny * t * dpr)]);
      }
      const grab = () => at.map(([X, Y]) => {
        if (X < 0 || Y < 0 || X >= c.width || Y >= c.height) return [0, 0, 0];
        const d = ctx.getImageData(X, Y, 1, 1).data;
        return [d[0], d[1], d[2]];
      });
      const keep = sm.selectedRiverId;
      sm.selectedRiverId = keep; sm.render();
      const on = grab();
      sm.selectedRiverId = null; sm.render();
      const off = grab();
      sm.selectedRiverId = keep; sm.render();
      let n = 0;
      for (let i = 0; i < at.length; i++) {
        const d = Math.abs(on[i][0] - off[i][0]) + Math.abs(on[i][1] - off[i][1]) + Math.abs(on[i][2] - off[i][2]);
        if (d > 10) n += 1;
      }
      return n;
    };
    const widthsAt = () => {
      // 🔴 取**段中点**而不是节点本身：节点位置上除了高亮还有别的东西会变
      //    （选中态的节点/端点标记等），取节点会量到一个偏大的假宽度。
      //    多段取样后报 **min 与 median** —— min 才是"这条高亮最细处有多细"。
      const pts = rv.points, ws = [];
      for (const i of [8, 9, 10, 11, 12, 13, 14, 15]) {
        const a = pts[i], b = pts[i + 1];
        const tx = b.x - a.x, ty = b.y - a.y;
        const L = Math.hypot(tx, ty) || 1;
        ws.push(diffWidthAt((a.x + b.x) / 2, (a.y + b.y) / 2, -ty / L, tx / L));
      }
      return ws;
    };
    const w1 = widthsAt();
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const mn = (a) => Math.min.apply(null, a);
    info.highlightWidth1x = { samples: w1, median: med(w1), min: mn(w1) };
    aim(4);
    await tick(300);
    const w4 = widthsAt();
    info.highlightWidth4x = { samples: w4, median: med(w4), min: mn(w4) };
    info.highlightVerdict = {
      median1x: med(w1), median4x: med(w4), min1x: mn(w1), min4x: mn(w4),
      ratio4xOver1x: med(w1) > 0 ? Math.round((med(w4) / med(w1)) * 100) / 100 : null,
      expected: '河宽 4px（basemapRiverWidthPx 上界）+ 光晕 3.5px ≈ 7~8 屏幕像素，1× 与 4× 应基本相等',
      unit: 'screen px（沿河法线的差异像素数）',
    };
    await S('09-river-4x-measured');

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
    return dev, edge


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

    os.makedirs(OUT_DIR, exist_ok=True)
    RT.setup_mock()
    _start_edge()
    shots, info = [], {}
    try:
        cdp = CDP()
        cdp.navigate('http://localhost:5180/?story=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        ok, pinfo = open_harness_project(cdp)
        print('harness project:', ok, str(pinfo)[:160])
        # 进剧本模式（harness 跳过开关在场 → 直达编辑器），故事线自己负责后续
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本模式')
        time.sleep(1.0)
        # RecoveryPanel（z-index 1100，全屏 + backdrop-filter）会在"上次没正常退出"时弹出来挡住一切：
        # 出图脚本上一轮是被 taskkill 杀的 → 下次进来必弹。它与本轮改动无关，但会污染每一张图
        # （`elementFromPoint` 全指向它、合成开销也会混进耗时读数），出图前先按「丢弃备份」关掉。
        ditched = cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                           ".find((x) => (x.textContent || '').includes('丢弃备份'));"
                           " if (b) { b.click(); return true; } return false; })()")
        print('recovery overlay dismissed:', ditched)
        time.sleep(0.8)
        cdp.eval("window.__shots = []; window.__shotAck = 0; window.__done = false; 'ok'")
        cdp.eval(STORY)
        deadline = time.time() + 300
        while time.time() < deadline:
            st = cdp.eval("JSON.stringify({shots: window.__shots || [], ack: window.__shotAck || 0,"
                          "done: !!window.__done, err: window.__storyErr || '',"
                          "info: window.__storyInfo || {}})")
            if isinstance(st, dict) and '__err__' in st:
                print('页面求值异常：', st); break
            st = json.loads(st)
            shots, info = st['shots'], st['info']
            if st['ack'] < len(shots):
                name = shots[st['ack']]
                png = cdp.send('Page.captureScreenshot', {'format': 'png'})
                path = os.path.join(OUT_DIR, '%s.png' % name)
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(png['data']))
                print('shot ->', os.path.relpath(path, ROOT))
                cdp.eval('window.__shotAck = %d; "ok"' % (st['ack'] + 1))
            if st['done'] and st['ack'] >= len(shots):
                if st['err']:
                    print('🔴 故事线异常：', st['err'][:1500])
                break
            time.sleep(0.15)
        else:
            print('🔴 故事线超时（未走完）')
        print('=== 读数 ===')
        print(json.dumps(info, ensure_ascii=False, indent=1))
        cdp.close()
    finally:
        if '--keep' not in sys.argv:
            _stop()
        else:
            print('--keep：Vite / Edge 保持运行（收工记得跑 _lab.py down 同款清理）')


if __name__ == '__main__':
    main()
