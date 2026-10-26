#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 153：地形注记（山脊候选 → 命名 → 落库 → 撤销）

背景（D3，2026-10-26）：
  参考图的信息密度有一半来自「亚平宁山脉」这类**沿走向排布的山系名**。
  我们此前既没有这类数据、也没有入口。这一版：
    · `utils/ridges.detectRidges` 从高度图抽脊线候选（纯函数，单测覆盖）；
    · 面板里逐条命名（**没名字不落库**，不自动编专名）；
    · 落库 `baseMaps[key].terrainLabels`（整表一条 undo，`origin:'auto'` 标记来源）。

判据（全部读真实状态，不看按钮文字）：
  1. 点「地形注记」→ 面板出现；
  2. 点「检测山脊」→ 候选 ≥1（人造对角山脊）；
  3. 命名 + 应用 → store 里有 1 条，`origin='auto'`、点数 ≥2、名字正确；
  4. 一次 `undo()` → 注记退回 0 条；
  5. 重绘不抛（`SM.render()` 后的渲染错误为空）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例153底图'


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
      s.addBaseProvince(KEY, { id: 'prov_a', name: '省A', kind: 'land',
        points: [{x:100,y:100},{x:760,y:100},{x:760,y:600},{x:100,y:600}] }, { checkOverlap: false });
      // 人造对角山脊（与单测同一形状：48×48、周边是海、脊线沿 x=y）
      const cols = 48, rows = 48, spacing = 20;
      const h = [], points = [];
      for (let r2 = 0; r2 < rows; r2++) {
        for (let c = 0; c < cols; c++) {
          points.push([c * spacing, r2 * spacing]);
          const border = c < 4 || r2 < 4 || c >= cols - 4 || r2 >= rows - 4;
          if (border) { h.push(12); continue; }
          const d = Math.abs(c - r2) / Math.SQRT2;
          h.push(Math.round((30 + 40 * Math.exp(-(d * d) / 12)) * 100) / 100);
        }
      }
      s.baseMaps[KEY].heightmap = { h: new Float32Array(h), grid: { cellsX: cols, cellsY: rows, spacing, points } };
      // 画布要有内容才能截图/重绘：加一段剧本并选中它（与 test_149 同一套造数）
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { prov_a: 'P1' },
      });
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0;
      SM.tlDate = { y: 2000, m: null, d: null };
      SM.rasterLayer = 'height';
      await tick(120);
      return JSON.stringify({ ok: true, hm: h.length });
    })()"""
    ok, seeded = eval_json(cdp, seed.replace('__STORE__', STORE).replace('__SM__', SM)
                           .replace('__KEY__', json.dumps(KEY)),
                           required=('ok',), desc='造一张带山脊的底图')
    if not ok or not seeded.get('ok'):
        return False, f'造数失败：{seeded}'

    # ① 进「底图编辑」模式：地形注记是**地理数据**，住在底图编辑行（与「改省界」同一排）
    mode_js = """(() => {
      const btn = Array.from(document.querySelectorAll('[data-testid="toolbar-modes"] button'))
        .find(b => (b.textContent || '').includes('底图编辑'));
      if (!btn) return 'no-mode-btn';
      if (!/✓/.test(btn.textContent || '')) btn.click();
      return 'ok';
    })()"""
    if cdp.eval(mode_js) != 'ok':
        return False, '找不到「底图编辑」模式按钮'
    try:
        wait_for(cdp, "!!document.querySelector('[data-testid=\"basemap-row\"]')",
                 desc='底图工具行', timeout=6)
    except Exception:
        return False, '底图编辑模式没打开'

    # ② 打开面板
    open_panel = """(() => {
      const b = document.querySelector('[data-testid="basemap-terrain-labels"]');
      if (!b) {
        const ids = Array.from(document.querySelectorAll('[data-testid^="basemap-"]'))
          .map((e) => e.getAttribute('data-testid'));
        return 'no-btn:' + JSON.stringify(ids);
      }
      b.click();
      return 'ok';
    })()"""
    opened = cdp.eval(open_panel)
    if opened != 'ok':
        return False, f'找不到「地形注记」按钮：{opened}'
    try:
        wait_for(cdp, "!!document.querySelector('[data-testid=\"terrain-labels-panel\"]')",
                 desc='地形注记面板', timeout=6)
    except Exception:
        return False, '面板没打开'

    # ② 检测山脊
    detect = r"""(async () => {
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const b = document.querySelector('[data-testid="terrain-labels-detect"]');
      if (!b) return JSON.stringify({ err: 'no-detect-btn' });
      b.click();
      await tick(250);
      const status = document.querySelector('[data-testid="terrain-labels-status"]');
      const rows = document.querySelectorAll('[data-testid^="terrain-label-name-"]');
      return JSON.stringify({ status: (status && status.textContent) || '', rows: rows.length });
    })()"""
    ok, det = eval_json(cdp, detect, required=('rows',), desc='检测山脊')
    if not ok:
        return False, f'检测求值失败：{det}'
    if int(det.get('rows') or 0) < 1:
        return False, f"检测没出候选：{det}"
    if '检测到' not in str(det.get('status') or ''):
        return False, f"状态栏没报候选：{det}"

    # ③ 命名 + 应用
    apply_js = r"""(async () => {
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const inp = document.querySelector('[data-testid="terrain-label-name-0"]');
      if (!inp) return JSON.stringify({ err: 'no-name-input' });
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '测试山脉');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await tick(60);
      const btn = document.querySelector('[data-testid="terrain-labels-apply"]');
      if (!btn) return JSON.stringify({ err: 'no-apply-btn' });
      if (btn.disabled) return JSON.stringify({ err: 'apply-disabled' });
      btn.click();
      await tick(300);
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const bm = s.baseMaps[KEY] || {};
      const labels = bm.terrainLabels || [];
      // 顺带重绘一次：既抓渲染异常，也证明画布真的出了像素
      // （2026-10-26 实测价值：这一条抓出过 `drawLabels` 丢了 null 守卫 → 渲染护栏暂停、整张画布空白）
      let renderError = '';
      if (SM && SM.render) {
        try { SM.render(); } catch (e) { renderError = String((e && e.message) || e); }
      }
      // 渲染走 rAF：读像素前等两帧（否则读到的是 clearRect 之后的空画布）
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await tick(120);
      let canvasPainted = false;
      try {
        const cv = document.querySelector('.scenario-map-container canvas');
        if (cv) {
          const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          for (let k = 3; k < d.length; k += 4) { if (d[k]) { canvasPainted = true; break; } }
        }
      } catch (e) { renderError = renderError || String((e && e.message) || e); }
      const status = document.querySelector('[data-testid="terrain-labels-status"]');
      return JSON.stringify({
        count: labels.length,
        first: labels[0] ? { name: labels[0].name, kind: labels[0].kind, origin: labels[0].origin,
                             points: (labels[0].points || []).length } : null,
        status: (status && status.textContent) || '',
        renderError,
        canvasPainted,
        paused: !!SM.renderPaused,
        guardError: String(SM.renderError || '').slice(0, 120),
      });
    })()"""
    ok, applied = eval_json(cdp, apply_js.replace('__STORE__', STORE).replace('__SM__', SM)
                            .replace('__KEY__', json.dumps(KEY)),
                            required=('count',), desc='命名并应用')
    if not ok:
        return False, f'应用求值失败：{applied}'
    fails = []
    if int(applied.get('count') or 0) != 1:
        fails.append(f"注记没落库（count={applied.get('count')}）：{applied}")
    first = applied.get('first') or {}
    if first.get('name') != '测试山脉':
        fails.append(f"名字不对：{first}")
    if first.get('origin') != 'auto':
        fails.append(f"来源标记应为 auto（用户手绘才是 user）：{first}")
    if int(first.get('points') or 0) < 2:
        fails.append(f"几何点数不足：{first}")
    if applied.get('renderError'):
        fails.append(f"重绘抛异常：{applied.get('renderError')}")
    if applied.get('paused'):
        fails.append(f"渲染护栏已暂停（guardError={applied.get('guardError')}）—— 画布会整片空白")
    if not applied.get('canvasPainted'):
        fails.append(f"应用后画布没有像素（guardError={applied.get('guardError')}）—— 注记没画出来或渲染挂了")

    # 可选截图：人眼看"山系名沿脊线排"到底什么样
    shot_dir = os.environ.get('SITIAN_SHOT_DIR')
    if shot_dir:
        import base64
        import pathlib
        import time as _t
        from lib.cdp import fetch_string
        try:
            cdp.eval("(() => { const SM = %s; SM.showTerrainNames = true;"
                     " if (SM.render) SM.render(); return 'ok'; })()" % SM)
            _t.sleep(0.4)
            cdp.eval("(() => { const cv = document.querySelector('.scenario-map-container canvas');"
                     " window.__SHOT__ = cv ? cv.toDataURL('image/png') : ''; return 'ok'; })()")
            data_url = fetch_string(
                cdp,
                "window.__SHOT__ ? window.__SHOT__.length : -1",
                lambda i, j: "window.__SHOT__.slice(%d,%d)" % (i, j),
                chunk=262144, desc='地形注记画布')
            if isinstance(data_url, str) and data_url.startswith('data:image'):
                out_dir = pathlib.Path(shot_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / 'terrain-labels.png').write_bytes(
                    base64.b64decode(data_url.split(',', 1)[-1]))
        except Exception:
            pass

    # ④ 撤销 → 归零
    undo_js = r"""(async () => {
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const s = __STORE__, KEY = __KEY__;
      s.undo();
      await tick(200);
      const labels = (s.baseMaps[KEY] || {}).terrainLabels || [];
      return JSON.stringify({ count: labels.length });
    })()"""
    ok, undone = eval_json(cdp, undo_js.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY)),
                           required=('count',), desc='撤销地形注记')
    if not ok:
        return False, f'撤销求值失败：{undone}'
    if int(undone.get('count') or 0) != 0:
        fails.append(f"一次 undo 没把注记退回：还剩 {undone.get('count')} 条")

    if fails:
        return False, '；'.join(fails)[:800] + ' | 实测：' + json.dumps(
            {'detect': det, 'apply': applied, 'undo': undone}, ensure_ascii=False)[:600]
    return True, (f"面板→检测 {det.get('rows')} 条候选→命名落库 1 条（origin=auto / "
                  f"{first.get('points')} 点）→ 画布有像素（未暂停）→ 一次 undo 归零")
