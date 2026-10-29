#!/usr/bin/env node
/**
 * Node 单元测试：星系 3D 观景的数据适配层（src/renderer/src/utils/system3dScene.js）
 *
 * 为什么必须有这一层：3D 观景里「轨道半径 / 行星类别 / 卫星挂靠 / 初始相位」全是**换算**，
 * 而 WebGL 在 CDP 用例里能开、在 CI 上不一定能开 —— 换算错的时候不能再靠"截张图看看"。
 * 本用例把四条口径钉死：
 *   · 确定性：同一份节点两次构景结果逐字节一致（禁 Math.random，判据可复现）；
 *   · 轨道单调：2D 轨道半径越大 → 3D 半径越大，第一圈恒为 6；
 *   · 卫星挂对母星：`parentId` 不匹配的卫星不许跑到恒星上；
 *   · 类别映射：关键字命中顺序（「气态巨行星」不能被「巨行星」或「行星」抢走）+ 认不出时落默认池。
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
      assert(got === want, `「${node.name}」应映射为 ${want}，实得 ${got}`);
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

  check('a5 空间站：tags 记「空间站」→ kind=station 且尺寸固定', () => {
    const s = S.buildSystem3dScene({
      starName: '衡佑',
      planets: [planet('st1', '衡佑站', 75, { tags: ['空间站'] })],
      moons: [],
    });
    const b = s.bodies[0];
    assert(b.kind === 'station', `kind 应为 station，实得 ${b.kind}`);
    assert(b.size === S.SYS3D_GEOM.stationSize, `空间站尺寸应为 ${S.SYS3D_GEOM.stationSize}，实得 ${b.size}`);
    assert(s.counts.planets === 0 && s.counts.stations === 1, `counts 不对：${JSON.stringify(s.counts)}`);
    // 「有 ≥1 颗行星」判据：只有空间站时按钮该灰禁 → hasPlanets 必须为 false
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
    // 其余组件一律不许碰 three（否则首屏会把它背进去）
    for (const f of fs.readdirSync(COMPONENTS).filter((x) => x.endsWith('.vue'))) {
      if (f === 'System3DView.vue') continue;
      const src = codeOnly(fs.readFileSync(path.join(COMPONENTS, f), 'utf8'));
      assert(!/from\s+['"]three['"]/.test(src) && !/import\(['"]three['"]\)/.test(src),
        `${f} 直接引了 three（3D 只许在 System3DView 里动态加载）`);
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
