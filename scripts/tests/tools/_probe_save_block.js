// 探针：**自动保存那一下**在主线程上占多久（2026-10-18 第十九修）。
// 背景：`_probe_jank_real.js` 里 `pan` 出现过 max 590ms 的单帧 —— 那是 800ms 防抖的
//   全量项目保存正好落在拖动中间。这里把它单独量出来：一小段静止观察 + 一次编辑，
//   记录此后 3 秒内**最长的帧间隔**（= 主线程被占住多久）与它出现的时刻。
// 结果写进 `window.__SAVE`；前提：`src/renderer/public/__real_desite.map` 存在。
window.__SAVE = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__SAVE;
  const OUT = J.out;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  /** 观察 ms 毫秒：每帧记间隔，返回最长几帧与发生时刻 */
  const watchFrames = (ms, perFrame) => new Promise((resolve) => {
    const deltas = []; let last = performance.now(); const t0 = last; let stop = false;
    const loop = () => {
      const now = performance.now();
      deltas.push({ dt: now - last, at: now - t0 });
      last = now;
      try { if (perFrame) perFrame(); } catch (e) { J.fails.push('perFrame: ' + String(e).slice(0, 120)); }
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setTimeout(() => { stop = true; }, ms);
    setTimeout(() => {
      const sorted = deltas.slice().sort((a, b) => b.dt - a.dt);
      resolve({
        frames: deltas.length,
        max: +sorted[0].dt.toFixed(1), maxAt: +sorted[0].at.toFixed(0),
        second: sorted[1] ? +sorted[1].dt.toFixed(1) : -1,
        secondAt: sorted[1] ? +sorted[1].at.toFixed(0) : -1,
        over50: deltas.filter((d) => d.dt > 50).length,
        over100: deltas.filter((d) => d.dt > 100).length,
      });
    }, ms + 200);
  });
  try {
    J.stage = 'import';
    const AP = await import('/src/utils/azgaar-parser.js');
    const text = await (await fetch('/__real_desite.map')).text();
    const NAME = '德斯特';
    s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
    await tick(2500);
    const sm = sc();
    sm.baseMapKey = NAME;
    if (sm.onBaseMapChange) await sm.onBaseMapChange();
    await tick(1500);
    // 静止基线（没有编辑 → 不该有保存）
    J.stage = 'idle-baseline';
    OUT.idle = await watchFrames(2500);
    // ① 直接量保存链本身的两段（与 CPU 采样对得上，便于对比）
    J.stage = 'save-chain';
    const exportFn = s.exportCanvasToProject || s.exportCanvas;
    const t0 = performance.now();
    const payload = exportFn.call(s);
    OUT.exportCanvasMs = +(performance.now() - t0).toFixed(1);
    OUT.payloadBytes = JSON.stringify(payload).length;
    const t1 = performance.now();
    const plain = JSON.parse(JSON.stringify(payload));
    OUT.reRoundTripMs = +(performance.now() - t1).toFixed(1);
    OUT.plainBytes = JSON.stringify(plain).length;
    // ② 真编辑（加一条河）→ 观察 800ms 防抖之后的保存落在哪一帧
    J.stage = 'edit-then-watch';
    const bm = s.baseMaps[NAME];
    let r = null;
    const t2 = performance.now();
    for (let k = 0; k < 3; k++) {
      r = s.addBaseMapRiver(NAME, {
        points: [{ x: 100 + k * 40, y: 100 }, { x: 300 + k * 40, y: 260 }, { x: 520 + k * 40, y: 300 }],
        width: 3.5,
      });
      s.updateBaseMapRiver(NAME, r.id, { width: 4 });
    }
    OUT.threeEditsMs = +(performance.now() - t2).toFixed(1);
    await tick(600);                       // 防抖 800ms；先等一会儿再观察
    OUT.afterEdit = await watchFrames(3000);
    // ③ 保存期间继续"拖"会怎样：编辑后 500ms 开始持续 mousemove（每帧一次），看有没有长帧
    J.stage = 'edit-while-dragging';
    s.addBaseMapRiver(NAME, { points: [{ x: 0, y: 0 }, { x: 200, y: 200 }], width: 3 });
    await tick(500);
    const cvs = sm.canvas;
    const rc = cvs.getBoundingClientRect();
    let i = 0;
    OUT.dragDuringSave = await watchFrames(2200, () => {
      i++;
      cvs.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rc.left + 60 + (i * 5) % 400, clientY: rc.top + 60 + (i * 3) % 200,
        button: 0, buttons: 0, bubbles: true, cancelable: true,
      }));
    });
    J.stage = 'done';
  } catch (e) {
    J.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 400));
    J.stage = 'done';
  }
})();
'kicked'
