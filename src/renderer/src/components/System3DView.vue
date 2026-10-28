<template>
  <div class="sys3d" data-testid="system-3d">
    <div ref="host" class="sys3d-host"></div>

    <div class="sys3d-hud">
      <div class="sys3d-title">{{ spec.star.name }} 恒星系 · 3D 观景</div>
      <div class="sys3d-sub">
        拖拽旋转 · 滚轮缩放（0.5x–6x） · P 暂停公转 · Esc 返回 2D
        <span class="sys3d-count">{{ countsText }}</span>
      </div>
    </div>

    <div ref="fpsEl" class="sys3d-fps">-- fps</div>

    <button class="sys3d-close" data-testid="system-3d-close" @click="requestClose">
      <Icon name="x" :size="14" /> 返回 2D
    </button>

    <div v-if="status" class="sys3d-status" data-testid="system-3d-status">{{ status }}</div>
    <div v-if="error" class="sys3d-error" data-testid="system-3d-error">
      <div class="sys3d-error-title">3D 观景不可用</div>
      <div class="sys3d-error-body">{{ error }}</div>
      <button @click="requestClose">返回 2D</button>
    </div>
  </div>
</template>

<script setup>
/**
 * 星系 3D 观景（2026-10-27 计划 §1，独立一轮交付）
 *
 * 低配口径（SP-1025 已踩过，照抄）：AA 关 / 无阴影 / 24×16 低模 / MeshLambert / 像素比封顶 1.5 /
 * 关闭即遍历 dispose / OrbitControls 阻尼 / rAF + 可见性暂停。
 *
 * 四条必须守住的纪律：
 * 1) **three 不进首屏**：`await import('three')` 放在 onMounted 里 → Vite 单独出 chunk。
 * 2) **不留常驻动画**：页面不可见 / 卸载都 cancelAnimationFrame；场景只在挂载期存在。
 * 3) **资源归零**：geometry/material/texture 全进 `disposable`，关闭时逐个 dispose，
 *    再 `renderer.dispose()` + `forceContextLoss()`；`getStats().memoryAtDispose` 供验收读。
 * 4) **prop 名不叫 scene**：组件内已有 `scene`（three 场景）局部变量，同名 prop 会被 setup 绑定
 *    遮蔽，模板里 `scene.star.name` 直接炸。这里叫 `spec`。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { SeededRng, getPlanetTexture, hashString, hexAlpha, planetClassLabel } from '../utils/planetArt.js';

const props = defineProps({
  // buildSystem3dScene() 的产物；父组件每次打开时现算
  spec: { type: Object, required: true },
});
const emit = defineEmits(['close']);

const host = ref(null);
const fpsEl = ref(null);
const status = ref('正在加载 3D 引擎…');
const error = ref('');
const paused = ref(false);

const countsText = computed(() => {
  const c = props.spec?.counts || {};
  return `${c.planets ?? 0} 行星 · ${c.moons ?? 0} 卫星${c.stations ? ` · ${c.stations} 空间站` : ''}`;
});

// ===== three 运行期状态（刻意不进响应式：每帧改它会触发 Vue 重渲染） =====
let THREE = null;
let OrbitControlsCtor = null;
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let rafId = 0;
let destroyed = false;
let clockLast = 0;
const disposable = [];
const labels = [];
const orbits = [];
const projectVec = { v: null };
let lastFpsStamp = 0;
let framesSinceStamp = 0;

/** 关闭后的验收数据（也用于排查 WebGL 泄漏） */
const stats = {
  geometries: 0,
  textures: 0,
  memoryAtDispose: null,
  disposed: 0,
  frames: 0,
  labels: 0,
  error: '',
};

function track(d) {
  if (d && typeof d.dispose === 'function') {
    disposable.push(d);
    stats.disposed += 1;
  }
  return d;
}

function requestClose() {
  emit('close');
}

function onKey(e) {
  if (e.code === 'Escape') { e.preventDefault(); requestClose(); return; }
  if (e.code === 'KeyP') {
    paused.value = !paused.value;
    status.value = paused.value ? '已暂停公转（P 继续）' : '';
  }
}

function onVisibility() {
  if (document.hidden) stopLoop();
  else if (renderer) startLoop();
}

function onContextLost(e) {
  e.preventDefault();
  error.value = '显卡驱动丢失了 WebGL 上下文（GPU 崩溃或驱动重置）。关掉 3D、回 2D 即可，不影响项目数据。';
  stats.error = error.value;
  stopLoop();
}

function resize() {
  const el = host.value;
  if (!el || !renderer || !camera) return;
  const w = Math.max(1, el.clientWidth);
  const h = Math.max(1, el.clientHeight);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function makeGlowTexture(tint) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, hexAlpha(tint, 0.95));
  grad.addColorStop(0.25, hexAlpha(tint, 0.42));
  grad.addColorStop(0.6, hexAlpha(tint, 0.12));
  grad.addColorStop(1, hexAlpha(tint, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

function makeRingTexture() {
  // 环：竖向渐变条带（内缘淡 → 中段实 → 外缘淡），贴到 RingGeometry 的径向 UV 上
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(232, 214, 176, 0)');
  grad.addColorStop(0.35, 'rgba(232, 214, 176, 0.55)');
  grad.addColorStop(0.62, 'rgba(210, 186, 140, 0.75)');
  grad.addColorStop(1, 'rgba(232, 214, 176, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

function makeLimbTexture() {
  // 临边昏暗（limb darkening）：恒星是自发光体，用 MeshLambert 会得到"背光黑球"，
  // 用纯色 MeshBasic 又是一块平圆盘。这里叠一张**永远面向相机**的暗边 sprite，
  // 中心透明、边缘压暗 —— 廉价但立刻有球体的体积感。
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0)');
  grad.addColorStop(0.84, 'rgba(26,13,0,0.20)');
  grad.addColorStop(0.96, 'rgba(20,10,0,0.46)');
  grad.addColorStop(1, 'rgba(20,10,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

function buildScene() {
  const spec = props.spec;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04050c);

  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 4000);
  const maxOrbit = Math.max(spec.maxOrbit || 6, 6);
  // 初始取景：按"盘面半宽 maxOrbit / 俯角 36°"反算距离，横向与纵向都不裁。
  // （不要用固定 1.6*maxOrbit+14：窗口宽高比一变就是要么太远要么裁边 —— 第一版截图即如此）
  const el = host.value;
  const aspect = Math.max(0.6, (el?.clientWidth || 1600) / Math.max(1, el?.clientHeight || 900));
  const vFov = (48 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distH = (maxOrbit + 1.6) / Math.tan(hFov / 2);
  const distV = (maxOrbit * 0.55 + 2.2) / Math.tan(vFov / 2);
  // 1.28 的余量是量出来的：盘面靠近相机那一侧会被透视**放大**（第一版只留 1.04，
  // 最外圈轨道在 1280×800 下左右与底部同时出画，见 build/visual-audit/system3d/）。
  const dist = Math.max(14, Math.max(distH, distV) * 1.28);
  camera.position.set(0, dist * 0.55, dist * 0.84);

  controls = new OrbitControlsCtor(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = Math.max(4, spec.star.radius * 1.6);
  controls.maxDistance = maxOrbit * 4 + 40;
  controls.minPolarAngle = 0.18;
  controls.maxPolarAngle = Math.PI / 2 + 0.35;
  controls.rotateSpeed = 0.6;

  scene.add(new THREE.AmbientLight(0x4a5578, 0.85));
  const sunLight = new THREE.PointLight(new THREE.Color(spec.star.tint), 2.1, 0, 1.25);
  scene.add(sunLight);

  // 恒星：低模球 + 加色光晕（光晕不参与光照，纯观感）
  const starGeo = new THREE.SphereGeometry(spec.star.radius, 28, 20);
  const starMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(spec.star.tint) });
  const star = new THREE.Mesh(track(starGeo), track(starMat));
  star.name = 'star';
  scene.add(star);

  const glowMat = new THREE.SpriteMaterial({
    map: track(makeGlowTexture(spec.star.tint)),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(track(glowMat));
  glow.scale.setScalar(spec.star.radius * 5.6);
  scene.add(glow);
  // 内层亮核：平涂球面单看像一块橙色圆盘，叠一层小光晕才有"发光"的味道
  const coreMat = new THREE.SpriteMaterial({
    map: track(makeGlowTexture(spec.star.tint)),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
  });
  const core = new THREE.Sprite(track(coreMat));
  core.scale.setScalar(spec.star.radius * 2.4);
  scene.add(core);

  // 临边昏暗叠层：尺寸 = 恒星直径，depthTest 关掉（球面比 sprite 平面更靠近相机，
  // 开着深度测试会被整个吃掉），renderOrder 抬高保证压在恒星上。
  const limbMat = new THREE.SpriteMaterial({
    map: track(makeLimbTexture()),
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const limb = new THREE.Sprite(track(limbMat));
  limb.scale.setScalar(spec.star.radius * 2.02);
  limb.renderOrder = 3;
  scene.add(limb);

  for (const body of spec.bodies) {
    // 轨道环（128 段折线，比圆环更省）
    const pts = [];
    for (let k = 0; k < 128; k++) {
      const a = (k / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * body.orbit, 0, Math.sin(a) * body.orbit));
    }
    const orbitGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const orbitMat = new THREE.LineBasicMaterial({ color: 0x4a5a78, transparent: true, opacity: 0.32 });
    scene.add(new THREE.LineLoop(track(orbitGeo), track(orbitMat)));

    const pivot = new THREE.Object3D();
    pivot.rotation.y = body.phase;
    scene.add(pivot);

    const tex = new THREE.CanvasTexture(getPlanetTexture(body.classId));
    tex.encoding = THREE.sRGBEncoding;
    track(tex);
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const geo = body.kind === 'station'
      ? new THREE.OctahedronGeometry(body.size, 0)
      : new THREE.SphereGeometry(body.size, 24, 16);
    const mesh = new THREE.Mesh(track(geo), track(mat));
    mesh.rotation.z = body.tilt;
    // holder = 行星在轨道上的位置（pivot 只负责公转角度）。卫星/环挂 holder 而不是 mesh：
    // mesh 每帧自转，挂上去卫星轨道会跟着行星一起转（第一版真实踩过）。
    const holder = new THREE.Object3D();
    holder.position.set(body.orbit, 0, 0);
    pivot.add(holder);
    holder.add(mesh);

    if (body.ring) {
      const ringGeo = new THREE.RingGeometry(body.size * 1.35, body.size * 2.1, 64);
      const ringMat = new THREE.MeshBasicMaterial({
        map: track(makeRingTexture()),
        color: 0xd8c290,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(track(ringGeo), track(ringMat));
      ring.rotation.x = Math.PI / 2.25;
      holder.add(ring);
    }

    const moonPivots = [];
    for (const moon of body.moons) {
      const mGeo = new THREE.SphereGeometry(moon.size, 12, 8);
      const mMat = new THREE.MeshLambertMaterial({ color: 0xb8b4ac });
      const mMesh = new THREE.Mesh(track(mGeo), track(mMat));
      mMesh.position.set(moon.orbit, 0, 0);
      const mp = new THREE.Object3D();
      mp.rotation.y = moon.phase;
      mp.add(mMesh);
      // 卫星挂在母行星的**位置节点**上：公转时跟着走，但不吃行星自转
      holder.add(mp);

      const mPts = [];
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        mPts.push(new THREE.Vector3(Math.cos(a) * moon.orbit, 0, Math.sin(a) * moon.orbit));
      }
      const mOrbitGeo = new THREE.BufferGeometry().setFromPoints(mPts);
      const mOrbitMat = new THREE.LineBasicMaterial({ color: 0x8b949e, transparent: true, opacity: 0.18 });
      holder.add(new THREE.LineLoop(track(mOrbitGeo), track(mOrbitMat)));
      moonPivots.push({ pivot: mp, speed: moon.speed });
    }

    orbits.push({ pivot, mesh, speed: body.speed, moonPivots });

    // 名称标签（DOM 投影：比 Sprite + CanvasTexture 省一份纹理，且中文字形清楚）
    const el = document.createElement('div');
    el.className = 'sys3d-label';
    el.textContent = body.kind === 'station'
      ? body.name
      : `${body.name} · ${planetClassLabel(body.classId)}`;
    host.value.appendChild(el);
    labels.push({ el, mesh, offset: body.size + 0.45 });
  }

  // 小行星带：最内圈到最外圈之间（种子固定 → 每次打开位置一致）
  if (spec.bodies.length >= 2) {
    const rng = new SeededRng(hashString(`${spec.star.name}:belt`));
    const inner = Math.min(...spec.bodies.map((b) => b.orbit)) + 1.6;
    const outer = Math.max(...spec.bodies.map((b) => b.orbit)) - 1.2;
    if (outer > inner + 0.8) {
      const n = 720;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const a = rng.next() * Math.PI * 2;
        const r = inner + rng.next() * (outer - inner);
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = (rng.next() - 0.5) * 0.8;
        pos[i * 3 + 2] = Math.sin(a) * r;
      }
      const beltGeo = new THREE.BufferGeometry();
      beltGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const beltMat = new THREE.PointsMaterial({ color: 0x8a8578, size: 0.16, transparent: true, opacity: 0.7, depthWrite: false });
      const belt = new THREE.Points(track(beltGeo), track(beltMat));
      belt.name = 'belt';
      scene.add(belt);
    }
  }

  // 背景星空
  const srng = new SeededRng(hashString(`${spec.star.name}:stars`));
  const starN = 1400;
  const starPos = new Float32Array(starN * 3);
  for (let i = 0; i < starN; i++) {
    const r = 900 + srng.next() * 700;
    const t = srng.next() * Math.PI * 2;
    const ph = Math.acos(2 * srng.next() - 1);
    starPos[i * 3] = r * Math.sin(ph) * Math.cos(t);
    starPos[i * 3 + 1] = r * Math.cos(ph);
    starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(t);
  }
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const bgMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, transparent: true, opacity: 0.75, depthWrite: false });
  scene.add(new THREE.Points(track(bgGeo), track(bgMat)));

  projectVec.v = new THREE.Vector3();
  stats.geometries = renderer.info.memory.geometries;
  stats.textures = renderer.info.memory.textures;
  stats.labels = labels.length;
}

function animate() {
  rafId = 0;
  if (destroyed || !renderer || !scene || !camera) return;
  rafId = requestAnimationFrame(animate);

  const now = performance.now();
  const dt = clockLast ? Math.min(0.05, (now - clockLast) / 1000) : 0.016;
  clockLast = now;
  stats.frames += 1;

  if (!paused.value) {
    for (const o of orbits) {
      o.pivot.rotation.y += o.speed * dt;
      o.mesh.rotation.y += 0.25 * dt;
      for (const mp of o.moonPivots) mp.pivot.rotation.y += mp.speed * dt;
    }
  }
  controls.update();
  renderer.render(scene, camera);
  // three 的 info.memory 只在**渲染时**记账：构景刚结束读到的是 0，必须每帧同步一次，
  // 否则面板显示"0 geo / 0 tex"，验收也没法判断资源到底有没有真的分配/释放。
  stats.geometries = renderer.info.memory.geometries;
  stats.textures = renderer.info.memory.textures;

  // 标签投影：相机背后的隐藏（NDC z > 1）
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  for (const l of labels) {
    projectVec.v.setFromMatrixPosition(l.mesh.matrixWorld);
    projectVec.v.y += l.offset;
    projectVec.v.project(camera);
    if (projectVec.v.z > 1) {
      l.el.style.display = 'none';
      continue;
    }
    l.el.style.display = 'block';
    l.el.style.transform = `translate(-50%, -100%) translate(${((projectVec.v.x + 1) / 2) * w}px, ${((1 - projectVec.v.y) / 2) * h}px)`;
  }

  framesSinceStamp += 1;
  if (now - lastFpsStamp >= 500) {
    if (fpsEl.value) fpsEl.value.textContent = `${Math.round((framesSinceStamp * 1000) / (now - lastFpsStamp))} fps`;
    lastFpsStamp = now;
    framesSinceStamp = 0;
  }
}

function startLoop() {
  if (rafId || destroyed || !renderer) return;
  clockLast = 0;
  lastFpsStamp = performance.now();
  framesSinceStamp = 0;
  animate();
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function disposeAll() {
  stopLoop();
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', resize);
  document.removeEventListener('visibilitychange', onVisibility);
  if (renderer?.domElement) renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
  for (const l of labels) l.el.remove();
  labels.length = 0;
  orbits.length = 0;

  try { controls?.dispose(); } catch { /* 上下文已丢失时可能抛 */ }

  if (scene) {
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach((m) => m && m.dispose());
      else if (mat) mat.dispose();
    });
  }
  for (const d of disposable) {
    try { d.dispose(); } catch { /* 材质与列表可能各 dispose 一次，重复调用无害 */ }
  }
  disposable.length = 0;

  if (renderer) {
    // 记"遍历 dispose 之后"的计数：验收判据就是这两个数归零
    stats.memoryAtDispose = {
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    };
    renderer.dispose();
    if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
    renderer.domElement?.remove();
  }
  renderer = null;
  scene = null;
  camera = null;
  controls = null;
  projectVec.v = null;
  if (fpsEl.value) fpsEl.value.textContent = '-- fps';
}

async function init() {
  try {
    // 动态 import：首屏 bundle 不含 three（构建产物检查见 docs/agents-archive/views.md）
    THREE = await import('three');
    const mod = await import('three/examples/jsm/controls/OrbitControls.js');
    if (destroyed) return;
    OrbitControlsCtor = mod.OrbitControls;

    const canvas = document.createElement('canvas');
    canvas.className = 'sys3d-canvas';
    canvas.setAttribute('data-testid', 'system-3d-canvas');
    host.value.appendChild(canvas);

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (e) {
      error.value = `当前环境无法创建 WebGL 上下文（${e && e.message ? e.message : '未知原因'}）。3D 观景需要开启硬件加速。`;
      stats.error = error.value;
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = false;
    renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);

    buildScene();
    resize();
    status.value = '';
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    startLoop();
  } catch (e) {
    error.value = `3D 模块加载失败：${e && e.message ? e.message : String(e)}`;
    stats.error = error.value;
  }
}

onMounted(init);

onBeforeUnmount(() => {
  destroyed = true;
  disposeAll();
});

/** 验收/测试入口：读运行期统计（关闭后仍可读，因为对象在父组件手里） */
function getStats() {
  return { ...stats, memoryAtDispose: stats.memoryAtDispose ? { ...stats.memoryAtDispose } : null };
}
defineExpose({ getStats, paused });
</script>

<style scoped>
.sys3d {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: #04050c;
  overflow: hidden;
}
.sys3d-host { position: absolute; inset: 0; }
.sys3d-host :deep(canvas.sys3d-canvas) { display: block; width: 100%; height: 100%; }
.sys3d-hud {
  position: absolute;
  top: 14px; left: 18px;
  color: #cfd8ea;
  pointer-events: none;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.9);
}
.sys3d-title { font-size: 15px; font-weight: 600; letter-spacing: 0.04em; }
.sys3d-sub { margin-top: 4px; font-size: 11px; color: #8b98b3; }
.sys3d-count { margin-left: 8px; color: #6f7d99; }
.sys3d-fps {
  position: absolute; top: 14px; right: 16px;
  font: 11px/1 ui-monospace, monospace;
  color: #5f6c85;
  pointer-events: none;
}
.sys3d-close {
  position: absolute; right: 16px; bottom: 16px;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px;
  border: 1px solid rgba(140, 160, 200, 0.35);
  border-radius: 6px;
  background: rgba(16, 22, 36, 0.82);
  color: #cfd8ea;
  font-size: 12px;
  cursor: pointer;
}
.sys3d-close:hover { background: rgba(30, 42, 64, 0.92); }
.sys3d-status {
  position: absolute; left: 50%; bottom: 22px;
  transform: translateX(-50%);
  font-size: 12px; color: #8b98b3;
  pointer-events: none;
}
.sys3d-error {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  background: rgba(6, 8, 14, 0.94);
  color: #d7dee9;
  text-align: center;
  padding: 24px;
}
.sys3d-error-title { font-size: 16px; font-weight: 600; color: #ff8f8f; }
.sys3d-error-body { font-size: 12px; color: #9aa6bd; max-width: 420px; line-height: 1.7; }
.sys3d-error button {
  margin-top: 6px; padding: 6px 14px;
  border: 1px solid rgba(140, 160, 200, 0.35);
  border-radius: 6px; background: rgba(24, 32, 48, 0.9); color: #cfd8ea; cursor: pointer;
}
</style>

<style>
/* 标签是运行时 append 到 host 的 DOM，scoped 选不到 → 用非 scoped 的全局类名（前缀唯一） */
.sys3d-label {
  position: absolute;
  top: 0;
  left: 0;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(8, 12, 20, 0.55);
  color: #c3cde0;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  pointer-events: none;
  will-change: transform;
}
</style>
