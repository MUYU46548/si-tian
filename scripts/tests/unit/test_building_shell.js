#!/usr/bin/env node
/**
 * Node 单元测试：建筑外观几何（src/renderer/src/interior/buildShell.js）
 *
 * 这一层守的是"3D 里看到的房子就是平面图画的那间"：
 *   · 墙按 thickness×height 挤出，抬起高度按 floor.elevation 叠；
 *   · 门窗是**真洞**（竖向切段），不是画个符号；弧墙上的门窗也不许消失；
 *   · 屋顶由墙端点推出来，坡顶的脊高、出檐、坡面数对得上。
 *
 * 用法：node scripts/tests/unit/test_building_shell.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'interior', 'buildShell.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, tol, label) {
  if (!Number.isFinite(a) || Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

/** 造一间矩形房：w×d（cm），原点在左上，墙厚 t，墙高 h */
function rectRoom({ w = 400, d = 300, t = 12, h = 280, elevation = 0, id = 'f1', doors = [], windows = [] } = {}) {
  const corners = [
    { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d },
  ];
  const walls = corners.map((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return { id: `w${i}`, start: { ...c }, end: { ...n }, thickness: t, height: h, color: '#8d7f6e' };
  });
  return {
    id, name: id, level: 0, elevation,
    walls,
    doors: doors.map((d2) => ({ kind: 'door', wallId: 'w0', position: 0.5, width: 90, height: 200, ...d2 })),
    windows: windows.map((w2) => ({ kind: 'window', wallId: 'w1', position: 0.5, width: 120, height: 140, sillHeight: 90, ...w2 })),
    furniture: [],
  };
}

/**
 * 把 ESM 源码按 data URL 载入（本仓 .js 是 ESM，但 package.json 没写 type=module，
 * 直接 import 磁盘路径会被当 CJS 解析）。
 *
 * 2026-11-15：buildShell 现在 `import ... from './stairs.js'` —— 单文件 data URL 解析不到
 * 相对路径，所以这里要**递归**把每个 `from './x.js'` 换成子模块的 data URL。
 * 只处理相对静态 import（这几个几何文件都不玩动态 import）。
 */
async function loadEsm(absPath) {
  const cache = new Map();
  const build = (p) => {
    if (cache.has(p)) return Promise.resolve(cache.get(p));
    const src = fs.readFileSync(p, 'utf8');
    const re = /from\s+'(\.[^']+)';/g;
    const jobs = [];
    let m;
    while ((m = re.exec(src))) jobs.push({ at: m.index, end: m.index + m[0].length, spec: m[1] });
    const parts = [];
    let last = 0;
    const chain = jobs.reduce((p2, j) => p2.then(async () => {
      const child = path.resolve(path.dirname(p), j.spec);
      const url = await build(child);
      parts.push(src.slice(last, j.at) + `from '${url}';`);
      last = j.end;
    }), Promise.resolve());
    return chain.then(() => {
      const out = parts.join('') + src.slice(last);
      const url = 'data:text/javascript;base64,' + Buffer.from(out, 'utf8').toString('base64');
      cache.set(p, url);
      return url;
    });
  };
  const url = await build(absPath);
  return import(url);
}

async function main() {
  const mod = await loadEsm(SRC);
  const { buildBuildingShell, hasWalls, ROOF_DEFAULTS, SHELL_DEFAULTS } = mod;

  check('s1 单面直墙：挤出成 1 个盒子，长=墙长+两侧半厚，厚/高照抄，中心在墙中点', () => {
    const floors = [{
      elevation: 0,
      walls: [{ id: 'w', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 12, height: 280 }],
      doors: [], windows: [],
    }];
    const r = buildBuildingShell(floors, { roof: { kind: 'flat' } });
    const walls = r.boxes.filter((b) => b.kind === 'wall');
    assert(walls.length === 1, `墙盒数应为 1，实际 ${walls.length}`);
    near(walls[0].sx, 412, 1e-6, '墙长（含两侧各外延 6）');
    near(walls[0].sz, 12, 1e-6, '墙厚');
    near(walls[0].sy, 280, 1e-6, '墙高');
    near(walls[0].cx, 200, 1e-6, '中心 x');
    near(walls[0].cz, 0, 1e-6, '中心 z');
    near(walls[0].cy, 140, 1e-6, '中心高度 = 280/2');
    near(walls[0].rotY, 0, 1e-9, '沿 +x 的墙 rotY = 0');
    return `1 盒 ${walls[0].sx}×${walls[0].sy}×${walls[0].sz}`;
  });

  check('s2 平面 (x,y) → 世界 (x, z=y)：朝下(y+)的墙 rotY = -90°', () => {
    const floors = [{
      elevation: 0,
      walls: [{ id: 'w', start: { x: 0, y: 0 }, end: { x: 0, y: 400 }, thickness: 12, height: 280 }],
      doors: [], windows: [],
    }];
    const r = buildBuildingShell(floors, { roof: { kind: 'flat' } });
    const b = r.boxes.find((x) => x.kind === 'wall');
    near(b.rotY, -Math.PI / 2, 1e-9, 'rotY');
    near(b.cz, 200, 1e-6, '中心 z = 平面 y');
    return '俯视方向与平面图一致';
  });

  check('s3 门（position .5，宽 90 高 200）：左右两段 + 上方 80 过梁 + 一块门扇', () => {
    const floors = [rectRoom({ doors: [{}] })];
    const r = buildBuildingShell(floors, { roof: { kind: 'flat' } });
    // w0 是 (0,0)→(400,0)，长 400
    const onW0 = r.boxes.filter((b) => Math.abs(b.cz) < 1e-6 && b.kind === 'wall');
    const lintel = onW0.find((b) => b.cy > 200);
    assert(!!lintel, '应有门上方过梁');
    near(lintel.sy, 80, 1e-6, '过梁高 = 280-200');
    near(lintel.cy, 240, 1e-6, '过梁中心 = 200+40');
    const sides = onW0.filter((b) => b.sy === 280).sort((a, b) => a.cx - b.cx);
    assert(sides.length === 2, `门前应有左右两段实墙，实际 ${sides.length}`);
    // 洞在 x∈[155,245]（中心 200 半宽 45）；左段外延 6 → 区间 [-6,155]，长 161，中心 74.5
    near(sides[0].cx, 74.5, 1e-6, '左段中心');
    near(sides[0].sx, 161, 1e-6, '左段长（含端点外延）');
    near(sides[1].cx, 325.5, 1e-6, '右段中心');
    const door = r.boxes.find((b) => b.kind === 'door');
    assert(!!door, '门扇应存在');
    near(door.sy, 200, 1e-6, '门扇高');
    near(door.sx, 90, 1e-6, '门扇宽 = 洞宽');
    return `过梁 80cm、门扇 90×200`;
  });

  check('s4 窗（宽 120 高 140 窗台 90）：下墙裙 90 / 上过梁 50 / 玻璃居中', () => {
    const floors = [rectRoom({ windows: [{}] })];
    const r = buildBuildingShell(floors, { roof: { kind: 'flat' } });
    const onW1 = r.boxes.filter((b) => Math.abs(b.cx - 400) < 1e-6 && b.kind === 'wall');
    const below = onW1.find((b) => b.cy < 90);
    const above = onW1.find((b) => b.cy > 230);
    assert(below, '应有窗下墙裙');
    near(below.sy, 90, 1e-6, '墙裙高');
    near(below.cy, 45, 1e-6, '墙裙中心');
    assert(above, '应有窗上过梁');
    near(above.sy, 50, 1e-6, '过梁高 = 280-(90+140)');
    const glass = r.boxes.find((b) => b.kind === 'window');
    assert(!!glass, '玻璃应存在');
    near(glass.cy, 160, 1e-6, '玻璃中心 = 90+70');
    return '窗洞是真洞（上下各留实体）';
  });

  check('s5 两层：elevation 300 的第二层整体抬高，屋顶压在最上层墙上', () => {
    const f1 = rectRoom({ elevation: 0, id: 'f1' });
    const f2 = rectRoom({ elevation: 300, id: 'f2' });
    const r = buildBuildingShell([f1, f2], { roof: { kind: 'flat' } });
    const ys = [...new Set(r.boxes.filter((b) => b.kind === 'wall').map((b) => Math.round(b.cy)))].sort((a, b) => a - b);
    assert(ys.includes(140) && ys.includes(440), `两层中心高度应是 140 / 440，实际 ${ys.join(',')}`);
    // 二层墙顶 = 300+280 = 580，平顶板在 580 之上
    const slab = r.boxes.filter((b) => b.kind === 'roof').sort((a, b) => b.cy - a.cy)[0];
    assert(slab && slab.cy > 580, `平顶应高于 580，实际 ${slab && slab.cy}`);
    return `墙顶 580，顶板 ${slab.cy}`;
  });

  check('s6 弧墙：采样成多段，各段长度之和 ≈ 弧长（±2%），且不只出一段', () => {
    // 起点(0,0) 终点(400,0) 控制点(200,200) 的二次贝塞尔
    const wall = { id: 'c', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, curvePoint: { x: 200, y: 200 }, thickness: 12, height: 280 };
    const r = buildBuildingShell([{ elevation: 0, walls: [wall], doors: [], windows: [] }], { roof: { kind: 'flat' } });
    const segs = r.boxes.filter((b) => b.kind === 'wall');
    assert(segs.length >= 8, `弧墙应被采样成多段，实际 ${segs.length}`);
    // 二次贝塞尔弧长（数值积分）
    let arc = 0;
    let prev = null;
    for (let i = 0; i <= 2000; i++) {
      const t = i / 2000;
      const mt = 1 - t;
      const p = { x: mt * mt * 0 + 2 * mt * t * 200 + t * t * 400, y: mt * mt * 0 + 2 * mt * t * 200 + t * t * 0 };
      if (prev) arc += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    const sum = segs.reduce((a, b) => a + b.sx, 0);
    // 端点外延 t/2 × 2 计入总长
    near(sum, arc + 12, arc * 0.02, '采样段总长 vs 弧长');
    return `${segs.length} 段，总长 ${sum.toFixed(1)}cm vs 弧长 ${arc.toFixed(1)}cm`;
  });

  check('s7 弧墙上的窗不许消失：仍切出墙裙/过梁/玻璃', () => {
    const wall = { id: 'c', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, curvePoint: { x: 200, y: 200 }, thickness: 12, height: 280 };
    const win = { id: 'g', wallId: 'c', position: 0.5, width: 120, height: 140, sillHeight: 90 };
    const r = buildBuildingShell([{ elevation: 0, walls: [wall], doors: [], windows: [win] }], { roof: { kind: 'flat' } });
    const glass = r.boxes.filter((b) => b.kind === 'window');
    assert(glass.length > 0, '弧墙上的窗玻璃不应消失');
    const segs = r.boxes.filter((b) => b.kind === 'wall');
    assert(segs.some((b) => b.cy < 90), '应有窗下墙裙');
    assert(segs.some((b) => b.cy > 230), '应有窗上过梁');
    return `玻璃 ${glass.length} 块`;
  });

  check('s8 坡顶：矩形 1000×800（出檐 45）→ 6 个三角面，脊高按短半×0.55 夹取', () => {
    const floors = [rectRoom({ w: 1000, d: 800 })];
    const r = buildBuildingShell(floors, { roof: { kind: 'gable' } });
    assert(r.roof.kind === 'gable', `屋顶类型，实际 ${r.roof.kind}`);
    assert(r.roof.tris.length === 6, `坡面三角数应为 6，实际 ${r.roof.tris.length}`);
    const hw = 500 + ROOF_DEFAULTS.overhang;   // 545
    const hd = 400 + ROOF_DEFAULTS.overhang;   // 445
    const expectRise = Math.min(hd * ROOF_DEFAULTS.riseRatio, ROOF_DEFAULTS.maxRise);
    near(r.roof.stats.ridgeHeight, expectRise, 1e-6, '脊高');
    near(r.roof.fascia.sx, 2 * hw, 1e-6, '檐口长（含出檐）');
    near(r.roof.fascia.sz, 2 * hd, 1e-6, '檐口宽（含出檐）');
    // 最高点 = 墙高 280 + 脊高
    near(r.bounds.max[1], 280 + expectRise, 1e-6, '包围盒最高点');
    return `脊高 ${expectRise.toFixed(1)}cm，出檐 ${ROOF_DEFAULTS.overhang}cm`;
  });

  check('s9 平顶：一块板 + 檐口，不产生三角面', () => {
    const r = buildBuildingShell([rectRoom({})], { roof: { kind: 'flat' } });
    assert(r.roof.kind === 'flat', '屋顶类型应为 flat');
    assert(r.roof.tris.length === 0, `平顶不应有三角面，实际 ${r.roof.tris.length}`);
    assert(r.roof.boxes.length === 1, '平顶应只有一块顶板');
    return '平顶 1 板 + 1 檐口';
  });

  check('s10 空数据不炸：无楼层 / 只有家具的老楼层 → empty，包围盒全 0', () => {
    for (const floors of [[], null, [{ furniture: [{ id: 'a' }], doors: [], windows: [] }]]) {
      const r = buildBuildingShell(floors, {});
      assert(r.empty === true, '应判空');
      assert(r.bounds.size.every((v) => v === 0), '空包围盒全 0');
      assert(r.roof === null, '无墙时不应有屋顶');
    }
    assert(hasWalls([]) === false, 'hasWalls(空) 应为 false');
    assert(hasWalls([{ walls: [{ id: 'w' }] }]) === true, 'hasWalls 应能识别有墙');
    return '空输入 → empty';
  });

  check('s11 门窗越界不炸：position 1.5 / 宽超墙长 / 高过墙高 → 被夹住且仍有墙', () => {
    const floors = [rectRoom({
      doors: [{ position: 1.5, width: 2000, height: 900 }],
      windows: [{ position: -0.3, width: 400, height: 500, sillHeight: 1200 }],
    })];
    const r = buildBuildingShell(floors, { roof: { kind: 'flat' } });
    assert(r.boxes.filter((b) => b.kind === 'wall').length > 0, '越界后仍应有墙');
    for (const b of r.boxes) {
      assert(Number.isFinite(b.cx) && Number.isFinite(b.cy) && Number.isFinite(b.cz), '盒子坐标必须有限');
      assert(b.sy > 0 && b.sx > 0 && b.sz > 0, '盒子尺寸必须为正');
    }
    return `共 ${r.boxes.length} 盒，坐标全有限`;
  });

  check('s12 转角补满：L 形两面墙的外延不重叠成缝隙（端点处盒子覆盖到角）', () => {
    const floors = [{
      elevation: 0,
      walls: [
        { id: 'a', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 12, height: 280 },
        { id: 'b', start: { x: 400, y: 0 }, end: { x: 400, y: 300 }, thickness: 12, height: 280 },
      ],
      doors: [], windows: [],
    }];
    const r = buildBuildingShell(floors, { roof: { kind: 'flat' } });
    const a = r.boxes.find((b) => b.kind === 'wall' && Math.abs(b.cz) < 1e-6);
    const b = r.boxes.find((b) => b.kind === 'wall' && Math.abs(b.cx - 400) < 1e-6);
    // 两面墙都各自在端点外延 6cm → 转角 (400,0) 一定被覆盖
    near(a.sx, 412, 1e-6, '横墙长');
    // 盒子恒为"局部 x = 沿墙方向"，靠 rotY 转向：竖墙的 312 落在 sx 上，sz 仍是墙厚
    near(b.sx, 312, 1e-6, '竖墙长');
    near(b.sz, 12, 1e-6, '竖墙厚');
    assert(a.cx + a.sx / 2 >= 400, '横墙应越过转角');
    return '两端各外延 6cm';
  });

  check('s13 口径自检：默认值仍是 cm（墙 12 厚 / 280 高 / 层高 300）', () => {
    assert(SHELL_DEFAULTS.wallThickness === 12, '墙厚默认 12cm');
    assert(SHELL_DEFAULTS.wallHeight === 280, '墙高默认 280cm');
    assert(SHELL_DEFAULTS.floorHeight === 300, '层高默认 300cm');
    assert(SHELL_DEFAULTS.windowSill === 90, '窗台默认 90cm');
    return '厘米口径';
  });

  check('s14 楼板：层高 300 / 墙高 280 时补一块 20cm 楼板，把层间透光缝填上', () => {
    const r = buildBuildingShell([rectRoom({ elevation: 0, id: 'f1' }), rectRoom({ elevation: 300, id: 'f2' })], { roof: { kind: 'flat' } });
    const slabs = r.boxes.filter((b) => b.kind === 'slab');
    assert(slabs.length === 1, `应有 1 块楼板，实际 ${slabs.length}`);
    near(slabs[0].sy, 20, 1e-6, '楼板厚 = 300-280');
    near(slabs[0].cy, 290, 1e-6, '楼板中心');
    // 覆盖整层：矩形 400×300
    near(slabs[0].sx, 400, 1e-6, '楼板长');
    near(slabs[0].sz, 300, 1e-6, '楼板宽');
    return '20cm 楼板 × 1';
  });

  check('s15 墙高 ≥ 层高时不补楼板（否则楼板会插进墙里）', () => {
    const r = buildBuildingShell([
      rectRoom({ elevation: 0, h: 300, id: 'f1' }),
      rectRoom({ elevation: 300, h: 300, id: 'f2' }),
    ], { roof: { kind: 'flat' } });
    assert(r.boxes.filter((b) => b.kind === 'slab').length === 0, '不该有楼板');
    return '无楼板';
  });

  check('s16 屋顶按面给法线依据：坡顶 4 个面（2 坡 + 2 山墙），三角面 6 个', () => {
    const r = buildBuildingShell([rectRoom({ w: 1000, d: 800 })], { roof: { kind: 'gable' } });
    assert(r.roof.faces.length === 4, `坡面数应为 4，实际 ${r.roof.faces.length}`);
    assert(r.roof.tris.length === 6, `三角面数应为 6，实际 ${r.roof.tris.length}`);
    const quads = r.roof.faces.filter((f) => f.length === 4).length;
    assert(quads === 2, `四边形坡面应为 2，实际 ${quads}`);
    return '2 坡 + 2 山墙';
  });

  check('s17 楼梯：两层楼 + 一部上行梯 → 18 块踏步，末级踏面 = 上一层地面', () => {
    const f1 = rectRoom({ elevation: 0, id: 'f1' });
    const f2 = rectRoom({ elevation: 300, id: 'f2' });
    f1.stairs = [{
      id: 'st1', start: { x: 100, y: 150 }, end: { x: 400, y: 150 }, width: 100, steps: 18,
    }];
    const r = buildBuildingShell([f1, f2], { roof: { kind: 'flat' } });
    const steps = r.boxes.filter((b) => b.kind === 'stair');
    assert(steps.length === 18, `应有 18 块踏步，实际 ${steps.length}`);
    assert(r.stats.stairs === 1, `stats.stairs 应为 1，实际 ${r.stats.stairs}`);
    // 最高一级的**顶面** = 300（上一层地面标高），误差取板厚的一半以内
    const top = Math.max(...steps.map((b) => b.cy + b.sy / 2));
    near(top, 300, 1e-6, '末级踏面 = 上一层地面');
    // 楼梯沿 +x 走 → sz 是梯段宽，sx 是单级进深
    near(steps[0].sz, 100, 1e-9, '梯段宽');
    near(steps[0].sx, 300 / 18, 1e-6, '单级进深 = 梯段长/级数');
    return '18 块，0→300cm';
  });

  check('s18 楼板开洞：楼梯所在的楼板被切碎，洞的面积 = 梯段宽+余量 × 梯段长+余量', () => {
    const f1 = rectRoom({ elevation: 0, id: 'f1', w: 800, d: 600 });
    const f2 = rectRoom({ elevation: 300, id: 'f2', w: 800, d: 600 });
    f1.stairs = [{
      id: 'st1', start: { x: 100, y: 300 }, end: { x: 400, y: 300 }, width: 100, steps: 18,
    }];
    const withHole = buildBuildingShell([f1, f2], { roof: { kind: 'flat' } });
    const pieces = withHole.boxes.filter((b) => b.kind === 'slab');
    assert(pieces.length >= 2, `楼板应被切碎，实际 ${pieces.length} 块`);
    const slabArea = pieces.reduce((s, b) => s + b.sx * b.sz, 0);
    // 楼板外用 800×600 的墙端点矩形（minAreaRect 就是它），挖掉的洞：
    // 宽 = 100 + 2*10 余量 = 120；长 = 300 + 5 + 10 = 315
    const expect = 800 * 600 - 120 * 315;
    near(slabArea, expect, 1e-3, '楼板净面积 = 整板 − 洞口');
    // 对照：同一栋楼没有楼梯 → 整块
    f1.stairs = [];
    const noHole = buildBuildingShell([f1, f2], { roof: { kind: 'flat' } });
    assert(noHole.boxes.filter((b) => b.kind === 'slab').length === 1, '无楼梯时楼板应是一整块');
    return `${pieces.length} 块，净面积 ${slabArea.toFixed(0)}`;
  });

  check('s19 屋顶设为不封顶：kind=none 时不生成屋顶（看得见楼梯与楼板洞口）', () => {
    const r = buildBuildingShell([rectRoom({})], { roof: { kind: 'none' } });
    assert(r.roof === null, '不封顶时不应有屋顶');
    assert(!r.empty, '墙还在，不算空');
    return '无屋顶';
  });

  // ── A23/A15：房间地面 / 吊顶面（2026-11-15）────────────────────────────
  const rectPoly = (w = 400, d = 300) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
  const roomOf = (mask = {}, poly) => Object.assign({
    id: 'r1', name: '客厅', walls: ['w0', 'w1', 'w2', 'w3'],
    floorTexture: 'wood', polygon: poly || rectPoly(),
  }, mask);
  const triArea = (tris) => tris.reduce((s, t) => {
    const a = t[0]; const b = t[1]; const c = t[2];
    return s + Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
  }, 0);

  check('s20 房间地面（A23）：一间房 → 1 块面、2 个三角形，颜色来自材质', () => {
    const f = rectRoom({});
    f.rooms = [roomOf()];
    const r = buildBuildingShell([f], { roof: { kind: 'none' } });
    const floors = r.surfaces.filter((s) => s.kind === 'room-floor');
    assert(floors.length === 1, `应只有 1 块房间地面，实际 ${floors.length}`);
    assert(floors[0].tris.length === 2, `矩形应切成 2 个三角形，实际 ${floors[0].tris.length}`);
    assert(/^#[0-9a-f]{6}$/i.test(floors[0].color), `颜色必须是 #hex：${floors[0].color}`);
    assert(r.stats.roomFloors === 1, `统计 roomFloors 应为 1，实际 ${r.stats.roomFloors}`);
    assert(r.stats.ceilings === 0, '没设吊顶时不该有天花板');
    // 地面必须抬 1cm（避免与地面/楼板共面 z-fighting）
    const ys = floors[0].tris.flat().map((p) => p[1]);
    near(Math.min(...ys), 1, 1e-6, '地面标高');
    return `1 块 / 2 三角形 / 面积 ${triArea(floors[0].tris)}`;
  });

  check('s21 吊顶（A15）：默认不生成，显式打开才画；净高超过墙顶被夹住', () => {
    const f = rectRoom({ h: 280 });
    f.rooms = [roomOf({ floorTexture: 'tile', ceiling: { texture: 'plaster', height: 240 } })];
    const off = buildBuildingShell([f], { roof: { kind: 'none' } });
    assert(off.stats.ceilings === 0, `默认应不生成吊顶（否则会盖住房间），实际 ${off.stats.ceilings}`);

    const on = buildBuildingShell([f], { roof: { kind: 'none' }, ceilings: true });
    assert(on.stats.ceilings === 1, `打开后应有 1 间吊顶，实际 ${on.stats.ceilings}`);
    const ceil = on.surfaces.find((s) => s.kind === 'room-ceiling');
    near(Math.min(...ceil.tris.flat().map((p) => p[1])), 240, 1e-6, '吊顶标高 = 净高');

    // 净高 800 打进 280 墙高的房间 → 夹到墙顶，不许飘在墙上方
    f.rooms[0].ceiling = { texture: 'plaster', height: 800 };
    const clamp = buildBuildingShell([f], { roof: { kind: 'none' }, ceilings: true });
    near(Math.min(...clamp.surfaces.find((s) => s.kind === 'room-ceiling').tris.flat().map((p) => p[1])),
      280, 1e-6, '超过墙顶应夹到墙顶');
    return '默认 0 / 打开 1 / 净高夹到墙顶';
  });

  check('s22 L 形房间：三角面积守恒，不会铺到隔壁（包围盒近似会多铺）', () => {
    // 400×300 的方框里挖掉右下 250×150：面积 = 400*150 + 150*150 = 82500
    const Lpoly = [
      { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 150 },
      { x: 150, y: 150 }, { x: 150, y: 300 }, { x: 0, y: 300 },
    ];
    const f = rectRoom({});
    f.rooms = [roomOf({ polygon: Lpoly })];
    const r = buildBuildingShell([f], { roof: { kind: 'none' } });
    const floor = r.surfaces.find((s) => s.kind === 'room-floor');
    assert(floor.tris.length === Lpoly.length - 2, `L 形应切成 n−2=4 个三角形，实际 ${floor.tris.length}`);
    const area = triArea(floor.tris);
    near(area, 82500, 1e-3, '三角面积和');
    assert(area < 400 * 300 - 1, '面积应小于包围盒（判据本身要能区分）');
    return `4 三角形 / 面积 ${area}（包围盒 120000）`;
  });

  check('s23 rooms:false 可关掉房间面（实时预览不需要时省几何）', () => {
    const f = rectRoom({});
    f.rooms = [roomOf({ ceiling: { texture: 'plaster', height: 240 } })];
    const r = buildBuildingShell([f], { roof: { kind: 'none' }, ceilings: true, rooms: false });
    assert(r.surfaces.length === 0, `关掉后不该有房间面，实际 ${r.surfaces.length}`);
    return '0 块面';
  });

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : '  FAIL'}  ${r.name}${r.detail ? `  —— ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('\n失败明细：');
    for (const r of bad) console.log(` - ${r.name}\n   ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
