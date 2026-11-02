#!/usr/bin/env node
/**
 * Node 单元测试：示例星系生成器（src/renderer/src/galaxy/generator.js）
 *
 * 这份模块是**原型 SP-1025 的 generator/topology/metrics 整包移植**（2026-11-02）。
 * 判据照原型的三条硬指标写死：① 同 seed 同参数逐项一致；② overlapPairs=0 / maxDegree≤cap / components=1；
 * ③ 形态真的换（spiral/ring/disc 分布不同）。
 * 另外守两条司天自己的红线：④ 实体形状合法；⑤ store 写口唯一且过闸门。
 *
 * 用法：node scripts/tests/unit/test_galaxy_generator.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'src', 'galaxy', 'generator.js')).href);
  const GL = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'galaxyLayout.js')).href);
  const { generateGalaxy, presetParams, toSiTianEntities, computeMetrics, buildLanes, Rng } = mod;
  const genA = generateGalaxy(presetParams('A'));

  check('a1 默认档：4 星域 / 120 恒星 / 有航道 / 名字不重', () => {
    assert(genA.nodes.length === 120, '节点数应为 120，实测 ' + genA.nodes.length);
    assert(genA.regions.length === 4, '星域数应为 4，实测 ' + genA.regions.length);
    assert(genA.edges.length > 100, '航道太少（' + genA.edges.length + '），kNN 没生效');
    const names = new Set(genA.nodes.map((n) => n.name));
    assert(names.size === 120, '名字必须唯一（防重），实测 ' + names.size + '/120');
    return genA.nodes.length + ' 恒星 / ' + genA.edges.length + ' 航道 / ' + genA.regions.length + ' 星域';
  });

  check('a2 同 seed 同参数 → 逐项一致（可复现）', () => {
    const again = generateGalaxy(presetParams('A'));
    const sig = (g) => JSON.stringify({ n: g.nodes.map((n) => [n.id, n.x, n.y, n.name, n.cluster]), e: g.edges });
    assert(sig(again) === sig(genA), '两次生成不一致 —— 种子里混进了 Math.random / Date');
    return '逐项一致';
  });

  check('a3 硬指标：重叠对 0 / 最大度 ≤ cap / 连通分量 1', () => {
    const m = genA.metrics;
    assert(m.overlapPairs === 0, '重叠对应为 0，实测 ' + m.overlapPairs);
    assert(m.maxDegree <= genA.params.edgeDegreeCap, '最大度 ' + m.maxDegree + ' 超过 cap ' + genA.params.edgeDegreeCap);
    assert(m.components === 1, '连通分量应为 1，实测 ' + m.components);
    assert(m.avgDegree >= 1 && m.avgDegree <= genA.params.edgeDegreeCap, '平均度 ' + m.avgDegree + ' 越界');
    return 'overlap=' + m.overlapPairs + ' maxDeg=' + m.maxDegree + ' avgDeg=' + m.avgDegree.toFixed(2) + ' comp=' + m.components;
  });

  check('a4 星域都有成员；簇占比表长度 = 势力数', () => {
    const empty = genA.regions.filter((r) => r.nodeIds.length === 0);
    assert(empty.length === 0, '有 ' + empty.length + ' 个空星域');
    assert(genA.metrics.clusterShare.length === 4, '簇占比表应有 4 份，实测 ' + genA.metrics.clusterShare.length);
    assert(genA.metrics.clusterShare.every((s) => s > 0), '每个势力都该有成员');
    return genA.regions.map((r) => r.nodeIds.length).join(' / ');
  });

  check('b1 形态真的不同：spiral / ring / disc 的坐标分布不一样', () => {
    const spreadOf = (g) => {
      const xs = g.nodes.map((n) => n.x), ys = g.nodes.map((n) => n.y);
      const sd = (arr) => { const m = arr.reduce((a, b) => a + b, 0) / arr.length;
        return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); };
      return sd(xs).toFixed(1) + ':' + sd(ys).toFixed(1);
    };
    const s = spreadOf(generateGalaxy({ ...presetParams('A'), shape: 'spiral' }));
    const r = spreadOf(generateGalaxy({ ...presetParams('A'), shape: 'ring' }));
    const d = spreadOf(generateGalaxy({ ...presetParams('A'), shape: 'disc' }));
    assert(s !== r || s !== d, '三种形态的分布居然一样（' + s + '）');
    return 'spiral ' + s + ' / ring ' + r + ' / disc ' + d;
  });

  check('b2 Rng 确定性；生成器不碰 Math.random；采样点有限', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 20; i++) assert(a.next() === b.next(), '第 ' + i + ' 个随机数不一致');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'galaxy', 'generator.js'), 'utf8');
    assert(!/Math\.random/.test(src), '生成器源码里出现了 Math.random（可复现性硬指标）');
    const rng = new Rng(7);
    const p = GL.sampleDomainShape('disc', 100, 80, () => rng.next(), 3);
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), '采样点必须是有限数');
    return 'ok';
  });

  check('c1 航道：无自环、无重复对、度不超上限', () => {
    const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 60, y: 0 }, { id: 'c', x: 120, y: 0 },
      { id: 'd', x: 0, y: 60 }, { id: 'e', x: 60, y: 60 }, { id: 'f', x: 120, y: 60 }];
    const r = buildLanes(nodes, { edgeRule: 'knn', edgeDegreeCap: 3 }, new Rng(1));
    const seen = new Set();
    for (const [x, y] of r.pairs) {
      assert(x !== y, '出现自环');
      const k = x < y ? x + '|' + y : y + '|' + x;
      assert(!seen.has(k), '重复航道 ' + k);
      seen.add(k);
    }
    const deg = new Map(nodes.map((n) => [n.id, 0]));
    for (const [x, y] of r.pairs) { deg.set(x, deg.get(x) + 1); deg.set(y, deg.get(y) + 1); }
    for (const [id, d] of deg) assert(d <= 3, '节点 ' + id + ' 的度 ' + d + ' 超过上限 3');
    return r.pairs.length + ' 条 / 成分 ' + r.report.components;
  });

  check('d1 转司天实体：父子关系、坐标、航道两端、id 唯一', () => {
    const ent = toSiTianEntities(genA, { worldId: 'w1', idPrefix: 'demo' });
    assert(ent.domains.length === 4, '星域应为 4，实测 ' + ent.domains.length);
    assert(ent.galaxies.length === 120, '恒星应为 120，实测 ' + ent.galaxies.length);
    assert(ent.lanes.length === genA.edges.length, '航道数应与边数一致');
    const domIds = new Set(ent.domains.map((d) => d.id));
    for (const d of ent.domains) {
      assert(d.layer === 'star_domain', '星域 layer 不对');
      assert(d.parentId === 'w1', '星域的父级必须是世界');
      assert(Number.isFinite(d.coordinate.x) && Number.isFinite(d.coordinate.y), '星域坐标必须是有限数');
      assert(d.tags.includes('sample'), '生成物必须带 sample 标签');
    }
    const ids = new Set();
    for (const g of ent.galaxies) {
      assert(!ids.has(g.id), '恒星 id 重复：' + g.id);
      ids.add(g.id);
      assert(g.layer === 'galaxy', '恒星 layer 不对');
      assert(domIds.has(g.parentId), '恒星的父级 ' + g.parentId + ' 不是星域（边域的星也应落到最近星域）');
      assert(Number.isFinite(g.coordinate.x) && Number.isFinite(g.coordinate.y), '恒星坐标必须是有限数');
    }
    const gIds = new Set(ent.galaxies.map((g) => g.id));
    for (const l of ent.lanes) {
      assert(gIds.has(l.fromId) && gIds.has(l.toId), '航道端点必须是本次生成的恒星');
      assert(l.type === 'local' || l.type === 'cross_domain', '航道类型非法：' + l.type);
      assert(l.id.startsWith('auto_'), '自动航道 id 必须以 auto_ 开头');
    }
    return ent.domains.length + '/' + ent.galaxies.length + '/' + ent.lanes.length + ' · 跨域 ' + ent.summary.crossDomainLanes;
  });

  check('e1 指标函数口径：空输入不炸、重叠对能数出来', () => {
    const empty = computeMetrics({ nodes: [], edges: [], minDistance: 30 });
    assert(empty.nodeCount === 0 && empty.components === 0 && empty.overlapPairs === 0, '空输入应返回全 0');
    const two = computeMetrics({ nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5, y: 0 }], edges: [], minDistance: 30 });
    assert(two.overlapPairs === 1, '两个相距 5、minDistance 30 的节点应记 1 对重叠，实测 ' + two.overlapPairs);
    return 'ok';
  });

  check('f1 store 写口：过闸门 + 登记 writeGate + 一条 execute', () => {
    const gd = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodata.js'), 'utf8');
    const i = gd.indexOf('function generateSampleGalaxy(');
    assert(i > 0, 'geodata.js 里没有 generateSampleGalaxy');
    const body = gd.slice(i, i + 2600);
    const firstGuard = body.indexOf('guardWrite(');
    const firstExec = body.indexOf('execute({');
    assert(firstGuard > 0, '函数体里没有 guardWrite');
    assert(firstExec > 0, '函数体里没有 execute');
    assert(firstGuard < firstExec, 'guardWrite 必须在 execute 之前');
    assert(/type: 'generate-sample-galaxy'/.test(body), 'execute 的 type 不是 generate-sample-galaxy');
    const wg = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'store', 'writeGate.js'), 'utf8');
    assert(/fns:\s*\['generateSampleGalaxy'\]/.test(wg), 'writeGate 没登记 generateSampleGalaxy');
    return 'ok';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
  console.log('\n=== 示例星系生成器 ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('用例自身崩溃：', err); process.exit(1); });