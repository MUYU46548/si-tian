#!/usr/bin/env node
/**
 * Node 单元测试：门的开合几何（src/renderer/src/interior/renderFloor.js#doorSwingGeometry，A12）
 *
 * 守的是制图规矩，四条：
 *   · 铰点在**门框一端**（默认洞口起点端），不在洞口中心；
 *   · 门扇长 = **洞口宽**（不是半个洞口），画在开启位置（垂直墙）；
 *   · 弧半径 = 洞口宽，从墙线扫到门扇，正好 **90°**；
 *   · `swingDirection` / `flipSide` 能翻到另一端 / 另一侧，且翻转后弧仍然 90°。
 *
 * 旧画法（圆心在洞口中心、半径取半个洞口）会在这里全部判红 —— 那就是它的问题。
 *
 * 用法：node scripts/tests/unit/test_door_swing.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'interior', 'renderFloor.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, tol, label) {
  if (!Number.isFinite(a) || Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

async function loadEsm(absPath) {
  const cache = new Map();
  const build = (p) => {
    if (cache.has(p)) return Promise.resolve(cache.get(p));
    const src = fs.readFileSync(p, 'utf8');
    const re = /from\s+'(\.\.?\/[^']+)';/g;
    const jobs = [];
    let m;
    while ((m = re.exec(src))) jobs.push({ at: m.index, end: m.index + m[0].length, spec: m[1] });
    const parts = [];
    let last = 0;
    const chain = jobs.reduce((p2, j) => p2.then(async () => {
      let child = path.resolve(path.dirname(p), j.spec);
      // 本仓 import 有的写扩展名、有的不写（`'../utils/interiorUnits'`）—— 补一次 .js
      if (!fs.existsSync(child) && fs.existsSync(child + '.js')) child += '.js';
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

/** 一面 400cm 长的横墙：(0,0) → (400,0)，厚 12。法向 = (0,1) */
const WALL = { id: 'w1', start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, thickness: 12 };
const DOOR = { kind: 'door', position: 0.5, width: 90, height: 210 };

async function main() {
  const mod = await loadEsm(SRC);
  const { doorSwingGeometry } = mod;
  assert(typeof doorSwingGeometry === 'function', 'renderFloor 没有导出 doorSwingGeometry');

  check('d1 铰点默认在洞口**起点端**（沿墙 start 侧），不在洞口中心', () => {
    const g = doorSwingGeometry(WALL, DOOR);
    near(g.hinge.x, 155, 1e-9, '铰点 x（200 - 45）');
    near(g.hinge.y, 0, 1e-9, '铰点 y（在墙线上）');
    assert(g.hinge.x !== g.center.x, '铰点不该在洞口中心');
    return `hinge (${g.hinge.x}, ${g.hinge.y})`;
  });

  check('d2 门扇长 = 洞口宽，方向垂直墙（法向）', () => {
    const g = doorSwingGeometry(WALL, DOOR);
    const len = Math.hypot(g.leaf.x - g.hinge.x, g.leaf.y - g.hinge.y);
    near(len, 90, 1e-9, '门扇长度（不是半个洞口）');
    near(g.leaf.x, g.hinge.x, 1e-9, '门扇垂直墙：x 不变');
    near(g.leaf.y, 90, 1e-9, '门扇开向 +y（墙的左法向）');
    return `长 ${len}cm`;
  });

  check('d3 弧半径 = 洞口宽，扫角正好 90°', () => {
    const g = doorSwingGeometry(WALL, DOOR);
    near(g.radius, 90, 1e-9, '弧半径');
    near(Math.abs(g.delta), Math.PI / 2, 1e-9, '扫角');
    return `${(Math.abs(g.delta) * 180 / Math.PI).toFixed(0)}°`;
  });

  check('d4 弧从墙线（关闭位置）扫起：起点角指向另一侧门框', () => {
    const g = doorSwingGeometry(WALL, DOOR);
    // 起点角 = 从铰点指向另一侧门框（245,0）→ 0 rad（+x）
    near(Math.cos(g.angStart), 1, 1e-9, '关闭位置在 +x');
    near(Math.sin(g.angStart), 0, 1e-9, '关闭位置在墙线上');
    return 'angStart = 0';
  });

  check('d5 swingDirection = right → 铰点换到另一端，弧方向翻转但仍是 90°', () => {
    const a = doorSwingGeometry(WALL, DOOR);
    const b = doorSwingGeometry(WALL, { ...DOOR, swingDirection: 'right' });
    near(b.hinge.x, 245, 1e-9, '铰点换到右端');
    near(b.leaf.x, 245, 1e-9, '门扇从新铰点出发');
    near(Math.abs(b.delta), Math.PI / 2, 1e-9, '扫角仍是 90°');
    assert(Math.sign(b.delta) === -Math.sign(a.delta), `弧方向应翻转：${a.delta} vs ${b.delta}`);
    return `delta ${a.delta.toFixed(2)} → ${b.delta.toFixed(2)}`;
  });

  check('d6 flipSide = true → 门扇开向墙的另一侧', () => {
    const a = doorSwingGeometry(WALL, DOOR);
    const b = doorSwingGeometry(WALL, { ...DOOR, flipSide: true });
    near(b.leaf.y, -90, 1e-9, '开向 -y');
    assert(Math.sign(b.delta) === -Math.sign(a.delta), '开向翻转时弧也翻转');
    near(Math.abs(b.delta), Math.PI / 2, 1e-9, '扫角仍是 90°');
    return 'y +90 → -90';
  });

  check('d7 门洞两端关于洞口中心对称（jamb 距中心各半个洞口宽）', () => {
    const g = doorSwingGeometry(WALL, DOOR);
    near(g.jambA.x, 155, 1e-9, '左门框');
    near(g.jambB.x, 245, 1e-9, '右门框');
    near(g.center.x, 200, 1e-9, '洞口中心');
    return '155 / 200 / 245';
  });

  check('d8 墙方向反过来（400,0 → 0,0）时，弧仍在同侧且 90°', () => {
    const rev = { ...WALL, start: { x: 400, y: 0 }, end: { x: 0, y: 0 } };
    const g = doorSwingGeometry(rev, DOOR);
    near(Math.abs(g.delta), Math.PI / 2, 1e-9, '扫角');
    near(Math.hypot(g.leaf.x - g.hinge.x, g.leaf.y - g.hinge.y), 90, 1e-9, '门扇长度');
    return '仍是 90° / 90cm';
  });

  check('d9 缺省值：不给 width 时按 90cm（与 store 的缺省一致）', () => {
    const g = doorSwingGeometry(WALL, { position: 0.5 });
    near(g.width, 90, 1e-9, '缺省洞口宽');
    near(g.radius, 90, 1e-9, '缺省弧半径');
    return '90cm';
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
