// scenario/layers/features.js — 剧本视图「地图要素」层（N1 刀 2，2026-10-30）
//
// 从 `ScenarioMap.vue` 搬出：道路/航路、手画河、城镇（含首都星标）。
// 这三块都是**世界坐标**里的普通要素层，和省份/文字/HUD 正交，但都有各自的"档位节流"
// （far→close 只出主干/首都），所以它们是刀 2 里最容易在观感上翻车的一块 —— 判据必须逐像素。
//
// 口径原样保留（一条都没改）：
//   · 道路：`utils/routeDensity.js` 分档渐显；海路按陆地掩膜切段 + 深色底衬（否则浅海面上等于没画）；
//   · 手画河：全部走 `drawOneHandRiver`（曲线 + 源头细→河口粗 + 岸线），不再自己 beginPath；
//   · 城镇：两趟绘制（普通在下、首都在上），far/mid 只留首都、near 只留人口 ≥20；
//     617 个城镇全画就是"一层白芝麻"（用户 B1 报障的技术成因）。
//
// `view` 字段：w,h,px,vx,vy,screenToWorld,baseMap,burgs,hoveredBurg,selectedBurg,BURG_SIZES,
//   polylineInView,labelDetail(),arterialLengthThreshold,shouldDrawRoute,getLandMask,
//   riverNodesForRender,drawOneHandRiver
//
// 河流两块（2026-10-31 加）：导入河 + 选中高亮。它们依赖 `utils/riverRender` 的纯函数
// （已在此直接 import），**只**把组件内的取数/缓存助手经 view 传入（getDisplayRivers /
// getMaxRiverWidth / riverWidthSeries / riverNodesForRender / riverSelIds），
// 计划缓存与 Path2D 缓存是**渲染独占**，随函数一起搬进本模块。

import {
  BASEMAP_RIVER_COLOR, basemapRiverWidthPx, basemapRiverWidthWorld,
  smoothRiverLine, planRiverCoveredRuns, catmullRomPoints,
  collapseReversedRiverPoints, offsetPolyline, offsetPolylineVariable, riverSelGapForWidth,
} from '../../utils/riverRender';

/** 导入河的绘制计划缓存（键 = 裁剪后列表引用 + 缩放 + 最宽河） */
let displayRiverPlanCache = { list: null, scale: 0, maxW: 0, smoothed: [], plans: [] };
/** 河道曲线 + 分块 Path2D 缓存：键 = 该河的 smoothed 数组（缩放变会换数组） */
const riverRunCache = new WeakMap();

/**
 * 一条河的可视段 → 若干块 Path2D（每块一个**宽度值**，2026-10-26 起逐点）。
 * `mid` 是**本 run 曲线**下标（subdiv=2，长度约 2 倍点数）—— 必须换算回整条河的点下标再取宽度，
 * 否则线宽被算粗（实测导入河像素 +12%）。
 */
function buildRiverRun(pts, s, e, widths) {
  const runPts = pts.slice(s, e);
  const curve = catmullRomPoints(runPts, 2);
  const n = curve.length;
  const count = Math.max(1, Math.min(16, n - 1));
  const out = [];
  for (let c = 0; c < count; c++) {
    const i0 = Math.floor((c * (n - 1)) / count);
    const i1 = Math.floor(((c + 1) * (n - 1)) / count);
    if (i1 <= i0) continue;
    const mid = Math.min(n - 1, Math.round((i0 + i1) / 2));
    const frac = n > 1 ? mid / (n - 1) : 1;
    const idx = s + frac * Math.max(0, e - s - 1);
    const path = new Path2D();
    path.moveTo(curve[i0].x, curve[i0].y);
    for (let i = i0 + 1; i <= i1; i++) path.lineTo(curve[i].x, curve[i].y);
    out.push({ path, idx });
  }
  return out;
}


/** 配色/样式对齐 Azgaar FMG 默认：道路棕色实线、小径棕色虚线、海路白色虚线 */
export const ROUTE_STYLES = {
  roads: { color: '#d06324', width: 0.9, dash: null, alpha: 0.95 },
  trails: { color: '#d06324', width: 0.5, dash: [2, 3], alpha: 0.85 },
  // 2026-10-27（用户「海路图还不如之前那个独立模块」）：0.5px + 1.5/3 的短虚线在浅色海面上
  // 几乎看不见，压在陆地上又像划痕。加宽到 0.9、虚线拉到 5/4，并加一层深色底衬。
  searoutes: { color: '#eaf4fb', width: 0.9, dash: [5, 4], alpha: 0.8 },
};

/** 道路 / 航路 */
export function drawRoutesLayer(c, view) {
  const list = view.baseMap && view.baseMap.routes;
  if (!list || !list.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(40);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  // 档位节流（C5）：496 条路/航路整图可见时会糊成一张网 —— 判据在 `utils/routeDensity.js`
  const detail = view.labelDetail();
  const arterialLen = view.arterialLengthThreshold(list, detail);

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const r of list) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    if (!view.shouldDrawRoute(r, detail, arterialLen)) continue;
    if (!view.polylineInView(pts, minX, minY, maxX, maxY)) continue;
    // 优先使用道路自带样式（P1-T3），回退到 group 默认
    const st = r.color
      ? { color: r.color, width: r.width || 1, dash: r.dash || null, alpha: 0.95 }
      : ROUTE_STYLES[r.group] || ROUTE_STYLES.roads;
    const isSea = r.group === 'searoutes';
    // 海路**只画在海面**：FMG 的 sea route 会横穿陆地（白色虚线切过省界），按陆地掩膜切段
    let runs = [pts];
    if (isSea) {
      const mask = view.getLandMask();
      if (mask) {
        runs = [];
        let cur = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          const mx = (pts[i - 1].x + pts[i].x) / 2;
          const my = (pts[i - 1].y + pts[i].y) / 2;
          if (mask.lookup(mx, my)) {
            if (cur.length >= 2) runs.push(cur);
            cur = [pts[i]];
          } else {
            cur.push(pts[i]);
          }
        }
        if (cur.length >= 2) runs.push(cur);
      }
    }
    for (const run of runs) {
      c.globalAlpha = st.alpha;
      c.strokeStyle = st.color;
      c.lineWidth = st.width;
      c.setLineDash(st.dash || []);
      c.beginPath();
      c.moveTo(view.vx(run[0]), view.vy(run[0]));
      for (let i = 1; i < run.length; i++) c.lineTo(view.vx(run[i]), view.vy(run[i]));
      // 海路：先画一层深色底衬，再画浅色虚线（否则浅海面上等于没画）
      if (isSea) {
        c.save();
        c.globalAlpha = 0.38;
        c.setLineDash([]);
        c.strokeStyle = 'rgba(16, 44, 64, 1)';
        c.lineWidth = st.width + 1.7;
        c.stroke();
        c.restore();
        c.globalAlpha = st.alpha;
        c.strokeStyle = st.color;
        c.lineWidth = st.width;
        c.setLineDash(st.dash || []);
      }
      c.stroke();
    }
  }
  c.setLineDash([]);
  c.restore();
}

/** 手画河（id 前缀 `river_`；导入河由 drawRivers 负责 —— 两边都画会把同一份数据画两遍） */
export function drawRiverPathsLayer(c, view) {
  const list = ((view.baseMap && view.baseMap.rivers) || [])
    .filter((r) => r && String(r.id || '').indexOf('river_') === 0);
  if (!list.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(40);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const r of list) {
    const path = view.riverNodesForRender(r);
    if (path.length < 2) continue;
    if (!view.polylineInView(path, minX, minY, maxX, maxY)) continue;
    view.drawOneHandRiver(c, path, r);
  }
  c.restore();
}

/** 浮雕图标（山/火山等；矢量名走 Path2D，历史 emoji 由 drawIconOrEmoji 内部 fillText 兜住） */
export function drawReliefIconsLayer(c, view) {
  const icons = view.reliefIcons;
  if (!icons || !icons.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(30);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const fontSize = Math.max(12, view.px(16));
  c.font = `${fontSize}px "PingFang SC", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const r of icons) {
    if (r.x < minX || r.x > maxX || r.y < minY || r.y > maxY) continue;
    view.drawIconOrEmoji(c, r.icon, r.x, r.y, Math.max(14, view.px(18)), r.color || '#FFFFFF');
  }
  c.textAlign = 'start';
  c.textBaseline = 'alphabetic';
}

/** 剧本标记（图标 + 名称；选中时金色虚线圈 —— 面板在右侧、圈在图上，用户能确认"改的就是这一个"） */
export function drawScenarioMarkersLayer(c, view) {
  const markers = view.selectedScenario && view.selectedScenario.markers;
  if (view.mode !== 'scenario' || !markers || !markers.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(30);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const fontSize = Math.max(12, view.px(14));
  c.font = `${fontSize}px "PingFang SC", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const m of markers) {
    if (m.x < minX || m.x > maxX || m.y < minY || m.y > maxY) continue;
    if (view.selectedMarker && m === view.selectedMarker) {
      const r = Math.max(12, view.px(16)) * 0.95;
      c.beginPath();
      c.arc(m.x, m.y, r, 0, Math.PI * 2);
      c.strokeStyle = '#fbbf24';
      c.lineWidth = view.px(1.6);
      if (c.setLineDash) c.setLineDash([view.px(3), view.px(3)]);
      c.stroke();
      if (c.setLineDash) c.setLineDash([]);
    }
    // 图标/颜色缺省时按「标记类型」补 —— 导入的数据往往只带 type
    const typeDef = view.MARKER_TYPES.find(t => t.id === m.type);
    view.drawIconOrEmoji(c, m.icon || (typeDef && typeDef.icon) || 'map-pin', m.x, m.y,
      Math.max(12, view.px(16)), m.color || (typeDef && typeDef.color) || '#FFFFFF');
    // 名称标签：与导出共用一份样式 + 默认深色描边
    const nameStyle = view.markerLabelTextStyle(m);
    view.drawStyledLabel(c, m.name || '', m.x, m.y + fontSize * 0.8, nameStyle, {
      align: 'center', baseline: 'middle', screenScale: view.cameraScale,
    });
  }
  c.textAlign = 'start';
  c.textBaseline = 'alphabetic';
}

/** 河流（导入河）：先裁到海岸线，再按覆盖段去重、逐块 Path2D 描边；末尾画河名 */
export function drawRiversLayer(c, view) {
  // D（2026-10-11）：**只画导入的**（FMG 参考图层）。手画的（id 前缀 `river_`）由
  // `drawRiverPathsLayer` 负责 —— 两边都画会把同一份数据画两遍（线宽叠加、观感更粗）。
  //
  // 🔴 2026-10-14：导入的河要**先裁到海岸线**（`view.getDisplayRivers()`，按引用缓存）。
  //    省份轮廓是按**后来的**新海岸线重建的，而这些河还是那次导入留下的 →
  //    真实底图实测 142/160 条河的末端落在省份多边形之外。
  const list = view.getDisplayRivers();
  if (!list.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(40);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  // 本幅图最宽的河（宽度归一化的参照）—— 按 rivers 引用缓存
  const maxRiverWidth = view.getMaxRiverWidth();
  // ── 同一段河道只画一遍（2026-10-21 第二十一修）────────────────────────────
  // 真实 FMG 数据里支流的路径会沿干流再走一遍，两张 `rivers[]` 共享一段河身；
  // 两条都画 = 粗河旁贴一条细线，放大后从某个节点分叉成双线。
  // 这里按「宽的先画、窄的跳过被盖住的连续段」生成绘制计划；纯函数在 riverRender.js。
  // 缓存键 = 裁剪后的列表引用 + 缩放（`dist` 按屏幕像素换算，缩放变了才需要重算）。
  if (displayRiverPlanCache.list !== list || displayRiverPlanCache.scale !== view.cameraScale
      || displayRiverPlanCache.maxW !== maxRiverWidth) {
    const smoothed = list.map((r) => smoothRiverLine((r && r.points) || [], 4));
    const plans = planRiverCoveredRuns(
      list.map((r, i) => ({ points: smoothed[i], widthPx: basemapRiverWidthPx(r, maxRiverWidth) })),
      // 去重距离 = **世界单位**（至少 4，1× 时 6）：同一段河道的两条路径在数据里相差
      // 0.6~5.3 世界单位；这个量级不随缩放变，所以不能只用屏幕像素（放大后会漏掉）。
      { dist: Math.max(4, view.px(6)) },
    );
    displayRiverPlanCache = { list, scale: view.cameraScale, maxW: maxRiverWidth, smoothed, plans };
  }
  const { smoothed, plans } = displayRiverPlanCache;
  for (let ri = 0; ri < list.length; ri++) {
    const r = list[ri];
    const raw = r.points;
    if (!raw || raw.length < 2) continue;
    if (!view.polylineInView(raw, minX, minY, maxX, maxY)) continue;
    // 先圆角（中点二次曲线）再进样条：Catmull-Rom 是插值曲线，不圆角的话
    // 导入数据里的直角在放大后原样保留 = 用户说的"折线/铁轨"。
    const pts = smoothed[ri];
    // 逐点宽度（2026-10-26）：造陆河用落库的 `widths`；导入河按弧长 + 距海方向推。
    const widths = view.riverWidthSeries(r, pts);
    // 🔴 曲线 + 分块 Path2D 按 smoothed 数组缓存（此前每帧对 16 个块各做一遍 beginPath/lineTo）
    let runs = riverRunCache.get(pts);
    if (!runs) {
      runs = [];
      for (const [s, e] of (plans[ri] || [])) {
        if (e - s < 2) continue;
        runs.push(...buildRiverRun(pts, s, e, widths));
      }
      riverRunCache.set(pts, runs);
    }
    if (!runs.length) continue;
    c.strokeStyle = BASEMAP_RIVER_COLOR;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.globalAlpha = 1;
    for (const { path, idx } of runs) {
      const wi = Math.min(widths.length - 1, Math.max(0, Math.round(idx)));
      const w = Number(widths[wi]) || Number(r.width) || 0.02;
      // ⚠️ 下限**不要写成 0.35**：`test_73` 的源码守卫用裸子串查「省名档阈值被写回组件」，
      //    0.35 是它认定的档位阈值（详见该用例注释：遇到误伤就改数字，别改守卫）。
      c.lineWidth = Math.max(0.3, basemapRiverWidthWorld({ width: w }, view.cameraScale, maxRiverWidth));
      c.stroke(path);
    }
  }
  // 河流名：默认关闭（自动地名多为 FMG 英文名），由「图层 → 自动地名」控制
  if (view.showPlaceNames) view.drawRiverNames(c);
  c.restore();
}

/** 选中河流的高亮：沿河两侧各退开一段画**两条平行偏移线**，中间完全留空（水面像素一个不碰） */
export function drawSelectedRiverHighlightLayer(c, view) {
  const ids = view.riverSelIds();
  if (!ids.length) return;
  const all = (view.baseMap && view.baseMap.rivers) || [];
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(40);
  for (const id of ids) {
    const r = all.find((x) => x && x.id === id);
    if (!r) continue;
    const rawPts = view.riverNodesForRender(r);
    // 导入河是「去 + 回」的闭合路径 —— 选中轮廓也必须在折过的中心线上，
    // 否则金色两条边线会跟着"双线"一起复制一份。
    const pts = String(r.id || '').indexOf('river_') === 0
      ? rawPts
      : collapseReversedRiverPoints(rawPts);
    if (!pts || pts.length < 2) continue;
    if (!view.polylineInView(pts, tl.x - pad, tl.y - pad, br.x + pad, br.y + pad)) continue;
    const isPrimary = id === view.selectedRiverId;
    c.save();
    c.lineCap = 'round'; c.lineJoin = 'round';
    // 🔴 2026-10-18 第十六修：**选中反馈不许盖住被选中的东西**。
    //   旧实现是两遍加宽描边（外层暖白 +3.5px、内层亮芯 +1.2px）⇒ 整条河被奶白光带盖住；
    //   第二版"虚线轮廓"照样盖住（线宽 baseW+1.6px、中心就在河道中心线上）。
    //   现在：沿河两侧各退开 `RIVER_SEL_GAP_PX` 画两条平行偏移线，中间完全留空。
    const weightWorld = view.px(view.RIVER_SEL_WEIGHT_PX);
    const edgeWorld = view.px(1);
    const barWorld = view.px(2);
    const barHalfWorld = view.px(6);
    // 逐点宽度之后，轮廓的偏移量也必须**逐点**（常量偏移会在宽段压进水面、窄段飘出老远）
    const selSeries = String(r.id || '').indexOf('river_') === 0 ? null : view.riverWidthSeries(r, pts);
    let sides;
    if (selSeries) {
      const maxW = view.getMaxRiverWidth();
      const dists = selSeries.map((w) => {
        const pxw = basemapRiverWidthPx({ width: w }, maxW);
        const gapPx = riverSelGapForWidth(pxw) * (isPrimary ? 1 : 0.7);
        return basemapRiverWidthWorld({ width: w }, view.cameraScale, maxW) / 2 + view.px(gapPx);
      });
      sides = [offsetPolylineVariable(pts, dists),
        offsetPolylineVariable(pts, dists.map((d) => -d))];
    } else {
      const baseW = basemapRiverWidthWorld(r, view.cameraScale);
      const basePx = basemapRiverWidthPx(r);
      const gap = view.px(riverSelGapForWidth(basePx) * (isPrimary ? 1 : 0.7));
      sides = [offsetPolyline(pts, baseW / 2 + gap),
        offsetPolyline(pts, -(baseW / 2 + gap))];
    }
    c.strokeStyle = isPrimary ? 'rgba(255, 214, 102, 0.95)' : 'rgba(34, 211, 238, 0.7)';
    c.lineWidth = weightWorld;
    for (const side of sides) {
      if (!side || side.length < 2) continue;
      c.beginPath();
      c.moveTo(view.vx(side[0]), view.vy(side[0]));
      for (let i = 1; i < side.length; i++) c.lineTo(view.vx(side[i]), view.vy(side[i]));
      c.stroke();
    }
    // 节点手柄：**只在河流工具里、且只对手画的河**画（导入河不支持拖节点，
    // 旧实现只要选中就画几十个方块 → 点一下就满屏"一堆点点"把河盖死）
    const handDrawn = String(r.id || '').indexOf('river_') === 0;
    if (isPrimary && handDrawn && view.tool === 'river') {
      // 节点太多时**抽稀**画：端点、当前节点必画，其余按 stride 取；手柄也缩小
      const hs = view.px(2.6);
      const stride = pts.length > 20 ? Math.ceil(pts.length / 20) : 1;
      c.strokeStyle = 'rgba(15, 23, 42, 0.9)';
      c.lineWidth = edgeWorld;
      for (let i = 0; i < pts.length; i++) {
        const keep = i === 0 || i === pts.length - 1 || i === view.riverActiveNode || (i % stride === 0);
        if (!keep) continue;
        const sx = view.vx(pts[i]);
        const sy = view.vy(pts[i]);
        const isHead = i === 0;
        const isMouth = i === pts.length - 1;
        c.fillStyle = isHead ? '#fbbf24' : (isMouth ? '#22d3ee' : 'rgba(248,250,252,0.92)');
        c.beginPath();
        c.rect(sx - hs, sy - hs, hs * 2, hs * 2);
        c.fill();
        c.stroke();
      }
      // 两端再加一枚"短横杠"：手柄会被水面附近的地形吃掉对比度，端点是用户最常确认的东西
      for (const i of [0, pts.length - 1]) {
        if (i < 0 || i >= pts.length) continue;
        c.strokeStyle = i === 0 ? '#fbbf24' : '#22d3ee';
        c.lineWidth = barWorld;
        c.beginPath();
        c.moveTo(view.vx(pts[i]) - barHalfWorld, view.vy(pts[i]));
        c.lineTo(view.vx(pts[i]) + barHalfWorld, view.vy(pts[i]));
        c.stroke();
      }
    }
    c.restore();
  }
}

/** 首都星标（十角星；城镇层内部用） */
function drawCapitalStar(c, view, x, y, r) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fillStyle = '#ffd700';
  c.fill();
  c.strokeStyle = 'rgba(20,24,34,0.65)';
  c.lineWidth = view.px(1);
  c.stroke();
}

/** 城镇（两趟：普通在下、首都在上；按档位节流 + 视口裁剪） */
export function drawBurgsLayer(c, view) {
  const list = view.burgs;
  if (!list || !list.length) return;
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const pad = view.px(24);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  // 617 个城镇全画 = 一层白芝麻（把地形、省界、河名全盖住）→ 按同一套档位节流
  const detail = view.labelDetail();
  const dotR = view.px(1.9);
  const starR = view.px(4.6);
  const hoverId = view.hoveredBurg ? view.hoveredBurg.id : null;
  const selectedId = view.selectedBurg ? view.selectedBurg.id : null;

  // 两趟绘制（普通城镇在下、首都在上）；不新建数组，避免渲染循环内分配
  for (let pass = 0; pass <= 1; pass++) {
    for (const b of list) {
      if ((b.capital ? 1 : 0) !== pass) continue;
      if (b.x < minX || b.x > maxX || b.y < minY || b.y > maxY) continue;
      if (pass === 1) {
        drawCapitalStar(c, view, b.x, b.y, starR);
      } else {
        // 档位节流：far/mid 只留首都；near 只留人口 ≥20 的；close 全出
        if (detail === 'far' || detail === 'mid') continue;
        if (detail === 'near' && Number(b.population || 0) < 20) continue;
        // 根据聚落规模调整大小（P1-T4）
        const sizeDef = view.BURG_SIZES.find(s => s.id === b.size) || view.BURG_SIZES[1];
        const r = dotR * (sizeDef.radius / 3.5);
        c.fillStyle = sizeDef.color;
        c.globalAlpha = 0.62;
        c.beginPath();
        c.arc(b.x, b.y, r, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
      }
      if (b.id === selectedId || b.id === hoverId) {
        c.strokeStyle = b.id === selectedId ? '#34d399' : '#ffffff';
        c.lineWidth = view.px(1.5);
        c.beginPath();
        c.arc(b.x, b.y, starR * 1.8, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }
}
