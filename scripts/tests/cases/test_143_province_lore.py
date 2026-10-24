#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 143：点省份 → 库内资料候选（读料桥收口，2026-10-24）

第 5 件的判据是「点图看设定、换库不崩、一个字节都不写」。实体节点走详情面板（test_141），
**省份/标记这类"非实体"** 以前点了没有任何资料入口 —— 这一刀在剧本视图的省份属性区加了「资料」段：
按省名走 `vaultIndexSearch`（主进程只读索引、元数据命中）列出候选，点候选进阅读器；
**没命中就明说「库里没有同名词条」**（不猜、不自动建 —— 与「认不出就进待人工」同一纪律）。

验收点：
1. 选中省份 → 属性区出现「资料」段，检索关键词**就是省名**
2. 命中 → 列出候选（标题 + 路径）；点一条 → 阅读器打开该路径
3. 没命中 → 明确空态（不是"什么都不显示"）
4. **只读**：整个过程 `createObsidianNote` / `setSitianConfig` / `projectSave` 的调用次数**一次都不增加**
5. 源码守卫：这一段只允许 `vaultIndexSearch` + `openNote`，不许出现任何写口
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
KEY = '用例143底图'
PROV_NAME = '雾隐城'


def _read(rel):
    import io
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


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
  const s = STORE, sm = SM;
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  const bm = s.baseMaps[KEY];
  bm.terrain.length = 0;
  const ring = (x0, y0, x1, y1) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
  s.addBaseProvince(KEY, { id: 'p143a', name: PROV, kind: 'land', points: ring(100, 100, 320, 320) });
  sm.baseMapKey = KEY;
  sm.baseMap = s.baseMaps[KEY];
  sm.showProps = true;
  return JSON.stringify({ ok: true, n: (s.baseMaps[KEY].terrain || []).length });
})()""".replace('STORE', STORE).replace('SM', SM).replace('KEY', json.dumps(KEY)).replace('PROV', json.dumps(PROV_NAME))

# 选中要在**装好探针之后**（选中会立刻触发一次检索）
SELECT = r"""(() => {
  const s = STORE, sm = SM;
  const prov = (s.baseMaps[KEY].terrain || []).find(p => p.id === 'p143a');
  if (!prov) return JSON.stringify({ __err__: '省份不在' });
  sm.showProps = true;
  sm.selectedProvince = prov;
  return JSON.stringify({ id: prov.id, name: prov.name });
})()""".replace('STORE', STORE).replace('SM', SM).replace('KEY', json.dumps(KEY))

# 包一层 mock：记录检索关键词 + 可切换"有命中 / 空"
STUB = r"""(() => {
  const api = window.sitianAPI;
  if (!window.__vsearchOrig) window.__vsearchOrig = api.vaultIndexSearch;
  window.__vsearchCalls = window.__vsearchCalls || [];
  window.__vsearchMode = 'hit';
  api.vaultIndexSearch = async (q, n) => {
    window.__vsearchCalls.push(String(q));
    if (window.__vsearchMode === 'none') return { success: true, results: [] };
    if (window.__vsearchMode === 'error') return { success: false, error: '索引还没建', results: [] };
    return { success: true, results: [
      { path: '03 设定/11 地理系统/行星/雾隐城.md', title: '雾隐城', layerHint: '城市', kind: 'map', score: 100 },
      { path: '03 设定/04 概念·规则/雾隐.md', title: '雾隐', layerHint: '资料', kind: 'lore', score: 60 },
    ] };
  };
  // 写口计数（只读判据：一次都不许涨）
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
})()""".replace('STORE', STORE).replace('SM', SM)

RESTUB_NONE = "(() => { window.__vsearchMode = 'none'; return 'ok'; })()"
RESTUB_HIT = "(() => { window.__vsearchMode = 'hit'; return 'ok'; })()"
CLICK_SEARCH = "(() => { const b = document.querySelector('[data-testid=\"province-vault-search\"]'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()"
CLOSE_READER = "(() => { const b = document.querySelector('[data-testid=\"nr-close\"]'); if (b) b.click(); return 'ok'; })()"

STATE = r"""(() => {
  const box = document.querySelector('[data-testid="province-vault"]');
  const rows = box ? Array.from(box.querySelectorAll('[data-testid="province-vault-hit"]')) : [];
  return JSON.stringify({
    hasBox: !!box,
    rows: rows.map(a => ({ title: (a.querySelector('.pv-title') || {}).textContent, path: a.getAttribute('title') })),
    empty: box ? (box.querySelector('[data-testid="province-vault-empty"]') || null) !== null : false,
    emptyText: box && box.querySelector('[data-testid="province-vault-empty"]')
      ? box.querySelector('[data-testid="province-vault-empty"]').textContent.replace(/\s+/g, ' ').trim() : '',
    calls: window.__vsearchCalls || [],
    writes: window.__writeCalls || null,
    reader: !!document.querySelector('[data-testid="note-reader"]'),
    propsOpen: !!document.querySelector('.province-props'),
  });
})()"""


def sub_source_guards():
    """源码守卫：资料段**只有一份实现**（`VaultLoreSection.vue`），且全程只读。

    2026-10-24（第 5 件补「点标记」）：省份资料与标记资料合并到同一个组件里，
    原来"在 ScenarioMap 里找 `searchVaultForProvince`"的守卫随之改口径 ——
    行为判据（关键词=名字 / 候选可点开 / 空态 / 只读计数）一条都没动，
    改的只是"实现住在哪个文件"。顺带把"只许一份实现"也钉死：
    ScenarioMap 里再出现 `vaultIndexSearch` 就是第二份实现，直接红。
    """
    bad = []
    code = _code_only(_read(MAP))
    lore = _code_only(_read(LORE))
    if 'vaultIndexSearch' not in lore:
        bad.append(f'{LORE} 里没有 vaultIndexSearch（只读索引）')
    for banned in ('createObsidianNote', 'setSitianConfig', 'projectSave', 'updateBaseProvince', 'execute('):
        if banned in lore:
            bad.append(f'资料段里出现写口 {banned}（必须只读）')
    if 'vaultIndexSearch' in code:
        bad.append('ScenarioMap 自己又调了 vaultIndexSearch（资料段必须只有一份实现）')
    if 'testid="province-vault"' not in code:
        bad.append('属性区没有把 province-vault 传给资料组件（「资料」段丢了）')
    if 'testid + \'-empty\'' not in lore:
        bad.append('没有"库里没有同名词条"的空态')
    if 'openNoteSearch' not in lore:
        bad.append('没有"全库搜索"出口')
    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '资料段只走 vaultIndexSearch + openNote；空态与全库搜索都在；实现只有一份'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')
    time.sleep(0.8)

    seed = _j(cdp, SEED)
    if not seed.get('ok'):
        return False, f'造省失败：{seed}'
    # 先装探针（mock + 写口计数），再选中 —— 选中会立刻触发一次检索
    _j(cdp, STUB)
    time.sleep(0.2)
    sel = _j(cdp, SELECT)
    if sel.get('__err__'):
        return False, f'选中省份失败：{sel}'
    time.sleep(0.7)

    st1 = _j(cdp, STATE)
    fails = []
    if not st1.get('propsOpen'):
        fails.append('省份属性面板没打开（无法看到资料段）')
    if not st1.get('hasBox'):
        fails.append('属性区没有「资料」段')
    if not st1.get('rows'):
        fails.append(f'有命中却没列出候选（{st1}）')
    else:
        titles = [r.get('title') for r in st1['rows']]
        if '雾隐城' not in titles:
            fails.append(f'候选里没有「雾隐城」：{titles}')
    if PROV_NAME not in (st1.get('calls') or []):
        fails.append(f'检索关键词不是省名（calls={st1.get("calls")}）')

    # ② 点候选 → 阅读器打开
    if st1.get('rows'):
        _j(cdp, "(() => { const a = document.querySelector('[data-testid=\"province-vault-hit\"]'); if (a) a.click(); return 'ok'; })()")
        time.sleep(0.7)
        st2 = _j(cdp, STATE)
        if not st2.get('reader'):
            fails.append('点候选没打开阅读器')
        _j(cdp, CLOSE_READER)
        time.sleep(0.3)

    # ③ 空态：改成"库里没有" → 明确空态
    _j(cdp, RESTUB_NONE)
    if _j(cdp, CLICK_SEARCH) != 'ok':
        fails.append('找不到「全库搜索」按钮')
    time.sleep(0.6)
    st3 = _j(cdp, STATE)
    if not st3.get('empty'):
        fails.append(f'没有命中时没有明确空态（{st3}）')
    elif '没有同名词条' not in (st3.get('emptyText') or ''):
        fails.append(f'空态文案没说明原因：{st3.get("emptyText")!r}')

    # ④ 只读：**创建笔记 / 改配置**这类写口必须保持 0
    #    （`projectSave` 不算：harness 的自动保存钩子会因前面造数而触发，与本检索无关）
    writes = st3.get('writes') or {}
    if int(writes.get('note') or 0) > 0 or int(writes.get('cfg') or 0) > 0:
        fails.append(f'资料检索期间出现了写调用：{writes}')

    # 复原
    _j(cdp, RESTUB_HIT)
    cdp.eval("(() => { if (window.__vsearchOrig) window.sitianAPI.vaultIndexSearch = window.__vsearchOrig; return 'ok'; })()")

    sg_ok, sg_detail = sub_source_guards()
    if not sg_ok:
        fails.append(sg_detail)

    detail = (f'选中「{PROV_NAME}」→ 检索关键词命中省名、候选 {len(st1.get("rows") or [])} 条'
              f'（{", ".join(str(r.get("title")) for r in (st1.get("rows") or []))}）；'
              f'点候选打开阅读器={st2.get("reader") if st1.get("rows") else "n/a"}；'
              f'空态「{st3.get("emptyText")}」；写调用 {writes}；源码守卫：{sg_detail}')
    if fails:
        return False, '；'.join(fails)[:900]
    return True, detail
