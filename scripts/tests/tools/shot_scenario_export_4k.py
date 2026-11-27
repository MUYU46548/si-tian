#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""剧本侧 4K 出图（Vite + Edge headless + mock IPC，**只读**）——2026-11-27

目的（交接 `HANDOFF_20261126.md` §2 第一件）：
  用**产品自己的导出入口**导一张 4K PNG（长边 ≥ 3840），
  不改 JSON、不截画布、不另写一套绘制；顺带拍一张应用界面截图对照。

怎么走：
  1. `run_tests.setup_mock()`（只改仓库内 index.html / mock 数据，真实库零污染）；
  2. 把 `.sitian` 原文分块塞进 `window.__projects[...]`，再用**产品自己的**
     `projectStore.openProject()` 打开（与 Electron 同一条 adopt 路径）；
  3. 点「历史剧本」→ 卡片墙第一张 → 选底图/剧本 → 适屏；
  4. 展开「更多」→ 把“导出尺寸”切到 **4K** → 真鼠标点「导出 PNG」；
     `saveExportFile` 被替换成“收下 dataUrl 不弹框”（与 test_100 同一手法）；
  5. 分块取回 dataUrl → 落 `build/export-4k/<tag>-<stamp>.png`；
  6. 打印 PNG 尺寸 / 字节 / SVG 尺寸 / 页面错误；退出码 0 = 出图成功且长边 ≥ 3840。

用法：
  python scripts/tests/tools/shot_scenario_export_4k.py
  python scripts/tests/tools/shot_scenario_export_4k.py --project <某.sitian> --key <底图键> --scenario <剧本id前缀>
  python scripts/tests/tools/shot_scenario_export_4k.py --tag sample
"""
import base64
import json
import os
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
sys.path.insert(0, TESTS)

import run_tests as rt                                               # noqa: E402
from lib.cdp import CDP, wait_for, fetch_string                      # noqa: E402
from lib.helpers import ensure_data_ready, open_toolbar_more         # noqa: E402

DEFAULT_PROJECT = os.path.join(rt.ROOT, 'sample', '示例世界.sitian')
DEFAULT_KEY = 'sample_land'
DEFAULT_SCENARIO = '示例时代一'
DEFAULT_YEAR = 200


def arg(name, default):
    a = sys.argv[1:]
    return a[a.index('--' + name) + 1] if ('--' + name) in a and a.index('--' + name) + 1 < len(a) else default


def log(msg):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), msg), flush=True)


def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(33)
    return struct.unpack('>II', head[16:24])


def shot(cdp, path):
    rep = cdp.send('Page.captureScreenshot', {'format': 'png'})
    data = (rep or {}).get('data') or ''
    if not data:
        raise RuntimeError('截图返回空')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(data))
    return len(data)


def ask(cdp, expr):
    t = time.time()
    try:
        return cdp.eval(expr), time.time() - t
    except Exception as e:                                          # noqa: BLE001
        log('  问话失败（%.1fs）：%s' % (time.time() - t, str(e)[:120]))
        return None, time.time() - t


def main():
    project = arg('project', DEFAULT_PROJECT)
    key = arg('key', DEFAULT_KEY)
    scenario = arg('scenario', DEFAULT_SCENARIO)
    year = int(arg('year', str(DEFAULT_YEAR)))
    tag = arg('tag', 'sample')
    out = arg('out', os.path.join(rt.ROOT, 'build', 'export-4k'))
    if not os.path.isfile(project):
        log('项目不存在：%s' % project)
        return 2
    os.makedirs(out, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    png_path = os.path.join(out, '%s-%s.png' % (tag, stamp))
    app_shot = os.path.join(out, '%s-%s-app.png' % (tag, stamp))

    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            log('端口 %d 被占用 —— 先停掉别的演练（run_tests / 视觉套件 / 其它截图脚本）' % port)
            return 3

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
        # 关掉首启免责声明 / 上一次演练留下的恢复面板（与 shot_real_project.py 同一手法）
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true');"
                 "localStorage.removeItem('sitian-session-backup');"
                 "localStorage.setItem('sitian-clean-shutdown', 'true'); 1")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='跳过首启后重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ensure_data_ready(cdp, timeout=90)

        # 页面错误 / 未处理拒绝：导出链路的“错误面板”底账
        cdp.eval("""(() => {
          window.__errs = [];
          window.addEventListener('error', e => window.__errs.push('error: ' + (e.message || '')));
          window.addEventListener('unhandledrejection', e => window.__errs.push('reject: ' + String((e.reason && e.reason.message) || e.reason)));
          const ce = console.error;
          console.error = function () { window.__errs.push('console: ' + Array.from(arguments).map(String).join(' ').slice(0, 300)); return ce.apply(console, arguments); };
          return 'ok';
        })()""")

        with open(project, 'r', encoding='utf-8') as f:
            raw = f.read()
        path = 'export4k/%s' % os.path.basename(project)
        log('项目 %d 字节 / %.1f MB' % (len(raw), len(raw) / 1048576.0))

        # 分块注入：每块只回长度（回整串会 8MB 往返，看着像卡死）
        cdp.eval("window.__realJson = ''; 1")
        for i in range(0, len(raw), 300 * 1024):
            cdp.eval("window.__realJson += %s; window.__realJson.length" % json.dumps(raw[i:i + 300 * 1024]))

        started = cdp.eval("""(async () => {
          try {
            const app = document.querySelector('#app').__vue_app__;
            const pinia = app.config.globalProperties.$pinia;
            const { useProjectStore } = await import('/src/store/projectStore.js');
            const proj = useProjectStore(pinia);
            window.__projects = window.__projects || {};
            window.__projects[%s] = JSON.parse(window.__realJson);
            window.__openDone = null;
            proj.openProject(%s).then(r => {
              window.__openDone = { ok: !!(r && r.success), err: (r && r.error) || '' };
            }).catch(e => { window.__openDone = { ok: false, err: String(e && e.message) }; });
            return 'started';
          } catch (e) { return 'ERR:' + (e && e.message); }
        })()""" % (json.dumps(path), json.dumps(path)))
        if started != 'started':
            log('openProject 发起失败：%s' % started)
            return 4
        for _ in range(80):
            time.sleep(0.25)
            done, _ = ask(cdp, "JSON.stringify(window.__openDone)")
            if done and done != 'null':
                break
        log('openProject：%s' % done)
        if not done or '"ok":true' not in str(done).replace(' ', ''):
            return 4

        # 进剧本视图：点页签 → 卡片墙点第一张（与 drill_w1_verdict / ENTER_JS 同一条路）
        enter = cdp.eval("""(async () => {
          const tick = ms => new Promise(r => setTimeout(r, ms));
          const tab = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('历史剧本'));
          if (!tab) return 'no-tab';
          tab.click();
          await tick(1400);
          const card = document.querySelector('.sp-card');
          if (card) { card.click(); await tick(1800); }
          return document.querySelector('.scenario-map-container') ? 'ok' : 'no-canvas';
        })()""")
        log('进剧本视图：%s' % enter)
        if enter != 'ok':
            return 5

        setup = cdp.eval("""(async () => {
          const tick = ms => new Promise(r => setTimeout(r, ms));
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          const ids = (SM.timeline && SM.timeline.scenarios || []).map(x => x.id);
          const want = %s;
          const idx = Math.max(0, ids.findIndex(x => x.indexOf(want) >= 0));
          if (SM.baseMapKey !== %s) {
            SM.baseMapKey = %s;
            if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
          }
          SM.tlEra = idx;
          SM.tlDate = { y: %d, m: null, d: null };
          await tick(600);
          if (typeof SM.fitToView === 'function') SM.fitToView();
          await tick(400);
          const b = SM.scenarioExport && SM.scenarioExport.buildScenarioSVG;
          let svgW = -1, svgH = -1;
          try {
            const built = b ? b() : null;
            svgW = built ? built.width : -1; svgH = built ? built.height : -1;
          } catch (e) { /* 导出自己会报 */ }
          return JSON.stringify({ ids, idx, baseMapKey: SM.baseMapKey, svgW, svgH,
                                  canvas: [SM.cw ? SM.cw() : null, SM.ch ? SM.ch() : null] });
        })()""" % (json.dumps(scenario), json.dumps(key), json.dumps(key), year))
        log('选底图/剧本：%s' % setup)
        try:
            setup_info = json.loads(setup) if isinstance(setup, str) else {}
        except Exception:                                           # noqa: BLE001
            setup_info = {}
        if setup_info.get('svgW', -1) <= 0:
            log('🔴 buildScenarioSVG 拿不到尺寸 —— 导出大概率也不会成')
            return 6

        if not open_toolbar_more(cdp):
            log('工具栏“更多”没展开（导出按钮在里面）')
            return 7

        exp = cdp.eval("""(async () => {
          const tick = ms => new Promise(r => setTimeout(r, ms));
          const fails = [], notes = {};
          window.__LAST_EXPORT__ = null;
          window.__EXPORT_CALLS__ = 0;
          window.sitianAPI.saveExportFile = async (o) => {
            window.__LAST_EXPORT__ = o; window.__EXPORT_CALLS__++;
            return { success: true, path: 'mock/export-4k.png' };
          };
          const sel = document.querySelector('[data-testid="export-scale"]');
          if (!sel) return JSON.stringify({ fails: ['导出尺寸选择框不在 DOM'], notes });
          sel.value = '4k';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await tick(250);
          notes.exportScale = sel.value;
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          SM.exportStatus = '';
          const btn = document.querySelector('[data-testid="export-png"]');
          if (!btn) return JSON.stringify({ fails: ['导出 PNG 按钮不在 DOM'], notes });
          // “更多”面板是可滚动浮层：导出那一行默认在折叠线以下。
          // 先滚到视口中央再点 —— 否则 elementFromPoint 命不中，"真鼠标"就是假的。
          btn.scrollIntoView({ block: 'center', inline: 'center' });
          await tick(250);
          const rc = btn.getBoundingClientRect();
          const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
          const top = document.elementFromPoint(cx, cy);
          notes.hitTarget = !!top && (top === btn || btn.contains(top));
          notes.btnRect = { x: Math.round(rc.left), y: Math.round(rc.top), w: Math.round(rc.width), h: Math.round(rc.height) };
          if (!notes.hitTarget) fails.push('导出按钮被挡住（elementFromPoint 不是它）');
          const mk = t => new MouseEvent(t, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0 });
          btn.dispatchEvent(mk('mousedown')); btn.dispatchEvent(mk('mouseup')); btn.dispatchEvent(mk('click'));
          let w = 0;
          while ((!window.__LAST_EXPORT__ || !/已导出 PNG/.test(String(SM.exportStatus || ''))) && w < 120000) {
            await tick(150); w += 150;
          }
          notes.waitedMs = w;
          notes.calls = window.__EXPORT_CALLS__;
          notes.status = SM.exportStatus;
          const du = String((window.__LAST_EXPORT__ || {}).dataUrl || '');
          notes.dataUrlLen = du.length;
          notes.dataUrlPrefix = du.slice(0, 22);
          if (!du) fails.push('没有 dataUrl（导出没走到 saveExportFile）');
          return JSON.stringify({ fails, notes });
        })()""")
        log('导出探针：%s' % str(exp)[:600])
        if not exp or '"fails":[]' not in str(exp).replace(' ', ''):
            log('🔴 导出失败')
            return 8

        data_url = fetch_string(
            cdp,
            "window.__LAST_EXPORT__ && window.__LAST_EXPORT__.dataUrl ? window.__LAST_EXPORT__.dataUrl.length : -1",
            lambda i, j: "window.__LAST_EXPORT__.dataUrl.slice(%d,%d)" % (i, j),
            chunk=524288, desc='取回 4K dataUrl')
        if not data_url.startswith('data:image/png;base64,'):
            log('dataUrl 前缀不对：%r' % data_url[:30])
            return 9
        with open(png_path, 'wb') as f:
            f.write(base64.b64decode(data_url.split(',', 1)[1]))
        w, h = png_size(png_path)
        log('4K PNG → %s（%d×%d，%d 字节 dataUrl）' % (png_path, w, h, len(data_url)))

        try:
            shot(cdp, app_shot)
            log('应用界面截图 → %s' % app_shot)
        except Exception as e:                                      # noqa: BLE001
            log('界面截图失败（不影响出图判据）：%s' % e)

        errs, _ = ask(cdp, "JSON.stringify(window.__errs || [])")
        log('页面错误：%s' % errs)
        if errs and errs not in ('[]', 'null'):
            log('🔴 导出过程中页面有错误')
            return 10
        if max(w, h) < 3840:
            log('🔴 长边 %d < 3840' % max(w, h))
            return 11
        log('✅ 4K 出图完成：长边 %d ≥ 3840' % max(w, h))
        return 0
    finally:
        for h in reversed(handles):
            try:
                subprocess.run(['taskkill', '/PID', str(h.proc.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:                                       # noqa: BLE001
                pass
        try:
            rt.teardown_mock()
        except Exception:                                           # noqa: BLE001
            log('teardown_mock 失败：检查 src/renderer/index.html.bak 与 mock-data/')


if __name__ == '__main__':
    sys.exit(main())
