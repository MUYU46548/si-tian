/**
 * Azgaar FMG .map 文件解析器（纯浏览器兼容，无依赖）
 *
 * 支持的 FMG 导出格式（.map = CRLF 分隔的多段文件）：
 *   data[0] 版本串        data[1] 设置串        data[2] mapCoordinates
 *   data[3] biomes        data[4] notes        data[5] SVG（多行）
 *   data[6] grid JSON     data[7] cells.h      data[8] cells.prec
 *   data[9] cells.f       data[10] cells.t     data[11] cells.temp
 *   data[12] features     data[13] cultures    data[14] states
 *   data[15] burgs        ...（其余 packed 数组按 CSV）
 *   之后仍是 JSON 段：religions / provinces / rivers / markers / routes / zones / ...
 *
 * 关键事实（2026-09-10 实测 FMG 1.151.2 导出文件得出）：
 *   1. 行号不是固定的：SVG 段跨多行，所以 data[i]（i>=6）的实际行号 = grid 行号 + (i-6)。
 *      旧实现硬编码 lines[2]/[3]/[140]/[155]/[160]/[165]，会取到完全无关的数据（cellsData 变成
 *      coordinates 字典、cultures 取到 markers、religions 取到 cells.good）。本实现改为
 *      「先按内容嗅探定位，再按 grid 锚点做位置回退」。
 *   2. grid 级数组（h/temp/prec/f/t，长度 = 网格点数）与 packed 级数组（culture/religion/biome/…，
 *      长度 = packed 细胞数，两者不同源）必须区分：packed 细胞是网格点的子集 + 海岸中点，
 *      无法从文件反推（需要 Delaunay）。因此本解析器：
 *        · 高度/温度/降水 → 直接用 grid 级数组（精确）
 *        · 文化/宗教 → 用 provinces[] → burg → burg.culture 的精确映射，落到省份粒度
 *        · 河流/道路 → 直接用 SVG 中已渲染的 path 几何（精确）
 *   3. SVG 中只包含「导出时可见」的图层：provincesBody / rivers / roads / trails / searoutes /
 *      coastline / oceanLayers / ice 等有几何；biomes / cults / relig / terrs 等被隐藏的图层是空组。
 *      所以生物群系、文化、宗教只能走数据侧，不能走 SVG。
 */

const SEA_LEVEL = 20;

/** 归一化换行并按行切分（FMG 用 CRLF；逐行 JSON.parse 前必须去掉尾部 \r） */
function splitMapLines(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function safeJson(str, fallback = null) {
  if (str == null) return fallback;
  const s = String(str).trim();
  if (!s || (s[0] !== '[' && s[0] !== '{')) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

/** CSV 数字段 → 数字数组（空值/尾部换行残渣按 0 处理） */
function parseCsvNumbers(str) {
  if (str == null) return [];
  const parts = String(str).split(',');
  const out = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    const v = t ? Number(t) : 0;
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** 路径坐标精度削减：SVG 里的 17 位小数对渲染无意义，只徒增产物体积 */
function rn1(n) {
  return Math.round(n * 10) / 10;
}

/** 闭合环去重尾点：RDP 对「首尾重合」的环会因零长度弦坍塌，必须先去掉重复尾点 */
function dedupeRing(points) {
  const n = points.length;
  if (n > 1 && Math.abs(points[0].x - points[n - 1].x) < 1e-6 && Math.abs(points[0].y - points[n - 1].y) < 1e-6) {
    return points.slice(0, n - 1);
  }
  return points;
}

/** 迭代式 Ramer–Douglas–Peucker（仅用于轮廓降采样，eps 单位 = 世界像素） */
function simplifyRing(input, eps) {
  const points = dedupeRing(input);
  if (points.length < 4) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const ax = points[a].x, ay = points[a].y;
    const dx = points[b].x - ax, dy = points[b].y - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = len > 1e-9
        ? Math.abs(dy * points[i].x - dx * points[i].y + points[b].x * ay - points[b].y * ax) / len
        : Math.sqrt((points[i].x - ax) ** 2 + (points[i].y - ay) ** 2);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps && maxI > 0) {
      keep[maxI] = true;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** 多边形面积（shoelace），用于降采样后的保真度自检 */
export function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return Math.abs(area) / 2;
}

/** SVG 路径 d → 多边形点数组（贝塞尔采样 2 样本/曲线，与旧实现保持一致） */
function parsePathD(d) {
  if (!d) return [];
  const points = [];
  const tokens = d.match(/[MLHVCSQTAZ][^MLMLHVCSQTAZ]*/gi) || [];
  let cx = 0, cy = 0;

  function parseNumbers(str) {
    return str.trim().split(/[\s,]+/).map(s => parseFloat(s)).filter(n => !isNaN(n));
  }

  for (const token of tokens) {
    const cmd = token[0].toUpperCase();
    const nums = parseNumbers(token.slice(1));

    if (cmd === 'M') {
      cx = nums[0]; cy = nums[1];
      points.push({ x: rn1(cx), y: rn1(cy) });
      for (let i = 2; i < nums.length; i += 2) {
        cx = nums[i]; cy = nums[i + 1];
        points.push({ x: rn1(cx), y: rn1(cy) });
      }
    } else if (cmd === 'L') {
      for (let i = 0; i < nums.length; i += 2) {
        cx = nums[i]; cy = nums[i + 1];
        points.push({ x: rn1(cx), y: rn1(cy) });
      }
    } else if (cmd === 'Q') {
      for (let i = 0; i < nums.length; i += 4) {
        const cpx = nums[i], cpy = nums[i + 1];
        const ex = nums[i + 2], ey = nums[i + 3];
        for (let t = 1; t <= 2; t++) {
          const u = t / 2;
          points.push({
            x: rn1((1 - u) * (1 - u) * cx + 2 * (1 - u) * u * cpx + u * u * ex),
            y: rn1((1 - u) * (1 - u) * cy + 2 * (1 - u) * u * cpy + u * u * ey),
          });
        }
        cx = ex; cy = ey;
      }
    } else if (cmd === 'C') {
      for (let i = 0; i < nums.length; i += 6) {
        const cpx1 = nums[i], cpy1 = nums[i + 1];
        const cpx2 = nums[i + 2], cpy2 = nums[i + 3];
        const ex = nums[i + 4], ey = nums[i + 5];
        for (let t = 1; t <= 2; t++) {
          const u = t / 2;
          points.push({
            x: rn1((1 - u) * (1 - u) * (1 - u) * cx + 3 * (1 - u) * (1 - u) * u * cpx1 + 3 * (1 - u) * u * u * cpx2 + u * u * u * ex),
            y: rn1((1 - u) * (1 - u) * (1 - u) * cy + 3 * (1 - u) * (1 - u) * u * cpy1 + 3 * (1 - u) * u * u * cpy2 + u * u * u * ey),
          });
        }
        cx = ex; cy = ey;
      }
    }
    // Z 不产生新点
  }
  return points;
}

/** 定位 grid JSON 行（data[6]）——SVG 之后的第一个稳定锚点 */
function findGridLineIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (s.length < 40) continue;
    if (s.charCodeAt(0) !== 123 /* { */) continue;
    if (s.indexOf('"cellsX"') === -1 || s.indexOf('"points"') === -1) continue;
    const obj = safeJson(s);
    if (obj && obj.points) return i;
  }
  return -1;
}

/**
 * 内容嗅探：按结构特征识别各 JSON 段，返回 { key: value }。
 * 这是对「硬编码行号」的根治——行号随 SVG 行数漂移，结构特征不会。
 */
function sniffJsonBlocks(lines) {
  const found = {};
  const isList = v => Array.isArray(v);
  const at1 = v => (isList(v) && v.length > 1 && v[1] && typeof v[1] === 'object' ? v[1] : null);

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (s.length < 8) continue;
    const c = s.charCodeAt(0);
    if (c !== 123 && c !== 91) continue;
    const v = safeJson(s);
    if (!v) continue;

    if (!Array.isArray(v)) {
      if (v.points && v.cellsX && found.grid === undefined) found.grid = v;
      else if (v.map && v.ocean && v.landmass && found.styles === undefined) found.styles = v;
      else if (v.cultures && v.religions && v.states && found.layerFlags === undefined) found.layerFlags = v;
      continue;
    }
    const e1 = at1(v);
    if (found.biomes === undefined && e1 && e1.habitability !== undefined && e1.color) { found.biomes = v; continue; }
    if (found.notes === undefined && e1 && e1.legend !== undefined) { found.notes = v; continue; }
    if (found.features === undefined && e1 && e1.firstCell !== undefined) { found.features = v; continue; }
    if (found.cultures === undefined && e1 && e1.expansionism !== undefined && e1.type !== undefined) { found.cultures = v; continue; }
    if (found.religions === undefined && e1 && e1.deity !== undefined) { found.religions = v; continue; }
    if (found.states === undefined && e1 && e1.capital !== undefined && e1.neighbors !== undefined) { found.states = v; continue; }
    if (found.provinces === undefined && e1 && e1.formName !== undefined) { found.provinces = v; continue; }
    if (found.burgs === undefined && e1 && e1.population !== undefined && e1.cell !== undefined && e1.x !== undefined) { found.burgs = v; continue; }
    if (found.rivers === undefined && e1 && e1.discharge !== undefined) { found.rivers = v; continue; }
    if (found.routes === undefined && e1 && e1.group !== undefined && e1.points !== undefined) { found.routes = v; continue; }
    if (found.markers === undefined && e1 && e1.icon !== undefined && e1.cell !== undefined) { found.markers = v; continue; }
    if (found.zones === undefined && e1 && e1.cells !== undefined && e1.type !== undefined && e1.name !== undefined) { found.zones = v; continue; }
    if (found.measurers === undefined && e1 && e1.points !== undefined && e1.type !== undefined) { found.measurers = v; continue; }
  }
  return found;
}

/** 从 SVG 段提取「<g id="xxx" ...>…</g>」内部文本（不解析嵌套，取到下一个同级 g 之前） */
function svgGroup(svg, gid) {
  const open = svg.indexOf('<g id="' + gid + '"');
  if (open < 0) return '';
  const bodyStart = svg.indexOf('>', open);
  const next = svg.indexOf('<g id="', bodyStart);
  return svg.slice(bodyStart + 1, next > 0 ? next : svg.length);
}

/** 抽取 <path id="prefixN" d="…"/> 形式的图层几何（河流/道路/海岸线都走这里） */
function extractIdPaths(groupText, idPrefix) {
  const out = [];
  const re = /<path\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(groupText)) !== null) {
    const attrs = m[1];
    const idm = /id="([^"]+)"/.exec(attrs);
    const dm = /\bd="([^"]+)"/.exec(attrs);
    if (!idm || !dm) continue;
    const id = idm[1];
    if (idPrefix && id.indexOf(idPrefix) !== 0) continue;
    const num = parseInt(id.slice(idPrefix.length), 10);
    out.push({ id, index: Number.isFinite(num) ? num : null, d: dm[1] });
  }
  return out;
}

/** path d → 折线点（河流/道路是 C 曲线；采样 2 段/曲线足够，渲染时再平滑） */
function pathToPolyline(d) {
  return parsePathD(d).map(p => ({ x: p.x, y: p.y }));
}

export function parseMapFile(text) {
  const warnings = [];
  const lines = splitMapLines(text);
  const gridLine = findGridLineIndex(lines);
  const sniffed = sniffJsonBlocks(lines);

  // data[i] → 行内容（i>=6 时行号 = gridLine + i - 6）
  const at = (i) => {
    if (i <= 4) return lines[i];
    if (i === 5) return gridLine > 0 ? lines.slice(5, gridLine).join('\n') : lines[5];
    if (gridLine < 0) return undefined;
    return lines[gridLine + i - 6];
  };
  const atJson = (i) => safeJson(at(i), null);

  const svgContent = at(5) || '';
  if (!svgContent || svgContent.indexOf('<svg') < 0) {
    warnings.push('未找到 SVG 段，文件可能不是 FMG 导出的 .map');
  }

  // ── 1. 陆地轮廓（featurePaths：大陆/岛屿外轮廓，供海岸线/底图背景）
  const featurePaths = {};
  {
    const re = /<path[^>]*d="([^"]+)"[^>]*id="feature_(\d+)"/g;
    let m;
    while ((m = re.exec(svgContent)) !== null) featurePaths[m[2]] = m[1];
  }
  if (Object.keys(featurePaths).length === 0) {
    throw new Error('未找到 feature paths。请确认是 FMG 导出的 .map 文件。');
  }

  const landFeatures = [];
  for (const id of Object.keys(featurePaths)) {
    if (!isLandFeature(svgContent, id)) continue;
    const raw = parsePathD(featurePaths[id]);
    // 轮廓只用于底图填充与海防，做 1.2px 容差降采样（面积偏差自检见 parseMapFile 末尾）
    const points = simplifyRing(raw, 1.2);
    landFeatures.push({
      id: 'feature_' + id,
      name: '陆地 ' + id,
      type: 'polygon',
      points,
      sourcePoints: raw.length,
      coast: true,
    });
  }

  // ── 2. 网格（精确的细胞坐标 + 高度/温度/降水）
  const gridRaw = sniffed.grid || atJson(6) || {};
  const rawPoints = Array.isArray(gridRaw.points) ? gridRaw.points : [];
  const cellCount = rawPoints.length;
  const gridPoints = cellCount
    ? (Array.isArray(rawPoints[0])
      ? rawPoints.map(p => ({ x: Number(p[0]) || 0, y: Number(p[1]) || 0 }))
      : (() => {
        const out = [];
        for (let i = 0; i + 1 < rawPoints.length; i += 2) out.push({ x: Number(rawPoints[i]) || 0, y: Number(rawPoints[i + 1]) || 0 });
        return out;
      })())
    : [];

  const pickCsv = (i, expectLen) => {
    const raw = at(i);
    if (raw == null) return [];
    const arr = parseCsvNumbers(raw);
    if (expectLen && arr.length !== expectLen) return [];
    return arr;
  };

  const heights = pickCsv(7, cellCount);
  const precipitation = pickCsv(8, cellCount);
  const temperature = pickCsv(11, cellCount);
  if (!cellCount) warnings.push('未解析到网格点（grid.points 缺失），地形高度/温度/降水图层不可用');
  else if (!heights.length) warnings.push('未解析到 cells.h（高度图不可用）');

  // ── 3. 文化 / 宗教 / 生物群系 / 势力 定义
  const biomes = (sniffed.biomes || atJson(3) || []).filter(b => b && typeof b === 'object');
  const cultures = (sniffed.cultures || atJson(13) || []).filter(c => c && typeof c === 'object');
  const religions = (sniffed.religions || atJson(29) || []).filter(r => r && typeof r === 'object');
  const states = (sniffed.states || atJson(14) || []).filter(s => s && typeof s === 'object');
  const fmgProvinces = (sniffed.provinces || atJson(30) || []).filter(p => p && typeof p === 'object');

  if (!cultures.length) warnings.push('未解析到 cultures（文化图层不可用）');
  if (!religions.length) warnings.push('未解析到 religions（宗教图层不可用）');

  // ── 4. 城镇（含文化归属，是文化→省份映射的桥梁）
  const burgData = sniffed.burgs || atJson(15) || [];
  const burgs = burgData
    .filter(b => b && typeof b === 'object' && b.i && b.x && b.y)
    .map(b => ({
      id: b.i,
      name: b.name || ('Burg ' + b.i),
      x: b.x,
      y: b.y,
      capital: b.capital ? 1 : 0,
      population: b.population || 0,
      state: b.state || 0,
      culture: b.culture || 0,
      feature: b.feature || 0,
      group: b.group || (b.capital ? 'capital' : 'town'),
    }));
  const burgById = new Map(burgs.map(b => [b.id, b]));

  // ── 5. 省份（FMG provincesBody 里的精确多边形 + provinces[] 元数据）
  const cultureById = new Map(cultures.map(c => [c.i, c]));
  const stateById = new Map(states.map(s => [s.i, s]));
  // 宗教：优先取「与文化同源」的宗教
  const religionByCulture = new Map();
  for (const r of religions) {
    if (!r || r.i === 0) continue;
    if (!religionByCulture.has(r.culture)) religionByCulture.set(r.culture, r);
  }

  const provincesBody = svgGroup(svgContent, 'provincesBody');
  const provincePaths = extractIdPaths(provincesBody, 'province');
  const provinceMetaById = new Map(fmgProvinces.filter(p => p.i).map(p => [p.i, p]));

  const terrain = [];
  for (const item of provincePaths) {
    const idNum = parseProvinceId(item.id);
    if (idNum == null) continue;
    if (item.id.indexOf('-gap') >= 0) continue; // 内部空洞（湖泊等），当前多边形模型不支持洞
    const meta = provinceMetaById.get(idNum) || {};
    const burg = meta.burg ? burgById.get(meta.burg) : null;
    const cultureId = burg ? burg.culture : 0;
    const culture = cultureById.get(cultureId) || null;
    const religion = religionByCulture.get(cultureId) || null;
    const state = meta.state ? stateById.get(meta.state) : null;
    const points = parsePathD(item.d);
    if (points.length < 3) continue;
    terrain.push({
      id: 'province_' + idNum,
      name: meta.name || ('省份 ' + idNum),
      type: 'polygon',
      points,
      biome: '',
      culture: culture ? culture.name : '未分类',
      cultureId: cultureId || 0,
      cultureColor: culture?.color || '',
      religionId: religion ? religion.i : 0,
      religion: religion ? religion.name : '',
      religionColor: religion?.color || '',
      stateId: meta.state || 0,
      stateName: state ? state.name : '',
      stateColor: state?.color || '',
      burgId: meta.burg || 0,
      color: meta.color || '',
      coast: false,
      source: 'fmg-province',
    });
  }
  // 省份多边形不可用时回退到陆地轮廓（保持旧行为，不让导入失败）
  if (!terrain.length) {
    warnings.push('provincesBody 图层为空（导出时省份图层可能未显示），已回退为陆地轮廓作为底图省份');
    for (const f of landFeatures) {
      terrain.push({
        id: f.id, name: f.name, type: 'polygon', points: f.points,
        biome: '', culture: '未分类', cultureId: 0, cultureColor: '',
        religion: '', religionId: 0, religionColor: '',
        coast: true, source: 'feature-fallback',
      });
    }
  }

  // ── 6. 河流 / 道路（SVG 已渲染几何，精确；元数据来自 rivers[] / routes[]）
  const riverMeta = new Map((sniffed.rivers || atJson(32) || []).filter(r => r && r.i !== undefined).map(r => [r.i, r]));
  const rivers = [];
  {
    const group = svgGroup(svgContent, 'rivers');
    for (const item of extractIdPaths(group, 'river')) {
      const meta = riverMeta.get(item.index) || {};
      const points = pathToPolyline(item.d);
      if (points.length < 2) continue;
      rivers.push({
        id: item.index,
        name: meta.name || ('河流 ' + item.index),
        type: meta.type || 'River',
        width: meta.width || 0.2,
        discharge: meta.discharge || 0,
        points,
      });
    }
  }
  if (!rivers.length && riverMeta.size) {
    warnings.push('rivers 图层为空（导出时河流图层可能未显示），河流无法渲染');
  }

  const routeMeta = new Map((sniffed.routes || atJson(37) || []).filter(r => r && r.i !== undefined).map(r => [r.i, r]));
  const routes = [];
  for (const [gid, group] of [['roads', 'roads'], ['trails', 'trails'], ['searoutes', 'searoutes']]) {
    const groupText = svgGroup(svgContent, gid);
    for (const item of extractIdPaths(groupText, 'route')) {
      const meta = routeMeta.get(item.index) || {};
      const points = pathToPolyline(item.d);
      if (points.length < 2) continue;
      routes.push({
        id: item.index,
        group: meta.group || group,
        name: meta.name || ('路线 ' + item.index),
        points,
      });
    }
  }

  // ── 7. 势力（states → polities，给剧本模式用）
  const polities = {};
  states.filter(s => s.i > 0).forEach(s => {
    polities[s.i] = { id: String(s.i), name: s.name || ('State ' + s.i), color: s.color || '#888888' };
  });

  // 省份 → 势力归属（原实现按 burg 投票；现在 provinces[] 直接带 state）
  const ownership = {};
  for (const p of terrain) {
    if (p.stateId) ownership[p.id] = String(p.stateId);
  }
  if (!Object.keys(ownership).length) {
    const votes = {};
    burgData.forEach(b => {
      if (b && b.state && b.feature) {
        const key = b.feature;
        votes[key] = votes[key] || {};
        votes[key][b.state] = (votes[key][b.state] || 0) + 1;
      }
    });
    for (const feature in votes) {
      const v = votes[feature];
      ownership['feature_' + feature] = String(Object.keys(v).sort((a, b) => v[b] - v[a])[0]);
    }
  }

  // ── 8. 标签 / 标记（保持旧行为：城镇标签取前 50，首都进 markers）
  const labels = [];
  burgData.filter(b => b && b.x && b.y && b.name).slice(0, 50).forEach(b => {
    labels.push({ x: b.x, y: b.y, text: b.name, size: 12, color: '#3c4150' });
  });
  const markers = burgData
    .filter(b => b && b.x && b.y && b.capital)
    .map(b => ({ x: b.x, y: b.y, name: b.name, type: 'capital' }));

  // ── 9. 组装
  const heightmap = {
    grid: {
      spacing: Number(gridRaw.spacing) || 0,
      cellsX: Number(gridRaw.cellsX) || 0,
      cellsY: Number(gridRaw.cellsY) || 0,
      points: gridPoints.map(p => [Math.round(p.x), Math.round(p.y)]),
      count: gridPoints.length,
    },
    h: heights,
    temp: temperature,
    prec: precipitation.map(v => round1(v)),
    biomes: biomes.map(b => ({ i: b.i, name: b.name || '', color: b.color || '#888888', habitability: b.habitability })),
    cultures: cultures.map(c => ({ i: c.i, name: c.name || '', color: c.color || '#888888', type: c.type || '', center: c.center ?? null })),
    religions: religions.map(r => ({ i: r.i, name: r.name || '', color: r.color || '#888888', type: r.type || '', form: r.form || '', culture: r.culture ?? null })),
    states: states.map(s => ({ i: s.i, name: s.name || '', color: s.color || '#888888', capital: s.capital })),
  };

  return {
    version: String(at(0) || '').split('|')[0] || '',
    terrain,
    landFeatures,
    polities,
    ownership,
    labels,
    markers,
    burgs,
    rivers,
    routes,
    cultures: heightmap.cultures,
    religions: heightmap.religions,
    biomes: heightmap.biomes,
    states: heightmap.states,
    heightmap,
    warnings,
    stats: {
      provinces: terrain.length,
      landFeatures: landFeatures.length,
      burgs: burgs.length,
      states: Object.keys(polities).length,
      ownedProvinces: Object.keys(ownership).length,
      cells: gridPoints.length,
      biomes: heightmap.biomes.length,
      cultures: heightmap.cultures.length,
      religions: heightmap.religions.length,
      rivers: rivers.length,
      routes: routes.length,
    },
  };
}

/** 'province12' / 'province-gap3' → 12 / 3；其他 → null */
function parseProvinceId(id) {
  const m = /^province(?:-gap)?(\d+)$/.exec(id);
  return m ? parseInt(m[1], 10) : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function isLandFeature(svgContent, featureId) {
  const landMatch = svgContent.match(/<mask id="land">([\s\S]*?)<\/mask>/);
  if (!landMatch) return true;
  const regex = new RegExp('data-f="' + featureId + '"[^>]*fill="white"');
  return regex.test(landMatch[1]);
}

export function buildScenariosJson(parsed, mapName, scenarioName) {
  const now = new Date().toISOString();

  const politiesArray = Object.values(parsed.polities).map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
  }));

  return {
    version: 2,
    baseMaps: {
      [mapName]: {
        id: mapName,
        name: mapName,
        terrain: parsed.terrain,
        landFeatures: parsed.landFeatures || [],
        burgs: parsed.burgs || [],
        rivers: parsed.rivers || [],
        routes: parsed.routes || [],
        heightmap: parsed.heightmap,
        referenceImages: [],
        source: {
          version: parsed.version || '',
          stats: parsed.stats || {},
          warnings: parsed.warnings || [],
        },
        createdAt: now,
        updatedAt: now,
      },
    },
    scenarios: {
      [`${mapName}/当前`]: {
        id: `${mapName}/当前`,
        ownerKey: mapName,
        name: scenarioName || '当前',
        era: { roman: '', label: '当前', startYear: '', endYear: '' },
        order: 1,
        description: `从 FMG .map 文件提取的 ${mapName} 当前状态。`,
        sourceNote: '',
        polities: politiesArray,
        ownership: parsed.ownership,
        labels: parsed.labels,
        markers: parsed.markers,
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}
