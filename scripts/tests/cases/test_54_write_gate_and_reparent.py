#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 54：只读一致性（内存编辑闸门）+ 批量归位 + 「前往编辑」直达画布

背景（2026-09-21 用户反馈：「各种建筑物散落在行星地图上」「当前各功能是否完善」）：
  a) **内存编辑闸门**：写闸门原来只守 11 条「落盘入口」，而画布上的编辑（行星笔刷/区域/内部家具/
     剧本染色）在只读态仍能改内存 —— 改动看起来生效（画布变了、列表多了），但永远不会落盘 = 静默丢数据。
     现在 `execute()` 与若干「直接写数据、不走 undo 栈」的 store 函数同样过 `guardWrite`，
     且任何拒绝都会留下**回音**（`writeGate.lastRejection` → App.vue 状态栏），绝不静默。
  b) **批量归位**：ProjectPanel 支持 Ctrl/⌘ 多选 → 「移到此父级」（`projectStore.moveEntities`，**一条** undo），
     用来把散落在行星下的设施/地点一次性归入城镇/区域。
  c) **前往编辑直达画布**：向导结果卡片的「前往编辑」经 `canvasBridge` 的 goto 注册口
     （面板不 import geodata）把画布切到该实体所在视图并选中。

覆盖：
  a) 源码契约：writeGate 的内存写入口清单，每条必须在对应文件里真存在守卫
  b) 只读态：6 类代表写操作（execute / 节点 / 区域 / 楼层 / 参考图 / 底图）零副作用 + 有回音
  c) 可写态：同样操作正常生效（证明闸门是模式驱动，不是一刀切 no-op）
  d) moveEntities：批量改父级一条 undo、已在目标下则跳过、把自己移到自己后代下被拒
  e) focusEntityOnCanvas / canvasBridge.gotoEntity：行星 → planet、区域 → area、建筑 → interior
"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib.helpers import ensure_case_state

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
APP = "document.querySelector('#app').__vue_app__"
STORE = f"{APP}._instance.setupState.store"
PINIA = f"{APP}.config.globalProperties.$pinia"

PRELUDE = """
  const G = await import('/src/store/writeGate.js');
  const U = await import('/src/store/undo.js');
  const CB = await import('/src/store/canvasBridge.js');
  const s = STORE_E;
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };
"""


def _read(rel):
    with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
        return f.read()


def _prelude():
    """所有子测试共用的 JS 前置（注入 store / pinia 选择器）"""
    return PRELUDE.replace('STORE_E', STORE).replace('PINIA_E', PINIA)


def sub_source_contract(cdp):
    """a) 内存写入口清单：每条 guarded 条目在对应文件里真存在 guardWrite 标记"""
    gate = _read('src/renderer/src/store/writeGate.js')
    if 'MEMORY_WRITE_CALLSITES' not in gate:
        return False, 'writeGate 缺少内存写入口清单 MEMORY_WRITE_CALLSITES'
    # 解析清单条目（file / marker）
    import re
    rows = re.findall(r"\{\s*id:\s*\d+,\s*file:\s*'([^']+)',\s*marker:\s*'([^']+)'", gate)
    if len(rows) < 5:
        return False, f'内存写入口清单条目过少（{len(rows)}）'
    bad = []
    for rel, marker in rows:
        src = _read(rel)
        if marker not in src:
            bad.append(f'{rel} 未见守卫标记 {marker!r}')
    if bad:
        return False, '；'.join(bad)
    # execute 是内存写的总闸门：它自己必须过 guardWrite
    undo_src = _read('src/renderer/src/store/undo.js')
    if 'guardWrite(' not in undo_src:
        return False, 'undo.js 的 execute() 没有过 guardWrite（内存编辑闸门缺失）'
    return True, f'内存写入口清单 {len(rows)} 条，守卫标记齐全'


def sub_readonly_zero_effect(cdp):
    """b) 只读态：6 类写操作零副作用 + 拒绝回音"""
    expr = "(async () => {" + PRELUDE.replace('STORE_E', STORE) + """
  const pid = (s.nodes.find(n => n.layer === 'planet' && s.mapData[s.getMapDataKey(n.id)]) || s.nodes.find(n => n.layer === 'planet'));
  if (!pid) return JSON.stringify({ fails: ['找不到行星节点'] });
  const pidKey = s.getMapDataKey(pid.id);
  const areaId = (s.nodes.find(n => n.layer === 'region') || {}).id || 'no_region';
  const node = s.nodes.find(n => n.layer === 'facility' && n.parentId === pid.id) || s.nodes.find(n => n.layer !== 'world');
  const target = s.nodes.find(n => n.layer === 'region');

  const snap = () => ({
    nodes: s.nodes.length,
    name: (s.nodes.find(n => n.id === node.id) || {}).name,
    // 所有已装载行星图的地形总数（项目/知识库两侧 key 规则不同，取总量最稳）
    terrain: Object.values(s.mapData || {}).reduce((n2, m) => n2 + (((m || {}).terrain) || []).length, 0),
    zones: Object.values(s.areaZones || {}).reduce((n2, z) => n2 + ((z || []).length), 0),
    refs: Object.values(s.mapData || {}).reduce((n2, m) => n2 + ((((m || {}).referenceImages) || []).length), 0),
    interior: Object.keys(s.interiorData || {}).length,
    baseMaps: Object.keys(s.baseMaps || {}).length,
    undo: U.historyLength.value,
  });
  G.setWriteMode('readonly', '用例：只读态');
  const before = snap();
  const rejBefore = G.rejectionCount.value;

  const r1 = s.updateNode(node.id, { name: '只读改名' });
  const r2 = s.addAreaZone(areaId, { id: 'ro_zone', name: '只读区域', color: '#fff',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
  const r3 = s.addFloor('ro_building', '只读层');
  const r4 = s.updateReferenceImage(pid.id, { id: 'ro_ref', name: '只读参考图' });
  const r5 = s.addBaseMap('只读底图', { name: '只读底图' });
  const r6 = U.execute({ type: 'ro-test', label: '只读测试命令', undo: () => {}, redo: () => { s.nodes.push({ id: 'ro_pushed' }); } });

  const after = snap();
  const rejAfter = G.rejectionCount.value;
  const last = G.lastRejection.value || {};
  G.setWriteMode('project', '用例：恢复可写');

  same('只读态快照完全不变（节点数/名称/地形/区域/参考图/内部容器/底图/undo 长度）', after, before);
  ck('execute 明确返回拒绝（ok:false）', r6 && r6.ok === false && r6.readOnly === true, r6);
  ck('addFloor 返回 null（未建容器）', r3 === null, r3);
  ck('拒绝留下回音（计数增加 ≥5）', rejAfter - rejBefore >= 5, { rejBefore, rejAfter });
  ck('回音带能力说明与去处', String(last.message || '').indexOf('只读') >= 0 && String(last.message || '').indexOf('打开项目') >= 0, last);
  same('写模式已恢复为可写', G.describeWriteGate().mode, 'project');
  return JSON.stringify({ fails, info: { before, after, rejBefore, rejAfter, last: last.action || '' } });
})()"""
    ok, obj = eval_json(cdp, expr, desc='只读零副作用')
    if not ok:
        return False, obj
    if obj.get('fails'):
        return False, '；'.join(obj['fails'])
    return True, (f"只读态 6 类写全部零副作用（节点 {obj['info']['before']['nodes']}、"
                  f"地形 {obj['info']['before']['terrain']}、undo {obj['info']['before']['undo']} 长度不变）；"
                  f"拒绝回音 {obj['info']['rejAfter'] - obj['info']['rejBefore']} 次，最后一条={obj['info']['last']}")


def sub_writable_works(cdp):
    """c) 可写态：同样的写操作正常生效（闸门是模式驱动）"""
    expr = "(async () => {" + PRELUDE.replace('STORE_E', STORE) + """
  const node = s.nodes.find(n => n.layer === 'facility') || s.nodes.find(n => n.layer !== 'world');
  const nameBefore = node.name;
  G.setWriteMode('project', '用例：可写态');
  // ⚠️ 先加楼层再改名：addFloor 不进 undo 栈（已知不一致，见用例尾部说明），
  //    所以「一次 undo」只能撤销改名 —— 这里按现状断言，不掩盖。
  const floor = s.addFloor('rw_building', '可写层');
  const nowFloors = ((s.interiorData['rw_building'] || {}).floors || []).length;
  const undoBefore = U.historyLength.value;
  const r1 = s.updateNode(node.id, { name: '可写改名' });
  const nowName = (s.nodes.find(n => n.id === node.id) || {}).name;
  const undoDelta = U.historyLength.value - undoBefore;
  U.undo();  // 撤销改名
  const backName = (s.nodes.find(n => n.id === node.id) || {}).name;
  const floorsAfterUndo = ((s.interiorData['rw_building'] || {}).floors || []).length;
  s.removeFloor('rw_building', (floor || {}).id);
  const floorsClean = ((s.interiorData['rw_building'] || {}).floors || []).length;
  return JSON.stringify({
    fails,
    info: { r1ok: r1 && r1.ok !== false, nowName, nameBefore, floorCreated: !!floor, nowFloors,
            undoDelta, backName, floorsAfterUndo, floorsClean },
  });
})()"""
    ok, obj = eval_json(cdp, expr, desc='可写态生效')
    if not ok:
        return False, obj
    fails = list(obj.get('fails') or [])
    info = obj.get('info') or {}
    if info.get('nowName') != '可写改名':
        fails.append(f"可写态改名未生效 → {info.get('nowName')}")
    if info.get('undoDelta') != 1:
        fails.append(f"改名不是一条 undo（Δ={info.get('undoDelta')}）")
    if not info.get('floorCreated') or info.get('nowFloors') != 1 or info.get('floorsAfterUndo') != 1:
        fails.append(f"可写态加楼层未生效 → {info}")
    if info.get('backName') != info.get('nameBefore'):
        fails.append(f"undo 未恢复原名 → {info}")
    if info.get('floorsClean') != 0:
        fails.append(f"测试楼层未清场 → {info}")
    if fails:
        return False, '；'.join(fails)
    return True, ('可写态：改名生效且一条 undo 可还原、加/删楼层生效（⚠️ addFloor 不进 undo 栈 —— '
                  '已知不一致，见开发日志遗留清单）')


def sub_batch_reparent(cdp):
    """d) 批量改父级：一条 undo / 已在目标下跳过 / 循环被拒"""
    expr = "(async () => {" + _prelude() + """
  const proj = (await import('/src/store/projectStore.js')).useProjectStore(PINIA_E);
  const list = Object.values(proj.entities);
  const planet = list.find(e => e.layer === 'planet');
  if (!planet) return JSON.stringify({ fails: ['项目里没有行星实体'] });
  const kids = list.filter(e => e.parentId === planet.id);
  const target = kids.find(e => ['city', 'town', 'village'].includes(e.layer));
  if (!target) return JSON.stringify({ fails: ['行星下没有城镇类实体，无法做归位测试'] });
  const picks = kids.filter(e => e.id !== target.id && ['facility', 'location', 'city', 'town', 'village'].includes(e.layer)).slice(0, 2).map(e => e.id);
  if (picks.length < 2) return JSON.stringify({ fails: ['行星下可归位的实体不足 2 个'] });

  const parentOf = (id) => (proj.getEntity(id) || {}).parentId;
  const beforeParents = picks.map(parentOf);
  const undoBefore = U.historyLength.value;
  const res = proj.moveEntities(picks, target.id);
  const afterParents = picks.map(parentOf);
  const undoDelta = U.historyLength.value - undoBefore;
  const lastLabel = U.getLastCommandLabel();
  const again = proj.moveEntities(picks, target.id);          // 已在目标下 → 跳过
  const cycle = proj.moveEntities([target.id], picks[0]);      // 把 target 移到自己后代下 → 拒绝
  U.undo();                                                    // 一条 undo 撤销批量移动
  const restoredParents = picks.map(parentOf);
  return JSON.stringify({
    fails,
    info: {
      moved: res && res.moved ? res.moved.length : -1, success: !!(res && res.success),
      afterParents, targetId: target.id, beforeParents,
      undoDelta, againMoved: again && again.moved ? again.moved.length : -1,
      lastLabel,
      againUnchanged: again && again.unchanged ? again.unchanged.length : -1,
      cycleOk: !!(cycle && cycle.success === false), cycleErr: (cycle && cycle.error) || '',
      restoredParents,
    },
  });
})()""".replace('PINIA_E', PINIA).replace('STORE_E', STORE)
    ok, obj = eval_json(cdp, expr, desc='批量改父级')
    if not ok:
        return False, obj
    fails = list(obj.get('fails') or [])
    info = obj.get('info') or {}
    if not info.get('success') or info.get('moved') != 2:
        fails.append(f"批量移动未成功 → {info}")
    if info.get('afterParents') != [info.get('targetId'), info.get('targetId')]:
        fails.append(f"移动后 parentId 不对 → {info}")
    # 「一条 undo」的判据：① 栈顶就是那条批量命令（label 可辨识）；② 一次 undo 把两个实体都还原
    # （不比对历史长度 —— 历史有 100 条上限，到顶后长度不再增长，Δ 会骗人）
    if '批量改父级' not in str(info.get('lastLabel')):
        fails.append(f"批量移动未进 undo 栈（lastLabel={info.get('lastLabel')}）full={info}")
    if info.get('againMoved') != 0 or info.get('againUnchanged') != 2:
        fails.append(f"已在目标下未跳过 → {info}")
    if not info.get('cycleOk'):
        fails.append(f"移到自己后代下未被拒 → {info}")
    if info.get('restoredParents') != info.get('beforeParents'):
        fails.append(f"undo 未恢复原父级 → {info}")
    if fails:
        return False, '；'.join(fails)
    return True, (f"批量改父级：2 个实体 → 城市「{info.get('targetId')}」，一条 undo 可撤可还原；"
                  f"已在目标下跳过；循环被拒（{info.get('cycleErr')[:24]}…）")


def sub_goto_canvas(cdp):
    """e) 「前往编辑」直达画布：行星/区域/建筑三种目标"""
    expr = "(async () => {" + PRELUDE.replace('STORE_E', STORE) + """
  const planet = s.nodes.find(n => n.layer === 'planet');
  const region = s.nodes.find(n => n.layer === 'region');
  const city = s.nodes.find(n => n.layer === 'city') || s.nodes.find(n => n.layer === 'planet');

  const navPlanet = s.focusEntityOnCanvas(planet.id);
  const viewPlanet = s.viewLevel;
  const curPlanet = s.currentPlanet ? s.currentPlanet.id : null;

  let navRegion = { ok: false }, viewRegion = null, curArea = null;
  if (region) {
    navRegion = s.focusEntityOnCanvas(region.id);
    viewRegion = s.viewLevel;
    curArea = s.currentArea ? s.currentArea.id : null;
  }

  // 建筑：先在（可写态的）项目里建一个挂在城市下的建筑节点
  const bid = 'fixture_goto_building';
  s.addNode({ id: bid, name: '导航用例建筑', layer: 'building', layerLabel: '建筑',
              parentId: city.id, tags: [], sourcePath: '', coordinate: { x: 0, y: 0 }, draft: true });
  const navBuilding = s.focusEntityOnCanvas(bid);
  const viewBuilding = s.viewLevel;
  const curBuilding = s.currentBuilding ? s.currentBuilding.id : null;

  // 面板走的那条路：canvasBridge 的注册口
  const viaBridge = CB.gotoEntity(bid);
  const described = CB.describeCanvasBridge();

  // 清场
  s.removeNode(bid);
  const gone = !s.nodes.some(n => n.id === bid);

  return JSON.stringify({
    fails,
    info: {
      navPlanet, viewPlanet, curPlanet, planetId: planet.id,
      navRegionOk: !!(navRegion && navRegion.ok), viewRegion, curArea, regionId: region ? region.id : null,
      navBuildingOk: !!(navBuilding && navBuilding.ok), viewBuilding, curBuilding, bid,
      viaBridgeOk: !!(viaBridge && viaBridge.ok), gotoHandler: !!described.gotoHandler, gone,
      label: (navBuilding && navBuilding.viewLabel) || '',
    },
  });
})()"""
    ok, obj = eval_json(cdp, expr, desc='前往编辑直达画布')
    if not ok:
        return False, obj
    fails = list(obj.get('fails') or [])
    info = obj.get('info') or {}
    if not (info.get('navPlanet') or {}).get('ok') or info.get('viewPlanet') != 'planet':
        fails.append(f"行星导航失败 → {info}")
    if info.get('curPlanet') != info.get('planetId'):
        fails.append(f"行星导航 currentPlanet 不对 → {info}")
    if info.get('regionId'):
        if not info.get('navRegionOk') or info.get('viewRegion') != 'area' or info.get('curArea') != info.get('regionId'):
            fails.append(f"区域导航失败 → {info}")
    if not info.get('navBuildingOk') or info.get('viewBuilding') != 'interior' or info.get('curBuilding') != info.get('bid'):
        fails.append(f"建筑导航失败 → {info}")
    if not info.get('viaBridgeOk') or not info.get('gotoHandler'):
        fails.append(f"canvasBridge 的 goto 注册口未生效 → {info}")
    if not info.get('gone'):
        fails.append('导航用例建筑未清场')
    if fails:
        return False, '；'.join(fails)
    return True, (f"「前往编辑」直达画布：行星 → {info.get('viewPlanet')}（currentPlanet 一致）、"
                  f"区域 → {info.get('viewRegion')}（currentArea 一致）、"
                  f"建筑 → {info.get('viewBuilding')}（{info.get('label')}，currentBuilding 一致）；"
                  f"canvasBridge.gotoEntity 注册口可用")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'harness 基线项目未能打开：{info}'

    ok, msg = sub_source_contract(cdp)
    if not ok:
        return False, f'[a] 源码契约：{msg}'

    ok, msg = sub_readonly_zero_effect(cdp)
    if not ok:
        return False, f'[b] 只读零副作用：{msg}'

    ok, msg = sub_writable_works(cdp)
    if not ok:
        return False, f'[c] 可写态生效：{msg}'

    ok, msg = sub_batch_reparent(cdp)
    if not ok:
        return False, f'[d] 批量改父级：{msg}'

    ok, msg = sub_goto_canvas(cdp)
    if not ok:
        return False, f'[e] 前往编辑直达画布：{msg}'

    return True, ('内存编辑闸门（只读零副作用 + 拒绝回音 + 可写恢复）；批量改父级一条 undo（跳过/防循环）；'
                  '「前往编辑」经 canvasBridge 直达 行星/区域/建筑 三种视图')
