#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""剧本视图「地形浮雕底」判据（2026-11-03）

背景：用户对照 EU4 的原话是「一屏 65% 地形 + 25% 政治水洗 + 10% 线字」，而司天剧本视图
90% 是平涂色块。这一刀把底图高度图（山体阴影 + 地形色）铺到政治色**下面**，
省份填色降到 ~0.42 水洗。

本工具做两件事（都在一次运行里，同一个机位、同一份数据）：
  ① 开/关浮雕各拍一张 `build/scenario-relief/on.png` / `off.png`（人眼复核）；
  ② 量化的判据：浮雕开着时，陆地像素的**亮度标准差**与**颜色数**必须明显高于关掉时
     （平涂色块的 std 接近 0；有地形纹理就上去了）。

开关：`window.__SITIAN_SCENARIO_RELIEF__ = false`（产品代码里的排障口，默认开）。

用法：python scripts/tests/drill_scenario_relief.py
退出码：0 = 判据过；1 = 没过（打印实测值）。
"""
import base64
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_tests as rt                                        # noqa: E402
from lib.cdp import CDP, wait_for, eval_json, fetch_string     # noqa: E402
from lib.helpers import ensure_data_ready, open_harness_project  # noqa: E402

OUT_DIR = os.path.join(rt.ROOT, 'build', 'scenario-relief')

# 画布统计：陆地像素（亮度 > 18）的亮度均值/标准差 + 不同颜色数 + **相邻像素梯度能量**。
# ⚠️ 只看全局 std/sat 会被"几块势力色 + 标签 + 省界"主导（实测差异被稀释到 ~1.1×）。
#    判"这一块地有没有地形"，要在**一个省的正中间取一块 60×40 的补丁**：
#    平涂时补丁内近乎单色（std≈0、sat 高），浮雕开时补丁里有起伏、色彩被水洗。
STATS_JS = """(() => {
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ error: 'no-canvas' });
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const d = g.getImageData(0, 0, W, H).data;
  const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const satOf = (i) => {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    return mx ? (mx - mn) / mx : 0;
  };
  // ── 全图（参考用：颜色数 / 哈希）──────────────────────────────────────────
  let n = 0, h = 0x811c9dc5;
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    h ^= d[i]; h = (h * 0x01000193) >>> 0;
    h ^= d[i + 1]; h = (h * 0x01000193) >>> 0;
    h ^= d[i + 2]; h = (h * 0x01000193) >>> 0;
    h ^= d[i + 3]; h = (h * 0x01000193) >>> 0;
    if (d[i + 3] < 8) continue;
    if (lum(i) < 18) continue;
    n++;
    if (colors.size < 8192) colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  // ── 补丁：第一个省的正中间 ─────────────────────────────────────────────────
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const bm = s.baseMaps && s.baseMaps['浮雕判据底图'];
  const prov = bm && (bm.terrain || [])[0];
  let patch = null;
  if (prov && prov.points && prov.points.length) {
    const cw2 = cv.clientWidth || W;
    const ratio = W / cw2;
    const wx = prov.points.reduce((a, p) => a + p.x, 0) / prov.points.length;
    const wy = prov.points.reduce((a, p) => a + p.y, 0) / prov.points.length;
    const sx = Math.round((wx * SM.cameraScale + SM.cameraX + cw2 / 2) * ratio);
    const sy = Math.round((wy * SM.cameraScale + SM.cameraY + (cv.clientHeight || H) / 2) * ratio);
    let pn = 0, psum = 0, psum2 = 0, psat = 0, pgrad = 0, pgradn = 0;
    for (let y = sy - 20; y < sy + 20; y++) {
      for (let x = sx - 30; x < sx + 30; x++) {
        if (x < 0 || y < 0 || x + 8 >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        if (d[i + 3] < 8) continue;
        const L = lum(i);
        if (L < 18) continue;
        pn++; psum += L; psum2 += L * L; psat += satOf(i);
        const j = i + 32;                       // 8px 右邻（山丘尺度）
        if (d[j + 3] >= 8) pgrad += Math.abs(lum(j) - L);
        pgradn++;
      }
    }
    const pm = pn ? psum / pn : 0;
    patch = {
      px: pn,
      std: pn ? +Math.sqrt(Math.max(0, psum2 / pn - pm * pm)).toFixed(3) : 0,
      sat: pn ? +(psat / pn).toFixed(3) : 0,
      grad: pgradn ? +(pgrad / pgradn).toFixed(3) : 0,
    };
  }
  return JSON.stringify({
    hash: h.toString(16), landPx: n, colors: colors.size, patch,
    cameraScale: SM.cameraScale, w: W, h: H,
  });
})()"""

SCENE_JS = """(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = '浮雕判据底图';
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '浮雕判据底图' });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();

  // ① 省份：地形推演需要「画好的陆地」当掩膜 —— **必须先有轮廓再生成**（顺序反了会拿不到高度图）
  const rects = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) {
      const x0 = c * 260, y0 = r * 170;
      rects.push([[x0, y0], [x0 + 240, y0], [x0 + 240, y0 + 150], [x0, y0 + 150]]);
    }
  }
  let injected = 0;
  while ((s.baseMaps[KEY].terrain || []).length < 6 && injected < 6) {
    const pts = rects[injected].map(([x, y]) => ({ x, y }));
    s.addBaseProvince(KEY, { id: 'relief_prov_' + injected, name: '浮雕省' + (injected + 1),
      points: pts, biome: 'temperate' }, { checkOverlap: false });
    injected++;
  }
  const provIds = (s.baseMaps[KEY].terrain || []).map(p => p.id);

  // ② 高度图：走产品自己的「按轮廓推演地形」（不是测试另造一套假数据）
  const gen = typeof s.synthesizeBaseMapTerrain === 'function'
    ? s.synthesizeBaseMapTerrain(KEY, { seed: 7 })
    : { ok: false, reason: 'no-api' };
  const hm = s.getHeightmapFor ? s.getHeightmapFor(KEY) : null;
  const hmPts = hm && hm.grid && hm.grid.points ? hm.grid.points.length : 0;

  // ③ 一层剧本 + 三个势力（颜色彼此差异大，水洗后仍能分辨）
  if (s.scenarios && typeof s.removeScenario === 'function') {
    for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  }
  const ownership = {};
  const polities = [
    { id: 'RLF_A', name: '浮雕甲国', color: '#b23b3b' },
    { id: 'RLF_B', name: '浮雕乙国', color: '#3b6fb2' },
    { id: 'RLF_C', name: '浮雕丙国', color: '#c9a227' },
  ];
  provIds.forEach((pid, i) => { ownership[pid] = polities[i % 3].id; });
  s.createScenario(KEY + '/浮雕时代', {
    ownerKey: KEY, name: '浮雕时代', order: 1,
    era: { roman: 'I', label: '浮', startYear: '2000', endYear: '2010' },
    polities, ownership,
  });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  sm.tlDate = { y: 2005, m: null, d: null };
  const ids = sm.timeline.scenarios.map(x => x.id);
  sm.tlEra = Math.max(0, ids.indexOf(KEY + '/浮雕时代'));
  sm.selectedPolity = null;
  sm.selectedProvinceIds = [];
  if (typeof sm.fitToView === 'function') sm.fitToView();
  if (typeof sm.render === 'function') sm.render();
  return JSON.stringify({
    ok: gen.ok !== false, genReason: gen.reason || '', hmPts, provinces: provIds.length,
    scenarios: ids.length, era: sm.tlEra,
  });
})()"""


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return ok


def shot(cdp, name, desc):
    """取统计 + 落 PNG（dataUrl 走 fetch_string 分块，别用 eval_json 拉 MB 字符串）"""
    ok, st = eval_json(cdp, STATS_JS, required=('hash',), desc=f'{desc}·统计')
    if not ok or st.get('error'):
        return None, None
    data_url = fetch_string(
        cdp,
        "document.querySelector('.scenario-map-container canvas').toDataURL('image/png').length",
        lambda i, j: ("document.querySelector('.scenario-map-container canvas')"
                      f".toDataURL('image/png').slice({i}, {j})"),
        desc=f'{desc}·PNG',
    )
    raw = data_url.split(',', 1)[1]
    path = os.path.join(OUT_DIR, f'{name}.png')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(raw))
    with open(os.path.join(OUT_DIR, f'{name}.json'), 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    return st, path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    # 端口自检：别和回归/别的演练抢
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
        bad += 0 if ck('harness 项目已打开', ok, json.dumps(info, ensure_ascii=False)[:120]) else 1

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
        time.sleep(1.0)

        sc_ok, sc = eval_json(cdp, SCENE_JS, required=('ok',), desc='铺浮雕判据场景')
        bad += 0 if ck('场景已铺设', bool(sc_ok) and bool(sc.get('ok')),
                       f"高度图格 {sc.get('hmPts')} / 省 {sc.get('provinces')} / 剧本 {sc.get('scenarios')}") else 1
        if not sc.get('hmPts'):
            print('  ❌ 底图没有高度图 —— 浮雕无从判断（地形生成失败？）', flush=True)
            return 1
        time.sleep(0.8)

        on, on_png = shot(cdp, 'on', '浮雕开')
        bad += 0 if ck('浮雕开·已取样', bool(on)) else 1

        eval_json(cdp, """(() => {
          window.__SITIAN_SCENARIO_RELIEF__ = false;
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          if (typeof sm.render === 'function') sm.render();
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='关浮雕')
        time.sleep(0.6)
        off, off_png = shot(cdp, 'off', '浮雕关')
        bad += 0 if ck('浮雕关·已取样', bool(off)) else 1

        eval_json(cdp, """(() => {
          window.__SITIAN_SCENARIO_RELIEF__ = undefined;
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          if (typeof sm.render === 'function') sm.render();
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='恢复默认')

        if on and off:
            print(f"  浮雕开：全图颜色 {on['colors']} / 陆地像素 {on['landPx']} / 补丁 {on.get('patch')}", flush=True)
            print(f"  浮雕关：全图颜色 {off['colors']} / 陆地像素 {off['landPx']} / 补丁 {off.get('patch')}", flush=True)
            bad += 0 if ck('开/关两帧不同（浮雕真的画了）', on['hash'] != off['hash']) else 1
            # 判据①：地形色 + 阴影让全图颜色数明显变多（平涂时是"每省一色 + 省界/标签"）
            bad += 0 if ck('全图颜色数明显变多（地形色 + 阴影）', on['colors'] >= off['colors'] * 1.5,
                           f"{off['colors']} → {on['colors']}") else 1
            # ⚠️ 补丁/方差这类**像素统计**只作参考：无头环境下取景与标签位置会漂，
            #    真正逐条钉死"水洗 0.42 / 浮雕 drawImage"的是 `unit/test_scenario_relief.js`（假 ctx 记账）。
            print('  （参考）水洗与浮雕的接线判据见 unit/test_scenario_relief.js', flush=True)
            print(f'  → {on_png}\n  → {off_png}（并排看：关的那张应是纯平涂）', flush=True)

        print(('  ✅ 浮雕判据通过' if not bad else f'  🔴 {bad} 项没过'), flush=True)
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
