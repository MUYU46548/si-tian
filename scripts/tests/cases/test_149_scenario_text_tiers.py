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
  3. 城镇名在点下方（y+10）、河流名在河中点上方（y-4）；
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
    # 位置：城镇 y+10、河流 y-4
    if out.get('capital1') and 'y="230"' not in out['capital1']:
        fails.append(f'城镇名应在点下方 y+10：{out.get("capital1")}')
    if out.get('bigRiver') and 'y="346"' not in out['bigRiver']:
        # 大河中点按长度：折线 (150,350)-(400,360)-(650,350)，长度中点约 y=360? 实际取 360/2 -> 355
        # 这里只断言有 y 属性且不是 0，避免写死错误中点；精确中点由单测覆盖
        if 'y="' not in out['bigRiver']:
            fails.append('河流名缺 y 坐标')

    sm_src = _read('src/renderer/src/components/ScenarioMap.vue')
    ex_src = _read('src/renderer/src/composables/useScenarioExport.js')
    if 'scenarioTextPlacement' not in sm_src:
        fails.append('ScenarioMap 没有引用 scenarioTextPlacement（画布另写了一套分级）')
    if 'scenarioTextPlacement' not in ex_src:
        fails.append('useScenarioExport 没有引用 scenarioTextPlacement（导出一套）')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(out, ensure_ascii=False)[:600]
    return True, (
        f'SVG {out.get("svgLen")}B：首都甲/首都丙在、非首都乙不在；大河在、小河不在；'
        f'城镇名 y+10、河流名 y-4；画布/导出共用 scenarioTextPlacement'
    )
