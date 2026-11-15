/**
 * interior/axonometric.js 单测（2026-11-15）
 *
 * 这一层决定"图会不会被切掉"。错了的表现是：导出的画四周少了一角，
 * 或者整栋楼只占画面中间一小块 —— 都属于"看上去没做错但没法用"。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/axonometric.js')).href);
const { AXO_PRESETS, axoDirection, axoFrame, AXO_CANVAS_PRESETS, axoCanvas } = mod;

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

/** 一栋 900×650、高 600 的两层小楼（cm） */
const HOUSE = { center: [0, 300, 0], size: [900, 600, 650] };

check('x1 方向向量是单位向量（否则"距离"会算错，裁剪面跟着错）', () => {
  for (const key of Object.keys(AXO_PRESETS)) {
    const d = axoDirection(key);
    const len = Math.hypot(d.x, d.y, d.z);
    near(len, 1, 1e-9, `${key} 不是单位向量`);
    assert(d.y > 0, `${key} 抬角应为正（相机在上方）`);
  }
  return `${Object.keys(AXO_PRESETS).length} 个预设`;
});

check('x2 等轴测：三根轴在画面上的投影等长（y = 1/√3）', () => {
  const d = axoDirection('iso');
  near(d.y, 1 / Math.sqrt(3), 1e-6, 'y 必须是 asin(1/√3)');
  near(d.x, d.z, 1e-9, '45° 时 x 与 z 相等');
  // 相机右轴 R = (dz,0,-dx)/|.|，上轴 U = R × (-dir)
  const rl = Math.hypot(d.z, d.x);
  const R = { x: d.z / rl, y: 0, z: -d.x / rl };
  const U = {
    x: R.y * -d.z - R.z * -d.y,
    y: R.z * -d.x - R.x * -d.z,
    z: R.x * -d.y - R.y * -d.x,
  };
  const proj = (ax) => Math.hypot(R.x * ax.x + R.y * ax.y + R.z * ax.z, U.x * ax.x + U.y * ax.y + U.z * ax.z);
  const px = proj({ x: 1, y: 0, z: 0 });
  const py = proj({ x: 0, y: 1, z: 0 });
  const pz = proj({ x: 0, y: 0, z: 1 });
  near(px, py, 1e-6, 'X 与 Y 投影等长');
  near(py, pz, 1e-6, 'Y 与 Z 投影等长');
  return `三轴投影 ${px.toFixed(3)}`;
});

check('x3 二测 2:1：进深的投影 = 宽度的一半（这才是 2:1 的定义）', () => {
  const d = axoDirection('dimetric');
  const rl = Math.hypot(d.z, d.x);
  const R = { x: d.z / rl, z: -d.x / rl };
  // 立面 +X 的投影宽度 ∝ |R·X|，+Z 的 ∝ |R·Z|
  const wx = Math.abs(R.x);
  const wz = Math.abs(R.z);
  near(Math.max(wx, wz) / Math.min(wx, wz), 2, 1e-6, '应为 2:1');
  return `宽:深 = ${(Math.max(wx, wz) / Math.min(wx, wz)).toFixed(3)}:1`;
});

check('x4 相机退到足够远：距离 > 包围球半径的 2 倍（正交下不影响大小，只为不切近远面）', () => {
  const f = axoFrame(HOUSE, { preset: 'iso', aspect: 3 / 2 });
  const r = Math.hypot(900, 600, 650) / 2;
  assert(f.distance > r * 2, `distance=${f.distance} 太小（r=${r.toFixed(1)}）`);
  assert(f.far > f.distance, '远裁剪面必须在相机后面');
  return `dist=${Math.round(f.distance)} / r=${Math.round(r)}`;
});

check('x5 视锥包住整栋（sphere 模式）：视锥高 ≥ 包围球直径，宽 ≥ 高 × aspect', () => {
  const aspect = 3 / 2;
  const f = axoFrame(HOUSE, { preset: 'iso', aspect, margin: 0.12 });
  const r = Math.hypot(900, 600, 650) / 2;
  assert(f.top - f.bottom >= 2 * r, `视锥高 ${f.top - f.bottom} < 直径 ${2 * r}`);
  near((f.right - f.left) / (f.top - f.bottom), aspect, 1e-9, '宽高比必须等于画幅');
  return `视锥 ${Math.round(f.right - f.left)}×${Math.round(f.top - f.bottom)}`;
});

check('x6 目标点在包围盒中心：相机看向 center（否则整栋偏出画面）', () => {
  const f = axoFrame(HOUSE, { preset: 'iso' });
  assert(f.target[0] === 0 && f.target[1] === 300 && f.target[2] === 0, `target=${f.target}`);
  // 相机位置 = center + dir × distance
  const d = axoDirection('iso');
  near(f.position[0], d.x * f.distance, 1e-6, 'position x');
  near(f.position[1], 300 + d.y * f.distance, 1e-6, 'position y');
  return 'center + dir·dist';
});

check('x7 margin 真的留出空白：视锥比"刚好包住"大', () => {
  const tight = axoFrame(HOUSE, { preset: 'iso', margin: 0 });
  const loose = axoFrame(HOUSE, { preset: 'iso', margin: 0.2 });
  assert(loose.spanH > tight.spanH * 1.15, `留白没生效：${tight.spanH} → ${loose.spanH}`);
  return `${Math.round(tight.spanH)} → ${Math.round(loose.spanH)}`;
});

check('x8 silhouette 模式比 sphere 更贴（同一栋楼，视锥更小）', () => {
  const sphere = axoFrame(HOUSE, { preset: 'iso', aspect: 3 / 2, fit: 'sphere' });
  const sil = axoFrame(HOUSE, { preset: 'iso', aspect: 3 / 2, fit: 'silhouette' });
  assert(sil.spanW * sil.spanH < sphere.spanW * sphere.spanH, 'silhouette 应更紧');
  near(sil.spanW / sil.spanH, 3 / 2, 1e-9, '仍然保持画幅比');
  return `${Math.round(sphere.spanH)} → ${Math.round(sil.spanH)}`;
});

check('x9 退化输入不炸：空 bounds / 尺寸为 0 / aspect=0', () => {
  const a = axoFrame(null, { preset: 'iso' });
  assert(Number.isFinite(a.top) && a.top > 0, 'null bounds 应回落到默认尺寸');
  const b = axoFrame({ center: [1, 2, 3], size: [0, 0, 0] }, { preset: 'iso' });
  assert(b.top > 0 && Number.isFinite(b.left), '尺寸 0 应兜底');
  const c = axoFrame(HOUSE, { preset: 'iso', aspect: 0 });
  assert(Number.isFinite(c.right) && c.right > 0, 'aspect 0 应兜底');
  return '3 种退化';
});

check('x10 画幅预设：print 是 3:2 且 ≥3600 宽；未知名回落 print', () => {
  const p = axoCanvas('print');
  near(p.width / p.height, 1.5, 1e-9, 'print 应为 3:2');
  assert(p.width >= 3600, `print 宽应 ≥3600，实际 ${p.width}`);
  assert(axoCanvas('不存在') === AXO_CANVAS_PRESETS.print, '未知名应回落 print');
  return `${p.width}×${p.height}`;
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} axonometric 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
