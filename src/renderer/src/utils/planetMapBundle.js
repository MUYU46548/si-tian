// utils/planetMapBundle.js — 把解析后的 `.map` 装成**行星地图自己的**一份数据（2026-10-17）
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// `.map` 导入此前只有剧本视图一条入口：它把数据装进**底图**（`baseMaps[key]`：省份多边形 +
// 高度图 + 河流 + 道路）。行星视图（`mapData[planetId]`）是**另一个容器**，此前根本没有导入路径 ——
// 于是「空行星上想用自己那张 Azgaar 地图起步」这件事，界面上做不到（只能先画省份再补地形）。
//
// 本文件负责「解析产物 → 行星容器」的**唯一映射**（纯函数，无 store / 无 DOM，可 Node 单测）。
// 落库（undo / 落盘 / 写闸门）在 `store/geodataModules/mapDataEditing.js#importPlanetMapBundle`。
//
// ── 三条映射纪律（都有代价，写在这里免得下次"顺手改一下"）────────────────────
// ① **省份只搬几何与名字**，颜色由行星侧「地形类型」决定 —— 行星画布按 `terrainTypes` 上色
//    （见 `planetDrawing.drawTerrain`），搬 `stateColor` 进来也不会被用；`stateId/cultureId/…`
//    原样留着，参考图层（政治/文化/宗教）靠它们关联。
// ② **高度图必须补齐四个通道**（h/temp/prec/biome）：行星侧的 `ensureHeightmap` 只有在四层
//    长度全都对得上时才不重算；缺 `biome` 会把文件里的温度/降水**直接换成估值**（静默失真）。
// ③ **河流/道路按行星侧字段名落**（`nodes` / `points`），不是底图的 `points` 一套 ——
//    两边的 `drawRivers` 读的字段不同，写错不会报错，只会「导入了但画不出来」。
//
// ⚠️ 不做的事：不建底图、不写剧本、不弹确认（要不要覆盖已有内容由调用方问用户）。
//    行星容器与剧本底图是**两份**（`mapData` / `baseMaps` 的双向同步是已知的未完成项），
//    所以导入回执必须把这件事说清楚，不能让用户以为"导一次两边都有"。

import { hasHeightmapContent } from './terrainRepresentation';
import { SEA_LEVEL, biomeIndex } from './heightMath';

/** 导入的省份统一用这个地形类型（行星侧合法类型见 `useProvinceEditor.TERRAIN_TYPES`） */
export const PLANET_IMPORT_TERRAIN_TYPE = 'land';

/** 导入会写入的行星地图字段（撤销/清点都按这份清单，**不整体替换 mapData**） */
export const PLANET_IMPORT_KEYS = [
  'terrain', 'rivers', 'routes', 'heightmap',
  'azgaarProvinces', 'azgaarStates', 'azgaarCultures', 'azgaarReligions',
];

function finitePoints(list) {
  const out = [];
  for (const p of (Array.isArray(list) ? list : [])) {
    const x = p && (Array.isArray(p) ? p[0] : p.x);
    const y = p && (Array.isArray(p) ? p[1] : p.y);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

/**
 * `.map` 的政治 / 文化 / 宗教 → 参考图层（唯一映射）。
 *
 * 同一份映射此前写在 `scenarioEditing.importPlanetLayerData` 里；行星侧导入也要它，
 * 抽到这里供**两处共用**（否则「参考图层的 id 口径」迟早一边变一边不变）。
 * @param {{provinces?:Array, states?:Array, cultures?:Array, religions?:Array}} parsed
 */
export function buildAzgaarReferenceLayers(parsed) {
  const src = parsed || {};
  const out = {};
  if (Array.isArray(src.provinces)) {
    out.azgaarProvinces = src.provinces.map(p => ({
      id: p.id,
      name: p.name || '',
      points: p.points || [],
      stateId: p.stateId || 0,
      cultureId: p.cultureId || 0,
      religionId: p.religionId || 0,
      color: p.color || p.stateColor || p.cultureColor || '#888888',
    }));
  }
  if (Array.isArray(src.states)) {
    out.azgaarStates = src.states.map(s => ({
      id: s.id || s.i,
      name: s.name || ('State ' + (s.id || s.i)),
      color: s.color || '#888888',
    }));
  }
  if (Array.isArray(src.cultures)) {
    out.azgaarCultures = src.cultures.map(c => ({
      id: c.id || c.i,
      name: c.name || ('Culture ' + (c.id || c.i)),
      color: c.color || '#888888',
    }));
  }
  if (Array.isArray(src.religions)) {
    out.azgaarReligions = src.religions.map(r => ({
      id: r.id || r.i,
      name: r.name || ('Religion ' + (r.id || r.i)),
      color: r.color || '#888888',
    }));
  }
  return out;
}

/**
 * 高度图 → 行星侧四通道（h / temp / prec / biome）。
 *
 * 🔴 「缺 biome 会被 `ensureHeightmap` 当成派生层损坏、重算 temp/prec」—— 也就是说
 *    只搬 h 的后果不是画不出来，而是**文件里的温度/降水被静默换成估值**（看起来一切正常）。
 *    所以这里一次补齐：temp/prec 优先用文件里的（长度对得上才算数），biome 由三者推。
 * @returns {object|null} 没有可画的内容时返回 null（行星侧保持原样，不写空壳）
 */
export function buildPlanetHeightmap(hm) {
  if (!hasHeightmapContent(hm)) return null;
  const grid = hm.grid || {};
  const points = Array.isArray(grid.points) ? grid.points.map(p => (Array.isArray(p) ? p.slice() : { ...p })) : [];
  const n = points.length;
  const srcH = hm.h instanceof Float32Array ? Array.from(hm.h) : (Array.isArray(hm.h) ? hm.h : []);
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = Number(srcH[i]) || 0;

  const srcTemp = Array.isArray(hm.temp) || (hm.temp && typeof hm.temp.length === 'number') ? hm.temp : null;
  const srcPrec = Array.isArray(hm.prec) || (hm.prec && typeof hm.prec.length === 'number') ? hm.prec : null;
  const temp = new Float32Array(n);
  const prec = new Float32Array(n);
  const biome = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const h = heights[i];
    // 文件里没有 / 长度对不上 → 用同一套估算（与行星侧派生同一口径）
    const t = (srcTemp && srcTemp.length === n && Number.isFinite(Number(srcTemp[i])))
      ? Number(srcTemp[i])
      : (30 - Math.max(0, h - SEA_LEVEL) * 0.5);
    const p = (srcPrec && srcPrec.length === n && Number.isFinite(Number(srcPrec[i])))
      ? Number(srcPrec[i])
      : Math.min(100, t > 0 ? 60 : 20);
    temp[i] = t;
    prec[i] = p;
    biome[i] = h < SEA_LEVEL ? 0 : biomeIndex(h, t, p);
  }
  return {
    grid: {
      ...grid,
      points,
      count: n,
      cellsX: Number(grid.cellsX) || 0,
      cellsY: Number(grid.cellsY) || 0,
    },
    h: heights,
    temp,
    prec,
    biome,
  };
}

/**
 * 解析产物 → 行星地图 bundle（纯函数）。
 * @param {object} parsed `utils/azgaar-parser.parseMapFile()` 的返回值
 */
export function buildPlanetMapBundle(parsed) {
  const p = parsed || {};
  const warnings = [];

  const terrain = [];
  for (let i = 0; i < (Array.isArray(p.terrain) ? p.terrain.length : 0); i++) {
    const prov = p.terrain[i];
    if (!prov) continue;
    const points = finitePoints(prov.points);
    if (points.length < 3) continue;              // 退化环画不出来，也不该占一个省份条目
    terrain.push({
      id: `imp_${prov.id || 'province_' + i}`,
      name: prov.name || `省份 ${i + 1}`,
      type: PLANET_IMPORT_TERRAIN_TYPE,
      description: '',
      elevation: '',
      climate: '',
      ecology: '',
      points,
      // 参考图层靠这三个 id 关联（政治 / 文化 / 宗教）；行星画布不按它们上色
      stateId: prov.stateId || 0,
      cultureId: prov.cultureId || 0,
      religionId: prov.religionId || 0,
      ...(prov.color ? { color: prov.color } : {}),
    });
  }

  const rivers = [];
  for (const r of (Array.isArray(p.rivers) ? p.rivers : [])) {
    if (!r) continue;
    const pts = finitePoints(r.points || r.nodes);
    if (pts.length < 2) continue;
    rivers.push({
      id: `imp_river_${r.id}`,
      name: r.name || '',
      width: Number.isFinite(Number(r.width)) ? Number(r.width) : undefined,
      discharge: Number.isFinite(Number(r.discharge)) ? Number(r.discharge) : undefined,
      // 行星侧 `drawRivers` 读的是 `nodes`（带 h 的描点）；这里只带平面坐标
      nodes: pts,
    });
  }

  const routes = [];
  for (const r of (Array.isArray(p.routes) ? p.routes : [])) {
    if (!r) continue;
    const pts = finitePoints(r.points || r.nodes);
    if (pts.length < 2) continue;
    routes.push({
      id: `imp_route_${r.id}`,
      name: r.name || '',
      points: pts,
      dashed: false,
      color: r.color || '#8a6d3b',
      label: '',
      description: '',
    });
  }

  const heightmap = buildPlanetHeightmap(p.heightmap);
  if (p.heightmap && !heightmap) {
    warnings.push('这份 .map 里没有可用的高度图（导出时未包含 cells.h）—— 地图会是扁平纯色，'
      + '这不是显示开关的问题');
  }

  return {
    terrain,
    rivers,
    routes,
    heightmap,
    // ⚠️ 参考图层的省份来源是解析器的 `terrain`（不是 `provinces`）——
    //    `importPlanetLayerData` 那条路传进来的键名才是 `provinces`。两边都要照顾：
    //    键名弄错不会报错，只会「政治 / 文化图层点了没反应」（映射出空数组）。
    ...buildAzgaarReferenceLayers({ ...p, provinces: p.provinces || p.terrain }),
    stats: {
      provinces: terrain.length,
      rivers: rivers.length,
      routes: routes.length,
      cells: (p.stats && p.stats.cells) || 0,
      hasHeightmap: !!heightmap,
      burgs: (p.stats && p.stats.burgs) || 0,
      skippedProvinces: Math.max(0, ((p.stats && p.stats.provinces) || 0) - terrain.length),
    },
    warnings: warnings.concat(Array.isArray(p.warnings) ? p.warnings : []),
  };
}

/** 现有行星地图里**会被导入覆盖**的内容量（用于"要不要覆盖"的确认文案） */
export function planetMapContentCounts(mapData) {
  const md = mapData || {};
  return {
    provinces: (md.terrain || []).length,
    rivers: (md.rivers || []).length,
    routes: (md.routes || []).length,
    hasHeightmap: hasHeightmapContent(md.heightmap),
  };
}

/** 行星空态/回执一句话：把"这一次导入了什么、哪些没导"说清（不是技术日志） */
export function describePlanetImportReceipt(name, bundle) {
  const b = bundle || {};
  const s = b.stats || {};
  const parts = [`已导入「${name}」到本行星：省份 ${s.provinces || 0} 块`];
  parts.push(`河流 ${s.rivers || 0} 条`, `道路 ${s.routes || 0} 条`);
  parts.push(s.hasHeightmap ? '高度图 有' : '高度图 ⚠️ 这份 .map 里就没有');
  if (s.burgs) parts.push(`城镇 ${s.burgs} 个未导入（行星图没有城镇图层）`);
  if (s.skippedProvinces) parts.push(`有 ${s.skippedProvinces} 块省份几何退化，已跳过`);
  return parts.join('、');
}
