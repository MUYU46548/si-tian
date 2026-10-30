// scenario/layers/labels.js — 剧本视图「文字标注」层（N1 刀 1，2026-10-30）
//
// 从 `ScenarioMap.vue` 搬出来：**四档标签的统一避让排布**（势力名 / 省名 / 城镇名 / 河名）
// + **地形注记**（山系沿脊线、海域疏排、平原落点）+ **剧本浮动地名**。
//
// 这一层的三条老账（都写在原处注释里，搬过来一字未改）：
//   ① 四档各画各的 → 字压字；现在合成**一次排布**（`utils/labelLayout.js`），放不下就不标；
//   ② 沿路径排字在急弯/回环会折成一团 → 先量平直度与最大转角，不够直退回水平字；
//   ③ 势力名字号按**领土屏幕面积**给（EU4 参考图：大国名压得住图，小国名不喧宾夺主）。
//
// `view` 字段（由 `ScenarioMap.makeLayerView()` 提供；纯数据 + 几个组件内判据）：
//   w, h, px, screenToWorld(x,y), cameraX/Y/Scale
//   baseMap, terrain(原始省表), mode, selectedScenario, selectedPolity, timeline, eraIndex, date
//   showLabels/showPlaceNames/showPolityLabels/showProvinceNames/showBurgs/showNamedProvincesOnly/
//   showTerrainNames/showRiverBase
//   polityLabelSources(), polityLabelTier, mapWorldSize(), labelDetail(), labelScale()
//
// ⚠️ 缓存（排布结论）必须**按实例**：它是"相机 + 数据引用"的函数，跨实例共享会拿到别人的图。

import {
  PROVINCE_LABEL_STYLE, POLITY_LABEL_STYLE,
} from '../../utils/polityLabels';
import { drawStyledLabel, fontString, drawTextAlongPath } from '../../utils/labelStyles';
import { layoutTextAlongPath, slicePathAroundPoint, pathLength } from '../../utils/textOnPath';
import { layoutLabels, AREA_LABEL_PLACEMENTS } from '../../utils/labelLayout';
import { detailCaps } from '../../utils/labelZoom';
import {
  scenarioLabelTextStyle, burgLabelTextStyle, riverLabelTextStyle, terrainLabelTextStyle,
} from '../../utils/mapTextStyles';
import { collectBurgLabels, collectRiverLabels } from '../../utils/scenarioTextPlacement';
import { collectScenarioLabels } from '../../utils/scenarioLabels';
import { planPolityShape } from '../../utils/labelOrient';
import { provinceRings, ringPointsForRender } from '../../utils/provinceShape';

// 河名抬离河道中线的屏幕像素数：字压在水线上，河本身就看不清了
const RIVER_NAME_NORMAL_OFFSET = 7;

/** 给标签样式套字号系数（样式常量是 freeze 的，只能返回新对象） */
function scaleStyle(style, k) {
  if (!style || !(k > 0) || Math.abs(k - 1) < 1e-6) return style;
  return { ...style, fontSize: (Number(style.fontSize) || 12) * k };
}

/**
 * 沿路径排出来的字在**屏幕上**是否互相压住（2026-10-27）。
 *
 * 沿路径推进不重叠 ≠ 屏幕上不重叠：急弯/回环处两个不同弧长的字会落到同一块像素上，
 * 这正是「河名/山名诡异折叠」的形态。判据只看**非相邻**字对（相邻字本来就该挨着）。
 */
function placedCharsOverlap(placed, fontSize) {
  const list = Array.isArray(placed) ? placed : [];
  const minGap = Math.max(4, Number(fontSize || 12) * 0.5);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 2; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < minGap) return true;
    }
  }
  return false;
}

/**
 * 创建这一层的四个入口。**缓存按实例**（见文件头 ⚠️）。
 */
export function createLabelLayers() {
  let planCanvas = null;
  let planCache = { refs: null, nums: null, plan: [] };

  function measureTextWithStyle(text, style) {
    if (!planCanvas) planCanvas = document.createElement('canvas');
    const mc = planCanvas.getContext('2d');
    mc.font = fontString(style, 1);          // 所有地图标签都是 lockScreenSize:true → 屏幕字号
    const size = Number(style && style.fontSize) || 12;
    // 与 `drawStyledLabel` 同一口径：有字距就把字距算进宽度（否则排布会少留位置、字压字）
    const em = Number(style && style.letterSpacingEm);
    if ('letterSpacing' in mc) {
      try { mc.letterSpacing = em > 0 ? `${Math.round(size * em * 100) / 100}px` : '0px'; } catch (e) { /* 忽略 */ }
    }
    // +6 / +2 是**留缝**：纯字宽会把两个标签贴成一行，看起来像一个词
    return { w: mc.measureText(String(text)).width + 6, h: size * 1.3 + 2 };
  }

  /** C2：多行标签的排布盒子（最宽一行 × 行数；行高与 `drawStyledLabel` 同一系数 1.12） */
  function measureTextBlockWithStyle(lines, style) {
    const list = Array.isArray(lines) && lines.length ? lines : [''];
    const size = Number(style && style.fontSize) || 12;
    let w = 0;
    for (const l of list) w = Math.max(w, measureTextWithStyle(l, style).w);
    return { w, h: size * 1.3 + 2 + (list.length - 1) * size * 1.12 };
  }

  /**
   * 地形注记的**保留走廊**（2026-10-27，用户 gap #6）：山系/海域名沿脊线排，占的是一条线；
   * 别的标签压上去就白排了。这里把「名字实际会占的那一段」算成框交给 `layoutLabels` 当障碍物。
   */
  function terrainReserveBoxes(view, style, toScreen) {
    const out = [];
    const labels = (view.baseMap && view.baseMap.terrainLabels) || [];
    if (!labels.length) return out;
    const fs = Number(style && style.fontSize) || 14;
    const pad = fs * 0.7;
    for (const lb of labels) {
      const name = String((lb && lb.name) || '').trim();
      const pts = (lb && lb.points) || [];
      if (!name || !pts.length) continue;
      const scr = pts.map((p) => toScreen(p.x, p.y));
      if (lb.kind === 'plain' || scr.length < 2) {
        const sp = scr[0];
        const m = measureTextWithStyle(name, style);
        out.push({
          x0: sp.x - m.w / 2 - pad, y0: sp.y - m.h / 2 - pad,
          x1: sp.x + m.w / 2 + pad, y1: sp.y + m.h / 2 + pad,
        });
        continue;
      }
      const mid = scr[Math.floor(scr.length / 2)];
      const textW = Math.max(24, measureTextWithStyle(name, style).w - 6);
      const win = slicePathAroundPoint(scr, mid, textW * 1.4);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of win) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      if (!Number.isFinite(minX)) continue;
      out.push({ x0: minX - pad, y0: minY - pad, x1: maxX + pad, y1: maxY + pad });
    }
    return out;
  }

  /** 四档标签的候选与排布结论（世界坐标）。缓存键 = 相机数值 + 数据引用 */
  function getPlan(view) {
    if (view.mode !== 'scenario') return [];
    const baseMapRef = view.baseMap;
    const terrainRef = view.terrain;
    const burgsRef = baseMapRef?.burgs || null;
    const riversRef = baseMapRef?.rivers || null;
    const ownRef = view.selectedScenario?.ownership || null;
    // ⚠️ `timeline` 必须进缓存键：势力**改名**不改 ownership/terrain 的引用，
    //    漏了它就会出现「撤销后画布上还是旧名字」（test_73 f3 实测）。
    // ⚠️ `terrainLabels` 同理（2026-10-27）：它们现在是**排布的保留区**（会挪动别的字）。
    const terrainLabelsRef = baseMapRef?.terrainLabels || null;
    const refs = [terrainRef, burgsRef, riversRef, terrainLabelsRef, ownRef, view.selectedPolity,
      view.timeline, view.selectedScenario];
    const nums = [
      view.cameraX, view.cameraY, view.cameraScale, view.w, view.h,
      view.showLabels ? 1 : 0, view.showPlaceNames ? 1 : 0,
      view.showPolityLabels ? 1 : 0, view.showProvinceNames ? 1 : 0, view.showBurgs ? 1 : 0,
      // C3（2026-10-29）：只显示已命名省 —— 换个开关就换了一批候选，必须进缓存键
      view.showNamedProvincesOnly ? 1 : 0,
      view.eraIndex, view.date, view.diffMode,
      // 档位与字号必须进缓存键：滚轮跨档时「候选集/字号」都变，漏了就会画面不动（假"没反应"）
      view.labelDetail(), view.labelScale().toFixed(3),
      // 地形注记的保留区（显示开关 + 档位）也改变排布结论
      view.showTerrainNames ? 1 : 0,
    ];
    const sameRefs = planCache.refs && planCache.refs.length === refs.length
      && refs.every((r, i) => r === planCache.refs[i]);
    const sameNums = planCache.nums && planCache.nums.length === nums.length
      && nums.every((n, i) => n === planCache.nums[i]);
    if (sameRefs && sameNums) return planCache.plan;

    const scale = view.cameraScale;
    const W = view.w;
    const H = view.h;
    const detail = view.labelDetail();
    const caps = detailCaps(detail);
    const fontScale = view.labelScale();
    const toScreen = (x, y) => ({ x: view.cameraX + x * scale, y: view.cameraY + y * scale });
    const tl0 = view.screenToWorld(0, 0);
    const br0 = view.screenToWorld(W, H);
    const worldRect = {
      minX: tl0.x - view.px(24), minY: tl0.y - view.px(24),
      maxX: br0.x + view.px(24), maxY: br0.y + view.px(24),
    };
    const cands = [];

    // ① 省名 / 势力名
    //    🔴 2026-10-27：旧代码在这里**跳过占位名**（真实 415 省全叫「新省份 N」）→ 放大到省名档时
    //    一个省名都画不出来；而约定是「画布 → 保留，导出 → 过滤」。现在画布照约定保留。
    if ((view.showPolityLabels || view.showProvinceNames) && terrainRef && terrainRef.length) {
      const provinces = [];
      for (const prov of terrainRef) {
        if (!prov) continue;
        const r0 = provinceRings(prov)[0];
        provinces.push({
          id: prov.id,
          name: prov.name,
          rings: r0 ? [{ kind: r0.kind, points: ringPointsForRender(r0) }] : [],
        });
      }
      const { ownerRefOf, polityOfEra } = view.polityLabelSources();
      const labels = collectScenarioLabels({
        provinces,
        tier: view.polityLabelTier,
        scale,
        ownerRefOf,
        polityOfEra,
        highlightOwnerId: view.selectedPolity?.id || null,
        // C3：只显示已命名省（占位名整层不画；判据与导出链同一份）
        skipPlaceholderProvinces: view.showNamedProvincesOnly,
      });
      for (const lb of labels) {
        if (lb.kind === 'polity' && !view.showPolityLabels) continue;
        if (lb.kind === 'province' && !view.showProvinceNames) continue;
        const sp = toScreen(lb.x, lb.y);
        const baseStyle = lb.kind === 'province' ? PROVINCE_LABEL_STYLE : POLITY_LABEL_STYLE;
        let style = scaleStyle(baseStyle, fontScale);
        // 势力名字号按**领土屏幕面积**给；sqrt 让面积翻 4 倍字号才翻倍，避免碎国名糊成一片
        if (lb.kind === 'polity' && Number.isFinite(lb.area) && lb.area > 0) {
          const areaPx = lb.area * scale * scale;
          // 上限 = 地图屏幕宽度的 6%（EU4 实测：马穆鲁克约占图宽 6%），再加 96px 绝对上限
          const mapWpx = view.mapWorldSize().w * scale;
          const cap = Math.max(24, Math.min(96, mapWpx * 0.06));
          const byArea = Math.max(20, Math.min(cap, Math.sqrt(Math.max(1, areaPx)) * 0.32));
          style = { ...style, fontSize: Math.min(110, byArea * fontScale) };
        }
        // C2：超大国名沿领土主轴排、超宽折两行
        let shape = null;
        if (lb.kind === 'polity' && Number.isFinite(lb.area) && lb.area > 0) {
          shape = planPolityShape({
            text: lb.text,
            fontSize: style.fontSize,
            maxWidthPx: Math.sqrt(lb.area) * scale * 0.92,
            axis: lb.axis,
            elongation: lb.elongation,
          });
        }
        cands.push({
          id: lb.kind + ':' + lb.text,
          kind: lb.kind,          // 'province' | 'polity'
          text: lb.text,
          x: sp.x, y: sp.y,
          style,
          highlight: lb.highlight,
          lines: shape ? shape.lines : null,
          rotate: shape ? shape.rotate : 0,
          // 势力名/省名是**面状大字**：城市圆点不该把它挡掉（EU4 里国名直接压在城市上）
          ignoreSoftObstacles: true,
          // 省名放不下时在面内挪一点（势力名优先级更高，会先占住形心）
          placements: lb.kind === 'province' ? AREA_LABEL_PLACEMENTS : undefined,
        });
      }
    }

    // ② 城镇名（圆点右侧优先，放不下换左/上/下；圆点本身是障碍物）
    if (caps.burgs >= 0 && view.showPlaceNames && view.showBurgs && burgsRef && burgsRef.length) {
      for (const lb of collectBurgLabels(burgsRef, { tier: caps.burgs, rect: worldRect })) {
        const sp = toScreen(lb.x, lb.y);
        const r = (lb.capital ? 5.5 : 2.5) * 1.4;   // 屏幕像素：圆点/星标半径 + 余量
        cands.push({
          id: 'burg:' + lb.id,
          kind: lb.capital ? 'capital' : 'town',
          text: lb.name,
          x: sp.x, y: sp.y,
          style: scaleStyle(burgLabelTextStyle({ capital: lb.capital }), fontScale),
          placements: [
            { mode: 'right', gap: r }, { mode: 'left', gap: r },
            { mode: 'above', gap: r }, { mode: 'below', gap: r + 2 },
            { mode: 'right', gap: r, dy: -11 }, { mode: 'left', gap: r, dy: 11 },
          ],
          obstacles: [{ x0: sp.x - r, y0: sp.y - r, x1: sp.x + r, y1: sp.y + r }],
        });
      }
    }

    // ③ 河名（贴河上方，其次下方 —— 河名压河是最难读的一种）
    if (caps.rivers >= 0 && view.showPlaceNames && view.showRiverBase && riversRef && riversRef.length) {
      for (const lb of collectRiverLabels(riversRef, { tier: caps.rivers, rect: worldRect })) {
        const sp = toScreen(lb.x, lb.y);
        cands.push({
          id: 'river:' + lb.id,
          kind: 'river',
          text: lb.name,
          x: sp.x, y: sp.y,
          style: scaleStyle(riverLabelTextStyle(), fontScale),
          placements: [{ mode: 'above', gap: 5 }, { mode: 'below', gap: 5 }, { mode: 'right', gap: 7 }],
          // 河名沿河：排布只决定「放在哪一段河道附近」，实际落字沿折线排（drawRiverNameAlongPath）
          path: lb.path || null,
        });
      }
    }

    const placed = layoutLabels(cands, {
      // C2：多行标签按**块**量（最宽一行 × 行数），否则排布会少留一行的高度、两行字互相压
      measure: (text, cand) => (cand && Array.isArray(cand.lines) && cand.lines.length > 1
        ? measureTextBlockWithStyle(cand.lines, cand.style)
        : measureTextWithStyle(text, cand.style)),
      bounds: { minX: 6, minY: 6, maxX: W - 6, maxY: H - 6 },
      pad: 3,
      // 地形注记走廊先占位（与画布上真实画出的位置同坐标系：屏幕像素）
      reserve: (view.showTerrainNames && caps.terrainNames)
        ? terrainReserveBoxes(view, scaleStyle(terrainLabelTextStyle(), fontScale), toScreen)
        : [],
    });
    const plan = placed.map((p) => ({
      kind: p.kind,
      text: p.text,
      style: p.style,
      highlight: !!p.highlight,
      wx: (p.cx - view.cameraX) / scale,
      wy: (p.cy - view.cameraY) / scale,
      lines: p.lines || null,
      rotate: p.rotate || 0,
      path: p.kind === 'river' ? (p.path || null) : null,
    }));
    planCache = { refs, nums, plan };
    return plan;
  }

  /**
   * 河名沿河排字。
   *
   * 为什么不把整条河喂给 `layoutTextAlongPath`：避让排布已经判定「这个名字放在此处放得下」，
   * 按整条河的中点排字会让字跑离判定过的位置（那个位置可能正压着省名）。所以先把落点**投到河道上**，
   * 只取它两侧一段，再喂给沿路径排字 —— 判定与落字看的是同一处。
   */
  function drawRiverNameAlongPath(c, view, lb, scale) {
    const pts = lb && lb.path;
    if (!Array.isArray(pts) || pts.length < 2) return false;
    if (!(scale > 0)) return false;
    const style = lb.style || riverLabelTextStyle();
    const chars = Array.from(String(lb.text || ''));
    if (!chars.length) return false;
    const measure = (ch) => Math.max(2, measureTextWithStyle(ch, style).w - 6);
    const letterSpacing = 2.5;
    const textWidth = chars.reduce((sum, ch) => sum + measure(ch), 0)
      + letterSpacing * Math.max(0, chars.length - 1);

    const scr = pts.map((p) => ({ x: view.cameraX + p.x * scale, y: view.cameraY + p.y * scale }));
    const anchor = { x: view.cameraX + lb.wx * scale, y: view.cameraY + lb.wy * scale };
    const window = slicePathAroundPoint(scr, anchor, textWidth * 1.6);
    if (!Array.isArray(window) || window.length < 2) return false;
    // 🔴 2026-10-27：只把一小段折线喂给沿路径排字、**不判这段有多弯** → S 弯会让同一串字折回来。
    //    这里先量平直度（净位移/弧长）与最大转角：不够直就退回水平字。
    const winLen = pathLength(window);
    if (!(winLen > 1)) return false;
    const net = Math.hypot(window[window.length - 1].x - window[0].x,
      window[window.length - 1].y - window[0].y);
    const straightness = net / winLen;
    let maxTurn = 0;
    let prevAngle = null;
    for (let i = 1; i < window.length; i++) {
      const a = Math.atan2(window[i].y - window[i - 1].y, window[i].x - window[i - 1].x);
      if (prevAngle != null) {
        let d = Math.abs(a - prevAngle);
        if (d > Math.PI) d = Math.PI * 2 - d;
        if (d > maxTurn) maxTurn = d;
      }
      prevAngle = a;
    }
    if (straightness < 0.72 || maxTurn > 1.05) return false;   // 1.05rad ≈ 60°
    const layout = layoutTextAlongPath(lb.text, window, {
      fontSize: style.fontSize,
      letterSpacing,
      // 50°：45° 的斜河必须还能沿河排（test_156 的判据就是这个角度）
      maxTiltDeg: 50,
      measure,
    });
    if (!layout.ok || layout.placed.length < chars.length) return false;
    if (placedCharsOverlap(layout.placed, style.fontSize)) return false;
    const placedWorld = layout.placed.map((p) => ({
      ch: p.ch,
      x: (p.x + Math.sin(p.angle) * RIVER_NAME_NORMAL_OFFSET - view.cameraX) / scale,
      y: (p.y - Math.cos(p.angle) * RIVER_NAME_NORMAL_OFFSET - view.cameraY) / scale,
      angle: p.angle,
    }));
    drawTextAlongPath(c, placedWorld, style, { screenScale: scale });
    return true;
  }

  /** 画出排布结论里的指定档位（世界坐标 → drawStyledLabel） */
  function drawPlanned(c, view, kinds) {
    const plan = getPlan(view);
    if (!plan.length) return;
    const scale = view.cameraScale;
    for (const lb of plan) {
      if (kinds.indexOf(lb.kind) < 0) continue;
      // 河名沿河：能沿折线排就沿，排不下才退回水平字（宁可横着，也别丢名字）
      if (lb.kind === 'river' && drawRiverNameAlongPath(c, view, lb, scale)) continue;
      drawStyledLabel(c, lb.text, lb.wx, lb.wy, lb.style, {
        align: 'center',
        baseline: 'middle',
        screenScale: scale,
        highlight: lb.highlight,
        lines: lb.lines || undefined,
        rotate: lb.rotate || 0,
      });
    }
  }

  /** 省名 + 势力名（门控在层里：两个开关各自生效） */
  function drawPolity(c, view) {
    if (!view.showPolityLabels && !view.showProvinceNames) {
      // 旧实现只判 showPolityLabels；两个开关都在时也得「单开省名」能出字
      if (!view.showProvinceNames) return;
    }
    if (view.mode !== 'scenario') return;
    drawPlanned(c, view, ['province', 'polity']);
  }

  /**
   * 地形注记（山系沿脊线 / 海域疏排 / 平原落点）。
   * 路径不够长/太陡时**退化为水平字** —— 宁可横着，也别让名字凭空消失。
   */
  function drawTerrain(c, view) {
    if (!view.showTerrainNames) return;
    // 档位闸门：最粗的 far 档不画地形注记（与城镇/河名同一条「缩小只剩势力名」的纪律）
    if (!detailCaps(view.labelDetail()).terrainNames) return;
    const labels = (view.baseMap && view.baseMap.terrainLabels) || [];
    if (!labels.length) return;
    const scale = view.cameraScale;
    if (!(scale > 0)) return;
    const W = view.w;
    const H = view.h;
    const style = scaleStyle(terrainLabelTextStyle(), view.labelScale());
    const toScreen = (p) => ({ x: view.cameraX + p.x * scale, y: view.cameraY + p.y * scale });

    for (const lb of labels) {
      const name = String((lb && lb.name) || '').trim();
      const kind = lb && lb.kind === 'sea' ? 'sea' : (lb && lb.kind === 'plain' ? 'plain' : 'range');
      const pts = (lb && lb.points) || [];
      if (!name || pts.length < (kind === 'plain' ? 1 : 2)) continue;

      // 平原：点注记 —— 不参与沿路径排字，落在取的点上（视口外跳过）
      if (kind === 'plain') {
        const sp = toScreen(pts[0]);
        if (sp.x < -60 || sp.x > W + 60 || sp.y < -30 || sp.y > H + 30) continue;
        drawStyledLabel(c, name, pts[0].x, pts[0].y, style, {
          align: 'center', baseline: 'middle', screenScale: scale,
        });
        continue;
      }

      // 视口裁剪（整条线都在屏外就跳过）
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        const sp = toScreen(p);
        if (sp.x < minX) minX = sp.x;
        if (sp.x > maxX) maxX = sp.x;
        if (sp.y < minY) minY = sp.y;
        if (sp.y > maxY) maxY = sp.y;
      }
      if (maxX < -40 || minX > W + 40 || maxY < -40 || minY > H + 40) continue;

      const scr = pts.map(toScreen);
      const layout = layoutTextAlongPath(name, scr, {
        fontSize: style.fontSize,
        letterSpacing: kind === 'sea' ? 6 : 2,
        maxTiltDeg: 55,
        measure: (ch) => Math.max(2, measureTextWithStyle(ch, style).w - 6),
      });
      // 折叠退让：急弯处字叠字 → 退回水平字
      if (layout.ok && !placedCharsOverlap(layout.placed, style.fontSize)) {
        const placedWorld = layout.placed.map((p) => ({
          ch: p.ch,
          x: (p.x - view.cameraX) / scale,
          y: (p.y - view.cameraY) / scale,
          angle: p.angle,
        }));
        drawTextAlongPath(c, placedWorld, style, { screenScale: scale });
      } else {
        const mid = pts[Math.floor(pts.length / 2)] || pts[0];
        drawStyledLabel(c, name, mid.x, mid.y, style, {
          align: 'center', baseline: 'middle', screenScale: scale,
        });
      }
    }
  }

  /** 剧本浮动地名（`selectedScenario.labels`）—— 与 SVG 导出共用 `scenarioLabelTextStyle` */
  function drawScenarioLabels(c, view) {
    if (view.mode !== 'scenario' || !view.selectedScenario || !view.selectedScenario.labels) return;
    view.selectedScenario.labels.forEach(label => {
      // `align/baseline` 保持旧画布的「左上角锚点」，避免地名整体位移
      drawStyledLabel(c, label.text || '', label.x, label.y, scenarioLabelTextStyle(label), {
        align: 'left', baseline: 'alphabetic',
      });
    });
  }

  return { getPlan, drawPlanned, drawPolity, drawTerrain, drawScenarioLabels };
}
