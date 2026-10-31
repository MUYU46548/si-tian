// scenario/interaction/down.js — 剧本视图交互（N1 第三阶段，2026-10-31）
//
// 由 `build/_extract_fn.mjs` 从 ScenarioMap.vue 的 `onMouseDown` 原样搬出（口径未改）。
// 依赖约定：
//   · `st`：手势期的普通 `let`（旗标/句柄）—— 组件侧是带 get/set 的对象，读写同一份；
//   · 其余：Vue ref / const / 函数 —— 按值传，对象身份不变；
//   · 纯函数工具：**直接 import**（同一份实现，不经 ctx 转手）。

import { beginInteraction } from '../../utils/interactionGate';
import { hitTestRiver } from '../../utils/rivers';
import { provinceRings } from '../../utils/provinceShape';

export function createDownHandlers(ctx) {
  const { st, ...rest } = ctx;
  const {
    CREATES_CONTENT_TOOLS,
    PROVINCE_GRID_TOOLS,
    RIVER_SELECT_HIT_PX,
    activeRingIdx,
    activeVertexIdx,
    baseMap,
    baseMapKey,
    beginStrokeBase,
    beginVertexLinkContext,
    brushBiome,
    brushCulture,
    brushRadius,
    brushReligion,
    brushStrength,
    cameraScale,
    canvas,
    clearOwnerMode,
    colorMode,
    currentProvince,
    draggingHandle,
    draggingVertex,
    ensureBaseMap,
    hitHandRiverBranchAnchor,
    hitRiverNodeIndex,
    nextOwnerStrokeId,
    ownerStrokeSample,
    pickPolityAt,
    provBrushPreview,
    provBrushWorldRadius,
    provLassoPoints,
    provinceBrush,
    provinceBrushOpts,
    provinceTargets,
    px,
    rasterLayer,
    render,
    resolvePoints,
    riverActiveNode,
    riverDraft,
    riverDraftParentId,
    riverDraftParentSeg,
    riverDrag,
    riverEraseStroke,
    riverMarquee,
    riverNodesForRender,
    screenToWorld,
    selectPolity,
    selectedPolity,
    selectedProvince,
    selectedRiver,
    selectedScenario,
    showSnapFeedback,
    statusMsg,
    store,
    terrainLabelPick,
    tool,
    vertexMarquee,
    vertexSelection,
    viewMode,
    vx,
    vy,
    withBezierControls,
    writeRingPoints,
    provBrushTarget,
  } = rest;

function onMouseDown(event) {
  if (event.button === 2) return; // 右键留给 context menu
  // 手势闸门（第十九修·一）：左键按住 = 「人手还在画布上」→ 到点的自动保存一律顺延。
  // 本组件**所有**编辑手势（拖笔/河笔/拖节点/框选/涂抹/高度·群系·文化·宗教笔刷）都从
  // mousedown 起笔，所以这一处接线即全量生效。**配对**靠 `st.canvasGateArmed`（不能无条件
  // 在 onMouseUp 里 end —— mouseleave 也会走 onMouseUp，会刷一堆"没有 begin 的 end"）。
  if (event.button === 0 && !st.canvasGateArmed) {
    beginInteraction('scenario-canvas');
    st.canvasGateArmed = true;
  }
  st.initialFitPending = false;      // 用户开始操作 → 不再自动抢镜头（见 onMounted 的适屏收尾）

  // 地形注记手绘（2026-10-27）：面板点「画山系/画海域/点平原」后画布进入取点态。
  // 必须排在所有工具分支之前：这一刻用户就是在给这条注记取几何，不许被别的工具抢走这一击。
  if (terrainLabelPick.value && event.button === 0) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const p = terrainLabelPick.value;
    terrainLabelPick.value = {
      ...p,
      points: [{ x: world.x, y: world.y }],
      dragging: p.kind !== 'plain',
      finished: p.kind === 'plain',
    };
    if (p.kind === 'plain') statusMsg('已落点：点面板「完成」再命名');
    render();
    return;
  }

  // 写类工具先确保有底图：项目里一张都没有时懒建一张（否则用户会「点了没反应」）
  if (CREATES_CONTENT_TOOLS.has(tool.value) && !ensureBaseMap()) return;

  // 涂归属（2026-10-20 重做）：只改**势力归属** —— 起笔只记省 id，抬手一次落库。
  // 与下面 `PROVINCE_GRID_TOOLS` 那条几何笔刷路径**完全分开**：不调多边形布尔。
  if (tool.value === 'ownerBrush' && event.button === 0) {
    if (store.isReadOnly) { statusMsg(`涂归属已停用：${store.readOnlyReason}`); return; }
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    if (event.altKey) {
      // 吸管：把该省当前的势力选成当前笔刷（"照着已有的涂"最常用）
      const { prov, polity } = pickPolityAt(world.x, world.y);
      if (!prov) statusMsg('吸管：这里没有省份');
      else if (!polity) statusMsg(`吸管：「${prov.name || '这个省'}」目前没有势力归属`);
      else { selectPolity(polity); statusMsg(`吸管：当前势力 = 「${polity.name}」`); }
      render();
      return;
    }
    if (!clearOwnerMode.value && !selectedPolity.value) {
      // 2026-10-20：没选势力时**不再静默不干活**（用户实测"涂归属什么都涂不了"就是这个态）。
      // 自动落到本剧本第一个势力，并说清"用的是谁、去哪换"——一笔一条撤销，画错了按 Ctrl+Z。
      const first = (selectedScenario.value?.polities || [])[0] || null;
      if (!first) {
        statusMsg('涂归属：这个剧本还没有势力 —— 先在地图上方的「势力：」行点「＋ 势力」');
        return;
      }
      selectPolity(first);
      statusMsg(`涂归属：没选势力，先用「${first.name}」—— 点地图上方的色块可以换`);
    }
    // 手势期基帧（2026-10-21）：拖动期画布**只贴基帧 + 画笔刷圈/已碰省份的预览色**，
    // 不再每帧重画 415 个省（用户反复报的「涂归属卡顿」）。落库仍在抬手（一笔一条撤销），
    // 所以基帧与数据在整笔期间天然一致 —— 与河流拖笔/框选同一条纪律。
    beginStrokeBase();
    st.ownerStrokeActive = true;
    st.ownerStrokeIds = new Set();
    nextOwnerStrokeId();          // 第 4 件：这一笔的账本组身份（一笔一组）
    st.ownerLastSample = { x: world.x, y: world.y };
    ownerStrokeSample(world.x, world.y);
    provBrushPreview.value = { x: world.x, y: world.y };
    render();
    return;
  }

  // ── 笔刷建省（2026-10-22）：涂抹期只收轨迹（零落库），**抬手才建省** ──────────────
  //    与「改省界」共用同一套采样（`applyProvinceStroke`，按 0.35×半径 抽稀），
  //    但落库走另一条路（`endProvinceStroke` 里按 tool 分派到 createProvinceFromBrush）。
  //    ⚠️ 这里**不要求已有省份**（空底图正是它最该能用的地方）——这是与上面那段的根本差别。
  if (tool.value === 'provincePaint' && event.button === 0) {
    if (store.isReadOnly) {
      statusMsg(`笔刷建省已停用：${store.readOnlyReason}`);
      return;
    }
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    st.provPaintActive = true;
    store.beginProvinceStroke();
    store.applyProvinceStroke(baseMapKey.value, {
      x: world.x, y: world.y,
      radius: provBrushWorldRadius.value,
      tool: 'provincePaint',
      target: 0,
    });
    provBrushPreview.value = { x: world.x, y: world.y };
    // 涂抹期数据一个字节都不变 → 底图可以整张贴成基帧，每帧只画笔迹带（见 beginStrokeBase）
    beginStrokeBase();
    render();
    return;
  }

  // P2：省份编辑 —— 笔刷落笔 / 套索起笔 / 点击填充（**矢量布尔**，不经网格）
  if (PROVINCE_GRID_TOOLS.has(tool.value) && event.button === 0) {
    // 只读态（未打开项目）：编辑入口不灰禁，但**不得产生任何改动** —— 直接说明原因与去处
    if (store.isReadOnly) {
      statusMsg(`省份编辑已停用：${store.readOnlyReason}`);
      return;
    }
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    if (!provinceTargets.value.length) {
      statusMsg('还没有省份：先点工具栏「新建省份」，再涂抹划地');
      return;
    }
    if (tool.value === 'provinceFill') {
      const res = store.fillProvinceRegion(baseMapKey.value, { x: world.x, y: world.y }, provBrushTarget.value);
      if (res && res.blocked) statusMsg(res.message);
      else if (res && res.rejected) statusMsg(res.message || '点击填充被拒绝');
      else if (res && res.changed) {
        provinceBrush.invalidateBorders();
        statusMsg(`${res.label}（一次点击 = 1 条撤销）`);
      } else statusMsg((res && res.message) || '这里没有可吞并的省份');
      render();
      return;
    }
    if (tool.value === 'provinceBrush') {
      st.provStrokeActive = true;
      store.beginProvinceStroke();
      store.applyProvinceStroke(baseMapKey.value, { x: world.x, y: world.y, ...provinceBrushOpts() });
    } else {
      st.provLassoActive = true;
      provLassoPoints.value = [world];
    }
    render();
    return;
  }

  // 「绘制」工具：按住拖动 = 自由绘制（原型 v7 的手感）。轨迹太短（其实只是单击）则不接管，
  // 仍由 onClick 的描点分支落一个顶点 —— 两条路径并存，能力不减。
  // 「描轮廓」（E，2026-10-11）复用**同一条采样**（同一个手势，只是松手后做的事不同）：
  //   画省份 = 新建一个省；描轮廓 = 把围住的这块地从邻省手里改到目标省。
  if ((tool.value === 'draw' || tool.value === 'outline') && event.button === 0) {
    if (store.isReadOnly) {
      statusMsg(`${tool.value === 'outline' ? '描轮廓' : '绘制'}已停用：${store.readOnlyReason}（新建/打开项目后即可编辑）`);
      return;
    }
    // 上一笔成型后若「那次 click 没送到」（松手点落在画布外），这里顺手清掉残留标记，
    // 免得下一次单击描点被静默吞掉（click 必定先于下一次 mousedown）
    st.suppressDrawClick = false;
    if (tool.value === 'outline' && !(baseMap.value?.terrain || []).length) {
      statusMsg('描轮廓：这张底图还没有省份 —— 先用「画省份」或「批量铺底」切出块来');
      return;
    }
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    st.freeTrace = [world];
    st.freeTraceActive = true;
    st.freeTraceRejectReason = '';
    beginStrokeBase();                              // 拖笔期：底图进基帧，每帧只画笔迹
    st.tracePreviewCache = { at: -1e9, ring: null };   // 新一笔：扔掉上一笔的预览形状
    render();
    return;
  }

  // ── 河流**橡皮**（2026-10-18 第十八修·三）：按住抹过去就擦 ────────────────────
  //    与绘图软件同款手势：不需要先选中、不需要挑节点。落库在抬手（`commitRiverErase`），
  //    拖动期间只有"擦除轨迹"这一份本地草稿在变 → 手势期基帧缓存照用。
  if (tool.value === 'riverErase' && event.button === 0) {
    if (store.isReadOnly) {
      statusMsg(`河流橡皮已停用：${store.readOnlyReason}（新建/打开项目后即可编辑）`);
      return;
    }
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    riverEraseStroke.value = [world];
    beginStrokeBase();
    render();
    return;
  }

  // ── 河流编辑器（2026-10-17 重做手势）────────────────────────────────────────
  // 🔴 核实过的真实现状（读代码 + 真机探针，不是猜的）：`onMouseMove` 里**根本没有**
  //    river 分支，而 `finishRiverDraft` 只挂在小双击上 —— 于是「河流 (W)」这个工具
  //    在真机上的全部能力是「点一下落一个点」，画布上的提示却写着"按住拖出笔迹"。
  //    用户要的是「流畅的笔刷绘制 + 事后可编辑可撤除」，所以这里补齐三件事：
  //      ① 按住拖动 = 连续采点（`onMouseMove` 的 river 分支）
  //      ② 松手 = 落库（`onMouseUp`），不再要求双击
  //      ③ 点河身加拐点 / 拖节点微调（本函数 + `onMouseMove` + `onMouseUp`）
  //    ⚠️ 分工靠 `st.suppressRiverClick` / `riverDrag` 传递，不能用局部变量：
  //       mousedown → mousemove* → mouseup → click 是**四个独立事件**。
  if (tool.value === 'river' && event.button === 0) {
    if (store.isReadOnly) {
      statusMsg(`画河流已停用：${store.readOnlyReason}（新建/打开项目后即可编辑）`);
      return;
    }
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    // ── 手势优先级（2026-10-18 第十五修·补；**这条是"依旧不能画支流"的真阻塞**）──────
    //    按下的落点可能**同时**命中"某个节点"与"某条河的河身"（节点就在河身上），
    //    而节点的命中容差是 24 屏像素（河很细，容差不放大就点不中）—— 于是**几乎整条河**
    //    都在节点容差里，支流永远起不了笔。实测症状极具误导性：状态栏显示
    //    「已移动第 10 个节点」而河身没动（那个"节点"其实是投影出来的最近节点）。
    //
    //    所以支流给一个**无歧义**的触发方式，顺序即语义：
    //      ① **Shift + 在河身上按下** → 画支流（Shift 是本仓既有的"第二功能"修饰键）；
    //      ② 按住**当前选中那条河的节点** → 拖动微调（既有能力，一字不改）；
    //      ③ 都没中但按在河身上 → 也当支流（离节点远时不必按 Shift）；
    //      ④ 都没中 → 画新河。
    let idx = riverActiveNode.value;
    if (idx < 0) idx = hitRiverNodeIndex(world.x, world.y);
    const sel = selectedRiver.value;
    const anchor = hitHandRiverBranchAnchor(world.x, world.y);
    const wantBranch = !!anchor && (event.shiftKey === true || !(idx >= 0 && sel && anchor.river.id === sel.id));
    const dragSelected = idx >= 0 && sel && !wantBranch;
    if (dragSelected) {
      riverDrag.value = {
        riverId: sel.id,
        index: idx,
        // 拖动草稿 = 与 store 解耦的一份点列（拖动期间只有它在变，松手才写回）
        points: (sel.points || []).map((p) => ({ x: p.x, y: p.y })),
        oldNodes: (sel.points || []).map((p) => ({ x: p.x, y: p.y })),
      };
      riverDraft.value = [];          // 拖节点不是画河：笔迹清掉，否则松手会凭空多一条
      riverDraftParentId.value = '';
      st.suppressRiverClick = false;     // 拖完之后的 click 要走"插入拐点"那条判断
      canvas.value.style.cursor = 'grabbing';
      beginStrokeBase();              // 拖节点期：底图进基帧（草稿全在 `riverDrag` 里）
      render();
      return;                         // 河流工具自己管手势，不再走下面的平移
    }
    // 支流：起点**吸附到河身**（而不是用户按下的那个像素），并记住母河；
    // 该点在母河折线上的位置（`segIndex`）也记下来 —— 落库时在那里**插一个拐点**，
    // 这样支流口与干流是**同一个坐标**，放大后不会出现"差半个像素没接上"。
    riverDraftParentId.value = anchor ? anchor.river.id : '';
    riverDraftParentSeg.value = anchor ? anchor.segIndex : -1;
    riverDraft.value = [anchor ? { x: anchor.point.x, y: anchor.point.y } : world];
    st.riverDraftCapped = false;         // 新的一笔：重新开始计数（上限是**每一笔**的）
    st.riverPreviewCache = { at: -1e9, pts: [] };   // 新的一笔：扔掉上一笔的预览形状
    beginStrokeBase();                // 拖笔期：底图进基帧，每帧只画笔迹
    st.suppressRiverClick = true;        // 这一笔由 mouseup 收口，click 不再落点
    if (anchor && event.shiftKey) statusMsg('支流模式：从这条河的河身起笔，拖出去松手即成支流');
    render();
    return;                           // 河流工具自己管手势，不再走下面的平移
  }

  // 笔刷工具：左键抬高 / 右键降低
  if (tool.value === 'height' && (event.button === 0 || event.button === 2)) {
    // 2026-10-27（B3「三个都画了，地形仿佛根本没变」）：高度笔刷只改高度图，而画布默认
    // 「陆海底色」档根本不吃高度 → 涂了完全看不出来。第一次落笔自动切到「地形高度」。
    if (rasterLayer.value !== 'height') {
      rasterLayer.value = 'height';
      statusMsg('已切到「地形高度」图层 —— 高度笔刷的改动只在这档看得见（涂完可用右上「底图图层」换回）');
    }
    st.isBrushing = true;
    st.brushMode = event.button === 0 ? 'raise' : 'lower';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyHeightBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushStrength.value, st.brushMode);
    return;
  }
  if (tool.value === 'lake' && event.button === 0) {
    // 湖泊（2026-10-27，SP-1025 语义）：平底 18/19；松手后按 h 重标海陆。
    if (rasterLayer.value !== 'height') {
      rasterLayer.value = 'height';
      statusMsg('已切到「地形高度」图层 —— 湖泊的改动只在这档看得见');
    }
    st.isBrushing = true;
    st.brushMode = 'lake';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyHeightBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushStrength.value, 'lake');
    return;
  }
  if (tool.value === 'biome' && event.button === 0) {
    // 群系色只在**底图编辑**视图里露出来（剧本模式被势力归属色整片盖住）—— 涂了没反应
    // 不是笔刷坏了，是当前视图把它盖住了。落笔时自动切到看得见的那一档。
    if (viewMode.value !== 'base') {
      viewMode.value = 'base';
      statusMsg('已切到「底图编辑」视图 —— 群系色在剧本模式会被势力色盖住（涂完可切回剧本）');
    }
    st.isBrushing = true;
    st.brushMode = 'biome';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyBiomeBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushBiome.value);
    return;
  }
  if (tool.value === 'culture' && event.button === 0) {
    // 文化/宗教色由「着色」下拉决定；不切这一档，笔画再对也看不出来
    if (colorMode.value !== 'culture') {
      colorMode.value = 'culture';
      statusMsg('已切到「着色：文化」—— 文化笔刷只在这档看得见');
    }
    st.isBrushing = true;
    st.brushMode = 'culture';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyCultureBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushCulture.value);
    return;
  }
  if (tool.value === 'religion' && event.button === 0) {
    if (colorMode.value !== 'religion') {
      colorMode.value = 'religion';
      statusMsg('已切到「着色：宗教」—— 宗教笔刷只在这档看得见');
    }
    st.isBrushing = true;
    st.brushMode = 'religion';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyReligionBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushReligion.value);
    return;
  }
  // marker 和 road 在 onCanvasClick 处理

  if (event.button === 0 && (tool.value === 'select' || tool.value === 'vertex')) {
    // 🔴 2026-10-17 第八修·三修（用户：「选择根本无法选中河」）：
    //    上一版我把河流命中放在 `onCanvasClick` 里。但「选择」工具在 **mousedown** 时
    //    就已经进入平移拖拽态（见下面 `st.panStart = …`）—— 只要手抖 1px，浏览器就不发
    //    `click`（click 要求按下与抬起在同一元素且无拖动）→ **河永远选不中**。
    //    这是"能力挂在错误的时机上"，不是判据问题。
    //    ⇒ 现在在 **mousedown 的第一时间**判定河：命中就选中并**吃掉这次按下**
    //      （不进入平移），没命中也**明确回一句**（带最近距离）——用户能看见"差多少"，
    //      而不是"点了没反应"。
    if (tool.value === 'select') {
      const rect = canvas.value.getBoundingClientRect();
      const world0 = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      const list = (baseMap.value?.rivers) || [];
      const radiusWorld = RIVER_SELECT_HIT_PX / Math.max(1e-6, cameraScale.value);
      const hit = hitTestRiver(list, world0.x, world0.y, radiusWorld, (r) => riverNodesForRender(r));
      if (hit) {
        // 不在这里选中（2026-10-27）：只记候选，**照常进平移** —— 松手位移 ≤4px 才算点选。
        // 这样「在河附近按住拖动看地图」不会变成选河，而点一下照旧能选中。
        st.pendingRiverPick = { id: hit.id, shift: !!event.shiftKey, x: event.clientX, y: event.clientY };
      } else {
        st.pendingRiverPick = null;
      }
      // 🔴 第五轮（2026-10-17）：Shift + 拖动 = **框选一批河**（用户点名「框选批量删河」）。
      //    只在不命中任何河时生效 —— 命中时 Shift 是"加选这一条"（上面那段）。
      if (!hit && event.shiftKey) {
        riverMarquee.value = { x0: world0.x, y0: world0.y, x1: world0.x, y1: world0.y };
        canvas.value.style.cursor = 'crosshair';
        beginStrokeBase();            // 框选期：底图进基帧，每帧只画框
        statusMsg('框选河流：拖出矩形，松手选中框内的河（Shift+点单条可加选）');
        render();
        return;
      }
    }
    // 顶点编辑模式：先判切线手柄，再判顶点
    if (tool.value === 'vertex' && selectedProvince.value) {
      const rect = canvas.value.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const prov = currentProvince();
      const threshold = px(8);
      const points = prov && provinceRings(prov).length ? resolvePoints(prov) : null;
      if (points) {
        // P0-T1：切线手柄命中（仅当前选中顶点）
        const ai = activeVertexIdx.value;
        if (ai >= 0 && ai < points.length && !st.altStraight) {
          const ap = points[ai];
          const hR = px(10);
          const out = ap.controlOut;
          const inn = ap.controlIn;
          if (out && Math.hypot(vx(ap) + out.x - world.x, vy(ap) + out.y - world.y) < hR) {
            draggingHandle.value = { provId: prov.id, vertexIdx: ai, which: 'out' };
            canvas.value.style.cursor = 'crosshair';
            beginStrokeBase();
            return;
          }
          if (inn && Math.hypot(vx(ap) + inn.x - world.x, vy(ap) + inn.y - world.y) < hR) {
            draggingHandle.value = { provId: prov.id, vertexIdx: ai, which: 'in' };
            canvas.value.style.cursor = 'crosshair';
            beginStrokeBase();
            return;
          }
        }
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const dx = vx(p) - world.x;
          const dy = vy(p) - world.y;
          if (Math.sqrt(dx * dx + dy * dy) < threshold) {
            // P1：点中的顶点若已在选中集里 → **整组一起搬**；点中别的 → 单选它（旧行为）
            if ((vertexSelection.value || []).indexOf(i) < 0) vertexSelection.value = [i];
            draggingVertex.value = { provId: prov.id, vertexIdx: i };
            activeVertexIdx.value = i;
            // 旧数据没有控制点：首次选中顶点时自动生成平滑切线（走 undo 栈）
            if (!p.controlIn && !p.controlOut) {
              store.updateBaseProvince(baseMapKey.value, prov.id, writeRingPoints(
                prov, activeRingIdx.value,
                withBezierControls(resolvePoints(prov).map(q => ({ x: vx(q), y: vy(q) }))),
              ));
              showSnapFeedback('已生成贝塞尔切线');
            }
            // 联动上下文**在这之后**取：上面那次切线写入会换掉省份对象，
            // 早取会拿到没有控制点的旧点集，拖动预览就会把切线丢掉。
            st.vertexLinkCtx = beginVertexLinkContext(currentProvince() || prov, i);
            render();
            canvas.value.style.cursor = 'grabbing';
            beginStrokeBase();          // ⚠️ 放在上面那次 store 写入**之后**：基帧是**懒建**的
            return;                     //    （第一次 render 时才建），这样切线补写已进基帧
          }
        }
        // P1：Shift + 空白处拖动 = **框选一批顶点**（与 PlanetMap 的框选手势一致）。
        // 刻意不占用普通拖动 —— 顶点模式下拖空白仍然是平移，手感不变。
        if (event.shiftKey) {
          st.vertexMarqueeStart = world;
          vertexMarquee.value = { x0: world.x, y0: world.y, x1: world.x, y1: world.y };
          canvas.value.style.cursor = 'crosshair';
          beginStrokeBase();
          render();
          return;
        }
      }
    }
    // 🔴 2026-10-14：顶点模式下 Shift+拖动**必须永远起得来框**，哪怕当前没有选中省份 /
    //    落点在选中省之外。为什么：这个手势的**前置条件**（先在「选择」里点一个省）
    //    完全不可见 —— 用户实测「我按 Shift 键似乎没什么作用」，而真实输入演练证明
    //    手势本身是通的（test_104）。所以问题不在手势、在**没有回音**：
    //    条件不满足时它就静默变成平移，用户看到的是"Shift 没用"。
    //    现在无论条件是否满足都给一条说明，并且框照样能拉（松手时告诉他框到了几个、
    //    该先点哪个省）。
    if (tool.value === 'vertex' && event.shiftKey) {
      const rect0 = canvas.value.getBoundingClientRect();
      const w0 = screenToWorld(event.clientX - rect0.left, event.clientY - rect0.top);
      st.vertexMarqueeStart = w0;
      vertexMarquee.value = { x0: w0.x, y0: w0.y, x1: w0.x, y1: w0.y };
      canvas.value.style.cursor = 'crosshair';
      beginStrokeBase();
      if (!currentProvince()) {
        statusMsg('框选只作用于**当前选中的省份**：先用「选择 (V)」点一下要精修的省，再按 Shift 拖框（现在也可以先拖，松手后会提示）');
      }
      render();
      return;
    }
    st.isPanning = true;
    st.panStart = { x: event.clientX, y: event.clientY };
    canvas.value.style.cursor = 'grabbing';
  }
}

  return { onMouseDown };
}
