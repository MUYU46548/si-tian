#!/usr/bin/env node
/**
 * Node 单测：事件账本（`scenarioEventLedger.js`）—— 三刀序列·第一刀的验收判据
 *
 * 判据（每条都能单独变红，不是恒真）：
 *   ① 录入校验：缺年份 / 起止颠倒 / 未知类型 / 未知势力 → 该拦的拦、该只警告的不拦；
 *   ② 时间窗口是 `[from, to)`：终止当日不再生效（和约日当天不能还显示敌对）；
 *   ③ 同日多事件：按录入顺序**后录者生效**，且关系相反时 `findConflicts` 必须报出来；
 *   ④ 跨年 / 跨代事件：窗口跨年照常生效；年份越出剧本区间只警告、不丢；
 *   ⑤ 非对称关系：臣属 = A 对 B 宗主 / B 对 A 藩属（两个方向不能都写同一个词）；
 *   ⑥ 查询期对脏数据容错：非法事件被跳过，不炸、也不静默（`findConflicts` 点名）；
 *   ⑦ 纯函数：不改入参（深比较快照）。
 *
 * 用法：node scripts/tests/unit/test_scenario_event_ledger.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (e) { results.push({ name, ok: false, detail: (e && e.message) || String(e) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-event-ledger-'));
  const fix = (s) => s.replace(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g, "from './$1.js'");
  const seen = new Set(); const q = ['scenarioEventLedger.js', 'scenarioDates.js'];
  while (q.length) {
    const f = q.shift(); if (seen.has(f)) continue; seen.add(f);
    const full = path.join(SRC, f); if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(path.join(tmp, f), fix(code));
    for (const m of code.matchAll(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g)) q.push(`${m[1]}.js`);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const L = await import(pathToFileURL(path.join(tmp, 'scenarioEventLedger.js')).href);
  const D = await import(pathToFileURL(path.join(tmp, 'scenarioDates.js')).href);

  const polities = [
    { id: 'pol_jia', name: '甲' },
    { id: 'pol_yi', name: '乙' },
    { id: 'pol_bing', name: '丙' },
  ];
  const nameOf = (id) => (polities.find((p) => p.id === id) || {}).name || id;
  const era = { startYear: '1340', endYear: '1360' };

  // ── 一份标准样本：1348 开战 → 1352 和约；1350 起同盟（故意与战争重叠，用来测冲突）──
  const warDraft = {
    type: 'war', actors: ['pol_jia', 'pol_yi'],
    from: '1348-06-01', to: '1352-06-01', title: '甲梁战争',
  };
  const peaceDraft = {
    type: 'peace', actors: ['pol_jia', 'pol_yi'],
    from: '1352-06-01', title: '甲梁和约',
  };

  check('一：录入校验 —— 合法草稿规整出 id/日期/默认标题；坏草稿逐条点名且不产出事件', () => {
    const ok = L.makeEvent({ ...warDraft, title: '' }, { existing: [], polities, era, nameOf });
    assert(ok.ok, `合法战争草稿被拒：${ok.errors}`);
    assert(ok.event.id === 'ev1', `首个 id 应为 ev1，实际 ${ok.event.id}`);
    assert(ok.event.from.y === 1348 && ok.event.from.m === 6 && ok.event.from.d === 1,
      `from 未规整：${JSON.stringify(ok.event.from)}`);
    assert(ok.event.to.y === 1352, 'to 未规整');
    assert(ok.event.title === '甲 × 乙：战争', `默认标题不对：${ok.event.title}`);

    const bad = L.makeEvent({ type: 'war', actors: ['pol_jia', 'pol_yi'], to: '1352' },
      { polities, era, nameOf });
    assert(!bad.ok && bad.event === null, '缺起始日期竟然通过了');
    assert(bad.errors.some((e) => e.includes('起始日期')), `错误信息没点名起始日期：${bad.errors}`);

    const reversed = L.makeEvent({ type: 'war', actors: ['pol_jia', 'pol_yi'], from: '1352', to: '1348' },
      { polities, era, nameOf });
    assert(!reversed.ok && reversed.errors.some((e) => e.includes('早于')),
      `起止颠倒没拦住：${reversed.errors}`);

    const unknownType = L.makeEvent({ type: 'nuke', actors: ['pol_jia', 'pol_yi'], from: '1350' },
      { polities, era, nameOf });
    assert(!unknownType.ok && unknownType.errors.some((e) => e.includes('未知事件类型')),
      '未知类型没拦住');

    const ghost = L.makeEvent({ type: 'war', actors: ['pol_jia', 'pol_ghost'], from: '1350' },
      { polities, era, nameOf });
    assert(ghost.ok, '不存在的势力应只是警告，不该拒绝录入（用户可能先录事件再建势力）');
    assert(ghost.warnings.some((w) => w.includes('pol_ghost')), `未知势力没警告：${ghost.warnings}`);
    return `id=ev1 / 标题「${ok.event.title}」/ 坏草稿报 ${bad.errors.length} 条`;
  });

  check('二：时间窗口 [from, to) —— 开战日已生效，停战日已失效', () => {
    const events = [L.makeEvent(warDraft, { existing: [], polities, era, nameOf }).event];
    const r = (d) => L.relationBetween(events, 'pol_jia', 'pol_yi', d);
    assert(r('1348-05-31').relation === 'Neutral', '开战前一天不应敌对');
    assert(r('1348-05-31').known === false, '开战前一天不应有「已知事件」');
    assert(r('1348-06-01').relation === 'Enemy', `开战当日应敌对，实际 ${r('1348-06-01').relation}`);
    assert(r('1351-12-31').relation === 'Enemy', '战争期间应敌对');
    assert(r('1352-06-01').relation === 'Neutral', `停战当日不应再敌对，实际 ${r('1352-06-01').relation}`);
    assert(r('1352-06-01').known === false, '停战日之后该事件已不生效');
    assert(r('1350').relation === 'Enemy', '裸年份（无月日）也应能查');
    return '1348-05-31 中立 / 1348-06-01 敌对 / 1352-06-01 中立';
  });

  check('三：同日多事件 —— 后录者生效；关系相反必须被 findConflicts 报出', () => {
    const war = L.makeEvent(warDraft, { existing: [], polities, era, nameOf }).event;
    const ally = L.makeEvent({
      type: 'alliance', actors: ['pol_yi', 'pol_jia'], // 参与方顺序反过来：对称关系必须照样命中
      from: '1350-01-01', to: '1355-01-01',
    }, { existing: [war], polities, era, nameOf }).event;
    const sameDay = L.makeEvent({
      type: 'alliance', actors: ['pol_jia', 'pol_yi'], from: '1350-03-01',
    }, { existing: [war, ally], polities, era, nameOf }).event;

    assert(ally.id === 'ev2' && sameDay.id === 'ev3', `id 应递增：${ally.id}/${sameDay.id}`);
    const events = [war, ally, sameDay];
    // 1350-02-01：战争(早) + 同盟(1350-01-01) 都在；同盟更晚 → 同盟生效
    assert(L.relationBetween(events, 'pol_jia', 'pol_yi', '1350-02-01').relation === 'Ally',
      '同日/更晚录入的事件应覆盖更早的敌对');
    // 同日互相矛盾：1351-01-01 再录一条战争（比同盟晚）→ 战争生效
    const war2 = L.makeEvent({
      type: 'war', actors: ['pol_jia', 'pol_yi'], from: '1351-01-01',
    }, { existing: events, polities, era, nameOf }).event;
    assert(L.relationBetween([...events, war2], 'pol_jia', 'pol_yi', '1351-06-01').relation === 'Enemy',
      '同日之后录入的战争应覆盖同盟');

    const c1 = L.findConflicts([war, ally], { polities, era });
    const hit1 = c1.warnings.filter((w) => w.code === 'conflicting-relations');
    assert(hit1.length === 1, `同盟×战争应报 **1** 条（正反方向要先去重），实际 ${hit1.length}：${JSON.stringify(hit1)}`);
    assert(hit1[0].eventIds.length === 2, `冲突应点名两条事件：${JSON.stringify(hit1[0])}`);

    const c2 = L.findConflicts(events, { polities, era });
    const hit2 = c2.warnings.filter((w) => w.code === 'conflicting-relations');
    assert(hit2.length === 2, `三条事件里有两对相反关系 → 应报 2 条，实际 ${hit2.length}`);
    return `冲突 1 条（去重）/${hit2.length} 条（两对）`;
  });

  check('四：跨年 / 跨代事件 —— 跨年照常生效；越出剧本区间只警告、不丢', () => {
    const longWar = L.makeEvent({
      type: 'war', actors: ['pol_jia', 'pol_bing'], from: '1345', to: '1358',
    }, { existing: [], polities, era, nameOf });
    assert(longWar.ok, `跨年战争被拒：${longWar.errors}`);
    assert(L.relationBetween([longWar.event], 'pol_bing', 'pol_jia', '1350-07-01').relation === 'Enemy',
      '跨年战争在中间年份应生效');
    assert(L.relationBetween([longWar.event], 'pol_jia', 'pol_bing', '1358-01-01').relation === 'Neutral',
      '跨年战争到终止年应失效');

    const crossing = L.makeEvent({
      type: 'war', actors: ['pol_jia', 'pol_bing'], from: '1355', to: '1370',
    }, { existing: [], polities, era, nameOf });
    assert(crossing.ok, '跨代事件应允许录入');
    assert(crossing.warnings.some((w) => w.includes('超出本剧本区间')),
      `越界没警告：${crossing.warnings}`);
    return '1345~1358 跨年生效 / 1355~1370 越界仅警告';
  });

  check('五：非对称关系 —— 臣属方向不能写成同一个词', () => {
    const v = L.makeEvent({
      type: 'vassalage', actors: ['pol_jia', 'pol_bing'], from: '1340',
    }, { existing: [], polities, era, nameOf }).event;
    const ab = L.relationBetween([v], 'pol_jia', 'pol_bing', '1350');
    const ba = L.relationBetween([v], 'pol_bing', 'pol_jia', '1350');
    assert(ab.relation === 'Suzerain' && ab.label === '宗主', `甲→丙 应为宗主，实际 ${ab.relation}/${ab.label}`);
    assert(ba.relation === 'Vassal' && ba.label === '藩属', `丙→甲 应为藩属，实际 ${ba.relation}/${ba.label}`);
    assert(ab.relation !== ba.relation, '两个方向返回了同一个关系（方向丢了）');

    const d = L.describeRelation([v], 'pol_bing', 'pol_jia', '1350-01-01', { nameOf });
    assert(d.includes('丙') && d.includes('甲') && d.includes('藩属'), `文案不对：${d}`);
    return `甲对丙=宗主 / 丙对甲=藩属；文案：${d}`;
  });

  check('六：脏数据 —— 查询不炸、冲突点名；不重叠的相反事件不误报', () => {
    const valid = L.makeEvent(warDraft, { existing: [], polities, era, nameOf }).event;
    const broken = { id: 'ev9', type: 'war', actors: ['pol_jia'], from: 'oops' };
    const c = L.findConflicts([valid, broken], { polities, era });
    assert(c.errors.length > 0, '非法事件没被报错');
    assert(c.errors.some((e) => e.eventIds.includes('ev9')), `错误没点名 ev9：${JSON.stringify(c.errors)}`);
    assert(c.errors.some((e) => e.message.includes('参与方')), '缺参与方没被点名');

    // 查询遇到非法事件：跳过，不抛
    assert(L.relationBetween([valid, broken], 'pol_jia', 'pol_yi', '1349').relation === 'Enemy',
      '合法事件被非法事件带崩了');

    // 不重叠的战争与同盟：不该报冲突
    const w = L.makeEvent({ type: 'war', actors: ['pol_jia', 'pol_yi'], from: '1300', to: '1310' },
      { existing: [], polities, era: {}, nameOf }).event;
    const a = L.makeEvent({ type: 'alliance', actors: ['pol_jia', 'pol_yi'], from: '1320', to: '1330' },
      { existing: [], polities, era: {}, nameOf }).event;
    const c2 = L.findConflicts([w, a], { polities });
    assert(!c2.warnings.some((x) => x.code === 'conflicting-relations'),
      `不重叠的事件被误报冲突：${JSON.stringify(c2.warnings)}`);

    // 重复 id
    const dup = L.findConflicts([valid, { ...valid }], { polities, era });
    assert(dup.errors.some((e) => e.code === 'duplicate-id'), '重复 id 没被报出来');
    return `非法事件报 ${c.errors.length} 条 / 不重叠 0 误报 / 重复 id 抓到`;
  });

  check('七：纯函数 —— 查询与录入都不改入参，非法事件在关系矩阵里不出现', () => {
    const events = [
      L.makeEvent(warDraft, { existing: [], polities, era, nameOf }).event,
      L.makeEvent(peaceDraft, { existing: [], polities, era, nameOf }).event,
    ];
    const snapshot = JSON.stringify(events);
    L.relationBetween(events, 'pol_jia', 'pol_yi', '1349-01-01');
    L.relationsAt(events, '1349-01-01', { polityIds: polities.map((p) => p.id) });
    L.findConflicts(events, { polities, era });
    L.describeRelation(events, 'pol_jia', 'pol_yi', '1349-01-01', { nameOf });
    L.sortEvents(events);
    assert(JSON.stringify(events) === snapshot, '查询/排序改动了入参');

    const m = L.relationsAt(events, '1349-01-01');
    assert(m.pairs.length === 2, `对称关系应报两个方向，实际 ${m.pairs.length}`);
    assert(m.byPolity.pol_jia.pol_yi.relation === 'Enemy', '关系矩阵不对');

    // 和约当天：矩阵里该对消失（中立 = 没有特殊关系）
    const after = L.relationsAt(events, '1352-06-01');
    assert(after.pairs.length === 0, `和约日之后该对仍留在矩阵里：${JSON.stringify(after.pairs)}`);
    return `入参未被改 / 敌对 2 方向 / 和约后 0 条`;
  });

  check('八：文案与清点 —— 「X 年 A 和 B 什么关系」能直接答人话', () => {
    const events = [
      L.makeEvent(warDraft, { existing: [], polities, era, nameOf }).event,
      L.makeEvent(peaceDraft, { existing: [], polities, era, nameOf }).event,
    ];
    const at = L.describeRelation(events, 'pol_jia', 'pol_yi', '1349-06-01', { nameOf });
    assert(at.includes('1349-06-01') && at.includes('敌对') && at.includes('战争'), `战争文案不对：${at}`);
    const after = L.describeRelation(events, 'pol_jia', 'pol_yi', '1355-01-01', { nameOf });
    assert(after.includes('中立') && after.includes('和约'), `和约后文案不对：${after}`);
    const none = L.describeRelation([], 'pol_jia', 'pol_yi', '1349-06-01', { nameOf });
    assert(none.includes('没有已记录'), `空账本文案不对：${none}`);
    // 只录了战争、没录和约：终止之后不能说「没有记录」，要说「此前那场仗已终止」
    const ended = L.describeRelation([events[0]], 'pol_jia', 'pol_yi', '1360', { nameOf });
    assert(ended.includes('没有生效中') && ended.includes('已终止') && ended.includes('甲梁战争'),
      `终止后文案不对：${ended}`);

    const st = L.ledgerStats(events, { polities, era });
    assert(st.total === 2 && st.byType.war === 1 && st.byType.peace === 1, `清点不对：${JSON.stringify(st)}`);
    assert(st.ongoing === 0, `和约/战争都不该算「至今未终」：${st.ongoing}`);
    return at;
  });

  check('九：增删改的纯函数层 —— 找不到 id 不新建，删除只删一条', () => {
    const made = L.makeEvent(warDraft, { existing: [], polities, era, nameOf });
    let sc = L.appendEvent({ timelineEvents: [] }, warDraft, { polities, era, nameOf });
    assert(sc.ok && sc.events.length === 1, 'appendEvent 失败');
    const other = L.appendEvent({ timelineEvents: sc.events },
      { type: 'alliance', actors: ['pol_yi', 'pol_bing'], from: '1350' },
      { polities, era, nameOf });
    assert(other.events.length === 2, '第二次 append 没接上');
    assert(JSON.stringify(sc.events) === JSON.stringify([made.event]), 'appendEvent 改动了上一版数组');

    const miss = L.replaceEvent({ timelineEvents: other.events }, 'ev99', { title: '不存在' }, { polities, era });
    assert(!miss.ok && miss.reason === 'missing' && miss.events.length === 2, '找不到 id 竟然新建/改动了');
    const replaced = L.replaceEvent({ timelineEvents: other.events }, 'ev1', { to: '1355-01-01' }, { polities, era, nameOf });
    assert(replaced.ok && replaced.event.to.y === 1355, `替换没生效：${JSON.stringify(replaced.event)}`);
    assert(replaced.event.title === made.event.title, '替换不该丢掉其它字段');

    const removed = L.removeEvent({ timelineEvents: other.events }, 'ev1');
    assert(removed.ok && removed.events.length === 1 && removed.events[0].id === 'ev2', '删除结果不对');
    assert(!L.removeEvent({ timelineEvents: other.events }, 'ev99').ok, '删不存在的 id 应返回 ok:false');
    return 'missing 不新建 / 替换保留其它字段 / 删除只删一条';
  });

  check('十：文本日期解析（命令行入口）—— 认几种写法、不认的返回 null', () => {
    const ok = (t, y, m, d) => {
      const r = D.parseDateText(t);
      assert(r && r.y === y && r.m === m && r.d === d, `${t} → ${JSON.stringify(r)}（期望 ${y}/${m}/${d}）`);
    };
    ok('1350', 1350, null, null);
    ok('1350-06', 1350, 6, null);
    ok('1350-06-01', 1350, 6, 1);
    ok('1350/6/1', 1350, 6, 1);
    ok('前1350', -1350, null, null);
    ok('-350', -350, null, null);
    ok({ y: 1348, m: 6, d: 1 }, 1348, 6, 1);
    for (const bad of ['', 'abc', '1350-13-01', '1350-02-30', '1350-00-10', '06-01']) {
      assert(D.parseDateText(bad) === null, `「${bad}」不该被解析出来：${JSON.stringify(D.parseDateText(bad))}`);
    }
    return '6 种写法对 / 6 种坏输入返回 null';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('用例自身崩溃：', e); process.exit(1); });
