#!/usr/bin/env node
/**
 * Node 单元测试：楼梯几何 + 楼板洞口（src/renderer/src/interior/stairs.js）
 *
 * 这一层守的是"2D 画的楼梯 = 3D 里的踏步 = 楼板上洞的位置"这三件事同源：
 *   · 踏步级数 / 升量 / 每级踏面标高由层标高推出来（不是写死 300）；
 *   · 洞口多边形必须把整个梯段罩住（罩不住 = 楼梯穿楼板）；
 *   · 楼板差集切出来的块必须**互不重叠**且**面积守恒**（面积不对 = 算漏了一块板）。
 *
 * 用法：node scripts/tests/unit/test_stairs.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'interior', 'stairs.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, tol, label) {
  if (!Number.isFinite(a) || Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

/** 一部沿 +x 走的楼梯：起点 (0,0)、终点 (300,0)、宽 100、18 级 */
function stair(extra = {}) {
  return {
    id: 'st1',
    start: { x: 0, y: 0 },
    end: { x: 300, y: 0 },
    width: 100,
    steps: 18,
    direction: 'up',
    ...extra,
  };
}

/** 多边形面积（鞋带公式，绝对值） */
function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 矩形面积 */
function rectArea(r) {
  return Math.max(0, r.u1 - r.u0) * Math.max(0, r.v1 - r.v0);
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const {
    STAIR_DEFAULTS, stairAxis, stairRise, stairStepCount, stairTreads,
    stairFootprint, stairHolePolygon, stairBoxes, subtractRects,
    orderFloorsByElevation, stairHolesForFloor, stairTargetFloor, stairDirection,
    stairOutsideInfo, fitStairInside,
  } = mod;

  check('t1 中心线：起点/终点/长度/单位方向/rotY 与墙同一套换算', () => {
    const a = stairAxis(stair());
    near(a.len, 300, 1e-9, '梯段长');
    near(a.dx, 1, 1e-9, 'dx');
    near(a.dy, 0, 1e-9, 'dy');
    near(a.rotY, 0, 1e-9, '沿 +x 的 rotY');
    // 沿 +y 走 → rotY = -90°（与墙一致：平面 y 就是世界的 z）
    const b = stairAxis(stair({ start: { x: 0, y: 0 }, end: { x: 0, y: 400 } }));
    near(b.rotY, -Math.PI / 2, 1e-9, '沿 +y 的 rotY');
    return '长 300 沿 +x';
  });

  check('t2 升量：由上下层标高算，没有目标层按默认层高（上行 +300 / 下行 -300）', () => {
    near(stairRise(stair(), { ownElevation: 0, targetElevation: 300 }), 300, 1e-9, '上行 300');
    near(stairRise(stair(), { ownElevation: 300, targetElevation: 620 }), 320, 1e-9, '层高 320');
    near(stairRise(stair({ direction: 'down' }), { ownElevation: 300, targetElevation: 0 }), -300, 1e-9, '下行 -300');
    near(stairRise(stair(), {}), STAIR_DEFAULTS.fallbackFloorHeight, 1e-9, '缺目标层回落 300');
    near(stairRise(stair({ direction: 'down' }), {}), -STAIR_DEFAULTS.fallbackFloorHeight, 1e-9, '下行缺目标层 -300');
    return '+300 / -300';
  });

  check('t3 级数：用户给的就用（夹 4~40），否则按 17.5cm 反算', () => {
    assert(stairStepCount(stair({ steps: 12 }), 300) === 12, '给定 12 级');
    assert(stairStepCount(stair({ steps: 2 }), 300) === 2 || stairStepCount(stair({ steps: 2 }), 300) >= 4,
      '过小的级数要抬起');
    assert(stairStepCount(stair({ steps: 999 }), 300) === STAIR_DEFAULTS.maxSteps, '上限夹住');
    // 300 / 17.5 ≈ 17.1 → 17
    assert(stairStepCount(stair({ steps: 0 }), 300) === 17, `反算 300cm → 17 级，实际 ${stairStepCount(stair({ steps: 0 }), 300)}`);
    assert(stairStepCount(stair({ steps: 0 }), 360) === 21, `360cm → 21 级，实际 ${stairStepCount(stair({ steps: 0 }), 360)}`);
    return '17 级 / 300cm';
  });

  check('t4 踏步：级数对得上，末级踏面 = 升量，板厚夹在 6~22', () => {
    const g = stairTreads(stair(), { ownElevation: 0, targetElevation: 300 });
    assert(g.treads.length === 18, `应有 18 级，实际 ${g.treads.length}`);
    near(g.treads[0].level, 300 / 18, 1e-9, '第一级踏面');
    near(g.treads[17].level, 300, 1e-9, '最后一级 = 升量（脚正好落到上一层地面）');
    near(g.treads[0].t0, 0, 1e-12, '第一级从起步端开始');
    near(g.treads[17].t1, 1, 1e-12, '最后一级到上落端结束');
    assert(g.thickness >= 6 && g.thickness <= 22, `板厚应夹在 6~22，实际 ${g.thickness}`);
    // 单调递增
    for (let i = 1; i < g.treads.length; i++) {
      assert(g.treads[i].level > g.treads[i - 1].level, '踏面标高必须递增');
    }
    return `18 级 / 踏面 ${(300 / 18).toFixed(1)}cm`;
  });

  check('t5 踏步盒：每级一块，宽度沿法向（sz），顶面落在该级踏面上', () => {
    const boxes = stairBoxes(stair(), { ownElevation: 300, targetElevation: 600 });
    assert(boxes.length === 18, `应有 18 块踏步，实际 ${boxes.length}`);
    const g = stairTreads(stair(), { ownElevation: 300, targetElevation: 600 });
    boxes.forEach((b, i) => {
      near(b.sz, 100, 1e-9, `第 ${i} 级梯段宽`);
      near(b.sy, g.thickness, 1e-9, `第 ${i} 级板厚`);
      // 顶面 = 层标高 + 该级踏面
      near(b.cy + b.sy / 2, 300 + g.treads[i].level, 1e-6, `第 ${i} 级顶面`);
      near(b.cx, 300 * (i + 0.5) / 18, 1e-6, `第 ${i} 级中心 x`);
      near(b.cz, 0, 1e-9, '沿 +x 走时 z 不变');
    });
    assert(boxes.every((b) => b.kind === 'stair'), '盒子 kind 必须是 stair');
    return '18 块，顶面逐级抬升';
  });

  check('t6 平面投影：宽 100 的梯段向两侧各 50，长度不外扩', () => {
    const fp = stairFootprint(stair());
    near(polyArea(fp.poly), 300 * 100, 1e-6, '投影面积 = 长 × 宽');
    const ys = fp.poly.map((p) => p.y).sort((a, b) => a - b);
    near(ys[0], -50, 1e-9, '一侧 50');
    near(ys[ys.length - 1], 50, 1e-9, '另一侧 50');
    return '300×100';
  });

  check('t7 洞口多边形：把整个梯段罩住（含余量），否则楼梯会穿楼板', () => {
    const fp = stairFootprint(stair());
    const hole = stairHolePolygon(stair());
    const hArea = polyArea(hole);
    const fArea = polyArea(fp.poly);
    assert(hArea > fArea, `洞口面积(${hArea}) 必须大于梯段投影(${fArea})`);
    // 梯段四角都要落在洞里（射线法 + 边界容忍：这里用"洞的包围盒"判，足够抓"洞偏了"）
    const xs = hole.map((p) => p.x); const ys = hole.map((p) => p.y);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    for (const p of fp.poly) {
      assert(p.x >= box.x0 - 1e-6 && p.x <= box.x1 + 1e-6 && p.y >= box.y0 - 1e-6 && p.y <= box.y1 + 1e-6,
        `梯段角点 (${p.x},${p.y}) 落在洞口外`);
    }
    // 上落端比起步端多留（人要走出去）
    assert(box.x1 - 300 > 0 - box.x0, `上落端余量(${(box.x1 - 300).toFixed(1)}) 应大于起步端(${(0 - box.x0).toFixed(1)})`);
    return `洞口 ${hArea.toFixed(0)} > 梯段 ${fArea.toFixed(0)}`;
  });

  check('t8 楼板差集：无洞 = 原矩形；中间一个洞 = 4 块且面积守恒', () => {
    const rect = { u0: -500, u1: 500, v0: -400, v1: 400 };
    const none = subtractRects(rect, []);
    assert(none.length === 1, '无洞应只返回一块');
    near(rectArea(none[0]), 800 * 1000, 1e-6, '无洞面积');

    const hole = { u0: 100, u1: 300, v0: -50, v1: 50 };
    const pieces = subtractRects(rect, [hole]);
    const sum = pieces.reduce((s, p) => s + rectArea(p), 0);
    near(sum, 800 * 1000 - 200 * 100, 1e-6, '挖洞后面积守恒');
    assert(pieces.length === 4, `中间一个洞应切成 4 块，实际 ${pieces.length}`);
    // 互不重叠：两两求交面积必须为 0
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i]; const b = pieces[j];
        const w = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
        const h = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0);
        assert(!(w > 1e-6 && h > 1e-6), `第 ${i} 块与第 ${j} 块重叠`);
      }
    }
    return '4 块 / 面积守恒';
  });

  check('t9 楼板差集：洞贴边 / 洞出界 / 洞盖满 / 洞重叠都不炸', () => {
    const rect = { u0: 0, u1: 1000, v0: 0, v1: 1000 };
    // 贴左边界
    const edge = subtractRects(rect, [{ u0: -50, u1: 200, v0: 400, v1: 600 }]);
    near(edge.reduce((s, p) => s + rectArea(p), 0), 1000 * 1000 - 200 * 200, 1e-6, '贴边洞面积');
    // 洞完全在界外 → 等于无洞
    const outside = subtractRects(rect, [{ u0: 2000, u1: 2100, v0: 0, v1: 100 }]);
    assert(outside.length === 1, '界外洞不应切块');
    // 盖满 → 空
    const full = subtractRects(rect, [{ u0: -10, u1: 1010, v0: -10, v1: 1010 }]);
    assert(full.length === 0, '洞盖满时不应剩板');
    // 两个重叠洞：只挖一次（面积不能扣两遍）
    const overlap = subtractRects(rect, [
      { u0: 100, u1: 400, v0: 100, v1: 400 },
      { u0: 300, u1: 600, v0: 300, v1: 600 },
    ]);
    near(overlap.reduce((s, p) => s + rectArea(p), 0),
      1e6 - (300 * 300) - (300 * 300) + (100 * 100), 1e-6, '重叠洞面积（只扣一次交集）');
    // 退化矩形
    assert(subtractRects({ u0: 5, u1: 5, v0: 0, v1: 10 }, []).length === 0, '零宽矩形应返回空');
    return '贴边/出界/盖满/重叠/退化 全过';
  });

  check('t10 楼层排序：按标高升序，同标高按 level，稳定不来回换位', () => {
    const floors = [
      { id: 'b', elevation: 300, level: 1 },
      { id: 'a', elevation: 0, level: 0 },
      { id: 'c', elevation: 300, level: 2 },
      { id: 'd', elevation: 150, level: 0.5 },
    ];
    const ordered = orderFloorsByElevation(floors).map((f) => f.id);
    assert(ordered.join(',') === 'a,d,b,c', `排序应是 a,d,b,c，实际 ${ordered.join(',')}`);
    return 'a,d,b,c';
  });

  check('t11 洞口归属：下层的上行梯开在上一层楼板；本层的下行梯开在本层楼板', () => {
    const f1 = { id: 'f1', elevation: 0, level: 0, stairs: [stair({ id: 's1' })] };
    const f2 = { id: 'f2', elevation: 300, level: 1, stairs: [] };
    const up = stairHolesForFloor([f1, f2], 'f2');
    assert(up.length === 1 && up[0].stairId === 's1', '2 层楼板应有 1 个洞，来自 1 层的上行梯');
    assert(stairHolesForFloor([f1, f2], 'f1').length === 0, '1 层楼板不该有洞（上行梯开在 2 层）');

    const g1 = { id: 'g1', elevation: 0, level: 0, stairs: [] };
    const g2 = { id: 'g2', elevation: 300, level: 1, stairs: [stair({ id: 's2', direction: 'down' })] };
    const down = stairHolesForFloor([g1, g2], 'g2');
    assert(down.length === 1 && down[0].stairId === 's2', '下行梯应开在自己这层的楼板上');
    return '上行开上层 / 下行开本层';
  });

  check('t12 目标层：上行找上一层、下行找下一层，没有就 null', () => {
    const f1 = { id: 'f1', elevation: 0, level: 0, stairs: [] };
    const f2 = { id: 'f2', elevation: 300, level: 1, stairs: [] };
    assert(stairTargetFloor([f1, f2], 'f1', stair()) === f2, '1 层上行 → 2 层');
    assert(stairTargetFloor([f1, f2], 'f2', stair()) === null, '2 层上行 → 没有上一层');
    assert(stairTargetFloor([f1, f2], 'f2', stair({ direction: 'down' })) === f1, '2 层下行 → 1 层');
    assert(stairDirection(stair()) === 'up' && stairDirection(stair({ direction: 'down' })) === 'down', '方向归一');
    assert(stairDirection(stair({ direction: '乱七八糟' })) === 'up', '未知方向回落 up');
    return 'up/down 都对';
  });

  check('t13 越界判定：全在房间内 = 0；一半露在外面 = 有比例；全在外 = 100%', () => {
    const room = { x0: -400, y0: -300, x1: 400, y1: 300 };
    const isInside = (p) => p.x >= room.x0 && p.x <= room.x1 && p.y >= room.y0 && p.y <= room.y1;
    const inside = stairOutsideInfo(stair({ start: { x: -200, y: -150 }, end: { x: -200, y: 150 } }), isInside);
    assert(inside.outside === 0, `房间内的楼梯不该有越界采样，实际 ${inside.outside}/${inside.samples}`);
    assert(inside.samples === 25, `默认 5×5 采样，实际 ${inside.samples}`);
    // 从 y=-150 拉到 y=450：后 1/3 在房间外
    const cross = stairOutsideInfo(stair({ start: { x: -200, y: -150 }, end: { x: -200, y: 450 } }), isInside);
    assert(cross.outside > 0 && cross.ratio > 0.15 && cross.ratio < 0.85,
      `跨墙的楼梯越界比例应在 15%~85%，实际 ${(cross.ratio * 100).toFixed(0)}%`);
    const far = stairOutsideInfo(stair({ start: { x: 2000, y: -150 }, end: { x: 2000, y: 150 } }), isInside);
    assert(far.ratio === 1, `完全在外的楼梯应为 100%，实际 ${(far.ratio * 100).toFixed(0)}%`);
    // 没有判定函数时不许炸（视图里房间还没围合时会传 undefined）
    assert(stairOutsideInfo(stair(), null).outside === 0, '无判定函数应返回 0 而不是抛错');
    return `跨墙 ${(cross.ratio * 100).toFixed(0)}%`;
  });

  check('t14 收进房间：跨墙的那跑能收进去且越界归零；收不进去时返回 null', () => {
    const room = { x0: -400, y0: -300, x1: 400, y1: 300 };
    const isInside = (p) => p.x >= room.x0 && p.x <= room.x1 && p.y >= room.y0 && p.y <= room.y1;
    const cross = stair({ start: { x: -200, y: -150 }, end: { x: -200, y: 450 } });
    assert(stairOutsideInfo(cross, isInside).outside > 0, '前提：这一跑本来就越界');
    const fit = fitStairInside(cross, isInside);
    assert(fit, '应能收进房间');
    const after = stairOutsideInfo({ ...cross, start: fit.start, end: fit.end }, isInside);
    assert(after.outside === 0, `收进后不该再越界，实际 ${after.outside}/${after.samples}`);
    const len = Math.hypot(fit.end.x - fit.start.x, fit.end.y - fit.start.y);
    assert(len >= 40, `收进后长度应 ≥40cm，实际 ${len.toFixed(0)}`);
    // 本来就在房间内：原样返回（不该被莫名缩短）
    const ok = stair({ start: { x: -200, y: -150 }, end: { x: -200, y: 150 } });
    const same = fitStairInside(ok, isInside);
    near(same.start.y, -150, 1e-6, '全在内时起点不该动');
    near(same.end.y, 150, 1e-6, '全在内时终点不该动');
    // 房间小到放不下（梯段宽 100、房间只有 30 宽）→ null，不假装成功
    const tiny = (p) => p.x >= -15 && p.x <= 15 && p.y >= -15 && p.y <= 15;
    assert(fitStairInside(cross, tiny) === null, '放不下时应返回 null');
    return `收进后 ${len.toFixed(0)}cm`;
  });

  const pass = results.filter((r) => r.ok).length;
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? `  —— ${r.detail}` : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('\n失败明细：');
    for (const r of results.filter((x) => !x.ok)) console.log(` - ${r.name}\n   ${r.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
