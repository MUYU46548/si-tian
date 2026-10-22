#!/usr/bin/env node
/**
 * Node 单测：自由绘制闭环净化（2026-10-22，三刀序列·第三刀）
 *
 * 用户原话：「当前手绘笔刷只画诡异几何」。真因实测（Node 复刻同一条链）：
 *   · 画 8 字：简化后 18 点、自交 1、fill（面积/包围盒）= 0.002 —— 落库是「几乎没面积带洞的怪形」；
 *   · 方框松手前回勾一下（非常常见）：自交 1、175° 尖刺。
 * 本层的判据是「落库前必须是一块正常的面」：
 *   ① 干净方框 / 手抖方框 / 圆 → 顶点少、fill 高、零自交；
 *   ② 8 字 / 回勾 → 归一成**一块**（零自交、丢掉碎屑），不是原样落库；
 *   ③ 一条线 / 点一下 → **明确拒绝**并给人话原因，不造怪多边形；
 *   ④ 同一输入两次结果一致（确定性，能进 undo/快照）。
 *
 * 用法：node scripts/tests/unit/test_freehand_ring.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── 手迹样例（与真机同量级：方框 300×200、圆 r=140；采样间隔 ~3px）──────────
function ringRect(w, h, step = 3, jitter = 0) {
  const out = [];
  let k = 0;
  const j = () => (jitter ? ((Math.sin(k++ * 12.9898) * 43758.5453) % 1) * jitter : 0);
  const edge = (x0, y0, x1, y1) => {
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let i = 0; i < n; i++) out.push({ x: x0 + (x1 - x0) * i / n + j(), y: y0 + (y1 - y0) * i / n + j() });
  };
  edge(0, 0, w, 0); edge(w, 0, w, h); edge(w, h, 0, h); edge(0, h, 0, 0);
  return out;
}
function ringCircle(r, n = 120, cx = 0, cy = 0, jitter = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = 2 * Math.PI * i / n;
    const rr = r + (jitter ? Math.sin(i * 7.7) * jitter : 0);
    out.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
  }
  return out;
}
function ringFigure8(r, n = 120) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = 2 * Math.PI * i / n;
    out.push({ x: r * Math.sin(2 * t) / 1.2, y: r * Math.cos(t) });
  }
  return out;
}
function ringHooked(w, h) {
  const base = ringRect(w, h, 3);
  const last = base[base.length - 1];
  for (let i = 1; i <= 8; i++) base.push({ x: last.x + i * 4, y: last.y - i * 3 });
  return base;
}
function ringLine(len = 300, n = 60) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ x: len * i / n, y: 0 });
  return out;
}

function areaOf(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]; const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

async function main() {
  const TMP = path.join(ROOT, 'scripts', 'tests', `.tmp_freehand_${process.pid}`);
  fs.mkdirSync(TMP, { recursive: true });
  const fix = (s) => s.replace(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g, "from './$1.js'");
  for (const f of ['freehandRing.js', 'strokeEngine.js', 'strokeMath.js', 'regionTrace.js', 'geometry.js']) {
    fs.writeFileSync(path.join(TMP, f), fix(fs.readFileSync(path.join(SRC, f), 'utf8')));
  }
  fs.writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({ type: 'module' }));
  const FH = await import(pathToFileURL(path.join(TMP, 'freehandRing.js')).href);
  const SE = await import(pathToFileURL(path.join(TMP, 'strokeEngine.js')).href);
  const RT = await import(pathToFileURL(path.join(TMP, 'regionTrace.js')).href);

  /** 复刻 ScenarioMap.freeTraceRing 的真实链：streamline(0.2) → RDP → 净化 */
  function pipeline(raw, { sanitize = true } = {}) {
    let src = raw;
    const st = SE.smoothStrokePoints(raw, { size: 1, thinning: 0, streamline: 0.2, smoothing: 0.5 });
    if (st.length >= 3) src = st.map((p) => ({ x: p.x, y: p.y }));
    const simplified = RT.simplifyClosedTrace(src);
    const before = {
      n: simplified.length,
      selfInt: FH.selfIntersectionCount(simplified),
      area: areaOf(simplified),
    };
    const san = sanitize ? FH.sanitizeFreehandRing(simplified) : null;
    return { before, san };
  }

  try {
    await check('一：干净方框 / 手抖方框 / 圆 —— 顶点少、fill 高、零自交', () => {
      for (const [label, raw, minFill] of [
        ['方框', ringRect(300, 200), 0.95],
        ['手抖方框', ringRect(300, 200, 3, 1.5), 0.9],
        ['圆', ringCircle(140), 0.7],
      ]) {
        const { before, san } = pipeline(raw);
        assert(san.ok, `${label} 被拒：${san.reason}`);
        assert(san.selfInt === 0 && before.selfInt === 0, `${label} 有自交`);
        assert(san.fill >= minFill, `${label} fill=${san.fill.toFixed(3)} < ${minFill}`);
        assert(san.points.length <= 24, `${label} 顶点 ${san.points.length} 个（太多）`);
      }
      return '3 种干净手迹都成面';
    });

    await check('二：8 字 / 松手回勾 —— 归一成一块（零自交、丢碎屑）', () => {
      const fig = pipeline(ringFigure8(140));
      assert(fig.before.selfInt > 0, '8 字原环本应自交（样例不成立）');
      assert(fig.san.ok, `8 字被拒：${fig.san.reason}`);
      assert(fig.san.selfInt === 0, '8 字净化后仍有自交');
      assert(fig.san.dropped >= 1, `8 字应丢掉另一瓣，实际 dropped=${fig.san.dropped}`);
      assert(fig.san.fill > 0.2, `8 字净化后仍不成面：fill=${fig.san.fill.toFixed(3)}`);

      const hook = pipeline(ringHooked(300, 200));
      assert(hook.before.selfInt > 0, '回勾样例本应自交');
      assert(hook.san.ok, `回勾被拒：${hook.san.reason}`);
      assert(hook.san.selfInt === 0, '回勾净化后仍有自交');
      assert(hook.san.area > 55000, `回勾应保留方框面积，实际 ${hook.san.area.toFixed(0)}`);
      assert(hook.san.dropped >= 1, '回勾的碎屑应被丢掉');
      return `8 字 fill=${fig.san.fill.toFixed(2)}；回勾 area=${hook.san.area.toFixed(0)}`;
    });

    await check('三：一条线 / 点一下 —— 明确拒绝，并给人话原因', () => {
      const line = pipeline(ringLine());
      assert(!line.san.ok, '直线不该成面（当前却通过了）');
      assert(['too-thin', 'degenerate'].includes(line.san.reason), `直线拒绝原因不对：${line.san.reason}`);
      const text = FH.explainFreehandRejection(line.san);
      assert(text && text.length > 6, `拒绝原因没人话：${text}`);

      const dot = FH.sanitizeFreehandRing([{ x: 1, y: 1 }, { x: 2, y: 1 }]);
      assert(!dot.ok && dot.reason === 'too-few-points', `点一下应判 too-few-points：${dot.reason}`);
      return `直线 → ${line.san.reason}（「${text}」）`;
    });

    await check('四：确定性 —— 同一输入两次结果逐值一致（可进 undo/快照）', () => {
      const raw = ringHooked(300, 200);
      const a = pipeline(raw).san;
      const b = pipeline(raw).san;
      assert(JSON.stringify(a.points) === JSON.stringify(b.points), '两次净化的点不一致');
      assert(a.area === b.area && a.fill === b.fill, '两次面积/fill 不一致');
      return `${a.points.length} 点逐值一致`;
    });

    await check('五：不破坏干净输入（净化是幂等的）', () => {
      const once = pipeline(ringRect(300, 200)).san;
      const twice = FH.sanitizeFreehandRing(once.points);
      assert(twice.ok, '净化后的形状再过一次被拒');
      assert(twice.points.length === once.points.length, `二次净化顶点数变了：${once.points.length} → ${twice.points.length}`);
      assert(Math.abs(twice.area - once.area) < 1e-6, '二次净化面积变了');
      return once.points.length + ' 点幂等';
    });
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('用例自身崩溃：', e); process.exit(1); });
