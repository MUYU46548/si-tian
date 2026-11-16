#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""规模帧时间探针（Vite + Edge headless + mock IPC，**只读**）：开图耗时 + 暖帧/平移/放大帧的分层读数。

为什么要它：`规模压测` 那张卡的读数是"3000 省 / 15 万格首帧堵 5.7s、重绘 105ms"，但
**105ms 花在哪一层**、**开图那 5 秒花在哪一段**，之前只能靠猜。`__SITIAN_RENDER_STAGES__`
（`scenario/renderProfile.js`）已经给了逐层计时，`__SITIAN_FRAME_LOG__` 给了逐帧总耗时；
这个脚本把它们组织成"三种手感的答案"：

  ① 暖帧（同机位连画 8 次）：稳态重绘成本 —— 拖动一次要付的钱；
  ② 平移帧（相机每帧移 20px）：平移时"略粘"的那一半到底在哪一层；
  ③ 放大帧（scale ×1.6 后再画）：清晰度档位的代价。

用法：
  python scripts/tests/tools/probe_scale_frames.py --project build/eu4-scale/bench-p3000-g512.sitian --key sample_land
  python scripts/tests/tools/probe_scale_frames.py --project sample/示例世界.sitian --key sample_land --tag sample
产物：build/<out>/<tag>.json（读数）+ 控制台表格。

⚠️ 独占 5180/9222；不要与 run_tests / 视觉套件同时跑。
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
sys.path.insert(0, TESTS)
import run_tests as rt                                        # noqa: E402
from lib.cdp import CDP, wait_for                             # noqa: E402
from lib.helpers import ensure_data_ready                     # noqa: E402

ROOT = rt.ROOT


def arg(name, default):
    a = sys.argv[1:]
    return a[a.index('--' + name) + 1] if ('--' + name) in a and a.index('--' + name) + 1 < len(a) else default


def flag(name):
    return ('--' + name) in sys.argv[1:]


def log(msg):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), msg), flush=True)


def ask(cdp, expr):
    t = time.time()
    try:
        return cdp.eval(expr), time.time() - t
    except Exception as e:                                     # noqa: BLE001
        log('  问话失败（%.1fs）：%s' % (time.time() - t, str(e)[:90]))
        return None, time.time() - t


# 页内测量：所有时间都用 performance.now() 在**同一进程**里取（跨 CDP 的往返不计入）
MEASURE_JS = r"""
(async () => {
  const out = { stage: 'run', frames: [], errors: [] };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const stage = (s) => { out.stage = s; window.__SCALE_PROBE__ = out; };
  window.__SCALE_PROBE__ = out;
  try {
    const host = document.querySelector('.scenario-map-container');
    if (!host) { out.errors.push('no-scenario-map'); return; }
    const sm = host.__vueParentComponent.setupState;
    out.hasSm = !!sm;
    window.__SITIAN_RENDER_PROFILE__ = true;
    // 帧：直接调组件的 render()（同步语义，与真实交互同一条路径）
    function one(label, extra) {
      const t0 = performance.now();
      sm.render();
      const ms = performance.now() - t0;
      const st = window.__SITIAN_RENDER_STAGES__ || [];
      const last = st.length ? st[st.length - 1] : null;
      const f = { label, ms: Math.round(ms * 100) / 100, total: last ? last.total : null,
                  layers: last ? last.layers : null, px: last ? last.px : null };
      if (extra) Object.assign(f, extra);
      out.frames.push(f);
      return f;
    }
    const cam0 = { x: sm.cameraX, y: sm.cameraY, scale: sm.cameraScale };
    out.cam0 = cam0;
    out.counts = {
      provinces: (sm.baseMap && sm.baseMap.terrain ? sm.baseMap.terrain.length : 0),
      hmCells: (sm.baseMap && sm.baseMap.heightmap && sm.baseMap.heightmap.h ? sm.baseMap.heightmap.h.length : 0),
      rivers: (sm.baseMap && sm.baseMap.rivers ? sm.baseMap.rivers.length : 0),
      // 排障口（2026-11-16）：高度图是不是被 Vue 代理了 —— `__v_skip` 有值 = 已标 raw。
      // 读它是因为“Vue 响应式开销”在 CPU 采样里只表现为匿名 `get` / `isRef`，看不出是谁的数据。
      hmRaw: !!(sm.baseMap && sm.baseMap.heightmap && sm.baseMap.heightmap.__v_skip),
      hmReactive: !!(sm.baseMap && sm.baseMap.heightmap && typeof sm.baseMap.heightmap.__v_isReactive === 'boolean'),
    };
    stage('warm');
    for (let i = 0; i < 8; i++) { one('warm-' + i); await sleep(0); }
    stage('pan');
    for (let i = 0; i < 12; i++) {
      sm.cameraX = cam0.x - i * 20;
      one('pan-' + i);
      await sleep(0);
    }
    // 平移后的"停稳帧"（相机静止、标签/浮雕等层恢复绘制）
    sm.cameraX = cam0.x - 240;
    await sleep(220);
    one('pan-settle');
    stage('zoom');
    sm.cameraX = cam0.x; sm.cameraY = cam0.y; sm.cameraScale = cam0.scale * 1.6;
    for (let i = 0; i < 3; i++) { one('zoom-' + i); await sleep(0); }
    stage('zoom-settle');
    await sleep(220);
    one('zoom-settle');
    // 还原机位（只读探针不该把页面留在奇怪状态）
    sm.cameraX = cam0.x; sm.cameraY = cam0.y; sm.cameraScale = cam0.scale;
    one('restored');
    out.bakeLog = (window.__SITIAN_BAKE_LOG__ || []).slice(-8);
    out.frameLogTail = (window.__SITIAN_FRAME_LOG__ || []).slice(-24);
    stage('done');
  } catch (e) {
    out.errors.push(String((e && e.message) || e));
    out.stage = 'done';
    window.__SCALE_PROBE__ = out;
  }
})()
"""


PROFILE_JS = r"""
(() => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const x0 = sm.cameraX;
  const t0 = performance.now();
  for (let i = 0; i < 15; i++) { sm.cameraX = x0 - i * 20; sm.render(); }
  sm.cameraX = x0; sm.render();
  return String(Math.round(performance.now() - t0));
})()
"""


def aggregate(profile):
    """按函数聚合**自耗时**（微秒 → 毫秒）"""
    nodes = {n['id']: n for n in profile['nodes']}
    total = 0
    per = {}
    samples = profile.get('samples') or []
    deltas = profile.get('timeDeltas') or []
    for i, sid in enumerate(samples):
        dt = deltas[i] if i < len(deltas) else 0
        total += dt
        n = nodes.get(sid)
        if not n:
            continue
        cf = n['callFrame']
        name = cf.get('functionName') or '(anonymous)'
        url = (cf.get('url') or '').split('/')[-1]
        key = '%s  @%s:%s' % (name, url, cf.get('lineNumber', -1) + 1)
        per[key] = per.get(key, 0) + dt
    return total, sorted(per.items(), key=lambda kv: -kv[1])


def summarize(frames):
    """按前缀分组，打印中位数 / 最小 / 最大（毫秒）"""
    groups = {}
    for f in frames:
        key = f['label'].rsplit('-', 1)[0] if not f['label'].startswith(('pan-settle', 'zoom-settle', 'restored')) else f['label']
        groups.setdefault(key, []).append(f['ms'])
    lines = []
    for k, v in groups.items():
        v = sorted(v)
        mid = v[len(v) // 2]
        lines.append('%-12s n=%-2d 中位 %6.2fms  min %6.2f  max %6.2f' % (k, len(v), mid, v[0], v[-1]))
    return lines


def layer_line(frame):
    if not frame or not frame.get('layers'):
        return ''
    items = sorted(frame['layers'].items(), key=lambda kv: -kv[1])
    return ' / '.join('%s %.1f' % (k, v) for k, v in items if v >= 0.05)


def main():
    project = arg('project', os.path.join(ROOT, 'build', 'eu4-scale', 'bench-p3000-g512.sitian'))
    key = arg('key', 'sample_land')
    tag = arg('tag', 'p3000')
    out_dir = os.path.join(ROOT, arg('out', os.path.join('build', 'eu4-scale', 'frames')))
    if not os.path.isfile(project):
        log('项目不存在：%s' % project)
        return 1
    os.makedirs(out_dir, exist_ok=True)

    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            log('端口 %d 被占用 —— 先停掉别的演练（run_tests / 视觉套件 / 旧截图脚本）' % port)
            return 2

    rt.setup_mock()
    handles, cdp = [], None
    try:
        dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT, timeout=120):
            raise RuntimeError('Vite 启动超时')
        edge = subprocess.Popen([
            rt.EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
            '--remote-debugging-port=%d' % rt.CDP_PORT, '--remote-allow-origins=*',
            '--user-data-dir=%s' % os.path.join(ROOT, '.test-edge-profile'),
            '--no-first-run', '--no-default-browser-check', '--no-sandbox', 'about:blank',
        ])
        handles.append(rt.ProcessHandle(edge, 'edge'))
        if not rt.wait_port(rt.CDP_PORT, timeout=60):
            raise RuntimeError('Edge CDP 启动超时')

        cdp = CDP()
        cdp.send('Page.enable')
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='首次导航')
        rt.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true');"
                 "localStorage.removeItem('sitian-session-backup');"
                 "localStorage.setItem('sitian-clean-shutdown', 'true'); 1")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='跳过首启后重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ask(cdp, """(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.textContent || '').trim() === '丢弃备份'); if (b) { b.click(); return 'dismissed'; } return 'none'; })()""")
        ensure_data_ready(cdp, timeout=90)

        # 默认走**产品默认口径**（分块烘焙 + 视口块开）：这是用户真正看到的手感。
        # `--sync-bake` 切成同步烘到底（老脚本的确定性口径，只用来量"最坏情况"）；
        # `--no-view-patch` 关掉视口块（对照：没有块时放大要靠整幅底图跟着变宽）。
        cdp.eval("window.__SITIAN_RASTER_SYNC__ = %s; window.__SITIAN_VIEW_PATCH__ = %s; 1"
                 % ('true' if flag('sync-bake') else 'false', 'false' if flag('no-view-patch') else 'true'))
        log('烘焙口径：%s · 视口块：%s' % ('同步' if flag('sync-bake') else '先粗后精（产品默认）',
                                    '关' if flag('no-view-patch') else '开（产品默认）'))
        cdp.eval("""(() => {
          window.__hb = []; window.__errs = [];
          window.__hbTimer = setInterval(() => window.__hb.push(Math.round(performance.now())), 100);
          window.addEventListener('error', e => window.__errs.push('error: ' + (e.message || '')));
          window.addEventListener('unhandledrejection', e => window.__errs.push('reject: ' + String((e.reason && e.reason.message) || e.reason)));
          return 'ok';
        })()""")

        with open(project, 'r', encoding='utf-8') as f:
            raw = f.read()
        path = 'real/%s' % os.path.basename(project)
        log('项目 %d 字节 / %.1f MB（%s）' % (len(raw), len(raw) / 1048576.0, os.path.basename(project)))

        # 分块注入（每块只回长度 —— 见 shot_real_project 的注释）
        cdp.eval("window.__realJson = ''; 1")
        step = 300 * 1024
        for i in range(0, len(raw), step):
            cdp.eval("window.__realJson += %s; window.__realJson.length" % json.dumps(raw[i:i + step]))

        t_open = time.time()
        started = cdp.eval("""(async () => {
          try {
            const app = document.querySelector('#app').__vue_app__;
            const pinia = app.config.globalProperties.$pinia;
            const { useProjectStore } = await import('/src/store/projectStore.js');
            const proj = useProjectStore(pinia);
            window.__projects = window.__projects || {};
            window.__projects[%s] = JSON.parse(window.__realJson);
            window.__openDone = null;
            window.__openT0 = performance.now();
            window.__inScenarioT0 = null;
            proj.openProject(%s).then(r => {
              window.__openDone = { ok: !!(r && r.success), err: (r && r.error) || '',
                                    ms: Math.round(performance.now() - window.__openT0) };
            }).catch(e => { window.__openDone = { ok: false, err: String(e && e.message) }; });
            return 'started';
          } catch (e) { return 'ERR:' + (e && e.message); }
        })()""" % (json.dumps(path), json.dumps(path)))
        if started != 'started':
            log('openProject 发起失败：%s' % started)
            return 3
        # 等 openProject 落地（adopt 完成 = 数据进 store）
        for _ in range(300):
            done, _ = ask(cdp, "JSON.stringify(window.__openDone || null)")
            if isinstance(done, str) and done != 'null':
                break
            time.sleep(0.1)
        log('openProject 落地：%s（轮询等 %+.1fs）' % (done, time.time() - t_open))

        # 进"历史剧本"页签：这就是"开图卡几秒"那一段（画布挂载 + 首帧 + 首次烘焙）
        t_scn = time.time()
        # `--profile-open`：把这一段整段采样（找出开图的 2~5 秒到底花在谁身上）
        open_prof = None
        if flag('profile-open'):
            cdp.send('Profiler.enable', {})
            cdp.send('Profiler.setSamplingInterval', {'interval': 500})
            cdp.send('Profiler.start', {})
        cdp.eval("""(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()""")
        wait_for(cdp, "!!document.querySelector('.scenario-canvas-wrap canvas')", timeout=90, desc='剧本画布')
        log('点历史剧本 → 画布出现：%.1fs' % (time.time() - t_scn))
        # 选底图 + 适屏（与真实"打开这个项目"同一条路）
        fit, _ = ask(cdp, """(() => {
          const wrap = document.querySelector('.scenario-canvas-wrap');
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          if (!sm) return JSON.stringify({ err: 'no-sm' });
          if (sm.baseMapKey !== %s) { sm.baseMapKey = %s; if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange(); }
          if (typeof sm.fitToView === 'function') sm.fitToView();
          return JSON.stringify({ key: sm.baseMapKey, fitScale: sm.cameraScale,
            w: wrap.clientWidth, h: wrap.clientHeight,
            provinces: (sm.baseMap && sm.baseMap.terrain ? sm.baseMap.terrain.length : 0) });
        })()""" % (json.dumps(key), json.dumps(key)))
        log('选底图 + 适屏：%s（这一段之前 %.1fs）' % (fit, time.time() - t_scn))
        time.sleep(1.0)
        if flag('profile-open'):
            prof_open = (cdp.send('Profiler.stop', {}) or {}).get('profile') or {}
            total_o, rows_o = aggregate(prof_open)
            open_prof = {
                'totalMs': round(total_o / 1000.0, 1),
                'rows': [{'ms': round(v / 1000.0, 1), 'key': k} for k, v in rows_o[:60]],
            }
            log('开图段 CPU 采样：总 %d ms' % (total_o / 1000))
            for k, v in rows_o[:18]:
                log('  %8.1f ms  %5.1f%%  %s' % (v / 1000.0, 100.0 * v / max(1, total_o), k))

        # 页内测量（一次性跑完，轮询读结果）
        cdp.send('Runtime.evaluate', {'expression': MEASURE_JS, 'returnByValue': True, 'awaitPromise': False})
        res = None
        deadline = time.time() + 240
        while time.time() < deadline:
            v, _ = ask(cdp, "JSON.stringify(window.__SCALE_PROBE__ || null)")
            if isinstance(v, dict) and '__err__' in v:
                time.sleep(0.5)
                continue
            if isinstance(v, str) and v and v != 'null':
                try:
                    res = json.loads(v)
                except Exception:                              # noqa: BLE001
                    res = None
                if res and res.get('stage') == 'done':
                    break
            time.sleep(0.5)
        if not res:
            log('🔴 没读到 __SCALE_PROBE__')
            return 4

        # CPU 采样（`--profile`）：把「除注册表以外那 150ms」摊到函数级，别再猜
        if flag('profile'):
            cdp.send('Profiler.enable', {})
            cdp.send('Profiler.setSamplingInterval', {'interval': 200})
            cdp.send('Profiler.start', {})
            drove = cdp.eval(PROFILE_JS)
            res['profile15WallMs'] = drove
            prof = (cdp.send('Profiler.stop', {}) or {}).get('profile') or {}
            total, rows = aggregate(prof)
            res['profile'] = {
                'totalMs': round(total / 1000.0, 1),
                'rows': [{'ms': round(v / 1000.0, 1), 'key': k} for k, v in rows[:60]],
            }
            log('CPU 采样：15 帧共 %s ms（采样总 %d ms）' % (drove, total / 1000))
            for k, v in rows[:18]:
                log('  %8.1f ms  %5.1f%%  %s' % (v / 1000.0, 100.0 * v / max(1, total), k))

        hb, _ = ask(cdp, "JSON.stringify(window.__hb || [])")
        try:
            arr = json.loads(hb) if isinstance(hb, str) else []
        except Exception:                                      # noqa: BLE001
            arr = []
        gaps = sorted(((arr[i] - arr[i - 1], arr[i - 1]) for i in range(1, len(arr))), reverse=True)[:5]
        res['heartbeatGaps'] = [{'gapMs': g, 'atMs': t} for g, t in gaps]
        res['pageErrors'] = json.loads(ask(cdp, "JSON.stringify(window.__errs || [])")[0] or '[]')
        res['openWall'] = {'scenarioToCanvasSec': None}
        out_path = os.path.join(out_dir, '%s.json' % tag)
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(res, f, ensure_ascii=False, indent=1)

        log('计数：%s' % json.dumps(res.get('counts'), ensure_ascii=False))
        log('机位：%s' % json.dumps(res.get('cam0'), ensure_ascii=False))
        for line in summarize(res['frames']):
            log('帧时间  ' + line)
        # 每组的代表帧（该组里最慢那帧）的分层明细
        for label in ('warm', 'pan', 'pan-settle', 'zoom', 'zoom-settle'):
            group = [f for f in res['frames'] if f['label'] == label or f['label'].startswith(label + '-')]
            if not group:
                continue
            worst = max(group, key=lambda f: f['ms'])
            log('分层 %-10s（%s · %sms）：%s' % (label, worst['label'], worst['ms'], layer_line(worst)))
        log('心跳最长空洞：%s' % ' '.join('%dms@%d' % (g['gapMs'], g['atMs']) for g in res['heartbeatGaps']))
        log('页面错误：%s' % res.get('pageErrors'))
        fl = res.get('frameLogTail') or []
        if fl:
            worst = max(fl, key=lambda x: x.get('ms') or 0)
            log('帧日志最慢一帧：%s' % json.dumps(worst, ensure_ascii=False))
        log('读数 → %s' % os.path.relpath(out_path, ROOT))
        return 0
    finally:
        if cdp is not None:
            try:
                cdp.eval("clearInterval(window.__hbTimer)")
            except Exception:                                  # noqa: BLE001
                pass
        for h in reversed(handles):
            try:
                subprocess.run(['taskkill', '/PID', str(h.proc.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:                                  # noqa: BLE001
                pass
        try:
            rt.teardown_mock()
        except Exception:                                      # noqa: BLE001
            log('teardown_mock 失败：检查 src/renderer/index.html.bak 与 mock-data/')


if __name__ == '__main__':
    sys.exit(main())
