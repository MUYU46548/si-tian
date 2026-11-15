#!/usr/bin/env node
/**
 * Node 单元测试：家具 → 3D 体块（src/renderer/src/interior/furnitureBoxes.js + buildShell 接线）
 *
 * 守的是“轴测图里那间屋子不是空的，而且摆的位置就是平面图上摆的位置”：
 *   · 每件家具一块体积，高度按**类型查表**（床 45 / 桌 75 / 柜 180 …），不是拍脑袋的高度；
 *   · 平面 (x,y) 是左上角 → 三维中心 = (x + w/2, y + d/2)，与 `InteriorView#drawFurniture` 同一口径；
 *   · 旋转差一个负号（平面顺时针 → three 绕 y 逆时针），写反了会镜像而平面图完全正常；
 *   · 门/窗（墙上的开口）、院落/园林/走廊/水池/围墙（地面区域）**不许**变成家具体块；
 *   · 二层家具落在二层标高上（不是全落在地面）；
 *   · `options.furniture === false` 能整层关掉（实时预览不需要时省开销）。
 *
 * 用法：node scripts/tests/unit/test_furniture_boxes.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'src', 'renderer', 'src', 'interior');
const SRC_BOXES = path.join(DIR, 'furnitureBoxes.js');
const SRC_SHELL = path.join(DIR, 'buildShell.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, tol, label) {
  if (!Number.isFinite(a) || Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

/**
 * 把 ESM 源码按 data URL 载入，并把相对 import 递归换成子模块的 data URL
 * （本仓 .js 是 ESM，但 package.json 没写 type=module；与 test_building_shell.js 同一份手法）。
 */
async function loadEsm(absPath) {
  const cache = new Map();
  const build = (p) => {
    if (cache.has(p)) return Promise.resolve(cache.get(p));
    const src = fs.readFileSync(p, 'utf8');
    const re = /from\s+'(\.\/[^']+)';/g;
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

/** 一间 400×300、墙高 280 的矩形房 */
function rectRoom({ w = 400, d = 300, t = 12, h = 280, elevation = 0, id = 'f1', furniture = [] } = {}) {
  const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
  const walls = corners.map((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return { id: `${id}-w${i}`, start: { ...c }, end: { ...n }, thickness: t, height: h, color: '#8d7f6e' };
  });
  return { id, name: id, elevation, walls, doors: [], windows: [], furniture };
}

const bed = { id: 'fu1', type: 'bed', x: 40, y: 40, width: 200, height: 150, rotation: 0, color: '#4682b4' };
const table = { id: 'fu2', type: 'table', x: 260, y: 60, width: 140, height: 80, rotation: 90, color: '#a0522d' };
const wardrobe = { id: 'fu3', type: 'wardrobe', x: 20, y: 210, width: 120, height: 60, rotation: 0, color: '#6b4226' };

async function main() {
  const boxesMod = await loadEsm(SRC_BOXES);
  const shellMod = await loadEsm(SRC_SHELL);
  const { furnitureBoxes, furnitureHeight, isFurnitureBody, FURNITURE_HEIGHTS } = boxesMod;
  const { buildBuildingShell } = shellMod;

  check('f1 高度按类型查表：床 45 / 桌 75 / 柜 180 / 衣柜 200 / 椅 45 / 沙发 80', () => {
    const want = { bed: 45, table: 75, chest: 180, wardrobe: 200, chair: 45, sofa: 80 };
    for (const [k, v] of Object.entries(want)) {
      near(furnitureHeight(k), v, 1e-6, `高度 ${k}`);
      near(FURNITURE_HEIGHTS[k], v, 1e-6, `表内 ${k}`);
    }
    return '6 类对得上';
  });

  check('f2 表里没有的类型 / 空类型 → 兜底 70（不是 0，0 会让家具消失）', () => {
    near(furnitureHeight('spaceship'), 70, 1e-6, '未知类型');
    near(furnitureHeight(''), 70, 1e-6, '空类型');
    near(furnitureHeight(undefined), 70, 1e-6, 'undefined');
    return '70';
  });

  check('f3 盒子口径：中心 = 左上角 + 半个尺寸，sx=平面宽、sz=平面深、sy=类型高', () => {
    const [b] = furnitureBoxes([bed], 0);
    near(b.cx, 40 + 200 / 2, 1e-6, '中心 x');
    near(b.cz, 40 + 150 / 2, 1e-6, '中心 z（= 平面 y）');
    near(b.cy, 45 / 2, 1e-6, '中心高度 = 高度一半（落地）');
    near(b.sx, 200, 1e-6, 'sx = 平面宽');
    near(b.sz, 150, 1e-6, 'sz = 平面深');
    near(b.sy, 45, 1e-6, 'sy = 类型高');
    assert(b.kind === 'furniture', `kind 应为 furniture，实际 ${b.kind}`);
    assert(b.color === '#4682b4', '颜色应照抄家具自己的 color');
    return `床 ${b.sx}×${b.sz}×${b.sy}`;
  });

  check('f4 旋转差一个负号：rotation 90° → rotY = −π/2（写反会镜像）', () => {
    const [, t] = furnitureBoxes([bed, table], 0);
    near(t.rotY, -Math.PI / 2, 1e-9, 'rotY');
    const [z] = furnitureBoxes([{ ...bed, rotation: 0 }], 0);
    near(z.rotY, 0, 1e-9, '无旋转');
    return '−π/2';
  });

  check('f5 标高：二层（elevation 300）的床坐在 300cm 面上，不是地面', () => {
    const [b] = furnitureBoxes([bed], 300);
    near(b.cy, 300 + 45 / 2, 1e-6, '二层床中心高度');
    near(b.cy - b.sy / 2, 300, 1e-6, '床底面 = 本层地面');
    return '300 → 322.5';
  });

  check('f6 门/窗（墙上的开口）与院落/园林/走廊/水池/围墙（地面区域）不许变成体块', () => {
    const skip = ['door', 'window', 'courtyard', 'garden', 'corridor', 'pond', 'wall'];
    for (const type of skip) {
      assert(!isFurnitureBody({ ...bed, type }), `${type} 不该进 3D`);
    }
    const out = furnitureBoxes(skip.map((type, i) => ({ ...bed, id: `s${i}`, type })), 0);
    assert(out.length === 0, `跳过类应为 0 个盒子，实际 ${out.length}`);
    return '7 类全跳过';
  });

  check('f7 零面积 / 负尺寸 / 空数组 → 不生成盒子（不抛错）', () => {
    assert(furnitureBoxes([], 0).length === 0, '空数组');
    assert(furnitureBoxes(null, 0).length === 0, 'null');
    assert(furnitureBoxes([{ ...bed, width: 0 }], 0).length === 0, 'width 0');
    assert(furnitureBoxes([{ ...bed, height: -5 }], 0).length === 0, 'height 负');
    return '4 种无效输入';
  });

  check('f8 颜色：合法的六位 hex 照抄；rgba()/非法值回落缺省色（否则 Lambert 解析不到颜色）', () => {
    const [ok] = furnitureBoxes([{ ...bed, color: '#123abc' }], 0);
    assert(ok.color === '#123abc', 'hex 应照抄');
    const [bad] = furnitureBoxes([{ ...bed, color: 'rgba(0,0,0,0.4)' }], 0, { color: '#a89880' });
    assert(bad.color === '#a89880', `非法色应回落，实际 ${bad.color}`);
    const [none] = furnitureBoxes([{ ...bed, color: undefined }], 0);
    assert(none.color === '#a89880', `无 color 应回落缺省，实际 ${none.color}`);
    return '#123abc / 回落';
  });

  check('f9 buildShell 接线：一层三件家具 → boxes 里 3 个家具盒，stats.furniture = 3', () => {
    const r = buildBuildingShell([rectRoom({ furniture: [bed, table, wardrobe] })], { roof: { kind: 'flat' } });
    const fu = r.boxes.filter((b) => b.kind === 'furniture');
    assert(fu.length === 3, `家具盒应为 3，实际 ${fu.length}`);
    assert(r.stats.furniture === 3, `stats.furniture 应为 3，实际 ${r.stats.furniture}`);
    // 家具盒不许被算进墙/门窗
    assert(r.stats.walls === 4, `墙数不该变，实际 ${r.stats.walls}`);
    assert(r.stats.openings === 0, `门窗数不该变，实际 ${r.stats.openings}`);
    return `3 件 · 总盒 ${r.stats.boxes}`;
  });

  check('f10 options.furniture === false 整层关掉（实时预览省 mesh）', () => {
    const on = buildBuildingShell([rectRoom({ furniture: [bed, table] })], { roof: { kind: 'flat' } });
    const off = buildBuildingShell([rectRoom({ furniture: [bed, table] })], { roof: { kind: 'flat' }, furniture: false });
    assert(on.boxes.filter((b) => b.kind === 'furniture').length === 2, '开：2 个');
    assert(off.boxes.filter((b) => b.kind === 'furniture').length === 0, '关：0 个');
    assert(off.stats.furniture === 0, 'stats 也要是 0');
    assert(off.stats.walls === 4, '墙不受开关影响');
    return '2 → 0';
  });

  check('f11 家具盒全在房间内（400×300 房间里摆三件，包围盒不越墙）', () => {
    const r = buildBuildingShell([rectRoom({ furniture: [bed, table, wardrobe] })], { roof: { kind: 'flat' } });
    const fu = r.boxes.filter((b) => b.kind === 'furniture');
    for (const b of fu) {
      // 旋转 90° 的那张桌子：包围盒按旋转后的四个角算
      const cos = Math.cos(b.rotY || 0);
      const sin = Math.sin(b.rotY || 0);
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = b.cx + (dx * b.sx / 2) * cos + (dz * b.sz / 2) * sin;
        const z = b.cz - (dx * b.sx / 2) * sin + (dz * b.sz / 2) * cos;
        assert(x >= 0 && x <= 400, `家具角 x 越界：${x.toFixed(1)}`);
        assert(z >= 0 && z <= 300, `家具角 z 越界：${z.toFixed(1)}`);
      }
    }
    return '3 件全部在墙内';
  });

  check('f12 家具顶面不高于墙顶（280）：最矮的床与最高的衣柜都在室内净空里', () => {
    const r = buildBuildingShell(
      [rectRoom({ h: 280, furniture: [bed, table, wardrobe, { ...bed, id: 'x', type: 'chest' }] })],
      { roof: { kind: 'flat' } },
    );
    const fu = r.boxes.filter((b) => b.kind === 'furniture');
    const top = Math.max(...fu.map((b) => b.cy + b.sy / 2));
    assert(top <= 280, `家具顶面 ${top} 高于墙顶 280，穿出屋顶了`);
    return `最高 ${top.toFixed(0)}cm`;
  });

  check('f13 二层家具跟着二层标高：两层各摆一件 → 一个在地面、一个在 300 之上', () => {
    const f1 = rectRoom({ id: 'f1', elevation: 0, furniture: [bed] });
    const f2 = rectRoom({ id: 'f2', elevation: 300, furniture: [table] });
    const r = buildBuildingShell([f1, f2], { roof: { kind: 'flat' } });
    const fu = r.boxes.filter((b) => b.kind === 'furniture');
    assert(fu.length === 2, `应为 2 件，实际 ${fu.length}`);
    const bottoms = fu.map((b) => b.cy - b.sy / 2).sort((a, b) => a - b);
    near(bottoms[0], 0, 1e-6, '一层家具底面');
    near(bottoms[1], 300, 1e-6, '二层家具底面');
    return '0 / 300';
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
