#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""W1 判决卡 · 产物 A：4 张产品导出图（2026-11-09）

规格来源：scenario-product-manager（W1 出口条件、U5b 的唯一数据来源）。
本脚本**只**负责「四张可复现的图 + 一份可核对的 result.json」；
ΔE 表、p99 统计、判据打分归 qa-engineer。

四条硬要求（PM 点名，都是踩过的坑）：
 1. **不许用 `Page.captureScreenshot` 代替导出**。截图带 UI、带选中态、分辨率不受控 ——
    那就换成了另一个判据。这里的图全部来自产品导出入口：点 `[data-testid="export-png"]`
    触发 `exportPNG`，在点击**前**劫 `window.sitianAPI.saveExportFile` 取走 `dataUrl`。
    `exportPNG` 只在 `!result?.success` 时才回退 `<a download>`，所以返回 `{success:true}`
    即可拿到成品图，且不弹保存框。
 2. 先关免责声明再导航（本机 `.w1-edge-profile` 隔离目录 + `lib` 的种子口径）。
 3. 判定一律走 `lib.cdp.eval_json()`（它返回 `(ok, obj)`；缺 `fails` 字段/JS 异常 = 失败），
    不写"没有报错就算过"。
 4. 只读原件：跑前跑后 sha256 必须一致；415 省那份哈希不匹配**立即中止**（基准变了，
    后面的数全是假的）。副本跑完删除，`build/` 之外一个字节都不动。

🔴 必须跑**真机 Electron**（`node_modules/electron/dist/electron.exe`），不能跑 mock 页：
   `projectOpen` / `saveExportFile` 都是真实 IPC；mock 页里 `window.sitianAPI` 是内存假实现，
   打开真实 `.sitian` 会静默失败 —— 那种"跑通了但图是空的"就是本项目反复踩的静默假绿。

🔴 **当前状态：被产品侧一处缺口服住，四张图出不来（2026-11-09 四轮实跑定位）**
   现象：脚本能打开真实 .sitian、进剧本、选底图/剧本、相机与适屏都正常，但点导出后
       `__w1Export` 永远不出现（渲染器**不卡**、无 JS 异常、页面 `visible`）。
   根因（两条，实测证据）：
     ① `window.sitianAPI` 被 contextBridge **深冻结**：
        `Object.isFrozen(...)===true`、`saveExportFile` 的 descriptor 是
        `{writable:false, configurable:false}` → 本文件下面那段"劫 saveExportFile"**注定无效**
        （赋值静默失败，非严格模式下连错都不报）。
     ② 于是走到真实 IPC `save-export-file`（`src/main/index.js:1097`），它**无条件**
        `dialog.showSaveDialog(...)` —— 原生模态框，CDP 关不掉，`await` 永不返回。
   结论：**产品导出通道目前不可被 drill 化**。三条出路（需产品拍板，非本脚本能绕）：
     A. 推荐 —— 给 `save-export-file` 加可选 `targetPath`（**照抄同文件 `diag-export`
        的既有先例："payload.target 给了就不弹对话框（演练/用例用）"**），
        `exportPNG` 侧把 `window.__SITIAN_EXPORT_TARGET__` 透传进去。约 8 行，不传则行为不变。
     B. drill 里用 CDP 的 `Page.setDownloadBehavior` + 让产品走 `<a download>` 回退 ——
        但回退分支只在 `result.success` 为假时触发，拿不到 dataUrl，**行不通**。
     C. 放弃"走产品入口"，改截 canvas —— 违反本文件开头第 1 条硬要求（会换成另一个判据）。
   在 A 落地前，本脚本只会产出 `result.json`（含 notes）与 `summary.md`，不会产 PNG。

⏱ 冷缓存首次导出可能 15 秒以上（4096 宽栅格烘焙 8–9s CPU + 分块 24ms 工作/24ms 让出），
   所以 `grab()` 的超时给到 420s，**不要**按 10s 设；`cdp.ws.settimeout` 也放宽到 90s
   （默认 15s 会在渲染器被占用时直接断连，报 `Connection to remote host was lost`）。

用法：
  python scripts/tests/drill_w1_verdict.py            # 正常跑
  python scripts/tests/drill_w1_verdict.py --keep     # 保留 .sitian 副本（排障用）
"""
import base64
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import run_tests as rt                                               # noqa: E402
from lib.cdp import CDP, wait_for, eval_json, fetch_string           # noqa: E402

TS = time.strftime('%Y%m%d-%H%M%S')
OUT = os.path.join(rt.ROOT, 'build', 'w1-verdict', TS)

# ── 输入（PM 指定；415 省那份的哈希是基准，不匹配就停）─────────────────────
CASES = [
    {'id': 'sample', 'src': os.path.join(rt.ROOT, 'sample', '示例世界.sitian'),
     'sha256': None, 'bytes': None},
]

# 🔴 真实项目**不进仓**（文件名本身就是私人内容）：要跑 415 省那一档，用环境变量给路径。
#    没给就只跑 sample —— 不写死路径，也不因为缺这个档就整体失败。
_REAL = os.environ.get('SITIAN_REAL_PROJECT', '').strip()
if _REAL:
    CASES.append({
        'id': 'real415',
        'src': _REAL,
        'sha256': 'e54cd5af3cf95b68b856496ae48eb27c555ed8ffcc77faf21d459fe6bf21c4e7',
        'bytes': 8250202,
    })
TARGET_W = 3840          # 产品导出 = 画布 CSS 宽 ×2（scenario/interaction/actions.js:68-70）→ 画布须 1920
RELIEF_STATE = [False, True]


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(33)
    return struct.unpack('>II', head[16:24])


# ── 页面侧：打开项目（真实 IPC）────────────────────────────────────────────
OPEN_JS = r"""(async () => {
  const app = document.querySelector('#app').__vue_app__;
  if (!app) return JSON.stringify({ fails: ['应用未挂载'] });
  const pinia = app.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const proj = useProjectStore(pinia);
  const r = await proj.openProject('__PATH__');
  if (!(r && r.success === true)) return JSON.stringify({ fails: ['projectOpen 失败：' + ((r && r.error) || '未知')] });
  return JSON.stringify({ fails: [], filePath: proj.filePath });
})()"""

# ── 页面侧：走产品路径进剧本视图（点页签 → 卡片墙 → 点卡）→ 选底图/剧本 → 适屏 ──
ENTER_JS = r"""(async () => {
  const tick = ms => new Promise(r => setTimeout(r, ms));
  const fails = [], notes = {};
  const tab = document.querySelector('[data-testid="module-scenario"]');
  if (!tab) return JSON.stringify({ fails: ['找不到"历史剧本"页签'], notes });
  tab.click();
  await tick(1400);
  const card = document.querySelector('.sp-card');
  if (card) { card.click(); await tick(1800); }
  const SM = (document.querySelector('.scenario-map-container') || {}).__vueParentComponent;
  if (!SM) return JSON.stringify({ fails: ['剧本编辑器未挂载（卡片墙没点开？）'], notes });
  const s = SM.setupState;

  const keys = Object.keys(s.store.baseMaps || {});
  notes.baseMapKeys = keys;
  if (!keys.length) return JSON.stringify({ fails: ['项目里没有底图'], notes });
  if (!s.baseMapKey) {
    s.baseMapKey = keys[0];
    if (typeof s.onBaseMapChange === 'function') await s.onBaseMapChange();
    await tick(1400);
  }
  const ids = ((s.timeline && s.timeline.scenarios) || []).map(x => x.id);
  notes.scenarioIds = ids;
  if (!ids.length) return JSON.stringify({ fails: ['项目里没有剧本'], notes });
  // `selectScenario(s)` 收的是**剧本对象**（ScenarioMap.vue:2262），不是 id
  if (typeof s.selectScenario === 'function') s.selectScenario(s.store.scenarios[ids[0]]);
  await tick(600);
  s.viewMode = 'scenario';
  s.tlEra = 0;
  await tick(600);
  if (typeof s.fitToView === 'function') s.fitToView();
  await tick(1000);
  notes.camera = { x: s.cameraX, y: s.cameraY, scale: s.cameraScale };
  notes.scenarioId = (s.selectedScenario && s.selectedScenario.id) || null;
  if (!notes.scenarioId) fails.push('选中剧本为空（画布会没有归属色）');
  return JSON.stringify({ fails, notes });
})()"""

# ── 页面侧：浮雕开/关（写开关 → 重绘 → **读回实际值**，不假设设了就生效）──────
RELIEF_JS = r"""((on) => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  if (on) delete window.__SITIAN_SCENARIO_RELIEF__;
  else window.__SITIAN_SCENARIO_RELIEF__ = false;
  if (typeof SM.render === 'function') SM.render();
  const actual = (typeof SM.reliefOn === 'function') ? SM.reliefOn() : null;
  return JSON.stringify({
    fails: (actual === null) ? ['setupState 上取不到 reliefOn() —— 无法读回实际状态'] : [],
    requested: on, actual,
  });
})(%s)"""

# ── 页面侧：产品导出入口 ───────────────────────────────────────────────────
HOOK_JS = r"""(() => {
  window.__w1Export = null;
  window.sitianAPI.saveExportFile = async (p) => { window.__w1Export = p.dataUrl; return { success: true }; };
  return JSON.stringify({ fails: [], hooked: true });
})()"""

# ⚠️ 必须 async 且**轮询等面板渲染**（2026-11-09 首跑实测踩到）：
#   `.more-toggle` 的 click 只改 Vue 响应式状态，`v-if="moreOpen"` 的浮层在**微任务之后**才进 DOM。
#   同步 `click(); querySelector('[data-testid="export-png"]')` 必然拿到 null ——
#   报错信息看起来像"按钮不存在"，实际是"没等渲染"。而且不能写成"再点一次 more-toggle"，
#   第二次点会把面板收起来，于是第二张图换成"等导出产物超时"这种完全不相关的失败。
CLICK_EXPORT_JS = r"""(async () => {
  const tick = ms => new Promise(r => setTimeout(r, ms));
  let btn = document.querySelector('[data-testid="export-png"]');
  if (!btn) {
    const more = document.querySelector('.more-toggle');
    if (!more) return JSON.stringify({ fails: ['找不到 .more-toggle（主行结构变了？）'] });
    more.click();
    for (let i = 0; i < 25 && !btn; i++) { await tick(100); btn = document.querySelector('[data-testid="export-png"]'); }
  }
  if (!btn) return JSON.stringify({ fails: ['"更多"展开后 2.5s 仍找不到 export-png'] });
  btn.click();
  return JSON.stringify({ fails: [] });
})()"""

CANVAS_W_JS = ("JSON.stringify({ fails: [], w: (() => { const c = document.querySelector("
               "'.scenario-map-container canvas'); return c ? c.getBoundingClientRect().width : 0; })() })")


def aw(ok, obj, desc):
    """`eval_json` 返回 (ok, obj|err)；这里统一成 (ok, obj, err_text) 便于本文件直读。"""
    if not ok:
        return False, {}, f'{desc}: {obj}'
    return True, obj, ''


def fit_viewport_for_1920(cdp, log):
    """把视口调到「剧本画布 CSS 宽 = 1920」（导出 ×2 = 3840）。最多 3 次逼近。"""
    width, height, cw = 2200, 1100, 0
    for _ in range(3):
        cdp.send('Emulation.setDeviceMetricsOverride',
                 {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})
        time.sleep(1.2)
        ok, obj, err = aw(*eval_json(cdp, CANVAS_W_JS, desc='画布宽'), '画布宽')
        if not ok:
            log('    ⚠️ ' + err)
            return False, 0
        cw = obj.get('w') or 0
        log(f'    视口 {width}×{height} → 画布 CSS 宽 {cw:.1f}')
        if abs(cw - 1920) <= 2:
            return True, cw
        if cw <= 0:
            return False, 0
        width = int(width + (1920 - cw)) + 1
    return abs(cw - 1920) <= 8, cw


def grab(cdp, path, timeout=420):
    """轮询 `__w1Export` → 分块取回 dataUrl → 写盘。返回 (ok, err, cdp)。

    🔴 两个必须知道的坑（2026-11-09 首跑实测，两条都会把整轮打成"运行失败"）：
      ① `lib.cdp` 的 ws 读超时是 **15s**，而导出的同步绘制（4096 栅格烘焙）会**长时间占住渲染器**，
         这期间任何 `Runtime.evaluate` 都答不上来 → `WebSocketTimeoutException`，且之后同一个 ws
         上的请求全废（报 `Connection to remote host was lost`）。所以：先 `sleep` 让出一整段、
         再把 ws 超时放宽到 90s、遇到断连就**换根管子**（页面里的 hook 不随 ws 消失）。
      ② PNG base64 常 10MB 上下，一次 `Runtime.evaluate` 必然撞超时 → 必须用 `fetch_string` 分块取。
    """
    t0 = time.time()
    time.sleep(6)                       # 这段是"别去打扰它"的时间，不是浪费
    while time.time() - t0 < timeout:
        try:
            if cdp.eval('!!window.__w1Export'):
                break
        except Exception:
            try:
                cdp.ws.close()
            except Exception:
                pass
            cdp = CDP(port=rt.CDP_PORT)
            cdp.ws.settimeout(90)
        time.sleep(1.5)
    else:
        return False, 'timeout', cdp
    try:
        data_url = fetch_string(cdp,
                                'window.__w1Export.length',
                                lambda i, j: f'window.__w1Export.slice({i}, {j})',
                                desc='导出 dataUrl')
    except Exception as e:
        return False, f'取回 dataUrl 失败：{e}', cdp
    if not data_url.startswith('data:image/png;base64,'):
        return False, f'dataUrl 前缀异常：{data_url[:60]}', cdp
    with open(path, 'wb') as f:
        f.write(base64.b64decode(data_url.split(',', 1)[1]))
    return True, '', cdp


def main():
    keep = '--keep' in sys.argv[1:]
    os.makedirs(OUT, exist_ok=True)

    # ① 只读校验 + ② 复制到 build/ 再用
    before = {}
    for c in CASES:
        if not os.path.exists(c['src']):
            print(f'  ❌ 缺输入：{c["src"]}', flush=True)
            return 2
        before[c['src']] = sha256_of(c['src'])
        if c.get('sha256') and before[c['src']] != c['sha256']:
            print(f'  ❌ 基准哈希不匹配，中止（后面的数全是假的）：{c["src"]}', flush=True)
            print(f'     期望 {c["sha256"]}\n     实际 {before[c["src"]]}', flush=True)
            return 2
        if c.get('bytes') and os.path.getsize(c['src']) != c['bytes']:
            print(f'  ❌ 基准字节数不匹配，中止：{c["src"]}', flush=True)
            return 2
        c['copy'] = os.path.join(OUT, os.path.basename(c['src']))
        shutil.copy2(c['src'], c['copy'])
        print(f'  ✅ 输入就绪 {c["id"]}（{os.path.getsize(c["copy"])} B）', flush=True)

    # ③ 真机 Electron（不是 mock 页）
    exe = os.path.join(rt.ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    env = dict(os.environ)
    env['NODE_ENV'] = 'development'
    env.pop('OPEN_DEVTOOLS', None)
    env.pop('ELECTRON_RUN_AS_NODE', None)

    dev = el = cdp = None
    result = {'ts': TS, 'targetWidth': TARGET_W, 'images': [], 'notes': []}
    try:
        for port in (rt.DEV_PORT, rt.CDP_PORT):
            if rt._tcp_open(port, '127.0.0.1'):
                print(f'  ❌ 端口 {port} 被占用（先停掉正在跑的回归/演练）', flush=True)
                return 2
        dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=rt.ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not rt.wait_port(rt.DEV_PORT, timeout=120):
            raise RuntimeError('vite dev server 启动超时')
        el = subprocess.Popen([exe, '.', '--remote-debugging-port=%d' % rt.CDP_PORT,
                               '--remote-allow-origins=*',
                               '--disable-background-timer-throttling',
                               '--disable-renderer-backgrounding',
                               '--disable-backgrounding-occluded-windows',
                               '--disable-features=CalculateNativeWinOcclusion',
                               '--user-data-dir=%s' % os.path.join(OUT, '_profile')],   # 放 build/ 内，别污染仓库根
                              cwd=rt.ROOT, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not rt.wait_port(rt.CDP_PORT, timeout=90):
            raise RuntimeError('Electron CDP 没起来')
        cdp = CDP(port=rt.CDP_PORT)
        cdp.ws.settimeout(90)          # 导出会长时间占住渲染器，15s 的默认读超时不够（见 grab 注释）
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='应用挂载')
        time.sleep(2.0)
        try:
            cdp.send('Page.bringToFront', {})
        except Exception as e:
            print('  ⚠️ bringToFront 失败（继续）：', e, flush=True)

        for c in CASES:
            print(f'\n=== {c["id"]} ===', flush=True)
            ok, obj, err = aw(*eval_json(cdp, OPEN_JS.replace('__PATH__', c['copy'].replace('\\', '/')),
                                        desc='openProject'), 'openProject')
            if not ok or obj.get('fails'):
                msg = err or str(obj.get('fails'))
                result['notes'].append(f'{c["id"]}: {msg}')
                print('  ❌', msg, flush=True)
                continue
            ok, obj, err = aw(*eval_json(cdp, ENTER_JS, desc='进剧本视图'), '进剧本视图')
            if not ok or obj.get('fails'):
                msg = err or str(obj.get('fails'))
                result['notes'].append(f'{c["id"]}: {msg}')
                print('  ❌', msg, flush=True)
                continue
            print('  进剧本：', json.dumps(obj.get('notes', {}), ensure_ascii=False), flush=True)
            vis = cdp.eval("JSON.stringify({hidden:document.hidden,vis:document.visibilityState})")
            print('  页面可见性：', vis, flush=True)
            result.setdefault('visibility', {})[c['id']] = vis
            fit_ok, cw = fit_viewport_for_1920(cdp, print)
            if not fit_ok:
                result['notes'].append(f'{c["id"]}: 画布宽 {cw:.0f} 无法逼近 1920（导出会 ≠3840）')
            ok, obj, err = aw(*eval_json(cdp, HOOK_JS, desc='劫 saveExportFile'), '劫 saveExportFile')
            if not ok:
                result['notes'].append(f'{c["id"]}: {err}')
                continue

            for on in RELIEF_STATE:
                name = f'{c["id"]}-relief-{"on" if on else "off"}'
                ok, obj, err = aw(*eval_json(cdp, RELIEF_JS % ('true' if on else 'false'), desc='切浮雕'), '切浮雕')
                actual = obj.get('actual')
                if not ok or actual != on:
                    # 硬要求：读回值必须等于请求值，否则这张图不能当判据
                    result['notes'].append(f'{name}: reliefOn 实际 {actual} ≠ 请求 {on}（{err}）')
                    print(f'  ❌ {name}: reliefOn 实际 {actual} ≠ 请求 {on}', flush=True)
                t0 = time.time()
                cdp.eval('window.__w1Export = null')
                ok, obj, err = aw(*eval_json(cdp, CLICK_EXPORT_JS, desc='点导出'), '点导出')
                if not ok or obj.get('fails'):
                    result['notes'].append(f'{name}: {err or obj.get("fails")}')
                    print('  ❌', err or obj.get('fails'), flush=True)
                    continue
                png = os.path.join(OUT, name + '.png')
                ok, err, cdp = grab(cdp, png)
                ms = int((time.time() - t0) * 1000)
                if not ok:
                    result['notes'].append(f'{name}: 导出失败 {err}')
                    print(f'  ❌ {name} 导出失败：{err}', flush=True)
                    continue
                w, h = png_size(png)
                result['images'].append({'file': name + '.png', 'sha256': sha256_of(png),
                                         'w': w, 'h': h, 'reliefOn': actual, 'ms': ms})
                print(f'  ✅ {name}.png  {w}×{h}  {ms}ms', flush=True)
    except Exception as e:
        result['notes'].append(f'运行失败：{e}')
        print(f'  ❌ 运行失败：{e}', flush=True)
    finally:
        for p in (el, dev):
            try:
                if p:
                    p.terminate()
            except Exception:
                pass
        if cdp:
            try:
                cdp.close()
            except Exception:
                pass
        # ④ 收尾：删副本（--keep 可留），并复核原件哈希
        if not keep:
            for c in CASES:
                for p in (c['copy'], c['copy'] + '.backups'):
                    try:
                        if os.path.isdir(p):
                            shutil.rmtree(p, ignore_errors=True)
                        elif os.path.exists(p):
                            os.remove(p)
                    except OSError:
                        pass
        for c in CASES:
            if sha256_of(c['src']) != before[c['src']]:
                result['notes'].append(f'原件被改动！{c["src"]}')

    with open(os.path.join(OUT, 'result.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    lines = [f'# W1 判决卡 · 产物 A（{TS}）', '', f'目标宽 {TARGET_W}px；目录 `{OUT}`', '']
    for im in result['images']:
        lines.append(f"- `{im['file']}` {im['w']}×{im['h']} reliefOn={im['reliefOn']} "
                     f"{im['ms']}ms sha256={im['sha256'][:16]}…")
    if result['notes']:
        lines += ['', '## 问题'] + [f'- {n}' for n in result['notes']]
    with open(os.path.join(OUT, 'summary.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')

    ok = len(result['images']) == 4 and not result['notes']
    print(f'\n产出 {len(result["images"])}/4 张 → {OUT}', flush=True)
    for n in result['notes']:
        print('  ⚠️', n, flush=True)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
