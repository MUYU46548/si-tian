/**
 * workers/deriveWorker.js — 温度 / 降水 / 生物群系派生（P2-4）
 *
 * 纯计算 worker：主线程 postMessage 高度图（Float32Array，**转移所有权**零拷贝传入），
 * worker 返回同长度的 temperature / precipitation / biome（同样零拷贝转回）。
 *
 * 计算逻辑直接复用 utils/heightMath.js 的 deriveLayers —— 唯一事实源，
 * 这里**不复制**任何公式（复制必然漂移；一致性由 test_39 的等价断言兜住）。
 *
 * 输入：{ type?, id, h: Float32Array, lat?: Float32Array, ocean?: Float32Array }
 * 输出：{ type:'derived', id, n, temperature, precipitation, biome, ms }
 *       { type:'pong', id }（连通性探测）
 *
 * 注意：h 转移后主线程那份数组会被 detach（length 变 0），调用方必须传副本 ——
 * 这件事由 utils/deriveClient.js 负责，worker 侧不做防御。
 */
import { deriveLayers } from '../utils/heightMath';

self.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === 'ping') {
    self.postMessage({ type: 'pong', id: msg.id });
    return;
  }

  const { id, h, lat, ocean } = msg;
  const t0 = performance.now();
  const n = h && typeof h.length === 'number' ? h.length : 0;
  if (!n) {
    self.postMessage({ type: 'error', id, error: 'empty-heightmap' });
    return;
  }

  // deriveLayers 的 latitudeFn/oceanDistFn 签名是 (gridPoints[i], i)：
  // 只给长度占位对象即可（两个回调都不使用第一个参数），避免为传数组再复制一份网格
  const placeholder = (lat || ocean) ? { length: n } : null;
  const latitudeFn = lat ? (_pt, i) => lat[i] : null;
  const oceanDistFn = ocean ? (_pt, i) => ocean[i] : null;

  const derived = deriveLayers(h, placeholder, latitudeFn, oceanDistFn);

  self.postMessage(
    {
      type: 'derived',
      id,
      n,
      temperature: derived.temperature,
      precipitation: derived.precipitation,
      biome: derived.biome,
      ms: performance.now() - t0,
    },
    [
      derived.temperature.buffer,
      derived.precipitation.buffer,
      derived.biome.buffer,
    ],
  );
};
