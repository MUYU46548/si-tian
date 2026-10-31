// interaction/province.js — 剧本视图（N1 第三阶段批处理，2026-10-31）
//
// 由 `build/_extract_batch.mjs` 从 ScenarioMap.vue 原样搬出：freeTraceRing / commitOutlineTrace / commitFreeTrace / finishPolySplit / handleMergeClick / getProvinceColor / setTool。
// 依赖约定：`st` = 手势/工具期的普通 `let`（组件侧带 get/set，读写同一份）；
//   其余 ref / const / 函数走 `ctx`；纯函数工具直接 import。

import { SEA_FILL, nextProvinceColor } from '../../utils/scenarioPalette';
import { conformToSkeleton } from '../../utils/provinceShape';
import { currentOwnerRef, isStriped, polityColor } from '../../utils/scenarioTimeline';
import { explainFreehandRejection, sanitizeFreehandRing, selfIntersectionCount } from '../../utils/freehandRing';
import { ref } from 'vue';
import { simplifyClosedTrace } from '../../utils/regionTrace';
import { smoothStrokePoints } from '../../utils/strokeEngine';

export function createProvinceActions(ctx) {
  const { st, ...rest } = ctx;
  const {
    BASEMAP_TOOL_IDS,
    BIOME_COLORS,
    PROVINCE_GRID_TOOLS,
    SNAP_EDGE_THRESHOLD,
    activeVertexIdx,
    addProvinceWithOverlapGate,
    baseMap,
    baseMapKey,
    basemapEditMode,
    brushPreview,
    clearPolySplit,
    clearSnapMarker,
    colorMode,
    dragPreview,
    draggingHandle,
    draggingVertex,
    drawPoints,
    endStrokeBase,
    ensureBaseMap,
    findProvinceAt,
    focusNewProvince,
    hoveredBurg,
    lockCoast,
    mergeProvId,
    mergeStep,
    outlineToNeighbor,
    polySplitHover,
    polySplitKeepStart,
    polySplitPoints,
    polySplitPreview,
    polySplitTarget,
    provBrushPreview,
    provBrushTarget,
    provLassoPoints,
    provinceBrush,
    rawTerrain,
    render,
    riverActiveNode,
    riverDraft,
    riverDrag,
    riverEraseStroke,
    riverMarquee,
    roadPath,
    roadStart,
    scenarios,
    selectedProvince,
    selectedRiverIds,
    selectedScenario,
    showBiomes,
    showProps,
    skeletonForTerrain,
    splitPoints,
    splitStep,
    statusMsg,
    store,
    timeline,
    tlDate,
    tlDiffMode,
    tlEra,
    tool,
    unownedProvinceColor,
    updateCursor,
    vertexEditMode,
    vertexMarquee,
    vertexSelection,
    viewMode,
  } = rest;

function freeTraceRing(rawPts, { snap = false, sanitize = true } = {}) {
  // T7：先过 perfect-freehand 的中心线稳定器（streamline），再 RDP 简化。
  // 预览与落库共用这一条链；稳定器对 100 点量级实测 p95 0.2ms（H1b spike）。
  //
  // 🔴 2026-10-21：`streamline` 从 0.4 降到 **0.2**。0.4 会把 90° 拐角**沿路径往回拉**
  //    （实测 40 点方框：角点从 (378,127) 被拉到 (367,127)，再叠上 RDP 就变成 14 单位外的
  //    一段圆弧），于是相邻省想贴上来时，最近骨架顶点已经超出 10 单位的吸附阈值 ——
  //    test_63 的「两省共享边界顶点」从 2 个掉到 1 个（2026-10-19 换笔迹引擎后一直红）。
  //    0.2 保留去抖，同时角点只内缩 ~4 单位（仍在阈值内）；实测共享顶点回到 2 个。
  //    ⚠️ 别再调回 0.4：那是把"手感平滑"建在"边界对不上"上的取舍，已经付过一次账。
  let src = rawPts;
  try {
    const stabilized = smoothStrokePoints(rawPts, { size: 1, thinning: 0, streamline: 0.2, smoothing: 0.5 });
    if (stabilized.length >= 3) src = stabilized.map((p) => ({ x: p.x, y: p.y }));
  } catch (e) { /* 引擎异常 → 退回原始手迹，绝不吞掉这一笔 */ }
  const simplified = simplifyClosedTrace(src);
  if (!simplified || simplified.length < 3) return null;
  let pts = simplified.map((q) => ({ x: q.x, y: q.y }));

  // 🔴 2026-10-22（第三刀）：落库前**净化闭环**。手画的圈经常自交（8 字 / 松手回勾），
  //    以前原样落库 → 画布上是一个「几乎没面积、带洞的怪多边形」（实测 fill=0.002）。
  //    这里用 polygon-clipping 归一：自交 → 拆成简单多边形 → 只留最大的一块；
  //    面积过小 / 细成一条线的，直接拒绝并给出原因（不再造怪形状）。
  // 预览**不跑净化**：polygon-clipping 在极端自交输入上可能长时间不返回（实测拖 8 字时
  // 预览每 60ms 调一次 → 主线程卡死）。预览只画简化后的原环，松手落库时再净化一次；
  // 打结时预览与成品的差别由状态栏「这一笔有交叉」说明。
  if (!sanitize) {
    return { ring: pts, simplified: pts.length, snapped: pts.length, cleaned: null, needsSanitize: true };
  }
  const sanitized = sanitizeFreehandRing(pts);
  if (!sanitized.ok) {
    st.freeTraceRejectReason = explainFreehandRejection(sanitized);
    return null;
  }
  pts = sanitized.points;
  st.freeTraceRejectReason = '';
  const cleaned = {
    dropped: sanitized.dropped,
    droppedArea: sanitized.droppedArea,
    holes: sanitized.holes,
    selfInt: sanitized.selfInt,
  };

  if (!snap) return { ring: pts, simplified: pts.length, snapped: pts.length, cleaned };
  // 🔴 必须传 **toRaw 后的地形**（2026-10-18 第十八修）：`buildSkeleton` 会把每个环的
  //    **顶点数组本身**存进骨架，而 `conformToSkeleton` 随后要逐顶点读 `.x/.y`。
  //    传响应式数组 ⇒ 骨架里躺着的是 Vue 代理 ⇒ **每次读坐标都过响应式 get 陷阱**。
  //    CPU 采样实测（真实底图拖一圈 4s）：`get` 574ms + `isReadonly` 138ms +
  //    `createReactiveObject` 127ms ≈ **15% 的拖笔时间**全花在这上面。
  //    地形写入一律换数组引用 ⇒ 引用缓存照样命中，渲染路径本来就该只读（同 `rawTerrain()`）。
  const skeleton = skeletonForTerrain(rawTerrain() || []);
  if (!skeleton.length) return { ring: pts, simplified: pts.length, snapped: pts.length, cleaned };
  const conformed = conformToSkeleton(pts, skeleton, SNAP_EDGE_THRESHOLD)
    .map((q) => ({ x: q.x, y: q.y }));
  // 贴骨架是插顶点，理论上不该自交；真出现了就**退回未吸附的形状**（宁可差一点缝隙，
  // 也不要一个自己咬自己的多边形 —— 后者连填充/命中都会错乱）
  if (selfIntersectionCount(conformed) > 0) {
    return { ring: pts, simplified: pts.length, snapped: pts.length, cleaned, snapAborted: true };
  }
  return { ring: conformed, simplified: pts.length, snapped: conformed.length, cleaned };
}

function commitOutlineTrace(pts) {
  if (!ensureBaseMap()) return false;
  // 🔴 与预览**同一条链**（`freeTraceRing`，不贴骨架 —— 描轮廓本来就是"只改这一段边界"，
  //    贴骨架会把笔迹整段吸到旧省界上，等于什么都没改）。
  const shape = freeTraceRing(pts, { snap: false });
  if (!shape) {
    statusMsg('描轮廓：轨迹太短，围不出形状（贴着要改的那条边界拖一圈再松手）');
    return false;
  }
  const path = shape.ring;
  let res = store.applyProvinceOutline(baseMapKey.value, path, {
    lockCoast: lockCoast.value,
    toNeighbor: outlineToNeighbor.value,
  });
  // D10：影响面超过上限 → 先问人（不静默执行）。S0 实测一笔 12 省、清空 3 个。
  if (res && res.rejected === 'province-gate') {
    if (!window.confirm(`${res.message}\n\n仍要执行吗？`)) {
      statusMsg(`描轮廓已取消：这一笔会影响 ${res.affected} 个省`);
      return true;
    }
    res = store.applyProvinceOutline(baseMapKey.value, path, {
      lockCoast: lockCoast.value,
      toNeighbor: outlineToNeighbor.value,
      allowMany: true,
    });
  }
  provinceBrush.invalidateBorders();
  // 拒绝分支排在 changed 之前 —— 与套索/点击填充同一条协议（{rejected, message}）
  if (res && res.rejected) {
    statusMsg(`描轮廓：${res.message}`);
    return true;
  }
  if (res && res.changed > 0) {
    const list = baseMap.value?.terrain || [];
    const target = list[res.targetIdx - 1];
    const owner = list[res.ownerIdx - 1];
    // 🔴 如实说明三件事：**从谁改判给谁**、**真正搬动了多少地**、以及"这块地上本来就有压叠"（若有）。
    //    搬动量用 `transferArea`（= 邻省失去的量，逐字节一致）而不是"笔迹围住的面积" ——
    //    区域跨边界时两者不同，报后者会让用户以为搬过去了一整块。
    statusMsg(`描轮廓：${res.detail || '已改边界'}`
      + `（笔迹 ${pts.length} 点 → 简化 ${path.length} 点；影响 ${res.affected || 0} 省；围住 ${Math.round(res.area || 0)}、`
      + `实际搬动 ${Math.round(res.transferArea || 0)}${
        res.switched && owner && target ? `：「${owner.name}」→「${target.name}」` : '（未换主）'}`
      + (res.neighborIdx ? `，贴着「${(list[res.neighborIdx - 1] || {}).name || ('省份 ' + res.neighborIdx)}」描` : '')
      + (res.preOverlap > 1 ? `；⚠️ 这块地上本来就有别省压着约 ${Math.round(res.preOverlap)}（原有压叠，不是这一笔造成的）` : '')
      + '）—— 邻省已自动重算，一笔 = 1 条撤销');
    if (target) { selectedProvince.value = target; showProps.value = true; }
  } else {
    statusMsg(`描轮廓：${(res && res.message) || '这一描没有改变任何边界'}`);
  }
  render();
  return true;
}

function commitFreeTrace(pts, shiftKey) {
  if (!ensureBaseMap()) return false;
  // 🔴 与预览**同一条链**（`freeTraceRing`）：用户松手前看到的那块地就是落库的那块地。
  //    这里若另写一遍简化/吸附，就会出现"预览一个形、落库另一个形"（= 描点连线模拟器的观感）。
  const shape = freeTraceRing(pts, { snap: !shiftKey });
  if (!shape) {
    statusMsg(`自由绘制：${st.freeTraceRejectReason || '轨迹太短，没有成型（按住沿轮廓拖一圈再松手）'}`);
    return false;
  }
  const id = `prov_${Date.now()}`;
  const count = baseMap.value?.terrain?.length || 0;
  const name = `新省份 ${count + 1}`;
  const prov = {
    id,
    name,
    kind: 'land',
    color: nextProvinceColor(count),
    // T8：自由绘制**不再把贝塞尔控制点写进数据** —— 数据多边形 = 渲染边界 = 布尔/命中用的几何。
    // 想要平滑轮廓时，用户点顶点（withBezierControls，/6 夹紧）显式加手柄。
    points: shape.ring,
  };
  if (!addProvinceWithOverlapGate(prov)) return true;
  provinceBrush.invalidateBorders();
  focusNewProvince(id, prov);          // 建完即选中 + 名字框待改（P1）
  const cleanedNote = shape.cleaned && (shape.cleaned.selfInt > 0 || shape.cleaned.dropped > 0 || shape.cleaned.holes > 0)
    ? `；这一笔有交叉，已取较大的一圈（丢碎屑 ${shape.cleaned.dropped} 块 / 洞 ${shape.cleaned.holes} 个）`
    : '';
  statusMsg(`已建「${name}」：轨迹 ${pts.length} 点 → 简化 ${shape.simplified} 点`
    + (shiftKey ? '（Shift：未吸附骨架）' : `（贴骨架后 ${shape.snapped} 点${shape.snapAborted ? '；吸附会自交，已放弃吸附' : ''}）`)
    + cleanedNote
    + ' —— 右侧可改名，一次绘制 = 1 条撤销');
  return true;
}

function finishPolySplit() {
  const pts = polySplitPoints.value.slice();
  if (pts.length < 2) { statusMsg('折线切割：至少需要两个点'); return; }
  if (store.isReadOnly) { statusMsg(`折线切割已停用：${store.readOnlyReason}`); return; }
  const keepStart = polySplitKeepStart.value;

  // 🔴 0.2.6：一次切**多块**（原先一刀一个省，切四五百块太慢）。
  //    每个省只用「折线在它内部的那一段」，所以延长段不会替邻居做决定（详见 store 注释）。
  const multi = store.splitProvincesAlong(baseMapKey.value, pts, { side: keepStart ? 1 : -1 });
  if (multi && multi.ok && multi.changed > 0) {
    clearPolySplit();
    provinceBrush.invalidateBorders();
    if (selectedProvince.value && !(baseMap.value?.terrain || []).some((p) => p.id === selectedProvince.value.id)) {
      selectedProvince.value = null;
    }
    const names = (multi.results || []).map((r) => r.name || ('省份 ' + r.idx)).slice(0, 6).join('、');
    statusMsg(`已沿折线切开 ${multi.changed} 个省：${names}${multi.changed > 6 ? ' …' : ''}`
      + `（${keepStart ? '绿色' : '橙色'}那半保留原省份身份；`
      + `${(multi.skipped || []).length ? `跳过 ${multi.skipped.length} 个；` : ''}`
      + `每个省一条撤销，要按 ${multi.changed} 次 Ctrl+Z）`);
    render();
    return;
  }
  if (multi && multi.rejected && multi.rejected !== 'no-cut') {
    statusMsg(`折线切割：${multi.message}`);
    render();
    return;
  }

  // 回落到**单省**路径：折线只擦过某个省的边（没真正横穿）时，单省那条能给出更准的话
  const target = polySplitTarget.value;
  if (!target) {
    statusMsg((multi && multi.message) || '折线切割：没找到要切的省份 —— 折线要穿过某个省的边界');
    return;
  }
  const res = store.splitProvinceAlong(baseMapKey.value, target.id, pts, { side: keepStart ? 1 : -1 });
  if (!res || res.blocked || res.rejected) {
    statusMsg((res && res.message) || '折线切割失败');
    render();
    return;
  }
  clearPolySplit();
  provinceBrush.invalidateBorders();
  if (selectedProvince.value && selectedProvince.value.id === target.id) {
    selectedProvince.value = (baseMap.value?.terrain || []).find((p) => p.id === target.id) || null;
  }
  statusMsg(`已沿折线把「${target.name || target.id}」切成两块`
    + `（${keepStart ? '绿色' : '橙色'}那半保留原省份身份；切割环 ${res.cutPoints || 0} 点；一次切割 = 1 条撤销）`);
  render();
}

function handleMergeClick(world) {
  const prov = findProvinceAt(world.x, world.y);
  if (!prov) { statusMsg('合并：请点中省份'); return; }
  if (mergeStep.value === 0) {
    mergeProvId.value = prov.id;
    mergeStep.value = 1;
    statusMsg(`合并：已选中「${prov.name}」，再点第二个省份`);
    render();
    return;
  }
  if (store.isReadOnly) { statusMsg(`合并已停用：${store.readOnlyReason}`); return; }
  if (mergeProvId.value && mergeProvId.value !== prov.id) {
    const terrain = baseMap.value?.terrain || [];
    const provA = terrain.find(q => q.id === mergeProvId.value);
    // 🔴 合并走**精确并集**（共边抵消；环真的穿过时才退回栅格），不再是凸包 ——
    //    凸包会把两个省之间的凹陷与邻居省份一起吞掉（用户实测「合并吃掉邻居」的根因）。
    const res = store.mergeProvinces(baseMapKey.value, [mergeProvId.value, prov.id], {
      name: `${provA?.name || ''}+${prov.name}`,
    });
    if (res && (res.blocked || res.rejected)) statusMsg(res.message || '合并失败');
    else if (res) {
      provinceBrush.invalidateBorders();
      // 🔴 P2：合并走**多边形布尔精确并集**（polygon-clipping）。旧的「共边抵消 / 栅格兜底」
      //    双分支已删除 —— 真实库那两块上万点的大陆会因 maxWork 超限被重采样成 220 分辨率轮廓
      //    （用户实测的第二处「退化」）。布尔没有阈值，也就不需要「超阈几倍」的量纲文案。
      statusMsg(`已合并（布尔精确并集，${res.loops} 环 / ${res.points} 点）`
        + '—— 不会吃掉邻居、也不会降精度；一次合并 = 1 条撤销');
    }
  }
  mergeStep.value = 0;
  mergeProvId.value = null;
  render();
}

function getProvinceColor(prov) {
  // P4：海域**不参与归属着色**（海不是谁的领土）→ 永远用水面色，与剧本/时间轴无关
  if (prov && prov.kind === 'sea') return SEA_FILL;

  // P1-T5：文化/宗教着色（颜色取自 .map 的 cultures/religions 定义，归属来自 province → burg → culture）
  if (colorMode.value === 'culture' && prov.cultureColor) return prov.cultureColor;
  if (colorMode.value === 'religion' && prov.religionColor) return prov.religionColor;

  // 剧本模式：优先势力归属色。归属按**时间轴当前年份**取（含「演变铺开」），
  // 而不是用选中剧本的静态快照 —— 否则拖时间轴时地图不会随年份变。
  if (viewMode.value === 'scenario') {
    const tl = timeline.value;
    const k = tlEra.value;
    // 🔴 本函数自己取日期，**不要**依赖调用方作用域里的 `at`：它被 `drawProvinces`（有 `at`）
    //    之外的多条路径调用（导出、色板预览等），靠外层变量就是一个 `ReferenceError`，
    //    而渲染路径里的异常会被 render 护栏吞成「连续 3 帧失败 → 暂停渲染」——
    //    症状是**整块画布空白**（test_41/44/61/73 一次全红），而不是某条断言红。
    const at = tlDate.value;
    if (tl.scenarios.length) {
      // ⚠️ 底色随变化图层模式切换：
      //   EU4 斜线占领 → 底色刻意保持**旧主**色（新主由斜线表达，两方本色）
      //   其他模式    → 底色 = **当前实际**持有者（关掉图层就该看到真实归属）
      // 颜色必须在 owner 所属的那个剧本里查（旧主 id 属于上一个剧本，跨剧本查会落到灰）
      const ref = (tlDiffMode.value === 'eu4' && isStriped(tl, k, prov.id, at))
        ? { owner: tl.scenarios[k - 1].ownership?.[prov.id], era: k - 1 }
        : currentOwnerRef(tl, k, prov.id, at);
      // 无主 → 地形本色（不再刷一块深灰蓝；见 `unownedProvinceColor`）
      if (!ref || !ref.owner) return unownedProvinceColor(prov);
      return polityColor(tl.scenarios[ref.era], ref.owner);
    }
    // 时间轴不可用（剧本缺年份等）时退回选中剧本的静态归属
    if (selectedScenario.value) {
      const owner = selectedScenario.value.ownership?.[prov.id];
      const polity = selectedScenario.value.polities?.find(p => p.id === owner);
      if (!polity) return unownedProvinceColor(prov);
      return polity.color || unownedProvinceColor(prov);
    }
  }

  // 省份**自有色**（P1：新建省份按色板轮转给色）—— 这是用户的显式选择，优先于群系/默认色
  if (prov.color) return prov.color;

  // 生物群系图层开启时按群系染色
  if (showBiomes.value && prov.biome && BIOME_COLORS[prov.biome]) return BIOME_COLORS[prov.biome];

  if (viewMode.value === 'scenario' && selectedScenario.value) return unownedProvinceColor(prov);
  return prov.biomeColor || '#bccda0';
}

function setTool(t) {
  tool.value = t;
  endStrokeBase();          // 换工具 = 手势中断：手势期基帧一律作废（见 `beginStrokeBase`）
  // 🔴 底图编辑模式的门（2026-10-18 第十七修）：选到**地理类**工具就自动把模式打开 ——
  //    这样"人在底图模式里"永远与"手上拿的是地理工具"一致，而既有用例直接 `setTool('river')`
  //    也照旧可用（零迁移）。反过来：切回省份类工具时**不自动关**（用户可能还要连着画几条河）。
  if (BASEMAP_TOOL_IDS.has(t) && !basemapEditMode.value) basemapEditMode.value = true;
  // P2：省份工具不再需要「先把网格准备好」—— 网格已退役（见 provinceEditing.js 文件头）。
  //     这里只保证有一个默认目标省，避免用户涂了半天才发现"没选省"。
  if (PROVINCE_GRID_TOOLS.has(t) && !provBrushTarget.value) provBrushTarget.value = 1;
  st.provStrokeActive = false;
  st.provPaintActive = false;    // 笔刷建省：换工具 = 这一笔作废（不落库，与几何笔刷同一条纪律）
  // 涂归属：换工具 = 这一笔作废（不落库）—— 与几何笔刷同一条纪律
  st.ownerStrokeActive = false;
  st.ownerStrokeIds = new Set();
  st.ownerLastSample = null;
  st.provLassoActive = false;
  provLassoPoints.value = [];
  provBrushPreview.value = null;
  drawPoints.value = [];
  splitStep.value = 0;
  splitPoints.value = [];
  polySplitPoints.value = [];
  polySplitHover.value = null;
  polySplitPreview.value = null;    // 换工具就丢掉折线预览（否则会残留上一条折线的两块颜色）
  mergeStep.value = 0;
  mergeProvId.value = null;
  vertexEditMode.value = (t === 'vertex');
  draggingVertex.value = null;
  // P1：换工具就丢掉顶点框选与联动上下文（否则换回顶点工具时会带着一批看不见的选中顶点）
  vertexSelection.value = [];
  vertexMarquee.value = null;
  st.vertexMarqueeStart = null;
  st.vertexLinkCtx = null;
  draggingHandle.value = null;
  // 第五轮：河流框选/多选同理 —— 换工具时清掉半截框与整批选中（主选中保留：它是"当前在编哪条"）
  riverMarquee.value = null;
  if (selectedRiverIds.value.length) selectedRiverIds.value = [];
  activeVertexIdx.value = -1;
  dragPreview.value = null;
  hoveredBurg.value = null;
  brushPreview.value = null;
  st.isBrushing = false;
  roadStart.value = null;
  roadPath.value = [];
  // 河流（2026-10-17）：换工具就丢掉半截笔迹 / 正在拖的节点 / 活动节点。
  // ⚠️ **不清 `selectedRiverId`**：选中是"当前在编哪条河"，
  //    切去别的工具看一眼再切回来还应该接着编它（清掉会让用户以为河没了）。
  riverDraft.value = [];
  riverDrag.value = null;
  riverActiveNode.value = -1;
  riverEraseStroke.value = [];          // 河流橡皮：换工具丢掉半截擦除轨迹（不然会残留一条红色轨迹）
  st.riverPreviewCache = { at: -1e9, pts: [] };
  st.suppressRiverClick = false;
  clearSnapMarker();
  updateCursor();
}

  return { freeTraceRing, commitOutlineTrace, commitFreeTrace, finishPolySplit, handleMergeClick, getProvinceColor, setTool };
}
