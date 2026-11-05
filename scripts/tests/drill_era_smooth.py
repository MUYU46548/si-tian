#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A2 演变过渡：真机判据（2026-11-05）

要证的事（用户原话：“演变动画不平滑”）：
  ① 换代那一下**不再是硬跳** —— 画布上该省的颜色在过渡期内取到**中间色**（既不是旧主色、
     也不是新主色），且逐通道落在两端之间；
  ② 过渡**会结束**：末态 = 新主色（过渡色不是新势力，数据一个字节不动）；
  ③ 过渡**能关**：时长设 0 → 同一套动作下**一个中间色样本都没有**（这是负向探针，
     证明 ① 的中间色确实由过渡产生，而不是渲染噪声/抗锯齿）；
  ④ **导出不带过渡**：过渡进行中 `makeLayerView({ snapshot: true })` 取到的就是新主色
     （否则同一份数据在过渡期导两次会得到不同像素）。

怎么做的（全部在真机页面内跑，CDP 只负责起停与取结果）：
  · Vite(5180) + Edge headless(9222)，harness 项目 + 自建 3 省底图 + **两代**剧本：
    时代 I 全归甲国（红 #c23b3b）→ 时代 II 全归乙国（蓝 #3b6cc2），两代显式不同谱系
    （`lineage`），所以整代全部省都是“变化省”；
  · 页面内 rAF 采样器：每帧读**同一个世界点**（省中心）的画布像素 + `window.__SITIAN_ERA_FADE__`，
    在采样开始后 180ms 把 `tlDate` 推到 2016（触发换代），采满 1.9s 一次性取回；
  · 时长临时设 1200ms（`window.__SITIAN_ERA_FADE_MS__`）——真机整图重绘 ~60ms/帧，
    320ms 只有 3~5 帧，采样容易只落在端点；判据要的是“有没有中间态”，不是“几帧”。

用法：python scripts/tests/drill_era_smooth.py
产物：build/era-smooth/<ts>/{result.json, summary.md, mid.png（过渡中那一帧）}
退出码：0 = 全过。
"""
import base64
import json
import os
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_tests as rt                                        # noqa: E402
from lib.cdp import CDP, wait_for, eval_json, fetch_string    # noqa: E402
from lib.helpers import ensure_data_ready, open_harness_project  # noqa: E402

OUT_ROOT = os.path.join(rt.ROOT, 'build', 'era-smooth')

# 采样点：第一个省（矩形 0,0–420,320）的中心，远离边界/省名
WX, WY = 210, 160

# 两代颜色（判据的期望值；与脚本里 createScenario 传的色必须一致）
COL_A = (0xc2, 0x3b, 0x3b)   # 时代 I 甲国
COL_B = (0x3b, 0x6c, 0xc2)   # 时代 II 乙国


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return {'name': name, 'ok': bool(ok), 'detail': str(detail)}


# ── 场景：两代剧本 + 三个矩形省 ────────────────────────────────────────────
SCENE_JS = r"""(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const KEY = '演变过渡底图';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '演变过渡底图' });
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  const rects = [
    [[0,0],[420,0],[420,320],[0,320]],
    [[460,0],[620,0],[620,180],[460,180]],
    [[0,360],[300,360],[300,520],[0,520]],
  ];
  let injected = 0;
  while ((s.baseMaps[KEY].terrain || []).length < 3 && injected < 3) {
    const pts = rects[injected].map(([x, y]) => ({ x, y }));
    s.addBaseProvince(KEY, { id: 'era_prov_' + injected, name: '过渡省' + (injected + 1),
      points: pts, biome: 'temperate', coast: false }, { checkOverlap: false });
    injected++;
  }
  // 清掉已有剧本（harness 基线里可能有别的），只留本轮两代
  if (s.scenarios && typeof s.removeScenario === 'function') {
    for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  }
  const own1 = {}, own2 = {}, changes = {};
  for (let i = 0; i < 3; i++) {
    own1['era_prov_' + i] = 'ERA_A';
    own2['era_prov_' + i] = 'ERA_B';
    changes['era_prov_' + i] = [{ y: 2015, m: 1, d: 1, owner: 'ERA_B' }];
  }
  s.createScenario(KEY + '/时代一', {
    ownerKey: KEY, name: '时代一', order: 1,
    era: { roman: 'I', label: '一', startYear: '2000', endYear: '2010' },
    // 🔴 显式谱系：不给 lineage 的话，两代省份集合完全相同 → 谱系匹配会判成“同一个国家”
    //    （changed 为空 → 换代没有任何省变色，判据变成空转）
    polities: [{ id: 'ERA_A', name: '甲国', color: '#c23b3b', lineage: 'ERA_LINE_A' }],
    ownership: own1,
  });
  s.createScenario(KEY + '/时代二', {
    ownerKey: KEY, name: '时代二', order: 2,
    era: { roman: 'II', label: '二', startYear: '2010', endYear: '2020' },
    polities: [{ id: 'ERA_B', name: '乙国', color: '#3b6cc2', lineage: 'ERA_LINE_B' }],
    ownership: own2,
    changeEvents: changes,
  });
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  const ids = SM.timeline.scenarios.map(x => x.id);
  SM.tlEra = Math.max(0, ids.indexOf(KEY + '/时代一'));
  SM.tlDate = { y: 2005, m: null, d: null };
  // 判据只看省色：文字/城镇/道路/河/浮雕/选中全部关掉（否则中心像素可能吃到文字或描边）
  for (const k of ['showLabels', 'showPolityLabels', 'showProvinceNames', 'showPlaceNames',
                   'showTerrainNames', 'showBurgs', 'showRoutes', 'showBiomes', 'showRivers']) SM[k] = false;
  SM.selectedProvince = null;
  SM.selectedProvinceIds = [];
  SM.tlDiffMode = 'off';
  if (typeof SM.render === 'function') SM.render();
  return JSON.stringify({
    ok: true, provinces: (s.baseMaps[KEY].terrain || []).length, injected, eras: ids.length,
    era: SM.tlEra, date: SM.tlDate,
    changed: (SM.timeline.eraChg[1] && SM.timeline.eraChg[1].changed || []).length,
  });
})()"""

FIT_JS = r"""(() => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  if (typeof SM.fitToView === 'function') SM.fitToView();
  if (typeof SM.render === 'function') SM.render();
  return JSON.stringify({ ok: true, scale: SM.cameraScale,
    camera: { x: Math.round(SM.cameraX * 100) / 100, y: Math.round(SM.cameraY * 100) / 100 } });
})()"""


# ── 页面内采样器：每帧读同一点像素，并在 delay 后把日期推到 target ────────────
SAMPLER_JS = r"""(() => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ ok: false, why: 'no-canvas' });
  const g = cv.getContext('2d');
  const dpr = cv.width / cv.clientWidth;
  const WX = %(wx)d, WY = %(wy)d;
  const sample = () => {
    const sx = SM.cameraX + WX * SM.cameraScale;
    const sy = SM.cameraY + WY * SM.cameraScale;
    const d = g.getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  };
  window.__ERA_SAMPLES__ = [];
  window.__ERA_SNAP__ = null;
  window.__ERA_SHOT__ = null;
  const t0 = performance.now();
  const go = () => {
    const c = sample();
    const f = window.__SITIAN_ERA_FADE__ || null;
    window.__ERA_SAMPLES__.push({
      t: Math.round(performance.now() - t0),
      r: c.r, g: c.g, b: c.b,
      fade: f ? { active: !!f.active, t: f.t, dur: f.dur, fromEra: f.fromEra, toEra: f.toEra } : null,
    });
    if (f && f.active) {
      // ④ 导出确定态：过渡**进行中**（取进度 > 0.15 的帧，确保真的在渐变），
      //    snapshot view 取的色必须已是新主色
      if (f.t > 0.15 && !window.__ERA_SNAP__) {
        try {
          const prov = SM.rawTerrain()[0];
          const rp = SM.rawProvOf(prov);
          const vs = SM.makeLayerView({ snapshot: true });
          const vf = SM.makeLayerView();
          window.__ERA_SNAP__ = {
            provId: prov.id, t: f.t,
            snapshot: vs.getProvinceColor(rp),
            canvas: vf.getProvinceColor(rp),
          };
        } catch (e) { window.__ERA_SNAP__ = { err: String(e && e.message) }; }
      }
      if (f.t > 0.15 && !window.__ERA_SHOT__) {
        try { window.__ERA_SHOT__ = cv.toDataURL('image/png'); } catch (e) {}
      }
    }
    if (performance.now() - t0 < %(span)d) requestAnimationFrame(go);
  };
  requestAnimationFrame(go);
  setTimeout(() => { SM.tlDate = %(target)s; }, %(delay)d);
  return JSON.stringify({ ok: true, span: %(span)d, delay: %(delay)d, dpr: dpr });
})()"""

PIX_JS = r"""(() => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const cv = document.querySelector('.scenario-map-container canvas');
  const dpr = cv.width / cv.clientWidth;
  const sx = SM.cameraX + %(wx)d * SM.cameraScale;
  const sy = SM.cameraY + %(wy)d * SM.cameraScale;
  const d = cv.getContext('2d').getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
  return JSON.stringify({ r: d[0], g: d[1], b: d[2], a: d[3],
    era: SM.tlEra, date: SM.tlDate, fade: window.__SITIAN_ERA_FADE__ || null });
})()"""


def dist(c, rgb):
    return max(abs(int(c['r']) - rgb[0]), abs(int(c['g']) - rgb[1]), abs(int(c['b']) - rgb[2]))


def is_between(c, a, b, inner_tol=2, span_tol=3):
    """逐通道落在 a→b 之间（含 ±span_tol 容差），且离两端都超过 inner_tol。"""
    if dist(c, a) <= inner_tol or dist(c, b) <= inner_tol:
        return False
    for ch in ('r', 'g', 'b'):
        v = int(c[ch])
        lo = min(a[{'r': 0, 'g': 1, 'b': 2}[ch]], b[{'r': 0, 'g': 1, 'b': 2}[ch]]) - span_tol
        hi = max(a[{'r': 0, 'g': 1, 'b': 2}[ch]], b[{'r': 0, 'g': 1, 'b': 2}[ch]]) + span_tol
        if v < lo or v > hi:
            return False
    return True


def hex_of(rgb):
    return '#%02x%02x%02x' % rgb


def main():
    ts = time.strftime('%Y%m%d-%H%M%S')
    out_dir = os.path.join(OUT_ROOT, ts)
    os.makedirs(out_dir, exist_ok=True)
    print(f'=== A2 演变过渡 · 真机判据 · {ts} ===', flush=True)

    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            print(f'  ❌ 端口 {port} 已被占用（先停掉正在跑的回归/演练）', flush=True)
            return 2

    rt.setup_mock()
    handles, cdp = [], None
    checks = []
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
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='跳过首启后重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ensure_data_ready(cdp, timeout=90)
        ok, info = open_harness_project(cdp)
        checks.append(ck('harness 项目已打开', ok, json.dumps(info, ensure_ascii=False)[:140]))

        got, res = eval_json(cdp, """(() => {
          const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('历史剧本'));
          if (!b) return JSON.stringify({ ok: false, why: 'no-btn' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='进历史剧本')
        if not got or not res.get('ok'):
            checks.append(ck('进入剧本视图', False, res))
            return 1
        wait_for(cdp, "!!document.querySelector('.scenario-map-container canvas')", timeout=60, desc='剧本画布挂载')
        time.sleep(1.2)

        s_ok, scene = eval_json(cdp, SCENE_JS, required=('ok',), desc='铺设两代剧本场景')
        checks.append(ck('两代场景已铺设', bool(s_ok) and scene.get('ok'), json.dumps(scene, ensure_ascii=False)))
        if not s_ok or not scene.get('ok'):
            return 1
        checks.append(ck('两代剧本都在（判据不是空转）', int(scene.get('eras') or 0) >= 2,
                         f"eras={scene.get('eras')} changed={scene.get('changed')}"))
        checks.append(ck('第二代有“变化省”（整代易主）', int(scene.get('changed') or 0) >= 3,
                         f"changed={scene.get('changed')}"))

        f_ok, fit = eval_json(cdp, FIT_JS, required=('ok',), desc='适屏')
        checks.append(ck('适屏完成', bool(f_ok) and fit.get('ok'), json.dumps(fit, ensure_ascii=False)))
        time.sleep(0.8)

        p_ok, start_px = eval_json(cdp, PIX_JS % {'wx': WX, 'wy': WY}, required=('r',), desc='起点像素')
        checks.append(ck('起点 = 时代一甲国色', dist(start_px, COL_A) <= 6,
                         f"像素 {tuple(start_px.get(k) for k in ('r','g','b'))} vs 期望 {COL_A}"))

        # ── ① 过渡开启（1200ms）────────────────────────────────────────────
        eval_json(cdp, "(() => { window.__SITIAN_ERA_FADE_MS__ = 1200; return JSON.stringify({ok:true}); })()",
                  required=('ok',), desc='设过渡时长')
        sm_ok, sm = eval_json(cdp, SAMPLER_JS % {
            'wx': WX, 'wy': WY, 'span': 1900, 'delay': 180,
            'target': "{ y: 2016, m: null, d: null }",
        }, required=('ok',), desc='启动采样器（换代到 2016）')
        checks.append(ck('采样器已启动', bool(sm_ok) and sm.get('ok'), json.dumps(sm, ensure_ascii=False)))
        time.sleep(2.3)

        d_ok, data = eval_json(cdp, """(() => JSON.stringify({
          samples: window.__ERA_SAMPLES__ || [],
          snap: window.__ERA_SNAP__,
          era: document.querySelector('.scenario-map-container').__vueParentComponent.setupState.tlEra,
          date: document.querySelector('.scenario-map-container').__vueParentComponent.setupState.tlDate,
        }))()""", required=('samples',), desc='取回采样')
        samples = (data or {}).get('samples') or []
        checks.append(ck('采样条数够（过渡期内每帧一条）', len(samples) >= 6, f'{len(samples)} 条'))

        first = samples[0] if samples else None
        last = samples[-1] if samples else None
        checks.append(ck('首个样本 = 旧主色（换代前）',
                         bool(first) and dist(first, COL_A) <= 6,
                         f"{first and tuple(first.get(k) for k in ('r','g','b'))}"))
        checks.append(ck('末个样本 = 新主色（过渡会结束）',
                         bool(last) and dist(last, COL_B) <= 6,
                         f"{last and tuple(last.get(k) for k in ('r','g','b'))}"))
        mids = [x for x in samples if is_between(x, COL_A, COL_B)]
        checks.append(ck('① 过渡期采到中间色（不再是硬跳）', len(mids) >= 2,
                         f'{len(mids)} 条中间色：' + ', '.join(
                             str(tuple(m.get(k) for k in ('r', 'g', 'b'))) for m in mids[:6])))
        checks.append(ck('④ 导出确定态：过渡中 snapshot 取的已是新主色',
                         bool((data or {}).get('snap')) and (data or {}).get('snap', {}).get('snapshot') == hex_of(COL_B),
                         json.dumps((data or {}).get('snap'), ensure_ascii=False)))
        checks.append(ck('  画布口径在过渡中确实是中间色（与 snapshot 对照）',
                         bool((data or {}).get('snap')) and (data or {}).get('snap', {}).get('canvas') != hex_of(COL_B),
                         f"canvas={((data or {}).get('snap') or {}).get('canvas')}"))
        durs = [x.get('fade', {}).get('dur') for x in samples if x.get('fade')]
        checks.append(ck('过渡时长按覆盖口生效（1200ms）',
                         bool(durs) and all(d == 1200 for d in durs), f'dur={sorted(set(durs))}'))

        # 过渡中那一帧（人眼复核）
        shot = None
        try:
            shot = fetch_string(
                cdp, "(window.__ERA_SHOT__ || '').length",
                lambda i, j: f"String((window.__ERA_SHOT__ || '')).slice({i}, {j})",
                desc='过渡帧 PNG')
        except Exception as e:      # 截图失败只警告，不算判据
            print(f'  ⚠️ 取过渡帧截图失败（不算失败）：{e}', flush=True)

        # ── ③ 负向探针：时长 0 → 一个中间色都不许有 ──────────────────────────
        eval_json(cdp, "(() => { window.__SITIAN_ERA_FADE_MS__ = 0; return JSON.stringify({ok:true}); })()",
                  required=('ok',), desc='关过渡')
        # 先回时代二（2016），再硬跳回 2005 → 颜色 B → A
        eval_json(cdp, """(() => {
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          SM.tlDate = { y: 2016, m: null, d: null };
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='回到时代二')
        time.sleep(0.9)
        sm2_ok, _ = eval_json(cdp, SAMPLER_JS % {
            'wx': WX, 'wy': WY, 'span': 900, 'delay': 180,
            'target': "{ y: 2005, m: null, d: null }",
        }, required=('ok',), desc='启动负向采样器')
        time.sleep(1.3)
        d2_ok, data2 = eval_json(cdp, "(() => JSON.stringify({ samples: window.__ERA_SAMPLES__ || [] }))()",
                                 required=('samples',), desc='取回负向采样')
        samples2 = (data2 or {}).get('samples') or []
        mids2 = [x for x in samples2 if is_between(x, COL_B, COL_A)]
        checks.append(ck('③ 负向探针：关掉过渡后 0 条中间色（硬跳）', len(mids2) == 0,
                         f'{len(mids2)} 条中间色 / 共 {len(samples2)} 条'))
        checks.append(ck('  负向探针确实换了主（前后两端各就位）',
                         bool(samples2) and dist(samples2[0], COL_B) <= 6 and dist(samples2[-1], COL_A) <= 6,
                         f"{samples2 and tuple(samples2[0].get(k) for k in ('r','g','b'))} → "
                         f"{samples2 and tuple(samples2[-1].get(k) for k in ('r','g','b'))}"))

        # 末态读一次（人眼复核 + 落档）
        time.sleep(0.3)
        _, end_px = eval_json(cdp, PIX_JS % {'wx': WX, 'wy': WY}, required=('r',), desc='末态像素')
        checks.append(ck('末态 = 时代二甲国色（数据仍是确定态）', dist(end_px, COL_A) <= 6,
                         f"像素 {tuple(end_px.get(k) for k in ('r','g','b'))} era={end_px.get('era')}"))

        # ── 落档 ────────────────────────────────────────────────────────────
        result = {
            'ts': ts,
            'checks': checks,
            'points': {'world': [WX, WY], 'colA': list(COL_A), 'colB': list(COL_B)},
            'samplesFadeOn': samples,
            'snapshotDuringFade': (data or {}).get('snap'),
            'samplesFadeOff': samples2,
            'startPx': start_px,
            'endPx': end_px,
        }
        with open(os.path.join(out_dir, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        if shot and shot.startswith('data:image/png;base64,'):
            with open(os.path.join(out_dir, 'mid.png'), 'wb') as f:
                f.write(base64.b64decode(shot.split(',', 1)[1]))
        with open(os.path.join(out_dir, 'summary.md'), 'w', encoding='utf-8') as f:
            f.write(f'# A2 演变过渡 · 真机判据 {ts}\n\n')
            for c in checks:
                f.write(f"- {'✅' if c['ok'] else '❌'} {c['name']}" + (f" — {c['detail']}" if c['detail'] else '') + '\n')

        bad = [c for c in checks if not c['ok']]
        print(f'\n产物：{out_dir}', flush=True)
        print(f'{"✅ 全过" if not bad else f"🔴 {len(bad)} 项没过"}（{len(checks) - len(bad)}/{len(checks)}）', flush=True)
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
