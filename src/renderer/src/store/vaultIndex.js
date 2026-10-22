// store/vaultIndex.js — 全库只读索引 / 实体候选（D1，2026-10-19）
//
// 边界（红线）：
//   · 只读：不写 Markdown、不碰画布、不 import geodata/projectStore；
//   · 所有磁盘 I/O 走主进程 `window.sitianAPI.vault*`（主进程做库根 containment）；
//   · 索引是“资料条目”层，**不是**地图节点层：候选必须人确认后才谈导入（D2）。
import { ref, computed } from 'vue';
import { defineStore } from 'pinia';

export const useVaultIndexStore = defineStore('vaultIndex', () => {
  const status = ref(null);          // { exists, builtAt, stats, sizeBytes }
  const candidates = ref([]);        // [{ path, title, layer, layerLabel, confidence, reasons }]
  const byLayer = ref({});
  const searchResults = ref([]);
  // 读料报告（2026-10-22，第二刀）：{ total, byCategory, byLayer, geo, needsHuman, inferred }
  const report = ref(null);
  const error = ref('');
  const busy = ref(false);

  const api = () => (typeof window !== 'undefined' ? window.sitianAPI : null) || {};

  const exists = computed(() => !!(status.value && status.value.exists));
  const total = computed(() => (status.value && status.value.stats && status.value.stats.total) || 0);
  const builtAt = computed(() => (status.value && status.value.builtAt) || '');

  function _fail(res) {
    error.value = (res && res.error) || '资料索引请求失败';
    return null;
  }

  async function refreshStatus() {
    const fn = api().vaultIndexStatus;
    if (!fn) { error.value = '当前环境没有主进程接口（资料索引不可用）'; return null; }
    try {
      const res = await fn();
      if (res && res.success !== false) {
        status.value = res;
        error.value = '';
        return res;
      }
      return _fail(res);
    } catch (e) {
      error.value = `读取索引状态失败：${(e && e.message) || e}`;
      return null;
    }
  }

  async function build(opts = {}) {
    const fn = api().vaultIndexBuild;
    if (!fn) { error.value = '当前环境没有主进程接口（资料索引不可用）'; return null; }
    busy.value = true;
    error.value = '';
    try {
      const res = await fn(opts);
      if (!res || res.success === false) return _fail(res);
      await refreshStatus();
      await loadCandidates();
      await loadReport();
      return res;
    } catch (e) {
      error.value = `建立索引失败：${(e && e.message) || e}`;
      return null;
    } finally {
      busy.value = false;
    }
  }

  async function loadCandidates(rules) {
    const fn = api().vaultEntityCandidates;
    if (!fn) return [];
    try {
      const res = await fn(rules || {});
      if (!res || res.success === false) { _fail(res); return []; }
      candidates.value = res.candidates || [];
      byLayer.value = res.byLayer || {};
      error.value = '';
      return candidates.value;
    } catch (e) {
      error.value = `读取候选实体失败：${(e && e.message) || e}`;
      return [];
    }
  }

  /** 读料报告（归类分布 + 待人工逐条原因 + 推断清单）；只读 */
  async function loadReport() {
    const fn = api().vaultClassifyReport;
    if (!fn) return null;
    try {
      const res = await fn();
      if (!res || res.success === false) { _fail(res); return null; }
      report.value = res.report || null;
      return report.value;
    } catch (e) {
      error.value = `读取读料报告失败：${(e && e.message) || e}`;
      return null;
    }
  }

  async function search(query, limit = 50) {
    const fn = api().vaultIndexSearch;
    if (!fn) return [];
    try {
      const res = await fn(query, limit);
      searchResults.value = (res && res.results) || [];
      if (res && res.success === false) _fail(res);
      return searchResults.value;
    } catch (e) {
      error.value = `搜索失败：${(e && e.message) || e}`;
      return [];
    }
  }

  async function readNote(relPath) {
    const fn = api().vaultNoteRead;
    if (!fn) return null;
    try {
      const res = await fn(relPath);
      if (!res || res.success === false) { _fail(res); return null; }
      return res.data || null;
    } catch (e) {
      error.value = `读取笔记失败：${(e && e.message) || e}`;
      return null;
    }
  }

  /** wikilink 目标 → 笔记路径（重名给候选） */
  async function resolveNote(name) {
    const fn = api().vaultNoteResolve;
    if (!fn || !name) return { path: null, candidates: [] };
    try {
      const res = await fn(name);
      if (!res || res.success === false) { _fail(res); return { path: null, candidates: [] }; }
      return { path: res.path || null, candidates: res.candidates || [] };
    } catch (e) {
      error.value = `解析链接失败：${(e && e.message) || e}`;
      return { path: null, candidates: [] };
    }
  }

  /** 正文全文搜索（D2）；与 `search` 的元数据搜索分开，避免误用 */
  async function searchDeep(query, limit = 50) {
    const fn = api().vaultNoteSearch;
    if (!fn) return [];
    try {
      const res = await fn(query, limit);
      if (!res || res.success === false) { _fail(res); return []; }
      searchResults.value = res.results || [];
      return searchResults.value;
    } catch (e) {
      error.value = `正文搜索失败：${(e && e.message) || e}`;
      return [];
    }
  }

  /** 附件 → dataUrl（阅读器 <img>） */
  async function readAsset(relPath, fromNote) {
    const fn = api().vaultAssetRead;
    if (!fn) return null;
    try {
      const res = await fn(relPath, fromNote);
      if (!res || res.success === false) return null;
      return res.data || null;
    } catch (e) {
      return null;
    }
  }

  /** 订阅主进程的索引变更（watcher → 防抖 → 增量重建）；返回取消订阅函数 */
  function bindIndexUpdates() {
    const fn = api().onVaultIndexUpdated;
    if (!fn) return () => {};
    try {
      return fn((summary) => {
        if (!summary || summary.error) return;
        refreshStatus().then(() => loadCandidates());
      }) || (() => {});
    } catch (e) {
      return () => {};
    }
  }

  function clearError() { error.value = ''; }

  return {
    status, candidates, byLayer, searchResults, report, error, busy,
    exists, total, builtAt,
    refreshStatus, build, loadCandidates, loadReport, search, readNote,
    resolveNote, searchDeep, readAsset, bindIndexUpdates, clearError,
  };
});
