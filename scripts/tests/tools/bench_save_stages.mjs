// 离线基准：把保存链的每段在真实项目文件上单独计时（**只读**项目文件，不写盘）
// 用法：node scripts/tests/tools/bench_save_stages.mjs [<项目文件>]
//   不给参数时取 `Documents/SiTianProjects` 里**最近改动**的 .sitian（刻意不写死项目名：
//   发布物与 scripts/ 都不许带私人专名，隐私扫描守门）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
function newestProject() {
  const base = path.join(os.homedir(), 'Documents', 'SiTianProjects');
  if (!fs.existsSync(base)) return '';
  const cands = fs.readdirSync(base)
    .filter((f) => f.endsWith('.sitian'))
    .map((f) => path.join(base, f))
    .filter((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
  if (!cands.length) return '';
  return cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
const file = process.argv[2] || newestProject();
if (!file || !fs.existsSync(file)) {
  console.error('找不到项目文件：请显式传一个 .sitian 路径');
  process.exit(2);
}

// projectSchema 是 ESM 且相对 import 没写扩展名 → 复制到临时目录补 .js 再 import
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-schema-'));
for (const name of ['projectSchema.js', 'normalizeId.js']) {
  let src = await fsp.readFile(path.join(ROOT, 'src', 'renderer', 'src', 'utils', name), 'utf8');
  src = src.replaceAll("from './normalizeId'", "from './normalizeId.js'");
  await fsp.writeFile(path.join(tmp, name), src, 'utf8');
}
await fsp.writeFile(path.join(tmp, 'package.json'), '{"type":"module"}', 'utf8');
const S = await import(pathToFileURL(path.join(tmp, 'projectSchema.js')).href);

const now = () => Number(process.hrtime.bigint()) / 1e6;
const rows = [];
function time(label, fn) {
  const t0 = now();
  const out = fn();
  rows.push([label, +(now() - t0).toFixed(1)]);
  return out;
}

const text = fs.readFileSync(file, 'utf8');
console.log(`项目：${file}（${(text.length / 1048576).toFixed(2)} MB 文本）`);
const project = time('JSON.parse(整文件)', () => JSON.parse(text));
console.log('顶层键：', Object.keys(project).map(k => `${k}=${JSON.stringify(project[k]).length}`).join('  '));
console.log('snapshots：', (project.snapshots || []).length, '份');

// ① 快照链
const state = time('snapshotState（4 键深拷）', () => S.snapshotState(project));
time('pushSnapshot（含 replay+diff+体积）', () => S.pushSnapshot(project, { label: 'bench' }));
const pushed = S.pushSnapshot(project, { label: 'bench2' });

// ② 整串序列化
const json = time('toIpcJson（整项目）', () => S.toIpcJson(pushed));

// ③ 分块序列化原型：按顶层键切块，逐块 JSON.stringify
const chunks = [];
const t0 = now();
const keys = Object.keys(pushed);
for (const k of keys) {
  const t = now();
  const piece = JSON.stringify(pushed[k], S.jsonSafeReplacer);
  chunks.push([k, piece, +(now() - t).toFixed(1)]);
}
const chunkTotal = +(now() - t0).toFixed(1);
const assembled = '{' + chunks.map(([k, piece]) => JSON.stringify(k) + ':' + (piece === undefined ? 'null' : piece)).join(',') + '}';

console.log('\n== 分块（按顶层键）耗时 ==');
for (const [k, piece, ms] of chunks) console.log(`  ${k.padEnd(12)} ${String((piece || '').length).padStart(9)} 字节  ${ms} ms`);
console.log(`  合计 ${chunkTotal} ms`);

const wholeParse = JSON.parse(json);
const chunkParse = JSON.parse(assembled);
console.log('\n分块拼回与整串是否等价（parse 后 deepEqual）：', S.deepEqual(wholeParse, chunkParse) ? '一致' : '不一致');
console.log('JSON 文本逐字节一致：', json === assembled ? '是' : '否');

console.log('\n== 计时汇总 ==');
for (const [k, ms] of rows) console.log(`  ${k.padEnd(28)} ${String(ms).padStart(8)} ms`);
