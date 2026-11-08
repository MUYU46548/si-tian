// scripts/lib/distPaths.mjs — 打包产物的落点（**唯一实现**，2026-11-08）
//
// 为什么要单独一份：用户 2026-11-08 的批评是“构建目录本来就不应该跑到其他文件夹里污染仓库”。
// 历史情况：`npm run dist` 默认写 `release/`，而几次实验又用 `release-xxx/` 输出，
// 结果仓库里堆了 10 个目录、3.9 GB（已清理）。根因不是“哪个名字”，是**默认落点在仓库里**。
//
// 现在的口径：
//   · 默认落到系统的用户数据目录（Windows = %LOCALAPPDATA%\sitian-build\release）
//   · 想改就设环境变量 `SITIAN_DIST_ROOT`（**仓库内也允许**，但那是你显式选的，不是默认）
//   · 仓库里再出现 `release*/` 只可能是历史残留；`unit/test_dist_paths.js` 守着默认值不在仓库内
//
// 单一实现：`scripts/dist.mjs`（打包）与 `scripts/tests/drill_packaged_app.py`（验包）都问这里。
import os from 'node:os';
import path from 'node:path';

/** 产物根目录（不是最终 `release/`，是它的上一层） */
export function resolveDistRoot() {
  const env = String(process.env.SITIAN_DIST_ROOT || '').trim();
  if (env) return path.resolve(env);
  if (process.platform === 'win32') {
    const base = String(process.env.LOCALAPPDATA || '').trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'sitian-build');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'sitian-build');
  }
  const base = String(process.env.XDG_DATA_HOME || '').trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'sitian-build');
}

/** 最终产物目录（electron-builder 的 `directories.output`） */
export function resolveDistDir() {
  return path.join(resolveDistRoot(), 'release');
}
