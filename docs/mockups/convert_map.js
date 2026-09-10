const fs = require('fs');
const path = require('path');

// ============================================================
// FMG .map → scenarios.json 转换器
// 管线: FMG .map → 解析 → baseMaps + scenarios → scenarios.json
// ============================================================

function parseMapFile(mapPath) {
  const data = fs.readFileSync(mapPath, 'utf8');
  const lines = data.split('\n');

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
    throw new Error('No feature paths found. Is this a valid FMG .map file?');
  }

  // 3. Parse burg data (line 141 - 0-indexed 140)
  let burgData = [];
  try { burgData = JSON.parse(lines[140]); } catch(e) { console.warn('Burg data parse failed:', e.message); }

  // 4. Parse states data (line 156 - 0-indexed 155)
  let statesData = [];
  try { statesData = JSON.parse(lines[155]); } catch(e) { console.warn('States data parse failed:', e.message); }

  // 5. Parse province features mapping (line 138 - 0-indexed 137)
  let provFeatures = [];
  try { provFeatures = JSON.parse(lines[137]); } catch(e) { console.warn('Province features parse failed:', e.message); }

  // 6. Build terrain polygons from feature paths
  const terrain = [];
  for (const id of Object.keys(featurePaths)) {
    const d = featurePaths[id];
    // Check if land or water via mask
    const isLand = isLandFeature(svgContent, id);
    if (!isLand) continue; // skip water features for terrain

    terrain.push({
      id: 'feature_' + id,
      name: 'Province ' + id,
      type: 'polygon',
      points: d, // Keep original SVG d attribute
      biome: 'temperate',
      culture: '未分类',
      coast: true,
    });
  }

  // 7. Build polities from states
  const polities = {};
  statesData.filter(s => s.i > 0).forEach(s => {
    polities[s.i] = {
      id: String(s.i),
      name: s.name || ('State ' + s.i),
      color: s.color || '#888888',
    };
  });

  // 8. Map states to features via burgs (vote by burg count)
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

  // 9. Build labels from burgs (capital/major towns)
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

  // 10. Build markers for important burgs
  const markers = burgData
    .filter(b => b.x && b.y && b.capital)
    .map(b => ({
      x: b.x,
      y: b.y,
      name: b.name,
      type: 'capital',
    }));

  return {
    terrain,
    polities,
    ownership,
    labels,
    markers,
    stats: {
      provinces: terrain.length,
      burgs: burgData.length,
      states: Object.keys(polities).length,
      ownedProvinces: Object.keys(ownership).length,
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

function buildScenariosJson(parsed, mapName, scenarioName) {
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

// ============================================================
// CLI
// ============================================================

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: node convert_map.js <input.map> [output.json] [--name MapName] [--scenario ScenarioName]');
    console.log('');
    console.log('Examples:');
    console.log('  node convert_map.js desite.map');
    console.log('  node convert_map.js desite.map ../.sitian/scenarios.json');
    console.log('  node convert_map.js desite.map --name "德斯特星" --scenario "当前时代"');
    process.exit(1);
  }

  const inputPath = args[0];
  let outputPath = null;
  let mapName = null;
  let scenarioName = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) { mapName = args[i + 1]; i++; }
    else if (args[i] === '--scenario' && args[i + 1]) { scenarioName = args[i + 1]; i++; }
    else if (!args[i].startsWith('--')) { outputPath = args[i]; }
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Parsing ${inputPath}...`);
  const parsed = parseMapFile(inputPath);

  console.log('Stats:', JSON.stringify(parsed.stats, null, 2));

  // Auto-detect map name from filename if not provided
  if (!mapName) {
    mapName = path.basename(inputPath, '.map').replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '');
  }

  const scenarios = buildScenariosJson(parsed, mapName, scenarioName);

  // Output
  const jsonStr = JSON.stringify(scenarios, null, 2);

  if (outputPath) {
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outputPath, jsonStr);
    console.log(`\nWritten to: ${outputPath}`);
    console.log(`Size: ${(jsonStr.length / 1024).toFixed(1)} KB`);
  } else {
    console.log('\n' + jsonStr);
  }

  console.log('\nDone!');
}

main();
