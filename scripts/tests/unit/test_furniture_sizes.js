/**
 * interior/furnitureSizes.js 单测 + 重排命令冒烟（台账 A18，2026-11-16）
 *
 * 这条命令会**写用户的项目文件**，所以判据里最要紧的三条是：
 *   ① 只动家具（门窗洞口、院落/园林这类地面区域一律不碰）；
 *   ② 改尺寸时**中心点不动**（x/y 是左上角，宽高变了不挪回去，家具会整体跑偏）；
 *   ③ 可以反复跑：第二遍必须 0 改动；`--apply` 之后**件数不变**。
 *
 * 另外还有一条"单一来源"的闸门：UI 里不许再留第二份尺寸表（否则命令与界面迟早漂移）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/furnitureSizes.js')).href);
const {
  FURNITURE_SIZES, DEFAULT_FURNITURE_SIZE,
  furnitureSize, isResizableFurniture, planFurnitureResize, applyFurnitureResize,
} = mod;

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push({ name, ok: true, note });
    console.log(`  ✅ ${name}${note ? ` —— ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: e && e.message });
    console.log(`  ❌ ${name} —— ${e && e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}：期望 ${b}，实际 ${a}`);
}

/** 造一个"旧项目"：床 100×80、桌 60×40、门洞 90×20、院子 600×600、一件坏尺寸 */
function oldProject() {
  return {
    version: '1.0.0',
    meta: { name: '用例项目' },
    entities: [],
    interiorData: {
      b1: {
        floors: [{
          id: 'f1',
          name: '一层',
          furniture: [
            { id: 'u1', name: '床', type: 'bed', x: 100, y: 200, width: 100, height: 80, rotation: 0, color: '#4682B4' },
            { id: 'u2', name: '桌', type: 'table', x: 400, y: 100, width: 60, height: 40, rotation: 90 },
            { id: 'u3', name: '门', type: 'door', x: 0, y: 0, width: 90, height: 20 },
            { id: 'u4', name: '院子', type: 'courtyard', x: 0, y: 0, width: 600, height: 600 },
            { id: 'u5', name: '没尺寸', type: 'chest', x: 10, y: 10 },
            { id: 'u6', name: '已是真实尺寸', type: 'bed', x: 0, y: 0, width: 200, height: 150 },
          ],
        }],
      },
      b2: { floors: [{ id: 'g1', name: '屋面', furniture: [] }] },
    },
  };
}

// ── 表本身 ──────────────────────────────────────────────────────────────

check('f1 表覆盖全部类型：8 种家具 + 门窗 + 5 种地面区域，且分得清 kind', () => {
  const want = {
    generic: 'furniture', table: 'furniture', chair: 'furniture', bed: 'furniture',
    chest: 'furniture', wardrobe: 'furniture', sofa: 'furniture', decoration: 'furniture',
    door: 'opening', window: 'opening',
    courtyard: 'area', garden: 'area', corridor: 'area', pond: 'area', wall: 'area',
  };
  for (const [type, kind] of Object.entries(want)) {
    const s = FURNITURE_SIZES[type];
    assert(s, `缺 ${type}`);
    assert(s.kind === kind, `${type} 的 kind 应为 ${kind}，实际 ${s.kind}`);
    assert(s.w > 0 && s.h > 0, `${type} 的尺寸必须为正`);
  }
  return `${Object.keys(want).length} 类`;
});

check('f2 认不出的类型回落"通用"，且当成家具（该被重排）', () => {
  const s = furnitureSize('不存在的类型');
  assert(s.w === DEFAULT_FURNITURE_SIZE.w && s.h === DEFAULT_FURNITURE_SIZE.h, '应回落通用尺寸');
  assert(s.kind === 'furniture', '认不出的东西按家具处理');
  assert(isResizableFurniture({ type: '不存在的类型' }) === true, '应该被判成可重排');
  assert(furnitureSize(null).kind === 'furniture', 'null 也走通用');
  return `${s.w}×${s.h}`;
});

check('f3 单一来源：InteriorView 里不许再留第二份尺寸表', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/InteriorView.vue'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert(src.includes("from '../interior/furnitureSizes.js'"), 'InteriorView 没 import furnitureSizes');
  assert(!/bed:\s*\{\s*w:\s*200/.test(src), 'InteriorView 里还留着旧的尺寸字面量（会出现两份表）');
  return '只 import 一份';
});

// ── 计划 ────────────────────────────────────────────────────────────────

check('f4 旧尺寸改成真实尺寸：床 100×80 → 200×150，**中心不动**', () => {
  const plan = planFurnitureResize(oldProject());
  const bed = plan.changes.find((c) => c.id === 'u1');
  assert(bed, '床应该被重排');
  assert(bed.to.w === 200 && bed.to.h === 150, `目标应是 200×150，实际 ${bed.to.w}×${bed.to.h}`);
  const cxBefore = bed.from.x + bed.from.w / 2;
  const cyBefore = bed.from.y + bed.from.h / 2;
  const cxAfter = bed.to.x + bed.to.w / 2;
  const cyAfter = bed.to.y + bed.to.h / 2;
  near(cxAfter, cxBefore, 0.11, 'x 中心');
  near(cyAfter, cyBefore, 0.11, 'y 中心');
  return `(${cxBefore},${cyBefore}) 不动`;
});

check('f5 只动家具：门洞、院子进 skipped，且原因写对', () => {
  const plan = planFurnitureResize(oldProject());
  const door = plan.skipped.find((s) => s.id === 'u3');
  const court = plan.skipped.find((s) => s.id === 'u4');
  assert(door && door.reason === 'opening', '门应是 opening');
  assert(court && court.reason === 'area', '院子应是 area');
  assert(!plan.changes.some((c) => c.id === 'u3' || c.id === 'u4'), '门窗与区域不许出现在 changes 里');
  return '2 类跳过';
});

check('f6 缺尺寸的不猜：进 skipped（bad-size），不进 changes', () => {
  const plan = planFurnitureResize(oldProject());
  const bad = plan.skipped.find((s) => s.id === 'u5');
  assert(bad && bad.reason === 'bad-size', '坏尺寸原因应是 bad-size');
  assert(!plan.changes.some((c) => c.id === 'u5'), '坏尺寸不许被改');
  return '1 件';
});

check('f7 尺寸已经在容差内就不动（命令可以反复跑）', () => {
  const plan = planFurnitureResize(oldProject());
  assert(!plan.changes.some((c) => c.id === 'u6'), '200×150 的床不该再被改');
  assert(plan.stats.alreadyOk >= 1, 'alreadyOk 应 ≥ 1');
  return `已是真实尺寸 ${plan.stats.alreadyOk} 件`;
});

check('f8 统计对得上：changes + alreadyOk + skipped = 家具总数', () => {
  const plan = planFurnitureResize(oldProject());
  const s = plan.stats;
  assert(s.furniture === 6, `家具总数应 6，实际 ${s.furniture}`);
  assert(s.changed + s.alreadyOk + s.skipped === s.furniture,
    `${s.changed}+${s.alreadyOk}+${s.skipped} ≠ ${s.furniture}`);
  assert(s.floors === 2, `层数应 2，实际 ${s.floors}`);
  assert(s.byType.bed === 1 && s.byType.table === 1, `按类型统计不对：${JSON.stringify(s.byType)}`);
  return `改 ${s.changed} / 已好 ${s.alreadyOk} / 跳 ${s.skipped}`;
});

// ── 应用 ────────────────────────────────────────────────────────────────

check('f9 apply 不改入参（原对象里的家具还是旧值）', () => {
  const project = oldProject();
  const plan = planFurnitureResize(project);
  applyFurnitureResize(project, plan.changes);
  const bed = project.interiorData.b1.floors[0].furniture.find((f) => f.id === 'u1');
  assert(bed.width === 100 && bed.height === 80, '原对象被改了（必须返回新对象）');
  return '入参未动';
});

check('f10 apply 之后：尺寸到位、件数不变、rotation 与颜色等字段原样保留', () => {
  const project = oldProject();
  const plan = planFurnitureResize(project);
  const next = applyFurnitureResize(project, plan.changes);
  const fur = next.interiorData.b1.floors[0].furniture;
  assert(fur.length === 6, `件数应 6，实际 ${fur.length}`);
  const bed = fur.find((f) => f.id === 'u1');
  assert(bed.width === 200 && bed.height === 150, `床应是 200×150，实际 ${bed.width}×${bed.height}`);
  assert(bed.color === '#4682B4', '颜色被改了');
  const table = fur.find((f) => f.id === 'u2');
  assert(table.rotation === 90, 'rotation 被改了');
  return '6 件 / 字段保留';
});

check('f11 幂等：apply 之后再 plan 必须是 0 改动', () => {
  const project = oldProject();
  const plan = planFurnitureResize(project);
  const next = applyFurnitureResize(project, plan.changes);
  const again = planFurnitureResize(next);
  assert(again.stats.changed === 0, `第二遍还应改 ${again.stats.changed} 件`);
  assert(again.stats.furniture === plan.stats.furniture, '件数变了');
  return '0 改动';
});

check('f12 退化输入：没有 interiorData / floors 不是数组 / 家具是 null → 不炸', () => {
  assert(planFurnitureResize(null).stats.furniture === 0, 'null 项目应 0 件');
  assert(planFurnitureResize({}).stats.furniture === 0, '没有 interiorData 应 0 件');
  const weird = { interiorData: { b: { floors: [null, { furniture: null }, { furniture: [null, { type: 'bed' }] }] } } };
  const plan = planFurnitureResize(weird);
  // null 那件不算家具（不是对象）；真正数到的是 {type:'bed'} 一件，它没尺寸 → skipped
  assert(plan.stats.furniture === 1, `只该数到 1 件，实际 ${plan.stats.furniture}`);
  assert(plan.stats.skipped === 1, '没尺寸那件应进 skipped');
  return '3 种退化';
});

check('f13 确定性与不改入参（plan 跑两遍结果逐项相同）', () => {
  const p = oldProject();
  const before = JSON.stringify(p);
  const a = JSON.stringify(planFurnitureResize(p));
  const b = JSON.stringify(planFurnitureResize(p));
  assert(a === b, '两次 plan 结果不同');
  assert(JSON.stringify(p) === before, 'plan 改了入参');
  return '一致';
});

// ── 命令冒烟（真跑一次 CLI：dry-run → apply → 再 dry-run）───────────────

check('f14 CLI 冒烟：dry-run 不写盘 / --apply 写盘且留备份 / 再跑一次 0 改动', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'build', 'test-furniture-'));
  const file = path.join(dir, 'case.sitian');
  fs.writeFileSync(file, JSON.stringify(oldProject()), 'utf8');
  const cli = path.join(ROOT, 'scripts', 'rearrange-furniture-sizes.mjs');
  const run = (...args) => execFileSync(process.execPath, [cli, '--project', file, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  });

  const sizeBefore = fs.statSync(file).size;
  const dry = run();
  assert(/需要重排：2 件/.test(dry), `dry-run 输出不对：${dry.split('\n').find((l) => l.includes('需要重排')) || dry.slice(0, 120)}`);
  assert(fs.statSync(file).size === sizeBefore, 'dry-run 竟然写盘了');

  const applied = run('--apply');
  assert(/✅ 完成/.test(applied), 'apply 没报成功');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bed = after.interiorData.b1.floors[0].furniture.find((f) => f.id === 'u1');
  assert(bed.width === 200 && bed.height === 150, '写盘后床不是 200×150');
  const backups = fs.readdirSync(`${file}.backups`).filter((f) => f.endsWith('.sitian'));
  assert(backups.length === 1, `应有 1 份备份，实际 ${backups.length}`);
  const backup = JSON.parse(fs.readFileSync(path.join(`${file}.backups`, backups[0]), 'utf8'));
  const oldBed = backup.interiorData.b1.floors[0].furniture.find((f) => f.id === 'u1');
  assert(oldBed.width === 100, '备份里应是旧值（100）');

  const again = run();
  assert(/没有需要改的/.test(again), `再跑一次应 0 改动：${again.slice(-160)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return 'dry-run / apply / 幂等 三步都过';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} furnitureSizes 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
