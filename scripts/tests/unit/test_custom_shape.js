/**
 * interior/customShape.js 单测（2026-11-14，家具自定义绘制）
 *
 * 这一层是坐标换算，错了表现为「画完形状跑偏/跟着家具转」。所以断言里既要验数值，
 * 也要验**旋转下的往返一致**（画 0°、45°、90° 各一次）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/customShape.js')).href);
const {
  furnitureCenter, worldToLocal, localToWorld,
  worldPointsToCustom, customToWorldPoints, sanitizeCustom,
} = mod;

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push({ name, ok: true, note });
    console.log(`  ✅ ${name}${note ? ` —— ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: e && e.message });
    console.log(`  ❌ ${name} —— ${e && e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}：期望 ${b}，实际 ${a}`);
}

/** 一件 200×100 的家具，左上角在 (100, 200) → 中心 (200, 250) */
const item = { id: 'f1', x: 100, y: 200, width: 200, height: 100, rotation: 0 };

check('c1 中心点与本地坐标：中心自身映射为 (0,0)，四角映射为 ±w/2、±h/2', () => {
  const c = furnitureCenter(item);
  near(c.x, 200, 1e-9, '中心 x');
  near(c.y, 250, 1e-9, '中心 y');
  const o = worldToLocal({ x: 200, y: 250 }, item);
  near(o.x, 0, 1e-9, '本地原点 x');
  near(o.y, 0, 1e-9, '本地原点 y');
  const tl = worldToLocal({ x: 100, y: 200 }, item);
  near(tl.x, -100, 1e-9, '左上 x');
  near(tl.y, -50, 1e-9, '左上 y');
  return '中心/左上';
});

check('c2 旋转 90°：世界点先反旋转再归一化（否则形状会跟着家具转跑偏）', () => {
  const rotated = { ...item, rotation: 90 };
  // 世界 +x 方向上的点，在旋转 90° 的家具本地坐标系里应落在 -y 方向
  const l = worldToLocal({ x: 250, y: 250 }, rotated);
  near(l.x, 0, 1e-9, '本地 x');
  near(l.y, -50, 1e-9, '本地 y（+x 世界 → -y 本地）');
  return '90° 反解';
});

check('c3 往返一致：world → local → world 在 0/45/90/180/270 度下都还原', () => {
  for (const rot of [0, 45, 90, 180, 270, -30]) {
    const it = { ...item, rotation: rot };
    for (const p of [{ x: 130, y: 220 }, { x: 260, y: 300 }, { x: 200, y: 250 }]) {
      const back = localToWorld(worldToLocal(p, it), it);
      near(back.x, p.x, 1e-9, `rot=${rot} x`);
      near(back.y, p.y, 1e-9, `rot=${rot} y`);
    }
  }
  return '6 个角度 × 3 点';
});

check('c4 三点归一化：左上角→(0,0)、右下角→(1,1)、中心→(0.5,0.5)', () => {
  const custom = worldPointsToCustom(
    [{ x: 100, y: 200 }, { x: 300, y: 300 }, { x: 200, y: 250 }], item,
  );
  assert(custom && custom.points.length === 3, '应得到 3 点');
  near(custom.points[0].x, 0, 1e-9, '左上 x');
  near(custom.points[0].y, 0, 1e-9, '左上 y');
  near(custom.points[1].x, 1, 1e-9, '右下 x');
  near(custom.points[1].y, 1, 1e-9, '右下 y');
  near(custom.points[2].x, 0.5, 1e-9, '中心 x');
  near(custom.points[2].y, 0.5, 1e-9, '中心 y');
  assert(custom.closed === true && custom.fill === true, '默认闭合 + 填充');
  return '0,0 / 1,1 / 0.5,0.5';
});

check('c5 少于 3 点 / 尺寸为 0 → null（不构成面，不许写进项目）', () => {
  assert(worldPointsToCustom([{ x: 1, y: 1 }, { x: 2, y: 2 }], item) === null, '2 点应 null');
  assert(worldPointsToCustom([], item) === null, '空数组应 null');
  assert(worldPointsToCustom(null, item) === null, 'null 应 null');
  assert(worldPointsToCustom([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }], { ...item, width: 0 }) === null, '宽 0 应 null');
  return '4 种非法输入';
});

check('c6 画到框外的点：自动撑大包围框（中心不动），不 clamp、不丢点', () => {
  const custom = worldPointsToCustom(
    [{ x: 0, y: 150 }, { x: 400, y: 350 }, { x: 200, y: 250 }], item,
  );
  assert(custom.points.length === 3, '点数不许少');
  // 本地最远到 ±200 / ±100 → 新框 400×200，中心不动 (200,250)
  near(custom.extent.width, 400, 1e-6, '撑大后宽');
  near(custom.extent.height, 200, 1e-6, '撑大后高');
  near(custom.extent.x, 0, 1e-6, '新左上 x');
  near(custom.extent.y, 150, 1e-6, '新左上 y');
  near(custom.extent.x + custom.extent.width / 2, 200, 1e-6, '中心 x 不动');
  near(custom.extent.y + custom.extent.height / 2, 250, 1e-6, '中心 y 不动');
  near(custom.points[0].x, 0, 1e-9, '最左 → 0');
  near(custom.points[1].x, 1, 1e-9, '最右 → 1');
  near(custom.points[2].x, 0.5, 1e-9, '中心 → 0.5');
  return '400×200，中心不动';
});

check('c9 未越界时 extent 与原尺寸一致（不许无谓改宽高，否则每次画都动尺寸）', () => {
  const custom = worldPointsToCustom(
    [{ x: 110, y: 210 }, { x: 290, y: 290 }, { x: 200, y: 250 }], item,
  );
  near(custom.extent.width, 200, 1e-9, '宽不变');
  near(custom.extent.height, 100, 1e-9, '高不变');
  near(custom.extent.x, 100, 1e-9, 'x 不变');
  near(custom.extent.y, 200, 1e-9, 'y 不变');
  return '尺寸原样';
});

check('c7 往返一致：保存时把 extent 应用到家具上，再读回来必须还原原世界点（旋转 37°）', () => {
  const it = { ...item, rotation: 37 };
  // 故意画到框外（旋转 37° 时很容易），这条路必须也能往返
  const src = [{ x: 120, y: 215 }, { x: 310, y: 205 }, { x: 260, y: 320 }, { x: 150, y: 275 }];
  const custom = worldPointsToCustom(src, it);
  // 保存时的正确用法：尺寸跟着 extent 一起更新
  const grown = { ...it, ...custom.extent };
  const back = customToWorldPoints(custom, grown);
  assert(back.length === src.length, '点数一致');
  for (let i = 0; i < src.length; i++) {
    // 归一化只存 4 位小数（约 0.02cm），再乘回去 + 旋转放大 → 容差取 0.05cm（半毫米）
    near(back[i].x, src[i].x, 0.05, `第 ${i} 点 x`);
    near(back[i].y, src[i].y, 0.05, `第 ${i} 点 y`);
  }
  return `4 点往返，新框 ${grown.width}×${grown.height}`;
});

check('c8 sanitizeCustom：脏数据一律判无效，干净数据原样通过', () => {
  assert(sanitizeCustom(null) === null, 'null');
  assert(sanitizeCustom({ points: [] }) === null, '空点');
  assert(sanitizeCustom({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }) === null, '2 点');
  assert(sanitizeCustom({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: NaN, y: 1 }] }) === null, 'NaN 坐标');
  assert(sanitizeCustom({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 'x' }] }) === null, '非数字坐标');
  const ok = sanitizeCustom({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: false });
  assert(ok && ok.points.length === 3, '合法数据应通过');
  assert(ok.closed === false && ok.fill === true, 'closed 沿用、fill 默认 true');
  return '5 种脏 + 1 种干净';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} customShape 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
