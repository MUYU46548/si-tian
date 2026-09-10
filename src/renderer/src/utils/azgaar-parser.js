/**
 * Azgaar FMG .map 文件解析器（纯浏览器兼容）
 * 完整提取：高度图、生物群系、温度、降水、文化、宗教、城镇、势力、省份
 */

// SVG 路径 d 属性 → 多边形点数组（贝塞尔采样，2 样本/曲线，避免全黑）
function parsePathD(d) {
  if (!d) return [];
  const points = [];
  const tokens = d.match(/[MLHVCSQTAZ][^MLHVCSQTAZ]*/gi) || [];
  let cx = 0, cy = 0;
  let lastCX = 0, lastCY = 0;

  function parseNumbers(str) {
    return str.trim().split(/[\s,]+/).map(s => parseFloat(s)).filter(n => !isNaN(n));
  }

  for (const token of tokens) {
    const cmd = token[0].toUpperCase();
    const nums = parseNumbers(token.slice(1));

    if (cmd === 'M') {
      cx = nums[0]; cy = nums[1];
      points.push({ x: cx, y: cy });
      for (let i = 2; i < nums.length; i += 2) {
        cx = nums[i]; cy = nums[i + 1];
        points.push({ x: cx, y: cy });
      }
    } else if (cmd === 'L') {
      for (let i = 0; i < nums.length; i += 2) {
        cx = nums[i]; cy = nums[i + 1];
        points.push({ x: cx, y: cy });
      }
    } else if (cmd === 'Q') {
      for (let i = 0; i < nums.length; i += 4) {
        const cpx = nums[i], cpy = nums[i + 1];
        const ex = nums[i + 2], ey = nums[i + 3];
        for (let t = 1; t <= 2; t++) {
          const u = t / 2;
          points.push({
            x: (1-u)*(1-u)*cx + 2*(1-u)*u*cpx + u*u*ex,
            y: (1-u)*(1-u)*cy + 2*(1-u)*u*cpy + u*u*ey,
          });
        }
        lastCX = cpx; lastCY = cpy;
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
            x: (1-u)*(1-u)*(1-u)*cx + 3*(1-u)*(1-u)*u*cpx1 + 3*(1-u)*u*u*cpx2 + u*u*u*ex,
            y: (1-u)*(1-u)*(1-u)*cy + 3*(1-u)*(1-u)*u*cpy1 + 3*(1-u)*u*u*cpy2 + u*u*u*ey,
          });
        }
        lastCX = cpx2; lastCY = cpy2;
        cx = ex; cy = ey;
      }
    } else if (cmd === 'Z') {
      // Close path - no new point
    }
  }
  return points;
}

export function parseMapFile(text) {
  const lines = text.split('\n');

  // 1. Extract SVG content (lines 6-126)
  const svgContent = lines.slice(6, 127).join('\n');

  // 2. Parse feature paths (d attribute comes BEFORE id in FMG SVG)
  const featureRegex = /<path[^>]*d="([^"]+)"[^>]*id="feature_(\d+)"/g;
  let m;
  const featurePaths = {};
  while ((m = featureRegex.exec(svgContent)) !== null) {
    featurePaths[m[2]] = m[1];
  }

  if (Object.keys(featurePaths).length === 0) {
    throw new Error('未找到 feature paths。请确认是 FMG 导出的 .map 文件。');
  }

  // 3. Parse heightmap cells (line 3 - 0-indexed 2)
  let cellsData = [];
  try { cellsData = JSON.parse(lines[2]); } catch(e) { /* ignore */ }

  // 4. Parse biomes data (line 4 - 0-indexed 3)
  let biomesData = [];
  try { biomesData = JSON.parse(lines[3]); } catch(e) { /* ignore */ }

  // 5. Parse burg data (line 141 - 0-indexed 140)
  let burgData = [];
  try { burgData = JSON.parse(lines[140]); } catch(e) { /* ignore */ }

  // 6. Parse states data (line 156 - 0-indexed 155)
  let statesData = [];
  try { statesData = JSON.parse(lines[155]); } catch(e) { /* ignore */ }

  // 7. Parse cultures data (line 161 - 0-indexed 160)
  let culturesData = [];
  try { culturesData = JSON.parse(lines[160]); } catch(e) { /* ignore */ }

  // 8. Parse religions data (line 166 - 0-indexed 165)
  let religionsData = [];
  try { religionsData = JSON.parse(lines[165]); } catch(e) { /* ignore */ }

  // 9. Build terrain polygons from feature paths
  const terrain = [];
  for (const id of Object.keys(featurePaths)) {
    const d = featurePaths[id];
    if (!isLandFeature(svgContent, id)) continue;

    const points = parsePathD(d);
    terrain.push({
      id: 'feature_' + id,
      name: 'Province ' + id,
      type: 'polygon',
      points,
      biome: 'temperate',
      culture: '未分类',
      coast: true,
    });
  }

  // 10. Build polities from states
  const polities = {};
  statesData.filter(s => s.i > 0).forEach(s => {
    polities[s.i] = {
      id: String(s.i),
      name: s.name || ('State ' + s.i),
      color: s.color || '#888888',
    };
  });

  // 11. Map states to features via burgs (vote by burg count)
  const featureStateVotes = {};
  burgData.forEach(b => {
    if (b.state && b.feature) {
      const key = b.feature;
      if (!featureStateVotes[key]) featureStateVotes[key] = {};
      featureStateVotes[key][b.state] = (featureStateVotes[key][b.state] || 0) + 1;
    }
  });

  const ownership = {};
  for (const feature in featureStateVotes) {
    const votes = featureStateVotes[feature];
    const topState = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
    ownership['feature_' + feature] = topState;
  }

  // 12. Build labels from burgs (top 50)
  const labels = [];
  burgData.filter(b => b.x && b.y && b.name).slice(0, 50).forEach(b => {
    labels.push({
      x: b.x,
      y: b.y,
      text: b.name,
      size: 12,
      color: '#3c4150',
    });
  });

  // 13. Build markers for capitals
  const markers = burgData
    .filter(b => b.x && b.y && b.capital)
    .map(b => ({
      x: b.x,
      y: b.y,
      name: b.name,
      type: 'capital',
    }));

  // 14. Build burgs (城镇/首都) — 紧凑字段，供地图图层渲染与点击查询
  //     注意：FMG 的 burg[0] 是占位项（数字），且 capital 是 1/0 而非 true/false
  const burgs = burgData
    .filter(b => b && typeof b === 'object' && b.i && b.x && b.y)
    .map(b => ({
      id: b.i,
      name: b.name || `Burg ${b.i}`,
      x: b.x,
      y: b.y,
      capital: b.capital ? 1 : 0,
      population: b.population || 0,
      state: b.state || 0,
      feature: b.feature || 0,
      group: b.group || (b.capital ? 'capital' : 'town'),
    }));

  // 15. Build heightmap grid info
  const heightmap = {
    cells: cellsData,
    biomes: biomesData,
    cultures: culturesData,
    religions: religionsData,
  };

  return {
    terrain,
    polities,
    ownership,
    labels,
    markers,
    burgs,
    heightmap,
    stats: {
      provinces: terrain.length,
      burgs: burgData.length,
      states: Object.keys(polities).length,
      ownedProvinces: Object.keys(ownership).length,
      cells: cellsData.length,
      biomes: biomesData.length,
    }
  };
}

function isLandFeature(svgContent, featureId) {
  const landMatch = svgContent.match(/<mask id="land">([\s\S]*?)<\/mask>/);
  if (!landMatch) return true;
  const landMask = landMatch[1];
  const regex = new RegExp(`data-f="${featureId}"[^>]*fill="white"`);
  return regex.test(landMask);
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
        burgs: parsed.burgs || [],
        heightmap: parsed.heightmap,
        referenceImages: [],
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
