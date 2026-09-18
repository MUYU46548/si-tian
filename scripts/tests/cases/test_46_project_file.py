#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 46：`.sitian` 项目文件（Phase 1：独立运行基础）

背景：司天当前的事实源是 Obsidian 库（`<vault>/.sitian/geodata.json`）。要让它成为
「独立运行的世界观编辑器」，需要一个自有的项目文件（`.sitian`）：项目元信息 + 实体树 +
剧本 + 地图数据 + 自动快照，不依赖知识库即可新建/打开/保存。

本用例守三件事（Phase 1 的验收靶子）：
  a) 结构定义与校验修复：`utils/projectSchema.js` —— 空项目形状、实体 id 推导去重、
     createEntity 归一化、validateProject 的修复清单（悬空 parentId / 自引用 / 父子循环 /
     未知 layer / 坏快照 / 缺 meta）、高版本拒载、版本迁移入口
  b) 快照环形缓冲：**就地 diff**（不是整份拷贝）→ 恢复必须精确、裁剪后旧快照仍可恢复、
     keep 参数、校验后仍可回放（「1 份 base + ≤50 份 diff」不变式）
  c) projectStore 端到端（走 mock 的 sitianAPI）：创建项目 → 实体 CRUD（重名去重/重命名不改 id/
     循环移动拒绝/级联删除+undo）→ 保存（快照累积、saveStatus、dirty）→ 回滚快照 + 可撤销
  d) 静态一致性：main 注册 / preload 暴露的**通道名必须一一对应**、handler 顶层不得依赖 electron
     （否则 Node 单元测试跑不起来）、LAYER_LABELS 与 geodata.js 的 layerLabels 不得漂移、
     Phase 1 **不得接线**（geodata.js / App.vue 不得 import projectStore）

文件系统侧（真实落盘、原子写、备份轮转）由 `scripts/tests/unit/test_project_io.js` 守：
CDP 用例里的 sitianAPI 是 mock（不落盘），测不到主进程 I/O。
"""
import sys, os, json, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
APP = "document.querySelector('#app').__vue_app__"


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
# a) + b) projectSchema（纯函数，页面内 dynamic import）
# ─────────────────────────────────────────────────────────────
SCHEMA_JS = """(async () => {
  const S = await import('/src/utils/projectSchema.js');
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };

  // ---- 空项目形状 ----
  const p0 = S.createEmptyProject({ name: '测试项目' });
  same('空项目顶层键', Object.keys(p0).sort(), ['entities','hyperlanes','maps','meta','scenarios','snapshots','version'].sort());
  ck('version', p0.version === S.PROJECT_VERSION, p0.version);
  ck('meta 齐备', !!p0.meta.id && p0.meta.name === '测试项目' && !!p0.meta.created);
  ck('scenarios 容器为 v2 结构', p0.scenarios.version === 2 && typeof p0.scenarios.baseMaps === 'object' && typeof p0.scenarios.scenarios === 'object');
  ck('LAYER_LABELS 覆盖 LAYER_ORDER', S.LAYER_ORDER.every(l => !!S.LAYER_LABELS[l]), S.LAYER_ORDER.filter(l => !S.LAYER_LABELS[l]));
  ck('快照保留上限为 50', S.SNAPSHOT_KEEP === 50, S.SNAPSHOT_KEEP);
  ck('maps 不进快照键', S.SNAPSHOT_DIFF_KEYS.indexOf('maps') < 0, S.SNAPSHOT_DIFF_KEYS);

  // ---- 版本比较 / 迁移入口 ----
  ck('compareVersion', S.compareVersion('1.0.0','1.0.0') === 0 && S.compareVersion('1.1.0','1.0.0') === 1 && S.compareVersion('0.9.9','1.0.0') === -1);
  const mgSame = S.migrateProject(S.createEmptyProject({ name: 'x' }));
  ck('同版本无迁移步骤', mgSame.ok === true && mgSame.steps.length === 0);
  const mgHi = S.migrateProject({ version: '9.0.0' });
  ck('高版本迁移被拒', mgHi.ok === false && mgHi.project === null, mgHi);
  const vHi = S.validateProject({ version: '9.0.0', entities: {} });
  ck('高版本校验被拒', vHi.ok === false && vHi.project === null);

  // ---- 实体 id 推导 + 去重 ----
  same('entityIdFromName 中文保留', S.entityIdFromName('青崖城', []), '青崖城');
  same('entityIdFromName 去重', S.entityIdFromName('青崖城', ['青崖城']), '青崖城_2');
  same('entityIdFromName 二次去重', S.entityIdFromName('青崖城', ['青崖城','青崖城_2']), '青崖城_3');
  same('entityIdFromName 英文归一', S.entityIdFromName('New City', []), 'new_city');

  // ---- createEntity 归一化 ----
  const e = S.createEntity({ name: 'New City', layer: 'nope', coordinate: { x: 'abc', y: 7 }, tags: 'zz' });
  same('entity id', e.id, 'new_city');
  same('未知 layer → unknown', e.layer, 'unknown');
  same('非数值坐标 → null', e.coordinate, { x: null, y: 7 });
  same('非数组 tags → []', e.tags, []);
  ck('layerLabel 由 LAYER_LABELS 派生', e.layerLabel === S.LAYER_LABELS.unknown, e.layerLabel);
  ck('origin 默认 project', e.origin === 'project', e.origin);

  // ---- validateProject 修复清单 ----
  const nasty = {
    version: '1.0.0', meta: {},
    entities: {
      good: { id: 'good', name: '好', layer: 'nope', parentId: 'ghost', coordinate: { x: 'x', y: 3 }, tags: 'zz' },
      self: { id: 'self', name: '自引', layer: 'city', parentId: 'self' },
      c1: { id: 'c1', name: '环1', layer: 'city', parentId: 'c2' },
      c2: { id: 'c2', name: '环2', layer: 'city', parentId: 'c1' },
      '': { name: '空键' },
    },
    hyperlanes: [{ id: 'l1', fromId: 'good', toId: 'ghost' }, { fromId: 'good', toId: 'good' }],
    snapshots: [{ at: 't' }],
  };
  const v = S.validateProject(nasty);
  ck('validate ok', v.ok === true && !!v.project);
  ck('meta 补写', !!v.project.meta.id && !!v.project.meta.name && !!v.project.meta.created);
  same('实体集合（空键条目被丢弃）', Object.keys(v.project.entities).sort(), ['c1','c2','good','self']);
  same('悬空 parentId 置空', v.project.entities.good.parentId, null);
  same('未知 layer 归一', v.project.entities.good.layer, 'unknown');
  same('坐标清洗', v.project.entities.good.coordinate, { x: null, y: 3 });
  same('tags 清洗', v.project.entities.good.tags, []);
  same('自引用置空', v.project.entities.self.parentId, null);
  ck('父子循环被打破', v.project.entities.c1.parentId === null || v.project.entities.c2.parentId === null, [v.project.entities.c1.parentId, v.project.entities.c2.parentId]);
  same('无效航道被清除', v.project.hyperlanes.length, 0);
  same('损坏快照被丢弃', v.project.snapshots.length, 0);
  ck('问题清单有记录', v.problems.length >= 5, v.problems);

  const nb = S.validateProject({ version: '1.0.0', meta: {}, entities: {}, snapshots: [{ at: 't', patch: { set: [], del: [] } }] });
  same('无 base 的快照缓冲整体丢弃', nb.project.snapshots.length, 0);
  ck('给出基准缺失说明', nb.problems.some(t => t.indexOf('基准') >= 0), nb.problems);

  ck('非对象输入被拒', S.validateProject(null).ok === false && S.validateProject('x').ok === false);

  // ---- diff / applyPatch 往返 ----
  const A = { meta: { name: 'a', tags: ['x'] }, entities: { z: { id: 'z', name: 'Z' } }, hyperlanes: [] };
  const B = { meta: { name: 'b', tags: ['x','y'] }, entities: { z: { id: 'z', name: 'ZZ' }, w: { id: 'w' } }, hyperlanes: [{ id: 'l1' }] };
  same('diff → apply 往返一致', S.applyPatch(A, S.diffStates(A, B)), B);
  same('反向往返一致', S.applyPatch(B, S.diffStates(B, A)), A);
  ck('删除走 del 槽', S.diffStates(B, A).del.length >= 1, S.diffStates(B, A).del);
  ck('数组整体替换（不索引化）', S.diffStates(A, B).set.some(s => s.path.join('.') === 'meta.tags'), S.diffStates(A, B).set);
  ck('无变化 → 空补丁', S.diffStates(A, A).set.length === 0 && S.diffStates(A, A).del.length === 0);
  ck('applyPatch 不改入参', (() => { const src = JSON.parse(JSON.stringify(A)); S.applyPatch(src, S.diffStates(A, B)); return JSON.stringify(src) === JSON.stringify(A); })());

  // ---- 环形缓冲：上限 + 裁剪后仍能精确恢复 ----
  let p = S.createEmptyProject({ name: 'ring', id: 'p1' });
  const snapStates = [];
  for (let i = 0; i < 60; i++) {
    p = { ...p, entities: { ...p.entities, ['e' + i]: { id: 'e'+i, name: 'n'+i, layer: 'city', parentId: null, tags: [], coordinate: { x: i, y: i } } } };
    p = S.pushSnapshot(p, { at: '2026-01-01T00:00:' + (i < 10 ? '0' + i : String(i)) + '.000Z', label: 'k' + i });
    snapStates.push(p.entities);
  }
  same('快照上限 50', p.snapshots.length, 50);
  const ringBad = [];
  for (const idx of [0, 1, 7, 25, 48, 49]) {
    const r = S.restoreSnapshot(p, idx);
    if (!r.ok) { ringBad.push('restore ' + idx + ' 失败'); continue; }
    const want = snapStates[10 + idx];
    if (JSON.stringify(r.state.entities) !== JSON.stringify(want)) {
      ringBad.push('restore ' + idx + ' 不一致：' + Object.keys(r.state.entities).length + ' vs ' + Object.keys(want).length);
    }
  }
  ck('裁剪后旧快照仍能精确恢复', ringBad.length === 0, ringBad);
  ck('越界下标被拒', S.restoreSnapshot(p, 50).ok === false && S.restoreSnapshot(p, -1).ok === false && S.restoreSnapshot(p, 1.5).ok === false);
  ck('第 0 份带 base', p.snapshots[0].base !== undefined);
  ck('后续份只有 patch', p.snapshots[1].base === undefined && typeof p.snapshots[1].patch === 'object');

  // ---- keep 参数 ----
  let q = S.createEmptyProject({ name: 'keep' });
  for (let i = 0; i < 6; i++) { q = { ...q, meta: { ...q.meta, name: 'n' + i } }; q = S.pushSnapshot(q, { keep: 3 }); }
  same('keep=3 生效', q.snapshots.length, 3);
  same('keep=3 后最早一份正确', S.restoreSnapshot(q, 0).state.meta.name, 'n3');
  same('keep=3 后最新一份正确', S.restoreSnapshot(q, 2).state.meta.name, 'n5');

  // ---- 校验后再回放（保证落盘 → 读回 → 恢复这条链路成立）----
  const vp = S.validateProject(p);
  same('校验后快照保留', vp.project.snapshots.length, 50);
  same('校验后最后一份仍可回放', Object.keys(S.restoreSnapshot(vp.project, 49).state.entities).length, 60);
  same('校验后最早一份仍可回放', Object.keys(S.restoreSnapshot(vp.project, 0).state.entities).length, 11);

  // ---- 统计 / 序列化 ----
  const st = S.projectStats(vp.project);
  same('stats.entities', st.entities, 60);
  same('stats.snapshots', st.snapshots, 50);
  ck('stats.byLayer', st.byLayer.city === 60, st.byLayer);
  const sums = S.snapshotSummaries(vp.project);
  same('摘要条数', sums.length, 50);
  ck('摘要含 changes/label/at', typeof sums[49].changes === 'number' && sums[49].label === 'k59' && !!sums[49].at, sums[49]);
  ck('serialize 可再解析', JSON.parse(S.serializeProject(vp.project)).version === S.PROJECT_VERSION);

  // ---- 防循环的父级候选 ----
  const forest = { root: { id: 'root', parentId: null }, mid: { id: 'mid', parentId: 'root' }, leaf: { id: 'leaf', parentId: 'mid' } };
  same('父级候选排除自身与后代', S.forbiddenParentIds(forest, 'root').sort(), ['leaf','mid','root']);

  return JSON.stringify({ fails: fails });
})()"""


def sub_schema(cdp):
    ok, res = eval_json(cdp, SCHEMA_JS, desc='projectSchema')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, f'projectSchema 断言失败 {len(fails)} 项：' + '；'.join(fails[:8])
    return True, '空项目形状/修复清单/diff 往返/快照环形缓冲（含裁剪后精确恢复）全部通过'


# ─────────────────────────────────────────────────────────────
# c) projectStore 端到端（mock sitianAPI，内存态）
# ─────────────────────────────────────────────────────────────
STORE_JS = """(async () => {
  const app = @APP@;
  const pinia = (app && app.config && app.config.globalProperties) ? app.config.globalProperties.$pinia : null;
  if (!pinia) return JSON.stringify({ err: 'pinia-not-found' });
  const M = await import('/src/store/projectStore.js');
  const U = await import('/src/store/undo.js');
  const s = M.useProjectStore(pinia);
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };

  U.clearHistory();
  window.__projects = {};
  window.__projectCalls = [];

  // 1) 创建项目
  const cr = await s.createProject({ name: 'test46项目', dir: 'mock/projects' });
  ck('createProject 成功', cr.success === true, cr);
  // 前置失败立即中止：后续断言会因 store 空态抛 TypeError，那会把「失败」变成看不懂的异常
  if (cr.success !== true) return JSON.stringify({ fails: fails, aborted: 'createProject 失败：' + (cr.error || '') });
  ck('isOpen + meta.name', s.isOpen === true && s.meta.name === 'test46项目', s.meta);
  ck('filePath 指向 .sitian', String(s.filePath).indexOf('test46项目.sitian') > 0, s.filePath);
  same('projectDir', s.projectDir, 'mock/projects');
  ck('mock 记录 create', (window.__projectCalls || []).some(c => c.op === 'create'));

  // 2) 实体 CRUD
  const w = s.createEntity({ name: '世界', layer: 'world' });
  ck('createEntity（含 id 推导）', w.success === true && w.entity.id === '世界', w);
  s.createEntity({ name: '青崖城', layer: 'city', parentId: '世界', coordinate: { x: 1, y: 2 } });
  const c2 = s.createEntity({ name: '青崖城', layer: 'city', parentId: '世界' });
  same('重名自动去重', c2.entity.id, '青崖城_2');
  same('entityCount', s.entityCount, 3);
  same('previewEntityId', s.previewEntityId('青崖城'), '青崖城_3');
  same('entityTree 根数', s.entityTree.length, 1);
  same('entityTree 子数', s.entityTree[0].children.length, 2);
  same('childrenOf', s.childrenOf('世界').length, 2);
  // 父级候选：排除「自身 + 全部后代」。世界是根 → 其余实体都是它的后代 → 候选为空
  same('parentCandidates（根实体：无候选）', s.parentCandidates('世界').map(x => x.id).sort(), []);
  // 青崖城此刻还没有后代 → 只排除自身，兄弟（青崖城_2）与父级（世界）仍可选
  same('parentCandidates（仅排除自身）', s.parentCandidates('青崖城').map(x => x.id).sort(), ['世界', '青崖城_2']);
  const badParent = s.createEntity({ name: '孤儿', layer: 'city', parentId: '不存在' });
  ck('父实体不存在时拒绝创建', badParent.success === false, badParent);
  const dupId = s.createEntity({ id: '世界', name: '重复世界', layer: 'world' });
  ck('id 冲突时拒绝创建', dupId.success === false, dupId);

  // 3) 重命名不改 id、不动子实体的父子关系（此刻青崖城_2 仍挂在世界下）
  const rn = s.renameEntity('青崖城', '青崖新城');
  ck('重命名成功且 id 不变', rn.success === true && !!s.getEntity('青崖城') && s.getEntity('青崖城').name === '青崖新城', rn);
  ck('重命名未动子实体父子关系', s.getEntity('青崖城_2').parentId === '世界', s.getEntity('青崖城_2').parentId);
  ck('空名拒绝', s.renameEntity('青崖城', '   ').success === false);

  // 4) 循环移动拒绝 / 合法移动
  const cyc = s.moveEntity('世界', '青崖城');
  ck('移到自己的后代下被拒', cyc.success === false, cyc);
  const mv = s.moveEntity('青崖城_2', '青崖城');
  ck('合法移动生效', mv.success === true && s.childrenOf('青崖城').length === 1, mv);
  // 有了真正的后代之后，后代必须从父级候选里消失（防循环的 UI 入口）
  same('parentCandidates 排除自己的后代', s.parentCandidates('青崖城').map(x => x.id).sort(), ['世界']);
  const self = s.moveEntity('世界', '世界');
  ck('移到自己下被拒', self.success === false, self);

  // 5) 级联删除 + 单条 undo
  const del = s.deleteEntity('青崖城');
  same('级联删除包含后代', (del.deleted || []).sort(), ['青崖城', '青崖城_2']);
  same('删除后计数', s.entityCount, 1);
  U.undo();
  same('undo 恢复计数', s.entityCount, 3);
  ck('undo 恢复父子关系', s.getEntity('青崖城_2').parentId === '青崖城');
  const delOne = s.deleteEntity('青崖城', { cascade: false });
  ck('不级联删除时子实体上提到被删者的父级',
     delOne.success === true && !s.getEntity('青崖城') && s.getEntity('青崖城_2').parentId === '世界',
     { delOne: delOne, orphanParent: s.getEntity('青崖城_2') ? s.getEntity('青崖城_2').parentId : null });
  U.undo();
  same('上提删除可撤销', s.entityCount, 3);

  // 6) 保存 + 快照累积
  const sv = await s.saveProject({ label: '首次保存' });
  ck('saveProject 成功', sv.success === true, sv);
  same('快照 1 份', s.snapshots.length, 1);
  same('saveStatus', s.saveStatus, 'saved');
  same('dirty 清除', s.dirty, false);
  ck('mock 记录 save', (window.__projectCalls || []).some(c => c.op === 'save'));

  // 7) 再改再存 → 回滚第 1 份 + 可撤销
  s.createEntity({ name: '额外地点', layer: 'location', parentId: '世界' });
  same('改动后计数', s.entityCount, 4);
  const sv2 = await s.saveProject({ label: '第二次保存' });
  ck('第二次保存', sv2.success === true, sv2);
  same('快照 2 份', s.snapshots.length, 2);
  ck('第 2 份摘要带 label/changes', s.snapshots[1].label === '第二次保存' && s.snapshots[1].changes > 0, s.snapshots[1]);
  const rs = s.restoreProjectSnapshot(0);
  ck('回滚成功', rs.success === true, rs);
  same('回滚后计数', s.entityCount, 3);
  ck('回滚移除了新增实体', !s.getEntity('额外地点'));
  U.undo();
  same('回滚可撤销', s.entityCount, 4);

  // 8) 列表 / 关闭
  const ls = await s.refreshProjectList('mock/projects');
  ck('refreshProjectList 成功', ls.success === true && ls.items.length >= 1, ls);
  same('列表读到实体数', ls.items[0].entityCount, 4);
  s.closeProject();
  ck('closeProject', s.isOpen === false && s.filePath === '');
  // ⚠️ saveProject 是 async —— 漏 await 会拿到 Promise 上的 undefined（.success === false 恒假）
  const noProjectCreate = s.createEntity({ name: 'x' });
  const noProjectSave = await s.saveProject();
  ck('未打开项目时创建实体被拒', noProjectCreate.success === false, noProjectCreate);
  ck('未打开项目时保存被拒', noProjectSave.success === false, noProjectSave);

  return JSON.stringify({ fails: fails });
})()""".replace('@APP@', APP)


def sub_store(cdp):
    ok, res = eval_json(cdp, STORE_JS, desc='projectStore')
    if not ok:
        return False, res
    if res.get('err'):
        return False, f'projectStore 用例环境异常：{res["err"]}'
    if res.get('aborted'):
        return False, f'projectStore 前置步骤失败已中止：{res["aborted"]}'
    fails = res.get('fails') or []
    if fails:
        return False, f'projectStore 断言失败 {len(fails)} 项：' + '；'.join(fails[:8])
    return True, '创建/实体 CRUD（去重·重命名不改 id·循环拒绝·级联删除+undo）/保存+快照累积/快照回滚全部通过'


# ─────────────────────────────────────────────────────────────
# d) 静态一致性（源码读盘）
# ─────────────────────────────────────────────────────────────
def sub_static(cdp):
    bad = []
    schema = _read('src/renderer/src/utils/projectSchema.js')
    for sym in ('createEmptyProject', 'validateProject', 'migrateProject', 'pushSnapshot',
                'restoreSnapshot', 'diffStates', 'applyPatch', 'SNAPSHOT_KEEP', 'PROJECT_VERSION'):
        if sym not in schema:
            bad.append(f'projectSchema 缺少导出 {sym}')

    store = _read('src/renderer/src/store/projectStore.js')
    for sym in ('useProjectStore', 'createProject', 'openProject', 'saveProject',
                'createEntity', 'deleteEntity', 'renameEntity'):
        if sym not in store:
            bad.append(f'projectStore 缺少 {sym}')

    # Phase 1 必须保持「不接线」：现有 Obsidian 链路不得引用 projectStore
    for rel in ('src/renderer/src/store/geodata.js', 'src/renderer/src/App.vue'):
        if 'projectStore' in _read(rel):
            bad.append(f'{rel} 引用了 projectStore（Phase 1 应保持不接线，接线属 Phase 2）')

    # main 注册 + 通道名与 preload 一一对应
    if 'registerProjectHandlers' not in _read('src/main/index.js'):
        bad.append('main/index.js 未注册 projectHandler')
    handler = _read('src/main/handlers/projectHandler.js')
    lines = [l.strip() for l in handler.splitlines() if not l.strip().startswith('//')]
    if any(re.match(r"^(const .*=\s*)?require\('electron'\)", l) for l in lines):
        bad.append('projectHandler 顶层依赖 electron（Node 单元测试会跑不起来）')
    preload = _read('src/preload/index.js')
    for api in ('projectCreate', 'projectOpen', 'projectSave', 'projectList',
                'projectPickDir', 'projectReveal', 'projectBackupNow', 'projectGitSnapshot'):
        if api not in preload:
            bad.append(f'preload 未暴露 {api}')

    ch_handler = set(re.findall(r"ipcMain\.handle\('([^']+)'", handler))
    ch_preload = set(re.findall(r"ipcRenderer\.invoke\('(project-[^']+)'", preload))
    if ch_handler != ch_preload:
        bad.append(f'通道名不一致 handler={sorted(ch_handler)} preload={sorted(ch_preload)}')
    if len(ch_handler) != 8:
        bad.append(f'注册通道数异常：{len(ch_handler)}（期望 8）')

    # LAYER_LABELS 防漂移（与 geodata.js 的 layerLabels 必须同键同值）
    def label_map(src, marker):
        i = src.find(marker)
        if i < 0:
            return None
        block = src[i:src.find('}', i)]
        return dict(re.findall(r"(\w+)\s*:\s*'([^']*)'", block))

    a = label_map(_read('src/renderer/src/store/geodata.js'), 'layerLabels = {')
    b = label_map(schema, 'LAYER_LABELS = {')
    if not a or not b:
        bad.append('未找到 layerLabels / LAYER_LABELS 定义')
    elif a != b:
        diff = {k: (a.get(k), b.get(k)) for k in set(a) | set(b) if a.get(k) != b.get(k)}
        bad.append(f'layerLabels 与 LAYER_LABELS 漂移：{diff}')

    if bad:
        return False, '；'.join(bad)
    return True, ('preload 8 个 API ↔ 主进程 8 个通道一一对应；projectHandler 无 electron 顶层依赖；'
                  'layerLabels 两处一致；Phase 1 未接线（geodata/App 均未引用 projectStore）')


# ─────────────────────────────────────────────────────────────
def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{APP}._instance.setupState.store.nodes.length > 0", timeout=45, desc='地理数据加载')

    results = []
    for name, fn in (('a/b projectSchema（形状·修复·diff·快照环）', sub_schema),
                     ('c projectStore 端到端', sub_store),
                     ('d 静态一致性（通道名/漂移/未接线）', sub_static)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'.sitian 项目文件 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, '.sitian 项目文件 ' + f'{len(results)}/{len(results)} 全通过 — ' + '；'.join(d for _, _, d in results)
