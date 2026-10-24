#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 144：点标记 → 标记面板 → 库内资料（2026-10-24，第 5 件补「点标记」）

背景：标记此前是"只画不收"的一层 —— 放下时 `askText` 问个名字，之后**点不到它**
（选择工具只认河流 / 城镇 / 省份，没有命中测试也没有面板）。于是"点标记看资料"一直挂不上。
这一刀补三件：① 命中测试（`utils/markerHitTest.js`，纯函数，另有 Node 单测）
② 标记面板（名字 / 类型 / 坐标 / 删除）③ 资料段（**与省份面板同一个组件**
`VaultLoreSection.vue`，不是复制第二份）。

验收点：
1. 真点地图上的标记图标 → 打开标记面板（面板里名字 / 类型 / 坐标来自那条标记）；
   **点偏 40px 不算命中**（否则"哪都能点开"= 命中半径形同虚设）；
2. 面板改三项都**走 store**：改名 / 改类型（图标·颜色跟着类型走）/ 改坐标，
   且撤销栈里是「编辑标记」（证明不是直改内存）；
3. 资料段：检索关键词**就是标记名**；候选可点开阅读器；空态明说「库里没有同名词条」；
   「全库搜索」把标记名带进搜索面板；
4. **只读**：`createObsidianNote` / `setSitianConfig` 调用次数 0（资料检索不写库）；
5. 删除：标记真的从剧本里消失、面板收起；
6. 源码守卫：命中只有一份实现；资料段只有一份实现（`vaultIndexSearch` 全仓一处）；
   面板不直改标记对象；store 的 `updateScenarioMarker` 走 `execute` + `saveScenarios`。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
MAP = 'src/renderer/src/components/ScenarioMap.vue'
LORE = 'src/renderer/src/components/VaultLoreSection.vue'
STORE_FILE = 'src/renderer/src/store/geodataModules/scenarioEditing.js'
HIT = 'src/renderer/src/utils/markerHitTest.js'
KEY = '用例144底图'
SC_ID = KEY + '/当前'
MARKER_ID = 'mk144'
MARKER_NAME = '雾隐驿'


def _read(rel):
    import io
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


def _fn_body(code, name):
    """截取 `function <name>` 到下一个**任意缩进层级**的 `function ` 之间。

    ⚠️ 不能只找 `\\nfunction `：store 里的函数都缩进两格（`  function …`），
    那样会一路截到文件末尾，于是把**别的函数**里的 `guardWrite(` 误算成这个函数里的
    （第一次跑本用例就踩到了：假红在"写口"这条上）。
    """
    start = code.find('function ' + name)
    if start < 0:
        return ''
    m = re.search(r'\n[ \t]*function ', code[start + 10:])
    if not m:
        return code[start:]
    return code[start:start + 10 + m.start()]


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, dict):
        raise RuntimeError('eval 异常：%s' % v)
    if isinstance(v, str) and v.startswith(('{', '[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


SEED = r"""(() => {
  const s = STORE, sm = SM, KEY = KEYJ, ID = IDJ;
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  const bm = s.baseMaps[KEY];
  bm.terrain.length = 0;
  const ring = (x0, y0, x1, y1) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
  s.addBaseProvince(KEY, { id: 'p144a', name: '雾隐城', kind: 'land', points: ring(100, 100, 320, 320) });
  for (const k of Object.keys(s.scenarios || {})) if (k.indexOf(KEY) === 0) s.removeScenario(k);
  s.createScenario(ID, {
    ownerKey: KEY, name: '用例144剧本', order: 1,
    era: { roman: 'I', label: '一', startYear: '1440', endYear: '1450' },
    polities: [], ownership: {}, labels: [],
    markers: [{ id: MID, x: 200, y: 200, name: MNAME, type: 'city', icon: 'castle', color: '#ffd700' }],
  });
  sm.baseMapKey = KEY;
  sm.selectedScenario = s.scenarios[ID];
  sm.tool = 'select';
  sm.viewMode = 'scenario';
  if (typeof sm.fitToView === 'function') sm.fitToView();
  const p = sm.worldToScreen(200, 200);
  return JSON.stringify({ id: ID, sx: p.x, sy: p.y, scale: sm.cameraScale,
                          n: ((s.scenarios[ID] || {}).markers || []).length });
})()""".replace('STORE', STORE).replace('SM', SM).replace('KEYJ', json.dumps(KEY)) \
    .replace('IDJ', json.dumps(SC_ID)).replace('MID', json.dumps(MARKER_ID)) \
    .replace('MNAME', json.dumps(MARKER_NAME))

# 装探针：记录检索关键词 + 可切换空态 + 写口计数（before 选中/点击）
STUB = r"""(() => {
  const api = window.sitianAPI;
  if (!window.__vsearchOrig) window.__vsearchOrig = api.vaultIndexSearch;
  window.__vsearchCalls = [];
  window.__deepCalls = [];
  window.__vsearchMode = 'hit';
  api.vaultIndexSearch = async (q, n) => {
    window.__vsearchCalls.push(String(q));
    if (window.__vsearchMode === 'none') return { success: true, results: [] };
    return { success: true, results: [
      { path: '03 设定/11 地理系统/行星/雾隐驿.md', title: '雾隐驿', layerHint: '城市', kind: 'map', score: 100 },
      { path: '03 设定/04 概念·规则/雾隐.md', title: '雾隐', layerHint: '资料', kind: 'lore', score: 60 },
    ] };
  };
  api.vaultNoteSearch = async (q, n) => {
    window.__deepCalls.push(String(q));
    return { success: true, results: [
      { path: '03 设定/11 地理系统/行星/雾隐驿.md', title: '雾隐驿', matchedIn: 'title', kind: 'map' },
    ] };
  };
  window.__writeCalls = { note: 0, cfg: 0, save: 0 };
  const wrap = (name, key) => {
    const orig = api[name];
    if (typeof orig !== 'function') return;
    api[name] = (...a) => { window.__writeCalls[key] += 1; return orig(...a); };
  };
  wrap('createObsidianNote', 'note');
  wrap('setSitianConfig', 'cfg');
  wrap('projectSave', 'save');
  return JSON.stringify({ ok: true });
})()"""

# 真点击画布（dx = 相对标记的屏幕偏移 px）
CLICK = r"""((dx) => {
  const sm = SM;
  const cvs = document.querySelector('.scenario-map-container canvas');
  if (!cvs) return JSON.stringify({ __err__: '没有画布' });
  const r = cvs.getBoundingClientRect();
  const p = sm.worldToScreen(MX, MY);
  const cx = r.left + p.x + dx;
  const cy = r.top + p.y;
  cvs.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, button: 0, clientX: cx, clientY: cy,
  }));
  return JSON.stringify({ sx: Math.round(p.x + dx), sy: Math.round(p.y),
                          w: Math.round(r.width), h: Math.round(r.height) });
})(DX)""".replace('SM', SM).replace('MX', '200').replace('MY', '200')

STATE = r"""(() => {
  const panel = document.querySelector('[data-testid="marker-props"]');
  const box = document.querySelector('[data-testid="marker-vault"]');
  const rows = box ? Array.from(box.querySelectorAll('[data-testid="marker-vault-hit"]')) : [];
  const val = (sel) => { const el = document.querySelector(sel); return el ? el.value : null; };
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  return JSON.stringify({
    panel: !!panel,
    name: val('[data-testid="marker-name"]'),
    type: val('[data-testid="marker-type"]'),
    x: val('[data-testid="marker-x"]'),
    y: val('[data-testid="marker-y"]'),
    panelText: panel ? panel.textContent.replace(/\s+/g, ' ').trim() : '',
    provincePanel: !!document.querySelector('.province-props:not(.marker-props)'),
    hasBox: !!box,
    rows: rows.map(a => ({ title: (a.querySelector('.pv-title') || {}).textContent, path: a.getAttribute('title') })),
    empty: box ? !!box.querySelector('[data-testid="marker-vault-empty"]') : false,
    emptyText: box && box.querySelector('[data-testid="marker-vault-empty"]')
      ? box.querySelector('[data-testid="marker-vault-empty"]').textContent.replace(/\s+/g, ' ').trim() : '',
    calls: window.__vsearchCalls || [],
    deepCalls: window.__deepCalls || [],
    writes: window.__writeCalls || null,
    reader: !!document.querySelector('[data-testid="note-reader"]'),
    searchPanel: !!document.querySelector('[data-testid="note-search-panel"]'),
    searchInput: (document.querySelector('.ns-input') || {}).value || null,
    undoLabel: store && store.undoLabel ? String(store.undoLabel) : null,
  });
})()"""

MARKERS = r"""(() => {
  const s = STORE;
  const sc = s.scenarios[ID];
  return JSON.stringify({ markers: (sc && sc.markers) || [], exists: !!sc });
})()""".replace('STORE', STORE).replace('ID', json.dumps(SC_ID))

SET_NAME = r"""(() => {
  const el = document.querySelector('[data-testid="marker-name"]');
  if (!el) return 'no-el';
  el.value = NEWNAME;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()""".replace('NEWNAME', json.dumps(MARKER_NAME + '·西'))

SET_TYPE = """(() => {
  const el = document.querySelector('[data-testid="marker-type"]');
  if (!el) return 'no-el';
  el.value = 'port';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()"""

SET_X = """(() => {
  const el = document.querySelector('[data-testid="marker-x"]');
  if (!el) return 'no-el';
  el.value = '260';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()"""

# 负向探针：把坐标框**清空**再提交 —— 必须"恢复原值且不写"（`Number('')===0` 的坑）
CLEAR_Y = """(() => {
  const el = document.querySelector('[data-testid="marker-y"]');
  if (!el) return 'no-el';
  el.value = '';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()"""

CLICK_SEL = "(() => { const b = document.querySelector('%s'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()"
RESTUB_NONE = "(() => { window.__vsearchMode = 'none'; return 'ok'; })()"
RESTUB_HIT = "(() => { window.__vsearchMode = 'hit'; return 'ok'; })()"


def sub_source_guards():
    bad = []
    code = _code_only(_read(MAP))
    lore = _code_only(_read(LORE))
    store = _code_only(_read(STORE_FILE))
    hit = _code_only(_read(HIT))

    # ① 命中测试只有一份实现，且面板确实用它
    if 'function hitMarker' not in hit:
        bad.append('utils/markerHitTest.js 里没有 hitMarker（命中唯一实现）')
    seg = _fn_body(code, 'findMarkerAt')
    if not seg:
        bad.append('ScenarioMap 没有 findMarkerAt（点标记的命中入口）')
    else:
        if 'hitMarker(' not in seg:
            bad.append('findMarkerAt 没有走 hitMarker（自己又算了一遍距离？）')
        if 'MARKER_HIT_RADIUS_PX' not in seg:
            bad.append('findMarkerAt 的容差不是 MARKER_HIT_RADIUS_PX / 缩放（口径漂移）')
        for banned in ('Math.hypot(', 'Math.sqrt('):
            if banned in seg:
                bad.append(f'findMarkerAt 里出现 {banned} —— 像是第二份命中实现')

    # ② 面板三件套 + 删除 + 资料段（资料段的 testid 是**传给组件**的，不是原生属性）
    for tid in ('marker-props', 'marker-name', 'marker-type', 'marker-x', 'marker-y',
                'marker-delete'):
        if f'data-testid="{tid}"' not in code:
            bad.append(f'ScenarioMap 没有 {tid}（标记面板缺件）')

    # ③ 资料段只有一份实现：vaultIndexSearch 全仓只出现在组件里
    if 'vaultIndexSearch' in code:
        bad.append('ScenarioMap 自己又调了 vaultIndexSearch（资料段必须只有一份实现）')
    if 'vaultIndexSearch' not in lore:
        bad.append('VaultLoreSection.vue 里没有 vaultIndexSearch（只读检索）')
    for banned in ('createObsidianNote', 'setSitianConfig', 'projectSave', 'updateBaseProvince', 'execute('):
        if banned in lore:
            bad.append(f'资料段里出现写口 {banned}（必须只读）')
    if code.count('<VaultLoreSection') != 2:
        bad.append(f'两个面板应各用一次 VaultLoreSection，实际 {code.count("<VaultLoreSection")} 次')
    for tid in ('province-vault', 'marker-vault'):
        if f'testid="{tid}"' not in code:
            bad.append(f'没有把 {tid} 传给资料组件')

    # ④ 面板不直改标记对象（必须经 store 写口）
    for banned in ('selectedMarker.value.name =', 'selectedMarker.value.type =',
                   'selectedMarker.value.x =', 'selectedMarker.value.y =',
                   'selectedMarker.value.icon =', 'selectedMarker.value.color ='):
        if banned in code:
            bad.append(f'面板直接改标记对象：{banned}（绕过 execute / 写闸门）')

    # ⑤ store 写口：一条 undo + 落盘，且别把旧对象就地改掉
    if store.count('function updateScenarioMarker') != 1:
        bad.append('store 里 updateScenarioMarker 不是恰好一份')
    body = _fn_body(store, 'updateScenarioMarker')
    if not body:
        bad.append('store 没有 updateScenarioMarker')
    else:
        if 'execute(' not in body:
            bad.append('updateScenarioMarker 没走 execute（无 undo / 无写闸门）')
        if 'saveScenarios()' not in body:
            bad.append('updateScenarioMarker 没有 saveScenarios（改了但没落盘）')
        if re.search(r'oldMarker\.\w+\s*=', body):
            bad.append('updateScenarioMarker 就地改旧对象（undo 会把新值当旧值还原）')
        for banned in ('createObsidianNote', 'setSitianConfig', 'guardWrite('):
            if banned in body:
                bad.append(f'updateScenarioMarker 里出现 {banned}')
    if 'updateScenarioMarker,' not in store:
        bad.append('updateScenarioMarker 没从 store 导出（面板调不到）')
    if 'store.updateScenarioMarker(' not in code:
        bad.append('面板没有走 store.updateScenarioMarker')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '命中/资料各一份实现；面板只走 store 写口；写口一条 undo + 落盘'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')
    time.sleep(0.8)

    seed = _j(cdp, SEED)
    if not seed.get('id'):
        return False, f'造标记失败：{seed}'
    if int(seed.get('n') or 0) != 1:
        return False, f'标记没造出来：{seed}'
    _j(cdp, STUB)
    time.sleep(0.3)

    fails = []

    # ① 真点标记图标 → 面板打开
    click = _j(cdp, CLICK.replace('DX', '0'))
    if click.get('__err__'):
        return False, f'点击失败：{click}'
    time.sleep(0.5)
    st1 = _j(cdp, STATE)
    if not st1.get('panel'):
        fails.append(f'点标记没打开面板（点在了 {click}）')
    if not st1.get('hasBox'):
        fails.append('标记面板没有「资料」段')
    if st1.get('name') != MARKER_NAME:
        fails.append(f'面板名字不是那条标记：{st1.get("name")!r}')
    if st1.get('type') != 'city':
        fails.append(f'面板类型不对：{st1.get("type")!r}')
    if st1.get('x') != '200' or st1.get('y') != '200':
        fails.append(f'面板坐标不对：{st1.get("x")},{st1.get("y")}')
    if st1.get('provincePanel'):
        fails.append('标记面板打开时省份面板还开着（两块叠在同一位置）')
    if not st1.get('rows'):
        fails.append(f'标记资料没有候选：{st1.get("rows")}')
    else:
        titles = [r.get('title') for r in st1['rows']]
        if '雾隐驿' not in titles:
            fails.append(f'候选里没有「雾隐驿」：{titles}')
    if MARKER_NAME not in (st1.get('calls') or []):
        fails.append(f'检索关键词不是标记名（calls={st1.get("calls")}）')

    # ② 点偏 40px 不命中（否则"哪都能点开"）
    _j(cdp, CLICK.replace('DX', '40'))
    time.sleep(0.4)
    st2 = _j(cdp, STATE)
    if st2.get('panel'):
        fails.append('点偏 40px 仍然命中标记（命中半径形同虚设）')

    # 回到标记上：重新打开面板
    _j(cdp, CLICK.replace('DX', '0'))
    time.sleep(0.4)

    # ③ 改名字 / 类型 / 坐标 —— 全部走 store，撤销栈标签是「编辑标记」
    if _j(cdp, SET_NAME) != 'ok':
        fails.append('找不到标记名输入框')
    time.sleep(0.35)
    m1 = _j(cdp, MARKERS)
    mk = (m1.get('markers') or [{}])[0]
    if mk.get('name') != MARKER_NAME + '·西':
        fails.append(f'改名没落库：{mk.get("name")!r}')
    st3 = _j(cdp, STATE)
    if (st3.get('undoLabel') or '') != '编辑标记':
        fails.append(f'改名没进撤销栈（undoLabel={st3.get("undoLabel")!r}）')
    if MARKER_NAME + '·西' not in (st3.get('calls') or []):
        fails.append(f'改名后资料没按新名字重查（calls={st3.get("calls")}）')

    if _j(cdp, SET_TYPE) != 'ok':
        fails.append('找不到类型下拉')
    time.sleep(0.35)
    m2 = _j(cdp, MARKERS)
    mk2 = (m2.get('markers') or [{}])[0]
    if mk2.get('type') != 'port':
        fails.append(f'改类型没落库：{mk2.get("type")!r}')
    if mk2.get('icon') != 'anchor' or mk2.get('color') != '#4A90D9':
        fails.append(f'图标/颜色没跟类型走：icon={mk2.get("icon")!r} color={mk2.get("color")!r}')

    if _j(cdp, SET_X) != 'ok':
        fails.append('找不到坐标输入框')
    time.sleep(0.35)
    m3 = _j(cdp, MARKERS)
    mk3 = (m3.get('markers') or [{}])[0]
    if mk3.get('x') != 260:
        fails.append(f'改坐标没落库：x={mk3.get("x")!r}')
    if mk3.get('y') != 200:
        fails.append(f'改 x 把 y 也动了：y={mk3.get("y")!r}')

    # ③b 负向探针：清空坐标框 = 非法值 → **一个字节都不写**，输入框回到原值
    if _j(cdp, CLEAR_Y) != 'ok':
        fails.append('找不到 y 坐标输入框')
    time.sleep(0.35)
    m3b = _j(cdp, MARKERS)
    mkb = (m3b.get('markers') or [{}])[0]
    if mkb.get('y') != 200:
        fails.append(f'清空坐标却把 y 写成了 {mkb.get("y")!r}（Number("")===0 的坑）')
    st3b = _j(cdp, STATE)
    if str(st3b.get('y')) != '200':
        fails.append(f'非法值提交后输入框没恢复原值：{st3b.get("y")!r}')

    # ④ 点候选 → 阅读器；空格子 → 明确空态
    st4 = _j(cdp, STATE)
    if st4.get('rows'):
        _j(cdp, CLICK_SEL % '[data-testid=\\"marker-vault-hit\\"]')
        time.sleep(0.7)
        st5 = _j(cdp, STATE)
        if not st5.get('reader'):
            fails.append('点候选没打开阅读器')
        _j(cdp, CLICK_SEL % '[data-testid=\\"nr-close\\"]')
        time.sleep(0.3)

    _j(cdp, RESTUB_NONE)
    if _j(cdp, CLICK_SEL % '[data-testid=\\"marker-vault-search\\"]') != 'ok':
        fails.append('找不到资料段的「重查」按钮')
    time.sleep(0.6)
    st6 = _j(cdp, STATE)
    if not st6.get('empty'):
        fails.append(f'没命中时没有明确空态（{st6.get("emptyText")!r}）')
    elif '没有同名词条' not in (st6.get('emptyText') or ''):
        fails.append(f'空态文案没说明原因：{st6.get("emptyText")!r}')

    # ⑤ 「全库搜索」把标记名带进搜索面板
    _j(cdp, RESTUB_HIT)
    if _j(cdp, CLICK_SEL % '[data-testid=\\"marker-vault-global\\"]') != 'ok':
        fails.append('找不到资料段的「全库搜索」按钮')
    time.sleep(0.8)
    st7 = _j(cdp, STATE)
    if not st7.get('searchPanel'):
        fails.append('「全库搜索」没打开资料搜索面板')
    elif (st7.get('searchInput') or '') != MARKER_NAME + '·西':
        fails.append(f'搜索面板没带标记名预填：{st7.get("searchInput")!r}')
    if MARKER_NAME + '·西' not in (st7.get('deepCalls') or []):
        fails.append(f'搜索面板没真的搜这个名字（deepCalls={st7.get("deepCalls")}）')
    _j(cdp, CLICK_SEL % '.ns-close')
    time.sleep(0.3)

    # ⑥ 只读：资料检索期间不许出现"建笔记 / 改配置"
    writes = st7.get('writes') or {}
    if int(writes.get('note') or 0) > 0 or int(writes.get('cfg') or 0) > 0:
        fails.append(f'资料检索期间出现写调用：{writes}')

    # ⑦ 删除：真的消失 + 面板收起
    if _j(cdp, CLICK_SEL % '[data-testid=\\"marker-delete\\"]') != 'ok':
        fails.append('找不到删除按钮')
    time.sleep(0.5)
    m4 = _j(cdp, MARKERS)
    if (m4.get('markers') or []):
        fails.append(f'删除后标记还在：{m4.get("markers")}')
    st8 = _j(cdp, STATE)
    if st8.get('panel'):
        fails.append('删除后面板还开着')

    # 复原探针
    cdp.eval("(() => { if (window.__vsearchOrig) window.sitianAPI.vaultIndexSearch = window.__vsearchOrig; return 'ok'; })()")

    sg_ok, sg_detail = sub_source_guards()
    if not sg_ok:
        fails.append(sg_detail)

    detail = (f'点标记 → 面板（{st1.get("name")} / {st1.get("type")} / x={st1.get("x")}）；'
              f'点偏 40px 不命中={not st2.get("panel")}；'
              f'改名·类型·坐标都落库（{mk2.get("type")}/{mk2.get("icon")}，x={mk3.get("x")}），'
              f'undoLabel={st3.get("undoLabel")!r}；'
              f'资料候选 {len(st1.get("rows") or [])} 条、空态「{st6.get("emptyText")}」、'
              f'全库搜索预填「{st7.get("searchInput")}」；写调用 {writes}；源码守卫：{sg_detail}')
    if fails:
        return False, '；'.join(fails)[:900]
    return True, detail
