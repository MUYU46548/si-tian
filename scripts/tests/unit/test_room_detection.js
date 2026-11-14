#!/usr/bin/env node
/**
 * Node 单元测试：房间自动围合（src/renderer/src/utils/roomDetection.js）
 *
 * 这块是建筑内部地图的地基：**房间不手画，由墙围合出来**。
 * 算法来自 theLodgeBots/open3dFloorplan（MIT），改过四处（见文件头），这里逐条守住：
 *   t4 守"环遍历步数上限"（原版写死 20，大房间必漏）
 *   t6 守"面积上限"（原版 >1000㎡ 直接丢，宫殿会被整个丢掉）
 *   t7 守"房间只存墙 id、多边形现算"（改墙后房间必须跟着变）
 *
 * 用法：node scripts/tests/unit/test_room_detection.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'roomDetection.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, tol, label) {
  if (Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

/** 造墙：points 依次相连，闭合成环 */
let seq = 0;
function ring(pts) {
  const walls = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    walls.push({ id: `w${++seq}`, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } });
  }
  return walls;
}
/** 单段墙 */
function wall(x1, y1, x2, y2) {
  return { id: `w${++seq}`, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { detectRooms, getRoomPolygon, polygonArea, ptEq, DEFAULT_EPS } = mod;

  check('t1 矩形四墙：出一间，面积正确', () => {
    const rooms = detectRooms(ring([[0, 0], [400, 0], [400, 300], [0, 300]]));
    assert(rooms.length === 1, `应出 1 间，实际 ${rooms.length}`);
    near(rooms[0].area, 120000, 1, '面积 cm²');
    assert(rooms[0].walls.length === 4, `墙数应为 4，实际 ${rooms[0].walls.length}`);
    return `1 间 / ${Math.round(rooms[0].area / 10000 * 100) / 100} ㎡`;
  });

  check('t2 L 形六墙：出一间，面积 = 外接矩形减缺口', () => {
    // 400×400 缺右上 200×200
    const rooms = detectRooms(ring([[0, 0], [400, 0], [400, 200], [200, 200], [200, 400], [0, 400]]));
    assert(rooms.length === 1, `应出 1 间，实际 ${rooms.length}`);
    near(rooms[0].area, 400 * 400 - 200 * 200, 1, '面积');
    return `1 间 / ${rooms[0].area} cm²`;
  });

  check('t3 共享墙：外框 + 中间一道墙 → 两间（T 交点必须打断）', () => {
    const walls = [
      ...ring([[0, 0], [800, 0], [800, 400], [0, 400]]),
      wall(400, 0, 400, 400),
    ];
    const rooms = detectRooms(walls);
    assert(rooms.length === 2, `应出 2 间，实际 ${rooms.length}`);
    for (const r of rooms) near(r.area, 160000, 1, '每间面积');
    return `2 间 / 各 ${rooms[0].area} cm²`;
  });

  check('t4 大房间（14 面墙）：环遍历不被步数上限截断', () => {
    // 正 14 边形，半径 600 —— 原版 `step < 20` 在这里会漏
    const pts = [];
    for (let i = 0; i < 14; i++) {
      const a = (Math.PI * 2 * i) / 14;
      pts.push([Math.round(600 + 600 * Math.cos(a)), Math.round(600 + 600 * Math.sin(a))]);
    }
    const rooms = detectRooms(ring(pts));
    assert(rooms.length === 1, `应出 1 间，实际 ${rooms.length}（步数上限被截断？）`);
    assert(rooms[0].walls.length >= 13, `墙数应 ≥13，实际 ${rooms[0].walls.length}`);
    return `1 间 / ${rooms[0].walls.length} 面墙`;
  });

  check('t5 开口三墙：不闭合就不出房间', () => {
    const rooms = detectRooms([
      wall(0, 0, 400, 0), wall(400, 0, 400, 300), wall(400, 300, 0, 300),
    ]);
    assert(rooms.length === 0, `开口不该出房间，实际 ${rooms.length}`);
    return '0 间';
  });

  check('t6 宫殿级面积（30000×20000）：不被面积上限丢掉', () => {
    const rooms = detectRooms(ring([[0, 0], [30000, 0], [30000, 20000], [0, 20000]]), { eps: 50 });
    assert(rooms.length === 1, `宫殿应出 1 间，实际 ${rooms.length}（面积上限没放开？）`);
    near(rooms[0].area, 6e8, 10, '面积 cm²');
    return `1 间 / ${rooms[0].area / 10000} ㎡`;
  });

  check('t7 房间带顶点序：polygon 优先，缺了才按墙回拼', () => {
    const walls = ring([[0, 0], [400, 0], [400, 300], [0, 300]]);
    const rooms = detectRooms(walls);
    assert(Array.isArray(rooms[0].polygon) && rooms[0].polygon.length === 4,
      `检测结果应带 4 点顶点序，实际 ${JSON.stringify(rooms[0].polygon)}`);
    const fromStored = polygonArea(getRoomPolygon(rooms[0], walls));
    assert(fromStored === 120000, `用存储顶点算面积应为 120000，实际 ${fromStored}`);

    // 退掉 polygon（模拟老数据只有墙 id）→ 走回拼，矩形无 T 交点应仍正确
    const legacy = { walls: rooms[0].walls };
    const fromWalls = polygonArea(getRoomPolygon(legacy, walls));
    assert(fromWalls === 120000, `回拼面积应为 120000，实际 ${fromWalls}`);
    return `polygon ${rooms[0].polygon.length} 点 / 回拼 ${fromWalls} cm²`;
  });

  check('t8 端点差 1cm 仍闭合（靠 eps 聚合）', () => {
    const walls = [
      wall(0, 0, 400, 0), wall(400, 0, 400, 300),
      wall(400, 300, 0, 300), wall(0, 300, 0, 1),   // 最后一面差 1cm
    ];
    const rooms = detectRooms(walls, { eps: DEFAULT_EPS });
    assert(rooms.length === 1, `1cm 缝应被容差吃掉，实际 ${rooms.length} 间`);
    return `eps=${DEFAULT_EPS} 时闭合`;
  });

  check('t9 幂等：同一批墙跑两次结果一致', () => {
    const walls = [
      ...ring([[0, 0], [800, 0], [800, 400], [0, 400]]),
      wall(400, 0, 400, 400),
    ];
    const a = detectRooms(walls).map((r) => r.area).sort((x, y) => x - y);
    const b = detectRooms(walls).map((r) => r.area).sort((x, y) => x - y);
    assert(JSON.stringify(a) === JSON.stringify(b), `两次结果不同：${a} vs ${b}`);
    return `${a.length} 间一致`;
  });

  check('t10 脏数据：null / 零长墙 / 缺字段不抛异常', () => {
    const rooms = detectRooms([null, { id: 'x' }, wall(10, 10, 10, 10), undefined]);
    assert(rooms.length === 0, `脏数据不该出房间，实际 ${rooms.length}`);
    assert(ptEq({ x: 0, y: 0 }, { x: 1, y: 1 }, 2), 'eps=2 时 (0,0) 与 (1,1) 应视为同点');
    return '0 间 / 不抛';
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
