/**
 * 行星美术库（3D 观景用的程序化平面纹理）
 *
 * 来源：SP-1025 `src/render/planetArt.ts`（自研，MIT），本仓只搬**纹理**这一层：
 * 移除 sprite 合成（2D 视图用不到的终止线阴影/大气环），并把对 `core/prng` 的依赖改成
 * 本文件内的确定性 RNG —— 司天不引整个 prng 模块，且**禁止 Math.random**
 * （同一 classId 每次得到的像素完全一致，验收截图可复现）。
 *
 * 一张纹理 = 一个行星类别（等距圆柱风格，512×256），供 `THREE.CanvasTexture` 贴球面；
 * 新增类别 = 加一条 def，不改渲染器。
 *
 * 18 类：宜居九型 + 死星系 + 气巨/冰巨 + 人造两型。
 */

/** FNV-1a：与判据无关的稳定散列（只用它给"看名字看不出来"的类别挑默认款）。 */
export function hashString(s) {
  let h = 2166136261 >>> 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：确定性随机（种子相同 → 序列相同）。替代 Math.random，禁止在渲染循环里用。 */
export class SeededRng {
  constructor(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(n) { return Math.floor(this.next() * n); }
}

/**
 * @typedef {Object} PlanetClassDef
 * @property {string} id
 * @property {string} label
 * @property {'terra'|'bands'|'dead'} kind
 * @property {string} base
 * @property {string[]} [land]
 * @property {string} [cap]
 * @property {number} [clouds]
 * @property {string[]} [bands]
 * @property {boolean} [night]
 * @property {boolean} [grid]
 * @property {boolean} [lava]
 * @property {string} [swirl]
 * @property {string} [atmosphere]
 */

/** @type {PlanetClassDef[]} */
export const PLANET_CLASSES = [
  { id: 'continental', label: '大陆星球', kind: 'terra', base: '#1c4d94', land: ['#3d8a45', '#4d9a3d', '#7a9a4a'], cap: '#eef4f8', clouds: 0.32, atmosphere: '#7fb2ff' },
  { id: 'ocean', label: '海洋星球', kind: 'terra', base: '#123a7a', land: ['#2d6a4a', '#3d7a55'], cap: '#e8f4f8', clouds: 0.4, atmosphere: '#6fb2ff' },
  { id: 'tropical', label: '热带星球', kind: 'terra', base: '#1470a0', land: ['#2d8a3d', '#4da845', '#8ac050'], clouds: 0.42, atmosphere: '#8fd0ff' },
  { id: 'savanna', label: '草原星球', kind: 'terra', base: '#3a7a6a', land: ['#b0a050', '#c0b060', '#8a9a4a'], clouds: 0.22, atmosphere: '#b0d0a0' },
  { id: 'arid', label: '干旱星球', kind: 'terra', base: '#a08050', land: ['#8a6838', '#b08a50'], clouds: 0.1, atmosphere: '#d0b080' },
  { id: 'desert', label: '沙漠星球', kind: 'terra', base: '#d9b380', land: ['#c9a060', '#e0c090'], clouds: 0.06, atmosphere: '#e8c890' },
  { id: 'tundra', label: '苔原星球', kind: 'terra', base: '#5a6a58', land: ['#7a8a6a', '#a0a890'], cap: '#dce8e8', clouds: 0.16, atmosphere: '#a8c8c8' },
  { id: 'arctic', label: '极地星球', kind: 'terra', base: '#a8c8d8', land: ['#e0ecf2'], cap: '#f4fafc', clouds: 0.1, atmosphere: '#c8e4f4' },
  { id: 'alpine', label: '高山星球', kind: 'terra', base: '#5a6a7a', land: ['#c8d4dc', '#8a9aa8'], cap: '#e8f0f4', clouds: 0.2, atmosphere: '#b8cce0' },
  { id: 'gaia', label: '盖亚星球', kind: 'terra', base: '#1a6a8a', land: ['#3da05a', '#7fc060', '#2d8a5a'], cap: '#e8f8f0', clouds: 0.48, atmosphere: '#8fe0b0' },
  { id: 'city', label: '都市星球', kind: 'terra', base: '#2a3a5a', land: ['#3a4a5a', '#4a5a6a'], clouds: 0.18, night: true, atmosphere: '#9ab8d8' },
  { id: 'machine', label: '机械星球', kind: 'terra', base: '#6a6a6a', land: ['#7a7a7a'], grid: true, clouds: 0, atmosphere: '#9a9aa8' },
  { id: 'molten', label: '熔岩星球', kind: 'dead', base: '#3a1410', lava: true, atmosphere: '#ff9a50' },
  { id: 'barren', label: '荒芜星球', kind: 'dead', base: '#8a7a6a', atmosphere: '#a8a098' },
  { id: 'frozen', label: '冰封星球', kind: 'dead', base: '#cfe0ea', atmosphere: '#d8ecf8' },
  { id: 'toxic', label: '剧毒星球', kind: 'dead', base: '#4a6a1a', swirl: '#a0d040', atmosphere: '#b0e060' },
  { id: 'gasGiant', label: '气态巨行星', kind: 'bands', base: '#c9a06b', bands: ['#c9a06b', '#e8d5b0', '#b07a45', '#e8d5b0', '#a06a3a', '#c9a06b'], atmosphere: '#e8c890' },
  { id: 'iceGiant', label: '冰封巨行星', kind: 'bands', base: '#3b5bdb', bands: ['#3b5bdb', '#4d74e8', '#5a8ae8', '#3b5bdb'], atmosphere: '#8fb0ff' },
];

const CLASS_IDS = new Set(PLANET_CLASSES.map((c) => c.id));

export function planetClassDef(classId) {
  return PLANET_CLASSES.find((c) => c.id === classId) ?? PLANET_CLASSES[0];
}

export function planetClassLabel(classId) {
  return planetClassDef(classId).label;
}

export function isPlanetClassId(classId) {
  return CLASS_IDS.has(classId);
}

/** 有环的类别（3D 里给气巨/冰巨加一圈薄环） */
export function hasRing(classId) {
  return planetClassDef(classId).kind === 'bands';
}

/**
 * 大气边缘光的**强度档**（2026-11-25）。
 *
 * 用户原话：「顺便很多行星根本没有大气」——指的是 3D 里每颗行星都是**硬边球**：
 * 一颗球贴一张贴图，轮廓就是球面的边界，没有任何"裹着一层气"的过渡。
 * 群星参考图里每颗行星都有一圈柔光（浓淡不同），那是行星最容易读成"球"的线索。
 *
 * 为什么强度要分档而不是一刀切：**荒芜/冰封**这类天体在设定上本来就只有极稀薄的一层，
 * 给它一个盖亚级别的光晕会立刻显得假；但完全不给又会退回"硬边球"。
 * 所以下限不是 0 —— 每颗行星都有一圈，只是死星系那几类薄得多（0.25 vs 1.0）。
 * 判据（`test_system3d_scene.js` a12）钉死两件事：**任何类别的强度都 > 0**（不许有"没有大气"的行星），
 * 且**死星系三类的强度必须明显小于宜居类**（不是所有人都裹同一层）。
 *
 * 数值口径：1.0 = 标准（大陆/海洋/热带/气巨）；>1 = 更厚（盖亚/巨行星）；<1 = 更薄。
 * 这是**观感系数**，不是物理大气压 —— 不要拿它去算任何数据。
 */
const ATMO_STRENGTH = Object.freeze({
  continental: 1.0, ocean: 1.0, tropical: 1.0, gaia: 1.15, savanna: 0.85,
  arid: 0.7, desert: 0.6, tundra: 0.6, arctic: 0.55, alpine: 0.6,
  city: 0.75, machine: 0.4,
  molten: 0.7, toxic: 0.85, frozen: 0.4, barren: 0.25,
  gasGiant: 1.15, iceGiant: 1.15,
});

/**
 * 某个行星类别的**大气边缘光参数**（3D 观景用；纯函数）。
 *
 * @param {string} classId
 * @returns {{ color: string, strength: number, kind: 'terra'|'bands'|'dead' }}
 *   `color` 恒为 `#rrggbb`（脏值回落主色），`strength` 恒落在 [0.2, 1.2]。
 */
export function atmosphereForClass(classId) {
  const def = planetClassDef(classId);
  const raw = typeof def.atmosphere === 'string' && def.atmosphere[0] === '#'
    ? def.atmosphere
    : def.base;
  const strength = ATMO_STRENGTH[def.id] ?? 0.6;
  return {
    color: raw,
    // 夹一下：ATMO_STRENGTH 里写错一个小数点也不许让光晕变成一坨白
    strength: Math.max(0.2, Math.min(1.2, strength)),
    kind: def.kind,
  };
}

/** rgba 字符串（alpha 0~1）；输入必须是 #rrggbb。 */
export function hexAlpha(hex, alpha) {
  const h = typeof hex === 'string' && hex[0] === '#' ? hex : '#888888';
  const r = parseInt(h.slice(1, 3), 16) || 0;
  const g = parseInt(h.slice(3, 5), 16) || 0;
  const b = parseInt(h.slice(5, 7), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 纹理缓存：按 classId 只画一次（同一进程内复用，离开 3D 不必清 —— 见 System3DView 的说明） */
const textureCache = new Map();

/**
 * 平面纹理（等距圆柱风格）：3D 观景的球面贴图。
 *
 * 🔴 2026-11-25 第二轮：256×128 → **512×256**。用户说的"近景看得出色块边界"就是它：
 *    行星在聚焦档能占 300px 直径，256 宽的贴图裹满整个球面 → 赤道附近 1 个纹素要摊到
 *    1.2 个屏幕像素，陆块边缘直接是**方块**。4 倍像素之后同一处的纹素密度翻倍。
 *    ⚠️ 所有特征尺寸都按 `S = W / 256` 缩放 —— 只放大画布不缩放笔触，陆块会变成
 *    "相对更小更碎"的斑点，配色没变但地貌完全变了（那是另一张图，不是更清晰的一张）。
 *    代价：18 类 × 512×256×4 ≈ 9.4 MB 显存（原 2.4 MB），只在 3D/2D 行星视图用得到。
 *
 * @param {string} classId
 * @returns {HTMLCanvasElement}
 */
export function getPlanetTexture(classId) {
  const key = CLASS_IDS.has(classId) ? classId : PLANET_CLASSES[0].id;
  const cached = textureCache.get(key);
  if (cached) return cached;
  const def = planetClassDef(key);
  const rng = new SeededRng(hashString(key));
  const W = 512;
  const H = 256;
  /** 与旧 256×128 版保持**同一套构图**的缩放系数 */
  const S = W / 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  g.fillStyle = def.base;
  g.fillRect(0, 0, W, H);

  if (def.kind === 'bands' && def.bands) {
    const grad = g.createLinearGradient(0, 0, 0, H);
    def.bands.forEach((col, k) => grad.addColorStop(k / (def.bands.length - 1), col));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 0.12;
    for (let i = 0; i < 16; i++) {
      g.fillStyle = rng.next() < 0.5 ? '#ffffff' : '#000000';
      g.fillRect(0, rng.range(0, H), W, (1 + rng.next() * 1.5) * S);
    }
    g.globalAlpha = 1;
  } else {
    // 陆地 / 斑纹
    if (def.land) {
      const n = def.kind === 'terra' ? 9 + rng.int(6) : 12 + rng.int(8);
      for (let i = 0; i < n; i++) {
        g.fillStyle = def.land[rng.int(def.land.length)];
        g.globalAlpha = 0.85;
        g.beginPath();
        g.ellipse(
          rng.range(0, W), rng.range(H * 0.16, H * 0.84),
          rng.range(6, 30) * S, rng.range(4, 16) * S, rng.range(0, 3), 0, Math.PI * 2
        );
        g.fill();
      }
      g.globalAlpha = 1;
    }
    if (def.grid) {
      // 机械：面板网格
      g.strokeStyle = 'rgba(20,20,24,0.55)';
      g.lineWidth = 1 * S;
      const step = 16 * S;
      for (let x = 0; x <= W; x += step) {
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      }
      for (let y = 0; y <= H; y += step) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }
      for (let i = 0; i < 26; i++) {
        g.fillStyle = rng.next() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)';
        g.fillRect(Math.floor(rng.range(0, W) / step) * step,
          Math.floor(rng.range(0, H) / step) * step, step, step);
      }
    }
    if (def.lava) {
      // 熔岩裂纹：随机游走的亮线
      for (let i = 0; i < 12; i++) {
        g.strokeStyle = 'rgba(255,122,32,0.9)';
        g.lineWidth = (1 + rng.next() * 1.6) * S;
        g.shadowColor = 'rgba(255,140,40,0.8)';
        g.shadowBlur = 4 * S;
        g.beginPath();
        let x = rng.range(0, W);
        let y = rng.range(0, H);
        g.moveTo(x, y);
        for (let k = 0; k < 8; k++) {
          x += rng.range(-26, 26) * S;
          y += rng.range(-12, 12) * S;
          g.lineTo(x, y);
        }
        g.stroke();
        g.shadowBlur = 0;
      }
    }
    if (def.swirl) {
      for (let i = 0; i < 9; i++) {
        g.strokeStyle = def.swirl;
        g.globalAlpha = 0.5;
        g.lineWidth = (1 + rng.next() * 2) * S;
        g.beginPath();
        const cx = rng.range(0, W);
        const cy = rng.range(H * 0.2, H * 0.8);
        g.arc(cx, cy, rng.range(6, 22) * S, rng.range(0, 3), rng.range(3.5, 6.5));
        g.stroke();
      }
      g.globalAlpha = 1;
    }
    if (def.cap) {
      g.fillStyle = def.cap;
      const top = (6 + rng.next() * 8) * S;
      const bot = (6 + rng.next() * 8) * S;
      g.fillRect(0, 0, W, top);
      g.fillRect(0, H - bot, W, bot);
    }
    if (def.night) {
      // 都市夜灯：暖色光点 + 少量冷色
      for (let i = 0; i < 90; i++) {
        g.fillStyle = rng.next() < 0.75 ? 'rgba(255,214,130,0.95)' : 'rgba(140,200,255,0.8)';
        g.fillRect(rng.range(0, W), rng.range(H * 0.2, H * 0.8), 1.2 * S, 1.2 * S);
      }
    }
    if (def.clouds) {
      g.fillStyle = 'rgba(255,255,255,1)';
      g.globalAlpha = def.clouds * 0.5;
      for (let i = 0; i < 26; i++) {
        g.beginPath();
        g.ellipse(rng.range(0, W), rng.range(0, H),
          rng.range(8, 30) * S, rng.range(2, 6) * S, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }
  }

  textureCache.set(key, c);
  return c;
}

/** 云层贴图缓存（与地表贴图同一套尺寸口径；没有云的类别返回 null） */
const cloudCache = new Map();

/** 有云层图层的类别（3D 里额外叠一层会自己转的云） */
export function hasClouds(classId) {
  const def = planetClassDef(classId);
  return !!(def.kind === 'terra' && def.clouds);
}

/**
 * 云层贴图（2026-11-25 第二轮）：**透明底 + 白色云团**，贴在比球面大 1.02 倍的球壳上。
 *
 * 为什么需要它：地表贴图里其实已经画了白云（`def.clouds`），但那层云是**焊死在地表上**的
 * —— 球一转，云跟着地形一起转，看起来像"石头上的白斑"。真实行星的云比地面转得快。
 * 所以把云单独抽一层、给一个稍快的自转，近景立刻有"大气在动"的感觉。
 *
 * 与地表贴图同分辨率（512×256），并按类别确定性生成（同一类别每次一样）。
 * @param {string} classId
 * @returns {HTMLCanvasElement|null}
 */
export function getCloudTexture(classId) {
  const cid = CLASS_IDS.has(classId) ? classId : PLANET_CLASSES[0].id;
  const def = planetClassDef(cid);
  if (!def.clouds) return null;
  const hit = cloudCache.get(cid);
  if (hit) return hit;
  const W = 512;
  const H = 256;
  const rng = new SeededRng(hashString(`cloud:${cid}`));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  // 🔴 第一版是"一团云 = 一个大椭圆 + 两个小椭圆"，近景看就是一颗颗**白点**
  //    （截图上像撒了盐）。真实云是**软边的团块**：先给 canvas 挂一个模糊滤镜，
  //    再用"一个簇 = 4~9 个低透明度小椭圆"叠出来 —— 边缘被模糊柔化，重叠处自然变厚。
  //    `ctx.filter` 是 Chromium 支持的 2D 能力（一次性生成，不是每帧）。
  g.filter = 'blur(6px)';
  const clusters = Math.round(10 + def.clouds * 26);
  for (let i = 0; i < clusters; i++) {
    const cx = rng.range(0, W);
    const cy = rng.range(0, H);
    // 纬向分布：赤道（ITCZ）与中纬多、极区少 —— 均匀撒会像"随机白斑"
    const lat = Math.abs((cy / H) * 2 - 1);
    if (rng.next() > (lat < 0.25 ? 1 : lat < 0.7 ? 0.75 : 0.35)) continue;
    const r = (16 + rng.next() * 44) * (1 - lat * 0.4);
    const puffs = 4 + Math.round(rng.next() * 5);
    for (let k = 0; k < puffs; k++) {
      g.fillStyle = `rgba(255,255,255,${0.05 + rng.next() * 0.10})`;
      g.beginPath();
      g.ellipse(
        cx + rng.range(-r, r), cy + rng.range(-r * 0.55, r * 0.55),
        r * rng.range(0.3, 0.62), r * rng.range(0.16, 0.34), 0, 0, Math.PI * 2,
      );
      g.fill();
    }
  }
  g.filter = 'none';
  cloudCache.set(cid, c);
  return c;
}

/** 仅测试/诊断用：清空纹理缓存（正常流程不清，纹理常驻对 3D 观景是收益）。 */
export function __clearTextureCache() {
  textureCache.clear();
  cloudCache.clear();
  discCache.clear();
}

// ===== 2D 行星圆盘（恒星系 2D 观景用；2026-11-01）=====
// 复用同一份 `getPlanetTexture`（3D 球面贴图）——**不新造一套配色**，只是把它按球面明暗压成圆盘。
// 为什么要它：`SystemDetailView` 原先每颗行星是一个纯色圆点（7px），一堆行星长得一模一样，
// 与原型“下钻恒星系视图”差着一整个美术层（`refs/src/sp1025-system-drilldown.png`）。
const discCache = new Map();

/**
 * 行星圆盘 sprite（带光照/边缘大气），**按 (类别, 像素档) 缓存**。
 * @param {string} classId
 * @param {number} px 目标像素直径（内部取 48/96/128 档，避免每帧重画）
 * @returns {HTMLCanvasElement}
 */
export function getPlanetDisc(classId, px = 48) {
  const cid = CLASS_IDS.has(classId) ? classId : PLANET_CLASSES[0].id;
  const bucket = px <= 48 ? 48 : px <= 96 ? 96 : 128;
  const key = `${cid}:${bucket}`;
  const hitP = discCache.get(key);
  if (hitP) return hitP;

  const def = planetClassDef(cid);
  const S = bucket;
  const R = S / 2;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');

  g.save();
  g.beginPath();
  g.arc(R, R, R * 0.94, 0, Math.PI * 2);
  g.clip();

  // 底：类别主色（贴图覆盖不到的地方不露白）
  g.fillStyle = def.base;
  g.fillRect(0, 0, S, S);

  // 贴图：取赤道带一块铺满圆盘（等价于"正面"）
  const tex = getPlanetTexture(cid);
  g.drawImage(tex, 0, (tex.height - tex.height / 2) / 2, tex.width, tex.height / 2, 0, 0, S, S);

  // 球面光照：左上受光、右下入影（与 3D 观景同侧，切视图不"翻灯"）
  const shade = g.createRadialGradient(R * 0.62, R * 0.58, R * 0.08, R, R, R * 1.02);
  shade.addColorStop(0, 'rgba(255,255,255,0.20)');
  shade.addColorStop(0.42, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.74)');
  g.fillStyle = shade;
  g.fillRect(0, 0, S, S);

  // 极冠（有 cap 的类别：顶部一条冷色带，别让"极地星球"看起来像普通球）
  if (def.cap) {
    g.globalAlpha = 0.5;
    g.fillStyle = def.cap;
    g.beginPath();
    g.ellipse(R, R * 0.12, R * 0.92, R * 0.3, 0, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
  g.restore();

  // 边缘：大气辉光 + 一圈细轮廓（远景也看得出是个球，而不是色块）
  g.beginPath();
  g.arc(R, R, R * 0.94, 0, Math.PI * 2);
  g.strokeStyle = hexAlpha(def.atmosphere || def.base, 0.55);
  g.lineWidth = Math.max(1, S * 0.035);
  g.stroke();

  discCache.set(key, c);
  return c;
}
