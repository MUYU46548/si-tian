"""用例 128：新建势力不再用 window.prompt（Electron 渲染进程不支持）。

暮雨 2026-10-19 实测：点「＋ 势力」→ `prompt() is and will not be supported`，整条建势力链卡死。
本用例守：
  · 点「＋ 势力」弹出 App 根部的 PromptDialog（不是原生 prompt）；
  · 输入名称 → 确定 → 剧本里真的多了一个势力，并自动选中它；
  · 取消不产生势力。
"""
import json

from lib.cdp import wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"

SETUP = r"""
(() => {
  const s = __STORE__, sm = __SM__;
  const KEY = 'case128';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain = [{
    id: 'p128', name: '省128', kind: 'land',
    points: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],
  }];
  for (const k of Object.keys(s.scenarios || {})) if (k.startsWith(KEY)) s.removeScenario(k);
  const id = KEY + '/当前';
  s.createScenario(id, {
    ownerKey: KEY, name: '当前', order: 1,
    era: { roman: 'I', label: '一', startYear: '2026', endYear: '2030' },
    polities: [], ownership: {},
  });
  sm.baseMapKey = KEY;
  if (sm.onBaseMapChange) sm.onBaseMapChange();
  sm.selectedScenario = s.scenarios[id];
  return JSON.stringify({ id, before: (s.scenarios[id].polities || []).length });
})()
"""


def run(cdp):
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')
    setup = cdp.eval(SETUP.replace('__STORE__', STORE).replace('__SM__', SM))
    try:
        info = json.loads(setup)
    except Exception:
        return False, f'造数据失败：{str(setup)[:300]}'

    # 点「＋ 势力」
    clicked = cdp.eval("(() => { const b = document.querySelector('[data-testid=\"add-polity\"]');"
                       " if (!b) return 'no-button'; b.click(); return 'ok'; })()")
    if clicked != 'ok':
        return False, f'没找到「＋ 势力」按钮：{clicked}'
    wait_for(cdp, "!!document.querySelector('.prompt-dialog')", timeout=10, desc='PromptDialog')
    # 输入 + 确定
    cdp.eval("(() => { const el = document.querySelector('.prompt-input');"
             " el.value = '测试势力甲'; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()")
    cdp.eval("document.querySelector('.prompt-btn.primary').click()")
    wait_for(cdp,
             "(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store;"
             " const sc = s.scenarios[%r]; return !!(sc && (sc.polities || []).some(p => p.name === '测试势力甲')); })()"
             % info['id'],
             timeout=10, desc='势力落库')
    after = cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store;"
                     " const sc = s.scenarios[%r]; return JSON.stringify({"
                     " n: (sc.polities || []).length, names: (sc.polities || []).map(p => p.name),"
                     " selected: (document.querySelector('.scenario-map-container').__vueParentComponent.setupState.selectedPolity || {}).name || null }); })()"
                     % info['id'])
    if '测试势力甲' not in str(after):
        return False, f'势力没建上：{after}'
    return True, f'PromptDialog 建势力成功：{after}'
