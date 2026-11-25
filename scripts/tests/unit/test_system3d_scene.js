#!/usr/bin/env node
/**
 * Node 单元测试：星系 3D 观景的数据适配层（src/renderer/src/utils/system3dScene.js）
 *
 * 为什么必须有这一层：3D 观景里“轨道半径 / 行星类别 / 卫星挂靠 / 初始相位”全是**换算**，
 * 而 WebGL 在 CDP 用例里能开、在 CI 上不一定能开 —— 换算错的时候不能再靠"截张图看看"。
 * 本用例把四条口径钉死：
 *   · 确定性：同一份节点两次构景结果逐字节一致（禁 Math.random，判据可复现）；
 *   · 轨道单调：2D 轨道半径越大 → 3D 半径越大，第一圈恒为 6；
 *   · 卫星挂对母星：`parentId` 不匹配的卫星不许跑到恒星上；
 *   · 类别映射：关键字命中顺序（“气态巨行星”不能被“巨行星”或“行星”抢走）+ 认不出时落默认池。
 *
 * 另外守两条**源码闸门**（实现搬家/退化时先红）：
 *   · 3D 组件必须走 `defineAsyncComponent(() => import('./System3DView.vue'))`；
 *   · 模板标签必须 PascalCase（`<System3DView>`）—— 本轮真实踩过：`<system-3d-view>`
 *     会被 camelize 成 `System3dView`（小写 d），与绑定名对不上 → 动态 import 被摇掉，
 *     构建产物里连 three chunk 都不生成（首屏反而"看起来"很干净，实际功能整块消失）。
 *
 * 用法：node scripts/tests/unit/test_system3d_scene.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const COMPONENTS = path.join(ROOT, 'src', 'renderer', 'src', 'components');

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

/** 剥注释：判据不许被注释里的示例骗过（本仓既定口径；HTML 注释也要剥，模板里解释了 kebab 坑） */
function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 造一个"行星布局"节点（字段对齐 SystemDetailView.planetLayouts 的展开副本） */
function planet(id, name, px, extra) {
  return {
    id,
    name,
    displayName: name,
    layer: 'planet',
    orbitRadius: px,
    tags: [],
    ...(extra || {}),
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-system3d-'));
  for (const f of ['planetArt.js', 'system3dScene.js']) {
    fs.copyFileSync(path.join(UTILS, f), path.join(tmp, f));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const S = await import(pathToFileURL(path.join(tmp, 'system3dScene.js')).href);
  const P = await import(pathToFileURL(path.join(tmp, 'planetArt.js')).href);

  const baseInput = () => ({
    starName: '衡佑',
    starTint: '#ffd2a1',
    planets: [
      planet('p1', '衡佑Ⅰ', 75),
      planet('p2', '衡佑Ⅱ', 110, { tags: ['气态巨行星'] }),
      planet('p3', '衡佑Ⅲ', 145, { tags: ['海洋', '可居住'] }),
    ],
    moons: [
      { id: 'm1', name: '衡佑Ⅲa', layer: 'moon', parentId: 'p3' },
      { id: 'm2', name: '衡佑Ⅲb', layer: 'moon', parentId: 'p3' },
      { id: 'm3', name: '孤儿卫星', layer: 'moon', parentId: 'nope' },
    ],
  });

  check('a1 确定性：同一份节点构景两次逐字节一致（禁 Math.random）', () => {
    const a = S.buildSystem3dScene(baseInput());
    const b = S.buildSystem3dScene(baseInput());
    assert(JSON.stringify(a) === JSON.stringify(b), '两次构景结果不同 → 某处用了随机/时间');
    assert(a.bodies[0].phase !== a.bodies[1].phase, '不同行星的初始相位不该相同（散列失效）');
    return 'ok';
  });

  check('a2 轨道单调：2D 半径越大 → 3D 越大；第一圈 = orbitBase', () => {
    const g = S.SYS3D_GEOM;
    assert(S.orbitRadius3d(75) === g.orbitBase, `第一圈应为 ${g.orbitBase}，实得 ${S.orbitRadius3d(75)}`);
    let prev = -1;
    for (const px of [75, 110, 145, 180, 215]) {
      const r = S.orbitRadius3d(px);
      assert(r > prev, `轨道半径不单调：${px}px → ${r}`);
      prev = r;
    }
    // 负数/NaN 不许炸出 NaN（真实数据里手动拖过的行星可能缺字段）
    assert(Number.isFinite(S.orbitRadius3d(NaN)) && Number.isFinite(S.orbitRadius3d(-5)), '异常输入必须回落到基准值');
    return 'ok';
  });

  check('a2b 3D 里每颗行星独占一圈（用户 11-25：两颗星球同一条轨道不合理）', () => {
    const g = S.SYS3D_GEOM;
    const sc = S.buildSystem3dScene(baseInput());
    const orbits = sc.bodies.filter((b) => b.kind === 'planet').map((b) => b.orbit);
    // 🔴 核心判据：任意两颗行星的轨道半径**必须不同**
    for (let i = 0; i < orbits.length; i++) {
      for (let j = i + 1; j < orbits.length; j++) {
        assert(Math.abs(orbits[i] - orbits[j]) > 1e-6,
          `第 ${i} 与第 ${j} 颗行星共用轨道 ${orbits[i]} —— 3D 里这是错的（2D 的每圈 3 颗设计不能带进来）`);
      }
    }
    // 而且必须是从 orbitBase 起、按 orbitStep 等差的（一圈一颗、不漏圈）
    const sorted = orbits.slice().sort((x, y) => x - y);
    for (let i = 0; i < sorted.length; i++) {
      const want = g.orbitBase + i * g.orbitStep;
      assert(Math.abs(sorted[i] - want) < 1e-6,
        `第 ${i} 圈应为 ${want}，实得 ${sorted[i]}（轨道不应有空洞）`);
    }
    // 反向探针：如果谁把实现换回"按 2D orbitRadius 算"，这条必红 —— 因为 2D 里前 3 颗共享一圈
    return `${orbits.length} 颗行星 / ${sorted.length} 条独立轨道（${sorted.map((x) => x.toFixed(1)).join(', ')}）`;
  });

  check('a3 卫星挂对母星：parentId 不匹配的不许出现（更不许跑到恒星上）', () => {
    const s = S.buildSystem3dScene(baseInput());
    const p3 = s.bodies.find((b) => b.id === 'p3');
    assert(p3, '找不到 p3');
    assert(p3.moons.length === 2, `p3 应有 2 颗卫星，实得 ${p3.moons.length}`);
    const names = p3.moons.map((m) => m.name).sort();
    assert(names.join(',') === '衡佑Ⅲa,衡佑Ⅲb', `卫星名字不对：${names}`);
    assert(s.bodies.every((b) => b.id !== 'm3'), '孤儿卫星被当成天体了');
    assert(s.counts.moons === 2, `counts.moons 应为 2，实得 ${s.counts.moons}`);
    // 卫星轨道必须比母星本体大（否则埋在球里看不见）
    assert(p3.moons[0].orbit > p3.size, `卫星轨道 ${p3.moons[0].orbit} 小于母星半径 ${p3.size}`);
    return 'ok';
  });

  check('a4 类别映射：关键字命中顺序 + 认不出落默认池 + 卫星兜底', () => {
    const cases = [
      [{ name: '某气态巨行星', tags: ['气态'] }, 'gasGiant'],
      [{ name: '某冰巨行星', tags: [] }, 'iceGiant'],
      [{ name: '冰封星', tags: [] }, 'frozen'],
      [{ name: '沙漠星', tags: [] }, 'desert'],
      [{ name: '海洋星', tags: [] }, 'ocean'],
      [{ name: '熔岩星', tags: [] }, 'molten'],
      [{ name: '都市星', tags: [] }, 'city'],
      [{ name: '机械星', tags: [] }, 'machine'],
      [{ name: '荒芜星', tags: [] }, 'barren'],
    ];
    for (const [node, want] of cases) {
      const got = S.planetClassForNode({ id: `x:${node.name}`, layer: 'planet', tags: [], ...node });
      assert(got === want, `“${node.name}”应映射为 ${want}，实得 ${got}`);
    }
    // 认不出 → 落在默认池里（不能返回 undefined / 越界）
    const pool = ['continental', 'ocean', 'tropical', 'savanna', 'arid', 'desert', 'tundra', 'arctic', 'alpine', 'gaia'];
    for (const id of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']) {
      const got = S.planetClassForNode({ id, name: '未名', layer: 'planet', tags: [] });
      assert(pool.includes(got), `默认类别 ${got} 不在默认池里`);
      assert(P.isPlanetClassId(got), `默认类别 ${got} 不是合法 classId`);
    }
    // 卫星没有类型信息 → 荒芜/冰封二选一（且确定性）
    const moonA = S.planetClassForNode({ id: 'm-a', layer: 'moon' }, { fallbackLayer: 'moon' });
    const moonB = S.planetClassForNode({ id: 'm-a', layer: 'moon' }, { fallbackLayer: 'moon' });
    assert(moonA === moonB && ['barren', 'frozen'].includes(moonA), `卫星兜底类别异常：${moonA}`);
    return 'ok';
  });

  check('a4b E2 显式类型优先：node.planetClass 压过 tags/名称推断；非法值不被采信', () => {
    // 名称明明像气态巨行星，但用户显式选了"海洋" → 以显式为准
    const explicit = S.planetClassForNode({
      id: 'p-a', layer: 'planet', name: '某气态巨行星', tags: ['气态'], planetClass: 'ocean',
    });
    assert(explicit === 'ocean', `显式 planetClass 应优先，实得 ${explicit}`);
    // 显式值与推断一致时结果不变（不引入新的非法分支）
    const same = S.planetClassForNode({ id: 'p-b', layer: 'planet', name: '海洋星', planetClass: 'ocean' });
    assert(same === 'ocean', '显式/推断一致时应同为 ocean');
    // 脏值（拼错/老数据）→ 回落推断，绝不让非法 classId 进渲染
    for (const bad of ['NotAClass', '', null, 42, undefined]) {
      const got = S.planetClassForNode({ id: 'p-c', layer: 'planet', name: '海洋星', planetClass: bad });
      assert(got === 'ocean', `脏值 ${JSON.stringify(bad)} 应回落推断，实得 ${got}`);
    }
    // 进构景后 classId 也跟着变（贴图/环按它走）
    const spec = S.buildSystem3dScene({
      starName: '衡佑',
      planets: [planet('p-d', '某气态巨行星', 75, { planetClass: 'arctic' })],
      moons: [],
    });
    assert(spec.bodies[0].classId === 'arctic', `构景 classId 应为 arctic，实得 ${spec.bodies[0].classId}`);
    return 'ok';
  });

  check('a10 E5 自动降档：>30ms 降一档、最低档就停、只降不升', () => {
    const q = (lv, ms) => S.nextQualityLevel(lv, ms);
    assert(q('high', 12) === 'high', '流畅时不降');
    assert(q('high', 41) === 'mid', '掉帧降一档');
    assert(q('mid', 41) === 'low', '再掉降到底');
    assert(q('low', 90) === 'low', '最低档不再降');
    assert(q('mid', 20) === 'mid', '只降不升（临界点来回抖会看到分辨率自己跳）');
    assert(q('high', NaN) === 'high', '脏帧耗不降档');
    assert(S.SYS3D_QUALITY.low.pixelRatioCap < S.SYS3D_QUALITY.high.pixelRatioCap, '低档像素比必须更小');
    assert(S.SYS3D_QUALITY.low.belt === false, '最低档应关掉小行星带');
    return 'ok';
  });

  check('a11 E3 双星：伴星进 spec（有色/轨道/相位/自转），最多 2 颗，缺色回落', () => {
    const one = S.buildSystem3dScene({
      starName: 'A', planets: [planet('p1', '一', 75)], moons: [],
      companions: [{ id: 'b1', name: '伴星甲', tint: '#88aaff' }],
    });
    assert(Array.isArray(one.companions) && one.companions.length === 1, `伴星数不对：${JSON.stringify(one.companions)}`);
    const c = one.companions[0];
    assert(c.tint === '#88aaff', `伴星色应透传，实得 ${c.tint}`);
    assert(c.orbit > one.star.radius, '伴星轨道必须在主星外面（否则被吞进恒星里）');
    assert(c.radius < one.star.radius, '伴星必须比主星小（大小关系反了会看成"两颗主星"）');
    assert(Number.isFinite(c.phase) && c.speed > 0, '伴星相位/角速度必须是有限数');
    // 缺色 / 非法色 → 回落（绝不把 undefined 塞进 Color()）
    const dirty = S.buildSystem3dScene({
      starName: 'A', planets: [], moons: [],
      companions: [{ id: 'b2', name: '伴星乙' }, { id: 'b3', tint: 'red' }, { id: 'b4' }],
    });
    assert(dirty.companions.every((x) => typeof x.tint === 'string' && x.tint[0] === '#'), '脏色没回落');
    assert(dirty.companions.length === 2, `伴星上限应为 2，实得 ${dirty.companions.length}`);
    // 单星系（无 companions）→ 空数组，不抛错
    assert(S.buildSystem3dScene({ starName: 'A', planets: [] }).companions.length === 0, '无伴星时应为空数组');
    return 'ok';
  });

  check('a5 空间站：tags 记“空间站”→ kind=station 且尺寸固定', () => {
    const s = S.buildSystem3dScene({
      starName: '衡佑',
      planets: [planet('st1', '衡佑站', 75, { tags: ['空间站'] })],
      moons: [],
    });
    const b = s.bodies[0];
    assert(b.kind === 'station', `kind 应为 station，实得 ${b.kind}`);
    assert(b.size === S.SYS3D_GEOM.stationSize, `空间站尺寸应为 ${S.SYS3D_GEOM.stationSize}，实得 ${b.size}`);
    assert(s.counts.planets === 0 && s.counts.stations === 1, `counts 不对：${JSON.stringify(s.counts)}`);
    // “有 ≥1 颗行星”判据：只有空间站时按钮该灰禁 → hasPlanets 必须为 false
    assert(s.hasPlanets === false, '只有空间站时 hasPlanets 应为 false（按钮判据）');
    return 'ok';
  });

  check('a6 空系：hasPlanets=false、maxOrbit 兜底、不抛错', () => {
    const s = S.buildSystem3dScene({ starName: '空系' });
    assert(Array.isArray(s.bodies) && s.bodies.length === 0, 'bodies 应为空数组');
    assert(s.hasPlanets === false, 'hasPlanets 应为 false');
    assert(Number.isFinite(s.maxOrbit) && s.maxOrbit > 0, `maxOrbit 兜底异常：${s.maxOrbit}`);
    assert(s.star.radius > 0 && s.star.tint[0] === '#', '恒星缺省值异常');
    return 'ok';
  });

  check('a7 天体上限：超过 maxBodies 截断（防用户拖出上百颗时 3D 卡死）', () => {
    const planets = Array.from({ length: S.SYS3D_GEOM.maxBodies + 40 }, (_, i) => planet(`p${i}`, `P${i}`, 75 + (i % 6) * 35));
    const s = S.buildSystem3dScene({ starName: '多', planets });
    assert(s.bodies.length === S.SYS3D_GEOM.maxBodies, `应截断到 ${S.SYS3D_GEOM.maxBodies}，实得 ${s.bodies.length}`);
    return 'ok';
  });

  check('a8 sizeOverride（A2）：按 2D 半径倍数缩放，不再吃散列抖动', () => {
    const s = S.buildSystem3dScene({
      starName: '衡佑',
      planets: [planet('big', '巨星', 75, { sizeOverride: 14 })],
    });
    assert(Math.abs(s.bodies[0].size - S.SYS3D_GEOM.planetBaseSize * 2) < 1e-9,
      `sizeOverride=14（2×基准 7）应得 2×尺寸，实得 ${s.bodies[0].size}`);
    return 'ok';
  });

  check('a9 美术库：18 类且 id/label 唯一，纹理绘制不依赖 DOM 顶层', () => {
    assert(P.PLANET_CLASSES.length === 18, `类别数应为 18，实得 ${P.PLANET_CLASSES.length}`);
    assert(new Set(P.PLANET_CLASSES.map((c) => c.id)).size === 18, 'classId 有重复');
    assert(new Set(P.PLANET_CLASSES.map((c) => c.label)).size === 18, 'label 有重复');
    assert(P.getPlanetTexture, '缺 getPlanetTexture');
    assert(P.planetClassLabel('gasGiant') === '气态巨行星', 'label 查表异常');
    assert(P.planetClassLabel('不存在') === '大陆星球', '非法 classId 应回落首项');
    assert(P.hasRing('gasGiant') && !P.hasRing('continental'), '环判定异常');
    const rgba = P.hexAlpha('#ff0000', 0.5);
    assert(rgba === 'rgba(255,0,0,0.5)', `hexAlpha 异常：${rgba}`);
    assert(P.hashString('abc') === P.hashString('abc'), 'hashString 不确定');
    return 'ok';
  });

  check('b1 源码闸门：3D 组件必须 defineAsyncComponent + PascalCase 标签', () => {
    const sdv = codeOnly(read('src/renderer/src/components/SystemDetailView.vue'));
    assert(sdv.includes("defineAsyncComponent(() => import('./System3DView.vue'))"),
      '缺 defineAsyncComponent(() => import(\'./System3DView.vue\'))');
    assert(/<System3DView\s+v-if="show3d"/.test(sdv),
      '模板里找不到 <System3DView v-if="show3d">（kebab 写法会 camelize 成 System3dView，组件解析不到）');
    assert(!/<system-3d-view/i.test(sdv), '模板里还有 kebab 写法 <system-3d-view>（会解析不到组件）');
    assert(sdv.includes('show3d.value = false'), '换系时应关闭 3D（watch system.id）');
    return 'ok';
  });

  check('b2 源码闸门：three 只许动态 import，且必须在组件挂载后才加载', () => {
    const three = codeOnly(read('src/renderer/src/components/System3DView.vue'));
    assert(three.includes("await import('three')"), 'System3DView 缺 await import(\'three\')');
    assert(!/from\s+['"]three['"]/.test(three), 'System3DView 里不许有静态 import three');

    // 这条闸门守的是**“three 不进首屏”**，不是"只有星系 3D 能用 three"。
    // 2026-11-14 加建筑外观时按目的重写了判据：要么不碰 three，要么进白名单且同时满足
    // ① 只有动态 import（没有 `from 'three'`）；② 有完整的释放纪律。
    // 白名单每加一个，就得在下面把纪律也断言一遍 —— 不是把文件名列进来就完事。
    const THREE_LAZY = ['ExteriorView.vue'];
    const DISCIPLINE = [
      'renderer.dispose()', 'forceContextLoss()', 'onBeforeUnmount(',
      "document.addEventListener('visibilitychange'",
    ];
    for (const f of fs.readdirSync(COMPONENTS).filter((x) => x.endsWith('.vue'))) {
      if (f === 'System3DView.vue') continue;
      const src = codeOnly(fs.readFileSync(path.join(COMPONENTS, f), 'utf8'));
      assert(!/from\s+['"]three['"]/.test(src), `${f} 静态 import 了 three（首屏会被背进去）`);
      const lazy = /import\(['"]three['"]\)/.test(src);
      if (!lazy) continue;
      assert(THREE_LAZY.includes(f), `${f} 动态引了 three 但不在白名单里（3D 只许在已登记的组件里动态加载）`);
      for (const needle of DISCIPLINE) {
        assert(src.includes(needle), `${f} 用了 three 但缺资源纪律：${needle}`);
      }
      // 必须在 mounted 里加载，不许模块顶层就 await（顶层会在 chunk 求值时立刻拉 three）
      assert(src.includes('onMounted('), `${f} 用了 three 但没在 onMounted 里初始化`);
    }

    // 🔴 非组件模块（interior/*.js）也要守同一条底线（2026-11-16 聚落鸟瞰加的）：
    // 一次性出图不套组件的 rAF/可见性纪律，所以判据换成“攒资源的那一层必须真的释放”。
    const INTERIOR = path.join(ROOT, 'src/renderer/src/interior');
    const THREE_LAZY_MODULES = ['settlementExport.js'];
    for (const f of fs.readdirSync(INTERIOR).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(INTERIOR, f), 'utf8');
      assert(!/from\s+['"]three['"]/.test(src), `interior/${f} 静态 import 了 three（首屏会被背进去）`);
      if (!/import\(['"]three['"]\)/.test(src)) continue;
      assert(THREE_LAZY_MODULES.includes(f), `interior/${f} 动态引了 three 但不在白名单里`);
      // 它自己不持有 renderer，释放必须在它调用的渲染层里（axoScene 的 dispose()/forceContextLoss）
      assert(/renderSettlementSheet|renderAxoSheet|renderAxoToDataUrl/.test(src), `interior/${f} 用了 three 但没走统一的出图入口`);
      const scene = fs.readFileSync(path.join(INTERIOR, 'axoScene.js'), 'utf8');
      assert(scene.includes('forceContextLoss()') && scene.includes('.dispose()'), 'axoScene 缺释放纪律');
    }
    return 'ok';
  });

  check('b3 源码闸门：资源纪律（dispose / forceContextLoss / 卸载与可见性暂停）', () => {
    const three = codeOnly(read('src/renderer/src/components/System3DView.vue'));
    for (const needle of [
      'renderer.dispose()',
      'forceContextLoss()',
      'cancelAnimationFrame(rafId)',
      "document.addEventListener('visibilitychange', onVisibility)",
      'onBeforeUnmount(',
      'controls?.dispose()',
      'disposeAll()',
    ]) {
      assert(three.includes(needle), `System3DView 缺资源纪律：${needle}`);
    }
    assert(three.includes("e.code === 'Escape'") && three.includes("e.code === 'KeyP'"), '缺 Esc/P 键位');
    // E5（2026-10-29）：自动降档必须接在渲染循环里（判据在 nextQualityLevel，接线在这里）
    assert(three.includes('nextQualityLevel(') && three.includes('applyQuality('), '缺自动降档接线');
    assert(three.includes('setPixelRatio('), '降档必须真的改像素比（否则只是改了个变量）');
    // E6：项目关闭时释放 3D 纹理缓存（常驻是收益，但要有个释放点）
    const ps = read('src/renderer/src/store/projectStore.js');
    assert(ps.includes('__clearTextureCache'), 'projectStore.closeProject 没释放 3D 纹理缓存');
    return 'ok';
  });

  check('a12 大气：18 类都有（不许有"没有大气"的行星），死星系明显更薄', () => {
    let minS = Infinity;
    let maxS = -Infinity;
    for (const c of P.PLANET_CLASSES) {
      const a = P.atmosphereForClass(c.id);
      assert(/^#[0-9a-fA-F]{6}$/.test(a.color), `${c.id} 的大气色不是 #rrggbb：${a.color}`);
      assert(a.strength > 0,
        `${c.id} 的大气强度为 0 —— 用户说的"很多行星根本没有大气"就是这种（每颗行星都必须有一圈）`);
      assert(a.strength >= 0.2 && a.strength <= 1.2, `${c.id} 强度越界：${a.strength}`);
      minS = Math.min(minS, a.strength);
      maxS = Math.max(maxS, a.strength);
    }
    // 死星系（荒芜/冰封/熔岩）必须**明显薄**于宜居类：不是所有行星裹同一层，
    // 否则"荒芜星球"会顶着一圈盖亚级的柔光（那一眼就假）。
    const living = P.atmosphereForClass('continental').strength;
    for (const dead of ['barren', 'frozen', 'molten']) {
      const s = P.atmosphereForClass(dead).strength;
      assert(s < living * 0.8, `${dead} 的大气 ${s} 太厚（应 < 宜居类的 ${living} × 0.8）`);
    }
    // 脏值回落（绝不许把 undefined 塞进 THREE.Color）
    const bad = P.atmosphereForClass('不存在');
    assert(/^#[0-9a-fA-F]{6}$/.test(bad.color) && bad.strength > 0, `非法 classId 没回落：${JSON.stringify(bad)}`);
    // 确定性：同一类别两次必须一模一样（截图判据可复现）
    assert(JSON.stringify(P.atmosphereForClass('ocean')) === JSON.stringify(P.atmosphereForClass('ocean')),
      '大气参数不确定（某处用了随机/时间）');
    return `${P.PLANET_CLASSES.length} 类 / 强度 ${minS}~${maxS}`;
  });

  check('a13 构景带大气：每颗行星都有 atmo，空间站没有，且与类别表同源', () => {
    const sc = S.buildSystem3dScene({
      starName: '衡佑',
      planets: [
        planet('p1', '衡佑Ⅰ', 75),
        planet('p2', '衡佑Ⅱ', 110, { tags: ['气态巨行星'] }),
        planet('st', '衡佑站', 145, { tags: ['空间站'] }),
      ],
      moons: [],
    });
    const planets = sc.bodies.filter((b) => b.kind === 'planet');
    assert(planets.length === 2, `应有 2 颗行星，实得 ${planets.length}`);
    for (const b of planets) {
      assert(b.atmo && typeof b.atmo === 'object', `${b.id} 没有 atmo —— 3D 里就是一颗硬边球`);
      assert(/^#[0-9a-fA-F]{6}$/.test(b.atmo.color) && b.atmo.strength > 0, `${b.id} 的 atmo 不合法`);
      const want = P.atmosphereForClass(b.classId);
      assert(b.atmo.color === want.color && b.atmo.strength === want.strength,
        `${b.id} 的 atmo 与类别表不一致（两套口径会漂移）`);
    }
    const st = sc.bodies.find((b) => b.id === 'st');
    assert(st && st.atmo === null, '空间站不该有大气（金属壳套光晕会看成小行星）');
    return `${planets.length} 颗行星都有大气`;
  });

  check('b4 源码闸门：大气壳层挂在**每颗**行星上，不是"有大气的几类才画"', () => {
    const src = codeOnly(read('src/renderer/src/components/System3DView.vue'));
    assert(/let atmoMat = null;\s*if \(body\.atmo\)/.test(src),
      '找不到"若 body.atmo 就建壳层"的结构（没有这个，行星又会退回硬边球）');
    assert(/makeAtmosphereMaterial\(\s*body\.atmo\.color,\s*body\.atmo\.strength\b/.test(src),
      '壳层没有用 spec 里的 atmo（颜色/浓淡必须来自构景层，组件不许自己再判一遍类别）');
    assert(!/classId\s*===\s*'(terra|bands|dead)'/.test(src),
      '组件里不许再按类别挑大气 —— 浓淡只有 planetArt 那张表一套口径');
    assert(src.includes('stats.atmospheres = atmoMats.length'), '缺 atmospheres 计数（真机判据读它）');
    assert(src.includes('setAtmosphereScale('), '缺反向探针入口 setAtmosphereScale（关掉必红要用）');
    return 'ok';
  });

  check('a14 卫星也有大气（薄一档）+ 有云类别/无云类别分得开', () => {
    const sc = S.buildSystem3dScene(baseInput());
    const p3 = sc.bodies.find((b) => b.id === 'p3');
    assert(p3 && p3.moons.length === 2, '缺卫星样本');
    for (const m of p3.moons) {
      assert(m.atmo && typeof m.atmo === 'object', `${m.id} 没有大气 —— 3D 里还是一颗灰球`);
      assert(/^#[0-9a-fA-F]{6}$/.test(m.atmo.color), `${m.id} 大气色不合法`);
      assert(m.atmo.strength > 0, `${m.id} 卫星大气强度为 0`);
      // 薄一档：必须真的比同类行星薄，而且下限还得看得见
      const planetSame = P.atmosphereForClass(m.classId);
      assert(m.atmo.strength < planetSame.strength,
        `${m.id} 的大气（${m.atmo.strength}）不比同类行星（${planetSame.strength}）薄`);
      assert(Math.abs(m.atmo.strength - planetSame.strength * S.SYS3D_GEOM.moonAtmoScale) < 1e-9,
        `${m.id} 的大气没有走 moonAtmoScale（两套口径会漂移）`);
    }
    // 云：terra 且 clouds>0 才有；气巨/死星系没有（气巨的云是条带，不叠第二层）
    assert(P.hasClouds('ocean') === true, '海洋星球应该有云层');
    assert(P.hasClouds('gaia') === true, '盖亚星球应该有云层');
    assert(P.hasClouds('barren') === false, '荒芜星球不该有云层');
    assert(P.hasClouds('machine') === false, '机械星球不该有云层');
    assert(P.hasClouds('gasGiant') === false, '气态巨行星不该叠第二层云');
    assert(typeof P.getCloudTexture === 'function', '缺 getCloudTexture');
    return `${p3.moons.length} 颗卫星都有大气（×${S.SYS3D_GEOM.moonAtmoScale}）`;
  });

  check('a15 贴图分辨率：512×256 且构图按同一套系数缩放（不是"换了张图"）', () => {
    // 纹理本身要在浏览器里画（document.createElement），Node 里拿不到 —— 这里守**口径**：
    // ① 宽高常数是 512×256；② 所有特征尺寸都乘了同一个缩放系数 S；③ 圆盘取样按贴图高度取一半。
    const src = read('src/renderer/src/utils/planetArt.js');
    assert(/const W = 512;\s*\n\s*const H = 256;/.test(src), '地表贴图不是 512×256');
    assert(/const S = W \/ 256;/.test(src), '缺少与旧 256 版对齐的缩放系数 S');
    for (const needle of ['rng.range(6, 30) * S', 'rng.range(4, 16) * S', '(1 + rng.next() * 1.5) * S',
      'const step = 16 * S', '1.2 * S']) {
      assert(src.includes(needle), `特征尺寸没跟着缩放：缺 ${needle}`);
    }
    assert(src.includes('tex.height / 2'), '2D 圆盘的赤道取样带没跟着贴图高度走（会取到极区）');
    return 'ok';
  });

  check('b5 源码闸门：卫星不许再是纯色灰球，云层要真的叠上去且自己转', () => {
    const src = codeOnly(read('src/renderer/src/components/System3DView.vue'));
    assert(src.includes('getPlanetTexture(moon.classId)'), '卫星没有用地表贴图（还是一颗纯色灰球）');
    assert(!/new THREE\.MeshLambertMaterial\(\{ color: 0xb8b4ac \}\)/.test(src),
      '还留着"卫星 = 灰球"的老写法');
    assert(src.includes("body.kind === 'planet' ? getCloudTexture(body.classId) : null"),
      '云层没接（或没排除空间站）');
    assert(src.includes('o.clouds.rotation.y +='), '云层没有自转（云跟地形一起死转就没意义了）');
    assert(src.includes('moonAtmoMats'), '缺卫星大气的计数（判据 A2 读它）');
    return 'ok';
  });

  check('a16 卫星自转 + 气巨有环（第三轮）', () => {
    const sc = S.buildSystem3dScene(baseInput());
    const p3 = sc.bodies.find((b) => b.id === 'p3');
    for (const m of p3.moons) {
      assert(Number.isFinite(m.spin) && m.spin > 0, `${m.id} 没有自转（近景会是颗不动的球）`);
    }
    // 自转必须确定性
    const again = S.buildSystem3dScene(baseInput());
    assert(JSON.stringify(again.bodies.find((b) => b.id === 'p3').moons)
      === JSON.stringify(p3.moons), '卫星自转不确定（某处用了随机）');
    // 环：气巨/冰巨才有；同类的行星没有
    assert(sc.bodies.find((b) => b.id === 'p2').ring === true, '气态巨行星应该有环');
    assert(sc.bodies.find((b) => b.id === 'p1').ring === false, `${sc.bodies.find((b) => b.id === 'p1').classId} 不该有环`);
    const icy = S.buildSystem3dScene({
      starName: 'A', planets: [planet('i1', '某冰巨行星', 75)], moons: [],
    });
    assert(icy.bodies[0].ring === true, '冰封巨行星也应该有环');
    return `${p3.moons.length} 颗卫星有自转 / 气巨有环`;
  });

  check('b6 源码闸门：环贴图必须是径向同心带（平面 UV 下竖条渐变是错的）', () => {
    const src = codeOnly(read('src/renderer/src/components/System3DView.vue'));
    assert(/function makeRingTexture\(\)[\s\S]{0,1500}?g\.arc\(half, half, r0/.test(src),
      '环贴图不是同心圆画的（RingGeometry 是平面 UV，竖条渐变贴上去是一道横向明暗）');
    assert(src.includes('ringTilt.rotation.z = body.tilt'),
      '环没有跟着行星自转轴倾角（倾角大的行星会"环斜穿球"）');
    assert(src.includes('mp.mesh.rotation.y += mp.spin * dt'), '卫星没有自转接线');
    return 'ok';
  });

  check('b7 源码闸门：有环的行星必须有环投下的暗带（挂在行星本体上，随自转/倾角）', () => {
    const src = codeOnly(read('src/renderer/src/components/System3DView.vue'));
    assert(src.includes('function makeRingShadowMaterial('), '缺环投影暗带的材质');
    assert(src.includes('mesh.add(shadow)'), '暗带没挂在行星本体上（挂 holder 的话不跟着自转/倾角）');
    assert(src.includes('vLocalPos.y / uRadius'), '暗带没用"到环面的距离"（局部 y）算，投影方向会错');
    assert(src.includes('stats.ringShadows = ringShadowCount'), '缺 ringShadows 计数（判据 A5 读它）');
    return 'ok';
  });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n=== ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ 用例异常：', e);
  process.exit(1);
});
