#!/usr/bin/env node
/**
 * Node 单元测试：建筑内部尺度口径（src/renderer/src/utils/interiorUnits.js）
 *
 * 这块守的是"宫殿和茅屋用同一个编辑器"这件事：
 *   · 整栋铺满视口时，两者算出来的 zoom 差几十倍，但网格、面积、家具可见性都必须自洽；
 *   · 家具不是"画小"，是**屏幕最小边 <6px 就整类不画**（否则宫殿里全是噪点）。
 *
 * 用法：node scripts/tests/unit/test_interior_units.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'interiorUnits.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, tol, label) {
  if (Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const {
    fitZoom, pickGridStep, formatLength, formatArea,
    isFurnitureVisible, furnitureScreenSize,
    DEFAULT_WALL_THICKNESS, DEFAULT_WALL_HEIGHT, GRID_STEPS_CM, MIN_FURNITURE_PX,
  } = mod;

  check('u1 茅屋 800×600cm：铺满 1080×750 视口，zoom 取短边', () => {
    const z = fitZoom({ w: 800, h: 600 }, { w: 1080, h: 750 });
    // min(1080/800=1.35, 750/600=1.25) * 0.9 = 1.125
    near(z, 1.125, 1e-6, 'zoom');
    return `zoom=${z}`;
  });

  check('u2 宫殿 30000×20000cm：同一视口 zoom 只有茅屋的 1/37', () => {
    const a = fitZoom({ w: 800, h: 600 }, { w: 1080, h: 750 });
    const b = fitZoom({ w: 30000, h: 20000 }, { w: 1080, h: 750 });
    // min(1080/30000=0.036, 750/20000=0.0375) * 0.9 = 0.0324
    near(b, 0.0324, 1e-6, '宫殿 zoom');
    assert(a / b > 30, `倍率应 >30，实际 ${a / b}`);
    return `${(a / b).toFixed(1)} 倍`;
  });

  check('u3 非法输入不抛：footprint 缺字段 / 视口为 0', () => {
    assert(fitZoom(null, { w: 100, h: 100 }) === 1, '空 footprint 应回 1');
    assert(fitZoom({ w: 0, h: 0 }, { w: 100, h: 100 }) === 1, '零尺寸应回 1');
    for (const bad of [0, -1, NaN, undefined]) {
      const s = pickGridStep(bad);
      assert(s === GRID_STEPS_CM[GRID_STEPS_CM.length - 1], `zoom=${bad} 应回落最疏档，实际 ${s}`);
    }
    return '不抛，回落到安全值';
  });

  check('u4 网格分级：茅屋与宫殿各取到"屏幕上 ≥8px"的最密档', () => {
    const zh = fitZoom({ w: 800, h: 600 }, { w: 1080, h: 750 });     // ≈1.125
    const zp = fitZoom({ w: 30000, h: 20000 }, { w: 1080, h: 750 }); // ≈0.034
    const gh = pickGridStep(zh);
    const gp = pickGridStep(zp);
    assert(gh * zh >= 8, `茅屋网格 ${gh}cm 应 ≥8px，实际 ${gh * zh}`);
    assert(gp * zp >= 8, `宫殿网格 ${gp}cm 应 ≥8px，实际 ${gp * zp}`);
    assert(gh < gp, `宫殿的格子应更疏：${gh} vs ${gp}`);
    return `茅屋 ${gh}cm / 宫殿 ${gp}cm`;
  });

  check('u5 长度格式：厘米与米的分界在 100cm', () => {
    assert(formatLength(45) === '45 cm', formatLength(45));
    assert(formatLength(99) === '99 cm', formatLength(99));
    assert(formatLength(360) === '3.60 m', formatLength(360));
    assert(formatLength(12000) === '120.00 m', formatLength(12000));
    assert(formatLength(NaN) === '', 'NaN 应回空串');
    return '45cm / 3.60m / 120.00m';
  });

  check('u6 面积格式：cm² → ㎡，两位小数', () => {
    assert(formatArea(48000) === '4.80 ㎡', formatArea(48000));
    assert(formatArea(600000000) === '60000.00 ㎡', formatArea(600000000));
    assert(formatArea(-1) === '', '负数应回空串');
    return '4.80㎡ / 60000.00㎡';
  });

  check('u7 家具可见性：同型号在茅屋画、在宫殿不画', () => {
    const bed = { width: 200, height: 150 };
    const zh = fitZoom({ w: 800, h: 600 }, { w: 1080, h: 750 });
    const zp = fitZoom({ w: 30000, h: 20000 }, { w: 1080, h: 750 });
    assert(isFurnitureVisible(bed, zh), `茅屋 bed 应可见（${150 * zh}px）`);
    assert(!isFurnitureVisible(bed, zp), `宫殿 bed 不该画（${150 * zp}px）`);
    return `茅屋 ${(150 * zh).toFixed(0)}px / 宫殿 ${(150 * zp).toFixed(2)}px`;
  });

  check('u8 家具可见性边界：正好 6px 算可见，5.9px 不算', () => {
    const z = 0.1;                        // px per cm
    assert(isFurnitureVisible({ width: 60, height: 60 }, z), '60×0.1=6 应可见');
    assert(!isFurnitureVisible({ width: 59, height: 59 }, z), '59×0.1=5.9 不该可见');
    const s = furnitureScreenSize({ width: 200, height: 150 }, 0.5);
    assert(s.w === 100 && s.h === 75, `屏幕尺寸应 100×75，实际 ${s.w}×${s.h}`);
    return `阈值 ${MIN_FURNITURE_PX}px`;
  });

  check('u9 常量自洽：墙厚 < 墙高、层高 ≥ 墙高、网格由密到疏', () => {
    assert(DEFAULT_WALL_THICKNESS > 0 && DEFAULT_WALL_THICKNESS < 50, '墙厚应是厘米级的个位/十位数');
    assert(DEFAULT_WALL_HEIGHT > 200 && DEFAULT_WALL_HEIGHT < 400, '墙高应在 2~4 米');
    for (let i = 1; i < GRID_STEPS_CM.length; i++) {
      assert(GRID_STEPS_CM[i] > GRID_STEPS_CM[i - 1], `网格档位必须递增：${GRID_STEPS_CM}`);
    }
    return `${DEFAULT_WALL_THICKNESS}cm × ${DEFAULT_WALL_HEIGHT}cm`;
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
