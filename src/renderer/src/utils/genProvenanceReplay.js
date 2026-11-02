// utils/genProvenanceReplay.js — **账本的重放路径**（N3a-1）：拿一条记录重新跑一次生成，
// 用 digest 判「重跑出来的是不是同一张图」（2026-11-02）
//
// 为什么单开一个文件而不是塞进 `genProvenance.js`：
//   `genProvenance.js` 是**零依赖**的规范层（谁也 import 得起，用例直接 import 就跑）；
//   重放必须 import 生成器本体（`landmass.js` 及其依赖链）。放一起的话，任何只想记一条账
//   的地方都会被拖着加载整条几何管线。
//
// 可重放的前提（重要）：**生成器得是纯函数，且记录里带齐全部输入**。
//   `generateLandmass(params, bbox)` 满足纯函数（随机只来自 seed 派生的 rng，无 Date/Math.random），
//   但 `bbox` 是它的**独立入参** —— 所以记录里把 bbox 一起塞进 `params.bbox`
//   （见 store 的 `generate-landmass`）：不记图幅，重放只能"按默认图幅再画一块"，永远对不上。
//
// ⚠️ 目前**只有造陆**有重放：地形推演要轮廓多边形、文化/宗教要高度图网格 ——
//    那些是"生成输入"里的巨大数据，账本按纪律不收。它们的记录只用于**审计**
//    （谁在什么时候用什么参数生成过、结果有多大），不承诺凭一条记录重算出同一份结果。

import { generateLandmass } from './landmass';
import { normalizeLandParams } from './terrainParams';
import { recordDigest, verifyRecord, landmassSummary, isValidBBox } from './genProvenance';

/**
 * **重放一条造陆记录**：按 `rec.params`（含 `params.bbox`）再跑一次 `generateLandmass`，
 * 用 `landmassSummary` 重建摘要，然后与记录里的 digest 对拍。
 *
 * @param {object} rec 账本里的一条 `kind:'landmass'` 记录
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} [bbox]
 *        图幅（省略 = 用记录里的 `params.bbox`；两者都没有 → `bad-bbox`，**不静默兜底**：
 *        换个图幅重放出来的是另一块大陆，那时该说的是"对不上"，不是"通过"）
 * @returns {{ok:boolean, reason:string, digest?:string, summary?:object, detail?:string}}
 */
export function replayLandmassRecord(rec, bbox) {
  if (!rec || typeof rec !== 'object' || String(rec.kind) !== 'landmass') {
    return { ok: false, reason: 'not-landmass-record' };
  }
  const src = (rec.params && typeof rec.params === 'object') ? rec.params : {};
  const box = (bbox === undefined || bbox === null) ? src.bbox : bbox;
  if (!isValidBBox(box)) {
    return {
      ok: false, reason: 'bad-bbox',
      detail: '记录里没有可用的图幅（params.bbox）—— 造陆是"按图幅出图"的，没图幅就重放不出同一块大陆',
    };
  }
  // 参数再归一化一次（幂等）：手写的记录可能带脏值，重放必须走**同一个**映射口
  const params = { ...normalizeLandParams(src).params, bbox: { ...box } };
  let gen;
  try {
    gen = generateLandmass(params, box);
  } catch (err) {
    return { ok: false, reason: 'generate-failed', detail: String((err && err.message) || err) };
  }
  const summary = landmassSummary(gen);
  const digest = recordDigest({ kind: 'landmass', params, seed: params.seed, summary });
  const verdict = verifyRecord(rec, { kind: 'landmass', params, seed: params.seed, summary });
  return { ...verdict, digest, summary };
}
