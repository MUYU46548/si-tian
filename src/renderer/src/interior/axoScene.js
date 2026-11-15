/**
 * 单栋建筑的**轴测插图**渲染（2026-11-15）。
 *
 * ## 和实时预览的区别（不是同一套观感）
 *
 * | | 实时预览（ExteriorView） | 轴测插图（本文件） |
 * |---|---|---|
 * | 相机 | 45° 透视 | **正交**（平行线不收敛） |
 * | 线 | 无 | **EdgesGeometry 墨线**（隐藏线靠深度缓冲自动剔除） |
 * | 材质 | Standard + 高光 + ACES | **Lambert 平涂**（插图不要高光） |
 * | 产物 | 屏幕 | 3600×2400 PNG，贴设定集 |
 *
 * ⚠️ 不 import three：THREE 由调用方传进来（`ExteriorView` 已经是动态 import 的那一处，
 * 两条路共用同一个模块实例；本文件自己 import 会让 three 被静态打进 chunk）。
 */

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 插图配色（纸上制图）：墙浅暖灰、屋顶两种、玻璃淡蓝、线近黑 */
export const AXO_COLORS = Object.freeze({
  paper: '#f6f3ea',
  ground: '#e9e4d8',
  line: '#2f343b',
  glass: '#bcd3e0',
  roofGable: '#c8b7a2',
  roofFlat: '#cfc9bd',
});

/**
 * 把 buildShell 的盒子/坡面变成"可描边"的场景。
 *
 * 为什么不复用 InstancedMesh：`EdgesGeometry` 只能作用于单个几何体，
 * InstancedMesh 没有"每实例边线"。插图是**一次性离屏渲染**（不是每帧），
 * 几百个 Mesh 的 draw call 完全可以接受。
 */
export function buildAxoScene(THREE, shell, opts = {}) {
  const scene = new THREE.Scene();
  const paper = opts.paper || AXO_COLORS.paper;
  scene.background = new THREE.Color(paper).convertSRGBToLinear();

  const group = new THREE.Group();
  const disposables = [];
  const track = (x) => {
    disposables.push(x);
    return x;
  };

  const lineMat = track(new THREE.LineBasicMaterial({
    color: new THREE.Color(AXO_COLORS.line).convertSRGBToLinear(),
    transparent: true,
    opacity: 0.9,
  }));

  // polygonOffset：把面往后推一点点，边线才能压在面上（否则共面被深度裁掉，线断成一截一截）
  const solidMat = (hex) => track(new THREE.MeshLambertMaterial({
    color: new THREE.Color(hex).convertSRGBToLinear(),
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }));

  const edgeCache = new Map();
  const edgeOf = (geo) => {
    if (!edgeCache.has(geo)) edgeCache.set(geo, track(new THREE.EdgesGeometry(geo, 1)));
    return edgeCache.get(geo);
  };

  // ① 盒子（墙 / 楼板 / 门窗框 / 平顶）
  for (const b of shell.boxes || []) {
    const geo = track(new THREE.BoxGeometry(num(b.sx, 1), num(b.sy, 1), num(b.sz, 1)));
    const isGlass = b.kind === 'window';
    const mat = isGlass
      ? track(new THREE.MeshLambertMaterial({
        color: new THREE.Color(AXO_COLORS.glass).convertSRGBToLinear(),
        transparent: true,
        opacity: 0.55,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }))
      : solidMat(b.color || '#e6e1d6');
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(num(b.cx), num(b.cy), num(b.cz));
    mesh.rotation.y = num(b.rotY, 0);
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
      for (const p of t || []) pos.push(p[0], p[1], p[2]);
    }
    if (!pos.length) continue;
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, solidMat(s.color || '#d8d3c8'));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  // ② 坡面（三/四边形）：扇形三角化 + 外轮廓描边
  for (const face of (shell.roof && shell.roof.faces) || []) {
    if (!face || face.length < 3) continue;
    const pos = [];
    for (let i = 1; i < face.length - 1; i++) {
      for (const p of [face[0], face[i], face[i + 1]]) pos.push(p[0], p[1], p[2]);
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mat = solidMat(opts.roofColor || AXO_COLORS.roofGable);
    const roofMesh = new THREE.Mesh(geo, mat);
    roofMesh.castShadow = true;
    group.add(roofMesh);

    // 轮廓：按面的顶点顺序连线（闭合）
    const lp = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      lp.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    const lgeo = track(new THREE.BufferGeometry());
    lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    group.add(new THREE.LineSegments(lgeo, lineMat));
  }

  // ③ 地面（一块纸色板，给建筑一个"落在地上"的依据，不画边线）
  const bounds = shell.bounds || {};
  const size = Array.isArray(bounds.size) ? bounds.size : [1000, 300, 1000];
  const center = Array.isArray(bounds.center) ? bounds.center : [0, 0, 0];
  const groundSize = Math.max(size[0], size[2]) * 3 + 2000;
  const gGeo = track(new THREE.PlaneGeometry(groundSize, groundSize));
  const gMat = track(new THREE.MeshLambertMaterial({
    color: new THREE.Color(opts.ground || AXO_COLORS.ground).convertSRGBToLinear(),
  }));
  const ground = new THREE.Mesh(gGeo, gMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center[0], num(bounds.min && bounds.min[1], -1) - 0.5, center[2]);
  ground.receiveShadow = true;
  group.add(ground);

  scene.add(group);

  // ④ 光：主光从左前上方（与轴测角一致 → 两个可见立面一明一暗）
  // 环境光压低到 0.42：第一版是 0.62，两个立面亮度几乎一样，整栋像一块白积木。
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
    // 范围要盖住"整栋 + 影子伸出去的那一截"（第一版只按包围盒*0.9，右侧影子被裁出一个缺口）
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

  return { scene, group, disposables };
}

/**
 * 渲染一张轴测图，返回 dataURL。
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
  const frame = opts.frame;
  const canvasSize = opts.canvas || { width: 3600, height: 2400 };
  const W = Math.max(64, Math.round(num(canvasSize.width, 3600)));
  const H = Math.max(64, Math.round(num(canvasSize.height, 2400)));

  const built = buildAxoScene(THREE, shell, opts);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;

  const renderer = new THREE.WebGLRenderer({
    canvas: cv,
    antialias: true,
    preserveDrawingBuffer: true,   // 要 toDataURL，必须留缓冲
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
  const dataUrl = cv.toDataURL('image/png');

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
  renderer.dispose();
  if (renderer.forceContextLoss) renderer.forceContextLoss();

  return { dataUrl, width: W, height: H, drawCalls };
}
