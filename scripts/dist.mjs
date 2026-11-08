#!/usr/bin/env node
// scripts/dist.mjs — 打包入口（2026-11-08），**唯一**负责把产物输出到仓库外
//
// 为什么不用 `electron-builder` 直接跑：它的输出目录是 package.json 里的静态值，
// 早先就靠改静态值/加 `--config.directories.output=release-xxx` 换目录，
// 于是仓库里越攒越多（2026-11-08 清了 10 个目录 / 3.9 GB）。
// 现在输出目录由 `scripts/lib/distPaths.mjs` 算，npm 脚本一律走这里。
//
// 用法（npm 脚本已经包好，一般不直接调）：
//   node scripts/dist.mjs            # = npm run dist（出安装包）
//   node scripts/dist.mjs --dir      # = npm run dist:dir（只要 win-unpacked）
//   node scripts/dist.mjs --publish always   # = npm run dist:publish
// 额外参数原样透传给 electron-builder。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDistDir } from './lib/distPaths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const out = resolveDistDir();

if (!fs.existsSync(CLI)) {
  console.error('找不到 electron-builder（node_modules/electron-builder/cli.js）—— 先 npm install');
  process.exit(1);
}

// 仓库里出现同名目录时提醒一句，但不拦（可能是你显式把 SITIAN_DIST_ROOT 指回来了）
const inRepo = path.join(ROOT, 'release');
if (path.resolve(inRepo) === path.resolve(out)) {
  console.warn('⚠️ 产物目录被指到仓库里的 release/（默认不该这样）');
}

console.log(`构建产物目录：${out}`);
fs.mkdirSync(out, { recursive: true });

const child = spawn(
  process.execPath,
  [CLI, `--config.directories.output=${out}`, ...process.argv.slice(2)],
  { cwd: ROOT, stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code === null ? 1 : code);
});
