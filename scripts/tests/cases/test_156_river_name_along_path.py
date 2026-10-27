#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 156：河名沿河排字（D3 收口，2026-10-27）

背景：
  参考图里河名是**顺着河道弯的**，我们此前一直是水平字：名字横跨河湾，
  读者反而看不出它指哪条河。几何层 `utils/textOnPath.js` 早在 2026-10-26 就绪
  （山系名已经沿脊线排），但河名仍走 `drawPlannedLabels(['river'])` 的水平分支。

  这一版把河名接上：
    · `collectRiverLabels` 把折线一并带出（只给中点就只能写水平字）；
    · 排布（`labelLayout`）仍决定「放在哪一段河道附近」——不许沿整条河的中点乱跑；
    · 绘制时先把落点**投到河道上**、取它两侧一段（`slicePathAroundPoint`），再沿这段逐字排；
    · 弯太急导致缺字时**退回水平字**（缺字的名字比横排更难读）。

判据（像素级，不靠读代码猜）：
  1. 排布结论里 river 条目带 `path`（折线真的传到了绘制层）；
  2. 45° 斜河的河名：开关「自动地名」的前后像素差 → 变化像素的主轴斜率 |slope| ≥ 0.55、
     纵向跨度 ≥ 30px（水平字的主轴斜率≈0、纵向只有一行字高）；
  3. 反向对照（同一套算子）：把河改成水平直线，同一测法 slope ≤ 0.25、纵向跨度 ≤ 26px
     —— 证明判据能区分"沿河"与"横排"，不是空转；
  4. 源码闸门：ScenarioMap 走 `slicePathAroundPoint` + `layoutTextAlongPath`，
     且保留水平退回分支。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例156底图'

DIAG = [{'x': 100, 'y': 50}, {'x': 170, 'y': 120}, {'x': 240, 'y': 190},
        {'x': 310, 'y': 260}, {'x': 380, 'y': 330}]
FLAT = [{'x': 100, 'y': 190}, {'x': 190, 'y': 190}, {'x': 280, 'y': 190}, {'x': 380, 'y': 190}]


def _read(rel):
    import io
    return io.open(os.path.join(os.path.dirname(__file__), '..', '..', '..', rel), encoding='utf-8').read()


# 同一个测量算子：开着/关掉「自动地名」各抓一帧，差集就是这批字；
# 再对差集做最小二乘 → 主轴斜率（水平字≈0，45° 沿河字≈1）。
MEASURE_JS = r"""(async () => {
  const SM = __SM__;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
  // 相机：让「可见比例」落在 near 档（ratio≈0.5）—— 河名在 mid/far 档刻意不标
  // （2026-10-27 起档位按可见比例判定，不是绝对 scale；见 utils/labelZoom.js）。
  // 同时把河道中点放到视口中心，否则字排在屏外、差集里一个像素都没有。
  const MAP_W = 580;
  const setCam = () => {
    const W = SM.cw(), H = SM.ch();
    SM.cameraScale = W / (0.5 * MAP_W);
    SM.cameraX = W / 2 - 240 * SM.cameraScale;
    SM.cameraY = H / 2 - 190 * SM.cameraScale;
  };
  const cv = () => document.querySelector('.scenario-map-container canvas');
  const grab = async () => {
    setCam();
    if (SM.render) SM.render();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // 适屏是异步的（onBaseMapChange / 剧本载入 watcher）：这一帧里还有人重设相机就再压回去
    setCam();
    if (SM.render) SM.render();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await tick(80);
    const el = cv();
    return el ? el.getContext('2d').getImageData(0, 0, el.width, el.height) : null;
  };
  const stat = (a, b) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
          + Math.abs(a.data[i + 2] - b.data[i + 2]) + Math.abs(a.data[i + 3] - b.data[i + 3]);
        if (d <= 24) continue;              // 抗锯齿/抖动噪声
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (n < 2) return { n, slope: 0, w: 0, h: 0 };
    const den = n * sxx - sx * sx;
    return {
      n,
      slope: den > 1e-6 ? (n * sxy - sx * sy) / den : 0,
      w: maxX - minX, h: maxY - minY,
      cx: sx / n, cy: sy / n,
    };
  };
  SM.showPlaceNames = true;
  const on = await grab();
  SM.showPlaceNames = false;
  const off = await grab();
  SM.showPlaceNames = true;
  if (!on || !off) return JSON.stringify({ __err__: 'no-canvas' });
  const m = stat(on, off);
  const plan = (typeof SM.getLabelPlan === 'function') ? SM.getLabelPlan() : [];
  const riverPlans = plan.filter((p) => p.kind === 'river');
  let cand = null;
  try {
    const lm = await import('/src/utils/labelZoom.js');
    const sp = await import('/src/utils/scenarioTextPlacement.js');
    const rivers = (SM.baseMap && SM.baseMap.rivers) || [];
    const caps = lm.detailCaps(lm.zoomDetail(SM.mapVisibleRatio ? SM.mapVisibleRatio() : 0.5));
    const got = caps.rivers >= 0 ? sp.collectRiverLabels(rivers, { tier: caps.rivers }) : [];
    cand = { caps, n: got.length, pathLen: got[0] && got[0].path ? got[0].path.length : 0 };
  } catch (e) { cand = { err: String((e && e.message) || e) }; }
  return JSON.stringify({
    n: m.n, slope: m.slope, w: m.w, h: m.h, cx: m.cx, cy: m.cy,
    planKinds: plan.map((p) => p.kind),
    riverPlanCount: riverPlans.length,
    riverPlanPathLen: riverPlans[0] && Array.isArray(riverPlans[0].path) ? riverPlans[0].path.length : 0,
    diag: {
      viewMode: SM.viewMode, cameraScale: SM.cameraScale,
      cw: SM.cw ? SM.cw() : null, ch: SM.ch ? SM.ch() : null,
      showPlaceNames: SM.showPlaceNames, showRiverBase: SM.showRiverBase, showRivers: SM.showRivers,
      riverSource: SM.riverSource, nRivers: ((SM.baseMap && SM.baseMap.rivers) || []).length,
      cand,
    },
  });
})()"""


def _measure(cdp, sm_expr):
    ok, out = eval_json(cdp, MEASURE_JS.replace('__SM__', sm_expr),
                        required=('n',), desc='测量河名像素主轴')
    return ok, out


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
      s.addBaseProvince(KEY, { id: 'p156', name: '省156', kind: 'land',
        points: [{x:20,y:20},{x:680,y:20},{x:680,y:600},{x:20,y:600}] }, { checkOverlap: false });
      // 只放一条有名字的河：差集里除了它没有别的文字（城镇/省名/势力名全关）
      s.baseMaps[KEY].rivers = [{ id: 'r156', name: '测试长河', points: __DIAG__, discharge: 900, width: 2 }];
      s.baseMaps[KEY].burgs = [];
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { p156: 'P1' },
      });
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0;
      SM.tlDate = { y: 2000, m: null, d: null };
      // 只留河名这一档字：省名/势力名/城镇名全关 → 像素差集里只有河名
      SM.showPolityLabels = false;
      SM.showPlaceNames = true;
      SM.showBurgs = false;
      SM.showRiverBase = true;
      // 相机在测量那一刻才设（`MEASURE_JS` 的 setCam）：进入剧本会异步适屏覆盖这里设的值。
      // 这里只等异步链路落地。
      await tick(700);
      return JSON.stringify({ ok: true, tier: SM.cameraScale });
    })()"""
    ok, seeded = eval_json(cdp, seed.replace('__STORE__', STORE).replace('__SM__', SM)
                           .replace('__KEY__', json.dumps(KEY)).replace('__DIAG__', json.dumps(DIAG)),
                           required=('ok',), desc='造一条 45° 斜河')
    if not ok or not seeded.get('ok'):
        return False, f'造数失败：{seeded}'

    ok, diag = _measure(cdp, SM)
    if not ok:
        return False, f'斜河测量失败：{diag}'

    # 反向对照：同一测法，把河换成水平直线（若判据无判别力，两条会给出相同斜率）
    flat_js = r"""(async () => {
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY],
        rivers: [{ id: 'r156', name: '测试长河', points: __FLAT__, discharge: 900, width: 2 }] } };
      await tick(150);
      return JSON.stringify({ ok: true });
    })()"""
    ok, swapped = eval_json(cdp, flat_js.replace('__STORE__', STORE).replace('__SM__', SM)
                            .replace('__KEY__', json.dumps(KEY)).replace('__FLAT__', json.dumps(FLAT)),
                            required=('ok',), desc='换成水平河（反向对照）')
    if not ok or not swapped.get('ok'):
        return False, f'反向对照造数失败：{swapped}'

    ok, flat = _measure(cdp, SM)
    if not ok:
        return False, f'水平河测量失败：{flat}'

    fails = []
    if int(diag.get('riverPlanCount') or 0) < 1:
        fails.append(f"排布里没有河名（kinds={diag.get('planKinds')}）—— 分级或候选没接上")
    if int(diag.get('riverPlanPathLen') or 0) < 2:
        fails.append(f"排布结论里的河名没带折线（path 点数={diag.get('riverPlanPathLen')}）")
    if int(diag.get('n') or 0) < 150:
        fails.append(f"斜河：差集像素太少（{diag.get('n')}）—— 河名可能没画出来")
    if abs(float(diag.get('slope') or 0)) < 0.55:
        fails.append(f"斜河：河名主轴斜率 {diag.get('slope')}（应≈1，水平字才会≈0）—— 没有沿河排")
    if int(diag.get('h') or 0) < 30:
        fails.append(f"斜河：字云纵向跨度只有 {diag.get('h')}px —— 是一行水平字")
    if int(flat.get('n') or 0) < 150:
        fails.append(f"对照：水平河的差集像素太少（{flat.get('n')}）")
    if abs(float(flat.get('slope') or 0)) > 0.25:
        fails.append(f"对照：水平河的主轴斜率 {flat.get('slope')} 竟然很陡（判据可能无判别力）")
    if int(flat.get('h') or 0) > 26:
        fails.append(f"对照：水平河的字云纵向跨度 {flat.get('h')}px 过大")

    sm_src = _read('src/renderer/src/components/ScenarioMap.vue')
    if 'slicePathAroundPoint' not in sm_src:
        fails.append('ScenarioMap 没有用 slicePathAroundPoint（河名没按落点取河道段）')
    if 'drawRiverNameAlongPath' not in sm_src:
        fails.append('ScenarioMap 缺 drawRiverNameAlongPath（沿河排字入口）')
    if 'layout.placed.length < chars.length' not in sm_src:
        fails.append('缺少「字没排全就退回水平字」的保护（缺字的名字比横排更难读）')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(
            {'diag': diag, 'flat': flat}, ensure_ascii=False)[:600]

    # 可选截图：人眼看「字是不是真的顺着河道弯」（对 45° 斜河最直观）
    shot_dir = os.environ.get('SITIAN_SHOT_DIR')
    if shot_dir:
        import base64
        import pathlib
        import time as _t
        from lib.cdp import fetch_string
        try:
            # 截图用斜河（对照用的水平河会盖掉数据）
            cdp.eval(r"""(() => {
              const s = %s, SM = %s, KEY = %s;
              s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY],
                rivers: [{ id: 'r156', name: '测试长河', points: %s, discharge: 900, width: 2 }] } };
              // 与测量同一取景（near 档 + 河道居中），否则截图里没有河名
              const W = SM.cw(), H = SM.ch();
              SM.cameraScale = W / (0.5 * 580);
              SM.cameraX = W / 2 - 240 * SM.cameraScale;
              SM.cameraY = H / 2 - 190 * SM.cameraScale;
              SM.render();
              return 'ok';
            })()""" % (STORE, SM, json.dumps(KEY), json.dumps(DIAG)))
            _t.sleep(0.5)
            cdp.eval("(() => { const cv = document.querySelector('.scenario-map-container canvas');"
                     " window.__SHOT__ = cv ? cv.toDataURL('image/png') : ''; return 'ok'; })()")
            data_url = fetch_string(
                cdp,
                "window.__SHOT__ ? window.__SHOT__.length : -1",
                lambda i, j: "window.__SHOT__.slice(%d,%d)" % (i, j),
                chunk=262144, desc='河名沿河画布')
            if isinstance(data_url, str) and data_url.startswith('data:image'):
                out_dir = pathlib.Path(shot_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / 'river-name-along-path.png').write_bytes(
                    base64.b64decode(data_url.split(',', 1)[-1]))
        except Exception:
            pass

    return True, (f"斜河河名主轴斜率 {float(diag.get('slope')):.2f}（跨度 {diag.get('h')}px / {diag.get('n')} 像素）"
                  f" → 水平对照 {float(flat.get('slope')):.2f}（跨度 {flat.get('h')}px）；"
                  f"排布带折线 {diag.get('riverPlanPathLen')} 点；缺字/太弯有水平退回")
