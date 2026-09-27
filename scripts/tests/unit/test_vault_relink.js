#!/usr/bin/env node
/**
 * Node 单元测试：笔记改名「断线检测 + 重连候选打分」（src/renderer/src/utils/vaultRelink.js）
 *
 * 背景（R15 / A-0，2026-09-27）：
 *   司天认亲依据是 `sourcePath`（笔记在库里的相对路径）。项目态下知识库的 add/unlink 事件被
 *   整条拦掉（防两套事实源混流）→ 改名之后司天既不知道也不提示，下次「导入知识库内容」把新名
 *   当新实体补进来、旧实体成孤儿。本模块把那个洞变成**一份可解释的候选清单**。
 *
 * 判错的后果都是静默的：
 *   · 把"用户自建实体"（无 sourcePath）算进断线 → 面板天天报警，用户学会无视它；
 *   · 候选不过滤「已被别的实体占用」的笔记 → 一次重连把两个实体指到同一篇笔记上；
 *   · 打分把不相干的笔记也标成「推荐」→ 用户照单全收 = 机器替他认错亲（比不推荐更坏）。
 *
 * 用法：node scripts/tests/unit/test_vault_relink.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS → 用 data: URL 动态 import（与其它 unit 用例一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'vaultRelink.js');

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

async function main() {
  const load = async (p) => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(p, 'utf8'), 'utf8').toString('base64'));
  const mod = await load(SRC);
  const { normalizeRelPath, dirOf, baseNameOf, commonSubstrLen, scoreCandidate, detectBrokenLinks, describeCandidate } = mod;

  // ---------- 1. 路径归一化 ----------
  check('t1 相对路径归一化：Windows 反斜杠 / ./ 前缀 / 重复斜杠都要抹平', () => {
    eq(normalizeRelPath('03 设定\\02 场景地点\\霜寒城.md'), '03 设定/02 场景地点/霜寒城.md', '反斜杠');
    eq(normalizeRelPath('./03 设定/霜寒城.md'), '03 设定/霜寒城.md', './ 前缀');
    eq(normalizeRelPath('03 设定//霜寒城.md'), '03 设定/霜寒城.md', '重复斜杠');
    eq(normalizeRelPath('  03 设定/霜寒城.md  '), '03 设定/霜寒城.md', '首尾空白');
    eq(normalizeRelPath(''), '', '空输入');
    eq(normalizeRelPath(null), '', 'null 输入');
    return '五种形态全部归一到同一种写法（否则实体与笔记比对必然错位）';
  });

  check('t2 dirOf / baseNameOf 的边界（库根、无扩展名、多级目录）', () => {
    eq(dirOf('03 设定/02 场景地点/霜寒城.md'), '03 设定/02 场景地点', '多级目录');
    eq(dirOf('霜寒城.md'), '', '库根 → 空串（不是 "." 也不是 "/"）');
    eq(baseNameOf('03 设定/02 场景地点/霜寒城.md'), '霜寒城', '去目录去 .md');
    eq(baseNameOf('03 设定/02 场景地点/霜寒城.MD'), '霜寒城', '扩展名大小写不敏感');
    eq(baseNameOf('无扩展名'), '无扩展名', '无扩展名原样返回');
    return '库根判空串：与主进程 listScannedNotes 的 dir 口径一致';
  });

  // ---------- 2. 名字相似度 ----------
  check('t3 用最长公共**子串**而不是子序列（否则「甲乙城 / 甲城乙」会被判成高度相似）', () => {
    eq(commonSubstrLen('霜寒城', '霜寒主城'), 2, '「霜寒」是公共子串');
    eq(commonSubstrLen('甲乙城', '甲城乙'), 1, '只有单字相邻 → 子串长度 1（子序列会是 2）');
    eq(commonSubstrLen('完全一样', '完全一样'), 4, '全等');
    eq(commonSubstrLen('', '任意'), 0, '空串');
    eq(commonSubstrLen('青崖城', '青崖城'), 3, '自比');
    return '中文地名以「前缀+层级词」为主，子串能抓住「霜寒城→霜寒主城」，子序列会顺带抓噪声';
  });

  // ---------- 3. 候选打分 ----------
  check('t4 同目录 + 名字相近 → 够「推荐」线；只沾一样 → 不推荐', () => {
    const both = scoreCandidate({
      entityName: '霜寒城', entityPath: '03 设定/02 场景地点/霜寒城.md',
      noteName: '霜寒主城', notePath: '03 设定/02 场景地点/霜寒主城.md',
    });
    assert(both.score >= 70, `同目录+名字相近应 ≥70，实际 ${both.score}`);
    assert(both.reasons.includes('同目录'), '理由里要写明同目录（UI 给用户看的是理由）');
    assert(both.reasons.some((r) => r.includes('名字相近')), '理由里要写明名字相近');

    const dirOnly = scoreCandidate({
      entityName: '甲城', entityPath: '03 设定/02 场景地点/甲城.md',
      noteName: '完全不同名', notePath: '03 设定/02 场景地点/完全不同名.md',
    });
    assert(dirOnly.score === 60, `只同目录应得 60，实际 ${dirOnly.score}`);

    const nameOnly = scoreCandidate({
      entityName: '霜寒城', entityPath: '03 设定/02 场景地点/霜寒城.md',
      noteName: '霜寒城', notePath: '别的地方/霜寒城.md',
    });
    assert(nameOnly.score < 70, `只名字像（不同目录）不该够推荐线，实际 ${nameOnly.score}`);
    return `同目录+名字相近 ${both.score} / 只同目录 ${dirOnly.score} / 只名字像 ${nameOnly.score}`;
  });

  // ---------- 4. 主入口：断线 / 无主 / 候选 ----------
  check('t5 断线检测：库里的笔记不在了 → 断线；未被引用的笔记 → 无主候选（带推荐）', () => {
    const entities = [
      { id: 'a', name: '霜寒城', sourcePath: '03 设定/02 场景地点/霜寒城.md' },
      { id: 'b', name: '曜川星', sourcePath: '03 设定/11 地理系统/行星/曜川星.md' },
    ];
    const notes = [
      { sourcePath: '03 设定/02 场景地点/霜寒主城.md', name: '霜寒主城' },
      { sourcePath: '03 设定/11 地理系统/行星/曜川星.md', name: '曜川星' },
    ];
    const r = detectBrokenLinks({ entities, notes });
    eq(r.checked, 2, '两个实体都参与对账');
    eq(r.dangling.length, 1, '只有「霜寒城」断了线');
    eq(r.dangling[0].id, 'a', '断线的是 a');
    eq(r.clean, false, '有断线 → clean=false');
    eq(r.unclaimed.length, 1, '「霜寒主城」是唯一无主笔记');
    eq(r.unclaimed[0].sourcePath, '03 设定/02 场景地点/霜寒主城.md', '无主的是改名后的新笔记');
    const sug = r.suggestions.a || [];
    assert(sug.length === 1, `应给出 1 个候选，实际 ${sug.length}`);
    eq(sug[0].recommended, true, '同目录 + 名字相近 → 标推荐');
    eq(sug[0].name, '霜寒主城', '候选就是改名后的那篇');
    eq((r.suggestions.b || []).length, 0, '没断线的实体不该有候选');
    return `checked=${r.checked} dangling=${r.dangling.length}（推荐：${sug[0].name}）`;
  });

  check('t6 用户自建实体（无 sourcePath）不参与对账 —— 否则面板天天误报', () => {
    const entities = [
      { id: 'x', name: '我手建的地点', sourcePath: '' },
      { id: 'y', name: '没字段的实体' },
    ];
    const r = detectBrokenLinks({ entities, notes: [{ sourcePath: '03 设定/02 场景地点/别的.md', name: '别的' }] });
    eq(r.checked, 0, '没有 sourcePath 的实体不计入 checked');
    eq(r.dangling.length, 0, '它们不该被报成断线');
    eq(r.clean, true, '干净');
    return '无来源笔记 = 用户自建，永远不报断线';
  });

  check('t7 已被别的实体占用的笔记不进候选池（否则一次重连把两个实体指到同一篇）', () => {
    const entities = [
      { id: 'a', name: '甲城', sourcePath: '03 设定/02 场景地点/甲城.md' },   // 断线
      { id: 'b', name: '乙城', sourcePath: '03 设定/02 场景地点/乙城.md' },   // 断线
    ];
    const notes = [
      { sourcePath: '03 设定/02 场景地点/甲城新.md', name: '甲城新' },
      { sourcePath: '03 设定/02 场景地点/乙城.md', name: '乙城' },           // 仍被 b 引用
    ];
    const r = detectBrokenLinks({ entities, notes });
    eq(r.dangling.length, 1, '只有甲城断线（乙城的笔记还在）');
    eq(r.unclaimed.length, 1, '无主笔记只有「甲城新」');
    assert(!r.unclaimed.some((n) => n.name === '乙城'), '被引用的笔记不得进无主池');
    return '占用中的笔记不会出现在候选里';
  });

  check('t8 多个候选按分数降序；明显领先才标「推荐」（不领先就不替用户拍板）', () => {
    const entities = [{ id: 'a', name: '霜寒城', sourcePath: 'dir1/霜寒城.md' }];
    const notes = [
      { sourcePath: 'dir1/霜寒主城.md', name: '霜寒主城' },        // 同目录 + 名字像 → 高分
      { sourcePath: 'dir2/霜寒城.md', name: '霜寒城' },            // 名字全同但不同目录
    ];
    const r = detectBrokenLinks({ entities, notes });
    const sug = r.suggestions.a;
    eq(sug.length, 2, '两个候选都要列出来');
    assert(sug[0].score > sug[1].score, '按分数降序');
    eq(sug[0].recommended, true, '分最高且明显领先 → 推荐');
    eq(sug[1].recommended, false, '第二名不推荐');

    // 假造一个「两个候选分数并列」的情形：此时**都不推荐**（让用户自己挑）
    const tie = detectBrokenLinks({
      entities: [{ id: 'z', name: '某地', sourcePath: 'd/某地.md' }],
      notes: [
        { sourcePath: 'd/某地甲.md', name: '某地甲' },
        { sourcePath: 'd/某地乙.md', name: '某地乙' },
      ],
    });
    const t = tie.suggestions.z;
    eq(t[0].score, t[1].score, '装置：两条同目录且公共子串长度相同 → 分数并列');
    eq(t[0].recommended, false, '并列时不给推荐（差别不够大就不替人拍板）');
    return `推荐 ${sug[0].name}（${sug[0].score} vs ${sug[1].score}）；并列时不推荐`;
  });

  check('t9 空输入 / 异常输入不抛，且不误报断线', () => {
    const r1 = detectBrokenLinks({});
    eq(r1.dangling.length, 0, '无输入 → 无断线');
    eq(r1.clean, true, 'clean');
    const r2 = detectBrokenLinks({ entities: null, notes: null });
    eq(r2.dangling.length, 0, 'null 输入');
    // 字典形态（project.entities 是 {id: e}）也要接受 —— 面板传的是 Object.values，
    // 但用例 / 其它调用方可能直接传字典，两种形态都得支持
    const r3 = detectBrokenLinks({
      entities: { a: { id: 'a', name: '甲城', sourcePath: 'q/甲城.md' } },
      notes: [],
    });
    eq(r3.dangling.length, 1, '字典形态的实体也要能对账');
    return '三种输入形态（数组 / 字典 / 空）均正常';
  });

  check('t10 候选理由文案走 describeCandidate 单源（UI 不另写一套措辞）', () => {
    const s = describeCandidate({ reasons: ['同目录', '名字相近（公共 2 字）'] });
    eq(s, '同目录 + 名字相近（公共 2 字）', '按「 + 」拼接');
    assert(describeCandidate(null).includes('不在原目录'), '无候选时给中性说明，不留空白');
    return '理由串由纯函数产出，面板只负责显示';
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
