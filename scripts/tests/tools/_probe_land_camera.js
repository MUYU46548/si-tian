// 探针（1-b 附带发现核对，2026-10-24）：**画一个省之后镜头会不会自己重新适屏？**
// 依据：ScenarioMap 的 `watch([baseMapKey, terrain.length])` 在"省数变了"时 `setTimeout(fitToView, 50)`，
// 只对 `provincePaint` 工具豁免 —— 自由绘制（draw）没豁免。
// 由 `_probe_jank_real.py _probe_land_camera.js __CAM` 驱动。只测量，不改产品代码。
window.__CAM = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__CAM;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const cam = (sm) => ({
    x: +Number(sm.cameraX).toFixed(1), y: +Number(sm.cameraY).toFixed(1), scale: +Number(sm.cameraScale).toFixed(4),
  });

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
  const NAME = '镜头底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  if (!sm.editMode && typeof sm.enterEditMode === 'function') sm.enterEditMode();
  await tick(600);

  const b = sm.canvas.getBoundingClientRect();
  const ev = (t, x, y) => new MouseEvent(t, {
    clientX: b.left + x, clientY: b.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  });

  // 先把镜头挪到一个**明显不是适屏位置**的地方，作为对照
  sm.cameraScale = sm.cameraScale * 0.7;
  sm.cameraX = sm.cameraX + 40;
  await tick(300);
  const before = cam(sm);

  const cx = b.width * 0.35, cy = b.height * 0.45, rr = Math.min(b.width, b.height) * 0.06;
  sm.setTool('draw');
  sm.canvas.dispatchEvent(ev('mousedown', cx + rr, cy));
  for (let i = 1; i <= 50; i++) {
    const a = (i / 50) * Math.PI * 2;
    sm.canvas.dispatchEvent(ev('mousemove', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
  }
  await tick(150);
  const n0 = (s.baseMaps[NAME].terrain || []).length;
  sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
  const afterUp = cam(sm);
  await tick(800);                       // 覆盖 setTimeout(fitToView, 50)
  const afterSettle = cam(sm);
  OUT.created = (s.baseMaps[NAME].terrain || []).length - n0;
  OUT.before = before;
  OUT.afterMouseUp = afterUp;
  OUT.afterSettle = afterSettle;
  OUT.cameraJumped = Math.abs(afterSettle.scale - before.scale) > 1e-3
    || Math.abs(afterSettle.x - before.x) > 0.5 || Math.abs(afterSettle.y - before.y) > 0.5;
  OUT.fitToView = (() => { const c = cam(sm); return c; })();

  // 对照：provincePaint 工具建省时不该抢镜头（源码里显式豁免）——只记录源码事实即可
  OUT.note = '镜头在松手后 800ms 内是否变化 = cameraJumped';

  J.stage = 'done';
})().catch((e) => {
  window.__CAM.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__CAM.stage = 'done';
});
'kicked'
