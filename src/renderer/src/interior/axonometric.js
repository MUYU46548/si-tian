/**
 * 单栋建筑的轴测取景（2026-11-15）。
 *
 * ## 为什么不用透视相机
 *
 * 设定集里的建筑插图用**轴测（平行投影）**：平行线永远平行、等大物体等大，
 * 读得出尺寸关系。透视相机（现在实时预览用的 45°）会把远端压小，墙线收敛，
 * 一眼就是"游戏截图"，不是"图"。
 *
 * 这一层只算**取景参数**（相机放哪、正交视锥多大），不碰 three —— 所以能单测。
 * 渲染侧（ExteriorView）拿到参数后 new OrthographicCamera 即可。
 *
 * 坐标系：与 buildShell 一致，X 向右、Y 向上、Z 向里（y 是标高，单位 cm）。
 */

const DEG = Math.PI / 180;

/**
 * 常用轴测角：方位角（绕 Y 转多少度）+ 仰角（抬多高）。
 *
 * ⚠️ 第一版把 `dimetric` 写成 30°/30° 并断言"两立面等宽" —— 那是错的：
 * 立面投影宽度只取决于**方位角**（|dx|=|dz| 要求 azimuth=45），跟仰角无关。
 * 现在按制图惯例如实定义，判据也换成真的：
 *   · 等轴测：三根轴在画面上的投影**等长**（仰角必须是 35.264° = asin(1/√3)）；
 *   · 二测 2:1：进深方向的投影是宽度的一半（方位角 atan(2) ≈ 63.435°）。
 */
// 用式子算而不是写死四位小数：35.264° 与 63.435° 都是约值，写死会让"三轴等缩""2:1"差出 1e-5
const ISO_ELEVATION = (Math.asin(1 / Math.sqrt(3)) * 180) / Math.PI;   // 35.264389…
const DIMETRIC_AZIMUTH = (Math.atan(2) * 180) / Math.PI;               // 63.434948…

export const AXO_PRESETS = Object.freeze({
  /** 严格的等轴测：三轴等缩，正六边形投影关系（45° / asin(1/√3)） */
  iso: { azimuth: 45, elevation: ISO_ELEVATION, label: '等轴测 45°/35.26°（三轴等缩）' },
  /** 二测 2:1：进深压一半，日式/像素风插画常用（atan2 / 30°） */
  dimetric: { azimuth: DIMETRIC_AZIMUTH, elevation: 30, label: '二测 2:1（进深压一半）' },
  /** 俯视一点：60° 仰角，看屋顶为主（有院墙/庭院时用） */
  high: { azimuth: 45, elevation: 60, label: '高视 45°/60°' },
});

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 轴测相机的方向单位向量（从"目标点指向相机"）。
 * @param {{azimuth?:number, elevation?:number}|string} preset 预设名或自定义角度
 * @returns {{x:number, y:number, z:number}}
 */
export function axoDirection(preset) {
  const p = typeof preset === 'string' ? (AXO_PRESETS[preset] || AXO_PRESETS.iso) : (preset || AXO_PRESETS.iso);
  const az = num(p.azimuth, 45) * DEG;
  const el = num(p.elevation, 30) * DEG;
  // 方位角从 +Z 轴往 +X 量（与 three 的 Y-up 右手系一致）
  return {
    x: Math.cos(el) * Math.sin(az),
    y: Math.sin(el),
    z: Math.cos(el) * Math.cos(az),
  };
}

/**
 * 算正交取景。
 *
 * @param {{center:[number,number,number], size:[number,number,number], radius?:number}} bounds
 *   buildShell 返回的 bounds（center/size）；radius 缺省时按包围球算
 * @param {object} opts
 *   · preset   轴测角（名字或 {azimuth,elevation}）
 *   · aspect   画面宽高比（W/H）
 *   · margin   四周留白比例（0.12 = 12%）
 *   · fit      取景基准：`'sphere'`（默认，保证整栋都进框）/ `'silhouette'`（按投影轮廓，更贴）
 * @returns {{position:[number,number,number], target:[number,number,number],
 *            left:number, right:number, top:number, bottom:number,
 *            near:number, far:number, distance:number, spanW:number, spanH:number}}
 */
export function axoFrame(bounds, opts = {}) {
  const b = bounds || {};
  const center = Array.isArray(b.center) && b.center.length === 3
    ? [num(b.center[0]), num(b.center[1]), num(b.center[2])]
    : [0, 0, 0];
  const size = Array.isArray(b.size) && b.size.length === 3
    ? [Math.max(1, num(b.size[0])), Math.max(1, num(b.size[1])), Math.max(1, num(b.size[2]))]
    : [100, 100, 100];
  const aspect = Math.max(0.1, num(opts.aspect, 16 / 9));
  const margin = Math.max(0, num(opts.margin, 0.12));

  const dir = axoDirection(opts.preset);
  // 相机沿 dir 退到"能把整栋套进视锥"的距离（正交下距离只影响裁剪，不影响大小）
  const radius = Number.isFinite(Number(b.radius))
    ? num(b.radius)
    : Math.hypot(size[0], size[1], size[2]) / 2;
  const distance = radius * 4 + 1000;

  const position = [
    center[0] + dir.x * distance,
    center[1] + dir.y * distance,
    center[2] + dir.z * distance,
  ];

  // 正交视锥：以包围球为基准（sphere）→ 任何朝向都不会切角
  let spanH = radius * 2;
  let spanW = spanH * aspect;
  if (opts.fit === 'silhouette') {
    // 按投影轮廓收紧：把包围盒 8 个角投到相机的右/上轴上取极值
    const right = { x: dir.z, y: 0, z: -dir.x };
    const rl = Math.hypot(right.x, right.z) || 1;
    const rx = right.x / rl;
    const rz = right.z / rl;
    const up = {
      x: -dir.y * rx, y: Math.hypot(dir.x, dir.z), z: -dir.y * rz,
    };
    const ul = Math.hypot(up.x, up.y, up.z) || 1;
    const ux = up.x / ul;
    const uy = up.y / ul;
    const uz = up.z / ul;

    let minR = Infinity; let maxR = -Infinity; let minU = Infinity; let maxU = -Infinity;
    for (const sx of [-0.5, 0.5]) {
      for (const sy of [-0.5, 0.5]) {
        for (const sz of [-0.5, 0.5]) {
          const px = size[0] * sx;
          const py = size[1] * sy;
          const pz = size[2] * sz;
          const pr = px * rx + pz * rz;
          const pu = px * ux + py * uy + pz * uz;
          if (pr < minR) minR = pr;
          if (pr > maxR) maxR = pr;
          if (pu < minU) minU = pu;
          if (pu > maxU) maxU = pu;
        }
      }
    }
    spanW = (maxR - minR);
    spanH = (maxU - minU);
    // 保持 aspect：谁更紧就按谁放大另一边
    if (spanW / spanH < aspect) spanW = spanH * aspect;
    else spanH = spanW / aspect;
  }

  const halfW = (spanW / 2) * (1 + margin);
  const halfH = (spanH / 2) * (1 + margin);

  return {
    position,
    target: center,
    left: -halfW,
    right: halfW,
    top: halfH,
    bottom: -halfH,
    near: 1,
    far: distance * 2 + radius * 4,
    distance,
    spanW: halfW * 2,
    spanH: halfH * 2,
  };
}

/**
 * 轴测出图的推荐画幅。
 *
 * 为什么默认 3:2 而不是 16:9：建筑插图多用于书籍/设定集内页，3:2 裁切余量更大；
 * 16:9 只在做屏幕壁纸/PPT 时才合适。
 */
export const AXO_CANVAS_PRESETS = Object.freeze({
  print: { width: 3600, height: 2400, label: '印刷 3600×2400（300dpi 的 A4 横）' },
  page: { width: 2400, height: 1600, label: '内页 2400×1600' },
  screen: { width: 1920, height: 1080, label: '屏幕 1920×1080' },
});

/** 取一个画幅预设（未知值回落 print） */
export function axoCanvas(name) {
  return AXO_CANVAS_PRESETS[name] || AXO_CANVAS_PRESETS.print;
}
