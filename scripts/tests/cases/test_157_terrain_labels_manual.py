#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 157：地形注记的手动入口（画山系 / 画海域 / 点平原）

背景（D3 收口，2026-10-27）：
  数据形状早就支持 `kind:'range'|'sea'|'plain'`，面板却只能从高度图抽 `range` 候选：
  · **没有高度图**的底图（老 97×45 导入图、手画的空底图）一条注记都做不出来；
  · 海域/平原连入口都没有 —— 而参考图里「第勒尼安海」「波河平原」这类名字占了一半信息量。
  更糟的是画布侧 `drawTerrainLabels` 写着 `pts.length < 2 → continue`：**平原（1 点）永远不画**。

判据（全部走真实 UI 事件 + 真实 store）：
  1. 无高度图 →「检测山脊」灰禁，但「点平原 / 画山系 / 画海域」可点（手动不依赖高度图）；
  2. 点平原：点一下画布 → 面板报「已取点」→ 完成 → 命名 → 应用 → store 里 1 条 `kind:'plain'`、
     `origin:'user'`、**1 个点**；且画布真的有像素变化（关掉「地形名称」前后差 > 100 px ——
     这一条专门守上面那个「平原永远不画」的缺陷）；
  3. 画山系（拖一条线）+ 画海域（拖一条线）：各成一条，点数 ≥2，`kind` 分别对；
  4. 三次应用后共 3 条（顺序 range/plain/sea 无关），全部 `origin:'user'`，一次 undo 退回 2 条（最后一次）；
  5. 面板「取消」与 Esc 都能退出采集态，且**数据一个字节没变**。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_case_state                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例157底图'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('#app')", desc='应用挂载', timeout=15)
    ensure_case_state(cdp)
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn'; btn.click(); return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入历史剧本失败：{r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)

    # ① 造一张**没有高度图**的底图（手动入口最该能用的地方）
    seed = r"""(async () => {
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
      s.addBaseMap(KEY, { name: KEY });
      s.addBaseProvince(KEY, { id: 'p157', name: '省157', kind: 'land',
        points: [{x:40,y:40},{x:620,y:40},{x:620,y:520},{x:40,y:520}] }, { checkOverlap: false });
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { p157: 'P1' },
      });
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0; SM.tlDate = { y: 2000, m: null, d: null };
      SM.cameraScale = 1; SM.cameraX = 0; SM.cameraY = 0;
      await tick(500);
      SM.cameraScale = 1; SM.cameraX = 0; SM.cameraY = 0;
      const bm = s.baseMaps[KEY] || {};
      return JSON.stringify({ ok: true, hasHm: !!(bm.heightmap && bm.heightmap.h) });
    })()"""
    ok, seeded = eval_json(cdp, seed.replace('__STORE__', STORE).replace('__SM__', SM)
                           .replace('__KEY__', json.dumps(KEY)), required=('ok',), desc='造一张无高度图底图')
    if not ok or not seeded.get('ok'):
        return False, f'造数失败：{seeded}'

    # ② 进「底图编辑」→ 打开地形注记面板
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
        wait_for(cdp, "!!document.querySelector('[data-testid=\"basemap-row\"]')", desc='底图工具行', timeout=6)
    except Exception:
        return False, '底图编辑模式没打开'
    opened = cdp.eval("""(() => {
      const b = document.querySelector('[data-testid="basemap-terrain-labels"]');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")
    if opened != 'ok':
        return False, '找不到「地形注记」按钮'
    try:
        wait_for(cdp, "!!document.querySelector('[data-testid=\"terrain-labels-panel\"]')", desc='面板', timeout=6)
    except Exception:
        return False, '面板没打开'

    # ②' 无高度图：检测灰禁、手动三个入口可点（手动不依赖高度图）
    avail = cdp.eval("""(() => {
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      return JSON.stringify({
        detect: !!(q('terrain-labels-detect') && q('terrain-labels-detect').disabled),
        range: !!(q('terrain-labels-pick-range') && !q('terrain-labels-pick-range').disabled),
        sea: !!(q('terrain-labels-pick-sea') && !q('terrain-labels-pick-sea').disabled),
        plain: !!(q('terrain-labels-pick-plain') && !q('terrain-labels-pick-plain').disabled),
      });
    })()""")
    try:
        av = json.loads(avail) if isinstance(avail, str) else {}
    except ValueError:
        av = {}
    fails = []
    if not av.get('detect'):
        fails.append(f"没有高度图时「检测山脊」应灰禁（实际可点）：{av}")
    for k in ('range', 'sea', 'plain'):
        if not av.get(k):
            fails.append(f'手动入口「{k}」不可点（没有高度图也不该灰禁）：{av}')

    # ③ 点平原：真实鼠标事件 → 完成 → 命名 → 应用 → 画布有像素变化
    plain_js = r"""(async () => {
      const SM = __SM__, s = __STORE__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      const cv = () => document.querySelector('.scenario-map-container canvas');
      const setInput = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const mouse = (type, sx, sy) => {
        const el = cv();
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1,
          clientX: rect.left + sx, clientY: rect.top + sy,
        }));
      };
      const grab = async () => {
        if (SM.render) SM.render();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await tick(80);
        const el = cv();
        return el.getContext('2d').getImageData(0, 0, el.width, el.height);
      };
      // 平原：点一下
      q('terrain-labels-pick-plain').click();
      await tick(80);
      mouse('mousedown', 320, 220);
      mouse('mouseup', 320, 220);
      await tick(120);
      const pickState = (() => {
        const p = SM.terrainLabelPick;
        return p ? { kind: p.kind, n: (p.points || []).length, finished: !!p.finished } : null;
      })();
      const statusInPanel = (q('terrain-labels-pick-status') || {}).textContent || '';
      const doneBtn = q('terrain-labels-pick-done');
      if (doneBtn) doneBtn.click();
      await tick(120);
      const input = q('terrain-label-name-0');
      if (!input) return JSON.stringify({ err: 'no-row-after-finish', pickState });
      setInput(input, '测试平原');
      await tick(60);
      const applyBtn = q('terrain-labels-apply');
      const applyDisabled = !!(applyBtn && applyBtn.disabled);
      applyBtn.click();
      await tick(220);
      const labels = ((s.baseMaps[__KEY__] || {}).terrainLabels) || [];
      SM.showTerrainNames = true;
      const on = await grab();
      SM.showTerrainNames = false;
      const off = await grab();
      SM.showTerrainNames = true;
      if (SM.render) SM.render();
      let diff = 0;
      // ⚠️ 必须比 RGB：画布底色 alpha 恒为 255，只比 alpha 会永远 0（这条断言一开始就栽在这）
      for (let i = 0; i < on.data.length; i += 4) {
        const d = Math.abs(on.data[i] - off.data[i])
          + Math.abs(on.data[i + 1] - off.data[i + 1])
          + Math.abs(on.data[i + 2] - off.data[i + 2]);
        if (d > 16) diff++;
      }
      return JSON.stringify({
        pickState, statusInPanel, applyDisabled, diff,
        count: labels.length, labels: labels.map(l => ({ kind: l.kind, name: l.name, n: (l.points || []).length, origin: l.origin })),
      });
    })()"""
    ok, plain = eval_json(cdp, plain_js.replace('__STORE__', STORE).replace('__SM__', SM)
                          .replace('__KEY__', json.dumps(KEY)),
                          required=('count',), desc='点平原 → 命名 → 应用')
    if not ok:
        return False, f'点平原失败：{plain}'
    ps = plain.get('pickState') or {}
    if ps.get('kind') != 'plain' or int(ps.get('n') or 0) != 1 or not ps.get('finished'):
        fails.append(f'点平原后采集态不对（应 finished + 1 点）：{plain.get("pickState")}')
    if '已取点' not in str(plain.get('statusInPanel') or ''):
        fails.append(f'面板没报「已取点」：{plain.get("statusInPanel")!r}')
    if int(plain.get('count') or 0) != 1:
        fails.append(f'平原注记没落库：{plain.get("labels")}')
    pl = (plain.get('labels') or [{}])[0]
    if pl.get('kind') != 'plain' or pl.get('origin') != 'user' or int(pl.get('n') or 0) != 1:
        fails.append(f'平原注记形状不对（应 plain/user/1 点）：{pl}')
    if int(plain.get('diff') or 0) < 100:
        fails.append(f"平原名没画出来（开关「地形名称」前后只差 {plain.get('diff')} 像素）")

    # ④ 画山系 + 画海域（拖一条线），沿用「完成 → 命名 → 应用」同一流程
    drag_js = r"""(async () => {
      const SM = __SM__, s = __STORE__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      const cv = () => document.querySelector('.scenario-map-container canvas');
      const setInput = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const mouse = (type, sx, sy) => {
        const el = cv();
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1,
          clientX: rect.left + sx, clientY: rect.top + sy,
        }));
      };
      const drag = async (pickId, pairs) => {
        q(pickId).click();
        await tick(80);
        mouse('mousedown', pairs[0][0], pairs[0][1]);
        for (let i = 1; i < pairs.length; i++) {
          mouse('mousemove', pairs[i][0], pairs[i][1]);
          await tick(30);
        }
        const last = pairs[pairs.length - 1];
        mouse('mouseup', last[0], last[1]);
        await tick(120);
        const p = SM.terrainLabelPick;
        const state = p ? { kind: p.kind, n: (p.points || []).length, finished: !!p.finished } : null;
        const done = q('terrain-labels-pick-done');
        if (done) done.click();
        await tick(100);
        return state;
      };
      const st1 = await drag('terrain-labels-pick-range', [[150, 120], [230, 190], [310, 260], [380, 320]]);
      const input1 = q('terrain-label-name-1');
      if (input1) setInput(input1, '测试山脉');
      await tick(60);
      q('terrain-labels-apply').click();
      await tick(200);
      const st2 = await drag('terrain-labels-pick-sea', [[120, 300], [240, 320], [400, 300]]);
      const input2 = q('terrain-label-name-2');
      if (input2) setInput(input2, '测试海');
      await tick(60);
      q('terrain-labels-apply').click();
      await tick(220);
      const labels = ((s.baseMaps[__KEY__] || {}).terrainLabels) || [];
      let renderError = '';
      try { SM.render(); } catch (e) { renderError = String((e && e.message) || e); }
      return JSON.stringify({
        st1, st2, count: labels.length, renderError,
        renderPaused: !!SM.renderPaused, guardError: String(SM.renderError || '').slice(0, 200),
        labels: labels.map(l => ({ kind: l.kind, name: l.name, n: (l.points || []).length, origin: l.origin })),
        pickLeft: !!SM.terrainLabelPick,
      });
    })()"""
    ok, drawn = eval_json(cdp, drag_js.replace('__STORE__', STORE).replace('__SM__', SM)
                          .replace('__KEY__', json.dumps(KEY)),
                          required=('count',), desc='画山系 + 画海域')
    if not ok:
        return False, f'画线失败：{drawn}'
    if int(drawn.get('count') or 0) != 3:
        fails.append(f"应有 3 条（平原 + 山系 + 海域），实际 {drawn.get('count')}：{drawn.get('labels')}")
    kinds = [l.get('kind') for l in (drawn.get('labels') or [])]
    for k in ('range', 'sea', 'plain'):
        if k not in kinds:
            fails.append(f'缺 {k} 注记：{drawn.get("labels")}')
    for l in (drawn.get('labels') or []):
        if l.get('origin') != 'user':
            fails.append(f"手绘注记的 origin 应为 user：{l}")
        if l.get('kind') != 'plain' and int(l.get('n') or 0) < 2:
            fails.append(f"线状注记点数不足：{l}")
    if drawn.get('pickLeft'):
        fails.append('「完成」之后采集态没有收尾（pick 还在）')
    if drawn.get('renderError'):
        fails.append(f"落库后重绘抛异常：{drawn.get('renderError')}")
    if drawn.get('renderPaused'):
        fails.append(f"渲染护栏已暂停（guardError={drawn.get('guardError')}）—— 画布会整片空白")

    # 可选截图：人眼看三种注记（平原横排 / 山系沿脊 / 海域疏排）各自的观感。
    # ⚠️ 必须在 ⑤ undo **之前**抓：undo 撤掉的是最后一条（海域），截图会少一类。
    shot_dir = os.environ.get('SITIAN_SHOT_DIR')
    if shot_dir:
        import base64
        import pathlib
        import time as _t
        from lib.cdp import fetch_string
        try:
            cdp.eval("(() => { const SM = %s; SM.showTerrainNames = true; SM.render(); return 'ok'; })()" % SM)
            _t.sleep(0.5)
            cdp.eval("(() => { const cv = document.querySelector('.scenario-map-container canvas');"
                     " window.__SHOT__ = cv ? cv.toDataURL('image/png') : ''; return 'ok'; })()")
            data_url = fetch_string(
                cdp,
                "window.__SHOT__ ? window.__SHOT__.length : -1",
                lambda i, j: "window.__SHOT__.slice(%d,%d)" % (i, j),
                chunk=262144, desc='地形注记（三种）')
            if isinstance(data_url, str) and data_url.startswith('data:image'):
                out_dir = pathlib.Path(shot_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / 'terrain-labels-manual.png').write_bytes(
                    base64.b64decode(data_url.split(',', 1)[-1]))
        except Exception:
            pass

    # ⑤ 一次 undo 退回 2 条（最后一次应用 = 一条命令）
    ok, undone = eval_json(cdp, r"""(async () => {
      const s = __STORE__, KEY = __KEY__;
      s.undo();
      await new Promise(r => setTimeout(r, 200));
      const labels = ((s.baseMaps[KEY] || {}).terrainLabels) || [];
      return JSON.stringify({ count: labels.length, kinds: labels.map(l => l.kind) });
    })()""".replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY)),
                          required=('count',), desc='一次 undo')
    if ok and int(undone.get('count') or 0) != 2:
        fails.append(f"一次 undo 应退回 2 条（实际 {undone.get('count')}）")

    # ⑥ 取消通路：开始采集 → 面板「取消」→ 采集态清空、数据未动；Esc 同理
    cancel_js = r"""(async () => {
      const SM = __SM__, s = __STORE__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      const before = JSON.stringify(((s.baseMaps[KEY] || {}).terrainLabels) || []);
      q('terrain-labels-pick-range').click();
      await tick(80);
      const active1 = !!SM.terrainLabelPick;
      q('terrain-labels-pick-cancel').click();
      await tick(80);
      const cleared1 = !SM.terrainLabelPick;
      // Esc 通路
      q('terrain-labels-pick-sea').click();
      await tick(80);
      const active2 = !!SM.terrainLabelPick;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick(80);
      const cleared2 = !SM.terrainLabelPick;
      const after = JSON.stringify(((s.baseMaps[KEY] || {}).terrainLabels) || []);
      return JSON.stringify({ active1, cleared1, active2, cleared2, same: before === after });
    })()"""
    ok, cancelled = eval_json(cdp, cancel_js.replace('__STORE__', STORE).replace('__SM__', SM)
                              .replace('__KEY__', json.dumps(KEY)),
                              required=('same',), desc='取消与 Esc')
    if not ok:
        fails.append(f'取消通路求值失败：{cancelled}')
    else:
        if not (cancelled.get('active1') and cancelled.get('cleared1')):
            fails.append(f'面板「取消」没退出采集态：{cancelled}')
        if not (cancelled.get('active2') and cancelled.get('cleared2')):
            fails.append(f'Esc 没退出采集态：{cancelled}')
        if not cancelled.get('same'):
            fails.append('取消/Esc 竟然改了数据（采集期必须零落库）')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(
            {'avail': av, 'plain': {k: plain.get(k) for k in ('count', 'diff', 'pickState')},
             'drawn': drawn.get('labels')}, ensure_ascii=False)[:600]

    return True, (f"无高度图也能手动：平原 1 点（画布差 {plain.get('diff')} 像素）+ 山系/海域各一条线 → "
                  f"3 条都 origin=user → 一次 undo 退 1 条 → 取消/Esc 零落库")
