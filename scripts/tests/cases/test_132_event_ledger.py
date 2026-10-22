#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 132：事件账本（三刀序列·第一刀）—— 数据层接线与往返

施工单验收线（`02-司天-三刀序列.md` 任务一）：
  · 纯数据层：事件录入接口（谁 / 什么事 / 起 / 止）、时间轴排序、状态查询（某时间点各方关系）；
  · 全自测：录入 → 查询 → 边界（同日多事件 / 跨年事件 / 事件冲突）；
  · 用户抽查一问（「X 年 Y 和 Z 什么关系」）账本能答对。

本用例守的是**接线与往返**（纯函数层的判据在 `unit/test_scenario_event_ledger.js`）：
  a 源码闸门：账本只有一份实现（`utils/scenarioEventLedger.js`），store 只搬数据；
    命令行工具与迁移工具共用 `scripts/lib/loadRendererUtils.mjs`（不许再抄第三份 loader）
  b 录入：`addTimelineEvent` 走 store → 事件进 `scenario.timelineEvents`，坏输入**整条拒绝**并点名；
  c 查询：`queryRelationAt` 答得出「2004 年甲乙什么关系」，战争终止后不会谎称「没有记录」；
  d 冲突：同日/重叠的相反关系被 `auditTimelineEvents` 报出来（不是静默合并）；
  e 撤销：一次录入 = 一条 undo；undo/redo 前后事件表逐字节可复原；
  f 落盘：等自动保存 → 项目载荷里真有 `timelineEvents`（可 JSON 往返）；
  g 重载：`applyScenarioState(fresh)` 之后查询仍答得对（= 载入→查询不丢）；
  h 级联：删势力连带删它的事件，一条 undo 全部还原（与 ownership/changeEvents 同一条纪律）。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for          # noqa: E402
from lib.helpers import ensure_case_state       # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
KEY = 'case132'
SC = KEY + '/账本时代'


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥注释再判源码（注释里写着旧实现会自己判自己 —— test_59/71/75 的教训）。"""
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


def source_gates():
    fails, notes = [], []
    ledger = _code_only(_read('src/renderer/src/utils/scenarioEventLedger.js'))
    for sym in ['export const EVENT_TYPES', 'export function makeEvent',
                'export function relationBetween', 'export function relationsAt',
                'export function findConflicts', 'export function describeRelation']:
        if sym not in ledger:
            fails.append(f'scenarioEventLedger 缺少 {sym}（账本必须单源）')
    dates = _code_only(_read('src/renderer/src/utils/scenarioDates.js'))
    if 'export function parseDateText' not in dates:
        fails.append('scenarioDates 缺少 parseDateText（文本日期解析必须单源）')

    store = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    if "from '../../utils/scenarioEventLedger'" not in store:
        fails.append('scenarioEditing 没引 scenarioEventLedger（会出现第二套校验/窗口比较）')

    def fn_body(src, name):
        at = src.find('function ' + name)
        if at < 0:
            return ''
        nxt = src.find('\n  function ', at + 1)
        return src[at:nxt if nxt > 0 else len(src)]

    for fn, marker in (('addTimelineEvent', 'appendEvent('),
                       ('updateTimelineEvent', 'replaceEvent('),
                       ('removeTimelineEvent', 'removeEvent('),
                       ('setTimelineEvents', 'appendEvent(')):
        body = fn_body(store, fn)
        if not body:
            fails.append(f'store 缺少 {fn}')
            continue
        if 'execute(' not in body:
            fails.append(f'{fn} 没走 execute()（只读态拦不住、Ctrl+Z 也回不来）')
        if marker not in body:
            fails.append(f'{fn} 没调用纯函数层的 {marker}（自己又写了一套）')
    if 'timelineEvents' not in fn_body(store, 'removePolity'):
        fails.append('removePolity 没有级联 timelineEvents —— 删完势力会留下一堆无主事件')

    tool = _read('scripts/ledger-query.mjs')
    if "from './lib/loadRendererUtils.mjs'" not in tool:
        fails.append('ledger-query 没用共享 loader（第三份 loader 迟早改漏扩展名规则）')
    if 'pathToFileURL' in tool:
        fails.append('ledger-query 自己实现了 loader（不该出现 pathToFileURL）')
    mig = _read('scripts/migrate-ledger-v2.mjs')
    if "from './lib/loadRendererUtils.mjs'" not in mig:
        fails.append('migrate-ledger-v2 还在自己抄 loader（本用例要求收敛到一份）')

    notes.append('源码闸门：账本单源 / store 只搬数据 / loader 共用')
    return fails, notes


SEED_JS = r"""
(() => {
  const s = __STORE__;
  const SC = __SC__;
  if (s.scenarios[SC]) s.removeScenario(SC);
  s.createScenario(SC, {
    ownerKey: __KEY__, name: '账本时代', order: 99,
    era: { roman: 'T', label: '账本', startYear: '2000', endYear: '2010' },
    polities: [{ id: 'P1', name: '甲国' }, { id: 'P2', name: '乙国' }, { id: 'P3', name: '丙国' }],
    ownership: {}, changeEvents: {},
  });
  return JSON.stringify({
    ok: !!s.scenarios[SC],
    polities: (s.scenarios[SC].polities || []).length,
    events: (s.scenarios[SC].timelineEvents || []).length,
  });
})()
"""

MAIN_JS = r"""
(async () => {
  const fails = [];
  const notes = {};
  const s = __STORE__;
  const SC = __SC__;
  const ok = (name, cond, extra) => { if (!cond) fails.push(name + (extra === undefined ? '' : '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)))); };
  const events = () => (s.scenarios[SC] && s.scenarios[SC].timelineEvents) || [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── b 录入 ────────────────────────────────────────────────────────────────
  const add = s.addTimelineEvent(SC, {
    type: 'war', actors: ['P1', 'P2'], from: '2003-02-01', to: '2006-08-01', title: '甲乙战争',
  });
  ok('b1 录入战争被接受', !!(add && add.ok), add && (add.errors || add.reason));
  ok('b2 事件落进 scenario.timelineEvents', events().length === 1, events().length);
  ok('b3 id 为 ev1', !!(add && add.event && add.event.id === 'ev1'), add && add.event && add.event.id);
  ok('b4 日期被规整成 {y,m,d}', !!(add && add.event && add.event.from && add.event.from.y === 2003
     && add.event.to && add.event.to.d === 1), add && add.event && add.event.to);

  const bad = s.addTimelineEvent(SC, {
    type: 'war', actors: ['P1', 'P2'], from: '2006', to: '2003', title: '倒着的战争',
  });
  ok('b5 起止颠倒的录入被整条拒绝', !!(bad && bad.ok === false), bad);
  ok('b6 被拒的录入没有写进事件表', events().length === 1, events().length);
  ok('b7 拒绝理由点名了「早于」', !!(bad && (bad.errors || []).some((e) => e.indexOf('早于') >= 0)), bad && bad.errors);

  // ── c 查询 ────────────────────────────────────────────────────────────────
  const q1 = s.queryRelationAt(SC, 'P1', 'P2', '2004');
  ok('c1 2004 年查询 = 敌对', !!(q1 && q1.ok && q1.relation === 'Enemy'), q1);
  ok('c2 答案是人话（含双方名/关系/战争名）', !!(q1 && q1.text && q1.text.indexOf('敌对') >= 0
     && q1.text.indexOf('甲乙战争') >= 0 && q1.text.indexOf('甲国') >= 0), q1 && q1.text);
  const q2 = s.queryRelationAt(SC, 'P1', 'P2', '2009');
  ok('c3 战争终止后为中立', !!(q2 && q2.relation === 'Neutral'), q2);
  ok('c4 🔴 终止后不许谎称「没有记录」', !!(q2 && q2.text && q2.text.indexOf('已终止') >= 0
     && q2.text.indexOf('甲乙战争') >= 0), q2 && q2.text);
  const q3 = s.queryRelationAt(SC, 'P1', 'P3', '2004');
  ok('c5 没打过交道的两方 = 无记录', !!(q3 && q3.text && q3.text.indexOf('没有已记录') >= 0), q3 && q3.text);
  notes.q = q1.text;

  // ── d 冲突：同日/重叠的相反关系必须报出来 ────────────────────────────────
  const ally = s.addTimelineEvent(SC, {
    type: 'alliance', actors: ['P1', 'P2'], from: '2005-01-01', to: '2008-01-01', title: '甲乙方盟',
  });
  ok('d1 与战争重叠的同盟仍可录入（历史里就有明盟暗战）', !!(ally && ally.ok), ally && ally.errors);
  const audit = s.auditTimelineEvents(SC);
  const conflicts = ((audit && audit.warnings) || []).filter((w) => w.code === 'conflicting-relations');
  ok('d2 重叠的相反关系被点名', conflicts.length === 1, audit && audit.warnings);
  ok('d3 查询按「后录入者生效」给同盟', !!(s.queryRelationAt(SC, 'P1', 'P2', '2006').relation === 'Ally'), null);
  const rmAlly = s.removeTimelineEvent(SC, ally.event.id);
  ok('d4 删掉同盟后又回到敌对', !!(rmAlly && rmAlly.ok && s.queryRelationAt(SC, 'P1', 'P2', '2006').relation === 'Enemy'), rmAlly);
  ok('d5 删完只剩一条冲突都不报', ((s.auditTimelineEvents(SC).warnings || []).filter((w) => w.code === 'conflicting-relations').length) === 0, null);

  // ── e 撤销 / 重做 ─────────────────────────────────────────────────────────
  const before = JSON.stringify(events());
  s.undo();                                   // 撤掉 d4 的删除
  ok('e1 一次撤销把删掉的事件还原', events().length === 2, events().length);
  s.redo();
  ok('e2 重做又删回去', events().length === 1, events().length);
  ok('e3 undo/redo 后事件表与预期逐字节一致', JSON.stringify(events()) === before, null);

  // ── f 落盘：等自动保存 → 项目载荷 ────────────────────────────────────────
  await sleep(1200);
  await window.__probe.flushProject();
  const payload = window.__probe.lastProject();
  const dict = payload && payload.scenarios && payload.scenarios.scenarios;
  const saved = dict && dict[SC] ? dict[SC].timelineEvents : null;
  ok('f1 项目载荷里有 timelineEvents', !!(saved && saved.length === 1), saved);
  ok('f2 载荷里的字段完整（type/actors/from/to/title）', !!(saved && saved[0] && saved[0].type === 'war'
     && Array.isArray(saved[0].actors) && saved[0].actors.length === 2 && saved[0].from && saved[0].to
     && saved[0].title === '甲乙战争'), saved && saved[0]);
  ok('f3 载荷可 JSON 往返', (() => {
    try { return JSON.parse(JSON.stringify(saved)).length === 1; } catch (e) { return false; }
  })());

  // ── g 重载：把项目里的剧本重新装回内存，查询仍答得对 ──────────────────────
  const reload = s.applyScenarioState({ scenarios: dict }, { fresh: true });
  ok('g1 重载成功', !!(reload && reload.ok), reload);
  const q4 = s.queryRelationAt(SC, 'P1', 'P2', '2004');
  ok('g2 重载后查询仍为敌对', !!(q4 && q4.relation === 'Enemy'), q4);
  ok('g3 重载后事件 id 未变', !!(events()[0] && events()[0].id === 'ev1'), events()[0]);

  // ── h 删势力级联 ─────────────────────────────────────────────────────────
  const ally2 = s.addTimelineEvent(SC, {
    type: 'alliance', actors: ['P2', 'P3'], from: '2000-06-01', title: '乙丙之盟',
  });
  ok('h1 为级联再录一条（乙×丙）', !!(ally2 && ally2.ok && events().length === 2), ally2 && ally2.errors);
  const drop = s.removePolity(SC, 'P2');
  ok('h2 删势力回报连带删掉的事件数', !!(drop && drop.success && drop.affectedEvents === 2), drop);
  ok('h3 两条事件都没了（含甲乙战争）', events().length === 0, events().length);
  s.undo();
  ok('h4 一条 undo 同时还原势力与事件', !!(s.scenarios[SC].polities.length === 3 && events().length === 2),
     { polities: s.scenarios[SC].polities.length, events: events().length });

  // 收尾：别把用例数据留在 harness 基线项目里
  s.removeScenario(SC);
  await sleep(900);
  await window.__probe.flushProject();
  ok('i1 收尾后剧本已清掉', !s.scenarios[SC], Object.keys(s.scenarios).length);

  return JSON.stringify({ fails, notes });
})()
"""


def run(cdp):
    fails, notes = source_gates()

    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'harness 基线项目未就绪：{info}'
    wait_for(cdp, f"!!{STORE}.scenarios", timeout=25, desc='store 就绪')

    js = (SEED_JS.replace('__STORE__', STORE).replace('__SC__', json.dumps(SC))
          .replace('__KEY__', json.dumps(KEY)))
    ok, seed = eval_json(cdp, js, required=None, desc='造剧本')
    if not (ok and isinstance(seed, dict) and seed.get('ok')):
        return False, f'造剧本失败：{seed}'
    if seed.get('polities') != 3:
        return False, f"剧本势力数不对：{seed}"
    time.sleep(0.4)

    js = MAIN_JS.replace('__STORE__', STORE).replace('__SC__', json.dumps(SC))
    ok, res = eval_json(cdp, js, required=None, desc='132 主探针')
    if not (ok and isinstance(res, dict)):
        return False, f'主探针求值异常：{res}'
    fails += res.get('fails', [])
    notes.append(f"查询示例：{res.get('notes', {}).get('q')}")

    if fails:
        return False, '；'.join(fails)
    return True, ' / '.join(notes)
