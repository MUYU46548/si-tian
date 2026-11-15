<template>
  <div class="exterior-view" data-testid="exterior-view">
    <div class="ex-top">
      <div class="ex-title">
        <Icon name="cube" :size="15" />
        <span>{{ buildingName || '建筑' }} — 外观</span>
      </div>
      <div class="ex-stats" data-testid="exterior-stats">{{ statsText }}</div>
      <div class="ex-actions">
        <label class="ex-roof">
          <span>楼层</span>
          <select v-model="floorPick" data-testid="exterior-floor-pick"
                  title="只看某一层：楼板会挡住下层，想看下层布置就切到那一层（切过去会自动去掉屋顶）">
            <option value="all">全部楼层</option>
            <option v-for="f in floorOptions" :key="f.id" :value="f.id">{{ f.label }}</option>
          </select>
        </label>
        <label class="ex-roof">
          <span>屋顶</span>
          <select v-model="roofKind" data-testid="exterior-roof-kind" title="去掉屋顶就能看见内部：楼梯、楼板洞口">
            <option value="gable">坡顶</option>
            <option value="flat">平顶</option>
            <option value="none">不封顶（看内部）</option>
          </select>
        </label>
        <label class="ex-roof">
          <span>角度</span>
          <select v-model="axoPreset" data-testid="exterior-axo-preset" title="轴测出图用的投影角度">
            <option value="iso">等轴测 45°/35°</option>
            <option value="dimetric">二测 2:1</option>
            <option value="high">高视 45°/60°</option>
          </select>
        </label>
        <button class="ex-btn" @click="exportAxo" :disabled="!ready || axoBusy || emptyBuilding"
                data-testid="exterior-axo-export"
                :title="emptyBuilding ? '这栋楼还没有墙，没有可出的图' : '把当前屋顶/楼层渲成一张轴测插图（3600×2400，带墨线），存成 PNG'">
          {{ axoBusy ? '出图中…' : '轴测出图' }}
        </button>
        <span v-if="axoMsg" class="ex-axo-msg" :class="{ err: axoMsgErr }" data-testid="exterior-axo-msg">{{ axoMsg }}</span>
        <button class="ex-btn" @click="resetView" :disabled="!ready" title="回到初始机位">复位视角</button>
        <button class="ex-btn primary" @click="$emit('close')" title="回到平面图">关闭</button>
      </div>
    </div>

    <div ref="host" class="ex-host" data-testid="exterior-host"></div>

    <div v-if="error" class="ex-fallback" data-testid="exterior-fallback">
      <Icon name="alert-circle" :size="18" />
      <p>{{ error }}</p>
      <p class="ex-fallback-sub">平面图不受影响。3D 预览需要浏览器能创建 WebGL 上下文（一般要求开启硬件加速）。</p>
    </div>
    <div v-else-if="status" class="ex-loading">{{ status }}</div>

    <div class="ex-hint" v-if="ready">左键拖拽旋转 · 滚轮缩放 · 右键平移</div>
    <div class="ex-empty" v-if="emptyBuilding && !error">
      这栋楼还没有墙。先回到平面图画几面墙，外观会自动长出来。
    </div>
  </div>
</template>

<script setup>
/**
 * 建筑外观（3D）—— 2026-11-14 第一版
 *
 * 定位：**同一份楼层数据的第二种渲染**。几何全在 `interior/buildShell.js`（纯函数、有单测），
 * 这里只负责"把方盒和三角面塞进 three"。所以 2D 平面图改了，3D 立刻就是改后的样子，不存在双源。
 *
 * 四条照抄星系 3D 的纪律（那边踩过）：
 * 1) three 动态 import，不进首屏；
 * 2) 打开才建、关闭即 dispose（几何/材质/贴图全清），不留常驻动画；
 * 3) 两个 InstancedMesh 画完所有墙（不透明 / 玻璃各一），几百个盒子也只有 2 次 draw call；
 * 4) WebGL 拿不到时给**明确退路**（不是白屏、不是静默失败）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { buildBuildingShell, ROOF_DEFAULTS, SHELL_COLORS } from '../interior/buildShell';
// 轴测插图：取景（纯函数、可单测）与离屏渲染分开，后者只在这里用（three 已是动态 import）
import { axoFrame, axoCanvas } from '../interior/axonometric';
import { renderAxoToDataUrl, AXO_COLORS } from '../interior/axoScene';
// 只看某一层（A20 余）：过滤口径是纯函数，Node 可测
import { ALL_FLOORS, floorViewOptions, floorsForView, floorViewLabel } from '../interior/floorView';
import { formatLength } from '../utils/interiorUnits';

const props = defineProps({
  buildingName: { type: String, default: '' },
  floors: { type: Array, default: () => [] },
  roofKind: { type: String, default: 'gable' },
});
const emit = defineEmits(['close']);

const host = ref(null);
const status = ref('正在加载 3D 引擎…');
const error = ref('');
const ready = ref(false);
const roofKind = ref(props.roofKind === 'flat' ? 'flat' : 'gable');
// 只看某一层（A20 余）：'all' = 全部楼层。
// 为什么需要它：两层楼的整体轴测里一层被二层楼板压着（物理正确），
// 想看下层布置只能删楼上 —— 那是拿数据换视图，不对。
const floorPick = ref(ALL_FLOORS);
const floorOptions = computed(() => floorViewOptions(props.floors));
// 真正送进几何层的那份楼层：pick 为全部时就是 props.floors 本身（同一引用，不白重建）
const viewFloors = computed(() => floorsForView(props.floors, floorPick.value));
const emptyBuilding = ref(false);
const shellStats = ref({ floors: 0, walls: 0, openings: 0, height: 0 });

// ===== 轴测出图（2026-11-15）=====
const axoPreset = ref('iso');
const axoBusy = ref(false);
const axoMsg = ref('');
const axoMsgErr = ref(false);
let axoMsgTimer = 0;

function setAxoMsg(text, isErr = false) {
  axoMsg.value = text;
  axoMsgErr.value = isErr;
  if (axoMsgTimer) clearTimeout(axoMsgTimer);
  // 失败不设 TTL（"失败要看得见"是本项目纪律）；成功 5 秒淡出
  axoMsgTimer = window.setTimeout(() => {
    if (!isErr) { axoMsg.value = ''; axoMsgTimer = 0; }
  }, 5000);
}

const statsText = computed(() => {
  const s = shellStats.value;
  if (!s.walls) return '无墙体';
  const pickLabel = floorViewLabel(props.floors, floorPick.value);
  const scope = pickLabel ? `只看 ${pickLabel} · ` : '';
  const h = s.height > 0 ? ` · 高 ${formatLength(s.height)}` : '';
  const st = s.stairs > 0 ? ` · ${s.stairs} 部楼梯` : '';
  const fu = s.furniture > 0 ? ` · ${s.furniture} 件家具` : '';
  const co = s.columns > 0 ? ` · ${s.columns} 根柱` : '';
  return `${scope}${s.floors} 层 · ${s.walls} 面墙 · ${s.openings} 处门窗${st}${co}${fu}${h}`;
});

let THREE = null;
let OrbitControlsCtor = null;
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let raf = 0;
let renderCount = 0;
let destroyed = false;
let resizeObs = null;
let lastShell = null;
let buildingGroup = null;

// 可释放资源：几何 / 材质 / 贴图统一登记，关掉时逐个 dispose
const disposable = [];
const track = (x) => { if (x) disposable.push(x); return x; };
/** 颜色：先按 sRGB 解释再转线性（r128 不做色彩管理，直接塞十六进制会整体发白） */
const sc = (hex) => new THREE.Color(hex).convertSRGBToLinear();

function disposeAll() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  if (resizeObs) { try { resizeObs.disconnect(); } catch (e) { /* 忽略 */ } resizeObs = null; }
  if (controls) { try { controls.dispose(); } catch (e) { /* 忽略 */ } controls = null; }
  if (scene) {
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    });
    scene.clear();
    scene = null;
  }
  for (const d of disposable) { try { d.dispose(); } catch (e) { /* 忽略 */ } }
  disposable.length = 0;
  if (renderer) {
    try {
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    } catch (e) { /* 忽略 */ }
    renderer = null;
  }
  buildingGroup = null;
  camera = null;
}

// ── 场景 ────────────────────────────────────────────────────────────────

/** 假接触阴影：径向渐变贴图。比开 shadowMap 便宜一个数量级，观感够用。 */
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 12, 128, 128, 128);
  g.addColorStop(0, 'rgba(30,34,40,0.55)');
  g.addColorStop(0.55, 'rgba(30,34,40,0.22)');
  g.addColorStop(1, 'rgba(30,34,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

function clearBuilding() {
  if (!buildingGroup || !scene) return;
  scene.remove(buildingGroup);
  buildingGroup.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
  buildingGroup = null;
}

/** 把外壳几何塞进场景（box 分不透明/玻璃两批，用 InstancedMesh） */
function buildBuildingMesh(shell) {
  buildingGroup = new THREE.Group();
  const opaque = shell.boxes.filter((b) => b.kind !== 'window');
  const glass = shell.boxes.filter((b) => b.kind === 'window');

  const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const mat = track(new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 }));
  const mesh = new THREE.InstancedMesh(boxGeo, mat, Math.max(1, opaque.length));
  mesh.frustumCulled = false;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const axisY = new THREE.Vector3(0, 1, 0);
  opaque.forEach((b, i) => {
    q.setFromAxisAngle(axisY, b.rotY || 0);
    pos.set(b.cx, b.cy, b.cz);
    scl.set(b.sx, b.sy, b.sz);
    m4.compose(pos, q, scl);
    mesh.setMatrixAt(i, m4);
    mesh.setColorAt(i, sc(b.color));
  });
  mesh.count = opaque.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  buildingGroup.add(mesh);

  if (glass.length) {
    const gm = track(new THREE.MeshStandardMaterial({
      roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.5,
    }));
    const gmesh = new THREE.InstancedMesh(boxGeo, gm, Math.max(1, glass.length));
    gmesh.frustumCulled = false;
    // 玻璃会比外墙早退 0.5cm 之外的位置：就是墙厚中心，正好嵌在洞里
    glass.forEach((b, i) => {
      q.setFromAxisAngle(axisY, b.rotY || 0);
      pos.set(b.cx, b.cy, b.cz);
      scl.set(b.sx, b.sy, b.sz);
      m4.compose(pos, q, scl);
      gmesh.setMatrixAt(i, m4);
      gmesh.setColorAt(i, sc(b.color));
    });
    gmesh.count = glass.length;
    gmesh.instanceMatrix.needsUpdate = true;
    if (gmesh.instanceColor) gmesh.instanceColor.needsUpdate = true;
    buildingGroup.add(gmesh);
  }

  // 屋顶坡面（坡顶才有面；平顶是盒子，已在上面那批里）
  const faces = shell.roof?.faces || [];
  if (faces.length) {
    // 🔴 法线必须按**面**给：直接用三角面算，四边形坡面中间会多一条对角折痕
    // （第一版截图里就是"拼板"缝）。这里把一个面的法线写给它的每个顶点。
    const pos = [];
    const nor = [];
    const normal = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    for (const face of faces) {
      const [a, b, c] = face;
      e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      normal.crossVectors(e1, e2).normalize();
      // 面按扇形拆三角（3 点 1 个，4 点 2 个）
      for (let i = 1; i < face.length - 1; i++) {
        for (const p of [face[0], face[i], face[i + 1]]) {
          pos.push(p[0], p[1], p[2]);
          nor.push(normal.x, normal.y, normal.z);
        }
      }
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    const rmat = track(new THREE.MeshStandardMaterial({
      color: sc(SHELL_COLORS.roofGable),
      roughness: 0.85,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }));
    buildingGroup.add(new THREE.Mesh(geo, rmat));
  }

  scene.add(buildingGroup);
}

/** 地面 + 接触阴影（跟着建筑尺寸走） */
function buildGround(shell) {
  const parent = buildingGroup || scene;
  const size = Math.max(2000, Math.max(shell.bounds.size[0], shell.bounds.size[2]) * 6);
  const groundGeo = track(new THREE.PlaneGeometry(size, size));
  const groundMat = track(new THREE.MeshStandardMaterial({ color: sc('#eceae5'), roughness: 1 }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(shell.bounds.center[0], -0.6, shell.bounds.center[2]);
  parent.add(ground);

  const tex = track(shadowTexture());
  const sgeo = track(new THREE.PlaneGeometry(1, 1));
  const smat = track(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  const shadow = new THREE.Mesh(sgeo, smat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(shell.bounds.center[0], 0.4, shell.bounds.center[2]);
  shadow.scale.set(
    Math.max(400, shell.bounds.size[0] * 1.5),
    Math.max(400, shell.bounds.size[2] * 1.5),
    1,
  );
  parent.add(shadow);
}

function placeCamera(shell) {
  if (!camera || !controls) return;
  const b = shell.bounds;
  const radius = Math.max(150, Math.hypot(b.size[0], b.size[1], b.size[2]) / 2);
  const fov = (camera.fov * Math.PI) / 180;
  const el = host.value;
  const aspect = Math.max(0.5, (el?.clientWidth || 1200) / Math.max(1, el?.clientHeight || 800));
  // 竖向按 fov 反算，横向按 aspect 补：窄窗口自动退远，不裁边
  let dist = radius / Math.sin(fov / 2) * 0.98;
  if (aspect < 1.3) dist *= 1.3 / aspect;
  const target = new THREE.Vector3(b.center[0], b.center[1] * 0.85, b.center[2]);
  const dir = new THREE.Vector3(0.55, 0.46, 0.92).normalize();
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.near = Math.max(1, dist / 500);
  camera.far = dist * 12;
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.minDistance = radius * 0.35;
  controls.maxDistance = dist * 3.2;
  controls.update();
}

function rebuild() {
  if (!scene) return;
  clearBuilding();
  const shell = buildBuildingShell(viewFloors.value, { roof: { kind: roofKind.value } });
  lastShell = shell;
  emptyBuilding.value = shell.empty;
  shellStats.value = { ...shell.stats, height: shell.bounds.size[1] };
  if (shell.empty) {
    status.value = '';
    return;
  }
  buildBuildingMesh(shell);
  buildGround(shell);
  placeCamera(shell);
  // 雾放在取景之后：距离按相机到目标的距离定，近处完全不受影响，只吃掉地面远端边界
  if (scene && camera) {
    const d = camera.position.distanceTo(controls ? controls.target : new THREE.Vector3());
    scene.fog = new THREE.Fog(sc('#eceae5'), d * 1.5, d * 3.6);
  }
  status.value = '';
  startLoop();
}

/**
 * 轴测出图（2026-11-15）。
 *
 * 为什么不用主视口那个 renderer：主视口是 `preserveDrawingBuffer: false`（省显存），
 * 且 3600×2400 会把正在看的画面抖一下。这里另起一个离屏 renderer，
 * 渲完立刻 dispose —— 一次性开销，不影响交互。
 */
async function exportAxo() {
  if (axoBusy.value) return;
  if (!lastShell || lastShell.empty) {
    setAxoMsg('这栋楼还没有墙，没有可出的图', true);
    return;
  }
  if (!THREE) {
    setAxoMsg('3D 引擎还没加载完，稍等一下再点', true);
    return;
  }
  axoBusy.value = true;
  setAxoMsg('正在渲染轴测图…');
  // 让浏览器先把"出图中…"画出来，再做重活（否则用户以为按钮没反应）
  await new Promise((r) => setTimeout(r, 30));
  try {
    const canvasSize = axoCanvas('print');
    const frame = axoFrame(lastShell.bounds, {
      preset: axoPreset.value,
      aspect: canvasSize.width / canvasSize.height,
      margin: 0.08,
      fit: 'silhouette',
    });
    const out = renderAxoToDataUrl(THREE, lastShell, {
      frame,
      canvas: canvasSize,
      roofColor: roofKind.value === 'flat' ? AXO_COLORS.roofFlat : AXO_COLORS.roofGable,
    });
    const name = `${props.buildingName || '建筑'}-轴测.png`.replace(/[\\/:*?"<>|]/g, '_');
    const api = window.sitianAPI;
    if (!api || !api.saveExportFile) throw new Error('当前环境不支持导出（缺少保存通道）');
    const r = await api.saveExportFile({ dataUrl: out.dataUrl, defaultName: name });
    if (r && r.success) {
      setAxoMsg(`已导出 ${out.width}×${out.height}：${(r.path || name).split(/[\\/]/).pop()}`);
    } else if (r && r.canceled) {
      setAxoMsg('');
    } else {
      setAxoMsg(`导出失败：${(r && r.error) || '未知原因'}`, true);
    }
  } catch (e) {
    setAxoMsg(`出图失败：${e && e.message ? e.message : String(e)}`, true);
  } finally {
    axoBusy.value = false;
  }
}

function resetView() {
  if (lastShell && !lastShell.empty) placeCamera(lastShell);
}

// ── 初始化 ──────────────────────────────────────────────────────────────

function resize() {
  if (!renderer || !camera || !host.value) return;
  const w = Math.max(1, host.value.clientWidth);
  const h = Math.max(1, host.value.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  startLoop();
}

// 🔴 **按需渲染，不跑常驻 60fps 循环**（2026-11-14 用户："CPU 负载这么大，用户电脑撑得住吗"）。
// 第一版照抄星系 3D 的 rAF 循环：静止不动时也每秒画 60 帧 —— 一个不动的房子也把 CPU/GPU 烧满。
// 现在：只在"画面真的会变"的时候画一帧（转视角、缩放、改屋顶、窗口大小变），
// 静止下来下一帧就停（OrbitControls.update() 在阻尼停住后返回 false）。
function startLoop() {
  if (document.hidden || destroyed || raf) return;
  raf = requestAnimationFrame(tick);
}

function tick() {
  raf = 0;
  if (destroyed || !renderer || !scene || !camera) return;
  const moved = controls ? controls.update() === true : false;
  renderer.render(scene, camera);
  renderCount++;
  // 阻尼还在滑就再来一帧；停住了就收工（静止时 CPU 占用 = 0）
  if (moved) startLoop();
}

function onVisibility() {
  if (document.hidden) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  } else {
    startLoop();
  }
}

async function init() {
  // 先把几何算出来（纯函数、不依赖 three）：这样即使这台机器拿不到 WebGL，
  // 顶栏的“几层/几面墙/几处门窗/多高”照样是对的 —— 不给用户一片空白。
  try {
    const pre = buildBuildingShell(viewFloors.value, { roof: { kind: roofKind.value } });
    lastShell = pre;
    emptyBuilding.value = pre.empty;
    shellStats.value = { ...pre.stats, height: pre.bounds.size[1] };
  } catch (e) {
    error.value = `外观几何计算失败：${e && e.message ? e.message : String(e)}`;
  }
  try {
    THREE = await import('three');
    const mod = await import('three/examples/jsm/controls/OrbitControls.js');
    if (destroyed) return;
    OrbitControlsCtor = mod.OrbitControls;

    const canvas = document.createElement('canvas');
    canvas.className = 'ex-canvas';
    canvas.setAttribute('data-testid', 'exterior-canvas');
    host.value.appendChild(canvas);

    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch (e) {
      error.value = `这台机器没能创建 WebGL 上下文（${e && e.message ? e.message : '未知原因'}）。`;
      status.value = '';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    // 高光收一收：第一版三盏灯直接叠出 2.1 的强度，墙被推到接近纯白，
    // 门窗、楼层分隔带全糊在一起。ACES 会滚降高光，暗部也更垂得住。
    if ('toneMapping' in renderer) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
    }
    renderer.shadowMap.enabled = false;

    scene = new THREE.Scene();
    scene.background = sc('#eceae5');

    camera = new THREE.PerspectiveCamera(45, 1, 10, 100000);

    scene.add(new THREE.HemisphereLight(sc('#eef2f7'), sc('#b6ada0'), 0.42));
    // 主光：从左前上方来 → 正面(+z)受光、右侧(+x)入影，两个可见面才分得出体积。
    // （第一版主光和相机同向，等于正面打光，整栋看起来像一块白色积木。）
    const sun = new THREE.DirectionalLight(sc('#fff6e2'), 2.1);
    sun.position.set(-1.4, 2.6, 2.4).multiplyScalar(1000);
    scene.add(sun);
    // 补光只提暗部，不抢主光
    const fill = new THREE.DirectionalLight(sc('#dfe8f2'), 0.28);
    fill.position.set(1.2, 0.6, -1.0).multiplyScalar(1000);
    scene.add(fill);

    controls = new OrbitControlsCtor(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;   // 不许钻到地面以下
    controls.screenSpacePanning = false;
    controls.rotateSpeed = 0.65;
    // 用户一转/一缩就画（阻尼期间 update() 也会触发 change，循环自己会续上）
    controls.addEventListener('change', startLoop);

    ready.value = true;
    rebuild();
    resize();
    if (typeof ResizeObserver !== 'undefined' && host.value) {
      resizeObs = new ResizeObserver(() => resize());
      resizeObs.observe(host.value);
    }
    window.addEventListener('resize', () => { resize(); startLoop(); });
    document.addEventListener('visibilitychange', onVisibility);
    startLoop();
  } catch (e) {
    error.value = `3D 模块加载失败：${e && e.message ? e.message : String(e)}`;
    status.value = '';
  }
}

onMounted(init);

onBeforeUnmount(() => {
  destroyed = true;
  document.removeEventListener('visibilitychange', onVisibility);
  disposeAll();
});

// 屋顶样式切换 / 楼层数据变化 / 只看某一层 → 重建（数据改了立刻反映，不留旧壳）
watch(roofKind, () => { if (ready.value) rebuild(); });
watch(() => props.floors, () => { if (ready.value) rebuild(); }, { deep: true });
// 切到单层时自动把屋顶切成“不封顶”：选这一层就是为了看里面的布置，
// 留着屋顶等于什么都没看见。用户随时可以自己改回坡顶（这里只在切换那一刻动一次）。
watch(floorPick, (v) => {
  if (v !== ALL_FLOORS && roofKind.value !== 'none') roofKind.value = 'none';
  if (ready.value) rebuild();
});
// 选中的楼层被删掉（平面图上删层）→ 回落“全部楼层”，不留一个指向空值的下拉
watch(floorOptions, (opts) => {
  if (floorPick.value !== ALL_FLOORS && !opts.some((o) => o.id === floorPick.value)) {
    floorPick.value = ALL_FLOORS;
  }
});

defineExpose({
  // renders = 本次打开累计渲染帧数。静止时应停止增长（验收"按需渲染"用）
  getStats: () => ({ ready: ready.value, error: error.value, renders: renderCount, stats: { ...shellStats.value } }),
  resetView,
});
</script>

<style scoped>
.exterior-view {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  background: #f4f5f7;
}
.ex-top {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  border-bottom: 1px solid #dfe3e8;
  background: #fff;
  flex-wrap: wrap;
}
.ex-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #2b3138;
}
.ex-stats {
  font-size: 12px;
  color: #6b7280;
}
.ex-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ex-roof {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #4b5563;
}
.ex-roof select {
  height: 24px;
  font-size: 12px;
  color: #2b3138;
  background: #fff;
  border: 1px solid #d5dae1;
  border-radius: 4px;
  padding: 0 4px;
}
.ex-btn {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
  color: #2b3138;
  background: #fff;
  border: 1px solid #d5dae1;
  border-radius: 4px;
  cursor: pointer;
  min-width: 64px;
}
.ex-btn:hover:not(:disabled) { background: #f1f3f6; }
.ex-btn:disabled { opacity: 0.5; cursor: default; }
.ex-btn.primary { background: #3b6ea5; border-color: #3b6ea5; color: #fff; }
.ex-btn.primary:hover { background: #345f8d; }
.ex-host {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.ex-host :deep(canvas.ex-canvas) {
  display: block;
  width: 100%;
  height: 100%;
}
.ex-loading {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 13px;
  color: #4b5563;
  background: rgba(255, 255, 255, 0.86);
  padding: 10px 16px;
  border-radius: 6px;
}
.ex-fallback {
  position: absolute;
  left: 50%;
  top: 46%;
  transform: translate(-50%, -50%);
  max-width: 460px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
  color: #8a4b2a;
  background: #fff8f2;
  border: 1px solid #f0dcc8;
  border-radius: 8px;
  padding: 18px 22px;
  font-size: 13px;
  line-height: 1.6;
}
.ex-fallback p { margin: 0; }
.ex-fallback-sub { color: #7c6a5c; font-size: 12px; }
.ex-axo-msg {
  font-size: 11px;
  color: #9fb0c0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ex-axo-msg.err { color: #e0705f; }

.ex-hint {
  position: absolute;
  left: 12px;
  bottom: 10px;
  font-size: 11px;
  color: #6b7280;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 4px;
  padding: 3px 8px;
}
.ex-empty {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 13px;
  color: #4b5563;
  background: #fff;
  border: 1px solid #e3e7ec;
  border-radius: 8px;
  padding: 16px 20px;
  max-width: 380px;
  text-align: center;
  line-height: 1.6;
}
</style>
