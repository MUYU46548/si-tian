#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""六个浮层的**视觉判据**（层级 / 遮挡 / 暗色主题可读性，2026-11-03）

背景（用户上一轮的原话）：*“六个浮层的视觉检查（层级/遮挡/暗色主题）——上轮只验了 DOM 存在，
没验看得清、不挡画布”*。

已有的 `drill_diplomacy_overlay.py` 只回答“面板**在不在 DOM 里**”。那只能抓住“点了没反应”，
抓不住下面这些**只在屏幕上才看得见**的毛病（本工具就是为此写的）：

  · 面板被别的东西盖住（`elementFromPoint(面板中心)` 命中的不是面板）→ 用户点不到、也看不清；
  · 面板跑出视口（fixed + top 偏移 + 宽 780，小窗口/缩放后会溢出）→ 一半在屏幕外；
  · 面板透明/背景缺失（Tailwind 变量出了主题作用域就断，本仓踩过）→ 字叠在画布上糊成一团；
  · 暗色主题下文字与底色的对比度不够 → “看得见框、读不清字”；
  · **同一块面板被复制成两份**（2026-11-03 真实踩到：地形注记的 Teleport 被复制，两个 `v-if` 同一状态，
    面板精确重叠；`querySelector` 永远只看得到第一个，所以 DOM 用例全绿）。
    → 本工具的判据是 `querySelectorAll(...).length === 1`，不是 `!!querySelector(...)`。

判据（每个面板 7 条 + 关掉后 2 条）：
  v1 包装节点**恰好 1 个**；v2 可见面积 ≥ 40,000 px²；v3 完整落在视口内（容差 2px）；
  v4 面板中心点命中的是面板自己（没有被盖）；v5 有效背景 alpha ≥ 0.9；
  v6 正文对比度 ≥ 4.5:1（WCAG AA，暗色主题）；v7 不占画布 85% 以上（不整块挡死）；
  v8 关掉后零节点；v9 关掉后画布中心重新可命中。
  另：每块面板留一张整页截图（`Page.captureScreenshot` —— canvas dataURL 里没有 HTML 浮层）。

用法：python scripts/tests/drill_scenario_overlays_visual.py
产物：build/overlays-visual/<panel>.png + summary.json
"""
import base64
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_tests as rt                                          # noqa: E402
from lib.cdp import CDP, wait_for, eval_json                    # noqa: E402
from lib.helpers import ensure_data_ready, open_harness_project  # noqa: E402

OUT_DIR = os.path.join(rt.ROOT, 'build', 'overlays-visual')

# 控制台默认编码在 Windows 上是 GBK：显式切 UTF-8，否则一条符号（✅ / ▶）就会让脚本崩在
# `UnicodeEncodeError` 上 —— 那不是断言失败，是压根没开始跑（2026-11-03 实测）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass

# 六个浮层：入口按钮 / 包装 testid / 开状态名 / 人话名 / 入口在哪
PANELS = [
    dict(btn='basemap-terrain-params', wrap='terrain-gen-wrap', state='terrainGenOpen',
         label='地形生成参数', where='daily'),
    dict(btn='basemap-fmg-terrain', wrap='fmg-wrap', state='fmgOpen',
         label='FMG 模板地形', where='daily'),
    dict(btn='basemap-generate-landmass', wrap='landmass-wrap', state='landmassOpen',
         label='造陆', where='daily'),
    dict(btn='basemap-derive-culture', wrap='derive-wrap', state='deriveOpen',
         label='文化/宗教/势力派生', where='daily'),
    dict(btn='diplomacy-open', wrap='diplomacy-wrap', state='diplomacyOpen',
         label='外交表', where='daily'),
    dict(btn='basemap-terrain-labels', wrap='terrain-labels-wrap', state='terrainLabelsOpen',
         label='地形注记', where='basemap'),
]

SCENE_JS = """(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = '浮层视觉底图';
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '浮层视觉底图' });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  const rects = [
    [[0, 0], [200, 0], [200, 160], [0, 160]],
    [[200, 0], [400, 0], [400, 160], [200, 160]],
  ];
  let i = 0;
  while ((s.baseMaps[KEY].terrain || []).length < 2 && i < 2) {
    const pts = rects[i].map(([x, y]) => ({ x, y }));
    s.addBaseProvince(KEY, { id: 'ovl_prov_' + i, name: '浮层省' + (i + 1), points: pts, biome: 'temperate' },
      { checkOverlap: false });
    i++;
  }
  // 高度图：地形注记 / 派生 两个入口是 `v-if="baseMapHasHeightmap"`，没有它按钮不渲染（不是 bug）
  let hmPts = 0;
  if (typeof s.synthesizeBaseMapTerrain === 'function') {
    s.synthesizeBaseMapTerrain(KEY, { seed: 11 });
    const hm = typeof s.getHeightmapFor === 'function' ? s.getHeightmapFor(KEY) : null;
    hmPts = hm && hm.grid && hm.grid.points ? hm.grid.points.length : 0;
  }
  if (s.scenarios && typeof s.removeScenario === 'function') {
    for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  }
  s.createScenario(KEY + '/浮层时代', {
    ownerKey: KEY, name: '浮层时代', order: 1,
    era: { roman: 'I', label: '浮', startYear: '1300', endYear: '1400' },
    polities: [
      { id: 'OVL_A', name: '甲国', color: '#b23b3b' },
      { id: 'OVL_B', name: '乙国', color: '#3b6fb2' },
    ],
    ownership: { ovl_prov_0: 'OVL_A', ovl_prov_1: 'OVL_B' },
  });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  sm.tlDate = { y: 1350, m: null, d: null };
  const ids = sm.timeline.scenarios.map(x => x.id);
  sm.tlEra = Math.max(0, ids.indexOf(KEY + '/浮层时代'));
  if (typeof sm.fitToView === 'function') sm.fitToView();
  if (typeof sm.render === 'function') sm.render();
  return JSON.stringify({ ok: true, provinces: (s.baseMaps[KEY].terrain || []).length,
                          scenarios: ids.length, hmPts });
})()"""

# 一次把“面板几何 + 层级 + 配色”全取回来（全在 DOM/计算样式上，不读组件状态）
# ⚠️ 关键口径：**不能拿包装节点当面板**。外交表的包装是 `fixed inset-0`（整屏、pointer-events-none），
#    拿它算面积/遮挡会得到“占画布 100%”这种假红（2026-11-03 首跑实测）。这里取
#    **最内层那个真正上了不透明背景、且面积 ≥20,000 px² 的元素** = 用户眼睛看到的那块面板。
MEASURE_JS = """(() => {
  const W = %s;
  const els = document.querySelectorAll('[data-testid="' + W + '"]');
  const out = { wrap: W, count: els.length };
  if (!els.length) return JSON.stringify(out);
  const el = els[0];
  const parse = (s) => {
    const m = String(s || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const box = (b) => ({ x: Math.round(b.x), y: Math.round(b.y),
                        w: Math.round(b.width), h: Math.round(b.height),
                        right: Math.round(b.right), bottom: Math.round(b.bottom) });
  // 选“看得见的那块面板”：自己或后代里，有不透明背景、面积够大、取**面积最小**的那个
  let target = el, tArea = Infinity;
  for (const n of [el, ...el.querySelectorAll('*')]) {
    const r = n.getBoundingClientRect();
    if (r.width < 80 || r.height < 40) continue;
    const c = parse(getComputedStyle(n).backgroundColor);
    if (!c || c.a < 0.9) continue;
    const a = r.width * r.height;
    if (a < 20000) continue;
    if (a < tArea) { tArea = a; target = n; }
  }
  const r = el.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  let bg = null, node = target;
  while (node) {
    const c = parse(getComputedStyle(node).backgroundColor);
    if (c && c.a > 0.05) { bg = c; break; }
    node = node.parentElement;
  }
  // 正文字色：`target` 自己可能只是"上了底色"的那层（`.gen-float` 的 color 是继承来的黑），
  //   真要判"读不读得清"，得取**第一段真正的文字**所在元素的 color。
  let fgNode = target;
  (function findText(n) {
    if (fgNode !== target) return;
    for (const ch of n.childNodes) {
      if (ch.nodeType === 3 && String(ch.textContent || '').trim()) { fgNode = n; return; }
    }
    for (const ch of n.children) { findText(ch); if (fgNode !== target) return; }
  })(target);
  const fg = parse(getComputedStyle(fgNode).color) || { r: 0, g: 0, b: 0, a: 1 };  let contrast = 0;
  if (bg) {
    const l1 = lum(fg), l2 = lum(bg);
    contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  const cx = Math.round(tr.x + tr.width / 2), cy = Math.round(tr.y + tr.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  const canvas = document.querySelector('.scenario-map-container canvas');
  const cbox = canvas ? canvas.getBoundingClientRect() : null;
  const tb = document.querySelector('.scenario-toolbar');
  const tbox = tb ? tb.getBoundingClientRect() : null;
  const inter = (a, b) => {
    if (!a || !b) return 0;
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
    return Math.round(w * h);
  };
  const canvasBox = cbox ? box(cbox) : null;
  out.wrapBox = box(r);
  out.panelBox = box(tr);
  out.panelSel = target.tagName.toLowerCase()
    + (typeof target.className === 'string' && target.className
       ? '.' + target.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  out.viewport = { w: window.innerWidth, h: window.innerHeight };
  out.bg = bg;
  out.fg = fg;
  out.contrast = Math.round(contrast * 100) / 100;
  out.hitInside = !!(hit && (hit === el || el.contains(hit)));
  out.hitTag = hit ? (hit.tagName.toLowerCase() + (typeof hit.className === 'string' && hit.className
    ? '.' + hit.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')) : '';
  out.hitCenter = { x: cx, y: cy };
  out.canvasBox = canvasBox;
  out.overlapCanvas = canvasBox ? inter(out.panelBox, canvasBox) : 0;
  out.canvasArea = canvasBox ? canvasBox.w * canvasBox.h : 0;
  out.toolbarBox = tbox ? box(tbox) : null;
  out.overlapToolbar = tbox ? inter(out.panelBox, tbox) : 0;
  out.textLen = (target.textContent || '').replace(/\\s+/g, ' ').trim().length;
  return JSON.stringify(out);
})()"""

CLICK_BTN_JS = """(() => {
  const b = document.querySelector('[data-testid="%s"]');
  if (!b) return JSON.stringify({ ok: false, why: 'no-button' });
  if (b.disabled) return JSON.stringify({ ok: false, why: 'disabled' });
  b.click();
  return JSON.stringify({ ok: true });
})()"""

OPEN_MORE_JS = """(() => {
  const b = document.querySelector('button[title^="更多"]');
  if (!b) return JSON.stringify({ ok: false });
  if (!document.querySelector('[data-testid="basemap-terrain-params"]')) b.click();
  return JSON.stringify({ ok: true, expanded: !!document.querySelector('[data-testid="basemap-terrain-params"]') });
})()"""

# 关掉面板：优先点面板自己的「取消 / 关闭」按钮（走产品路径）；找不到才回落到置状态
CLOSE_JS = """(() => {
  const el = document.querySelectorAll('[data-testid="%s"]')[0];
  if (!el) return JSON.stringify({ ok: false, why: 'not-open' });
  const btns = Array.from(el.querySelectorAll('button'));
  const byTestId = el.querySelector('[data-testid$="-cancel"], [data-testid$="-close"]');
  if (byTestId) { byTestId.click(); return JSON.stringify({ ok: true, via: 'testid' }); }
  const byText = btns.find((b) => /取消|关闭|完成|收起/.test(b.textContent || ''));
  if (byText) { byText.click(); return JSON.stringify({ ok: true, via: 'text' }); }
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  SM.%s = false;
  return JSON.stringify({ ok: true, via: 'state' });
})()"""

SET_MODE_JS = """(() => {
  const b = document.querySelector('[data-testid="basemap-edit-toggle"]');
  if (!b) return JSON.stringify({ ok: false, why: 'no-toggle' });
  b.click();
  return JSON.stringify({ ok: true });
})()"""

CANVAS_HIT_JS = """(() => {
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ canvas: false });
  const r = cv.getBoundingClientRect();
  const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  return JSON.stringify({ canvas: true, onCanvas: !!(hit && cv.contains(hit)), tag: hit ? hit.tagName.toLowerCase() : '' });
})()"""


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return bool(ok)


def shot(cdp, name):
    rep = cdp.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
    data = (rep or {}).get('data') or ''
    if not data:
        return None
    p = os.path.join(OUT_DIR, f'{name}.png')
    with open(p, 'wb') as f:
        f.write(base64.b64decode(data))
    return p


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
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
            '--no-first-run', '--no-default-browser-check',
            '--no-sandbox', 'about:blank',
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
        bad += 0 if ck('harness 项目已打开', ok, json.dumps(info, ensure_ascii=False)[:100]) else 1

        got, res = eval_json(cdp, """(() => {
          const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('历史剧本'));
          if (!b) return JSON.stringify({ ok: false, why: 'no-btn' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='进历史剧本')
        if not got or not res.get('ok'):
            ck('进入剧本视图', False, res)
            return 1
        wait_for(cdp, "!!document.querySelector('.scenario-map-container canvas')", timeout=60, desc='剧本画布挂载')
        time.sleep(0.8)

        sc_ok, sc = eval_json(cdp, SCENE_JS, required=('ok',), desc='铺浮层视觉场景')
        bad += 0 if ck('场景已铺设', bool(sc_ok) and bool(sc.get('ok')),
                       f"省 {sc.get('provinces')} / 剧本 {sc.get('scenarios')} / 高度图格 {sc.get('hmPts')}") else 1
        time.sleep(0.8)
        bad += 0 if ck('基线底图有高度图（地形注记/派生入口才会渲染）', int(sc.get('hmPts') or 0) > 0) else 1

        # 基准：开局画布中心可命中、六个面板都不在 DOM 里
        c0 = eval_json(cdp, CANVAS_HIT_JS, required=('canvas',), desc='开局画布命中')[1]
        bad += 0 if ck('开局：画布中心命中的是画布', bool(c0.get('onCanvas')), json.dumps(c0, ensure_ascii=False)) else 1
        open_count = eval_json(cdp, """(() => JSON.stringify({
          n: %s,
        }))()""" % ' + '.join(
            ['document.querySelectorAll(\'[data-testid="%s"]\').length' % p['wrap'] for p in PANELS]),
            required=('n',), desc='开局面板计数')[1].get('n')
        bad += 0 if ck('开局：六个浮层都不在 DOM 里', open_count == 0, f'合计 {open_count} 个节点') else 1

        # ── 日常行四个 + 外交：先展开“更多”（入口都在里面）──
        more_ok, more = eval_json(cdp, OPEN_MORE_JS, required=('ok',), desc='展开“更多”')
        # ⚠️ 不判 `expanded`：Vue 的 DOM 更新是异步的，`click()` 之后同一 tick 里查不到新节点
        #    （本仓铁律：读 DOM 前先等一拍）。这里只看“点到了按钮”，节点在不在由下面的入口点击回答。
        bad += 0 if ck('展开了“更多”（生成类入口在里面）', bool(more_ok) and more.get('ok'),
                       json.dumps(more, ensure_ascii=False)[:80]) else 1
        time.sleep(0.3)

        for p in PANELS:
            if p['where'] == 'basemap':
                continue          # 地形注记单独一条：入口只在底图编辑模式里
            print(f"\n── {p['label']} ──", flush=True)
            # 每块面板前都确认一次“更多”是展开的：生成类面板关掉时下拉可能被一起收起，
            # 下一块的入口就不在 DOM 里了（那不是浮层的问题，是这批入口都在下拉里）。
            eval_json(cdp, OPEN_MORE_JS, required=('ok',), desc='确认“更多”已展开')
            time.sleep(0.2)
            ok_b, rb = eval_json(cdp, CLICK_BTN_JS % p['btn'], required=('ok',), desc='点入口·' + p['label'])
            time.sleep(0.45)
            bad += 0 if ck('入口点得开·' + p['label'], bool(ok_b) and rb.get('ok'),
                           json.dumps(rb, ensure_ascii=False)[:70]) else 1
            m = eval_json(cdp, MEASURE_JS % json.dumps(p['wrap']), required=('count',), desc='量·' + p['label'])[1]
            records.append({'panel': p['label'], 'wrap': p['wrap'], 'measure': m})
            bad += panel_checks(p, m)
            png = shot(cdp, p['wrap'])
            if png:
                print(f'  → {png}', flush=True)
            ok_c, rc = eval_json(cdp, CLOSE_JS % (p['wrap'], p['state']), required=('ok',), desc='关·' + p['label'])
            time.sleep(0.35)
            bad += after_close(cdp, p, rc if ok_c else {})

        # ── 地形注记：入口只在底图编辑模式（`v-if="basemapEditMode"` 的工具栏里）──
        p = [x for x in PANELS if x['where'] == 'basemap'][0]
        print(f"\n── {p['label']}（底图编辑模式）──", flush=True)
        ok_m, rm = eval_json(cdp, SET_MODE_JS, required=('ok',), desc='进底图编辑')
        time.sleep(0.6)
        bad += 0 if ck('进入底图编辑模式', bool(ok_m) and rm.get('ok'),
                       json.dumps(rm, ensure_ascii=False)[:60]) else 1
        ok_b, rb = eval_json(cdp, CLICK_BTN_JS % p['btn'], required=('ok',), desc='点入口·' + p['label'])
        time.sleep(0.45)
        bad += 0 if ck('入口点得开·' + p['label'], bool(ok_b) and rb.get('ok'),
                       json.dumps(rb, ensure_ascii=False)[:70]) else 1
        m = eval_json(cdp, MEASURE_JS % json.dumps(p['wrap']), required=('count',), desc='量·' + p['label'])[1]
        records.append({'panel': p['label'], 'wrap': p['wrap'], 'measure': m})
        bad += panel_checks(p, m)
        png = shot(cdp, p['wrap'])
        if png:
            print(f'  → {png}', flush=True)
        ok_c, rc = eval_json(cdp, CLOSE_JS % (p['wrap'], p['state']), required=('ok',), desc='关·' + p['label'])
        time.sleep(0.35)
        bad += after_close(cdp, p, rc if ok_c else {})
        eval_json(cdp, """(() => { const b = document.querySelector('[data-testid="basemap-exit"]');
                  if (b) b.click(); return JSON.stringify({ ok: true }); })()""",
                  required=('ok',), desc='退出底图编辑')
        time.sleep(0.4)

        with open(os.path.join(OUT_DIR, 'summary.json'), 'w', encoding='utf-8') as f:
            json.dump({'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'bad': bad,
                       'panels': records}, f, ensure_ascii=False, indent=1)
        print(('  ✅ 六个浮层视觉判据通过' if not bad else f'  🔴 {bad} 项没过'), flush=True)
        print(f'  产物目录：{OUT_DIR}', flush=True)
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


def panel_checks(p, m):
    """单块面板的 7 条视觉判据。返回失败数。"""
    bad = 0
    label = p['label']
    box = m.get('panelBox') or {}
    wrap = m.get('wrapBox') or {}
    vp = m.get('viewport') or {}
    bad += 0 if ck(f'v1 恰好 1 个包装节点·{label}', m.get('count') == 1,
                   f"count={m.get('count')}（>1 = 同一块面板被复制成多份）") else 1
    area = (box.get('w') or 0) * (box.get('h') or 0)
    bad += 0 if ck(f'v2 面板可见面积 ≥40,000 px²·{label}', area >= 40000,
                   f'{box.get("w")}×{box.get("h")} = {area}（{m.get("panelSel")}）') else 1
    inside = (box.get('x', -1) >= -2 and box.get('y', -1) >= -2
              and box.get('right', 1e9) <= vp.get('w', 0) + 2
              and box.get('bottom', 1e9) <= vp.get('h', 0) + 2)
    bad += 0 if ck(f'v3 完整落在视口内·{label}', inside,
                   f'面板 {box} / 视口 {vp}') else 1
    bad += 0 if ck(f'v4 面板中心没被别的东西盖住·{label}', m.get('hitInside') is True,
                   f"命中的是 {m.get('hitTag')}") else 1
    bg = m.get('bg') or {}
    bad += 0 if ck(f'v5 有效背景不透明（alpha ≥0.9）·{label}', (bg.get('a') or 0) >= 0.9,
                   f'背景 {bg}') else 1
    bad += 0 if ck(f'v6 正文对比度 ≥4.5:1（暗色主题）·{label}', (m.get('contrast') or 0) >= 4.5,
                   f"对比度 {m.get('contrast')}（字 {m.get('fg')} / 底 {bg}）") else 1
    ca = m.get('canvasArea') or 0
    frac = (m.get('overlapCanvas') or 0) / ca if ca else 0
    bad += 0 if ck(f'v7 不整块挡死画布（占用 ≤85%）·{label}', frac <= 0.85,
                   f'占画布 {round(frac * 100, 1)}%（与工具栏重叠 {m.get("overlapToolbar")} px²）') else 1
    return bad


def after_close(cdp, p, rc):
    bad = 0
    label = p['label']
    n = eval_json(cdp, """(() => JSON.stringify({
      n: document.querySelectorAll('[data-testid="%s"]').length,
    }))()""" % p['wrap'], required=('n',), desc='关后计数·' + label)[1].get('n')
    bad += 0 if ck(f'v8 关掉后零节点·{label}', n == 0, f'count={n}（关闭方式：{rc.get("via", "?")}）') else 1
    c = eval_json(cdp, CANVAS_HIT_JS, required=('canvas',), desc='关后画布命中·' + label)[1]
    bad += 0 if ck(f'v9 关掉后画布中心可再命中·{label}', bool(c.get('onCanvas')),
                   f"命中的是 {c.get('tag')}") else 1
    return bad


if __name__ == '__main__':
    sys.exit(main())
