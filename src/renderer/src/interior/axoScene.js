/**
 * 单栋建筑的**轴测插图**渲染（2026-11-15；2026-11-16 加比例人/树、墙面色阶、图注）
 *
 * ## 和实时预览的区别（不是同一套观感）
 *
 * | | 实时预览（ExteriorView） | 轴测插图（本文件） |
 * |---|---|---|
 * | 相机 | 45° 透视 | **正交**（平行线不收敛） |
 * | 线 | 无 | **EdgesGeometry 墨线**（隐藏线靠深度缓冲自动剔除） |
 * | 材质 | Standard + 高光 + ACES | **四档平涂**（受光/侧光/背光/深背光，查表来的） |
 * | 产物 | 屏幕 | 3600×2400 PNG（下半截是图注条），贴设定集 |
 *
 * ⚠️ 不 import three：THREE 由调用方传进来（`ExteriorView` 已经是动态 import 的那一处，
 * 两条路共用同一个模块实例；本文件自己 import 会让 three 被静态打进 chunk）。
 *
 * ## 2026-11-16 这一轮加的三样（都是“这张图能不能读”的问题）
 *
 * 1) **墙面色阶**：以前每个盒子吃连续光照，两个立面只差一点点，纸上糊成一片。
 *    现在按**面法向**查四档明度（`axoProps.wallTone`）写进顶点色 —— 一块面一个色；
 *    顺带补了墙脚的勒脚带（`AXO_COLORS.plinth`），立面才有“下重上轻”。
 * 2) **比例人与树**：黑白剪影，站在楼的左前方（朝向相机那一侧，永远不会被楼挡住）。
 *    没有尺度的插图，读者读不出“这房子多高”。
 * 3) **图注**：成品图下半截另起一条纸带，写名称 / 层数 / 占地 / 投影角 / 方位（指北针）/ 比例人。
 *    为什么另起一条而不是盖在图上：建筑在图里是贴地的，盖上去必然压住墙脚 ——
 *    那正是读者最需要看清的地方。
 */

import { fitText } from './planSheet.js';
import { axoDirection } from './axonometric.js';
import { earClip } from './triangulate.js';
import {
  AXO_TONES,
  axialTone,
  axoSheetPlan,
  propPlacements,
  personSilhouette,
  toneColor,
  treeSilhouette,
  wallTone,
} from './axoProps.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 插图配色（纸上制图）：墙浅暖灰、屋顶两种、玻璃淡蓝、线近黑 */
export const AXO_COLORS = Object.freeze({
  paper: '#f6f3ea',
  ground: '#e9e4d8',
  line: '#2f343b',
  inkSoft: '#5c626b',
  glass: '#bcd3e0',
  roofGable: '#c8b7a2',
  roofFlat: '#cfc9bd',
  plinth: '#b6ab97',
  figure: '#22262c',
  treeTrunk: '#4a3b2f',
  treeCrown: '#3c4a3f',
  road: '#c9bfa8',        // 聚落路面（比地面深一档才看得出是路；初版 #ded5c2 和地面几乎同色）
  plainWall: '#d6cfc0',   // 没画内部的建筑（体块）：比有内部图的墙浅一档
});

// ── 平涂：面的颜色全部写进顶点色 ─────────────────────────────────────────

/** BoxGeometry 的六个面法向（局部坐标），顺序与它的顶点排列一一对应（每面 4 个顶点） */
const BOX_FACES = Object.freeze([
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
]);

/** 三角面法向（右手）；退化三角形回落到“朝上”，免得算出 NaN 把整块面涂黑 */
function faceNormal(tri) {
  if (!Array.isArray(tri) || tri.length < 3) return { x: 0, y: 1, z: 0 };
  const [a, b, c] = tri;
  const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
  const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-9)) return { x: 0, y: 1, z: 0 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** 一整块面一个颜色（顶点色），tone 是 `axoProps.wallTone` 给出的明度系数 */
function paintFlat(THREE, geo, hex, tone) {
  const n = Math.max(1, geo.attributes.position.count);
  // 乘法在 **sRGB** 里做（先乘出十六进制、再转线性）：three 的顶点色是线性量，
  // 直接乘线性值再进 sRGB 输出，眼睛看到的差别只有一半（0.74 看着像 0.87）——
  // 第一版就是这样，两个立面「还是一样白」。toneColor 是这件事的唯一实现。
  const col = new THREE.Color(toneColor(hex, tone)).convertSRGBToLinear();
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    data[i * 3] = col.r;
    data[i * 3 + 1] = col.g;
    data[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(data, 3));
}

/** 盒子逐面取档：六个面各拿一个明度 —— 两个可见立面因此是**两个色块**，不是一段渐变 */
function paintBoxFaces(THREE, geo, hex, rotY) {
  const count = geo.attributes.position.count;
  const data = new Float32Array(count * 3);
  const toneHex = BOX_FACES.map((f) => new THREE.Color(toneColor(hex, axialTone(f, rotY))).convertSRGBToLinear());
  for (let i = 0; i < count; i++) {
    const col = toneHex[Math.min(BOX_FACES.length - 1, Math.floor(i / 4))] || toneHex[2];
    data[i * 3] = col.r;
    data[i * 3 + 1] = col.g;
    data[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(data, 3));
}

/** 勒脚：墙脚一圈深色基座。只在**贴地的墙**上长（楼上的墙也长就成了积木腰线） */
const PLINTH = Object.freeze({ height: 42, out: 1.5 });

/**
 * 把勒脚盒并进盒子表。
 * 每侧外扩 1.5cm —— 齐平的话整块被墙盖住，等于没画；外扩之后在轴测里是一条 2~4px 的暗边。
 */
function withPlinths(shell, opts) {
  const list = Array.isArray(shell && shell.boxes) ? shell.boxes : [];
  if (opts && opts.plinth === false) return list;
  const groundY = num(shell && shell.bounds && shell.bounds.min && shell.bounds.min[1], 0);
  const extra = [];
  for (const b of list) {
    if (!b || b.kind !== 'wall') continue;
    const bottom = num(b.cy) - num(b.sy) / 2;
    if (Math.abs(bottom - groundY) > 2) continue;
    const h = Math.min(PLINTH.height, num(b.sy));
    if (!(h > 4)) continue;
    extra.push({
      ...b,
      kind: 'plinth',
      color: AXO_COLORS.plinth,
      cy: bottom + h / 2,
      sy: h,
      sx: num(b.sx) + PLINTH.out * 2,
      sz: num(b.sz) + PLINTH.out * 2,
    });
  }
  return extra.length ? list.concat(extra) : list;
}



/**
 * 把 buildShell 的盒子/坡面变成"可描边"的场景。
 *
 * 为什么不复用 InstancedMesh：`EdgesGeometry` 只能作用于单个几何体，
 * InstancedMesh 没有"每实例边线"。插图是**一次性离屏渲染**（不是每帧），
 * 几百个 Mesh 的 draw call 完全可以接受。
 */
// ── 场景装配的可复用件（单栋插图 / 聚落鸟瞰 共用）────────────────────────

/** 一次性渲染的资源登记 + 三种共用材质。`disposables` 由调用方负责释放 */
function paintCtx(THREE, opts) {
  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };
  const lineMat = track(new THREE.LineBasicMaterial({
    color: new THREE.Color(AXO_COLORS.line).convertSRGBToLinear(),
    transparent: true,
    opacity: 0.9,
  }));
  // 平涂材质（2026-11-16）：颜色全在**顶点色**里（每个面一个档），材质只当壳用。
  // 为什么不用 MeshLambert：连续明暗在纸上糊成一片渐变，两个立面差得又不够；
  // 试作里的建筑插图都是“一块面一个色”，色块边界才立得住。
  const flatMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  // 玻璃单独一份：半透明 + 顶点色（同一个着色逻辑，只是要透）
  const glassMat = track(new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.55,
  }));
  const edgeCache = new Map();
  const edgeOf = (geo) => {
    if (!edgeCache.has(geo)) edgeCache.set(geo, track(new THREE.EdgesGeometry(geo, 1)));
    return edgeCache.get(geo);
  };
  return { opts, disposables, track, lineMat, flatMat, glassMat, edgeOf };
}

/**
 * 把一栋楼的盒子 / 房间地面 / 坡面塞进 group（可整体平移 —— 聚落鸟瞰靠这个摆位）。
 * @param {number[]} offset [dx,dy,dz]，单位 cm
 */
function addShellGeometry(THREE, group, c, shell, offset = [0, 0, 0]) {
  const ox = num(offset[0]);
  const oy = num(offset[1]);
  const oz = num(offset[2]);
  const { track, lineMat, flatMat, glassMat, edgeOf, opts } = c;

  // ① 盒子（墙 / 楼板 / 门窗框 / 平顶）+ 勒脚带
  for (const b of withPlinths(shell, opts)) {
    const rotY = num(b.rotY, 0);
    const geo = track(new THREE.BoxGeometry(num(b.sx, 1), num(b.sy, 1), num(b.sz, 1)));
    const isGlass = b.kind === 'window';
    paintBoxFaces(THREE, geo, b.color || (isGlass ? AXO_COLORS.glass : '#e6e1d6'), rotY);
    const mesh = new THREE.Mesh(geo, isGlass ? glassMat : flatMat);
    mesh.position.set(num(b.cx) + ox, num(b.cy) + oy, num(b.cz) + oz);
    mesh.rotation.y = rotY;
    // 只投影、**不接收**：体块建筑一旦自阴影，屋顶会被自己投出的影子盖出"塌陷斑"
    // （第四版截图里左上坡面那块不规则暗区就是它）。插图的明暗只该由朝向决定。
    mesh.castShadow = true;
    group.add(mesh);

    const edges = new THREE.LineSegments(edgeOf(geo), lineMat);
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    group.add(edges);
  }

  // ①.5 房间地面 / 吊顶面（2026-11-15，A23/A15）：一块面一个 mesh（面数本来就不多）
  //
  // 为什么必须补这里：`exportAxo` 拿的是 `lastShell`，而插图镜头**看不见组合层的顶点色**，
  // 漏了这一段就是“视口里铺了地板、出图上是白地”，用户会拿两张图对不上。
  // 插图风格本来就不吃光照阴影（只按朝向分面），所以不投影、不接收。
  for (const s of shell.surfaces || []) {
    if (!s || !Array.isArray(s.tris) || !s.tris.length) continue;
    const pos = [];
    for (const t of s.tris) {
      for (const p of t || []) pos.push(p[0] + ox, p[1] + oy, p[2] + oz);
    }
    if (!pos.length) continue;
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    // 房间地面都是水平的 → 一个档就够（按第一个三角面算，别逐面）
    paintFlat(THREE, geo, s.color || '#d8d3c8', wallTone(faceNormal(s.tris[0])));
    const mesh = new THREE.Mesh(geo, flatMat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  // ② 坡面（三/四边形）：扇形三角化 + 外轮廓描边。每个坡面按**自己的朝向**取档 ——
  //    两个坡面一亮一暗，屋顶才是“坡”而不是一块板。
  for (const face of (shell.roof && shell.roof.faces) || []) {
    if (!face || face.length < 3) continue;
    const pos = [];
    for (let i = 1; i < face.length - 1; i++) {
      for (const p of [face[0], face[i], face[i + 1]]) pos.push(p[0] + ox, p[1] + oy, p[2] + oz);
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    paintFlat(THREE, geo, opts.roofColor || AXO_COLORS.roofGable, wallTone(faceNormal(face)));
    const roofMesh = new THREE.Mesh(geo, flatMat);
    roofMesh.castShadow = true;
    group.add(roofMesh);

    // 轮廓：按面的顶点顺序连线（闭合）
    const lp = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      lp.push(a[0] + ox, a[1] + oy, a[2] + oz, b[0] + ox, b[1] + oy, b[2] + oz);
    }
    const lgeo = track(new THREE.BufferGeometry());
    lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    group.add(new THREE.LineSegments(lgeo, lineMat));
  }
}

/** 地面（一块纸色板，给建筑一个"落在地上"的依据，不画边线） */
function addGround(THREE, group, c, bounds, opts = {}) {
  const { track } = c;
  const size = Array.isArray(bounds.size) ? bounds.size : [1000, 300, 1000];
  const center = Array.isArray(bounds.center) ? bounds.center : [0, 0, 0];
  // 地面板尺寸可调（2026-11-16）：
  //   单栋插图默认 3 倍 + 2m → 铺满整幅（地面色本来就和纸几乎同色，读起来就是"纸"；
  //   边界留在画面里反而会在四角冒出一条淡色斜边，比不铺还难看）；
  //   聚落是**基地平面**，传 1.35 倍 —— 那儿要看得见"地块边界"。
  const groundScale = num(opts.groundScale, 3);
  const groundPadCm = num(opts.groundPadCm, 2000);
  const groundSize = Math.max(size[0], size[2]) * groundScale + groundPadCm;
  const gGeo = track(new THREE.PlaneGeometry(groundSize, groundSize));
  const gMat = track(new THREE.MeshLambertMaterial({
    color: new THREE.Color(opts.ground || AXO_COLORS.ground).convertSRGBToLinear(),
  }));
  const ground = new THREE.Mesh(gGeo, gMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center[0], num((bounds.min || [])[1], -1) - 0.5, center[2]);
  ground.receiveShadow = true;
  group.add(ground);
}

/** 光：主光从左前上方（与轴测角一致 → 两个可见立面一明一暗）+ 一盏补光 */
function addSunLights(THREE, scene, size, opts = {}) {
  const ambient = new THREE.AmbientLight(0xffffff, 0.42);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 0.86);
  // 🔴 方向光只看方向，但**阴影相机是挂在 position 上的**：position 太近（第一版只写了方向量，
  //    距原点 3 个单位）→ 建筑有一半落在近裁剪面后面 → 地面阴影缺一块（截图里右下那个直角缺口）。
  //    乘一个远距离，方向不变，整栋都进得了阴影相机的视锥。
  sun.position.set(-1.2, 2.4, 1.6).multiplyScalar(3000);
  // 落影（2026-11-15）：不开阴影时房子是"飘在纸上的"，一眼假。只渲一次，成本可接受。
  if (opts.shadow !== false) {
    sun.castShadow = true;
    // 4096：3600px 的成品图上，2048 的影子边缘会是一格一格的锯齿
    sun.shadow.mapSize.set(4096, 4096);
    // 范围要盖住"整片内容 + 影子伸出去的那一截"（只按包围盒*0.9 会裁出缺口）
    const r = Math.hypot(num(size[0], 100), num(size[1], 100), num(size[2], 100)) * 2.2 + 400;
    const cam = sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1; cam.far = 12000;
    cam.updateProjectionMatrix();
    // 别让阴影边缘糊成一团灰（体块建筑的影子要"硬"才像手绘）
    if ('radius' in sun.shadow) sun.shadow.radius = 2;
    if ('bias' in sun.shadow) sun.shadow.bias = -0.0005;
  }
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.2);
  fill.position.set(1.4, 0.5, -1.2);
  scene.add(fill);
}


export function buildAxoScene(THREE, shell, opts = {}) {
  const c = paintCtx(THREE, opts);
  const scene = new THREE.Scene();
  const paper = opts.paper || AXO_COLORS.paper;
  scene.background = new THREE.Color(paper).convertSRGBToLinear();
  const group = new THREE.Group();

  addShellGeometry(THREE, group, c, shell, [0, 0, 0]);

  // ②.5 比例人 / 树（2026-11-16）：**面向相机的平面**（正交下等于 1:1 的立面剪影），
  //     站在地面、楼的左前方。用 Basic 材质（不吃光），剪影才是纯墨色。
  const props = opts.propsList !== undefined
    ? (Array.isArray(opts.propsList) ? opts.propsList : [])
    : (opts.props === false ? [] : propPlacements(shell.bounds, { preset: opts.preset }));
  if (props.length) {
    const dir = axoDirection(opts.preset || 'iso');
    for (const prop of props) {
      if (!prop) continue;
      const sil = prop.kind === 'tree' ? treeSilhouette(prop.heightCm) : personSilhouette(prop.heightCm);
      const at = Array.isArray(prop.at) ? prop.at : [0, 0, 0];
      for (const part of sil.parts) {
        const pts = (part.points || []).map((p) => new THREE.Vector2(num(p[0]), num(p[1])));
        if (pts.length < 3) continue;
        const shape = c.track(new THREE.Shape(pts));
        const geo = c.track(new THREE.ShapeGeometry(shape));
        const hex = part.kind === 'crown'
          ? AXO_COLORS.treeCrown
          : (part.kind === 'trunk' ? AXO_COLORS.treeTrunk : AXO_COLORS.figure);
        paintFlat(THREE, geo, hex, AXO_TONES.lit);
        const mat = c.track(new THREE.MeshBasicMaterial({
          vertexColors: true, side: THREE.DoubleSide,
        }));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(num(at[0]), num(at[1]), num(at[2]));
        // 平面默认朝 +Z；让它正对相机 = 画面上永远是“站直的人”，不会斜着躺在地上
        mesh.lookAt(new THREE.Vector3(
          num(at[0]) + dir.x * 1000,
          num(at[1]) + dir.y * 1000,
          num(at[2]) + dir.z * 1000,
        ));
        mesh.castShadow = true;
        group.add(mesh);
      }
    }
  }

  const bounds = shell.bounds || {};
  addGround(THREE, group, c, bounds, opts);
  scene.add(group);
  addSunLights(THREE, scene, Array.isArray(bounds.size) ? bounds.size : [1000, 300, 1000], opts);

  return { scene, group, disposables: c.disposables };
}

/**
 * 把场景渲进一张离屏 canvas（**不**释放之前的中间产物由调用方负责）。
 * 单独拆出来的原因：成品图要在这张图上再叠一条图注纸带，所以必须拿到 canvas 本身。
 *
 * @param {object} THREE
 * @param {object} shell buildShell 的结果
 * @param {object} opts { frame, canvas, roofColor / paper / ground, propsList, preset, shadow }
 * @returns {{canvas:HTMLCanvasElement, width:number, height:number, drawCalls:number}}
 */
function renderSceneCanvas(THREE, built, opts = {}) {
  const frame = opts.frame;
  const canvasSize = opts.canvas || { width: 3600, height: 2400 };
  const W = Math.max(64, Math.round(num(canvasSize.width, 3600)));
  const H = Math.max(64, Math.round(num(canvasSize.height, 2400)));

  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;

  const renderer = new THREE.WebGLRenderer({
    canvas: cv,
    antialias: true,
    preserveDrawingBuffer: true,   // 要把画面再画到成品画布上，必须留缓冲
    alpha: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  if (opts.shadow !== false) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;

  const camera = new THREE.OrthographicCamera(
    frame.left, frame.right, frame.top, frame.bottom, frame.near, frame.far,
  );
  camera.position.set(frame.position[0], frame.position[1], frame.position[2]);
  // three 的相机默认看 -Z；用手写 lookAt 而不是 OrbitControls（导出不需要交互）
  camera.lookAt(frame.target[0], frame.target[1], frame.target[2]);
  camera.updateProjectionMatrix();

  renderer.render(built.scene, camera);

  // 清干净：一张图渲完就该释放（几十 MB 的几何/纹理不该留在内存里）
  for (const d of built.disposables) {
    try { d.dispose(); } catch (e) { /* 已释放 */ }
  }
  built.scene.traverse((o) => {
    if (o.geometry && !built.disposables.includes(o.geometry)) {
      try { o.geometry.dispose(); } catch (e) { /* ignore */ }
    }
  });
  const drawCalls = renderer.info && renderer.info.render ? renderer.info.render.calls : 0;
  // 🔴 不在这里 forceContextLoss：成品图还要先把这张 canvas 画到成品画布上。
  // 丢了上下文之后再 drawImage 只会得到一片透明/黑（2026-11-16 实测：整张图空白、
  // 只剩图注纸带）。释放交给调用方，在取完 dataURL 之后调 dispose()。
  const dispose = () => {
    try { renderer.dispose(); } catch (e) { /* 已释放 */ }
    try { if (renderer.forceContextLoss) renderer.forceContextLoss(); } catch (e) { /* 已释放 */ }
  };

  return { canvas: cv, width: W, height: H, drawCalls, dispose };
}

/**
 * 渲染一张轴测图，返回 dataURL（**只有图，没有图注**；成品走 `renderAxoSheet`）。
 *
 * @param {object} THREE three 模块
 * @param {object} shell buildShell 的结果
 * @param {object} opts
 *   · frame    `axoFrame()` 的结果（相机取景）
 *   · canvas   `axoCanvas()` 的结果（{width,height}）
 *   · roofColor / paper / ground  配色覆盖
 * @returns {{dataUrl:string, width:number, height:number, drawCalls:number}}
 */
export function renderAxoToDataUrl(THREE, shell, opts = {}) {
  const inner = renderSceneCanvas(THREE, buildAxoScene(THREE, shell, opts), opts);
  const dataUrl = inner.canvas.toDataURL('image/png');
  inner.dispose();
  return {
    dataUrl,
    width: inner.width,
    height: inner.height,
    drawCalls: inner.drawCalls,
  };
}

// ── 图注纸带（2D，纯画）───────────────────────────────────────────────

function sheetFont(size, weight = '400') {
  return `${weight} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
}

/** 指北针：箭头方向由 `axoProps.northScreenVector()` 给出（画布坐标，y 向下） */
function drawCompass(ctx, cx, cy, r, north) {
  const nx = num(north && north.x, 0);
  const ny = num(north && north.y, -1);
  const len = Math.hypot(nx, ny) || 1;
  const ux = nx / len;
  const uy = ny / len;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = AXO_COLORS.line;
  ctx.fillStyle = AXO_COLORS.line;
  ctx.lineWidth = Math.max(1, r * 0.045);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  // 箭头：尖端指向北，底边垂直于它
  const px = -uy;
  const py = ux;
  const tipX = ux * r * 0.84;
  const tipY = uy * r * 0.84;
  const bx = ux * r * 0.02;
  const by = uy * r * 0.02;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(bx + px * r * 0.3, by + py * r * 0.3);
  ctx.lineTo(bx - px * r * 0.3, by - py * r * 0.3);
  ctx.closePath();
  ctx.fill();
  // “北”写在箭头指的那一侧外面（跟着转，不会跑到圆里压住针）
  ctx.font = sheetFont(Math.round(r * 0.52), '600');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('北', ux * r * 1.3, uy * r * 1.3);
  ctx.restore();
}

/**
 * 把图注画到成品画布上。ctx 的坐标系 = 成品图像素（**不要**预先 scale）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} plan `axoSheetPlan()` 的结果（用到 `band`）
 * @param {object} model `axoCaptionModel()` 的结果
 */
export function drawAxoSheet(ctx, plan, model) {
  const b = plan && plan.band;
  if (!ctx || !b) return;
  const m = model || {};
  const pad = num(b.pad, Math.round(b.w * 0.022));
  const titleSize = Math.round(b.h * 0.30);
  const subSize = Math.round(b.h * 0.115);
  const labelSize = Math.round(b.h * 0.092);
  const valueSize = Math.round(b.h * 0.125);
  const tinySize = Math.round(b.h * 0.088);

  ctx.save();
  // 纸带
  ctx.fillStyle = AXO_COLORS.paper;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  // 一条细线把图和字分开（两边同色，不画线就分不清“下面是图注”）
  ctx.strokeStyle = AXO_COLORS.line;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = Math.max(1, Math.round(b.h * 0.008));
  ctx.beginPath();
  ctx.moveTo(b.x + pad, b.y + 2);
  ctx.lineTo(b.x + b.w - pad, b.y + 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const compassR = Math.max(14, Math.round(b.h * 0.15));
  const compassCx = b.x + b.w - pad - compassR;
  const titleMax = Math.max(120, b.w * 0.34 - pad);

  // 左：图名 + 一行副题 + 一行说明
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = AXO_COLORS.line;
  ctx.font = sheetFont(titleSize, '600');
  ctx.fillText(fitText(ctx, String(m.title || ''), titleMax), b.x + pad, b.y + Math.round(b.h * 0.46));

  ctx.fillStyle = AXO_COLORS.inkSoft;
  ctx.font = sheetFont(subSize, '400');
  ctx.fillText(fitText(ctx, String(m.subtitle || ''), titleMax), b.x + pad, b.y + Math.round(b.h * 0.68));

  ctx.font = sheetFont(tinySize, '400');
  ctx.fillText(fitText(ctx, String(m.note || ''), titleMax * 1.1), b.x + pad, b.y + Math.round(b.h * 0.90));

  // 中：格子（层数 / 占地 / 投影 / 方位 / 屋顶）
  const cells = Array.isArray(m.cells) ? m.cells : [];
  if (cells.length) {
    const x0 = b.x + pad + Math.round(b.w * 0.36);
    const x1 = compassCx - compassR - Math.round(pad * 0.7);
    const colW = Math.max(40, (x1 - x0) / cells.length);
    cells.forEach((c, i) => {
      const cx = x0 + colW * i;
      ctx.fillStyle = AXO_COLORS.inkSoft;
      ctx.font = sheetFont(labelSize, '400');
      ctx.fillText(fitText(ctx, String(c.label || ''), colW - 12), cx, b.y + Math.round(b.h * 0.34));
      ctx.fillStyle = AXO_COLORS.line;
      ctx.font = sheetFont(valueSize, '600');
      ctx.fillText(fitText(ctx, String(c.value || ''), colW - 12), cx, b.y + Math.round(b.h * 0.66));
    });
  }

  // 右：指北针 + 出处
  drawCompass(ctx, compassCx, b.y + b.h * 0.46, compassR, m.north);
  ctx.fillStyle = AXO_COLORS.inkSoft;
  ctx.font = sheetFont(tinySize, '400');
  ctx.textAlign = 'right';
  ctx.fillText(String(m.footer || ''), b.x + b.w - pad, b.y + Math.round(b.h * 0.90));
  ctx.restore();
}

/**
 * 出**成品插图**：3D 渲到上面一块，下面接一条图注纸带，返回 dataURL。
 *
 * @param {object} THREE
 * @param {object} shell
 * @param {object} opts
 *   · frame / canvas / roofColor / paper / ground / propsList / preset / shadow  同 `renderAxoToDataUrl`
 *   · plan     `axoSheetPlan()` 的结果（调用方拿它算取景宽高比，所以由调用方建）
 *   · caption  `axoCaptionModel()` 的结果；不传 = 只有图（用于对照探针）
 */
export function renderAxoSheet(THREE, shell, opts = {}) {
  const caption = (opts.caption && typeof opts.caption === 'object') ? opts.caption : null;
  const plan = opts.plan || axoSheetPlan(opts.canvas, { caption: !!caption });
  const sceneOpts = { ...opts, canvas: plan.render };
  const inner = renderSceneCanvas(THREE, buildAxoScene(THREE, shell, sceneOpts), sceneOpts);

  const W = plan.canvas.width;
  const H = plan.canvas.height;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('拿不到画布上下文');
  ctx.fillStyle = AXO_COLORS.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(inner.canvas, 0, 0);
  if (caption && plan.band) drawAxoSheet(ctx, plan, caption);
  const dataUrl = out.toDataURL('image/png');

  // 释放：WebGL 渲染器要等**画完/取完**才放（先放会丢上下文），两张中间画布也一样
  inner.dispose();
  inner.canvas.width = 0;
  inner.canvas.height = 0;
  out.width = 0;
  out.height = 0;

  return { dataUrl, width: W, height: H, drawCalls: inner.drawCalls };
}


// ── 聚落鸟瞰（2026-11-16）────────────────────────────────────────────────
//
// 与单栋插图共用同一套平涂/墨线/俯视落影，区别只有三点：
//   · 一次画多栋（每栋一个 shell + 自己的偏移）；
//   · 地面先铺一块大板，再铺道路（路面是折线偏移出来的带，见 `settlement.roadRibbon`）；
//   · 图注用聚落的说法（建筑/道路/镇域），并加一根**比例尺** ——
//     镇子尺度下“一个 1.70 m 的人”只有几个像素，尺子才是对的参照物。

/** 道路：折线带 → 地面上的浅色面 + 一圈墨线 */
function addRoads(THREE, group, c, roads) {
  const y = 1.5;   // 抬高 1.5cm：与地面共面会闪（z-fighting）
  for (const r of Array.isArray(roads) ? roads : []) {
    const poly = ((r && r.poly) || [])
      .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
      .map((p) => ({ x: num(p.x), y: num(p.y) }));
    if (poly.length < 3) continue;
    const tris = earClip(poly);
    if (!tris.length) continue;
    const pos = [];
    for (const t of tris) for (const p of t) pos.push(p.x, y, p.y);
    const geo = c.track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    // 路面水平 → 一档就够。颜色用插图自己的，**不跟地图上的道路色**：
    // 地图上那是屏幕配色（橙黄），印在纸上会变成一条刺眼的带子。
    paintFlat(THREE, geo, AXO_COLORS.road, wallTone({ x: 0, y: 1, z: 0 }));
    // 双面：路带的绕序一旦反了，单面材质会把整块路面剔掉、只剩两圈线
    // （第一版就这样“只有路缘没有路面”）。绕序在 settlement 里已统一成逆时针，这里是保险。
    const roadMat = c.track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    const mesh = new THREE.Mesh(geo, roadMat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    // 边线：闭合一圈（两条边各一条，路面才读得出宽度）
    const lp = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      lp.push(a.x, y, a.y, b.x, y, b.y);
    }
    const lgeo = c.track(new THREE.BufferGeometry());
    lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    group.add(new THREE.LineSegments(lgeo, c.lineMat));
  }
}

/**
 * 聚落场景：地面 + 若干栋（每栋一个 shell + 偏移）+ 道路。
 *
 * @param {Array<{shell:object, offset:number[]}>} items
 * @param {object} opts { bounds, roads, shadow, paper, ground }
 */
export function buildSettlementScene(THREE, items, opts = {}) {
  const c = paintCtx(THREE, opts);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.paper || AXO_COLORS.paper).convertSRGBToLinear();
  const group = new THREE.Group();
  const bounds = opts.bounds || {
    min: [0, 0, 0], max: [0, 0, 0], size: [1000, 300, 1000], center: [0, 0, 0],
  };
  addGround(THREE, group, c, bounds, opts);
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.shell || it.shell.empty) continue;
    addShellGeometry(THREE, group, c, it.shell, it.offset || [0, 0, 0]);
  }
  addRoads(THREE, group, c, opts.roads);
  scene.add(group);
  addSunLights(THREE, scene, bounds.size, opts);
  return { scene, group, disposables: c.disposables };
}

/**
 * 比例尺（画在图面左下角）。
 *
 * 为什么画在**图面**上而不是图注条里：图注条那点高度塞不下“尺子 + 三段刻度字”，
 * 而图面左下角通常是空纸（地面板是斜的菱形，左下角在板子外面）。
 */
function drawScaleBarOnSheet(ctx, plan, bar) {
  const ticks = Array.isArray(bar && bar.ticks) ? bar.ticks : [];
  if (!bar || !(bar.px > 0)) return;
  const W = plan.canvas.width;
  const unit = W / 3600;                       // 以 3600 宽为基准的尺寸单位
  const pad = Math.round(W * 0.022);
  const barH = Math.max(8, Math.round(22 * unit));
  const x = pad + Math.round(24 * unit);
  const y = plan.render.height - pad - Math.round(46 * unit);
  const font = Math.max(12, Math.round(38 * unit));

  ctx.save();
  // 白底浮片（制图惯例）：地面是浅色，尺子直接压上去会糊
  ctx.fillStyle = 'rgba(246,243,234,0.88)';
  ctx.strokeStyle = AXO_COLORS.line;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = Math.max(1, Math.round(1.5 * unit));
  const plateW = bar.px + Math.round(48 * unit);
  const plateH = barH + Math.round(74 * unit);
  ctx.beginPath();
  ctx.rect(x - Math.round(16 * unit), y - Math.round(34 * unit), plateW, plateH);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 三格黑白交替
  const seg = bar.px / 3;
  ctx.strokeStyle = AXO_COLORS.line;
  ctx.fillStyle = AXO_COLORS.line;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.rect(x + i * seg, y, seg, barH);
    if (i % 2 === 0) ctx.fill();
    else ctx.stroke();
  }
  ctx.lineWidth = Math.max(1, Math.round(1.5 * unit));
  ctx.strokeRect(x, y, bar.px, barH);

  // 刻度文字：0 / 中 / 全长
  ctx.font = `400 ${font}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.fillStyle = AXO_COLORS.line;
  ctx.textBaseline = 'top';
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (i === 0) ctx.textAlign = 'left';
    else if (i === ticks.length - 1) ctx.textAlign = 'right';
    else ctx.textAlign = 'center';
    ctx.fillText(String(t.label || ''), x + num(t.px), y + barH + Math.round(6 * unit));
  }
  ctx.restore();
}

/**
 * 出**聚落插图**：地面 + 多栋 + 道路 + 比例尺 + 图注纸带，返回 dataURL。
 *
 * @param {Array} items [{ shell, offset }]
 * @param {object} opts { frame, plan, caption, roads, bounds, shadow, paper, ground }
 */
export function renderSettlementSheet(THREE, items, opts = {}) {
  const caption = (opts.caption && typeof opts.caption === 'object') ? opts.caption : null;
  const plan = opts.plan || axoSheetPlan(opts.canvas, { caption: !!caption });
  const sceneOpts = { ...opts, canvas: plan.render };
  const inner = renderSceneCanvas(THREE, buildSettlementScene(THREE, items, sceneOpts), sceneOpts);

  const W = plan.canvas.width;
  const H = plan.canvas.height;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('拿不到画布上下文');
  ctx.fillStyle = AXO_COLORS.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(inner.canvas, 0, 0);
  if (caption) drawScaleBarOnSheet(ctx, plan, caption.scaleBar);
  if (caption && plan.band) drawAxoSheet(ctx, plan, caption);
  const dataUrl = out.toDataURL('image/png');

  // 释放：渲染器要等取完图才放（先放会丢上下文）
  inner.dispose();
  inner.canvas.width = 0;
  inner.canvas.height = 0;
  out.width = 0;
  out.height = 0;
  return { dataUrl, width: W, height: H, drawCalls: inner.drawCalls };
}
