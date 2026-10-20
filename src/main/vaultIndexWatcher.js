// src/main/vaultIndexWatcher.js — 全库资料索引监听（D2 / T6，2026-10-19）
//
// 只做一件事：库内任何 `.md` 增/删/改 → 250ms 防抖 → 增量重建 `note-index.json`
// → 回调把 summary 交给主进程发 `vault-index-updated`。
//
// 🔴 与 `vault-watcher.js` 的边界：
//   · 那个监听只覆盖两个地理目录，负责**画布节点**增量；
//   · 本文件监听**整库**，只重建**只读索引**，绝不改画布、绝不写笔记。
//   两者必须分开，否则用户改一篇人物笔记会触发画布刷新（两套事实源混流）。
'use strict';

const path = require('path');
const chokidar = require('chokidar');
const vaultIndex = require('./vaultIndex');

const IGNORED = /(^|[\\/])(\.git|\.obsidian|\.sitian|node_modules|__pycache__|\.trash|\.lab-edge-profile|\.test-edge-profile)([\\/]|$)/;

/**
 * @param {string} root 库根
 * @param {(summary:object)=>void} onChange 索引重建后的回调（带 event/path）
 * @param {{debounceMs?:number}} [opts]
 * @returns {{close:()=>void}}
 */
function startIndexWatcher(root, onChange, opts = {}) {
  if (!root) return { close() {} };
  const rootAbs = path.resolve(root);
  const debounceMs = Number(opts.debounceMs) >= 0 ? Number(opts.debounceMs) : 250;
  let timer = null;
  let closed = false;

  const watcher = chokidar.watch(rootAbs, {
    // 只关心 `.md`；附件/图片不进索引，watcher 也不该为它们付监听成本
    ignored: (p) => IGNORED.test(String(p)) || (/\.[a-z0-9]+$/i.test(String(p)) && !/\.md$/i.test(String(p))),
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });

  const schedule = (event, fullPath) => {
    if (!/\.md$/i.test(fullPath)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      try {
        const { summary } = vaultIndex.buildIndex(rootAbs);
        if (typeof onChange === 'function') {
          onChange({
            ...summary,
            event,
            path: path.relative(rootAbs, fullPath).replace(/\\/g, '/'),
          });
        }
      } catch (e) {
        if (typeof onChange === 'function') {
          onChange({ error: String((e && e.message) || e), event, path: fullPath });
        }
      }
    }, debounceMs);
  };

  watcher
    .on('add', (p) => schedule('add', p))
    .on('change', (p) => schedule('change', p))
    .on('unlink', (p) => schedule('unlink', p))
    .on('error', (e) => console.warn('[IndexWatcher] 错误:', (e && e.message) || e));

  console.log('[IndexWatcher] 资料索引监听已启动：', rootAbs);
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try { watcher.close(); } catch (e) { /* ignore */ }
    },
  };
}

module.exports = { startIndexWatcher, IGNORED };
