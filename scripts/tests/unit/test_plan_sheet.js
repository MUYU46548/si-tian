#!/usr/bin/env node
/**
 * Node 单元测试：平面图出图版式（src/renderer/src/interior/planSheet.js）
 *
 * 出图这一刀最怕的不是"画得丑"，是**图面上的东西互相压住**、比例尺写错、面积合计对不上。
 * 这些全是数字，所以在这里判，不靠看截图。
 *
 * 用法：node scripts/tests/unit/test_plan_sheet.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'interior', 'planSheet.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, tol, label) {
  if (!Number.isFinite(a) || Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

/** 假 ctx：只实现 measureText，用来测截断（真 canvas 在 Node 里没有） */
function fakeCtx(perChar = 7) {
  return { measureText: (s) => ({ width: String(s).length * perChar }) };
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const {
    pickScale, scaleBarPlan, planTableRows, buildPlanSheet, fitText,
    PX_PER_CM_PAPER, SCALE_DENOMS, SHEET_PAPERS,
  } = mod;

  check('p1 9m×6.5m 的民居：1:50 就能放下（能用最大比例就用最大的）', () => {
    const area = { w: 722, h: 572 };
    const r = pickScale({ w: 900, h: 650 }, area);
    assert(r.denom === 50, `应选 1:50，实际 1:${r.denom}`);
    near(r.pxPerCm, PX_PER_CM_PAPER / 50, 1e-9, 'pxPerCm');
    assert(900 * r.pxPerCm <= area.w && 650 * r.pxPerCm <= area.h, '应真的放得下');
    return `1:50 → ${(900 * r.pxPerCm).toFixed(0)}×${(650 * r.pxPerCm).toFixed(0)}px`;
  });

  check('p2 300m×200m 的宫殿：一路退到 1:2000 才放得下', () => {
    const r = pickScale({ w: 30000, h: 20000 }, { w: 722, h: 572 });
    assert(r.denom === 2000, `应选 1:2000，实际 1:${r.denom}`);
    assert(!r.overflow, '不该溢出');
    assert(30000 * r.pxPerCm <= 722, '宽要放得下');
    return `1:2000 → ${(30000 * r.pxPerCm).toFixed(0)}px 宽`;
  });

  check('p3 大到最大分母也放不下：标 overflow，而不是悄悄裁掉', () => {
    const r = pickScale({ w: 400000, h: 300000 }, { w: 722, h: 572 });
    assert(r.denom === SCALE_DENOMS[SCALE_DENOMS.length - 1], '应回落到最大分母');
    assert(r.overflow === true, 'overflow 必须为 true（调用方据此提示）');
    return `1:${r.denom} overflow`;
  });

  check('p4 空楼层（footprint 0）：不抛错、不溢出、给默认比例', () => {
    const r = pickScale({ w: 0, h: 0 }, { w: 722, h: 572 });
    assert(Number.isFinite(r.pxPerCm) && r.pxPerCm > 0, 'pxPerCm 必须为正');
    assert(r.overflow === false, '空楼层不算溢出');
    return `1:${r.denom}`;
  });

  check('p5 比例尺：1:50 时取 2m 整段（不超 190px），刻度 0 / 1m / 2m', () => {
    const k = PX_PER_CM_PAPER / 50;
    const b = scaleBarPlan(k, 190);
    assert(b.cm === 200, `应取 200cm，实际 ${b.cm}`);
    near(b.px, 200 * k, 0.02, '尺长 px');
    assert(b.px <= 190, '不许超过上限');
    assert(b.ticks.length === 3, '三个刻度');
    assert(b.ticks[2].label === '2m', `末端刻度应为 2m，实际 ${b.ticks[2].label}`);
    assert(b.ticks[1].label === '1', `中点刻度应为 1（米），实际 ${b.ticks[1].label}`);
    return `${b.cm}cm / ${b.px}px`;
  });

  check('p6 面积表：按面积降序、超 14 间折成"另有 N 间"、合计等于总和', () => {
    const rooms = Array.from({ length: 20 }, (_, i) => ({ name: `房${i}`, area: (i + 1) * 10000 }));
    const t = planTableRows(rooms, { maxRows: 14 });
    assert(t.rows.length === 14, `最多 14 行，实际 ${t.rows.length}`);
    assert(t.more === 6, `另有 6 间，实际 ${t.more}`);
    assert(t.count === 20, '总间数 20');
    assert(t.rows[0].area === 200000, '第一行应是最大那间');
    assert(t.rows[0].area > t.rows[1].area, '必须降序');
    near(t.total, 10000 * (20 * 21 / 2), 1e-6, '合计');
    assert(t.totalText === '210.00 ㎡', `合计文案，实际 ${t.totalText}`);
    return `14 行 + 另有 6 间，合计 ${t.totalText}`;
  });

  check('p7 面积表：没名字的给"未命名"，0/负面积不进表', () => {
    const t = planTableRows([{ name: '  ', area: 50000 }, { name: '阳台', area: 0 }, { area: -1 }], {});
    assert(t.rows.length === 1, `只该剩 1 行，实际 ${t.rows.length}`);
    assert(t.rows[0].name === '未命名', `无名应回落"未命名"，实际 ${t.rows[0].name}`);
    return t.rows[0].name;
  });

  check('p8 版式不重叠：图面 / 右侧面板 / 标题栏 三块互不压住', () => {
    const s = buildPlanSheet({
      buildingName: '听雨楼', floorName: '一层',
      footprint: { w: 900, h: 650 },
      rooms: [{ name: '大厅', area: 300000 }],
      date: '2026-11-14',
    });
    assert(s.map.x + s.map.w <= s.panel.x, `图面右边界越过了面板：${s.map.x + s.map.w} > ${s.panel.x}`);
    assert(s.panel.y + s.panel.h <= s.titleBar.y, '面板底边压到标题栏');
    assert(s.map.y + s.map.h <= s.titleBar.y, '图面底边压到标题栏');
    assert(s.header.y + s.header.h <= s.map.y, '顶栏压到图面');
    assert(s.panel.y + s.areaTable.h <= s.legend.y, '面积表压到图例');
    assert(s.legend.y + s.legend.h <= s.titleBar.y, '图例压到标题栏');
    // 图框内：四块都在 frame 里
    for (const box of [s.map, s.panel, s.titleBar, s.areaTable, s.legend]) {
      assert(box.x >= s.frame.x && box.y >= s.frame.y, '应在图框内（左/上）');
      assert(box.x + box.w <= s.frame.x + s.frame.w + 0.01, '应在图框内（右）');
      assert(box.y + box.h <= s.frame.y + s.frame.h + 0.01, '应在图框内（下）');
    }
    return `图面 ${s.map.w.toFixed(0)}×${s.map.h.toFixed(0)}，面板 ${s.panel.w}px`;
  });

  check('p9 版式数据齐：6 格标题栏、比例与控制比一致、面积合计进格', () => {
    const s = buildPlanSheet({
      buildingName: '听雨楼', floorName: '二层',
      footprint: { w: 900, h: 650 },
      rooms: [{ name: '卧室', area: 120000 }, { name: '走廊', area: 30000 }],
      date: '2026-11-14', version: '0.5.8',
    });
    assert(s.cells.length === 6, `标题栏应 6 格，实际 ${s.cells.length}`);
    const byLabel = Object.fromEntries(s.cells.map((c) => [c.label, c.value]));
    assert(byLabel['楼层'] === '二层', '楼层格');
    assert(byLabel['比例'] === `1:${s.scaleDenom}`, '比例格必须与 scaleDenom 一致');
    assert(byLabel['房间数'] === '2', `房间数格，实际 ${byLabel['房间数']}`);
    assert(byLabel['合计面积'] === '15.00 ㎡', `合计格，实际 ${byLabel['合计面积']}`);
    assert(byLabel['绘制日期'] === '2026-11-14', '日期格');
    assert(String(s.footer.text).includes('0.5.8'), '页脚带版本');
    return `${byLabel['比例']} / ${byLabel['合计面积']}`;
  });

  check('p10 平面图居中于绘图区，且给底部比例尺让出空间（不压尺子）', () => {
    const s = buildPlanSheet({ footprint: { w: 900, h: 650 }, rooms: [] });
    near(s.plan.w, 900 * s.pxPerCm, 1e-6, 'plan 宽');
    near(s.plan.h, 650 * s.pxPerCm, 1e-6, 'plan 高');
    const a = s.drawArea;
    near(s.plan.x + s.plan.w / 2, a.x + a.w / 2, 0.51, '横向居中于绘图区');
    near(s.plan.y + s.plan.h / 2, a.y + a.h / 2, 0.51, '纵向居中于绘图区');
    assert(a.y + a.h <= s.map.y + s.map.h - 40 + 0.01, '绘图区底部应让出 40px 给比例尺');
    return `plan ${s.plan.w.toFixed(0)}×${s.plan.h.toFixed(0)}，绘图区底 ${a.y + a.h}`;
  });

  check('p11 空楼层：empty=true，标题栏照样 6 格（不许少格/缺字段）', () => {
    const s = buildPlanSheet({ buildingName: '空屋', floorName: '一层', footprint: { w: 0, h: 0 }, rooms: [] });
    assert(s.empty === true, '应判空');
    assert(s.cells.length === 6, '标题栏格数');
    assert(s.table.count === 0, '房间数 0');
    assert(s.table.totalText === '0.00 ㎡', `合计文案，实际 ${s.table.totalText}`);
    return '空楼层版式完整';
  });

  check('p12 纸张：A4/A3 两档，A3 更宽更高且图面更大', () => {
    const a4 = buildPlanSheet({ footprint: { w: 900, h: 650 }, paper: 'A4' });
    const a3 = buildPlanSheet({ footprint: { w: 900, h: 650 }, paper: 'A3' });
    assert(a4.paper.w === SHEET_PAPERS.A4.w && a4.paper.h === SHEET_PAPERS.A4.h, 'A4 尺寸');
    assert(a3.paper.w === SHEET_PAPERS.A3.w && a3.paper.h === SHEET_PAPERS.A3.h, 'A3 尺寸');
    assert(a3.map.w > a4.map.w && a3.map.h > a4.map.h, 'A3 的图面应更大');
    return `A4 ${a4.map.w.toFixed(0)}px → A3 ${a3.map.w.toFixed(0)}px`;
  });

  check('p13 长名字截断：超宽加省略号，且不超宽', () => {
    const ctx = fakeCtx(7);
    const out = fitText(ctx, '一个特别特别特别长的房间名字要截断', 70);
    assert(out.endsWith('…'), `应截断，实际 ${out}`);
    assert(ctx.measureText(out).width <= 70 + 7, '截断后应基本放得下');
    assert(fitText(ctx, '短名', 200) === '短名', '放得下就原样');
    return out;
  });

  check('p14 面积表高度随行数变：两间房时不该留一大片空白，也不越过图例', () => {
    const few = buildPlanSheet({ footprint: { w: 900, h: 650 }, rooms: [{ name: 'A', area: 10000 }, { name: 'B', area: 20000 }] });
    const many = buildPlanSheet({ footprint: { w: 900, h: 650 }, rooms: Array.from({ length: 30 }, (_, i) => ({ name: `R${i}`, area: 1e4 })) });
    assert(few.areaTable.h < 160, `两间房时表高应 <160，实际 ${few.areaTable.h}`);
    assert(many.areaTable.h > few.areaTable.h, '房间多时表更高');
    assert(many.areaTable.h <= many.panel.h - 176 + 1, '表高不许越过图例位置');
    assert(many.areaTable.y + many.areaTable.h <= many.legend.y, '表压到图例');
    return `2 间 ${few.areaTable.h}px / 30 间 ${many.areaTable.h}px`;
  });

  check('p15 指北针在抬头行里（图面常被墙填满，放图里必被压）', () => {
    const s = buildPlanSheet({ footprint: { w: 900, h: 650 }, rooms: [] });
    assert(s.north.cy > s.header.y && s.north.cy < s.header.y + s.header.h, '指北针应在抬头行纵向范围内');
    assert(s.north.cy < s.map.y, '指北针不许压进图面');
    return `cy=${s.north.cy}（图面从 ${s.map.y} 开始）`;
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
