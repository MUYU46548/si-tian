// galaxy/sky.js —— 银河背景美术资产（**吸收自 SP-1025 `src/render/background.ts`，MIT，自研**）
//
// 为什么搬它：司天原先的星域背景是“径向渐变 + 网格线 + 5 层谐波点子”——
// 网格线在真实比例下看着像坐标纸，点子分布是伪随机取模（成行成列的对角斜纹），
// 用户对星域总览的评价是“一坨狗屎”。原型那套是**一次生成存成离屏资产、每帧只 drawImage**：
//   深空底色渐变 → 星云（多组柔化径向团 + 子团块）→ 深远星系抹痕 → 尘埃带 → 三层星场（少量十字星芒）→ 暗角
//
// 口径（与原型一致，别自己改数字）：
//   · 纯计算 `galaxySkySpec(seed)` 与绘制 `paintGalaxySky` 分离 → 同 seed 必然同一片天（可测）；
//   · 资产按（矩形尺寸 × 像素密度）缓存，种子变了才重画，**不参与逐帧重算**；
//   · 资产用 `drawImage` 铺进世界矩形 —— 画布与“导出 PNG(全图)”**共用这一份**（同源红线）。
//
// ⚠️ 这里的星点只是**背景装饰**，半径 ≤ 1.6 世界单位：回归用例（test_117）靠
//    “arc 半径 ≥ 5 才算节点圆”把星点排除在外，**别把星点画大**。

/** 星域视图的固定世界矩形（星域环形半径 630 + 星域半径 350 + 余量） */
export const GALAXY_SKY_RECT = { x: -1600, y: -1600, w: 3200, h: 3200 };

/** 没有世界可依时用的种子（= 2026-11-01 内化原型时的原值，老截图/老基线认得它） */
export const DEFAULT_SKY_SEED = 20261031;

/**
 * 世界 id → 背景种子（FNV-1a 32 位；纯函数、无状态、不碰 `Math.random`）。
 *
 * 2026-11-03 用户实测：“中间背景图是固定的吗？好丑。不能每次随机生成吗？”
 * 事实是：此前**所有世界共用一张天**（`galaxySkySpec(20261031)` 写死）。
 *
 * 口径（刻意与“每次打开换一张”不同）：
 *   · **每个世界一片固定的天** —— 换世界换一片，回到同一个世界还是那一片。
 *     真随机会让同一份截图/像素基线/导出图每次都不一样，等于把可复核性换掉了；
 *   · 派生用 id 而不是名字：改名不该换天（名字是显示层，id 才是身份）。
 */
export function skySeedFor(key) {
  const s = String(key == null ? '' : key);
  if (!s) return DEFAULT_SKY_SEED;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = h >>> 0;
  return h || DEFAULT_SKY_SEED;
}

/** 确定性伪随机（mulberry32，与 FMG/原型同族；不碰全局 Math.random） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NEBULA_TINTS = ['#5b3f9e', '#2e6f6a', '#7a3560', '#3a4f9e', '#6b4fa8'];
const STAR_TINTS = ['#ffffff', '#dfe9ff', '#cfe0ff', '#ffd9a0', '#ffc9b8'];

/** 纯函数：种子 → 背景构图（星场 / 星云 / 尘埃带 / 远景星系抹痕）。同 seed 恒定。 */
export function galaxySkySpec(seed = DEFAULT_SKY_SEED) {
  const r = rng((seed ^ 0x9e3779b9) >>> 0);
  const range = (a, b) => a + r() * (b - a);
  const int = (n) => Math.floor(r() * n);

  const stars = { far: [], mid: [], near: [] };
  const layer = (count, rMin, rMax, aMin, aMax, flareChance, out) => {
    for (let i = 0; i < count; i++) {
      out.push({
        x: range(0, 1), y: range(0, 1), // 归一化：铺到任意矩形都不必重掷
        r: range(rMin, rMax),
        alpha: range(aMin, aMax),
        tint: r() < 0.85 ? STAR_TINTS[int(3)] : STAR_TINTS[3 + int(2)],
        flare: r() < flareChance,
      });
    }
  };
  layer(900, 0.35, 0.8, 0.10, 0.40, 0, stars.far);
  layer(320, 0.7, 1.4, 0.28, 0.68, 0, stars.mid);
  layer(70, 1.1, 1.9, 0.5, 0.95, 0.12, stars.near);

  const nebulas = [];
  const nebulaCount = 4 + int(3);
  for (let i = 0; i < nebulaCount; i++) {
    const blobs = [];
    const sub = 6 + int(7);
    for (let k = 0; k < sub; k++) {
      const ang = range(0, Math.PI * 2);
      const d = range(0, 0.55);
      blobs.push({ dx: Math.cos(ang) * d, dy: Math.sin(ang) * d, rr: range(0.35, 0.8) });
    }
    nebulas.push({
      x: range(0.12, 0.88), y: range(0.12, 0.88),
      radius: range(0.10, 0.24), // 相对短边
      tint: NEBULA_TINTS[int(NEBULA_TINTS.length)],
      alpha: range(0.08, 0.16),
      blobs,
    });
  }

  const galaxies = [];
  const galaxyCount = 3 + int(4);
  for (let i = 0; i < galaxyCount; i++) {
    galaxies.push({
      x: range(0.04, 0.96), y: range(0.04, 0.96),
      rx: range(0.006, 0.016), ry: range(0.0016, 0.0045),
      angle: range(0, Math.PI), alpha: range(0.08, 0.20),
    });
  }

  // 尘埃带：一条穿过画面的斜向暗带（预折算成若干条抖动粗线，绘制端零随机）
  const angle = range(-0.5, 0.5) + (r() < 0.5 ? 0 : Math.PI / 2.4);
  const cx = 0.5 + range(-0.06, 0.06);
  const cy = 0.5 + range(-0.05, 0.05);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const dust = [];
  const strands = 8 + int(7);
  for (let i = 0; i < strands; i++) {
    const off = range(-0.06, 0.06);
    dust.push({
      x1: cx - dx * 0.55 - dy * off, y1: cy - dy * 0.55 + dx * off,
      x2: cx + dx * 0.55 - dy * off, y2: cy + dy * 0.55 + dx * off,
      width: range(0.012, 0.05), alpha: range(0.05, 0.15),
    });
  }
  return { stars, nebulas, galaxies, dust };
}

/** 资产缓存：key = 像素边长 + 种子 */
const _cache = new Map();

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * 画一张背景资产（离屏 canvas）。**只在种子/尺寸变化时调用一次**。
 * @param {number} px 资产边长（像素）
 * @param {number} seed
 */
export function paintSkyAsset(px = 1024, seed = DEFAULT_SKY_SEED) {
  const key = `${px}:${seed}`;
  const hit = _cache.get(key);
  if (hit) return hit;

  const spec = galaxySkySpec(seed);
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d');
  const S = px;

  // 1) 深空底色（对角渐变，别用纯色：纯色在放大后是死板的一块）
  const base = ctx.createLinearGradient(0, 0, S, S);
  base.addColorStop(0, '#05070f');
  base.addColorStop(0.5, '#080b16');
  base.addColorStop(1, '#03040a');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S);

  // 2) 星云（screen 叠加，子团块叠出体积感）
  ctx.globalCompositeOperation = 'screen';
  for (const nb of spec.nebulas) {
    const ncx = nb.x * S, ncy = nb.y * S, R = nb.radius * S;
    for (const b of nb.blobs) {
      const bx = ncx + b.dx * R, by = ncy + b.dy * R, br = b.rr * R;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, hexAlpha(nb.tint, nb.alpha));
      g.addColorStop(0.55, hexAlpha(nb.tint, nb.alpha * 0.45));
      g.addColorStop(1, hexAlpha(nb.tint, 0));
      ctx.fillStyle = g;
      ctx.fillRect(bx - br, by - br, br * 2, br * 2);
    }
  }

  // 3) 深远星系抹痕（极淡的斜椭圆光斑）
  for (const g0 of spec.galaxies) {
    ctx.save();
    ctx.translate(g0.x * S, g0.y * S);
    ctx.rotate(g0.angle);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, g0.rx * S);
    grad.addColorStop(0, `rgba(222,232,255,${g0.alpha})`);
    grad.addColorStop(1, 'rgba(222,232,255,0)');
    ctx.fillStyle = grad;
    ctx.scale(1, Math.max(0.15, g0.ry / g0.rx));
    ctx.beginPath();
    ctx.arc(0, 0, g0.rx * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 4) 尘埃带（压暗）
  ctx.globalCompositeOperation = 'source-over';
  for (const d of spec.dust) {
    ctx.strokeStyle = `rgba(3,4,9,${d.alpha})`;
    ctx.lineWidth = Math.max(1, d.width * S);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(d.x1 * S, d.y1 * S);
    ctx.lineTo(d.x2 * S, d.y2 * S);
    ctx.stroke();
  }

  // 5) 三层星场（近层少量十字星芒）
  const starScale = S / 1024; // 星点半径按资产边长等比
  const drawStars = (list) => {
    for (const s of list) {
      const x = s.x * S, y = s.y * S, rr = Math.max(0.4, s.r * starScale);
      ctx.globalAlpha = s.alpha;
      ctx.fillStyle = s.tint;
      if (s.flare) {
        ctx.shadowColor = s.tint;
        ctx.shadowBlur = 8 * starScale;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = s.alpha * 0.65;
        ctx.fillRect(x - rr * 4, y - 0.4, rr * 8, 0.8);
        ctx.fillRect(x - 0.4, y - rr * 4, 0.8, rr * 8);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };
  drawStars(spec.stars.far);
  drawStars(spec.stars.mid);
  drawStars(spec.stars.near);

  // 6) 暗角
  const vig = ctx.createRadialGradient(S / 2, S / 2, S * 0.34, S / 2, S / 2, S * 0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, S, S);

  _cache.set(key, c);
  return c;
}

/**
 * 把背景铺进世界矩形。画布与导出**都调它**（同源）。
 *
 * 2026-11-02（②“星云按视口裁”）：资产分辨率不再固定 1024，而是**按当前变换算出来的屏幕尺寸**选档。
 * 旧口径是“一张 1024² 资产拉满 3200×3200 世界矩形”—— 远景（scale≈0.36）刚好够用，
 * 但一放大到 1.2 就是 3.75 倍上采样，星点糊成团、星云没有层次（用户说的"抄不清楚"里有一条就是它）。
 * 现在按 `rect.w × scale` 选 1024 / 1536 / 2048 三档（只在跨档时才重新生成，资产本身有缓存）。
 * 上限 2048 是有意的：4096² 要 64MB 且生成一次就掉一帧，收益却只有边缘那一点锐度。
 */
export function paintGalaxySky(ctx, rect, opts = {}) {
  let px = opts.px || 0;
  if (!px) {
    // 世界→屏幕的缩放（含 DPR 之外的画布变换）；导出态是 1（外层已按 dpr 铺好）
    let scale = 1;
    try {
      const m = ctx.getTransform ? ctx.getTransform() : null;
      if (m && Number.isFinite(m.a)) scale = Math.hypot(m.a, m.b) || 1;
    } catch (e) { scale = 1; }
    const need = Math.abs(rect.w) * scale;
    px = need > 1500 ? 2048 : need > 900 ? 1536 : 1024;
    if (opts.maxPx) px = Math.min(px, opts.maxPx);
  }
  const asset = paintSkyAsset(px, opts.seed || DEFAULT_SKY_SEED);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(asset, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

/** 测试/主题切换用：清掉资产缓存 */
export function __clearSkyCache() {
  _cache.clear();
}
