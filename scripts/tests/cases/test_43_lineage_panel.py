#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 43：势力谱系管理面板（P2）

覆盖：
  1. 工具栏入口 → 面板渲染（谱系表行数 = 有省份的势力数）
  2. 「承自」下拉指向前一剧本势力 → 写入 polity.successorOf → 变化省数随之改变（真影响 diff）
  3. undo → successorOf 移除且变化省数回滚
  4. 易主日期页：改 input → 写入 scenario.changeEvents（显式，月日精度）→ 点「自动」清除
  5. 面板关闭
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib.helpers import ensure_data_ready, open_test_base_map, open_toolbar_more

SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"


def _enter(cdp):
    r = cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()""")
    if r != 'ok':
        return r
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    return 'ok'


def _seed_js(cdp):
    """甲时代 A1 独占两省；乙时代 B1(prov_a) / B2(prov_b) → eraChg[1] = ['prov_b']（返回 JS 源）"""
    return """(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
      if (!s.baseMaps['云陇大陆']) s.addBaseMap('云陇大陆', { name: '云陇大陆' });
      s.baseMaps['云陇大陆'].terrain.length = 0;
      const mk = (id, x0) => ({ id, name: '省' + id.slice(-1).toUpperCase(),
        points: [{x:x0,y:150},{x:x0+140,y:150},{x:x0+140,y:290},{x:x0,y:290}],
        biome: 'temperate', coast: true });
      ['prov_a','prov_b'].forEach((id, i) => s.addBaseProvince('云陇大陆', mk(id, 200 + i*200)));
      const P = (id, name, color) => ({ id, name, color });
      s.createScenario('云陇大陆/甲时代', {
        ownerKey: '云陇大陆', name: '甲时代', order: 1,
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [P('A1','甲国','#c23b3b')],
        ownership: { prov_a:'A1', prov_b:'A1' },
      });
      s.createScenario('云陇大陆/乙时代', {
        ownerKey: '云陇大陆', name: '乙时代', order: 2,
        era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
        polities: [P('B1','乙国','#4a90d9'), P('B2','乙南','#e6a23c')],
        ownership: { prov_a:'B1', prov_b:'B2' },
      });
      return JSON.stringify({scenarios: Object.keys(s.scenarios).length});
    })()"""


def run(cdp):
    ensure_data_ready(cdp)
    r = _enter(cdp)
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    # 底图 fixture：司天不再默认建/选示例底图（见 helpers.open_test_base_map 说明）
    bm_ok, bm_info = open_test_base_map(cdp, '云陇大陆')
    if not bm_ok:
        return False, f'底图 fixture 未就位: {bm_info}'
    seed_ok, seed = eval_json(cdp, _seed_js(cdp), required=('scenarios',), desc='注入 2 省 + 2 剧本')
    if not seed_ok:
        return False, f'数据注入探针失败: {seed}'
    if seed['scenarios'] != 2:
        return False, f'数据注入失败: {seed}'
    time.sleep(0.4)

    # ---------- 1. 打开面板 ----------
    # P3 起「谱系」入口收在「更多」里（默认只露 6 个主控件）→ 先展开再点
    open_toolbar_more(cdp)
    panel_ok, panel = eval_json(cdp, """(() => {
      const btn = document.querySelector('[data-testid="open-lineage"]');
      if (!btn) return JSON.stringify({err:'no-button'});
      btn.click();
      return JSON.stringify({clicked: true});
    })()""", required=('clicked',), desc='工具栏谱系入口')
    if not panel_ok:
        return False, f'工具栏缺谱系入口（或按钮点击抛异常）: {panel}'
    time.sleep(0.25)
    dom_ok, dom = eval_json(cdp, """(() => {
      const dlg = document.querySelector('[data-testid="lineage-panel"]');
      if (!dlg) return JSON.stringify({mounted:false});
      return JSON.stringify({
        mounted: true,
        eras: dlg.querySelectorAll('.slp-era').length,
        rows: dlg.querySelectorAll('.slp-table tbody tr').length,
        selects: dlg.querySelectorAll('select[data-testid^="slp-succ-"]').length,
        hasYearsTab: !!dlg.querySelector('[data-testid="slp-tab-years"]'),
      });
    })()""", required=('mounted',), desc='谱系面板 DOM')
    if not dom_ok:
        return False, f'谱系面板 DOM 探针失败: {dom}'
    if not dom.get('mounted'):
        return False, '谱系面板未渲染'
    # 甲时代 1 行 + 乙时代 2 行 = 3 行；只有乙时代有「承自」下拉（2 个）
    if dom.get('eras') != 2 or dom.get('rows') != 3 or dom.get('selects') != 2:
        return False, f'谱系表结构不符: {dom}'
    if not dom.get('hasYearsTab'):
        return False, f'缺易主日期页签: {dom}'

    # ---------- 2. 承自纠正：B2 承自 A1 → prov_b 不再计为「变化」 ----------
    corr_ok, corr = eval_json(cdp, f"""(() => {{
      const s = {SM};
      const before = s.timeline.eraChg[1].changed;
      const sel = document.querySelector('select[data-testid="slp-succ-1-B2"]');
      if (!sel) return JSON.stringify({{err:'no-select'}});
      const options = Array.from(sel.options).map(o => o.value).filter(Boolean);
      sel.value = 'A1';
      sel.dispatchEvent(new Event('change', {{bubbles:true}}));
      return JSON.stringify({{before, options}});
    }})()""", required=('before', 'options'), desc='承自下拉')
    if not corr_ok:
        return False, f'乙时代缺 B2 的「承自」下拉（或探针抛异常）: {corr}'
    if corr['options'] != ['A1']:
        return False, f'「承自」下拉候选应只有前一剧本的 A1: {corr}'
    time.sleep(0.35)
    after_ok, after = eval_json(cdp, f"""(() => {{
      const s = {SM};
      const pol = s.store.scenarios['云陇大陆/乙时代'].polities.find(p => p.id === 'B2');
      const badge = document.querySelector('[data-testid="tl-era-1"] .tl-badge');
      return JSON.stringify({{
        successorOf: pol.successorOf,
        changed: s.timeline.eraChg[1].changed,
        badge: badge ? badge.textContent.trim() : null,
      }});
    }})()""", required=('changed',), desc='承自写入结果')
    if not after_ok:
        return False, f'承自写入结果探针失败: {after}'
    if after.get('successorOf') != 'A1':
        return False, f'承自未写入 store: {after}'
    if after['changed'] != []:
        return False, f'承自纠正未影响变化判定（应变为空）: {after}'
    if after.get('badge') not in (None, '', '0'):
        return False, f'时代块角标未随纠正更新: {after}'

    # ---------- 3. undo 回滚 ----------
    un_ok, un = eval_json(cdp, f"""(() => {{
      const s = {SM};
      s.store.undo();
      const pol = s.store.scenarios['云陇大陆/乙时代'].polities.find(p => p.id === 'B2');
      return JSON.stringify({{successorOf: pol.successorOf ?? null, changed: s.timeline.eraChg[1].changed}});
    }})()""", required=('successorOf', 'changed'), desc='undo 回滚承自')
    if not un_ok:
        return False, f'undo 回滚探针失败: {un}'
    if un['successorOf'] is not None or un['changed'] != ['prov_b']:
        return False, f'承自纠正未随 undo 回滚: {un}'

    # ---------- 4. 易主日期页（月日精度：`changeEvents[pid] = [{y,m,d,owner}, …]`） ----------
    years_ok, years = eval_json(cdp, f"""(async () => {{
      const s = {SM};
      // 「易主日期」页展示的是**当前剧本**的变化省 → 先把游标移到乙时代
      // 月日精度：游标真源是 tlDate（`s.tlYear = 2010` 现在写的是只读 computed，静默无效）
      s.tlDate = {{ y: 2010, m: null, d: null }};
      await new Promise(r => setTimeout(r, 150));
      if (s.tlEra !== 1) return JSON.stringify({{err:'era-not-1', era: s.tlEra}});
      document.querySelector('[data-testid="slp-tab-years"]').click();
      await new Promise(r => setTimeout(r, 150));
      const input = document.querySelector('[data-testid="slp-cy-prov_b"]');
      if (!input) return JSON.stringify({{err:'no-input', era: s.tlEra}});
      // 合成值（未录入时的推算日期）—— 期望被显式值取代
      const autoEv = (s.timeline.eraChg[1].byProvince.prov_b || [])[0] || null;
      // 刻意写一个**不同于合成值**的年份：否则「显式值是否真的生效」分辨不出来（合成值恰好同年 → 假绿）
      input.value = '2016';
      input.dispatchEvent(new Event('change', {{bubbles:true}}));
      await new Promise(r => setTimeout(r, 200));
      const written = s.store.scenarios['云陇大陆/乙时代'].changeEvents;
      const effEv = (s.timeline.eraChg[1].byProvince.prov_b || [])[0] || null;
      const clearBtn = document.querySelector('[data-testid="slp-cyclear-prov_b"]');
      if (clearBtn) clearBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const cleared = s.store.scenarios['云陇大陆/乙时代'].changeEvents;
      const backEv = (s.timeline.eraChg[1].byProvince.prov_b || [])[0] || null;
      return JSON.stringify({{autoEvent: autoEv, written, effEvent: effEv,
                             cleared, backEvent: backEv, hadClearBtn: !!clearBtn}});
    }})()""", required=('autoEvent', 'written', 'effEvent', 'cleared', 'backEvent', 'hadClearBtn'),
        desc='易主日期页录入/清除')
    if not years_ok:
        return False, f'易主日期页探针失败（缺 prov_b 的行 / JS 抛异常）: {years}'
    auto_ev = years['autoEvent'] or {}
    if auto_ev.get('explicit'):
        return False, f'用例前提不成立（此时应是自动推算的合成日期）: {years}'
    # 显式值必须是「整列表替换」写入 changeEvents，形状 {y,m,d,owner}
    w = years['written'] or {}
    wl = w.get('prov_b') or []
    if list(w.keys()) != ['prov_b'] or len(wl) != 1:
        return False, f'显式易主日期未按新模型写入（期望 changeEvents.prov_b 恰好 1 条）: {years}'
    if wl[0].get('y') != 2016 or wl[0].get('m') is not None or wl[0].get('d') is not None:
        return False, f'写入的事件日期不符（期望 2016 只到年 = m/d 为 null）: {years}'
    if wl[0].get('owner') != 'B2':
        return False, f'写入的事件归属不符（期望该省在本剧本的新主 B2）: {years}'
    eff = years['effEvent'] or {}
    if eff.get('y') != 2016 or not eff.get('explicit'):
        return False, f'显式日期未生效于时间轴（且须标 explicit）: {years}'
    if not years['hadClearBtn']:
        return False, f'显式值应出现「自动」清除按钮: {years}'
    if years['cleared'] != {}:
        return False, f'「自动」未清除显式日期（应回到无 changeEvents 键的空表）: {years}'
    back = years['backEvent'] or {}
    if back.get('y') != auto_ev.get('y') or back.get('explicit'):
        return False, f'清除后未回到自动推算值（期望 y={auto_ev.get("y")} 且 explicit=false）: {years}'

    # ---------- 5. 关闭面板（Vue 未 flush 前查 DOM 必然还在 → 等一个 tick） ----------
    closed_ok, closed = eval_json(cdp, """(async () => {
      const dlg = document.querySelector('[data-testid="lineage-panel"]');
      const x = dlg && dlg.querySelector('.slp-x');
      if (!x) return JSON.stringify({closed: false, why: 'no-close-btn'});
      x.click();
      await new Promise(r => setTimeout(r, 150));
      return JSON.stringify({closed: !document.querySelector('[data-testid="lineage-panel"]')});
    })()""", required=('closed',), desc='关闭面板')
    if not closed_ok or not closed['closed']:
        return False, f'面板未关闭: {closed}'

    return True, (f'面板 {dom["eras"]} 剧本/{dom["rows"]} 行/{dom["selects"]} 个承自下拉'
                  f' → B2 承自 A1：变化省 {corr["before"]}→{after["changed"]} 且角标更新'
                  f' → undo 回滚至 {un["changed"]}'
                  f' → 显式易主日期 2016 写入 changeEvents/清除回合成值 {years["backEvent"]["y"]} → 面板关闭')
