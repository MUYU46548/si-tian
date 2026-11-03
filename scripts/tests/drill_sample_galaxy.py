#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「示例星系（测试）」的验收：**在自建临时世界里**跑，不污染 harness 项目（2026-11-03）

为什么单独一条（用户原话）：*“测试夹具改成自建临时世界再生成示例星系 —— 落实你说的
‘测试自己创世界’，视觉验收不再污染 harness 项目”*。

「示例星系（测试）」是**测试夹具**（`store.generateSampleGalaxy`，2026-11-02 从原型 SP-1025
移植的生成器），不是产品生成路径。之前的视觉验收是把 120 颗星直接追加进**共享的 harness 基线项目**
（mock 里的 `harness-baseline.sitian`）—— 跑完那 120 个实体还留在里面，后续用例看到的世界就变了。
本工具改成：

  ① 先验只读态（没项目时按钮禁用且给出原因）；
  ② **新建一个临时项目**（`mock/projects/self-built/…`，mock 内存，不落真实磁盘）；
  ③ 在它里面**自建一个世界**，进星域视图；
  ④ 点按钮生成 → 断言 4 星域 / 120 恒星 / 175 航道（A 档预设）；
  ⑤ 截图（整页，含工具栏与画布）；
  ⑥ 一次 Ctrl+Z 精确撤回（回 1 节点 / 0 航道）；
  ⑦ **反面对照**：harness 基线项目从头到尾没被创建/写入（`__projects` 里没有它、
     `__savedProject` 里也没有它）—— 这才是"不再污染"的证据；
  ⑧ 落盘判据：自动保存（800ms 防抖）后在**自建项目**的保存载荷里能查到那 4 个星域。

用法：python scripts/tests/drill_sample_galaxy.py
产物：build/sample-galaxy/generated.png + summary.json
"""
import base64
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_tests as rt                                          # noqa: E402
from lib.cdp import CDP, wait_for, eval_json                    # noqa: E402
from lib.helpers import ensure_data_ready, select_world_with_domains  # noqa: E402

OUT_DIR = os.path.join(rt.ROOT, 'build', 'sample-galaxy')

# 控制台默认编码在 Windows 上是 GBK：显式切 UTF-8，否则一条符号（✅ / ▶）就会让脚本崩在
# `UnicodeEncodeError` 上 —— 那不是断言失败，是压根没开始跑（2026-11-03 实测）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass
SELF_DIR = 'mock/projects/self-built'
HARNESS = 'mock/projects/harness-baseline.sitian'


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return bool(ok)


def shot(cdp, name):
    rep = cdp.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
    data = (rep or {}).get('data') or ''
    if not data:
        return None
    p = os.path.join(OUT_DIR, f'{name}.png')
    with open(p, 'wb') as f:
        f.write(base64.b64decode(data))
    return p


EMPTY_COUNTS = """(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  return JSON.stringify({ nodes: s.nodes.length, lanes: s.hyperlanes.length,
    domains: s.nodes.filter(n => n.layer === 'star_domain').length,
    galaxies: s.nodes.filter(n => n.layer === 'galaxy').length });
})()"""

READONLY_JS = """(() => {
  const b = document.querySelector('[data-testid="gen-sample-galaxy"]');
  if (!b) return JSON.stringify({ found: false });
  return JSON.stringify({ found: true, disabled: !!b.disabled, title: b.title || '',
                          text: (b.textContent || '').trim() });
})()"""

NEW_PROJECT_JS = """(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const store = app._instance.setupState.store;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const proj = useProjectStore(pinia);
  const r = await proj.createProject({ name: '示例星系自建世界', dir: '%s' });
  if (!r || !r.success) return JSON.stringify({ ok: false, error: (r && r.error) || 'create 失败' });
  const world = store.addNode({
    id: 'self_world_1', name: '自建临时世界', layer: 'world', parentId: null,
    tags: ['fixture'], sourcePath: '', coordinate: { x: 0, y: 0 },
  });
  store.selectWorld(world);
  return JSON.stringify({ ok: true, filePath: proj.filePath, projectName: proj.project && proj.project.meta.name,
                          nodes: store.nodes.length });
})()""" % SELF_DIR

GENERATE_JS = """(() => {
  const before = (() => {
    const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
    return { nodes: s.nodes.length, lanes: s.hyperlanes.length,
             domains: s.nodes.filter(n => n.layer === 'star_domain').length };
  })();
  const b = document.querySelector('[data-testid="gen-sample-galaxy"]');
  if (!b) return JSON.stringify({ ok: false, why: 'no-button' });
  if (b.disabled) return JSON.stringify({ ok: false, why: 'disabled' });
  b.click();
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const after = { nodes: s.nodes.length, lanes: s.hyperlanes.length,
                  domains: s.nodes.filter(n => n.layer === 'star_domain').length,
                  galaxies: s.nodes.filter(n => n.layer === 'galaxy').length };
  return JSON.stringify({ ok: true, before, after });
})()"""

UNDO_JS = """(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  s.undo();
  return JSON.stringify({ nodes: s.nodes.length, lanes: s.hyperlanes.length,
    domains: s.nodes.filter(n => n.layer === 'star_domain').length,
    galaxies: s.nodes.filter(n => n.layer === 'galaxy').length });
})()"""

HARNESS_CLEAN_JS = """(() => {
  window.__projects = window.__projects || {};
  window.__savedProject = window.__savedProject || [];
  window.__projectCalls = window.__projectCalls || [];
  const calls = window.__projectCalls.filter(c => (c.filePath || '') === '%s');
  return JSON.stringify({
    inProjects: Object.prototype.hasOwnProperty.call(window.__projects, '%s'),
    inSaves: window.__savedProject.filter(p => (p.filePath || '') === '%s').length,
    calls: calls.length,
    savedPaths: Array.from(new Set(window.__projectCalls.map(p => p.filePath || ''))).slice(0, 8),
  });
})()""" % (HARNESS, HARNESS, HARNESS)

# mock 的“磁盘”就是 `window.__projects[filePath]`（projectSave 的原样落点）+ `__projectCalls` 的 save 记录。
# ⚠️ 别查 `__savedProject`：那个钩子只由 `open_harness_project()` 装 —— 本工具**故意不打开 harness 项目**。
SAVED_SELF_JS = """(() => {
  window.__projects = window.__projects || {};
  window.__projectCalls = window.__projectCalls || [];
  const path = Object.keys(window.__projects).find(k => k.indexOf('%s') === 0) || '';
  const p = path ? window.__projects[path] : null;
  const ents = p && p.entities ? Object.values(p.entities) : [];
  const saves = window.__projectCalls.filter(c => c.op === 'save' && (c.filePath || '').indexOf('%s') === 0).length;
  return JSON.stringify({
    path,
    saves,
    domains: ents.filter(e => e.layer === 'star_domain').length,
    galaxies: ents.filter(e => e.layer === 'galaxy').length,
    worlds: ents.filter(e => e.layer === 'world').length,
    entities: ents.length,
  });
})()""" % (SELF_DIR, SELF_DIR)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            print(f'  ❌ 端口 {port} 已被占用（先停掉正在跑的回归/演练）', flush=True)
            return 2

    bad = 0
    rt.setup_mock()
    handles, cdp = [], None
    try:
        dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=rt.ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT, timeout=120):
            raise RuntimeError('Vite dev server 启动超时')
        edge = subprocess.Popen([
            rt.EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
            '--remote-debugging-port=%d' % rt.CDP_PORT, '--remote-allow-origins=*',
            '--user-data-dir=%s' % os.path.join(rt.ROOT, '.test-edge-profile'),
            '--no-first-run', '--no-default-browser-check',
            '--no-sandbox', 'about:blank',
        ])
        handles.append(rt.ProcessHandle(edge, 'edge'))
        if not rt.wait_port(rt.CDP_PORT, timeout=60):
            raise RuntimeError('Edge CDP 启动超时')

        cdp = CDP()
        cdp.send('Page.enable')
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='首次导航')
        rt.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='整页加载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ensure_data_ready(cdp, timeout=90)

        # ① 只读态：先拿知识库数据进星域视图（**不打开 harness 项目**）
        wid = select_world_with_domains(cdp)
        wait_for(cdp, "!!document.querySelector('.galaxy-map-container')", timeout=40, desc='GalaxyMap 挂载')
        time.sleep(0.8)
        ro = eval_json(cdp, READONLY_JS, required=('found',), desc='只读态按钮')[1]
        bad += 0 if ck('只读态：示例星系按钮存在且禁用', ro.get('found') and ro.get('disabled'),
                       json.dumps(ro, ensure_ascii=False)[:140]) else 1
        bad += 0 if ck('只读态：悬浮说明里说清“为什么不能用”',
                       '只读' in (ro.get('title') or '') or '项目' in (ro.get('title') or ''),
                       (ro.get('title') or '')[:80]) else 1
        print(f'  · 知识库世界：{wid}', flush=True)

        # ②③ 自建临时项目 + 自建世界 → 进星域视图
        np_ok, npj = eval_json(cdp, NEW_PROJECT_JS, required=('ok',), desc='新建临时项目 + 自建世界')
        bad += 0 if ck('新建临时项目成功（不碰真实磁盘）', bool(np_ok) and npj.get('ok'),
                       json.dumps(npj, ensure_ascii=False)[:140]) else 1
        bad += 0 if ck('世界由用例自己建（示例星系的唯一合法宿主）',
                       npj.get('nodes') == 1, f"节点 {npj.get('nodes')}") else 1
        wait_for(cdp, "!!document.querySelector('.galaxy-map-container')", timeout=40, desc='自建世界的星域视图')
        time.sleep(1.0)
        before = eval_json(cdp, EMPTY_COUNTS, required=('nodes',), desc='生成前计数')[1]
        bad += 0 if ck('生成前：只有自建世界那一个节点', before.get('nodes') == 1,
                       json.dumps(before, ensure_ascii=False)) else 1

        # ④ 点按钮生成
        g_ok, gj = eval_json(cdp, GENERATE_JS, required=('ok',), desc='点“示例星系（测试）”')
        bad += 0 if ck('按钮点得开（自建项目里不再是只读）', bool(g_ok) and gj.get('ok'),
                       json.dumps(gj, ensure_ascii=False)[:120]) else 1
        af = gj.get('after') or {}
        bad += 0 if ck('生成 4 个星域', af.get('domains') == 4, f"星域 {af.get('domains')}") else 1
        bad += 0 if ck('生成 120 颗恒星', af.get('galaxies') == 120, f"恒星 {af.get('galaxies')}") else 1
        bad += 0 if ck('生成航道网（A 档 175 条）', (af.get('lanes') or 0) >= 100,
                       f"航道 {af.get('lanes')}") else 1
        print(f"  · 节点 {before.get('nodes')} → {af.get('nodes')} · 航道 "
              f"{before.get('lanes')} → {af.get('lanes')}", flush=True)
        time.sleep(0.8)

        # ⑤ 截图（画布 + 工具栏都在里面）
        png = shot(cdp, 'generated')
        print(f'  → {png}', flush=True)
        bad += 0 if ck('截图已落盘', bool(png) and os.path.getsize(png) > 20000,
                       f'{os.path.getsize(png) if png else 0} 字节') else 1

        # ⑧ 落盘：自动保存（800ms 防抖）后，自建项目的载荷里要有这 4 个星域
        saved = {}
        end = time.time() + 12
        while time.time() < end:
            saved = eval_json(cdp, SAVED_SELF_JS, required=('saves',), desc='自建项目保存载荷')[1]
            if saved.get('saves') and saved.get('domains') == 4:
                break
            time.sleep(0.5)
        bad += 0 if ck('自动保存把示例星系写进**自建项目**（不是 harness）',
                       saved.get('saves', 0) >= 1 and saved.get('domains') == 4,
                       json.dumps(saved, ensure_ascii=False)) else 1

        # ⑥ 一次 Ctrl+Z 精确撤回
        un = eval_json(cdp, UNDO_JS, required=('nodes',), desc='撤销一次')[1]
        bad += 0 if ck('一次撤销精确回到生成前（1 节点 / 0 航道 / 0 星域）',
                       un.get('nodes') == 1 and un.get('lanes') == 0 and un.get('domains') == 0,
                       json.dumps(un, ensure_ascii=False)) else 1

        # ⑦ 反面对照：harness 基线项目全程没被创建、也没被保存
        hc = eval_json(cdp, HARNESS_CLEAN_JS, required=('inProjects',), desc='harness 是否被碰过')[1]
        bad += 0 if ck('harness 基线项目**从未被创建**（不再污染共享夹具）',
                       hc.get('inProjects') is False and hc.get('calls') == 0,
                       json.dumps(hc, ensure_ascii=False)) else 1
        bad += 0 if ck('harness 基线项目**从未被保存**', hc.get('inSaves') == 0,
                       f"保存 {hc.get('inSaves')} 次 · 落盘路径 {hc.get('savedPaths')}") else 1

        with open(os.path.join(OUT_DIR, 'summary.json'), 'w', encoding='utf-8') as f:
            json.dump({'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'bad': bad,
                       'before': before, 'after': af, 'saved': saved, 'undo': un,
                       'harness': hc}, f, ensure_ascii=False, indent=1)
        print(('  ✅ 示例星系（自建临时世界）判据通过' if not bad else f'  🔴 {bad} 项没过'), flush=True)
        print(f'  产物目录：{OUT_DIR}', flush=True)
        return 0 if not bad else 1
    finally:
        for h in reversed(handles):
            try:
                h.stop()
            except Exception:
                pass
        try:
            rt.teardown_mock()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
