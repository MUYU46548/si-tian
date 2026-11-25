<template>
  <div class="sys3d" data-testid="system-3d">
    <div
      ref="host"
      class="sys3d-host"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
    ></div>

    <!-- E1/E2（2026-10-29）：点中一颗行星 → 小卡片（改类型 / 下钻到行星地图）。
         以前 3D 是纯观景：能看不能点，用户看完还得回 2D 找那颗星。 -->
    <div v-if="picked" class="sys3d-card" data-testid="sys3d-card">
      <div class="sys3d-card-head">
        <strong>{{ picked.name }}</strong>
        <span class="sys3d-card-sub">{{ classLabel(picked.classId) }}</span>
        <button class="sys3d-card-x" title="取消选择（Esc 仍是返回 2D）" @click="picked = null">
          <Icon name="x" :size="12" />
        </button>
      </div>
      <label class="sys3d-card-row" title="行星类型：落数据（node.planetClass），下次打开 3D / 2D 图标都按它">
        <span>类型</span>
        <select data-testid="sys3d-class" :value="picked.classId" @change="onClassChange">
          <option v-for="c in planetClasses" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
      </label>
      <label class="sys3d-card-row" title="逐颗改色：只影响这一颗，写进项目文件的 planetColors（2D 圆盘同步变）">
        <span>颜色</span>
        <input class="sys3d-color" type="color" data-testid="sys3d-color-base"
               :value="pickedColors.base" title="地表主色（海/底色）" @input="onColor('base', $event)" />
        <input class="sys3d-color" type="color" data-testid="sys3d-color-land"
               :value="pickedColors.land" title="陆块色" @input="onColor('land', $event)" />
        <input class="sys3d-color" type="color" data-testid="sys3d-color-atmo"
               :value="pickedColors.atmosphere" title="大气边光色" @input="onColor('atmosphere', $event)" />
      </label>
      <label class="sys3d-card-row" title="我的配色（本机保存，跨项目可用；套用只影响这一颗）">
        <span>配色</span>
        <select data-testid="sys3d-preset" :value="''" @change="onApplyPreset">
          <option value="">{{ presets.length ? '选一套…' : '（还没有）' }}</option>
          <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label class="sys3d-card-row">
        <input class="sys3d-preset-name" data-testid="sys3d-preset-name" v-model="presetName"
               placeholder="配色名（可空）" />
        <button class="sys3d-preset-save" data-testid="sys3d-preset-save" @click="onSavePreset">存为配色</button>
      </label>
      <button class="sys3d-card-go" data-testid="sys3d-drill" @click="onDrill">
        进入行星地图 <Icon name="chevron-right" :size="12" />
      </button>
    </div>

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
    <div v-if="qualityBadge" class="sys3d-quality" data-testid="system-3d-quality">{{ qualityBadge }}</div>
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
 * 低配口径（SP-1025 已踩过，照抄）：无阴影 / 低模 / MeshLambert / 关闭即遍历 dispose /
 * OrbitControls 阻尼 / rAF + 可见性暂停。
 * ⚠️ 2026-11-25 起 AA 是**开**的、像素比上限 2、球面 40×28 —— 单星系是近景主视图，
 *    旧的"低配观感"取舍用在这里就是"锯齿 + 模糊"（见 init() 里的长注释）。
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
import {
  PLANET_CLASSES, SeededRng, atmosphereForClass, getCloudTexture, getPlanetTexture,
  hashString, hexAlpha, paletteForClass, planetClassLabel,
} from '../utils/planetArt.js';
import { SYS3D_QUALITY, nextQualityLevel } from '../utils/system3dScene.js';
import { loadPresets, savePreset } from '../utils/planetPalettes.js';

const props = defineProps({
  // buildSystem3dScene() 的产物；父组件每次打开时现算
  spec: { type: Object, required: true },
});
const emit = defineEmits(['close', 'select-node', 'set-class', 'set-colors']);

const host = ref(null);
const fpsEl = ref(null);
const status = ref('正在加载 3D 引擎…');
const error = ref('');
const paused = ref(false);

const countsText = computed(() => {
  const c = props.spec?.counts || {};
  return `${c.planets ?? 0} 行星 · ${c.moons ?? 0} 卫星${c.stations ? ` · ${c.stations} 空间站` : ''}`;
});

// ===== E1/E2（2026-10-29）：3D 里点中行星 → 改类型 / 下钻 =====
const planetClasses = PLANET_CLASSES;
const picked = ref(null);       // { id, name, classId, kind }（选中那颗）
/** 可点对象：mesh 用于射线检测，mat 用于换贴图（改类型当场生效，不必重开 3D） */
const pickables = [];
let raycaster = null;
let downAt = null;              // pointerdown 位置：用来区分“点选”与“拖拽旋转”

const classLabel = (id) => planetClassLabel(id);

function onPointerDown(e) {
  downAt = { x: e.clientX, y: e.clientY, t: Date.now() };
}

function onPointerUp(e) {
  if (!downAt || !raycaster || !camera || !host.value) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const held = Date.now() - downAt.t;
  downAt = null;
  // 拖拽（旋转视角）与长按都不算点选 —— 否则每次转视角都会弹出卡片
  if (moved > 6 || held > 700) return;
  const rect = host.value.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  raycaster.setFromCamera({
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
  }, camera);
  const hits = raycaster.intersectObjects(pickables.map((p) => p.mesh), false);
  if (!hits.length) { picked.value = null; return; }
  const hit = pickables.find((p) => p.mesh === hits[0].object);
  picked.value = hit ? { ...hit.body } : null;
}

/** 卡上三个拾色器当前显示的值（类别默认 + 这一颗的覆盖） */
const pickedColors = computed(() => {
  const p = picked.value;
  const d = p ? paletteForClass(p.classId, p.palette) : null;
  if (!d) return { base: "#888888", land: "#888888", atmosphere: "#888888" };
  return {
    base: d.base,
    land: (Array.isArray(d.land) && d.land[0]) || d.base,
    atmosphere: d.atmosphere || d.base,
  };
});

/** 把一份色板**当场画到这颗球上**（贴图重建 + 大气色/浓淡）。改色和改类型都走它。 */
function applyPalette(hit, palette) {
  if (!hit || !THREE) return;
  const tex = new THREE.CanvasTexture(getPlanetTexture(hit.body.classId, palette));
  tex.encoding = THREE.sRGBEncoding;
  track(tex);
  hit.mat.map = tex;
  hit.mat.needsUpdate = true;
  if (hit.atmoMat) {
    const atmo = atmosphereForClass(hit.body.classId, palette);
    hit.atmoMat.uniforms.uColor.value.set(atmo.color);
    hit.atmoMat.userData.baseStrength = atmo.strength * ATMO_GAIN;
    hit.atmoMat.uniforms.uStrength.value = atmo.strength * ATMO_GAIN * atmoScale;
  }
}

/**
 * 拾色器改动：只改**这一颗**（写 planetColors 覆盖，不动类别默认值）。
 * 三个口：base = 地表主色（海/底色）、land = 陆块色（数组只填第一档）、atmosphere = 大气色。
 */
function onColor(slot, e) {
  const p = picked.value;
  const v = String((e && e.target && e.target.value) || "");
  if (!p || !/^#[0-9a-fA-F]{6}$/.test(v)) return;
  const colors = { ...(p.palette || {}) };
  if (slot === "land") colors.land = [v];
  else colors[slot] = v;
  const hit = pickables.find((x) => x.body.id === p.id);
  if (hit) {
    hit.body.palette = colors;
    applyPalette(hit, colors);
  }
  picked.value = { ...p, palette: colors };
  emit("set-colors", { id: p.id, colors });
}

/** 本机配色库（B 前半段）：跨项目可选的 DIY 配色；改动只作用在**当前这一颗** */
const presets = ref(loadPresets());
const presetName = ref("");

/** 选中一套配色 → 套到当前这颗上（走与拾色器同一条 applyPalette + set-colors） */
function onApplyPreset(e) {
  const id = String((e && e.target && e.target.value) || "");
  const p = picked.value;
  if (!id || !p) return;
  const hit = pickables.find((x) => x.body.id === p.id);
  const preset = presets.value.find((x) => x.id === id);
  if (!hit || !preset) return;
  const colors = { ...(p.palette || {}), ...preset.colors };
  hit.body.palette = colors;
  applyPalette(hit, colors);
  picked.value = { ...p, palette: colors };
  emit("set-colors", { id: p.id, colors });
}

/** 把当前这颗的**完整配色**存进本机库（存的是覆盖补丁，不是整套类别定义） */
function onSavePreset() {
  const p = picked.value;
  if (!p) return null;
  const eff = paletteForClass(p.classId, p.palette);
  const r = savePreset({
    name: presetName.value || p.name,
    classId: p.classId,
    colors: { base: eff.base, cap: eff.cap, atmosphere: eff.atmosphere, land: eff.land },
  });
  presets.value = r.list;
  presetName.value = "";
  status.value = r.ok ? "已存为配色（本机，跨项目可用）" : "配色没存进去（浏览器存储被禁用？）";
  return r;
}

/** 改类型：**当场换贴图/大气** + 落数据（planetClass 走父组件的 store 写口） */
function onClassChange(e) {
  const id = picked.value && picked.value.id;
  const classId = String(e.target.value || '');
  if (!id || !classId) return;
  const hit = pickables.find((p) => p.body.id === id);
  if (hit && THREE) {
    const tex = new THREE.CanvasTexture(getPlanetTexture(classId));
    tex.encoding = THREE.sRGBEncoding;
    track(tex);
    hit.mat.map = tex;
    hit.mat.needsUpdate = true;
    // 大气色/浓淡也跟着类别走：荒芜 → 盖亚，边缘光不能还是原来那圈土黄
    if (hit.atmoMat) {
      const atmo = atmosphereForClass(classId, hit.body.palette);
      hit.atmoMat.uniforms.uColor.value.set(atmo.color);
      hit.atmoMat.userData.baseStrength = atmo.strength * ATMO_GAIN;
      hit.atmoMat.uniforms.uStrength.value = atmo.strength * ATMO_GAIN * atmoScale;
    }
    picked.value = { ...picked.value, classId };
  }
  emit('set-class', { id, classId });
}

/** 下钻：只报 id，父组件自己按 id 找到**真节点**（3D spec 里没有整份节点对象） */
function onDrill() {
  const p = picked.value;
  if (!p) return;
  picked.value = null;
  emit('select-node', { id: p.id });
}

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
/** E3：伴星 pivot（公转角度每帧推进） */
const starPivots = [];
/**
 * 大气壳层的材质清单（2026-11-25）。
 * 一是给排障口 `setAtmosphereScale` 用（验收要做"关掉必红"的反向探针），
 * 二是给 `stats.atmospheres` 计数 —— 判据「每颗行星都得有大气」要读得到数。
 */
const atmoMats = [];
/** 其中属于卫星的那些（判据要分开数：行星数 / 卫星数各有一条） */
const moonAtmoMats = [];
/** 日冕材质（每帧慢转：静止的放射光针看着像贴纸） */
const coronaMats = [];
/** 云层网格（每帧比地表多转一点：云不该跟地形一起死转） */
const cloudMeshes = [];
/** 大气强度总系数（排障口可改；0 = 全关） */
let atmoScale = 1;
/** 建了几个环（验收读数：气巨/冰巨必须各有一个） */
let ringCount = 0;
/** 环的暗带（判据 A5：有环就必须有投影暗带） */
let ringShadowCount = 0;
/** 大气壳层半径 = 行星半径 × 这个倍数（1.22 → 光晕向外延伸约 22% 半径；量过 1.18 只剩 ~1.10R） */
const ATMO_SHELL = 1.22;
/**
 * 大气整体增益（**观感系数**，不是又一张分类表）。
 * 1.0 时贴近轮廓那一圈的 alpha 能到 0.85 —— 在 140px 的行星上就是一圈发白的浓雾；
 * 0.72 是看着"裹了一层气"而不是"套了个发光垫圈"的那个值（2026-11-25 截图上量的）。
 */
const ATMO_GAIN = 0.72;
const projectVec = { v: null };
let lastFpsStamp = 0;
let framesSinceStamp = 0;

// ===== E5（2026-10-29）：按实测帧耗自动降档（只降不升，判据是纯函数） =====
let qualityLevel = 'high';
let qualityAvgMs = 0;
let qualityAccumMs = 0;
let qualityAccumN = 0;
let beltMesh = null;
const qualityBadge = ref('');

function applyQuality() {
  const q = SYS3D_QUALITY[qualityLevel] || SYS3D_QUALITY.high;
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap));
  } catch (e) { /* 上下文丢失时忽略 */ }
  resize();
  if (beltMesh) beltMesh.visible = q.belt;
  stats.quality = {
    level: qualityLevel,
    pixelRatio: (() => { try { return renderer.getPixelRatio(); } catch (e) { return null; } })(),
    avgFrameMs: Math.round(qualityAvgMs * 10) / 10,
  };
  qualityBadge.value = qualityLevel === 'high'
    ? ''
    : `已自动降档（${q.label}）：帧耗 ${Math.round(qualityAvgMs)}ms，像素比 ${stats.quality.pixelRatio}`;
}

/** 关闭后的验收数据（也用于排查 WebGL 泄漏） */
const stats = {
  geometries: 0,
  textures: 0,
  memoryAtDispose: null,
  disposed: 0,
  frames: 0,
  labels: 0,
  error: '',
  // 2026-11-25：大气壳层计数（判据：必须 == planets）与总系数（反向探针用）
  atmospheres: 0,
  planets: 0,
  atmoScale: 1,
  // 第二轮：卫星大气 / 云层（卫星的大气薄一档，单独计数）
  moonAtmospheres: 0,
  moons: 0,
  clouds: 0,
  coronaScale: 1,
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
  // 🔴 2026-11-25：128 → 512（用户：「只让人觉得模糊」）
  //
  // 128×128 的径向渐变贴到屏幕上 300px+ 的光晕上是**放大 2.4 倍**，
  // 双线性放大会把渐变的 stop 边缘抹成一片均匀的雾 —— 这就是"模糊"的直接来源，
  // 而且它盖在恒星边缘上，把恒星的轮廓也一起糊掉了。
  // 512 之后同样尺寸是缩小采样（1×），渐变干净。
  // 代价：一张 512×512 的 RGBA canvas ≈ 1 MB，只生成一次（按 tint 缓存），可接受。
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const half = S / 2;
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, hexAlpha(tint, 0.95));
  grad.addColorStop(0.25, hexAlpha(tint, 0.42));
  grad.addColorStop(0.6, hexAlpha(tint, 0.12));
  grad.addColorStop(1, hexAlpha(tint, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  // 缩小采样时用 mipmap 更干净（原值默认 AlsoGenerateMipmaps，这里显式写清意图）
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * 恒星本体材质（2026-11-25）：**自发光球 + 临边昏暗**，用着色器做在球面上。
 *
 * 之前是 `MeshBasicMaterial` 平涂 + 一张"暗边 sprite"贴在前面（makeLimbTexture）。
 * 那张 sprite 有两个毛病：① 它是个**平面**，恒星在屏幕边缘时暗边圈和球对不上；
 * ② 平涂球完全没有"中间过曝、边缘偏色"的太阳质感 —— 截图里就是一块橙色圆盘。
 *
 * 现在：球面按"正对相机程度"混两色 —— 中心接近白（过曝），边缘压暗并偏回本色。
 * 这比 sprite 版多不了几个像素的代价，但恒星一眼是"发光的球"而不是"圆盘"。
 *
 * ⚠️ 颜色口径：自定义 ShaderMaterial **不经过** `renderer.outputEncoding` 的 sRGB 转换
 *    （那是内置材质才有的 fragment chunk）。所以这里直接输出**作者写的 sRGB 值**，
 *    与 CanvasTexture（sRGB 解码）画出来的光晕在同一空间里，不会一深一浅。
 */
function makeStarMaterial(tint) {
  const core = new THREE.Color(tint).lerp(new THREE.Color(0xffffff), 0.72);
  const edge = new THREE.Color(tint).multiplyScalar(0.5);
  return new THREE.ShaderMaterial({
    uniforms: {
      uCore: { value: core },
      uEdge: { value: edge },
      // 1.0 = 按 cos(视角) 线性压暗（临边昏暗的经典近似）。
      // 之前 0.6 等于"整块盘都接近亮核"，所以看起来是平圆盘而不是球。
      uPow: { value: 1.0 },
    },
    vertexShader: `
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      void main() {
        vViewNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uCore;
      uniform vec3 uEdge;
      uniform float uPow;
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      void main() {
        float facing = clamp(dot(normalize(vViewNormal), normalize(-vViewPos)), 0.0, 1.0);
        gl_FragColor = vec4(mix(uEdge, uCore, pow(facing, uPow)), 1.0);
      }`,
  });
}

/**
 * 行星大气边缘光（2026-11-25，用户：「很多行星根本没有大气」）。
 *
 * 做法：比行星**大一圈的背面球壳** + 加色混合，但衰减**不是**按"菲涅耳"算的。
 *
 * 🔴 第一版用的是 `1 - |dot(法线, 视线)|`（球壳自己的掠射角），截图里立刻现出两个毛病：
 *    ① 亮度峰值落在**壳层的轮廓上**，所以外缘是一圈**硬边**（像给行星套了个垫圈）；
 *    ② 整圈灰蒙蒙、贴边那一截反而是最暗的 —— 不像"气"，像阴影。
 *    根因：菲涅耳量的是"这层壳表面有多斜"，而大气要的是"这条视线离行星多远"。
 *
 * 现在按**冲击参数**（视线到行星中心的最短距离，视空间里就是 `s = |frag.xy - center.xy|`）算：
 *   把 `s` 归一化成 `t = (s - 行星半径) / (壳层半径 - 行星半径)`，`rim = (1 - t)^0.7` ——
 *   在行星轮廓处最亮、向外单调衰减到 0，两端都不出硬边。
 *
 * 🔴 为什么是 `(1-t)^0.7` 而不是 `1 - smoothstep(...)`（第二版试过，判据直接把它抓了）：
 *    背面球壳在屏幕上被**透视压扁** —— `t` 从 0.6 到 1.0 那一段在 140px 半径的行星上
 *    只占 10 来个像素，smoothstep 的两端导数为 0，于是光晕"看着只有薄薄一圈"，
 *    实测轮廓外 1.06R~1.18R 的平均增量只有 5.9（判据要求 ≥ 6）。幂函数换成小于 1 的指数，
 *    外段才有能量。这是"数学上均匀"与"屏幕上均匀"的差别 —— 量出来的，不是猜的。
 *
 * `lit` 让**朝恒星那一侧更亮**：方向取**屏幕平面**上的（`朝向恒星的视空间 xy`），
 * 这样"哪边亮"与肉眼看到的光照方向一致；暗面只留一层极淡的轮廓。
 *
 * `s` 在一条视线上是不变的（它垂直于视线），所以用顶点的视空间坐标算就精确，不必逐像素射线求交。
 *
 * ⚠️ 颜色口径：自定义 ShaderMaterial **不经过** `renderer.outputEncoding` 的 sRGB 转换
 *    （那是内置材质才有的 fragment chunk）。所以这里直接输出**作者写的 sRGB 值**，
 *    与 CanvasTexture（sRGB 解码）画出来的贴图在同一空间里，不会一深一浅。
 */
function makeAtmosphereMaterial(tint, strength, planetR, shellR) {
  const base = strength * ATMO_GAIN;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(tint) },
      uStrength: { value: base },
      uPlanetR: { value: planetR },
      uShellR: { value: shellR },
    },
    vertexShader: `
      varying vec3 vViewPos;
      varying vec3 vCenterView;
      void main() {
        // 行星中心（视空间）+ 本片元（视空间）：两者 xy 之差就是冲击参数
        vCenterView = (viewMatrix * modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      uniform float uPlanetR;
      uniform float uShellR;
      varying vec3 vViewPos;
      varying vec3 vCenterView;
      void main() {
        vec2 dv = vViewPos.xy - vCenterView.xy;
        float s = length(dv);
        float t = clamp((s - uPlanetR) / max(1e-4, uShellR - uPlanetR), 0.0, 1.0);
        float rim = pow(1.0 - t, 0.7);
        // 屏幕平面上"朝恒星"的方向（恒星在世界原点 → 视空间里就是 -行星中心）
        vec2 starDir = normalize(-vCenterView.xy + vec2(1e-6, 0.0));
        float lit = 0.55 + 0.45 * clamp(dot(s > 1e-4 ? dv / s : vec2(0.0), starDir), 0.0, 1.0);
        gl_FragColor = vec4(uColor, rim * uStrength * lit);
      }`,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  mat.userData.baseStrength = base;
  return mat;
}

/**
 * 日冕 / 耀斑贴图（2026-11-25，用户：「恒星没有日冕/耀斑 —— 现在是个亮球」）。
 *
 * 参考图里的恒星不只是"亮球"：外面有一圈**长短不一的放射光针**，而且整团是缓慢流动的。
 * 一张 512 的贴图（26 根细锥 + 内层柔光）贴在加色 sprite 上、每帧慢转 —— 静态截图也看得出"毛边"，
 * 动起来是流动的。全部由 `hashString(tint)` 定种子，同一颗恒星每次打开长得一样。
 */
function makeCoronaTexture(tint) {
  const S = 512;
  const half = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rng = new SeededRng(hashString(`corona:${tint}`));
  g.globalCompositeOperation = 'lighter';
  // ① 光针：从球面（0.2R）伸到 0.35~0.75R，越长越淡。
  //    32 根（原来是 26）—— 根数少时那圈放射线太像"画上去的太阳"，多几根、长短差大更像日冕。
  const RAYS = 32;
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2 + (rng.next() - 0.5) * 0.2;
    const len = half * (0.35 + rng.next() * 0.4);
    const w = 0.005 + rng.next() * 0.011;
    const grad = g.createLinearGradient(half, half, half + Math.cos(a) * len, half + Math.sin(a) * len);
    grad.addColorStop(0, hexAlpha(tint, 0.46));
    grad.addColorStop(0.45, hexAlpha(tint, 0.13));
    grad.addColorStop(1, hexAlpha(tint, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(half + Math.cos(a - w) * half * 0.2, half + Math.sin(a - w) * half * 0.2);
    g.lineTo(half + Math.cos(a) * len, half + Math.sin(a) * len);
    g.lineTo(half + Math.cos(a + w) * half * 0.2, half + Math.sin(a + w) * half * 0.2);
    g.closePath();
    g.fill();
  }
  // ② 内层柔光：比"光晕"更宽更淡，把光针的根部接回球面（否则光针像凭空插上去的）
  const halo = g.createRadialGradient(half, half, half * 0.1, half, half, half * 0.88);
  halo.addColorStop(0, hexAlpha(tint, 0.26));
  halo.addColorStop(0.45, hexAlpha(tint, 0.08));
  halo.addColorStop(1, hexAlpha(tint, 0));
  g.fillStyle = halo;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * 星云贴图（2026-11-25，用户：「背景空」）：一团软边、内部不均匀的色块。
 *
 * 抄的是星域 3D 原型（`scripts/proto/domain3d-proto.html`）那套 —— 那边已经为"深空感"
 * 调过一轮（3000 颗星场 + 4 团星云 + 1 个亮核）。单星系视图不需要亮核（恒星自己就是亮的），
 * 只要 4 团极淡的冷色让黑底不平。
 */
function makeNebulaTexture(seed) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rng = new SeededRng(seed);
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.5)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.2)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.055)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // 叠十几团小浓淡：真实星云是不规则的，一个完美的圆一眼假
  for (let i = 0; i < 14; i++) {
    const x = S / 2 + (rng.next() - 0.5) * S * 0.8;
    const y = S / 2 + (rng.next() - 0.5) * S * 0.8;
    const r = S * (0.06 + rng.next() * 0.2);
    const g2 = g.createRadialGradient(x, y, 0, x, y, r);
    g2.addColorStop(0, `rgba(255,255,255,${0.05 + rng.next() * 0.09})`);
    g2.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = g2;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

/**
 * 行星环贴图（2026-11-25 第三轮）：**同心带状**的径向纹理（256×256）。
 *
 * 🔴 旧版是一张 2×64 的竖向渐变条带。`RingGeometry` 的 UV 是**平面映射**
 *    （uv = 顶点位置映射到 0~1²），拿竖条渐变去贴，环面上得到的是一道**横向明暗**，
 *    不是"一圈圈同心环"——看起来像一块半透明胶带。
 *    平面映射要的是**径向**纹理：从画布中心往外一圈圈画，贴上去正好对上。
 *
 * 带隙：中段留两条低不透明度的窄缝（真实环的卡西尼缝），内缘淡入、外缘渐隐。
 */
/**
 * 环投在行星上的**暗带**（2026-11-25 第四轮）。
 *
 * 真实的行星环会挡住阳光，在行星赤道带压出一条比周围暗的带子 —— 气巨的"球感"
 * 有一半来自这个细节（不然环看起来像贴在球外面的一张纸）。
 *
 * 做法：贴着一层 1.004R 的球壳，用着色器在**行星局部坐标**里量"离环面多远"。
 *   环躺在行星赤道面里（`ringTilt.rotation.z = body.tilt` + RingGeometry 摆平），
 *   所以局部 y 就是**到环面的距离**：`|y| < uBand` 的地方压暗，边缘平滑过渡。
 *   再乘一个"受光程度"：暗面本来就黑，暗带只在**受光侧**才看得见。
 *
 * 为什么不用真阴影贴图（shadowMap）：那要给整个场景开阴影 + 让环投光，
 * 代价是帧耗翻倍（这个视图还有日冕/云/大气三层加色），而效果用一条带子就够了。
 */
function makeRingShadowMaterial(planetR) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRadius: { value: planetR },
      // 0.34 ≈ 环的投影带半高（相对半径）。再宽会把两极也压暗，看起来像"行星被切了一刀"。
      uBand: { value: 0.34 },
      uStrength: { value: 0.55 },
    },
    vertexShader: `
      varying vec3 vLocalPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vLocalPos = position;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uRadius;
      uniform float uBand;
      uniform float uStrength;
      varying vec3 vLocalPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        float y = clamp(vLocalPos.y / uRadius, -1.0, 1.0);
        float band = 1.0 - smoothstep(uBand * 0.55, uBand, abs(y));
        vec3 toStar = normalize(-vWorldPos);
        float lit = smoothstep(-0.15, 0.35, dot(normalize(vWorldNormal), toStar));
        gl_FragColor = vec4(0.0, 0.0, 0.0, band * lit * uStrength);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

function makeRingTexture() {
  const S = 256;
  const half = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rng = new SeededRng(hashString('system3d:ring'));
  // RingGeometry 的内/外径是 1.35R / 2.1R（见调用处），平面 UV 下可见环带是 0.643R~1.0R。
  // 所以条纹画在这个区间里（画布半径 0.64~1.0），否则一半条纹会落在中间的洞里。
  const rings = 34;
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const r0 = half * (0.64 + t * 0.36);
    const w = half * 0.014;
    // 亮度：整体偏亮、中间两条缝（卡西尼缝）
    let alpha = 0.5 + rng.next() * 0.4;
    if (t > 0.42 && t < 0.47) alpha *= 0.18;
    if (t > 0.62 && t < 0.65) alpha *= 0.35;
    if (t < 0.05 || t > 0.95) alpha *= 0.35;   // 内外缘淡入淡出
    g.strokeStyle = `rgba(232, 214, 176, ${alpha.toFixed(3)})`;
    g.lineWidth = w * (1 + rng.next() * 1.2);
    g.beginPath();
    g.arc(half, half, r0, 0, Math.PI * 2);
    g.stroke();
  }
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
  // 🔴 2026-11-25：28×20 → 48×32。恒星是画面里最大的物体（半径 2.4，近景可占 250px+），
  //    低段数时轮廓的多边形棱在加色光晕衬托下特别明显 —— 那正是"锯齿感"最集中的地方。
  const starGeo = new THREE.SphereGeometry(spec.star.radius, 48, 32);
  // 2026-11-25：平涂 MeshBasic → 自发光着色器（中间过曝、边缘压暗偏色）。见 makeStarMaterial。
  const starMat = makeStarMaterial(spec.star.tint);
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

  // 日冕 / 耀斑（2026-11-25）：一张 32 根光针的加色贴图，比光晕大一圈、每帧慢转。
  // 光晕（5.6×）给的是"过曝"，日冕（9.6×）给的是"毛边"—— 两者缺一个都像贴纸。
  const CORONA_OPACITY = 0.55;
  const coronaMat = new THREE.SpriteMaterial({
    map: track(makeCoronaTexture(spec.star.tint)),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity: CORONA_OPACITY,
  });
  const corona = new THREE.Sprite(track(coronaMat));
  corona.scale.setScalar(spec.star.radius * 9.6);
  corona.renderOrder = 1;
  scene.add(corona);
  coronaMat.userData.baseOpacity = CORONA_OPACITY;
  coronaMats.push(coronaMat);

  // 临边昏暗叠层（sprite 版）2026-11-25 **已删**：那是个贴在恒星前面的平面，
  // 恒星转到屏幕边缘时暗边圈和球对不上；现在由 makeStarMaterial 在球面上算。

  // ── 双星（E3，2026-10-29）：子恒星绕主恒星转，自带点光与光晕 ──────────────────
  // 以前 3D 只按主恒星取色 → 双星系和单星系长得一模一样（数据在 `parentStar` 上，画不出来）。
  for (const c of (spec.companions || [])) {
    const pivot = new THREE.Object3D();
    pivot.rotation.y = c.phase;
    scene.add(pivot);
    const holder = new THREE.Object3D();
    holder.position.set(c.orbit, 0, 0);
    pivot.add(holder);
    const cGeo = new THREE.SphereGeometry(c.radius, 20, 14);
    const cMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(c.tint) });
    holder.add(new THREE.Mesh(track(cGeo), track(cMat)));
    const cGlow = new THREE.Sprite(track(new THREE.SpriteMaterial({
      map: track(makeGlowTexture(c.tint)),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    })));
    cGlow.scale.setScalar(c.radius * 5.2);
    holder.add(cGlow);
    // 伴星也参与照明（强度低一档：主星仍是主光源，否则行星暗面会"两面都亮"）
    holder.add(new THREE.PointLight(new THREE.Color(c.tint), 0.8, 0, 1.4));
    starPivots.push({ pivot, speed: c.speed });
  }

  for (const body of spec.bodies) {
    // 轨道环（128 段折线，比圆环更省）
    const pts = [];
    for (let k = 0; k < 128; k++) {
      const a = (k / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * body.orbit, 0, Math.sin(a) * body.orbit));
    }
    const orbitGeo = new THREE.BufferGeometry().setFromPoints(pts);
    // 🔴 2026-11-25 提亮（0.32 → 0.5 + 换更亮的蓝）：
    //    1px 的线在暗背景上 opacity 0.32 时，抗锯齿后的边缘像素只有 ~0.1 亮度，
    //    肉眼读起来是"断断续续的脏线"而不是"细轨道"—— 用户说的"模糊"有一半是这条。
    //    参考图 `星系视图1.png` 里轨道是**能看清是哪一圈**的淡线，不是几乎看不见。
    const orbitMat = new THREE.LineBasicMaterial({ color: 0x6d84a8, transparent: true, opacity: 0.5 });
    scene.add(new THREE.LineLoop(track(orbitGeo), track(orbitMat)));

    const pivot = new THREE.Object3D();
    pivot.rotation.y = body.phase;
    scene.add(pivot);

    const tex = new THREE.CanvasTexture(getPlanetTexture(body.classId, body.palette));
    tex.encoding = THREE.sRGBEncoding;
    track(tex);
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const geo = body.kind === 'station'
      ? new THREE.OctahedronGeometry(body.size, 0)
      // 🔴 2026-11-25：24×16 → 40×28（用户：「锯齿感非常强」）
      //    单星系是近景视图，行星在屏幕上可以占到 100~200px，
      //    24 段的球在这个尺寸下**轮廓能看出多边形棱**（不是抗锯齿能救的 —— 那是几何问题）。
      //    代价：顶点数 24×16≈400 → 40×28≈1100，8 颗行星共 +5600 顶点，可忽略。
      : new THREE.SphereGeometry(body.size, 40, 28);
    const mesh = new THREE.Mesh(track(geo), track(mat));
    mesh.rotation.z = body.tilt;
    // holder = 行星在轨道上的位置（pivot 只负责公转角度）。卫星/环挂 holder 而不是 mesh：
    // mesh 每帧自转，挂上去卫星轨道会跟着行星一起转（第一版真实踩过）。
    const holder = new THREE.Object3D();
    holder.position.set(body.orbit, 0, 0);
    pivot.add(holder);
    holder.add(mesh);

    // 大气边缘光（2026-11-25，用户：「很多行星根本没有大气」）。
    // 挂在 holder 上（不吃 mesh 的自转/倾角）：大气层不该跟着地表一起转。
    // `body.atmo` 由 buildSystem3dScene 给 —— 每颗行星都有，空间站没有。
    let atmoMat = null;
    if (body.atmo) {
      const shellR = body.size * ATMO_SHELL;
      atmoMat = makeAtmosphereMaterial(body.atmo.color, body.atmo.strength, body.size, shellR);
      atmoMat.userData.bodyId = body.id;   // 反向探针要能只关这一颗
      // 壳层段数不必很高（光晕是着色器算的、不吃几何），但轮廓是几何 → 32×22 不肉
      const atmoGeo = new THREE.SphereGeometry(shellR, 32, 22);
      const atmo = new THREE.Mesh(track(atmoGeo), track(atmoMat));
      atmo.renderOrder = 2;      // 透明层：行星之后画，只留轮廓外那一圈
      holder.add(atmo);
      atmoMats.push(atmoMat);
    }
    // 云层（2026-11-25 第二轮）：比球面大 2% 的**半透明白云壳**，自转比地表快一档。
    // 以前云是画在地表贴图里的 —— 球一转，云跟地形一起转，看着像"石头上的白斑"。
    // 只有 terra 且 `def.clouds > 0` 的类别有（气巨的云本来就是条带，不再叠）。
    let cloudMesh = null;
    const cloudCanvas = body.kind === 'planet' ? getCloudTexture(body.classId) : null;
    if (cloudCanvas) {
      const cTex = new THREE.CanvasTexture(cloudCanvas);
      cTex.encoding = THREE.sRGBEncoding;
      track(cTex);
      const cGeo = new THREE.SphereGeometry(body.size * 1.02, 40, 28);
      // 不写深度、稍后画：远半球的云被行星本体挡掉，只留正面那层
      const cMat = new THREE.MeshLambertMaterial({ map: cTex, transparent: true, depthWrite: false });
      cloudMesh = new THREE.Mesh(track(cGeo), track(cMat));
      cloudMesh.rotation.z = body.tilt;
      holder.add(cloudMesh);
      cloudMeshes.push(cloudMesh);
    }
    // E1：这颗球可被点中（射线检测只认这一份清单）
    pickables.push({ mesh, mat, body, atmoMat });

    if (body.ring) {
      const ringGeo = new THREE.RingGeometry(body.size * 1.35, body.size * 2.1, 96);
      const ringMat = new THREE.MeshBasicMaterial({
        map: track(makeRingTexture()),
        color: 0xd8c290,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(track(ringGeo), track(ringMat));
      // 🔴 环要躺在**这颗行星的赤道面**里：旧版写死 `rotation.x = PI/2.25`，
      //    与 `body.tilt`（自转轴倾角）无关 —— 倾角大的行星会出现"环斜着穿过球"。
      //    做法：外层转 tilt（与 mesh.rotation.z 同一个轴），内层再摆平。
      const ringTilt = new THREE.Object3D();
      ringTilt.rotation.z = body.tilt;
      ring.rotation.x = Math.PI / 2;
      ringTilt.add(ring);
      holder.add(ringTilt);
      ringCount += 1;

      // 环投在行星赤道带上的暗带（挂在 mesh 上：跟着自转/倾角一起走）
      const shadowMat = makeRingShadowMaterial(body.size);
      const shadowGeo = new THREE.SphereGeometry(body.size * 1.004, 40, 28);
      const shadow = new THREE.Mesh(track(shadowGeo), track(shadowMat));
      shadow.renderOrder = 1;
      mesh.add(shadow);
      ringShadowCount += 1;
    }

    const moonPivots = [];
    for (const moon of body.moons) {
      // 2026-11-25 第二轮：卫星不再是一颗灰球 —— 用地表美术库的同一套类别贴图
      //（`barren`/`frozen` 两种），段数 12×8 → 20×14（近景才不是多面体）。
      const mTex = new THREE.CanvasTexture(getPlanetTexture(moon.classId, moon.palette));
      mTex.encoding = THREE.sRGBEncoding;
      track(mTex);
      const mGeo = new THREE.SphereGeometry(moon.size, 20, 14);
      const mMat = new THREE.MeshLambertMaterial({ map: mTex });
      const mMesh = new THREE.Mesh(track(mGeo), track(mMat));
      mMesh.position.set(moon.orbit, 0, 0);
      const mp = new THREE.Object3D();
      mp.rotation.y = moon.phase;
      mp.add(mMesh);
      // 卫星挂在母行星的**位置节点**上：公转时跟着走，但不吃行星自转
      holder.add(mp);

      // 卫星的大气（比同类行星薄一档：SYS3D_GEOM.moonAtmoScale）
      if (moon.atmo) {
        const mShellR = moon.size * ATMO_SHELL;
        const mAtmoMat = makeAtmosphereMaterial(moon.atmo.color, moon.atmo.strength, moon.size, mShellR);
        const mAtmoGeo = new THREE.SphereGeometry(mShellR, 20, 14);
        const mAtmo = new THREE.Mesh(track(mAtmoGeo), track(mAtmoMat));
        mAtmo.renderOrder = 2;
        mMesh.add(mAtmo);
        mAtmoMat.userData.bodyId = moon.id;
        atmoMats.push(mAtmoMat);
        moonAtmoMats.push(mAtmoMat);
      }

      const mPts = [];
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        mPts.push(new THREE.Vector3(Math.cos(a) * moon.orbit, 0, Math.sin(a) * moon.orbit));
      }
      const mOrbitGeo = new THREE.BufferGeometry().setFromPoints(mPts);
      const mOrbitMat = new THREE.LineBasicMaterial({ color: 0x8b949e, transparent: true, opacity: 0.18 });
      holder.add(new THREE.LineLoop(track(mOrbitGeo), track(mOrbitMat)));
      moonPivots.push({ pivot: mp, speed: moon.speed, mesh: mMesh, spin: moon.spin || 0.3 });
    }

    orbits.push({ pivot, mesh, speed: body.speed, moonPivots, clouds: cloudMesh });

    // 名称标签（DOM 投影：比 Sprite + CanvasTexture 省一份纹理，且中文字形清楚）
    const el = document.createElement('div');
    el.className = 'sys3d-label';
    el.textContent = body.kind === 'station'
      ? body.name
      : `${body.name} · ${planetClassLabel(body.classId)}`;
    host.value.appendChild(el);
    labels.push({ el, mesh, offset: body.size + 0.45 });
  }

  // 小行星带：**一圈窄带**，不是"内轨到外轨之间的整片区域"。
  //
  // 🔴 2026-11-25 修（用户看到满屏小点后追查）：
  //    原实现把带子铺在 `min(orbit)+1.6 ~ max(orbit)-1.2` —— 也就是**跨越所有行星轨道**。
  //    2 颗行星时那是 8.6~13.2 的整片环域，720 个点撒在两圈之间，
  //    看起来是"满天碎屑"而不是"小行星带"。
  //    真实小行星带（以及群星里那条）是**夹在两条相邻轨道之间的一条窄环**。
  //
  //    改法：取最外侧两颗行星之间的**中点**，带宽 = 相邻轨道间距的 22%（窄带）。
  //    ⚠️ 这也顺带修掉了"带子压住行星轨道"的观感 —— 原实现的内外边界直接等于行星轨道位置。
  if (spec.bodies.length >= 2) {
    const rng = new SeededRng(hashString(`${spec.star.name}:belt`));
    const orbits = spec.bodies.map((b) => b.orbit).sort((a, b) => a - b);
    // 用最外两个轨道的中间那条缝（真实恒星系里小行星带通常在火星/木星之间）
    const gapMid = (orbits[orbits.length - 2] + orbits[orbits.length - 1]) / 2;
    const gapSpan = orbits[orbits.length - 1] - orbits[orbits.length - 2];
    const halfWidth = Math.max(0.35, gapSpan * 0.11);   // 窄：带宽 ≈ 轨道间距的 22%
    const inner = gapMid - halfWidth;
    const outer = gapMid + halfWidth;
    // 点的数量随带宽走（窄带不需要 720 个点，会显得密得像实线）
    const n = Math.round(720 * (halfWidth * 2) / Math.max(1, gapSpan));
    const count = Math.max(80, Math.min(720, n));
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = inner + rng.next() * (outer - inner);
      pos[i * 3] = Math.cos(a) * r;
      // 竖向厚度也收窄（原来 ±0.4，在窄带里显得上下一团）
      pos[i * 3 + 1] = (rng.next() - 0.5) * 0.22;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const beltGeo = new THREE.BufferGeometry();
    beltGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const beltMat = new THREE.PointsMaterial({
      color: 0x9a9484, size: 0.13, transparent: true, opacity: 0.55,
      // 关掉距离衰减：正交/透视下都保持同样大小的碎石颗粒（这是"带"的质感，不是"星点"）
      sizeAttenuation: false,
      depthWrite: false,
    });
    const belt = new THREE.Points(track(beltGeo), track(beltMat));
    belt.name = 'belt';
    scene.add(belt);
    beltMesh = belt;    // E5：降到最低档时整条带子关掉（它是纯装饰、点最多）
  }

  // ── 背景（2026-11-25）：星云 → 星场，两层 ─────────────────────────────
  // 用户：「背景空」。参考图里的深空不是纯黑，是"几团极淡的冷色 + 一层颗粒感的星"。
  // 星云先画（renderOrder 更低），星场压在上面；两者都不写深度、不吃光照、不进命中。
  //
  // ⚠️ 星云 sprite 放在 1200 距离的球壳上（相机的 far 是 4000、星场是 900~1600）：
  //    转到哪个角度都有底，不会出现"背景的黑边"。
  const nebulaDirs = [
    { color: 0x2e4f86, dir: [0.55, 0.28, 0.79], scale: 980 },    // 冷蓝
    { color: 0x22665e, dir: [-0.72, 0.34, 0.61], scale: 860 },   // 淡青
    { color: 0x452f70, dir: [0.22, 0.78, -0.58], scale: 900 },   // 淡紫
    { color: 0x5c3038, dir: [-0.46, -0.14, -0.87], scale: 780 }, // 暗红
  ];
  nebulaDirs.forEach((n, i) => {
    const mat = new THREE.SpriteMaterial({
      map: track(makeNebulaTexture(hashString(`${spec.star.name}:nebula:${i}`))),
      color: new THREE.Color(n.color),
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    const sp = new THREE.Sprite(track(mat));
    sp.position.copy(new THREE.Vector3(n.dir[0], n.dir[1], n.dir[2]).normalize().multiplyScalar(1200));
    sp.scale.setScalar(n.scale);
    sp.renderOrder = -90;
    scene.add(sp);
  });

  // 背景星空：1400 → 2200 颗，亮度按幂律分布（多数暗、少数亮）+ 一点冷/暖色差。
  // 原来是一片等亮白点，看着像噪点而不是星空 —— 参考图里星的亮度差得很开。
  const srng = new SeededRng(hashString(`${spec.star.name}:stars`));
  const starN = 2200;
  const starPos = new Float32Array(starN * 3);
  const starCol = new Float32Array(starN * 3);
  const tmpCol = new THREE.Color();
  for (let i = 0; i < starN; i++) {
    const r = 900 + srng.next() * 700;
    const t = srng.next() * Math.PI * 2;
    const ph = Math.acos(2 * srng.next() - 1);
    starPos[i * 3] = r * Math.sin(ph) * Math.cos(t);
    starPos[i * 3 + 1] = r * Math.cos(ph);
    starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(t);
    const b = 0.2 + 0.8 * Math.pow(srng.next(), 2.4);
    tmpCol.setHSL(0.55 + srng.next() * 0.14, 0.25 * srng.next(), b * 0.8);
    starCol[i * 3] = tmpCol.r;
    starCol[i * 3 + 1] = tmpCol.g;
    starCol[i * 3 + 2] = tmpCol.b;
  }
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  bgGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
  const bgMat = new THREE.PointsMaterial({
    // sizeAttenuation: false —— 星点固定 1.7px（远景星场不该因为远近变大变小）
    size: 1.7, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0.95, depthWrite: false,
  });
  const bgStars = new THREE.Points(track(bgGeo), track(bgMat));
  bgStars.renderOrder = -80;
  scene.add(bgStars);

  projectVec.v = new THREE.Vector3();
  stats.geometries = renderer.info.memory.geometries;
  stats.textures = renderer.info.memory.textures;
  stats.labels = labels.length;
  // 验收判据（2026-11-25）：「每颗行星都要有大气」= 壳层数必须等于行星数。
  // 以前 3D 里一颗都没有 —— 用户说的"很多行星根本没有大气"就是这个。
  // 卫星的大气单独计数（薄一档，判据 A2 用），别混进行星那一栏。
  stats.moonAtmospheres = moonAtmoMats.length;
  stats.atmospheres = atmoMats.length - moonAtmoMats.length;
  stats.planets = spec.bodies.filter((b) => b.kind === 'planet').length;
  stats.moons = spec.bodies.reduce((n, b) => n + b.moons.length, 0);
  stats.clouds = cloudMeshes.length;
  stats.rings = ringCount;
  stats.ringShadows = ringShadowCount;
  // E5：初始就在最高档（不预设降档 —— 用户机器够快就不该看到任何变化）
  stats.quality = { level: qualityLevel, pixelRatio: renderer ? renderer.getPixelRatio() : null, avgFrameMs: 0 };
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
      if (o.clouds) o.clouds.rotation.y += 0.33 * dt;   // 云比地表转得快一点
      for (const mp of o.moonPivots) {
        mp.pivot.rotation.y += mp.speed * dt;
        mp.mesh.rotation.y += mp.spin * dt;   // 第三轮：卫星也自转（以前近景是颗不动的球）
      }
    }
    for (const s of starPivots) s.pivot.rotation.y += s.speed * dt;
    // 日冕慢转：静止的放射光针看着像贴纸，转起来才是"被风吹的光"（0.02 rad/s ≈ 5 分钟一圈）
    for (const m of coronaMats) m.rotation += dt * 0.02;
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

  // E5：每 45 帧评一次档（窗口太短会被一次 GC 误伤，太长则用户已经卡了半天）
  qualityAccumMs += dt * 1000;
  qualityAccumN += 1;
  if (qualityAccumN >= 45) {
    qualityAvgMs = qualityAccumMs / qualityAccumN;
    qualityAccumMs = 0;
    qualityAccumN = 0;
    const next = nextQualityLevel(qualityLevel, qualityAvgMs);
    if (next !== qualityLevel) {
      qualityLevel = next;
      applyQuality();
    }
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
  // E1：点选清单与选中态一起清（否则重开 3D 会拿到已 dispose 的 mesh）
  pickables.length = 0;
  picked.value = null;
  raycaster = null;
  // E3/E5：伴星 pivot 与降档状态也归零（重开 3D 从最高档开始）
  starPivots.length = 0;
  atmoMats.length = 0;
  moonAtmoMats.length = 0;
  coronaMats.length = 0;
  cloudMeshes.length = 0;
  ringCount = 0;
  ringShadowCount = 0;
  atmoScale = 1;
  beltMesh = null;
  qualityLevel = 'high';
  qualityAvgMs = 0;
  qualityAccumMs = 0;
  qualityAccumN = 0;
  qualityBadge.value = '';

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
    // E1：点选用的射线检测器（只建一个，每帧不重建）
    raycaster = new THREE.Raycaster();

    const canvas = document.createElement('canvas');
    canvas.className = 'sys3d-canvas';
    canvas.setAttribute('data-testid', 'system-3d-canvas');
    host.value.appendChild(canvas);

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        // 🔴 2026-11-25 改成 true（用户：「这版锯齿感非常强，但是完全没有像素游戏的美感，
        //    只让人觉得模糊」）。
        //
        // 原值是 false —— 那是 2026-10-28 按"低配观感"定的，理由是省 GPU。
        // 但**单星系内部是近景主视图**（不是星域那种远景总览），
        // 行星球面、轨道细线、字母标签全是高对比边缘，关掉 MSAA 后：
        //   · 球面轮廓出现台阶（用户说的"锯齿感"）
        //   · 细轨道线（1px）在斜向被采样成断续的点（用户说的"模糊"）
        // 这两件事同时发生 —— 就是"又锯齿又模糊"。
        //
        // 代价：MSAA 4x 大约多 20~30% 的 GPU（本机实测帧耗 0.4ms → 0.5ms，可忽略）。
        // 低配兜底仍在：`qualityLevel` 自动降档会先把 pixelRatioCap 降下来。
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (e) {
      error.value = `当前环境无法创建 WebGL 上下文（${e && e.message ? e.message : '未知原因'}）。3D 观景需要开启硬件加速。`;
      stats.error = error.value;
      return;
    }
    // 像素比上限 1.5 → 2：高分屏上 1.5 会让细线落在半像素上，反而更糊。
    // （自动降档仍会在帧耗超标时把它压回去）
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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

// ===== 验收 / 排障口（2026-11-25）=====
//
// 为什么要把这几个函数暴露出来：观感件（大气边缘光）**只能在画出来的像素上验**，
// 而 headless 下相机位置每次都不同 —— 没有"把镜头对到这颗行星上"的入口，
// 截图判据就只能靠运气（行星可能在恒星背面、可能被标签压住）。
// 这三个都**不写数据、不改视图状态**，与 `paused` / `getStats` 同一条性质。

/** 缩放：mult > 1 拉近（相机到目标的距离 ÷ mult），夹在 OrbitControls 的上下限里 */
function zoomTo(mult) {
  if (!camera || !controls) return false;
  const k = Number(mult);
  if (!Number.isFinite(k) || k <= 0) return false;
  const off = camera.position.clone().sub(controls.target);
  const dist = Math.max(controls.minDistance, Math.min(controls.maxDistance, off.length() / k));
  camera.position.copy(controls.target).add(off.setLength(dist));
  controls.update();
  return true;
}

/**
 * 把镜头对到某颗行星（验收截图用）。
 * ⚠️ 行星在公转 —— 不暂停的话下一帧就跑出画面，调用方先按 P（`paused`）。
 * @param {string} id body.id
 * @param {number} [distMul] 相机距离 = 行星半径 × distMul（默认 3.2，行星约占屏高 1/3）
 */
function focusBody(id, distMul = 3.2) {
  if (!camera || !controls) return false;
  const hit = pickables.find((p) => p.body.id === id);
  if (!hit) return false;
  const target = new THREE.Vector3();
  hit.mesh.getWorldPosition(target);
  controls.target.copy(target);
  const dist = Math.max(controls.minDistance, hit.body.size * Math.max(1.2, distMul));
  const dir = new THREE.Vector3(0.62, 0.42, 1).normalize().multiplyScalar(dist);
  camera.position.copy(target).add(dir);
  controls.update();
  return true;
}

/** 踢一帧（headless 下 rAF 可能挂住：场景换了但画面没刷 → 截图 0 像素差） */
function tick() {
  if (!renderer || !scene || !camera) return false;
  try { controls?.update(); } catch { /* 上下文丢失时忽略 */ }
  renderer.render(scene, camera);
  return true;
}

/** 世界坐标 → 屏幕像素（含画布在页面里的偏移与 devicePixelRatio，截图上直接能采） */
function projectRect(worldCenter, worldRadius) {
  const el = renderer?.domElement;
  if (!el || !camera) return null;
  // 🔴 必须先强制刷新相机矩阵：`controls.update()` 里只有 `lookAt()` 会改朝向，
  //    而它内部那次 `updateWorldMatrix` 是在**设新四元数之前**跑的 —— 于是
  //    `matrixWorld` 会停在"新位置 + 旧朝向"，`matrixWorldInverse` 更是上一次渲染的。
  //    不刷新就投影，会得到"行星明明在画面正中，算出来却在左上角"这种假数字
  //    （2026-11-25 第一版判据就是这么错的：B/C 两条全红，其实是采样点偏了 400px）。
  camera.updateMatrixWorld(true);
  const w = el.clientWidth || 1;
  const h = el.clientHeight || 1;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const p0 = worldCenter.clone().project(camera);
  const p1 = worldCenter.clone().add(right.multiplyScalar(worldRadius)).project(camera);
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    // canvas 内的 CSS 像素
    cx: ((p0.x + 1) / 2) * w,
    cy: ((1 - p0.y) / 2) * h,
    r: Math.hypot(((p1.x - p0.x) / 2) * w, ((p1.y - p0.y) / 2) * h),
    // 换算到"整页截图"的像素（截图是 devicePixelRatio 倍）
    pageCx: (rect.left + ((p0.x + 1) / 2) * w) * dpr,
    pageCy: (rect.top + ((1 - p0.y) / 2) * h) * dpr,
    pageR: Math.hypot(((p1.x - p0.x) / 2) * w, ((p1.y - p0.y) / 2) * h) * dpr,
    dpr,
  };
}

/**
 * 某颗行星在屏幕上的位置/半径 —— **验收判据用**：像素采样得知道往哪儿采。
 * 行星在公转，所以要采样就得先 `paused = true`（或先 focusBody 再立刻拍）。
 */
function bodyScreenRect(id) {
  const hit = pickables.find((p) => p.body.id === id);
  if (!hit) return null;
  const center = new THREE.Vector3();
  hit.mesh.getWorldPosition(center);
  return projectRect(center, hit.body.size);
}

/** 恒星在屏幕上的位置/半径（同上；日冕/临边昏暗的判据要它） */
function starScreenRect() {
  return projectRect(new THREE.Vector3(0, 0, 0), props.spec.star.radius);
}

/** 验收口：列出天体（id/name/kind）—— 截图脚本要挑一颗行星聚焦，不该去猜 spec 的结构 */
function listBodies() {
  return pickables.map((p) => ({ id: p.body.id, name: p.body.name, kind: p.body.kind, ring: !!p.body.ring }));
}

/**
 * 大气强度总系数（**验收的反向探针**用）：0 = 全关，1 = 正常。
 * 判据是"关掉之后行星轮廓外那圈亮度必须掉下来"—— 没有这个口就没法证明
 * 截图里那圈光真的是大气壳层画的，而不是背景星云碰巧亮在那里。
 *
 * @param {number} k 0~2
 * @param {string} [onlyId] 只改这一颗（天体 id）。**验收必须用它**：
 *   画面里还有别的行星/卫星，全局关掉会让它们的轮廓也一起变，判据就成了假红
 *   （2026-11-25 第二轮，卫星刚加上就把判据 C 顶红了）。
 */
function setAtmosphereScale(k, onlyId) {
  const v = Number(k);
  const scale = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
  const target = onlyId ? String(onlyId) : '';
  for (const m of atmoMats) {
    if (target && m.userData.bodyId !== target) continue;
    m.uniforms.uStrength.value = (m.userData.baseStrength || 0) * scale;
  }
  if (!target) {
    atmoScale = scale;
    stats.atmoScale = atmoScale;
  }
  return scale;
}

/**
 * 日冕强度总系数（同样是**验收的反向探针**）：0 = 关掉光针，1 = 正常。
 * 判据是"关掉之后，恒星周围那一圈的**角向变异系数**必须掉下来"——
 * 没有这个口就没法证明截图里那些放射光针是日冕画的，而不是星云/背景星碰巧排成那样。
 */
function setCoronaScale(k) {
  const v = Number(k);
  const s = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
  for (const m of coronaMats) m.opacity = (m.userData.baseOpacity || 0) * s;
  stats.coronaScale = s;
  return s;
}

defineExpose({
  getStats, paused, zoomTo, focusBody, tick, setAtmosphereScale, setCoronaScale,
  bodyScreenRect, starScreenRect, listBodies,
});
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

/* E1/E2（2026-10-29）：点中行星后的卡片（改类型 / 下钻） */
.sys3d-card {
  position: absolute;
  left: 18px;
  bottom: 18px;
  min-width: 240px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 8px;
  background: rgba(12, 18, 30, 0.88);
  backdrop-filter: blur(6px);
  color: #dbe4f3;
  font-size: 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
}
.sys3d-card-head { display: flex; align-items: baseline; gap: 8px; }
.sys3d-card-head strong { font-size: 14px; color: #f1f5fb; }
.sys3d-card-sub { color: #8b98b3; font-size: 11px; }
.sys3d-card-x {
  margin-left: auto;
  border: none; background: transparent; color: #8b98b3;
  cursor: pointer; display: inline-flex; padding: 0 2px;
}
.sys3d-card-row { display: flex; align-items: center; gap: 8px; color: #9fb0c8; }
.sys3d-card-row select {
  flex: 1;
  background: #0f172a; color: #dbe4f3;
  border: 1px solid rgba(148, 163, 184, 0.4); border-radius: 4px;
  padding: 2px 6px; font-size: 12px;
}
.sys3d-color {
  width: 30px; height: 20px;
  padding: 0; border: 1px solid rgba(148, 163, 184, 0.45); border-radius: 4px;
  background: transparent; cursor: pointer;
}
.sys3d-preset-name {
  flex: 1; min-width: 0;
  background: #0f172a; color: #dbe4f3;
  border: 1px solid rgba(148, 163, 184, 0.4); border-radius: 4px;
  padding: 2px 6px; font-size: 12px;
}
.sys3d-preset-save {
  border: 1px solid rgba(148, 163, 184, 0.45); border-radius: 4px;
  background: rgba(30, 41, 59, 0.9); color: #dbe4f3;
  padding: 3px 8px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.sys3d-preset-save:hover { background: rgba(51, 65, 85, 0.95); }
.sys3d-card-go {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid rgba(56, 189, 248, 0.55);
  background: rgba(56, 189, 248, 0.16);
  color: #e2f3ff; border-radius: 4px;
  padding: 5px 10px; font-size: 12px; cursor: pointer;
}
.sys3d-card-go:hover { background: rgba(56, 189, 248, 0.26); }

/* E5（2026-10-29）：自动降档提示（只在真的降了才出现） */
.sys3d-quality {
  position: absolute;
  left: 18px;
  top: 78px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid rgba(250, 204, 21, 0.45);
  background: rgba(120, 53, 15, 0.55);
  color: #fde68a;
  font-size: 11px;
  pointer-events: none;
}
</style>
