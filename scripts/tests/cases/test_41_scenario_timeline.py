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
from lib.cdp import wait_for, eval_json
from lib.helpers import ensure_data_ready, open_test_base_map


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


def _seed_js(cdp):
    """注入 3 个省 + 3 个剧本的确定性数据集（mock saveScenarios 不落盘）—— 返回 JS 源"""
    return """(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      // 清空剧本（保留底图），保证从干净状态推谱系
      for (const k of Object.keys(s.scenarios)) s.removeScenario(k);

      const mk = (id, x0, y0) => ({
        id, name: '省' + id.slice(-1).toUpperCase(),
        points: [{x:x0,y:y0},{x:x0+120,y:y0},{x:x0+120,y:y0+120},{x:x0,y:y0+120}],
        biome: 'temperate', coast: true,
      });
      if (!s.baseMaps['云陇大陆']) s.addBaseMap('云陇大陆', { name: '云陇大陆' });
      const bm = s.baseMaps['云陇大陆'];
      bm.terrain.length = 0;
      ['prov_a','prov_b','prov_c'].forEach((id, i) => {
        s.addBaseProvince('云陇大陆', mk(id, 200 + i * 160, 200));
      });

      const P = (id, name, color) => ({ id, name, color });
      s.createScenario('云陇大陆/甲时代', {
        ownerKey: '云陇大陆', name: '甲时代', order: 1,
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [P('A1','甲国','#c23b3b')],
        ownership: { prov_a:'A1', prov_b:'A1', prov_c:'A1' },
      });
      s.createScenario('云陇大陆/乙时代', {
        ownerKey: '云陇大陆', name: '乙时代', order: 2,
        era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
        polities: [P('B1','乙国','#4a90d9'), P('B2','乙南','#e6a23c')],
        ownership: { prov_a:'B1', prov_b:'B2', prov_c:'B1' },
      });
      s.createScenario('云陇大陆/丙时代', {
        ownerKey: '云陇大陆', name: '丙时代', order: 3,
        era: { roman: 'Ⅲ', label: '丙', startYear: '2020', endYear: '2030' },
        polities: [P('C1','丙国','#5b8c5a'), P('C2','丙南','#8e44ad'), P('C3','丙西','#d4a857')],
        ownership: { prov_a:'C1', prov_b:'C2', prov_c:'C3' },
      });
      return JSON.stringify({
        provCount: s.baseMaps['云陇大陆'].terrain.length,
        scCount: Object.keys(s.scenarios).length,
      });
    })()"""


def run(cdp):
    ensure_data_ready(cdp)
    r = _enter_scenario_mode(cdp)
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    # 底图 fixture：司天不再默认建/选示例底图（见 helpers.open_test_base_map 说明）
    bm_ok, bm_info = open_test_base_map(cdp, '云陇大陆')
    if not bm_ok:
        return False, f'底图 fixture 未就位: {bm_info}'

    # ⚠️ 这个探针返回的是 {provCount, scCount} 而**不是** {fails} —— 必须显式声明 required，
    #    否则 eval_json 会按默认的 ('fails',) 判「缺字段」而把一次**成功**的造数报成失败
    #    （文案还写成「疑似异常被当成通过」，方向正好相反）。
    seed_ok, seed = eval_json(cdp, _seed_js(cdp), required=('provCount', 'scCount'),
                              desc='注入 3 省 + 3 剧本')
    if not seed_ok:
        return False, f'数据注入探针失败: {seed}'
    if seed['provCount'] != 3 or seed['scCount'] != 3:
        return False, f'数据注入失败: {seed}'
    time.sleep(0.4)   # 等 computed 重算 + 组件渲染

    # ---------- 1. 谱系匹配 + 变化年份 ----------
    tl_ok, tl = eval_json(cdp, f"""(() => {{
      const s = {_sm(cdp)};
      const t = s.timeline;
      return JSON.stringify({{
        eraChg: t.eraChg.map(e => e.changed),
        years: t.years.map(y => [y.start, y.end]),
        minYear: t.minYear, maxYear: t.maxYear,
        lineages: t.lineages.length,
        stats: t.stats,
      }});
    }})()""", required=('eraChg', 'years', 'minYear', 'maxYear', 'lineages', 'stats'),
        desc='时间轴模型')
    if not tl_ok:
        return False, f'时间轴模型探针失败: {tl}'
    expect = [[], ['prov_b'], ['prov_c']]
    if tl['eraChg'] != expect:
        return False, f'谱系匹配结果不符: 期望 {expect}，实得 {tl["eraChg"]}'
    if tl['years'] != [[2000, 2010], [2010, 2020], [2020, 2030]]:
        return False, f'年代区间解析错误（字符串年份必须 Number 化）: {tl["years"]}'
    if tl['minYear'] != 2000 or tl['maxYear'] != 2030:
        return False, f'年代范围错误: {tl["minYear"]}~{tl["maxYear"]}'

    # ---------- 2. 组件在位 ----------
    dom_ok, dom = eval_json(cdp, """(() => {
      const root = document.querySelector('[data-testid="scenario-timeline"]');
      if (!root) return JSON.stringify({mounted:false});
      const st = root.__vueParentComponent?.setupState;
      return JSON.stringify({
        mounted: true,
        blocks: root.querySelectorAll('.tl-block').length,
        gapBlocks: root.querySelectorAll('.tl-block.is-gap').length,
        playhead: !!root.querySelector('[data-testid="tl-playhead"]'),
        controls: ['tl-play','tl-prev','tl-next','tl-axis-year','tl-axis-equal',
                   'tl-diff-eu4','tl-diff-outline','tl-diff-off','tl-lineage',
                   // 月日精度新增：把当前日期存为切片点（切片导出默认必出的帧来源）
                   'tl-save-slice-point']
                  .filter(t => root.querySelector(`[data-testid="${t}"]`)).length,
      });
    })()""", required=('mounted',), desc='时间轴组件 DOM')
    if not dom_ok:
        return False, f'时间轴 DOM 探针失败: {dom}'
    if not dom['mounted']:
        return False, '时间轴组件未挂载'
    if dom.get('blocks') != 3:
        return False, f'轨道块数错误（应为 3 个剧本）: {dom.get("blocks")}'
    if not dom.get('playhead') or dom.get('controls') != 10:
        return False, f'轨道/控制条元素缺失: {dom}'

    # ---------- 3. 拖动游标 ----------
    # ⚠️ 月日精度（2026-10-05）：游标真源是 `tlDate`（`{y,m,d}` ref），`tlYear` 已降为**只读 computed**
    #    （`dateToYearValue(tlDate)`）。所以这里读年份、同时把 tlDate 带回来断言「月日归 null」——
    #    轨道表达的是「到某一年」，保留旧月日会让「拖到 2003 年」实际停在 2003-06-01（用户看不见却影响归属判定）。
    drag_ok, drag = eval_json(cdp, """(() => {
      const root = document.querySelector('[data-testid="scenario-timeline"]');
      const wrap = root.querySelector('.tl-railwrap');
      const rail = root.querySelector('.tl-rail');
      const r = rail.getBoundingClientRect();
      const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      const mk = (t, x) => new PointerEvent(t, {clientX:x, clientY:r.top+r.height/2,
                                                bubbles:true, pointerId:1});
      const snapDate = () => ({y: sm.tlDate.y, m: sm.tlDate.m, d: sm.tlDate.d});
      const before = Math.round(sm.tlYear);
      wrap.dispatchEvent(mk('pointerdown', r.left + r.width*0.1));
      const at10 = Math.round(sm.tlYear); const d10 = snapDate();
      wrap.dispatchEvent(mk('pointermove', r.left + r.width*0.5));
      const at50 = Math.round(sm.tlYear); const d50 = snapDate();
      wrap.dispatchEvent(mk('pointerup', r.left + r.width*0.5));
      return JSON.stringify({before, at10, at50, d10, d50});
    })()""", required=('before', 'at10', 'at50', 'd10', 'd50'), desc='拖动游标')
    if not drag_ok:
        return False, f'拖动游标探针失败: {drag}'
    # 按年比例轴：u=0.1 → 2000+3=2003；u=0.5 → 2015
    if not (drag['at10'] < drag['at50']):
        return False, f'拖动游标年份未单调变化: {drag}'
    if abs(drag['at10'] - 2003) > 1 or abs(drag['at50'] - 2015) > 1:
        return False, f'按年比例轴映射不准: {drag}（期望 2003 / 2015）'
    for key, year_key in (('d10', 'at10'), ('d50', 'at50')):
        want_date = {'y': drag[year_key], 'm': None, 'd': None}
        if drag[key] != want_date:
            return False, f'轨道拖动后 tlDate 应为 {want_date}（月日归 null），实得 {drag[key]}'
    # 状态栏日期文本（`tl-status` 里的 `tl-date`）：只到年时**只显示年**（显示成 2015-01-01
    # 会把「只录到年」谎报成精确日期）
    dt_ok, dt = eval_json(cdp, """(() => {
      const el = document.querySelector('[data-testid="tl-date"]');
      return JSON.stringify({text: el ? el.textContent.trim() : ''});
    })()""", required=('text',), desc='状态栏日期文本')
    if not dt_ok:
        return False, f'状态栏日期文本探针失败: {dt}'
    if dt['text'] != str(drag['at50']):
        return False, f'状态栏日期文本不符: {dt["text"]!r}（应为只到年的 {drag["at50"]}）'

    # ---------- 4. 点时代块跳剧本 ----------
    jump_ok, jump = eval_json(cdp, """(() => {
      const s = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      const blk = document.querySelector('[data-testid="tl-era-2"]');
      if (!blk) return JSON.stringify({err:'no-block'});
      blk.click();
      return JSON.stringify({era: s.tlEra, year: Math.round(s.tlYear),
                             selected: s.selectedScenario?.name});
    })()""", required=('era', 'year', 'selected'), desc='点时代块跳剧本')
    if not jump_ok:
        return False, f'点时代块跳剧本探针失败: {jump}'
    if jump.get('era') != 2 or jump.get('year') != 2020:
        return False, f'点时代块未跳转: {jump}'
    if jump.get('selected') != '丙时代':
        return False, f'点时代块未同步选中剧本: {jump}'

    # ---------- 5. 键盘（连续真实按键序列；不在中途强设 state，避开 prop 传播时序） ----------
    kb_ok, kb = eval_json(cdp, """(async () => {
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
    })()""", required=('home', 'r1', 'r2', 'r3overrun', 'l1', 'shiftUp', 'shiftDown', 'end'),
        desc='键盘导航')
    if not kb_ok:
        return False, f'键盘导航探针失败: {kb}'
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
    played_ok, played = eval_json(cdp, """(async () => {
      const s = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      // 🔴 游标真源是 tlDate（月日精度）；`s.tlYear = 2000` 在旧模型里是赋值、现在是往
      //    **只读 computed** 上写 → Vue 只打一条 warn，值不变（静默无效）。必须写 tlDate。
      s.tlEra = 0; s.tlDate = { y: 2000, m: null, d: null }; s.tlPlaying = false;
      await new Promise(r => setTimeout(r, 60));
      const startYear = Math.round(s.tlYear);
      const btn = document.querySelector('[data-testid="tl-play"]');
      const labelBefore = btn.textContent.trim();
      btn.click();
      const playingNow = s.tlPlaying;
      await new Promise(r => setTimeout(r, 700));
      const midYear = Math.round(s.tlYear);
      btn.click();
      const stopped = s.tlPlaying;
      return JSON.stringify({startYear, labelBefore, playingNow, midYear, stopped});
    })()""", required=('startYear', 'labelBefore', 'playingNow', 'midYear', 'stopped'),
        desc='播放')
    if not played_ok:
        return False, f'播放探针失败: {played}'
    if played['startYear'] != 2000:
        return False, f'播放前未把游标设到 2000（tlDate 写入无效？）: {played}'
    if not played['playingNow'] or played['stopped']:
        return False, f'播放按钮未切换 tlPlaying: {played}'
    if played['midYear'] <= 2000:
        return False, f'播放中游标未前进: {played}'

    # ---------- 7. 轴向切换 ----------
    axes_ok, axes = eval_json(cdp, """(() => {
      const s = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
      const root = document.querySelector('[data-testid="scenario-timeline"]');
      document.querySelector('[data-testid="tl-axis-equal"]').click();
      const eq = {mode: s.tlAxisMode, blocks: root.querySelectorAll('.tl-block').length};
      document.querySelector('[data-testid="tl-axis-year"]').click();
      const yr = {mode: s.tlAxisMode, blocks: root.querySelectorAll('.tl-block').length,
                  gaps: root.querySelectorAll('.tl-block.is-gap').length};
      return JSON.stringify({eq, yr});
    })()""", required=('eq', 'yr'), desc='轴向切换')
    if not axes_ok:
        return False, f'轴向切换探针失败: {axes}'
    if axes['eq']['mode'] != 'equal' or axes['eq']['blocks'] != 3:
        return False, f'等宽轴错误: {axes}'
    if axes['yr']['mode'] != 'year' or axes['yr']['blocks'] != 3 or axes['yr']['gaps'] != 0:
        return False, f'按年比例轴错误: {axes}'

    return True, (f'谱系匹配{json.dumps(tl["eraChg"], ensure_ascii=False)} → 组件{dom["blocks"]}块'
                  f' → 拖动{drag["at10"]}/{drag["at50"]} → 点块跳丙时代 → 键盘四键全通'
                  f' → 播放前进至{played["midYear"]} → 双向轴向切换')
