#!/usr/bin/env node
/**
 * Node 单元测试：省份命中的**空间索引**（src/renderer/src/utils/provinceHitIndex.js）
 *
 * 为什么必须有这一层（2026-10-23，第 1 件 1-a）：
 *   旧 `findProvinceAt` 是**全表线性扫描**，真实 200 省底图上实测 20.4ms/次；「涂归属」一次
 *   mousemove 要查 5 个偏移 = 96.9ms（帧统计 p95 117ms）。换索引后必须证明**语义一个字节都没变**：
 *     ① 候选按原始下标降序（数组靠后的省盖在上面）—— 压叠时点中的仍是"视觉最上面"那个；
 *     ② 洞真的点不中、飞地真的点得中（绕数规则仍只走 `pointInProvince`）；
 *     ③ 没有有效环的省整省跳过；点落在包围盒外恒为 null。
 *   这些在 CDP 用例里只能看到"点错了省"，定位不到是哪条规则破的 —— 所以在纯函数层逐点对拍。
 *
 * ⚠️ 加载方式与 test_polygon_bool.js 同：复制到临时目录 + 写 `{"type":"module"}`，补相对 import 的 `.js`。
 *
 * 用法：node scripts/tests/unit/test_province_hit_index.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['provinceHitIndex.js', 'provinceShape.js', 'geometry.js', 'polylineSmooth.js', 'gridOutline.js'];

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

function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

// ── 造省工具（顶点必须是 {x,y}；环不要求闭合）─────────────────────────────
const P = (x, y) => ({ x, y });
const sq = (x, y, w, h) => [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
const circle = (cx, cy, r, n = 24) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(P(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
};
const Lshape = (x, y, w, h) => [
  P(x, y), P(x + w, y), P(x + w, y + h / 3), P(x + w / 3, y + h / 3), P(x + w / 3, y + h), P(x, y + h),
];

/** 朴素实现：与改造前的 findProvinceAt 逐字一致（对拍基准） */
function naiveFind(terrain, x, y, PS) {
  for (let i = terrain.length - 1; i >= 0; i--) {
    const prov = terrain[i];
    if (!prov) continue;
    if (!PS.provinceRings(prov).length) continue;
    if (PS.pointInProvince(x, y, prov)) return prov;
  }
  return null;
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-hitidx-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const IDX = await import(pathToFileURL(path.join(tmp, 'provinceHitIndex.js')).href);
  const PS = await import(pathToFileURL(path.join(tmp, 'provinceShape.js')).href);
  assert(typeof IDX.buildProvinceHitIndex === 'function', 'buildProvinceHitIndex 没导出');
  assert(typeof IDX.hitProvince === 'function', 'hitProvince 没导出');
  assert(typeof IDX.createProvinceHitCache === 'function', 'createProvinceHitCache 没导出');

  // ── ① 与朴素扫描**逐点对拍**（含随机压叠 / 洞 / 飞地 / 坏点）──────────────
  check('随机 80 省 × 3000 点：索引命中 === 朴素扫描（逐点对拍）', () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const terrain = [];
    for (let i = 0; i < 80; i++) {
      const x = rnd() * 1600 - 800, y = rnd() * 1200 - 600;
      const kind = i % 7;
      if (kind === 0) {
        terrain.push({ id: 'p' + i, name: '方' + i, kind: 'land', points: sq(x, y, 40 + rnd() * 200, 30 + rnd() * 160) });
      } else if (kind === 1) {
        terrain.push({ id: 'p' + i, name: '圆' + i, kind: 'land', points: circle(x, y, 20 + rnd() * 120) });
      } else if (kind === 2) {
        // 带洞：外框 + 内框（内框在外框内部，深度 1 → 符号 -1）
        terrain.push({
          id: 'p' + i, name: '环' + i, kind: 'land', points: sq(x, y, 200, 200),
          extraRings: [{ points: sq(x + 70, y + 70, 60, 60), kind: 'land' }],
        });
      } else if (kind === 3) {
        // 飞地：两块互不相交的环（都算实心）
        terrain.push({
          id: 'p' + i, name: '飞' + i, kind: 'land', points: sq(x, y, 80, 80),
          extraRings: [{ points: sq(x + 300, y + 300, 80, 80), kind: 'land' }],
        });
      } else if (kind === 4) {
        terrain.push({ id: 'p' + i, name: 'L' + i, kind: 'land', points: Lshape(x, y, 160, 160) });
      } else if (kind === 5) {
        terrain.push({ id: 'p' + i, name: '空' + i, kind: 'land', points: [] });     // 无环 → 必须跳过
      } else {
        terrain.push({ id: 'p' + i, name: '怪' + i, kind: 'land', points: [{ x: NaN, y: 0 }, { x: 1, y: NaN }] });
      }
    }
    const index = IDX.buildProvinceHitIndex(terrain);
    let mismatches = 0, hits = 0;
    const firstBad = [];
    for (let k = 0; k < 3000; k++) {
      const x = rnd() * 2200 - 1100, y = rnd() * 1600 - 800;
      const a = IDX.hitProvince(index, x, y);
      const b = naiveFind(terrain, x, y, PS);
      if (a) hits++;
      if ((a && a.id) !== (b && b.id)) {
        mismatches++;
        if (firstBad.length < 3) firstBad.push(`(${x.toFixed(1)},${y.toFixed(1)}) idx=${a && a.id} naive=${b && b.id}`);
      }
    }
    assert(mismatches === 0, `有 ${mismatches} 个点对不上：${firstBad.join('；')}`);
    assert(hits > 200, `命中点太少（${hits}/3000），对拍没有代表性`);
    return `${hits}/3000 命中，0 处不一致（${index.stats.indexed} 省入索引 / ${index.stats.cells} 格 / 建 ${index.stats.buildMs}ms）`;
  });

  // ── ② 压叠：靠后的省盖在上面（与 findProvinceAt 同一条）────────────────
  check('两块完全重叠的省：命中靠后的那块（画在上面的那块）', () => {
    const terrain = [
      { id: 'under', name: '下', kind: 'land', points: sq(0, 0, 100, 100) },
      { id: 'over', name: '上', kind: 'land', points: sq(0, 0, 100, 100) },
    ];
    const index = IDX.buildProvinceHitIndex(terrain);
    const got = IDX.hitProvince(index, 50, 50);
    assert(got && got.id === 'over', `应命中 over，实际 ${got && got.id}`);
    assert(naiveFind(terrain, 50, 50, PS).id === 'over', '对拍基准自己也必须是 over');
    return 'over 胜出';
  });

  // ── ③ 洞与飞地 ──────────────────────────────────────────────────────────
  check('洞：环上的点点得中、洞心点不中；飞地：两块的内部都点得中', () => {
    const donut = {
      id: 'donut', name: '甜甜圈', kind: 'land', points: sq(0, 0, 200, 200),
      extraRings: [{ points: sq(70, 70, 60, 60), kind: 'land' }],
    };
    const island = {
      id: 'island', name: '飞地', kind: 'land', points: sq(1000, 0, 50, 50),
      extraRings: [{ points: sq(1200, 0, 50, 50), kind: 'land' }],
    };
    const index = IDX.buildProvinceHitIndex([donut, island]);
    assert(IDX.hitProvince(index, 20, 100)?.id === 'donut', '外环上的点应命中');
    assert(IDX.hitProvince(index, 100, 100) === null, '洞心不该命中');
    assert(IDX.hitProvince(index, 1020, 20)?.id === 'island', '主环应命中');
    assert(IDX.hitProvince(index, 1220, 20)?.id === 'island', '飞地环应命中');
    // 与朴素实现一致
    assert(naiveFind([donut, island], 100, 100, PS) === null, '基准实现也不该命中洞心');
    return '洞/飞地 4 点全对';
  });

  // ── ④ 包围盒外 / 空表 / 坏数据 ──────────────────────────────────────────
  check('空表、包围盒外、非有限坐标：一律 null（不抛异常）', () => {
    const index = IDX.buildProvinceHitIndex([{ id: 'a', points: sq(0, 0, 10, 10) }]);
    assert(IDX.hitProvince(IDX.buildProvinceHitIndex([]), 0, 0) === null, '空表应为 null');
    assert(IDX.hitProvince(index, -1, -1) === null, '包围盒外应为 null');
    assert(IDX.hitProvince(index, 1e9, 1e9) === null, '远处应为 null');
    assert(IDX.hitProvince(index, NaN, 0) === null, 'NaN 应为 null');
    assert(IDX.hitProvince(null, 0, 0) === null, '索引为 null 时应为 null');
    return 'ok';
  });

  // ── ⑤ 巨型包围盒（覆盖全图）走"每查都测"那条路，也必须正确 ─────────────
  check('一个覆盖全图的省（巨型表路径）+ 小省：仍按"靠后盖上面"判', () => {
    const big = { id: 'big', name: '大', kind: 'land', points: sq(-5000, -5000, 10000, 10000) };
    const small = { id: 'small', name: '小', kind: 'land', points: sq(10, 10, 20, 20) };
    // 默认格子很粗（整图 1 格）→ 大省落在普通格；这里把格子调细，逼它进"巨型"分支
    const fine = IDX.buildProvinceHitIndex([big, small], { cell: 10 });
    assert(fine.huge.length >= 1, `大省应进巨型表（实际 huge=${fine.huge.length} / cells=${fine.cells.size}）`);
    assert(IDX.hitProvince(fine, 20, 20)?.id === 'small', '小省盖在大省上面，应命中 small');
    assert(IDX.hitProvince(fine, 3000, 3000)?.id === 'big', '小省外应命中 big');
    // 反过来：大省在后面 → 大省盖住小省
    const fine2 = IDX.buildProvinceHitIndex([small, big], { cell: 10 });
    assert(IDX.hitProvince(fine2, 20, 20)?.id === 'big', '大省在后应盖住小省');
    // 粗格子（默认）也要对 —— 两条路径都过才算数
    assert(IDX.hitProvince(IDX.buildProvinceHitIndex([big, small]), 20, 20)?.id === 'small', '粗格子路径不对');
    return `巨型表 ${fine.huge.length} 条 / 细格子 ${fine.cells.size} 格`;
  });

  // ── ⑥ 缓存：同引用复用、换引用重建 ──────────────────────────────────────
  check('缓存按 terrain 引用：同引用复用同一个索引，换数组就重建', () => {
    const t1 = [{ id: 'a', points: sq(0, 0, 10, 10) }];
    const cache = IDX.createProvinceHitCache();
    const i1 = cache.get(t1);
    const i2 = cache.get(t1);
    assert(i1 === i2, '同一 terrain 引用应返回同一个索引对象');
    const t2 = t1.concat([{ id: 'b', points: sq(20, 0, 10, 10) }]);
    const i3 = cache.get(t2);
    assert(i3 !== i1, '换了数组引用必须重建');
    assert(cache.stats().cached === true, 'stats 应报告已缓存');
    return `t1 → ${i1.stats.cells} 格 / t2 → ${i3.stats.cells} 格`;
  });

  // ── ⑦ 性能底价（宽松上限：只防"退回线性扫描"，不当基准跑）────────────────
  check('500 省：建索引 + 2000 次查询都在可接受量级（防性能回退）', () => {
    const terrain = [];
    for (let i = 0; i < 500; i++) {
      const x = (i % 25) * 80, y = Math.floor(i / 25) * 80;
      terrain.push({ id: 'p' + i, name: '省' + i, kind: 'land', points: circle(x + 30, y + 30, 25, 16) });
    }
    const t0 = Date.now();
    const index = IDX.buildProvinceHitIndex(terrain);
    const buildMs = Date.now() - t0;
    let hits = 0;
    const t1 = Date.now();
    for (let k = 0; k < 2000; k++) {
      // 圆心取样（圆半径 25、圆心在 +30,+30）
      if (IDX.hitProvince(index, (k % 25) * 80 + 30, Math.floor(k / 25) % 20 * 80 + 30)) hits++;
    }
    const queryMs = Date.now() - t1;
    assert(buildMs < 400, `建索引太慢：${buildMs}ms（500 省）`);
    assert(queryMs < 300, `2000 次查询太慢：${queryMs}ms`);
    assert(hits > 1000, `命中数异常：${hits}/2000`);
    return `建 ${buildMs}ms / 2000 查 ${queryMs}ms（每次 ${(queryMs / 2000).toFixed(3)}ms）/ 命中 ${hits}`;
  });

  // ── ⑧ 反向探针：故意破坏索引必须能被对上（证明①不是空转）────────────────
  check('反向探针：把候选顺序改成正序 → 压叠场景立刻对不上', () => {
    const terrain = [
      { id: 'under', name: '下', kind: 'land', points: sq(0, 0, 100, 100) },
      { id: 'over', name: '上', kind: 'land', points: sq(0, 0, 100, 100) },
    ];
    const index = IDX.buildProvinceHitIndex(terrain);
    const forward = [...index.entries].sort((a, b) => a.index - b.index);
    // 手工按"正序"模拟旧口径的错误实现
    let wrong = null;
    for (const e of forward) {
      if (PS.pointInProvince(50, 50, e.prov, e)) { wrong = e.prov; break; }
    }
    assert(wrong && wrong.id === 'under', `正序模拟应命中 under（得到 ${wrong && wrong.id}）`);
    assert(IDX.hitProvince(index, 50, 50).id === 'over', '真实现必须命中 over');
    return '正序=under（错） / 真实现=over（对）';
  });

  report(results);
}

function report(rows) {
  const failed = rows.filter((r) => !r.ok);
  for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${rows.length - failed.length}/${rows.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 单测自身异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});

