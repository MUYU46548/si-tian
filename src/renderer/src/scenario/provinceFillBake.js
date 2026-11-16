// scenario/provinceFillBake.js — **省色块整幅位图**（2026-11-16，规模刀 2）
//
// ── 为什么要有它（2 万省压测的结论，不是猜）────────────────────────────────
// 适屏档每帧要画 N 个省：`drawProvincesLayer` 每省一次 `fill` + 一次同色 `stroke`。
// 实测（`probe_scale_frames`，1080×634）：
//     3,000 省 暖帧 24ms ／ 10,000 省 292ms ／ 20,000 省 646ms
// 把每省的 save/restore 收掉只减了 JS 侧 CPU（-33%），**适屏档帧时间没动** ——
// 瓶颈是原生光栅化（1 万次 stroke 相加 ≈ 180ms/帧），跟代码怎么写没关系。
// 省数再往上（用户：“5000 起步，几万省完全可能”）唯一能走的路是**换画法**：
// 把“归属色 + 政治水洗”烘成一张位图，每帧只 `drawImage` 一次。EU4 自己就是这么画的
// （省图是位图 + 颜色查找，边界另叠矢量）。
//
// ── 口径（改这里之前必读）──────────────────────────────────────────────
// ① **只在“大图 + 适屏档”用**：省数 < `MIN_PROVINCES`（默认 2000）不烘；相机放大到
//    超过位图精度（`needPpu > ppu * 1.05`）也不烘 —— 那时逐省矢量更清楚，而且放大后
//    大部分省在裁剪区外，本来就不慢（1 万省放大档实测 28~69ms）。
// ② **失效键全部取自对象引用**：地形数组 / 当前剧本对象 / `ownership` 字典 / `polities` 数组 /
//    `timeline.scenarios` 数组 + 纪元号 + 日期 + 差异档 + 底图档 + 水洗值。
//    这些写口一律换新对象（`ownershipCommand` → `execute` 换剧本对象），所以“引用没变 =
//    内容没变”与 `reliefRasterSlot` / `hitIndex` 是同一条纪律。
// ③ **画法只能有一份**：本模块不自己画省份，它收一个 `paint(ctx, viewShim, terrain)` 回调
//    （= `provinces.js#paintProvinceBodies`），烘的时候把 `px()` 换成“烘焙分辨率下的像素”，
//    其余字段原样透传 —— 所以位图里那一遍与直接画那一遍是同一段代码。
// ④ **只长不缩**：手里的位图 ppu 够用就复用；缩小时用 `drawImage` 缩下来（更清晰，不会更糊）。
// ⑤ 演变过渡期间（`view.eraFade`）**不烘**：过渡色每帧都不一样，烘出来就是每帧重烘。
//
// 排障口：
//   `window.__SITIAN_PROV_BITMAP__`      = false 关 / true 强制开（默认 auto）
//   `window.__SITIAN_PROV_BITMAP_MIN__`  = 省数门槛（默认 2000，用例可设 0）
//   `window.__SITIAN_PROV_BITMAP_STAT__` = { bakes, lastMs, px, provinces }（只读）

const MIN_PROVINCES = 2000;
const MIN_W = 512;
const MAX_W = 2048;
const STEP = 128;          // 烘焙宽度按 128 一档（别为取整把像素量翻倍）

let slot = null;           // { key, ppu, canvas, minX, minY, w, h, provinces, ms }

/** 世界包围盒（按 terrain 数组引用缓存；写口换数组 → 自然失效） */
const rectCache = new WeakMap();
export function provinceWorldRect(terrain) {
  if (!Array.isArray(terrain) || !terrain.length) return null;
  const hit = rectCache.get(terrain);
  if (hit) return hit;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < terrain.length; i++) {
    const pts = terrain[i] && terrain[i].points;
    if (!pts) continue;
    for (let j = 0; j < pts.length; j++) {
      const x = pts[j] && pts[j].x, y = pts[j] && pts[j].y;
      if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
      if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const rect = { minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  rectCache.set(terrain, rect);
  return rect;
}

/** 对象引用 → 稳定 id（失效键用；不清空，弱引用不挡 GC） */
let seq = 0;
const ids = new WeakMap();
function refId(o) {
  if (!o || (typeof o !== 'object' && typeof o !== 'function')) return 0;
  let id = ids.get(o);
  if (!id) { id = ++seq; ids.set(o, id); }
  return id;
}

/** 省数门槛（用例可下调；产品默认 MIN_PROVINCES） */
function minProvinces() {
  if (typeof window === 'undefined' || !window) return MIN_PROVINCES;
  const v = Number(window.__SITIAN_PROV_BITMAP_MIN__);
  return Number.isFinite(v) && v >= 0 ? v : MIN_PROVINCES;
}

function mode() {
  if (typeof window === 'undefined' || !window) return null;
  const v = window.__SITIAN_PROV_BITMAP__;
  if (v === false) return 'off';
  if (v === true) return 'on';
  return null;
}

/** 当前是否允许走位图（纯判据，导出给用例） */
export function provinceBitmapEligible(view, terrain) {
  if (mode() === 'off') return false;
  if (!Array.isArray(terrain) || terrain.length < minProvinces()) return false;
  if (view && view.eraFade) return false;              // 过渡期每帧换色，烘了也白烘
  if (view && view.forExport) return false;            // 导出/切片：要的是矢量精度，不是帧率
  return true;
}

/**
 * 取（必要时烘）省色块位图。
 *
 * @param {object} view 层拿到的视图对象（只读；这里会派生一个 `px()` 换成烘焙分辨率的副本）
 * @param {Array} terrain 省份数组（= `view.rawTerrain()`）
 * @param {(c:CanvasRenderingContext2D, shim:object, terrain:Array)=>void} paint
 *        唯一的绘制实现（`paintProvinceBodies`）
 * @returns {{canvas:HTMLCanvasElement,minX:number,minY:number,w:number,h:number}|null}
 */
export function provinceFillBitmap(view, terrain, paint) {
  if (!provinceBitmapEligible(view, terrain)) return null;
  const rect = provinceWorldRect(terrain);
  if (!rect || typeof document === 'undefined') return null;
  const tl = (view && view.timeline) || {};
  const k = Number(view.eraIndex) || 0;
  const sc = tl.scenarios && tl.scenarios[k];
  const key = [
    view.baseMapKey || '', refId(terrain), refId(tl.scenarios), k,
    view.date == null ? '' : String(view.date),
    view.diffMode || '', view.rasterLayer || '', view.mode || '',
    view.politicalWash == null ? '' : String(view.politicalWash),
    view.showBiomes ? 'biomes' : '', refId(view.selectedScenario),   // 群系图层 / 时间轴不可用时的兜底取色
    refId(sc), refId(sc && sc.ownership), refId(sc && sc.polities),
  ].join('|');

  const scale = Number(view.cameraScale) || 1;
  const need = Math.max(MIN_W, Math.min(MAX_W, Math.ceil((rect.w * scale) / STEP) * STEP));
  const needPpu = need / rect.w;
  // ① 放大超过位图精度 → 不烘（逐省矢量更清楚，而且放大后大部分省在裁剪区外，本来就不慢）
  if (scale > needPpu * 1.05) return null;
  // ④ 只长不缩：键相同且手里这张够宽 → 直接复用
  if (slot && slot.key === key && slot.ppu >= needPpu * 0.995) return slot;

  const ppu = needPpu;
  const cw = Math.max(1, Math.round(rect.w * ppu));
  const ch = Math.max(1, Math.round(rect.h * ppu));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  ctx.setTransform(ppu, 0, 0, ppu, -rect.minX * ppu, -rect.minY * ppu);
  // ③ 绘制实现只有一份：把“屏幕像素 → 世界单位”的换算换成烘焙分辨率的
  const shim = Object.assign({}, view, { px: (n) => n / ppu, cameraScale: ppu });
  try {
    paint(ctx, shim, terrain);
  } catch (e) {
    slot = null;
    return null;
  }
  const ms = Math.round(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - t0) * 10) / 10;
  slot = { key, ppu, canvas, minX: rect.minX, minY: rect.minY, w: rect.w, h: rect.h, provinces: terrain.length, ms };
  if (typeof window !== 'undefined' && window) {
    const prev = window.__SITIAN_PROV_BITMAP_STAT__ || { bakes: 0 };
    window.__SITIAN_PROV_BITMAP_STAT__ = { bakes: prev.bakes + 1, lastMs: ms, px: [cw, ch], provinces: terrain.length };
  }
  return slot;
}

/** 排障/用例用：清空槽 */
export function resetProvinceFillBitmap() {
  slot = null;
  if (typeof window !== 'undefined' && window) window.__SITIAN_PROV_BITMAP_STAT__ = { bakes: 0 };
}

/** 只读读数（用例断言“真的没重烘”用） */
export function provinceFillBitmapInfo() {
  return slot
    ? { key: slot.key, ppu: slot.ppu, px: [slot.canvas.width, slot.canvas.height], provinces: slot.provinces, ms: slot.ms }
    : null;
}

/**
 * 把位图入口挂到 view 上（层的纪律：依赖一律从 view 取，层里不 import 渲染模块）。
 * 过渡态（`eraFade`）也一起带上：过渡期颜色每帧都变，位图不能烘（见口径 ⑤）。
 */
export function attachProvinceFillBitmap(view, eraFade, forExport) {
  view.eraFade = eraFade || null;
  // 导出/切片（`makeLayerView({ snapshot: true })`）**一律不用位图**：
  // 位图是按屏幕缩放烘的，贴到导出画布上会糊，而且导出必须逐像素确定（A2 同一条纪律）。
  view.forExport = !!forExport;
  view.provinceFillBitmap = (terrain, paint) => provinceFillBitmap(view, terrain, paint);
  return view;
}
