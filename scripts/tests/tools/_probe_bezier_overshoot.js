#!/usr/bin/env node
// S0 几何探针（不是回归用例）：**先算一遍**「贝塞尔切线 /3」到底把边界鼓出去多少。
//
// 为什么要它：真机截图只能看“像不像”，而这个偏差是可算的 ——
// 渲染端 `withBezierControls`（ScenarioMap.vue:7063-7075）用 out=(next-prev)/3，
// 标准 Catmull-Rom → 三次贝塞尔是 (next-prev)/6；两倍切线会让每一段曲线在 t=0.5
// 处离开数据多边形那条弦。这里用同样的公式在几种典型环上量出比值。
'use strict';

function withBezierControls(points) {
  const n = points.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const dx = (next.x - prev.x) / 3;
    const dy = (next.y - prev.y) / 3;
    out[i] = { x: p.x, y: p.y, controlOut: { x: dx, y: dy }, controlIn: { x: -dx, y: -dy } };
  }
  return out;
}

function bulge(points) {
  const pts = withBezierControls(points);
  const n = pts.length;
  let maxDist = 0, maxRatio = 0, sumRatio = 0, segs = 0;
  for (let i = 0; i < n; i++) {
    const p0 = pts[i], p3 = pts[(i + 1) % n];
    const p1 = { x: p0.x + p0.controlOut.x, y: p0.y + p0.controlOut.y };
    const p2 = { x: p3.x + p3.controlIn.x, y: p3.y + p3.controlIn.y };
    const bx = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8;
    const by = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8;
    const mx = (p0.x + p3.x) / 2, my = (p0.y + p3.y) / 2;
    const d = Math.hypot(bx - mx, by - my);
    const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    maxDist = Math.max(maxDist, d);
    if (chord > 1e-9) { maxRatio = Math.max(maxRatio, d / chord); sumRatio += d / chord; segs++; }
  }
  return { maxDist: +maxDist.toFixed(3), maxRatio: +maxRatio.toFixed(4), avgRatio: +(sumRatio / Math.max(segs, 1)).toFixed(4) };
}

function ring(n, r, jitter = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + (jitter ? Math.sin(i * 2.7) * jitter : 0));
    out.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
  }
  return out;
}

const cases = {
  '正方形（边长 100）': [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
  '正六边形（半径 100）': ring(6, 100),
  '正二十四边形（半径 100）': ring(24, 100),
  '不均匀环（半径 100，±35% 抖动）': ring(24, 100, 0.35),
  '很稀疏的环（半径 100，8 点 ±45%）': ring(8, 100, 0.45),
};

const out = {};
for (const [name, pts] of Object.entries(cases)) out[name] = bulge(pts);
console.log(JSON.stringify(out, null, 2));
