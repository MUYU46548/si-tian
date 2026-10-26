#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 149：城镇名 / 河流名的导出分级（出版档）

背景（2026-10-25 文本标注第二刀）：
  真实底图 617 个城镇、160 条河，全标名字就是糊图。画布按缩放分级，
  导出是固定分辨率图，用**出版档**：只标首都 + 流量前 12 的河。
  如果画布与导出各写一套分级，就会出现「画布只标首都、导出标 617 个」——
  不会报错，只会让成品图没法用。

判据：
  1. 导出 SVG 含首都名、不含非首都城镇名（出版档 = capitalOnly）；
  2. 含流量最大的河名；无名河不出现；
  3. 城镇名贴着点、河流名贴着河道中点（**方位**由避让排布决定：右侧优先，放不下换左/上/下）；
  4. 源码守卫：ScenarioMap 与 useScenarioExport 都引用 `scenarioTextPlacement`。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例149底图'


def _read(rel):
    import io
    return io.open(os.path.join(os.path.dirname(__file__), '..', '..', '..', rel), encoding='utf-8').read()


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
      for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
      s.loadScenarioState({ groups: [] });
      if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
      s.addBaseMap(KEY, { name: KEY });
      s.addBaseProvince(KEY, { id: 'prov_a', name: '省A', kind: 'land',
        points: [{x:100,y:100},{x:700,y:100},{x:700,y:500},{x:100,y:500}] }, { checkOverlap: false });
      const bm = s.baseMaps[KEY];
      bm.burgs = [
        { id: 1, name: '首都甲', x: 260, y: 220, capital: 1, group: 'capital', population: 50 },
        { id: 2, name: '非首都乙', x: 420, y: 260, capital: 0, population: 99 },
        { id: 3, name: '首都丙', x: 560, y: 300, capital: 1, group: 'capital', population: 10 },
      ];
      bm.rivers = [
        { id: 'r1', name: '大河', points: [{x:150,y:350},{x:400,y:360},{x:650,y:350}], discharge: 900 },
        ...Array.from({ length: 11 }, (_, i) => ({
          id: 'rm' + i, name: '中河' + i,
          points: [{x:150,y:380 + i * 4},{x:650,y:380 + i * 4}], discharge: 500 - i,
        })),
        { id: 'r2', name: '小河', points: [{x:150,y:450},{x:650,y:450}], discharge: 10 },
        { id: 'r3', points: [{x:150,y:470},{x:650,y:470}], discharge: 9999 },
      ];
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { prov_a: 'P1' },
      });
      SM.baseMapKey = KEY;
      // 自动地名默认关闭（FMG 英文名）；本用例专测分级/导出，显式打开
      SM.showPlaceNames = true;
      await tick(40);
      SM.tlEra = 0;
      SM.tlDate = { y: 2000, m: null, d: null };
      await tick(40);
      return JSON.stringify({ ok: true });
    })()"""
    seed_src = seed.replace('__STORE__', STORE).replace('__SM__', SM).replace('__KEY__', json.dumps(KEY))
    ok, seed_out = eval_json(cdp, seed_src, required=('ok',), desc='f0 造城镇/河流')
    if not ok:
        return False, f'造数失败：{seed_out}'

    build = r"""(async () => {
      const SM = __SM__;
      const fn = SM.buildScenarioSVG || (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG);
      if (!fn) return JSON.stringify({ __err__: '没有 buildScenarioSVG' });
      const svg = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      // 关掉「自动地名」后再导一次：默认关闭时不应出现 FMG 英文名
      // 画布侧：同一套候选（避让排布）里必须真的有城镇/河/势力三类 —— 只测导出会漏掉画布接线。
      // ⚠️ 必须在**关掉自动地名之前**取：排布缓存按开关值失效，关掉之后自然只剩势力名。
      const plan = (typeof SM.getLabelPlan === 'function') ? SM.getLabelPlan() : [];
      const planKinds = plan.map((p) => p.kind);
      SM.showPlaceNames = false;
      const svgOff = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      const pick = (text) => {
        const re = new RegExp('<text\\b([^>]*)>' + text + '</text>');
        const m = svg.match(re); return m ? m[1] : null;
      };
      return JSON.stringify({
        svgLen: svg.length,
        capital1: pick('首都甲'),
        capital2: pick('首都丙'),
        nonCapital: pick('非首都乙'),
        bigRiver: pick('大河'),
        smallRiver: pick('小河'),
        hasNonCapital: svg.indexOf('>非首都乙<') >= 0,
        hasSmallRiver: svg.indexOf('>小河<') >= 0,
        offHasCapital: svgOff.indexOf('>首都甲<') >= 0,
        offHasRiver: svgOff.indexOf('>大河<') >= 0,
        planKinds,
        diag: {
          place: !!SM.showPlaceNames, burgs: !!SM.showBurgs,
          nBurgs: ((SM.baseMap && SM.baseMap.burgs) || []).length,
          nRivers: ((SM.baseMap && SM.baseMap.rivers) || []).length,
          scale: SM.cameraScale,
        },
      });
    })()"""
    ok, out = eval_json(cdp, build.replace('__SM__', SM), required=('svgLen',), desc='f1 构建导出 SVG')
    if not ok:
        return False, f'导出 SVG 失败：{out}'

    fails = []
    if not out.get('capital1') or not out.get('capital2'):
        fails.append('导出 SVG 缺首都名（出版档应含全部首都）')
    if out.get('hasNonCapital'):
        fails.append('导出 SVG 混进非首都城镇名（出版档应只标首都）')
    if not out.get('bigRiver'):
        fails.append('导出 SVG 缺流量最大的河名')
    if out.get('hasSmallRiver'):
        fails.append('导出 SVG 混进非前 12 的河名')
    if out.get('offHasCapital') or out.get('offHasRiver'):
        fails.append('关掉「自动地名」后导出仍有城镇/河流名（默认关闭没生效）')
    # 画布侧：避让排布的结论里要真的有城镇与势力名。
    # ⚠️ 不含 river：该缩放下 `riverLabelTier` 刻意返回 -1（低缩放不标河名），导出档才标。
    kinds = out.get('planKinds') or []
    for k in ('capital', 'polity'):
        if k not in kinds:
            fails.append(f'画布标签排布里没有 {k}（kinds={kinds}, diag={out.get("diag")}）')
    # 位置：城镇名贴着自己的点、河名贴着河道中点。
    # ⚠️ 2026-10-26 起落点由**避让排布**决定（右侧优先，放不下换左/上/下），
    #    不再是固定的 y+10 —— 所以判据从"精确坐标"改成"离锚点足够近"；
    #    精确落点/换位规则由 `scripts/tests/unit/test_label_layout.js` 覆盖。
    def _attrs(blob):
        import re as _re2
        return {k: float(v) for k, v in _re2.findall(r'([a-z-]+)="(-?[0-9.]+)"', blob or '')}
    if out.get('capital1'):
        a = _attrs(out['capital1'])
        if not (240 <= a.get('x', -1) <= 340) or abs(a.get('y', 0) - 220) > 24:
            fails.append(f'城镇名应贴在点附近（锚点 260,220）：{out.get("capital1")}')
    if out.get('bigRiver'):
        a = _attrs(out['bigRiver'])
        if abs(a.get('y', 0) - 355) > 24:
            fails.append(f'河流名应在河道中点附近（≈355）：{out.get("bigRiver")}')

    sm_src = _read('src/renderer/src/components/ScenarioMap.vue')
    ex_src = _read('src/renderer/src/composables/useScenarioExport.js')
    if 'scenarioTextPlacement' not in sm_src:
        fails.append('ScenarioMap 没有引用 scenarioTextPlacement（画布另写了一套分级）')
    if 'scenarioTextPlacement' not in ex_src:
        fails.append('useScenarioExport 没有引用 scenarioTextPlacement（导出一套）')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(out, ensure_ascii=False)[:600]

    # 可选：把画布存一张（SITIAN_SHOT_DIR），人眼看"避让后到底什么样"
    shot_dir = os.environ.get('SITIAN_SHOT_DIR')
    if shot_dir:
        import base64
        import pathlib
        from lib.cdp import fetch_string
        try:
            # 截图前把「自动地名」打开并重绘（上面为了测导出翻转，已经把它关掉了）
            cdp.eval("(() => { const SM = %s; SM.showPlaceNames = true;"
                     " if (SM.render) SM.render(); return 'ok'; })()" % SM)
            import time as _t
            _t.sleep(0.4)
            cdp.eval("(() => { const cv = document.querySelector('.scenario-map-container canvas');"
                     " window.__SHOT__ = cv ? cv.toDataURL('image/png') : ''; return 'ok'; })()")
            data_url = fetch_string(
                cdp,
                "window.__SHOT__ ? window.__SHOT__.length : -1",
                lambda i, j: "window.__SHOT__.slice(%d,%d)" % (i, j),
                chunk=262144, desc='标签画布截图')
            if isinstance(data_url, str) and data_url.startswith('data:image'):
                out_dir = pathlib.Path(shot_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / 'labels-canvas.png').write_bytes(
                    base64.b64decode(data_url.split(',', 1)[-1]))
        except Exception:
            pass

    return True, (
        f'SVG {out.get("svgLen")}B：首都甲/首都丙在、非首都乙不在；大河在、小河不在；'
        f'城镇名贴点旁、河名贴河道（方位由避让排布决定）；'
        f'画布排布含 {out.get("planKinds")}；画布/导出共用 scenarioTextPlacement'
    )
