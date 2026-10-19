/**
 * scenarioThumb.js —— 剧本卡片缩略图的离屏烘焙（方案 B：Canvas 烘焙位图）。
 *
 * 视觉决策（2026-10-17 暮雨拍板，依据 docs/assets/scenario-picker-mockup.png）：
 * 地形分层设色打底 + 势力色半透明叠加 + 河流/海岸线 —— 信息密度对齐 EU4 剧本封面。
 * 方案 A（SVG 矢量）被否：色块观感割裂。
 *
 * 🔴 三条实现口径：
 * ① **地形层按底图共享**：同一底图的 N 个剧本只有势力叠加层不同 → 地形栅格只烘一次
 *    （`createThumbBaker` 内按 baseMapKey 缓存 buildHeightmapRaster 的产物）。
 *    这是"1×地形 + N×叠加"的性能对策，暮雨要求"如果能优化性能的话"。
 * ② **归属查询走 currentOwnerRef**（scenarioTimeline 唯一实现）——开局年早于第一条易主日时
 *    真实主是上一代的势力，跨代 polity id 不通用，自己写口径颜色会全查成灰。
 * ③ **本模块带 DOM 依赖**（document.createElement('canvas')）→ 走 CDP 用例，不进 Node 单测
 *    （同 regionTrace.js 的既有归类）。
 * ④ **成品位图按内容签名缓存**（P0-2）：`createThumbBaker()` 是**每个组件实例**一份，
 *    所以「进卡片墙 → 改剧本 → 回卡片墙」这条路上路径缓存必然重建 —— 位图缓存放在**模块级**，
 *    跨实例存活（详见下方 CACHE 段注释）。
 */
import { buildHeightmapRaster } from './heightmapRaster.js';
import { provinceRings } from './provinceShape.js';
import { currentOwnerRef, polityOf } from './scenarioTimeline.js';
import { openingSituation } from './scenarioCards.js';

const THUMB_W = 680, THUMB_H = 400;          // 卡片缩略图尺寸（烘焙分辨率；CSS 里等比缩到卡宽）
const SEA_COLOR = '#132b40';
const LAND_FALLBACK = '#2e4a33';             // 无高度图时的陆地底色
const RIVER_COLOR = '#5d97bb';               // 与画布自带河同色（BASEMAP_RIVER_COLOR 口径）
const BORDER_STROKE = 'rgba(12,16,22,0.55)';

/* ══════════ 烘成品位图缓存（P0-2，2026-10-17 第三轮）══════════
 * 上一轮只做了 **Path2D 按底图缓存**（同一次进入的 N 张卡共用路径），但「进卡片墙 → 进编辑器
 * → 再回卡片墙」时**整个 baker 实例重建**（`createThumbBaker()` 挂在组件 setup 上），
 * 于是每次回到卡片墙都要把 N 张卡重画一遍（415 省底图 = 每张付 fill/stroke 的原生开销）。
 * 现在把**烘好的位图**放进模块级缓存：第二次进卡片墙是纯 drawImage 拷位图（无路径/无栅格重建）。
 *
 * 🔴 失效口径 = **内容签名**，不是「底图 key」：签名是缩略图依赖的全部数据的**全量**哈希
 *    （省份点列 / 高度图 h / 河流点 / 剧本归属与势力色 / 起始年）。改一个顶点、涂一格高度、
 *    换一个势力颜色，签名就变 → 自动换新图。
 *    ⚠️ 不许改成"抽样哈希"或"只看长度"：那种失效的表现是**图看着对但其实是上一版**，
 *    是本项目最难被发现的一类（用户不会怀疑缩略图，只会觉得"这图怎么不对"）。
 * ⚠️ 缓存**只活在本进程内**（页面刷新即空）：不做落盘 —— 缩略图是纯展示派生物，
 *    写进项目文件会平白多一份可能与真相漂移的数据。
 */
const CACHE_MAX = 24;                        // ≤24 张位图（680×400×4B ≈ 1.1MB/张 → 上限 ≈26MB）
const bakedCache = new Map();                // `key#sig` -> HTMLCanvasElement
const cacheStats = { hits: 0, misses: 0 };

/** 供回归用例量「第二次进卡片墙到底有没有走缓存」（纯读数，不改行为） */
export function thumbCacheStats() {
  return { hits: cacheStats.hits, misses: cacheStats.misses, size: bakedCache.size };
}
/** 清空成品缓存（用例之间互相隔离用；产品路径不需要手动调） */
export function resetThumbCache() {
  bakedCache.clear();
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

/** FNV-1a 变体：把数值/字符串滚进 32 位散列 */
function hNum(h, n) {
  if (!Number.isFinite(n)) return (h ^ 0x9e3779b9) >>> 0;
  // 量化到 1/64 世界单位：浮点尾差（float32 往返那类）不该让整片缓存失效
  h ^= Math.round(n * 64) | 0;
  return Math.imul(h, 0x01000193) >>> 0;
}
function hStr(h, s) {
  const t = String(s ?? '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
function hRing(h, ring) {
  const pts = ring?.points || [];
  h = hNum(h, pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    h = hNum(h, p?.x ?? p?.[0]);
    h = hNum(h, p?.y ?? p?.[1]);
  }
  return h;
}

/**
 * 缩略图内容签名（全量口径 —— 见上方纪律）。
 * @returns {string} 16 进制签名（空数据也给合法值：空底图的缩略图同样该被缓存）
 */
function signatureOf(baseMap, heightmap, tl, k, scenario) {
  let h = 0x811c9dc5;
  for (const prov of baseMap?.terrain || []) {
    h = hStr(h, prov?.id);
    h = hStr(h, prov?.kind);
    for (const ring of provinceRings(prov)) h = hRing(h, ring);
  }
  const hm = heightmap || baseMap?.heightmap;
  if (hm?.h?.length) {
    h = hNum(h, hm.h.length);
    for (let i = 0; i < hm.h.length; i++) h = hNum(h, hm.h[i]);
    h = hNum(h, hm.grid?.spacing ?? 0);
  }
  for (const rv of baseMap?.rivers || []) {
    const pts = rv?.points || [];
    h = hNum(h, pts.length);
    for (let i = 0; i < pts.length; i++) {
      h = hNum(h, pts[i]?.x ?? pts[i]?.[0]);
      h = hNum(h, pts[i]?.y ?? pts[i]?.[1]);
    }
  }
  for (const sc of tl?.scenarios || []) {
    h = hStr(h, sc?.id);
    h = hNum(h, Number(sc?.era?.startYear));
    for (const p of sc?.polities || []) { h = hStr(h, p?.id); h = hStr(h, p?.color); }
    const own = sc?.ownership || {};
    for (const pid of Object.keys(own).sort()) { h = hStr(h, pid); h = hStr(h, own[pid]); }
    const ev = sc?.changeEvents || {};
    for (const pid of Object.keys(ev).sort()) {
      for (const e of ev[pid] || []) { h = hNum(h, Number(e?.y)); h = hStr(h, e?.owner); }
    }
  }
  h = hStr(h, scenario?.id);
  return (h >>> 0).toString(16);
}

/** 底图省份的合并包围盒（含高度图网格若存在）——所有剧本共用同一视野 */
function worldBoundsOf(baseMap) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const prov of baseMap?.terrain || []) {
    for (const ring of provinceRings(prov)) {
      for (const p of ring.points) eat(p.x ?? p[0], p.y ?? p[1]);
    }
  }
  const hm = baseMap?.heightmap;
  if (hm?.grid?.points?.length) {
    const s = hm.grid.spacing || 14.4;
    eat(minX, minY); // 已有值则并入网格角点
    const gp = hm.grid.points;
    eat(gp[0][0] - s, gp[0][1] - s);
    const last = gp[gp.length - 1];
    eat(last[0] + s, last[1] + s);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 100, h: 100 };
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  return { minX, minY, w, h };
}

/**
 * 创建缩略图烘焙器（每视图一个实例，缓存互不干扰——同 createRasterCache 的理由）。
 * 缓存失效：调用方在底图数据变化后 `invalidate(baseMapKey)`。
 */
export function createThumbBaker() {
  /** baseMapKey -> { raster, bounds, scale, ox, oy, provPaths, riverPaths } */
  const cache = new Map();

  function layerFor(key, baseMap, heightmap) {
    const hit = cache.get(key);
    if (hit) return hit;
    const bounds = worldBoundsOf(baseMap);
    const scale = Math.min(THUMB_W / bounds.w, THUMB_H / bounds.h) * 0.94;
    const ox = (THUMB_W - bounds.w * scale) / 2 - bounds.minX * scale;
    const oy = (THUMB_H - bounds.h * scale) / 2 - bounds.minY * scale;
    const X = (x) => x * scale + ox, Y = (y) => y * scale + oy;

    let raster = null;
    const hm = heightmap || baseMap?.heightmap;
    if (hm?.grid?.points?.length && hm.h?.length) {
      raster = buildHeightmapRaster(hm, 'landsea', { shade: 1 });
    }

    // 🔴 Path2D 只建一次（每张卡复用）——2026-10-17 暮雨实测「进入的时候有点卡」：
    //    真实底图 415 省 / 2.7 万点，旧实现**每张卡**从点列重建一遍路径（12 张卡 = 12 遍）。
    //    路径构建才是大头；Path2D 复用后第 2..N 张卡只付 fill/stroke 的原生开销。
    const provPaths = [];
    for (const prov of baseMap?.terrain || []) {
      const path = new Path2D();
      let n = 0;
      for (const ring of provinceRings(prov)) {
        const rp = ring.points;
        if (rp.length < 3) continue;
        path.moveTo(X(rp[0].x ?? rp[0][0]), Y(rp[0].y ?? rp[0][1]));
        for (let i = 1; i < rp.length; i++) {
          path.lineTo(X(rp[i].x ?? rp[i][0]), Y(rp[i].y ?? rp[i][1]));
        }
        path.closePath();
        n += rp.length;
      }
      if (n) provPaths.push({ sea: prov.kind === 'sea', id: prov.id, path });
    }
    const riverPaths = [];
    for (const rv of baseMap?.rivers || []) {
      const pts = rv?.points;
      if (!pts || pts.length < 2) continue;
      const p = new Path2D();
      p.moveTo(X(pts[0].x ?? pts[0][0]), Y(pts[0].y ?? pts[0][1]));
      for (let i = 1; i < pts.length; i++) p.lineTo(X(pts[i].x ?? pts[i][0]), Y(pts[i].y ?? pts[i][1]));
      riverPaths.push({ path: p, w: Math.max(0.7, Math.min(2.2, (rv.width || 1) * 0.9)) });
    }

    const entry = { raster, bounds, scale, ox, oy, provPaths, riverPaths };
    cache.set(key, entry);
    return entry;
  }

  /**
   * 真正画一张缩略图（无缓存路径）—— 就地绘制到给定 ctx。
   * @param {object} opts { baseMapKey, baseMap, heightmap, tl, k, scenario }
   */
  function renderInto(ctx, { baseMapKey, baseMap, heightmap, tl, k, scenario }) {
    ctx.fillStyle = SEA_COLOR;
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);

    const layer = layerFor(baseMapKey, baseMap, heightmap);
    const { raster, scale, ox, oy } = layer;

    // ① 地形层（共享缓存产物；无高度图则等省份多边形自己的底色）
    if (raster) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(raster.canvas,
        raster.minX * scale + ox, raster.minY * scale + oy,
        raster.w * scale, raster.h * scale);
    }

    // ② 省份：陆地兜底色 + 势力叠加（开局归属）+ 省界 —— 全部复用缓存 Path2D
    const startY = Number(scenario?.era?.startYear);
    const at = Number.isFinite(startY) ? { y: startY, m: null, d: null } : null;

    for (const item of layer.provPaths) {
      if (item.sea) {
        ctx.fillStyle = 'rgba(30,58,88,0.55)';
        ctx.fill(item.path, 'evenodd');
        continue;
      }
      if (!raster) { ctx.fillStyle = LAND_FALLBACK; ctx.fill(item.path, 'evenodd'); }
      // 势力叠加：底图色（或陆地色）× 0.42 + 势力色 × 0.58 —— 地形仍透得出（EU4 封面的层次）
      if (scenario && item.id) {
        const ref = at ? currentOwnerRef(tl, k, item.id, at) : { owner: scenario.ownership?.[item.id], era: k };
        const color = ref.owner ? (polityOf(tl.scenarios[ref.era], ref.owner)?.color || null) : null;
        if (color) {
          ctx.save();
          ctx.globalAlpha = 0.58;
          ctx.fillStyle = color;
          ctx.fill(item.path, 'evenodd');
          ctx.restore();
        }
      }
      // 省界（同色细描边抹亚像素缝 + 压暗分界）
      ctx.strokeStyle = BORDER_STROKE;
      ctx.lineWidth = 0.8;
      ctx.stroke(item.path);
    }

    // ③ 河流（自带河口径：单色细线；缩略图尺寸下不描岸线）
    ctx.strokeStyle = RIVER_COLOR;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const rv of layer.riverPaths) {
      ctx.lineWidth = rv.w;
      ctx.stroke(rv.path);
    }

    // ④ 角落压暗（卡片贴图在深色卡面上的融合感）
    const vg = ctx.createRadialGradient(THUMB_W/2, THUMB_H/2, THUMB_H*0.35, THUMB_W/2, THUMB_H/2, THUMB_H*0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  }

  /**
   * 烘一个剧本的缩略图到目标 canvas（就地绘制）。
   * @param {HTMLCanvasElement} canvas 目标（尺寸会被设为 THUMB_W×THUMB_H）
   * @param {object} opts { baseMapKey, baseMap, heightmap, tl, k }
   *   🔴 `heightmap` 由调用方经 `getHeightmapFor(key)` 解析后传入 ——
   *      绑定了行星的底图 `baseMap.heightmap` 是空的（高度图在行星侧），
   *      直接读 baseMap 会给绑定底图烘出一张纯色图（不报错，只是"看着像坏了"）。
   * @returns {{cached:boolean,key:string}} `cached=true` 表示命中成品位图缓存（**零绘制成本**，
   *   调用方据此跳过"让出一帧"—— 全命中时卡片墙应当**立刻**完整，不该再逐张等 16ms）
   */
  function bake(canvas, { baseMapKey, baseMap, heightmap, tl, k }) {
    canvas.width = THUMB_W; canvas.height = THUMB_H;
    const ctx = canvas.getContext('2d');
    const scenario = tl?.scenarios?.[k];
    const key = `${baseMapKey || ''}#${signatureOf(baseMap, heightmap, tl, k, scenario)}`;
    const hit = bakedCache.get(key);
    if (hit) {
      cacheStats.hits += 1;
      ctx.drawImage(hit, 0, 0);
      return { cached: true, key };
    }
    cacheStats.misses += 1;
    renderInto(ctx, { baseMapKey, baseMap, heightmap, tl, k, scenario });
    // 存成品位图：拷一份带走（目标 canvas 归组件，下次烘焙会就地覆盖）
    try {
      const off = document.createElement('canvas');
      off.width = THUMB_W; off.height = THUMB_H;
      off.getContext('2d').drawImage(canvas, 0, 0);
      bakedCache.set(key, off);
      while (bakedCache.size > CACHE_MAX) bakedCache.delete(bakedCache.keys().next().value);
    } catch (e) {
      // 缓存失败不该让这张图失败（画布已经在屏幕上了）
      console.warn('[scenarioThumb] 成品缓存写入失败', e);
    }
    return { cached: false, key };
  }

  return {
    bake,
    /** 清掉**路径/栅格**层缓存（底图数据变了的调用方用）；
     *  成品位图缓存不必清 —— 它的键是内容签名，改了就自然换新图。 */
    invalidate: (baseMapKey) => baseMapKey ? cache.delete(baseMapKey) : cache.clear(),
    THUMB_W, THUMB_H,
  };
}

/** 卡片上的开局态势条数据（薄转引：组件只 import 这一处即可拿到态势+缩略图） */
export { openingSituation };
