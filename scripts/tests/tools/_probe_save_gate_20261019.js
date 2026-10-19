// 探针（第十九修·一，2026-10-19）：**手势期间自动保存顺延**到底有没有把那"一顿"消掉。
// 口径与上一轮 `_probe_save_block.js` 完全对齐（同一台机、同一张真实 desite 底图、同样的编辑），
// 唯一差别是**这次按住鼠标真的拖**（真实 mousedown → 每帧 mousemove → mouseup），
// 而不是 `buttons:0` 的空转 mousemove —— 后者不算手势，闸门不会开。
//
// 结果写进 `window.__GATE`；前提：`src/renderer/public/__real_desite.map` 存在。
window.__GATE = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__GATE;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const pinia = app.config.globalProperties.$pinia;
  const PS = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  const G = await import('/src/utils/interactionGate.js');
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  /** 观察 ms 毫秒：每帧记间隔，返回最长几帧与发生时刻（与上一轮探针同一实现） */
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
  const mouse = (cvs, type, x, y, buttons) => cvs.dispatchEvent(new MouseEvent(type, {
    clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true,
  }));
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

    // ① 静止基线（没有编辑 → 不该有保存）
    J.stage = 'idle-baseline';
    OUT.idle = await watchFrames(2000);

    // ② 保存链本身（与上一轮同一测法，便于对比）
    J.stage = 'save-chain';
    const t0 = performance.now();
    const payload = s.exportCanvasToProject();
    OUT.exportMs = +(performance.now() - t0).toFixed(1);
    const json = JSON.stringify(payload);
    OUT.payloadBytes = json.length;
    const t1 = performance.now();
    JSON.parse(JSON.stringify(payload));
    OUT.roundTripMs = +(performance.now() - t1).toFixed(1);

    // ③ 核心场景：一次编辑 → 500ms 后**按住并持续拖动** 2.6s（保存的 800ms 防抖正好落在拖动里）
    J.stage = 'edit-hold-drag';
    G.resetInteractionGate();
    s.addBaseMapRiver(NAME, {
      points: [{ x: 100, y: 100 }, { x: 300, y: 260 }, { x: 520, y: 300 }], width: 3.5,
    });
    await tick(500);
    const cvs = sm.canvas;
    const rc = cvs.getBoundingClientRect();
    let i = 0;
    mouse(cvs, 'mousedown', rc.left + 200, rc.top + 200, 1);
    OUT.holdDrag = await watchFrames(2600, () => {
      i += 1;
      mouse(cvs, 'mousemove', rc.left + 200 + (i * 7) % 300, rc.top + 200 + (i * 3) % 160, 1);
    });
    OUT.defersDuringDrag = G.interactionGateStats.defers;
    OUT.savedDuringDrag = PS.dirty === false;   // 拖动期间就写完了？那说明闸门没生效
    mouse(cvs, 'mouseup', rc.left + 210, rc.top + 210, 0);

    // ④ 抬手之后：顺延的那次保存必须补上（并量它落在哪一帧 —— 这是**明知会有的**一次卡顿）
    J.stage = 'after-release';
    OUT.afterRelease = await watchFrames(2000);
    OUT.savedAfterRelease = PS.dirty === false;
    OUT.forced = G.interactionGateStats.forced;
    OUT.maxDeferSeen = G.interactionGateStats.maxDeferSeen;

    // ⑤ 一次完整落盘的真实成本（闸门不管显式保存 → 这里量的是那条链的全长）
    J.stage = 'flush-cost';
    s.addBaseMapRiver(NAME, { points: [{ x: 10, y: 10 }, { x: 200, y: 200 }], width: 3 });
    await tick(1200);                       // 让防抖先自己跑完，别把两笔算进同一次 flush
    s.addBaseMapRiver(NAME, { points: [{ x: 20, y: 20 }, { x: 240, y: 240 }], width: 3 });
    const t2 = performance.now();
    await PS.flushSave();
    OUT.flushSaveMs = +(performance.now() - t2).toFixed(1);
    OUT.dirtyAtEnd = PS.dirty;
    J.stage = 'done';
  } catch (e) {
    J.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 400));
    J.stage = 'done';
  }
})();
'kicked'
