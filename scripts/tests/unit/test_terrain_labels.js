#!/usr/bin/env node
/**
 * Node 单元测试：**地形注记的自动生成与合并**（2026-11-04）
 *
 * 守的六件事：
 *   ① **确定性**：同 seed + 同高度图 → 同 id / 同名字 / 同点，逐字节一致（不读 Math.random / Date.now）；
 *   ② **三种注记都会出**：山系（脊线）/ 海域（通到图边的水块）/ 平原（低海拔连通块）；
 *   ③ **名字不重**：同一批里没有重名（重名会在地图上叠字）；
 *   ④ **只补空**：已有山系注记 → 这一种一条都不加；其它种照补；已有条目原样保留（用户的地图解释优先）；
 *   ⑤ **关掉就是空**：`maxRanges/maxSeas/maxPlains = 0` 与没有高度图都不抛异常、返回空表；
 *   ⑥ **上限**：`maxLabels` 真的截断。
 *
 * 用法：node scripts/tests/unit/test_terrain_labels.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

/** 收集依赖（支持 ./x、../sub/x、./y；统一补 .js）—— 复刻浏览器侧的无后缀导入 */
function collectDeps(entries) {
  const seen = new Map();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop().replace(/\\/g, '/');
    if (seen.has(f)) continue;
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    seen.set(f, src);
    for (const m of src.matchAll(/from '(\.\.?\/[^']+)'/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      queue.push(rel.endsWith('.js') ? rel : rel + '.js');
    }
  }
  return seen;
}

function loadModules(names) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-labels-'));
  for (const [f, src] of collectDeps(names)) {
    const fixed = src.replace(/from '(\.\.?\/[^']+)'/g, (all, spec) => (spec.endsWith('.js') ? all : `from '${spec}.js'`));
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fixed);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  return { tmp, url: (f) => pathToFileURL(path.join(tmp, f)).href };
}

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/** 合成高度图：左右两条水带（海域）+ 中间一条南北向山脊 + 大片低地（平原） */
function makeHm() {
  const cellsX = 32;
  const cellsY = 20;
  const spacing = 10;
  const h = new Float32Array(cellsX * cellsY);
  const points = [];
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const i = y * cellsX + x;
      points.push([x * spacing, y * spacing]);
      if (x < 4 || x >= 28) h[i] = 8;                       // 海（低于 seaLevel=20）
      else if (x >= 14 && x <= 20) h[i] = 72 + ((x * 13 + y * 7) % 17); // 山脊带
      else h[i] = 30;                                       // 低地（平原带）
    }
  }
  return { h, grid: { points, cellsX, cellsY, spacing } };
}

(async () => {
  const { url } = loadModules(['terrainLabels.js']);
  const M = await import(url('terrainLabels.js'));
  const SEA = 20;

  const hm = makeHm();
  const a = M.buildAutoTerrainLabels(hm, { seed: 7, seaLevel: SEA });
  const b = M.buildAutoTerrainLabels(hm, { seed: 7, seaLevel: SEA });

  check('a1 确定性：同 seed 两跑逐字节一致', () => {
    assert(JSON.stringify(a) === JSON.stringify(b), '同 seed 两跑不一致（混入了随机或时间）');
    return `${a.labels.length} 条一致`;
  });

  check('a2 三种注记都会出（山系/海域/平原）', () => {
    assert(a.stats.ranges >= 1, `山系 ${a.stats.ranges} 条（应为 ≥1）`);
    assert(a.stats.seas >= 1, `海域 ${a.stats.seas} 条（应为 ≥1）`);
    assert(a.stats.plains >= 1, `平原 ${a.stats.plains} 条（应为 ≥1）`);
    return `山 ${a.stats.ranges} / 海 ${a.stats.seas} / 原 ${a.stats.plains}`;
  });

  check('a3 每条都有名字、点齐、坐标有限且在world范围内', () => {
    for (const l of a.labels) {
      assert(l.name && l.name.length >= 2, `注记 ${l.id} 没名字`);
      assert(l.origin === 'auto', `${l.id} origin 应为 auto`);
      assert(Array.isArray(l.points) && l.points.length >= (l.kind === 'plain' ? 1 : 2), `${l.id} 点不够`);
      for (const p of l.points) {
        assert(Number.isFinite(p.x) && Number.isFinite(p.y), `${l.id} 点非有限数`);
        assert(p.x >= -1 && p.x <= 32 * 10 + 1 && p.y >= -1 && p.y <= 20 * 10 + 1, `${l.id} 点跑出图幅`);
      }
    }
    return `${a.labels.length} 条`;
  });

  check('a4 同批名字不重（连词干也不重）', () => {
    const names = a.labels.map((l) => l.name);
    assert(new Set(names).size === names.length, `有重名：${names.join('、')}`);
    const stems = names.map((n) => n.slice(0, 2));
    assert(new Set(stems).size === stems.length, `词干重复（同图两张大字会糊成一处）：${names.join('、')}`);
    return names.join('、');
  });

  check('a5 换 seed → 至少一个名字变', () => {
    const c = M.buildAutoTerrainLabels(hm, { seed: 11, seaLevel: SEA });
    const n1 = a.labels.map((l) => l.name).join('|');
    const n2 = c.labels.map((l) => l.name).join('|');
    assert(n1 !== n2, '换 seed 名字没变（种子没参与取名）');
    return '名字随种子变';
  });

  check('a6 只补空：已有山系 → 山系一条不加，其它照补，原条目原样保留', () => {
    const userRange = {
      id: 'user_1', kind: 'range', name: '我给的山', origin: 'user',
      points: [{ x: 100, y: 100 }, { x: 200, y: 160 }],
    };
    const merged = M.mergeAutoTerrainLabels([userRange], a.labels);
    const ranges = merged.filter((l) => l.kind === 'range');
    assert(ranges.length === 1 && ranges[0].id === 'user_1', `山系应只有用户那一条，实际 ${ranges.length} 条`);
    assert(ranges[0].name === '我给的山', '用户命名被改掉了');
    assert(merged.some((l) => l.kind === 'sea'), '海域没补上');
    assert(merged.some((l) => l.kind === 'plain'), '平原没补上');
    return `山 1（保留）/ 海 ${merged.filter((l) => l.kind === 'sea').length} / 原 ${merged.filter((l) => l.kind === 'plain').length}`;
  });

  check('a7 已有三种都占了 → 一条都不加', () => {
    const existing = [
      { id: 'u1', kind: 'range', name: '甲山', origin: 'user', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { id: 'u2', kind: 'sea', name: '乙海', origin: 'user', points: [{ x: 0, y: 0 }, { x: 2, y: 2 }] },
      { id: 'u3', kind: 'plain', name: '丙原', origin: 'user', points: [{ x: 5, y: 5 }] },
    ];
    const merged = M.mergeAutoTerrainLabels(existing, a.labels);
    assert(merged.length === 3, `应保持 3 条，实际 ${merged.length}`);
    return '3 条不变';
  });

  check('a8 onlyFillKinds=false → 全部追加（仅避重名）', () => {
    const existing = [{ id: 'u1', kind: 'range', name: '甲山', origin: 'user', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }];
    const merged = M.mergeAutoTerrainLabels(existing, a.labels, { onlyFillKinds: false });
    assert(merged.length === 1 + a.labels.length, `应 ${1 + a.labels.length} 条，实际 ${merged.length}`);
    return `${merged.length} 条`;
  });

  check('a9 关掉 = 空表（三种上限都 0）', () => {
    const off = M.buildAutoTerrainLabels(hm, { seed: 7, seaLevel: SEA, maxRanges: 0, maxSeas: 0, maxPlains: 0 });
    assert(off.labels.length === 0, `应 0 条，实际 ${off.labels.length}`);
    return '0 条';
  });

  check('a10 没有高度图 / 空网格 → 空表且不抛', () => {
    for (const bad of [null, {}, { h: [], grid: { cellsX: 0, cellsY: 0, points: [] } }, { h: [1, 2, 3], grid: { cellsX: 2, cellsY: 2, points: [] } }]) {
      const r = M.buildAutoTerrainLabels(bad, { seed: 7, seaLevel: SEA });
      assert(Array.isArray(r.labels) && r.labels.length === 0, '坏输入应返回空表');
    }
    return '4 个坏输入都安全';
  });

  check('a11 maxLabels 真的截断', () => {
    const merged = M.mergeAutoTerrainLabels([], a.labels, { maxLabels: 2 });
    assert(merged.length === 2, `应截到 2 条，实际 ${merged.length}`);
    return '2 条';
  });

  // ── 源码闸门：注记必须与地形/河写在**同一条 undo** 里（半截状态是这类缺陷的老形态）──
  const path2 = (f) => path.join(ROOT, 'src', 'renderer', 'src', f);

  check('a12 重生成：旧的自动注记让位，用户注记仍占住那种', () => {
    const existing = [
      { id: 'auto_old_1', kind: 'range', name: '旧山', origin: 'auto', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { id: 'u_sea', kind: 'sea', name: '我的海', origin: 'user', points: [{ x: 0, y: 0 }, { x: 2, y: 2 }] },
    ];
    const merged = M.mergeAutoTerrainLabels(existing, a.labels);
    assert(!merged.some((l) => l.name === '旧山'), '旧的 auto 注记没被换掉（地形换了、名字还指着老山）');
    assert(merged.some((l) => l.name === '我的海'), '用户的海名被删了');
    assert(!merged.some((l) => l.kind === 'sea' && l.origin === 'auto'), '用户占住的海域不该再加自动条目');
    const keepOld = M.mergeAutoTerrainLabels(existing, a.labels, { replaceAuto: false });
    assert(keepOld.some((l) => l.name === '旧山'), 'replaceAuto:false 时应保留旧 auto 注记');
    return `重生成：山 ${merged.filter((l) => l.kind === 'range').length} / 海 ${merged.filter((l) => l.kind === 'sea').length}`;
  });

  check('g1 scenarioEditing.js：synthesizeTerrainInto 的 execute 块内 undo/redo 都写注记', () => {
    const src = fs.readFileSync(path2('store/geodataModules/scenarioEditing.js'), 'utf8').replace(/\r\n/g, '\n');
    const fnAt = src.indexOf('function synthesizeTerrainInto(');
    assert(fnAt >= 0, '找不到 synthesizeTerrainInto（地形推演的唯一实现被改名了？）');
    const execAt = src.indexOf('execute({', fnAt);
    assert(execAt > 0, 'synthesizeTerrainInto 里没有 execute({');
    const block = src.slice(execAt, execAt + 4000);
    assert(block.includes('setTerrainLabels(t.id, labelsBefore)'), 'undo 侧没把注记写回（撤销后注记会残留）');
    assert(block.includes('setTerrainLabels(t.id, labelsAfter)'), 'redo 侧没写注记（生成后注记落不了盘）');
    assert(block.includes('setBaseMapRivers(t.id, riversBefore)'), 'undo 侧没把河写回');
    assert(block.includes('setBaseMapRivers(t.id, riversAfter)'), 'redo 侧没写河');
    return '注记与河都各在 undo/redo 两侧';
  });

  check('g2 地形生成面板：开关真的接到 store（labels: autoLabels.value）', () => {
    const src = fs.readFileSync(path2('components/TerrainGenPanel.vue'), 'utf8').replace(/\r\n/g, '\n');
    const hits = (src.match(/labels:\s*autoLabels\.value/g) || []).length;
    assert(hits === 1, `底图那条路应传开关（行星没有注记容器，不该传），实际命中 ${hits} 处`);
    assert(/data-testid="tgen-auto-labels"/.test(src), '开关没有 data-testid（演练点不到）');
    assert(/const autoLabels = ref\(true\)/.test(src), '开关默认值不是 true（应默认生成）');
    assert(/v-if="!isPlanet"/.test(src), '行星面板应隐藏注记开关（行星没有 terrainLabels 容器）');
    return '1 处接线 + 默认开 + 行星隐藏';
  });

  check('g4 geodata.js：装配处真的把写口挂到 provinceGridOps 上', () => {
    // 🔴 2026-11-04 真踩：provinceEditing 里导出了 `setTerrainLabels`，但没在 `geodata.js` 里
    //    赋给 `provinceGridOps` → 生成时抛 `provinceGridOps.setTerrainLabels is not a function`
    //    （页面只报一句，地形已经算完但一个字没写）。装配是第三个必须一致的地方。
    const src = fs.readFileSync(path2('store/geodata.js'), 'utf8').replace(/\r\n/g, '\n');
    for (const fn of ['setBaseMapRivers', 'setTerrainLabels']) {
      assert(new RegExp(`provinceGridOps\\.${fn}\\s*=\\s*provinceEditingModule\\.${fn}`).test(src),
        `geodata.js 没把 ${fn} 挂到 provinceGridOps（生成链会 TypeError）`);
    }
    return 'setBaseMapRivers / setTerrainLabels 都已挂';
  });

  check('g3 地形注记面板与生成链共用同一份几何/命名实现', () => {
    const genSrc = fs.readFileSync(path2('utils/terrainLabels.js'), 'utf8');
    assert(genSrc.includes("from './ridges'"), '生成链没复用 utils/ridges.js#detectRidges');
    assert(genSrc.includes("from './polylineSmooth'"), '生成链没复用 smoothPolyline');
    const storeSrc = fs.readFileSync(path2('store/geodataModules/scenarioEditing.js'), 'utf8');
    assert(storeSrc.includes("from '../../utils/terrainLabels'"), 'store 没引 terrainLabels（另写了一份？）');
    return 'detectRidges / smoothPolyline 同一份';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(2);
});
