#!/usr/bin/env node
/**
 * Node 单元测试：只看某一层（src/renderer/src/interior/floorView.js，A20 余）
 *
 * 守的是“切到某层看到的就是那一层的布置”，三件容易写错的事：
 *   · 该层 `elevation` 必须**归零** —— 不归零，二层会浮在 3 m 高的空中；
 *   · 该层 `stairs` 必须清空 —— 楼梯跨层，单层视图里没有“上一层”，留着会画出一跑悬空踏步；
 *   · 不选层 / 选了已删除的层时，必须**原样返回入参数组本身**（同一引用）——
 *     否则组件里 `watch` 会以为数据变了，白重建一次 3D 场景。
 *
 * 用法：node scripts/tests/unit/test_floor_view.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'interior', 'floorView.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/** ESM 源码按 data URL 载入（相对 import 递归替换；与 test_building_shell.js 同一手法） */
async function loadEsm(absPath) {
  const cache = new Map();
  const build = (p) => {
    if (cache.has(p)) return Promise.resolve(cache.get(p));
    const src = fs.readFileSync(p, 'utf8');
    const re = /from\s+'(\.\.?\/[^']+)';/g;
    const jobs = [];
    let m;
    while ((m = re.exec(src))) jobs.push({ at: m.index, end: m.index + m[0].length, spec: m[1] });
    const parts = [];
    let last = 0;
    const chain = jobs.reduce((p2, j) => p2.then(async () => {
      const child = path.resolve(path.dirname(p), j.spec);
      const url = await build(child);
      parts.push(src.slice(last, j.at) + `from '${url}';`);
      last = j.end;
    }), Promise.resolve());
    return chain.then(() => {
      const out = parts.join('') + src.slice(last);
      const url = 'data:text/javascript;base64,' + Buffer.from(out, 'utf8').toString('base64');
      cache.set(p, url);
      return url;
    });
  };
  const url = await build(absPath);
  return import(url);
}

function mkFloor(id, name, elevation, extra = {}) {
  return {
    id, name, elevation,
    walls: [{ id: `${id}-w1` }, { id: `${id}-w2` }],
    doors: [], windows: [],
    furniture: [{ id: `${id}-f1`, type: 'bed' }],
    stairs: [{ id: `${id}-s1`, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }],
    ...extra,
  };
}

async function main() {
  const mod = await loadEsm(SRC);
  const { ALL_FLOORS, floorViewOptions, floorsForView, floorViewLabel } = mod;

  const floors = [mkFloor('f2', '二层', 300), mkFloor('f1', '一层', 0)];

  check('v1 选项按标高升序，label 带楼层名与地面标高', () => {
    const opts = floorViewOptions(floors);
    assert(opts.length === 2, `选项数应为 2，实际 ${opts.length}`);
    assert(opts[0].id === 'f1', `第一项应是一层，实际 ${opts[0].id}`);
    assert(opts[1].id === 'f2', `第二项应是二层，实际 ${opts[1].id}`);
    assert(opts[0].label.includes('一层'), `label 缺楼层名：${opts[0].label}`);
    assert(opts[1].label.includes('3.00 m'), `label 缺标高：${opts[1].label}`);
    return opts.map((o) => o.label).join(' / ');
  });

  check('v2 楼层没有名字时用“第 N 层”兜底（不出现空标签）', () => {
    const opts = floorViewOptions([{ id: 'a', elevation: 0 }, { id: 'b', name: '  ', elevation: 300 }]);
    assert(opts[0].label.startsWith('第 1 层'), `兜底失败：${opts[0].label}`);
    assert(opts[1].label.startsWith('第 2 层'), `兜底失败：${opts[1].label}`);
    return opts.map((o) => o.label).join(' / ');
  });

  check('v3 不选层（all / null / 空串）→ 原样返回入参数组本身（同一引用）', () => {
    assert(floorsForView(floors, ALL_FLOORS) === floors, 'all 应返回同一引用');
    assert(floorsForView(floors, null) === floors, 'null 应返回同一引用');
    assert(floorsForView(floors, '') === floors, '空串应返回同一引用');
    return '同一引用';
  });

  check('v4 选中二层 → 只剩 1 层、elevation 归零、stairs 清空、家具与墙保留', () => {
    const out = floorsForView(floors, 'f2');
    assert(out.length === 1, `应为 1 层，实际 ${out.length}`);
    assert(out[0].id === 'f2', `层 id 不对：${out[0].id}`);
    assert(out[0].elevation === 0, `elevation 应归零，实际 ${out[0].elevation}`);
    assert(Array.isArray(out[0].stairs) && out[0].stairs.length === 0, 'stairs 应清空');
    assert(out[0].furniture.length === 1, '家具不该被丢');
    assert(out[0].walls.length === 2, '墙不该被丢');
    return 'elevation 300 → 0，stairs 1 → 0';
  });

  check('v5 不改入参：原楼层的 elevation 与 stairs 一个都没动', () => {
    floorsForView(floors, 'f2');
    const f2 = floors.find((f) => f.id === 'f2');
    assert(f2.elevation === 300, `原 elevation 被改了：${f2.elevation}`);
    assert(f2.stairs.length === 1, '原 stairs 被改了');
    return '入参未动';
  });

  check('v6 选中一个不存在的楼层（比如刚被删掉）→ 回落全部，同一引用', () => {
    const out = floorsForView(floors, 'ghost');
    assert(out === floors, '不存在的 id 应返回同一引用（回落全部）');
    return '回落全部';
  });

  check('v7 传 null / 非数组不炸', () => {
    assert(Array.isArray(floorsForView(null, 'f1')), 'null 应返回数组');
    assert(Array.isArray(floorsForView(undefined, ALL_FLOORS)), 'undefined 应返回数组');
    return '空数组';
  });

  check('v8 两层同标高时顺序稳定（不来回换位）', () => {
    const same = [mkFloor('a', '甲', 0), mkFloor('b', '乙', 0)];
    const o1 = floorViewOptions(same).map((o) => o.id).join(',');
    const o2 = floorViewOptions(same).map((o) => o.id).join(',');
    assert(o1 === o2, `同标高两次排序不一致：${o1} vs ${o2}`);
    return o1;
  });

  check('v9 floorViewLabel：全部楼层 → 空串；选中某层 → 那一层的 label', () => {
    assert(floorViewLabel(floors, ALL_FLOORS) === '', 'all 应为空串');
    assert(floorViewLabel(floors, 'f1').includes('一层'), 'f1 的 label 不对');
    assert(floorViewLabel(floors, 'ghost') === '', '不存在的 id 应为空串');
    return 'all 空串 / f1 有名字';
  });

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : '  FAIL'}  ${r.name}${r.detail ? `  —— ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('\n失败明细：');
    for (const r of bad) console.log(` - ${r.name}\n   ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
