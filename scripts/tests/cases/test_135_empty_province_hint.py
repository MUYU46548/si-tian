#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 135：空底图上的「第一笔」提示卡（2026-10-22 用户实测反馈）

用户原话：「可以建空底图了，但是我不知道怎么画，于是又卡住了。使用手册看不懂。」
真因（代码实证）：
  · 「画省份」按钮只在 `basemapEditMode`（底图编辑）下渲染；
  · 日常模式的省份行只有 圈选/点填/折线/铺底/描轮廓 —— 空底图上这些都要"已有省份或陆地"；
  · 使用手册第九节写「用主行的『画省份』」，但日常模式的主行里根本没有它。
本用例守：
  a 0 省时画布中央有提示卡（三步 + 「开始画省份」按钮），文案是人话；
  b 点「开始画省份」→ 真的进底图编辑 + 选好 draw 工具 + 状态栏教怎么落笔；
  c 有省之后提示卡消失（不挡视线）；
  d 日常模式的省份行也能找到「画省份」入口（不用自己猜先去切模式）；
  e 源码闸门：手册第九节有「最短路径」；提示卡/入口/函数都在。
"""
import json
import os
import time

from lib.cdp import eval_json, wait_for
from lib.helpers import ensure_case_state

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _gates():
    fails = []
    src = open(os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue'), encoding='utf-8').read()
    for needle, label in [
        ('data-testid="empty-province-hint"', '空底图第一笔提示卡'),
        ('data-testid="empty-province-start"', '提示卡里的「开始画省份」'),
        ('function startDrawingProvince(', '第一笔入口函数'),
        ('data-testid="province-draw-entry"', '省份行的「画省份」入口'),
    ]:
        if needle not in src:
            fails.append(f'源码闸门缺：{label}（{needle}）')
    guide = open(os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'userGuide.js'), encoding='utf-8').read()
    if '最短路径（空底图' not in guide:
        fails.append('使用手册第九节缺「最短路径（空底图）」段')
    return fails


def _seed(cdp):
    cdp.eval("""(async () => {
      const s = __STORE__, sm = __SM__;
      Object.keys(s.scenarios || {}).forEach(k => s.removeScenario(k));
      if (!s.baseMaps['用例135底图']) s.addBaseMap('用例135底图', { name: '用例135底图' });
      s.baseMaps['用例135底图'].terrain.length = 0;
      s.createScenario('用例135底图/甲时代', {
        ownerKey: '用例135底图', name: '甲时代', order: 1,
        era: { startYear: '2000', endYear: '2010' }, polities: [], ownership: {},
      });
      sm.baseMapKey = '用例135底图';
      if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
      sm.selectScenario(s.scenarios['用例135底图/甲时代']);
      sm.basemapEditMode = false;
      sm.setTool('select');
      return 'ok';
    })()""".replace('__STORE__', STORE).replace('__SM__', SM))
    time.sleep(0.5)


def run(cdp):
    fails = _gates()
    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'harness 项目未就绪：{info}'
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')
    _seed(cdp)

    # a 提示卡
    wait_for(cdp, "!!document.querySelector('[data-testid=\"empty-province-hint\"]')", timeout=8, desc='第一笔提示卡')
    ok_t, text = eval_json(cdp, """(() => {
      const el = document.querySelector('[data-testid="empty-province-hint"]');
      return JSON.stringify(el ? el.innerText : '');
    })()""", required=None, desc='提示卡文案')
    for token in ('还没有省份', '按住左键', '松手'):
        if token not in str(text):
            fails.append(f'提示卡里缺「{token}」：{text}')
    ok_btn, has_btn = eval_json(cdp, """(() => JSON.stringify({
      has: !!document.querySelector('[data-testid="empty-province-start"]')
    }))()""", required=None, desc='开始画省份按钮')
    if not (isinstance(has_btn, dict) and has_btn.get('has')):
        fails.append('提示卡里没有「开始画省份」按钮')

    # b 点它 → 底图编辑 + draw
    cdp.eval("document.querySelector('[data-testid=\"empty-province-start\"]').click()")
    time.sleep(0.5)
    ok_s, st = eval_json(cdp, """(() => {
      const sm = __SM__;
      return JSON.stringify({ tool: sm.tool, edit: sm.basemapEditMode, hint: String(sm.provinceHint || '') });
    })()""".replace('__SM__', SM), required=None, desc='点完之后的状态')
    if not (isinstance(st, dict) and st.get('tool') == 'draw'):
        fails.append(f"点「开始画省份」没切到画省份：{st}")
    if not (isinstance(st, dict) and st.get('edit') is True):
        fails.append(f"点「开始画省份」没进底图编辑：{st}")
    if '按住左键' not in str(st.get('hint')):
        fails.append(f'状态栏没教怎么落笔：{st.get("hint")}')

    # c 有省之后提示卡消失
    eval_json(cdp, """(() => {
      const s = __STORE__;
      s.addBaseProvince('用例135底图', {
        id: 'p135', name: '省1', kind: 'land',
        points: [{x:100,y:100},{x:260,y:100},{x:260,y:240},{x:100,y:240}],
      }, { checkOverlap: false });
      return 'ok';
    })()""".replace('__STORE__', STORE), required=None, desc='加一个省')
    time.sleep(0.5)
    ok_gone, gone = eval_json(cdp, """(() => JSON.stringify({
      has: !!document.querySelector('[data-testid="empty-province-hint"]'),
      count: (__STORE__.baseMaps['用例135底图'].terrain || []).length,
    }))()""".replace('__STORE__', STORE), required=None, desc='提示卡是否消失')
    if not (isinstance(gone, dict) and gone.get('count') >= 1):
        fails.append(f'省没加进去：{gone}')
    elif gone.get('has'):
        fails.append('有省之后提示卡还在（挡视线）')

    # d 日常模式的省份行入口
    eval_json(cdp, "(() => { const sm = %s; sm.basemapEditMode = false; sm.setTool('select'); sm.moreOpen = true; return 'ok'; })()" % SM,
              required=None, desc='回日常模式并展开更多')
    time.sleep(0.3)
    ok_e, entry = eval_json(cdp, """(() => JSON.stringify({
      has: !!document.querySelector('[data-testid="province-draw-entry"]'),
      text: (document.querySelector('[data-testid="province-draw-entry"]') || {}).innerText || '',
    }))()""", required=None, desc='省份行画省份入口')
    if not (isinstance(entry, dict) and entry.get('has')):
        fails.append('日常模式的省份行里没有「画省份」入口')

    # 收尾
    eval_json(cdp, """(() => {
      const s = __STORE__, sm = __SM__;
      if (s.baseMaps['用例135底图']) s.removeBaseMap('用例135底图');
      sm.showScenarioManager = false;
      sm.moreOpen = false;
      sm.baseMapKey = '';
      return 'ok';
    })()""".replace('__STORE__', STORE).replace('__SM__', SM), required=None, desc='收尾')
    time.sleep(0.3)

    if fails:
        return False, '；'.join(fails)
    return True, '提示卡三步 + 「开始画省份」→ 底图编辑/draw + 有省后消失 + 省份行入口在'
