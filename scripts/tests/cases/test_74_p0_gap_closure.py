#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 74：P0 三条「提过多次但从未实装」的修复（R5 / R6 / R7）

来源：`docs/IMPROVEMENT_BACKLOG.md` §四 的稽核清单。这三条的共同症状都是**静默**——
点了没反应、导出再导入丢东西、删了节点数据永久留下，全都不报错。

覆盖：
  f0 源码守卫：R5/R6/R7 的**接线**确实在（三层视图暴露 renderer、App 声明三个 ref、
     `getActiveRenderer` 覆盖六层、导出带 parentId、删节点清理孤儿数据且撤销回灌）
  f1 R5 书签：行星层能拿到 renderer（旧实现恒 null）→ 加书签带**锚点**→
     同层跳转相机**逐值复原**→ 跨层跳转能切视图→ 世界选择页（无画布）**给可见原因**而不是静默 return
  f2 R6 导出配置：导出的节点带 `parentId` 等编辑侧字段（旧实现无 parentId → 层级整片丢失）→
     导入端**新建缺失实体**并复原层级 → 一条 undo 整体还原
  f3 R7 删节点孤儿数据：画布删除连带清 `mapData` / `interiorData`，undo 逐值还原；
     项目面板删除同样把画布侧活副本清掉（否则下一次保存会把孤儿**写回去**），undo 两半都还
"""
import sys, os, io, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib import helpers as H  # noqa: E402
from lib.cdp import wait_for, eval_json  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

APP = "document.querySelector('#app').__vue_app__"
APP_ST = "document.querySelector('#app').__vue_app__._instance.setupState"


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    out, i, n, in_block = [], 0, len(src), False
    while i < n:
        c = src[i]
        if in_block:
            if c == '*' and i + 1 < n and src[i + 1] == '/':
                in_block, i = False, i + 2
                continue
            out.append('\n' if c == '\n' else ' ')
            i += 1
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            in_block, i = True, i + 2
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            while i < n and src[i] != '\n':
                i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def sub_source_guards(cdp):
    import re as _re
    app = _code_only(_read('src/renderer/src/App.vue'))
    geo = _code_only(_read('src/renderer/src/store/geodata.js'))
    proj = _code_only(_read('src/renderer/src/store/projectStore.js'))
    bad = []

    # ── R5 ──
    for f, name in [('PlanetMap', 'PlanetMap.vue'), ('AreaMap', 'AreaMap.vue'), ('InteriorView', 'InteriorView.vue')]:
        src = _code_only(_read(f'src/renderer/src/components/{name}'))
        if not _re.search(r'defineExpose\(\{[^}]*renderer', src):
            bad.append(f'{name} 没有 defineExpose({{ canvas, renderer }})（书签取不到相机）')
    for v in ['planetMapRef = ref', 'areaMapRef = ref', 'interiorViewRef = ref']:
        if v not in app:
            bad.append(f'App.vue 未声明 {v.split(" =")[0]}（模板 ref 绑不上 → 恒 null）')
    for lv in ["'planet'", "'area'", "'interior'"]:
        if lv not in app.split('function getActiveRenderer')[1].split('function getActiveCanvas')[0]:
            bad.append(f'getActiveRenderer 未覆盖 {lv}')
    # 「不再静默」：两个书签入口都必须有可见回音
    for fn in ['handleAddBookmark', 'handleBookmarkNavigate']:
        seg = app.split(f'function {fn}')[1][:2600] if f'function {fn}' in app else ''
        if not seg:
            bad.append(f'找不到 {fn}()')
        elif 'bookmarkStatus(' not in seg:
            bad.append(f'{fn}() 里没有可见回音（静默 return 是这条缺陷的本体）')

    # ── R6 ──
    if 'function buildMapConfig' not in app:
        bad.append('App.vue 没有 buildMapConfig()（导出载荷无法被往返用例复用 → 导出端漏字段测不出来）')
    if 'handleExportMapConfig' in app and 'buildMapConfig()' not in app.split('function handleExportMapConfig')[1][:400]:
        bad.append('handleExportMapConfig 没有走 buildMapConfig()（存在第二处载荷构造）')
    seg = app.split('function configNodeOf')[1][:900] if 'function configNodeOf' in app else ''
    # 必须断言**取值**，不能只断言「出现了 parentId:」——`parentId: null` 也能过（实测漏掉过一次）
    if not _re.search(r'parentId:\s*n\.parentId', seg):
        bad.append('configNodeOf 没有把 parentId 取自节点（层级会整片丢失）')
    if 'store.entityToNode(' not in app:
        bad.append('导入端没有用 store.entityToNode() 还原节点（形状会有第二份定义）')

    # ── R7 ──
    rem = geo.split('function removeNode')[1][:3000] if 'function removeNode' in geo else ''
    if 'deleteOrphans' not in rem or 'restoreOrphans' not in rem:
        bad.append('removeNode 没有「清孤儿 / 撤销回灌」两半')
    if 'pruneData' not in geo or 'mergeData' not in geo:
        bad.append('画布适配器没有注册 pruneData / mergeData（项目侧删除无法清画布活副本）')
    if 'adapter.pruneData' not in proj and 'pruneData(' not in proj:
        bad.append('projectStore.deleteEntity 没有清孤儿数据')

    return (False, '；'.join(bad)) if bad else (True, 'R5 三层暴露+六层 renderer+去静默 / R6 parentId+entityToNode / R7 两半成对')


# ══════════════════════════════════════════════════════════════════
# f1~f3 端到端
# ══════════════════════════════════════════════════════════════════
JS = r"""(async () => {
  const fails = [], notes = [];
  const ck = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' → ' + JSON.stringify(e) : '')); };
  const same = (l, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(l + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));

  const APP = __APP__;
  const st = APP._instance.setupState;
  const store = st.store;
  const pinia = APP.config.globalProperties.$pinia;
  const PM = await import('/src/store/projectStore.js');
  const proj = PM.useProjectStore(pinia);

  // ══ f1 R5：书签 ══════════════════════════════════════════════════
  const planet = store.planets[0];
  ck('装置：存在行星节点', !!planet, null);
  store.selectPlanet(planet);
  // PlanetMap 是异步组件：等它真的挂上（固定 sleep 会在慢机器上假红）
  for (let i = 0; i < 30 && !document.querySelector('.planet-map-container'); i++) await tick(100);
  const pmEl = document.querySelector('.planet-map-container');
  ck('装置：行星图已挂载', !!pmEl, null);
  const pm = pmEl ? pmEl.__vueParentComponent.setupState : null;

  ck('f1 ★ 行星层能取到 renderer（旧实现恒 null → 书签静默失效）',
     !!(st.getActiveRenderer && st.getActiveRenderer()), null);
  ck('f1 行星层的 renderer 与组件暴露的是同一个', !!(pm && st.getActiveRenderer() === pm.renderer), null);

  // 同层：相机逐值复原
  // ⚠️ 取不到 renderer 时**不要直接往下调用**（会变成 "reading 'focusOn' of null" 的裸异常，
  //    探针只能看到一句栈，看不出是哪条 R5 断言挂了）→ 显式判空并记一条具名失败。
  const R = st.getActiveRenderer();
  if (!R) {
    ck('f1 ★ 行星层能取到 renderer（取不到则整段相机断言无法进行）', false, null);
  } else {
    R.focusOn(137, 251, 2.5);
    const vt = R.getViewTransform();
    const n0 = st.bookmarks.length;
    st.handleAddBookmark();
    await tick(60);
    ck('f1 加书签成功', st.bookmarks.length === n0 + 1, st.bookmarks.length);
    const bm = st.bookmarks[st.bookmarks.length - 1];
    ck('f1 书签记了所属层级', bm.viewLevel === 'planet', bm.viewLevel);
    ck('f1 ★ 书签记了**锚点实体**（跨层跳转全靠它）', bm.anchorId === planet.id, bm.anchorId);

    R.focusOn(0, 0, 1);
    st.handleBookmarkNavigate(bm);
    await tick(120);
    same('f1 ★ 同层跳转：相机逐值复原', st.getActiveRenderer().getViewTransform(), vt);

    // 跨层：从 domain 跳到 planet
    store.selectWorld(store.worlds[0]);
    await tick(250);
    ck('装置：已切到星域总览', store.viewLevel === 'domain', store.viewLevel);
    st.handleBookmarkNavigate(bm);
    await tick(500);
    ck('f1 ★ 跨层跳转把视图切到了行星地图', store.viewLevel === 'planet', store.viewLevel);
    ck('f1 跨层跳转给了成功回音（不是静默）', st.statusKind === 'ok', st.statusKind);
  }

  // 世界选择页没有画布 → 必须给原因
  store.backToWorld();
  await tick(200);
  const n1 = st.bookmarks.length;
  st.handleAddBookmark();
  await tick(60);
  ck('f1 世界选择页加书签被拒（不新增书签）', st.bookmarks.length === n1, st.bookmarks.length);
  ck('f1 ★ 被拒时给出可见原因（旧实现直接 return，什么都不说）',
     st.statusKind === 'err' && /画布|书签/.test(st.statusText), { k: st.statusKind, t: st.statusText });

  // ══ f2 R6：导出配置带层级 + 导入新建缺失实体 ══════════════════════
  const worldNode = store.nodes.find(n => n.layer === 'world');
  const planetNode = store.nodes.find(n => n.layer === 'planet');
  ck('装置：有 world 与 planet 节点', !!(worldNode && planetNode), null);
  // ⚠️ 层级的**真值**要从数据里读，不能假设行星挂在世界下（fixture 里实际挂在星系下）
  const planetParent = planetNode.parentId;
  ck('装置：行星节点确有父级（否则「层级往返」这条断言无意义）', !!planetParent, planetParent);

  // ★ 用**真实导出载荷**做往返 —— 手写配置测不出「导出端漏字段」
  //   （实测教训：把 configNodeOf 的 parentId 改成恒 null，手写配置的版本照样全绿）
  const cfg = st.buildMapConfig();
  const shaped = (cfg.nodes || []).find(n => n.id === planetNode.id) || {};
  ck('f2 导出载荷含全部节点', (cfg.nodes || []).length === store.nodes.length,
     { cfg: (cfg.nodes || []).length, canvas: store.nodes.length });
  ck('f2 ★ 导出节点的 parentId 是**真值**（不是只有键、值为 null）',
     shaped.parentId === planetParent, { got: shaped.parentId, want: planetParent });
  ck('f2 导出节点带 layer/layerLabel', shaped.layer === 'planet' && !!shaped.layerLabel, shaped.layer);
  ck('f2 导出不带 draft（由 sourcePath 派生）', !('draft' in shaped), Object.keys(shaped));
  const parentedInCfg = cfg.nodes.filter(n => n.parentId).length;
  ck('f2 ★ 导出载荷里**有层级关系**（整份全 null = 层级丢失）', parentedInCfg > 0,
     { parented: parentedInCfg, total: cfg.nodes.length });

  // 往真实载荷里加一个新实体：导入端应当**新建**它，并挂到行星下
  const NEW_ID = 'r6_new_place';
  cfg.nodes.push({
    id: NEW_ID, name: 'R6新地点', layer: 'place', parentId: planetNode.id,
    layerLabel: '地点', coordinate: { x: 11, y: 22 }, tags: ['t'],
    wikilinks: ['某词条'], sourcePath: '',
  });

  ck('装置：导入前新节点不存在', !store.nodes.some(n => n.id === NEW_ID), null);

  // 捕获 handleImportMapConfig 建出来的 <input>，喂一个假 File
  const origCreate = document.createElement.bind(document);
  let fakeInput = null;
  document.createElement = (tag) => {
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'input') { fakeInput = el; el.click = () => {}; }
    return el;
  };
  st.handleImportMapConfig();
  document.createElement = origCreate;
  ck('装置：拿到了导入用的 input', !!fakeInput, null);
  fakeInput.onchange({ target: { files: [{ text: async () => JSON.stringify(cfg) }] } });
  await tick(400);

  const created = store.nodes.find(n => n.id === NEW_ID);
  ck('f2 ★ 导入**新建了缺失实体**（旧实现只更新已存在节点 → 换台机器导入后什么都没有）', !!created, null);
  if (created) {
    same('f2 新建节点的层级正确（挂到行星下）', created.parentId, planetNode.id);
    same('f2 新建节点的坐标正确', created.coordinate, { x: 11, y: 22 });
    same('f2 新建节点带上了编辑侧字段（wikilinks）', created.wikilinks, ['某词条']);
    ck('f2 无 sourcePath → 视为暂存节点（draft）', created.draft === true, created.draft);
  }
  same('f2 已存在节点的层级保持不变', store.nodes.find(n => n.id === planetNode.id).parentId, planetParent);
  // ★ 往返不变式：导入后画布上的父子关系应当与导出载荷**逐条一致**
  const mismatched = cfg.nodes.filter(n => {
    const cur = store.nodes.find(x => x.id === n.id);
    return cur && (cur.parentId || null) !== (n.parentId || null);
  });
  ck('f2 ★ 往返后所有节点的 parentId 与导出载荷一致', mismatched.length === 0,
     mismatched.slice(0, 3).map(n => ({ id: n.id, want: n.parentId })));

  store.undo();
  await tick(120);
  ck('f2 ★ 一条 undo 把新建的实体整体撤回', !store.nodes.some(n => n.id === NEW_ID), null);
  same('f2 undo 也复原了已存在节点的层级', store.nodes.find(n => n.id === planetNode.id).parentId, planetParent);
  store.redo();
  await tick(120);
  ck('f2 redo 又把它加回来', store.nodes.some(n => n.id === NEW_ID), null);
  store.undo();
  await tick(150);
  notes.push('f2 导入新建后已在 undo 中收回');;

  // ══ f3 R7：删节点连带清孤儿数据 ══════════════════════════════════
  // 两条删除路径用**各自独立**的夹具：串在同一份数据上时，前一段的 removeNode/undo 会通过
  // 防抖保存把中间态推给项目，导致后一段的 `descendantsOf` 拿到的是被改过的父子关系
  // （实测踩到：建筑没被算进后代 → interiorData 没被清 → 断言红，但原因是测试自己串味）。
  const mk = (id, name, layer, parentId) => store.addNode({
    id, name, layer, parentId, tags: [], sourcePath: '', coordinate: { x: 0, y: 0 },
  });

  // ── f3a 画布路径（removeNode 自带 undo）──
  const P7 = 'r7_planet', R7 = 'r7_region', B7 = 'r7_building';
  mk(P7, 'R7行星', 'planet', worldNode.id);
  mk(R7, 'R7区域', 'region', P7);
  mk(B7, 'R7建筑', 'building', R7);
  store.mapData[P7] = { terrain: [{ id: 't1' }], markers: [] };
  store.areaZones[R7] = [{ id: 'z1' }];
  store.interiorData[B7] = { buildingId: B7, floors: [{ id: 'f1' }] };
  await tick(120);

  const mdCopy = JSON.parse(JSON.stringify(store.mapData[P7]));
  store.removeNode(P7);
  await tick(150);
  ck('f3a 节点已删除', !store.nodes.some(n => n.id === P7), null);
  ck('f3a ★ 它的 mapData 被一起清掉（旧实现永久留下）', !(P7 in store.mapData), Object.keys(store.mapData));
  ck('f3a 子节点仍在（未连带删除）', store.nodes.some(n => n.id === R7), null);
  ck('f3a 子节点的区域数据**不该**被误删', !!(store.areaZones[R7]), null);

  store.undo();
  await tick(150);
  ck('f3a 撤销后节点回来了', store.nodes.some(n => n.id === P7), null);
  ck('f3a ★ 撤销把 mapData 逐值还原', !!store.mapData[P7], null);
  same('f3a 还原的是同一份内容', store.mapData[P7], mdCopy);

  store.removeNode(B7);
  await tick(150);
  ck('f3a ★ 删建筑连带清 interiorData', !(B7 in store.interiorData), Object.keys(store.interiorData));
  store.undo();
  await tick(150);
  ck('f3a 撤销后 interiorData 回来', !!(store.interiorData[B7] && store.interiorData[B7].floors), null);

  // ── f3b 项目面板路径（画布是活副本，必须一起清）──
  const P8 = 'r7b_planet', R8 = 'r7b_region', B8 = 'r7b_building';
  mk(P8, 'R7B行星', 'planet', worldNode.id);
  mk(R8, 'R7B区域', 'region', P8);
  mk(B8, 'R7B建筑', 'building', R8);
  store.mapData[P8] = { terrain: [{ id: 't8' }] };
  store.areaZones[R8] = [{ id: 'z8' }];
  store.interiorData[B8] = { buildingId: B8, floors: [{ id: 'f8' }] };
  if (typeof store.flushSave === 'function') store.flushSave();
  await tick(700);
  ck('f3b 装置：项目侧已有这三个实体且父子关系正确（否则「项目删除」路径测成空转）',
     !!(proj.entities[P8] && proj.entities[R8] && proj.entities[B8]),
     { p: !!proj.entities[P8], r: !!proj.entities[R8], b: !!proj.entities[B8] });
  ck('f3b 装置：后代链完整（P8 → R8 → B8）',
     proj.entities[R8].parentId === P8 && proj.entities[B8].parentId === R8,
     { r: proj.entities[R8].parentId, b: proj.entities[B8].parentId });

  const res = proj.deleteEntity(P8, { cascade: true });
  await tick(300);
  ck('f3b 项目删实体成功', !!(res && res.success), res);
  ck('f3b 连带删掉了整条后代链', (res.deleted || []).length === 3, res.deleted);
  ck('f3b ★ 项目删除后**画布侧**活副本也被清（否则保存会把孤儿写回去）',
     !(P8 in store.mapData) && !(R8 in store.areaZones) && !(B8 in store.interiorData),
     { md: P8 in store.mapData, az: R8 in store.areaZones, it: B8 in store.interiorData });
  ck('f3b 回执里报了清理份数（不静默删数据）', (res && res.cleanedData > 0), res && res.cleanedData);

  store.undo();
  await tick(400);
  ck('f3b ★ 撤销项目删除：数据两半都还回来（只清不还 = 撤销即数据丢失）',
     !!(store.mapData[P8] && store.areaZones[R8] && store.interiorData[B8]),
     { md: !!store.mapData[P8], az: !!store.areaZones[R8], it: !!store.interiorData[B8] });

  // 清理本次造的东西
  try { proj.deleteEntity(P8, { cascade: true }); } catch (e) {}
  try { proj.deleteEntity(P7, { cascade: true }); } catch (e) {}
  try { store.removeNode(NEW_ID); } catch (e) {}

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{APP_ST}.store.nodes.length > 0", timeout=45, desc='地理数据加载')

    ok, detail = sub_source_guards(cdp)
    if not ok:
        return False, f'f0 源码守卫失败：{detail}'

    js = JS.replace('__APP__', APP)
    ok, res = eval_json(cdp, js, desc='P0 三条修复（R5/R6/R7）')
    if not ok:
        return False, res
    if isinstance(res, dict):
        fails = res.get('fails') or []
        if fails:
            return False, f'P0 断言失败 {len(fails)} 项：' + '；'.join(str(x) for x in fails[:10])
        notes = res.get('notes') or []
        return True, ('R5 书签（三层 renderer + 锚点 + 同层逐值复原 + 跨层切视图 + 无画布给原因）/ '
                      'R6 导出带层级 + 导入新建缺失实体 + 一条 undo / '
                      'R7 画布与项目两条删除路径都清孤儿且撤销两半都还 —— 全部通过'
                      + ('；' + '；'.join(notes) if notes else ''))
    return False, f'用例返回值异常：{str(res)[:200]}'
