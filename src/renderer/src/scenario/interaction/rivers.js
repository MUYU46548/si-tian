// interaction/rivers.js — 剧本视图（N1 第三阶段批处理，2026-10-31）
//
// 由 `build/_extract_batch.mjs` 从 ScenarioMap.vue 原样搬出：finishRiverDraft / riverWidthsFor / makeRiverLandCheck / strokeRiverNetworkAsPaths / autoRiverPartsFor / clipSelectedRiversToCoast / generateAndShowRivers。
// 依赖约定：`st` = 手势/工具期的普通 `let`（组件侧带 get/set，读写同一份）；
//   其余 ref / const / 函数走 `ctx`；纯函数工具直接 import。

import { RIVER_WIDTH_MIN, RIVER_WIDTH_MAX } from '../../utils/rivers';
import { TRACE_SOURCE_HEIGHT } from '../../utils/riverTrace';
import { buildRiverPaths, thinRiverPath } from '../../utils/riverChains';
import { catmullRomPoints, fillRiverRibbon, pruneRiverNetwork, taperWidths } from '../../utils/riverRender';
import { clipPolylineToCoast, clipPolylinesToCoast } from '../../utils/coastline';
import { resampleSeries, widthsBySpeed } from '../../utils/strokeMath';

export function createRiverActions(ctx) {
  const { st, ...rest } = ctx;
  const {
    RIVER_BRUSH_MIN_POINTS,
    RIVER_MIN_SCREEN_CAP_PX,
    RIVER_MIN_SCREEN_PX,
    RIVER_PATH_CONTROL_POINTS,
    RIVER_PATH_MAX,
    RIVER_PATH_MIN_POINTS,
    RIVER_SMOOTH_SOURCE_HEIGHT,
    RIVER_WIDTH_DATA_SCALE,
    RIVER_WIDTH_DEFAULT,
    RIVER_WORLD_FLOOR,
    SEA_LEVEL_FOR_RIVER,
    autoRiverDrawn,
    autoRiverMaxFlow,
    autoRiverSegments,
    autoRivers,
    baseMap,
    baseMapKey,
    cameraScale,
    countCrossingsWithExisting,
    countPolylineCrossings,
    countSelfCrossings,
    getLandMask,
    handDrawnRivers,
    px,
    render,
    riverDraft,
    riverDraftParentId,
    riverDraftParentSeg,
    riverFlowGate,
    riverNodesFromDraft,
    riverSelIds,
    riverSelList,
    riverSmooth,
    riverSmoothPasses,
    riverSmoothRadius,
    riverSourceHeight,
    riverTerrainAdvice,
    selectedRiverId,
    smoothRadius,
    snapToPolyline,
    statusMsg,
    store,
  } = rest;

function finishRiverDraft(fromBrush = false) {
  const draft = riverDraft.value || [];
  const parentId = riverDraftParentId.value;
  riverDraft.value = [];
  // ⚠️ `riverDraftParentSeg` **不在这里清**：下面插母河拐点还要用它（它在 `onMouseDown`
  //    每次起笔时重置，所以不会串到下一笔）。
  riverDraftParentId.value = '';
  // 太短：不落库。**必须清空草稿** —— 留着会让下一次落笔接着上一次的点连成怪形状。
  if (draft.length < 2) return null;
  if (fromBrush && draft.length < RIVER_BRUSH_MIN_POINTS) {
    statusMsg('笔迹太短，已丢弃（拖长一点；只想加拐点就点已有河流的河身）');
    render();
    return null;
  }
  // ── 支流的两道闸门（2026-10-18 第十五修；「交叉怪物」的结构性防线）──────────
  //    ① **穿回母河**：与母河的交点 ≥ 2 = 这一笔又拐回来了（第 1 个交点是它长出去的
  //       那个起点，不算）→ 丢弃；
  //    ② **自交**：自己打了个结 → 丢弃。
  //    ⚠️ 丢弃是**有回执的**（说清是哪一条、为什么），绝不静默吞掉用户这一笔。
  if (parentId) {
    const parent = handDrawnRivers().find((r) => r && r.id === parentId);
    if (parent) {
      const back = countPolylineCrossings(draft.map((p) => ({ x: p.x, y: p.y })), parent.points || []);
      if (back >= 2) {
        statusMsg('这一笔又穿回母河了（支流只能长出去，不能穿回来）—— 已丢弃，请重新画');
        render();
        return null;
      }
    }
  }
  if (countSelfCrossings(draft.map((p) => ({ x: p.x, y: p.y }))) > 0) {
    statusMsg('这一笔画了个结（自交）—— 已丢弃，请重新画');
    render();
    return null;
  }
  // ③ 横切已有河（**没有**起点吸附时的那一类）：交点 ≥ 2 说明这一笔穿过去了。
  //    一条河的拓扑里，"穿过"不是汇聚 —— 汇聚是**支流端点接在干流上**（上面那条路走的就是它）。
  //    ⚠️ 回执要把"那该怎么做"说清楚：只说"不许"等于把用户堵在门外。
  if (!parentId) {
    const cross = countCrossingsWithExisting(draft.map((p) => ({ x: p.x, y: p.y })));
    if (cross.worst >= 2) {
      statusMsg('这一笔横切了已有的河（交叉）—— 已丢弃。要画支流请**从那条河的河身上起笔**（起点会自动吸附）');
      render();
      return null;
    }
  }
  // 🔴 2026-10-17 第六修（用户截图：画出来一堆点而不是线）：**三步走，顺序不能换**；
  //    2026-10-18 第十八修·四：这三步抽成 `riverNodesFromDraft`，**预览与落库共用同一条链**
  //    —— 与省份自由绘制（`freeTraceRing`）同一条纪律：预览要是"你将得到的那条河"。
  const chain = riverNodesFromDraft(draft);
  const pts = chain.pts;
  // T7（H1b→H2）：速度→宽度因子。没有时间戳，用采样间距当速度代理；
  // 参考间距取**屏幕 6px 换算成世界单位**，这样不同缩放档下“快/慢”的判据一致。
  // 存的是**相对因子**（0.65~1.55），用户调 `river.width` 时整条河仍会等比变宽。
  const widthFactors = pts.length
    ? resampleSeries(widthsBySpeed(draft, { base: 1, min: 0.65, max: 1.55, referenceGap: px(6) }), pts.length)
    : null;
  // D（2026-10-11）：**必须走 store**。旧实现只 push 进组件本地 `riverPaths` ——
  // 那条路既不进撤销栈、也不落盘（重开应用河就没了，且一声不响）。
  // 线宽按点数分级（与行星侧河流同一口径：越长的河越宽）。
  // 🔴 2026-10-17 第七修：落库宽度改用**河宽字段自己的量纲**（`RIVER_WIDTH_MIN..MAX` = 1..12）。
  //    以前压在 0.4~1.6，于是「把这条河调宽」调到 1.6 就到顶、再调没反应
  //    （数据层说"能到 12"，渲染层只认到 2.7 屏幕像素）—— 那是**能力存在但够不着**。
  //    现在默认给 `RIVER_WIDTH_DEFAULT`（3.5 → 8.4 屏幕像素 @100%），用户可继续调到 12。
  const width = RIVER_WIDTH_DEFAULT;
  // ── 支流：在**母河**上插一个拐点，让支流口与干流共享同一个坐标 ────────────────
  //    🔴 为什么必须插：支流起点是"吸附到母河折线上的投影点"，而母河的折线只在
  //    **它的节点**处有坐标。不插拐点的话，放大后这条支流看起来是"贴着"干流而不是
  //    "接在"干流上（而且在节点稀疏处会差出好几个世界单位）。
  //    🔴 2026-10-18 第十八修·三：这一步以前是**第二条 undo**（`addBaseMapRiver` 已经压了一条），
  //    用户按一次 Ctrl+Z 只撤掉"拐点插入"、支流还在 —— 而他的心理模型是"我刚画了一条支流"。
  //    现在「加这条河 + 改母河」走**同一个原子写口**（`applyBaseMapRiverEdit`）= 一条 undo。
  let parentPatch = null;
  if (parentId) {
    const parent = handDrawnRivers().find((x) => x && x.id === parentId);
    const junction = draft[0];
    if (parent && junction) {
      const ppts = (parent.points || []).map((p) => ({ x: p.x, y: p.y }));
      const seg = riverDraftParentSeg.value;
      let at = seg >= 0 && seg < ppts.length - 1 ? seg + 1 : -1;
      if (at < 0) {
        // 没记下段号（例如合成事件没有 mousemove）：按"最近点"自己找一遍
        const near = snapToPolyline(junction, ppts);
        at = near ? near.segIndex + 1 : -1;
      }
      const dup = at >= 0 && ppts[at] && Math.hypot(ppts[at].x - junction.x, ppts[at].y - junction.y) < 1e-6;
      if (at >= 0 && at <= ppts.length && !dup) {
        ppts.splice(at, 0, { x: junction.x, y: junction.y });
        parentPatch = { id: parentId, patch: { points: ppts } };
      }
    }
  }
  const r = store.applyBaseMapRiverEdit(baseMapKey.value, {
    patches: parentPatch ? [parentPatch] : [],
    adds: [{ points: pts, width, ...(widthFactors && widthFactors.length ? { widthFactors } : {}) }],
  });
  const newRiverId = (r && r.ok && r.added && r.added.length) ? r.added[0] : '';
  if (r && r.ok && newRiverId) {
    selectedRiverId.value = newRiverId;     // 画完立刻选中 → 紧接着就能拖节点/加拐点
    // 回执**只说结论、压到一行**（用户明确要求"底下那一堆废话不该显示给我看"）：
    // 中间流水（笔迹 N 点 → 抽稀 M → 平滑 K）是**实现细节**，不该占用状态栏。
    const total = (baseMap.value?.rivers || []).length;
    statusMsg(parentId
      ? `已画一条支流（接在母河上，共 ${total} 条）—— 拖节点微调 · Ctrl+Z 撤回（一步撤净）`
      : `已画一条河流（共 ${total} 条）—— 拖节点微调 · 点河身加拐点 · Ctrl+Z 撤回`);
  } else {
    statusMsg(`河流没画上：${(r && r.message) || '未知原因'}`);
  }
  render();
  return newRiverId ? (baseMap.value?.rivers || []).find((x) => x && x.id === newRiverId) || null : null;
}

function riverWidthsFor(river, count) {
  // 🔴 2026-10-17 第七修：`width` 是**显示宽度**（世界单位），量纲 = 河宽字段自己的
  //    `RIVER_WIDTH_MIN..MAX`（1..12）。以前落库压在 0.4~1.6，于是
  //    「把这条河调宽」调到 1.6 就到顶、再调没反应 —— **能力存在但够不着**。
  //
  // 🔴 2026-10-18 第十五修（暮雨：「河流在较小的缩放率下正常，放大后表现为空心铁轨，
  //    中间的水色渲染块没了，只剩两边的轨道」）—— 真正的病根在**调用方**：
  //    `drawOneHandRiver` 曾经传 `toPx: (w) => px(w)`，而画布在该处已经
  //    `scale(cameraScale)` ⇒ 把世界宽度**又除了一次**缩放，屏幕宽度于是恒为
  //    8.4px（实测 1×/2×/4×/8×/16× 全是 6~8 屏幕像素；把 `river.width` 放大 10 倍
  //    重测**纹丝不动** —— 一条判据就能否掉"数据没生效"那一类猜测）。
  //    现在 `toPx` 是恒等，下面那道"屏幕像素下限"就成了唯一负责"缩小时还看得见"的闸门：
  //    它把世界宽度抬到至少 `floorScreen / scale`，所以
  //      · 放大时 floorScreen 封顶（`RIVER_MIN_SCREEN_CAP_PX`）⇒ 河按**世界宽度**画，
  //        跟着地图一起变宽（这正是"放大后该有的样子"）；
  //      · 缩小时 floorScreen 起作用 ⇒ 河不会细到看不见。
  //    ⚠️ 不封顶会出现"越放大越细"（老写法在放大端的失效方式）。
  const dataW = Number.isFinite(Number(river && river.width)) ? Number(river.width) : RIVER_WIDTH_DEFAULT;
  const mouthWorld = Math.max(RIVER_WIDTH_MIN, Math.min(RIVER_WIDTH_MAX, dataW * RIVER_WIDTH_DATA_SCALE));
  const headWorld = Math.max(0.3, mouthWorld * 0.22);
  const tapered = taperWidths(count, headWorld, mouthWorld);
  // T7：手画河可带“速度→宽度因子”（相对值）；导入河/自动河没有这个字段 → 行为不变。
  if (Array.isArray(river && river.widthFactors) && river.widthFactors.length === count) {
    for (let i = 0; i < count; i++) {
      const f = Number(river.widthFactors[i]);
      if (Number.isFinite(f) && f > 0) tapered[i] *= Math.max(0.3, Math.min(2.5, f));
    }
  }

  // 「整条等比抬起」而不是逐点夹：逐点夹会把"源头细 → 河口粗"的渐变夹平（那是用户要的）。
  // 判据只看河口（最粗那点）。
  const scale = cameraScale.value;
  if (scale > 0) {
    let curMax = 0;
    for (const w of tapered) curMax = Math.max(curMax, w);
    const floorScreen = Math.min(RIVER_MIN_SCREEN_PX, RIVER_MIN_SCREEN_CAP_PX * scale);
    const needWorld = Math.max(floorScreen / scale, RIVER_WORLD_FLOOR);
    if (curMax > 0 && needWorld > curMax) {
      const k = needWorld / curMax;
      for (let i = 0; i < tapered.length; i++) tapered[i] *= k;
    }
  }
  return tapered;
}

function makeRiverLandCheck(mask) {
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  const grid = hm && hm.grid;
  const ok = grid && Array.isArray(grid.points) && grid.points.length && hm.h && hm.h.length === grid.points.length;
  let x0 = 0, y0 = 0, sp = 14.4, cols = 0, rows = 0;
  if (ok) {
    const p = grid.points[0];
    x0 = Array.isArray(p) ? p[0] : p.x;
    y0 = Array.isArray(p) ? p[1] : p.y;
    sp = grid.spacing || 14.4;
    cols = grid.cellsX | 0;
    rows = grid.cellsY | 0;
  }
  const heightIsLand = (x, y) => {
    if (!ok || !(cols > 1 && rows > 1)) return false;
    const ci = Math.round((x - x0) / sp);
    const cj = Math.round((y - y0) / sp);
    if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) return false;
    return (Number(hm.h[cj * cols + ci]) || 0) >= SEA_LEVEL_FOR_RIVER;
  };
  const useMask = !!(mask && typeof mask.lookup === 'function');
  if (!useMask && !ok) return null;   // 两份判据都没有 → 调用方按"不裁"处理
  // 🔴 2026-10-16 第五修（用户第三次报「依然过度延伸进海洋」）：
  //    **掩膜在时必须独占** —— 不能 `mask.lookup(x,y) || heightIsLand(x,y)`（那是并集）。
  //    为什么并集是错的（实测真实底图 desite，`scripts/tests/tools/_probe_phantom.mjs`，
  //    掩膜走**产品自己的** `buildLandMask`）：
  //      · 高度场 h≥20 判陆 **3053** 格，省份多边形判陆 **2960** 格，两者都陆 **2850**；
  //      · 🔴 **幻影格（高度说陆 / 掩膜说海）= 203 格 = 全部格点的 2.04%**
  //        （另有 110 格是反向：掩膜陆 / 高度海）；
  //      · **145 / 1710 段 = 8.5%** 至少一端踩在幻影格上（涉及 90 个幻影格）；
  //      · 踩在幻影格上的段在**并集**下**两端都判陆** → `clipSegmentToLand` 走
  //        `if (aLand && bLand) return {...seg}` → **一次裁剪都不做**，河照格心画进海里。
  //        实测「两端都判陆 → 跳过裁剪」的段数：并集 **1034** vs 掩膜独占 **854**
  //        → **180 段**在并集下"不用裁"，其中相当一部分正是画进海里的那些。
  //      · 上一轮我据「9/2785 越界」认为已修好 —— 那个数**量的是"裁剪之后仍越界"**，
  //        量不到"压根没进裁剪"（同一件事上第三次给自己发假证据）。
  //    🔴 **可复用的判据**：当两份判据对同一件事给不同答案时，取**真正决定画面**的那一份。
  //       这里画出来的陆地是省份多边形（海岸线由它重建），高度场只是**格心采样**的近似 ——
  //       所以掩膜独占，高度只在"还没有省份"时兜底（空底图/新底图照样能生成河）。
  //    ⚠️ 上一轮"改掩膜独占反而更糟（693→776）"的实测结论**来自同一个 bug 的另一面**：
  //       那次越界是在**裁剪之后**量的，而并集让大量段根本没进裁剪。
  //    ⚠️ **量尺纪律（本轮踩到）**：我第一版量尺自己手写了射线法 → 读出 **101** 格（真值 203，
  //       少一半）。量"产品口径"的东西一律 import **产品的实现**，不要另写一份；那份已删。
  if (useMask) return (x, y) => !!mask.lookup(x, y);
  return heightIsLand;
}

function strokeRiverNetworkAsPaths(c, paths, opts) {
  const subdiv = Number.isFinite(opts.subdiv) ? opts.subdiv : 6;
  const flowMax = Number.isFinite(opts.maxFlow) && opts.maxFlow > 1 ? opts.maxFlow : 1;
  // 先画细的、后画粗的：粗干流压在支流上，分叉处不会出现"细线横切粗线"的接缝
  const ordered = paths.slice().sort((a, b) => {
    const fa = Math.max(...a.map((p) => p.flow || 0));
    const fb = Math.max(...b.map((p) => p.flow || 0));
    return fa - fb;
  });
  for (const pts of ordered) {
    if (!pts || pts.length < 2) continue;
    const curve = pts.length >= 3
      ? catmullRomPoints(pts.map((p) => ({ x: p.x, y: p.y })), subdiv)
      : pts.map((p) => ({ x: p.x, y: p.y }));
    // 逐点宽度：按该链的流量量级给"河口宽度"，链内用与手画河同一口径过渡到源头
    const ownFlow = Math.max(1, ...pts.map((p) => p.flow || 0));
    const t = Math.min(1, Math.log(1 + ownFlow) / Math.log(1 + flowMax));
    // 河口宽度（屏幕像素）：最细 `minPx`，最粗 ≈ minPx×3.2（干流与支流拉开差距）
    const mouthPx = Math.max(opts.minPx, opts.minPx * (1 + 2.2 * t));
    const headPx = Math.max(opts.minPx * 0.75, mouthPx * 0.28);
    const nC = curve.length;
    // 逐点宽度（世界单位）：屏幕像素 → 世界单位；链内按 1.6 次幂从源头过渡到河口
    const pxToWorld = 1 / Math.max(1e-6, cameraScale.value || 1);
    const widths = [];
    for (let i = 0; i < nC; i++) {
      const u = nC > 1 ? i / (nC - 1) : 1;
      widths.push(Math.max(headPx * pxToWorld * 0.5, (headPx + (mouthPx - headPx) * Math.pow(u, 1.6)) * pxToWorld));
    }
    // 🔴 2026-10-20 第十七修：一条链 = **一次闭合多边形 fill**（旧写法每 1~2px 一段
    //    `beginPath/stroke`，900 链 × ~90 点 = 8 万次调用，既慢又长成"竹节"）。
    //    宽度连续、分叉处由"先细后粗、粗压细"的排序保证。
    fillRiverRibbon(c, curve, widths, {
      color: opts.color,
      // 岸线 = 0：见 drawCurvedRiver 的说明（两条边夹一条缝的成因）
      bankWidth: 0,
      // 不透明：分块圆帽接缝会叠自己，半透明会在水里压出一条更深的细芯（2026-10-21）
      alpha: 1,
    });
  }
}

function autoRiverPartsFor(net, terrain, segMax) {
  const c = st.autoRiverPartsCache;
  if (c.net === net && c.terrain === terrain && c.segMax === segMax) return c.out;
  // 🔴 2026-10-17 第六修（用户：「恐怖谷，我都懒得说了」）：
  //    一万多根"每格一根"的小棍铺满全图 = 一片平行斜线网格，那不是河。两条一起上：
  //      ① **按流量剪枝**（`pruneRiverNetwork`）—— 细支流不画，干支流拓扑保留；
  //         闸门按本幅图流量上界归一化（`riverFlowGate`：绝对数字换个地形就失效）。
  //      ② **屏幕像素下限**（`riverMinWidthForNet`，留在渲染侧算）—— 让"本网络在屏幕上
  //         有没有 2px"决定最细的河有多粗；缩到格子只有 1px 时退成一层薄雾而不是网格。
  const gate = riverFlowGate(segMax, net);
  const pruned = pruneRiverNetwork(net, gate);
  // 🔴 2026-10-17 第八修（用户：「支气管模拟器」「你会画河吗」）：
  //    **逐段画**从结构上就画不出河 —— 每根小棍独立描边、每根都是直线、段与段之间
  //    没有共享几何。就算给每段加个小弧，观感仍是"分叉处劈开的三根棍"。
  //    正确做法：**先把流向场还原成河链，再画河链**（见 `utils/riverChains.js`）：
  //      · 沿 receiver 往上溯，在**汇流点断开** → 得到"源头→下一个汇流点/河口"的完整链；
  //      · 每条链压到 8~14 个控制点 → Catmull-Rom 成**大尺度的弯**（不是格级锯齿）；
  //      · 宽度按该链自己的流量逐点变粗（源头细 → 河口粗）。
  //    这条路才是开源制图/水文工具的标准做法（Strahler/Shreve 分级的同一种分解）。
  const paths = buildRiverPaths(pruned.kept, {
    minFlow: gate,
    // 链的点数下限：一两条格的孤段即使流量达标也**不画**（那正是"支气管"的成因）
    minLen: RIVER_PATH_MIN_POINTS,
    maxPaths: RIVER_PATH_MAX,
  });
  // 🔴 2026-10-17 第八修·补（用户：「各种超出陆地进入海洋，《文明6》等游戏都不这样」）：
  //    实测（`_probe_river_sea_overrun.js`）：段一级已经 99.2% 在陆地，但**河链**里
  //    仍有 **4.1% 的末端落在海里**，而且 Catmull-Rom 会把链尾那一小段拖到岸外 ——
  //    看起来就是"河伸进大海"。
  //    根因不在段裁剪，而在**链级没有裁剪**：链是"源头→河口"的整条折线，
  //    它由多段拼成，段的逐段裁剪保不住"整条线的末端"。
  //    所以这里补一层**链级硬裁剪**：用产品自己的陆地掩膜把每条链裁到岸线。
  //    `keepOvershoot` 给一点点余量（否则河口会被切在离岸一格的位置，看起来断头）。
  //    —— 效果是"不可能画出海面上的河"：这是**结构性保证**，不是调参。
  //    ⚠️ 掩膜走 `getLandMask()`（**按 terrain 引用缓存**）—— 这里原来每帧 `buildLandMask`。
  let out = [];
  if (paths.length) {
    const chainObjs = paths.map((p) => ({
      id: p.flow,
      points: thinRiverPath(p.points, RIVER_PATH_CONTROL_POINTS),
      flow: p.flow,
    }));
    const coastMask = (Array.isArray(terrain) && terrain.length) ? getLandMask() : null;
    if (coastMask) {
      const clipped = clipPolylinesToCoast(chainObjs, coastMask.lookup, { keepOvershoot: 6 });
      out = clipped.list
        .filter((c) => c.points && c.points.length >= 2)
        .map((c) => c.points);
    } else {
      out = chainObjs.map((c) => c.points);
    }
  }
  st.autoRiverPartsCache = { net, terrain, segMax, out };
  return out;
}

function clipSelectedRiversToCoast() {
  const ids = riverSelIds();
  if (!ids.length) { statusMsg('裁海岸线：先选中要裁的河流（点它的河身，或 Shift+拖动框选）'); return false; }
  const terrain = baseMap.value?.terrain || [];
  if (!terrain.length) {
    statusMsg('裁海岸线：这张底图还没有省份 —— 没有海岸线可裁（先画省份，或改用「自动河流」）');
    return false;
  }
  const isLand = makeRiverLandCheck(getLandMask());
  if (!isLand) { statusMsg('裁海岸线：这张底图既没有省份轮廓也没有高度图，判断不了哪里是海'); return false; }
  const patches = [];
  let skipped = 0;
  for (const r of riverSelList()) {
    const pts = (r.points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) { skipped += 1; continue; }
    // ⚠️ `clipPolylineToCoast` 返回的是 `{ points, trimmed, dropped }`（不是点数组）
    let res = null;
    try { res = clipPolylineToCoast(pts, isLand); } catch { res = null; }
    if (!res || res.dropped || (res.points || []).length < 2) { skipped += 1; continue; }
    if (!res.trimmed) continue;                       // 本来就在陆地上 → 不算改动
    patches.push({ id: r.id, patch: { points: res.points.map((p) => ({ x: p.x, y: p.y })) } });
  }
  if (!patches.length) {
    statusMsg(`裁海岸线：选中的 ${ids.length} 条河已经在陆地上（没有可裁的入海段）`
      + (skipped ? `；另有 ${skipped} 条整条都在海里 —— 想删就直接按 Delete` : ''));
    return false;
  }
  const res = store.applyBaseMapRiverPatches(baseMapKey.value, patches);
  if (res && res.ok && res.changed) {
    statusMsg(`裁海岸线：${res.changed} 条河已裁到岸线`
      + (skipped ? `（${skipped} 条整条在海里，未动）` : '')
      + ' —— 一次操作 = 1 条撤销');
    render();
    return true;
  }
  statusMsg(`裁海岸线失败：${(res && res.message) || '没有改动'}`);
  return false;
}

function generateAndShowRivers() {
  // 旧实现在这里同步跑分钟级循环，用户看到的是"点了没反应、然后就卡死"。
  // 现在算法是索引版（秒级以内），但**必须给回执**：画了几条、丢了几条、多久。
  // ⚠️ 回执走 `statusMsg`（它写的是 `provinceHint`，显示为状态栏里的 .draw-hint），
  //    不是 `statusText`（那是「N 省份 | M 网格」那行）—— test_103 按这个口径断言。
  //
  // 🔴 2026-10-14 补（第三轮）：回执必须**把闸门读数一起报出来**。
  //    缘由是实测：这份地形的源头高度闸门恰好是"条数"的主宰 —— 默认 60 只出 **3 条**，
  //    而把它降到 40 立刻变 **67 条**（同一份数据）。用户只看到"生成 3 条河流"会以为
  //    河就是少的，**看不到"是闸门卡住了、而且可以调"**。所以：
  //      · 回执里写明「源头高度 >N / 离海 ≥M 格」；
  //      · 面板上给一个可调输入（`river-source-height`），让这个闸门**够得着**。
  const r = store.generateRivers(baseMapKey.value, {
    sourceHeight: Number.isFinite(riverSourceHeight.value) ? riverSourceHeight.value : undefined,
    // 🔴 追踪前平滑（2026-10-16）：实测唯一能显著改善观感的方向。
    //    ⚠️ 平滑压低山头 → 源头更难达标，所以**必须同时**把闸门降下来。
    //    这里在**点击时**降（而不是在 watch 里偷偷改），并把这件事写进回执 ——
    //    用户看得到"为什么闸门变成 40 了"，而不是发现参数自己变了。
    ...(riverSmooth.value
      ? {
        smoothRadius: riverSmoothRadius.value,
        smoothPasses: riverSmoothPasses.value,
        sourceHeight: Math.min(
          Number.isFinite(riverSourceHeight.value) ? riverSourceHeight.value : TRACE_SOURCE_HEIGHT,
          RIVER_SMOOTH_SOURCE_HEIGHT,
        ),
      }
      : {}),
  });
  // 平滑生效时把闸门输入框同步成实际用的值（让面板与算法一致，不出现"显示 60、实际用 40"）
  if (riverSmooth.value && r && r.smoothed) {
    riverSourceHeight.value = Math.min(riverSourceHeight.value, RIVER_SMOOTH_SOURCE_HEIGHT);
  }
  if (!r || r.ok === false) {
    statusMsg((r && r.message) || '自动河流没跑起来');
    return;
  }
  autoRivers.value = r.rivers || [];
  // 🔴 河网段（树枝状几何本体）+ 段汇流量上界（线宽归一化要用）—— 见 `autoRiverSegments` 注释
  autoRiverSegments.value = r.segments || [];
  autoRiverMaxFlow.value = r.segMaxFlow || 0;
  // 剪枝在**这里**算一次（回执要用它，渲染也用它）—— 不能等渲染时才第一次算，
  // 否则回执里那句话用的是**上一次**的读数（"改了没反应"的经典成因）。
  autoRiverDrawn.value = pruneRiverNetwork(
    autoRiverSegments.value, riverFlowGate(autoRiverMaxFlow.value, autoRiverSegments.value)).kept.length;
  // 🔴 2026-10-17 第六修：**状态栏只说结论，长解释进 tooltip**。
  //    用户原话：「底下还有一堆废话文本，这些根本不该显示出来给用户看」。
  //    那段解释（河长上限为什么低、两套河为什么并存）本身没错，但它是**读一次就够的**，
  //    不该每次点按钮都铺满状态栏（实测占到两行、把画布压矮）。
  //    现在：**一行**结论 + 悬停看详情（`riverTerrainAdvice` 那份计算已存在，直接复用）。
  //    ⚠️ 但**闸门读数与平滑回执必须留在这一行里**（保留原有守卫的口径）：
  //       它们是"参数够不够得着"的证据 —— 用户看不到读数就以为"河本来就少"。
  const brief = [`生成 ${autoRivers.value.length} 条河流`];
  if (autoRiverSegments.value.length) {
    brief.push(autoRiverDrawn.value < autoRiverSegments.value.length
      ? `河网 ${autoRiverDrawn.value}/${autoRiverSegments.value.length} 段（只画河道）`
      : `河网 ${autoRiverSegments.value.length} 段`);
  }
  if (r.sources === 0) {
    brief.push('⚠️ 源头高度调低（例如 40）再看');
  } else {
    brief.push(`闸门 源头高度 >${riverSourceHeight.value}`);
  }
  if (r.smoothed) brief.push(`已先平滑地形 → 闸门按 ${riverSourceHeight.value} 起算`);
  brief.push(`${Math.round(r.elapsedMs || 0)} ms`);
  // 🔴 2026-10-17：地形建议从"常驻角标 + 悬停"改为**一次性指路**（只在这一行里说一遍）。
  //    用户明确否掉了工具栏上那枚常驻「长河受限」（"放在已经很拥挤的工具栏里真的有必要吗"）。
  //    现在只在**长河确实受限**时追一句**可执行的**建议，而且带上解决入口的名字。
  statusMsg(
    `${brief.join(' · ')}`
    + (riverTerrainAdvice.value ? ' · 这份地形缺长河：点「更多 → 按轮廓生成地形」重建地形后更明显' : ''),
  );
  render();
}

  return { finishRiverDraft, riverWidthsFor, makeRiverLandCheck, strokeRiverNetworkAsPaths, autoRiverPartsFor, clipSelectedRiversToCoast, generateAndShowRivers };
}
