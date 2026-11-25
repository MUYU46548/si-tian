#!/usr/bin/env node
/**
 * Node 单元测试：星域内 3D 总览的场景适配层（`galaxy/domain3dScene.js`）
 *
 * 这份模块是 E-4（多恒星系同屏）的**纯函数地基**：把司天的实体数组算成一份
 * "合批友好"的场景描述。性能风险全在"要画几批"上，所以这里**先钉死批次数**。
 *
 * 判据分五组：
 *   a) 基本形状：恒星/航道/边界的实例数与扁平数组长度对得上
 *   b) **合批结构**：position 是扁平 Float32Array，长度 = 实例数 × 分量数（这是合批的前提）
 *   c) 过滤纪律：跨域航道 / 自环 / 重复对 / 脏坐标，一条都不许进场景
 *   d) z 派生：确定性（同 id 同 z）、有厚度不越界、0 厚度时严格为 0
 *   e) 取景：fitCameraFor 单调性 + 边界情况
 *
 * 用法：node scripts/tests/unit/test_domain3d_scene.js
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const mod = await import(pathToFileURL(
    path.join(ROOT, 'src', 'renderer', 'src', 'galaxy', 'domain3dScene.js')).href);
  const { buildDomain3dScene, stableHash01, fitCameraFor,
    DOMAIN3D_STAR_RADIUS, DOMAIN3D_Z_THICKNESS } = mod;

  // ── 测试数据：一个星域 5 颗星 + 几条航道 ────────────────────────────────
  const domain = { id: 'd1', name: '测试星域' };
  const stars = [
    { id: 's1', name: '甲', x: 0, y: 0 },
    { id: 's2', name: '乙', x: 100, y: 0 },
    { id: 's3', name: '丙', x: 100, y: 120 },
    { id: 's4', name: '丁', x: 0, y: 120 },
    { id: 's5', name: '戊', x: 50, y: 60 },
  ];
  const lanes = [
    { id: 'L1', from: 's1', to: 's2' },
    { id: 'L2', from: 's2', to: 's3' },
    { id: 'L3', from: 's3', to: 's4' },
    { id: 'L4', from: 's4', to: 's1' },
  ];

  // ══ a) 基本形状 ══════════════════════════════════════════════════════
  check('a1 基本形状：5 星 / 4 段航道 / 计数与数组长度一致', () => {
    const sc = buildDomain3dScene({ domain, stars, hyperlanes: lanes, radius: 200 });
    assert(sc.stars.count === 5, '星数应为 5，实测 ' + sc.stars.count);
    assert(sc.lanes.segmentCount === 4, '航道应为 4，实测 ' + sc.lanes.segmentCount);
    assert(sc.counts.stars === 5 && sc.counts.laneSegments === 4, '计数不一致');
    assert(sc.stars.ids.length === 5 && sc.stars.names.length === 5, 'ids/names 长度不符');
    assert(sc.lanes.ids.length === 4, 'laneIds 长度不符');
    return `5 星 / 4 段 / 边界 ${sc.counts.borders}`;
  });

  check('a2 空输入不炸，给安全默认框', () => {
    const sc = buildDomain3dScene({});
    assert(sc.stars.count === 0 && sc.lanes.segmentCount === 0, '空输入应为 0 星 0 段');
    assert(Number.isFinite(sc.bbox.minX) && Number.isFinite(sc.bbox.maxX), 'bbox 必须是有限数');
    assert(sc.bbox.maxX > sc.bbox.minX, 'bbox 不该退化成一个点');
    return '空场景 bbox 安全';
  });

  // ══ b) 合批结构（B 方案能不能成立的关键）══════════════════════════════
  check('b1 恒星位置是扁平 Float32Array，长度 = n×3', () => {
    const sc = buildDomain3dScene({ domain, stars, hyperlanes: lanes, radius: 200 });
    assert(sc.stars.position instanceof Float32Array,
      '必须是 Float32Array（普通数组喂不了 InstancedMesh/BufferAttribute）');
    assert(sc.stars.position.length === 5 * 3, '长度应为 15，实测 ' + sc.stars.position.length);
    return '5×3 = 15 个 float';
  });

  check('b2 航道端点是扁平 Float32Array，长度 = 段数×6（两端点×xyz）', () => {
    const sc = buildDomain3dScene({ domain, stars, hyperlanes: lanes, radius: 200 });
    assert(sc.lanes.position instanceof Float32Array, '必须是 Float32Array');
    assert(sc.lanes.position.length === 4 * 6, '长度应为 24，实测 ' + sc.lanes.position.length);
    return '4×6 = 24 个 float';
  });

  check('b3 合批后 draw call 是常数（与星数无关）——这是当年搁置的那个顾虑', () => {
    const small = buildDomain3dScene({ domain, stars, hyperlanes: lanes, radius: 200 });
    // 造一个 30 星的大星域
    const bigStars = [];
    const bigLanes = [];
    for (let i = 0; i < 30; i++) {
      bigStars.push({ id: 'b' + i, name: '星' + i, x: (i % 6) * 100, y: Math.floor(i / 6) * 100 });
      if (i > 0) bigLanes.push({ id: 'BL' + i, from: 'b' + (i - 1), to: 'b' + i });
    }
    const big = buildDomain3dScene({ domain, stars: bigStars, hyperlanes: bigLanes, radius: 400 });
    assert(small.counts.drawCallsIfBatched === big.counts.drawCallsIfBatched,
      `合批后批次数应恒定，实测 5 星 ${small.counts.drawCallsIfBatched} vs 30 星 ${big.counts.drawCallsIfBatched}`);
    assert(big.counts.drawCallsIfBatched <= 3, '合批后应 ≤3 批');
    assert(big.counts.drawCallsIfNaive === 30 + 29,
      '逐 Mesh 才 ' + (30 + 29) + '，实测 ' + big.counts.drawCallsIfNaive);
    // 🔴 反向探针：如果哪天有人把合批改回逐对象，上面两条会一起红
    return `合批 ${big.counts.drawCallsIfBatched} 批 vs 逐对象 ${big.counts.drawCallsIfNaive} 批（30 星）`;
  });

  // ══ c) 过滤纪律 ══════════════════════════════════════════════════════
  check('c1 跨域航道不画（端点不在本星域）', () => {
    const sc = buildDomain3dScene({
      domain, stars, radius: 200,
      hyperlanes: [
        { id: 'in', from: 's1', to: 's2' },
        { id: 'out', from: 's1', to: 'OTHER_DOMAIN_STAR' },
      ],
    });
    assert(sc.lanes.segmentCount === 1, '只该留域内那一条，实测 ' + sc.lanes.segmentCount);
    assert(sc.lanes.ids[0] === 'in', '留下的必须是域内那条');
    return '跨域线被剔除';
  });

  check('c2 自环与重复对（含方向相反）都只画一次', () => {
    const sc = buildDomain3dScene({
      domain, stars, radius: 200,
      hyperlanes: [
        { id: 'a', from: 's1', to: 's2' },
        { id: 'b', from: 's2', to: 's1' },   // 反向重复
        { id: 'c', from: 's1', to: 's1' },   // 自环
      ],
    });
    assert(sc.lanes.segmentCount === 1, '应只剩 1 段，实测 ' + sc.lanes.segmentCount);
    return '自环 + 反向重复都收敛成 1 段';
  });

  check('c3 脏坐标的星被跳过并留 warning（不许进渲染）', () => {
    const sc = buildDomain3dScene({
      domain, radius: 200,
      stars: [
        { id: 'ok', name: '好的', x: 1, y: 2 },
        { id: 'nan', name: '坏的', x: NaN, y: 0 },
        { id: 'undef', name: '缺的' },
        { name: '没有id', x: 0, y: 0 },
      ],
    });
    assert(sc.stars.count === 1, '只该留 1 颗，实测 ' + sc.stars.count);
    assert(sc.warnings.length >= 2, '两条脏星应各留一条 warning，实测 ' + sc.warnings.length);
    return `${sc.stars.count} 星留下 / ${sc.warnings.length} 条 warning`;
  });

  check('c4 航道端点缺失时不崩（库里可能有悬空引用）', () => {
    const sc = buildDomain3dScene({
      domain, stars, radius: 200,
      hyperlanes: [{ id: 'ghost', from: 's1', to: 'NOT_EXIST' }],
    });
    assert(sc.lanes.segmentCount === 0, '端点不存在的航道应被跳过');
    return '悬空引用安全跳过';
  });

  // ══ d) z 派生 ════════════════════════════════════════════════════════
  check('d1 z 是确定性的：同 id 两次算出同一个值', () => {
    const a = buildDomain3dScene({ domain, stars, radius: 200 });
    const b = buildDomain3dScene({ domain, stars, radius: 200 });
    for (let i = 0; i < a.stars.position.length; i++) {
      assert(a.stars.position[i] === b.stars.position[i], '第 ' + i + ' 个分量不一致 —— z 混进了随机');
    }
    return '逐分量一致';
  });

  check('d2 z 落在厚度范围内，且厚度 0 时严格为 0', () => {
    const zHalf = DOMAIN3D_Z_THICKNESS * 200;
    const sc = buildDomain3dScene({ domain, stars, radius: 200 });
    for (let i = 0; i < sc.stars.count; i++) {
      const z = sc.stars.position[i * 3 + 2];
      assert(Math.abs(z) <= zHalf + 1e-6, `z=${z} 越界（上限 ±${zHalf}）`);
    }
    const flat = buildDomain3dScene({ domain, stars, radius: 200, zThickness: 0 });
    for (let i = 0; i < flat.stars.count; i++) {
      assert(flat.stars.position[i * 3 + 2] === 0, '厚度 0 时 z 必须严格为 0');
    }
    return `厚度 ±${zHalf.toFixed(1)} / 0 档严格平面`;
  });

  check('d3 stableHash01：确定性、落在 [0,1)、分布不退化', () => {
    assert(stableHash01('abc') === stableHash01('abc'), '同输入必须同输出');
    const vals = [];
    for (let i = 0; i < 500; i++) {
      const v = stableHash01('star_' + i);
      assert(v >= 0 && v < 1, '越界：' + v);
      vals.push(v);
    }
    const uniq = new Set(vals).size;
    assert(uniq > 450, '分布退化（500 个里只有 ' + uniq + ' 个不同值）');
    return `500 次取 500 个不同值中的 ${uniq} 个`;
  });

  // ══ e) 取景 ══════════════════════════════════════════════════════════
  check('e1 fitCameraFor：跨度越大距离越远（单调）', () => {
    const small = fitCameraFor({ minX: -50, minY: -50, minZ: 0, maxX: 50, maxY: 50, maxZ: 0 },
      { w: 1000, h: 600 });
    const big = fitCameraFor({ minX: -500, minY: -500, minZ: 0, maxX: 500, maxY: 500, maxZ: 0 },
      { w: 1000, h: 600 });
    assert(big.distance > small.distance, '大跨度应更远：' + big.distance + ' vs ' + small.distance);
    assert(Math.abs(small.center.x) < 1e-6 && Math.abs(small.center.y) < 1e-6, '中心应在原点');
    return '距离单调，中心正确';
  });

  check('e2 fitCameraFor：aspect 补偿 —— 宽 bbox 配窄画布必须退得更远', () => {
    // 🔴 这条断言我第一版写反了（2026-11-25 被它自己揪出来）：
    //    当时断言"宽画布更远"，但 bbox 是 1000 宽 × 200 高 —— 要把 1000 的横向跨度塞进
    //    400px 宽的视口，当然得退得更远。**窄画布才是更远的那个**。
    //    真正要防的 bug 是旧实现那种：拿 max(spanX, spanY) 当竖直跨度，
    //    于是宽 bbox 在宽画布上被算成 1340（实测），实际只要 279 —— 白退 4.8 倍，图会小得看不清。
    const bbox = { minX: -500, minY: -100, minZ: 0, maxX: 500, maxY: 100, maxZ: 0 };
    const wide = fitCameraFor(bbox, { w: 1920, h: 400 });
    const tall = fitCameraFor(bbox, { w: 400, h: 1920 });
    assert(tall.distance > wide.distance,
      '同一份宽 bbox 在窄画布上应更远（否则横向出画）：窄 ' + tall.distance + ' vs 宽 ' + wide.distance);

    // 反向探针：宽画布上不该把 1000 的横向跨度当成竖直跨度（那会退过头）
    const fov = (50 * Math.PI) / 180;
    const tanHalf = Math.tan(fov / 2);
    const needH = (500) / (tanHalf * (1920 / 400));     // 横向真正需要的距离
    assert(wide.distance < needH * 2,
      `宽画布退了 ${wide.distance.toFixed(1)}，横向只需要 ${(needH * 1.25).toFixed(1)} 左右 —— 退过头了（旧 bug 回来了）`);
    assert(wide.distance >= needH,
      `宽画布退得不够（${wide.distance.toFixed(1)} < ${needH.toFixed(1)}）—— 会横向出画`);
    return `窄 ${tall.distance.toFixed(0)} > 宽 ${wide.distance.toFixed(0)}（横向需 ${(needH * 1.25).toFixed(0)}）`;
  });

  check('e3 fitCameraFor：退化输入不产生 NaN / Infinity', () => {
    for (const bbox of [
      { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 0 },
    ]) {
      for (const v of [{ w: 0, h: 0 }, { w: -5, h: 10 }, {}, null]) {
        const r = fitCameraFor(bbox, v);
        assert(Number.isFinite(r.distance) && r.distance > 0, '距离非法：' + r.distance);
        assert(Number.isFinite(r.center.x), 'center.x 非法');
      }
    }
    return '退化输入全部安全';
  });

  // ══ f) 源码闸门 ══════════════════════════════════════════════════════
  check('f1 源码闸门：零 DOM / 零 three / 零 Math.random', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'galaxy', 'domain3dScene.js'), 'utf8');
    // ⚠️ 必须**先剥注释再扫**：第一版直接扫全文，`Math.random` 在注释里出现（"不依赖 Math.random"）
    //    就被判成违规 —— 假红。闸门自己也要遵守"别把注释当代码"。
    const code = src
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const bad = [];
    if (/\bdocument\./.test(code)) bad.push('碰了 document');
    if (/\bwindow\./.test(code)) bad.push('碰了 window');
    if (/require\(['"]three/.test(code) || /from ['"]three/.test(code)) bad.push('引了 three');
    if (/Math\.random/.test(code)) bad.push('用了 Math.random（会破坏确定性）');
    assert(!bad.length, bad.join('；'));
    assert(/export function buildDomain3dScene/.test(code), '缺 buildDomain3dScene');
    return '纯函数，无副作用（已剥注释）';
  });

  check('f2 常量导出齐备（调用方与测试共用一份）', () => {
    assert(Number.isFinite(DOMAIN3D_STAR_RADIUS) && DOMAIN3D_STAR_RADIUS > 0, '星半径常量非法');
    assert(Number.isFinite(DOMAIN3D_Z_THICKNESS), 'z 厚度常量非法');
    return `星半径 ${DOMAIN3D_STAR_RADIUS} / z 厚度 ${DOMAIN3D_Z_THICKNESS}`;
  });

  // ── 汇总 ────────────────────────────────────────────────────────────
  let pass = 0;
  for (const r of results) {
    if (r.ok) pass++;
    console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
