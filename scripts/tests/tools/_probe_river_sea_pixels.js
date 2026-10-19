(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const KEY = 'labSeaOverrun';

  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const land = { id: 'p1', name: '大陆', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) };
  const sp = 14.4, cols = 133, rows = 75, pts = [], h = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = -920 + i * sp, y = -500 + j * sp;
    pts.push([x, y]);
    const d = Math.hypot(x, y / 0.72);
    h.push(Math.max(0, Math.min(100, Math.round((1 - d / 900) * 100))));
  }
  s.baseMaps = { ...s.baseMaps, [KEY]: {
    id: KEY, name: KEY, terrain: [land], referenceImages: [],
    heightmap: { h, grid: { points: pts, cellsX: cols, cellsY: rows, spacing: sp } },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  sc.baseMapKey = KEY; sc.onBaseMapChange?.();
  await new Promise(r => setTimeout(r, 350));

  const coast = await import('/src/utils/coastline.js');
  const mask = coast.buildLandMask([land]);
  const isLand = mask.lookup;

  const r = s.generateRivers(KEY, {});
  out.rivers = (r.rivers || []).length;
  out.segs = (r.segments || []).length;
  out.segMaxFlow = r.segMaxFlow || 0;
  sc.autoRivers = r.rivers || [];
  sc.autoRiverSegments = r.segments || [];
  sc.autoRiverMaxFlow = r.segMaxFlow || 0;
  sc.autoRiverDrawn = (r.segments || []).length;
  sc.showBorders = false; sc.rasterLayer = 'none';

  const cvs = sc.canvas, wrap = cvs.parentElement;
  // 相机：只框住大陆（这样海里有没有河一目了然）
  const viewW = 2200, viewH = 1700;
  sc.cameraScale = Math.min(wrap.clientWidth / viewW, wrap.clientHeight / viewH);
  sc.cameraX = wrap.clientWidth / 2; sc.cameraY = wrap.clientHeight / 2;
  sc.render(); await new Promise(r => setTimeout(r, 250));

  // ── 逐像素：河色像素落在海里 = 越界 ────────────────────────────────────
  const W = cvs.width, H = cvs.height, ctx2 = cvs.getContext('2d');
  const d = ctx2.getImageData(0, 0, W, H).data;
  // 河色 #5d97bb
  const isRiverPx = (i) => {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    return Math.abs(R - 0x5d) <= 22 && Math.abs(G - 0x97) <= 22 && Math.abs(B - 0xbb) <= 22;
  };
  // 屏幕 → 世界（与产品 screenToWorld 同口径）
  const w2s = sc.worldToScreen;
  const s2w = (sx, sy) => {
    const a = s2wWorld(0, 0), b = s2wWorld(1, 0), c = s2wWorld(0, 1);
    // 仿射：用两点差求缩放与平移（无旋转）
    const sxUnit = b.x - a.x, syUnit = c.y - a.y;
    return { x: a.x + sx * (sxUnit || 1), y: a.y + sy * (syUnit || 1) };
  };
  function s2wWorld(sx, sy) {
    // 就地实现与产品一致的逆变换：优先用产品暴露的口（若没有则用相机参数）
    const scale = sc.cameraScale;
    const cx = wrap.clientWidth / 2, cy = wrap.clientHeight / 2;
    return { x: (sx - cx) / scale + (sc.cameraXTargetX ?? 0), y: (sy - cy) / scale + (sc.cameraYTargetY ?? 0) };
  }
  // 更稳的做法：用产品自己的 screenToWorld
  const inv = sc.screenToWorld;
  let riverPx = 0, riverPxInSea = 0;
  const seaSamples = [];
  if (typeof inv === 'function') {
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        if (!isRiverPx(i)) continue;
        riverPx++;
        const wpt = inv(x, y);
        if (!isLand(wpt.x, wpt.y)) {
          riverPxInSea++;
          if (seaSamples.length < 8) seaSamples.push({ x: Math.round(wpt.x), y: Math.round(wpt.y) });
        }
      }
    }
  }
  out.pixels = { W, H, riverPx, riverPxInSea,
    seaPct: riverPx ? Math.round(riverPxInSea / riverPx * 1000) / 10 : 0, seaSamples };
  out.usedProductInverse = typeof inv === 'function';
  return JSON.stringify(out, null, 1);
})()
