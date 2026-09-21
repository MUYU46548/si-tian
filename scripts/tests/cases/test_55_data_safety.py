#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 55：数据安全 —— 退出前落盘 / 关闭项目先保存 / 保存失败拒绝关闭

用户原话（2026-09-21）：「没有数据安全承诺的系统，投进去的手绘时间是无担保贷款。」
本用例把这句话对应的机制变成**可执行契约**，而不是口头承诺：

  a) 退出前落盘（quitFlush 注册表）：画布侧与项目侧都注册了 flush 回调，
     主进程 quit 前驱动它们 → 未落盘的改动（含防抖窗口内的）写完再退
  b) 关闭项目先保存：dirty 时 `closeProject()` 先落盘，成功才关（不静默丢弃改动）
  c) 保存失败 → **拒绝关闭**：项目保持打开、dirty 保留、原因可执行；恢复后可正常关闭
  d) `geodata.flushSave()` 真写：防抖窗口（800ms）内的行星地图改动被真正保存
     （原实现只 clearTimeout 不保存 = 静默丢改动）
  e) 静态：主进程在 before-quit 拦截并等渲染层回执（含超时兜底）+ preload 通道 + App 侧驱动

判定一律走显式布尔，不用「没有报错就算过」（CDP 用例的假绿陷阱）。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.helpers import ensure_case_state   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

MAIN_JS = """(async () => {
  const fails = [];
  const ck = (name, cond, extra) => {
    if (!cond) fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  };
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const store = app._instance.setupState.store;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const Q = await import('/src/store/quitFlush.js');
  const W = await import('/src/store/writeGate.js');
  const proj = useProjectStore(pinia);
  const HARNESS = 'mock/projects/harness-baseline.sitian';
  const tick = (ms) => new Promise(r => setTimeout(r, ms));
  const savedCount = () => ((window.__savedProject || []).length);

  // ── a) 退出前落盘：注册表里有画布与项目两条 ─────────────────────────────
  const names = Q.registeredFlushers();
  ck('退出前落盘：画布侧已注册', names.indexOf('geodata') >= 0, names);
  ck('退出前落盘：项目侧已注册', names.indexOf('project') >= 0, names);
  const flushed = await Q.flushAll('用例驱动');
  ck('flushAll 返回每个 flusher 的结果', Array.isArray(flushed) && flushed.length >= 2, flushed);
  ck('flushAll 不抛错且无失败项', flushed.every(r => r.ok !== false), flushed);

  if (!proj.isOpen) return JSON.stringify({ fails: fails, aborted: 'harness 基线项目未打开（起点应为已打开项目）' });

  // ── b) 关闭项目前自动保存 ───────────────────────────────────────────────
  const before = savedCount();
  const ce = proj.createEntity({ name: '数据安全·关闭前保存', layer: 'location' });
  ck('制造 dirty：createEntity 成功', ce && ce.success === true, ce);
  ck('制造 dirty：dirty=true', proj.dirty === true, proj.dirty);
  const r1 = await proj.closeProject();
  ck('dirty 时关闭项目成功', r1 && r1.success === true, r1);
  ck('关闭前确实保存过（saved=true）', r1 && r1.saved === true, r1);
  ck('确实发生了一次项目落盘', savedCount() > before, { before: before, after: savedCount() });
  ck('项目已关闭', proj.isOpen === false);
  ck('关闭后回到只读（无项目=只读的终态不变）', W.isReadOnly.value === true, W.writeMode.value);

  // ── c) 保存失败 → 拒绝关闭（数据不丢，原因可执行）────────────────────────
  const open1 = await proj.openProject(HARNESS);
  ck('重新打开项目（准备保存失败场景）', open1 && open1.success === true, open1);
  ck('打开项目后可写', W.isReadOnly.value === false, W.writeMode.value);
  const origSave = window.sitianAPI.projectSave;
  window.sitianAPI.projectSave = async () => ({ success: false, error: '磁盘已满（用例模拟）' });
  const ce2 = proj.createEntity({ name: '数据安全·拒绝关闭', layer: 'location' });
  ck('制造 dirty（保存失败场景）', ce2 && ce2.success === true, ce2);
  const r2 = await proj.closeProject();
  ck('保存失败时拒绝关闭（success=false）', r2 && r2.success === false, r2);
  ck('拒绝原因写明「项目未关闭 / 数据仍在」',
     r2 && String(r2.error || '').indexOf('未关闭') >= 0, r2 && r2.error);
  ck('项目仍打开（没被关掉）', proj.isOpen === true);
  ck('未保存改动仍在（dirty 保持）', proj.dirty === true, proj.dirty);
  ck('刚建的实体还在（内存数据没丢）',
     Object.values(proj.entities || {}).some(e => (e.name || '') === '数据安全·拒绝关闭'));
  window.sitianAPI.projectSave = origSave;
  const r3 = await proj.closeProject();
  ck('保存恢复后可正常关闭', r3 && r3.success === true, r3);
  ck('确实补上了一次落盘', savedCount() > before + 1, savedCount());

  // ── d) flushSave 真写：防抖窗口内的行星地图改动不许被丢掉 ────────────────
  const open2 = await proj.openProject(HARNESS);
  ck('再次打开项目（准备 flush 场景）', open2 && open2.success === true, open2);
  const keys = Object.keys(store.mapData || {});
  ck('harness 播种了行星地图数据', keys.length > 0, keys);
  if (keys.length > 0) {
    const key = keys[0];
    if (!store.mapData[key]) store.mapData[key] = {};
    if (!Array.isArray(store.mapData[key].terrain)) store.mapData[key].terrain = [];
    const beforeLen = store.mapData[key].terrain.length;
    store.mapData[key].terrain.push({
      id: 'flush_probe_' + Date.now(), name: 'flush 探针地形',
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
    });
    store.scheduleAutoSaveMap(key);            // 只是「挂起 800ms」，此时还没落盘
    await store.flushSave();                   // flush 必须把它真的写掉
    await window.__probe.flushProject();
    const md = window.__probe.lastMapPayload(key);
    const gotLen = md && md.data && Array.isArray(md.data.terrain) ? md.data.terrain.length : -1;
    ck('flushSave 真写掉了防抖窗口内的行星地图改动', gotLen === beforeLen + 1,
       { key: key, before: beforeLen, after: gotLen });
  }

  return JSON.stringify({ fails: fails });
})()"""


def _read(rel):
    with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
        return f.read()


def run(cdp):
    ensure_case_state(cdp)
    raw = cdp.eval(MAIN_JS)
    if not (isinstance(raw, str) and raw.startswith('{')):
        return False, f'用例求值异常（非 JSON）：{str(raw)[:300]}'
    import json as _json
    try:
        data = _json.loads(raw)
    except ValueError:
        return False, f'用例返回值非 JSON：{raw[:300]}'
    fails = data.get('fails') or []
    if data.get('aborted'):
        return False, f'前置失败：{data["aborted"]}（fails={fails}）'

    # ── e) 静态闸门：主进程拦截 + preload 通道 + App 驱动 ─────────────────────
    static = []
    main_src = _read('src/main/index.js')
    preload_src = _read('src/preload/index.js')
    app_src = _read('src/renderer/src/App.vue')

    if "'app-flush-before-quit'" not in main_src:
        static.append('main/index.js 未在退出前通知渲染层落盘（缺 app-flush-before-quit）')
    if "'app-flush-done'" not in main_src:
        static.append('main/index.js 未等待渲染层回执（缺 app-flush-done）')
    if 'FLUSH_BEFORE_QUIT_MS' not in main_src:
        static.append('main/index.js 缺少退出前落盘的超时兜底（退不掉比丢 800ms 更糟）')
    if 'event.preventDefault()' not in main_src.split("app.on('before-quit'")[-1][:400]:
        static.append("main/index.js 的 before-quit 没有拦截（所有退出路径都要经过它）")
    if 'onFlushBeforeQuit' not in preload_src or 'notifyFlushDone' not in preload_src:
        static.append('preload 未暴露退出前落盘通道（onFlushBeforeQuit / notifyFlushDone）')
    if 'flushAll' not in app_src:
        static.append('App.vue 未驱动 quitFlush.flushAll（渲染层不会落盘）')
    if 'projectStore' in app_src:
        static.append('App.vue 直接引用了 projectStore（应只经中立注册表 quitFlush）')

    if fails or static:
        return False, ('数据安全契约未达成：' + '；'.join(fails + static))
    return True, ('退出前落盘注册表（画布+项目）+ 关闭项目先保存（saved=true 且真的落盘）'
                  '+ 保存失败拒绝关闭（项目保持打开、dirty 保留、恢复后可关）'
                  '+ flushSave 真写防抖窗口内的地图改动 + 主进程 before-quit 拦截/preload 通道/App 驱动齐备')
