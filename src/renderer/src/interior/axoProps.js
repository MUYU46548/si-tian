/**
 * interior/axoProps.js —— 轴测插图的“配角”与图注（2026-11-16）
 *
 * ## 这一层解决什么
 *
 * 之前的轴测出图只有一栋楼：读者不知道这栋楼多大，也不知道画面上方是哪个方向，
 * 图也没有名字 —— 贴进设定集里只是一张像素，读不出信息。这一层补三样：
 *
 *   ① 比例人与树（黑白剪影）—— 有了 1.70 m 的人，才看得出这是三米的小屋还是十米的院墙；
 *   ② 墙面色阶 —— 两个立面以前只靠光照差一点点，现在按**面朝向量成三档**平涂（画出来的）；
 *   ③ 图注 —— 名称 / 层数 / 占地 / 投影角 / 方位（指北针）/ 比例人尺码。
 *
 * ## 三条纪律
 *
 * 1) **纯函数**：不 import three、不碰 DOM、不用 `Math.random()`（同一个项目连出两张必须逐字节相同）。
 * 2) **不含业务数据**：占地那行文字由调用方用 `describeFootprint()` 算好后传进来 ——
 *    “尺寸给人看的一行”只有一份实现，不在这里再抄一遍。
 * 3) **方位是算出来的**：世界 -Z（平面图的上方）定为北，指北针按当前投影角度投影到纸上。
 *    换一个投影角度针就跟着转，不是画死的一个箭头。
 *
 * 坐标口径与 `buildShell` 一致：世界单位 = 厘米，X 右、Y 上、Z 里（平面 y → 世界 z）。
 */

import { axoDirection } from './axonometric.js';

/** 配角的默认尺寸（cm）：1.70 m 的人 + 4.80 m 的树 */
export const PROP_DEFAULTS = Object.freeze({
  personCm: 170,
  treeCm: 480,
  gapCm: 90,          // 离建筑轮廓的最近距离
});

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ── 剪影几何（局部坐标：脚在 y=0，向上为正，单位 cm）──────────────────────

/** 1.70 m 基准体型的躯干+四肢+腿缝（一条闭合多边形，头另算） */
const PERSON_BODY_170 = Object.freeze([
  [-9, 150], [-17, 144], [-21, 121], [-19, 95], [-12, 93], [-12, 86],
  [-13, 45], [-11, 0], [-2, 0], [0, 78], [2, 0], [11, 0], [13, 45],
  [12, 86], [12, 93], [19, 95], [21, 121], [17, 144], [9, 150],
]);

/**
 * 站立的人形剪影：头（12 边形近似圆）+ 躯干四肢（一条多边形，带腿缝）。
 * @param {number} [heightCm]
 * @returns {{height:number, parts:Array<{kind:string, points:number[][]}>}}
 */
export function personSilhouette(heightCm = PROP_DEFAULTS.personCm) {
  const h = Math.max(60, num(heightCm, PROP_DEFAULTS.personCm));
  const k = h / 170;
  const head = [];
  const cy = 160 * k;
  const r = 10 * k;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    head.push([round2(Math.sin(a) * r), round2(cy + Math.cos(a) * r)]);
  }
  return {
    height: round2(h),
    parts: [
      { kind: 'head', points: head },
      { kind: 'body', points: PERSON_BODY_170.map(([x, y]) => [round2(x * k), round2(y * k)]) },
    ],
  };
}

/** 树冠轮廓的半径抖动（写死的 12 个系数，不是随机数 —— 同一棵树每次都一样） */
const CROWN_WOBBLE = Object.freeze([1, 0.94, 1.05, 0.96, 1.03, 0.93, 1, 0.92, 1.04, 0.95, 1.02, 0.97]);

/**
 * 一棵树的剪影：树干（略收窄的四边形）+ 树冠（12 边形团）。
 * @param {number} [heightCm] 树高（树冠顶端到地面）
 * @returns {{height:number, parts:Array<{kind:string, points:number[][]}>}}
 */
export function treeSilhouette(heightCm = PROP_DEFAULTS.treeCm) {
  const h = Math.max(120, num(heightCm, PROP_DEFAULTS.treeCm));
  const tw = h * 0.055;
  const trunkTop = h * 0.46;
  const trunk = [
    [-round2(tw), 0], [round2(tw), 0],
    [round2(tw * 0.68), round2(trunkTop)], [-round2(tw * 0.68), round2(trunkTop)],
  ];
  const crown = [];
  const cy = h * 0.68;
  const rx = h * 0.21;
  const ry = h * 0.32;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const w = CROWN_WOBBLE[i];
    crown.push([
      round2(Math.sin(a) * rx * w),
      round2(cy + Math.cos(a) * ry * w),
    ]);
  }
  return {
    height: round2(h),
    parts: [
      { kind: 'trunk', points: trunk },
      { kind: 'crown', points: crown },
    ],
  };
}

// ── 摆在哪：屏幕左前方（一定不被楼挡住，一定不出画面）───────────────────

/**
 * 相机在水平面上的两根轴。
 * @param {string|object} preset 轴测角
 * @returns {{right:{x:number,z:number}, toward:{x:number,z:number}}} 单位向量
 *   right  = 画面上“向右”对应的世界方向；
 *   toward = 朝向相机（也就是画面上“向下”的那个方向）。
 */
export function screenAxes(preset) {
  const d = axoDirection(preset);
  const rl = Math.hypot(d.z, d.x) || 1;
  const fl = Math.hypot(d.x, d.z) || 1;
  return {
    right: { x: d.z / rl, z: -d.x / rl },
    toward: { x: d.x / fl, z: d.z / fl },
  };
}

function normBounds(bounds) {
  const b = bounds || {};
  const center = Array.isArray(b.center) && b.center.length === 3
    ? [num(b.center[0]), num(b.center[1]), num(b.center[2])]
    : [0, 0, 0];
  const size = Array.isArray(b.size) && b.size.length === 3
    ? [num(b.size[0]), num(b.size[1]), num(b.size[2])]
    : [0, 0, 0];
  const min = Array.isArray(b.min) && b.min.length === 3
    ? [num(b.min[0]), num(b.min[1]), num(b.min[2])]
    : [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2];
  const max = Array.isArray(b.max) && b.max.length === 3
    ? [num(b.max[0]), num(b.max[1]), num(b.max[2])]
    : [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2];
  return { center, size, min, max };
}

/** 包围盒在某根水平轴上的投影半径（正交投影下是精确值：|ax|·sx + |az|·sz）/2 */
function halfExtentAlong(box, axis) {
  return (Math.abs(axis.x) * box.size[0] + Math.abs(axis.z) * box.size[2]) / 2;
}

/**
 * 人 + 树摆在哪。
 *
 * 位置取“贴着楼的**近角**、往屏幕左挪出轮廓”：朝向相机保证**不被楼挡住**（在楼的前面），
 * 往左挪出轮廓保证**不压在楼上**，都站在地面高度 —— 读者一眼能把人跟墙脚对齐。
 *
 * ⚠️ 别把 gap 放大来“让开”楼：人/树离得越远，取景框就被撑得越大、楼在画里越小
 * （2026-11-16 实测：按包围盒并集取景时，900×650 的房子深度被撑到 1427，楼小了一半）。
 *
 * @param {object} bounds buildShell 的 bounds
 * @param {object} [opts] { preset, personCm, treeCm, gapCm }
 * @returns {Array<{kind:'person'|'tree', heightCm:number, at:[number,number,number]}>}
 */
export function propPlacements(bounds, opts = {}) {
  const box = normBounds(bounds);
  const ax = screenAxes(opts.preset);
  const gap = Math.max(10, num(opts.gapCm, PROP_DEFAULTS.gapCm));
  const halfR = halfExtentAlong(box, ax.right);
  const halfF = halfExtentAlong(box, ax.toward);
  const ground = box.min[1];
  const personCm = num(opts.personCm, PROP_DEFAULTS.personCm);
  const treeCm = num(opts.treeCm, PROP_DEFAULTS.treeCm);
  const at = (f, r) => [
    round2(box.center[0] + ax.toward.x * f + ax.right.x * r),
    round2(ground),
    round2(box.center[2] + ax.toward.z * f + ax.right.z * r),
  ];
  return [
    // 人贴着近角（离墙一个身位），树再往左一点 —— 一大一小错开，不叠成一团
    { kind: 'person', heightCm: personCm, at: at(halfF + gap * 0.9, -(halfR + gap * 1.1)) },
    { kind: 'tree', heightCm: treeCm, at: at(halfF + gap * 1.4, -(halfR + gap * 3.0)) },
  ];
}

/** 一个剪影的水平半宽（局部 x 的最大绝对值） */
function silhouetteHalfWidth(sil) {
  let halfW = 0;
  for (const part of sil.parts) {
    for (const q of part.points) halfW = Math.max(halfW, Math.abs(num(q[0])));
  }
  return halfW;
}

/**
 * 取景要用的点：楼的包围盒 8 个角 + 每个配角的**剪影外框**。
 *
 * 为什么给点而不给包围盒：正交取景只关心“投影到屏幕上的范围”，而配角是斜着摆在世界里的，
 * 它们的轴对齐包围盒并进楼的大盒子会凭空多出一大片空白（见 `propPlacements` 的注释）。
 * 剪影平面是正对相机的，所以它在屏幕上就是 `at ± right × 半宽`、高度就是身高。
 *
 * @param {object} bounds 楼的 bounds
 * @param {Array} props `propPlacements()` 的结果
 * @param {string|object} preset 轴测角
 * @returns {Array<[number,number,number]>} 世界坐标点
 */
export function propFitPoints(bounds, props, preset) {
  const box = normBounds(bounds);
  const pts = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) pts.push([x, y, z]);
    }
  }
  const ax = screenAxes(preset);
  for (const p of Array.isArray(props) ? props : []) {
    if (!p) continue;
    const at = Array.isArray(p.at) ? p.at : [0, 0, 0];
    const sil = p.kind === 'tree' ? treeSilhouette(p.heightCm) : personSilhouette(p.heightCm);
    const halfW = silhouetteHalfWidth(sil);
    const x = num(at[0]);
    const y = num(at[1]);
    const z = num(at[2]);
    for (const s of [-1, 1]) {
      const px = x + ax.right.x * s * halfW;
      const pz = z + ax.right.z * s * halfW;
      pts.push([px, y, pz]);
      pts.push([px, y + sil.height, pz]);
    }
  }
  return pts;
}

// ── 墙面色阶（把“靠光照差一点”换成“看得出的分档”）─────────────────────

/**
 * 光照方向（从物体指向光源）：与 axoScene 里那盏主光同一个方向（-1.2, 2.4, 1.6）归一化。
 * 只用来**判定档位**，不再拿来算亮度 —— 平涂的亮度是查表来的，跟光强无关。
 */
export const AXO_SUN = Object.freeze({
  x: -1.2 / Math.hypot(1.2, 2.4, 1.6),
  y: 2.4 / Math.hypot(1.2, 2.4, 1.6),
  z: 1.6 / Math.hypot(1.2, 2.4, 1.6),
});

/** 四档明度系数：受光 / 侧光 / 背光 / 深背光 */
export const AXO_TONES = Object.freeze({
  lit: 1,
  side: 0.86,
  shade: 0.74,
  back: 0.66,
});

/**
 * 面法向 → 明度系数（四档，不是连续值）。
 *
 * 为什么量化：连续的 Lambert 明暗在纸上会糊成一片渐变，两个立面差得又不够；
 * 插图要的是“这块面一个色、那块面一个色”，色块边界才立得住。
 */
export function wallTone(normal) {
  const n = normal || {};
  const dot = num(n.x) * AXO_SUN.x + num(n.y) * AXO_SUN.y + num(n.z) * AXO_SUN.z;
  if (dot >= 0.55) return AXO_TONES.lit;
  if (dot >= 0.05) return AXO_TONES.side;
  if (dot >= -0.35) return AXO_TONES.shade;
  return AXO_TONES.back;
}

/** 盒子绕 Y 轴转 rotY 之后的法向（与 three 的 rotation.y 同一套换算） */
export function rotateNormalY(normal, rotY) {
  const n = normal || {};
  const nx = num(n.x);
  const ny = num(n.y);
  const nz = num(n.z);
  const c = Math.cos(num(rotY));
  const s = Math.sin(num(rotY));
  return { x: nx * c + nz * s, y: ny, z: -nx * s + nz * c };
}

/** 盒子某个面的明度系数（局部法向 + rotY） */
export function axialTone(normalLocal, rotY) {
  return wallTone(rotateNormalY(normalLocal, rotY));
}

/**
 * 颜色乘明度系数（只乘不调色相）。输入 `#rrggbb`，输出同样的 6 位十六进制。
 */
export function toneColor(hex, tone) {
  const s = String(hex || '').trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s);
  const t = Math.max(0, Math.min(2, num(tone, 1)));
  if (!m) return s || '#000000';
  const v = parseInt(m[1], 16);
  const out = [0, 8, 16].map((shift) => {
    const c = (v >> (16 - shift)) & 0xff;
    return Math.max(0, Math.min(255, Math.round(c * t)))
      .toString(16)
      .padStart(2, '0');
  });
  return `#${out.join('')}`;
}

// ── 方位（指北针）────────────────────────────────────────────────────────

/**
 * 北在画面上的方向（画布坐标：x 向右、**y 向下**）。
 * 口径：世界 -Z = 北（与平面图的“上”同向）。
 * @param {string|object} preset
 * @returns {{x:number,y:number}} 单位向量（可直接拿去画箭头）
 */
export function northScreenVector(preset) {
  const d = axoDirection(preset);
  const rl = Math.hypot(d.z, d.x) || 1;
  const right = { x: d.z / rl, y: 0, z: -d.x / rl };
  // up = dir × right（与 axoFrame 里算 silhouette 用的是同一套基）
  const up = {
    x: d.y * right.z - d.z * right.y,
    y: d.z * right.x - d.x * right.z,
    z: d.x * right.y - d.y * right.x,
  };
  // 北 = (0,0,-1)
  const nx = -right.z;
  const nu = -up.z;
  const len = Math.hypot(nx, nu) || 1;
  return { x: nx / len, y: -nu / len };
}

const DIR_NAMES = Object.freeze(['正上', '右上', '正右', '右下', '正下', '左下', '正左', '左上']);

/**
 * 一句人话：“北在画面右上（60°）”。角度是从画面上方顺时针量的。
 */
export function northText(preset) {
  const v = northScreenVector(preset);
  const deg = Math.round(((Math.atan2(v.x, -v.y) * 180) / Math.PI + 360) % 360);
  const name = DIR_NAMES[Math.round(deg / 45) % 8];
  return `北在画面${name}（${deg}°）`;
}

// ── 图注（版式 + 文案）──────────────────────────────────────────────────

/** 图注条占画面高度的比例（3600×2400 → 顶部 2124 高留给图，底部 276 给字） */
export const AXO_SHEET = Object.freeze({ bandRatio: 0.115 });

/**
 * 出一张图要用的三个尺寸：成品画幅 / 中间的图什么尺寸 / 图注条在哪。
 *
 * 为什么图注条是**另起一条**而不是盖在图上：盖上去必然压住墙脚（建筑在图里是贴地的），
 * 那正是读者最需要看清的地方。宁可把图的高度让出 11.5%。
 *
 * @param {{width:number,height:number}} canvas
 * @param {object} [opts] { caption:boolean, bandRatio:number }
 */
export function axoSheetPlan(canvas, opts = {}) {
  const W = Math.max(320, Math.round(num(canvas && canvas.width, 3600)));
  const H = Math.max(240, Math.round(num(canvas && canvas.height, 2400)));
  const withCaption = opts.caption !== false;
  const bandH = withCaption
    ? Math.max(60, Math.round(H * Math.min(0.4, Math.max(0.04, num(opts.bandRatio, AXO_SHEET.bandRatio)))))
    : 0;
  const pad = Math.round(W * 0.022);
  return {
    canvas: { width: W, height: H },
    // 3D 只画上面这一块（宽高比跟着变，取景要按它算）
    render: { width: W, height: Math.max(120, H - bandH) },
    band: withCaption
      ? { x: 0, y: H - bandH, w: W, h: bandH, pad, line1: H - bandH + Math.round(bandH * 0.30), line2: H - bandH + Math.round(bandH * 0.66) }
      : null,
  };
}

/**
 * 图注文案（全是“给人读的”字段，一个工程术语都没有）。
 *
 * @param {object} input
 * @param {string} [input.name]        建筑名
 * @param {number} [input.floors]      整栋层数
 * @param {string} [input.scope]       只看某一层时的层名（空串 = 看全部）
 * @param {string} [input.sizeText]    `describeFootprint()` 的结果（占地一行）
 * @param {string} [input.projection]  投影角（预设的中文标签）
 * @param {string|object} [input.preset] 轴测角（算指北针用）
 * @param {string} [input.roofText]    屋顶档位（坡顶 / 平顶 / 不封顶）
 * @param {number} [input.personCm]    图里那个人的身高
 * @param {boolean} [input.showPerson] 画面里有没有人（决定要不要写比例人这一行）
 * @param {string} [input.date]        形如 2026-11-16
 * @param {string} [input.version]     应用版本号
 * @returns {{title:string, subtitle:string, cells:Array<{label:string,value:string}>,
 *            note:string, footer:string, north:{x:number,y:number}|null}}
 */
export function axoCaptionModel(input = {}) {
  const name = String(input.name || '').trim() || '建筑';
  const floors = Math.max(0, Math.round(num(input.floors, 0)));
  const scope = String(input.scope || '').trim();
  const sizeText = String(input.sizeText || '').trim();
  const roofText = String(input.roofText || '').trim();
  const personCm = num(input.personCm, PROP_DEFAULTS.personCm);

  const levelText = floors > 0
    ? (scope ? `${floors} 层（本图只看${scope}）` : `${floors} 层`)
    : (scope ? `只看${scope}` : '层数不明');
  const meters = (cm) => `${(Math.round(cm) / 100).toFixed(2)} m`;

  const cells = [
    { label: '层数', value: levelText },
    { label: '占地', value: sizeText || '还没画墙，量不出来' },
    { label: '投影', value: String(input.projection || '').trim() || '轴测' },
    { label: '方位', value: northText(input.preset) },
  ];
  if (roofText) cells.push({ label: '屋顶', value: roofText });

  const notes = [];
  if (input.showPerson !== false) notes.push(`比例人 ${meters(personCm)}`);
  notes.push('北 = 平面图上方');

  const date = String(input.date || '').trim();
  const version = String(input.version || '').trim();
  return {
    title: name,
    subtitle: `轴测插图${roofText ? ` · ${roofText}` : ''}`,
    cells,
    note: notes.join(' · '),
    footer: `司天${version ? ` v${version}` : ''}${date ? ` · ${date}` : ''}`,
    north: northScreenVector(input.preset),
  };
}
