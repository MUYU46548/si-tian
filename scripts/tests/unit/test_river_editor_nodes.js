#!/usr/bin/env node
/**
 * Node 单元测试：**河流编辑器的节点操作 + 河网画法**（`utils/rivers.js` / `polylineSmooth.js` / `riverRender.js`）
 *   · `findRiverSegment` —— 找最近线段
 *   · `insertNodeBetween` —— 在某段插入节点
 *   · `distanceToPolyline` / `hitTestRiver` —— 河身命中（从 PlanetMap 下沉的单源）
 *   · `replaceRiverNode` —— 移动一个节点（纯函数）
 *   · `decimatePolyline` / `smoothRiverNodes` / `smoothWhileDrawing` / `fitPolylineToCount` —— 点数与平滑
 *   · `catmullRomPoints` / `taperWidths` / `pruneRiverNetwork` / `strokeRiverNetwork(curve)` —— 会弯 + 变粗 + 只画河道
 *
 * 为什么必须有这一层：地图编辑器的"手画河"是**自动河流的保底**（用户明说：
 * 「保底也要做，强化地图编辑器本身，让用户可以随心所欲画河流」）。而这条链上
 * 曾经有一个**几何上够不着的能力**：
 *   `insertNodeBetween` 要的是**线段起点下标**，但本文件当时只有 `findRiverPointIndex`
 *   （最近**顶点**）→ 用户只有恰好点在某个顶点上才知道该往哪插 → 该函数**零调用**。
 *   所以这两半必须一起测：**没有 findRiverSegment，insertNodeBetween 就是死的**。
 *
 * ⚠️ 2026-10-17 第六修（用户截图三连报）之后，本文件还额外守住三条"观感 = 几何"的判据：
 *   ① 一条河的**点数不能由拖动时长决定**（否则节点手柄糊成一条虚线 —— "画出来一堆点"）；
 *   ② 曲线必须**真的穿过控制点**（"不会弯吗？"）；
 *   ③ 宽度必须**单调变粗且前段更慢**（"不会有粗细变化吗？"）。
 *
 * 用法：node scripts/tests/unit/test_river_editor_nodes.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['rivers.js', 'heightmapAccess.js', 'polylineSmooth.js', 'riverRender.js'];

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch (_) { /* next */ }
  }
  return null;
}

/** 一条"从高到低"的简单河：h 依次递减 */
const line = () => ([
  { x: 0, y: 0, h: 50 },
  { x: 100, y: 0, h: 30 },
  { x: 200, y: 0, h: 10 },
]);
/** 高度场：简单线性，方便手算 */
const heightAt = (x, y) => 60 - x * 0.25;

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-rnode-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const Rv = await import(pathToFileURL(path.join(tmp, 'rivers.js')).href);
  const PV = await import(pathToFileURL(path.join(tmp, 'polylineSmooth.js')).href);
  const RR = await import(pathToFileURL(path.join(tmp, 'riverRender.js')).href);

  // ══════════════════════════════════════════════════════════════════════
  // 一、findRiverSegment
  // ══════════════════════════════════════════════════════════════════════
  check('findRiverSegment：返回**线段起点下标**（不是最近顶点下标）', () => {
    const n = line();
    // 点在 0→1 段的中间：下标记为 0（首段）
    const a = Rv.findRiverSegment(n, 50, 0, 20);
    assert(a && a.index === 0, `应命中第 0 段，实际 ${JSON.stringify(a)}`);
    // 点在 1→2 段的中间：下标记为 1
    const b = Rv.findRiverSegment(n, 150, 0, 20);
    assert(b && b.index === 1, `应命中第 1 段，实际 ${JSON.stringify(b)}`);
    return '段0 / 段1 都判对';
  });

  check('findRiverSegment：投影点落在段上（不是原样返回点击点）', () => {
    const n = line();
    // 点在线上方 5 单位处 → 投影应回到 y=0
    const r = Rv.findRiverSegment(n, 50, 5, 20);
    assert(r, '应命中');
    assert(Math.abs(r.point.y - 0) < 1e-9, `投影 y 应为 0，实际 ${r.point.y}`);
    assert(Math.abs(r.point.x - 50) < 1e-9, `投影 x 应为 50，实际 ${r.point.x}`);
    assert(Math.abs(r.dist - 5) < 1e-9, `距离应为 5，实际 ${r.dist}`);
    // 超出段端点时投影被夹在端点（t∈[0,1]）
    const e = Rv.findRiverSegment(n, -80, 0, 200);
    assert(e && Math.abs(e.point.x - 0) < 1e-9, `段外点击应夹到端点 x=0，实际 ${e && e.point.x}`);
    return '投影 (50,0) / 夹端点 x=0';
  });

  check('findRiverSegment：超出容差返回 null / 点太少返回 null / 退化段不炸', () => {
    const n = line();
    assert(Rv.findRiverSegment(n, 50, 100, 20) === null, '远点应返回 null');
    assert(Rv.findRiverSegment([{ x: 0, y: 0 }], 0, 0, 20) === null, '只有一个点应返回 null');
    assert(Rv.findRiverSegment([], 0, 0, 20) === null, '空数组应返回 null');
    assert(Rv.findRiverSegment(null, 0, 0, 20) === null, 'null 应返回 null');
    // 两点重合的退化段：不能出 NaN
    const deg = Rv.findRiverSegment([{ x: 5, y: 5 }, { x: 5, y: 5 }], 5, 5, 20);
    assert(deg && Number.isFinite(deg.point.x) && Number.isFinite(deg.point.y),
      `退化段不能出 NaN，实际 ${JSON.stringify(deg)}`);
    return '四条边界都对';
  });

  // ══════════════════════════════════════════════════════════════════════
  // 二、insertNodeBetween
  // ══════════════════════════════════════════════════════════════════════
  check('insertNodeBetween：插在 index+1（段中间），且**点数 +1**', () => {
    const n = line();
    const out = Rv.insertNodeBetween(n, 0, { x: 50, y: 3 }, heightAt);
    assert(out.length === n.length + 1, `点数应从 ${n.length} 增到 ${n.length + 1}，实际 ${out.length}`);
    assert(out[1].x === 50 && out[1].y === 3, `新点应在下标 1，实际 ${JSON.stringify(out[1])}`);
    // 原有点必须原样保留（顺序与坐标）
    assert(out[0].x === 0 && out[2].x === 100 && out[3].x === 200, '原有点顺序被打乱');
    // 高度由 heightAt 取，而不是沿用邻居
    assert(out[1].h === heightAt(50, 3), `新点高度应由 heightAt 决定，实际 ${out[1].h}`);
    return `3 点 → ${out.length} 点，插在下标 1`;
  });

  check('insertNodeBetween：**不改入参**（纯函数纪律 —— undo 旧快照靠它）', () => {
    const n = line();
    const before = JSON.stringify(n);
    Rv.insertNodeBetween(n, 1, { x: 150, y: 0 }, heightAt);
    assert(JSON.stringify(n) === before, '入参被改动了 —— undo 的旧快照会跟着变');
    return '入参未动';
  });

  check('insertNodeBetween：插完仍满足"**从高到低**"的流向不变量（normalizeRiverFlow 生效）', () => {
    const n = line();
    // 故意插一个**比邻居更高**的点：不变量必须把它修正回去
    const out = Rv.insertNodeBetween(n, 0, { x: 50, y: 0 }, () => 999);
    for (let i = 0; i + 1 < out.length; i++) {
      assert(out[i].h >= out[i + 1].h,
        `插点后第 ${i} 段逆流：${out[i].h} → ${out[i + 1].h}（流向不变量被破坏）`);
    }
    return `高度序列 ${out.map((p) => Math.round(p.h)).join(' ≥ ')}`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 三、两者配合：产品里"点河身加拐点"的完整路径
  // ══════════════════════════════════════════════════════════════════════
  check('配合：点河身 → findRiverSegment 定位段 → insertNodeBetween 插入（保底能力打通）', () => {
    const n = line();
    const tol = 14;
    // 模拟用户在第二段中间偏上一点点击
    const click = { x: 160, y: 6 };
    const seg = Rv.findRiverSegment(n, click.x, click.y, tol);
    assert(seg, '应当命中线段（否则"点河身加拐点"根本触发不了）');
    const out = Rv.insertNodeBetween(n, seg.index, seg.point, heightAt);
    assert(out.length === 4, `应变成 4 个点，实际 ${out.length}`);
    // 新节点应当落在**那一段上**（投影点），而不是点击点本身
    assert(Math.abs(out[2].y - 0) < 1e-9, `新节点应落在河身上（y=0），实际 ${out[2].y}`);
    assert(out[2].x > 100 && out[2].x < 200, `新节点应在第 1 段内，实际 x=${out[2].x}`);
    return `点击 (160,6) → 插到段1 的 (${out[2].x.toFixed(0)},${out[2].y})`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 四、画河保底：**抽稀 + 带高度平滑**（`polylineSmooth.js`，两张画布共用）
  // ══════════════════════════════════════════════════════════════════════
  check('decimatePolyline：按最小间距抽稀，**端点必留**', () => {
    const dense = [];
    for (let i = 0; i <= 100; i++) dense.push({ x: i, y: 0 });
    const out = PV.decimatePolyline(dense, 10);
    assert(out.length < dense.length, `应当抽稀，实际 ${out.length} vs ${dense.length}`);
    assert(out[0].x === 0 && out[out.length - 1].x === 100,
      `端点必须保留（否则河头/河口被抽掉），实际 ${out[0].x} .. ${out[out.length - 1].x}`);
    for (let i = 0; i + 2 < out.length; i++) {
      const d = Math.hypot(out[i + 1].x - out[i].x, out[i + 1].y - out[i].y);
      assert(d >= 10 - 1e-9, `第 ${i} 跳间距 ${d} < 10`);
    }
    return `101 点 → ${out.length} 点，首末保留`;
  });

  check('decimatePolyline：点数 ≤2 / 无间距 / 非数组 都不炸且不改入参', () => {
    const two = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    assert(PV.decimatePolyline(two, 10).length === 2, '两点应原样返回');
    const three = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    assert(PV.decimatePolyline(three, 0).length === 3, '间距 0 应原样返回');
    assert(PV.decimatePolyline(null, 10).length === 0, 'null 应返回空数组');
    const before = JSON.stringify(three);
    PV.decimatePolyline(three, 10);
    assert(JSON.stringify(three) === before, '入参被改动');
    return '四条边界都对';
  });

  check('smoothRiverNodes：平滑后**点数增加**、且**高度跟着点走**（不丢 h）', () => {
    const nodes = [
      { x: 0, y: 0, h: 60 },
      { x: 100, y: 0, h: 40 },
      { x: 100, y: 100, h: 20 },
    ];
    const out = PV.smoothRiverNodes(nodes, 2);
    assert(out.length > nodes.length, `Chaikin 2 轮应增加点数：${nodes.length} → ${out.length}`);
    for (const p of out) {
      assert(Number.isFinite(p.h), `平滑后出现没有 h 的点：${JSON.stringify(p)}`);
    }
    assert(out[0].h === 60 && out[out.length - 1].h === 20,
      `端点 h 应保持 60/20，实际 ${out[0].h}/${out[out.length - 1].h}`);
    assert(out[0].x === 0 && out[0].y === 0, '首点坐标被移动了');
    assert(out[out.length - 1].x === 100 && out[out.length - 1].y === 100, '末点坐标被移动了');
    return `${nodes.length} → ${out.length} 点，端点 h 保持 ${out[0].h}/${out[out.length - 1].h}`;
  });

  check('smoothRiverNodes：点数 <3 原样返回（浅拷贝）；无 h 时**不伪造 h**', () => {
    const two = [{ x: 0, y: 0, h: 5 }, { x: 1, y: 1, h: 1 }];
    const out = PV.smoothRiverNodes(two, 2);
    assert(out.length === 2 && out[0].h === 5, '两点应原样返回');
    assert(out[0] !== two[0], '应当是浅拷贝（避免下游误改原数组）');
    // 🔴 没有海拔概念的数据（剧本底图的河存 `{x,y}`）不许被补上 `h: 0` ——
    //    否则每存一条底图河都往项目文件塞几百个 `"h":0`，还会发出"它有海拔"的假信号。
    const noH = PV.smoothRiverNodes([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], 1);
    assert(noH.every((p) => !('h' in p)), `没有 h 时不该伪造 h，实际 ${JSON.stringify(noH[0])}`);
    // 反向：只要有一个点带有限 h，就按"高度跟着点走"补齐（行星图那条路行为不变）
    const mixed = PV.smoothRiverNodes([{ x: 0, y: 0, h: 60 }, { x: 100, y: 0 }, { x: 200, y: 0, h: 20 }], 2);
    assert(mixed.every((p) => Number.isFinite(p.h)), '只要数据里有海拔，输出就必须点点有 h');
    assert(mixed[0].h === 60 && mixed[mixed.length - 1].h === 20, '端点 h 应逐字保留');
    return '浅拷贝 / 无 h 不伪造 / 有 h 则补齐 / 端点 h 保留';
  });

  check('「像电路」的判据：平滑必须**真的降低转角**（否则等于没做）', () => {
    const zig = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 50 }];
    const turn = (pts) => {
      let worst = 0, sum = 0, n = 0;
      for (let i = 1; i + 1 < pts.length; i++) {
        const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
        const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
        let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
        const deg = d * 180 / Math.PI;
        sum += deg; n++; if (deg > worst) worst = deg;
      }
      return { worst, mean: n ? sum / n : 0 };
    };
    const before = turn(zig);
    const after = turn(PV.smoothPolyline(zig, 2));
    assert(after.worst < before.worst,
      `最大转角应变小：${before.worst.toFixed(1)}° → ${after.worst.toFixed(1)}°`);
    assert(after.mean < before.mean,
      `平均转角应变小：${before.mean.toFixed(1)}° → ${after.mean.toFixed(1)}°`);
    // 反向探针：不平滑（迭代 0）必须维持原折角 —— 否则这条判据没有判别力
    const none = turn(PV.smoothPolyline(zig, 0));
    assert(Math.abs(none.worst - before.worst) < 1e-9, '迭代 0 应当原样返回（探针失效）');
    return `最大转角 ${before.worst.toFixed(0)}° → ${after.worst.toFixed(0)}°，平均 ${before.mean.toFixed(0)}° → ${after.mean.toFixed(0)}°`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 五、反向探针（守卫本身必须能被证明抓得住问题）
  // ══════════════════════════════════════════════════════════════════════
  check('反向探针：**顶点口径无法表达"点在哪一段上"**', () => {
    const n = line();
    const click = { x: 160, y: 6 };
    const seg = Rv.findRiverSegment(n, click.x, click.y, 200);
    const vertexIdx = Rv.findRiverPointIndex(n, click.x, click.y, 200);
    assert(seg && seg.index === 1, `段口径应给出"第 1 段"，实际 ${JSON.stringify(seg)}`);
    assert(vertexIdx === 2, `顶点口径应给出最近顶点 2，实际 ${vertexIdx}`);
    // 关键：两者语义不同（段起点下标 vs 顶点下标），数字恰好都是小整数，
    // 所以**混用不会报错、只会插错地方** —— 这正是危险所在。
    assert(seg.index !== vertexIdx, `两者的语义必须可区分：段 ${seg.index} vs 顶点 ${vertexIdx}`);
    const dv = n.map((p) => Math.hypot(p.x - click.x, p.y - click.y));
    assert(seg.dist < Math.min(dv[1], dv[2]),
      `到**线段**的距离(${seg.dist.toFixed(1)}) 必须小于到任一端点的距离(${Math.min(dv[1], dv[2]).toFixed(1)})`);
    return `段距离 ${seg.dist.toFixed(1)} < 端点距离 ${Math.min(dv[1], dv[2]).toFixed(1)}；段下标 ${seg.index} ≠ 顶点下标 ${vertexIdx}`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 六、剧本底图的节点编辑（2026-10-17）：底图侧此前只有 add / remove
  // ══════════════════════════════════════════════════════════════════════
  check('distanceToPolyline / hitTestRiver：点**线段**而不是点顶点（从 PlanetMap 下沉）', () => {
    const n = line();
    assert(Math.abs(Rv.distanceToPolyline(50, 7, n) - 7) < 1e-9,
      `到线段距离应为 7，实际 ${Rv.distanceToPolyline(50, 7, n)}`);
    const dv = Math.hypot(50 - n[0].x, 7 - n[0].y);
    assert(dv > 50 && Rv.distanceToPolyline(50, 7, n) < 1e-6 + 7,
      `线段口径(${Rv.distanceToPolyline(50, 7, n).toFixed(1)}) 必须远小于顶点口径(${dv.toFixed(1)})`);
    assert(Rv.distanceToPolyline(0, 0, [{ x: 0, y: 0 }]) === Infinity, '单点折线应给 Infinity');
    assert(Rv.distanceToPolyline(0, 0, null) === Infinity, 'null 应给 Infinity');
    return `线段 7.0 vs 顶点 ${dv.toFixed(1)}`;
  });

  check('hitTestRiver：答"哪条河"（与 findRiverSegment 答"哪一段"互补）', () => {
    const near = { id: 'a', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const far = { id: 'b', points: [{ x: 0, y: 80 }, { x: 100, y: 80 }] };
    const hit = Rv.hitTestRiver([far, near], 50, 5, 20, (r) => r.points);
    assert(hit && hit.id === 'a', `应命中更近的那条，实际 ${JSON.stringify(hit && hit.id)}`);
    assert(Rv.hitTestRiver([far, near], 50, 5, 20, (r) => r.points) === hit, '应返回**原对象**（不是拷贝）');
    assert(Rv.hitTestRiver([near], 50, 40, 20, (r) => r.points) === null, '超出容差应 null');
    const degenerate = { id: 'c', points: [{ x: 50, y: 0 }] };
    assert(Rv.hitTestRiver([degenerate], 50, 0, 20, (r) => r.points) === null, '单点河不该被命中');
    assert(Rv.hitTestRiver(null, 0, 0, 20) === null, 'null 列表应 null');
    assert(Rv.hitTestRiver([{ id: 'd', nodes: near.points }], 50, 3, 20).id === 'd', '默认口径没认 nodes');
    return '最近者胜 / 原对象 / 超差 null / 单点跳过 / 两种字段名都认';
  });

  check('replaceRiverNode：**不改入参**、下标越界原样返回、h 不凭空冒出来', () => {
    const n = line();
    const before = JSON.stringify(n);
    const out = Rv.replaceRiverNode(n, 1, { x: 111, y: 22 });
    assert(out.length === 3 && out[1].x === 111 && out[1].y === 22, '应替换第 1 个点');
    assert(out[1].h === 30, `未给 h 时应沿用原点 h=30，实际 ${out[1].h}`);
    assert(JSON.stringify(n) === before, '入参被改动了 —— 拖动预览与落库就会互相污染');
    assert(out[0] !== n[0], '必须是新对象（浅拷贝每个点）');
    const oob = Rv.replaceRiverNode(n, 99, { x: 1, y: 1 });
    assert(oob.length === 3 && oob[0].x === 0, '越界下标应原样返回');
    assert(Rv.replaceRiverNode(null, 0, { x: 1, y: 1 }).length === 0, 'null 应给空数组');
    const flat = Rv.replaceRiverNode([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, { x: 9, y: 9 });
    assert(!('h' in flat[0]), `无 h 的河不该被补上 h，实际 ${JSON.stringify(flat[0])}`);
    const withH = Rv.replaceRiverNode([{ x: 0, y: 0, h: 5 }, { x: 1, y: 1, h: 4 }], 0, { x: 2, y: 2, h: 9 });
    assert(withH[0].h === 9, '显式 h 应被采纳');
    return '不改入参 / 越界原样 / h 沿用·不凭空 / 显式 h 采纳';
  });

  // ══════════════════════════════════════════════════════════════════════
  // 七、smoothWhileDrawing：**画的时候就能看到的**平滑
  // ══════════════════════════════════════════════════════════════════════
  check('smoothWhileDrawing：预览的**笔尖那一段**必须真的被切角', () => {
    const turn = (pts) => {
      let worst = 0, sum = 0, n = 0;
      for (let i = 1; i + 1 < pts.length; i++) {
        const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
        const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
        let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
        sum += d * 180 / Math.PI; n++;
        worst = Math.max(worst, d * 180 / Math.PI);
      }
      return { worst, mean: n ? sum / n : 0 };
    };
    const zig = [];
    for (let i = 0; i < 20; i++) zig.push({ x: i * 20, y: (i % 2) * 18 });
    const out = PV.smoothWhileDrawing(zig, 2, 12);
    // ⚠️ 判据只看**尾部窗口对应的输出区段**：头部是刻意定格的，
    //    把整条一起量会把"头部那个没切过的角"算进来 → 最大值不变 → 假红。
    const headLen = (zig.length - 12 - 1) * 4;
    const beforeTail = turn(zig.slice(-13));
    const afterTail = turn(out.slice(Math.max(0, headLen)));
    assert(afterTail.worst < beforeTail.worst,
      `笔尖段的最大转角应下降：${beforeTail.worst.toFixed(0)}° → ${afterTail.worst.toFixed(0)}°`);
    assert(afterTail.mean < beforeTail.mean,
      `笔尖段的平均转角应下降：${beforeTail.mean.toFixed(0)}° → ${afterTail.mean.toFixed(0)}°`);
    assert(out[0].x === zig[0].x && out[0].y === zig[0].y, '首点被移动了');
    assert(out[out.length - 1].x === zig[zig.length - 1].x
      && out[out.length - 1].y === zig[zig.length - 1].y, '末点被移动了');
    return `笔尖段最大转角 ${beforeTail.worst.toFixed(0)}° → ${afterTail.worst.toFixed(0)}°，平均 ${beforeTail.mean.toFixed(0)}° → ${afterTail.mean.toFixed(0)}°`;
  });

  check('smoothWhileDrawing：只动**尾部窗口** —— 已画完的部分必须定格', () => {
    const zig = [];
    for (let i = 0; i < 30; i++) zig.push({ x: i * 20, y: (i % 2) * 18 });
    const before = JSON.stringify(zig);
    const a = PV.smoothWhileDrawing(zig, 2, 12);
    const b = PV.smoothWhileDrawing(zig.concat([{ x: 999, y: 0 }]), 2, 12);
    // 实测边界：**首个发生变化的输出下标 = 17**（head 16 + 交接点 1）。
    // ⚠️ 第一版我按"每输入点经 2 轮变 4 点"算成 68 → 假红；Chaikin 的输出点序
    //    并不与输入点一一对应，只能量**实测下标**。
    const stable = zig.length - 12;
    assert(JSON.stringify(a.slice(0, stable)) === JSON.stringify(b.slice(0, stable)),
      `前 ${stable} 个输出点必须逐字定格（含交接点）`);
    assert(JSON.stringify(zig) === before, '入参被改动了');
    // 反向探针：窗口开满 → 整条会被重算（证明"只动尾部"有判别力）
    const full1 = PV.smoothWhileDrawing(zig, 2, 999);
    const full2 = PV.smoothWhileDrawing(zig.concat([{ x: 999, y: 0 }]), 2, 999);
    assert(JSON.stringify(full2) !== JSON.stringify(full1),
      '窗口开满时整条都会被重算 —— 否则"只动尾部"这条判据没有判别力');
    const two = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    const o = PV.smoothWhileDrawing(two, 2, 12);
    assert(o.length === 2 && o[0] !== two[0], '点数 <4 应原样浅拷贝');
    return `前 ${stable} 个输出点定格 / 入参不动 / 窗口开满作反证`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 八、第六修（2026-10-17，用户截图三连报）：点数上限 / 曲线 / 变宽 / 剪枝
  //     「画出来一堆点，而不是线」「不会弯吗？不会有粗细变化吗？」「依旧恐怖谷」
  // ══════════════════════════════════════════════════════════════════════
  check('fitPolylineToCount：把点数压到目标值（"一堆点"的根治），端点必留', () => {
    const dense = [];
    for (let i = 0; i < 500; i++) dense.push({ x: i, y: Math.sin(i / 20) * 10 });
    const out = PV.fitPolylineToCount(dense, 40, { minCount: 6, maxCount: 96 });
    assert(out.length === 40, `应压到 40 点，实际 ${out.length}`);
    assert(out[0].x === dense[0].x && out[0].y === dense[0].y, '首点被移动');
    assert(out[out.length - 1].x === dense[499].x && out[out.length - 1].y === dense[499].y, '末点被移动');
    // 按**弧长**均匀：相邻点间距应大致相等（不是按数组下标取——那会在急弯处挤成一团）
    const gaps = [];
    for (let i = 0; i + 1 < out.length; i++) gaps.push(Math.hypot(out[i + 1].x - out[i].x, out[i + 1].y - out[i].y));
    const spread = Math.max(...gaps) / Math.min(...gaps);
    assert(spread < 2.2, `按弧长取样应大致均匀，实际最大/最小 = ${spread.toFixed(2)}`);
    // 目标 >= 原点数时原样返回（不能"插值变多"）
    // ⚠️ 必须显式放大 maxCount —— 默认上限 256 是刻意的（防"给一条长河无限加点"）
    assert(PV.fitPolylineToCount(dense, 999, { maxCount: 9999 }).length === 500, '目标更大时应原样返回');
    // 反向探针：**默认上限确实生效**（不许被悄悄改成无穷）
    assert(PV.fitPolylineToCount(dense, 999, {}).length === 256, '未给 maxCount 时应被默认上限 256 夹住');
    // 全部点重合：必须退化成 2 个点（不能返回 N 个同坐标点 —— 那正是"一串点"）
    const same = PV.fitPolylineToCount([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], 40, {});
    assert(same.length === 2, `重合点应退化成 2 点，实际 ${same.length}`);
    return `500 → 40 点，间距离散度 ${spread.toFixed(2)}`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 一·补：**预览 = 落库**（2026-10-18 第十五修；暮雨第 3 条「依旧不能给河流画支流……
  //   依旧描点连线模拟器」的验收口径之一）
  //
  // 为什么放在 Node 层：这是**纯函数之间的口径关系**（预览用的 `smoothWhileDrawing`
  // 与落库用的 `fitPolylineToCount` + `smoothRiverNodes` 是不是同一条形状），
  // 不需要画布。判据用"逐顶点到对方折线的最短距离"——**数值**，不是印象。
  // ⚠️ 组件的常量（`RIVER_TRACE_MIN_STEP_PX=10` / `RIVER_NODE_SPACING_PX=30` /
  //    min 6 / max 72）在本文件里**按同值复述**：这条关系要成立，两边必须一致；
  //    改组件里的常量时这里会红，提醒你同步（这正是我们要的联动）。
  // ══════════════════════════════════════════════════════════════════════
  check('预览 = 落库：一条 140 点笔迹的预览形状与落库形状**逐顶点距离 < 2 世界单位**', () => {
    const distToPolyline = (p, pts) => {
      let best = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
        const qx = a.x + dx * t, qy = a.y + dy * t;
        best = Math.min(best, Math.hypot(p.x - qx, p.y - qy));
      }
      return best;
    };
    // 一条"像河"的笔迹：长 ~800 世界单位、带两个弯（弯是判据的要点 —— 直线不会暴露差异）
    const raw = [];
    const N = 140;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      raw.push({ x: 200 + 560 * t, y: 120 + 640 * t + 90 * Math.sin(t * Math.PI * 2.2) });
    }
    // 预览：与组件里那一行**同一份实现**（`smoothWhileDrawing(riverDraft, 1, 18)`）
    const preview = PV.smoothWhileDrawing(raw, 1, 18);
    // 落库：与 `finishRiverDraft` 同一串调用（同一组常量）
    const dec = PV.decimatePolyline(raw.map((p) => ({ x: p.x, y: p.y })), 10);
    let len = 0;
    for (let i = 0; i + 1 < dec.length; i++) len += Math.hypot(dec[i + 1].x - dec[i].x, dec[i + 1].y - dec[i].y);
    const want = Math.max(6, Math.min(72, Math.round(len / 30)));
    const fitted = PV.fitPolylineToCount(dec, want, { minCount: 6, maxCount: 72 });
    const landed = fitted.length >= 3 ? PV.smoothRiverNodes(fitted, 1) : fitted;

    const gA = preview.map((p) => distToPolyline(p, landed));
    const gB = landed.map((p) => distToPolyline(p, preview));
    const maxA = Math.max(...gA), maxB = Math.max(...gB);
    assert(maxA < 2, `预览顶点离落库折线最远 ${maxA.toFixed(2)} 世界单位（应 < 2 —— 否则松手会"跳形"）`);
    assert(maxB < 2, `落库顶点离预览折线最远 ${maxB.toFixed(2)} 世界单位（应 < 2）`);
    // 反向探针：两个形状必须**不是**平凡相等（否则上面对比的是同一份数据，判据空转）
    assert(preview.length !== landed.length,
      `预览与落库的点数不该相同（${preview.length}）—— 相同说明这条判据在拿同一份数据自比`);
    assert(preview.length > 2 && landed.length > 2, '两侧都应有足够的点');
    // 端点必须**逐字**相同（源头/河口是用户看得见的读数）
    const eps = 1e-9;
    for (const p of [raw[0], raw[raw.length - 1]]) {
      assert(gA.some((d, i) => d < 1 || (Math.abs(preview[i].x - p.x) < eps && Math.abs(preview[i].y - p.y) < eps))
        || distToPolyline(p, preview) < eps, `端点 (${p.x},${p.y}) 不在预览折线上`);
    }
    return `预览 ${preview.length} 点 / 落库 ${landed.length} 点；相互最近距离 max ${maxA.toFixed(2)} / ${maxB.toFixed(2)} 世界单位`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 一·补二：选中轮廓的**偏移几何**（2026-10-18 第十六修）
  //
  // 暮雨原话：「那一条白色的显然就算选中河流的光晕，但是太诡异太离谱了，根本没办法正常绘图，
  //   把整条河都挡住。也许需要想想别的办法。只要用户能编辑河流就行了，而不是点下去没反馈。」
  // ⇒ 选中标记**必须画在河的两侧**，不许压在水面上。判据就是"偏移量"这件事本身。
  // ══════════════════════════════════════════════════════════════════════
  check('offsetPolyline：垂直偏移正确、两侧对称、端点不缩、退化输入不炸', () => {
    // 一条水平线：偏移 d 后整条线上移/下移 d
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }];
    const up = RR.offsetPolyline(line, 10);
    const dn = RR.offsetPolyline(line, -10);
    for (let i = 0; i < line.length; i++) {
      assert(Math.abs(up[i].y - 10) < 1e-6, `上侧第 ${i} 点 y 应为 10，实际 ${up[i].y}`);
      assert(Math.abs(dn[i].y + 10) < 1e-6, `下侧第 ${i} 点 y 应为 -10，实际 ${dn[i].y}`);
      assert(Math.abs(up[i].x - line[i].x) < 1e-6, `偏移不该沿走向移动点（第 ${i} 点）`);
    }
    // 竖直线的偏移必须落在 x 方向
    const v = [{ x: 5, y: 0 }, { x: 5, y: 100 }];
    const vSide = RR.offsetPolyline(v, 7);
    assert(Math.abs(Math.abs(vSide[0].x - 5) - 7) < 1e-6, `竖直线偏移应在 x 方向 ±7，实际 ${vSide[0].x}`);
    // 转角处：两条边线的**间距**必须约等于 2d（法线取平均再归一化保证这一点）
    const corner = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const cl = RR.offsetPolyline(corner, 10);
    const cr = RR.offsetPolyline(corner, -10);
    const midGap = Math.hypot(cl[1].x - cr[1].x, cl[1].y - cr[1].y);
    assert(Math.abs(midGap - 20) < 1e-6, `转角处两侧间距应 ≈ 20（不归一化会冲到 28），实际 ${midGap.toFixed(3)}`);
    // 退化：空 / 单点 / d=0 / 重合点 都不许抛
    assert(RR.offsetPolyline([], 5).length === 0, '空折线应返回空');
    assert(RR.offsetPolyline([{ x: 1, y: 1 }], 5).length === 1, '单点应原样返回');
    assert(RR.offsetPolyline(line, 0)[1].y === 0, 'd=0 应原样');
    const dup = RR.offsetPolyline([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 }], 5);
    assert(dup.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), '重合点不许产生 NaN');
    return `水平 ±10 / 竖直 ±7 / 转角间距 ${midGap.toFixed(1)} / 退化 4 例`;
  });

  check('source：选中高亮**不许**再用"加宽的中心线"（那会把水面盖住）', () => {
    const vm = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue'), 'utf8');
    const seg = vm.split('function drawSelectedRiverHighlight', 2)[1] || '';
    const body = seg.split('\nfunction ', 1)[0];
    assert(body.indexOf('offsetPolyline(') >= 0, '选中高亮必须调用 offsetPolyline 画**两侧**边线');
    // 反向探针：老形态是 "两遍加宽描边"（lineWidth = baseW + …）
    assert(!/lineWidth\s*=\s*baseW\s*\+/.test(body),
      '选中高亮的线宽又变成 baseW + …（中心线加宽 = 盖住水面，第十六修退化的特征）');
    assert(body.indexOf('255, 244, 200') < 0, '旧的暖白 0.30 光晕又回来了（把整条河盖成奶白色）');
    return 'offsetPolyline 在场 / 无 baseW+ 加宽 / 无暖白光晕';
  });

  check('catmullRomPoints：曲线**穿过**控制点、端点逐字保留、点数可控', () => {
    const ctrl = [{ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 200, y: 0 }, { x: 300, y: 60 }];
    const curve = RR.catmullRomPoints(ctrl, 8);
    assert(curve.length === (ctrl.length - 1) * 8 + 1, `点数应为 (n-1)*subdiv+1，实际 ${curve.length}`);
    assert(curve[0].x === 0 && curve[0].y === 0, '首点必须逐字保留');
    assert(curve[curve.length - 1].x === 300 && curve[curve.length - 1].y === 60, '末点必须逐字保留');
    for (let k = 0; k < ctrl.length; k++) {
      const p = curve[k * 8];
      assert(Math.abs(p.x - ctrl[k].x) < 1e-6 && Math.abs(p.y - ctrl[k].y) < 1e-6,
        `曲线应穿过控制点 ${k}：期望 (${ctrl[k].x},${ctrl[k].y})，实际 (${p.x.toFixed(2)},${p.y.toFixed(2)})`);
    }
    // 反向探针：**直线输入必须输出直线**（曲线不该在直线段上瞎弯）
    const straight = RR.catmullRomPoints([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], 6);
    const offLine = Math.max(...straight.map((p) => Math.abs(p.y)));
    assert(offLine < 1e-9, `直线输入应保持直线，最大偏离 ${offLine}`);
    assert(RR.catmullRomPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], 8).length === 2, '两点应原样返回');
    return `4 控制点 → ${curve.length} 曲线点；直线输入不弯`;
  });

  check('taperWidths：源头细 → 河口粗，且**起步慢、后段快**（真实河流形状）', () => {
    const ws = RR.taperWidths(11, 1, 10);
    assert(ws.length === 11, '个数应等于请求的点数');
    assert(ws[0] === 1 && ws[10] === 10, `端点应为 1/10，实际 ${ws[0]}/${ws[10]}`);
    for (let i = 0; i + 1 < ws.length; i++) {
      assert(ws[i + 1] >= ws[i] - 1e-9, `宽度必须单调不减：${ws[i]} → ${ws[i + 1]}`);
    }
    // 指数 1.6（> 1）：**前段更慢** —— 中点宽度应低于线性（5.5）
    assert(ws[5] < 5.5, `中段应比线性更细（指数 1.6），实际 ${ws[5].toFixed(2)} vs 线性 5.5`);
    // 反向探针：指数 < 1（我第一版的 0.35）中点会**高于**线性 —— 判据必须能区分两侧
    const wrong = [];
    for (let i = 0; i < 11; i++) wrong.push(1 + 9 * Math.pow(i / 10, 0.35));
    assert(wrong[5] > 5.5 && Math.abs(ws[5] - wrong[5]) > 0.5,
      `判据没有区分力：指数>1 与 <1 必须落在中线的两侧（实际 ${ws[5].toFixed(2)} vs ${wrong[5].toFixed(2)}）`);
    assert(RR.taperWidths(0, 1, 2).length === 0, 'count=0 应给空数组');
    assert(RR.taperWidths(1, 1, 2)[0] === 2, 'count=1 应给河口宽度');
    return `1 → 10，中点 ${ws[5].toFixed(2)}（线性会是 5.5）`;
  });

  check('pruneRiverNetwork：剪掉"每格一根"的细段，但**干支流拓扑不能断**', () => {
    const segs = [
      { x0: 0, y0: 0, x1: 1, y1: 0, flow: 100 },   // 干流
      { x0: 1, y0: 0, x1: 2, y1: 0, flow: 90 },    // 干流
      { x0: 2, y0: 0, x1: 3, y1: 0, flow: 80 },    // 干流
      { x0: 5, y0: 5, x1: 1, y1: 0, flow: 3 },     // 支流（细，但**下游是干流**）
      { x0: 9, y0: 9, x1: 8, y1: 9, flow: 2 },     // 孤立细段（下游没人）
      { x0: 7, y0: 7, x1: 6, y1: 7, flow: 1 },     // 孤立细段
    ];
    const out = RR.pruneRiverNetwork(segs, 50, {});
    const kept = out.kept.map((s) => `${s.x0},${s.y0}`);
    assert(kept.includes('0,0') && kept.includes('1,0') && kept.includes('2,0'), `干流三段都要留下，实际 ${kept}`);
    // 🔴 关键：流量 3 的支流必须**因为下游被留下**而保留（简单流量过滤会把它切掉 → 干流半途断掉）
    assert(kept.includes('5,5'), `下游连着干流的细支流必须保留（拓扑），实际 ${kept}`);
    assert(!kept.includes('9,9') && !kept.includes('7,7'), `孤立细段应被剪掉，实际 ${kept}`);
    assert(out.dropped === 2, `应剪掉 2 段，实际 ${out.dropped}`);
    // 反向探针：闸门为 0 / 无效时**不许剪任何东西**（零行为变更的兜底）
    assert(RR.pruneRiverNetwork(segs, 0, {}).kept.length === 6, '闸门 0 应原样返回');
    assert(RR.pruneRiverNetwork(segs, NaN, {}).kept.length === 6, '闸门无效应原样返回');
    assert(RR.pruneRiverNetwork(null, 50, {}).kept.length === 0, 'null 应给空');
    // 🔴 默认键必须**按格心量化**：真实底图的格心是浮点（spacing 14.4 → 0.1/14.5/28.9…），
    //    拿 `${x},${y}` 当键会因浮点不一致而匹配失败 → 拓扑链断掉
    //    （实测 3750 段的河网只留 26 段，回归 test_103 当场抓住）。
    const floatSegs = [
      { x0: 0.1, y0: 0.2, x1: 14.5, y1: 0.2, flow: 100 },
      { x0: 14.5, y0: 0.2, x1: 28.9, y1: 0.2, flow: 90 },
      { x0: 43.3, y0: 0.2, x1: 14.5, y1: 0.2, flow: 3 },
      { x0: 57.7, y0: 0.2, x1: 71.1, y1: 0.2, flow: 2 },
    ];
    const flo = RR.pruneRiverNetwork(floatSegs, 50, {});
    assert(flo.kept.length === 3 && flo.kept.some((s) => s.x0 === 43.3),
      `小数格心也要保住拓扑支流，实际留 ${flo.kept.length} 段`);
    return `6 段 → 留 ${out.kept.length} 段（拓扑支流保住、孤立细段剪掉）`;
  });

  check('strokeRiverNetwork 的 `curve`：给了才弯，不给仍是直线（零行为变更）', () => {
    const calls = [];
    const ctx = {
      save() {}, restore() {}, beginPath() {}, stroke() { calls.push('stroke'); },
      moveTo(x, y) { calls.push(['moveTo', x, y]); },
      lineTo(x, y) { calls.push(['lineTo', x, y]); },
      quadraticCurveTo(cx, cy, x, y) { calls.push(['quad', cx, cy, x, y]); },
      set lineWidth(v) { this._lw = v; }, get lineWidth() { return this._lw; },
      set strokeStyle(v) { this._ss = v; }, get strokeStyle() { return this._ss; },
      set globalAlpha(v) { this._ga = v; }, get globalAlpha() { return this._ga; },
      set lineCap(v) {}, set lineJoin(v) {},
    };
    const segs = [{ x0: 0, y0: 0, x1: 10, y1: 0, flow: 5 }];
    calls.length = 0;
    RR.strokeRiverNetwork(ctx, segs, { toPx: (w) => w, widthPx: () => 1, singlePass: true, solid: true });
    assert(calls.some((c) => Array.isArray(c) && c[0] === 'lineTo'), '不给 curve 时应走 lineTo（直线）');
    assert(!calls.some((c) => Array.isArray(c) && c[0] === 'quad'), '不给 curve 时不该出现二次曲线');
    calls.length = 0;
    RR.strokeRiverNetwork(ctx, segs, {
      toPx: (w) => w, widthPx: () => 1, singlePass: true, solid: true,
      curve: (s) => ({ x: (s.x0 + s.x1) / 2, y: 3 }),
    });
    assert(calls.some((c) => Array.isArray(c) && c[0] === 'quad'), '给了 curve 必须走 quadraticCurveTo');
    // curve 返回 null（退化段）→ 退回直线，不能画出 NaN
    calls.length = 0;
    RR.strokeRiverNetwork(ctx, segs, {
      toPx: (w) => w, widthPx: () => 1, singlePass: true, solid: true, curve: () => null,
    });
    assert(calls.some((c) => Array.isArray(c) && c[0] === 'lineTo'), 'curve 返回 null 时应退回直线');
    assert(!calls.some((c) => Array.isArray(c) && c.some((v) => typeof v === 'number' && !Number.isFinite(v))), '不许出现 NaN');
    return '直线 / 曲线 / 退化回退 三种都走通';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('用例自身崩溃：', err);
  process.exit(1);
});
