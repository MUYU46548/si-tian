"""用例 129：剧本卡片墙 —— 12 条剧本全部可见 + 搜索/筛选/计数 + 盖住左侧导航。

暮雨 2026-10-19 实测：「卡片墙根本不展示所有剧本」「左边导航栏依旧遮不住」。
本用例守：
  · 12 条剧本 → 12 张卡（不是只渲染前几张）；
  · 「共 N / N」计数 + 搜索能缩小子集 + 无匹配有回执；
  · picker 的 z-index 覆盖左侧导航（elementFromPoint 落在 picker 内）。
"""
import json

from lib.cdp import wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

SETUP = r"""
(() => {
  const s = __STORE__;
  const KEY = 'case129';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain = [{
    id: 'p129', name: '省129', kind: 'land',
    points: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],
  }];
  for (const k of Object.keys(s.scenarios || {})) if (k.startsWith(KEY)) s.removeScenario(k);
  for (let i = 1; i <= 12; i++) {
    s.createScenario(KEY + '/剧本' + String(i).padStart(2, '0'), {
      ownerKey: KEY, name: '剧本' + String(i).padStart(2, '0'), order: i,
      era: { roman: 'Ⅰ', label: '一', startYear: String(2000 + i), endYear: String(2010 + i) },
      polities: [], ownership: {},
    });
  }
  window.__SKIP_SCENARIO_PICKER = false;
  return JSON.stringify({ count: Object.keys(s.scenarios || {}).filter(k => k.startsWith(KEY)).length });
})()
"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    cdp.eval(SETUP.replace('__STORE__', STORE))
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('[data-testid=\"scenario-picker\"]')", timeout=20, desc='卡片墙')
    wait_for(cdp, "document.querySelectorAll('.sp-card').length >= 12", timeout=20, desc='12 张卡')

    cards = cdp.eval("document.querySelectorAll('.sp-card').length")
    count_text = cdp.eval("(document.querySelector('[data-testid=\"sp-count\"]') || {}).textContent || ''")
    if cards != 12:
        return False, f'卡片数不是 12：{cards}'
    if '12 / 12' not in str(count_text):
        return False, f'计数不对：{count_text}'

    # 搜索：剧本 01 → 1 张
    cdp.eval("(() => { const el = document.querySelector('[data-testid=\"sp-search\"]');"
             " el.value = '剧本01'; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()")
    wait_for(cdp, "document.querySelectorAll('.sp-card').length === 1", timeout=10, desc='搜索缩到 1 张')
    # 无匹配
    cdp.eval("(() => { const el = document.querySelector('[data-testid=\"sp-search\"]');"
             " el.value = '不存在的剧本zzz'; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('[data-testid=\"sp-no-match\"]')", timeout=10, desc='无匹配回执')
    # 清空 → 回到 12
    cdp.eval("(() => { const el = document.querySelector('[data-testid=\"sp-search\"]');"
             " el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()")
    wait_for(cdp, "document.querySelectorAll('.sp-card').length === 12", timeout=10, desc='清空恢复 12')

    # 结构性判据（2026-10-21 模块壳第二轮起）：
    #   左侧导航必须**不在 DOM**（遮罩/露底修过五次仍会露）；
    #   顶部栏则**必须常驻**——模块页签要在卡片墙上也能点（用户实测：
    #   「点历史剧本后再也没有地方点世界观，最接近的是返回世界」）。
    #   两者不矛盾的判据：卡片墙从顶栏下沿开始铺，且顶栏在它之上（点得到）。
    nav_gone = cdp.eval("!document.querySelector('.tree-navigation')")
    toolbar_present = cdp.eval("!!document.querySelector('.toolbar')")
    if not nav_gone:
        return False, '卡片墙打开时左侧导航仍在 DOM（仍是遮罩思路）'
    if not toolbar_present:
        return False, '卡片墙打开时顶部模块栏不在 DOM —— 用户只能从退出按钮离开'
    lay = cdp.eval("""(() => {
      const t = document.querySelector('.toolbar').getBoundingClientRect();
      const p = document.querySelector('[data-testid="scenario-picker"]').getBoundingClientRect();
      const sw = document.querySelector('[data-testid="module-switch"]');
      const r = sw ? sw.getBoundingClientRect() : null;
      const hit = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
      return JSON.stringify({
        toolbarBottom: Math.round(t.bottom), pickerTop: Math.round(p.top),
        switchHit: hit ? (hit.closest('[data-testid="module-switch"]') ? 'switch' : String(hit.className)) : 'none',
      });
    })()""")
    try:
        L = json.loads(lay)
    except Exception:
        return False, f'模块栏布局探针失败：{lay[:200]}'
    if L['pickerTop'] < L['toolbarBottom'] - 1:
        return False, f"卡片墙压住了顶部栏（pickerTop={L['pickerTop']} < toolbarBottom={L['toolbarBottom']}）"
    if L['switchHit'] != 'switch':
        return False, f"卡片墙打开时模块页签点不到（命中的是 {L['switchHit']}）"

    # 盖住左侧导航：视口左侧中部点在 picker 内，而不是 tree-navigation
    cover = cdp.eval("(() => { const el = document.elementFromPoint(10, 300);"
                     " return el ? (el.closest('[data-testid=\"scenario-picker\"]') ? 'picker' : el.className) : 'none'; })()")
    if cover != 'picker':
        return False, f'左侧导航没被盖住：该点元素={cover}'
    # 滚到最底下也必须盖住（暮雨实测：拉到底会露出 SiTian 标题）
    bottom = cdp.eval("(() => { const p = document.querySelector('[data-testid=\"scenario-picker\"]');"
                      " p.scrollTop = p.scrollHeight; const el = document.elementFromPoint(10, window.innerHeight - 12);"
                      " const bg = document.querySelector('.sp-bg');"
                      " return JSON.stringify({ top: el ? (el.closest('[data-testid=\"scenario-picker\"]') ? 'picker' : el.className) : 'none',"
                      " bgPos: bg ? getComputedStyle(bg).position : 'none' }); })()")
    try:
        b = json.loads(bottom)
    except Exception:
        b = {}
    if b.get('top') != 'picker':
        return False, f'滚到底后左侧导航又露出来：{bottom}'
    if b.get('bgPos') != 'fixed':
        return False, f'背景不是 fixed（会跟着滚走）：{bottom}'
    return True, f'12 张卡 / 计数 {str(count_text).strip()} / 搜索可缩到 1 / 无匹配回执 / 左导航上下都被盖住'
