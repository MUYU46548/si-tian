// scripts/lib/loadRendererUtils.mjs — 在 Node 里加载 `src/renderer/src/utils/**` 的纯函数模块
//
// 为什么要这么绕：渲染层的 utils 是 ESM、且 import 不带扩展名（Vite 认，Node 不认），
// 直接把 `src/...` 交给 `import()` 会 `ERR_MODULE_NOT_FOUND`。做法是：把入口和它的
// `./xxx` 传递依赖抄到一个临时目录、补上 `.js`、再放一个 `{"type":"module"}` 的
// package.json —— 这样跑的是**仓库里的同一份源码**，不是复制品（没有第二实现）。
//
// 三处调用方（`scripts/migrate-ledger-v2.mjs`、`scripts/ledger-query.mjs`、以及以后的新工具）
// 共用本文件：以前每条命令各抄一份 loader，抄的人一改扩展名规则就是三份慢慢不一样。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
const DEFAULT_SRC = path.join(REPO_ROOT, 'src', 'renderer', 'src', 'utils');

/**
 * 把 `entryFile`（如 `'scenarioEventLedger.js'`）及其相对依赖抄进临时目录并 import。
 * @param {string} entryFile 相对 `srcDir` 的文件名
 * @param {{srcDir?:string}} opts
 * @returns {Promise<{mod:object, tmpDir:string, cleanup:Function}>}
 */
export async function loadRendererModule(entryFile, opts = {}) {
  const srcDir = opts.srcDir || DEFAULT_SRC;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-utils-'));
  const fix = (s) => s.replace(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g, "from './$1.js'");
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const full = path.join(srcDir, f);
    if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(path.join(tmpDir, f), fix(code));
    for (const m of code.matchAll(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g)) queue.push(`${m[1]}.js`);
  }
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ type: 'module' }));
  const entry = path.join(tmpDir, entryFile);
  if (!fs.existsSync(entry)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`找不到模块：${path.join(srcDir, entryFile)}`);
  }
  const mod = await import(pathToFileURL(entry).href);
  return {
    mod,
    tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** 仓库根目录（工具里拼默认路径用） */
export function repoRoot() {
  return REPO_ROOT;
}
