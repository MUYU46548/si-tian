#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 40：Draft 转正 ID 连续性（2026-09-16）

背景：暂存（draft）节点的 id 是随机 id（`node_<ts>_<rand>`），而 extract-data 用
`normalizeId(文件名)` 作为节点 id。转正只回填 sourcePath、不改 id → 下次重提取会按文件名
再生成一个同义节点，而子节点 parentId / 地图数据 / 剧本归属仍指向旧 id（幽灵引用）。

覆盖：
  a) normalizeId 三处实现（extract-data.js / vault-watcher.js / utils/normalizeId.js）逐字符一致
     —— 「防漂移」是转正 id 推导的正确性前提（历史上 vault-watcher 就漂移过一次）
  b) normalizeId / basenameNoExt / nodeIdFromNoteResult 语义（纯函数，页面内实测）
  c) store.changeNodeId 级联完整性：子节点 parentId、航道端点、太空标记 systemId、
     区域/建筑数据字典键、建筑内部自引用字段、剧本 ownership 键、星域边界覆盖键
     —— 并验证 undo 回滚全部引用、redo 重新应用
  d) 碰撞降级：目标 id 已存在 → success:false 且零副作用（不改 id、不动引用）
  e) 转正 UI 全链路（详情面板按钮）：转正后 id === normalizeId(文件名)、子节点 parentId 跟随、
     面板给出 ok 提示
  f) 同名冲突时的 UI 降级：只回填 sourcePath，id 不变，面板给出 warn 提示（不阻断转正）
  g) 视图入口静态断言：NodeDetailPanel 与 AreaMap 的 promoteDraft 都经由 changeNodeId
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

TS = str(int(time.time()))
OLD_ID = 'test40_draft_' + TS
NEW_ID = 'test40_promoted_' + TS
CHILD_ID = 'test40_child_' + TS
PROMOTE_NAME = '转正测试城' + TS      # 期望 id：normalizeId 保留中文与数字 → 原样
PROMOTE_EXPECT = '转正测试城' + TS
CONFLICT_NAME = '冲突测试城' + TS
OK_PREFIX = 'test40_ok_' + TS        # UI 转正用例的 draft id
CONFLICT_OLD_ID = 'test40_conflict_' + TS
PLANET_OLD_ID = 'test40_planet_' + TS   # 行星地图 key 迁移（mapData 字典键）+ memberIds 数组槽
PLANET_NEW_ID = 'test40_planet_new_' + TS


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _read(rel):
    with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
        return f.read()


# ─────────────────────────────────────────────────────────────
# a) 三处 normalizeId 实现一致性（源码比对，纯 Python 读盘）
# ─────────────────────────────────────────────────────────────
def sub_impl_drift_check(cdp):
    targets = {
        'scripts/extract-data.js': None,
        'src/main/vault-watcher.js': None,
        'src/renderer/src/utils/normalizeId.js': None,
    }
    for rel in targets:
        src = _read(rel)
        lines = [l.strip() for l in src.splitlines() if 'return name.replace' in l]
        if not lines:
            return False, f'{rel} 未找到 normalizeId 的实现行'
        targets[rel] = lines[0]
    impls = set(targets.values())
    if len(impls) != 1:
        return False, ('normalizeId 三处实现不一致（同一文件名会得到不同 id）：'
                       + ' | '.join(f'{k} → {v}' for k, v in targets.items()))
    # renderer 侧额外导出面：转正流程依赖 basenameNoExt / nodeIdFromNoteResult
    util = _read('src/renderer/src/utils/normalizeId.js')
    for fn in ('export function normalizeId', 'export function basenameNoExt', 'export function nodeIdFromNoteResult'):
        if fn not in util:
            return False, f'utils/normalizeId.js 缺少导出：{fn}'
    return True, '三处实现逐字符一致，renderer 侧导出齐备'


# ─────────────────────────────────────────────────────────────
# b) 纯函数语义
# ─────────────────────────────────────────────────────────────
def sub_normalize_semantics(cdp):
    res = _j(cdp, """(async () => {
      const N = await import('/src/utils/normalizeId.js');
      const cases = [
        ['[[青崖城]]', '青崖城'],
        ['New City', 'new_city'],
        ['青崖城·东', '青崖城东'],
        ['A/B\\\\C', 'a_b_c'],
        ['', 'unknown'],
        [null, 'unknown'],
      ];
      const fails = [];
      for (const [input, expect] of cases) {
        const got = N.normalizeId(input);
        if (got !== expect) fails.push({ input, expect, got });
      }
      const base = N.basenameNoExt('03 设定/02 场景地点/青崖城.md');
      if (base !== '青崖城') fails.push({ base });
      const base2 = N.basenameNoExt('a\\\\b\\\\New City.MD');
      if (base2 !== 'New City') fails.push({ base2 });
      const r1 = N.nodeIdFromNoteResult({ filename: '青崖城' });
      const r2 = N.nodeIdFromNoteResult({ path: 'a/b/New City.md' });
      const r3 = N.nodeIdFromNoteResult({ path: '' }, '青崖城');
      if (r1 !== '青崖城') fails.push({ r1 });
      if (r2 !== 'new_city') fails.push({ r2 });
      if (r3 !== '青崖城') fails.push({ r3 });
      return JSON.stringify({ fails });
    })()""")
    if not isinstance(res, dict):
        return False, f'模块导入/求值失败 {res}'
    if res.get('fails'):
        return False, f'normalizeId 语义不符：{res["fails"]}'
    return True, 'normalizeId / basenameNoExt / nodeIdFromNoteResult 语义正确'


# ─────────────────────────────────────────────────────────────
# c) changeNodeId 级联完整性 + undo/redo
# ─────────────────────────────────────────────────────────────
CASCADE_JS = """(async () => {
  const s = @STORE@;
  const OLD = @OLD@, NEW = @NEW@, CHILD = @CHILD@;
  const planet = s.nodes.find(n => n.layer === 'planet');
  const planetId = planet ? planet.id : null;

  // ---- 布置引用（覆盖全部级联位置）----
  s.addNode({ id: OLD, name: 'ID连续性测试点@TS@', layer: 'city', parentId: planetId,
    tags: [], sourcePath: '', coordinate: { x: 1, y: 2 }, draft: true });
  s.addNode({ id: CHILD, name: '子地点@TS@', layer: 'facility', parentId: OLD,
    tags: [], sourcePath: 'x.md', coordinate: { x: 1, y: 3 } });
  const hl = s.addHyperlane(OLD, planetId || OLD, 'local');
  s.addSpaceMarker({ id: 'test40_sm_@TS@', systemId: OLD, x: 0, y: 0, type: 'anomaly', label: '' });
  s.addAreaZone(OLD, { id: 'test40_zone_@TS@', name: '测试区域', points: [], color: '#fff' });
  s.interiorData[OLD] = { buildingId: OLD, floors: [] };
  s.domainBorderOverrides[OLD] = [{ x: 0, y: 0 }];
  // mock 环境不加载真实剧本（loadScenarios 返回空）→ 就地建一个临时剧本再播种归属
  let ownedScenario = null;
  if (!Object.keys(s.scenarios || {}).length) {
    ownedScenario = 'test40_scen';
    s.createScenario(ownedScenario, { ownerKey: null, name: 'ID级联测试剧本', polities: [] });
  }
  const scId = Object.keys(s.scenarios || {})[0] || null;
  let ownSeeded = false;
  if (scId) {
    s.setOwnership(scId, OLD, 'pol_test40');
    ownSeeded = s.scenarios[scId].ownership[OLD] === 'pol_test40';
  }

  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const own = () => (scId ? s.scenarios[scId].ownership : {});
  const hlHit = (id) => !!(hl && s.hyperlanes.some(h => h.fromId === id || h.toId === id));
  const smHit = (id) => s.spaceMarkers.some(m => m.id === 'test40_sm_@TS@' && m.systemId === id);

  // ---- 变更 ----
  const res = s.changeNodeId(OLD, NEW);

  const applied = {
    ok: res && res.success === true && res.changed === true,
    refs: res ? res.refs : -1,
    dictKeys: res ? res.dictKeys : -1,
    nodeId: s.nodes.some(n => n.id === NEW) && !s.nodes.some(n => n.id === OLD),
    child: (s.nodes.find(n => n.id === CHILD) || {}).parentId === NEW,
    hyperlane: hlHit(NEW),
    spaceMarker: smHit(NEW),
    areaZoneKey: has(s.areaZones, NEW) && !has(s.areaZones, OLD),
    interiorKey: has(s.interiorData, NEW) && !has(s.interiorData, OLD),
    interiorSelf: (s.interiorData[NEW] || {}).buildingId === NEW,
    borderOverride: has(s.domainBorderOverrides, NEW) && !has(s.domainBorderOverrides, OLD),
    scenarioOwn: ownSeeded ? (has(own(), NEW) && own()[NEW] === 'pol_test40' && !has(own(), OLD)) : 'skipped',
  };

  // ---- undo：全部引用必须回到旧 id ----
  s.undo();
  const undone = {
    nodeId: s.nodes.some(n => n.id === OLD) && !s.nodes.some(n => n.id === NEW),
    child: (s.nodes.find(n => n.id === CHILD) || {}).parentId === OLD,
    hyperlane: hlHit(OLD),
    spaceMarker: smHit(OLD),
    areaZoneKey: has(s.areaZones, OLD) && !has(s.areaZones, NEW),
    interiorKey: has(s.interiorData, OLD) && !has(s.interiorData, NEW),
    interiorSelf: (s.interiorData[OLD] || {}).buildingId === OLD,
    borderOverride: has(s.domainBorderOverrides, OLD) && !has(s.domainBorderOverrides, NEW),
    scenarioOwn: ownSeeded ? (has(own(), OLD) && !has(own(), NEW)) : 'skipped',
  };

  // ---- redo：应用态复现 ----
  s.redo();
  const redone = {
    nodeId: s.nodes.some(n => n.id === NEW) && !s.nodes.some(n => n.id === OLD),
    child: (s.nodes.find(n => n.id === CHILD) || {}).parentId === NEW,
    areaZoneKey: has(s.areaZones, NEW),
    interiorKey: has(s.interiorData, NEW),
    scenarioOwn: ownSeeded ? has(own(), NEW) : 'skipped',
  };

  // ---- 碰撞：目标 id 已存在 → 零副作用 ----
  s.undo(); // 回到 OLD
  const collide = s.changeNodeId(OLD, CHILD);
  const collision = {
    rejected: collide && collide.success === false,
    reason: collide ? collide.reason : '',
    nodeUntouched: s.nodes.some(n => n.id === OLD),
    childUntouched: (s.nodes.find(n => n.id === CHILD) || {}).parentId === OLD,
  };

  // ---- 目标 id 为空 / 相同 id 的边界 ----
  const same = s.changeNodeId(OLD, OLD);
  const empty = s.changeNodeId(OLD, '');
  const missing = s.changeNodeId('test40_not_exist', NEW);
  const edges = {
    same: same && same.success === true && same.changed === false,
    empty: empty && empty.success === false,
    missing: missing && missing.success === false,
  };

  return JSON.stringify({ res, applied, undone, redone, collision, edges, ownSeeded, ownedScenario });
})()"""


def sub_cascade(cdp):
    js = (CASCADE_JS
          .replace('@STORE@', STORE)
          .replace('@OLD@', json.dumps(OLD_ID))
          .replace('@NEW@', json.dumps(NEW_ID))
          .replace('@CHILD@', json.dumps(CHILD_ID))
          .replace('@TS@', TS))
    res = _j(cdp, js)
    if not isinstance(res, dict):
        return False, f'级联用例求值失败 {res}'

    bad = []
    app = res.get('applied', {})
    for k, v in app.items():
        if v is False:
            bad.append(f'变更后 {k} 未跟随')
    if app.get('refs', 0) < 1:
        bad.append('未采集到任何引用槽（refs=0）')
    if not res.get('ownSeeded'):
        bad.append('剧本 ownership 夹具未建立（无 scenario，级联该分支未覆盖）')

    for k, v in res.get('undone', {}).items():
        if v is False:
            bad.append(f'undo 后 {k} 未恢复')
    for k, v in res.get('redone', {}).items():
        if v is False:
            bad.append(f'redo 后 {k} 未复现')

    col = res.get('collision', {})
    if not col.get('rejected'):
        bad.append(f'碰撞未被拒绝（{col}）')
    if not col.get('nodeUntouched') or not col.get('childUntouched'):
        bad.append('碰撞时产生了副作用')
    for k, v in res.get('edges', {}).items():
        if not v:
            bad.append(f'边界分支异常：{k}')

    if bad:
        return False, 'changeNodeId 级联/撤销不完整：' + '；'.join(bad)
    return True, (f'级联 {app.get("refs")} 处引用 + {app.get("dictKeys")} 个字典键全部跟随，'
                  f'undo/redo 双向可逆，碰撞与边界分支正常')


# ─────────────────────────────────────────────────────────────
# d) 行星地图字典键迁移 + memberIds 数组槽（mapData 深层引用）
# ─────────────────────────────────────────────────────────────
MAPDATA_JS = """(async () => {
  const s = @STORE@;
  const OLD = @OLDP@, NEW = @NEWP@;
  s.addNode({ id: OLD, name: '行星id迁移测试@TS@', layer: 'planet', parentId: null,
    tags: [], sourcePath: '', coordinate: { x: 0, y: 0 }, draft: true });
  s.mapData[OLD] = {
    planetId: OLD, version: 1, terrain: [], regions: [{ id: 'test40_r1', name: '区域', nodeId: OLD, points: [] }],
    markers: [{ id: 'test40_m1', nodeId: OLD, x: 0, y: 0 }], routes: [], textLabels: [],
    clusters: [{ id: 'test40_c1', name: '聚簇', memberIds: [OLD], color: '#fff', collapsed: false }],
    gridWidth: 1, gridHeight: 1, terrainGrid: [0], heightmap: { h: [0], grid: { points: [] } },
  };
  const res = s.changeNodeId(OLD, NEW);
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const applied = {
    ok: res && res.success === true,
    keyRenamed: has(s.mapData, NEW) && !has(s.mapData, OLD),
    planetIdField: (s.mapData[NEW] || {}).planetId === NEW,
    regionNodeId: ((((s.mapData[NEW] || {}).regions || [])[0] || {}).nodeId) === NEW,
    markerNodeId: ((((s.mapData[NEW] || {}).markers || [])[0] || {}).nodeId) === NEW,
    clusterMember: (((((s.mapData[NEW] || {}).clusters || [])[0] || {}).memberIds) || [])[0] === NEW,
    warnings: (res && res.warnings) ? res.warnings.length : -1,
  };
  s.undo();
  const undone = {
    keyRenamed: has(s.mapData, OLD) && !has(s.mapData, NEW),
    planetIdField: (s.mapData[OLD] || {}).planetId === OLD,
    regionNodeId: ((((s.mapData[OLD] || {}).regions || [])[0] || {}).nodeId) === OLD,
    clusterMember: (((((s.mapData[OLD] || {}).clusters || [])[0] || {}).memberIds) || [])[0] === OLD,
  };
  return JSON.stringify({ applied, undone });
})()"""


def sub_mapdata_key_migration(cdp):
    js = (MAPDATA_JS
          .replace('@STORE@', STORE)
          .replace('@OLDP@', json.dumps(PLANET_OLD_ID))
          .replace('@NEWP@', json.dumps(PLANET_NEW_ID))
          .replace('@TS@', TS))
    res = _j(cdp, js)
    if not isinstance(res, dict):
        return False, f'mapData 键迁移用例求值失败 {res}'
    bad = []
    for k, v in res.get('applied', {}).items():
        if v is False:
            bad.append(f'变更后 {k} 未跟随')
    if res.get('applied', {}).get('warnings', 0) < 1:
        bad.append('行星地图迁移未给出告警')
    for k, v in res.get('undone', {}).items():
        if v is False:
            bad.append(f'undo 后 {k} 未恢复')
    if bad:
        return False, '行星地图 key 迁移异常：' + '；'.join(bad)
    return True, 'mapData 字典键随 id 迁移，planetId/regions.nodeId/markers.nodeId/clusters.memberIds 全部跟随并可撤销'


# ─────────────────────────────────────────────────────────────
# e) 转正 UI 全链路
# ─────────────────────────────────────────────────────────────
def sub_promote_ui(cdp):
    made = _j(cdp, """(() => {
      const s = @STORE@;
      const planet = s.nodes.find(n => n.layer === 'planet');
      s.addNode({ id: @OKID@, name: @NAME@, layer: 'city',
        parentId: planet ? planet.id : null, tags: [], sourcePath: '',
        coordinate: { x: 5, y: 5 }, draft: true });
      s.addNode({ id: @CHILD@, name: '转正子地点@TS@', layer: 'facility',
        parentId: @OKID@, tags: [], sourcePath: '', coordinate: { x: 6, y: 6 }, draft: true });
      const n = s.nodes.find(x => x.id === @OKID@);
      if (!n) return JSON.stringify({ err: 'addNode-failed' });
      s.selectNode(n);
      return JSON.stringify({ id: n.id, draft: n.draft === true });
    })()""".replace('@STORE@', STORE)
       .replace('@OKID@', json.dumps(OK_PREFIX))
       .replace('@NAME@', json.dumps(PROMOTE_NAME))
       .replace('@CHILD@', json.dumps(CHILD_ID + '_ui'))
       .replace('@TS@', TS))
    if not isinstance(made, dict) or 'id' not in made:
        return False, f'暂存节点创建失败 {made}'

    wait_for(cdp, "!!document.querySelector('.detail-panel .actions-section-top')", desc='详情面板操作区')
    time.sleep(0.3)

    res = _j(cdp, """(async () => {
      const s = @STORE@;
      const sec = document.querySelector('.detail-panel .actions-section-top');
      if (!sec) return JSON.stringify({ err: 'no-panel' });
      const btn = Array.from(sec.querySelectorAll('button'))
        .find(b => b.textContent.includes('创建 Obsidian 笔记'));
      if (!btn) return JSON.stringify({ err: 'no-promote-btn' });
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      const notice = document.querySelector('[data-testid="promote-notice"]');
      const newNode = s.nodes.find(n => n.id === @EXPECT@);
      const child = s.nodes.find(n => n.id === @CHILD@);
      return JSON.stringify({
        expectId: @EXPECT@,
        oldStillThere: s.nodes.some(n => n.id === @OKID@),
        newNodeFound: !!newNode,
        sourcePath: newNode ? newNode.sourcePath : null,
        draft: newNode ? newNode.draft : null,
        childParent: child ? child.parentId : null,
        noticeText: notice ? notice.textContent.trim() : null,
        noticeKind: notice ? notice.className : null,
      });
    })()""".replace('@STORE@', STORE)
       .replace('@EXPECT@', json.dumps(PROMOTE_EXPECT))
       .replace('@CHILD@', json.dumps(CHILD_ID + '_ui'))
       .replace('@OKID@', json.dumps(OK_PREFIX)))
    if not isinstance(res, dict):
        return False, f'转正链路求值失败 {res}'
    bad = []
    if not res.get('newNodeFound'):
        bad.append(f'转正后未出现 id = {res.get("expectId")} 的节点（id 未同步）')
    if res.get('oldStillThere'):
        bad.append('旧随机 id 仍然存在（id 未切换）')
    if not res.get('sourcePath'):
        bad.append('sourcePath 未回填')
    if res.get('draft') is not False:
        bad.append('draft 标记未清除')
    if res.get('childParent') != PROMOTE_EXPECT:
        bad.append(f'子节点 parentId 未跟随（{res.get("childParent")}）')
    if not res.get('noticeText') or 'id 同步为' not in (res.get('noticeText') or ''):
        bad.append(f'缺少 id 同步提示（{res.get("noticeText")}）')
    if 'ok' not in (res.get('noticeKind') or ''):
        bad.append(f'提示样式非 ok（{res.get("noticeKind")}）')
    if bad:
        return False, '转正 UI 链路异常：' + '；'.join(bad)
    return True, f'转正后 id 同步为「{PROMOTE_EXPECT}」，子节点 parentId 跟随，面板提示 ok'


# ─────────────────────────────────────────────────────────────
# f) 同名冲突 → 降级（不阻断转正，UI 提示 warn）
# ─────────────────────────────────────────────────────────────
def sub_collision_fallback(cdp):
    made = _j(cdp, """(() => {
      const s = @STORE@;
      const planet = s.nodes.find(n => n.layer === 'planet');
      // 占位节点：id 恰为「草稿名的 normalizeId」→ 转正时必然撞车
      s.addNode({ id: @TARGET@, name: @TARGET@, layer: 'city',
        parentId: planet ? planet.id : null, tags: [], sourcePath: 'blocker.md',
        coordinate: { x: 9, y: 9 } });
      s.addNode({ id: @OLD@, name: @TARGET@, layer: 'village',
        parentId: planet ? planet.id : null, tags: [], sourcePath: '',
        coordinate: { x: 8, y: 8 }, draft: true });
      const n = s.nodes.find(x => x.id === @OLD@);
      if (!n) return JSON.stringify({ err: 'addNode-failed' });
      s.selectNode(n);
      return JSON.stringify({ ok: true });
    })()""".replace('@STORE@', STORE)
       .replace('@TARGET@', json.dumps(CONFLICT_NAME))
       .replace('@OLD@', json.dumps(CONFLICT_OLD_ID)))
    if not isinstance(made, dict) or not made.get('ok'):
        return False, f'冲突夹具创建失败 {made}'

    wait_for(cdp, "!!document.querySelector('.detail-panel .actions-section-top')", desc='详情面板操作区')
    time.sleep(0.3)

    res = _j(cdp, """(async () => {
      const s = @STORE@;
      const sec = document.querySelector('.detail-panel .actions-section-top');
      const btn = Array.from(sec.querySelectorAll('button'))
        .find(b => b.textContent.includes('创建 Obsidian 笔记'));
      if (!btn) return JSON.stringify({ err: 'no-promote-btn' });
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      const notice = document.querySelector('[data-testid="promote-notice"]');
      const blocker = s.nodes.find(n => n.id === @TARGET@);
      const draft = s.nodes.find(n => n.id === @OLD@);
      return JSON.stringify({
        blockerIntact: !!blocker && blocker.sourcePath === 'blocker.md',
        draftKeptId: !!draft,
        draftSourcePath: draft ? draft.sourcePath : null,
        draftCleared: draft ? draft.draft === false : null,
        noticeText: notice ? notice.textContent.trim() : null,
        noticeKind: notice ? notice.className : null,
      });
    })()""".replace('@STORE@', STORE)
       .replace('@TARGET@', json.dumps(CONFLICT_NAME))
       .replace('@OLD@', json.dumps(CONFLICT_OLD_ID)))
    if not isinstance(res, dict):
        return False, f'冲突降级用例求值失败 {res}'
    bad = []
    if not res.get('blockerIntact'):
        bad.append('占用方节点被误改')
    if not res.get('draftKeptId'):
        bad.append('降级后节点 id 被改动（应保持不变）')
    if not res.get('draftSourcePath'):
        bad.append('降级后未回填 sourcePath（转正被阻断）')
    if res.get('draftCleared') is not True:
        bad.append('降级后 draft 标记未清除')
    if '同名笔记已存在' not in (res.get('noticeText') or ''):
        bad.append(f'缺少同名冲突提示（{res.get("noticeText")}）')
    if 'warn' not in (res.get('noticeKind') or ''):
        bad.append(f'提示样式非 warn（{res.get("noticeKind")}）')
    if bad:
        return False, '冲突降级异常：' + '；'.join(bad)
    return True, '同名冲突时 id 保持不变、转正未阻断、面板提示 warn'


# ─────────────────────────────────────────────────────────────
# g) 两个转正入口都经由 changeNodeId（源码断言）
# ─────────────────────────────────────────────────────────────
def sub_view_entry_static(cdp):
    bad = []
    for rel, marker in (('src/renderer/src/components/NodeDetailPanel.vue', 'promote-notice'),
                        ('src/renderer/src/components/AreaMap.vue', 'area-promote-notice')):
        src = _read(rel)
        idx = src.find('async function promoteDraft')
        if idx < 0:
            bad.append(f'{rel} 未找到 promoteDraft')
            continue
        body = src[idx:idx + 4000]
        if 'store.changeNodeId(' not in body:
            bad.append(f'{rel} 的 promoteDraft 未调用 changeNodeId')
        if 'nodeIdFromNoteResult(' not in body:
            bad.append(f'{rel} 的 promoteDraft 未用 nodeIdFromNoteResult 推导新 id')
        if marker not in src:
            bad.append(f'{rel} 缺少转正提示节点（{marker}）')
    if bad:
        return False, '；'.join(bad)
    return True, '详情面板与区域地图的转正入口均经由 changeNodeId，且都带结果提示'


# ─────────────────────────────────────────────────────────────
def _cleanup(cdp):
    js = """(() => {
      const s = @STORE@;
      const ids = [@OLD@, @NEW@, @CHILD@, @OKID@, @CHILDU@, @CONFLICT@, @TARGET@, @POLD@, @PNEW@];
      for (const id of ids) {
        if (s.nodes.some(n => n.id === id)) s.removeNode(id);
      }
      const hl = s.hyperlanes.find(h => h.fromId === @NEW@ || h.toId === @NEW@
                                    || h.fromId === @OLD@ || h.toId === @OLD@);
      if (hl) s.removeHyperlane(hl.id);
      const sm = s.spaceMarkers.find(m => m.id === 'test40_sm_@TS@');
      if (sm) s.removeSpaceMarker(sm.id);
      for (const id of [@OLD@, @NEW@]) {
        if (s.areaZones[id]) delete s.areaZones[id];
        if (s.interiorData[id]) delete s.interiorData[id];
        if (s.domainBorderOverrides[id]) delete s.domainBorderOverrides[id];
        for (const k of Object.keys(s.scenarios || {})) {
          if (s.scenarios[k].ownership && s.scenarios[k].ownership[id]) s.clearOwnership(k, id);
        }
      }
      if (s.scenarios && s.scenarios['test40_scen']) s.removeScenario('test40_scen');
      for (const id of [@POLD@, @PNEW@]) { if (s.mapData && s.mapData[id]) delete s.mapData[id]; }
      s.clearSelection();
      return 'cleaned';
    })()""".replace('@STORE@', STORE) \
        .replace('@OLD@', json.dumps(OLD_ID)) \
        .replace('@NEW@', json.dumps(NEW_ID)) \
        .replace('@CHILD@', json.dumps(CHILD_ID)) \
        .replace('@CHILDU@', json.dumps(CHILD_ID + '_ui')) \
        .replace('@OKID@', json.dumps(OK_PREFIX)) \
        .replace('@CONFLICT@', json.dumps(CONFLICT_OLD_ID)) \
        .replace('@TARGET@', json.dumps(CONFLICT_NAME)) \
        .replace('@POLD@', json.dumps(PLANET_OLD_ID)) \
        .replace('@PNEW@', json.dumps(PLANET_NEW_ID)) \
        .replace('@TS@', TS)
    try:
        cdp.eval(js)
    except Exception:
        pass


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    results = []
    for name, fn in (('a normalizeId 三处一致', sub_impl_drift_check),
                     ('b 纯函数语义', sub_normalize_semantics),
                     ('c 级联 + undo/redo', sub_cascade),
                     ('d mapData 键与成员数组', sub_mapdata_key_migration),
                     ('e 转正 UI 全链路', sub_promote_ui),
                     ('f 同名冲突降级', sub_collision_fallback),
                     ('g 视图入口静态断言', sub_view_entry_static)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    _cleanup(cdp)

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'Draft 转正 id 连续性 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('Draft 转正 id 连续性 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
