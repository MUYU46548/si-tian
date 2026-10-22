#!/usr/bin/env node
// 事件账本查询 / 录入 —— 三刀序列·第一刀的「能问能答」入口（2026-10-22）
//
// 为什么先给命令行而不是先做面板：
//   账本引擎是**数据层**（施工单原话）。数据层立住的判据是「问一句话能答对」，
//   而面板一旦先做，所有精力都会花在布局上，账本本身的边界（同日多事件/跨年/冲突）
//   反而没人测。命令行 + Node 单测 = 最便宜的验收；外交表面板等账本立住后另出。
//
// 做三件事：
//   · 问：`--at 1350 --a 瓯 --b 梁` → 一句话答案（谁和谁、什么关系、从哪天起、为什么）
//   · 看：不给 --a/--b → 该时点所有非中立关系 + 本代事件清点 + 冲突体检
//   · 录：`--add '<json>'`（默认 dry-run，`--apply` 才写盘，先备份、写后读回校验）
//
// 用法：
//   node scripts/ledger-query.mjs --project <file.sitian> --list
//   node scripts/ledger-query.mjs --project <file.sitian> --at 1350 --a 瓯 --b 梁
//   node scripts/ledger-query.mjs --project <file.sitian> --at 1350
//   node scripts/ledger-query.mjs --project <file.sitian> \
//        --add '{"type":"war","a":"瓯","b":"梁","from":"1348-06-01","to":"1352-06-01"}' --apply
//   ⚠️ `--apply` 前先在司天里关闭该项目（内存态会把改动盖回去）。
import fs from 'fs';
import path from 'path';
import { loadRendererModule, repoRoot } from './lib/loadRendererUtils.mjs';

const ROOT = repoRoot();

function parseArgs(argv) {
  const out = { project: '', at: '', a: '', b: '', era: '', add: '', apply: false, list: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--project') out.project = argv[++i] || '';
    else if (k === '--at') out.at = argv[++i] || '';
    else if (k === '--a') out.a = argv[++i] || '';
    else if (k === '--b') out.b = argv[++i] || '';
    else if (k === '--era') out.era = argv[++i] || '';
    else if (k === '--add') out.add = argv[++i] || '';
    else if (k === '--apply') out.apply = true;
    else if (k === '--list') out.list = true;
    else if (k === '--json') out.json = true;
    else if (k === '--help' || k === '-h') out.help = true;
  }
  return out;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 剧本按 order 排序（与 `utils/scenarioTimeline.js#sortScenarios` 同口径；这里只排顺序，不复制账本逻辑） */
function sortEras(dict) {
  return Object.keys(dict || {})
    .map((id) => ({ ...(dict[id] || {}), id: (dict[id] && dict[id].id) || id }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
}

function yearOf(scenario, key) {
  const n = Number(scenario && scenario.era && scenario.era[key]);
  return Number.isFinite(n) ? n : null;
}

/** 文本日期 → 年份（只取年份用于选代；月日交给账本模块） */
function yearFromText(text) {
  if (text === null || text === undefined) return NaN;
  if (typeof text === 'number') return text;
  if (typeof text === 'object') return Number(text.y);
  const m = String(text).trim().match(/^(前)?\s*(-?\d+)/);
  if (!m) return NaN;
  const y = Number(m[2]);
  if (!Number.isFinite(y)) return NaN;
  return m[1] ? -Math.abs(y) : y;
}

function eraLabel(scenario) {
  const a = yearOf(scenario, 'startYear');
  const b = yearOf(scenario, 'endYear');
  const range = a === null || b === null ? '区间未填' : `${a} ~ ${b}`;
  return `${scenario.name || scenario.id}（${range}）`;
}

/** 年份 → 剧本：优先落在区间内的那一代；都不在 → 最近的一代（并说明） */
function eraForYear(eras, year) {
  if (!Number.isFinite(year)) return { era: null, note: '' };
  const inside = eras.filter((s) => {
    const a = yearOf(s, 'startYear');
    const b = yearOf(s, 'endYear');
    return a !== null && b !== null && year >= a && year <= b;
  });
  if (inside.length) return { era: inside[inside.length - 1], note: inside.length > 1 ? `年份同时落在 ${inside.length} 代里，取靠后者` : '' };
  // 断层：取起始年最近的一代
  let best = null;
  let bestDist = Infinity;
  for (const s of eras) {
    const a = yearOf(s, 'startYear');
    if (a === null) continue;
    const d = Math.abs(a - year);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return { era: best, note: best ? `该年份不在任何一代的一区间内（断层），按最近的 ${eraLabel(best)} 查` : '' };
}

function resolveActor(era, who) {
  if (!who) return { ok: false };
  const list = era.polities || [];
  const exact = list.find((p) => String(p.id) === String(who) || String(p.name) === String(who));
  if (exact) return { ok: true, id: String(exact.id), name: exact.name || String(exact.id) };
  const hits = list.filter((p) => String(p.name || '').startsWith(String(who)));
  if (hits.length === 1) return { ok: true, id: String(hits[0].id), name: hits[0].name || String(hits[0].id) };
  if (hits.length > 1) {
    return { ok: false, error: `「${who}」在本代有 ${hits.length} 个候选：${hits.map((p) => `${p.name}(${p.id})`).join(' / ')} —— 请写 id` };
  }
  return { ok: false, error: `本代没有势力叫「${who}」（现有：${(list.map((p) => p.name).filter(Boolean).join(' / ') || '无')}）` };
}

function dumpProject(project, file) {
  const dict = project && project.scenarios && project.scenarios.scenarios;
  if (!dict || typeof dict !== 'object') return null;
  return { dict, eras: sortEras(dict), bytes: fs.statSync(file).size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project) {
    console.log('用法: node scripts/ledger-query.mjs --project <file.sitian> [--list | --at <日期> [--a 势力 --b 势力] | --add <json> [--apply]]');
    return args.help ? 0 : 2;
  }
  if (!fs.existsSync(args.project)) {
    console.error('项目文件不存在：' + args.project);
    return 2;
  }
  const raw = fs.readFileSync(args.project, 'utf8');
  const project = JSON.parse(raw);
  const loaded = dumpProject(project, args.project);
  if (!loaded) {
    console.error('这个项目里没有 scenarios.scenarios');
    return 2;
  }
  const { dict, eras } = loaded;
  const { mod: L, cleanup } = await loadRendererModule('scenarioEventLedger.js');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const day = args.at || '';
    const year = day ? yearFromText(day) : NaN;

    // ── 录入 ────────────────────────────────────────────────
    if (args.add) {
      let addText = args.add;
      // `--add @事件.json`：长事件 / 带换行的 note 走文件（PowerShell 会对命令行里的引号再剥一层）
      if (addText.startsWith('@')) {
        const f = addText.slice(1);
        if (!fs.existsSync(f)) { console.error('事件文件不存在：' + f); return 2; }
        addText = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      }
      let draft;
      try { draft = JSON.parse(addText); } catch (e) {
        console.error('--add 不是合法 JSON：' + e.message);
        return 2;
      }
      const fromYear = yearFromText(draft.from);
      const forced = args.era ? eras.find((s) => String(s.id) === String(args.era) || String(s.name) === String(args.era)) : null;
      const picked = forced || eraForYear(eras, fromYear).era;
      if (!picked) { console.error('无法确定事件属于哪一代（请用 --era <id|名称> 指定）'); return 2; }
      const nameOf = (id) => {
        const p = (picked.polities || []).find((x) => String(x.id) === String(id));
        return (p && p.name) || String(id);
      };
      // 参与方允许写名字（命令行更顺手）：先按 id/名字解析成 id，再进纯函数层校验
      const draftActors = (Array.isArray(draft.actors) ? draft.actors : [draft.a, draft.b]).filter((x) => x !== undefined && x !== null && x !== '');
      const resolved = [];
      for (const who of draftActors) {
        const r = resolveActor(picked, who);
        if (!r.ok) { console.error(r.error || `无法解析参与方「${who}」`); return 2; }
        resolved.push(r.id);
      }
      const existing = Array.isArray(picked.timelineEvents) ? picked.timelineEvents : [];
      const made = L.makeEvent({ ...draft, actors: resolved, a: undefined, b: undefined }, {
        existing, polities: picked.polities || [], era: picked.era || {}, nameOf,
      });
      if (!made.ok) {
        console.error('录入被拒绝：');
        for (const e of made.errors) console.error('  ✗ ' + e);
        return 1;
      }
      for (const w of made.warnings) console.log('  ⚠ ' + w);
      console.log(`剧本：${eraLabel(picked)}`);
      console.log('事件：' + JSON.stringify(made.event));
      const conflicts = L.findConflicts([...existing, made.event], { polities: picked.polities || [], era: picked.era || {} });
      for (const w of conflicts.warnings) console.log('  ⚠ ' + w.message);
      for (const e of conflicts.errors) console.log('  ✗ ' + e.message);
      if (conflicts.errors.length) { console.error('🔴 这批数据有硬错误 —— 拒绝写盘'); return 1; }
      if (!args.apply) {
        console.log('\n[dry-run] 未写盘。确认无误后加 --apply（会先备份项目文件）。');
        return 0;
      }
      // 写盘：先备份，再临时文件 + rename，最后读回校验
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const bakDir = path.join(ROOT, 'backups', 'ledger-events-' + ts);
      fs.mkdirSync(bakDir, { recursive: true });
      const base = path.basename(args.project, '.sitian');
      const backup = path.join(bakDir, base + '-before.sitian');
      fs.copyFileSync(args.project, backup);
      const nextEvents = [...existing, made.event];
      const nextDict = { ...dict, [picked.id]: { ...picked, timelineEvents: nextEvents } };
      const nextProject = { ...project, scenarios: { ...project.scenarios, scenarios: nextDict } };
      const nextText = JSON.stringify(nextProject);
      const tmpPath = args.project + '.tmp-ledger-events';
      fs.writeFileSync(tmpPath, nextText);
      fs.renameSync(tmpPath, args.project);
      fs.writeFileSync(path.join(bakDir, 'manifest.json'), JSON.stringify({
        ts, project: args.project, before: path.basename(backup), era: picked.id,
        event: made.event, bytesBefore: raw.length, bytesAfter: nextText.length,
      }, null, 2));
      const back = JSON.parse(fs.readFileSync(args.project, 'utf8')).scenarios.scenarios[picked.id];
      const landed = (back.timelineEvents || []).some((ev) => ev && ev.id === made.event.id);
      console.log(`✅ 已写盘（${fmtBytes(raw.length)} → ${fmtBytes(nextText.length)}）；备份：${backup}`);
      console.log('读回校验：' + (landed ? '事件已在盘上' : '🔴 没找到刚写的事件'));
      return landed ? 0 : 1;
    }

    // ── 看：列剧本 / 列关系 ─────────────────────────────────
    if (args.list) {
      console.log(`=== 事件账本清点（${path.basename(args.project)}，${fmtBytes(loaded.bytes)}）===`);
      let total = 0;
      for (const s of eras) {
        const events = Array.isArray(s.timelineEvents) ? s.timelineEvents : [];
        const st = L.ledgerStats(events, { polities: s.polities || [], era: s.era || {} });
        total += st.total;
        console.log(`  · ${eraLabel(s)}：势力 ${(s.polities || []).length} / 事件 ${st.total}`
          + `（${Object.entries(st.byType).map(([k, v]) => `${L.typeLabel(k)} ${v}`).join(' / ') || '空'}）`
          + ` / 体检 ${st.errors}✗ ${st.warnings}⚠`);
      }
      console.log(`合计事件：${total}`);
      console.log('\n提示：问一句 → --at <年份> [--a 势力 --b 势力]');
      return 0;
    }

    const picked = args.era
      ? eras.find((s) => String(s.id) === String(args.era) || String(s.name) === String(args.era))
      : eraForYear(eras, year).era;
    if (!picked) { console.error('无法确定查哪一代（请用 --at <年份> 或 --era）'); return 2; }
    const at = day || (yearOf(picked, 'endYear') !== null ? String(yearOf(picked, 'endYear')) : today);
    const events = Array.isArray(picked.timelineEvents) ? picked.timelineEvents : [];
    const nameOf = (id) => {
      const p = (picked.polities || []).find((x) => String(x.id) === String(id));
      return (p && p.name) || String(id);
    };

    if (args.a && args.b) {
      const A = resolveActor(picked, args.a);
      const B = resolveActor(picked, args.b);
      if (!A.ok) { console.error(A.error); return 2; }
      if (!B.ok) { console.error(B.error); return 2; }
      const text = L.describeRelation(events, A.id, B.id, at, { nameOf });
      if (args.json) {
        const r = L.relationBetween(events, A.id, B.id, at);
        console.log(JSON.stringify({ era: picked.id, at, a: A, b: B, ...r, text }, null, 2));
      } else {
        console.log(`剧本：${eraLabel(picked)}`);
        console.log('问：' + at + ' 时，' + A.name + ' 与 ' + B.name + ' 什么关系？');
        console.log('答：' + text);
        const related = L.eventsBetween(events, A.id, B.id);
        if (related.length) {
          console.log('\n涉及这两方的事件：');
          for (const ev of related) console.log(`  · ${L.typeLabel(ev.type)}「${ev.title || ev.id}」${L.formatEventSpan(ev)}`);
        }
      }
      const conflicts = L.findConflicts(events, { polities: picked.polities || [], era: picked.era || {} });
      if (conflicts.errors.length || conflicts.warnings.length) {
        console.log(`\n账本体检：${conflicts.errors.length} 个错误 / ${conflicts.warnings.length} 个可疑`);
        for (const e of conflicts.errors) console.log('  ✗ ' + e.message);
        for (const w of conflicts.warnings) console.log('  ⚠ ' + w.message);
      }
      return 0;
    }

    // 不带 --a/--b：报该时点所有非中立关系
    const m = L.relationsAt(events, at, { polityIds: (picked.polities || []).map((p) => p.id) });
    console.log(`=== 事件账本（${eraLabel(picked)}）===`);
    console.log('基准日：' + at);
    if (!m.pairs.length) {
      console.log('当前没有已记录的非中立关系。');
    } else {
      console.log('当前关系：');
      const seen = new Set();
      for (const p of m.pairs) {
        const directed = p.relation === 'Suzerain' || p.relation === 'Vassal';
        const key = [p.a, p.b].sort().join('|') + (directed ? '|' + p.relation : '');
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`  · ${nameOf(p.a)} × ${nameOf(p.b)}：${p.label}（${L.typeLabel(p.type)}「${p.title}」，${L.formatEventSpan({ from: p.since, to: p.until })}）`);
      }
    }
    const ongoing = events.filter((ev) => L.isWindowEvent(ev) && L.isActiveAt(ev, at));
    if (ongoing.length) {
      console.log('\n仍在生效的事件：');
      for (const ev of ongoing) {
        console.log(`  · ${L.typeLabel(ev.type)}「${ev.title || ev.id}」${L.formatEventSpan(ev)}`);
      }
    }
    const st = L.ledgerStats(events, { polities: picked.polities || [], era: picked.era || {} });
    console.log(`\n事件表：${st.total} 条（${Object.entries(st.byType).map(([k, v]) => `${L.typeLabel(k)} ${v}`).join(' / ') || '空'}）`
      + ` / 体检 ${st.errors}✗ ${st.warnings}⚠`);
    return 0;
  } finally {
    cleanup();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
