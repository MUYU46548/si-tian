#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「涂归属」一笔的**端到端时延**（真机 · 真实 415 省项目副本，2026-11-03）

这是最后一个还没数过的性能口径。此前只量了 `render()` / 平移 / 拖顶点 / 建省松手：
**“涂一笔多久落库”从来没量过**（上轮日志第 1 件事）。

本工具在**真实 Electron + 真实 415 省项目的工作副本**上跑（原项目只读：跑前后 sha256 一致），
用真实鼠标事件走产品路径（`ownerBrush` → 采样 → 松手 `commitOwnerStroke` → `batchSetOwnership`
→ `projectStore` 暂存 → 800ms 自动保存防抖 → IPC 写盘），量三段时间：

  ① `commitMs`      —— **松手那一下的同步段**（事件派发 + 归属写口 + 账本 + 暂存），
                       这是用户按下去能感觉到的那一段（口径：≤50ms）。
  ② `stagedMs`      —— 松手到 `projectStore.dirty=true`（“改动已交给项目”，应当≈0）。
  ③ `endToEndMs`    —— 松手到**磁盘上真的变了**（含 800ms 自动保存防抖 → 这就是用户眼里
                       “什么时候落库”的真实数字；防抖是产品设计，不是缺陷）。
  ④ `flushMs`       —— 第二笔之后**显式 flush**（关项目/退出走的那条路）到磁盘变化的时间，
                       即“不含防抖的纯落盘成本”。

判据（不是打印了算完）：
  · 磁盘上那一笔真的写进去了：该省 `ownership` == 目标势力、`changeEvents` 多一条、
    `ledger.events` 里有**同一个 groupId** 的事件（一笔一组，2026-11-02 修的那个洞）；
  · `commitMs ≤ 50`（用户口径）；`stagedMs ≤ 5`；三段时间都打印出来存档；
  · 跑前/跑后真实项目文件 sha256 一致（只读纪律）。

用法：python scripts/tests/drill_owner_latency.py [--project <file.sitian>]
产物：build/owner-latency/<时间戳>/{result.json, summary.md}
⚠️ 会开一个真实 Electron 窗口（约 1~2 分钟）；跑之前别让 `run_tests.py` 占着 5180。
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 控制台默认编码在 Windows 上是 GBK：显式切 UTF-8，否则一条符号（✅ / ▶）就会让脚本崩在
# `UnicodeEncodeError` 上 —— 那不是断言失败，是压根没开始跑（2026-11-03 实测）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

DEV_PORT = 5180
CDP_PORT = 9226
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')

# ── 第一段：铺一笔（松手即返回，不让 Python 等保存）──────────────────────────
SETUP_JS = r"""(async () => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = SM.selectedScenario;
  if (!sc) return JSON.stringify({ ok: false, why: 'no-scenario' });
  const polities = sc.polities || [];
  if (!polities.length) return JSON.stringify({ ok: false, why: 'no-polity' });
  const pol = polities[0];
  const cvs = SM.canvas;
  // ⚠️ 先切工具再量矩形：切到 `ownerBrush` 会多出一行“笔刷设置”（模板里 `v-if="tool === 'ownerBrush'"`），
  //   画布高度会变 —— 先用旧矩形算相机，正中对准的就不是那个省了（2026-11-03 第二跑实测：涂到了邻居）。
  SM.setTool('ownerBrush');
  SM.selectedPolity = pol;
  if (typeof SM.clearOwnerMode !== 'undefined') SM.clearOwnerMode = false;
  if (typeof SM.fitToView === 'function') SM.fitToView();
  SM.render();
  await new Promise(r => setTimeout(r, 200));
  const rect = cvs.getBoundingClientRect();

  // 🔴 目标点必须**用产品自己的命中函数**挑，不能拿省的顶点重心当靶：
  //    真实 415 省里很多是批量切出来的凹多边形，重心可能落在海里/省外 ——
  //    2026-11-03 首跑就是这么"一笔什么都没涂到"（commitMs 13.6ms 但 ownership 没变）。
  //    做法：在画布上扫网格 → screenToWorld → findProvinceAt，命中"陆地且不是目标势力"的第一个点。
  let hit = null;
  const grid = [];
  for (let gy = 1; gy <= 11 && !hit; gy++) {
    for (let gx = 1; gx <= 13 && !hit; gx++) {
      const lx = rect.width * gx / 14;
      const ly = rect.height * gy / 12;
      const w = SM.screenToWorld(lx, ly);
      const p = SM.findProvinceAt(w.x, w.y);
      if (!p || p.kind === 'sea') continue;
      const cur = SM.ownerPolityForProvince(p.id);
      const curId = cur && (cur.id || cur);
      grid.push(p.id);
      if (curId === pol.id) continue;
      hit = { id: p.id, wx: w.x, wy: w.y, points: (p.points || []).length, curId };
    }
  }
  if (!hit) return JSON.stringify({ ok: false, why: 'no-target-province', scanned: grid.slice(0, 12) });

  // 选好点之后再定相机：把该世界点摆到画布正中（缩放 0.8 让笔刷半径 ≈37 世界单位，一笔几格）
  const scale = 0.8;
  SM.cameraScale = scale;
  SM.cameraX = rect.width / 2 - hit.wx * scale;
  SM.cameraY = rect.height / 2 - hit.wy * scale;
  SM.render();
  await new Promise(r => setTimeout(r, 160));
  const sx = Math.round(rect.left + rect.width / 2);
  const sy = Math.round(rect.top + rect.height / 2);
  // 摆好相机后再用产品命中函数复核一次（证明"要点的那个像素确实是目标省"）
  const verify = SM.findProvinceAt(SM.screenToWorld(rect.width / 2, rect.height / 2).x,
                                   SM.screenToWorld(rect.width / 2, rect.height / 2).y);
  window.__ownerProbe = { provinceId: hit.id, polityId: pol.id, scenarioId: sc.id,
                          baseMapKey: SM.baseMapKey, sx, sy,
                          ownBefore: JSON.parse(JSON.stringify(sc.ownership || {})) };
  return JSON.stringify({ ok: true, province: hit.id, points: hit.points,
                          polity: pol.id, scenario: sc.id, baseMap: SM.baseMapKey,
                          beforeOwner: hit.curId || '', tool: SM.tool, scale, sx, sy,
                          canvas: [rect.width, rect.height],
                          verify: verify ? verify.id : null,
                          verifySame: !!verify && verify.id === hit.id });
})()"""

# ── 第二段：真鼠标事件（mousedown → 3 次 mousemove → 松手），松手后**同步**读结果
STROKE_JS = r"""(async () => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const pr = window.__ownerProbe;
  const cvs = SM.canvas;
  const mk = (type, x, y) => new MouseEvent(type, {
    clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1,
  });
  // 目标点复核（相机已把它摆到画布正中）：正中那个像素必须还是目标省
  const rect = cvs.getBoundingClientRect();
  const wCenter = SM.screenToWorld(rect.width / 2, rect.height / 2);
  const hitCenter = SM.findProvinceAt(wCenter.x, wCenter.y);
  const sc = s.scenarios[pr.scenarioId];
  const polities = (sc && sc.polities) || [];
  const pol = polities[0] || null;
  const pol2 = polities[1] || null;

  /** 一笔：按下 → 3 次 mousemove → 松手；返回**松手那一下**的同步耗时 */
  const strike = (targets, tgt) => {
    SM.selectedPolity = tgt;
    SM.clearOwnerMode = !tgt;
    const ms = [];
    cvs.dispatchEvent(mk('mousedown', pr.sx, pr.sy));
    for (let i = 1; i <= 3; i++) {
      const a = performance.now();
      cvs.dispatchEvent(mk('mousemove', pr.sx + i * 3, pr.sy + i * 2));
      ms.push(Math.round((performance.now() - a) * 100) / 100);
    }
    const t = performance.now();
    cvs.dispatchEvent(mk('mouseup', pr.sx + 9, pr.sy + 6));
    return { commitMs: Math.round((performance.now() - t) * 100) / 100, moveMs: ms };
  };

  // ① 预热一笔（冷启动的 JIT / 命中索引 / 基帧都在这笔里付掉，不该算进稳态口径）
  const warm = strike(null, pol);

  // 把归属写口包一层计时：60ms 到底花在"写口"还是"事件/渲染"上，得能拆开说
  let storeMs = 0, storeCalls = 0;
  const origBatch = s.batchSetOwnership.bind(s);
  s.batchSetOwnership = (...a) => {
    const t = performance.now();
    const r = origBatch(...a);
    storeMs += performance.now() - t;
    storeCalls++;
    return r;
  };

  // ② 稳态：交替两个势力涂 4 笔（**偶数**笔：最后一笔落在 pol 上，与预热后的初值不同，
  //    这样"改了哪些省"与磁盘断言都能对上；奇数笔会绕回初值 —— 实测"改了 0 个省"的假象）。
  const strokes = [];
  for (let i = 0; i < 4; i++) {
    const tgt = (i % 2 === 0) ? (pol2 || null) : pol;
    const t = Date.now();
    const r = strike(null, tgt);
    strokes.push({ i, commitMs: r.commitMs, moveMs: r.moveMs,
                   target: tgt ? (tgt.id || String(tgt)) : null, wall: t });
  }
  s.batchSetOwnership = origBatch;
  const wallBefore = strokes[strokes.length - 1].wall;
  const lastTarget = strokes[strokes.length - 1].target;
  // ⚠️ 必须**重新取**剧本对象：每次归属写入都会换新对象，开头抓的那个是旧快照
  //    （2026-11-03 实测：不改这里会得到"改了 0 个省 / groupId 空"的假象）
  const scNow = s.scenarios[pr.scenarioId];
  const own = (scNow && scNow.ownership) || {};
  const before = pr.ownBefore || {};
  const changed = [];
  for (const k of Object.keys(own)) if (own[k] !== before[k]) changed.push(k);
  const raw = strokes.map(x => x.commitMs).slice().sort((a, b) => a - b);
  // 内存侧这一笔的 groupId（账本里最后一条属于本省的事件）
  let gidMem = '';
  const led = (scNow && scNow.ledger && scNow.ledger.events) || [];
  for (let i = led.length - 1; i >= 0; i--) {
    const e = led[i];
    if (e && e.payload && e.payload.provinceId === pr.provinceId && e.groupId) { gidMem = e.groupId; break; }
  }
  // 同步读 projectStore（松手那一刻的 dirty / 状态）
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const proj = useProjectStore(pinia);
  return JSON.stringify({
    ok: true,
    wallBefore,
    warmMs: warm.commitMs,
    strokes,
    medianMs: Math.round(((raw.length % 2)
      ? raw[(raw.length - 1) / 2]
      : (raw[raw.length / 2 - 1] + raw[raw.length / 2]) / 2) * 100) / 100,
    maxMs: Math.round(raw[raw.length - 1] * 100) / 100,
    minMs: Math.round(raw[0] * 100) / 100,
    lastTarget,
    // 60ms 拆账：写口（batchSetOwnership）自己占多少 / 其余是事件派发+渲染+回执
    storeMs: Math.round(storeMs * 100) / 100,
    storeCalls,
    storePerCallMs: storeCalls ? Math.round((storeMs / storeCalls) * 100) / 100 : null,
    centerProvince: hitCenter ? hitCenter.id : null,
    centerMatches: !!hitCenter && hitCenter.id === pr.provinceId,
    changed: changed.slice(0, 12),
    changedCount: changed.length,
    ownership: own[pr.provinceId] || null,
    changeEvents: (scNow && scNow.changeEvents && scNow.changeEvents[pr.provinceId]
      ? scNow.changeEvents[pr.provinceId].length : 0),
    ledgerEvents: led.length,
    gidMem,
    statusMsg: SM.provinceHint || '',
    dirty: !!proj.dirty,
    saveStatus: proj.saveStatus,
    lastSavedAt: proj.lastSavedAt,
  });
})()"""

STAGED_JS = None   # 已并入 STROKE_JS（松手当场同步读 dirty，比事后采样准）

# ── 第四段：第二笔 + 立刻 flush（不含 800ms 防抖的纯落盘成本）
FLUSH_JS = r"""(async () => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const pr = window.__ownerProbe;
  const sc = s.scenarios[pr.scenarioId];
  const pol = (sc.polities || [])[0];
  // 换一个点/省（避开刚才那个），避免"值没变 → 不算改动"。
  // ⚠️ 同样用产品命中函数扫网格挑点（重心可能在省外，见 SETUP_JS 的说明）。
  const rect = SM.canvas.getBoundingClientRect();
  SM.fitToView();
  SM.render();
  await new Promise(r => setTimeout(r, 180));
  let pick = null, hit2 = null;
  for (let gy = 1; gy <= 11 && !pick; gy++) {
    for (let gx = 1; gx <= 13 && !pick; gx++) {
      const lx = rect.width * gx / 14, ly = rect.height * gy / 12;
      const w = SM.screenToWorld(lx, ly);
      const p = SM.findProvinceAt(w.x, w.y);
      if (!p || p.kind === 'sea' || p.id === pr.provinceId) continue;
      const cur = SM.ownerPolityForProvince(p.id);
      if (cur && (cur.id || cur) === pol.id) continue;
      pick = p; hit2 = { wx: w.x, wy: w.y };
    }
  }
  if (!pick) return JSON.stringify({ ok: false, why: 'no-second-province' });
  const scale2 = 0.8;
  SM.cameraScale = scale2;
  SM.cameraX = rect.width / 2 - hit2.wx * scale2;
  SM.cameraY = rect.height / 2 - hit2.wy * scale2;
  SM.setTool('ownerBrush');
  SM.selectedPolity = pol;
  SM.render();
  await new Promise(r => setTimeout(r, 160));
  const mk = (type, x, y) => new MouseEvent(type, {
    clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1,
  });
  const sx = Math.round(rect.left + rect.width / 2);
  const sy = Math.round(rect.top + rect.height / 2);
  cvsDispatch(mk, sx, sy, SM.canvas);
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const proj = useProjectStore(pinia);
  // 等 450ms 让**剧本层自己的 300ms 防抖**先跑完（否则此刻 projectStore 还是干净的，
  //   `flushSave()` 会直接 skipped —— 2026-11-03 第三跑就是这么"测了个空"）
  await new Promise(r => setTimeout(r, 450));
  const dirtyBefore = !!proj.dirty;
  const changedBefore = (s.scenarios[pr.scenarioId].ownership || {})[pick.id];
  const w0 = Date.now();
  const p0 = performance.now();
  const r = await proj.flushSave();
  const flushMs = performance.now() - p0;
  return JSON.stringify({ ok: true, province: pick.id, wallBefore: w0, dirtyBefore,
                          ownershipAfterStroke: changedBefore || null,
                          flushMs: Math.round(flushMs * 100) / 100,
                          skipped: !!(r && r.skipped),
                          saveResult: r && (r.success !== undefined ? r.success : null) });
  function cvsDispatch(mk2, x, y, cv) {
    cv.dispatchEvent(mk2('mousedown', x, y));
    cv.dispatchEvent(mk2('mousemove', x + 2, y + 2));
    cv.dispatchEvent(mk2('mouseup', x + 4, y + 4));
  }
})()"""


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def wait_http(url, timeout=120):
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                return r.status < 500
        except Exception:
            time.sleep(0.4)
    return False


def wait_cdp(port=CDP_PORT, timeout=120):
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/version' % port, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def port_busy(port):
    import socket
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_file_change(path, before, t0_wall, timeout=20.0, poll=0.005):
    """等文件 mtime/size 变化；返回 (变化时刻的 epoch ms, 观测耗时 ms)。"""
    end = time.time() + timeout
    while time.time() < end:
        st = os.stat(path)
        sig = (st.st_mtime_ns, st.st_size)
        if sig != before:
            now_ms = time.time() * 1000.0
            return now_ms, round(now_ms - t0_wall, 1)
        time.sleep(poll)
    return None, None


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return bool(ok)


def main():
    args = sys.argv[1:]
    real = args[args.index('--project') + 1] if '--project' in args else ''
    if not real:
        try:
            with open(APP_CFG, encoding='utf-8') as f:
                real = (json.load(f) or {}).get('lastProjectPath', '')
        except Exception:
            real = ''
    if not real or not os.path.exists(real):
        print(f'  ❌ 找不到真实项目（配置里的 lastProjectPath = {real!r}）')
        print('     → 用 --project <file.sitian> 指定，或先在司天里打开一次项目')
        return 2
    for p in (DEV_PORT, CDP_PORT):
        if port_busy(p):
            print(f'  ❌ 端口 {p} 已被占用（先停掉正在跑的回归/演练）')
            return 2

    ts = time.strftime('%Y%m%d-%H%M%S')
    out_dir = os.path.join(ROOT, 'build', 'owner-latency', ts)
    os.makedirs(out_dir, exist_ok=True)
    cfg_bak = os.path.join(out_dir, 'config.json.bak')
    real_sha_before = sha256(real)
    real_size = os.path.getsize(real)
    work = os.path.join(out_dir, 'work-copy.sitian')
    shutil.copy2(real, work)

    print(f'=== 涂归属端到端时延 · 真实项目副本 ===')
    print(f'  原项目（只读）：{real}')
    print(f'  sha256 {real_sha_before[:16]}… / {real_size} 字节')
    print(f'  工作副本：{work}', flush=True)

    import run_tests as RT
    from lib.cdp import CDP, wait_for, eval_json

    cfg = None
    el = dev = None
    bad = 0
    try:
        if os.path.exists(APP_CFG):
            shutil.copy2(APP_CFG, cfg_bak)
            with open(APP_CFG, encoding='utf-8') as f:
                cfg = json.load(f)
            cfg['lastProjectPath'] = work
            with open(APP_CFG, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        else:
            os.makedirs(os.path.dirname(APP_CFG), exist_ok=True)
            with open(APP_CFG, 'w', encoding='utf-8') as f:
                json.dump({'lastProjectPath': work}, f, ensure_ascii=False, indent=2)

        node = shutil.which('node')
        exe = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=open(os.path.join(out_dir, 'vite.log'), 'w'),
                               stderr=subprocess.STDOUT)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('  ❌ Vite 没起来（看 vite.log）')
            return 1
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        el = subprocess.Popen([exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
                               '--remote-allow-origins=*'],
                              cwd=ROOT, env=env, stdout=open(os.path.join(out_dir, 'electron.log'), 'w'),
                              stderr=subprocess.STDOUT)
        if not wait_cdp():
            print('  ❌ Electron CDP 没起来（看 electron.log）')
            return 1

        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=120, desc='应用挂载')
        RT.apply_viewport(cdp)
        time.sleep(2.0)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        time.sleep(2.0)
        cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click();"
                 " return c ? 'ok' : 'none'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=60, desc='剧本编辑器')
        time.sleep(1.5)
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(1.0)

        proj_info = eval_json(cdp, """(() => import('/src/store/projectStore.js').then(({ useProjectStore }) => {
          const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
          const p = useProjectStore(pinia);
          return JSON.stringify({ filePath: p.filePath, name: p.project && p.project.meta && p.project.meta.name,
            dirty: !!p.dirty, entities: p.project && p.project.entities ? Object.keys(p.project.entities).length : 0 });
        }))()""", required=('filePath',), desc='当前项目')[1]
        bad += 0 if ck('打开的是工作副本（不是真实项目）',
                       os.path.normcase(str(proj_info.get('filePath') or '')) == os.path.normcase(work),
                       f"打开 {proj_info.get('filePath')}") else 1

        # ── 铺场景（相机对准一个可涂的省）──
        ok_s, setup = eval_json(cdp, SETUP_JS, required=('ok',), desc='铺涂归属场景')
        bad += 0 if ck('场景就位（ownerBrush + 目标省 + 目标势力）', bool(ok_s) and setup.get('ok'),
                       json.dumps(setup, ensure_ascii=False)[:200]) else 1
        if not (ok_s and setup.get('ok')):
            return 1
        pid = setup.get('province')
        pol = setup.get('polity')
        sid = setup.get('scenario')
        print(f"  · 省 {pid}（{setup.get('points')} 顶点）→ 势力 {pol} / 剧本 {sid}", flush=True)
        stat0 = os.stat(work)
        sig0 = (stat0.st_mtime_ns, stat0.st_size)

        # ── 真鼠标：预热 1 笔 + 稳态 5 笔（松手同步段逐笔计时）──
        ok_st, stroke = eval_json(cdp, STROKE_JS, required=('ok',), desc='涂一笔 ×6')
        bad += 0 if ck('鼠标事件走完了（预热 1 笔 + 稳态 5 笔）', bool(ok_st) and stroke.get('ok'),
                       json.dumps(stroke, ensure_ascii=False)[:160]) else 1
        if not (ok_st and stroke.get('ok')):
            return 1
        median_ms = stroke.get('medianMs')
        print(f"  · 松手同步段：预热 {stroke.get('warmMs')} ms · 稳态 "
              f"min {stroke.get('minMs')} / 中位 {median_ms} / max {stroke.get('maxMs')} ms", flush=True)
        print(f"  · 逐笔：{[s.get('commitMs') for s in (stroke.get('strokes') or [])]}", flush=True)
        print(f"  · 拆账：归属写口 batchSetOwnership 每次 {stroke.get('storePerCallMs')} ms"
              f"（{stroke.get('storeCalls')} 次共 {stroke.get('storeMs')} ms）"
              f" → 其余 {round((median_ms or 0) - (stroke.get('storePerCallMs') or 0), 1)} ms 是事件/渲染/回执",
              flush=True)
        bad += 0 if ck('① 松手同步段（稳态中位）≤50ms（用户口径）',
                       isinstance(median_ms, (int, float)) and median_ms <= 50,
                       f'中位 {median_ms} ms（预热 {stroke.get("warmMs")} ms）') else 1

        # 前置：正中那个像素必须还是目标省（否 = 相机/布局变了，这一跑的数据没意义）
        bad += 0 if ck('前置：画布正中确实是目标省（相机没被布局改掉）',
                       bool(stroke.get('centerMatches')),
                       f"正中命中 {stroke.get('centerProvince')} / 目标 {pid}") else 1
        print(f"  · 这几笔改了 {stroke.get('changedCount')} 个省：{stroke.get('changed')}", flush=True)
        print(f"  · 回执：{str(stroke.get('statusMsg'))[:80]}", flush=True)

        # ── 暂存：松手 → projectStore.dirty（剧本层自己还有 300ms 防抖，所以等 450ms 再读）──
        time.sleep(0.45)
        ok_st2, staged = eval_json(cdp, """(() => import('/src/store/projectStore.js').then(({ useProjectStore }) => {
          const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
          const p = useProjectStore(pinia);
          return JSON.stringify({ dirty: !!p.dirty, saveStatus: p.saveStatus });
        }))()""", required=('dirty',), desc='暂存状态（450ms 后）')
        bad += 0 if ck('② 松手 450ms 内改动已交给项目（dirty=true）', bool(staged.get('dirty')),
                       json.dumps(staged, ensure_ascii=False)) else 1

        # ── 磁盘：等自动保存（800ms 防抖 + 写）真的落地 ──
        t0_wall = float(stroke.get('wallBefore') or (time.time() * 1000))
        changed_at, e2e_ms = wait_file_change(work, sig0, t0_wall, timeout=25.0)
        bad += 0 if ck('③ 松手 → 磁盘真的变了（自动保存链路走通）', changed_at is not None,
                       f'落库耗时 {e2e_ms} ms（含 800ms 自动保存防抖）') else 1

        # 落盘内容核对（读文件，不看内存）
        with open(work, 'rb') as f:
            disk = json.loads(f.read().decode('utf-8'))
        scen = ((disk.get('scenarios') or {}).get('scenarios') or {}).get(sid) or {}
        own = (scen.get('ownership') or {}).get(pid)
        evs = (scen.get('changeEvents') or {}).get(pid) or []
        led = (scen.get('ledger') or {}).get('events') or []
        # 这一笔的 groupId：磁盘上取账本里**最后一条**属于本省的事件（笔刷写入时带 strokeId）
        gid_disk = ''
        for e in reversed(led):
            if (e or {}).get('payload', {}).get('provinceId') == pid and (e or {}).get('groupId'):
                gid_disk = e.get('groupId')
                break
        gid_mem = stroke.get('gidMem') or ''
        target_owner = stroke.get('lastTarget') or pol
        bad += 0 if ck('④ 磁盘上该省归属 = 最后一笔的目标势力', own == target_owner,
                       f'ownership[{pid}] = {own!r}（目标 {target_owner!r}）') else 1
        bad += 0 if ck('⑤ 磁盘上账本多了一条（changeEvents 带内容）', len(evs) >= 1,
                       f'changeEvents[{pid}] 共 {len(evs)} 条') else 1
        bad += 0 if ck('⑥ 账本给这一笔记了组（内存 groupId == 磁盘，且不是迁移合成的 v2: 组）',
                       bool(gid_mem) and gid_mem == gid_disk and not gid_disk.startswith('v2:'),
                       f'内存 {gid_mem!r} / 磁盘 {gid_disk!r}') else 1

        # ── 第四段：第二笔 + 立刻 flush（不含防抖的纯落盘）──
        sig1 = (os.stat(work).st_mtime_ns, os.path.getsize(work))
        ok_f, fl = eval_json(cdp, FLUSH_JS, required=('ok',), desc='第二笔 + flush')
        flush_e2e = None
        if ok_f and fl.get('ok') and fl.get('dirtyBefore'):
            _, flush_e2e = wait_file_change(work, sig1, float(fl.get('wallBefore') or (time.time() * 1000)),
                                            timeout=25.0)
        # `flushSave()` 在没有 dirty 时会**跳过**（返回 skipped）—— 那种情况测不到落盘，必须当成没测到
        bad += 0 if ck('⑦ 显式 flush（关项目/退出那条路）也能落盘',
                       bool(fl.get('dirtyBefore')) and flush_e2e is not None,
                       f"纯落盘 {flush_e2e} ms · flushSave 内部 {fl.get('flushMs')} ms · "
                       f"dirtyBefore={fl.get('dirtyBefore')} · skipped={fl.get('skipped')}") else 1

        # ── 只读纪律：真实项目一个字节都没动 ──
        sha_after = sha256(real)
        bad += 0 if ck('真实项目只读（跑前/跑后 sha256 一致）', sha_after == real_sha_before,
                       f'{sha_after[:16]}…') else 1

        result = {
            'ts': ts, 'realProject': real, 'realSha256': real_sha_before, 'workCopy': work,
            'province': pid, 'polity': pol, 'scenario': sid,
            'warmMs': stroke.get('warmMs'), 'medianMs': median_ms,
            'minMs': stroke.get('minMs'), 'maxMs': stroke.get('maxMs'),
            'strokes': [s.get('commitMs') for s in (stroke.get('strokes') or [])],
            'storePerCallMs': stroke.get('storePerCallMs'), 'storeMs': stroke.get('storeMs'),
            'storeCalls': stroke.get('storeCalls'),
            'endToEndMs': e2e_ms, 'flushMs': fl.get('flushMs'), 'flushEndToEndMs': flush_e2e,
            'groupId': gid_disk,
            'changed': stroke.get('changed'), 'statusMsg': stroke.get('statusMsg'),
            'disk': {'ownership': own, 'changeEvents': len(evs), 'ledgerEvents': len(led)},
            'verdict': {'commit_median_le_50ms': isinstance(median_ms, (int, float)) and median_ms <= 50,
                        'persisted': changed_at is not None and own == target_owner},
            'bad': bad,
        }
        with open(os.path.join(out_dir, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        md = [
            f'# 涂归属一笔的端到端时延 · {ts}', '',
            f'- 真实项目（只读）：`{real}`', f'- 工作副本：`{work}`',
            f'- 目标：省 `{pid}`（剧本 `{sid}`）· 稳态 5 笔交替势力', '',
            '| 段 | 实测 | 口径 |', '|---|---|---|',
            f"| ① 松手同步段（稳态中位） | **{median_ms} ms** | ≤50ms |",
            f"| ↳ 同一批：预热 / min / max | {stroke.get('warmMs')} / {stroke.get('minMs')} / {stroke.get('maxMs')} ms | 参考 |",
            f"| ↳ 逐笔 | {result['strokes']} ms | 参考 |",
            f"| ↳ 拆账：归属写口 / 其余 | {stroke.get('storePerCallMs')} ms / "
            f"{round((median_ms or 0) - (stroke.get('storePerCallMs') or 0), 1)} ms | 事件派发 + 渲染 + 回执 |",
            f'| ② 交给项目（dirty） | 450ms 内 = {staged.get("dirty")} | 剧本层 300ms 防抖 + 项目层 800ms 防抖 |',
            f'| ③ 松手 → 磁盘（含两层防抖） | **{e2e_ms} ms** | 记录，不设上限 |',
            f"| ④ 显式 flush → 磁盘 | {flush_e2e} ms（flushSave 内部 {fl.get('flushMs')} ms） | 记录 |",
            '', f'- 这几笔改了 {stroke.get("changedCount")} 个省：`{stroke.get("changed")}`',
            f'- 回执：{stroke.get("statusMsg")}',
            f'- 一笔一组 groupId：内存 `{gid_mem}` / 磁盘 `{gid_disk}`',
            f'- 磁盘：changeEvents {len(evs)} 条 / ledger {len(led)} 条',
            f'- 真实项目 sha256 跑前后一致：{sha_after == real_sha_before}',
            '', f'结论：**{bad} 项没过**',
        ]
        with open(os.path.join(out_dir, 'summary.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(md) + '\n')
        print('\n' + '\n'.join(md), flush=True)
        print(('  ✅ 涂归属端到端判据通过' if not bad else f'  🔴 {bad} 项没过'), flush=True)
        return 0 if not bad else 1
    finally:
        if el is not None:
            subprocess.run(['taskkill', '/PID', str(el.pid), '/T', '/F'], capture_output=True)
        if dev is not None:
            subprocess.run(['taskkill', '/PID', str(dev.pid), '/T', '/F'], capture_output=True)
        if os.path.exists(cfg_bak):
            shutil.move(cfg_bak, APP_CFG)
        elif cfg is None:
            try:
                os.remove(APP_CFG)
            except Exception:
                pass
        print('  · 配置已还原', flush=True)


if __name__ == '__main__':
    sys.exit(main())
