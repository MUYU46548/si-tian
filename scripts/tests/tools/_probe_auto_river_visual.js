(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = 'labAutoR4';
  const land = { id: 'L1', name: '陆地', kind: 'land', color: '#c98a5b',
    points: [{ x: -4000, y: -3000 }, { x: 4000, y: -3000 }, { x: 4000, y: 3000 }, { x: -4000, y: 3000 }] };
  // 圆丘地形：实测能追出 1600+ 条代表路径（斜脊那种会一条都没有 —— 闸门过不去）
  const sp = 20, cols = 121, rows = 121, pts = [], h = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    pts.push({ x: -2000 + i * sp, y: -2000 + j * sp });
    const d = Math.hypot(i - 60, j - 60);
    h.push(Math.max(0, Math.min(100, Math.round(90 - d * 1.1))));
  }
  const hm = { h, grid: { points: pts, cellsX: cols, cellsY: rows, spacing: sp } };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: KEY, terrain: [land], referenceImages: [], heightmap: hm,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  const cont = document.querySelector('.scenario-map-container');
  const sc = cont.__vueParentComponent.setupState;
  const hide = (sel) => document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; });
  const reveal = () => {
    for (const fx of [0.25, 0.4, 0.55, 0.7, 0.85]) for (const fy of [0.3, 0.45, 0.6, 0.75]) {
      const el = document.elementFromPoint(window.innerWidth * fx, window.innerHeight * fy);
      if (!el || el.tagName === 'CANVAS') continue;
      let node = el, depth = 0;
      while (node && node !== document.body && depth < 8) {
        const cs = getComputedStyle(node);
        if (cs.position === 'absolute' || cs.position === 'fixed') { node.style.display = 'none'; break; }
        node = node.parentElement; depth++;
      }
    }
  };
  hide('.world-selector, .sidebar, .tree-panel, .left-panel, .panel-shell, .props-panel');
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise(r => setTimeout(r, 300));
  hide('.world-selector, .sidebar, .tree-panel, .left-panel, .panel-shell, .props-panel');
  reveal();
  await new Promise(r => setTimeout(r, 100));
  const cvs = sc.canvas;
  const wrap = cvs.parentElement;
  out.wrap = [wrap.clientWidth, wrap.clientHeight];
  // 🔴 判"弯不弯 / 粗细有没有变化"**必须放大看局部**：
  //    自动河与自带河同口径（屏幕 0.7px 起），10% 缩放下它本来就该是一根细暗线 ——
  //    在那个尺度上讨论"好不好看"是量错了对象。
  sc.cameraScale = 1.0;
  sc.cameraX = wrap.clientWidth / 2 - (-2000 + 60 * 20) * sc.cameraScale;
  sc.cameraY = wrap.clientHeight / 2 - (-2000 + 60 * 20) * sc.cameraScale;
  sc.render();
  await new Promise(r => setTimeout(r, 60));
  sc.generateAndShowRivers();
  await new Promise(r => setTimeout(r, 500));
  out.autoRivers = (sc.autoRivers || []).length;
  out.autoSegments = (sc.autoRiverSegments || []).length;
  out.autoDrawn = sc.autoRiverDrawn;
  out.gate = Math.round(sc.riverFlowGate(sc.autoRiverMaxFlow) * 10) / 10;
  out.netMinPx = Math.round(sc.riverMinWidthForNet() * 100) / 100;
  out.hint = String(sc.provinceHint || '').slice(0, 120);
  // ⚠️ 相机要在**生成之后**再设：生成流程自己会适屏（先设会被它覆盖回全景 → 又变成 0.7px 细线）
  sc.cameraScale = 1.0;
  sc.cameraX = wrap.clientWidth / 2 - (-2000 + 60 * 20) * sc.cameraScale;
  sc.cameraY = wrap.clientHeight / 2 - (-2000 + 60 * 20) * sc.cameraScale;
  out.scale = Math.round(sc.cameraScale * 1000) / 1000;
  sc.render();
  await new Promise(r => setTimeout(r, 150));
  return JSON.stringify(out);
})()
