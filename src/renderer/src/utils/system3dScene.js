/**
 * 星系 3D 观景的数据适配层（纯函数，无 DOM / 无 three 依赖）
 *
 * 为什么单独一层：`SystemDetailView` 里已有 2D 布局（`planetLayouts`，含 orbitRadius / 卫星挂靠），
 * 3D 只需要**同一份世界观数据换一种表达**（轨道半径 → 3D 距离、节点 → 行星类别）。
 * 把换算放这里，就能在 Node 单测里钉死「确定性 / 轨道单调 / 卫星挂对母星」，不必起 WebGL。
 *
 * 确定性纪律：不允许 Math.random。所有"看名字看不出来"的观感参数（类别、大小抖动、初始相位、
 * 自转轴倾角）一律由 `hashString(node.id || node.name)` 推导 —— 同一项目每次打开长得一模一样。
 */

import { PLANET_CLASSES, hashString, isPlanetClassId } from './planetArt.js';

// ===== 尺寸口径（与 SP-1025 一致的低模观感；单位是场景单位，不是像素） =====
export const SYS3D_GEOM = {
  // 恒星与第一圈轨道的比例（观感口径）：恒星直径约等于内圈轨道的 1/4。
  // 曾经取 3.0/6.0，截图里恒星像把内行星吞了（build/visual-audit/system3d/02-3d.png 的第一版），
  // 现在 1.9/7.6 —— 恒星仍然压得住画面，行星看得出是"绕着走"。
  starRadius: 1.9,
  /** 第一圈轨道（2D 公式位 75px 处）对应的 3D 半径 */
  orbitBase: 7.6,
  /** 2D 每多一圈（+35px）在 3D 里加多少 */
  orbitStep: 3.3,
  /** 2D 轨道半径基准（systemOrbit.planetOrbitLayout: 40 + orbit*35，第一圈 = 75） */
  orbitRef2d: 75,
  orbitRef2dStep: 35,
  /** 行星半径基准（2D getPlanetRadius('planet') = 7） */
  planetRefRadius2d: 7,
  planetBaseSize: 1.15,
  stationSize: 0.55,
  moonSize: 0.2,
  maxBodies: 64,
};

/** 类别关键字表：按顺序匹配，先命中先赢（"气态巨行星"必须排在"巨行星"之前） */
const CLASS_KEYWORDS = [
  [['气态', '气巨', 'gas'], 'gasGiant'],
  [['冰巨', '冰封巨'], 'iceGiant'],
  [['熔岩', '岩浆', '火'], 'molten'],
  [['冰封', '冻', '寒'], 'frozen'],
  [['沙漠', '沙'], 'desert'],
  [['海洋', '洋', '水世界'], 'ocean'],
  [['剧毒', '毒'], 'toxic'],
  [['荒芜', '荒'], 'barren'],
  [['草原'], 'savanna'],
  [['丛林', '热带'], 'tropical'],
  [['高山', '山'], 'alpine'],
  [['苔原'], 'tundra'],
  [['盖亚', '花园'], 'gaia'],
  [['都市', '城市', 'ecumenopolis'], 'city'],
  [['机械', '铸造'], 'machine'],
  [['干旱'], 'arid'],
  [['极地', '北极'], 'arctic'],
  [['大陆'], 'continental'],
];

/** 认不出类别时的默认池（确定性散列取一款，避免整系一片同款绿球） */
const TERRA_POOL = ['continental', 'ocean', 'tropical', 'savanna', 'arid', 'desert', 'tundra', 'arctic', 'alpine', 'gaia'];

function nodeText(node) {
  const tags = Array.isArray(node?.tags) ? node.tags.join(' ') : '';
  return [node?.name, node?.displayName, tags].filter(Boolean).join(' ');
}

/** 是否为"空间站"（司天用 tags 第二项记类型；layer 仍是 planet） */
export function isStationNode(node) {
  if (!node) return false;
  if (node.layer === 'station') return true;
  return Array.isArray(node.tags) && node.tags.includes('空间站');
}

/**
 * 节点 → 行星类别 id。
 * 司天没有群星那套 `class` 字段，只能按 layer / tags / 名称关键字映射；认不出就按 id 散列取一款默认。
 * @param {object} node
 * @param {{ fallbackLayer?: 'planet'|'moon' }} [opts]
 */
export function planetClassForNode(node, opts = {}) {
  const text = nodeText(node);
  for (const [words, classId] of CLASS_KEYWORDS) {
    if (words.some((w) => text.includes(w))) return classId;
  }
  if (isStationNode(node)) return 'machine';
  if (node?.layer === 'moon' || opts.fallbackLayer === 'moon') {
    // 卫星没有类型信息时按"荒芜/冰封"二选一（都是卫星的常见样子）
    return hashString(node?.id || node?.name || '') % 2 === 0 ? 'barren' : 'frozen';
  }
  const pool = TERRA_POOL;
  return pool[hashString(node?.id || node?.name || '') % pool.length];
}

/** 0~1 的确定性伪随机（同一 key 恒定） */
function unit(key) {
  return (hashString(key) % 10000) / 10000;
}

/** 2D 轨道半径 → 3D 轨道半径（单调递增，第一圈 6，之后每圈 +3.1） */
export function orbitRadius3d(orbitRadius2d) {
  const r = Number.isFinite(orbitRadius2d) ? orbitRadius2d : SYS3D_GEOM.orbitRef2d;
  const rings = (r - SYS3D_GEOM.orbitRef2d) / SYS3D_GEOM.orbitRef2dStep;
  return SYS3D_GEOM.orbitBase + Math.max(0, rings) * SYS3D_GEOM.orbitStep;
}

/**
 * 构建 3D 场景描述。
 * @param {object} input
 * @param {string} [input.starName]
 * @param {string} [input.starTint] 恒星色（#rrggbb，来自 getStarColor(type).mid）
 * @param {Array<object>} [input.planets] 行星布局（需含 id/name/orbitRadius，可含 tags/sizeOverride）
 * @param {Array<object>} [input.moons] 卫星节点（需含 parentId）
 * @returns {{ star: object, bodies: Array<object>, hasPlanets: boolean, maxOrbit: number, counts: object }}
 */
export function buildSystem3dScene(input = {}) {
  const starTint = typeof input.starTint === 'string' && input.starTint[0] === '#' ? input.starTint : '#ffd2a1';
  const planets = Array.isArray(input.planets) ? input.planets : [];
  const moons = Array.isArray(input.moons) ? input.moons : [];

  const sorted = planets
    .slice()
    .sort((a, b) => (a.orbitRadius ?? 0) - (b.orbitRadius ?? 0))
    .slice(0, SYS3D_GEOM.maxBodies);

  const moonsByParent = new Map();
  for (const m of moons) {
    if (!m || !m.parentId) continue;
    if (!moonsByParent.has(m.parentId)) moonsByParent.set(m.parentId, []);
    moonsByParent.get(m.parentId).push(m);
  }

  const bodies = sorted.map((node, index) => {
    const key = node.id || node.name || `body-${index}`;
    const station = isStationNode(node);
    const classId = planetClassForNode(node, { fallbackLayer: 'planet' });
    const sizeScale = Number.isFinite(node.sizeOverride) && node.sizeOverride > 0
      ? node.sizeOverride / SYS3D_GEOM.planetRefRadius2d
      : 0.86 + unit(`size:${key}`) * 0.5;
    const orbit = orbitRadius3d(node.orbitRadius);
    const moonNodes = moonsByParent.get(node.id) || [];
    return {
      id: key,
      name: node.displayName || node.name || '未命名天体',
      kind: station ? 'station' : 'planet',
      classId: isPlanetClassId(classId) ? classId : PLANET_CLASSES[0].id,
      orbit,
      size: station ? SYS3D_GEOM.stationSize : SYS3D_GEOM.planetBaseSize * sizeScale,
      // 初始相位（散列）与公转角速度（开普勒式：外圈慢）
      phase: unit(`phase:${key}`) * Math.PI * 2,
      speed: 0.55 / Math.sqrt(Math.max(1, orbit / SYS3D_GEOM.orbitBase)),
      // 自转与自转轴倾角：让球看起来不是死贴图
      spin: 0.18 + unit(`spin:${key}`) * 0.25,
      tilt: (unit(`tilt:${key}`) - 0.5) * 0.5,
      ring: classId === 'gasGiant' || classId === 'iceGiant',
      moons: moonNodes.map((m, mi) => {
        const mKey = m.id || `${key}-moon-${mi}`;
        return {
          id: mKey,
          name: m.displayName || m.name || '卫星',
          classId: planetClassForNode(m, { fallbackLayer: 'moon' }),
          orbit: SYS3D_GEOM.planetBaseSize * sizeScale + 0.75 + mi * 0.45,
          size: SYS3D_GEOM.moonSize * (0.85 + unit(`msize:${mKey}`) * 0.4),
          phase: unit(`mphase:${mKey}`) * Math.PI * 2,
          speed: 1.1 / (1 + mi * 0.35),
        };
      }),
    };
  });

  const maxOrbit = bodies.reduce((m, b) => Math.max(m, b.orbit), SYS3D_GEOM.orbitBase);
  return {
    star: {
      name: input.starName || '恒星',
      tint: starTint,
      radius: SYS3D_GEOM.starRadius,
    },
    bodies,
    hasPlanets: bodies.some((b) => b.kind === 'planet'),
    maxOrbit,
    counts: {
      planets: bodies.filter((b) => b.kind === 'planet').length,
      stations: bodies.filter((b) => b.kind === 'station').length,
      moons: bodies.reduce((n, b) => n + b.moons.length, 0),
    },
  };
}
