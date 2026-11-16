#!/usr/bin/env node
/**
 * Node 单元测试：数据层两条判据（2026-11-08，`docs/plan/ANALYSIS_20261108_LORE_BRIDGE.md` §六-7）
 *
 * ① **空值不落盘**：项目文件里不许出现 `sourcePath: ''` / `parentId: null` / `tags: []` /
 *    `coordinate: {x:null,y:null}` 这种“没填也写一遍”的占位值。它们不携带信息，只会把文件撑大、
 *    让快照与 diff 里全是噪音，读起来还像“已经填过了”。
 *    口径：只改**磁盘形态**（`stripEmptyEntityValues` 是纯函数，内存里的项目一字不动），
 *    读侧默认不变（`validateProject` 载入时把四个键补回默认值）。
 *
 * ② **没有完成态**：项目里不存在 `complete` / `progress` / `missing` 这类“做完没做完”的字段。
 *    理由不是洁癖 —— 用户 2026-11-07 的红线：「不许把结构变成填表门槛」。一旦实体上出现完成度，
 *    下一步就是“没填完不许保存/不许入树”，而同行的 World Anvil / Novelcrafter 走的都是
 *    “先写，再连，缺口交给人”。
 *    ⚠️ 与 `utils/entityStatus.js` 的 `status` 不冲突：那是**叙事状态**（在 / 已毁灭 / 封存），
 *    不是工作流完成度；它也不在实体形状白名单里，属于画布侧附加字段。
 *
 * 用法：node scripts/tests/unit/test_entity_empty_values.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测的 projectSchema 是 ESM 且有相对 import（./normalizeId）→ 复制到临时目录 +
 *    `{"type":"module"}` 再 import（与 test_project_size.js 同一套做法）。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GEODATA = path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodata.js');

const results = [];
async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: (await fn()) || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP, process.env.TEMP, process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
].filter(Boolean);
let TMP = '';

async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    const dir = path.join(base, `sitian-entity-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, '.probe'), 'ok', 'utf-8');
      await fsp.unlink(path.join(dir, '.probe'));
      TMP = dir;
      return;
    } catch (e) { tried.push(`${base} → ${e.code || e.message}`); }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

async function importSchema() {
  const deps = ['projectSchema.js', 'normalizeId.js'];
  const dir = path.join(TMP, 'schema');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  for (const f of deps) {
    const body = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', f), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
    await fsp.writeFile(path.join(dir, f), body, 'utf-8');
  }
  return import(pathToFileURL(path.join(dir, 'projectSchema.js')).href);
}

/** 从 geodata.js 里读出实体形状白名单（唯一来源在那里，本文件不复制一份） */
function readEntityShapeKeys() {
  const src = fs.readFileSync(GEODATA, 'utf8');
  const m = src.match(/const ENTITY_SHAPE_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error('没在 geodata.js 里找到 ENTITY_SHAPE_KEYS（白名单搬家了就更新本用例）');
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** 完成态词汇。命中任意一条 = 实体上出现了“做完没做完” */
const COMPLETION_TOKENS = /^(complete|completed|completion|progress|progressing|percent|percentage|missing|done|finished)$/i;
function completionHits(keys) {
  return keys.filter(k => COMPLETION_TOKENS.test(String(k)));
}

/** 一个“什么都没填”的实体（createEntity 的默认产物） */
function emptyEntity(S) {
  return S.createEntity({ name: '甲', layer: 'city' });
}

async function main() {
  await resolveTmpRoot();
  const S = await importSchema();

  // ══════════════════════════════════════════════════════════════
  // A. 空值不落盘
  // ══════════════════════════════════════════════════════════════
  await check('A1 四类空值从磁盘形态里消失（parentId / tags / coordinate / sourcePath）', () => {
    const e = emptyEntity(S);
    // 先确认 createEntity 给的是**完整形状**（内存口径没变，否则本用例测的是别的东西）
    assert('parentId' in e && 'tags' in e && 'coordinate' in e && 'sourcePath' in e,
      'createEntity 仍应产出完整形状（内存口径不变），实际键：' + Object.keys(e).join(','));
    const project = S.createEmptyProject({ name: 'p' });
    const withEntity = { ...project, entities: { [e.id]: e } };
    const stripped = S.stripEmptyEntityValues(withEntity).entities[e.id];
    for (const k of ['parentId', 'tags', 'coordinate', 'sourcePath']) {
      assert(!(k in stripped), `空值的 ${k} 不该写进磁盘形态，实际仍在：${JSON.stringify(stripped[k])}`);
    }
    // 有默认语义的字段照旧写
    for (const k of ['id', 'name', 'layer', 'layerLabel', 'origin', 'uuid', 'createdAt', 'updatedAt']) {
      assert(k in stripped, `带默认语义的 ${k} 必须照旧写`);
    }
    return `去掉 4 个空值键，保留 ${Object.keys(stripped).length} 个`;
  });

  await check('A2 有值的一个都不许丢（反向探针：把剥离写成整块删字段必须红）', () => {
    const full = S.createEntity({
      name: '乙', layer: 'city', parentId: 'world-1', tags: ['港口', '季节'],
      coordinate: { x: 12.5, y: -3.25 }, origin: 'obsidian', sourcePath: '03 设定/02 场景地点/乙.md',
    });
    const out = S.stripEmptyEntityValues({ entities: { [full.id]: full } });
    const kept = out.entities[full.id];
    eq(kept.parentId, 'world-1', 'parentId 有值必须保留');
    eq(kept.tags.join(','), '港口,季节', 'tags 有值必须保留');
    eq(kept.coordinate.x, 12.5, 'coordinate.x 有值必须保留');
    eq(kept.coordinate.y, -3.25, 'coordinate.y 有值必须保留');
    eq(kept.sourcePath, '03 设定/02 场景地点/乙.md', 'sourcePath 有值必须保留');
    eq(kept.origin, 'obsidian', 'origin 原样');
    return '五条有值字段全部保留';
  });

  await check('A3 半空坐标只删“x 与 y 都空”的那种（y=0 不是空值）', () => {
    const a = S.createEntity({ name: '丙', layer: 'city', coordinate: { x: 3, y: 0 } });
    const b = S.createEntity({ name: '丁', layer: 'city', coordinate: { x: null, y: 8 } });
    const out = S.stripEmptyEntityValues({ entities: { a, b } });
    assert('coordinate' in out.entities.a, 'y=0 是合法坐标，不许当成空值删掉（这是最容易踩的假阳性）');
    eq(out.entities.a.coordinate.y, 0, 'y=0 原样');
    assert('coordinate' in out.entities.b, '只有 x 空不算空坐标，整块保留');
    eq(out.entities.b.coordinate.y, 8, 'y 有值');
    return 'y=0 / 单轴为空都保留';
  });

  await check('A4 纯函数：入参一个字不动（返回的是新对象）', () => {
    const e = emptyEntity(S);
    const project = { ...S.createEmptyProject({ name: 'p' }), entities: { [e.id]: e } };
    const before = JSON.stringify(project);
    const out = S.stripEmptyEntityValues(project);
    eq(JSON.stringify(project), before, '入参被改动了（快照/撤销会因此拿到半剥过的项目）');
    assert(out !== project && out.entities !== project.entities, '必须返回新对象');
    return '入参哈希不变';
  });

  await check('A5 读侧默认不变：剥完再载入，四类键全部补回默认值', () => {
    const e = emptyEntity(S);
    const project = { ...S.createEmptyProject({ name: 'p' }), entities: { [e.id]: e } };
    const onDisk = JSON.parse(S.toIpcJson(S.stripEmptyEntityValues(project)));
    const loaded = S.validateProject(onDisk);
    assert(loaded.ok, '剥过的项目必须仍然载入成功：' + (loaded.problems || []).join(' / '));
    const back = loaded.project.entities[e.id];
    eq(back.parentId, null, 'parentId 补回 null');
    eq(Array.isArray(back.tags) && back.tags.length, 0, 'tags 补回 []');
    eq(back.coordinate.x, null, 'coordinate.x 补回 null');
    eq(back.coordinate.y, null, 'coordinate.y 补回 null');
    eq(back.sourcePath, '', 'sourcePath 补回空串');
    return '载入后形状与剥离前一致（' + (loaded.problems.length ? loaded.problems.length + ' 条修复提示' : '零修复提示') + '）';
  });

  await check('A6 真实量级：100 个空值实体，落盘文本确实变小且不含占位键', () => {
    const entities = {};
    for (let i = 0; i < 100; i++) {
      const e = S.createEntity({ name: '节点' + i, layer: 'city' });
      entities[e.id] = e;
    }
    const project = { ...S.createEmptyProject({ name: 'p' }), entities };
    const raw = S.toIpcJson(project);
    const lean = S.toIpcJson(S.stripEmptyEntityValues(project));
    for (const needle of ['"sourcePath":""', '"parentId":null', '"tags":[]', '"coordinate":{"x":null,"y":null}']) {
      assert(!lean.includes(needle), `磁盘形态里仍有占位键 ${needle}（本用例测的是“不落盘”，不是“变小一点”）`);
    }
    assert(lean.length < raw.length, `反向判据：剥过必须更小（raw=${raw.length} lean=${lean.length}）`);
    eq(JSON.parse(lean).entities && Object.keys(JSON.parse(lean).entities).length, 100, '100 个实体一个不许丢');
    return `${raw.length} → ${lean.length} 字符（-${raw.length - lean.length}）`;
  });

  await check('A7 边界：不是项目对象 / 没有 entities / 实体是 null → 原样返回不抛', () => {
    eq(S.stripEmptyEntityValues(null), null, 'null 原样');
    eq(S.stripEmptyEntityValues('x'), 'x', '字符串原样');
    const noEntities = { version: '1.0.0' };
    assert(S.stripEmptyEntityValues(noEntities) === noEntities, '没有 entities 的项目原样返回');
    const weird = { entities: { a: null, b: 'x', c: { id: 'c', name: 'c' } } };
    const out = S.stripEmptyEntityValues(weird);
    eq(out.entities.a, null, 'null 实体原样带过');
    eq(out.entities.b, 'x', '非对象实体原样带过');
    return '4 种畸形输入都没抛';
  });

  await check('A8 占地派生字段（A21）：宽度取不到 / 为 0 / 缺指纹 都不写进磁盘', () => {
    const base = S.createEntity({ name: '戊', layer: 'building' });
    const good = { ...base, id: 'b-good', footprint: { w: 912, h: 662, area: 603744, stamp: '1d1aa193' } };
    const zero = { ...base, id: 'b-zero', footprint: { w: 0, h: 0, area: 0, stamp: 'x' } };
    const noStamp = { ...base, id: 'b-nostamp', footprint: { w: 900, h: 600 } };
    const out = S.stripEmptyEntityValues({
      entities: { [good.id]: good, [zero.id]: zero, [noStamp.id]: noStamp },
    });
    assert('footprint' in out.entities['b-good'], '有尺寸的占地必须保留（这是 A21 的落盘形态）');
    eq(out.entities['b-good'].footprint.w, 912, '宽度原样');
    assert(!('footprint' in out.entities['b-zero']), '0x0 的占位不该写进磁盘（没有墙 = 没有尺寸）');
    assert(!('footprint' in out.entities['b-nostamp']), '缺指纹就无法判断新鲜度，不许写');
    return '保留 1 / 剥掉 2';
  });

  // ══════════════════════════════════════════════════════════════
  // B. 没有完成态
  // ══════════════════════════════════════════════════════════════
  await check('B1 实体形状白名单里没有任何完成态字段', () => {
    const keys = readEntityShapeKeys();
    assert(keys.length >= 10, `白名单读出来只有 ${keys.length} 个键，解析可能坏了`);
    const hits = completionHits(keys);
    eq(hits.length, 0, `实体形状里出现了完成态字段：${hits.join(', ')}（用户 2026-11-07 红线：不许把结构变成填表门槛）`);
    return `${keys.length} 个键，零完成态`;
  });

  await check('B2 createEntity 产出的键全在白名单里，且零完成态', () => {
    const keys = readEntityShapeKeys();
    const produced = Object.keys(emptyEntity(S));
    const stray = produced.filter(k => !keys.includes(k));
    eq(stray.length, 0, `createEntity 写出了白名单外的键：${stray.join(', ')}（白名单在 geodata.js，这里是唯一来源）`);
    const hits = completionHits(produced);
    eq(hits.length, 0, `createEntity 写出了完成态字段：${hits.join(', ')}`);
    return `${produced.length} 个键，全部在白名单里`;
  });

  await check('B3 载入后的实体也没有完成态（老档里被人塞过也必须被看得出来）', () => {
    const e = emptyEntity(S);
    const project = { ...S.createEmptyProject({ name: 'p' }), entities: { [e.id]: e } };
    const loaded = S.validateProject(JSON.parse(S.toIpcJson(project)));
    assert(loaded.ok, '载入失败：' + (loaded.problems || []).join(' / '));
    const hits = completionHits(Object.keys(loaded.project.entities[e.id]));
    eq(hits.length, 0, `载入后实体上出现完成态字段：${hits.join(', ')}`);
    return '零命中';
  });

  await check('B4 负向探针：塞一个 progress 进去，判据必须红', () => {
    const fake = [...readEntityShapeKeys(), 'progress'];
    const hits = completionHits(fake);
    eq(hits.join(','), 'progress', '探针自己坏了：completionHits 没抓到 progress');
    // 反面：叙事状态 status 不是完成态，不许被误伤
    eq(completionHits(['status']).length, 0, 'status（叙事状态）不是完成态，不许误判');
    return 'progress 被抓到 / status 不误判';
  });

  // ── 输出 ──────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n=== 数据层两条判据 ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 单测自身异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
