const fs = require('fs');
const p = process.argv[2];
const key = process.argv[3] || 'desite';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const rivers = j.scenarios.baseMaps[key].rivers || [];
const segX = (a, b, c, d) => {
  const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
};
const crossPt = (a, b, c, d) => {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (!den) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
};
const CELL = 120;
const grid = new Map();
for (let ri = 0; ri < rivers.length; ri++) {
  const pts = rivers[ri].points || [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL), x1 = Math.floor(Math.max(a.x, b.x) / CELL);
    const y0 = Math.floor(Math.min(a.y, b.y) / CELL), y1 = Math.floor(Math.max(a.y, b.y) / CELL);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = gx + ',' + gy;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ ri, i, a, b });
    }
  }
}
const found = [];
const seen = new Set();
for (const list of grid.values()) {
  for (let m = 0; m < list.length; m++) for (let n = m + 1; n < list.length; n++) {
    const s = list[m], t = list[n];
    if (s.ri === t.ri) continue;
    if (!segX(s.a, s.b, t.a, t.b)) continue;
    const kk = Math.min(s.ri, t.ri) + ':' + Math.max(s.ri, t.ri) + ':' + s.i + ':' + t.i;
    if (seen.has(kk)) continue;
    seen.add(kk);
    const pt = crossPt(s.a, s.b, t.a, t.b);
    if (pt) found.push({ pt, a: rivers[s.ri].id, b: rivers[t.ri].id });
  }
}
found.sort((u, v) => v.pt.y - u.pt.y);
console.log('crossings:', found.length);
for (const f of found.slice(0, 8)) {
  console.log(`（${f.pt.x.toFixed(1)}, ${f.pt.y.toFixed(1)}） ${f.a} × ${f.b}`);
}
