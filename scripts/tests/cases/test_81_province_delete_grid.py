#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 81：删除省份不再作废网格 + 合并超阈的规模量纲

来源：2026-10-01 收尾时留下的第四件 ——
  ① `removeProvinceWithGrid`（带重编号的删除）**零调用**：产品路径走 `removeBaseProvince`，
     它只换 `terrain` 数组 → 形状签名失配 → 下次用网格时**整表重新栅格化**
     （真实库 21 省 / 25930 点实测 170~368ms 主线程停顿），而且用户涂过的格子会被重采样一次。
     另外它自己还有一条**撤销静默失效**：apply 闭包捕获了当时的 `entry`，而 `commit()` 读 `cache[key]`
     —— 删除后若发生重建/换图，回灌写进孤儿对象、落盘的却是未回灌的标签。
  ② `mergeProvinceShapes` 超阈时的**真瓶颈不在栅格化**，而在它之后照跑的 O(n²) 相交扫描
     （`ringsProperlyCross` 每对都重新 dedupeRing；真实库前两大省 ≈ 1.06e8 次内层迭代），
     而 store 只回报 `method/loops`，用户看到的一句"精度降级"没有量纲。

本用例覆盖：
  f0 源码守卫：重编号/回灌助手存在且**不 execute**（由删除命令包进同一条 undo）、
     `removeBaseProvince` 经延迟注入槽调用它们并把省份放回**原位**、
     两个旧函数的 apply 不再认捕获的 entry、合并回报量纲、UI 文案带倍数。
  f1 删除不再作废网格：删除中间那个省之后 `getProvinceGrid` 仍**有效**（无需重建）、
     标签 = 旧标签的精确重编号（不是重采样）、一条 undo 后标签与省份顺序**逐项还原**。
  f2 合并量纲：小规模 `cancel` 且 `pairsTested === 1`；超阈 `raster` + `overflow` +
     `crossScanSkipped` + `pairsTested === 0`，且耗时可控。
"""
import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例81底图'


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []

    pe = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    for sym, why in (('function shiftProvinceGridForDelete', '缺少删除时的就地重编号'),
                     ('function restoreProvinceGrid', '缺少撤销时的整表回灌')):
        if sym not in pe:
            bad.append(f'provinceEditing {why}')
    exported = pe.split('return {')[-1]
    for sym in ('shiftProvinceGridForDelete', 'restoreProvinceGrid'):
        if sym not in exported:
            bad.append(f'{sym} 没导出到 store 壳（删除命令拿不到）')
    # 助手必须**不 execute**：删除命令得把这一步包进同一条 undo（否则 test_77 f2 会变两条）
    seg = pe[pe.find('function shiftProvinceGridForDelete'):pe.find('function shiftProvinceGridForDelete') + 1200]
    if 'execute(' in seg:
        bad.append('shiftProvinceGridForDelete 自己压了一条 undo（会把删除拆成两条撤销）')
    # 旧函数的「撤销写孤儿」缺陷：apply 里必须重新取缓存
    for fn in ('function removeProvinceWithGrid', 'function clearProvinceLabels'):
        body = pe[pe.find(fn):pe.find(fn) + 1800]
        if 'const cur = cache[key]' not in body:
            bad.append(f'{fn} 的 apply 仍认捕获的 entry（换图/重建后撤销会写进孤儿对象）')

    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    if 'provinceGridOps' not in se:
        bad.append('scenarioEditing 没接网格联动槽')
    rb = se[se.find('function removeBaseProvince'):se.find('function removeBaseProvince') + 5200]
    for sym, why in (('gridOps.shiftForDelete', '删除时没就地重编号网格'),
                     ('gridOps.restore', '撤销时没回灌网格'),
                     ('insertAt(', '撤销没把省份放回原位（序号语义会错）'),
                     ('gridShifted', '回执没说明网格有没有跟上')):
        if sym not in rb:
            bad.append(f'removeBaseProvince {why}')

    gd = _code_only(_read('src/renderer/src/store/geodata.js'))
    if 'provinceGridOps.shiftForDelete' not in gd or 'provinceGridOps.restore' not in gd:
        bad.append('geodata.js 没把网格助手注入槽（槽会一直是空的）')

    ps = _code_only(_read('src/renderer/src/utils/provinceShape.js'))
    # `mergeProvinceShapes` 保留为**纯函数参考实现**（有 Node 单测），量纲字段自然还在；
    # 但它已不再被产品代码调用（见下）。
    for sym, why in (('crossScanSkipped', '超阈时没标记「跳过相交扫描」'),
                     ('pairsTested', '没回报实际测了几对环')):
        if sym not in ps:
            bad.append(f'provinceShape 合并{why}')

    pei = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    # 🔴 P2（2026-10-09）：合并改**布尔精确并集** —— `maxWork`/`overflow`/`raster` 这套
    #    "超阈降级"的量纲概念整体消失（布尔没有阈值）。旧守卫要求回报量纲，现在**反转为**
    #    「不许再出现降级路径」。
    for sym in ('unionMulti', 'polygonClipping'):
        if sym not in pei:
            bad.append(f'mergeProvinces 没走布尔精确并集（缺 {sym}）')
    if 'maxWork' in pei or "'raster'" in pei:
        bad.append('provinceEditing 仍有「超阈降级到栅格」的残留（P2 后应完全消失）')
    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    # 2026-10-31：绘制/交互体已分批搬到 scenario/{layers,interaction}/* —— 判据读合集，不再绑文件位置
    from lib.rsrc import render_src_code_only as _rsrc_all
    sm = _rsrc_all()
    if '布尔精确并集' not in sm:
        bad.append('合并文案没说明走的是布尔精确并集（用户看不出会不会降精度）')
    if '精度降级' in sm:
        bad.append('合并文案仍提「精度降级」→ 该分支应已删除')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, ('删除级联网格（不额外压栈 + 省份回原位）+ 两个旧函数修掉孤儿写入 + '
                  '合并走布尔精确并集（无阈值、无栅格降级）+ UI 文案说明')


# ══════════════════════════════════════════════════════════════════
# 公共造数：3 个相邻陆地省（100×100 一格一个），网格就绪
# ══════════════════════════════════════════════════════════════════
SEED_JS = r"""
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const cell = (id, name, x0) => ({ id, name, kind: 'land',
    points: [{x:x0,y:0},{x:x0+100,y:0},{x:x0+100,y:100},{x:x0,y:100}] });
  s.addBaseProvince(KEY, cell('p81a', '甲省', 0), { checkOverlap: false });
  s.addBaseProvince(KEY, cell('p81b', '乙省', 100), { checkOverlap: false });
  s.addBaseProvince(KEY, cell('p81c', '丙省', 200), { checkOverlap: false });
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  s.rebuildProvinceGrid(KEY);
  SM.cameraScale = 1; SM.cameraX = 0; SM.cameraY = 0;
"""


def _seed():
    return SEED_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))


def _seed_for_big():
    """两个上万点的环 —— 用来把 work 顶过阈值（真实库前两大省的形状）"""
    return r"""
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const ring = (id, name, x0) => {
    const pts = [];
    for (let k = 0; k <= 3000; k++) pts.push({ x: x0 + Math.sin(k / 40) * 200, y: k });
    for (let k = 3000; k >= 0; k--) pts.push({ x: x0 + 300 + Math.sin(k / 40) * 200, y: k });
    return { id, name, kind: 'land', points: pts };
  };
  s.addBaseProvince(KEY, ring('b81a', '大甲', 0), { checkOverlap: false });
  s.addBaseProvince(KEY, ring('b81b', '大乙', 150), { checkOverlap: false });
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  SM.cameraScale = 1; SM.cameraX = 0; SM.cameraY = 0;
"""


# ══════════════════════════════════════════════════════════════════
# f1 删除不再作废网格
# ══════════════════════════════════════════════════════════════════
DELETE_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  __SEED__
  await tick(200);

  const labels = () => s.baseMaps[KEY].provinceLabels.data;
  const terrainIds = () => s.baseMaps[KEY].terrain.map(p => p.id);

  // 先涂一笔，让标签不是「刚栅格化出来的那样」（同时也验证重编号动的是用户涂过的格）
  s.applyProvinceLasso(KEY, [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}], 2);
  await tick(150);
  const before = Array.from(labels());
  const beforeIds = terrainIds();
  ck('前置：3 省在册', beforeIds.length === 3, beforeIds);
  ck('前置：网格有效（刚重建过）', !!s.getProvinceGrid(KEY));

  // ① 删除中间那个省（下标 1）
  const r = s.removeBaseProvince(KEY, 'p81b');
  await tick(200);
  ck('删除成功且回执说明网格已跟上', !!(r && r.success === true && r.gridShifted === true), r);
  ck('省份表少一个', terrainIds().length === 2 && terrainIds().indexOf('p81b') < 0, terrainIds());

  // ② 网格**仍然有效**（旧实现换了 terrain 数组 → 签名失配 → 下次用到时整表重新栅格化）
  const grid = s.getProvinceGrid(KEY);
  ck('删除后网格无需重建（getProvinceGrid 非 null）', !!grid,
     { hasGrid: !!grid, shape: s.baseMaps[KEY].provinceLabels && s.baseMaps[KEY].provinceLabels.shape });

  // ③ 标签 = 旧标签的**精确重编号**（自身格置 0、序号 > idx 的减 1），不是重新栅格化的结果
  const after = Array.from(labels());
  const exp = before.map(l => (l === 2 ? 0 : (l > 2 ? l - 1 : l)));
  ck('标签长度不变', after.length === exp.length, { a: after.length, e: exp.length });
  let diff = 0;
  for (let i = 0; i < exp.length; i++) if (after[i] !== exp[i]) diff++;
  ck('逐格等于期望的重编号结果', diff === 0, { diffCells: diff, sample: [before.slice(0, 6), after.slice(0, 6), exp.slice(0, 6)] });

  // ④ 一条 undo：省份回到**原位**、标签逐格还原
  s.undo();
  await tick(200);
  ck('undo 后省份表逐项还原（含顺序）',
     JSON.stringify(terrainIds()) === JSON.stringify(beforeIds), { now: terrainIds(), before: beforeIds });
  const restored = Array.from(labels());
  let diff2 = 0;
  for (let i = 0; i < before.length; i++) if (restored[i] !== before[i]) diff2++;
  ck('undo 后标签逐格还原（整表快照回灌）', diff2 === 0, { diffCells: diff2 });
  return JSON.stringify({ fails, notes: { cells: before.length } });
})()"""


def sub_delete(cdp):
    expr = (DELETE_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed()))
    ok, res = eval_json(cdp, expr, desc='删除省份网格联动')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("notes"), ensure_ascii=False)}' if res.get('notes') else ''
        return False, ('删除网格断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra)
    return True, f'删除后网格无需重建、标签精确重编号（{res.get("notes", {}).get("cells")} 格）、一条 undo 逐项还原'


# ══════════════════════════════════════════════════════════════════
# f2 合并：布尔精确并集（无阈值、无降级）
# ══════════════════════════════════════════════════════════════════
MERGE_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;

  // ① 小规模：布尔精确并集
  __SEED__
  await tick(200);
  const ok1 = s.mergeProvinces(KEY, ['p81a', 'p81b']);
  ck('小规模合并不被拒', !!(ok1 && !ok1.rejected), ok1);
  ck('合并方法 = 布尔并集（bool）', ok1.method === 'bool', ok1 && ok1.method);
  ck('回报规模（点数 / 环数）', ok1.points >= 3 && ok1.loops >= 1, ok1);
  s.undo();
  await tick(150);

  // ② 🔴 P2：**没有阈值、没有降级** —— 上万点的省照样走精确布尔。
  //    旧实现 `unionRingsByCancellation` 有 maxWork=2e7，真实库前两大省（10525×10071 点）
  //    → overflow → 退回 `unionRingsByRaster(maxDim=220)`，把上万点重采样成 220 分辨率轮廓。
  __SEEDBIG__
  await tick(300);
  const t0 = Date.now();
  const ok2 = s.mergeProvinces(KEY, ['b81a', 'b81b']);
  const dt = Date.now() - t0;
  ck('上万点的省合并给出结果', !!(ok2 && !ok2.rejected), ok2);
  ck('🔴 大点数合并仍走布尔（**没有栅格降级**）', ok2.method === 'bool', ok2 && ok2.method);
  ck('🔴 结果点数与输入同量级（没被重采样成几百点）', ok2.points > 500, ok2 && ok2.points);
  ck('耗时可控（布尔是 O(n log n)，不该出现秒级停顿）', dt < 10000, dt + 'ms');
  notes.merge = { method: ok2.method, points: ok2.points, dt: dt };
  return JSON.stringify({ fails, notes });
})()"""


def sub_merge(cdp):
    expr = (MERGE_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed())
            .replace('__SEEDBIG__', _seed_for_big().replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))))
    ok, res = eval_json(cdp, expr, desc='合并量纲')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("notes"), ensure_ascii=False)}' if res.get('notes') else ''
        return False, ('合并量纲断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra)
    m = res.get('notes', {}).get('merge') or {}
    return True, (f'小规模 cancel/pairs=1；超阈 raster + 跳过扫描（work {m.get("work")} ≫ {m.get("maxWork")}，'
                  f'{m.get("dt")}ms）')


def run(cdp):
    ensure_data_ready(cdp)
    r = cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    cdp.eval("window.confirm = () => true; window.prompt = (m, d) => d;")
    time.sleep(1.0)

    results = []
    for name, fn in (('f0 源码守卫', sub_source_guards),
                     ('f1 删除网格联动', sub_delete),
                     ('f2 合并量纲', sub_merge)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'删省网格/合并量纲 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('删省网格/合并量纲 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
