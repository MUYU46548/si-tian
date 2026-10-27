#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 161：粗格导入图（97×45 量级）的等深线 —— 用高精度海岸线环重建海深场

背景（2026-10-27）：
  真实 415 省底图是 **97×45 / 格距 18.3 世界单位**。`extractIsoLines` 在这种格上
  一圈只出十来个像素一段的多边形，等于画不出等深线 —— `getSeaDetail` 的 spacing 闸门
  因此只给它渐变（用户当时也接受了这个取舍）。
  但这类图恰恰带着**高精度海岸线环**（`landFeatures`，实测 20 环 / 1747 点）：
  有精度的海岸线就能重建一张够细的"离岸距离"场。

口径（与 `buildSeaDepth` 逐字一致，只换数据源）：
  环 → 偶数奇偶扫描线栅格化（step ≈ 格距/4）→ 8 邻域 Chamfer 距岸 + 两遍平滑 →
  按本场距岸分布 p70 归一化 → t = 1 - exp(-d/ref) → 同一组 `SEA_DEPTH_LEVELS` 抽线。

判据：
  1. 粗格（spacing 18）+ 高精度环：`getSeaDetail().isobaths` **非空**（修复前为空）；
  2. 同一份底图**去掉环**（只剩粗格高度场）→ 等深线为 0（证明增益来自环，不是别处漏进来的）；
  3. 导出的 SVG 里出现等深线 `<path>`（stroke `rgba(48, 96, 128, 0.20)`）——
     画布与导出读的是同一份 `getSeaDetail`；
  4. 海岸线仍在（环本身），且地图没被"算崩"（调用在 3s 内返回）。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例161底图'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('#app')", desc='应用挂载', timeout=15)
    ensure_data_ready(cdp)
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn'; btn.click(); return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入历史剧本失败：{r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)

    seed = r"""(async () => {
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
      s.addBaseMap(KEY, { name: KEY });
      s.addBaseProvince(KEY, { id: 'p161', name: '省161', kind: 'land',
        points: [{x:60,y:60},{x:520,y:60},{x:520,y:460},{x:60,y:460}] }, { checkOverlap: false });
      // 粗格：20×20 / spacing 18（≈ 97×45 的量级），中间一块方岛
      const cols = 20, rows = 20, spacing = 18;
      const h = [], points = [];
      for (let r2 = 0; r2 < rows; r2++) {
        for (let c = 0; c < cols; c++) {
          points.push([c * spacing, r2 * spacing]);
          const land = c >= 6 && c <= 13 && r2 >= 6 && r2 <= 13;
          h.push(land ? 45 : 12);
        }
      }
      s.baseMaps[KEY].heightmap = { h: new Float32Array(h), grid: { cellsX: cols, cellsY: rows, spacing, points } };
      // 高精度海岸线环（真实 .map 的 landFeatures 就是这个量级：一圈几十个点）
      const ring = [];
      const x0 = 100, y0 = 100, x1 = 240, y1 = 240;   // 与上面方岛大致重合
      for (let i = 0; i <= 20; i++) ring.push({ x: x0 + (x1 - x0) * (i / 20), y: y0 });
      for (let i = 0; i <= 20; i++) ring.push({ x: x1, y: y0 + (y1 - y0) * (i / 20) });
      for (let i = 0; i <= 20; i++) ring.push({ x: x1 - (x1 - x0) * (i / 20), y: y1 });
      for (let i = 0; i <= 20; i++) ring.push({ x: x0, y: y1 - (y1 - y0) * (i / 20) });
      s.baseMaps[KEY].landFeatures = [{ points: ring }];
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { p161: 'P1' },
      });
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0; SM.tlDate = { y: 2000, m: null, d: null };
      SM.rasterLayer = 'height';
      await tick(150);
      return JSON.stringify({ ok: true, spacing, rings: 1 });
    })()"""
    ok, seeded = eval_json(cdp, seed.replace('__STORE__', STORE).replace('__SM__', SM)
                           .replace('__KEY__', json.dumps(KEY)), required=('spacing',), desc='造粗格底图 + 高精度环')
    if not ok or int(seeded.get('spacing') or 0) != 18:
        return False, f'造数失败：{seeded}'

    probe = r"""(async () => {
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const t0 = Date.now();
      const d = SM.getSeaDetail ? SM.getSeaDetail() : null;
      const cost = Date.now() - t0;
      const withRings = d ? {
        isobaths: (d.isobaths || []).length,
        coastPts: (d.coasts || []).reduce((n, r) => n + (r.length || 0), 0),
      } : { isobaths: 0, coastPts: 0 };
      // 反向对照：把环拿掉（只剩粗格高度场）→ 等深线必须归零
      const ring = s.baseMaps[KEY].landFeatures;
      delete s.baseMaps[KEY].landFeatures;
      await tick(30);
      const d2 = SM.getSeaDetail ? SM.getSeaDetail() : null;
      const noRings = { isobaths: (d2 && d2.isobaths || []).length };
      s.baseMaps[KEY].landFeatures = ring;   // 复原（后续导出要用环）
      await tick(30);
      const d3 = SM.getSeaDetail ? SM.getSeaDetail() : null;
      return JSON.stringify({
        withRings, noRings, cost,
        restoredIsobaths: (d3 && d3.isobaths || []).length,
      });
    })()"""
    ok, out = eval_json(cdp, probe.replace('__STORE__', STORE).replace('__SM__', SM)
                        .replace('__KEY__', json.dumps(KEY)), required=('withRings',), desc='粗格等深线（有环 / 无环）')
    if not ok:
        return False, f'探测失败：{out}'
    wr = out.get('withRings') or {}
    nr = out.get('noRings') or {}

    build = r"""(async () => {
      const SM = __SM__;
      const fn = SM.buildScenarioSVG || (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG);
      if (!fn) return JSON.stringify({ __err__: '没有 buildScenarioSVG' });
      const svg = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      const count = (needle) => (svg.split(needle).length - 1);
      return JSON.stringify({
        len: svg.length,
        isobathPaths: count('rgba(48, 96, 128, 0.20)'),
        imgs: count('<image'),
        coast: count('rgba(44, 92, 122, 0.45)'),
      });
    })()"""
    ok, exp = eval_json(cdp, build.replace('__SM__', SM).replace('__STORE__', STORE)
                        .replace('__KEY__', json.dumps(KEY)), required=('len',), desc='导出 SVG')
    if not ok:
        return False, f'导出失败：{exp}'

    fails = []
    if int(wr.get('isobaths') or 0) < 1:
        fails.append(f"粗格 + 高精度环仍没有等深线（isobaths={wr.get('isobaths')}）")
    if int(nr.get('isobaths') or 0) != 0:
        fails.append(f"反向对照失败：去掉环后仍有 {nr.get('isobaths')} 条等深线（闸门没生效）")
    if int(wr.get('coastPts') or 0) < 3:
        fails.append(f"海岸线丢了（coastPts={wr.get('coastPts')}）")
    if int(out.get('cost') or 0) > 3000:
        fails.append(f"算一次等深线用了 {out.get('cost')}ms（>3s，真实 415 省图会卡）")
    if int(exp.get('isobathPaths') or 0) < 1:
        fails.append('导出 SVG 里没有等深线 path —— 画布与导出没读同一份 getSeaDetail')
    if int(exp.get('imgs') or 0) < 1:
        fails.append('导出没有内联地形底图（地形档应带）')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(
            {'withRings': wr, 'noRings': nr, 'cost': out.get('cost'), 'export': exp}, ensure_ascii=False)[:600]
    return True, (f"粗格 18：有环 → 等深线 {wr.get('isobaths')} 条（{out.get('cost')}ms）、"
                  f"无环 → {nr.get('isobaths')} 条（闸门有效）；海岸线 {wr.get('coastPts')} 点；"
                  f"导出等深线 path {exp.get('isobathPaths')} 处")
