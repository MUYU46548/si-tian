#!/usr/bin/env node
/**
 * Node 单元测试：缩放 → 详略档位 / 字号（src/renderer/src/utils/labelZoom.js）
 *
 * 这是「Paradox 式文字分层」的判定层（2026-10-27 用户点名要做）：
 *   · 缩小只看见势力名（far 档：城镇/河流/地形注记全隐）；
 *   · 放大才出城镇/河名，再大出省名（省名档与 `polityLabels` 的 0.35 同一刻）；
 *   · 档位切换带**滞回**：滚轮停在阈值上不许逐帧抖档；
 *   · 字号随缩放**小幅**变化（不是恒定像素、也不是按比例放大）。
 *
 * 用法：node scripts/tests/unit/test_label_zoom.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'labelZoom.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const {
    ZOOM_DETAILS, ZOOM_DETAIL_THRESHOLDS, DETAIL_CAPS,
    rawZoomDetail, zoomDetail, detailCaps, labelFontScale,
  } = mod;
  // C5（2026-10-29）：道路分级渐显与标签**同一套档位**（routeDensity 无 import → data: URL 可直接载）
  const rd = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(path.join(path.dirname(SRC), 'routeDensity.js'), 'utf8'), 'utf8').toString('base64'));
  const { shouldDrawRoute, arterialLengthThreshold, polylineLength, ROUTE_TIER_GROUPS } = rd;

  check('z1 裸档位：阈值两侧各自落档（0.35 / 0.6 / 2.2）', () => {
    eq(rawZoomDetail(0.1), 'close', '0.1');
    eq(rawZoomDetail(0.35), 'close', '0.35 正好在上沿（含）');
    eq(rawZoomDetail(0.36), 'near', '0.36');
    eq(rawZoomDetail(0.6), 'near', '0.6');
    eq(rawZoomDetail(0.61), 'mid', '0.61');
    eq(rawZoomDetail(2.2), 'mid', '2.2');
    eq(rawZoomDetail(2.21), 'far', '2.21');
    // 整图可见（地图占视口 62%，ratio 1.62）仍是 mid —— 首都名不该在"地图还看得清"时消失
    eq(rawZoomDetail(1.62), 'mid', '1.62（test_149 的适屏比例）');
    // 脏输入不产生 NaN 档位（回到中档 = 保守值）
    eq(rawZoomDetail(NaN), 'mid', 'NaN');
    eq(rawZoomDetail(0), 'mid', '0');
    eq(rawZoomDetail(-3), 'mid', '负');
    return 'close/near/mid/far 边界正确（含 1.62 → mid），脏输入回落 mid';
  });

  check('z2 档位表：far 只剩势力名（城镇/河流/地形注记全隐）', () => {
    assert(DETAIL_CAPS.far.burgs === -1, 'far 城镇应为 -1');
    assert(DETAIL_CAPS.far.rivers === -1, 'far 河流应为 -1');
    eq(DETAIL_CAPS.far.terrainNames, false, 'far 地形注记');
    // mid：整图可见 → 首都 + 地形注记，但不出河名
    eq(DETAIL_CAPS.mid.burgs, 0, 'mid 只首都');
    eq(DETAIL_CAPS.mid.rivers, -1, 'mid 不出河名');
    eq(DETAIL_CAPS.mid.terrainNames, true, 'mid 地形注记在');
    // near / close 逐级放开（单调：放大只会更多，不会更少）
    assert(DETAIL_CAPS.near.burgs >= DETAIL_CAPS.mid.burgs, 'near 城镇不少于 mid');
    assert(DETAIL_CAPS.close.burgs >= DETAIL_CAPS.near.burgs, 'close 城镇不少于 near');
    assert(DETAIL_CAPS.near.rivers >= DETAIL_CAPS.mid.rivers, 'near 河流不少于 mid');
    assert(DETAIL_CAPS.close.rivers >= DETAIL_CAPS.near.rivers, 'close 河流不少于 near');
    eq(DETAIL_CAPS.close.terrainNames, true, 'close 地形注记');
    return `far={${DETAIL_CAPS.far.burgs},${DETAIL_CAPS.far.rivers},${DETAIL_CAPS.far.terrainNames}} `
      + `close={${DETAIL_CAPS.close.burgs},${DETAIL_CAPS.close.rivers}}`;
  });

  check('z3 滞回：阈值附近来回抖动时不换档（进/出各要越过 12%）', () => {
    // near 的上沿 0.6：从 near 缩到 0.62 不该换 mid（要 >0.672）
    eq(zoomDetail(0.62, 'near'), 'near', '0.62 应保持 near');
    eq(zoomDetail(0.7, 'near'), 'mid', '0.7 应换 mid');
    // 从 mid 放大到 0.58 不该换 near（要 <0.528）
    eq(zoomDetail(0.58, 'mid'), 'mid', '0.58 应保持 mid');
    eq(zoomDetail(0.5, 'mid'), 'near', '0.5 应换 near');
    // 无 prev / 关掉滞回 = 裸档位
    eq(zoomDetail(0.62, null), 'mid', '首次直接按裸档位');
    eq(zoomDetail(0.62, 'near', 0), 'mid', 'hysteresis=0 时不死区');
    return '0.62 保持 near / 0.7 换 mid / 0.58 保持 mid / 0.5 换 near';
  });

  check('z4 滞回不会卡死在更细的档（反复越界仍能一路变粗）', () => {
    let d = 'close';
    const seen = [d];
    // 每步都明确越过「边界 × 1.12」，验证的是"能一路走到底"，不是步长粒度
    for (const r of [0.4, 0.7, 1.0, 1.4, 1.8, 3.0]) {
      d = zoomDetail(r, d);
      if (seen[seen.length - 1] !== d) seen.push(d);
    }
    eq(seen.join('>'), 'close>near>mid>far', '一路放大比例应逐档变粗');
    // 反向：一路缩放（比例变小）应逐档变细
    let up = 'far';
    const back = [up];
    for (const r of [1.4, 1.0, 0.5, 0.25]) {
      up = zoomDetail(r, up);
      if (back[back.length - 1] !== up) back.push(up);
    }
    eq(back.join('>'), 'far>mid>near>close', '一路放大应逐档变细');
    return seen.join('>') + ' / ' + back.join('>');
  });

  check('z5 字号系数：放大变大、缩小时保持 1.0、单调且有上下限', () => {
    const near = labelFontScale(ZOOM_DETAIL_THRESHOLDS.near);   // 0.6
    eq(Number(near.toFixed(2)), 1.0, 'near 上沿 = 1.0');
    const zoomedIn = labelFontScale(0.1);
    const moreIn = labelFontScale(0.02);
    assert(zoomedIn > near, `放大应变大：${zoomedIn}`);
    assert(moreIn >= zoomedIn, '更大不低于前一档（可封顶）');
    assert(moreIn <= 1.75 + 1e-9, `封顶 1.75：${moreIn}`);
    // 2026-10-27（用户「缩小后几乎看不清字」）：缩小时字号**不缩小**（下限 1.0）——
    // 这一档只剩势力名，再缩 5% 就是雪上加霜。
    const zoomedOut = labelFontScale(5);
    assert(Math.abs(zoomedOut - 1) < 1e-9, `缩小时保持 1.0：${zoomedOut}`);
    // 单调：ratio 越小（放得越大）字号系数不减
    let prev = 0;
    for (const r of [10, 3, 1.6, 1, 0.6, 0.35, 0.1, 0.02]) {
      const k = labelFontScale(r);
      assert(k >= prev - 1e-9, `单调被打断：ratio=${r} k=${k} < ${prev}`);
      prev = k;
    }
    return `0.6→${near.toFixed(2)} / 0.1→${zoomedIn.toFixed(2)} / 0.02→${moreIn.toFixed(2)} / 5→${zoomedOut.toFixed(2)}`;
  });

  check('z6 C5 道路分级渐显：档位逐级放开 + far 只留主干（长度分位）', () => {
    const road = (len, group = 'roads') => ({
      group,
      points: [{ x: 0, y: 0 }, { x: len, y: 0 }],
    });
    // 分组：far/mid 只有 roads；near 加 trails；close 再加 searoutes（单调放开）
    eq(ROUTE_TIER_GROUPS.far.join(','), 'roads', 'far');
    eq(ROUTE_TIER_GROUPS.mid.join(','), 'roads', 'mid');
    eq(ROUTE_TIER_GROUPS.near.join(','), 'roads,trails', 'near');
    eq(ROUTE_TIER_GROUPS.close.join(','), 'roads,trails,searoutes', 'close');
    for (const [g, want] of [['trails', 'near'], ['searoutes', 'close']]) {
      assert(!shouldDrawRoute(road(100, g), 'mid'), `${g} 不该在 mid 画`);
      assert(shouldDrawRoute(road(100, g), want), `${g} 应在 ${want} 画`);
    }
    // far 档：只留长度进前 50% 的干道（真实数据里线宽分不出主次，长度是唯一信号）
    const list = [road(1000), road(800), road(120), road(60)];
    const th = arterialLengthThreshold(list, 'far', 0.5);
    assert(th === 800, `前 50% 门槛应为 800，实得 ${th}`);
    eq(list.filter((r) => shouldDrawRoute(r, 'far', th)).length, 2, 'far 只剩 2 条干道');
    eq(list.filter((r) => shouldDrawRoute(r, 'mid', 0)).length, 4, 'mid 全部 roads');
    // 非 far 档不算门槛（0 = 不过滤），脏输入不崩
    eq(arterialLengthThreshold(list, 'mid'), 0, 'mid 不需要门槛');
    eq(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5, '折线长度');
    eq(polylineLength([{ x: 0, y: 0 }]), 0, '单点 = 0');
    assert(!shouldDrawRoute(null, 'close'), '空路线不画');
    assert(!shouldDrawRoute({ points: [{ x: 0, y: 0 }] }, 'close'), '单点路线不画');
    return `far ${th} / 分档 ${Object.keys(ROUTE_TIER_GROUPS).length} 档`;
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
