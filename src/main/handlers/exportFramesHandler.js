// main/handlers/exportFramesHandler.js
// 历史剧本「逐年切片」批量落盘的**唯一实现**（一次选目录 → 写 N 帧 + 一份 frames.json 清单）。
//
// 为什么单独一层：
//   ① 现有两个保存通道（`save-export-file` / `save-text-file`）都是**一次调用弹一个模态框** ——
//      11 帧就是 11 次模态，用户要按 11 次「保存」。EU4 式切片必须是「选一次目录，写一批」。
//   ② 主进程纪律：本文件**顶层不 require electron**（只依赖 fs/path）→ 能被
//      `scripts/tests/unit/*.js` 直接调用做**真落盘**断言；对话框留在 `main/index.js`。
//   ③ 写文件是本项目里最不能出错的一段（数据安全承诺）。所以：名字全部先消毒（不许出现
//      路径分隔符 / `..`）、先写 `.tmp-<ts>` 再 rename（断电不留半个文件）、
//      整批上限与单帧上限都有闸门，且**全程返回 `{success:false, error}` 而不抛异常**。
//
// 目录选择：调用方给「父目录 + 子目录名」，本模块**永不覆盖同名子目录**
// （已存在就 `-2`/`-3` 往后排），所以重复导出不会把上一次的帧冲掉。
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/** 单批帧数上限（与渲染层 `MAX_SLICE_FRAMES` 同量级；含 svg+png 双份时按文件数算） */
const MAX_FILES = 800;
/** 单帧文本（SVG）上限 */
const MAX_TEXT_BYTES = 24 * 1024 * 1024;
/** 单帧位图（PNG dataURL）上限 */
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
/** 整批上限 */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** 子目录去重时最多试几个后缀 */
const MAX_DIR_ATTEMPTS = 60;

/** 文件名消毒：只留基名，去掉路径分隔符与控制字符；空则给兜底名 */
function safeFileName(name, fallback = 'frame') {
  const base = String(name == null ? '' : name).replace(/[\\/]/g, '_');
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || fallback;
}

/** 目录名消毒（同上，另加长度上限） */
function safeDirName(name, fallback = 'sitian-slices') {
  return safeFileName(name, fallback).slice(0, 80) || fallback;
}

/** dataURL → Buffer；非图片 dataURL 直接报错（不猜格式） */
function decodeDataUrl(dataUrl) {
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(String(dataUrl || ''));
  if (!m) return { error: '不是合法的 base64 dataURL' };
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return { error: 'dataURL 解码为空' };
  return { buffer: buf, mime: m[1].toLowerCase() };
}

/** 原子写：先 `.tmp-<ts>-<rand>` 再 rename（同目录内 rename 是原子操作） */
async function atomicWriteFile(target, data) {
  const tmp = `${target}.tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch (_) { /* 清不掉也不掩盖原错误 */ }
    throw err;
  }
}

/** 在 parentDir 下挑一个不存在的子目录名（`base`、`base-2`、…），**绝不覆盖已有目录** */
async function pickUniqueDir(parentDir, base) {
  for (let i = 1; i <= MAX_DIR_ATTEMPTS; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    const full = path.join(parentDir, name);
    try {
      await fsp.access(full);
    } catch (_) {
      return { name, full };
    }
  }
  return null;
}

/**
 * 把一批帧写进「父目录下的一个新子目录」。
 *
 * @param {string} parentDir 目标父目录（必须是**绝对路径**，由渲染层经系统对话框拿到）
 * @param {object} payload
 * @param {string} [payload.dirName] 子目录名（消毒；默认 `sitian-slices-<ts>`）
 * @param {Array<{name:string, text?:string, dataUrl?:string}>} payload.files 帧文件
 * @param {object} [payload.manifest] 清单对象（写为 frames.json）
 * @returns {Promise<{success:boolean, error?:string, dir?:string, count?:number,
 *                    bytes?:number, files?:string[], manifestPath?:string}>}
 */
async function writeFrames(parentDir, payload = {}) {
  try {
    if (typeof parentDir !== 'string' || !parentDir) return { success: false, error: '没有指定导出目录' };
    if (!path.isAbsolute(parentDir)) return { success: false, error: '导出目录必须是绝对路径' };
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!files.length) return { success: false, error: '没有要写入的帧' };
    if (files.length > MAX_FILES) return { success: false, error: `帧文件数 ${files.length} 超过上限 ${MAX_FILES}` };

    // ① 先把整批**全部校验/解码**再落盘：任何一帧不合格就整批不写（不留半批）
    const prepared = [];
    const seen = new Set();
    let total = 0;
    for (const f of files) {
      const rawName = f && f.name;
      if (typeof rawName !== 'string' || !rawName.trim()) return { success: false, error: '帧缺少文件名' };
      if (/[\\/]/.test(rawName) || rawName.includes('..')) {
        return { success: false, error: `帧文件名不合法（不许含路径）：${rawName}` };
      }
      const name = safeFileName(rawName);
      if (seen.has(name)) return { success: false, error: `帧文件名重复：${name}` };
      seen.add(name);

      const hasText = typeof f.text === 'string';
      const hasData = typeof f.dataUrl === 'string' && f.dataUrl;
      if (hasText === !!hasData) {
        return { success: false, error: `帧 ${name} 必须**恰好**带 text 或 dataUrl 之一` };
      }
      let data;
      if (hasText) {
        data = Buffer.from(f.text, 'utf8');
        if (data.length > MAX_TEXT_BYTES) return { success: false, error: `帧 ${name} 超过单帧文本上限` };
      } else {
        const dec = decodeDataUrl(f.dataUrl);
        if (dec.error) return { success: false, error: `帧 ${name}：${dec.error}` };
        if (dec.buffer.length > MAX_IMAGE_BYTES) return { success: false, error: `帧 ${name} 超过单帧位图上限` };
        data = dec.buffer;
      }
      total += data.length;
      if (total > MAX_TOTAL_BYTES) return { success: false, error: '整批体积超过上限，请减少帧数或降低 PNG 倍率' };
      prepared.push({ name, data });
    }

    // ② 目录（父目录必须已存在且可写；子目录名去重）
    let st;
    try {
      st = await fsp.stat(parentDir);
    } catch (_) {
      return { success: false, error: `导出目录不存在：${parentDir}` };
    }
    if (!st.isDirectory()) return { success: false, error: `导出目标不是目录：${parentDir}` };

    const base = safeDirName(payload.dirName || `sitian-slices-${Date.now()}`);
    const picked = await pickUniqueDir(parentDir, base);
    if (!picked) return { success: false, error: `同名目录过多，无法新建：${base}` };
    await fsp.mkdir(picked.full, { recursive: true });

    // ③ 逐个原子写
    const written = [];
    for (const p of prepared) {
      await atomicWriteFile(path.join(picked.full, p.name), p.data);
      written.push(p.name);
    }

    let manifestPath = null;
    if (payload.manifest && typeof payload.manifest === 'object') {
      const manifest = { ...payload.manifest };
      manifest.dir = picked.name;
      // `files` = **帧文件**（按帧序，不含 frames.json 自身）—— 外部 ffmpeg 直接吃这个列表
      manifest.files = written.slice();
      manifest.writtenAt = new Date().toISOString();
      const json = JSON.stringify(manifest, null, 1);
      manifestPath = path.join(picked.full, 'frames.json');
      await atomicWriteFile(manifestPath, Buffer.from(json, 'utf8'));
      written.push('frames.json');           // 返回值里的 files = 本次写下的**全部条目**
      total += Buffer.byteLength(json, 'utf8');
    }

    return {
      success: true, dir: picked.full, dirName: picked.name,
      count: prepared.length, bytes: total, files: written, manifestPath,
    };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
}

module.exports = {
  writeFrames, safeFileName, safeDirName, decodeDataUrl, atomicWriteFile, pickUniqueDir,
  MAX_FILES, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES,
};
