// utils/vault.js — 知识库（Obsidian vault）名称解析
//
// obsidian://open?vault=<名称>&file=<相对路径> 里的 vault 参数是**库目录名**，
// 必须与当前配置的知识库一致，否则换库后所有正文/wikilink 跳转会落到错误的库。
// 历史上 NodeDetailPanel / AreaMap 硬编码 'ROSA'（批次 R2 修复）。
//
// 取值来源：主进程 getVaultPath()（userData/config.json 的 vaultPath）→ 取 basename。
// 不做长期缓存：用户可在设置面板换库，每次跳转前重新取一次（IPC，开销可忽略）。
import { ref } from 'vue';

/** 兜底库名：仅当无法从主进程取到路径时使用（保持历史行为，不静默失败） */
const FALLBACK_VAULT_NAME = 'ROSA';

/** 当前知识库目录名（响应式，供 UI 展示/调试） */
export const vaultName = ref('');

/** 从完整路径取末段目录名（兼容 Windows 反斜杠与 POSIX 斜杠） */
export function basenameOf(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 重新读取当前库名并写入 vaultName；返回库名（取不到则回退兜底值） */
export async function refreshVaultName() {
  try {
    const p = await window.sitianAPI?.getVaultPath?.();
    const name = basenameOf(p);
    if (name) vaultName.value = name;
  } catch (e) {
    // 取不到路径时保留已有值（可能来自上一次成功读取），不抛错
  }
  return vaultName.value || FALLBACK_VAULT_NAME;
}

/** 同步读取当前库名（可能未刷新过 → 回退兜底值） */
export function getVaultName() {
  return vaultName.value || FALLBACK_VAULT_NAME;
}

/** 构造 obsidian:// URI（不发送） */
export function buildObsidianUri(target) {
  return `obsidian://open?vault=${encodeURIComponent(getVaultName())}&file=${encodeURIComponent(target)}`;
}

/** 刷新库名后打开目标笔记（target = 库内相对路径或 wikilink 名） */
export async function openObsidianUri(target) {
  if (!target) return false;
  await refreshVaultName();
  const result = await window.sitianAPI?.openExternal?.(buildObsidianUri(target));
  return result ?? false;
}
