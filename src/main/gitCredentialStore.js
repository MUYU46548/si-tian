// src/main/gitCredentialStore.js — 远程仓库访问令牌的**应用侧**保管（2026-09-22）
//
// ── 为什么需要它（真实事故）──────────────────────────────────────────────
// 用户按面板提示填了 Personal Access Token，点「立即同步」仍报「远程仓库需要登录」。
// 原因：旧实现把令牌**只**交给 `git credential approve`（系统凭据管理器 / GCM），
// 推送时能不能取回来取决于 **路径里的那一个 git 与它的 credential.helper 配置**
// （应用进程 spawn 的 git 与用户 shell 里的 git 未必是同一个，helper 也可能是 store/cache/none）。
// 也就是说：**令牌存进去了 ≠ 推送时能取回来**，而失败表现是「我明明填了令牌」。
//
// 现在：推送/拉取一律由本模块提供的令牌直接喂给 git（见 gitSyncHandler 的 credentialArgs），
// 系统凭据管理器只作为**附加**写入（让用户在命令行里也能用），不再是推送的必要条件。
//
// ── 安全约定 ────────────────────────────────────────────────────────────
// · 令牌在磁盘上**必须加密**（Windows: safeStorage/DPAPI）。加解密函数由调用方注入，
//   本文件顶层**不 require electron**（这样纯 Node 单测能直接 require 它）。
// · 拿不到加密能力时**宁可不落盘**，只保留在进程内存里（当前会话可用），
//   并如实告知「本次会话有效」—— 不写明文、不假装已保存。
// · 令牌绝不回传渲染层：`get()` 只给主进程内部用，IPC 只回 `{hasToken, username}`。
const path = require('path');
const fs = require('fs').promises;

const FILE_NAME = 'git-credentials.json';

function normHost(host) {
  return String(host || '').trim().toLowerCase();
}

/**
 * @param {{dir?: string, encrypt?: (s:string)=>string|null, decrypt?: (s:string)=>string|null}} opts
 *   dir      — 存放凭据文件的目录（Electron: app.getPath('userData')）
 *   encrypt  — 字符串加密（Electron: safeStorage.encryptString → base64）
 *   decrypt  — 对应解密
 */
function createCredentialStore({ dir = '', encrypt = null, decrypt = null } = {}) {
  const file = dir ? path.join(dir, FILE_NAME) : '';
  const canPersist = !!(file && typeof encrypt === 'function' && typeof decrypt === 'function');
  /** 无加密能力（或读文件失败）时的会话内保管：host → {username, token} */
  const session = new Map();

  async function readAll() {
    if (!canPersist) return {};
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) {
      return {};   // 不存在 / 损坏 → 当成空，不抛错（凭据丢了最多是重新填一次）
    }
  }

  async function writeAll(obj) {
    const tmp = `${file}.tmp-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    await fs.rename(tmp, file);   // 原子替换：断电不会留下半个 JSON
  }

  /**
   * 取回令牌（仅主进程内部使用；绝不回传渲染层）。
   * 命名为独立函数（不用 this）—— 便于解构调用与单测。
   * @returns {Promise<{username:string, token:string}|null>}
   */
  async function get(host = '') {
    const h = normHost(host);
    if (!h) return null;
    if (session.has(h)) return session.get(h);
    if (!canPersist) return null;
    const all = await readAll();
    const rec = all[h];
    if (!rec || !rec.secret) return null;
    try {
      const token = String(decrypt(rec.secret) || '');
      if (!token) return null;
      const value = { username: String(rec.username || ''), token };
      session.set(h, value);
      return value;
    } catch (e) {
      return null;   // 解密失败（换了机器/用户）→ 视为没有，让用户重填
    }
  }

  return {
    /** 是否具备「跨会话保存」能力（false = 只在本次会话内存里） */
    persistent: canPersist,
    file: canPersist ? file : '',

    /**
     * 保存令牌。
     * @returns {Promise<{ok:boolean, persistent:boolean, error?:string}>}
     */
    async set({ host = '', username = '', token = '' } = {}) {
      const h = normHost(host);
      const t = String(token || '').trim();
      const u = String(username || '').trim();
      if (!h) return { ok: false, persistent: canPersist, error: '缺少域名（请先填/保存仓库地址）' };
      if (!t) return { ok: false, persistent: canPersist, error: '令牌为空' };

      if (!canPersist) {
        session.set(h, { username: u, token: t });
        return { ok: true, persistent: false };
      }
      try {
        const all = await readAll();
        const secret = encrypt(t);
        if (!secret) {   // 本机加密不可用（safeStorage 未就绪）→ 不写明文，退回会话内存
          session.set(h, { username: u, token: t });
          return { ok: true, persistent: false, error: '本机加密存储不可用（已退回本次会话内存保管）' };
        }
        all[h] = { username: u, secret };
        await writeAll(all);
        session.set(h, { username: u, token: t });   // 同会话内直接用，免二次解密
        return { ok: true, persistent: true };
      } catch (err) {
        session.set(h, { username: u, token: t });
        return { ok: true, persistent: false, error: `凭据文件写入失败（已退回本次会话内存保管）：${err.message}` };
      }
    },

    get,

    /** 是否已保存该域名的令牌（供 IPC 回给面板显示状态，不含令牌本身） */
    async has(host = '') {
      return !!(await get(host));
    },

    /** 清除（换仓库/退出时用；面板提供「清除令牌」入口） */
    async clear(host = '') {
      const h = normHost(host);
      session.delete(h);
      if (!canPersist) return { ok: true };
      try {
        const all = await readAll();
        if (all[h]) { delete all[h]; await writeAll(all); }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

module.exports = { createCredentialStore, FILE_NAME };
