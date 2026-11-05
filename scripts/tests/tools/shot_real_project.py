#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机项目截图（Vite + Edge headless + mock IPC，**只读**）：整页一张 + 放大一张。

为什么不用 Electron：真机窗口会弹原生对话框、被 GPU 拖住，脚本拿不到稳定时序；
而这条通道在 `drill_scenario_pixels.py` / `drill_visual_suite.py` 里已跑了上百次，
且 `openProject()` 走的是与 Electron **同一个** adopt 路径（`projectStore.openProject`）。

⚠️ 三条纪律（2026-11-04 踩出来的，别改回去）：
  ① **会话先起，再塞数据**：把 8MB 项目 JSON 分块塞进 `window.__projects`，
     然后 `openProject()` **不 await**（一调用就返回），再用一句极短的表达式
     （`performance.now()`）轮询"页面活过来了吗"。8MB 项目实测 adopt 只要 372ms，
     但**任何一条 `Runtime.evaluate` 都要等主线程**：把它当成"卡死"去重试 25 次，
     只会把 0.4s 的事故拖成 40s，还把真因（主线程某一帧 1s）埋掉。
  ② **探针要装心跳**：页面里 100ms 一跳，跑完看最长空洞 = 主线程最长同步占用。
  ③ **stdout 和 stderr 分开算**：PowerShell 的 `Tee-Object` 只收 stdout，
     Python 的 traceback 在 stderr —— 只看日志文件会把"异常退出"读成"静默死亡"。

用法：
  python scripts/tests/tools/shot_real_project.py                       # 整页 + 默认放大
  python scripts/tests/tools/shot_real_project.py --zoom 3 --focus longest
  python scripts/tests/tools/shot_real_project.py --focus center --zoom 2
  python scripts/tests/tools/shot_real_project.py --focus 1450,400 --zoom 4
产物：<out>/<tag>.png（整页）、<out>/<tag>-zoom.png（放大）、打印各阶段耗时与心跳空洞。
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
sys.path.insert(0, TESTS)
import run_tests as rt                                        # noqa: E402
from lib.cdp import CDP, wait_for                             # noqa: E402
from lib.helpers import ensure_data_ready                     # noqa: E402

DEFAULT_PROJECT = r'<用户目录>\Documents\SiTianProjects\示例项目.sitian'


def arg(name, default):
    a = sys.argv[1:]
    return a[a.index('--' + name) + 1] if ('--' + name) in a and a.index('--' + name) + 1 < len(a) else default


def flag(name):
    """无值开关（`--gen`）"""
    return ('--' + name) in sys.argv[1:]


def log(msg):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), msg), flush=True)


def ask(cdp, expr):
    """问页面一句短话；超时/异常都返回 (None, 耗时)，绝不抛。"""
    t = time.time()
    try:
        return cdp.eval(expr), time.time() - t
    except Exception as e:                                     # noqa: BLE001
        log('  问话失败（%.1fs）：%s' % (time.time() - t, str(e)[:90]))
        return None, time.time() - t


def shot(cdp, path):
    rep = cdp.send('Page.captureScreenshot', {'format': 'png'})
    data = (rep or {}).get('data') or ''
    if not data:
        raise RuntimeError('截图返回空')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(data))
    return len(data)


def pick_focus(project_path, key, focus):
    """按 --focus 选一个世界坐标中心。返回 (cx, cy, 说明)。"""
    if re.match(r'^-?\d+(\.\d+)?,-?\d+(\.\d+)?$', focus or ''):
        cx, cy = [float(x) for x in focus.split(',')]
        return cx, cy, '给定坐标'
    with open(project_path, 'r', encoding='utf-8') as f:
        j = json.load(f)
    bm = ((j.get('scenarios') or {}).get('baseMaps') or {}).get(key) or {}
    rivers = bm.get('rivers') or []
    terrain = bm.get('terrain') or []
    if focus == 'center' or not rivers:
        xs, ys = [], []
        for prov in terrain:
            for p in (prov.get('points') or []):
                xs.append(p.get('x', p[0] if isinstance(p, list) else 0))
                ys.append(p.get('y', p[1] if isinstance(p, list) else 0))
        if not xs:
            return 0.0, 0.0, '无地形（退回原点）'
        return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, '陆地包围盒中心'
    best = max(rivers, key=lambda r: len(r.get('points') or []))
    pts = best.get('points') or []
    cx = sum(p['x'] for p in pts) / len(pts)
    cy = sum(p['y'] for p in pts) / len(pts)
    return cx, cy, '最长的一条河（%d 个点 / %s）' % (len(pts), best.get('id', '?'))


def main():
    project = arg('project', DEFAULT_PROJECT)
    key = arg('key', 'desite')
    zoom = float(arg('zoom', '2.5'))
    focus = arg('focus', 'longest')
    gen = flag('gen')
    out = arg('out', os.path.join(rt.ROOT, 'build', 'regen-terrain'))
    tag = arg('tag', 'real-%s' % key)
    if not os.path.isfile(project):
        log('项目不存在：%s' % project)
        return 1
    os.makedirs(out, exist_ok=True)
    cx, cy, why = pick_focus(project, key, focus)
    log('放大中心 = (%.1f, %.1f)  ← %s' % (cx, cy, why))

    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            log('端口 %d 被占用 —— 先停掉别的演练（run_tests / 视觉套件 / 旧截图脚本）' % port)
            return 2

    rt.setup_mock()
    handles, cdp = [], None
    try:
        dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=rt.ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT, timeout=120):
            raise RuntimeError('Vite 启动超时')
        edge = subprocess.Popen([
            rt.EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
            '--remote-debugging-port=%d' % rt.CDP_PORT, '--remote-allow-origins=*',
            '--user-data-dir=%s' % os.path.join(rt.ROOT, '.test-edge-profile'),
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
        # 🔴 清掉“上次未保存编辑”的恢复凭据（2026-11-04 踩到）：`RecoveryPanel` 一旦在
        #    localStorage 里看到 `sitian-session-backup` 就弹整页模态，把地图压暗 ——
        #    这层状态是**上一次演练**留下的（`--gen` 会触发自动保存的备份），不是用户数据。
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true');"
                 "localStorage.removeItem('sitian-session-backup');"
                 "localStorage.setItem('sitian-clean-shutdown', 'true'); 1")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='跳过首启后重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        # 兜底：万一还有恢复面板，点“丢弃备份”（测试档里的备份，不是真实项目数据）
        dismissed, _ = ask(cdp, """(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.textContent || '').trim() === '丢弃备份'); if (b) { b.click(); return 'dismissed'; } return 'none'; })()""")
        if dismissed == 'dismissed':
            log('已丢弃上一次演练留下的恢复备份（只在这个测试档里）')
            time.sleep(0.5)
        ensure_data_ready(cdp, timeout=90)

        # 心跳 + 页面错误收集（必须装在打开项目之前）
        cdp.eval("""(() => {
          window.__hb = []; window.__errs = [];
          window.__hbTimer = setInterval(() => window.__hb.push(Math.round(performance.now())), 100);
          window.addEventListener('error', e => window.__errs.push('error: ' + (e.message || '')));
          window.addEventListener('unhandledrejection', e => window.__errs.push('reject: ' + String((e.reason && e.reason.message) || e.reason)));
          const ce = console.error;
          console.error = function () { window.__errs.push('console: ' + Array.from(arguments).map(String).join(' ').slice(0, 300)); return ce.apply(console, arguments); };
          return 'ok';
        })()""")

        with open(project, 'r', encoding='utf-8') as f:
            raw = f.read()
        path = 'real/%s' % os.path.basename(project)
        log('项目 %d 字节 / %.1f MB' % (len(raw), len(raw) / 1048576.0))

        # 🔴 每块都要**只回一个长度**（2026-11-04 实测）：`window.__realJson += <块>`
        #    这个表达式自身的返回值就是**累积后的整串**，`returnByValue` 会把 300KB→8MB
        #    一路回传，注入 8MB 项目要 28s，且每一块都像"页面卡住"。回长度后 <2s。
        t0 = time.time()
        cdp.eval("window.__realJson = ''; 1")
        step = 300 * 1024
        for i in range(0, len(raw), step):
            cdp.eval("window.__realJson += %s; window.__realJson.length" % json.dumps(raw[i:i + step]))
        log('注入耗时 %.1fs（%d 块）' % (time.time() - t0, (len(raw) + step - 1) // step))

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
        for _ in range(60):
            time.sleep(0.2)
            done, _ = ask(cdp, "JSON.stringify(window.__openDone)")
            if done and done != 'null':
                break
        log('openProject 结果：%s' % done)

        # 进剧本视图（点击本身返回很快；渲染是异步的）
        clicked, _ = ask(cdp, """(() => { const b = Array.from(document.querySelectorAll('button'))
          .find(x => (x.textContent || '').includes('历史剧本')); if (b) { b.click(); return 'clicked'; } return 'no-btn'; })()""")
        log('点历史剧本：%s' % clicked)
        if clicked != 'clicked':
            return 4
        ok_canvas = False
        for _ in range(40):
            v, _ = ask(cdp, "!!document.querySelector('.scenario-map-container canvas')")
            if v:
                ok_canvas = True
                break
            time.sleep(0.5)
        if not ok_canvas:
            diag, _ = ask(cdp, """JSON.stringify({ btns: Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(Boolean).slice(0,20),
              body: (document.body.innerText||'').slice(0, 200) })""")
            log('画布没出现，现场：%s' % diag)
            return 5
        log('画布已出现')

        # 选底图 + 适屏 + 渲染
        view, _ = ask(cdp, """(() => {
          const wrap = document.querySelector('.scenario-map-container');
          const sm = wrap.__vueParentComponent.setupState;
          if (sm.baseMapKey !== %s) { sm.baseMapKey = %s; if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange(); }
          if (typeof sm.fitToView === 'function') sm.fitToView();
          return JSON.stringify({ key: sm.baseMapKey, fitScale: sm.cameraScale, w: wrap.clientWidth, h: wrap.clientHeight });
        })()""" % (json.dumps(key), json.dumps(key)))
        log('适屏：%s' % view)
        try:
            info = json.loads(view) if isinstance(view, str) else {}
        except Exception:                                      # noqa: BLE001
            info = {}

        def apply_zoom():
            """把镜头推到 --focus 指向的中心（fit × --zoom）。幂等：重复调用结果相同。"""
            did, _ = ask(cdp, """(() => {
              const wrap = document.querySelector('.scenario-map-container');
              const sm = wrap.__vueParentComponent.setupState;
              const fit = %s;
              sm.cameraScale = Math.max(%s, fit * %s);
              sm.cameraX = wrap.clientWidth / 2 - (%s) * sm.cameraScale;
              sm.cameraY = wrap.clientHeight / 2 - (%s) * sm.cameraScale;
              if (typeof sm.renderNow === 'function') sm.renderNow();
              else if (typeof sm.render === 'function') sm.render();
              return JSON.stringify({ scale: sm.cameraScale });
            })()""" % (json.dumps(float(info.get('fitScale') or 1)), json.dumps(0.02),
                       json.dumps(zoom), json.dumps(cx), json.dumps(cy)))
            log('放大：%s' % did)
            time.sleep(1.5)

        # `--gen`：在页内对这张底图跑一次“生成地形”（**只在内存里**，mock 不落盘），
        # 用来验证“生成即出注记/河”这条链路在真实 415 省项目上真的成立，并看图。
        if gen:
            got, _ = ask(cdp, """(() => {
              try {
                const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
                const r = s.synthesizeBaseMapTerrain(%s, { force: true, labels: true, rivers: true });
                const bm = s.baseMaps && s.baseMaps[%s] ? s.baseMaps[%s] : {};
                const labels = Array.isArray(bm.terrainLabels) ? bm.terrainLabels : [];
                return JSON.stringify({ ok: !!(r && r.ok), cells: r && r.cellCount,
                  labels: labels.length, labelsAdded: (r && r.labelsAdded) || 0,
                  names: labels.map(l => l.kind + ':' + l.name).slice(0, 12),
                  rivers: (bm.rivers || []).length, msg: (r && r.message || '').slice(0, 200) });
              } catch (e) { return JSON.stringify({ ok: false, err: String((e && e.message) || e) }); }
            })()""" % (json.dumps(key), json.dumps(key), json.dumps(key)))
            log('生成（页内，不落盘）：%s' % got)
            ask(cdp, """(() => { const wrap = document.querySelector('.scenario-map-container');
              const sm = wrap.__vueParentComponent.setupState;
              if (typeof sm.fitToView === 'function') sm.fitToView();
              if (typeof sm.renderNow === 'function') sm.renderNow(); else if (typeof sm.render === 'function') sm.render();
              return 1; })()""")
            time.sleep(1.2)
            view2, _ = ask(cdp, """(() => { const wrap = document.querySelector('.scenario-map-container');
              const sm = wrap.__vueParentComponent.setupState;
              return JSON.stringify({ fitScale: sm.cameraScale, w: wrap.clientWidth, h: wrap.clientHeight }); })()""")
            try:
                info = json.loads(view2) if isinstance(view2, str) else info
            except Exception:                                  # noqa: BLE001
                pass

        # `--no-relief`：关掉地形浮雕底（产品自带的排障开关 `window.__SITIAN_SCENARIO_RELIEF__`），
        # 用来二分“这圈阴影是浮雕栅格还是别的图层画的”。
        if flag('no-relief'):
            ask(cdp, """(() => { window.__SITIAN_SCENARIO_RELIEF__ = false;
              const wrap = document.querySelector('.scenario-map-container');
              const sm = wrap.__vueParentComponent.setupState;
              if (typeof sm.renderNow === 'function') sm.renderNow(); else if (typeof sm.render === 'function') sm.render();
              return 1; })()""")
            log('已关掉浮雕底（__SITIAN_SCENARIO_RELIEF__ = false）')
            time.sleep(0.6)

        # `--set key=value[,key=value]`：直接改 setupState 上的开关（排障：这层到底是哪一层画的）
        set_opt = arg('set', '')
        if set_opt:
            pairs = []
            for kv in set_opt.split(','):
                if '=' not in kv:
                    continue
                k, v = kv.split('=', 1)
                raw = v
                if v in ('true', 'false'):
                    raw = v
                elif v.replace('.', '', 1).isdigit():
                    raw = v
                else:
                    raw = json.dumps(v)
                pairs.append('%s: %s' % (k.strip(), raw))
            expr = """(() => { const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              const sets = {%s};
              for (const k of Object.keys(sets)) { try { sm[k] = sets[k]; } catch (e) {} }
              if (typeof sm.renderNow === 'function') sm.renderNow(); else if (typeof sm.render === 'function') sm.render();
              return JSON.stringify(Object.keys(sets)); })()""" % ', '.join(pairs)
            got, _ = ask(cdp, expr)
            log('改状态：%s' % got)
            time.sleep(0.5)

        # `--river-source base|auto|both`：只画某一层河，用来二分“交叉是哪一层画的”
        src_opt = arg('river-source', '')
        if src_opt:
            ask(cdp, """(() => { const wrap = document.querySelector('.scenario-map-container');
              const sm = wrap.__vueParentComponent.setupState;
              sm.riverSource = %s;
              if (typeof sm.renderNow === 'function') sm.renderNow(); else if (typeof sm.render === 'function') sm.render();
              return 1; })()""" % json.dumps(src_opt))
            log('河流来源设为 %s' % src_opt)
            time.sleep(0.5)

        # `--hide-rivers`：点掉面板上的“河流”勾选（用来确认画面上的青线到底是不是河）
        if flag('hide-rivers'):
            got, _ = ask(cdp, """(() => {
              const labels = Array.from(document.querySelectorAll('label'))
                .filter((l) => (l.textContent || '').includes('河流'));
              const lab = labels.find((l) => l.querySelector('input[type=checkbox]'));
              const box = lab && lab.querySelector('input[type=checkbox]');
              if (!box) return 'no-box:' + labels.map((l) => (l.textContent || '').trim()).join('|').slice(0, 60);
              if (box.checked) box.click();
              return box.checked ? 'still-on' : 'off';
            })()""")
            log('取消“河流”勾选：%s' % got)
            time.sleep(0.6)

        # `--dump-rivers`：把**本帧真正描边的折线**导成 JSON（排障：断没断 / 连没连）
        if flag('dump-rivers'):
            ask(cdp, """(() => { window.__SITIAN_DUMP_RIVERS__ = true;
              const wrap = document.querySelector('.scenario-map-container');
              const sm = wrap.__vueParentComponent.setupState;
              if (typeof sm.renderNow === 'function') sm.renderNow(); else if (typeof sm.render === 'function') sm.render();
              return 1; })()""")
            time.sleep(0.5)

        # `--probe-capture`：画布指纹 × 截图 四态对照（2026-11-04 第十九修）
        # 判的是"屏幕上那层到底是不是本帧画的"：同一页面内改四步状态，每步同时取
        #   ① 画布的像素指纹（getImageData 采样 FNV，不落盘、不依赖截图）
        #   ② Page.captureScreenshot 的 PNG 哈希
        # 两者**同向变动** = 合成链干净；**画布变了而 PNG 不变** = 截图拿的是旧表面
        # （那就是"截图与几何对不上"的真因，不用再去几何里找）。
        if flag('probe-capture'):
            fp_js = """(() => {
              const cvs = document.querySelector('.scenario-canvas-wrap canvas');
              if (!cvs) return JSON.stringify({ fp: 'no-canvas' });
              const g = cvs.getContext('2d');
              let d;
              try { d = g.getImageData(0, 0, cvs.width, cvs.height).data; }
              catch (e) { return JSON.stringify({ fp: 'getImageData-failed', err: String(e && e.message) }); }
              let h = 2166136261 >>> 0, n = 0;
              for (let i = 0; i < d.length; i += 397) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; n++; }
              const flog = window.__SITIAN_FRAME_LOG__ || [];
              return JSON.stringify({
                fp: h.toString(16) + ':' + n, size: cvs.width + 'x' + cvs.height,
                draw: window.__RIVER_DRAW__ || null,
                frames: flog.length, last: flog.length ? flog[flog.length - 1] : null,
              });
            })()"""

            def probe(label):
                info_s, _ = ask(cdp, fp_js)
                p = os.path.join(out, '%s-probe-%s.png' % (tag, label))
                shot(cdp, p)
                with open(p, 'rb') as f:
                    png = hashlib.sha256(f.read()).hexdigest()[:16]
                log('探针 %-10s 画布 %s | PNG %s' % (label, info_s, png))
                return info_s, png

            def render_now():
                ask(cdp, """(() => { const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
                  if (typeof sm.renderNow === 'function') sm.renderNow();
                  else if (typeof sm.render === 'function') sm.render();
                  return 1; })()""")
                time.sleep(0.4)

            probe('base')
            # 记下原值：探针把“河流”关了之后**必须还原**，否则后面的整页/放大图里河全没了
            # （2026-11-04 真踩：look12b 的放大图一条河都没有，看着像“把河改没了”）。
            keep_flags, _ = ask(cdp, """(() => { const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              return JSON.stringify({ showRivers: sm.showRivers }); })()""")
            # ① 真实开关：勾掉“河流”（若画布不变 → 这层根本没受开关管）
            # ⚠️ 必须写 `showRivers`（ref，proxyRefs 会解包）；`showRiverBase` 是 computed，直接赋值会抛
            #    “computed value is readonly” —— 第一版探针就栽在这上面（改了没生效、还看不出错）。
            asked, _ = ask(cdp, """(() => { const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              try { sm.showRivers = false; } catch (e) { return 'set-failed:' + String(e && e.message); }
              return JSON.stringify({ showRivers: sm.showRivers, showRiverBase: sm.showRiverBase }); })()""")
            log('关“河流”开关：%s' % asked)
            render_now()
            probe('flag-off')
            # ② 抽掉数据（缓存键是数组引用 → 曲线必须重建、画布必须变）
            keep, _ = ask(cdp, """(() => {
              const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              const k = sm.baseMapKey;
              if (!s.baseMaps || !s.baseMaps[k]) return 'no-basemap';
              window.__savedRivers = s.baseMaps[k].rivers;
              s.baseMaps[k].rivers = [];
              return 'cleared:' + k; })()""")
            log('抽掉河数据：%s' % keep)
            render_now()
            probe('data-empty')
            # ③ 放回去：必须回到与 base 同一指纹（否则说明画的是缓存里的旧几何）
            ask(cdp, """(() => {
              const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              const k = sm.baseMapKey;
              s.baseMaps[k].rivers = window.__savedRivers || [];
              return 'restored'; })()""")
            render_now()
            probe('data-back')
            flog, _ = ask(cdp, "JSON.stringify((window.__SITIAN_FRAME_LOG__ || []).slice(-6))")
            log('最近 6 帧：%s' % flog)

        # `--probe-cross`：在**页面里**把"真横穿"（段中 × 段中，端点容差按世界单位给）画成红圈再截图。
        # 为什么在页面里算：投影用的就是渲染器自己的 `cameraX/cameraY/cameraScale`，
        # 离线再猜一次 transform 只会多一个错源（这一轮已经因此浪费过时间）。
        if flag('probe-cross'):
            cam0, _ = ask(cdp, """(() => { const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              return JSON.stringify([sm.cameraX, sm.cameraY, sm.cameraScale]); })()""")
            if zoom > 0:
                apply_zoom()          # 红圈要画在**放大后**的同一机位上，才能和 crop 对着看
            got, _ = ask(cdp, """(() => {
              const drawn = window.__RIVER_DRAWN__ || [];
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              const cvs = document.querySelector('.scenario-canvas-wrap canvas');
              const c = cvs.getContext('2d');
              const S = sm.cameraScale, X = sm.cameraX, Y = sm.cameraY;
              const segs = [];
              for (let ri = 0; ri < drawn.length; ri++) {
                const p = drawn[ri].pts || [];
                for (let i = 0; i + 1 < p.length; i++) segs.push({ ri, a: p[i], b: p[i + 1] });
              }
              const CELL = 8, grid = new Map();
              for (const s of segs) {
                const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / CELL), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / CELL);
                const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / CELL), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / CELL);
                for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
                  const k = cx + ',' + cy;
                  if (!grid.has(k)) grid.set(k, []);
                  grid.get(k).push(s);
                }
              }
              const TOL = 0.35;   // 端点容差（世界单位）：焊接接点落在中心线上，量化后会有 0.01 级漂移
              const out = [];
              const seen = new Set();
              const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
              for (const list of grid.values()) {
                for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
                  const s1 = list[i], s2 = list[j];
                  if (s1.ri === s2.ri) continue;
                  const kk = s1.ri < s2.ri ? s1.ri + ':' + s2.ri : s2.ri + ':' + s1.ri;
                  const rx = s1.b[0] - s1.a[0], ry = s1.b[1] - s1.a[1];
                  const sx = s2.b[0] - s2.a[0], sy = s2.b[1] - s2.a[1];
                  const den = cross([rx, ry], [sx, sy]);
                  if (Math.abs(den) < 1e-12) continue;
                  const ox = s2.a[0] - s1.a[0], oy = s2.a[1] - s1.a[1];
                  const t = cross([ox, oy], [sx, sy]) / den;
                  const u = cross([ox, oy], [rx, ry]) / den;
                  if (!(t > 0 && t < 1 && u > 0 && u < 1)) continue;
                  const L1 = Math.hypot(rx, ry), L2 = Math.hypot(sx, sy);
                  if (t * L1 < TOL || (1 - t) * L1 < TOL) continue;
                  if (u * L2 < TOL || (1 - u) * L2 < TOL) continue;
                  const p = [s1.a[0] + rx * t, s1.a[1] + ry * t];
                  const key = Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2);
                  if (seen.has(key)) continue;
                  seen.add(key);
                  out.push(p);
                }
              }
              c.save();
              c.setTransform(1, 0, 0, 1, 0, 0);
              for (const p of out) {
                const px = X + p[0] * S, py = Y + p[1] * S;
                c.beginPath(); c.arc(px, py, 6, 0, Math.PI * 2);
                c.strokeStyle = 'rgba(255, 32, 32, 0.95)'; c.lineWidth = 2; c.stroke();
              }
              // 汇流点（尾巴被焊在主干上的河）打品红点 —— 判“这一版有没有把这些点挪开”
              let nJ = 0;
              for (const r of drawn) {
                if (!r.j) continue;
                const q = (r.pts || [])[(r.pts || []).length - 1];
                if (!q) continue;
                nJ += 1;
                const px = X + q[0] * S, py = Y + q[1] * S;
                c.beginPath(); c.arc(px, py, 4, 0, Math.PI * 2);
                c.fillStyle = 'rgba(220, 20, 200, 0.9)'; c.fill();
              }
              // 取景中心十字（--focus 那个世界坐标到底落在画面哪一处）
              const fx = X + %s * S, fy = Y + %s * S;
              c.strokeStyle = 'rgba(0, 200, 255, 0.95)'; c.lineWidth = 2;
              c.beginPath(); c.moveTo(fx - 18, fy); c.lineTo(fx + 18, fy);
              c.moveTo(fx, fy - 18); c.lineTo(fx, fy + 18); c.stroke();
              c.beginPath(); c.arc(fx, fy, 22, 0, Math.PI * 2); c.stroke();
              c.restore();
              return JSON.stringify({ n: out.length, segs: segs.length, junctions: nJ,
                sample: out.slice(0, 8).map((p) => [Math.round(p[0]), Math.round(p[1])]) });
            })()""" % (json.dumps(float(cx)), json.dumps(float(cy))))
            log('页内横穿红圈：%s' % got)
            time.sleep(0.3)
            p3 = os.path.join(out, tag + '-cross.png')
            log('横穿标注截图 %d 字节 → %s' % (shot(cdp, p3), p3))
            # 还原整页机位（后面的 p1 是“整页”口径，不能被这次放大污染）
            try:
                cx0, cy0, sc0 = json.loads(cam0 or '[]')
                ask(cdp, """(() => { const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
                  sm.cameraX = %s; sm.cameraY = %s; sm.cameraScale = %s;
                  if (typeof sm.renderNow === 'function') sm.renderNow();
                  else if (typeof sm.render === 'function') sm.render();
                  return 'restored'; })()""" % (json.dumps(cx0), json.dumps(cy0), json.dumps(sc0)))
                time.sleep(0.4)
            except Exception:                                  # noqa: BLE001
                log('还原机位失败（后面的整页图会是放大后的机位）')

        time.sleep(1.2)
        p1 = os.path.join(out, tag + '.png')
        log('整页截图 %d 字节 → %s' % (shot(cdp, p1), p1))
        if flag('dump-rivers'):
            dumped, _ = ask(cdp, "JSON.stringify(window.__RIVER_DRAWN__ || [])")
            # ⚠️ 空导出的两种含义必须分开（2026-11-04 踩到）：页面真没画河 / 这条通道自己失败了。
            #    18:08 那次落了个 2 字节的 `[]`，而同一帧的截图里有河 —— 于是有人拿它当"这一帧没河"的证据。
            #    这里改成：空就重试一次，仍空就明确报出来，不再静默写 `[]`。
            if not isinstance(dumped, str) or dumped in ('', '[]'):
                log('⚠ 河流折线导出为空，重试一次（空导出可能只是通道失败，不等于没画河）')
                ask(cdp, """(() => { window.__RIVER_DRAWN__ = null;
                  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
                  if (typeof sm.renderNow === 'function') sm.renderNow(); else if (typeof sm.render === 'function') sm.render();
                  return 1; })()""")
                time.sleep(0.5)
                dumped, _ = ask(cdp, "JSON.stringify(window.__RIVER_DRAWN__ || [])")
                if not isinstance(dumped, str) or dumped in ('', '[]'):
                    log('⚠ 仍然为空 —— 这一帧**确实没有**可描的河折线（不要把这条当成“几何没问题”的证据）')
            jp = os.path.join(out, tag + '-drawn.json')
            with open(jp, 'w', encoding='utf-8') as f:
                f.write(dumped if isinstance(dumped, str) else '[]')
            log('河流折线已导出 → %s（%d 字节）' % (jp, len(dumped or '')))

        # 放大到 --focus 指向的中心
        if zoom and zoom > 0:
            apply_zoom()
            p2 = os.path.join(out, tag + '-zoom.png')
            log('放大截图 %d 字节 → %s' % (shot(cdp, p2), p2))

        dbg, _ = ask(cdp, """(() => {
          const out = { draw: window.__RIVER_DRAW__ || null };
          try {
            const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
            out.src = sm.riverSource;
            out.autoN = (sm.autoRivers || []).length;
            out.autoSegN = (sm.autoRiverSegments || []).length;
            out.baseN = ((sm.baseMap && sm.baseMap.rivers) || []).length;
            const rect = document.querySelector('.scenario-map-container').getBoundingClientRect();
            out.rect = { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
            out.camera = { x: sm.cameraX, y: sm.cameraY, scale: sm.cameraScale };
          } catch (e) { out.err = String(e && e.message); }
          return JSON.stringify(out);
        })()""")
        log('河流绘制自检：%s' % dbg)
        errs, _ = ask(cdp, "JSON.stringify((window.__errs || []).slice(0, 12))")
        log('页面错误：%s' % errs)
        hb, _ = ask(cdp, "JSON.stringify(window.__hb)")
        try:
            arr = json.loads(hb) if isinstance(hb, str) else []
        except Exception:                                      # noqa: BLE001
            arr = []
        gaps = sorted(((arr[i] - arr[i - 1], arr[i - 1]) for i in range(1, len(arr))), reverse=True)[:5]
        log('心跳 %d 点 / 最长空洞（毫秒@起点）: %s' % (len(arr), ' '.join('%d@%d' % (d, t) for d, t in gaps)))
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
