// src/main/diagPackage.js — 诊断包（发布门槛④，2026-11-05）
//
// ── 它解决什么 ──────────────────────────────────────────────────────────────
// 发布之后陌生人崩了，只能截个横幅，没有任何可发回来的东西。这里给一个**本地一键导出**：
// 版本 / 环境 / 配置摘要 / 最近日志 / 最近一次错误 + 项目**计数**（不含任何设定文本）。
//
// ── 三条硬规矩（判据就守这三条）──────────────────────────────────────────────
// ① **不带世界观正文**：包内不读项目文件、不读笔记；项目只给数字；
// ② **路径脱敏**：库路径/项目路径只报“是否为空 + 盘符”；日志里的一切绝对路径都换成占位符
//    （含 `C:\Users\<用户名>`）—— 末段可能就是私人项目名；
// ③ **零依赖**：ZIP 用 STORED（不压缩）自己写，够用（几百 KB），不引 archiver/jszip。
//
// 纯函数 + 注入 fs：`scripts/tests/unit/test_diag_package.js` 直接 import 本文件（Node 可测）。

'use strict';

/** 路径脱敏：只留“空不空 + 盘符 + 层级”，一个目录名都不留 */
function maskPath(p) {
  if (!p || typeof p !== 'string') return { empty: true };
  const m = /^([A-Za-z]:)[\\/]/.exec(p);
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return {
    empty: false,
    drive: m ? m[1].toUpperCase() : '(相对路径)',
    segments: parts.length,
  };
}

/**
 * 文本脱敏：把已知敏感路径（库路径/项目路径）与一切绝对路径替换成占位符。
 * 保留盘符（诊断时“是不是在 C 盘”有用），其余一律抹掉。
 */
function redactText(text, secrets = []) {
  let s = String(text == null ? '' : text);
  // ① 先抹**整条绝对路径**（用户名/库名/项目名都在这条路径里，抹前缀会留下后半截）。
  //    `(?<![A-Za-z])` 是必须的：否则 `https://…` 里的 `s:/` 会被当成盘符路径，
  //    诊断包里把 URL 抹成 `<路径:S:>` 就看不出是哪一次网络请求了（用例守这一条）。
  s = s.replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'<>|]+/g, (m0) => `<路径:${m0.slice(0, 2).toUpperCase()}>`);
  // ② 再抹**知道的那几条**（库路径/项目路径）可能以别的写法出现的前缀
  for (const sec of secrets) {
    if (typeof sec !== 'string' || sec.length < 3) continue;
    s = s.split(sec).join('<路径已脱敏>');
    const alt = sec.replace(/\\/g, '/');
    if (alt !== sec) s = s.split(alt).join('<路径已脱敏>');
  }
  return s;
}

/** 日志目录里最近 N 个文件的尾部（同步读；目录不存在返回空） */
function tailLogFiles(logDir, opts = {}) {
  const fsImpl = opts.fs || require('fs');
  const pathImpl = opts.path || require('path');
  const maxFiles = Number.isFinite(opts.maxFiles) ? Math.max(1, opts.maxFiles) : 3;
  const maxLines = Number.isFinite(opts.maxLines) ? Math.min(2000, Math.max(1, opts.maxLines)) : 400;
  const out = { dir: logDir ? '<日志目录>' : '', files: [], lines: [], bytes: 0 };
  if (!logDir) return out;
  let names = [];
  try {
    names = fsImpl.readdirSync(logDir)
      .filter((n) => /\.log$/i.test(n))
      .map((n) => ({ n, t: (() => { try { return fsImpl.statSync(pathImpl.join(logDir, n)).mtimeMs; } catch (_) { return 0; } })() }))
      .sort((a, b) => b.t - a.t)
      .slice(0, maxFiles)
      .map((x) => x.n);
  } catch (_) {
    return out;
  }
  for (const n of names) {
    let text = '';
    try {
      text = fsImpl.readFileSync(pathImpl.join(logDir, n), 'utf8');
    } catch (_) { continue; }
    const all = text.split(/\r?\n/).filter((l) => l.length > 0);
    const tail = all.slice(-maxLines);
    out.files.push({ name: n, lines: all.length, kept: tail.length });
    out.bytes += Buffer.byteLength(text, 'utf8');
    out.lines.push(...tail);
  }
  // 只保留最后 maxLines 行（多文件时也不能把整本日志塞进包里）
  if (out.lines.length > maxLines) out.lines = out.lines.slice(-maxLines);
  return out;
}

/** 从日志尾部捞最近一次错误（electron-log 的格式：`[时间] [级别] ...`） */
function lastErrorFrom(lines) {
  const list = Array.isArray(lines) ? lines : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const l = list[i];
    if (/\b(error|uncaughtException|unhandledRejection)\b/i.test(l)) {
      // 往前带 2 行（堆栈首行常在同一行后面；多行堆栈在下面）
      const stack = list.slice(i, Math.min(list.length, i + 12)).join('\n');
      return { line: l.slice(0, 400), stack: stack.slice(0, 4000) };
    }
  }
  return null;
}

/**
 * 组包（只组数据，不写盘）。
 * @param {object} input 全部由调用方采集（见 main/index.js 的 diag-export）
 */
function buildDiagnostics(input = {}) {
  const secrets = input.secrets || [];
  const logs = tailLogFiles(input.logDir, input.logOptions || {});
  const redactedLog = logs.lines.map((l) => redactText(l, secrets));
  const err = lastErrorFrom(redactedLog);
  const stats = input.stats && typeof input.stats === 'object' ? input.stats : {};
  const pickNumber = (v) => (Number.isFinite(v) ? v : null);
  return {
    manifestVersion: 1,
    exportedAt: new Date().toISOString(),
    note: '诊断包：版本/环境/配置摘要/最近日志/项目计数。不含世界观正文；路径已脱敏。',
    app: {
      name: 'SiTian',
      version: String(input.version || ''),
      packaged: !!input.packaged,
      locale: String(input.locale || ''),
    },
    runtime: {
      electron: (input.versions && input.versions.electron) || '',
      chrome: (input.versions && input.versions.chrome) || '',
      node: (input.versions && input.versions.node) || '',
      v8: (input.versions && input.versions.v8) || '',
      platform: String(input.platform || ''),
      arch: String(input.arch || ''),
      osRelease: redactText(input.osRelease || '', secrets),
    },
    machine: {
      cpuCount: pickNumber(input.cpuCount),
      totalMemoryGB: Number.isFinite(input.totalMemoryGB) ? Math.round(input.totalMemoryGB * 10) / 10 : null,
      screen: input.screen || null,
    },
    config: {
      vault: maskPath(input.vaultPath),
      lastProject: maskPath(input.lastProjectPath),
    },
    project: {
      entities: pickNumber(stats.entities),
      baseMaps: pickNumber(stats.baseMaps),
      provinces: pickNumber(stats.provinces),
      scenarios: pickNumber(stats.scenarios),
      gridCells: pickNumber(stats.gridCells),
      rivers: pickNumber(stats.rivers),
      roads: pickNumber(stats.roads),
    },
    logs: {
      dir: '<日志目录>',
      files: logs.files,
      bytes: logs.bytes,
      keptLines: redactedLog.length,
    },
    lastError: err,
    logTail: redactedLog,
  };
}

// ── 最小 ZIP 写入器（STORED，无压缩，UTF-8 文件名，零依赖）──────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 固定 DOS 时间戳（2026-01-01 00:00）：同样的输入产出同样的字节，用例才能逐字节对拍
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * @param {Array<{name:string, data:string|Buffer}>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of list) {
    const name = Buffer.from(String(e.name || 'file.txt').replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // UTF-8 名字
    lh.writeUInt16LE(0, 8);           // stored
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attr
    ch.writeUInt32LE(0, 38);          // external attr
    ch.writeUInt32LE(offset, 42);     // local header offset
    centrals.push(ch, name);

    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * 写诊断包：`<target>` 一个 zip，内含 `diagnostics.json` 与 `logs.txt`。
 * @returns {{ok:boolean, path?:string, entries?:string[], bytes?:number, error?:string}}
 */
function writeDiagnostics(target, diag) {
  const fs = require('fs');
  try {
    const json = JSON.stringify(diag, null, 2);
    const logs = Array.isArray(diag.logTail) ? diag.logTail.join('\n') : '';
    const zip = makeZip([
      { name: 'diagnostics.json', data: json },
      { name: 'logs.txt', data: logs },
    ]);
    fs.writeFileSync(target, zip);
    return { ok: true, path: target, entries: ['diagnostics.json', 'logs.txt'], bytes: zip.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  maskPath, redactText, tailLogFiles, lastErrorFrom,
  buildDiagnostics, makeZip, crc32, writeDiagnostics, DOS_DATE, DOS_TIME,
};
