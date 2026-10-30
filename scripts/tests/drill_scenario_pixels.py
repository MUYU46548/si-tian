#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""N1 判据工具：剧本视图「同机位像素指纹」（2026-10-30）

N1（渲染层接口化）的第一条判据是「**重构前后同机位截图逐像素一致**」。
它需要一个能重复的取景 + 一个能比较的指纹，这就是本工具：

  · 取景固定：同一份 fixture 数据 → 进「历史剧本」→ 适屏 → 记录 camera(x,y,scale) 与画布尺寸；
  · 指纹两枚：
      ① `hash`          —— 整张画布 RGBA 的 FNV-1a（**逐像素**，抗"看起来差不多"）；
      ② `hashNoLabels`  —— 关掉文字标注后的同一张画布（把"文字层"与"几何层"分开比：
                           字体的亚像素渲染会让整图哈希变，几何层的回归不受它牵连）；
  · 同时落一张 PNG 供人眼复核（`build/pixel-baseline/<tag>.png`）。

用法：
  python scripts/tests/drill_scenario_pixels.py --tag before     # 重构前留底
  python scripts/tests/drill_scenario_pixels.py --tag after      # 重构后再跑一次
  python scripts/tests/drill_scenario_pixels.py --compare before after

判据（`--compare`）：尺寸一致 + camera 一致 + 两枚哈希一致 → 0；否则 1 并逐项列出。
⚠️ 只在本机比：字体/DPR 跨机器会不同，`hashNoLabels` 才是跨机器也有意义的那枚。
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_tests as rt                                        # noqa: E402
from lib.cdp import CDP, wait_for, eval_json, fetch_string   # noqa: E402
from lib.helpers import ensure_data_ready, open_harness_project  # noqa: E402

OUT_DIR = os.path.join(rt.ROOT, 'build', 'pixel-baseline')

# 指纹：FNV-1a 32 位（够用、无依赖）。同时统计"非背景像素数"与"不同颜色数"，
# 让"哈希变了"这件事可解释（是全图偏移，还是只有某层少画了）。
FP_JS = """(() => {
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ error: 'no-canvas' });
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  let h = 0x811c9dc5;
  const colors = new Set();
  let nonBg = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i], b = d[i+1], c = d[i+2], e = d[i+3];
    h ^= a; h = (h * 0x01000193) >>> 0;
    h ^= b; h = (h * 0x01000193) >>> 0;
    h ^= c; h = (h * 0x01000193) >>> 0;
    h ^= e; h = (h * 0x01000193) >>> 0;
    if (e !== 0) nonBg++;
    if (colors.size < 4096) colors.add((a << 16) | (b << 8) | c);
  }
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  return JSON.stringify({
    hash: h.toString(16),
    w: cv.width, h: cv.height,
    nonBg, colors: colors.size,
    camera: { x: Math.round(SM.cameraX * 100) / 100, y: Math.round(SM.cameraY * 100) / 100,
              scale: Math.round(SM.cameraScale * 10000) / 10000 },
    viewLevel: SM.store ? SM.store.viewLevel : null,
  });
})()"""

TOGGLE_LABELS_JS = """((on) => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  // 文字层有**五个**开关（标志/省名/地名/地形注记/城镇），只关 `showLabels` 画不出"无文字的几何图"
  // ——2026-10-30 实测：第一版只关它，`hashNoLabels` 与整图完全相同（势力名照旧画）。
  const keys = ['showLabels', 'showPolityLabels', 'showProvinceNames', 'showPlaceNames', 'showTerrainNames'];
  const missing = keys.filter(k => !(k in SM));
  if (missing.length) return JSON.stringify({ error: 'missing switches: ' + missing.join(',') });
  for (const k of keys) SM[k] = !!on;
  if (typeof SM.render === 'function') SM.render();
  return JSON.stringify({ ok: true, off: !on, keys });
})"""


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return {'name': name, 'ok': bool(ok), 'detail': str(detail)}


def main():
    args = sys.argv[1:]
    tag = 'before'
    scene_name = 'base'          # base = 静态场景；edit = 再叠一层编辑态（顶点手柄/框选/笔刷圈）
    if '--scene' in args:
        scene_name = args[args.index('--scene') + 1]
    if '--tag' in args:
        tag = args[args.index('--tag') + 1]
    if '--compare' in args:
        return compare(args[args.index('--compare') + 1], args[args.index('--compare') + 2])

    os.makedirs(OUT_DIR, exist_ok=True)
    print(f'=== 剧本视图像素指纹 · tag={tag} ===', flush=True)

    # 前置：端口空闲（有回归在跑就别插队）
    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            print(f'  ❌ 端口 {port} 已被占用（先停掉正在跑的回归/演练）', flush=True)
            return 2

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
        ck('harness 项目已打开', ok, json.dumps(info, ensure_ascii=False)[:160])

        # 进剧本视图
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
        time.sleep(1.2)

        # 场景固定：自带底图 + 3 个省份（含一个沿海省，好把「海岸浅滩」那层也纳入画面）。
        # 为什么要自带：harness 项目里没有剧本底图，空画布拍出来是一片纯色 —— 那种基线什么都守不住。
        scene = eval_json(cdp, """(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const KEY = '像素基线底图';
          if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '像素基线底图' });
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          sm.baseMapKey = KEY;
          if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
          const rects = [
            [[0,0],[420,0],[420,320],[0,320]],
            [[60,60],[340,60],[340,240],[60,240]],
            [[460,0],[620,0],[620,180],[460,180]],
          ];
          const coasts = [false, false, true];
          let injected = 0;
          while ((s.baseMaps[KEY].terrain || []).length < 3 && injected < 3) {
            const pts = rects[injected].map(([x, y]) => ({ x, y }));
            s.addBaseProvince(KEY, { id: 'pix_prov_' + injected, name: '像素基线省' + (injected + 1),
              points: pts, biome: 'temperate', coast: coasts[injected] }, { checkOverlap: false });
            injected++;
          }
          // ② 一层剧本：**文字层必须有东西可画**（此前基线里省名一个都没出 → `hashNoLabels`
          //    与整图相同，文字那一刀等于没有判据）。这里造一个势力 + 三个省归属 + 一条浮动地名：
          //      · 省名/势力名 → `drawPolityLabels`（走统一避让排布 getLabelPlan）
          //      · 浮动地名   → `drawLabels`（走 scenarioLabelTextStyle）
          if (s.scenarios && typeof s.removeScenario === 'function') {
            for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
          }
          s.createScenario(KEY + '/像素基线时代', {
            ownerKey: KEY, name: '像素基线时代', order: 1,
            era: { roman: 'I', label: '基', startYear: '2000', endYear: '2010' },
            polities: [{ id: 'PIX_A', name: '像素甲国', color: '#c23b3b' }],
            ownership: { pix_prov_0: 'PIX_A', pix_prov_1: 'PIX_A', pix_prov_2: 'PIX_A' },
            labels: [{ text: '像素基线地名', x: 300, y: 420 }],
          });
          sm.baseMapKey = KEY;
          if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
          sm.tlDate = { y: 2005, m: null, d: null };
          const ids = sm.timeline.scenarios.map(x => x.id);
          sm.tlEra = Math.max(0, ids.indexOf(KEY + '/像素基线时代'));
          sm.selectedPolity = null;
          sm.selectedProvinceIds = [];
          if (typeof sm.render === 'function') sm.render();
          return JSON.stringify({
            ok: true, provinces: (s.baseMaps[KEY].terrain || []).length, injected,
            scenarios: ids.length, era: sm.tlEra,
            hasLabels: !!(sm.timeline.scenarios[sm.tlEra] || {}).labels,
          });
        })()""", required=('ok',), desc='铺设像素基线场景')
        ck('场景已铺设', bool(scene[0]) and scene[1].get('ok'), scene[1])
        time.sleep(0.5)

        # 可选：把画布切到「编辑态」再拍（顶点手柄 / 框选 / 笔刷圈那几层只在这时候出现，
        # 默认场景里它们整体不触发 —— 只拍静态场景等于没给那几刀留判据）
        if scene_name == 'edit':
            edit = eval_json(cdp, """(() => {
              const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
              const KEY = '像素基线底图';
              const prov = (s.baseMaps[KEY].terrain || [])[0];
              SM.selectedProvince = prov;
              SM.vertexEditMode = true;
              SM.activeVertexIdx = 2;
              SM.vertexSelection = [1, 3];
              SM.tool = 'provinceBrush';
              SM.provBrushRadius = 24;
              SM.provBrushPreview = { x: 180, y: 150 };
              SM.vertexMarquee = { x0: 60, y0: 60, x1: 300, y1: 240 };
              SM.riverMarquee = { x0: 120, y0: 200, x1: 380, y1: 300 };
              if (typeof SM.render === 'function') SM.render();
              return JSON.stringify({ ok: true, tool: SM.tool, radius: SM.provBrushRadius });
            })()""", required=('ok',), desc='切编辑态')
            ck('编辑态已就位', bool(edit[0]) and edit[1].get('ok'), edit[1])
            time.sleep(0.5)
        fit = eval_json(cdp, """(() => {
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          if (typeof SM.fitToView !== 'function') return JSON.stringify({ ok: false, why: 'no-fitToView' });
          SM.fitToView();
          if (typeof SM.render === 'function') SM.render();
          return JSON.stringify({ ok: true, scale: SM.cameraScale });
        })()""", required=('ok',), desc='适屏')
        ck('调了 fitToView', bool(fit[0]) and fit[1].get('ok'), fit[1])
        time.sleep(0.8)

        fp_ok, fp = eval_json(cdp, FP_JS, required=('hash',), desc='指纹')
        if not fp_ok or fp.get('error'):
            ck('取像素指纹', False, fp)
            return 1

        on_ok, on = eval_json(cdp, TOGGLE_LABELS_JS + '(false)', required=('ok',), desc='关标注')
        time.sleep(0.4)
        off_ok, fp_off = eval_json(cdp, FP_JS, required=('hash',), desc='指纹·无标注')
        eval_json(cdp, TOGGLE_LABELS_JS + '(true)', required=('ok',), desc='开标注')
        time.sleep(0.3)

        # 落 PNG（人眼复核）。⚠️ dataUrl 是 MB 级字符串：必须走 `fetch_string` 分块取，
        # 一次性 `eval_json` 会让 CDP 读超时（15s）—— 本仓踩过。
        data_url = fetch_string(
            cdp,
            "document.querySelector('.scenario-map-container canvas').toDataURL('image/png').length",
            lambda i, j: ("document.querySelector('.scenario-map-container canvas')"
                          f".toDataURL('image/png').slice({i}, {j})"),
            desc='画布 PNG dataUrl',
        )

        record = {
            'tag': tag,
            'ts': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'hash': fp['hash'],
            'hashNoLabels': fp_off['hash'],
            'w': fp['w'], 'h': fp['h'],
            'camera': fp['camera'],
            'nonBg': fp['nonBg'],
            'colors': fp['colors'],
            'showLabelsToggle': bool(on_ok and on.get('ok')),
        }
        with open(os.path.join(OUT_DIR, f'{tag}.json'), 'w', encoding='utf-8') as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        raw = data_url.split(',', 1)[1]
        import base64
        with open(os.path.join(OUT_DIR, f'{tag}.png'), 'wb') as f:
            f.write(base64.b64decode(raw))

        ck('指纹已落盘', True, json.dumps(record, ensure_ascii=False))
        print(f'  → {os.path.join(OUT_DIR, f"{tag}.json")}', flush=True)
        print(f'  → {os.path.join(OUT_DIR, f"{tag}.png")}（人眼复核）', flush=True)
        return 0
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


def compare(a_tag, b_tag):
    pa = os.path.join(OUT_DIR, f'{a_tag}.json')
    pb = os.path.join(OUT_DIR, f'{b_tag}.json')
    for p in (pa, pb):
        if not os.path.exists(p):
            print(f'  ❌ 缺基线：{p}')
            return 2
    with open(pa, encoding='utf-8') as f:
        a = json.load(f)
    with open(pb, encoding='utf-8') as f:
        b = json.load(f)
    print(f'=== 像素指纹比对：{a_tag} → {b_tag} ===')
    bad = 0
    for k in ('w', 'h', 'hash', 'hashNoLabels'):
        same = a.get(k) == b.get(k)
        bad += 0 if same else 1
        print(('  ✅ ' if same else '  ❌ ') + f'{k}: {a.get(k)} → {b.get(k)}')
    cam_same = a.get('camera') == b.get('camera')
    bad += 0 if cam_same else 1
    print(('  ✅ ' if cam_same else '  ❌ ') + f'camera: {a.get("camera")} → {b.get("camera")}')
    print(f'  非背景像素 {a.get("nonBg")} → {b.get("nonBg")} · 颜色数 {a.get("colors")} → {b.get("colors")}')
    if bad:
        print(f'\n🔴 {bad} 项不一致 —— 逐像素判据没过（先看 PNG：{OUT_DIR}\\{a_tag}.png vs {b_tag}.png）')
        return 1
    print('\n✅ 逐像素一致（含关标注后的几何层）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
