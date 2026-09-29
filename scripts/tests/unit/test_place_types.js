#!/usr/bin/env node
/**
 * Node 单元测试：地点类型点选（src/renderer/src/utils/placeTypes.js，A-3 中文点选糙版）
 *
 * 背景（`docs/ROADMAP_NEXT.md` 线 A A-3 + 2026-09-28 在线审查三条补刀）：
 *   搬家后「笔记里本来就没写」的机器属性只有点选界面能填，本模块是**唯一实现**：
 *     ① 下拉选项 = 8 枚举 ∪ 实体当前值（补刀①：枚举外第 9 种值不许被静默吞掉）；
 *     ② 「只看空白」按**层级**判空白（补刀②：真 ROSA 实测 45 个类型空白里 39 个是宇宙层，
 *        9 个 parentId 空白里 4 个是 world —— 不分层过滤 = 39 行无意义噪音）。
 *   判错的后果都是静默的：吞值 = 用户手写类型一打开下拉就没；不分层 = 过滤器形同虚设。
 *
 * 另守**枚举单源**：renderer 三处（ProjectPanel / NodeDetailPanel / geodata）都从本模块取，
 * 组件里再抄一份 `['自然', '宗教', …]` 就是第二套事实源；CJS 侧（scripts/add-place-type-frontmatter.js）
 * 属不同 bundle、按本仓惯例**复制 + 测试比对**（与 normalizeId / entityStatus 同手法）。
 *
 * 用法：node scripts/tests/unit/test_place_types.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS → 用 data: URL 动态 import（与其它 unit 用例一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const SRC = path.join(UTILS, 'placeTypes.js');

const PANEL = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ProjectPanel.vue');
const DETAIL = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'NodeDetailPanel.vue');
const GEODATA = path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodata.js');
const CJS_SCRIPT = path.join(ROOT, 'scripts', 'add-place-type-frontmatter.js');

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
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  assert(a === e, `${label}: got ${a} want ${e}`);
}

/** 剥掉 JS 注释再做子串判据 —— 注释里天然会出现「此前如何如何 / 再写一份 […]」的字样 */
function codeOnly(src) {
  let out = '', i = 0;
  const n = src.length;
  let inBlock = false;
  while (i < n) {
    const c = src[i];
    if (inBlock) {
      if (c === '*' && src[i + 1] === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') out += '\n';
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') { inBlock = true; i += 2; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

const ENUM = ['自然', '宗教', '皇室', '商业', '工业', '居住', '公共', '特殊'];

(async () => {
  const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(SRC, 'utf8')).toString('base64'));
  const {
    PLACE_TYPES, PLACE_TYPE_LAYERS, expectsPlaceType, missingPlaceType, missingParent,
    showsPlaceTypeControl, placeTypeOptions, GAP_MODES, matchesGap,
  } = mod;

  // ── t1 枚举本体 ────────────────────────────────────────────────────────────
  check('t1 8 枚举与提取脚本/规范一致（改枚举必须三处同步）', () => {
    eq(PLACE_TYPES, ENUM, 'PLACE_TYPES');
    eq(PLACE_TYPE_LAYERS, ['facility', 'location', 'region'], 'PLACE_TYPE_LAYERS');
    return '8 枚举 / 3 层级';
  });

  // ── t2~t5 补刀①：选项 = 枚举 ∪ 当前值 ────────────────────────────────────
  check('t2 空值 → 恰好 8 个选项', () => {
    eq(placeTypeOptions(null), ENUM, 'null');
    eq(placeTypeOptions(''), ENUM, '空串');
    return '8';
  });
  check('t3 枚举内值 → 不重复（8 个）', () => {
    eq(placeTypeOptions('商业'), ENUM, '商业');
    return '8';
  });
  check('t4 ★ 枚举外第 9 种值 → 追加在末尾（静默吞值 = 用户手写值被下拉抹掉）', () => {
    const opts = placeTypeOptions('秘境');
    eq(opts.length, 9, '选项数');
    assert(opts[8] === '秘境', `第 9 项应为「秘境」，实为 ${opts[8]}`);
    return '9，末位=秘境';
  });
  check('t5 枚举外值排在枚举之后（顺序稳定，不打乱既有 8 个）', () => {
    const opts = placeTypeOptions('秘境');
    eq(opts.slice(0, 8), ENUM, '前 8 位');
    return '前 8 位不变';
  });

  // ── t6~t9 补刀②：空白按层级判 ────────────────────────────────────────────
  check('t6 该填的层级：facility / location / region', () => {
    eq([expectsPlaceType({ layer: 'facility' }), expectsPlaceType({ layer: 'location' }),
        expectsPlaceType({ layer: 'region' })], [true, true, true], '三个地点层级');
    return 'facility/location/region = true';
  });
  check('t7 ★ 宇宙层与聚落不算「类型空白」（真 ROSA 实测 45 个空白里 39 个是宇宙层）', () => {
    const layers = ['world', 'star_domain', 'galaxy', 'planet', 'star', 'moon', 'city', 'town', 'village', 'building'];
    const wrong = layers.filter(l => missingPlaceType({ layer: l, placeType: null }));
    eq(wrong, [], '这些层级不该被判成类型空白');
    return '宇宙层 + 聚落 + 建筑全部不算空白';
  });
  check('t8 该填却没填 → 空白；填了就不是', () => {
    assert(missingPlaceType({ layer: 'region', placeType: null }), 'region 空值应判空白');
    assert(!missingPlaceType({ layer: 'region', placeType: '商业' }), 'region 已填不该判空白');
    return 'region 判定正确';
  });
  check('t9 ★ 挂靠空白：非 world 无父级 = 孤儿；world 在顶层是合法的（实测 9 空里 4 个是 world）', () => {
    assert(missingParent({ layer: 'facility', parentId: null }), 'facility 无父级应判孤儿');
    assert(missingParent({ layer: 'city', parentId: undefined }), 'city 无父级应判孤儿');
    assert(!missingParent({ layer: 'world', parentId: null }), 'world 顶层不是孤儿');
    assert(!missingParent({ layer: 'region', parentId: 'p1' }), '有父级不是孤儿');
    return 'world 豁免 / 非 world 判孤儿';
  });

  // ── t10~t12 下拉显示条件与过滤 ────────────────────────────────────────────
  check('t10 显示条件：该填的层级，或已带值的行（保证枚举外现存值可见）', () => {
    assert(showsPlaceTypeControl({ layer: 'region', placeType: null }), 'region 应显示');
    assert(showsPlaceTypeControl({ layer: 'city', placeType: '商业' }), '已带值的聚落也显示（保住现值）');
    assert(!showsPlaceTypeControl({ layer: 'galaxy', placeType: null }), '宇宙层空值不显示');
    return 'region 显示 / city 带值显示 / galaxy 空值不显示';
  });
  check('t11 matchesGap 四档', () => {
    const galaxy = { layer: 'galaxy', placeType: null, parentId: 'w1' };
    const region = { layer: 'region', placeType: null, parentId: 'p' };
    const orphan = { layer: 'facility', placeType: null, parentId: null };
    assert(matchesGap(galaxy, 'all'), 'all 恒真');
    assert(!matchesGap(galaxy, 'type'), '宇宙层不该进类型过滤（补刀②的 39 行噪音就是这条）');
    assert(!matchesGap(galaxy, 'parent'), '有父级的宇宙层不进 parent 过滤');
    assert(matchesGap(region, 'type'), 'region 空类型进 type');
    assert(!matchesGap(region, 'parent'), '有父级不进 parent');
    assert(matchesGap(orphan, 'parent'), '无父级的地点进 parent');
    assert(matchesGap(region, 'any'), 'any = type ∪ parent');
    assert(matchesGap(orphan, 'any'), 'any 含 parent 空白');
    return '四档语义正确';
  });
  check('t12 GAP_MODES 与过滤器文案单源（4 档）', () => {
    eq(GAP_MODES.map(m => m.value), ['all', 'type', 'parent', 'any'], 'mode 值');
    assert(GAP_MODES.every(m => m.label && m.label.length >= 2), '每档都有中文文案');
    return GAP_MODES.map(m => m.label).join('/');
  });

  // ── t13 枚举单源（renderer 三处不许再抄一份）────────────────────────────────
  check('t13 ★ renderer 三处引用 placeTypes、且无内联 8 枚举数组（注释已剥）', () => {
    const files = [
      ['ProjectPanel.vue', PANEL],
      ['NodeDetailPanel.vue', DETAIL],
      ['geodata.js', GEODATA],
    ];
    for (const [name, p] of files) {
      const code = codeOnly(fs.readFileSync(p, 'utf8'));
      assert(code.includes('utils/placeTypes'), `${name} 没有引用 utils/placeTypes`);
      assert(!code.includes("['自然', '宗教'"), `${name} 里有内联 8 枚举数组（第二套事实源）`);
    }
    return '三处均引用单源、无内联枚举';
  });

  // ── t14 CJS 侧枚举比对（不同 bundle → 复制 + 测试比对，与 normalizeId 同手法）──
  check('t14 CJS 提取脚本的枚举与 PLACE_TYPES 逐字符一致', () => {
    const src = fs.readFileSync(CJS_SCRIPT, 'utf8');
    // 只认「以 8 枚举顺序开头」的那个数组字面量 —— NAME_RULES/TAG_RULES 里也有含「自然」的数组
    const m = src.match(/(\s*'自然'\s*,\s*'宗教'\s*,\s*'皇室'[^[\]]*)/);
    assert(m, 'CJS 脚本里找不到 8 枚举数组');
    const arr = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    eq(arr, ENUM, 'CJS 枚举');
    return 'CJS 与 renderer 一致';
  });

  // ── 报告 ──────────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch(err => {
  console.error('❌ 测试执行异常：', err && err.stack || err);
  process.exit(1);
});
