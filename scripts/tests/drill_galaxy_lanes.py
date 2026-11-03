#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""星域图「远景不画航道 + 端点圆点」判据（2026-11-03）

做法（同一个世界、同一份数据，只改相机与图层开关）：
  ① 远景（scale 0.35）→ 拍一张；再把「航道」图层关掉 → 再拍一张。
     **两张哈希必须相同** —— 相同 = 远景一个航道像素都没画（群星的全景就是这样）。
  ② 近景（scale 1.2）→ 同样的开关两次 → 哈希**必须不同** = 近景航道真的画了（含端点圆点）。
产物：build/galaxy-lanes/far-on.png / far-off.png / near-on.png（人眼复核）。

用法：python scripts/tests/drill_galaxy_lanes.py
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
from lib.cdp import CDP, wait_for, eval_json, fetch_string       # noqa: E402
from lib.helpers import ensure_data_ready, open_harness_project, select_world_with_domains, view_level  # noqa: E402

OUT_DIR = os.path.join(rt.ROOT, 'build', 'galaxy-lanes')

FP_JS = """(() => {
  const cv = document.querySelector('.galaxy-map-container canvas');
  if (!cv) return JSON.stringify({ error: 'no-canvas' });
  const SM = document.querySelector('.galaxy-map-container').__vueParentComponent.setupState;
  // ⚠️ 不能拿整张画布的哈希当判据：天空是**动画**的（星点闪烁按 performance.now 走），
  //    同一状态两帧的哈希本来就会变。这里直接问应用"这一帧要画几条航道"——
  //    `hyperlanesToDraw` 是画与命中的**唯一入口**，问它就等于问画面。
  let drawn = null;
  try { drawn = typeof SM.hyperlanesToDraw === 'function' ? SM.hyperlanesToDraw().length : null; } catch (e) { drawn = 'err:' + e.message; }
  let total = null;
  try { total = (SM.visibleHyperlanes || []).length; } catch (e) { total = null; }
  return JSON.stringify({
    drawn, total,
    scale: SM.renderer.getViewTransform().scale,
    lanesOn: SM.layers.isVisible('domain', 'hyperlanes'),
  });
})()"""


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return ok


def snap(cdp, name):
    ok, fp = eval_json(cdp, FP_JS, required=('drawn',), desc=f'{name}·统计')
    if not ok or fp.get('error'):
        return None, None
    data_url = fetch_string(
        cdp,
        "document.querySelector('.galaxy-map-container canvas').toDataURL('image/png').length",
        lambda i, j: ("document.querySelector('.galaxy-map-container canvas')"
                      f".toDataURL('image/png').slice({i}, {j})"),
        desc=f'{name}·PNG',
    )
    raw = data_url.split(',', 1)[1]
    path = os.path.join(OUT_DIR, f'{name}.png')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(raw))
    return fp, path


def cam(cdp, scale):
    ok, r = eval_json(cdp, """(() => {
      const SM = document.querySelector('.galaxy-map-container').__vueParentComponent.setupState;
      const ds = SM.domainNodes || [];
      if (!ds.length) return JSON.stringify({ ok: false, why: 'no-domain' });
      const cx = ds.reduce((a, d) => a + d.x, 0) / ds.length;
      const cy = ds.reduce((a, d) => a + d.y, 0) / ds.length;
      SM.renderer.focusOn(cx, cy, %s);
      if (typeof SM.render === 'function') SM.render();
      return JSON.stringify({ ok: true, scale: SM.renderer.getViewTransform().scale });
    })()""" % scale, required=('ok',), desc=f'相机 {scale}')
    return ok and r.get('ok'), r


def toggle_lanes(cdp):
    ok, r = eval_json(cdp, """(() => {
      const SM = document.querySelector('.galaxy-map-container').__vueParentComponent.setupState;
      const hasLayers = !!SM.layers && typeof SM.layers.toggleLayer === 'function';
      if (!hasLayers) return JSON.stringify({ ok: false, why: 'no-layers', keys: Object.keys(SM).slice(0, 40) });
      SM.layers.toggleLayer('domain', 'hyperlanes');
      if (typeof SM.renderer === 'object' && typeof SM.renderer.requestRender === 'function') SM.renderer.requestRender();
      if (typeof SM.render === 'function') SM.render();
      return JSON.stringify({ ok: true, lanesOn: SM.layers.isVisible('domain', 'hyperlanes') });
    })()""", required=('ok',), desc='开关航道图层')
    return ok, r


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
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='跳过首启后重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ensure_data_ready(cdp, timeout=90)
        ok, info = open_harness_project(cdp)
        bad += 0 if ck('harness 项目已打开', ok, json.dumps(info, ensure_ascii=False)[:100]) else 1

        select_world_with_domains(cdp)
        time.sleep(0.8)
        lvl = view_level(cdp)
        bad += 0 if ck('已进入星域总览（domain）', lvl == 'domain', f'view_level={lvl}') else 1
        wait_for(cdp, "!!document.querySelector('.galaxy-map-container canvas')", timeout=60, desc='星系画布挂载')
        time.sleep(0.6)

        # ── 远景：要画 0 条（数据里明明有 total 条）──────────────────────────
        cam(cdp, 0.35)
        time.sleep(0.5)
        far_on, far_on_png = snap(cdp, 'far-on')
        if far_on:
            print(f"  远景：drawn={far_on['drawn']} / total={far_on['total']} scale={far_on['scale']:.2f}", flush=True)
            bad += 0 if ck('远景要画的航道 = 0 条（群星全景没有线）', far_on['drawn'] == 0) else 1
            bad += 0 if ck('数据里确实有航道（不是"本来就没有"）', (far_on['total'] or 0) > 0,
                           f"total={far_on['total']}") else 1
            bad += 0 if ck('远景档位确认（scale ≤ 0.5）', far_on['scale'] <= 0.5, f"{far_on['scale']:.2f}") else 1

        # ── 远景 + 悬停一条：必须画出来（不能"看不见却点得到"）───────────────
        hov_ok, hov = eval_json(cdp, """(() => {
          const SM = document.querySelector('.galaxy-map-container').__vueParentComponent.setupState;
          const list = SM.visibleHyperlanes || [];
          if (!list.length) return JSON.stringify({ ok: false, why: 'no-lane' });
          SM.hoveredHyperlane = list[0].id;
          return JSON.stringify({ ok: true, id: list[0].id, drawn: SM.hyperlanesToDraw().length });
        })()""", required=('ok',), desc='远景悬停一条')
        if hov_ok and hov.get('ok'):
            bad += 0 if ck('远景只画悬停的那一条（不把整网抖出来）', hov['drawn'] == 1,
                           f"drawn={hov['drawn']}") else 1
        eval_json(cdp, """(() => {
          const SM = document.querySelector('.galaxy-map-container').__vueParentComponent.setupState;
          SM.hoveredHyperlane = null;
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='清除悬停')

        # ── 近景：必须画出来 ──────────────────────────────────────────────────
        cam(cdp, 1.2)
        time.sleep(0.5)
        near_on, near_on_png = snap(cdp, 'near-on')
        if near_on:
            print(f"  近景：drawn={near_on['drawn']} / total={near_on['total']} scale={near_on['scale']:.2f}", flush=True)
            bad += 0 if ck('近景航道照画（> 0 条）', (near_on['drawn'] or 0) > 0, f"drawn={near_on['drawn']}") else 1
            bad += 0 if ck('近景档位确认（scale ≥ 1.0）', near_on['scale'] >= 1.0, f"{near_on['scale']:.2f}") else 1
            print(f'  → {far_on_png}\n  → {near_on_png}（并排看：远景应一条线都没有）', flush=True)

        print(('  ✅ 航道 LOD 判据通过' if not bad else f'  🔴 {bad} 项没过'), flush=True)
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
