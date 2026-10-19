(async () => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const out = { steps: [] };
  const KEY = 'lab底图6';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  const cont = document.querySelector('.scenario-map-container');
  const sc = cont.__vueParentComponent.setupState;
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise(r => setTimeout(r, 150));
  const cvs = sc.canvas;
  const rect = cvs.getBoundingClientRect();
  const mk = (t, x, y) => new MouseEvent(t, { clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  const rivers = () => (s.baseMaps[KEY].rivers || []);

  sc.setTool('river');
  await new Promise(r => setTimeout(r, 0));
  cvs.dispatchEvent(mk('mousedown', 200, 200));
  for (let i = 1; i <= 14; i++) cvs.dispatchEvent(mk('mousemove', 200 + i * 12, 200 + Math.round(8 * Math.sin(i / 2))));
  cvs.dispatchEvent(mk('mouseup', 368, 200));
  cvs.dispatchEvent(mk('click', 368, 200));
  await new Promise(r => setTimeout(r, 20));

  const n = rivers()[0].points[1];
  const ps = { x: sc.cameraX + n.x * sc.cameraScale, y: sc.cameraY + n.y * sc.cameraScale };
  out.ps = ps;
  out.hitBefore = sc.hitRiverNodeIndex(n.x, n.y);
  sc.riverDraft = [];
  sc.riverDrag = null;
  sc.onMouseDown(mk('mousedown', ps.x, ps.y));
  out.directDragSet = !!sc.riverDrag;
  out.directDraft = sc.riverDraft.length;
  out.hitAfterDown = sc.hitRiverNodeIndex(n.x, n.y);
  // 现在走真实监听器（先清干净）
  sc.riverDraft = []; sc.riverDrag = null;
  cvs.dispatchEvent(mk('mousedown', ps.x, ps.y));
  out.evDragSet = !!sc.riverDrag;
  out.evDraft = sc.riverDraft.length;
  out.evHit = sc.hitRiverNodeIndex(n.x, n.y);
  out.selAfter = sc.selectedRiverId;
  return JSON.stringify(out);
})()
