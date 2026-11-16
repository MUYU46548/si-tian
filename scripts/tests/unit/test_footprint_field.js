/**
 * interior/footprintField.js 单测（台账 A21，2026-11-16）
 *
 * 这条字段唯一真正的风险是**陈旧**：地图上按墙算 9 米、信息条读旧字段 12 米。
 * 所以判据分三组：
 *   ① 数值口径 —— w/h 是**含墙厚外扩**的最小外接矩形长边/短边，面积是外轮廓面积；
 *   ② 指纹 —— 哪些改动该让它失效（拖端点、删墙）、哪些不该（改颜色、改高度、重排数组）；
 *   ③ 读侧兜底 —— 字段新鲜就用字段，指纹对不上就现算，形状坏了不算数。
 *
 * 用法：node scripts/tests/unit/test_footprint_field.js
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/footprintField.js')).href);
const { footprintStamp, footprintField, readFootprint, describeFootprint } = mod;
const symbolMod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/buildingSymbol.js')).href);

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push({ name, ok: true });
    console.log(`  [OK] ${name}${note ? ` - ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  [FAIL] ${name} - ${e && e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}: 期望 ${b}, 实际 ${a}`);
}

/** 一间矩形房（四面墙沿中心线围合，墙厚 t） */
function floor(w = 900, d = 650, t = 12, id = 'f1') {
  return {
    id,
    elevation: 0,
    walls: [
      { id: `${id}-w0`, start: { x: 0, y: 0 }, end: { x: w, y: 0 }, thickness: t, height: 280, color: '#8d7f6e' },
      { id: `${id}-w1`, start: { x: w, y: 0 }, end: { x: w, y: d }, thickness: t, height: 280, color: '#8d7f6e' },
      { id: `${id}-w2`, start: { x: w, y: d }, end: { x: 0, y: d }, thickness: t, height: 280, color: '#8d7f6e' },
      { id: `${id}-w3`, start: { x: 0, y: d }, end: { x: 0, y: 0 }, thickness: t, height: 280, color: '#8d7f6e' },
    ],
  };
}

check('f1 没有墙就没有尺寸（空数组 / null / undefined 都返回 null）', () => {
  assert(footprintField([]) === null, '空数组应返回 null');
  assert(footprintField(null) === null, 'null 应返回 null');
  assert(footprintField(undefined) === null, 'undefined 应返回 null');
  assert(footprintField([{ walls: [] }]) === null, '有层没墙应返回 null');
  return '无墙一律 null';
});

check('f2 900x650 的房：外接 9.12 x 6.62 m（含墙厚外扩）', () => {
  const fp = footprintField([floor(900, 650, 12)]);
  assert(fp, '应算出字段');
  // 墙中心线沿边界，两侧各外扩半个墙厚 6cm → 900+12 = 912 / 650+12 = 662
  near(fp.w, 912, 0.6, '长边');
  near(fp.h, 662, 0.6, '短边');
  return `${fp.w} x ${fp.h} cm`;
});

check('f3 面积与 buildFootprint 同一口径（外轮廓，院子洞已按默认填掉）', () => {
  const floors = [floor(900, 650, 12)];
  const fp = footprintField(floors);
  const raw = symbolMod.buildFootprint(floors);
  assert(raw && raw.area > 0, 'buildFootprint 应有面积');
  near(fp.area, raw.area, Math.max(1, raw.area * 0.01), '面积');
  near(fp.area, 912 * 662, 2000, '外轮廓面积应接近 912x662');
  return `${fp.area} cm2`;
});

check('f4 指纹稳定：同数据两次相同，墙数组打乱顺序也相同', () => {
  const a = [floor(900, 650)];
  const b = [floor(900, 650)];
  b[0].walls = b[0].walls.slice().reverse();
  const s1 = footprintStamp(a);
  const s2 = footprintStamp(a);
  const s3 = footprintStamp(b);
  assert(/^[0-9a-f]{8}$/.test(s1), `指纹应是 8 位十六进制，实际 ${s1}`);
  assert(s1 === s2, '同一份数据两次指纹不同');
  assert(s1 === s3, '墙数组顺序变化不该改变指纹（布尔并集与顺序无关）');
  return s1;
});

check('f5 拖一个端点：指纹必变', () => {
  const a = [floor(900, 650)];
  const b = [floor(900, 650)];
  b[0].walls[0].end.x = 920;            // 南墙右端往右拖 20cm
  assert(footprintStamp(a) !== footprintStamp(b), '拖端点后指纹没变');
  return '端点变化被捕获';
});

check('f6 改颜色 / 高度 / 层名：指纹不变（不影响平面尺寸）', () => {
  const a = [floor(900, 650)];
  const b = [floor(900, 650)];
  for (const w of b[0].walls) { w.color = '#ff0000'; w.height = 320; }
  b[0].name = '改个名';
  b[0].elevation = 300;
  assert(footprintStamp(a) === footprintStamp(b), '只改观感字段不该让占地失效');
  return '观感字段不参与指纹';
});

check('f7 字段新鲜时优先用字段（不再重算）', () => {
  const floors = [floor(900, 650)];
  const field = footprintField(floors);
  // 故意把宽高改成别的值：只要指纹对得上，就应该直接读字段（证明真的走了缓存）
  const node = { id: 'b1', footprint: { ...field, w: 123, h: 45 } };
  const got = readFootprint(node, floors);
  assert(got, '应读到尺寸');
  assert(got.source === 'field', `应走字段，实际 ${got.source}`);
  assert(got.stale === false, '新鲜字段不该标陈旧');
  assert(got.w === 123 && got.h === 45, `应原样读字段，实际 ${got.w}x${got.h}`);
  return 'source=field';
});

check('f8 指纹对不上：现算并标 stale（旧版本写的字段不会被当真）', () => {
  const floors = [floor(900, 650)];
  const stale = { w: 5000, h: 4000, area: 1, stamp: 'deadbeef' };
  const got = readFootprint({ id: 'b1', footprint: stale }, floors);
  assert(got, '应算出尺寸');
  assert(got.source === 'computed', `应现算，实际 ${got.source}`);
  assert(got.stale === true, '字段存在但对不上，应标陈旧');
  near(got.w, 912, 0.6, '现算的长边');
  return `${got.w} x ${got.h} cm（来源 computed）`;
});

check('f9 字段形状坏了（w=0 / 缺 stamp）不算新鲜', () => {
  const floors = [floor(900, 650)];
  const bad = [{ id: 'b1', footprint: { w: 0, h: 0, area: 0, stamp: footprintStamp(floors) } }];
  const got1 = readFootprint(bad[0], floors);
  assert(got1.source === 'computed', 'w=0 不该被当成有效字段');
  const got2 = readFootprint({ id: 'b1', footprint: { w: 900, h: 600 } }, floors);
  assert(got2.source === 'computed', '缺 stamp 不该被当成有效字段');
  return '坏形状走现算';
});

check('f10 文案：尺寸与面积各保留一位小数（厘米换算成米）', () => {
  const fp = footprintField([floor(900, 650)]);
  const text = describeFootprint(fp);
  assert(text === '9.1 × 6.6 m · 60.4 ㎡', `文案实际是 "${text}"`);
  assert(describeFootprint(null) === '', 'null 应给空串（UI 据此不显示整块）');
  assert(describeFootprint({ w: 0, h: 0 }) === '', '没有尺寸应给空串');
  return text;
});

check('f11 两层楼：同尺寸第二层不改变整栋，多接一间就变宽', () => {
  const one = footprintField([floor(900, 650, 12, 'f1')]);
  const twoSame = footprintField([floor(900, 650, 12, 'f1'), floor(900, 650, 12, 'f2')]);
  near(twoSame.w, one.w, 0.6, '两层完全重合时整栋宽度不该变');

  // 二层右边再接一间 400x650（与第一层墙面相接）
  const f2 = floor(400, 650, 12, 'f2');
  for (const w of f2.walls) { w.start.x += 900; w.end.x += 900; }
  const twoWide = footprintField([floor(900, 650, 12, 'f1'), f2]);
  near(twoWide.w, 1312, 1, '接一间 400 宽的房后整栋长边');
  return `${one.w} -> ${twoWide.w} cm`;
});

check('f12 负向：墙端点是 NaN 时不抛异常', () => {
  const bad = [{ id: 'f1', walls: [{ id: 'w', start: { x: NaN, y: 0 }, end: { x: NaN, y: NaN }, thickness: 12 }] }];
  let out = null;
  let threw = null;
  try { out = footprintField(bad); } catch (e) { threw = e; }
  assert(!threw, `不该抛异常，实际抛了 ${threw && threw.message}`);
  return out ? `容错后得到 ${out.w} x ${out.h}` : '容错后返回 null';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? 'FAILED' : 'PASSED'} footprintField 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
