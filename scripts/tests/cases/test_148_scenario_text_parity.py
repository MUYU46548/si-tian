#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 148：剧本文字层（地名 / 标记名）画布与导出同源

背景（2026-10-25 文本标注专项第一刀）：
  省名/势力名已经走 `polityLabels` 的 `PROVINCE/POLITY_LABEL_STYLE`，但**用户地名**与**标记名**
  仍是两套：
    · 画布：地名默认浅色、描边可选；标记名用标记颜色、无描边；
    · 导出：地名默认 `#3c4150` 深灰、无描边；标记名写死 `#e2e8f0`、位置在标记上方。
  同一个地名在画布和导出图上是两种颜色/两个位置，而且不报错。

本用例判据（SVG 内容 + 源码守卫）：
  1. 默认地名：`fill=#e2e8f0`、`stroke=#1B2130`、`paint-order=stroke`、锚点 start（与画布左上角锚点一致）；
  2. 自定义地名（color/size/stroke/strokeWidth）原样进 SVG；
  3. 标记名：颜色用标记自身颜色、锚点 middle、位置在标记下方（y+9）；
  4. 源码守卫：`ScenarioMap` 与 `useScenarioExport` 都引用 `mapTextStyles`，不允许再各写一套默认色。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例148底图'


def _read(rel):
    import io
    return io.open(os.path.join(os.path.dirname(__file__), '..', '..', '..', rel), encoding='utf-8').read()


def run(cdp):
    wait_for(cdp, "!!document.querySelector('#app')", desc='应用挂载', timeout=15)
    ensure_data_ready(cdp)

    # 进历史剧本 + 自带底图（复用现有 helpers 的入口）
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click(); return 'ok';
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
        points: [{x:100,y:100},{x:600,y:100},{x:600,y:400},{x:100,y:400}] }, { checkOverlap: false });
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { prov_a: 'P1' },
        labels: [
          { text: '默认地名', x: 240, y: 220 },
          { text: '自定义地名', x: 300, y: 260, color: '#ffcc00', size: 16, stroke: '#000000', strokeWidth: 4 },
        ],
        markers: [
          { name: '红色标记', x: 420, y: 240, color: '#c23b3b', type: 'city' },
        ],
      });
      SM.baseMapKey = KEY;
      await tick(40);
      SM.tlEra = 0;
      SM.tlDate = { y: 2000, m: null, d: null };
      await tick(40);
      return JSON.stringify({ ok: true });
    })()"""
    seed_src = seed.replace('__STORE__', STORE).replace('__SM__', SM).replace('__KEY__', json.dumps(KEY))
    ok, seed_out = eval_json(cdp, seed_src, required=('ok',), desc='f0 造地名/标记')
    if not ok:
        return False, f'造数失败：{seed_out}'

    build = r"""(async () => {
      const SM = __SM__;
      const fn = SM.buildScenarioSVG || (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG);
      if (!fn) return JSON.stringify({ __err__: '没有 buildScenarioSVG' });
      const svg = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      const pick = (text) => {
        const re = new RegExp('<text\\b([^>]*)>' + text + '</text>');
        const m = svg.match(re);
        return m ? m[1] : null;
      };
      return JSON.stringify({
        svgLen: svg.length,
        defLabel: pick('默认地名'),
        customLabel: pick('自定义地名'),
        marker: pick('红色标记'),
        hasMarkerDot: svg.indexOf('<circle') >= 0,
      });
    })()"""
    ok, out = eval_json(cdp, build.replace('__SM__', SM), required=('svgLen',), desc='f1 构建导出 SVG')
    if not ok:
        return False, f'导出 SVG 失败：{out}'

    fails = []
    def_attrs = out.get('defLabel')
    if not def_attrs:
        fails.append('SVG 里找不到默认地名')
    else:
        for frag, what in (
            ('fill="#e2e8f0"', '默认地名 fill 应为浅色 #e2e8f0（与画布一致）'),
            ('stroke="#1B2130"', '默认地名应有深色描边'),
            ('paint-order="stroke"', '描边应先于填字'),
            ('text-anchor="start"', '地名锚点应为 start（与画布左上角一致）'),
        ):
            if frag not in def_attrs:
                fails.append(what)

    cust = out.get('customLabel')
    if not cust:
        fails.append('SVG 里找不到自定义地名')
    else:
        for frag, what in (
            ('fill="#ffcc00"', '自定义地名颜色丢失'),
            ('font-size="16"', '自定义地名字号丢失'),
            ('stroke="#000000"', '自定义地名描边色丢失'),
            ('stroke-width="4"', '自定义地名描边宽丢失'),
        ):
            if frag not in cust:
                fails.append(what)

    mk = out.get('marker')
    if not mk:
        fails.append('SVG 里找不到标记名')
    else:
        for frag, what in (
            ('fill="#c23b3b"', '标记名颜色应跟标记自身颜色（画布语义）'),
            ('text-anchor="middle"', '标记名应居中'),
            ('y="249"', '标记名应在标记下方（y+9）'),
        ):
            if frag not in mk:
                fails.append(what)
    if not out.get('hasMarkerDot'):
        fails.append('SVG 里没有标记点（circle）')

    # 源码守卫：两层都必须走 mapTextStyles
    sm_src = _read('src/renderer/src/components/ScenarioMap.vue')
    ex_src = _read('src/renderer/src/composables/useScenarioExport.js')
    if 'mapTextStyles' not in sm_src:
        fails.append('ScenarioMap 没有引用 mapTextStyles（画布又写了一套）')
    if 'svgTextAttrsFromStyle' not in ex_src:
        fails.append('useScenarioExport 没有用共享的 svgTextAttrsFromStyle')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps({
            'def': def_attrs, 'custom': cust, 'marker': mk,
        }, ensure_ascii=False)[:600]
    return True, (
        f'SVG {out.get("svgLen")}B：默认地名（浅字+描边+start 锚点）、'
        f'自定义地名（color/size/stroke 全保留）、标记名（自身色+居中+下方）全对；'
        f'画布/导出共用 mapTextStyles'
    )
