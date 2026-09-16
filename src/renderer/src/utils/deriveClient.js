/**
 * utils/deriveClient.js — 派生计算的 Worker 客户端（P2-4）
 *
 * 职责：单例 worker 生命周期 + 传输（零拷贝）+ 防抖合并 + 降级同步。
 *
 * 三条硬约束（都对应真实会踩的坑）：
 *  1. **原数组不可转移**：postMessage 的 transfer 会把主线程那份 Float32Array 置空。
 *     所以传出去的一定是副本（new Float32Array(h)），主线程数据始终可用。
 *  2. **必须能降级**：worker 构造失败（CSP / file:// 下的模块 worker / 被打包裁剪）时
 *     必须静默回退到同步计算，绝不能把派生搞丢（丢了 = 温度/群系整层不动）。
 *  3. **必须能终止**：页面卸载时 terminate，避免 Electron 关窗后 worker 残留。
 *
 * 阈值设计：小网格（默认 ≤ 8000 格）走同步。理由：派生是 O(n) 的轻计算，
 * 8000 格约 1ms，而一次 postMessage 往返 + 结构化克隆的开销与之同量级 ——
 * 小网格过一次 worker 反而更慢。真正受益的是大网格的**连续笔刷**（防抖合并成一次）。
 */
import DeriveWorker from '../workers/deriveWorker.js?worker';
import { deriveLayers } from './heightMath';

const DEFAULT_THRESHOLD = 8000;
const DEFAULT_DEBOUNCE = 300;

let worker = null;
let workerBroken = false;   // 构造失败 / onerror 后置位，不再重试
let seq = 0;
const pending = new Map();  // id -> { resolve, t0 }

let debounceTimer = null;
let debounceResolvers = [];
let debouncePayload = null;

let asyncThreshold = DEFAULT_THRESHOLD;
const stats = {
  workerCalls: 0,
  coalesced: 0,      // 被防抖合并掉的请求数
  syncCalls: 0,
  errors: 0,
  lastMs: 0,
  lastTransport: 'none',
};

// ── 生命周期 ─────────────────────────────────────────────
function failAllPending(reason) {
  for (const [, p] of pending) p.resolve(null);
  pending.clear();
  stats.errors++;
  if (typeof console !== 'undefined') console.warn('[deriveClient] worker 失效，降级同步：', reason);
}

function ensureWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new DeriveWorker();
    worker.onmessage = (e) => {
      const data = e.data || {};
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      stats.lastMs = data.ms || 0;
      p.resolve(data.type === 'derived' ? data : null);
    };
    worker.onerror = (err) => {
      workerBroken = true;
      failAllPending(err && err.message ? err.message : 'worker onerror');
      try { worker.terminate(); } catch (_) { /* 已终止 */ }
      worker = null;
    };
  } catch (e) {
    workerBroken = true;
    worker = null;
    if (typeof console !== 'undefined') console.warn('[deriveClient] 无法创建 worker，降级同步：', e);
  }
  return worker;
}

/** 关闭 worker（应用退出 / 测试收尾）。之后再次调用会自动重建。 */
export function terminateDeriveWorker() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    debounceResolvers.forEach(r => r(null));
    debounceResolvers = [];
    debouncePayload = null;
  }
  if (worker) {
    // 关键：在途请求必须**先解成 null** 再清表 —— 否则那些 Promise 永远不 settle，
    // 调用方 await 会一直挂着（test_39-d 抓到的挂死）。null 会由 deriveInWorker 的
    // 收尾逻辑转成同步补算结果，所以衍生值不会丢。
    failAllPending('worker terminated');
    try { worker.terminate(); } catch (_) { /* 已终止 */ }
  }
  worker = null;
  workerBroken = false;
}

if (typeof window !== 'undefined') {
  // Electron 关窗 / 页面刷新：终止 worker，避免残留线程
  window.addEventListener('beforeunload', () => { try { terminateDeriveWorker(); } catch (_) { /* noop */ } });
}

// ── 参数 / 诊断 ───────────────────────────────────────────
export function setAsyncThreshold(n) {
  const v = Number(n);
  asyncThreshold = Number.isFinite(v) && v >= 0 ? v : DEFAULT_THRESHOLD;
  return asyncThreshold;
}
export function getAsyncThreshold() { return asyncThreshold; }
export function isWorkerAvailable() { return !!worker && !workerBroken; }
export function getDeriveStats() {
  return { ...stats, threshold: asyncThreshold, available: isWorkerAvailable(), broken: workerBroken };
}
export function resetDeriveStats() {
  stats.workerCalls = 0; stats.coalesced = 0; stats.syncCalls = 0;
  stats.errors = 0; stats.lastMs = 0; stats.lastTransport = 'none';
}

// ── 计算 ─────────────────────────────────────────────────
/** 同步派生（唯一真值来源；也是 worker 失效时的兜底） */
export function deriveAllLayersSync(h, opts = {}) {
  stats.syncCalls++;
  stats.lastTransport = 'sync';
  const n = h ? h.length : 0;
  const placeholder = (opts.lat || opts.ocean) ? { length: n } : null;
  const latitudeFn = opts.lat ? (_pt, i) => opts.lat[i] : null;
  const oceanDistFn = opts.ocean ? (_pt, i) => opts.ocean[i] : null;
  return deriveLayers(h, placeholder, latitudeFn, oceanDistFn);
}

/**
 * 在 worker 中派生（Promise）。worker 不可用 → 同步结果（transport='sync'）。
 * h 会被复制后转移，调用方的数组不受影响。
 */
export function deriveInWorker(h, opts = {}) {
  const n = h ? h.length : 0;
  if (!n) return Promise.resolve(null);
  const w = ensureWorker();
  if (!w) {
    return Promise.resolve({ ...deriveAllLayersSync(h, opts), transport: 'sync' });
  }
  const id = ++seq;
  stats.workerCalls++;
  stats.lastTransport = 'worker';
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    const copy = new Float32Array(h);           // 副本：原数组必须留给主线程
    const transfer = [copy.buffer];
    const payload = { id, h: copy };
    if (opts.lat) { const l = new Float32Array(opts.lat); payload.lat = l; transfer.push(l.buffer); }
    if (opts.ocean) { const o = new Float32Array(opts.ocean); payload.ocean = o; transfer.push(o.buffer); }
    try {
      w.postMessage(payload, transfer);
    } catch (e) {
      pending.delete(id);
      stats.errors++;
      resolve({ ...deriveAllLayersSync(h, opts), transport: 'sync' });
    }
  }).then((res) => {
    // worker 侧报错 / onerror 把 pending 解成 null → 就地同步补算。
    // 绝不允许把派生"算丢"：丢了的表现是温度/群系整层停在旧值，且毫无提示。
    if (!res) return { ...deriveAllLayersSync(h, opts), transport: 'sync' };
    return { ...res, transport: res.transport || 'worker' };
  });
}

/**
 * 统一入口：小网格 / worker 不可用 → 同步；否则走 worker。
 * @returns {Promise<{temperature, precipitation, biome, transport, ms?}|null>}
 */
export function deriveAllLayersAsync(h, opts = {}) {
  const n = h ? h.length : 0;
  if (n && n <= asyncThreshold) {
    return Promise.resolve({ ...deriveAllLayersSync(h, opts), transport: 'sync' });
  }
  return deriveInWorker(h, opts);
}

/**
 * 防抖派生（连续笔刷只算最后一次）。
 * @param {Float32Array} h 高度图（内部会复制）
 * @param {(res:object|null)=>void} onDone 结果回调
 */
export function scheduleDerive(h, onDone, opts = {}) {
  const debounce = opts.debounce ?? DEFAULT_DEBOUNCE;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    stats.coalesced++;
    debounceResolvers.push(onDone);
  } else {
    debounceResolvers.push(onDone);
  }
  debouncePayload = h;
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    const payload = debouncePayload;
    const callbacks = debounceResolvers;
    debouncePayload = null;
    debounceResolvers = [];
    const res = payload ? await deriveAllLayersAsync(payload, opts) : null;
    for (const cb of callbacks) {
      try { cb(res); } catch (e) { if (typeof console !== 'undefined') console.warn('[deriveClient] 回调异常', e); }
    }
  }, debounce);
  return debounceTimer;
}
