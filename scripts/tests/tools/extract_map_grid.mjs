#!/usr/bin/env node
/**
 * 从 Azgaar/FMG `.map` 文件里抽出 **grid / 高度** 段，写成诊断用的 JSON。
 *
 * 为什么需要它：`.map` 不是单个 JSON（首行 magic + base64 缩略图 + SVG + 逐行 JSON/CSV 段），
 * 而「河流到底能长多长」「高度图分辨率够不够」这类**观感问题**只能在真实数据上量。
 * 抽取口径与 `src/renderer/src/utils/azgaar-parser.js` **逐字对齐**（网格 JSON 行 + data[7] CSV），
 * 免得诊断工具与产品解析器各说一套。
 *
 * ⚠️ 只读：不写仓里任何数据，产物默认落临时目录。
 *
 * 用法：
 *   node scripts/tests/tools/extract_map_grid.mjs <in.map> [out.json]
 * 输出：{ source, grid:{points,cellsX,cellsY,spacing}, h:number[]|null }
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const [, , inPath, outArg] = process.argv;
if (!inPath) {
  console.error('用法：node extract_map_grid.mjs <in.map> [out.json]');
  process.exit(2);
}

const lines = String(fs.readFileSync(inPath, 'utf8')).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
const safeJson = (s) => {
  const t = String(s == null ? '' : s).trim();
  if (!t || (t[0] !== '[' && t[0] !== '{')) return null;
  try { return JSON.parse(t); } catch (_) { return null; }
};
const csv = (s) => String(s == null ? '' : s).split(',').map((x) => {
  const t = x.trim(); const v = t ? Number(t) : 0; return Number.isFinite(v) ? v : 0;
});

// ── 与解析器同一判据：SVG 之后第一个「带 cellsX 与 points 的 JSON 行」 = 网格段 ──
let gridLine = -1;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i];
  if (s.length < 40 || s.charCodeAt(0) !== 123) continue;
  if (s.indexOf('"cellsX"') === -1 || s.indexOf('"points"') === -1) continue;
  const o = safeJson(s);
  if (o && o.points) { gridLine = i; break; }
}
if (gridLine < 0) { console.error('没找到网格段（这个文件不是 FMG 导出的 .map？）'); process.exit(1); }

const at = (i) => (i <= 4 ? lines[i] : i === 5 ? lines.slice(5, gridLine).join('\n') : lines[gridLine + i - 6]);
const gridRaw = safeJson(lines[gridLine]);
const rawPoints = Array.isArray(gridRaw.points) ? gridRaw.points : [];
const points = Array.isArray(rawPoints[0])
  ? rawPoints.map((p) => ({ x: Number(p[0]) || 0, y: Number(p[1]) || 0 }))
  : (() => { const o = []; for (let i = 0; i + 1 < rawPoints.length; i += 2) o.push({ x: Number(rawPoints[i]) || 0, y: Number(rawPoints[i + 1]) || 0 }); return o; })();

const rawH = at(7);
const h = rawH == null ? null : csv(rawH);
const hh = (h && h.length === points.length) ? h : null;

// spacing：网格是规则栅格时由相邻两点推；不是规则栅格则报 0（诊断里会显式说明）
let spacing = Number(gridRaw.spacing) || 0;
if (!spacing && points.length > 1) {
  const dx = Math.abs(points[1].x - points[0].x);
  const dy = Math.abs(points[1].y - points[0].y);
  spacing = dx || dy || 0;
}

// ── 陆地轮廓（SVG 里 feature_* 路径；`<mask id="land">` 里 fill=white 的才算陆地）──
// 诊断要用它当**海岸线掩膜**（产品在剧本侧用的是省份多边形，两者实测只差几十格）。
const svg = at(5) || '';
const rn1 = (n) => Math.round(n * 10) / 10;
function parsePathD(d) {
  if (!d) return [];
  const out = [];
  const tokens = d.match(/[MLHVCSQTAZ][^MLMLHVCSQTAZ]*/gi) || [];
  let cx = 0, cy = 0;
  const nums = (s) => s.trim().split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
  for (const token of tokens) {
    const cmd = token[0].toUpperCase();
    const v = nums(token.slice(1));
    if (cmd === 'M' || cmd === 'L') {
      for (let i = 0; i + 1 < v.length; i += 2) { cx = v[i]; cy = v[i + 1]; out.push({ x: rn1(cx), y: rn1(cy) }); }
    } else if (cmd === 'C') {
      for (let i = 0; i + 5 < v.length; i += 6) {
        const x1 = v[i], y1 = v[i + 1], x2 = v[i + 2], y2 = v[i + 3], x3 = v[i + 4], y3 = v[i + 5];
        for (const t of [0.5, 1]) {
          const u = 1 - t;
          out.push({
            x: rn1(u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3),
            y: rn1(u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3),
          });
        }
        cx = x3; cy = y3;
      }
    }
  }
  return out;
}
const landMaskSvg = svg.match(/<mask id="land">([\s\S]*?)<\/mask>/);
const landFeatures = [];
const pathRe = /<path[^>]*d="([^"]+)"[^>]*id="feature_(\d+)"/g;
let m;
while ((m = pathRe.exec(svg)) !== null) {
  const id = m[2];
  if (landMaskSvg && !new RegExp('data-f="' + id + '"[^>]*fill="white"').test(landMaskSvg[1])) continue;
  const pts = parsePathD(m[1]);
  if (pts.length >= 3) landFeatures.push({ id: 'feature_' + id, kind: 'land', points: pts });
}

const outPath = outArg || path.join(os.tmpdir(), path.basename(inPath, path.extname(inPath)) + '.grid.json');
const payload = {
  source: path.basename(inPath),
  grid: { points, cellsX: gridRaw.cellsX, cellsY: gridRaw.cellsY, spacing },
  h: hh,
  landFeatures,
};
fs.writeFileSync(outPath, JSON.stringify(payload));
console.log(JSON.stringify({
  out: outPath, cells: points.length, cellsX: gridRaw.cellsX, cellsY: gridRaw.cellsY, spacing,
  hParsed: h ? h.length : 0, hUsable: !!hh,
  hMin: hh ? Math.min(...hh) : null, hMax: hh ? Math.max(...hh) : null,
  landFeatures: landFeatures.length,
  landVerts: landFeatures.reduce((a, f) => a + f.points.length, 0),
}, null, 2));
