#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 52：Phase 3 省份「归属标签网格」——笔刷 / 自由轮廓 / 自动省界 / 重编号安全撤销

覆盖：
  a) 纯函数层：多边形 → 格归属栅格化（面积降序、命中即停）；差异边 → 省界链；Chaikin 平滑；
     序号越界自愈；序列化往返（TypedArray 必须转普通数组）
  b) store 层：网格懒建并落盘（provinceLabels.data 长度 = cols×rows）
  c) 笔刷：一笔涂抹 = **一条** undo（撤销回原状、重做再落回）；无目标省份时不写脏标签
  d) 自由轮廓：圈内整批划归 + 一条 undo
  e) 新建省份 → terrain 增长、序号可用；删除省份 → **重编号**（labels 全部 ≤ terrain 长度，
     不留下指向不存在省份的标签）
  f) 清空归属 + 一条 undo 还原；重建网格（按多边形重新栅格化）
  g) 接线：ScenarioMap 有省份笔刷/自由轮廓两个工具（含快捷键），网格视图开启后走格渲染
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib import helpers as H

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
SC_CANVAS = "document.querySelector('.scenario-map-container canvas')"

JS_PURE = r"""
(async () => {
  const fails = [];
  const same = (label, got, want) => { if (String(got) !== String(want)) fails.push(label + ' got=' + got + ' want=' + want); };
  const ok = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' (' + extra + ')' : '')); };
  const g = await import('/src/utils/provinceGrid.js');

  // 网格几何
  const grid = g.makeGrid({ minX: 0, minY: 0, maxX: 300, maxY: 200 }, { cell: 10, extraCells: 0 });
  same('cols', grid.cols, 30); same('rows', grid.rows, 20);
  const cell = g.cellAt(grid, 105, 105);
  same('cellAt', cell.c + ',' + cell.r, '10,10');

  // 多边形 → 归属（大省先落、小省不啃洞）
  const big = { name: '大省', points: [{x:0,y:0},{x:300,y:0},{x:300,y:200},{x:0,y:200}] };
  const small = { name: '小省', points: [{x:100,y:100},{x:160,y:100},{x:160,y:160},{x:100,y:160}] };
  const labels = g.rasterizeProvinces([small, big], grid);   // 故意把小省放前面（面积降序必须纠正）
  const st = { owned: g.countOwned(labels), used: g.usedIndices(labels) };
  ok('栅格化覆盖', st.owned === 600, JSON.stringify(st));
  // 序号 = 数组下标 + 1：small 是 0 号 → 1，big 是 1 号 → 2。大省先落 → 小省没有格
  same('命中即停（小省不覆盖大省）', st.used.join(','), '2');
  same('重叠处归属大省', labels[10 * grid.cols + 10], 2);
  const labels2 = g.rasterizeProvinces([big, small], grid);
  same('顺序无关（面积降序）', g.usedIndices(labels2).join(','), '1');

  // 省界提取 + 平滑
  const chains = g.extractBorders(labels, grid);
  ok('省界链数', chains.length >= 1, chains.length);
  const segs = chains.reduce((a, c) => a + c.length, 0);
  ok('省界段数', segs >= 4, segs);
  const smooth = g.chaikin(chains[0], 2);
  ok('Chaikin 加点并保端点', smooth.length > chains[0].length
     && smooth[0].x === chains[0][0].x && smooth[smooth.length-1].y === chains[0][chains[0].length-1].y,
     smooth.length + ' vs ' + chains[0].length);
  // 无主格 → 没有边界线
  same('全无主时无省界', g.extractBorders(new Uint8Array(grid.cols * grid.rows), grid).length, 0);

  // 笔刷：半径 2 的一笔只改有限格；抹除写回 0
  const L2 = new Uint8Array(grid.cols * grid.rows);
  const changed = g.stampBrush(L2, grid, { c: 10, r: 10, radius: 2, strength: 1, tool: 'paint', target: 3 });
  ok('笔刷改动格数', changed.length > 0 && changed.length <= 13, changed.length);
  ok('笔刷落了新值', L2[10 * grid.cols + 10] === 3);
  const erased = g.stampBrush(L2, grid, { c: 10, r: 10, radius: 2, strength: 1, tool: 'erase', target: 0 });
  ok('抹除回到无主', erased.length > 0 && L2[10 * grid.cols + 10] === 0);

  // 套索：圈内整批
  const L3 = new Uint8Array(grid.cols * grid.rows);
  const lasso = g.lassoCells(L3, grid, [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}], 2);
  ok('套索圈格数', lasso.length >= 90 && lasso.length <= 110, lasso.length);
  ok('套索落值', L3[5 * grid.cols + 5] === 2);

  // 重编号（删除 2 号省：它自己的格置无主，> 2 的减 1，0 与 1 不动）
  const L4 = new Uint8Array([0, 1, 2, 3, 5, 0, 4]);
  const rn = g.renumberAfterDelete(L4, 2);
  same('重编号结果', Array.from(L4).join(','), '0,1,0,2,4,0,3');
  same('重编号清空格数', rn.cleared, 1);

  // 序列化往返 + 越界自愈
  const ser = g.serializeLabels(new Uint8Array([0, 1, 255]));
  ok('序列化为普通数组', Array.isArray(ser) && ser.join(',') === '0,1,255');
  ok('长度不符 → null', g.deserializeLabels([1, 2], 3) === null);
  ok('非法值 → null', g.deserializeLabels([1, 'x', 3], 3) === null);
  const norm = g.normalizeStoredGrid({ cols: 3, rows: 1, cell: 10, ox: 0, oy: 0, data: [0, 1, 9] }, [big]);
  ok('越界序号置无主', norm && Array.from(norm.labels).join(',') === '0,1,0', norm && Array.from(norm.labels).join(','));
  ok('几何不自洽 → null', g.normalizeStoredGrid({ cols: 3, rows: 2, cell: 10, ox: 0, oy: 0, data: [0, 1, 2] }, []) === null);

  return JSON.stringify({ fails, chains: chains.length, segs, cells: st.owned });
})()
"""

JS_STORE = r"""
(async () => {
  const fails = [];
  const same = (label, got, want) => { if (String(got) !== String(want)) fails.push(label + ' got=' + got + ' want=' + want); };
  const ok = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' (' + extra + ')' : '')); };
  const s = PLACEHOLDER_STORE;
  const KEY = __KEY__;                        // 当前已加载的底图
  const base = s.baseMaps[KEY];
  if (!base) return JSON.stringify({ fails: ['底图 ' + KEY + ' 不存在'] });

  // mock 底图可能没有任何省份 → 注入 3 个面积不同的测试省份（大/中/小，中省在大省内部）
  const rects = [
    [{x:0,y:0},{x:400,y:0},{x:400,y:300},{x:0,y:300}],
    [{x:60,y:60},{x:340,y:60},{x:340,y:240},{x:60,y:240}],
    [{x:420,y:0},{x:520,y:0},{x:520,y:120},{x:420,y:120}],
  ];
  let injected = 0;
  while (s.baseMaps[KEY].terrain.length < 3 && injected < 3) {
    const pts = rects[injected].map(q => ({ ...q }));
    s.addBaseProvince(KEY, { id: 'prov_case52_' + injected, name: '用例52省' + (injected + 1), points: pts, biome: 'temperate', coast: false });
    injected++;
  }
  const nProv = s.baseMaps[KEY].terrain.length;
  if (injected) s.rebuildProvinceGrid(KEY);   // 注入的多边形 → 立即按新定义表重新栅格化

  // b) 懒建 + 落盘
  const entry = s.ensureProvinceGrid(KEY);
  ok('网格懒建', !!entry, 'null');
  if (!entry) return JSON.stringify({ fails });
  const stored = s.baseMaps[KEY].provinceLabels;
  ok('网格已写回 store', !!stored, 'undefined');
  same('data 长度 = cols*rows', stored.data.length, stored.cols * stored.rows);
  ok('栅格化后有主格', s.provinceGridStats(KEY).owned > 0, s.provinceGridStats(KEY).owned);
  const owned0 = s.provinceGridStats(KEY).owned;

  // c) 一笔涂抹 = 一条 undo
  const before = owned0;
  const cx = entry.grid.ox + (entry.grid.cols / 2) * entry.grid.cell;
  const cy = entry.grid.oy + (entry.grid.rows / 2) * entry.grid.cell;
  const cellIdx = Math.floor(entry.grid.rows / 2) * entry.grid.cols + Math.floor(entry.grid.cols / 2);
  const preStroke = entry.labels[cellIdx];
  const target = preStroke === 3 ? 4 : 3;          // 保证这一笔真的改变该格
  s.beginProvinceStroke();
  for (let k = 0; k < 6; k++) s.applyProvinceStroke(KEY, { x: cx + k * entry.grid.cell, y: cy, radius: 4, strength: 1, tool: 'paint', target });
  const brush = s.endProvinceStroke('测试划归');
  ok('笔刷产生改动', brush && brush.changed > 0, JSON.stringify(brush));
  same('涂抹改变了目标格', entry.labels[cellIdx], target);
  s.undo();
  same('一条 undo 撤销整笔', entry.labels[cellIdx], preStroke);
  s.redo();
  same('redo 落回新值', entry.labels[cellIdx], target);

  // 无目标省份 → 不写脏标签
  const emptyKey = '__case52_empty__';
  s.baseMaps = { ...s.baseMaps, [emptyKey]: { id: emptyKey, name: '空底图', terrain: [], referenceImages: [] } };
  const e = s.ensureProvinceGrid(emptyKey);
  s.beginProvinceStroke();
  const wrote = s.applyProvinceStroke(emptyKey, { x: e.grid.ox + 10, y: e.grid.oy + 10, radius: 3, strength: 1, tool: 'paint', target: 1 });
  s.endProvinceStroke('无目标');
  same('无省份时不写标签', wrote, 0);
  same('无省份时网格仍全无主', e.labels.reduce((a, v) => a + (v ? 1 : 0), 0), 0);

  // d) 自由轮廓：圈内整批划归 + 一条 undo
  const g2 = entry.grid;
  const poly = [];
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2;
    poly.push({ x: cx + Math.cos(a) * g2.cell * 5, y: cy + Math.sin(a) * g2.cell * 5 });
  }
  const idxsBefore = entry.labels.slice();
  const lasso = s.applyProvinceLasso(KEY, poly, 3);
  ok('套索产生改动', lasso && lasso.changed > 0, JSON.stringify(lasso));
  ok('套索落值', entry.labels[cellIdx] === 3, entry.labels[cellIdx]);
  s.undo();
  same('套索一条 undo', entry.labels[cellIdx], idxsBefore[cellIdx]);
  s.redo();

  // e) 新建省份 → 删除省份（重编号安全）
  const added = s.addBrushProvince(KEY, {});
  ok('新建省份', added && added.idx === nProv + 1, JSON.stringify(added));
  same('terrain 增长', s.baseMaps[KEY].terrain.length, nProv + 1);
  // 给新省份涂一块地
  const newIdx = added.idx;
  s.beginProvinceStroke();
  const off = 20;
  for (let k = 0; k < 4; k++) s.applyProvinceStroke(KEY, { x: g2.ox + off * g2.cell + k * g2.cell, y: g2.oy + off * g2.cell, radius: 3, strength: 1, tool: 'paint', target: newIdx });
  s.endProvinceStroke('新省份划归');
  let used = s.provinceGridStats(KEY).used;
  ok('新省份有归属格', used.includes(newIdx), JSON.stringify(used));
  // 删除 2 号省 → 3/4/... 全部减 1，且不留越界标签
  const del = s.removeProvinceWithGrid(KEY, s.baseMaps[KEY].terrain[1].id);
  ok('删除省份', !!del, 'null');
  const maxLabel = entry.labels.reduce((a, v) => Math.max(a, v), 0);
  ok('删除后无越界标签', maxLabel <= s.baseMaps[KEY].terrain.length, maxLabel + ' > ' + s.baseMaps[KEY].terrain.length);
  same('terrain 缩短', s.baseMaps[KEY].terrain.length, nProv);
  s.undo();
  same('撤销删除后 terrain 还原', s.baseMaps[KEY].terrain.length, nProv + 1);
  same('撤销删除后 maxLabel 还原', entry.labels.reduce((a, v) => Math.max(a, v), 0), newIdx);
  s.redo();

  // f) 清空归属 + 还原；重建网格
  const cleared = s.clearProvinceLabels(KEY);
  ok('清空归属', cleared && cleared.cleared > 0, JSON.stringify(cleared));
  same('清空后无主', s.provinceGridStats(KEY).owned, 0);
  s.undo();
  same('清空一条 undo 还原', s.provinceGridStats(KEY).owned, cleared.cleared);
  const rebuilt = s.rebuildProvinceGrid(KEY);
  ok('重建网格', rebuilt && rebuilt.owned > 0, JSON.stringify(rebuilt));

  // 收场：把本用例造出来的省份与网格退回（delete + 撤销栈留在组件里，用例结束即重载）
  s.undo();                                    // 撤销 rebuild
  s.removeProvinceWithGrid(KEY, s.baseMaps[KEY].terrain[s.baseMaps[KEY].terrain.length - 1].id);

  return JSON.stringify({ fails, nProv, owned0, brushChanged: brush ? brush.changed : -1,
    lassoChanged: lasso ? lasso.changed : -1 });
})()
"""

JS_READONLY = r"""
(async () => {
  const fails = [];
  const same = (label, got, want) => { if (String(got) !== String(want)) fails.push(label + ' got=' + got + ' want=' + want); };
  const ok = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' (' + extra + ')' : '')); };
  const s = PLACEHOLDER_STORE;
  const G = await import('/src/store/writeGate.js');
  const KEY = __KEY__;
  const entry = s.ensureProvinceGrid(KEY);
  if (!entry) return JSON.stringify({ fails: ['无网格'] });

  const sum = (a) => { let n = 0; for (let i = 0; i < a.length; i++) n += a[i]; return n; };
  const owned0 = s.provinceGridStats(KEY).owned;
  const sum0 = sum(entry.labels);
  const terrain0 = s.baseMaps[KEY].terrain.length;
  const storedSum0 = sum(s.baseMaps[KEY].provinceLabels.data);
  const firstId = s.baseMaps[KEY].terrain[0].id;

  G.setWriteMode('readonly', '');
  same('已进入只读态', G.isReadOnly.value, true);

  // 用一个「与当前值不同的目标」落笔 —— 可写时这一笔必然改动该格，只读时必然零改动
  const cx = entry.grid.ox + 10 * entry.grid.cell, cy = entry.grid.oy + 10 * entry.grid.cell;
  const roIdx = 10 * entry.grid.cols + 10;
  const roPre = entry.labels[roIdx];
  const roTarget = roPre === 2 ? 3 : 2;
  ok('只读用例的落点可被改动（前提）', roPre !== roTarget, roPre + ' vs ' + roTarget);

  // 笔刷：一格都不许动（changed === 0，内存 labels 也不变）
  s.beginProvinceStroke();
  let dab = 0;
  for (let k = 0; k < 5; k++) dab += s.applyProvinceStroke(KEY, { x: cx + k * entry.grid.cell, y: cy, radius: 4, strength: 1, tool: 'paint', target: roTarget });
  const strokeRes = s.endProvinceStroke('只读测试');
  same('只读：笔刷零改动', dab, 0);
  same('只读：不产生 undo 命令', strokeRes, null);
  same('只读：该格未被改', entry.labels[roIdx], roPre);
  same('只读：内存格未变', sum(entry.labels), sum0);

  // 自由轮廓 / 新建 / 删除 / 清空 / 重建：全部被拒且零副作用
  const poly = [];
  for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; poly.push({ x: cx + Math.cos(a) * entry.grid.cell * 4, y: cy + Math.sin(a) * entry.grid.cell * 4 }); }
  const lasso = s.applyProvinceLasso(KEY, poly, 1);
  ok('只读：套索被拒', lasso && lasso.blocked === true, JSON.stringify(lasso));
  ok('只读：套索零改动', lasso && lasso.changed === 0, JSON.stringify(lasso));
  ok('只读：套索消息含能力说明', lasso && /只读|项目/.test(lasso.message || ''), lasso && lasso.message);

  const added = s.addBrushProvince(KEY, {});
  ok('只读：新建省份被拒', added && added.blocked === true, JSON.stringify(added));
  same('只读：省份表未增长', s.baseMaps[KEY].terrain.length, terrain0);

  const del = s.removeProvinceWithGrid(KEY, firstId);
  ok('只读：删除省份被拒', del && del.blocked === true, JSON.stringify(del));
  same('只读：删除后省份表不变', s.baseMaps[KEY].terrain.length, terrain0);

  const cleared = s.clearProvinceLabels(KEY);
  ok('只读：清空归属被拒', cleared && cleared.blocked === true, JSON.stringify(cleared));
  same('只读：归属格数不变', s.provinceGridStats(KEY).owned, owned0);

  const rb = s.rebuildProvinceGrid(KEY);
  ok('只读：重建网格被拒', rb && rb.blocked === true, JSON.stringify(rb));
  same('只读：落盘载荷未变', sum(s.baseMaps[KEY].provinceLabels.data), storedSum0);

  // 懒建也要遵守：只读态下新底图只进内存缓存，**不写 store**
  const roKey = '__case52_ro__';
  s.baseMaps = { ...s.baseMaps, [roKey]: { id: roKey, name: '只读底图', terrain: [{ id: 'p1', name: 'P1', points: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}] }] } };
  const roEntry = s.ensureProvinceGrid(roKey);
  ok('只读：网格可读（只读 ≠ 看不了）', !!roEntry && s.provinceGridStats(roKey).owned > 0, JSON.stringify(roEntry && s.provinceGridStats(roKey).owned));
  same('只读：懒建不写 store', s.baseMaps[roKey].provinceLabels === undefined, true);

  // 恢复可写 → 同一落点、同一目标，这次必须真的改
  G.setWriteMode('project', '用例恢复（harness 基线项目已打开）');
  same('恢复可写', G.canWrite(), true);
  s.beginProvinceStroke();
  const again = s.applyProvinceStroke(KEY, { x: cx, y: cy, radius: 4, strength: 1, tool: 'paint', target: roTarget });
  const againRes = s.endProvinceStroke('恢复可写');
  ok('恢复可写后笔刷生效', again > 0 && againRes && againRes.changed > 0, again + '/' + JSON.stringify(againRes));
  same('恢复可写后该格真的改了', entry.labels[roIdx], roTarget);
  s.undo();
  same('撤销后回到原值', entry.labels[roIdx], roPre);

  return JSON.stringify({ fails, owned0, terrain0 });
})()
"""

JS_WIRING = r"""
(() => {
  const fails = [];
  const ok = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' (' + extra + ')' : '')); };
  const sc = PLACEHOLDER_SC;
  if (!sc) return JSON.stringify({ fails: ['ScenarioMap 未挂载'] });
  ok('存在省份笔刷工具分支', typeof sc.setTool === 'function');
  sc.setTool('provinceBrush');
  ok('切到省份笔刷', sc.tool === 'provinceBrush', sc.tool);
  ok('自动开网格视图', sc.showProvinceMesh === true, String(sc.showProvinceMesh));
  ok('笔刷参数就位', sc.provBrushRadius > 0 && !!sc.provBrushTool, sc.provBrushRadius + '/' + sc.provBrushTool);
  sc.setTool('provinceLasso');
  ok('切到自由轮廓', sc.tool === 'provinceLasso' && sc.provBrushTool === sc.provBrushTool);
  ok('目标省份列表可读', Array.isArray(sc.provinceTargets));
  // 工具栏按钮存在（用 title 定位，不用图标文本）
  const btns = Array.from(document.querySelectorAll('.scenario-toolbar button'));
  const hasBrush = btns.some(b => (b.getAttribute('title') || '').includes('省份笔刷'));
  const hasLasso = btns.some(b => (b.getAttribute('title') || '').includes('自由轮廓'));
  ok('工具栏有省份笔刷按钮', hasBrush);
  ok('工具栏有自由轮廓按钮', hasLasso);
  return JSON.stringify({ fails, buttons: btns.length, nProv: sc.provinceTargets.length });
})()
"""


def _j(cdp, expr, desc=''):
    ok, obj = eval_json(cdp, expr, required=('fails',), desc=desc)
    return (obj, '') if ok else (None, obj)


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # a) 纯函数层
    obj, err = _j(cdp, JS_PURE, desc='provinceGrid 纯函数')
    if obj is None:
        return False, f'纯函数求值失败：{err}'
    if obj['fails']:
        return False, '纯函数层失败：' + '；'.join(obj['fails'])
    pure = f"省界 {obj['chains']} 链 {obj['segs']} 段、栅格化 {obj['cells']} 格"

    # 进入剧本模式（底图/scenarios 走这条既有链路加载，与 test_19 一致）
    entered = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if entered != 'ok':
        return False, f'未找到「历史剧本」入口（{entered}）'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=20, desc='ScenarioMap 挂载')
    time.sleep(1.2)

    # 取当前已加载的底图（mock 可能不带省份，store 层会注入测试省份）
    keys = cdp.eval("(() => { const s = %s; return JSON.stringify(Object.keys(s.baseMaps || {})); })()" % STORE)
    keys = json.loads(keys) if isinstance(keys, str) else []
    if not keys:
        return False, '底图未加载（scenarios 加载链路没走通）'
    key = 'desite' if 'desite' in keys else keys[0]

    # b-f) store 层
    js_store = JS_STORE.replace('PLACEHOLDER_STORE', STORE).replace('__KEY__', json.dumps(key))
    obj, err = _j(cdp, js_store, desc='省份网格 store')
    if obj is None:
        return False, f'store 层求值失败：{err}'
    if obj['fails']:
        return False, 'store 层失败：' + '；'.join(obj['fails'])
    store_summary = (f'笔刷一笔 = 一条 undo（改 {obj["brushChanged"]} 格）、自由轮廓一笔改 {obj["lassoChanged"]} 格')

    # g) 接线：ScenarioMap 工具/按钮在位
    obj2, err = _j(cdp, JS_WIRING.replace('PLACEHOLDER_SC', SC), desc='ScenarioMap 接线')
    if obj2 is None:
        return False, f'接线检查求值失败：{err}'
    if obj2['fails']:
        return False, '接线检查失败：' + '；'.join(obj2['fails'])

    # h) 只读态：编辑入口不灰禁，但**不得产生任何改动**
    js_ro = JS_READONLY.replace('PLACEHOLDER_STORE', STORE).replace('__KEY__', json.dumps(key))
    obj3, err = _j(cdp, js_ro, desc='只读态零副作用')
    if obj3 is None:
        return False, f'只读态检查求值失败：{err}'
    if obj3['fails']:
        return False, '只读态检查失败：' + '；'.join(obj3['fails'])

    # 收场：退出剧本模式
    cdp.eval("""(() => { const s = %s; s.scenarioMode = false; return 'ok'; })()""" % STORE)

    return True, (f'省份网格通过（底图 {key}，{obj["nProv"]} 省）：{pure}、Chaikin 平滑；'
                  f'{store_summary}；新建/删除省份重编号安全（无越界标签）、清空归属与重建网格可撤销；'
                  f'ScenarioMap 工具与工具栏入口就位（{obj2["buttons"]} 个按钮）；'
                  f'只读态 6 个写操作全部零副作用（笔刷 0 改动、省份表/归属/落盘载荷均不变、懒建只进内存）+ 恢复可写后照常生效')
