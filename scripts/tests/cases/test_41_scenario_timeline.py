#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 41：历史剧本时间轴（P1）

覆盖真实 CDP 链路：
  1. 合成 3 剧本数据集 → 验证谱系匹配 + 逐省变化年份（纯函数经组件 computed 落到 DOM）
  2. 时间轴组件挂载：轨道块 / 游标 / 控制条均在位
  3. 拖动游标（真实 PointerEvent）→ 年份跟随
  4. 点时代块 → 跳剧本 + 同步选中态
  5. 键盘 ←/→ 跳剧本、Shift+←/→ 逐年
  6. 播放 → 游标自动前进；再点暂停
  7. 轴向切换：按年比例 16 块（含断层块）/ 等宽 3 块

预期谱系变化（由「省份集合重叠度贪心继承」推得，见下方数据集设计）：
  eraChg = [[], ['prov_b'], ['prov_c']]
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import ensure_data_ready


def _sm(cdp):
    return "document.querySelector('.scenario-map-container')?.__vueParentComponent?.setupState"


def _enter_scenario_mode(cdp):
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if r != 'ok':
        return r
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    return 'ok'


def _seed(cdp):
    """注入 3 个省 + 3 个剧本的确定性数据集（mock saveScenarios 不落盘）"""
    return cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      // 清空剧本（保留底图），保证从干净状态推谱系
      for (const k of Object.keys(s.scenarios)) s.removeScenario(k);

      const mk = (id, x0, y0) => ({
        id, name: '省' + id.slice(-1).toUpperCase(),
        points: [{x:x0,y:y0},{x:x0+120,y:y0},{x:x0+120,y:y0+120},{x:x0,y:y0+120}],
        biome: 'temperate', coast: true,
      });
      if (!s.baseMaps['德斯特星']) s.addBaseMap('德斯特星', { name: '德斯特星' });
      const bm = s.baseMaps['德斯特星'];
      bm.terrain.length = 0;
      ['prov_a','prov_b','prov_c'].forEach((id, i) => {
        s.addBaseProvince('德斯特星', mk(id, 200 + i * 160, 200));
      });

      const P = (id, name, color) => ({ id, name, color });
      s.createScenario('德斯特星/甲时代', {
        ownerKey: '德斯特星', name: '甲时代', order: 1,
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [P('A1','甲国','#c23b3b')],
        ownership: { prov_a:'A1', prov_b:'A1', prov_c:'A1' },
      });
      s.createScenario('德斯特星/乙时代', {
        ownerKey: '德斯特星', name: '乙时代', order: 2,
        era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
        polities: [P('B1','乙国','#4a90d9'), P('B2','乙南','#e6a23c')],
        ownership: { prov_a:'B1', prov_b:'B2', prov_c:'B1' },
      });
      s.createScenario('德斯特星/丙时代', {
        ownerKey: '德斯特星', name: '丙时代', order: 3,
        era: { roman: 'Ⅲ', label: '丙', startYear: '2020', endYear: '2030' },
        polities: [P('C1','丙国','#5b8c5a'), P('C2','丙南','#8e44ad'), P('C3','丙西','#d4a857')],
        ownership: { prov_a:'C1', prov_b:'C2', prov_c:'C3' },
      });
      return JSON.stringify({
        provCount: s.baseMaps['德斯特星'].terrain.length,
        scCount: Object.keys(s.scenarios).length,
      });
    })()""")


def run(cdp):
    ensure_data_ready(cdp)
    r = _enter_scenario_mode(cdp)
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'

    seed = json.loads(_seed(cdp))
    if seed['provCount'] != 3 or seed['scCount'] != 3:
        return False, f'数据注入失败: {seed}'
    time.sleep(0.4)   # 等 computed 重算 + 组件渲染

    # ---------- 1. 谱系匹配 + 变化年份 ----------
    tl = cdp.eval(f"""(() => {{
      const s = {_sm(cdp)};
      const t = s.timeline;
      return JSON.stringify({{
        eraChg: t.eraChg.map(e => e.changed),
        years: t.years.map(y => [y.start, y.end]),
        minYear: t.minYear, maxYear: t.maxYear,
        lineages: t.lineages.length,
        stats: t.stats,
      }});
    }})()""")
    tl = json.loads(tl)
    expect = [[], ['prov_b'], ['prov_c']]
    if tl['eraChg'] != expect:
        return False, f'谱系匹配结果不符: 期望 {expect}，实得 {tl["eraChg"]}'
    if tl['years'] != [[2000, 2010], [2010, 2020], [2020, 2030]]:
        return False, f'年代区间解析错误（字符串年份必须 Number 化）: {tl["years"]}'
    if tl['minYear'] != 2000 or tl['maxYear'] != 2030:
        return False, f'年代范围错误: {tl["minYear"]}~{tl["maxYear"]}'

    # ---------- 2. 组件在位 ----------
    dom = json.loads(cdp.eval("""(() => {
      const root = document.querySelector('[data-testid="scenario-timeline"]');
      if (!root) return JSON.stringify({mounted:false});
      const st = root.__vueParentComponent?.setupState;
      return JSON.stringify({
        mounted: true,
        blocks: root.querySelectorAll('.tl-block').length,
        gapBlocks: root.querySelectorAll('.tl-block.is-gap').length,
        playhead: !!root.querySelector('[data-testid="tl-playhead"]'),
        controls: ['tl-play','tl-prev','tl-next','tl-axis-year','tl-axis-equal',
                   'tl-diff-eu4','tl-diff-outline','tl-diff-off','tl-lineage']
                  .filter(t => root.querySelector(`[data-testid="${t}"]`)).length,
      });
    })()"""))
    if not dom['mounted']:
        return False, '时间轴组件未挂载'
    if dom['blocks'] != 3:
        return False, f'轨道块数错误（应为 3 个剧本）: {dom["blocks"]}'
    if not dom['playhead'] or dom['controls'] != 9:
        return False, f'轨道/控制条元素缺失: {dom}'

    # ---------- 3. 拖动游标 ----------
    drag = json.loads(cdp.eval("""(() => {
      const root = document.querySelector('[data-testid="scenario-timeline"]');
      const wrap = root.querySelector('.tl-railwrap');
      const rail = root.querySelector('.tl-rail');
      const r = rail.getBoundingClientRect();
      const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      const mk = (t, x) => new PointerEvent(t, {clientX:x, clientY:r.top+r.height/2,
                                                bubbles:true, pointerId:1});
      const before = Math.round(sm.tlYear);
      wrap.dispatchEvent(mk('pointerdown', r.left + r.width*0.1));
      const at10 = Math.round(sm.tlYear);
      wrap.dispatchEvent(mk('pointermove', r.left + r.width*0.5));
      const at50 = Math.round(sm.tlYear);
      wrap.dispatchEvent(mk('pointerup', r.left + r.width*0.5));
      return JSON.stringify({before, at10, at50});
    })()"""))
    # 按年比例轴：u=0.1 → 2000+3=2003；u=0.5 → 2015
    if not (drag['at10'] < drag['at50']):
        return False, f'拖动游标年份未单调变化: {drag}'
    if abs(drag['at10'] - 2003) > 1 or abs(drag['at50'] - 2015) > 1:
        return False, f'按年比例轴映射不准: {drag}（期望 2003 / 2015）'

    # ---------- 4. 点时代块跳剧本 ----------
    jump = json.loads(cdp.eval("""(() => {
      const s = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      const blk = document.querySelector('[data-testid="tl-era-2"]');
      if (!blk) return JSON.stringify({err:'no-block'});
      blk.click();
      return JSON.stringify({era: s.tlEra, year: Math.round(s.tlYear),
                             selected: s.selectedScenario?.name});
    })()"""))
    if jump.get('era') != 2 or jump.get('year') != 2020:
        return False, f'点时代块未跳转: {jump}'
    if jump.get('selected') != '丙时代':
        return False, f'点时代块未同步选中剧本: {jump}'

    # ---------- 5. 键盘（连续真实按键序列；不在中途强设 state，避开 prop 传播时序） ----------
    kb = json.loads(cdp.eval("""(async () => {
      const s = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      const wait = () => new Promise(r => setTimeout(r, 90));
      const snap = () => ({era: s.tlEra, year: Math.round(s.tlYear)});
      const fire = (key, shift) => window.dispatchEvent(
        new KeyboardEvent('keydown', {key, shiftKey: !!shift, bubbles: true}));

      fire('Home');  await wait(); const home = snap();
      fire('ArrowRight'); await wait(); const r1 = snap();
      fire('ArrowRight'); await wait(); const r2 = snap();
      fire('ArrowRight'); await wait(); const r3overrun = snap();   // 末剧本边界不应越界
      fire('ArrowLeft');  await wait(); const l1 = snap();
      fire('ArrowRight', true); await wait(); const shiftUp = snap(); // 逐年微调
      fire('ArrowLeft', true);  await wait(); const shiftDown = snap();
      fire('End'); await wait(); const end = snap();
      return JSON.stringify({home, r1, r2, r3overrun, l1, shiftUp, shiftDown, end});
    })()"""))
    want = {
        'home': {'era': 0, 'year': 2000},
        'r1': {'era': 1, 'year': 2010},
        'r2': {'era': 2, 'year': 2020},
        'r3overrun': {'era': 2, 'year': 2020},
        'l1': {'era': 1, 'year': 2010},
        'shiftUp': {'era': 1, 'year': 2011},
        'shiftDown': {'era': 1, 'year': 2010},
        'end': {'era': 2, 'year': 2020},
    }
    for k, exp in want.items():
        if kb.get(k) != exp:
            return False, f'键盘 {k} 不符：期望 {exp}，实得 {kb.get(k)}（全部={kb}）'

    # ---------- 6. 播放 ----------
    played = json.loads(cdp.eval("""(async () => {
      const s = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      s.tlEra = 0; s.tlYear = 2000; s.tlPlaying = false;
      await new Promise(r => setTimeout(r, 60));
      const btn = document.querySelector('[data-testid="tl-play"]');
      const labelBefore = btn.textContent.trim();
      btn.click();
      const playingNow = s.tlPlaying;
      await new Promise(r => setTimeout(r, 700));
      const midYear = Math.round(s.tlYear);
      btn.click();
      const stopped = s.tlPlaying;
      return JSON.stringify({labelBefore, playingNow, midYear, stopped});
    })()"""))
    if not played['playingNow'] or played['stopped']:
        return False, f'播放按钮未切换 tlPlaying: {played}'
    if played['midYear'] <= 2000:
        return False, f'播放中游标未前进: {played}'

    # ---------- 7. 轴向切换 ----------
    axes = json.loads(cdp.eval("""(() => {
      const s = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      const root = document.querySelector('[data-testid="scenario-timeline"]');
      document.querySelector('[data-testid="tl-axis-equal"]').click();
      const eq = {mode: s.tlAxisMode, blocks: root.querySelectorAll('.tl-block').length};
      document.querySelector('[data-testid="tl-axis-year"]').click();
      const yr = {mode: s.tlAxisMode, blocks: root.querySelectorAll('.tl-block').length,
                  gaps: root.querySelectorAll('.tl-block.is-gap').length};
      return JSON.stringify({eq, yr});
    })()"""))
    if axes['eq']['mode'] != 'equal' or axes['eq']['blocks'] != 3:
        return False, f'等宽轴错误: {axes}'
    if axes['yr']['mode'] != 'year' or axes['yr']['blocks'] != 3 or axes['yr']['gaps'] != 0:
        return False, f'按年比例轴错误: {axes}'

    return True, (f'谱系匹配{json.dumps(tl["eraChg"], ensure_ascii=False)} → 组件{dom["blocks"]}块'
                  f' → 拖动{drag["at10"]}/{drag["at50"]} → 点块跳丙时代 → 键盘四键全通'
                  f' → 播放前进至{played["midYear"]} → 双向轴向切换')
