/**
 * interior/furnitureSizes.js —— 家具的**真实平面尺寸**（2026-11-16，台账 A18）
 *
 * ## 为什么单独一份
 *
 * 这份表原来藏在 `InteriorView.vue` 的 `getDefaultSize()` 里。问题是：**只有 UI 能用**。
 * 于是旧项目（2026-11-13 之前画的）里家具还是"整数凑的方块"（一张床 100×80，比单人床还小），
 * 而没有任何脚本能按同一份口径把它们改回来 —— A18 那条"重排命令"就一直空着。
 *
 * 现在表搬到模块里：
 *   · UI（`InteriorView`）放新家具时用它 → 与命令**同一份口径**，不会一边改了另一边不动；
 *   · 命令（`scripts/rearrange-furniture-sizes.mjs`）用它把旧数据重排 → 带 dry-run / 备份 / 回读校验。
 *
 * ## 三种尺寸分开看
 *
 * | kind | 例子 | 会不会被命令重排 |
 * |---|---|---|
 * | `furniture` | 床 / 桌 / 椅 / 柜 / 衣柜 / 沙发 / 装饰 / 通用 | ✅ 会 |
 * | `opening` | 门 / 窗 | ❌ 不会（它们的尺寸是**洞口**尺寸，由墙上的位置决定） |
 * | `area` | 院落 / 园林 / 走廊 / 水池 / 围墙 | ❌ 不会（用户自己圈的地面区域，多大都是有意的） |
 *
 * ## 纪律
 * 纯函数：不 import three / 不碰 DOM / 不用随机数；`planFurnitureResize` 只读入参，
 * `applyFurnitureResize` 返回**新对象**（调用方决定写不写盘）。
 */

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * 每个类型的**平面真实尺寸**（cm）。高度不在这里 —— 高度是类型的属性，见 `furnitureBoxes.FURNITURE_HEIGHTS`。
 *
 * 数值口径：常见成人家具的外廓尺寸。床是 1.5m 双人床、桌是 1.4m 餐桌/书桌、
 * 柜 1.2m 双门柜、衣柜 1.2m（再宽就是整体衣柜，另算）、沙发 2m 三人位、装饰 40cm 摆件。
 */
export const FURNITURE_SIZES = Object.freeze({
  generic: Object.freeze({ w: 80, h: 60, kind: 'furniture' }),
  table: Object.freeze({ w: 140, h: 80, kind: 'furniture' }),
  chair: Object.freeze({ w: 45, h: 45, kind: 'furniture' }),
  bed: Object.freeze({ w: 200, h: 150, kind: 'furniture' }),
  chest: Object.freeze({ w: 120, h: 60, kind: 'furniture' }),
  wardrobe: Object.freeze({ w: 120, h: 60, kind: 'furniture' }),
  sofa: Object.freeze({ w: 200, h: 90, kind: 'furniture' }),
  decoration: Object.freeze({ w: 40, h: 40, kind: 'furniture' }),
  // 洞口：尺寸由墙上的位置与洞口本身决定，命令不碰
  door: Object.freeze({ w: 90, h: 20, kind: 'opening' }),
  window: Object.freeze({ w: 120, h: 20, kind: 'opening' }),
  // 地面区域：用户自己圈的，多大都有意为之
  courtyard: Object.freeze({ w: 600, h: 600, kind: 'area' }),
  garden: Object.freeze({ w: 800, h: 600, kind: 'area' }),
  corridor: Object.freeze({ w: 200, h: 80, kind: 'area' }),
  pond: Object.freeze({ w: 300, h: 200, kind: 'area' }),
  wall: Object.freeze({ w: 600, h: 24, kind: 'area' }),
});

/** 认不出的类型按“通用”尺寸 */
export const DEFAULT_FURNITURE_SIZE = FURNITURE_SIZES.generic;

/**
 * 某类家具的平面尺寸。
 * @param {string} type
 * @returns {{w:number, h:number, kind:'furniture'|'opening'|'area'}}
 */
export function furnitureSize(type) {
  const t = String(type || 'generic');
  return FURNITURE_SIZES[t] || { ...DEFAULT_FURNITURE_SIZE, kind: 'furniture' };
}

/**
 * 这件东西该不该被"重排到真实尺寸"。
 * 只动 furniture；洞口与地面区域一律不动（见文件头那张表）。
 */
export function isResizableFurniture(item) {
  if (!item || typeof item !== 'object') return false;
  return furnitureSize(item.type).kind === 'furniture';
}

/**
 * 扫一遍项目，算出"要改成什么"（**不写任何东西**）。
 *
 * 口径：
 *   · 只动 `kind === 'furniture'` 的类型；
 *   · 尺寸已经在容差内 → 不动（默认 2cm 或 3%，取大者）——命令可以反复跑，第二遍应当 0 改动；
 *   · 改尺寸时**保持中心点**：`x/y` 是左上角，宽高变了要把左上角挪回去，否则家具会整体跑偏；
 *   · 缺 width/height（0 或非法）→ 记进 "坏尺寸"，**不猜**，交给人看。
 *
 * @param {object} project `.sitian` 解析出来的对象（只读）
 * @param {object} [opts] { toleranceCm, toleranceRatio }
 * @returns {{
 *   changes: Array<object>, skipped: Array<object>,
 *   stats: { buildings:number, floors:number, furniture:number, changed:number,
 *            alreadyOk:number, skipped:number, byType:object }
 * }}
 */
export function planFurnitureResize(project, opts = {}) {
  const tolCm = Math.max(0, num(opts.toleranceCm, 2));
  const tolRatio = Math.max(0, num(opts.toleranceRatio, 0.03));
  const interiorData = project && project.interiorData && typeof project.interiorData === 'object'
    ? project.interiorData
    : {};

  const changes = [];
  const skipped = [];
  const byType = {};
  let floors = 0;
  let furniture = 0;
  let alreadyOk = 0;

  for (const buildingId of Object.keys(interiorData)) {
    const data = interiorData[buildingId];
    const list = data && Array.isArray(data.floors) ? data.floors : [];
    for (const floor of list) {
      if (!floor || !Array.isArray(floor.furniture)) continue;
      floors += 1;
      for (const item of floor.furniture) {
        if (!item || typeof item !== 'object') continue;
        furniture += 1;
        const type = String(item.type || 'generic');
        const target = furnitureSize(type);
        if (target.kind !== 'furniture') {
          skipped.push({ buildingId, floorId: floor.id, id: item.id, type, reason: target.kind });
          continue;
        }
        const w = num(item.width);
        const h = num(item.height);
        if (!(w > 0) || !(h > 0)) {
          skipped.push({ buildingId, floorId: floor.id, id: item.id, type, reason: 'bad-size' });
          continue;
        }
        const tolW = Math.max(tolCm, target.w * tolRatio);
        const tolH = Math.max(tolCm, target.h * tolRatio);
        if (Math.abs(w - target.w) <= tolW && Math.abs(h - target.h) <= tolH) {
          alreadyOk += 1;
          continue;
        }
        const x = num(item.x);
        const y = num(item.y);
        changes.push({
          buildingId,
          floorId: floor.id,
          id: item.id,
          type,
          name: String(item.name || ''),
          from: { x: round1(x), y: round1(y), w: round1(w), h: round1(h) },
          // 左上角按中心不动挪回去
          to: {
            x: round1(x + (w - target.w) / 2),
            y: round1(y + (h - target.h) / 2),
            w: target.w,
            h: target.h,
          },
        });
        byType[type] = (byType[type] || 0) + 1;
      }
    }
  }

  return {
    changes,
    skipped,
    stats: {
      buildings: Object.keys(interiorData).length,
      floors,
      furniture,
      changed: changes.length,
      alreadyOk,
      skipped: skipped.length,
      byType,
    },
  };
}

/**
 * 把 plan 落到一份**新的**项目对象上（不改入参）。
 * @param {object} project
 * @param {Array} changes `planFurnitureResize` 的 changes
 * @returns {object} 新项目
 */
export function applyFurnitureResize(project, changes) {
  const list = Array.isArray(changes) ? changes : [];
  if (!list.length) return project;
  const byId = new Map();
  for (const c of list) byId.set(`${c.buildingId}|${c.floorId}|${c.id}`, c);

  const src = project || {};
  const interiorData = {};
  for (const buildingId of Object.keys(src.interiorData || {})) {
    const data = src.interiorData[buildingId];
    const floorsSrc = data && Array.isArray(data.floors) ? data.floors : null;
    if (!floorsSrc) { interiorData[buildingId] = data; continue; }
    interiorData[buildingId] = {
      ...data,
      floors: floorsSrc.map((floor) => {
        if (!floor || !Array.isArray(floor.furniture)) return floor;
        return {
          ...floor,
          furniture: floor.furniture.map((item) => {
            if (!item) return item;
            const hit = byId.get(`${buildingId}|${floor.id}|${item.id}`);
            if (!hit) return item;
            return {
              ...item,
              x: hit.to.x,
              y: hit.to.y,
              width: hit.to.w,
              height: hit.to.h,
            };
          }),
        };
      }),
    };
  }
  return { ...src, interiorData };
}
