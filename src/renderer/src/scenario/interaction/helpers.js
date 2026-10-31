// interaction/helpers.js — 剧本视图（N1 第三阶段批处理，2026-10-31）
//
// 由 `build/_extract_batch.mjs` 从 ScenarioMap.vue 原样搬出：getSeaDetail / mapWorldSize / riverWidthSeries / applyReimportDialog / autoSeedBatch / onWheel / fitToView / handleResize。
// 依赖约定：`st` = 手势/工具期的普通 `let`（组件侧带 get/set，读写同一份）；
//   其余 ref / const / 函数走 `ctx`；纯函数工具直接 import。

import { RASTER_SEA_LEVEL } from '../../utils/heightmapRaster';
import { SEA_DEPTH_LEVELS, buildSeaDepth, buildSeaDepthFromRings, sampleGridAt } from '../../utils/seaDepth';
import { extractIsoLines } from '../../utils/contour';
import { pickRiverMouthEnd, riverWidthFactors } from '../../utils/riverRender';
import { provinceRings } from '../../utils/provinceShape';
import { smoothPolyline } from '../../utils/riverTrace';
import { toRaw } from 'vue';

export function createHelperActions(ctx) {
  const { st, ...rest } = ctx;
  const {
    baseMap,
    baseMapKey,
    batchOpts,
    batchSeeds,
    batchStatus,
    brushRadius,
    brushStrength,
    cameraScale,
    cameraX,
    cameraY,
    canvas,
    canvasWrap,
    closeReimportDialog,
    endStrokeBase,
    getSeaDistanceField,
    markCameraMotion,
    provinceHint,
    px,
    rasterLayer,
    reimportDialog,
    render,
    riverWidthSeriesCache,
    screenToWorld,
    statusMsg,
    store,
    tool,
    viewMode,
  } = rest;

function getSeaDetail() {
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  if (!hm || !hm.grid || !hm.h || !hm.h.length) return null;
  const land = baseMap.value?.landFeatures || null;
  if (st.seaDetailCache.hm === hm && st.seaDetailCache.land === land) return st.seaDetailCache;

  const cols = hm.grid.cellsX | 0;
  const rows = hm.grid.cellsY | 0;
  const pts = hm.grid.points;
  const gridOk = cols > 1 && rows > 1 && pts && pts.length >= cols * rows;
  const isobaths = [];
  // 高精度陆地环（导入 .map 的 `landFeatures`）：海岸线用它，粗格图上还用它重建海深场。
  const ringRings = (Array.isArray(land) ? land : [])
    .map((f) => (f && Array.isArray(f.points) ? f.points : null))
    .filter((r) => r && r.length >= 3);
  // 等深线的可读性下限：1 格 = 18 世界单位的老导入图（真实 415 省底图就是 97×45 / 18.3 格距），
  // 抽出来的等深线是一圈圈十来个像素一段的多边形；这种图只给**海深渐变**，不画线。
  // 阈值 14 覆盖造陆图（约 8~10 单位/格），也与"细网格才谈得上等深线"这个事实一致。
  const spacing = Number(hm.grid.spacing) || 0;
  const isobathOk = spacing > 0 && spacing <= 14;
  if (gridOk && isobathOk) {
    const depth = buildSeaDepth(hm, { seaLevel: RASTER_SEA_LEVEL });
    if (depth) {
      for (const level of SEA_DEPTH_LEVELS) {
        for (const ln of extractIsoLines(depth.t, cols, rows, pts, level)) {
          // 等值线的折角来自格距（marching squares 每格一段）→ 先 Chaikin 再画，
          // 否则 1× 下是一圈"锯齿轮廓"（实测截图）。平滑只切角、不改变档位。
          const smooth = smoothPolyline(ln.points, 2);
          if (smooth.length >= 2) isobaths.push(smooth);
        }
      }
    }
  } else if (ringRings.length) {
    // ── 粗格导入图的等深线（2026-10-27）────────────────────────────────────────
    // 97×45 / 格距 18.3 的高度场画不出可读的等深线，但这类图带着**高精度海岸线环**：
    // 把环栅格化成细掩膜 → 同一套 Chamfer + p70 + 指数映射 → 同一组档位抽线。
    // 数据源换成环，口径与 `buildSeaDepth` 逐字一致（不是第二套海深模型）。
    const fine = buildSeaDepthFromRings(ringRings, {
      step: Math.max(2, Math.min(5, (spacing || 18) / 4)),
    });
    if (fine) {
      for (const level of SEA_DEPTH_LEVELS) {
        for (const ln of extractIsoLines(fine.t, fine.cols, fine.rows, fine.points, level)) {
          const smooth = smoothPolyline(ln.points, 1);
          if (smooth.length >= 2) isobaths.push(smooth);
        }
      }
    }
  }
  // 海岸线：① 存着的陆地轮廓（导入 .map 的高精度环，与省份几何同源）；② 没有 → 高度场等值线
  const coasts = [];
  const feats = Array.isArray(land) ? land : [];
  if (ringRings.length) {
    for (const ring of ringRings) coasts.push(ring);
  } else if (gridOk) {
    for (const ln of extractIsoLines(hm.h, cols, rows, pts, RASTER_SEA_LEVEL)) {
      const smooth = smoothPolyline(ln.points, 2);
      if (smooth.length >= 2) coasts.push(smooth);
    }
  }
  st.seaDetailCache = { hm, land, isobaths, coasts };
  return st.seaDetailCache;
}

function mapWorldSize() {
  const terrain = baseMap.value?.terrain;
  if (!terrain || !terrain.length) return { w: 0, h: 0 };
  if (st._mapSizeCache.src === terrain) return st._mapSizeCache;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const prov of terrain) {
    for (const ring of provinceRings(toRaw(prov))) {
      for (const p of (ring.points || [])) {
        const x = Array.isArray(p) ? p[0] : p && p.x;
        const y = Array.isArray(p) ? p[1] : p && p.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  st._mapSizeCache = {
    src: terrain,
    w: isFinite(minX) ? Math.max(1, maxX - minX) : 0,
    h: isFinite(minY) ? Math.max(1, maxY - minY) : 0,
  };
  return st._mapSizeCache;
}

function riverWidthSeries(river, pts) {
  const base = Number(river && river.width) > 0 ? Number(river.width) : 0.02;
  if (!pts || pts.length < 2) return [base];
  const hit = riverWidthSeriesCache.get(pts);
  if (hit) return hit;
  let series;
  if (Array.isArray(river.widths) && river.widths.length >= 2) {
    const n = river.widths.length;
    series = pts.map((_, k) => {
      const t = pts.length > 1 ? k / (pts.length - 1) : 1;
      return Number(river.widths[Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))))]) || base;
    });
  } else {
    const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
    const field = getSeaDistanceField();
    let reversed = false;
    if (hm && field) {
      const end = pickRiverMouthEnd(pts, (x, y) => sampleGridAt(hm, field.dist, x, y), { fallback: 'last' });
      reversed = end === 'first';
    }
    // 🔴 2026-10-27（C2「粗细几乎完全平均」）：线性因子 0.35→1 落到像素口径只差 ~1.5 倍
    //    （被 1.2~4.6 的区间和归一化一起压平了）。平方后源头只剩 12%，河口仍是满宽 ——
    //    这样一条河自己能看出"越往下游越宽"，而不只是河与河之间不同。
    series = riverWidthFactors(pts, { reversed }).map((f) => base * f * f);
  }
  riverWidthSeriesCache.set(pts, series);
  return series;
}

function applyReimportDialog() {
  const d = reimportDialog.value;
  const bundle = st.pendingReimportBundle;
  if (!d || !bundle) return;
  if (!d.preview.canApply) {
    statusMsg('重导被阻止：存在并省冲突，先处理冲突再导');
    return;
  }
  const r = store.reimportBasemapAsNew(d.oldKey, bundle, {
    copyReferenceImages: !!d.copyReferenceImages,
  });
  if (!r || !r.ok) {
    statusMsg(`重导失败：${(r && r.message) || '未知原因'}`);
    return;
  }
  closeReimportDialog();
  baseMapKey.value = r.newKey;
  if (window.sitianAPI?.setCurrentBaseMapKey) {
    window.sitianAPI.setCurrentBaseMapKey(r.newKey);
  }
  if (store.baseMaps?.[r.newKey]?.heightmap) rasterLayer.value = 'height';
  if (viewMode.value !== 'scenario') viewMode.value = 'scenario';
  setTimeout(fitToView, 50);
  statusMsg(`${r.message}`
    + (r.unmappedOld?.length ? `；⚠️ ${r.unmappedOld.length} 个旧省没映射上（归属会丢）` : '')
    + (r.droppedOldProvinces?.length ? `；丢弃归属 ${r.droppedOldProvinces.length} 条` : '')
    + '（Ctrl+Z 可整次撤回）');
}

function autoSeedBatch() {
  if (store.isReadOnly) { statusMsg(`批量铺底已停用：${store.readOnlyReason}`); return; }
  const o = batchOpts();
  if (o.provinceIds && !o.provinceIds.length) {
    batchStatus.value = '「选中的省份」是空的 —— 先在选择工具下 Ctrl+点击选几个省，或把范围改成「全部陆地」';
    statusMsg(batchStatus.value);
    return;
  }
  batchStatus.value = '正在算范围与播种…';
  // 让状态先刷出来（并集在真实底图上要一秒左右）
  setTimeout(() => {
    const r = store.planBatchSeeds(baseMapKey.value, o);
    if (!r || r.ok === false) {
      batchStatus.value = (r && r.message) || '播种失败';
      statusMsg(batchStatus.value);
      return;
    }
    batchSeeds.value = r.seeds;
    batchStatus.value = `已播 ${r.seeds.length} 个点（范围 ${r.targets} 省 / ${r.regionPoints} 点边界，第 ${r.attempt + 1} 轮凑够）`
      + '—— 满意就点「一键切分」';
    statusMsg(batchStatus.value);
    render();
  }, 0);
}

function onWheel(event) {
  st.initialFitPending = false;         // 用户开始操作 → 不再自动抢镜头
  endStrokeBase();                   // 滚轮会动相机 → 手势期基帧必须作废（相机动了贴图就是错的）
  // 笔刷工具下：滚轮调半径，Shift+滚轮调强度
  if (tool.value === 'height' || tool.value === 'biome' || tool.value === 'lake') {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 1 : -1;
    if (event.shiftKey && tool.value === 'height') {
      brushStrength.value = Math.max(0.5, Math.min(10, brushStrength.value + delta * 0.5));
    } else {
      brushRadius.value = Math.max(20, Math.min(300, brushRadius.value + delta * 10));
    }
    return;
  }
  event.preventDefault();
  const rect = canvas.value.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const worldBefore = screenToWorld(mx, my);
  const zoomFactor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  cameraScale.value = Math.max(0.1, Math.min(50, cameraScale.value * zoomFactor));
  const worldAfter = screenToWorld(mx, my);
  cameraX.value += (worldAfter.x - worldBefore.x) * cameraScale.value;
  cameraY.value += (worldAfter.y - worldBefore.y) * cameraScale.value;
  markCameraMotion();   // 缩放期跳过标签/聚落/小地图，停稳后补全量
  render();
}

function fitToView() {
  if (!baseMap.value?.terrain?.length) return;
  const terrain = baseMap.value.terrain;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const prov of terrain) {
    if (!prov.points) continue;
    for (const p of prov.points) {
      const px = p.x || p[0] || 0;
      const py = p.y || p[1] || 0;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  if (!isFinite(minX)) return;
  const w = canvasWrap.value.clientWidth;
  const h = canvasWrap.value.clientHeight;
  const padding = 40;
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  // 🔴 scale 必须夹到正数：窗口很小时 (w - padding*2) 或 (h - padding*2) 会是负数
  //    → 之前会算出**负 cameraScale**，而 `3 / cameraScale` 这类绘制半径立刻变成负数，
  //      Canvas 抛 IndexSizeError，整个 render 管线崩掉（2026-09-20 实测：历史剧本打开的
  //      小窗口下必崩，并且抛错在渲染路径里会把后续交互一起拖死）。
  //    下限取 0.02（约 1 世界单位 = 0.02px），宁可视口偏远也不允许 ≤0。
  const rawScale = Math.min((w - padding * 2) / bw, (h - padding * 2) / bh);
  cameraScale.value = Math.max(0.02, rawScale || 0.02);
  cameraX.value = padding + (w - padding * 2 - bw * cameraScale.value) / 2 - minX * cameraScale.value;
  cameraY.value = padding + (h - padding * 2 - bh * cameraScale.value) / 2 - minY * cameraScale.value;
  render();
}

function handleResize() {
  if (!canvas.value || !canvasWrap.value) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvasWrap.value.clientWidth;
  const h = canvasWrap.value.clientHeight;
  st.canvasDpr = dpr;
  canvas.value.width = Math.round(w * dpr);
  canvas.value.height = Math.round(h * dpr);
  canvas.value.style.width = w + 'px';
  canvas.value.style.height = h + 'px';
  // T10（S0 实测画布被面板压到 541×200）：小于 700×400 时给一次可读提示，
  // 不自动改布局（自动收面板会打断正在填的表单）；用户看到提示后自己收面板。
  if ((w < 700 || h < 400) && !st.smallCanvasWarned) {
    st.smallCanvasWarned = true;
    // 🔴 2026-10-20：布局提示**不许覆盖刚发生的操作回执**（实测：导入完成的回执被
    //    「画布只有 1065×200」顶掉 → 用户以为导入没发生 = 又一次"静默失败"）。
    //    3 秒内的操作回执优先；纯布局提示自己可以被下一条布局提示覆盖。
    const recentOp = Date.now() - st.lastStatusAt < 3000;
    const prev = provinceHint.value || '';
    if (!recentOp && (!prev || /^画布只有/.test(prev))) {
      statusMsg(`画布只有 ${Math.round(w)}×${Math.round(h)} —— 侧栏/时间轴占得太多，收起面板再画会顺手很多`);
    }
  } else if (w >= 700 && h >= 400) {
    st.smallCanvasWarned = false;
  }
  // 首次进入期间布局仍在定稿（时间轴面板占位会让画布变矮）→ 重新适屏，别留一个错的镜位；
  // 用户已经开始操作后就只重绘，不动镜头。
  if (st.initialFitPending) fitToView();
  else render();
}

  return { getSeaDetail, mapWorldSize, riverWidthSeries, applyReimportDialog, autoSeedBatch, onWheel, fitToView, handleResize };
}
