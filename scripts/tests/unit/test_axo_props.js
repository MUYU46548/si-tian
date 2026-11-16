/**
 * interior/axoProps.js 单测（2026-11-16）
 *
 * 这一层决定“插图里那几样东西对不对”：
 *   · 比例人/树**高就是那么高**（170cm 的人贴在 3m 墙边该是墙高的 57%），摆的位置不被楼挡住、
 *     也不出画面；
 *   · 墙面色阶是**四档查表**（不是连续光照），换个面朝向就换档；颜色乘法不带偏色；
 *   · 图注说人话：层数/占地/投影/方位齐全，没墙的时候不许编一个 0×0 出来；
 *   · 指北针按投影角度真的会转（换角度针不动就是画死的）。
 *
 * ⚠️ 这里测的是**纯函数**：不出图、不需要浏览器。出图长什么样由
 * `scripts/tests/drill_axonometric.py` 判（那一条会做“关掉比例人再出一张”的对照）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/axoProps.js')).href);
const {
  PROP_DEFAULTS, AXO_TONES, AXO_SHEET,
  personSilhouette, treeSilhouette,
  screenAxes, propPlacements, propFitPoints,
  wallTone, axialTone, toneColor,
  northScreenVector, northText,
  axoSheetPlan, axoCaptionModel,
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
const ys = (pts) => pts.map((p) => p[1]);
const xs = (pts) => pts.map((p) => p[0]);
const allPoints = (sil) => sil.parts.reduce((acc, p) => acc.concat(p.points), []);

/** 一栋 900×650、高 600 的两层小楼（cm），与 test_axonometric 同一份 */
const HOUSE = {
  center: [0, 300, 0],
  size: [900, 600, 650],
  min: [-450, 0, -325],
  max: [450, 600, 325],
};

// ── 比例人 / 树 ─────────────────────────────────────────────────────────

check('y1 人形剪影：总高精确等于身高，脚踩在 y=0', () => {
  const sil = personSilhouette(170);
  const pts = allPoints(sil);
  near(Math.max(...ys(pts)), 170, 0.02, '头顶应在 170');
  near(Math.min(...ys(pts)), 0, 0.02, '脚应在 0');
  assert(sil.parts.length >= 2, '头与身体应分开（头是圆、身子有腿缝）');
  for (const p of sil.parts) assert(p.points.length >= 3, `${p.kind} 至少 3 个点`);
  return `${sil.parts.length} 段 · 高 ${sil.height}`;
});

check('y2 人形按身高等比缩放（1.90 m 的头顶就在 190）', () => {
  const small = personSilhouette(170);
  const tall = personSilhouette(190);
  near(Math.max(...ys(allPoints(tall))), 190, 0.02, '190 的头顶');
  const wSmall = Math.max(...xs(allPoints(small)));
  const wTall = Math.max(...xs(allPoints(tall)));
  near(wTall / wSmall, 190 / 170, 0.01, '宽度应跟着身高走');
  return `宽 ${wSmall.toFixed(1)} → ${wTall.toFixed(1)}`;
});

check('y3 树：冠顶 = 树高，树干踩地，树冠压住树干顶端（不能断成两截）', () => {
  const sil = treeSilhouette(480);
  const trunk = sil.parts.find((p) => p.kind === 'trunk');
  const crown = sil.parts.find((p) => p.kind === 'crown');
  assert(trunk && crown, '树应有树干与树冠两段');
  near(Math.max(...ys(crown.points)), 480, 0.05, '冠顶应为树高');
  near(Math.min(...ys(trunk.points)), 0, 0.02, '树干底应在 0');
  assert(Math.min(...ys(crown.points)) < Math.max(...ys(trunk.points)), '冠底应低于干顶（接得上）');
  return `干到 ${Math.max(...ys(trunk.points)).toFixed(0)}，冠自 ${Math.min(...ys(crown.points)).toFixed(0)} 起`;
});

check('y4 剪影是确定性的：两次调用逐项相同（不靠随机数）', () => {
  const a = JSON.stringify(personSilhouette());
  const b = JSON.stringify(personSilhouette());
  const c = JSON.stringify(treeSilhouette());
  const d = JSON.stringify(treeSilhouette());
  assert(a === b && c === d, '同样的输入必须给同样的点');
  return `${a.length} / ${c.length} 字符`;
});

check('y5 摆位：人和树都站在地面高度（y = 包围盒底）', () => {
  const list = propPlacements(HOUSE, { preset: 'iso' });
  assert(list.length === 2, '应有一个人 + 一棵树');
  for (const p of list) near(p.at[1], HOUSE.min[1], 0.01, `${p.kind} 应踩在地上`);
  return list.map((p) => `${p.kind} ${p.heightCm}`).join(' / ');
});

check('y6 摆位在**楼的左前方**：投影上既不压住楼，也不会被楼挡住', () => {
  for (const preset of ['iso', 'dimetric', 'high']) {
    const ax = screenAxes(preset);
    const list = propPlacements(HOUSE, { preset });
    const halfR = (Math.abs(ax.right.x) * HOUSE.size[0] + Math.abs(ax.right.z) * HOUSE.size[2]) / 2;
    const halfF = (Math.abs(ax.toward.x) * HOUSE.size[0] + Math.abs(ax.toward.z) * HOUSE.size[2]) / 2;
    for (const p of list) {
      const dx = p.at[0] - HOUSE.center[0];
      const dz = p.at[2] - HOUSE.center[2];
      const r = dx * ax.right.x + dz * ax.right.z;      // 屏幕左右
      const f = dx * ax.toward.x + dz * ax.toward.z;    // 屏幕上下（+f = 朝相机 = 画面下方）
      assert(r <= -halfR, `${preset}/${p.kind} 应挪到楼的左侧（r=${r.toFixed(0)}，需 ≤ ${-halfR.toFixed(0)}）`);
      assert(f >= halfF, `${preset}/${p.kind} 应比楼更靠相机（f=${f.toFixed(0)}，需 ≥ ${halfF.toFixed(0)}）`);
    }
  }
  return '3 个投影角都在左前方';
});

check('y7 换方位角摆位跟着换；只抬仰角不变（朝向相机的是哪一侧只由方位角定）', () => {
  const iso = propPlacements(HOUSE, { preset: 'iso' })[0].at.join(',');
  const dim = propPlacements(HOUSE, { preset: 'dimetric' })[0].at.join(',');
  const high = propPlacements(HOUSE, { preset: 'high' })[0].at.join(',');
  assert(iso !== dim, 'iso 与 dimetric 的方位角不同，摆位必须不同（否则换个角度人会被楼挡住）');
  assert(iso === high, '只抬仰角时摆位应不变 —— 这一侧仍朝着相机，挪了反而会跑到楼后面');
  return 'iso ≠ dimetric，iso = high';
});

check('y8 取景点：楼 8 个角 + 每个人/树 4 个点（按面向相机的平面算）', () => {
  const list = propPlacements(HOUSE, { preset: 'iso' });
  const pts = propFitPoints(HOUSE, list, 'iso');
  assert(pts.length === 8 + list.length * 4, `点数应为 8+${list.length * 4}，实际 ${pts.length}`);
  // 树顶（480）比楼（600）矮，所以"最高点"是楼的角；这里查的是**树的顶点在不在集里**
  const treeTop = HOUSE.min[1] + Math.max(...list.map((p) => p.heightCm));
  assert(pts.some((p) => Math.abs(p[1] - treeTop) < 0.05), `应包含树顶点 y=${treeTop}`);
  assert(pts.some((p) => Math.abs(p[1] - HOUSE.max[1]) < 0.05), '应包含楼的最高角');
  return `${pts.length} 个点`;
});

check('y9 取景按投影算，比"并包围盒"窄一截（否则楼在画里白白小一半）', () => {
  const ax = screenAxes('iso');
  const list = propPlacements(HOUSE, { preset: 'iso' });
  const spanOf = (pts) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const r = (p[0] - HOUSE.center[0]) * ax.right.x + (p[2] - HOUSE.center[2]) * ax.right.z;
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    return hi - lo;
  };
  // 旧写法的代表：把楼的盒和配角的盒（半径按高度 0.25 估）并成一个大盒子，再投四个角
  const boxPts = [];
  let minX = HOUSE.min[0]; let maxX = HOUSE.max[0];
  let minZ = HOUSE.min[2]; let maxZ = HOUSE.max[2];
  for (const p of list) {
    const r = p.heightCm * 0.25;
    minX = Math.min(minX, p.at[0] - r); maxX = Math.max(maxX, p.at[0] + r);
    minZ = Math.min(minZ, p.at[2] - r); maxZ = Math.max(maxZ, p.at[2] + r);
  }
  for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) boxPts.push([x, 0, z]);
  const tight = spanOf(propFitPoints(HOUSE, list, 'iso'));
  const loose = spanOf(boxPts);
  assert(tight < loose * 0.95, `按点算应明显更窄：points ${tight.toFixed(0)} vs 并盒 ${loose.toFixed(0)}`);
  return `${tight.toFixed(0)} vs 并盒 ${loose.toFixed(0)}`;
});

// ── 墙面色阶 ────────────────────────────────────────────────────────────

check('y10 色阶是四档查表：朝上的面最亮、两个可见立面各占一档', () => {
  const up = wallTone({ x: 0, y: 1, z: 0 });
  const px = wallTone({ x: 1, y: 0, z: 0 });
  const pz = wallTone({ x: 0, y: 0, z: 1 });
  near(up, AXO_TONES.lit, 1e-9, '朝上的面应是最亮一档');
  near(pz, AXO_TONES.side, 1e-9, '+Z 立面应是侧光档');
  near(px, AXO_TONES.back, 1e-9, '+X 立面应是背光档');
  assert(px !== pz, '两个可见立面必须能分开（这正是“色阶不够像画”要解决的）');
  return `上 ${up} / +Z ${pz} / +X ${px}`;
});

check('y11 量化真的成立：法向差 3° 还是同一档（不是连续明暗）', () => {
  const a = wallTone({ x: 0, y: 0, z: 1 });
  const b = wallTone({ x: 0.05, y: 0, z: 1 });
  assert(a === b, '轻微偏转应当同档');
  const levels = new Set([
    wallTone({ x: 0, y: 1, z: 0 }), wallTone({ x: 0, y: 0, z: 1 }),
    wallTone({ x: 1, y: 0, z: 0 }), wallTone({ x: -1, y: -0.6, z: 0 }),
  ]);
  assert(levels.size >= 3, `四档里至少出现三档，实际 ${levels.size}`);
  return `${levels.size} 档`;
});

check('y12 盒子绕 Y 转 90° 之后，+Z 面的档位换成另一面（旋转是算进去的）', () => {
  const front = axialTone({ x: 0, y: 0, z: 1 }, 0);
  const turned = axialTone({ x: 0, y: 0, z: 1 }, Math.PI / 2);
  near(front, AXO_TONES.side, 1e-9, '不转时 +Z 是侧光档');
  near(turned, AXO_TONES.back, 1e-9, '转 90° 后该面朝 +X，应是背光档');
  return `${front} → ${turned}`;
});

check('y13 调色只乘明度、不改色相；非法输入原样返回', () => {
  assert(toneColor('#ffffff', 0.5) === '#808080', `白 ×0.5 应为 #808080，实际 ${toneColor('#ffffff', 0.5)}`);
  assert(toneColor('#ffffff', 1) === '#ffffff', '×1 不应变');
  assert(toneColor('#cfc7b8', 0.74) !== '#cfc7b8', '该变暗');
  assert(toneColor('不是颜色', 0.5) === '不是颜色', '非法输入原样返回（不许抛错）');
  return toneColor('#cfc7b8', AXO_TONES.shade);
});

// ── 方位与图注 ──────────────────────────────────────────────────────────

check('y14 指北针是单位向量，且等轴测下指向画面右上（不是画死的朝上）', () => {
  for (const key of ['iso', 'dimetric', 'high']) {
    const v = northScreenVector(key);
    near(Math.hypot(v.x, v.y), 1, 1e-9, `${key} 应是单位向量`);
  }
  const iso = northScreenVector('iso');
  assert(iso.x > 0.5 && iso.y < 0, `等轴测下北应偏右上，实际 (${iso.x.toFixed(2)}, ${iso.y.toFixed(2)})`);
  const a = JSON.stringify(northScreenVector('iso'));
  const b = JSON.stringify(northScreenVector('high'));
  assert(a !== b, '换投影角针要跟着转');
  return northText('iso');
});

check('y15 方位那句人话读得懂（不含角度也能指方向）', () => {
  const text = northText('iso');
  assert(/^北在画面(正上|正下|正左|正右|左上|右上|左下|右下)（\d+°）$/.test(text), `格式不对：${text}`);
  return text;
});

check('y16 版面：图 + 图注条 = 成品高度，条在底部；关掉图注时图占满', () => {
  const plan = axoSheetPlan({ width: 3600, height: 2400 });
  assert(plan.render.height + plan.band.h === 2400, '两块相加应等于成品高');
  assert(plan.band.y === plan.render.height, '纸带应紧接在图下面');
  assert(plan.band.h / 2400 <= 0.2, `纸带别太厚（实际 ${(plan.band.h / 2400 * 100).toFixed(1)}%）`);
  const bare = axoSheetPlan({ width: 3600, height: 2400 }, { caption: false });
  assert(bare.band === null && bare.render.height === 2400, '关掉图注时图应占满整幅');
  return `条高 ${plan.band.h}px（${(AXO_SHEET.bandRatio * 100).toFixed(1)}%）`;
});

check('y17 图注字段齐全：层数 / 占地 / 投影 / 方位 / 屋顶，且没有工程术语', () => {
  const m = axoCaptionModel({
    name: '示例小屋',
    floors: 2,
    scope: '',
    sizeText: '9.2 × 6.7 m · 62.3 ㎡',
    projection: '等轴测 45°/35.26°（三轴等缩）',
    preset: 'iso',
    roofText: '坡顶',
    date: '2026-11-16',
    version: '0.5.19',
  });
  const labels = m.cells.map((c) => c.label);
  for (const want of ['层数', '占地', '投影', '方位', '屋顶']) {
    assert(labels.includes(want), `缺“${want}”这一格：${labels.join('/')}`);
  }
  assert(m.title === '示例小屋', '图名应是建筑名');
  assert(/2 层/.test(m.cells[0].value), `层数应写“2 层”，实际 ${m.cells[0].value}`);
  assert(/62\.3 ㎡/.test(m.cells[1].value), '占地原样带过来');
  assert(/1\.70 m/.test(m.note), `比例人尺码应写在说明里，实际 ${m.note}`);
  assert(/v0\.5\.19/.test(m.footer), '出处应带版本号');
  const jargon = /provenance|落库|单源|格距|回执|幂等|φ|N3a/;
  const allText = [m.title, m.subtitle, m.note, m.footer].concat(m.cells.map((c) => `${c.label}${c.value}`)).join(' ');
  assert(!jargon.test(allText), `图注里出现了工程术语：${allText}`);
  return `${m.cells.length} 格`;
});

check('y18 没墙 / 只看某一层时，图注不编数字', () => {
  const bare = axoCaptionModel({ name: '', floors: 0, sizeText: '' });
  assert(bare.title === '建筑', '没名字应回落“建筑”');
  assert(/层数不明/.test(bare.cells[0].value), `应说层数不明，实际 ${bare.cells[0].value}`);
  assert(/量不出来/.test(bare.cells[1].value), `占地应说量不出来，实际 ${bare.cells[1].value}`);
  const one = axoCaptionModel({ floors: 2, scope: '二层' });
  assert(/只看二层/.test(one.cells[0].value), `只看某层要写出来，实际 ${one.cells[0].value}`);
  return one.cells[0].value;
});

check('y19 负向探针：把 gapCm 设成负数也必须留在楼外（不许压进墙里）', () => {
  const ax = screenAxes('iso');
  const list = propPlacements(HOUSE, { preset: 'iso', gapCm: -500 });
  const halfR = (Math.abs(ax.right.x) * HOUSE.size[0] + Math.abs(ax.right.z) * HOUSE.size[2]) / 2;
  for (const p of list) {
    const dx = p.at[0] - HOUSE.center[0];
    const dz = p.at[2] - HOUSE.center[2];
    const r = dx * ax.right.x + dz * ax.right.z;
    assert(r <= -halfR, `gap 为负时被夹小了但仍在楼侧，实际 r=${r.toFixed(0)}`);
  }
  return '夹到最小间距 10cm';
});

check('y20 负向探针：没有配角时取景点只剩楼的 8 个角', () => {
  assert(propFitPoints(HOUSE, [], 'iso').length === 8, '空列表应只给楼的 8 角');
  assert(propFitPoints(HOUSE, null, 'iso').length === 8, 'null 应只给楼的 8 角');
  return '8 个点';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} axoProps 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
