#!/usr/bin/env node
/**
 * Node 单元测试：星系/星域视图的共享布局与配色（src/renderer/src/utils/galaxyLayout.js）
 *
 * 为什么必须有这一层：这份模块是「画布与导出 PNG(全图)**同源**」的载体（§bug 导出与画布不同源）。
 * 它的口径错一条，就会出现"导出的图和屏幕上的不是一回事"——而**一条都不会报错**。
 * 这里把每条口径钉死（含两条**反向口径**：遗留坐标不许采信、星系数 < 3 的星域不许消失）。
 *
 * 用法：node scripts/tests/unit/test_galaxy_layout.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-glayout-'));
  fs.copyFileSync(path.join(SRC_DIR, 'galaxyLayout.js'), path.join(tmp, 'galaxyLayout.js'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const G = await import(pathToFileURL(path.join(tmp, 'galaxyLayout.js')).href);

  const dom = (id, extra) => Object.assign({ id, name: id, layer: 'star_domain', faction: undefined }, extra || {});
  const gal = (id, parentId, extra) => Object.assign({ id, name: id, layer: 'galaxy', parentId }, extra || {});

  check('a1 势力色：表内直取 / 表外哈希确定性 / 空值给默认色', () => {
    assert(G.getFactionColor('赤焰王国') === '#E74C3C', G.getFactionColor('赤焰王国'));
    const a = G.getFactionColor('用例势力甲');
    const b = G.getFactionColor('用例势力甲');
    assert(a === b && a.startsWith('hsl('), `${a} vs ${b}`);
    assert(G.getFactionColor('用例势力乙') !== a, '不同名字应给出不同色（哈希没生效？）');
    assert(G.getFactionColor('') === G.DEFAULT_FACTION_COLOR, G.getFactionColor(''));
    return `赤焰王国=#E74C3C / 用例势力甲=${a}`;
  });

  check('a2 resolveDomainColor 三级优先：预览覆盖（按 id）> 节点 factionColor > 名字哈希', () => {
    const d = dom('d1', { faction: '赤焰王国' });
    assert(G.resolveDomainColor(d, {}) === '#E74C3C', '应回落名字色');
    const withNode = dom('d1', { faction: '赤焰王国', factionColor: '#123456' });
    assert(G.resolveDomainColor(withNode, {}) === '#123456', '节点 factionColor 应优先于名字色');
    assert(G.resolveDomainColor(withNode, { d1: '#ff00ff' }) === '#ff00ff', '预览覆盖应最优先');
    // 键必须是 domain.id：拿 faction 当键会让"未归属"的星域共用一个键
    assert(G.resolveDomainColor(dom('d2', { faction: 'x' }), { x: '#ff0000' }) !== '#ff0000',
      '覆盖表的键是 faction 而不是 id —— 会串色');
    return 'ok';
  });

  check('b1 星域布局：环形半径 = 700×0.9；单个星域落在原点；遗留 coordinate 不采信', () => {
    const ds = [dom('a', { coordinate: { x: 737, y: 131 } }), dom('b', { coordinate: { x: 864, y: 184 } })];
    const out = G.layoutDomains(ds, {});
    assert(out.length === 2, '数量不对');
    const r0 = Math.hypot(out[0].x, out[0].y);
    assert(Math.abs(r0 - 630) < 1e-6, `半径应为 630，实测 ${r0}`);
    assert(!(out[0].x === 737 && out[0].y === 131), '遗留 coordinate 被采信了（老项目会全部错位）');
    assert(out[0].factionColor !== undefined && out[0].radius === 350, '应带上 factionColor / radius');
    const one = G.layoutDomains([dom('solo', { coordinate: { x: 9, y: 9 } })], {});
    assert(one[0].x === 0 && one[0].y === 0, '单个星域应在原点');
    return 'ok';
  });

  check('b2 星域布局：userMoved 或"正在拖动"才用 coordinate', () => {
    const moved = dom('m', { userMoved: true, coordinate: { x: 40, y: -60 } });
    const out = G.layoutDomains([moved], {});
    assert(out[0].x === 40 && out[0].y === -60, JSON.stringify(out[0]));
    const dragging = dom('dr', { coordinate: { x: -12, y: 34 } });
    const out2 = G.layoutDomains([dragging], { draggingId: 'dr' });
    assert(out2[0].x === -12 && out2[0].y === 34, '拖动期应认实时坐标（否则每帧弹回环形）');
    return 'ok';
  });

  check('c1 星系布局：进所属星域簇内；无 coordinate 的星系**也要有位置**（导出曾经直接跳过）', () => {
    const domains = G.layoutDomains([dom('a'), dom('b')], {});
    const galaxies = [
      gal('g1', 'a'),                              // 完全没 coordinate
      gal('g2', 'a', { coordinate: { x: 0, y: 0 } }),   // 有 coordinate 但没 userMoved
      gal('g3', 'b'),
      gal('orphan', 'nope'),                       // 父星域不在当前世界
    ];
    const out = G.layoutGalaxies(galaxies, domains, {});
    const ids = out.map(g => g.id);
    assert(ids.includes('g1'), 'g1 没有位置（导出会缺节点）');
    assert(!ids.includes('orphan'), '孤儿星系不该出现');
    const a = domains.find(d => d.id === 'a');
    for (const g of out.filter(x => x.domainId === 'a')) {
      assert(Number.isFinite(g.x) && Number.isFinite(g.y), `${g.id} 位置不是有限数`);
      const d = Math.hypot(g.x - a.x, g.y - a.y);
      assert(d <= 100 + 60 + 1e-6, `${g.id} 离星域中心 ${d.toFixed(1)}，超出簇半径`);
    }
    assert(out.every(g => g.factionColor === a.factionColor || g.factionColor), '应带上所属星域的 factionColor');
    return `${out.length} 个星系有位置`;
  });

  check('c2 星系布局：userMoved 且仍在星域半径内才保留自己的坐标；超出则回落簇内', () => {
    const domains = G.layoutDomains([dom('a')], {});
    const a = domains[0];
    const inside = gal('in', 'a', { userMoved: true, coordinate: { x: a.x + 30, y: a.y + 20 } });
    const outside = gal('out', 'a', { userMoved: true, coordinate: { x: a.x + 900, y: a.y } });
    const out = G.layoutGalaxies([inside, outside], domains, {});
    const gIn = out.find(g => g.id === 'in'), gOut = out.find(g => g.id === 'out');
    assert(Math.abs(gIn.x - (a.x + 30)) < 1e-6, '半径内的 userMoved 坐标应保留');
    assert(Math.hypot(gOut.x - a.x, gOut.y - a.y) < 200, `半径外的旧坐标应回落簇内，实测 ${gOut.x}`);
    return 'ok';
  });

  check('d1 边界：星系数 < 3 也必须有边界（导出原先直接 continue → 星域凭空消失）', () => {
    const domains = G.layoutDomains([dom('a'), dom('b')], {});
    const galaxies = G.layoutGalaxies([gal('g1', 'a'), gal('g2', 'a'), gal('g3', 'b')], domains, {});
    const borders = G.factionBorders({ domainNodes: domains, galaxyNodes: galaxies, overrides: {} });
    assert(borders.length === 2, `应有 2 条边界（a 走凸包 / b 走多边形），实测 ${borders.length}`);
    const b = borders.find(x => x.domainId === 'b');
    assert(b && b.points.length === G.GALAXY_LAYOUT.circleSegments, '星系数不足时应画正多边形');
    const a = borders.find(x => x.domainId === 'a');
    assert(a && a.points.length >= 3, 'a 应有凸包');
    return `a=${a.points.length} 点 / b=${b.points.length} 点`;
  });

  check('d2 凸包外扩是**同一个 pad**（原先画布 50 / 导出 25）', () => {
    const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const hull = G.convexHull(sq);
    assert(hull.length === 4, `凸包应 4 点，实测 ${hull.length}`);
    const ex = G.expandHull(hull);
    const c = G.hullCenter(hull);
    const d0 = Math.hypot(hull[0].x - c.x, hull[0].y - c.y);
    const d1 = Math.hypot(ex[0].x - c.x, ex[0].y - c.y);
    assert(Math.abs((d1 - d0) - G.GALAXY_LAYOUT.hullPad) < 1e-6, `外扩量应为 ${G.GALAXY_LAYOUT.hullPad}`);
    const ex25 = G.expandHull(hull, 25);
    assert(Math.abs(Math.hypot(ex25[0].x - c.x, ex25[0].y - c.y) - (d0 + 25)) < 1e-6, 'pad 参数应生效');
    return `pad=${G.GALAXY_LAYOUT.hullPad}`;
  });

  check('d3 边界：用户覆盖点优先，且颜色取星域当前色（不是按名字哈希的第二套）', () => {
    const domains = G.layoutDomains([dom('a', { factionColor: '#abcdef' })], {});
    const pts = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }];
    const borders = G.factionBorders({ domainNodes: domains, galaxyNodes: [], overrides: { a: pts } });
    assert(borders.length === 1 && borders[0].points === pts, '覆盖点应原样使用');
    assert(borders[0].color === '#abcdef', `颜色应为星域当前色，实测 ${borders[0].color}`);
    return 'ok';
  });

  check('e1 航道配色：**4 类**互不相同；用户建的（非 auto_）与自动的必须不同', () => {
    const cs = [
      G.hyperlaneColor({ id: 'auto_1', type: 'local' }, {}),
      G.hyperlaneColor({ id: 'h1', type: 'local' }, {}),                 // 用户建的
      G.hyperlaneColor({ id: 'h2', type: 'cross_domain' }, {}),
      G.hyperlaneColor({ id: 'h3', type: 'hyperjump' }, {}),
    ];
    assert(new Set(cs).size === 4, `4 类应互不相同：${JSON.stringify(cs)}`);
    assert(G.hyperlaneColor({ id: 'auto_9', type: 'local' }, {}) === cs[0], '自动航道的色应稳定');
    assert(G.hyperlaneColor({ id: 'h1', type: 'local' }, { hovered: true }) !== cs[1], '悬停态应不同');
    assert(G.hyperlaneColor({ id: 'auto_1', type: 'local' }, { isDark: false }) !== cs[0], '亮色主题应不同');
    return cs.join(' / ');
  });

  check('e2 节点观感：星系用势力色（导出原先固定 #ffd700）；半径按层', () => {
    assert(G.nodeColor({ layer: 'galaxy', factionColor: '#ff00ff' }) === '#ff00ff', '星系应用势力色');
    assert(G.nodeColor({ layer: 'galaxy' }) === '#4a90d9', '没势力时用默认星系色');
    assert(G.nodeRadius('world') === 10 && G.nodeRadius('galaxy') === 7 && G.nodeRadius('city') === 5, '半径表变了');
    return 'ok';
  });

  check('f1 星云谱在世界坐标里固定（导出不许按图幅重掷）', () => {
    assert(Array.isArray(G.STARFIELD.nebulae) && G.STARFIELD.nebulae.length >= 2, '星云谱应至少 2 条');
    for (const n of G.STARFIELD.nebulae) {
      assert(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.r), JSON.stringify(n));
      assert(typeof n.color === 'string' && n.color.startsWith('rgba('), n.color);
    }
    return `${G.STARFIELD.nebulae.length} 条`;
  });

  check('g1 反向探针：判据本身有判别力（遗留坐标采信 / 少星系跳过 两种错法必须能被抓到）', () => {
    // ① 如果哪天有人把"遗留坐标"也认了 —— b1 的断言会红（这里直接验断言表达式）
    const legacy = G.layoutDomains([dom('a', { coordinate: { x: 737, y: 131 } })], {})[0];
    const naiveX = 737;
    assert(legacy.x !== naiveX, '反向探针失效：遗留坐标竟然被采信');
    // ② 如果哪天有人把"星系数<3 跳过"写回来 —— d1 的断言会红
    const borders = G.factionBorders({
      domainNodes: G.layoutDomains([dom('b')], {}), galaxyNodes: [], overrides: {},
    });
    assert(borders.length === 1, '反向探针失效：无星系的星域没有边界');
    return '两条错法都能被上面判据抓到';
  });

  check('h1 源码守卫：画布与导出都 import 这一份，且不许再自带第二套（App.vue 内）', () => {
    const gm = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/GalaxyMap.vue'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'src/renderer/src/App.vue'), 'utf8');
    assert(gm.includes("from '../utils/galaxyLayout'"), 'GalaxyMap 没有 import 共享模块');
    assert(app.includes("from './utils/galaxyLayout'"), 'App.vue（导出侧）没有 import 共享模块');
    for (const bad of ['convexHullForExport', 'getDomainColorForExport', 'function getNodeColor(']) {
      assert(!app.includes(bad), `App.vue 里还留着第二套实现：${bad}`);
    }
    assert(!gm.includes('function convexHull('), 'GalaxyMap 里还留着本地凸包实现');
    return 'ok';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('用例自身崩溃：', err);
  process.exit(1);
});
