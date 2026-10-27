#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 158：地形注记进导出（SVG）—— 与画布同一份数据/样式/几何

背景（D3 收口，2026-10-27）：
  画布上已经有山系名（沿脊线）、海域名（疏排）、平原名（落点横排），但 **SVG/PNG 导出
  不带它们** —— 用户导出的成品地形图是一张"只有省名/势力名"的政治图。
  导出与画布之间的距离，正是本项目反复吃亏的那类：不报错，只是"导出少了一层"。

判据：
  1. 导出 SVG 里三类注记都在：
     · 山系/海域是**逐字 `<text>` + `transform="rotate(...)"`**（SVG 没有沿路径文字，
       与画布逐字 rotate 同一口径）；
     · 平原是**一个完整 `<text>`**（不带 rotate）；
  2. 反向对照：把画布的「地形名称」开关关掉再导 → 这些字一个都不出现、rotate 归零
     （证明判据不是恒真）；
  3. 顺序/样式单源：导出侧的地形样式取自 `mapTextStyles.terrainLabelTextStyle`
     （ScenarioMap 里不再有第二份常量），沿路径几何取自 `utils/textOnPath`。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例158底图'

LABELS = [
    {'id': 'tl_range', 'kind': 'range', 'name': '测试山脉',
     'points': [{'x': 120, 'y': 120}, {'x': 200, 'y': 180}, {'x': 280, 'y': 240}, {'x': 360, 'y': 300}],
     'origin': 'user'},
    {'id': 'tl_sea', 'kind': 'sea', 'name': '测试海',
     'points': [{'x': 120, 'y': 400}, {'x': 260, 'y': 420}, {'x': 400, 'y': 400}],
     'origin': 'user'},
    {'id': 'tl_plain', 'kind': 'plain', 'name': '测试平原',
     'points': [{'x': 240, 'y': 500}], 'origin': 'user'},
]


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
      if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
      s.addBaseMap(KEY, { name: KEY });
      s.addBaseProvince(KEY, { id: 'p158', name: '省158', kind: 'land',
        points: [{x:80,y:80},{x:480,y:80},{x:480,y:560},{x:80,y:560}] }, { checkOverlap: false });
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { p158: 'P1' },
      });
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0; SM.tlDate = { y: 2000, m: null, d: null };
      SM.showTerrainNames = true;
      await tick(80);
      const res = s.applyTerrainLabels(KEY, __LABELS__);
      await tick(120);
      const labels = (s.baseMaps[KEY] || {}).terrainLabels || [];
      return JSON.stringify({ ok: !!(res && res.ok), count: labels.length, kinds: labels.map(l => l.kind) });
    })()"""
    ok, seeded = eval_json(cdp, seed.replace('__STORE__', STORE).replace('__SM__', SM)
                           .replace('__KEY__', json.dumps(KEY))
                           .replace('__LABELS__', json.dumps(LABELS, ensure_ascii=False)),
                           required=('count',), desc='造三类地形注记')
    if not ok or int(seeded.get('count') or 0) != 3:
        return False, f'造数失败：{seeded}'

    build = r"""(async () => {
      const SM = __SM__;
      const fn = SM.buildScenarioSVG || (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG);
      if (!fn) return JSON.stringify({ __err__: '没有 buildScenarioSVG' });
      const on = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      SM.showTerrainNames = false;
      const off = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      SM.showTerrainNames = true;
      const chars = (svg) => ['测', '试', '山', '脉', '海'].map((c) => (svg.split('>' + c + '<').length - 1));
      const rotateCount = (svg) => (svg.split('transform="rotate(').length - 1);
      const plainOn = on.indexOf('>测试平原<') >= 0;
      const plainOff = off.indexOf('测试平原') >= 0;
      const rangeCharsOn = on.split('>山<').length - 1;
      const rangeCharsOff = off.split('>山<').length - 1;
      return JSON.stringify({
        onLen: on.length, offLen: off.length,
        onChars: chars(on), offChars: chars(off),
        onRotate: rotateCount(on), offRotate: rotateCount(off),
        plainOn, plainOff, rangeCharsOn, rangeCharsOff,
        // 平原那个 <text> 的 y（应≈500，且不带 rotate）
        plainTag: (on.match(/<text[^>]*>测试平原<\/text>/) || [''])[0],
        sampleRotated: (on.match(/<text[^>]*transform="rotate\([^)]*\)"[^>]*>山<\/text>/) || [''])[0],
      });
    })()"""
    ok, out = eval_json(cdp, build.replace('__SM__', SM), required=('onLen',), desc='导出 SVG（开/关地形名称各一次）')
    if not ok:
        return False, f'导出失败：{out}'

    fails = []
    # ① 三类都在（山系/海域逐字、平原整名）
    on_chars = out.get('onChars') or []
    if len(on_chars) != 5 or any(int(n) < 1 for n in on_chars):
        fails.append(f'导出缺地形注记的字（测/试/山/脉/海 逐字计数={on_chars}）：{out.get("onLen")}B')
    if not out.get('plainOn'):
        fails.append('导出缺平原名（应是一个完整 <text>测试平原</text>）')
    # ② rotate 只由山系(4) + 海域(3) 产生（=7）；平原不带 rotate
    if int(out.get('onRotate') or 0) < 7:
        fails.append(f'沿路径的字没有 rotate（实际 {out.get("onRotate")} 处）—— 山系/海域被导成横排')
    if out.get('plainTag') and 'rotate(' in out.get('plainTag'):
        fails.append(f'平原名不该跟着 rotate：{out.get("plainTag")}')
    if not out.get('sampleRotated'):
        fails.append('找不到带 rotate 的逐字 <text>（沿路径排字没落到 SVG 上）')
    # ③ 反向对照：关掉开关 → 一个字都不出现、rotate 归零
    off_chars = out.get('offChars') or []
    if any(int(n) > 0 for n in off_chars):
        fails.append(f'关掉「地形名称」后导出仍有地形注记（逐字计数={off_chars}）')
    if int(out.get('offRotate') or 0) != 0:
        fails.append(f'关掉「地形名称」后仍有 rotate 文字（{out.get("offRotate")} 处）')
    if out.get('plainOff'):
        fails.append('关掉「地形名称」后导出仍有平原名')

    # ④ 单源闸门：样式只在 mapTextStyles 一份、几何只在 textOnPath 一份
    ex_src = _read('src/renderer/src/composables/useScenarioExport.js')
    sm_src = _read('src/renderer/src/components/ScenarioMap.vue')
    if 'terrainLabelTextStyle' not in ex_src:
        fails.append('导出的地形样式没走 mapTextStyles.terrainLabelTextStyle（另写了一份）')
    if 'layoutTextAlongPath' not in ex_src:
        fails.append('导出没复用 textOnPath.layoutTextAlongPath（沿路径几何另写一份）')
    if 'TERRAIN_RANGE_STYLE' in sm_src:
        fails.append('ScenarioMap 里还留着旧的 TERRAIN_RANGE_STYLE（样式会有两份）')
    if 'terrainLabelTextStyle' not in sm_src:
        fails.append('画布没走 terrainLabelTextStyle（与导出不同源）')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(out, ensure_ascii=False)[:600]

    # 可选：把这份导出 SVG 落到盘上（人眼/浏览器直接打开就能看地形注记的观感）
    shot_dir = os.environ.get('SITIAN_SHOT_DIR')
    if shot_dir:
        import pathlib
        try:
            svg_text = cdp.eval("""(() => {
              const SM = __SM__;
              const fn = SM.buildScenarioSVG || (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG);
              return String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
            })()""".replace('__SM__', SM))
            if isinstance(svg_text, str) and '<svg' in svg_text:
                out_dir = pathlib.Path(shot_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / 'terrain-labels-export.svg').write_text(svg_text, encoding='utf-8')
            else:
                print(f'  ⚠️ 导出 SVG 落盘跳过：{type(svg_text).__name__} {str(svg_text)[:120]}')
        except Exception as e:
            print(f'  ⚠️ 导出 SVG 落盘失败：{e}')

    return True, (f"SVG {out.get('onLen')}B：山系/海域逐字 rotate {out.get('onRotate')} 处、平原整名 1 个；"
                  f"关掉地形名称后逐字计数 {out.get('offChars')} / rotate {out.get('offRotate')} "
                  f"→ 样式与沿路径几何都只有一份（mapTextStyles / textOnPath）")
