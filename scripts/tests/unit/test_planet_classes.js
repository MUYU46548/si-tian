#!/usr/bin/env node
/**
 * Node 单元测试：**项目级自定义行星类别**（2026-11-25 第六轮，B 方案后半段）
 *
 * 这一层的东西只有一半能靠界面看见：类别出现在下拉里、行星换了几何颜色 —— 但
 * “脏值会不会进项目文件”“同 id 改定义会不会贴旧纹理”“旧项目没有这个字段会不会炸”
 * 这三类事故在界面上都是**静默**的。所以判据分三段：
 *
 *   A. 纯函数（`utils/planetClasses.js`）：规范化、上限、去重、由配色造类别；
 *   B. 渲染层（`utils/planetArt.js` + `utils/system3dScene.js`）：注册表、取色口、
 *      **缓存键带类别定义指纹**（用假 canvas 真跑一遍 getPlanetTexture 验缓存分家）、
 *      自定义气巨有环；
 *   C. 项目文件（`utils/projectSchema.js`）：旧项目补空表、坏条目丢弃并记问题、往返不丢。
 *
 * 另加源码闸门（b 段）：四段接线少一段，功能就会“看起来没做”
 * （store 没进载荷 / 关项目没清注册表 / 卡片没接写口 / 环又写死两个内置 id）。
 *
 * 用法：node scripts/tests/unit/test_planet_classes.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP,
  process.env.TEMP,
  process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
].filter(Boolean);

let TMP = '';

async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    const dir = path.join(base, `sitian-planet-classes-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, '.probe'), 'ok', 'utf-8');
      await fsp.unlink(path.join(dir, '.probe'));
      TMP = dir;
      return;
    } catch (e) {
      tried.push(`${base} → ${e.code || e.message}`);
    }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

/**
 * 复制被测模块到临时目录再 import。
 * 为什么：这些是 ESM，而 `projectSchema.js` 里还有不带扩展名的相对 import（`./normalizeId`）——
 * Node 的 ESM 解析器不认，必须补 `.js`（与 test_project_size.js / test_entity_empty_values.js 同法）。
 */
async function copyModules() {
  const dir = path.join(TMP, 'mods');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  const files = [
    'planetPalettes.js', 'planetClasses.js', 'planetArt.js', 'system3dScene.js',
    'projectSchema.js', 'normalizeId.js',
  ];
  for (const f of files) {
    let body = fs.readFileSync(path.join(UTILS, f), 'utf8');
    // 只给不带扩展名的相对 import 补 .js（带 .js 的保持原样，别补成 .js.js）
    body = body.replace(/from '(\.\/[A-Za-z0-9_-]+)'/g, "from '$1.js'");
    await fsp.writeFile(path.join(dir, f), body, 'utf-8');
  }
  const load = (f) => import(pathToFileURL(path.join(dir, f)).href);
  return {
    dir,
    P: await load('planetArt.js'),
    C: await load('planetClasses.js'),
    S: await load('system3dScene.js'),
    SCHEMA: await load('projectSchema.js'),
  };
}

/**
 * 假 canvas：`getPlanetTexture` 只用 2D 上下文的绘制 API（Node 里没有 document）。
 * 用 Proxy 把所有方法变 no-op、把 fillStyle 之类的赋值收下 —— 足以真跑一遍贴图生成，
 * 用来验“缓存键带不带类别指纹”这个**行为**（而不是查源码字符串）。
 */
function installFakeCanvas() {
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (!(key in target)) target[key] = () => {};
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const doc = {
    createElement() {
      return { width: 0, height: 0, getContext: () => ctx };
    },
  };
  globalThis.document = doc;
  return () => { delete globalThis.document; };
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 剥注释：判据不许被注释里的示例骗过（本仓既定口径） */
function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const VALID = {
  id: 'cp-test-0001',
  label: '熔金星球',
  kind: 'terra',
  base: '#7a3b2e',
  land: ['#a06a4a', '#c08050'],
  cap: '#e8d8c0',
  clouds: 0.2,
  atmosphere: '#ffb070',
  atmo: 0.9,
  seed: 'desert',
};

async function main() {
  await resolveTmpRoot();
  const { P, C, S, SCHEMA } = await copyModules();

  // ── A. 纯函数 ─────────────────────────────────────────────────────────
  await check('a1 由配色造类别：字段齐全、seed 记住祖类别、气巨条带由配色推导', () => {
    const def = P.customClassFromPalette({
      name: '熔金',
      classId: 'desert',
      palette: { base: '#7a3b2e', land: ['#a06a4a'], atmosphere: '#ffb070' },
    });
    assert(def && /^cp-[a-z0-9][a-z0-9-]{2,47}$/.test(def.id), `id 形态不对：${def && def.id}`);
    eq(def.label, '熔金', '名字');
    eq(def.kind, 'terra', 'kind 应跟祖类别');
    eq(def.base, '#7a3b2e', '主色');
    eq(def.land, ['#a06a4a'], '陆色');
    eq(def.seed, 'desert', 'seed 必须记住祖类别（否则陆块构图会变成另一张图）');
    eq(def.cap, P.planetClassDef('desert').cap, 'cap 没覆盖时应沿用祖类别');
    eq(def.clouds, P.planetClassDef('desert').clouds, '云量应沿用祖类别');
    eq(def.atmo, P.atmosphereForClass('desert').strength, '大气浓淡应沿用祖类别');
    // 规范化必须原样接受自己造的东西（项目文件里存的就是它）
    eq(C.normalizePlanetClass(def), def, '自己造的类别过不了自己的规范化');

    const giant = P.customClassFromPalette({
      name: '熔金巨', classId: 'gasGiant', palette: { base: '#885522', land: ['#ddaa66'] },
    });
    eq(giant.kind, 'bands', '气巨的 kind 应保持 bands');
    assert(Array.isArray(giant.bands) && giant.bands.length >= 2, '气巨自定义类别必须有条带色');
    assert(giant.bands.includes('#885522') || giant.bands.some((c) => c !== giant.bands[0]),
      '条带没有跟着配色走（否则拾色器改主色，球一点都不变）');
    return `${def.label} / ${giant.label}`;
  });

  await check('a2 脏值不进库：坏 id / 坏 kind / 空名 / 坏色 一律丢弃，重复 id 只留第一条', () => {
    const dirty = [
      null, 'x', {},
      { ...VALID, id: 'continental' },          // 撞内置 id
      { ...VALID, id: 'cp-' },                  // 太短
      { ...VALID, kind: 'nope' },               // 不认的 kind
      { ...VALID, label: '   ' },               // 空名
      { ...VALID, base: 'red' },                // 坏色
      { ...VALID, base: '#123' },               // 坏色
      { ...VALID, id: 'cp-test-0002', base: '#ffffff', clouds: 99, atmo: -5 }, // 合法（数值夹紧）
      { ...VALID, id: 'cp-test-0002', base: '#000000' },                       // 重复 id → 丢
    ];
    const list = C.normalizePlanetClassList(dirty);
    eq(list.map((x) => x.id), ['cp-test-0002'], '合法项筛选/去重不对');
    eq(list[0].clouds, 0.85, 'clouds 应被夹到 0.85');
    eq(list[0].atmo, 0.2, 'atmo 应被夹到 0.2');
    // 上限：超出的截断（项目文件不能无限长）
    const many = Array.from({ length: C.MAX_CUSTOM_PLANET_CLASSES + 9 }, (_, i) => ({
      ...VALID, id: `cp-limit-${i}`,
    }));
    eq(C.normalizePlanetClassList(many).length, C.MAX_CUSTOM_PLANET_CLASSES, '上限没生效');
    // 非数组 → 空数组（不是抛）
    eq(C.normalizePlanetClassList(undefined), [], 'undefined 应得空数组');
    // 名字：折叠空白 + 同名补号（下拉里两个同名项没法选）
    eq(C.sanitizeClassName('  熔金   星球  '), '熔金 星球', '名字空白没折叠');
    eq(C.uniquePlanetClassLabel('熔金', [{ label: '熔金' }, { label: '熔金 2' }]), '熔金 3', '同名没补号');
    return `丢 ${dirty.length - list.length} 条，上限 ${C.MAX_CUSTOM_PLANET_CLASSES}`;
  });

  await check('a3 注册表：自定义类别可查定义/label/合法性，清空后不再被认', () => {
    const defs = C.normalizePlanetClassList([
      { ...VALID, id: 'cp-reg-1' },
      { ...VALID, id: 'cp-reg-2', kind: 'bands', base: '#334455', land: [] },
    ]);
    const active = P.registerPlanetClasses(defs);
    eq(active.length, 2, '注册数');
    eq(P.planetClassDef('cp-reg-1').label, '熔金星球', '自定义 label 查表');
    eq(P.planetClassLabel('cp-reg-1'), '熔金星球', 'planetClassLabel');
    assert(P.isPlanetClassId('cp-reg-1') && P.isPlanetClassId('continental'), '合法 id 判定');
    assert(!P.isPlanetClassId('cp-nope'), '未注册的 cp-* 不许被认成合法类别');
    assert(P.isPlanetClassId('cp-reg-1'), '注册后可认');
    assert(P.hasRing('cp-reg-2'), '自定义 bands 类别必须有环');
    assert(!P.hasRing('cp-reg-1'), 'terra 类别不该有环');
    // 清空（关闭项目）后：不再认，且查询回落到内置首项（绝不返回 undefined）
    P.registerPlanetClasses([]);
    assert(!P.isPlanetClassId('cp-reg-1'), '清空后仍被认成合法类别（关项目会画出上一个项目的类型）');
    eq(P.planetClassDef('cp-reg-1').id, P.PLANET_CLASSES[0].id, '未注册类别应回落内置首项');
    return '2 条注册 / 清空生效';
  });

  await check('a4 取色口与大气：逐颗覆盖压过类别默认、自定义类别自带浓淡', () => {
    const defs = P.registerPlanetClasses([VALID, {
      ...VALID, id: 'cp-atmo', atmosphere: '#00ff00', atmo: 0.3,
    }]);
    assert(defs.length === 2, '注册失败');
    // 没覆盖 → 原样返回类别定义
    eq(P.paletteForClass('cp-test-0001').base, VALID.base, '无覆盖应返回类别主色');
    // 有覆盖 → 覆盖生效，没覆盖的字段仍回落类别定义
    const ov = P.paletteForClass('cp-test-0001', { base: '#112233' });
    eq(ov.base, '#112233', '覆盖没生效');
    eq(ov.land, VALID.land, '没覆盖的 land 应回落类别定义');
    // 大气：颜色跟覆盖，浓淡用类别自带的 atmo
    const atmo = P.atmosphereForClass('cp-atmo', { atmosphere: '#123456' });
    eq(atmo.color, '#123456', '大气色没跟覆盖走');
    eq(atmo.strength, 0.3, '自定义类别的 atmo 没生效（会退回 0.6，观感与存成类别前不一致）');
    eq(atmo.kind, 'terra', 'kind');
    P.registerPlanetClasses([]);
    return 'ok';
  });

  // ── B. 渲染层 ─────────────────────────────────────────────────────────
  await check('a5 构景：自定义类别透传 classId、有环、大气一致；未注册回落推断', () => {
    const defs = C.normalizePlanetClassList([
      { ...VALID, id: 'cp-scene-terra' },
      { ...VALID, id: 'cp-scene-bands', kind: 'bands', base: '#445566', land: ['#8899aa'], atmosphere: '#aabbcc', atmo: 0.8 },
    ]);
    P.registerPlanetClasses(defs);
    const spec = S.buildSystem3dScene({
      starName: '衡佑',
      planets: [
        { id: 'p1', name: 'A', layer: 'planet', orbitRadius: 75, planetClass: 'cp-scene-terra' },
        { id: 'p2', name: 'B', layer: 'planet', orbitRadius: 110, planetClass: 'cp-scene-bands' },
        // 未注册的 cp-*：不许原样进渲染（会变成“大陆星球”但标签写着不存在的类别）
        { id: 'p3', name: 'C', layer: 'planet', orbitRadius: 145, planetClass: 'cp-never-registered' },
      ],
      moons: [],
    });
    const [b1, b2, b3] = spec.bodies;
    eq(b1.classId, 'cp-scene-terra', '自定义 terra 的 classId 被改掉了');
    eq(b2.classId, 'cp-scene-bands', '自定义 bands 的 classId 被改掉了');
    eq(b2.ring, true, '自定义气巨没有环（surface3dScene 又写死了内置 id？）');
    eq(b1.ring, false, 'terra 不该有环');
    eq(b2.atmo.color, '#aabbcc', '大气色没跟类别走');
    eq(b2.atmo.strength, 0.8, '大气浓淡没跟类别走');
    assert(P.isPlanetClassId(b3.classId), '未注册类别应回落成合法内置类别');
    assert(b3.classId !== 'cp-never-registered', '未注册的类别 id 不许进渲染');
    P.registerPlanetClasses([]);
    return `${spec.bodies.map((b) => `${b.classId}${b.ring ? '+ring' : ''}`).join(' / ')}`;
  });

  await check('a6 贴图缓存：同 id 改定义必须重建（缓存键要带类别定义指纹）', () => {
    const uninstall = installFakeCanvas();
    try {
      const first = C.normalizePlanetClassList([{ ...VALID, id: 'cp-cache-1' }]);
      P.registerPlanetClasses(first);
      const tex1 = P.getPlanetTexture('cp-cache-1');
      const tex2 = P.getPlanetTexture('cp-cache-1');
      assert(tex1 === tex2, '同一类别两次取贴图应命中缓存（否则每帧重画）');
      // 同 id、同色板、**定义变了**（颜色不一样的同名类别）→ 不许贴旧纹理
      const second = C.normalizePlanetClassList([{ ...VALID, id: 'cp-cache-1', base: '#00ff00' }]);
      assert(second[0].base === '#00ff00', '造不出改定义的用例');
      P.registerPlanetClasses(second);
      const tex3 = P.getPlanetTexture('cp-cache-1');
      assert(tex3 !== tex1, '同 id 改定义后仍拿到旧贴图（缓存键缺类别定义指纹）');
      // 逐颗色板仍要分家（A 方案的判据，别在改这一层时弄丢）
      const tex4 = P.getPlanetTexture('cp-cache-1', { base: '#112233' });
      assert(tex4 !== tex3, '不同色板共用了同一张贴图');
      // 2D 圆盘走同一个类别解析口：自定义类别必须能出圆盘（不是只给 3D 用）
      const disc = P.getPlanetDisc('cp-cache-1', 48);
      assert(disc && disc.width === 48, '2D 圆盘没按自定义类别出图');
      assert(P.getPlanetTexture('cp-cache-1') === tex3, '出圆盘不该污染地表贴图的缓存');
      P.registerPlanetClasses([]);
      return '缓存命中 / 改定义重建 / 色板分家 / 2D 圆盘可用';
    } finally {
      uninstall();
    }
  });

  // ── C. 项目文件 ───────────────────────────────────────────────────────
  await check('a7 项目文件：空项目带 planetClasses，旧项目补空表，坏条目丢弃并记问题', () => {
    const empty = SCHEMA.createEmptyProject({ name: '空', id: 'p-x', now: '2026-11-25T00:00:00.000Z' });
    eq(empty.planetClasses, [], '新项目应带空类别表');

    // 旧项目（没有这个字段）→ 补空表，且**不许**因此报“损坏”
    const old = SCHEMA.createEmptyProject({ name: '旧', id: 'p-old', now: '2026-11-25T00:00:00.000Z' });
    delete old.planetClasses;
    const migrated = SCHEMA.migrateProject(old);
    assert(migrated.ok, `旧项目迁移失败：${migrated.problems}`);
    eq(migrated.project.planetClasses, [], '旧项目应补出空类别表');
    assert(!migrated.problems.some((p) => /planetClasses|行星类别/.test(p)), '缺字段不该报问题');

    // 有合法 + 坏的混合 → 保留合法的，坏的丢弃并留下问题
    const mixed = SCHEMA.createEmptyProject({ name: '混合', id: 'p-mix', now: '2026-11-25T00:00:00.000Z' });
    mixed.planetClasses = [VALID, { ...VALID, id: 'bad-id' }, { ...VALID, id: 'cp-mix-2', base: 'red' }];
    const r = SCHEMA.migrateProject(mixed);
    assert(r.ok, `迁移失败：${r.problems}`);
    eq(r.project.planetClasses.map((c) => c.id), [VALID.id], '合法条目没保留/坏条目没丢');
    assert(r.problems.some((p) => p.includes('自定义行星类别')), '丢了条目却没有记问题（静默丢数据）');

    // planetClasses 不是数组 → 重置为空 + 记问题
    const broken = SCHEMA.createEmptyProject({ name: '坏', id: 'p-bad', now: '2026-11-25T00:00:00.000Z' });
    broken.planetClasses = 'nope';
    const r2 = SCHEMA.migrateProject(broken);
    eq(r2.project.planetClasses, [], '非数组应重置为空');
    assert(r2.problems.some((p) => p.includes('planetClasses')), '非数组没有记问题');
    // 序列化往返（落盘/读回）不丢
    const round = JSON.parse(SCHEMA.serializeProject(r.project));
    eq(round.planetClasses, r.project.planetClasses, '序列化往返丢了类别');
    return `旧项目补空 / 坏条目 ${r.problems.length} 条问题`;
  });

  // ── b. 源码闸门（少一段接线 = 功能“看起来没做”）────────────────────────
  await check('b1 源码闸门：项目文件载荷 / 装载 / 关项目清注册表 三处都接上', () => {
    const geo = read('src/renderer/src/store/geodata.js');
    assert(geo.includes('planetClasses: rawShallowRows(state.planetClasses)'),
      'buildProjectPayload 没带 planetClasses → 存盘就丢');
    assert(geo.includes('applyPlanetClasses(project.planetClasses)'),
      'applyProjectToCanvas 没装类别 → 打开项目下拉是空的');
    assert(geo.includes('applyPlanetClasses([])') && /releaseProjectFromCanvas[\s\S]{0,400}applyPlanetClasses\(\[\]\)/.test(geo),
      'releaseProjectFromCanvas 没清注册表 → 关项目后还认上一个项目的类别');
    assert(geo.includes('registerPlanetClasses('), 'store 没写渲染层注册表');
    const ps = read('src/renderer/src/store/projectStore.js');
    assert(ps.includes('next.planetClasses = payload.planetClasses'),
      'mergeCanvasPayload 没合 planetClasses → 画布保存推不进项目');
    const schema = read('src/renderer/src/utils/projectSchema.js');
    assert(schema.includes('planetClasses') && schema.includes('normalizePlanetClassList'),
      'projectSchema 没登记/校验 planetClasses（读回会被丢掉）');
    return 'payload / adopt / release / merge / schema 齐全';
  });

  await check('b2 源码闸门：卡片下拉分组 + 存/删走 store；环判定不许再写死内置 id', () => {
    const vue = codeOnly(read('src/renderer/src/components/System3DView.vue'));
    assert(/data-testid="sys3d-class"/.test(vue), '缺类型下拉');
    assert(/optgroup[^>]*label="内置类型"/.test(vue), '类型下拉没有内置分组');
    assert(/optgroup[^>]*label="本项目自定义"/.test(vue), '类型下拉没有自定义分组');
    assert(vue.includes('customClasses') && vue.includes('stockClasses'), '下拉没接自定义类别表');
    assert(/data-testid="sys3d-class-save"/.test(vue) && vue.includes('customClassFromPalette('),
      '缺“存为类别”按钮或没走同一个类别工厂');
    assert(vue.includes('geodata.addPlanetClass(') && vue.includes('geodata.removePlanetClass('),
      '存/删没接 store 写口（点了不会落项目）');
    assert(/canSaveClass/.test(vue) && /canvasSource === 'project'/.test(vue),
      '只读态没有灰禁（没项目时点了会静默失败）');
    assert(vue.includes('getPlanetTexture(classId, hit.body.palette)'),
      '改类型时没把逐颗色板传下去（3D 与 2D 会不一致）');
    const scene = codeOnly(read('src/renderer/src/utils/system3dScene.js'));
    assert(scene.includes('ring: hasRing(classId)'), '环判定仍是硬编码内置 id（自定义气巨会没环）');
    assert(!/classId === 'gasGiant' \|\| classId === 'iceGiant'/.test(scene), '仍留着写死的两个气巨 id');
    return 'ok';
  });

  // ── 汇总 ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 自定义行星类别 单元测试（Node）===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('单元测试运行器异常:', err);
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  });
