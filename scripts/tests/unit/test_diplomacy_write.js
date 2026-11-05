#!/usr/bin/env node
/**
 * Node 单元测试：外交表「可写」的契约（A1，2026-11-05）
 *
 * 为什么要有这一层（而不是只靠真机 drill）：`drill_diplomacy_write.py` 要起 Vite + Electron（1~2 分钟），
 * 但这一轮真正的风险是**几行源码级的口径**，它们出错时不会报错、只会静默退化：
 *
 *   ① 面板自己去改 `scenario.timelineEvents`（绕过 `execute()`）→ 只读态照改、撤销回不来；
 *   ② 面板文案还写着"只读"，而它其实会写盘 → 用户以为只是查，点一下把数据改了；
 *   ③ 撤销回调里不排保存 → 撤了但磁盘没撤，关掉重开事件又回来了（2026-11-05 修的那个真 bug）；
 *   ④ 类型清单自己手抄一份 → 新增事件类型时面板没有它（"同一能力两份实现"）。
 *
 * 这四条都在源码里读得出来，秒级，进回归。
 *
 * 用法：node scripts/tests/unit/test_diplomacy_write.js
 * 退出码：0 = 全通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PANEL = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'DiplomacyPanel.vue');
const STORE = path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules', 'scenarioEditing.js');
const LEDGER = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'scenarioEventLedger.js');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
/** 读源码并归一化换行（本仓 index 是 LF、工作树是 CRLF —— 不归一化会切片失败 → 假红） */
function read(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function main() {
  const panel = read(PANEL);
  const store = read(STORE);

  check('a1 面板写入只经 store 的唯一写口 addTimelineEvent', () => {
    assert(panel.includes('store.addTimelineEvent('), '面板没有调用 store.addTimelineEvent —— 那它怎么记录？');
    return '走 store.addTimelineEvent()';
  });

  check('a2 面板不自己动 timelineEvents（绕过 execute 就没有撤销/只读闸门）', () => {
    const bad = [
      ['直接赋值', /\.timelineEvents\s*=[^=]/],
      ['push', /\.timelineEvents\.push\(/],
      ['splice', /\.timelineEvents\.splice\(/],
    ].filter(([, re]) => re.test(panel)).map(([k]) => k);
    assert(bad.length === 0, `面板里出现了直接改事件表的写法：${bad.join(' / ')}`);
    return '零处直接改事件表';
  });

  check('a3 文案与能力一致：有写入口就不许再自称“只读”', () => {
    // 只看**模板**里的可见文案（注释里说“这段代码是只读的”不算误导用户）
    const tpl = panel.slice(panel.indexOf('<template>'), panel.indexOf('</template>'));
    assert(tpl.length > 500, '取不到模板片段');
    const claimsReadOnly = /只读/.test(tpl);
    assert(!claimsReadOnly, '模板里还有“只读”字样 —— 与它会写盘的事实相反');
    assert(tpl.includes('可录入'), '模板里没有“可录入”徽标（能力变了，徽标也要说清）');
    // 负向探针：把同一套判定用在“既写盘又自称只读”的样本上，必须判为不一致
    const fake = '<template><span>只读</span></template><script>store.addTimelineEvent(sid, d)</script>';
    const fakeTpl = fake.slice(fake.indexOf('<template>'), fake.indexOf('</template>'));
    assert(/只读/.test(fakeTpl) && fake.includes('store.addTimelineEvent('),
      '反向探针失败：判定逻辑对"既写盘又自称只读"竟然判通过');
    return '能力与文案一致（负向探针验过）';
  });

  check('a4 类型清单从 EVENT_TYPE_LIST 派生（不手抄第二份）', () => {
    assert(panel.includes('EVENT_TYPE_LIST'), '面板没有使用 EVENT_TYPE_LIST');
    const ledger = read(LEDGER);
    assert(ledger.includes('export const EVENT_TYPE_LIST'), '账本里应导出 EVENT_TYPE_LIST');
    for (const t of ['war', 'alliance', 'friendship', 'rivalry', 'vassalage', 'peace', 'custom']) {
      const inLedger = new RegExp(`\\n\\s*${t}:\\s*\\{`).test(ledger);
      assert(inLedger, `账本类型表里没有 ${t}`);
    }
    return '7 种关系/记事类型都在账本';
  });

  check('a5 撤销也落盘：applyTimelineEvents 里必须排保存（防“撤了磁盘没撤”回潮）', () => {
    const at = store.indexOf('function applyTimelineEvents(');
    assert(at >= 0, '找不到 applyTimelineEvents');
    const end = store.indexOf('\n  }', at);
    assert(end > at, '函数体切片失败');
    const body = store.slice(at, end);
    assert(body.includes('scenario.timelineEvents') || body.includes('timelineEvents: events'),
      '切片不像 applyTimelineEvents 的函数体');
    assert(body.includes('scheduleAutoSaveScenarios('),
      'applyTimelineEvents 里没有排保存 —— 撤销后磁盘不会变（2026-11-05 修的就是这个）');
    assert(!body.includes('saveScenarios('),
      '不要在 undo/redo 的热路径里同步 saveScenarios（8MB 项目会卡 100ms+）');
    return 'undo/redo 同一条防抖';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 外交表可写契约（Node）单元测试 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

process.exit(main());
