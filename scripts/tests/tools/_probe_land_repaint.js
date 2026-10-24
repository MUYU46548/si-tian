// 探针（1-b 收口 · 2026-10-24）：去掉 deep watch + 去掉重复同步重绘之后，
// ① 松手快了多少 ② **画面是不是仍然自己就更新了**（不看代码，看像素）③ 一次松手重绘几遍。
// 判据（防"省了帧但画面不动"）：
//   松手后等一帧 → 截图校验和；再手动 render() 一次 → 校验和必须**完全相同**
//   （不同 = 松手那一下没画上，用户会看到旧画面）。
// 由 `_probe_jank_real.py _probe_land_repaint.js __RP` 驱动。只测量，不改产品代码。
window.__RP = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__RP;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const pinia = app.config.globalProperties.$pinia;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;

  J.stage = 'import';
  let text = null;
  for (const url of ['/__real_desite.map', '/docs/mockups/desite.map']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const t = await r.text();
      if (t.length < 1000000 || !t.includes('feature')) continue;
      text = t; break;
    } catch (e) { /* next */ }
  }
  if (!text) throw new Error('拿不到 desite.map');
  const AP = await import('/src/utils/azgaar-parser.js');
  const NAME = '重绘底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  if (!sm.editMode && typeof sm.enterEditMode === 'function') sm.enterEditMode();
  await tick(600);
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const ps = useProjectStore(pinia);
  const b = sm.canvas.getBoundingClientRect();

  // 重绘计数 + 像素校验和
  let clears = 0;
  const cvs = sm.canvas;
  const c2d = cvs.getContext('2d');
  const origClear = c2d.clearRect.bind(c2d);
  c2d.clearRect = (...a) => { clears += 1; return origClear(...a); };
  const checksum = () => {
    const w = cvs.width | 0, h = cvs.height | 0;
    const d = c2d.getImageData(0, 0, w, h).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 37) { sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0; n += 1; }
    return { sum, n };
  };

  const ev = (t, x, y) => new MouseEvent(t, {
    clientX: b.left + x, clientY: b.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  });
  const dragTrace = (cx, cy, rr, n) => {
    sm.canvas.dispatchEvent(ev('mousedown', cx + rr, cy));
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      sm.canvas.dispatchEvent(ev('mousemove', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
    }
  };

  // ── ① 建省松手：耗时 + 是否自己重绘 + 有没有补帧 ─────────────────────────
  J.stage = 'land';
  {
    const runs = [];
    for (let k = 0; k < 4; k++) {
      const cx = b.width * (0.28 + k * 0.085), cy = b.height * 0.5;
      const rr = Math.min(b.width, b.height) * 0.055;
      sm.setTool('draw');
      dragTrace(cx, cy, rr, 50);
      await tick(400);
      ps.dirty = false;                     // 压住 800ms 防抖落盘（不让它的 GC 混进读数）
      clears = 0;
      const n0 = (s.baseMaps[NAME].terrain || []).length;
      const t0 = performance.now();
      sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
      const landMs = +(performance.now() - t0).toFixed(1);
      const clearsSync = clears;
      await raf();                          // 让同一帧的 watcher/flush 跑完
      await raf();
      const afterFrame = checksum();
      clears = 0;
      sm.render();                          // 强制再画一遍：画面若已是最新，校验和必须一样
      const afterForce = checksum();
      const n1 = (s.baseMaps[NAME].terrain || []).length;
      runs.push({
        landMs, created: n1 > n0, clearsSync, clearsTotal: clears,
        sameAfterForceReRender: afterFrame.sum === afterForce.sum,
        checksum: afterFrame.sum,
      });
      ps.dirty = false;
      await tick(600);
    }
    OUT.land = runs;
    OUT.landP50 = runs.map((r) => r.landMs).sort((a, b2) => a - b2)[Math.floor(runs.length / 2)];
    if (runs.some((r) => !r.sameAfterForceReRender)) {
      J.fails.push('松手后画面不是最新的（强制重绘后校验和变了）—— 去掉同步 render() 的代价');
    }
    if (!runs.some((r) => r.created)) J.fails.push('这一轮没建出省（读数无效）');
  }

  // ── ② 拒绝分支：取消压叠确认 → 笔迹预览必须被擦掉 ─────────────────────────
  J.stage = 'reject';
  {
    window.confirm = () => false;           // 压叠闸门 → 用户取消
    const cx = b.width * 0.32, cy = b.height * 0.52;
    const rr = Math.min(b.width, b.height) * 0.045;
    sm.setTool('draw');
    dragTrace(cx, cy, rr, 50);
    await tick(300);
    const n0 = (s.baseMaps[NAME].terrain || []).length;
    clears = 0;
    sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
    const clearsSync = clears;
    await raf(); await raf();
    const n1 = (s.baseMaps[NAME].terrain || []).length;
    const afterFrame = checksum();
    clears = 0;
    sm.render();
    const afterForce = checksum();
    OUT.reject = {
      same: n0 === n1, clearsSync, syncRenderHappened: clearsSync > 0,
      sameAfterForceReRender: afterFrame.sum === afterForce.sum,
    };
    if (n0 !== n1) J.fails.push('取消分支居然建出了省（判据无效）');
    if (!OUT.reject.syncRenderHappened) J.fails.push('取消分支没补帧 —— 笔迹预览会留在画面上');
    if (!OUT.reject.sameAfterForceReRender) J.fails.push('取消分支画面不干净（强制重绘后变了）');
    window.confirm = () => true;
  }

  J.stage = 'done';
})().catch((e) => {
  window.__RP.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__RP.stage = 'done';
});
'kicked'
