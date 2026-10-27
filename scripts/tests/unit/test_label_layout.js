#!/usr/bin/env node
/**
 * Node 单元测试：文字避让排布（src/renderer/src/utils/labelLayout.js）
 *
 * 这块是"参考图那种密度"的地基：617 个城镇名 + 415 个省名 + 河名如果各画各的，
 * 2× 下就是一团墨。判据只有一条硬性的 —— **放下的任意两个标签不许相交**；
 * 其余是"放不下要换位、换完还放不下就不画"。
 *
 * 用法：node scripts/tests/unit/test_label_layout.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'labelLayout.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

/** 一笔固定量字：每字 10 宽、行高 12 */
const measure = (text) => ({ w: String(text).length * 10, h: 12 });

function overlaps(a, b) {
  return !(a.box.x1 <= b.box.x0 || b.box.x1 <= a.box.x0 || a.box.y1 <= b.box.y0 || b.box.y1 <= a.box.y0);
}
function assertNoOverlap(placed, pad = 0) {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      const hit = !(a.box.x1 + pad <= b.box.x0 || b.box.x1 + pad <= a.box.x0
        || a.box.y1 + pad <= b.box.y0 || b.box.y1 + pad <= a.box.y0);
      if (hit) throw new Error(`「${a.text}」与「${b.text}」重叠：${JSON.stringify([a.box, b.box])}`);
    }
  }
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { layoutLabels, LABEL_PRIORITY, AREA_LABEL_PLACEMENTS } = mod;

  check('t1 同一坐标三个标签：高优先级占位，其余换位或丢弃，任意两个不相交', () => {
    const placed = layoutLabels([
      { text: 'AAA', x: 100, y: 100, priority: 10, placements: [{ dx: 0, dy: 0 }] },
      { text: 'BBBB', x: 100, y: 100, priority: 20, placements: [{ dx: 0, dy: 0 }] },
      { text: 'CCCCC', x: 100, y: 100, priority: 30, placements: [{ dx: 0, dy: 0 }] },
    ], { measure, pad: 2 });
    eq(placed.length, 1, '只有一个落点 → 只该放一个');
    eq(placed[0].text, 'CCCCC', '优先级最高的先占');
    assertNoOverlap(placed);
    return '1/3 放下（最高优先级）';
  });

  check('t2 贴边落点：right / left / above / below 的框位置各就各位', () => {
    const one = (pl) => layoutLabels([{ text: 'AB', x: 100, y: 100, placements: [pl] }], { measure });
    const r = one({ mode: 'right', gap: 5 })[0];
    eq(r.box.x0, 105, 'right.x0 = x + gap');
    eq(r.box.x1, 125, 'right.x1');
    eq(r.box.y0, 94, 'right 垂直居中');
    const l = one({ mode: 'left', gap: 5 })[0];
    eq(l.box.x1, 95, 'left.x1 = x - gap');
    const a = one({ mode: 'above', gap: 5 })[0];
    eq(a.box.y1, 95, 'above.y1 = y - gap');
    const b = one({ mode: 'below', gap: 5 })[0];
    eq(b.box.y0, 105, 'below.y0 = y + gap');
    return 'right/left/above/below 各 2 项断言';
  });

  check('t3 首选落点被障碍物占住 → 自动换第二个落点', () => {
    const placed = layoutLabels([{
      text: 'AB', x: 100, y: 100,
      placements: [{ mode: 'right', gap: 5 }, { mode: 'left', gap: 5 }],
      obstacles: [{ x0: 102, y0: 80, x1: 140, y1: 120 }],   // 右侧被占
    }], { measure, pad: 2 });
    eq(placed.length, 1, '应换位而不是丢弃');
    eq(placed[0].place, 1, '用了第二个落点');
    assert(placed[0].box.x1 <= 95, `应在左侧：${JSON.stringify(placed[0].box)}`);
    return 'place=1，落在左侧';
  });

  check('t4 所有落点都被占 → 丢弃（宁可没有字，不许叠着画）', () => {
    const placed = layoutLabels([{
      text: 'AB', x: 100, y: 100,
      placements: [{ mode: 'right', gap: 5 }],
      obstacles: [{ x0: 90, y0: 70, x1: 160, y1: 130 }],
    }], { measure });
    eq(placed.length, 0, '应丢弃');
    return '0';
  });

  check('t5 视口边界：中心点出界的不放（更不会为了放它把字挪到图外）', () => {
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
    const placed = layoutLabels([
      { text: 'AB', x: 10, y: 10 },
      { text: 'CD', x: 500, y: 10 },
    ], { measure, bounds });
    eq(placed.length, 1, '只放界内那个');
    eq(placed[0].text, 'AB', '留下的是界内');
    return '1/2';
  });

  check('t6 100 个同点标签：全部互不相交，且至少放下 1 个', () => {
    const cands = [];
    for (let i = 0; i < 100; i++) {
      cands.push({
        text: 'N' + i, x: 500, y: 400, priority: i,
        placements: [{ dx: 0, dy: 0 }, { mode: 'right', gap: 4 }, { mode: 'above', gap: 4 }],
      });
    }
    const placed = layoutLabels(cands, { measure, pad: 2 });
    assert(placed.length >= 1, '至少放 1 个');
    assertNoOverlap(placed, 2);
    return `${placed.length}/100 放下，无重叠`;
  });

  check('t7 空文本 / 零宽 / 缺 measure：返回空，不抛', () => {
    eq(layoutLabels([], { measure }).length, 0, '空候选');
    eq(layoutLabels([{ text: '', x: 0, y: 0 }], { measure }).length, 0, '空文本');
    eq(layoutLabels([{ text: 'AB', x: 0, y: 0 }], { measure: () => ({ w: 0, h: 0 }) }).length, 0, '零宽');
    eq(layoutLabels([{ text: 'AB', x: 0, y: 0 }], {}).length, 0, '缺 measure');
    return '[]';
  });

  check('t8 默认优先级表覆盖四档且顺序合理（势力 > 首都 > 省 > 城镇 > 河）', () => {
    assert(LABEL_PRIORITY.polity > LABEL_PRIORITY.capital, '势力 > 首都');
    assert(LABEL_PRIORITY.capital > LABEL_PRIORITY.province, '首都 > 省名');
    assert(LABEL_PRIORITY.province > LABEL_PRIORITY.town, '省名 > 城镇');
    assert(LABEL_PRIORITY.town > LABEL_PRIORITY.river, '城镇 > 河名');
    return JSON.stringify(LABEL_PRIORITY);
  });

  check('t9 同优先级保持输入顺序（排布要可复现）', () => {
    const placed = layoutLabels([
      { text: 'AAAA', x: 100, y: 100 },
      { text: 'BBBB', x: 100, y: 100 },
    ], { measure });
    eq(placed.length, 1, '同点只放一个');
    eq(placed[0].text, 'AAAA', '先到先得');
    return 'AAAA';
  });

  check('t10 保留区（reserve）：地形注记走廊里的标签必须让开或丢掉', () => {
    const cand = { text: '省名', x: 100, y: 100 };
    const free = layoutLabels([cand], { measure });
    eq(free.length, 1, '无保留区时应放下');
    assert(Math.abs(free[0].cx - 100) < 1e-6 && Math.abs(free[0].cy - 100) < 1e-6, '无保留区时应落在原位');
    // 走廊正好盖住候选落点 → 不许压上去
    const blocked = layoutLabels([{ ...cand, placements: [{ dx: 0, dy: 0 }] }], {
      measure,
      reserve: [{ x0: 60, y0: 90, x1: 140, y1: 110 }],
    });
    for (const p of blocked) {
      const overlaps = !(p.box.x1 <= 60 || p.box.x0 >= 140 || p.box.y1 <= 90 || p.box.y0 >= 110);
      assert(!overlaps, `压到保留区了：${JSON.stringify(p.box)}`);
    }
    // 有备选落点的（省名）应被挪出去而不是丢掉
    const nudged = layoutLabels([{ ...cand, placements: AREA_LABEL_PLACEMENTS }], {
      measure,
      reserve: [{ x0: 60, y0: 90, x1: 140, y1: 110 }],
    });
    eq(nudged.length, 1, '有备选落点时应挪开而不是丢');
    assert(Math.abs(nudged[0].cy - 100) > 1e-6 || Math.abs(nudged[0].cx - 100) > 1e-6, '位置应真的变了');
    // 脏保留区不抛
    const dirty = layoutLabels([cand], { measure, reserve: [null, { x0: NaN }, { x0: 1, y0: 1, x1: 2, y1: 2 }] });
    eq(dirty.length, 1, '脏框只跳过、不影响正常排布（这个候选被小框挡住就该丢）');
    return `free=1 blocked=${blocked.length} nudged=${nudged.length}`;
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
