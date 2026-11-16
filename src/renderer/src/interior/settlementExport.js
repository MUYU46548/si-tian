/**
 * interior/settlementExport.js —— 聚落鸟瞰的“出图”装配（2026-11-16）
 *
 * ## 为什么单独一层
 *
 * 出图要做四件事：采集（`settlement.collectSettlement`）→ 每栋长出几何（`buildShell` / 体块）
 * → 取景与图注（`axonometric` / `settlement`）→ 离屏渲一张 PNG（`axoScene`）。
 * 把它摆在组件里，组件就得自己 `import('three')` —— 而本仓有一条闸门：
 * **three 只许在登记过的组件里动态加载，并且要自带释放纪律**（`unit/test_system3d_scene.js` b2）。
 * 一次性出图既没有 rAF 循环、也不需要 visibilitychange，套不上组件那套纪律；
 * 所以把 three 的加载收在这一个模块里，组件只管“把区域数据递进来、把 PNG 拿回去”。
 *
 * ## 纪律（与 axoScene 一致）
 *   · three **动态 import**，只在真的点出图时加载（不进首屏）；
 *   · 渲完立刻 `dispose()` + `forceContextLoss()`（都在 axoScene 的 `renderSceneCanvas` 里）；
 *   · 本模块不碰 DOM 之外的东西，不写任何数据。
 */

import { buildBuildingShell } from './buildShell.js';
import { axoFrame, axoCanvas, AXO_PRESETS } from './axonometric.js';
import { axoSheetPlan } from './axoProps.js';
import { AXO_COLORS, renderSettlementSheet } from './axoScene.js';
import {
  collectSettlement, plainShell, settlementBounds, settlementCaptionModel,
  settlementScaleBar, scaleBarTicks, SETTLEMENT_DEFAULTS,
} from './settlement.js';

/**
 * 出一个聚落的鸟瞰 PNG（dataURL）。
 *
 * @param {object} input
 * @param {string} [input.name] 区域名（图注标题）
 * @param {Array} [input.places] 区域子节点
 * @param {Array} [input.routes] 区域道路
 * @param {object} [input.interiorData]
 * @param {object} [input.opts] 排障开关（只读）：{ roads:false, plain:false, caption:false }
 * @returns {Promise<{empty:true, reason:string} | {
 *   dataUrl:string, width:number, height:number, stats:object, buildings:number, roads:number }>}
 */
export async function renderSettlementPng(input = {}) {
  const over = input.opts || {};
  const name = String(input.name || '').trim() || '聚落';
  const settlement = collectSettlement({
    places: input.places,
    routes: input.routes,
    interiorData: input.interiorData,
  });

  // 每栋楼：有内部图就长真几何，没有就给一块体块（同构，渲染层不分支）
  const allItems = settlement.buildings.map((b) => ({
    building: b,
    offset: b.offset,
    shell: b.wired
      // 屋顶是封着的 → 房间地面/家具/吊顶一个都看不见，全部省掉（鸟瞰里几十栋，白建几何很亏）
      ? buildBuildingShell(b.floors, { roof: { kind: 'gable' }, furniture: false, rooms: false })
      : plainShell(b, { color: AXO_COLORS.plainWall }),
  }));
  // 取景按**整片聚落**算（数据有什么就框什么），画的时候才可能被排障开关筛掉。
  // 这样“关掉道路再出一张”的对照里画面不会跟着重排 —— 判据才分得清“差的是路”。
  const items = allItems.filter((it) => over.plain !== false || it.building.wired);
  const roads = over.roads === false ? [] : settlement.roads;

  const bounds = settlementBounds(
    allItems.map((it) => ({ bounds: it.shell.bounds, offset: it.offset })),
    settlement.roads,
    SETTLEMENT_DEFAULTS.pad,
  );
  if (!bounds) return { empty: true, reason: '这个区域里没有可画的东西（建筑都没有坐标？）' };

  // three 动态 import：整仓只有 System3DView / ExteriorView / 这里三处会拉它
  const THREE = await import('three');
  const canvasSize = axoCanvas('print');
  const preset = 'iso';
  const wantCaption = over.caption !== false;
  const plan = axoSheetPlan(canvasSize, { caption: wantCaption });
  const frame = axoFrame(bounds, {
    preset,
    aspect: plan.render.width / plan.render.height,
    // 聚落的内容本来就是散的：留白 5% 就够，8% 会让镇子在画面里缩一圈
    margin: 0.05,
    fit: 'silhouette',
  });
  // 比例尺按**取景宽度**算：正交下沿屏幕右轴 1cm 世界 = renderWidth / spanW 像素
  const bar = settlementScaleBar({ spanWCm: frame.spanW, renderWidthPx: plan.render.width });
  const caption = wantCaption ? settlementCaptionModel({
    name,
    stats: settlement.stats,
    extentCm: { w: bounds.size[0], h: bounds.size[2] },
    projection: (AXO_PRESETS[preset] || {}).short || '轴测',
    preset,
    scaleBar: { ...bar, ticks: scaleBarTicks(bar) },
    date: new Date().toISOString().slice(0, 10),
    version: (typeof window !== 'undefined' && window.sitianAPI && window.sitianAPI.version) || '',
  }) : null;

  // 排障口（只读摘要）：排查“建筑怎么这么小 / 地面怎么铺满了”时不用猜
  if (typeof window !== 'undefined') {
    window.__SITIAN_LAST_SETTLEMENT__ = {
      bounds: { min: bounds.min.map(Math.round), max: bounds.max.map(Math.round) },
      frame: {
        left: Math.round(frame.left), right: Math.round(frame.right),
        top: Math.round(frame.top), bottom: Math.round(frame.bottom),
      },
      buildings: items.length,
      roads: roads.length,
      caption: !!caption,
    };
  }

  const out = renderSettlementSheet(THREE, items, {
    frame,
    plan,
    caption,
    bounds,
    roads,
    canvas: plan.render,
    // 地面比纸深一档：不然整片场地和纸同色，看着像“几个盒子浮在纸上”
    ground: '#d9d0bb',
    groundScale: 1.35,
    groundPadCm: 300,
  });

  return {
    dataUrl: out.dataUrl,
    width: out.width,
    height: out.height,
    stats: settlement.stats,
    buildings: items.length,
    roads: roads.length,
  };
}
