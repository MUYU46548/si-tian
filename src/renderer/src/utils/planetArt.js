/**
 * 行星美术库（3D 观景用的程序化平面纹理）
 *
 * 来源：SP-1025 `src/render/planetArt.ts`（自研，MIT），本仓只搬**纹理**这一层：
 * 移除 sprite 合成（2D 视图用不到的终止线阴影/大气环），并把对 `core/prng` 的依赖改成
 * 本文件内的确定性 RNG —— 司天不引整个 prng 模块，且**禁止 Math.random**
 * （同一 classId 每次得到的像素完全一致，验收截图可复现）。
 *
 * 一张纹理 = 一个行星类别（等距圆柱风格，256×128），供 `THREE.CanvasTexture` 贴球面。
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
 * 平面纹理（等距圆柱风格，256×128）：3D 观景的球面贴图。
 * @param {string} classId
 * @returns {HTMLCanvasElement}
 */
export function getPlanetTexture(classId) {
  const key = CLASS_IDS.has(classId) ? classId : PLANET_CLASSES[0].id;
  const cached = textureCache.get(key);
  if (cached) return cached;
  const def = planetClassDef(key);
  const rng = new SeededRng(hashString(key));
  const W = 256;
  const H = 128;
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
      g.fillRect(0, rng.range(0, H), W, 1 + rng.next() * 1.5);
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
          rng.range(6, 30), rng.range(4, 16), rng.range(0, 3), 0, Math.PI * 2
        );
        g.fill();
      }
      g.globalAlpha = 1;
    }
    if (def.grid) {
      // 机械：面板网格
      g.strokeStyle = 'rgba(20,20,24,0.55)';
      g.lineWidth = 1;
      for (let x = 0; x <= W; x += 16) {
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      }
      for (let y = 0; y <= H; y += 16) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }
      for (let i = 0; i < 26; i++) {
        g.fillStyle = rng.next() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)';
        g.fillRect(Math.floor(rng.range(0, W) / 16) * 16, Math.floor(rng.range(0, H) / 16) * 16, 16, 16);
      }
    }
    if (def.lava) {
      // 熔岩裂纹：随机游走的亮线
      for (let i = 0; i < 12; i++) {
        g.strokeStyle = 'rgba(255,122,32,0.9)';
        g.lineWidth = 1 + rng.next() * 1.6;
        g.shadowColor = 'rgba(255,140,40,0.8)';
        g.shadowBlur = 4;
        g.beginPath();
        let x = rng.range(0, W);
        let y = rng.range(0, H);
        g.moveTo(x, y);
        for (let k = 0; k < 8; k++) {
          x += rng.range(-26, 26);
          y += rng.range(-12, 12);
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
        g.lineWidth = 1 + rng.next() * 2;
        g.beginPath();
        const cx = rng.range(0, W);
        const cy = rng.range(H * 0.2, H * 0.8);
        g.arc(cx, cy, rng.range(6, 22), rng.range(0, 3), rng.range(3.5, 6.5));
        g.stroke();
      }
      g.globalAlpha = 1;
    }
    if (def.cap) {
      g.fillStyle = def.cap;
      const top = 6 + rng.next() * 8;
      const bot = 6 + rng.next() * 8;
      g.fillRect(0, 0, W, top);
      g.fillRect(0, H - bot, W, bot);
    }
    if (def.night) {
      // 都市夜灯：暖色光点 + 少量冷色
      for (let i = 0; i < 90; i++) {
        g.fillStyle = rng.next() < 0.75 ? 'rgba(255,214,130,0.95)' : 'rgba(140,200,255,0.8)';
        g.fillRect(rng.range(0, W), rng.range(H * 0.2, H * 0.8), 1.2, 1.2);
      }
    }
    if (def.clouds) {
      g.fillStyle = 'rgba(255,255,255,1)';
      g.globalAlpha = def.clouds * 0.5;
      for (let i = 0; i < 26; i++) {
        g.beginPath();
        g.ellipse(rng.range(0, W), rng.range(0, H), rng.range(8, 30), rng.range(2, 6), 0, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }
  }

  textureCache.set(key, c);
  return c;
}

/** 仅测试/诊断用：清空纹理缓存（正常流程不清，纹理常驻对 3D 观景是收益）。 */
export function __clearTextureCache() {
  textureCache.clear();
}
