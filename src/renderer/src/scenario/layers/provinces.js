// scenario/layers/provinces.js — 剧本视图“省界”层（N1 刀 1，2026-10-30）
//
// 从 `ScenarioMap.vue` 搬出来：**省份填色/描边（含 EU4 斜线、选中描边）** 与 **省界两遍法**。
// 口径原样保留（改观感的事不在这一刀里）：
//   · 地形/温度/降水这类**栅格图层**打开时，省份只描边不填色（`fills:false`）；
//   · 海域省由 `landsea` 栅格的深度色带负责，不再盖 SEA_FILL，只留虚线海界；
//   · 同色 1.6px 描边抹掉相邻两省在共享弧上的亚像素缝；不填色时省界必须自己画出来；
//   · EU4 斜线底色用**旧主**色、斜线用**新主**色（不引入新色相）；
//   · 省界**两遍**：先全部普通界（不透明统一线宽），再叠选中/多选/合并目标。
//
// `view` 字段（由 `ScenarioMap.makeLayerView()` 提供）：
//   baseMap, rasterLayer, altStraight, px, SEA_EDGE, BORDER_COLOR,
//   PROVINCE_BORDER_COLOR, PROVINCE_BORDER_PX,
//   rawTerrain(), rawProvOf(prov), provincePathFor(rp, altStraight), getProvinceColor(rp),
//   timeline, eraIndex, date, diffMode, mode, isStriped(tl, k, id, at), polityColor(sc, owner),
//   provinceBBox(rp), selectedProvince, multiSelect, mergeProvId

/** 颜色是否不透明（半透明色描边会变成可见的深色轮廓线） */
export function isOpaqueColor(col) {
  if (typeof col !== 'string') return false;
  const m = col.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return true;                       // #rrggbb / 命名色 / hsl() → 当作不透明
  const parts = m[1].split(',').map((s) => s.trim());
  return parts.length < 4 || Number(parts[3]) >= 1;
}

// 2026-11-16（1 万/2 万省压测）：**每省的固定开销**是这一层的大头，但不是全部。
//   压测读数（`probe_scale_frames`，Vite+Edge headless，1080×634）：
//     3,000 省 暖帧 24.1ms ／ 10,000 省 292ms ／ 20,000 省 646ms
//   CPU 采样（2 万省，15 帧 6472ms）：restore 34.3% + save 13.6% + stroke 13.1%，
//   而真正的 `fill` 只有 4.6% —— 61% 花在“每个省两对 save/restore 加一次同色描边”上。
//
//   这一刀做了（**逐像素一致**：`drill_scenario_pixels --tag p20261116c` 主帧 hash 9910bd4 /
//   hashNoLabels 80b07d44 / riverHash 7be13ef5，与基线 v20261108l 三项全等）：
//     ① 整层一对 save/restore（原来每省 2 对 = 2 万省 4 万次状态栈进出）；
//     ② `politicalWash` / `px()` 提到循环外（一帧里是常量，原来每省现取 3~5 次）；
//     ③ `diffMode === 'outline'` 的 `changed.includes(id)` 改成按帧建一次 Set —— 原来是
//        每省一次 O(M) 线性查找（O(N·M)），语义不变只是换了查法。
//       （EU4 斜线 / 变化描边这两档仍然逐省：装饰必须压在**本省**的同色描边之上。）
//
//   实测结果（同一台机器，前后各跑一遍）：
//     · JS 侧 CPU：15 帧 6472ms → 4300ms（-33%）；
//     · **放大档帧时间 291~295ms → 28~69ms**（放大后大部分省在裁剪区外，省下的状态栈直接见效）；
//     · 适屏档帧时间基本没动（292 → 293~306ms）—— 因为瓶颈是**原生光栅化**（1 万次
//       stroke 相加 ≈ 180ms/帧），不是 JS。要动它必须换画法（省色块位图化），见
//       方寸卡 task-20261116-001，不在这一刀里。
//
//   🔴 试过并**否决**的写法（别再来一遍）：把同色描边按颜色合成 4 条 Path2D 一次描。
//      像素几乎一样（28px/最大差 1），但**性能是负的**：1 万省实测 stroke 从 45ms/帧
//      抬到 250ms/帧，整帧 301.6 → 575.6ms —— 一条 Path2D 里塞 2500 个闭合子路径，
//      Skia 的描边开销比“逐省小笔画”高约 5 倍。合批只对**一次性**的几何（省界第一遍）有效，
//      对“每帧都要描一遍”的路径反而更贵。
//
// 2026-11-16 第二刀（规模刀 2）：**省身改为可整幅烘焙的位图**（`scenario/provinceFillBake.js`）。
//   省数 ≥ 2000 且相机在适屏档时，整幅只烘一次、每帧 `drawImage` 一次；
//   位图失效键取对象引用（地形 / 剧本 / ownership / polities / 日期 / 档位），写口一换对象就重烘。
//   绘制实现仍然只有下面这一份 `paintProvinceBodies`（烘焙时 `px()` 换成烘焙分辨率）。
/**
 * 省身绘制：填色 + 同色描边 / 虚线海界 / 不填色时的省界。**唯一实现**。
 * 直接画（小项目、放大档、过渡期）与位图烘焙都走这里 —— 两份实现必然漂移。
 * 不在里面 save/restore：调用方负责外层状态。
 */
export function paintProvinceBodies(c, view, terrain, fills = true) {
  const alpha0 = c.globalAlpha;
  // 政治水洗（2026-11-03）：默认 1（= 旧口径，不透明）；浮雕底打开时 ~0.42
  const wash = view.politicalWash == null ? 1 : view.politicalWash;
  // 线宽/虚线段都是“相机 → 像素”的函数，一帧里不变：提到循环外
  const pxDash = view.px(6), pxGap = view.px(4), pxSea = view.px(1.2);
  const pxSame = view.px(1.6), pxNoFill = view.px(0.9);
  for (let i = 0; i < terrain.length; i++) {
    const rp = view.rawProvOf(terrain[i]);
    // 路径按省缓存（Path2D）：几何不变时每帧只做 fill/stroke，不再重描 2.4 万个顶点
    const path = view.provincePathFor(rp, view.altStraight);
    if (!path) continue;
    const fillCol = view.getProvinceColor(rp);
    // 政治档的海面由 `landsea` 栅格画**深度色带**；海域省再盖 SEA_FILL 会把青绿浅滩压成深蓝
    const seaFromRaster = rp.kind === 'sea' && view.rasterLayer === 'landsea';
    if (fills && !seaFromRaster) {
      // 地形浮雕底打开时用 politicalWash 让山体阴影/地形色从政治色下面透出来 ——
      // 这是“像 EU4”的构图比例（一屏 65% 地形 + 25% 政治 + 10% 线字）里最关键的一层。
      c.globalAlpha = wash;
      c.fillStyle = fillCol;
      // 多环实体：一条路径覆盖所有环；evenodd 与命中口径一致 → 洞真空、飞地真画
      c.fill(path, 'evenodd');
    }
    // 同色描边（~1px）：抹掉相邻省份之间的**亚像素缝**（共享弧两端 Chaikin 邻域不同）
    if (rp.kind === 'sea') {
      // 海界 = 淡虚线（实线是陆地省界，虚线一眼区分水陆）
      c.globalAlpha = alpha0;
      c.setLineDash([pxDash, pxGap]);
      c.strokeStyle = view.SEA_EDGE;
      c.lineWidth = pxSea;
      c.stroke(path);
      c.setLineDash([]);
    } else if (fills && isOpaqueColor(fillCol)) {
      // 同色描边也走同一个水洗值：否则浮雕底上会浮出一圈“实色描边”（比省身还重）
      c.globalAlpha = wash;
      c.strokeStyle = fillCol;
      // 1.6px：相邻两省各 0.8px 正好把 1~3px 的白点/针孔盖住
      c.lineWidth = pxSame;
      c.stroke(path);
    } else if (!fills) {
      // 不填色时，省界**必须**自己画出来（否则“没有省份”和“有省份”看起来一样）
      c.globalAlpha = alpha0;
      c.strokeStyle = view.BORDER_COLOR;
      c.lineWidth = pxNoFill;
      c.stroke(path);
    }
  }
}

export function drawProvincesLayer(c, view, opts = {}) {
  if (!view.baseMap || !view.baseMap.terrain) return;
  const fills = opts.fills !== false;
  const tl = view.timeline;
  const k = view.eraIndex;
  // 归属查询必须吃**日期**（月日精度）：同一年内 6 月前后归主不同
  const at = view.date;
  const scenarioMode = view.mode === 'scenario' && tl.scenarios.length > 0;
  const eu4 = scenarioMode && view.diffMode === 'eu4';
  const outline = scenarioMode && view.diffMode === 'outline';
  // ③ 变化省集合：原来每省一次 `changed.includes(id)` = O(N·M)
  const changedSet = (outline && k > 0) ? new Set(tl.eraChg[k]?.changed || []) : null;

  const terrain = view.rawTerrain();
  // 刀 2：省数够多且相机在适屏档 → 整幅位图（一帧一次 drawImage）；否则直接画（唯一实现同一份）
  // 依赖一律从 view 取（层的纪律）：位图由 `ScenarioMap` 注入，层自己不 import 渲染模块
  const bmp = (fills && typeof view.provinceFillBitmap === 'function')
    ? view.provinceFillBitmap(terrain, (bc, bv, bt) => paintProvinceBodies(bc, bv, bt, true))
    : null;
  c.save();                                   // 整层一对（原来每省 2 对）
  if (bmp) {
    c.globalAlpha = 1;
    c.imageSmoothingEnabled = true;
    c.drawImage(bmp.canvas, bmp.minX, bmp.minY, bmp.w, bmp.h);
  } else {
    paintProvinceBodies(c, view, terrain, fills);
  }

  // 装饰（EU4 斜线 / 变化描边）必须逐省：它们叠在**本省**省身之上
  // ⚠️ 第 0 代一律没有“上一代”→ `isStriped` 恒 false、`eraChg[0]` 也没有变化集，整段可以跳过
  //    （2 万省时这一跳省掉 2 万次 `isStriped`，是位图化之后剩下的最大一笔逐省开销）
  if (k > 0 && (eu4 || changedSet)) {
    for (let i = 0; i < terrain.length; i++) {
      const rp = view.rawProvOf(terrain[i]);
      const striped = eu4 && view.isStriped(tl, k, rp.id, at);
      const outlined = !striped && changedSet && changedSet.has(rp.id);
      if (!striped && !outlined) continue;
      const path = view.provincePathFor(rp, view.altStraight);
      if (!path) continue;
      // EU4 式斜线占领：底色是**旧主**色（上面刚填的），斜线用**新主**色
      if (striped) {
        const newCol = view.polityColor(tl.scenarios[k], tl.scenarios[k].ownership?.[rp.id]);
        const b = view.provinceBBox(rp);
        const dy = b.maxY - b.minY;
        const step = view.px(8.5);
        c.save();
        c.clip(path);                   // 复用缓存路径做裁剪
        c.globalAlpha = 0.92;
        c.strokeStyle = newCol;
        c.lineWidth = view.px(3.2);
        for (let t = b.minX - dy - 20; t < b.maxX + 20; t += step) {
          c.beginPath();
          c.moveTo(t, b.minY - 20);
          c.lineTo(t + dy + 40, b.maxY + 20);
          c.stroke();
        }
        c.restore();
        c.save();
        c.lineWidth = view.px(1.4);
        c.strokeStyle = newCol;
        c.stroke(path);
        c.restore();
      } else {
        c.save();
        c.lineWidth = view.px(2);
        c.strokeStyle = '#ffffff';
        c.stroke(path);
        c.restore();
      }
    }
  }
  c.restore();
}

/**
 * 国界层（2026-11-03）：三级线宽里缺的中间一级。
 *
 * 只画**共边两侧归属不同**的那些边（`view.polityBorderEdges()` 在共边索引上分拣，纯函数、不写数据）。
 * 一次 `beginPath` 收全体、只 `stroke` 一次 —— 415 省底图上国界边可能上千条，逐条 stroke 会掉帧。
 * 画在省界**之前**（order 55 < 省界两遍法）：0.7px 的细省界盖住 1.2px 国界的中线，
 * 读起来才是"国界线外面还有一圈省界"的 EU4 层级，而不是两条线抢同一条边。
 */
export function drawPolityBordersLayer(c, view) {
  if (!view.baseMap || !view.baseMap.terrain) return;
  if (typeof view.polityBorderEdges !== 'function') return;
  const edges = view.polityBorderEdges();
  if (!edges || !edges.length) return;
  c.save();
  c.strokeStyle = view.POLITY_BORDER_COLOR || 'rgba(46, 34, 26, 0.92)';
  c.lineWidth = view.px(view.POLITY_BORDER_PX == null ? 1.2 : view.POLITY_BORDER_PX);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  for (const e of edges) {
    c.moveTo(e.a.x, e.a.y);
    c.lineTo(e.b.x, e.b.y);
  }
  c.stroke();
  c.restore();
}

/**
 * 省份边界（**两遍**：先全部、再高亮）。
 * 逐省一遍 + 半透明会让**共边被描两次**（颜色更深，观感发灰）；0.6px 在 1080 宽画布上几乎看不见。
 */
export function drawProvinceBordersLayer(c, view) {
  if (!view.baseMap || !view.baseMap.terrain) return;
  const multi = view.multiSelect;
  const terrain = view.rawTerrain();
  // ── 第一遍：普通边界（不透明、统一线宽 —— 共边叠加也还是同一个色）────────
  // 🔴 2026-11-08 晚（3000 省压测）：原来逐省 `stroke(path)` —— 3000 次原生描边调用，
  //    CPU 采样里 `stroke` 占整帧 32%，其中这一层与河流是大头。第一遍是**一个颜色、一个线宽**，
  //    本来就可以合成一条路径一次描（`Path2D.addPath`）→ 3000 次 → 1 次。
  //    ⚠️ 唯一的差别在**共边处的抗锯齿**：同色笔画叠两次的覆盖度比合并后略高 → 共边淡一点点。
  //    主帧实测 **83 px / 480,600（0.017%）**、最大通道差 21，且只落在省界的抗锯齿带上
  //    （热图 `build/pixel-baseline/diff-v20261108k-v20261108l.png`）。不是线宽/颜色/位置的改变。
  //    浏览器没有 `addPath` 时退回逐省描边（行为与以前一字不差）。
  const canBatch = typeof Path2D === 'function'
    && typeof Path2D.prototype.addPath === 'function';
  c.save();
  c.strokeStyle = view.PROVINCE_BORDER_COLOR;
  c.lineWidth = view.px(view.PROVINCE_BORDER_PX);
  if (canBatch) {
    const all = new Path2D();
    let any = false;
    for (const prov of terrain) {
      const rp = view.rawProvOf(prov);
      // 边界与填充共用同一份 Path2D 缓存：每帧不再重描 2.4 万顶点
      const path = view.provincePathFor(rp, view.altStraight);
      if (!path) continue;
      all.addPath(path);
      any = true;
    }
    if (any) c.stroke(all);
  } else {
    for (const prov of terrain) {
      const rp = view.rawProvOf(prov);
      // 边界与填充共用同一份 Path2D 缓存：每帧不再重描 2.4 万顶点
      const path = view.provincePathFor(rp, view.altStraight);
      if (!path) continue;
      c.stroke(path);
    }
  }
  c.restore();
  // ── 第二遍：选中 / 多选 / 合并目标（只画这几个，顺序=层叠顺序）──────────────
  for (const prov of terrain) {
    const isSelected = view.selectedProvince && view.selectedProvince.id === prov.id;
    const isMulti = multi.has(prov.id);
    const isMergeTarget = view.mergeProvId === prov.id;
    if (!isSelected && !isMulti && !isMergeTarget) continue;
    const rp = view.rawProvOf(prov);
    const path = view.provincePathFor(rp, view.altStraight);
    if (!path) continue;
    // 多选描边用**青色 + 更粗**：单选白色 1.5px，两者叠在一起也看得出"这些是批量对象"
    c.strokeStyle = isMergeTarget ? '#ffd700' : (isMulti ? '#22d3ee' : '#ffffff');
    c.lineWidth = isMulti ? view.px(2.5) : view.px(1.5);
    c.stroke(path);
  }
}
