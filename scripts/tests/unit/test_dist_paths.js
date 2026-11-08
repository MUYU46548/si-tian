#!/usr/bin/env node
/**
 * Node 单测：打包产物**不许再落进仓库**（2026-11-08，用户：“构建目录本来就不应该跑到其他文件夹里污染仓库”）
 *
 * 背景：历史上一共攒了 10 个 release-xxx 目录 / 3.9 GB（release、release-018、release-inst、release-p2…）。根因不是哪个名字起错了，是**默认落点在仓库里**，而换目录靠改静态配置/加参数，
 * 于是每次都多一个。现在输出目录由 `scripts/lib/distPaths.mjs` 算（系统用户数据目录），
 * npm 脚本一律走 `scripts/dist.mjs`。
 *
 * 判据：
 *   a1 默认输出目录**不在仓库内**（这是本条用例的存在理由）；
 *   a2 默认目录 = <root>/release；
 *   a3 `SITIAN_DIST_ROOT` 能覆盖（有人想显式放回来，允许，但必须是他写的）；
 *   a4 npm 的 dist / dist:dir / dist:publish **都必须**经过 `scripts/dist.mjs`（不许再裸调 electron-builder）；
 *   a5 `scripts/dist.mjs` 确实把 `--config.directories.output=` 透传给 electron-builder；
 *   a6 反向探针：把根指到仓库里时，a1 那种断言确实会红（证明判据不是空转）。
 *
 * 用法：node scripts/tests/unit/test_dist_paths.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

(async () => {
  const { resolveDistRoot, resolveDistDir } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'distPaths.mjs')).href
  );
  const saved = process.env.SITIAN_DIST_ROOT;
  const clean = () => { delete process.env.SITIAN_DIST_ROOT; };
  const restore = () => {
    if (saved === undefined) delete process.env.SITIAN_DIST_ROOT;
    else process.env.SITIAN_DIST_ROOT = saved;
  };

  check('a1 默认输出目录不在仓库内', () => {
    clean();
    const dir = resolveDistDir();
    assert(!inside(dir, ROOT), `默认产物目录落进了仓库：${dir}`);
    return dir;
  });

  check('a2 默认目录 = <root>/release', () => {
    clean();
    eq(resolveDistDir(), path.join(resolveDistRoot(), 'release'), '目录形状');
    return path.basename(resolveDistDir());
  });

  check('a3 SITIAN_DIST_ROOT 能覆盖（显式放回来也允许）', () => {
    process.env.SITIAN_DIST_ROOT = path.join(ROOT, 'build', 'dist-probe');
    const dir = resolveDistDir();
    assert(inside(dir, ROOT), '覆盖没生效');
    return dir;
  });

  check('a4 npm 的 dist* 脚本必须经过 scripts/dist.mjs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const k of ['dist', 'dist:dir', 'dist:publish']) {
      const cmd = String((pkg.scripts || {})[k] || '');
      assert(cmd.includes('node scripts/dist.mjs'),
        `${k} 没有走 scripts/dist.mjs（会再出现“裸调 electron-builder 写仓库”）：${cmd}`);
      assert(!/(^|\s)electron-builder(\s|$)/.test(cmd.replace('node scripts/dist.mjs', '')),
        `${k} 里还留着裸 electron-builder 调用：${cmd}`);
    }
    return ['dist', 'dist:dir', 'dist:publish'].join(' / ');
  });

  check('a5 dist.mjs 真的把输出目录透传给 electron-builder', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'dist.mjs'), 'utf8');
    assert(src.includes('--config.directories.output='), '没有传 --config.directories.output');
    assert(src.includes('resolveDistDir'), '没有走 resolveDistDir（自己另算一遍 = 两份实现）');
    return 'ok';
  });

  check('a6 反向探针：根指回仓库时，a1 的判据确实会红', () => {
    process.env.SITIAN_DIST_ROOT = path.join(ROOT, 'release');
    const dir = resolveDistDir();
    assert(inside(dir, ROOT), '探针失败：指回仓库后居然还判“不在仓库内”');
    restore();
    return '红得正确';
  });

  restore();
  const ok = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}  — ${r.detail}`);
  console.log(`\n${ok}/${results.length} 通过`);
  if (ok !== results.length) process.exit(1);
})();
