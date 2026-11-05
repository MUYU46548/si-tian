#!/usr/bin/env node
/**
 * 隐私与署名扫描（发布门槛③，2026-11-05）
 *
 * ── 为什么 ────────────────────────────────────────────────────────────────
 * S1=C（对外发布）+ S24（MIT 开源）意味着**代码、注释、提交历史都给陌生人看**。
 * 要清的是“私人世界内容”，不是“作者是谁”：`暮雨` 署名必须保留，私人专名/私人路径必须 0。
 *
 * ── 口径 ──────────────────────────────────────────────────────────────────
 * 三个作用域，各自有各自的判据：
 *   · `code`  —— `src/` + `scripts/`：**必须 0**（这是随安装包与仓库一起发出去的东西）；
 *   · `docs`  —— `docs/` 非归档区：**必须 0**（公开仓库里同样可见）；
 *   · `root`  —— `README.md` / `LICENSE` / `package.json` / 构建配置：**必须 0**，
 *               并且要**确认署名还在**（见 `--signature`）。
 *
 * 归档区（`docs/archive/`、`docs/agents-archive/`）按“原文一字未改”的历史证据保留，不扫；
 * 它们只在发布前人工确认“里面没有真实设定全文”。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 *   node scripts/privacy-scan.mjs                 # 全扫（默认专名表）
 *   node scripts/privacy-scan.mjs --scope code    # 只扫代码
 *   node scripts/privacy-scan.mjs --terms 某专名,另一条
 *   node scripts/privacy-scan.mjs --json          # 机器可读（CI/用例用）
 *   node scripts/privacy-scan.mjs --self-test     # 负向探针：塞一个假专名，必须被抓到
 *   node scripts/privacy-scan.mjs --signature     # 署名检查（LICENSE/README）
 * 退出码：0 = 干净；1 = 有命中 / 署名缺失 / 探针失效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { decodeTerms } = require_('./privacy-terms.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 默认私人专名表：来自 `scripts/privacy-terms.js`（base64，明文不在仓里） */
export const DEFAULT_TERMS = decodeTerms();

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.vue', '.py', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.txt', '.ts', '.sitian']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'release-018', 'release-018b', 'release-019',
  'release-green', 'release-inst', 'release-internal', 'release-p2', 'release-p3', 'release-p4', 'release-p5',
  'refs', 'backups', '.test-edge-profile', '.lab-edge-profile', '.workbuddy', '.hermes', '__pycache__',
  'prototype', 'docs/assets', 'sitian-architecture.html']);

/** 递归收集文本文件（相对路径；跳过二进制/构建产物/归档） */
export function walkFiles(baseDir, opts = {}) {
  const out = [];
  const skipArchive = opts.skipArchive !== false;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        if (/\.backups$/.test(e.name)) continue;   // 项目备份目录（本地产物，gitignore 已忽略）
        if (skipArchive && (rel === 'docs/archive' || rel === 'docs/agents-archive')) continue;
        walk(abs);
      } else if (e.isFile()) {
        if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
        // 扫描器与词表自身不扫：它们按设计就含词表（base64，明文不落库）
        if (rel === 'scripts/privacy-scan.mjs' || rel === 'scripts/privacy-terms.js') continue;
        out.push(rel);
      }
    }
  };
  walk(baseDir);
  return out;
}

/** 扫一批文件；返回 { hits: [{file,line,term,text}], scanned } */
export function scanFiles(files, terms) {
  const list = (terms && terms.length ? terms : DEFAULT_TERMS).filter((t) => typeof t === 'string' && t.length >= 2);
  const hits = [];
  let scanned = 0;
  for (const rel of files) {
    // 绝对路径原样用（负向探针会在临时目录里造一个泄漏文件；`path.join` 不认绝对路径）
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    scanned++;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const t of list) {
        if (lines[i].includes(t)) {
          hits.push({ file: rel, line: i + 1, term: t, text: lines[i].trim().slice(0, 160) });
          break; // 一行只报一次，避免同义词刷屏
        }
      }
    }
  }
  return { hits, scanned };
}

export const SCOPES = {
  code: () => walkFiles(path.join(ROOT, 'src')).concat(walkFiles(path.join(ROOT, 'scripts'))),
  docs: () => walkFiles(path.join(ROOT, 'docs')),
  root: () => ['README.md', 'LICENSE', 'package.json', 'THIRD_PARTY_NOTICES.md', 'vite.config.js', 'tailwind.config.js']
    .filter((f) => fs.existsSync(path.join(ROOT, f))),
  // 2026-11-05：示例项目也是**发布物**（随安装包走）—— 它里面的底图名/剧本名同样是“私人世界内容”
  sample: () => (fs.existsSync(path.join(ROOT, 'sample')) ? walkFiles(path.join(ROOT, 'sample')) : []),
};

/** 署名检查：LICENSE 与 README 里的作者必须逐字还在 */
export function checkSignature() {
  const need = [
    { file: 'LICENSE', part: '暮雨' },
    { file: 'README.md', part: '暮雨' },
  ];
  const out = [];
  for (const n of need) {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, n.file), 'utf8'); } catch (_) { text = ''; }
    out.push({ file: n.file, part: n.part, ok: text.includes(n.part) });
  }
  return out;
}

/** 负向探针：把假专名写进临时目录，扫描必须抓到；清掉后必须干净 */
export function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-privacy-'));
  const fake = path.join(dir, 'leak.md');
  fs.writeFileSync(fake, '这是一段含 假专名-绝密 的文字\n', 'utf8');
  const bad = scanFiles([fake], ['假专名-绝密']);
  const clean = scanFiles([fake], ['不存在的专名']);
  fs.rmSync(dir, { recursive: true, force: true });
  return { caught: bad.hits.length === 1, quietWhenClean: clean.hits.length === 0 };
}

function parseArgs(argv) {
  const o = { scope: 'all', terms: null, json: false, selfTest: false, signature: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') o.scope = argv[++i] || 'all';
    else if (a === '--terms') o.terms = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json') o.json = true;
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '--signature') o.signature = true;
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.selfTest) {
    const r = selfTest();
    const ok = r.caught && r.quietWhenClean;
    if (o.json) console.log(JSON.stringify(r));
    else console.log((ok ? '✅ ' : '🔴 ') + `负向探针：塞假专名被抓到=${r.caught} / 无专名时安静=${r.quietWhenClean}`);
    return ok ? 0 : 1;
  }

  const scopes = o.scope === 'all' ? Object.keys(SCOPES) : o.scope.split(',');
  const report = {};
  let bad = 0;
  for (const s of scopes) {
    const gen = SCOPES[s];
    if (!gen) { console.error('未知 scope：' + s); return 2; }
    const r = scanFiles(gen(), o.terms);
    report[s] = r;
    bad += r.hits.length;
  }
  const sig = o.signature ? checkSignature() : null;
  const sigBad = sig ? sig.filter((x) => !x.ok).length : 0;

  if (o.json) {
    console.log(JSON.stringify({ report, signature: sig, terms: o.terms || DEFAULT_TERMS }, null, 2));
  } else {
    for (const [s, r] of Object.entries(report)) {
      console.log(`\n[${s}] 扫了 ${r.scanned} 个文件 · 命中 ${r.hits.length}`);
      for (const h of r.hits.slice(0, 40)) console.log(`  ${h.file}:${h.line}  «${h.term}»  ${h.text}`);
      if (r.hits.length > 40) console.log(`  …还有 ${r.hits.length - 40} 条`);
    }
    if (sig) {
      for (const x of sig) console.log(`${x.ok ? '✅' : '🔴'} 署名 ${x.part} 在 ${x.file}`);
    }
    console.log(bad || sigBad ? `\n🔴 共 ${bad} 处命中${sigBad ? ` / 署名缺失 ${sigBad}` : ''}` : '\n✅ 0 命中');
  }
  return (bad || sigBad) ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
