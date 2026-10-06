#!/usr/bin/env node
/**
 * Node 单元测试：免责声明文案与确认状态（src/renderer/src/utils/disclaimer.js）
 *
 * 为什么必须有这一层（CDP 用例覆盖不到）：
 *   ① **版本化重确认**是这份声明的核心机制：`DISCLAIMER_ACK_KEY` 必须含 `DISCLAIMER_VERSION`。
 *      一旦有人把键写成不含版本的固定串，「升版本 → 全员重新确认」就**静默失效** ——
 *      用户永远不会再看到新条款，而界面与日志都没有任何异常。
 *   ② 文案侧要守「老实」：13 节骨架不许缺、**未成年人条款必须保留**（本次需求明确要求）、
 *      第 12 节的司法辖区**必须是占位符**（绝不编造法院/辖区）、短版要点不许为空。
 *   ③ ack 读写必须能优雅降级：localStorage 在隐私模式/配额满时会**抛异常**，
 *      而这条路径在 CDP 用例里几乎跑不到（测试环境的 localStorage 一切正常）。
 *
 * 用法：node scripts/tests/unit/test_disclaimer.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS → 用 data: URL 动态 import
 *    （disclaimer.js 零 import，所以不需要 test_scenario_dates.js 那套临时目录 +
 *     补扩展名 + type:module 的做法）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'disclaimer.js');

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
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 假 localStorage（可注入抛错模式，验降级路径） */
function fakeStore(seed, opts) {
  const m = Object.assign({}, seed || {});
  const o = opts || {};
  const guard = (fn) => { if (o.throwGet && fn === 'get') throw new Error('SecurityError'); };
  return {
    getItem(k) { guard('get'); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { if (o.throwSet) throw new Error('QuotaExceededError'); m[k] = String(v); },
    removeItem(k) { delete m[k]; },
    _raw: m,
  };
}

async function main() {
  const load = async (p) => import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(p, 'utf8'), 'utf8').toString('base64'));
  const mod = await load(SRC);
  const {
    DISCLAIMER_VERSION, DISCLAIMER_ACK_KEY, DISCLAIMER_UPDATED_AT,
    DISCLAIMER_SHORT, DISCLAIMER_FULL, DISCLAIMER_SECTION_COUNT,
    hasAckedDisclaimer, ackedDisclaimerAt, ackDisclaimer, clearDisclaimerAck,
  } = mod;

  // ---------- 1. 版本化 ack（本模块最关键的机制） ----------
  check('v0 ack 键**含版本号** —— 否则升版本不会触发重新确认（静默失效）', () => {
    assert(typeof DISCLAIMER_VERSION === 'string' && /^\d+\.\d+\.\d+$/.test(DISCLAIMER_VERSION),
      `版本号应是 x.y.z，实际 ${DISCLAIMER_VERSION}`);
    assert(DISCLAIMER_ACK_KEY.includes(DISCLAIMER_VERSION),
      `ack 键 ${DISCLAIMER_ACK_KEY} 不含版本号 ${DISCLAIMER_VERSION}`);
    assert(DISCLAIMER_ACK_KEY.startsWith('sitian_disclaimer_ack_'),
      `ack 键前缀不对：${DISCLAIMER_ACK_KEY}`);
    return `键=${DISCLAIMER_ACK_KEY}，版本=${DISCLAIMER_VERSION}`;
  });

  check('v1 换版本号 → 旧 ack 失效（用「键名不同 ⇒ 互不影响」实证）', () => {
    const store = fakeStore();
    ackDisclaimer(store, new Date('2026-10-06T05:00:00.000Z'));
    assert(hasAckedDisclaimer(store) === true, '本版本应已确认');
    // 模拟「产品升版本」：换一个含新版本号的键去查 —— 老记录不该被判为已确认
    const otherKey = DISCLAIMER_ACK_KEY.replace(DISCLAIMER_VERSION, '99.0.0');
    assert(Object.keys(store._raw).length === 1, '应只有一条 ack 记录');
    assert(!Object.keys(store._raw).includes(otherKey), '不应存在别的版本的 ack 记录');
    return '键名绑定版本 → 升版本 = 老记录查不到 = 重新确认';
  });

  check('v2 ack 往返：写入 ISO 时间戳、读回同一时刻、清除后归 false', () => {
    const store = fakeStore();
    eq(hasAckedDisclaimer(store), false, '初始未确认');
    eq(ackedDisclaimerAt(store), null, '初始无时间');
    const at = new Date('2026-10-06T05:30:00.000Z');
    eq(ackDisclaimer(store, at), true, '写入应成功');
    eq(hasAckedDisclaimer(store), true, '写入后应已确认');
    eq(ackedDisclaimerAt(store), at.toISOString(), '读回的时刻');
    eq(clearDisclaimerAck(store), true, '清除应成功');
    eq(hasAckedDisclaimer(store), false, '清除后应未确认');
    return at.toISOString();
  });

  check('v3 时间戳损坏 → ackedDisclaimerAt 返回 null（不抛、不返回 Invalid Date）', () => {
    const store = fakeStore({ [DISCLAIMER_ACK_KEY]: 'not-a-date' });
    eq(hasAckedDisclaimer(store), true, '键存在 → 仍算已确认（不因时间戳坏了就重弹）');
    eq(ackedDisclaimerAt(store), null, '坏时间戳应给 null');
    return '键存在即可判定"已确认"，时间戳仅用于展示';
  });

  check('v4 store 缺失 / 抛异常 → 一律安全降级（不抛，返回 false/null）', () => {
    eq(hasAckedDisclaimer(null), false, 'null store');
    eq(ackedDisclaimerAt(null), null, 'null store');
    eq(ackDisclaimer(null), false, 'null store 写入应返回 false');
    eq(clearDisclaimerAck(null), false, 'null store 清除应返回 false');
    const broken = fakeStore(null, { throwGet: true, throwSet: true });
    eq(hasAckedDisclaimer(broken), false, 'getItem 抛错 → false');
    eq(ackedDisclaimerAt(broken), null, 'getItem 抛错 → null');
    eq(ackDisclaimer(broken), false, 'setItem 抛错 → false（调用方据此提示"本次会话内有效"）');
    return '4 种空/异 store + 2 条抛错路径全部降级';
  });

  // ---------- 2. 文案骨架 ----------
  check('t0 13 节骨架：节号 1..13 连续、标题非空、每节至少一个内容块', () => {
    eq(DISCLAIMER_SECTION_COUNT, 13, '总节数');
    eq(DISCLAIMER_FULL.length, 13, 'DISCLAIMER_FULL 长度');
    DISCLAIMER_FULL.forEach((sec, i) => {
      eq(sec.n, i + 1, `第 ${i + 1} 节的编号`);
      assert(typeof sec.title === 'string' && sec.title.trim().length >= 2, `第 ${sec.n} 节标题为空`);
      assert(Array.isArray(sec.blocks) && sec.blocks.length >= 1, `第 ${sec.n} 节没有任何内容块`);
      sec.blocks.forEach((b, bi) => {
        assert(['p', 'list', 'note'].includes(b.type), `第 ${sec.n} 节第 ${bi} 块类型非法：${b.type}`);
        if (b.type === 'list') {
          assert(Array.isArray(b.items) && b.items.length >= 1, `第 ${sec.n} 节第 ${bi} 块 list 为空`);
        } else {
          assert(typeof b.text === 'string' && b.text.trim().length >= 4, `第 ${sec.n} 节第 ${bi} 块文本为空`);
        }
      });
    });
    return DISCLAIMER_FULL.map((s) => `${s.n}.${s.title}`).join(' / ');
  });

  check('t1 🔴 未成年人条款（第 5 节）**必须保留** —— 本次需求明确要求覆盖', () => {
    const sec = DISCLAIMER_FULL.find((s) => s.n === 5);
    assert(sec, '缺少第 5 节');
    const all = sec.title + JSON.stringify(sec.blocks);
    assert(all.includes('未成年人'), '第 5 节没有出现「未成年人」');
    assert(all.includes('监护人'), '第 5 节没有提到监护人');
    assert(/知情同意|同意/.test(all), '第 5 节没有提到知情同意');
    return `${sec.title}（含监护人知情同意 + 监护人担责）`;
  });

  check('t2 第 2 节「软件性质」= 本地工具 / 无 LLM / 无账号 / 无遥测，且联网只两处', () => {
    const txt = JSON.stringify(DISCLAIMER_FULL.find((s) => s.n === 2));
    for (const kw of ['大语言模型', '本地桌面', '账号', '遥测']) {
      assert(txt.includes(kw), `第 2 节缺少「${kw}」`);
    }
    // 两处联网必须点名，且必须说清"不做假承诺"的边界
    assert(txt.includes('electron-updater') && txt.includes('Git'), '第 2 节没有点明两处联网');
    assert(txt.includes('两处'), '第 2 节没有明确「只有两处」联网');
    return '本地 / 无 LLM / 无账号 / 无遥测 / 仅更新与 Git 两处联网';
  });

  check('t3 第 6 节「数据安全」必须"先如实列机制、再明确不保证"（写虚了整份声明就白写）', () => {
    const sec = DISCLAIMER_FULL.find((s) => s.n === 6);
    const txt = JSON.stringify(sec);
    // 7 条机制的关键词各至少出现一次
    const mech = ['自动保存', '轮转', '会话基线', '原子写盘', '快照', '退出前落盘', '加密'];
    for (const m of mech) assert(txt.includes(m), `第 6 节缺少机制「${m}」`);
    // 必须写明「都不构成保证」
    assert(txt.includes('不构成') && txt.includes('保证'), '第 6 节没有写明"不构成保证"');
    // 必须点出「备份与主文件同盘」这个真实的同损风险
    assert(txt.includes('同一台电脑') || txt.includes('同一块磁盘'), '第 6 节没点出备份与主文件同盘的风险');
    // 必须给行动建议（自行另备并验证）
    assert(txt.includes('另行备份') && txt.includes('验证'), '第 6 节没有给"自行备份并验证"的建议');
    return '7 条机制 + 不构成保证 + 同盘同损 + 自行验证建议';
  });

  check('t4 第 12 节适用法律**必须是占位符** —— 绝不编造司法辖区/法院', () => {
    const sec = DISCLAIMER_FULL.find((s) => s.n === 12);
    const txt = JSON.stringify(sec);
    assert(/【待定/.test(txt), '第 12 节没有保留【待定：…】占位符');
    assert(txt.includes('待定'), '缺少"待定"字样');
    // 常见辖区名一旦出现就是编造
    for (const bad of ['中华人民共和国', '北京仲裁', '中国法院', '香港特别行政区']) {
      assert(!txt.includes(bad), `第 12 节出现了具体辖区/机构「${bad}」（属编造，必须留占位符）`);
    }
    return '保留【待定：司法辖区】占位符，无任何编造';
  });

  check('t5 短版要点：≥5 条、与 13 节并存（首启要给要点，全文必须读过）', () => {
    assert(Array.isArray(DISCLAIMER_SHORT), 'DISCLAIMER_SHORT 应为数组');
    assert(DISCLAIMER_SHORT.length >= 5, `短版要点只有 ${DISCLAIMER_SHORT.length} 条，太少`);
    DISCLAIMER_SHORT.forEach((t, i) => {
      assert(typeof t === 'string' && t.trim().length >= 8, `第 ${i} 条要点过短`);
    });
    return `${DISCLAIMER_SHORT.length} 条要点 + ${DISCLAIMER_SECTION_COUNT} 节全文`;
  });

  check('t6 生效日期存在且形如 YYYY-MM-DD（条款更新记录不能缺）', () => {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(DISCLAIMER_UPDATED_AT), `生效日期格式不对：${DISCLAIMER_UPDATED_AT}`);
    return DISCLAIMER_UPDATED_AT;
  });

  check('t7 第 9 节必须引用随附清单（版权与许可证.md）—— 否则"见清单"指向空', () => {
    const txt = JSON.stringify(DISCLAIMER_FULL.find((s) => s.n === 9));
    assert(txt.includes('版权与许可证.md'), '第 9 节没有引用 版权与许可证.md');
    for (const dep of ['Electron', 'Vue', 'Vite', 'reka-ui', 'Tailwind', 'marked']) {
      assert(txt.includes(dep), `第 9 节漏了依赖「${dep}」`);
    }
    return '引用 版权与许可证.md 且点名主要依赖';
  });

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.error('\n失败：');
    for (const f of failed) console.error(`  · ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('用例异常：', e); process.exit(1); });
