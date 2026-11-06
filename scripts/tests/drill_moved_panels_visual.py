#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""**搬家后的面板视觉留影 + 判据**（2026-11-06，配合 ScenarioMap 拆分）

为什么要这个文件：2026-11-06 把 7 个界面块从 `ScenarioMap.vue` 拆进 `scenario/panels/`
（图层锁定 / 聚落编辑 / 从留底恢复 / 剧本管理对话框 / 左侧剧本列表 / 省份属性 / 标记属性）。
它们**每一块都带着自己的 scoped 样式一起搬**，DOM 用例能证明"行为没变"，但证明不了"长得没变"：
`<style scoped>` 换了 scope id、共享 CSS 走了另一个入口 —— 这类事故只在屏幕上现形。

做法：Vite + Edge headless + CDP（与 `drill_scenario_overlays_visual.py` 同一套 harness），
用它的 `SCENE_JS` 铺一块有省份 / 有剧本 / 有势力归属的底图，然后把 7 块面板**逐一打开**：

  · 断判据（每块 4 条）：`querySelectorAll(...).length === 1`（不许复制成两份）/ 可见面积 > 0 /
    完整落在视口内 / 面板中心点命中的是面板自己（不被盖住）；
  · 留一张**按元素裁切**的截图 `build/panels-visual/<key>.png`（不含画布，便于搬前/搬后逐像素比）；
  · 记下每个面板的 `textContent` 摘要（SHA1）与几何，写进 `summary.json`。

**搬前/搬后怎么比**：同一份脚本在拆分前的提交上再跑一遍（临时 worktree + node_modules junction），
把两次产物分别放到 `build/panels-visual/after/` 与 `before/`，用
`python scripts/tests/tools/diff_panel_shots.py` 比像素与文本。

用法：python scripts/tests/drill_moved_panels_visual.py [--out build/panels-visual]
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_tests as rt                                               # noqa: E402
from lib.cdp import CDP, wait_for, eval_json                         # noqa: E402
from lib.helpers import ensure_data_ready, open_harness_project      # noqa: E402
# 场景铺设只有一份实现（六个浮层的视觉演练已经写过）：直接借用，别在这里抄第二份
import drill_scenario_overlays_visual as ov                          # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass

OUT = os.path.join(rt.ROOT, 'build', 'panels-visual')
for i, a in enumerate(sys.argv[1:]):
    if a == '--out' and i + 2 <= len(sys.argv[1:]):
        OUT = os.path.abspath(sys.argv[i + 2])

# 每一块：怎么开、怎么关、节点选择器。⚠️ 顺序有讲究 —— `.province-props` 同时命中标记面板
# （标记面板是 `province-props marker-props`），所以省份面板必须先拍、先关。
PANELS = [
    dict(key='scenario-list', sel='[data-testid="scenario-list-panel"]', label='左侧历史剧本列表',
         open="(() => 1)()", close="(() => 1)()"),
    dict(key='province-props', sel='.province-props:not(.marker-props)', label='省份属性面板',
         open="sm.selectedProvince = (s.baseMaps[KEY].terrain || [])[0]; sm.showProps = true;",
         close="sm.showProps = false;"),
    dict(key='marker-props', sel='[data-testid="marker-props"]', label='标记属性面板',
         open=("sm.viewMode = 'scenario';"
               "sm.selectedMarker = { id: 'ovl_marker', name: '浮层标记', type: 'city', x: 120, y: 80 };"
               "sm.showMarkerPanel = true;"),
         close="sm.showMarkerPanel = false;"),
    dict(key='layer-lock', sel='.layer-lock-panel', label='图层锁定面板',
         open="sm.showLayerPanel = true;", close="sm.showLayerPanel = false;"),
    dict(key='burg-editor', sel='.burg-editor-panel', label='聚落编辑面板',
         open=("sm.editingBurg = { id: 'ovl_burg', name: '浮层聚落', size: 'city',"
               " population: 1200, culture: '甲', capital: 0 }; sm.burgEditorOpen = true;"),
         close="sm.burgEditorOpen = false;"),
    dict(key='basemap-source', sel='.bmsrc-panel', label='从留底恢复底图面板',
         open="sm.sourceRestoreLoading = true; sm.sourceRestoreOpen = true;",
         close="sm.sourceRestoreOpen = false; sm.sourceRestoreLoading = false;"),
    dict(key='scenario-manager', sel='.modal-dialog', label='剧本管理对话框',
         open="sm.showScenarioManager = true;", close="sm.showScenarioManager = false;"),
]

TICK = "new Promise(r => setTimeout(r, 260))"

MEASURE_JS = """(() => {
  const el = document.querySelector(%s);
  if (!el) return JSON.stringify({ count: 0, panelSel: %s });
  const all = document.querySelectorAll(%s);
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  const cs = getComputedStyle(el);
  const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
  return JSON.stringify({
    count: all.length,
    panelSel: %s,
    box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
           h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    hitInside: hit ? (hit === el || el.contains(hit)) : false,
    hitTag: hit ? (hit.className || hit.tagName) : '',
    bg: cs.backgroundColor,
    textLen: text.length,
  });
})()"""


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return bool(ok)


def capture(cdp, box, path):
    """整页截图 → 按元素矩形裁切（用 PIL 在本地裁）。

    ⚠️ 2026-11-06 实测：`Page.captureScreenshot` 带 `clip` 参数在本机**不生效**（拿回来的还是整页，
       而且先试 `fromSurface:false` 会拿到一帧**空白**—— 于是 7 块面板的图全都一模一样、
       比对结果假绿）。所以改成「绝对可靠的整页截图 + 本地裁切」：
       整页截图这条路径在 `drill_scenario_overlays_visual.py` 里已经跑了上百次。
    """
    data = ''
    try:
        rep = cdp.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
        data = (rep or {}).get('data') or ''
    except Exception:                                            # noqa: BLE001
        data = ''
    if not data:
        return False
    raw = base64.b64decode(data)
    try:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(raw))
        x = max(0, int(box.get('x') or 0))
        y = max(0, int(box.get('y') or 0))
        w = max(1, int(box.get('w') or img.size[0]))
        h = max(1, int(box.get('h') or img.size[1]))
        img.crop((x, y, min(x + w, img.size[0]), min(y + h, img.size[1]))).save(path)
        return True
    except Exception:                                            # noqa: BLE001
        with open(path, 'wb') as f:                              # 退化成整页，别让判据假绿
            f.write(raw)
        return True


def main():
    os.makedirs(OUT, exist_ok=True)
    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            print(f'  ❌ 端口 {port} 已被占用（先停掉正在跑的回归/演练）', flush=True)
            return 2

    bad = 0
    records = []
    rt.setup_mock()
    handles, cdp = [], None
    try:
        dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=rt.ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT, timeout=120):
            raise RuntimeError('Vite dev server 启动超时')
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
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='整页加载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ensure_data_ready(cdp, timeout=90)
        ok, info = open_harness_project(cdp)
        bad += 0 if ck('harness 项目已打开', ok, json.dumps(info, ensure_ascii=False)[:80]) else 1

        got, res = eval_json(cdp, """(() => {
          const b = Array.from(document.querySelectorAll('button'))
            .find(x => (x.textContent || '').includes('历史剧本'));
          if (!b) return JSON.stringify({ ok: false, why: 'no-btn' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='进历史剧本')
        if not got or not res.get('ok'):
            ck('进入剧本视图', False, res)
            return 1
        wait_for(cdp, "!!document.querySelector('.scenario-map-container canvas')", timeout=60, desc='剧本画布')
        time.sleep(0.8)

        sc_ok, sc = eval_json(cdp, ov.SCENE_JS, required=('ok',), desc='铺场景')
        bad += 0 if ck('场景已铺设', bool(sc_ok) and bool(sc.get('ok')),
                       f"省 {sc.get('provinces')} / 剧本 {sc.get('scenarios')}") else 1
        time.sleep(0.6)

        for p in PANELS:
            js = ("""(() => {
              const KEY = '浮层视觉底图';
              const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              %s
              return JSON.stringify({ ok: true });
            })()""" % p['open'])
            o = eval_json(cdp, js, required=('ok',), desc='开·' + p['label'])
            cdp.eval(TICK)
            m = eval_json(cdp, MEASURE_JS % (json.dumps(p['sel']), json.dumps(p['sel']),
                                            json.dumps(p['sel']), json.dumps(p['sel'])),
                          required=('count',), desc='量·' + p['label'])[1]
            # textContent 的摘要回 Python 侧算（JS 侧没有 sha1），用于“搬前/搬后文案是否一字不差”
            txt = cdp.eval("""(() => { const el = document.querySelector(%s);
              return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400) : ''; })()"""
                           % json.dumps(p['sel']))
            sha = hashlib.sha1((txt or '').encode('utf-8')).hexdigest()
            box = m.get('box') or {}
            area = (box.get('w') or 0) * (box.get('h') or 0)
            vp = m.get('viewport') or {}
            inside = (box.get('x', -1) >= -2 and box.get('y', -1) >= -2
                      and box.get('right', 10 ** 9) <= vp.get('w', 0) + 2
                      and box.get('bottom', 10 ** 9) <= vp.get('h', 0) + 2)
            label = p['label']
            bad += 0 if ck(f'恰好 1 个节点·{label}', m.get('count') == 1, f"count={m.get('count')}") else 1
            bad += 0 if ck(f'有可见面积·{label}', area > 4000, f"{box.get('w')}×{box.get('h')}") else 1
            bad += 0 if ck(f'完整在视口内·{label}', bool(inside), f'{box} / 视口 {vp}') else 1
            bad += 0 if ck(f'中心点命中的是面板自己·{label}', m.get('hitInside') is True,
                           f"命中 {m.get('hitTag')}") else 1

            png = os.path.join(OUT, p['key'] + '.png')
            shot_ok = capture(cdp, box, png) if box else False
            bad += 0 if ck(f'截图落盘·{label}', shot_ok,
                           os.path.basename(png) if shot_ok else '拿不到帧') else 1
            records.append(dict(key=p['key'], label=label, sel=p['sel'], box=box, vp=vp,
                                count=m.get('count'), textSha=sha, textLen=len(txt or ''),
                                text=(txt or '')[:200], png=os.path.basename(png) if shot_ok else None))

            cjs = ("""(() => {
              const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              %s
              return JSON.stringify({ ok: true });
            })()""" % p['close'])
            eval_json(cdp, cjs, required=('ok',), desc='关·' + label)
            cdp.eval(TICK)

        with open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf-8') as f:
            json.dump({'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'bad': bad,
                       'root': rt.ROOT, 'panels': records}, f, ensure_ascii=False, indent=1)
        print(('  ✅ 7 块面板视觉判据全过' if not bad else f'  🔴 {bad} 项没过'), flush=True)
        print(f'  产物目录：{OUT}', flush=True)
        return 0 if not bad else 1
    finally:
        for h in reversed(handles):
            try:
                h.stop()
            except Exception:
                pass
        try:
            rt.teardown_mock()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
