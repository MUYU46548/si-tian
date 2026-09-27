#!/usr/bin/env node
/**
 * Node 单元测试：A-1 存量机器属性搬家工具（scripts/migrate-vault-attrs.js）
 *
 * 背景（《机器属性搬家》报告 ①③④）：
 *   「层级 / 上层挂靠 / 地点类型」这套机器属性现在由笔记 frontmatter 承载，用户得人肉维护。
 *   定案：结构归 `.sitian`，内容归笔记。本工具把**存量**搬过去（搬家 + 清点 + 反向档）。
 *
 * 判错的后果都是**静默**的，所以每条都要有专门断言：
 *   · 覆盖了项目里已有的值 → 用户在司天界面里改过的东西被笔记里的旧值吃掉；
 *   · 补了悬空的 parentId → 项目校验会把它静默置空（搬了个寂寞，且看不出为什么）；
 *   · 默认就写盘 → 用户只是"看一眼"却改了数据；
 *   · 反向档没落 → 出事时无法逐条核"到底改了什么"。
 *
 * 用法：node scripts/tests/unit/test_migrate_attrs.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠️ 端到端**不 spawn 子进程**：本仓的单测运行环境里 node 无法再 spawn 一个 node（EBUSY）。
//    所以脚本被刻意切成「薄 CLI 外壳 + 可调用逻辑层（parseArgs / runMigration）」，
//    用例直接调逻辑层做真实的文件读写 —— 覆盖的仍是"真落盘"，只是不经进程边界。
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-vault-attrs.js');
const FIXTURE_GEODATA = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'vault-fixture', 'geodata.json');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}

// ── 造一份迷你"项目 + 知识库节点"（不依赖 fixture，读数可控）──
const NOTE_DIR = '合成数据/地点';
const noteFor = (id, name, extra = {}) => ({
  id, name, layer: extra.layer || 'city', layerLabel: extra.layerLabel || '城市',
  parentId: extra.parentId === undefined ? '曜川星' : extra.parentId,
  placeType: extra.placeType === undefined ? '商业' : extra.placeType,
  sourcePath: `${NOTE_DIR}/${name}.md`, coordinate: { x: 0, y: 0 },
});
const entFor = (id, name, patch = {}) => ({
  id, name, layer: 'unknown', layerLabel: '未知', parentId: null, placeType: '',
  origin: 'obsidian', sourcePath: `${NOTE_DIR}/${name}.md`, coordinate: { x: 1, y: 2 },
  ...patch,
});

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sitian-${tag}-`));
}
/** 临时目录清理（safe-delete shim 可能拦批量删除 → 失败不影响结论） */
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 留给系统清理 */ }
}

async function main() {
  const M = require(SCRIPT);
  const { buildMigrationPlan, applyPatches, isBlank, parseArgs, runMigration } = M;

  // 父级占位实体：`Note 给的 parentId` 必须在项目里存在，否则会被正确地判成「父级缺失」
  const parentStub = { id: '曜川星', name: '曜川星', layer: 'planet', sourcePath: '' };

  // ─────────────────────────────────────────────
  // 1. 纯函数：认亲 + 补齐
  // ─────────────────────────────────────────────
  await check('t1 按来源笔记认亲；反斜杠 / 正斜杠两种写法必须配得上（Windows 上必然出现）', () => {
    const entities = {
      a: entFor('a', '青崖城'),
      b: entFor('b', '云梦泽', { sourcePath: `合成数据\\地点\\云梦泽.md` }),   // 反斜杠形态
    };
    const plan = buildMigrationPlan({
      entities,
      vaultNodes: [noteFor('n1', '青崖城'), noteFor('n2', '云梦泽')],
    });
    eq(plan.matched, 2, '两个实体都应认亲成功');
    eq(plan.unmatchedEntities.length, 0, '不该有认不到的');
    assert(plan.patches.some(p => p.id === 'b'), '反斜杠路径的实体也要被补上（归一化没做的话这里会认不到）');
    return '正/反斜杠两种 sourcePath 都能对上同一篇笔记';
  });

  await check('t2 只补「项目侧为空」的字段：空 / unknown / null / 空串都算空', () => {
    assert(isBlank({ layer: 'unknown' }, 'layer'), 'unknown 视为空（提取器推断不出时写的就是它）');
    assert(isBlank({ layer: '' }, 'layer'), '空串');
    assert(isBlank({ layer: undefined }, 'layer'), 'undefined');
    assert(!isBlank({ layer: 'city' }, 'layer'), '有值 → 不为空');
    assert(isBlank({ parentId: null }, 'parentId'), 'parentId null');
    assert(isBlank({ placeType: '' }, 'placeType'), 'placeType 空串');

    const plan = buildMigrationPlan({
      entities: {
        '曜川星': parentStub,
        a: entFor('a', '青崖城'),
        b: entFor('b', '云泽城', { sourcePath: `${NOTE_DIR}/云泽城.md` }),
      },
      vaultNodes: [noteFor('n1', '青崖城'), noteFor('n2', '云泽城')],
    });
    // a 的 layer / parentId / placeType 三项都空 → 三项都要补
    const forA = plan.patches.filter(p => p.id === 'a').map(p => p.field).sort();
    deepEq(forA, ['layer', 'parentId', 'placeType'], 'a 应补三个字段');
    eq(plan.matched, 2, '两个都认到');
    return '空白判据：undefined / null / 空串 / unknown';
  });

  await check('t3 ★ 项目侧已有值 → 一律不覆盖；与笔记不同时进「冲突」清单交人判断', () => {
    const entities = {
      '曜川星': parentStub,
      a: entFor('a', '青崖城', { layer: 'town', layerLabel: '城镇' }),   // 用户改过：笔记说 city
      b: entFor('b', '云泽城', { sourcePath: `${NOTE_DIR}/云泽城.md`, layer: 'city' }),  // 与笔记一致
    };
    const plan = buildMigrationPlan({ entities, vaultNodes: [noteFor('n1', '青崖城'), noteFor('n2', '云泽城')] });

    assert(!plan.patches.some(p => p.id === 'a' && p.field === 'layer'),
      '项目已有 layer=town，脚本绝不能把它改成 city');
    const c = plan.conflicts.find(x => x.id === 'a' && x.field === 'layer');
    assert(!!c, '不一致必须进冲突清单（不能悄悄放过）');
    eq(c.project, 'town', '冲突里记着项目值');
    eq(c.note, 'city', '冲突里记着笔记值');

    assert(!plan.conflicts.some(x => x.id === 'b' && x.field === 'layer'), '一致的不算冲突');
    eq(plan.already >= 1, true, '一致的要计入 already');
    // 冲突的字段不能被补（a 的 layer 有值 → 不进 patches），但另外两个空字段照补
    const forA = plan.patches.filter(p => p.id === 'a').map(p => p.field).sort();
    deepEq(forA, ['parentId', 'placeType'], 'a 只补空的那两项');
    return `冲突 ${plan.conflicts.length} 条（记下项目值 vs 笔记值），一致 ${plan.already} 条`;
  });

  await check('t4 ★ 补 parentId 前必须校验父实体存在 —— 否则补出悬空引用，会被项目校验静默置空', () => {
    const entities = { a: entFor('a', '青崖城', { parentId: null }) };
    // 笔记给的父级是「不存在的星」，项目里没有这个实体
    const plan = buildMigrationPlan({
      entities,
      vaultNodes: [noteFor('n1', '青崖城', { parentId: '不存在的星' })],
    });
    assert(!plan.patches.some(p => p.field === 'parentId'), '父实体不存在时绝不能补 parentId');
    eq(plan.parentMissing.length, 1, '要单独列出「父级缺失」而不是静默跳过');
    eq(plan.parentMissing[0].wantParentId, '不存在的星', '点名期望的父级');

    // 父实体存在 → 正常补
    const ok = buildMigrationPlan({
      entities: { a: entFor('a', '青崖城', { parentId: null }), '曜川星': entFor('p', '曜川星', { parentId: null }) },
      vaultNodes: [noteFor('n1', '青崖城')],
    });
    const patched = ok.patches.find(p => p.field === 'parentId');
    assert(!!patched && patched.to === '曜川星', '父实体在项目里 → 照常补');
    return '父级缺失单独成类（不补、不静默）';
  });

  await check('t5 用户自建实体（无 sourcePath）不参与搬家 —— 笔记里根本没有它', () => {
    const entities = {
      mine: { id: 'mine', name: '我手建的地点', layer: 'unknown', sourcePath: '' },
      a: entFor('a', '青崖城'),
    };
    const plan = buildMigrationPlan({ entities, vaultNodes: [noteFor('n1', '青崖城')] });
    eq(plan.matched, 1, '只有带 sourcePath 的那个参与');
    assert(!plan.patches.some(p => p.id === 'mine'), '自建实体不该被补');
    assert(!plan.unmatchedEntities.some(u => u.id === 'mine'), '也不该被列进「认不到」（那是改名场景，和自建是两回事）');
    return '无来源笔记 = 用户自建 → 直接跳过';
  });

  await check('t6 认不到的实体（来源笔记不在库里）单独列出 —— 那是「改名」信号，指向 A-0 的重连', () => {
    const entities = { a: entFor('a', '已改名的城') };
    const plan = buildMigrationPlan({ entities, vaultNodes: [noteFor('n1', '青崖城')] });
    eq(plan.matched, 0, '认不到就不参与');
    eq(plan.unmatchedEntities.length, 1, '单独列出');
    eq(plan.unmatchedEntities[0].sourcePath, `${NOTE_DIR}/已改名的城.md`, '带上原路径供人核对');
    eq(plan.patches.length, 0, '认不到就不补');
    return '认不到 → 提示「先跑检查笔记改名」';
  });

  await check('t7 补 layer 时把 layerLabel 一起补（否则树上的徽标显示英文 code）', () => {
    const plan = buildMigrationPlan({
      entities: { a: entFor('a', '青崖城', { layer: 'unknown', layerLabel: '未知' }) },
      vaultNodes: [noteFor('n1', '青崖城', { layer: 'city', layerLabel: '城市' })],
    });
    const p = plan.patches.find(x => x.field === 'layer');
    eq(p.to, 'city', '补的取值是 layer code');
    eq(p.label, '城市', '★ 同时带上 layerLabel');
    return 'layer → to=city / label=城市';
  });

  // ─────────────────────────────────────────────
  // 2. 纯函数：applyPatches
  // ─────────────────────────────────────────────
  await check('t8 applyPatches 是纯函数（不改入参），并且只动 patches 里的字段', () => {
    const project = {
      version: '1.0.0', meta: { name: 'P', updated: 'old' },
      entities: { a: entFor('a', '青崖城'), b: entFor('b', '云泽城', { sourcePath: `${NOTE_DIR}/云泽城.md` }) },
    };
    const snapshot = JSON.stringify(project);
    const plan = buildMigrationPlan({
      entities: project.entities,
      vaultNodes: [noteFor('n1', '青崖城')],
    });
    const next = applyPatches(project, plan.patches, { now: '2026-09-27T00:00:00.000Z' });

    eq(JSON.stringify(project), snapshot, '原对象不得被改动');
    assert(next !== project, '要返回新对象');
    eq(next.entities.a.layer, 'city', 'a 的 layer 被补上');
    eq(next.entities.a.layerLabel, '城市', 'layerLabel 一起补');
    eq(next.entities.a.createdAt, project.entities.a.createdAt, 'createdAt 不动');
    eq(next.entities.a.updatedAt, '2026-09-27T00:00:00.000Z', 'updatedAt 刷新');
    eq(next.meta.updated, '2026-09-27T00:00:00.000Z', 'meta.updated 刷新');
    eq(next.entities.b.layer, 'unknown', 'b 没在计划里 → 一个字段都不许动');
    // 坐标这类"别人的数据"必须原样
    deepEq(next.entities.a.coordinate, { x: 1, y: 2 }, '坐标不动');
    return '入参未变；只改计划内的字段 + updatedAt';
  });

  await check('t9 计划里出现不存在的实体 id 时跳过（不抛、不造新实体）', () => {
    const project = { entities: { a: entFor('a', '青崖城') } };
    const next = applyPatches(project, [
      { id: 'ghost', field: 'layer', to: 'city' },
      { id: 'a', field: 'layer', to: 'city', label: '城市' },
    ], { now: 'T' });
    eq(Object.keys(next.entities).length, 1, '不该凭空多出实体');
    eq(next.entities.a.layer, 'city', '正常的那条照做');
    return '幽灵 id 被跳过';
  });

  // ─────────────────────────────────────────────
  // 3. 端到端：真跑脚本（临时目录，不碰真实库与真实项目）
  // ─────────────────────────────────────────────
  /** 造一个临时「库 + 项目」环境：库用 fixture 的 geodata.json（--from-cache 的来源） */
  function makeEnv(tag, projectEntities) {
    const dir = tmpDir(tag);
    const vault = path.join(dir, 'vault');
    fs.mkdirSync(path.join(vault, '.sitian'), { recursive: true });
    fs.copyFileSync(FIXTURE_GEODATA, path.join(vault, '.sitian', 'geodata.json'));
    const projectPath = path.join(dir, '迁移测试.sitian');
    const project = {
      version: '1.0.0',
      meta: { id: 'p1', name: '迁移测试', created: 'T', updated: 'T' },
      entities: projectEntities,
      hyperlanes: [], scenarios: { version: 2, baseMaps: {}, scenarios: {} }, maps: {}, snapshots: [],
    };
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf-8');
    return { dir, vault, projectPath, project };
  }
  // fixture 里的曜川星：笔记侧 layer=planet / layerLabel=行星 / parentId=曜川星系 / placeType=null
  const YAOCHUAN = {
    id: '曜川星', name: '曜川星', layer: 'unknown', layerLabel: '未知', parentId: null,
    placeType: '', origin: 'obsidian', sourcePath: '合成数据/planet/曜川星.md', coordinate: { x: 1, y: 2 },
  };

  await check('t10 ★ 端到端：默认 dry-run 只出清点表、**一个文件都不写**', async () => {
    const env = makeEnv('migrate-dry', { '曜川星': { ...YAOCHUAN } });
    try {
      const before = fs.readFileSync(env.projectPath, 'utf-8');
      const lines = [];
      const res = await runMigration({
        projectPath: env.projectPath, vault: env.vault, fromCache: true, apply: false,
        log: (s) => lines.push(s),
      });
      const text = lines.join('\n');
      assert(res.ok, res.error);
      eq(res.written, false, 'dry-run 不写盘');
      assert(text.includes('搬家清点表'), '要打印清点表');
      assert(text.includes('待补属性'), '要有待补统计');
      assert(text.includes('dry-run'), '要明确说明是 dry-run');
      eq(fs.readFileSync(env.projectPath, 'utf-8'), before, '★ 项目文件必须一字未改');
      assert(!fs.existsSync(`${env.projectPath}.backups`), '★ dry-run 不该产生任何备份目录');
      return `清点表已出（待补 ${res.plan.patches.length} 处），项目文件与备份目录都未变`;
    } finally { cleanup(env.dir); }
  });

  await check('t11 ★ 端到端：--apply 补齐属性 + 落旧文件备份 + 落反向档，且笔记侧没被碰', async () => {
    const env = makeEnv('migrate-apply', {
      // 父实体也在项目里 → parentId 才补得进去（父级不在项目里会被正确跳过，见 t4）
      '曜川星系': { id: '曜川星系', name: '曜川星系', layer: 'galaxy', layerLabel: '星系', parentId: null, placeType: '', sourcePath: '' },
      '曜川星': { ...YAOCHUAN, coordinate: { x: 7, y: 8 } },
    });
    try {
      // 造一篇"笔记"（只读校验：脚本不该动它）
      const noteDir = path.join(env.vault, '合成数据', 'planet');
      fs.mkdirSync(noteDir, { recursive: true });
      const notePath = path.join(noteDir, '曜川星.md');
      fs.writeFileSync(notePath, '---\n层级: 行星\n上层区域: [[曜川星系]]\n---\n\n# 曜川星\n', 'utf-8');
      const noteBefore = fs.readFileSync(notePath, 'utf-8');

      const lines = [];
      const res = await runMigration({
        projectPath: env.projectPath, vault: env.vault, fromCache: true, apply: true,
        log: (s) => lines.push(s),
      });
      assert(res.ok, res.error);
      eq(res.written, true, 'apply 应写盘');
      assert(lines.join('\n').includes('已补'), '要有写入回执');

      const after = JSON.parse(fs.readFileSync(env.projectPath, 'utf-8'));
      const e = after.entities['曜川星'];
      eq(e.layer, 'planet', '★ layer 已补（unknown → planet）');
      eq(e.layerLabel, '行星', 'layerLabel 一起补');
      eq(e.parentId, '曜川星系', 'parentId 已补（父实体在同批里）');
      deepEq(e.coordinate, { x: 7, y: 8 }, '★ 坐标这类既有数据不许被碰');

      // 备份 + 反向档
      const backups = fs.readdirSync(`${env.projectPath}.backups`);
      const oldFiles = backups.filter(f => f.endsWith('.sitian'));
      const archives = backups.filter(f => f.startsWith('migrate-attrs-') && f.endsWith('.json'));
      assert(oldFiles.length >= 1, '★ 写盘前必须留一份旧文件备份');
      eq(archives.length, 1, '★ 必须落一份反向档');
      const archivePath = path.join(`${env.projectPath}.backups`, archives[0]);
      eq(res.archivePath, archivePath, 'runMigration 要回报反向档路径');
      const arc = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
      eq(arc.kind, 'migrate-vault-attrs', '反向档类型');
      assert(arc.applied.length >= 1, '反向档要逐条记「从什么改成什么」');
      const one = arc.applied.find(a => a.field === 'layer');
      eq(one.from, 'unknown', '反向档记着原值');
      eq(one.to, 'planet', '反向档记着新值');
      eq(one.note, '合成数据/planet/曜川星.md', '反向档记着来源笔记（可回溯）');

      eq(fs.readFileSync(notePath, 'utf-8'), noteBefore, '★ 笔记必须一字未改（原字段原地不动）');
      return `补 ${arc.applied.length} 处；旧文件备份 ${oldFiles.length} 份 + 反向档 1 份；笔记未动`;
    } finally { cleanup(env.dir); }
  });

  await check('t12 ★ 端到端：项目侧已有值时 --apply 不覆盖它（冲突只报告）', async () => {
    const env = makeEnv('migrate-conflict', {
      // 用户把它设成"卫星"（笔记说行星）→ 脚本必须保留卫星
      '曜川星': { ...YAOCHUAN, layer: 'moon', layerLabel: '卫星', parentId: '曜川星系', placeType: '公共' },
    });
    try {
      const lines = [];
      const res = await runMigration({
        projectPath: env.projectPath, vault: env.vault, fromCache: true, apply: true,
        log: (s) => lines.push(s),
      });
      assert(res.ok, res.error);
      const after = JSON.parse(fs.readFileSync(env.projectPath, 'utf-8'));
      eq(after.entities['曜川星'].layer, 'moon', '★ 用户设的 moon 必须保住（笔记说 planet）');
      eq(after.entities['曜川星'].layerLabel, '卫星', 'label 也要跟着保住');
      eq(after.entities['曜川星'].placeType, '公共', 'placeType 也要保住');
      assert(res.plan.conflicts.some(c => c.field === 'layer' && c.project === 'moon' && c.note === 'planet'),
        '冲突要进计划，且带着项目值与笔记值两边的取值');
      assert(lines.join('\n').includes('冲突') || lines.join('\n').includes('没有需要补'),
        '报告里要提到冲突（不能静默放过）');
      eq(res.written, false, '没有待补 → 不该写盘');
      return `冲突 ${res.plan.conflicts.length} 条，项目值未被覆盖，未写盘`;
    } finally { cleanup(env.dir); }
  });

  await check('t13 CLI 参数解析：缺 --project 报错、默认 dry-run、--apply 必须显式', () => {
    const bad = parseArgs([]);
    assert(bad.error.includes('--project'), '要指明缺哪个参数');
    eq(bad.apply, false, '默认 dry-run（apply 必须显式）');
    const ok = parseArgs(['--project', 'x/y.sitian', '--apply', '--from-cache', '--limit', '3']);
    eq(ok.apply, true, '--apply 解析');
    eq(ok.fromCache, true, '--from-cache 解析');
    eq(ok.limit, 3, '--limit 解析');
    assert(ok.projectPath.endsWith('y.sitian') && path.isAbsolute(ok.projectPath), '--project 要转成绝对路径');
    eq(parseArgs(['--project', 'x/y.sitian']).apply, false, '不给 --apply 就是 dry-run');
    return 'parseArgs 全参数解析 + 默认不写盘';
  });

  // ─────────────────────────────────────────────
  // 4. 跨实现一致性：路径归一化只有一处"真身"
  // ─────────────────────────────────────────────
  await check('t14 ★ normalizeRelPath 两处实现必须逐字符一致（提取器 CJS vs renderer ESM 副本）', () => {
    const pick = (file) => {
      const src = fs.readFileSync(file, 'utf-8');
      const i = src.indexOf('function normalizeRelPath');
      assert(i >= 0, `${file} 里找不到 normalizeRelPath`);
      // 取函数体（到下一个顶层 } 为止），剥注释 + 压掉空白后比较 —— 缩进/注释差异不算差异
      const body = src.slice(i, src.indexOf('\n}', i) + 2);
      return body.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    };
    const a = pick(path.join(ROOT, 'scripts', 'extract-data.js'));
    const b = pick(path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'vaultRelink.js'));
    assert(a.includes('.replace(/\\\\/g'), '提取器那份要实现反斜杠归一化');
    eq(b, a, '两份实现对不上 → 同一个 sourcePath 会被判成两个（改名检测与搬家都会错）');
    return '两份实现逐字符等价（改一处漏改另一处立刻红）';
  });

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.error('\n失败：');
    for (const f of failed) console.error(`  · ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('用例异常：', e); process.exit(1); });
