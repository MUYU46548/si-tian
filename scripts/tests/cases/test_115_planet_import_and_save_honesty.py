#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 115：行星视图的 `.map` 导入入口 + 保存诚实显示（2026-10-17，暮雨点名要的两件）

来源：`docs/SITIAN_MODULE_REFORM_PLAN_20261017.md` §2-P1 的前两项，第六轮交接文档 §5 的 1/2。

── 为什么要这两件 ────────────────────────────────────────────────────────────
① **起步闭环**：`.map` 导入此前只有剧本视图一条入口（装进**底图** `baseMaps[key]`），
   而行星图看的是 `mapData[planetId]` —— 另一个容器、此前**没有任何导入路径**。
   于是「空行星上想用自己的 Azgaar 地图起步」在界面上做不到；更糟的是高度笔刷会提示
   「先导入 Azgaar .map」，**指向一个当刻看不见、甚至不存在的入口**
   （与剧本侧 0.2.9 修掉的「提示指向看不见的入口」是同一类问题）。
② **保存诚实**：项目态（`.sitian`）下保存是两段的 —— geodata 把改动推给 projectStore
   （`{ staged: true, persisted: false }`），再由它的 800ms 防抖写进磁盘。
   行星图「保存地图」只看 `result.success` 就报「保存成功」= 在数据还没进磁盘时说它进了。

── 判据（不看源码也能解释清楚）───────────────────────────────────────────────
  f0 源码闸门：入口在**空态里**且是真的按钮；命名/留底/解析走**共用件**（不许组件内各写一份）；
     落库走新写口且登记进写闸门契约；保存回执必须走 `describeSaveAction`（不许再看 `result.success`）；
     旧的「指向看不见入口」的提示语必须消失
  f1 端到端：清空某行星 → 点空态「导入 .map 底图」（真按钮 + 真 File）→
     省份 / 高度图四通道 / 河流真的进了 **mapData**（不是底图）；**标记/区域/地点簇原样保留**
  f2 一条撤销：Ctrl+Z（store.undo）一次 → 省份回到 0、高度图回到导入前
  f3 覆盖语义：已有内容时弹一次确认；**取消 → 一字不动**；确认 → **替换**（不是累加）
  f4 保存诚实：stub `saveMapData` 返回 `{staged:true,persisted:false}` → 横幅必须说
     「已交给项目」且**不含**「保存成功」；返回 `persisted:true` → 才说「已保存到磁盘」

⚠️ 本用例的主探针**拆成多段**：CDP 客户端的读超时是 15s（`lib/cdp.py`），
   而"喂文件 → 等异步导入 → 断言"本身就要几秒。写成一个大 eval 会崩在
   `Connection timed out` 上而不是给出结论（这种失败最容易被误判成"环境抖动"）。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                      # noqa: E402
from lib.helpers import ensure_case_state, goto_planet, enter_edit  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PM = "document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉注释（`<!-- -->` / `//` / `/* */`）—— 判据只能对代码成立：
    注释里写「旧实现会报『保存成功』」不该被当成"代码里还有那句谎话"；
    模板注释里写「旧版提示『先导入 Azgaar .map』」也不该被判成"还在提示"。
    """
    import re
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    out, in_block = [], False
    for line in src.split('\n'):
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


# ── 一份**结构完整**的 FMG .map（合成；两省 + 一条河 + 4 格高度/温度/降水）──
# 行号锚点（解析器的 data[i] → lines 映射见 azgaar-parser 的 `at()`）：
#   gridLine = 16 → at(6)=16 / at(7)=17(cells.h) / at(8)=18(prec) / at(11)=21(temp)
MAP_LINES = [
    "1.151.2|File can be loaded in azgaar.github.io/Fantasy-Map-Generator|2026-10-17|97",
    "km|4|square|m|2|\u00b0C|||||||1000|1||||||",
    '{"latT":180,"latN":90,"latS":-90,"lonT":320,"lonW":-160,"lonE":160}',
    '[{"i":0,"name":"Marine","color":"#466eab","habitability":0}]',
    '<svg id="map" data-layer="map" width="100" height="100" version="1.1" xmlns="http://www.w3.org/2000/svg">',
    '<g id="oceanLayers">',
    '<path d="M0,0 L100,0 L100,100 L0,100 Z" id="feature_1"/>',
    '</g>',
    '<g id="provincesBody">',
    '<path d="M0,0 L50,0 L50,50 L0,50 Z" id="province1"/>',
    '<path d="M50,0 L100,0 L100,50 L50,50 Z" id="province2"/>',
    '</g>',
    '<g id="rivers">',
    '<path d="M5,5 L15,15 L25,30" id="river1"/>',
    '</g>',
    '</svg>',
    '{"cellsX":2,"cellsY":2,"spacing":5,"points":[[2,2],[7,2],[2,7],[7,7]],"count":4}',
    "30,40,10,60",          # cells.h（4 格）
    "55,60,50,40",          # prec
    "1,1,1,0",              # f
    "2,2,2,-1",             # t
    "12,8,10,15",           # temp
]
MAP_TEXT = "\n".join(MAP_LINES)


def source_gates():
    fails, notes = [], []
    pm = _code_only(_read('src/renderer/src/components/PlanetMap.vue'))
    mis = _code_only(_read('src/renderer/src/utils/mapImportSource.js'))
    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    md = _code_only(_read('src/renderer/src/store/geodataModules/mapDataEditing.js'))
    pmb = _code_only(_read('src/renderer/src/utils/planetMapBundle.js'))
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))

    # ① 入口：必须在**空态**里，且是真按钮（不是一句"请去别处导入"）
    for needle, label in [
        ('data-testid="planet-import-map"', '空态里有「导入 .map」按钮'),
        ('@click="triggerPlanetMapImport()"', '按钮真的接上了导入函数'),
        ('data-testid="planet-import-map-height"', '高度笔刷面板里也有入口（"无高度图数据"的提示必须指向看得见的地方）'),
        ('async function importPlanetMapFile(', '导入实现（读文件 → 留底 → 解析 → 落库 → 回执）'),
        ('store.importPlanetMapBundle(', '落库走 store 写口（不是在组件里直接改 mapData）'),
        ('describePlanetImportReceipt(', '回执说清导入了什么'),
        ('两个容器各存一份', '回执必须说清"行星容器 ≠ 剧本底图"'),
    ]:
        if needle not in pm:
            fails.append(f'PlanetMap 缺：{label}（`{needle}`）')

    # ② 共用件：命名 / 留底 / 读文本不许在组件里各写一份
    for needle, label in [
        ('export function mapNameFromFileName(', '「文件名 → 底图名」唯一实现'),
        ('export async function backupMapSourceFile(', '「原文留底」唯一实现'),
        ('export async function readMapSourceText(', '读文件文本的唯一入口'),
    ]:
        if needle not in mis:
            fails.append(f'mapImportSource 缺：{label}（`{needle}`）')
    for needle, label in [
        ("from '../utils/mapImportSource'", '组件用共用件（不是自己写一份）'),
        ('mapNameFromFileName(', '用共用的命名'),
        ('backupMapSourceFile(', '用共用的留底'),
    ]:
        if needle not in pm:
            fails.append(f'PlanetMap 缺：{label}（`{needle}`）')
    if '.replace(/\\.map$/i' in pm or '.replace(/\\s*\\d{4}-\\d{2}-\\d{2}' in pm:
        fails.append('PlanetMap 自己又写了一份「文件名 → 底图名」（两份实现必然漂移）')
    if 'saveBaseMapSource(' in pm:
        fails.append('PlanetMap 自己直连留底 IPC（应走 utils/mapImportSource.backupMapSourceFile）')

    # ③ 剧本侧也必须换到共用件（否则等于"新增了第二份"，只是位置不同）
    for needle, label in [
        ("from '../utils/mapImportSource'", '剧本视图也用共用件'),
        ('mapNameFromFileName(file.name)', '剧本视图用共用的命名'),
    ]:
        if needle not in sm:
            fails.append(f'ScenarioMap 缺：{label}（`{needle}`）')
    if 'async function backupMapSourceFile(' in sm:
        fails.append('ScenarioMap 里还留着本地 backupMapSourceFile（应只剩共用件那一份）')

    # ④ 写口：守卫 + 只覆盖导入清单 + 登记进写闸门契约
    for needle, label in [
        ('function importPlanetMapBundle(', '行星导入写口存在'),
        ("guardWrite('导入 .map 到行星地图')", '写口有内存写闸门'),
        ('PLANET_IMPORT_KEYS', '按导入清单写（不是整体替换 mapData）'),
    ]:
        if needle not in md:
            fails.append(f'mapDataEditing 缺：{label}（`{needle}`）')
    if 'importPlanetMapBundle' not in wg:
        fails.append('写闸门契约里没登记 importPlanetMapBundle（test_54 的反向校验也会抓）')

    # ⑤ 保存诚实：回执必须按 staged/persisted 说，不许再看 result.success 报成功
    if 'describeSaveAction(result)' not in pm:
        fails.append('PlanetMap 的保存横幅没走 describeSaveAction（唯一判定）')
    for bad in ["'保存成功'", 'result?.success ? ']:
        if bad in pm:
            fails.append(f'PlanetMap 仍在用 `{bad}` 判断保存成功（项目态下那是谎报）')

    # ⑥ 参考图层映射单源（行星导入与 importPlanetLayerData 共用）
    if 'buildAzgaarReferenceLayers(' not in pmb:
        fails.append('planetMapBundle 缺 buildAzgaarReferenceLayers')
    if 'buildAzgaarReferenceLayers(' not in se:
        fails.append('scenarioEditing.importPlanetLayerData 没走同一份映射（两处各写一份会漂移）')

    # ⑦ 旧提示（指向不可达入口）必须消失
    if '先导入 Azgaar .map' in pm:
        fails.append('行星视图还在提示「先导入 Azgaar .map」——那句话指向的是不存在的入口')

    notes.append('源码闸门 24 项' + ('全过' if not fails else f'缺 {len(fails)} 项'))
    return fails, notes


# ══ 探针 A：准备（清空 + 放三种"不该被碰"的东西）+ 点真按钮喂 File ═══════════
JS_SETUP = r"""(() => {
  const s = __STORE__, pm = __PM__;
  if (!pm) return JSON.stringify({ err: 'no-pm', fails: [] });
  const md = pm.currentMapData;
  if (!md) return JSON.stringify({ err: 'no-mapdata', fails: [] });
  const pid = md.planetId;
  // 保留标记/区域/地点簇（导入清单里没有它们 → 必须原样留着）
  s.mapData[pid] = {
    planetId: pid, version: 1,
    terrain: [],
    // ⚠️ 区域先留空：fogMode（空态提示）判的是「没有地形**且**没有区域」，
    //    放一个区域进去，空态卡片就不会出现 —— 那样测的就不是空态入口了。
    regions: [],
    markers: [{ id: 'case115-marker', x: 1, y: 1, name: '用例标记' }],
    routes: [], textLabels: [],
    clusters: [{ id: 'case115-cluster', name: '用例簇', memberIds: [] }],
    rivers: [], heightmap: null,
  };
  return JSON.stringify({ pid, fails: [] });
})()"""

JS_CLICK_IMPORT = r"""(() => {
  const TEXT = __TEXT__;
  const empty = document.querySelector('[data-testid="planet-empty-hint"]');
  const btn = document.querySelector('[data-testid="planet-import-map"]');
  if (!btn) return JSON.stringify({ err: 'no-btn', empty: !!empty, fails: [] });
  const realCreate = document.createElement.bind(document);
  let injected = false;
  document.createElement = function (tag, ...rest) {
    const el = realCreate(tag, ...rest);
    if (String(tag).toLowerCase() === 'input') {
      el.click = function () {
        injected = true;
        setTimeout(() => {
          try { el.onchange({ target: { files: [new File([TEXT], 'case115.map', { type: 'text/plain' })] } }); }
          catch (e) { window.__case115InjectErr = String(e); }
        }, 0);
      };
    }
    return el;
  };
  btn.click();
  document.createElement = realCreate;
  return JSON.stringify({ injected, emptyHint: !!empty, fails: [] });
})()"""

# ══ 探针 B：内容断言（f1 / f1b / f1c）════════════════════════════════════════
JS_ASSERT_CONTENT = r"""(() => {
  const s = __STORE__, pm = __PM__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + String(e).slice(0, 240) + ')' : '')); };
  const md = s.mapData[pm.currentMapData.planetId];
  const bannerEl = document.querySelector('[data-testid^="planet-save-banner-"]');
  const banner = { text: bannerEl ? (bannerEl.textContent || '').trim() : '', testid: bannerEl ? bannerEl.getAttribute('data-testid') : '' };

  ok('f1 ★ 省份进了**行星地图**：2 块', (md.terrain || []).length === 2, (md.terrain || []).length);
  ok('f1 省份 id 带 imp_ 前缀（与手画的 id 不同源）',
     (md.terrain || []).every(t => String(t.id).indexOf('imp_') === 0),
     JSON.stringify((md.terrain || []).map(t => t.id)));
  const hm = md.heightmap;
  ok('f1 ★ 高度图进了行星地图', !!hm, hm ? 'ok' : 'null');
  if (hm) {
    ok('f1 ★ 高度图四个通道齐全且长度 = 网格点数',
       ['h', 'temp', 'prec', 'biome'].every(k => hm[k] && hm[k].length === hm.grid.points.length),
       JSON.stringify({ h: hm.h && hm.h.length, temp: hm.temp && hm.temp.length, prec: hm.prec && hm.prec.length,
                        biome: hm.biome && hm.biome.length, pts: hm.grid.points.length }));
    ok('f1 ★ 文件里的高度值被保留（30/40/10/60）',
       Math.round(hm.h[0]) === 30 && Math.round(hm.h[3]) === 60, JSON.stringify(Array.from(hm.h)));
  }
  ok('f1 ★ 河流进了行星地图且带 nodes（drawRivers 读 nodes）',
     (md.rivers || []).length === 1 && Array.isArray(md.rivers[0].nodes) && md.rivers[0].nodes.length === 3,
     JSON.stringify((md.rivers || []).map(r => ({ id: r.id, n: (r.nodes || []).length }))));

  ok('f1b ★ 标记原样保留（导入不许删用户的标记）',
     (md.markers || []).length === 1 && md.markers[0].id === 'case115-marker', JSON.stringify(md.markers));
  ok('f1b ★ 地点簇原样保留', (md.clusters || []).length === 1 && md.clusters[0].id === 'case115-cluster', null);

  notes.receipt = banner.text.slice(0, 240);
  notes.counts = {
    terrain: (md.terrain || []).length,
    ids: (md.terrain || []).map(t => t.id),
    keys: Object.keys(s.mapData),
    pid: pm.currentMapData.planetId,
    rivers: (md.rivers || []).length,
  };
  ok('f1c ★ 导入后横幅有回执（不是一声不响）', banner.text.indexOf('已导入') >= 0, banner.text.slice(0, 140));
  ok('f1c 回执点名省份数', banner.text.indexOf('省份 2 块') >= 0, banner.text.slice(0, 180));
  ok('f1c ★ 回执说清"这是本行星的数据 / 剧本侧要另导一次"',
     banner.text.indexOf('本行星') >= 0 && banner.text.indexOf('各存一份') >= 0, banner.text.slice(0, 240));
  return JSON.stringify({ fails, notes });
})()"""

# ══ 探针 C：一条撤销 ═════════════════════════════════════════════════════════
JS_UNDO = r"""(() => {
  const s = __STORE__, pm = __PM__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + String(e).slice(0, 200) + ')' : '')); };
  s.undo();
  const md = s.mapData[pm.currentMapData.planetId];
  ok('f2 ★ 一次撤销 → 省份回到 0（一整次导入 = 一条命令）', (md.terrain || []).length === 0, (md.terrain || []).length);
  ok('f2 ★ 一次撤销 → 高度图也回到导入前（null）', !md.heightmap, md.heightmap ? 'still-there' : 'null');
  ok('f2 撤销后河流也回到 0', (md.rivers || []).length === 0, (md.rivers || []).length);
  notes.state = { terrain: (md.terrain || []).length, rivers: (md.rivers || []).length, hm: !!md.heightmap };
  return JSON.stringify({ fails, notes });
})()"""

# ══ 探针 D：再导一次（有内容）→ 取消 / 确认 ══════════════════════════════════
JS_IMPORT_AGAIN = r"""(() => {
  const s = __STORE__, pm = __PM__;
  const TEXT = __TEXT__;
  // 先放一个区域：它不在导入清单里 → 覆盖导入**不许**把它删掉
  const md = s.mapData[pm.currentMapData.planetId];
  md.regions = [{ id: 'case115-region', name: '用例区域', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] }];
  pm.importPlanetMapFile(new File([TEXT], 'case115.map', { type: 'text/plain' }));
  return JSON.stringify({ started: true, fails: [] });
})()"""

JS_CONFIRM_CANCEL = r"""(() => {
  const pm = __PM__;
  const TEXT = __TEXT__;
  window.confirm = () => false;
  pm.importPlanetMapFile(new File([TEXT], 'case115.map', { type: 'text/plain' }));
  return JSON.stringify({ started: true, fails: [] });
})()"""

JS_CONFIRM_OK = r"""(() => {
  const pm = __PM__;
  const TEXT = __TEXT__;
  window.confirm = () => true;
  pm.importPlanetMapFile(new File([TEXT], 'case115.map', { type: 'text/plain' }));
  return JSON.stringify({ started: true, fails: [] });
})()"""

JS_ASSERT_OVERWRITE = r"""(() => {
  const s = __STORE__, pm = __PM__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + String(e).slice(0, 200) + ')' : '')); };
  const md = s.mapData[pm.currentMapData.planetId];
  const bannerEl = document.querySelector('[data-testid^="planet-save-banner-"]');
  const banner = bannerEl ? (bannerEl.textContent || '').trim() : '';
  ok('f3 ★ 确认后是**替换**不是累加（仍 2 块，不是 4 块）', (md.terrain || []).length === 2, (md.terrain || []).length);
  ok('f3 替换后高度图还在', !!md.heightmap, null);
  ok('f3 ★ 覆盖导入没碰区域（regions 不在导入清单里）',
     (md.regions || []).length === 1 && md.regions[0].id === 'case115-region', JSON.stringify(md.regions));
  notes.banner = banner.slice(0, 120);
  return JSON.stringify({ fails, notes });
})()"""

# ══ 探针 E：保存诚实（staged ≠ persisted）═════════════════════════════════════
JS_SAVE = r"""(() => {
  const s = __STORE__, pm = __PM__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + String(e).slice(0, 200) + ')' : '')); };
  if (!pm.editMode && pm.enterEditMode) pm.enterEditMode();
  window.__case115OrigSave = s.saveMapData;
  window.__case115ClickSave = (result) => {
    s.saveMapData = async () => result;
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.title || '').indexOf('保存地图') >= 0);
    if (!b) return { err: 'no-save-btn' };
    b.click();
    return { clicked: true };
  };
  return JSON.stringify({ fails, notes, editMode: !!pm.editMode });
})()"""

JS_SAVE_READ = r"""(() => {
  const el = document.querySelector('[data-testid^="planet-save-banner-"]');
  return JSON.stringify({
    fails: [],
    text: el ? (el.textContent || '').trim() : '',
    testid: el ? el.getAttribute('data-testid') : '',
  });
})()"""

JS_SAVE_CALL = r"""(() => {
  const f = window.__case115ClickSave;
  if (!f) return JSON.stringify({ err: 'no-hook', fails: [] });
  return JSON.stringify(Object.assign({ fails: [] }, f(__RESULT__)));
})()"""

JS_SAVE_RESTORE = r"""(() => {
  const s = __STORE__;
  if (window.__case115OrigSave) s.saveMapData = window.__case115OrigSave;
  delete window.__case115OrigSave;
  delete window.__case115ClickSave;
  window.confirm = () => true;
  return JSON.stringify({ ok: true, fails: [] });
})()"""


def _js(template, text=MAP_TEXT):
    return (template.replace('__STORE__', STORE).replace('__PM__', PM)
            .replace('__TEXT__', json.dumps(text)))


def _eval(cdp, js, desc):
    ok, res = eval_json(cdp, js, desc=desc)
    if not ok:
        return None, f'{desc}求值失败: {res}'
    return res, None


def run(cdp):
    fails, notes = source_gates()

    ok_state, info = ensure_case_state(cdp)
    if not ok_state:
        return False, f'harness 基线项目未就绪：{info}'

    level = goto_planet(cdp)
    if level != 'planet':
        return False, f'导航行星失败: {level}'
    wait_for(cdp, "!!document.querySelector('.planet-map-container')", desc='PlanetMap 挂载', timeout=20)
    time.sleep(0.6)

    # ── A. 准备 + 点空态真按钮喂文件 ──────────────────────────────────────────
    res, err = _eval(cdp, _js(JS_SETUP), '115 准备')
    if err:
        return False, err
    if res.get('err'):
        return False, f'装置未就绪：{res}'

    res, err = _eval(cdp, _js(JS_CLICK_IMPORT), '115 点空态导入按钮')
    if err:
        return False, err
    if res.get('err') == 'no-btn':
        return False, f'空态里找不到「导入 .map 底图」按钮（空态提示在？{res.get("empty")}）'
    if not res.get('injected'):
        return False, f'按钮没有打开文件选择器（{res}）'

    # 导入是异步的（留底 → 解析 → 落库）：等省份出现
    try:
        wait_for(cdp, f"(__STORE__ && (__STORE__.mapData[__PM__.currentMapData.planetId].terrain || []).length > 0)"
                      .replace('__STORE__', STORE).replace('__PM__', PM),
                 timeout=15, desc='导入落库')
    except RuntimeError as e:
        return False, f'导入没有落库：{e}'
    time.sleep(0.4)

    # ── B. 内容断言 ──────────────────────────────────────────────────────────
    res, err = _eval(cdp, _js(JS_ASSERT_CONTENT), '115 内容断言')
    if err:
        return False, err
    fails += [str(x) for x in res.get('fails', [])]
    if res.get('notes', {}).get('receipt'):
        notes.append(f'回执="{res["notes"]["receipt"][:140]}"')

    # ── C. 一条撤销 ──────────────────────────────────────────────────────────
    res, err = _eval(cdp, _js(JS_UNDO), '115 撤销')
    if err:
        fails.append(err)
    else:
        fails += [str(x) for x in res.get('fails', [])]

    # ── D. 再导一次（有内容）→ 取消 → 确认 ───────────────────────────────────
    res, err = _eval(cdp, _js(JS_IMPORT_AGAIN), '115 再导入一次')
    if err:
        fails.append(err)
    else:
        try:
            wait_for(cdp, f"(__STORE__.mapData[__PM__.currentMapData.planetId].terrain || []).length === 2"
                          .replace('__STORE__', STORE).replace('__PM__', PM), timeout=15, desc='第二次导入')
        except RuntimeError as e:
            fails.append(f'第二次导入没落库：{e}')

    res, err = _eval(cdp, _js(JS_CONFIRM_CANCEL), '115 覆盖确认-取消')
    if err:
        fails.append(err)
    time.sleep(1.2)
    res, err = _eval(cdp, '''(() => {
      const s = __STORE__, pm = __PM__;
      const md = s.mapData[pm.currentMapData.planetId];
      const el = document.querySelector('[data-testid^="planet-save-banner-"]');
      return JSON.stringify({
        fails: [],
        provinces: (md.terrain || []).length,
        banner: el ? (el.textContent || '').trim() : '',
      });
    })()'''.replace('__STORE__', STORE).replace('__PM__', PM), '115 取消后读数')
    if err:
        fails.append(err)
    else:
        if res.get('provinces') != 2:
            fails.append(f'f3 ★ 取消覆盖后地图被改了（省份 {res.get("provinces")} ≠ 2）')
        if '取消' not in str(res.get('banner', '')):
            fails.append(f'f3 取消覆盖没有回执（横幅="{res.get("banner", "")[:60]}"）')

    res, err = _eval(cdp, _js(JS_CONFIRM_OK), '115 覆盖确认-确认')
    if err:
        fails.append(err)
    time.sleep(1.4)
    res, err = _eval(cdp, _js(JS_ASSERT_OVERWRITE), '115 覆盖后断言')
    if err:
        fails.append(err)
    else:
        fails += [str(x) for x in res.get('fails', [])]

    # ── E. 保存诚实 ──────────────────────────────────────────────────────────
    res, err = _eval(cdp, _js(JS_SAVE), '115 保存钩子')
    if err:
        fails.append(err)
    else:
        time.sleep(0.4)
        for label, payload, want_text, want_testid in [
            ('staged', {'success': True, 'staged': True, 'persisted': False}, '已交给项目', 'planet-save-banner-warn'),
            ('persisted', {'success': True, 'staged': True, 'persisted': True}, '已保存到磁盘', 'planet-save-banner-ok'),
            ('failed', {'success': False, 'error': 'EBUSY: 磁盘被占用'}, '保存失败', 'planet-save-banner-err'),
        ]:
            call, err = _eval(cdp, JS_SAVE_CALL.replace('__RESULT__', json.dumps(payload)).replace('__STORE__', STORE), f'115 保存-{label}')
            if err:
                fails.append(err)
                continue
            if call.get('err'):
                fails.append(f'装置：找不到「保存地图」按钮（{call}）')
                continue
            time.sleep(0.5)
            read, err = _eval(cdp, JS_SAVE_READ, f'115 读横幅-{label}')
            if err:
                fails.append(err)
                continue
            text, testid = read.get('text', ''), read.get('testid', '')
            notes.append(f'{label}: 「{text}」/ {testid}')
            if want_text not in text:
                fails.append(f'f4 {label} → 横幅应含「{want_text}」（实际「{text[:80]}」）')
            if label == 'staged' and ('保存成功' in text or '已保存到磁盘' in text):
                fails.append(f'f4 ★ staged 时说了已落盘的话（实际「{text[:80]}」）')
            if testid != want_testid:
                fails.append(f'f4 {label} → 档位应是 {want_testid}（实际 {testid}）')

    _eval(cdp, JS_SAVE_RESTORE.replace('__STORE__', STORE), '115 还原 stub')

    if fails:
        return False, f'断言失败 {len(fails)} 项：' + '；'.join(fails[:8])
    return True, ' | '.join(notes)
