// utils/vault.js — 知识库（Obsidian vault）名称解析
//
// obsidian://open?vault=<名称>&file=<相对路径> 里的 vault 参数是**库目录名**，
// 必须与当前配置的知识库一致，否则换库后所有正文/wikilink 跳转会落到错误的库。
// 历史上 NodeDetailPanel / AreaMap 曾硬编码库名（批次 R2 修复）。
//
// 取值来源：主进程 getVaultPath()（userData/config.json 的 vaultPath）→ 取 basename。
// 不做长期缓存：用户可在设置面板换库，每次跳转前重新取一次（IPC，开销可忽略）。
//
// 兜底（2026-09-21）：只认「上一次成功解析到的库名」（内存 + localStorage），
// **不内置任何库名** —— 产品不该假定用户的库叫什么（库名随时可改，写死一个名字
// 会在换库后把跳转静默引向错误的库）。一次都没解析到时宁可不发 URI，也不乱跳。
import { ref } from 'vue';

/** localStorage 键：上次成功解析到的库名（跨会话可用） */
const VAULT_NAME_CACHE_KEY = 'sitian-vault-name';

function readCachedVaultName() {
  try {
    return localStorage.getItem(VAULT_NAME_CACHE_KEY) || '';
  } catch (e) {
    return '';
  }
}

function writeCachedVaultName(name) {
  try {
    if (name) localStorage.setItem(VAULT_NAME_CACHE_KEY, name);
  } catch (e) {
    // 隐私模式 / 存储被禁用：忽略，不影响本次跳转
  }
}

/** 当前知识库目录名（响应式，供 UI 展示/调试）；初值取自上次成功解析的缓存 */
export const vaultName = ref(readCachedVaultName());

/** 从完整路径取末段目录名（兼容 Windows 反斜杠与 POSIX 斜杠） */
export function basenameOf(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 重新读取当前库名并写入 vaultName；返回库名（取不到则返回已知值，可能为空串） */
export async function refreshVaultName() {
  try {
    const p = await window.sitianAPI?.getVaultPath?.();
    const name = basenameOf(p);
    if (name && name !== vaultName.value) {
      vaultName.value = name;
      writeCachedVaultName(name);
    }
  } catch (e) {
    // 取不到路径时保留已有值（可能来自上一次成功读取），不抛错
  }
  return vaultName.value || readCachedVaultName();
}

/** 同步读取当前库名（可能未刷新过 → 用上次成功解析的缓存；都没有则空串） */
export function getVaultName() {
  return vaultName.value || readCachedVaultName();
}

/** 构造 obsidian:// URI（不发送）；库名未知时返回空串，由调用方决定是否放弃 */
export function buildObsidianUri(target) {
  const name = getVaultName();
  if (!name || !target) return '';
  return `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(target)}`;
}

/** 刷新库名后打开目标笔记（target = 库内相对路径或 wikilink 名） */
export async function openObsidianUri(target) {
  if (!target) return false;
  await refreshVaultName();
  const uri = buildObsidianUri(target);
  if (!uri) {
    // 库名未知时宁可不动：绝不拿一个猜出来的库名去跳转
    console.warn('[SiTian] 未取到知识库名，已跳过 Obsidian 跳转（请先在设置中选择知识库）');
    return false;
  }
  const result = await window.sitianAPI?.openExternal?.(uri);
  return result ?? false;
}
