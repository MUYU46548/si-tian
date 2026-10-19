// 探针（第十九修·二的前置测量，2026-10-19）：**一次保存**把 275ms 花在哪。
// 不做任何改动，只测：导出载荷 / 并进项目 / 快照 diff / IPC 克隆 四段各自多久。
// 结果写进 `window.__BREAK`；前提：`src/renderer/public/__real_desite.map` 存在。
window.__BREAK = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__BREAK;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const pinia = app.config.globalProperties.$pinia;
  const PS = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  const SCHEMA = await import('/src/utils/projectSchema.js');
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const T = (label, fn) => { const t = performance.now(); const r = fn(); OUT[label] = +(performance.now() - t).toFixed(1); return r; };
  try {
    J.stage = 'import';
    const AP = await import('/src/utils/azgaar-parser.js');
    const text = await (await fetch('/__real_desite.map')).text();
    const NAME = '德斯特';
    s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
    await tick(2500);
    const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
    sc.baseMapKey = NAME;
    if (sc.onBaseMapChange) await sc.onBaseMapChange();
    await tick(1500);

    J.stage = 'breakdown';
    // ① 预热一次（首次调用含 JIT/惰性编译，别把它算进稳态）
    T('warmExport', () => s.exportCanvasToProject());
    const payload = T('export', () => s.exportCanvasToProject());
    OUT.payloadBytes = JSON.stringify(payload).length;
    T('roundTrip', () => JSON.parse(JSON.stringify(payload)));

    // ② 并进项目（mergeCanvasPayload：实体时间戳保留 + 逐键合并）
    const merged = T('merge', () => SCHEMA.mergeCanvasPayload
      ? SCHEMA.mergeCanvasPayload(PS.project, payload)
      : PS.project);
    OUT.mergedBytes = JSON.stringify(merged).length;

    // ③ 快照（deepClone + diffWalk —— 满 50 份会轮转）
    const withSnap = T('pushSnapshot', () => SCHEMA.pushSnapshot(merged, { label: 'probe' }));

    // ④ 过 IPC 边界（真实 Electron 上是 V8 ValueSerializer；这里用 structuredClone 近似）
    T('ipcClone', () => structuredClone(withSnap));
    T('toIpcPlain', () => JSON.parse(JSON.stringify(withSnap)));

    // ⑤ 与真实保存对照
    const t = performance.now();
    await PS.flushSave();
    OUT.flushSaveMs = +(performance.now() - t).toFixed(1);
    OUT.snapshotCount = (PS.project && PS.project.snapshots) ? PS.project.snapshots.length : -1;
    J.stage = 'done';
  } catch (e) {
    J.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 400));
    J.stage = 'done';
  }
})();
'kicked'
