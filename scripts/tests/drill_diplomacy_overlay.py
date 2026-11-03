#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""外交表浮层的真机判据（2026-11-03）

背景：`ScenarioMap` 里的浮层（外交 / 派生 / FMG）在**无头回归环境**里曾出现"状态为真、DOM 里却没有节点"，
只能靠人眼点一次确认。当时的观测是在 **HMR 过的页面**上做的。本工具用**全新导航（整页加载）**复现同一条链路：

  ① 铺一个带两个势力的剧本 → 点“更多 → 外交”→ 断言 `[data-testid=diplomacy-panel]` **真的在 DOM 里**；
  ② 截图（`Page.captureScreenshot`，DOM 浮层只有它能拍 —— canvas dataURL 里没有 HTML）；
  ③ 点关闭 → 断言 DOM 里**零节点**；
  ④ 再开一次 → 再关一次（证明不是"只能开一次"）。

判据全在 DOM 上：面板在 = 过；面板不在 = 红并打印当时的 `diplomacyOpen` 状态与 DOM 计数（区分"没开"与"开了没渲染"）。

用法：python scripts/tests/drill_diplomacy_overlay.py
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

OUT_DIR = os.path.join(rt.ROOT, 'build', 'diplomacy-overlay')

SCENE_JS = """(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = '外交判据底图';
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '外交判据底图' });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  const rects = [
    [[0, 0], [200, 0], [200, 160], [0, 160]],
    [[200, 0], [400, 0], [400, 160], [200, 160]],
  ];
  let i = 0;
  while ((s.baseMaps[KEY].terrain || []).length < 2 && i < 2) {
    const pts = rects[i].map(([x, y]) => ({ x, y }));
    s.addBaseProvince(KEY, { id: 'dip_prov_' + i, name: '外交省' + (i + 1), points: pts, biome: 'temperate' },
      { checkOverlap: false });
    i++;
  }
  if (s.scenarios && typeof s.removeScenario === 'function') {
    for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  }
  s.createScenario(KEY + '/外交时代', {
    ownerKey: KEY, name: '外交时代', order: 1,
    era: { roman: 'I', label: '交', startYear: '1300', endYear: '1400' },
    polities: [
      { id: 'DIP_A', name: '甲国', color: '#b23b3b' },
      { id: 'DIP_B', name: '乙国', color: '#3b6fb2' },
    ],
    ownership: { dip_prov_0: 'DIP_A', dip_prov_1: 'DIP_B' },
  });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  sm.tlDate = { y: 1350, m: null, d: null };
  const ids = sm.timeline.scenarios.map(x => x.id);
  sm.tlEra = Math.max(0, ids.indexOf(KEY + '/外交时代'));
  sm.selectedPolity = null;
  sm.selectedProvinceIds = [];
  if (typeof sm.fitToView === 'function') sm.fitToView();
  if (typeof sm.render === 'function') sm.render();
  return JSON.stringify({ ok: true, provinces: (s.baseMaps[KEY].terrain || []).length, scenarios: ids.length });
})()"""

STATE_JS = """(() => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const panel = document.querySelector('[data-testid="diplomacy-panel"]');
  const wrap = document.querySelector('[data-testid="diplomacy-wrap"]');
  const text = panel ? (panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '';
  return JSON.stringify({
    open: !!SM.diplomacyOpen, panel: !!panel, wrap: !!wrap,
    panels: document.querySelectorAll('[data-testid="diplomacy-panel"]').length,
    text,
  });
})()"""

CLICK_JS = """(() => {
  const b = document.querySelector('[data-testid="%s"]');
  if (!b) return JSON.stringify({ ok: false, why: 'no-button' });
  b.click();
  return JSON.stringify({ ok: true, cls: b.className });
})()"""

CLICK_SEL_JS = """(() => {
  const b = document.querySelector(%s);
  if (!b) return JSON.stringify({ ok: false, why: 'no-selector' });
  b.click();
  return JSON.stringify({ ok: true });
})()"""

HAS_JS = """(() => JSON.stringify({
  more: !!document.querySelector('[data-testid="diplomacy-open"]'),
  palette: !!document.querySelector('[data-testid="diplomacy-open-palette"]'),
}))()"""


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return ok


def state(cdp):
    ok, st = eval_json(cdp, STATE_JS, required=('panel',), desc='读外交表 DOM')
    return st if ok else {}


def click_sel(cdp, sel, desc):
    ok, r = eval_json(cdp, CLICK_SEL_JS % json.dumps(sel), required=('ok',), desc=desc)
    time.sleep(0.35)
    return ok and bool(r.get('ok')), r


def shot(cdp, name):
    rep = cdp.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
    data = (rep or {}).get('data') or ''
    if not data:
        return None
    path = os.path.join(OUT_DIR, f'{name}.png')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(data))
    return path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            print(f'  ❌ 端口 {port} 已被占用（先停掉正在跑的回归/演练）', flush=True)
            return 2

    bad = 0
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
        # ⚠️ 关键：再来一次**整页加载**（不是 HMR 补丁）——"状态真 / DOM 空"的旧观测是在 HMR 页上做的
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

        sc_ok, sc = eval_json(cdp, SCENE_JS, required=('ok',), desc='铺外交判据场景')
        bad += 0 if ck('场景已铺设', bool(sc_ok) and bool(sc.get('ok')),
                       f"省 {sc.get('provinces')} / 剧本 {sc.get('scenarios')}") else 1
        time.sleep(0.6)

        bad += 0 if ck('开局：面板不在 DOM 里', not state(cdp).get('panel'), json.dumps(state(cdp), ensure_ascii=False)) else 1

        # ① 从“更多 → 外交”点开（先展开“更多”，否则那个按钮不在 DOM 里）
        ok_more, rm = click_sel(cdp, 'button[title^="更多"]', '展开“更多”')
        bad += 0 if ck('展开了“更多”下拉', ok_more, json.dumps(rm, ensure_ascii=False)[:60]) else 1
        has = eval_json(cdp, HAS_JS, required=('more',), desc='查两条入口')[1]
        bad += 0 if ck('“更多”里能看到外交按钮', bool(has.get('more')), json.dumps(has, ensure_ascii=False)) else 1
        ok_open, r = click_sel(cdp, '[data-testid="diplomacy-open"]', '点“更多 → 外交”')
        bad += 0 if ck('找到并点了“外交”按钮', ok_open, json.dumps(r, ensure_ascii=False)[:80]) else 1
        st = state(cdp)
        bad += 0 if ck('开：diplomacyOpen = true', st.get('open') is True, json.dumps(st, ensure_ascii=False)) else 1
        bad += 0 if ck('开：面板真的在 DOM 里（不是"状态真、DOM 空"）', st.get('panel') is True,
                       json.dumps(st, ensure_ascii=False)) else 1
        bad += 0 if ck('开：DOM 里只有一份面板', st.get('panels') == 1, f"panels={st.get('panels')}") else 1

        # ①b 关键回归：把“更多”收起，面板**必须还在**（2026-11-03 的 bug 就是它跟着下拉一起消失）
        click_sel(cdp, 'button[title^="更多"]', '收起“更多”')
        time.sleep(0.3)
        st_after_more = state(cdp)
        bad += 0 if ck('收起“更多”后面板仍在（面板不再挂在下拉里）', st_after_more.get('panel') is True,
                       json.dumps(st_after_more, ensure_ascii=False)) else 1

        if st.get('text'):
            print(f"  · 面板文本：{st['text'][:80]}", flush=True)
        png = shot(cdp, 'open')
        print(f'  → {png}', flush=True)

        # ② 关闭
        ok_close, rc = click_sel(cdp, '[data-testid="diplomacy-close"]', '点面板关闭')
        bad += 0 if ck('找到并点了关闭按钮', ok_close, json.dumps(rc, ensure_ascii=False)[:80]) else 1
        st2 = state(cdp)
        bad += 0 if ck('关：diplomacyOpen = false', st2.get('open') is False, json.dumps(st2, ensure_ascii=False)) else 1
        bad += 0 if ck('关：DOM 里零节点', st2.get('panel') is False and st2.get('panels') == 0,
                       json.dumps(st2, ensure_ascii=False)) else 1

        # ③ 势力色板那条捷径入口（2026-11-03 之前这条是**静默无效**的：它不开下拉，面板永远不会渲染）
        ok_pal, rp = click_sel(cdp, '[data-testid="diplomacy-open-palette"]', '点势力色板行的“外交”')
        st5 = state(cdp)
        bad += 0 if ck('色板入口也能开（两条入口同一个面板）', ok_pal and st5.get('panel') is True,
                       json.dumps(st5, ensure_ascii=False)) else 1
        click_sel(cdp, '[data-testid="diplomacy-close"]', '关闭')
        st6 = state(cdp)
        bad += 0 if ck('色板入口开的也能关掉', st6.get('panel') is False, json.dumps(st6, ensure_ascii=False)) else 1

        # ④ 顺带复测旧笔记那条：“无头环境里 Teleport 子节点进不了 body”
        #    拿 FMG 浮层（`Teleport to="body"`）直接验：置 fmgOpen → 看它在不在 DOM、在不在 body。
        #    结论两种都要写回文档：进得去 → 旧口径作废；进不去 → 那批浮层要改成外交表这种就地渲染。
        eval_json(cdp, """(() => {
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          SM.fmgOpen = true;
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='置 fmgOpen')
        time.sleep(0.35)
        t_ok, tp = eval_json(cdp, """(() => JSON.stringify({
          open: !!document.querySelector('.scenario-map-container').__vueParentComponent.setupState.fmgOpen,
          inDom: !!document.querySelector('[data-testid="fmg-wrap"]'),
          underBody: !!document.querySelector('body > [data-testid="fmg-wrap"]'),
        }))()""", required=('inDom',), desc='查 FMG 浮层落点')
        print(f"  · Teleport 复测：{json.dumps(tp, ensure_ascii=False)}", flush=True)
        if tp.get('open'):
            bad += 0 if ck('Teleport 浮层（FMG）在无头环境里进了 DOM', tp.get('inDom') is True,
                           json.dumps(tp, ensure_ascii=False)) else 1
            print(('  · 进 body：是（旧笔记“进不了 body”作废）' if tp.get('underBody')
                   else '  · 进 body：**否**（挂在 #app 下 —— 旧笔记的现象仍在，只是不影响可见性）'), flush=True)
        eval_json(cdp, """(() => {
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          SM.fmgOpen = false;
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='复位 fmgOpen')

        print(('  ✅ 外交表浮层判据通过' if not bad else f'  🔴 {bad} 项没过'), flush=True)
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
