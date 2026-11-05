(async () => {
  const out = { stage: 'init' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // 0) 关掉"检测到未保存的编辑"恢复对话框（上一个 lab 进程留下的）
    out.stage = 'dialog';
    for (const b of Array.from(document.querySelectorAll('button'))) {
      const t = (b.textContent || '').trim();
      if (t === '丢弃备份') { b.click(); await sleep(200); break; }
    }
    // 1) 进剧本模式
    out.stage = 'scenario';
    const nav = Array.from(document.querySelectorAll('button'))
      .find((x) => (x.textContent || '').includes('历史剧本'));
    if (nav) nav.click();
    for (let i = 0; i < 40 && !document.querySelector('.scenario-map-container'); i++) await sleep(150);

    const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
    const el = document.querySelector('.scenario-map-container');
    if (!el) { out.err = 'no-scenario-map'; return JSON.stringify(out); }
    const sm = el.__vueParentComponent.setupState;

    const KEY = 'labRivers';
    out.stage = 'basemap';
    if (!s.baseMaps[KEY]) s.addBaseMap('labRivers', { name: '河流实验' });

    // ── 造一张 200×120 的大陆高度图（世界坐标 1600×960，格距 8）───────────────
    const cols = 200, rows = 120, sp = 8;
    const points = [], h = [], prec = [];
    const g = (x, y, cx, cy, sx, sy, a) => a * Math.exp(-(((x - cx) ** 2) / (2 * sx * sx) + ((y - cy) ** 2) / (2 * sy * sy)));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * sp;
        const y = (r - (rows - 1) / 2) * sp;
        const v = g(x, y, -260, -80, 420, 300, 78)
          + g(x, y, 330, 130, 300, 220, 58)
          + g(x, y, -40, 240, 260, 160, 40)
          + 7 * Math.sin(x * 0.013) * Math.cos(y * 0.017)
          + 4.5 * Math.sin((x + y) * 0.021)
          + 3 * Math.cos(x * 0.033 - y * 0.019);
        points.push([x, y]);
        h.push(v < 21 ? 0 : Math.min(100, v));
        const p = 55 + 35 * Math.cos(x * 0.0016) + 20 * Math.sin(y * 0.0031);
        prec.push(Math.max(5, Math.min(100, p)));
      }
    }
    out.stage = 'commit';
    s.commitHeightmap(KEY, {
      grid: { points, cellsX: cols, cellsY: rows, spacing: sp },
      h: Float32Array.from(h),
      prec: Float32Array.from(prec),
    });

    out.stage = 'select';
    sm.baseMapKey = KEY;
    if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
    await sleep(350);
    sm.riverSourceHeight = 60;
    sm.tool = 'river';
    if (typeof sm.render === 'function') sm.render();

    out.stage = 'generate';
    sm.generateAndShowRivers();
    await sleep(450);

    // 相机：整幅图（含边框）+ 把侧栏藏掉，尽量只留画布
    for (const sel of ['.sidebar', '.tree-panel', '.left-panel', '.panel-shell', '.props-panel', '.world-selector']) {
      document.querySelectorAll(sel).forEach((n) => { n.style.display = 'none'; });
    }
    const cvs = el.querySelector('canvas');
    const wrap = cvs.parentElement;
    // 取景：**放大到能看清一条河**（观感判据只能在这个尺度上做；55% 全是纹理）
    const zoom = Number('__ZOOM__');
    const cxw = Number('__CX__'), cyw = Number('__CY__');
    const scale = zoom;
    sm.cameraScale = scale;
    sm.cameraX = wrap.clientWidth / 2 - cxw * scale;
    sm.cameraY = wrap.clientHeight / 2 - cyw * scale;
    if (typeof sm.renderNow === 'function') sm.renderNow(); else sm.render();
    await sleep(300);

    const rivers = (sm.autoRivers && sm.autoRivers.value) || sm.autoRivers || [];
    const orders = {};
    for (const r of rivers) orders[r.order] = (orders[r.order] || 0) + 1;
    out.ok = true;
    out.key = KEY;
    out.scale = +scale.toFixed(3);
    out.rivers = rivers.length;
    out.segments = (((sm.autoRiverSegments && sm.autoRiverSegments.value) || sm.autoRiverSegments) || []).length;
    out.orders = orders;
    out.endInSea = rivers.filter((r) => r.endInSea).length;
    out.endInLake = rivers.filter((r) => r.endInLake).length;
    out.hint = String(sm.provinceHint || '').slice(0, 160);
    out.lakes = (s.getHeightmapFor(KEY).lakes || []).length;
    out.stage = 'done';
  } catch (e) {
    out.err = String((e && e.message) || e);
    out.stack = String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ').slice(0, 300);
  }
  return JSON.stringify(out);
})()
