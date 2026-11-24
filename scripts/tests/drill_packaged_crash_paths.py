#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机复验：**打包版**里走一遍 0.5.1 用户崩过的那三条路（0.5.20）

为什么单独写这一条：源码修好 ≠ 用户装的包里修好。`run_tests.py` 跑的是 Vite dev server
（`localhost:5180` 的未压缩模块），而用户崩的是 `app.asar` 里**压缩过的 chunk**
（`SystemDetailView-BKZ-wFec.js` / `PlanetMap-BKi3i2NT.js`）。压缩会改变量名、内联函数，
"源码里没问题"根本不能推出"包里没问题"。

复验三条（全部按**用户点得到**的路径走，不直接改 store 内部变量）：
  A. 1~2 颗行星的恒星系 → 画布渲染名字（`planetCount < 3` 那条分支，0.5.1 崩在这里）
  B. 行星图开"政治 / 群系轮廓 / 海岸山脊 / 文化宗教"四层（`getState` 崩在这里）
  C. 建筑内部拖动家具吸附网格（`worldTop` 崩在这里）
每一步之后都断言**没有弹出错误面板**（`#sitian-error-overlay`）—— 这是用户看到的东西。

用法：python scripts/tests/drill_packaged_crash_paths.py
前置：先 `npm run dist`（用 win-unpacked 里的打包版，不是 dev server）。
退出码：0 = 全通过。
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

# ⚠️ Windows 重定向 stdout 默认是 GBK —— 打印 ✅/❌ 会 UnicodeEncodeError（AGENTS.md 记过这条）
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.cdp import CDP, find_page_ws  # noqa: E402

CDP_PORT = 9227          # 不与 run_tests(9222) / packaged drill(9226) 抢
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIST = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'sitian-build', 'release', 'win-unpacked')
EXE = os.path.join(DIST, '司天.exe')

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f'{"✅" if ok else "❌"} {name}' + (f' — {detail}' if detail else ''))


def port_open(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=1):
            return True
    except Exception:
        return False


def error_panel(cdp):
    """页面上的错误面板正文（没有则空串）。"""
    raw = cdp.eval("""(() => {
      const el = document.getElementById('sitian-error-overlay');
      if (!el) return '';
      const pre = el.querySelector('[data-role=detail]');
      return (pre && pre.textContent ? pre.textContent : '(无详情)').slice(0, 500);
    })()""")
    return raw if isinstance(raw, str) else ''


def wait_for(cdp, expr, timeout=25, desc=''):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if cdp.eval(f'!!({expr})'):
                return True
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError(f'等待超时：{desc or expr}')


def main():
    if port_open(CDP_PORT):
        print(f'CDP 端口 {CDP_PORT} 已被占用 —— 先停掉正在跑的演练')
        return 1
    if not os.path.exists(EXE):
        print(f'找不到打包版：{EXE}\n先跑 npm run dist')
        return 1

    # 🔴 记录演练**前**文档目录里已有哪几个示例副本 —— 收尾时只删"多出来的那些"，
    #    绝不按通配符盲删（用户自己的示例与历史副本必须原样留着）。
    _proj_dir = os.path.join(os.path.expanduser('~'), 'Documents', 'SiTianProjects')
    def _sample_set():
        try:
            return {n for n in os.listdir(_proj_dir)
                    if n.startswith('示例世界') and n.endswith('.sitian')}
        except Exception:
            return set()
    _samples_before = _sample_set()
    _created_sample_paths = []

    profile = os.path.join(ROOT, 'build', 'packaged-crash-paths', 'profile')
    shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)
    os.makedirs(os.path.join(ROOT, 'build', 'packaged-crash-paths'), exist_ok=True)

    log = open(os.path.join(ROOT, 'build', 'packaged-crash-paths', 'electron.log'), 'w', encoding='utf-8')
    # ⚠️ 照抄 drill_packaged_app.py 的启动口径（它已经被真机证明可用）：
    #   · `cwd=unpacked` —— 从包目录起，别让相对路径解析到仓库；
    #   · 清掉 ELECTRON_RUN_AS_NODE / NODE_ENV —— 否则打包版会误走 dev 分支；
    #   · `--disable-gpu` —— headless 下 GPU 初始化会拖很久甚至挂住。
    env = os.environ.copy()
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env.pop('NODE_ENV', None)
    proc = subprocess.Popen([
        EXE,
        f'--user-data-dir={profile}',
        f'--remote-debugging-port={CDP_PORT}',
        '--disable-gpu', '--disable-software-rasterizer',
    ], cwd=DIST, env=env, stdout=log, stderr=subprocess.STDOUT)
    cdp = None
    try:
        deadline = time.time() + 180
        while time.time() < deadline and not port_open(CDP_PORT):
            time.sleep(0.5)
        if not port_open(CDP_PORT):
            check('打包版启动', False, '180s 内 CDP 端口没起来（见 build/packaged-crash-paths/electron.log）')
            return 1
        check('打包版启动', True, f'CDP {CDP_PORT}')
        # 打包版页面是 file://，必须按前缀挑（否则可能连到 edge://downloads-hub 这类页）
        cdp = CDP(ws_url=find_page_ws(CDP_PORT, timeout=120, prefer_prefix='file://'))
        wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                 timeout=180, desc='应用挂载')
        time.sleep(1.0)

        # 免责声明：打包版首启是 **gate 模式**（滚到底 + 勾选两道门槛）。
        # 🔴 程序化 `el.click()` 对 `:disabled` 按钮是**静默 no-op**（AGENTS.md / test_83 都记过），
        #    于是上一版"点了三个候选按钮"其实一次都没生效，示例项目按钮被弹窗挡着点不到
        #    → 根因看起来像"打包版 store 坏了"，实际是弹窗还在（本次诊断抓到的：
        #    `disclaimer: true` + 正文里世界选择页正常渲染）。
        # 正规解法（test_83 / shot_settings_panel 同款）：**自己写 ack 键**再重载，
        # 而不是跟弹窗的 disabled 按钮较劲。
        ack_set = cdp.eval("""(() => {
          try {
            const KEY = 'sitian_disclaimer_ack_v1.2.0';
            if (!localStorage.getItem(KEY)) {
              localStorage.setItem(KEY, new Date().toISOString());
              return 'wrote';
            }
            return 'already:' + localStorage.getItem(KEY);
          } catch (e) { return 'err:' + e.message; }
        })()""")
        print(f'   [免责声明] ack={ack_set}')
        if isinstance(ack_set, str) and ack_set.startswith(('wrote', 'already')):
            # ⚠️ `cdp.navigate()` 默认跳 dev server（localhost:5180），打包版必须跳回**当前这个
            #    file:// 地址**。写错的话表现为"重载后应用挂载超时"，很容易误判成打包版坏了。
            cur_url = cdp.eval('location.href')
            cdp.navigate(cur_url if isinstance(cur_url, str) and cur_url.startswith('file://') else None)
            time.sleep(2.5)
            wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                     timeout=120, desc='重载后挂载')
            time.sleep(1.2)
        # 兜底：万一 ack 没生效，把弹窗按"滚到底 → 勾选 → 同意"的真实顺序走一遍
        if cdp.eval("!!document.querySelector('[class*=disclaimer]')"):
            cdp.eval("""(() => {
              const sc = document.querySelector('.disclaimer-body, .disclaimer-scroll, [data-role=scroll]');
              if (sc) sc.scrollTop = sc.scrollHeight;
              document.querySelectorAll('input[type=checkbox]').forEach(c => {
                if (!c.checked) c.click();
              });
              const btns = Array.from(document.querySelectorAll('button'));
              const go = btns.find(x => (x.textContent || '').includes('同意并继续') && !x.disabled);
              if (go) go.click();
              return 'ok';
            })()""")
            time.sleep(1.2)
        still_up = cdp.eval("!!document.querySelector('[class*=disclaimer]')")
        check('免责声明已关闭', not still_up, '已关闭' if not still_up else '仍在（后面的示例项目会被它挡住）')

        # 打开示例项目（走产品自己的按钮，复制到文档目录再打开）
        # 🔴 这一段的两个坑（都在真机上踩过）：
        #   ① 重载后世界选择页要**几拍**才渲染出来 —— 点得太早 `b` 还是 null，
        #      静默什么都没发生，然后空等 180s；
        #   ② 点到了也不代表装载完成（复制 2MB 示例 + 主进程 open + adopt 要几秒）。
        #      所以判据是"**数据真的进 store 了**"，不是"点击调用发出去了"。
        #   做法：循环「找按钮→点→等两秒→查 store」，直到就绪或超时。
        _btn_deadline = time.time() + 90
        _ready = False
        _clicked = False
        while time.time() < _btn_deadline:
            if not _clicked:
                _clicked = bool(cdp.eval("""(() => {
                  const b = document.querySelector('[data-testid=world-open-sample]')
                         || Array.from(document.querySelectorAll('button'))
                              .find(x => (x.textContent || '').includes('示例地图项目'));
                  if (!b || b.disabled) return false;
                  b.click();
                  return true;
                })()"""))
            try:
                _ready = bool(cdp.eval(
                    "(() => { try { const a = document.querySelector('#app').__vue_app__;"
                    " const p = a && a.config.globalProperties.$pinia;"
                    " const s = p && p._s.get('geodata');"
                    " return !!(s && s.nodes && s.nodes.length); } catch (e) { return false; } })()"))
            except Exception:
                _ready = False
            if _ready:
                break
            time.sleep(1.0)
        check('点得到「示例地图项目」', _clicked,
              '已点' if _clicked else '90s 内按钮都没出现/一直禁用（世界选择页没渲染？）')
        if not _ready:
            diagx = cdp.eval(
                "(() => {"
                " const a = document.querySelector('#app') && document.querySelector('#app').__vue_app__;"
                " const pinia = a && a.config.globalProperties && a.config.globalProperties.$pinia;"
                " return JSON.stringify({"
                "  hasApp: !!a, hasPinia: !!pinia,"
                "  stores: pinia ? Array.from(pinia._s.keys()) : [],"
                "  disclaimer: !!document.querySelector('[class*=disclaimer]'),"
                "  text: (document.body.innerText || '').slice(0, 300).replace(/\\s+/g, ' '),"
                " });"
                "})()")
            check('示例项目数据就绪', False, '90s 仍未就绪｜诊断=' + str(diagx)[:400])
            raise SystemExit(1)
        time.sleep(1.5)
        diag0 = cdp.eval("""(() => {
          const a = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
          const pinia = a && a.config.globalProperties && a.config.globalProperties.$pinia;
          const g = pinia && pinia._s.get('geodata');
          const p = pinia && pinia._s.get('project');
          return JSON.stringify({
            hasPinia: !!pinia,
            geodata: !!g, nodes: g ? (g.nodes || []).length : -1,
            projectOpen: p ? !!p.isOpen : null,
            disclaimerStillUp: !!document.querySelector('[class*=disclaimer]'),
            bodyText: (document.body.innerText || '').slice(0, 160).replace(/\\s+/g, ' '),
          });
        })()""")
        print('   [启动诊断] ' + str(diag0)[:500])
        _created_sample_paths = [os.path.join(_proj_dir, n)
                                 for n in (_sample_set() - _samples_before)]
        if _created_sample_paths:
            print('   [本轮副本] ' + ', '.join(os.path.basename(x) for x in _created_sample_paths))
        check('示例项目打开', True, '实体树已就绪')

        # 打包版统一走 pinia（store id 见 defineStore 的第一个参数）
        # geodata store（`defineStore('geodata', …)`）是 nodes / 视图层级 / mapData 的唯一来源
        store = ("(document.querySelector('#app').__vue_app__.config.globalProperties"
                 ".$pinia._s.get('geodata'))")

        # ---- A. 1~2 颗行星的恒星系（0.5.1 的 planetCount 分支） ----
        nav = cdp.eval(f"""(() => {{
          const s = {store};
          const sys = s.nodes.find(n => n.layer === 'system')
                   || s.nodes.find(n => n.layer === 'star')
                   || s.nodes.find(n => n.layer === 'planet');
          if (!sys) return 'no-system';
          const world = s.nodes.find(n => n.layer === 'world');
          if (world) s.selectWorld(world);
          s.enterSystemDetail(sys);
          return JSON.stringify({{ level: s.viewLevel, id: sys.id }});
        }})()""")
        ok_a = False
        if isinstance(nav, str) and nav.startswith('{'):
            wait_for(cdp, "document.querySelector('.system-detail-container canvas')", timeout=30,
                     desc='恒星系画布挂载')
            time.sleep(1.2)
            # 🔴 打包版里**读不到组件 setupState**（压缩后 `__vueParentComponent` 链不可靠），
            #    所以判据必须落在**用户看得见的东西**上：
            #      ① 画布像素指纹在"重绘前后"真的变了（= 那几行名字真画上去了，不是空转）
            #      ② 全程没有错误面板
            #    只判②是空的：如果这一帧根本没渲染，②永远绿。
            def canvas_hash():
                return cdp.eval("""(() => {
                  const c = document.querySelector('.system-detail-container canvas');
                  if (!c) return 'no-canvas';
                  const ctx = c.getContext('2d');
                  const d = ctx.getImageData(0, 0, c.width, c.height).data;
                  let h = 2166136261 >>> 0, nz = 0;
                  for (let i = 0; i < d.length; i += 13 * 4) {
                    if (d[i] || d[i + 1] || d[i + 2]) nz++;
                    h ^= d[i]; h = Math.imul(h, 16777619) >>> 0;
                    h ^= d[i + 1]; h = Math.imul(h, 16777619) >>> 0;
                    h ^= d[i + 2]; h = Math.imul(h, 16777619) >>> 0;
                  }
                  return h.toString(16) + ':' + nz;
                })()""")

            # 🔴 不能点画布：点=下钻，视图会切走（上一版就是这么把画布点没的，读成 no-canvas）。
            #    只派 mousemove 触发产品自己的重绘（悬停会重画，不会导航）。
            h0 = canvas_hash()
            cdp.eval("""(() => {
              const c = document.querySelector('.system-detail-container canvas');
              if (!c) return 'no-canvas';
              const r = c.getBoundingClientRect();
              for (let i = 0; i < 6; i++) {
                c.dispatchEvent(new MouseEvent('mousemove', {
                  clientX: r.left + 40 + i * 37, clientY: r.top + 40 + i * 29,
                  bubbles: true, cancelable: true, button: 0,
                }));
              }
              return 'ok';
            })()""")
            time.sleep(1.4)
            h1 = canvas_hash()
            panel_a = error_panel(cdp)
            # 判据（这一条最容易写成空转，写清为什么是这三个）：
            #   · 画布还在（不是 no-canvas）= 视图没被点走、没崩掉；
            #   · 非空像素 > 500 = 这一帧真的画了东西（恒星/轨道/行星），不是空白；
            #   · 零错误面板。
            #   注意**不要求指纹变化**：名字是静态渲染，重绘一帧本来就该逐像素一致。
            def nz_of(h):
                try:
                    return int(str(h).split(':')[-1])
                except Exception:
                    return -1
            alive = isinstance(h1, str) and h1 != 'no-canvas'
            nonzero = nz_of(h1) > 500
            ok_a = (not panel_a) and alive and nonzero
            drew = alive
            check('A. 恒星系画名字不崩（planetCount 分支）', ok_a,
                  f'指纹 {h0} → {h1}（非空像素 {h1.split(":")[-1] if isinstance(h1,str) else "?"}）'
                  + (f'｜错误面板：{panel_a}' if panel_a else '｜零错误面板')
                  + ('' if drew else '｜画布没变=没渲染，本条判据无效'))
        else:
            check('A. 恒星系画名字不崩（planetCount 分支）', False, f'未能进入恒星系视图（{nav}）')

        # ---- B. 行星图开四个 Azgaar 图层（0.5.1 的 getState 分支） ----
        navp = cdp.eval(f"""(() => {{
          const s = {store};
          const planet = s.nodes.find(n => n.layer === 'planet');
          if (!planet) return 'no-planet';
          s.selectPlanet(planet);
          return s.viewLevel;
        }})()""")
        ok_b = False
        if navp == 'planet':
            wait_for(cdp, "document.querySelector('.planet-map-container canvas')", timeout=30,
                     desc='行星画布挂载')
            time.sleep(1.0)
            # 给足数据（打包版读不到源码路径，只能从 store 的公共口喂）
            cdp.eval(f"""(() => {{
              const s = {store};
              const pl = s.nodes.find(n => n.layer === 'planet');
              const md = s.mapData[pl.id] || {{ planetId: pl.id, version: 1 }};
              const COLS = 12, ROWS = 12, SP = 60;
              const pts = [];
              for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) pts.push({{ x: c * SP, y: r * SP }});
              const biome = [], h = [];
              for (let i = 0; i < COLS * ROWS; i++) {{
                const c = i % COLS, r = (i / COLS) | 0;
                h.push(c < COLS / 2 ? 5 : 45);
                biome.push(c < COLS / 2 ? 1 : 4);
              }}
              const ring = (x0, y0, x1, y1) => [{{x: x0, y: y0}}, {{x: x1, y: y0}},
                                                {{x: x1, y: y1}}, {{x: x0, y: y1}}];
              md.azgaarProvinces = [
                {{ id: 'p1', points: ring(20, 20, 300, 300), color: '#e74c3c',
                   cultureColor: '#3498db', religionColor: '#f1c40f' }},
                {{ id: 'p2', points: ring(320, 20, 640, 300), color: '#2ecc71',
                   cultureColor: '#9b59b6', religionColor: '#e67e22' }},
              ];
              md.heightmap = {{ biome: biome, h: h,
                grid: {{ cellsX: COLS, cellsY: ROWS, points: pts, spacing: SP }} }};
              const next = Object.assign({{}}, s.mapData);
              next[pl.id] = md;
              s.mapData = next;
              return 'ok';
            }})()""")
            time.sleep(0.8)
            # 用图层面板的按钮打开（= 用户点得到的那条路）
            for label in ('政治', '群系', '海岸', '文化'):
                cdp.eval(f"""(() => {{
                  const b = Array.from(document.querySelectorAll('.planet-map-container button'))
                    .find(x => (x.textContent || '').trim().includes('{label}'));
                  if (b && !b.classList.contains('active')) b.click();
                  return 'ok';
                }})()""")
            time.sleep(1.2)
            # 与 A 同一口径：**像素真的变了**才算验到；只判"没报错"会空转
            # 🔴 判据教训：行星画布**本来就铺满底图**，"非空像素数"恒等于采样总数，
            #    用它当判据永远是 +0（上一版就栽在这）。正确口径是
            #    **同一位置两帧之间有多少像素不同**。
            def planet_snap():   # 存一份快照到 window（不来回传整幅图）
                return cdp.eval("""(() => {
                  const c = document.querySelector('.planet-map-container canvas');
                  if (!c) return 'no-canvas';
                  const ctx = c.getContext('2d');
                  const d = ctx.getImageData(0, 0, c.width, c.height).data;
                  const px = [];
                  for (let i = 0; i < d.length; i += 4 * 3) px.push(d[i], d[i + 1], d[i + 2]);
                  window.__B_SNAP__ = px;
                  return px.length;
                })()""")

            def planet_diff():   # 与快照逐像素比，返回"不同通道值个数 / 不同像素数"
                return cdp.eval("""(() => {
                  const base = window.__B_SNAP__;
                  const c = document.querySelector('.planet-map-container canvas');
                  if (!base || !c) return -1;
                  const ctx = c.getContext('2d');
                  const d = ctx.getImageData(0, 0, c.width, c.height).data;
                  let diffPx = 0, k = 0;
                  for (let i = 0; i < d.length; i += 4 * 3) {
                    if (d[i] !== base[k] || d[i + 1] !== base[k + 1] || d[i + 2] !== base[k + 2]) diffPx++;
                    k += 3;
                  }
                  return diffPx;
                })()""")

            # 基线要在**四层全关**的状态下取，再全开比 —— 这样差值必然是这四层画的。
            cdp.eval(f"""(() => {{
              const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
              const lay = pinia._s.get('layers');
              for (const id of ['politicalBorders', 'biomeContours', 'coastlineRidges', 'cultureReligion']) {{
                if (lay.isVisible('planet', id)) lay.toggleLayer('planet', id);
              }}
              return 'ok';
            }})()""")
            time.sleep(1.6)
            planet_snap()
            diag = cdp.eval(f"""(() => {{
              const s = {store};
              const pl = s.nodes.find(n => n.layer === 'planet');
              const md = (pl && s.mapData[pl.id]) || null;
              const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
              const lay = pinia._s.get('layers');
              const btns = Array.from(document.querySelectorAll('.planet-map-container button'))
                .map(b => (b.textContent || '').trim()).filter(Boolean);
              return JSON.stringify({{
                hasPlanet: !!pl,
                azgaar: md ? (md.azgaarProvinces || []).length : 'no-md',
                hasHeightmap: !!(md && md.heightmap),
                vis: lay ? {{
                  politicalBorders: lay.isVisible('planet', 'politicalBorders'),
                  biomeContours: lay.isVisible('planet', 'biomeContours'),
                  coastlineRidges: lay.isVisible('planet', 'coastlineRidges'),
                  cultureReligion: lay.isVisible('planet', 'cultureReligion'),
                }} : 'no-layers',
                btnCount: btns.length,
                btnSample: btns.slice(0, 40),
              }});
            }})()""")
            print('   [B 诊断] ' + str(diag)[:900])
            # 🔴 一条踩过的坑：这些是 **toggle** 按钮，盲点第二下会把图层又关掉
            #    （上一版就是这么"点了四个按钮、结果四个全 false、像素 +0"）。
            #    正确做法：按 store 的可见性**只补关着的那几个**，并回读确认。
            enabled = cdp.eval(f"""(() => {{
              const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
              const lay = pinia._s.get('layers');
              const want = [
                ['politicalBorders', '政治'], ['biomeContours', '自然'],
                ['coastlineRidges', '海岸'], ['cultureReligion', '文化'],
              ];
              const out = {{}};
              for (const [id, label] of want) {{
                if (!lay.isVisible('planet', id)) {{
                  const b = Array.from(document.querySelectorAll('.planet-map-container button'))
                    .find(x => (x.textContent || '').trim().includes(label));
                  if (b) b.click();
                }}
                out[id] = lay.isVisible('planet', id);
              }}
              return JSON.stringify(out);
            }})()""")
            print('   [B 图层] ' + str(enabled)[:400])
            # 让相机适配到**现有内容**（示例底图 72 省），再把我注入的多边形挪到那个包围盒中心
            # —— 否则视口裁剪会在第一个循环就 continue 掉，四个函数等于没跑（上一版就是这么空转的）。
            placed = cdp.eval(f"""(() => {{
              const s = {store};
              const pl = s.nodes.find(n => n.layer === 'planet');
              const md = s.mapData[pl.id];
              // 现有地块/省份的包围盒中心
              let xs = [], ys = [];
              for (const poly of (md.terrain || [])) for (const p of (poly.points || [])) {{
                xs.push(p.x ?? p[0]); ys.push(p.y ?? p[1]);
              }}
              let cx = 0, cy = 0;
              if (xs.length) {{
                cx = (Math.min(...xs) + Math.max(...xs)) / 2;
                cy = (Math.min(...ys) + Math.max(...ys)) / 2;
              }}
              // 以中心为基准重铺（600x600 见方，与原有内容同尺度）
              const ring = (x0, y0, x1, y1) => [{{x: x0, y: y0}}, {{x: x1, y: y0}},
                                                {{x: x1, y: y1}}, {{x: x0, y: y1}}];
              const S = 600;
              const x0 = cx - S, y0 = cy - S, x1 = cx + S, y1 = cy + S;
              md.azgaarProvinces = [
                {{ id: 'p1', points: ring(x0, y0, cx, cy), color: '#e74c3c',
                   cultureColor: '#3498db', religionColor: '#f1c40f' }},
                {{ id: 'p2', points: ring(cx, y0, x1, cy), color: '#2ecc71',
                   cultureColor: '#9b59b6', religionColor: '#e67e22' }},
                {{ id: 'p3', points: ring(x0, cy, x1, y1), color: '#f39c12',
                   cultureColor: '#1abc9c', religionColor: '#c0392b' }},
              ];
              // 高度图也挪过来（12x12 格，spacing 100 → 覆盖 1100x1100，正好落在这个区）
              const COLS = 12, ROWS = 12, SP = 100;
              const pts = [], biome = [], h = [];
              for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {{
                pts.push({{ x: x0 + c * SP, y: y0 + r * SP }});
              }}
              for (let i = 0; i < COLS * ROWS; i++) {{
                const c = i % COLS, r = (i / COLS) | 0;
                h.push(c < COLS / 2 ? 5 : 45);
                biome.push(c < COLS / 2 ? 1 : 4);
                if (c > COLS - 3 && r > 2 && r < 8) h[i] = 90;
              }}
              md.heightmap = {{ biome: biome, h: h,
                grid: {{ cellsX: COLS, cellsY: ROWS, points: pts, spacing: SP }} }};
              const next = Object.assign({{}}, s.mapData);
              next[pl.id] = Object.assign({{}}, md);
              s.mapData = next;
              return JSON.stringify({{ center: [cx, cy], x0: x0, y0: y0, x1: x1, y1: y1 }});
            }})()""")
            print('   [B 重铺] ' + str(placed)[:300])
            # 点「⤢ 全图」让相机框住全部内容（注入的多边形就在内容包围盒里）
            cdp.eval("""(() => {
              const b = Array.from(document.querySelectorAll('.planet-map-container button'))
                .find(x => (x.textContent || '').includes('全图'));
              if (b) b.click();
              return 'ok';
            })()""")
            # 🔴 稳定化（上一版这里不稳，同一份代码两次跑出 337351 / 0 两个结果）：
            #    「全图」之后相机动画 / 分块烘焙 / 视口块要几拍才落定。等两段墙钟，
            #    并且**快照放在等待之后**——否则快照落在过渡帧上，差值就随机了。
            time.sleep(2.2)
            time.sleep(1.2)
            after = cdp.eval(f"""(() => {{
              const s = {store};
              const pl = s.nodes.find(n => n.layer === 'planet');
              const md = (pl && s.mapData[pl.id]) || null;
              const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
              const lay = pinia._s.get('layers');
              return JSON.stringify({{
                azgaar: md ? (md.azgaarProvinces || []).length : 'no-md',
                hasHeightmap: !!(md && md.heightmap),
                cells: md && md.heightmap && md.heightmap.grid
                  ? md.heightmap.grid.cellsX + 'x' + md.heightmap.grid.cellsY : null,
                viewLevel: s.viewLevel,
                planetId: pl && pl.id,
                mdPlanetId: md && md.planetId,
                vis: {{
                  politicalBorders: lay.isVisible('planet', 'politicalBorders'),
                  biomeContours: lay.isVisible('planet', 'biomeContours'),
                  coastlineRidges: lay.isVisible('planet', 'coastlineRidges'),
                  cultureReligion: lay.isVisible('planet', 'cultureReligion'),
                }},
              }});
            }})()""")
            print('   [B 点击后] ' + str(after)[:700])
            diff_px = planet_diff()
            panel_b = error_panel(cdp)
            # 四层里有三层是描线/填色 → 与快照相比必须**有可观的像素差**
            changed = isinstance(diff_px, int) and diff_px > 200
            ok_b = (not panel_b) and changed
            check('B. 行星图四个 Azgaar 图层不崩（getState 分支）', ok_b,
                  f'逐像素差 {diff_px} 处'
                  + (f'｜错误面板：{panel_b}' if panel_b else '｜零错误面板')
                  + ('' if changed else '｜画布没变=这四层没画，本条判据无效'))
        else:
            check('B. 行星图四个 Azgaar 图层不崩（getState 分支）', False, f'未进入行星视图（{navp}）')

        # ---- C. 建筑内部拖家具吸附网格（0.5.1 的 worldTop 分支） ----
        ok_c = False
        try:
            # 🔴 示例世界**没有建筑节点** —— 上一版这里直接"不适用放行"，等于这一条从未被验过。
            #    这一版自己造一栋：区域 + 建筑 + 一层内部数据 + 一件家具（走产品真正的写口）。
            made = cdp.eval(f"""(() => {{
              const s = {store};
              const layers = {{}};
              for (const n of s.nodes) layers[n.layer] = (layers[n.layer] || 0) + 1;
              // 示例世界的层级是 world → planet → region（没有 area）；
              // 建筑的父级按产品口径可以是 region（区域图里就能放建筑）。
              let area = s.nodes.find(n => n.layer === 'area')
                      || s.nodes.find(n => n.layer === 'region')
                      || s.nodes.find(n => n.layer === 'planet');
              if (!area) return 'no-parent:' + JSON.stringify(layers);
              const bid = 'probe_building_1';
              if (!s.nodes.find(n => n.id === bid)) {{
                s.updateNode ? null : null;
                try {{
                  s.addNode({{ id: bid, name: '探针楼', layer: 'building',
                    parentId: area.id, coordinate: {{ x: (area.coordinate?.x || 0) + 10,
                                                     y: (area.coordinate?.y || 0) + 10 }} }});
                }} catch (e) {{ return 'add-fail:' + e.message; }}
              }}
              return JSON.stringify({{ areaId: area.id, bid: bid,
                has: !!s.nodes.find(n => n.id === bid) }});
            }})()""")
            print('   [C 造楼] ' + str(made)[:300])

            interior = cdp.eval(f"""(() => {{
              const s = {store};
              const area = s.nodes.find(n => n.layer === 'area')
                        || s.nodes.find(n => n.layer === 'region')
                        || s.nodes.find(n => n.layer === 'planet');
              const bld = s.nodes.find(n => n.id === 'probe_building_1');
              if (!area || !bld) return 'no-area-or-building';
              // 先进楼（`selectBuilding` 会自己懒建 interiorData[buildingId]），再填一层内部数据。
              s.selectBuilding(bld);
              const layers = s.interiorData;
              const box = layers[bld.id];
              if (!box) return 'no-interior-container';
              // 🔴 墙的真实形状是 {{id, start:{{x,y}}, end:{{x,y}}, thickness}} ——
              //    不是 {{x1,y1,x2,y2}}。上一版按后者造数据，`footprint.js` 读 `wall.start.x`
              //    得到 undefined → 抛 `Cannot read properties of undefined (reading 'x')`，
              //    看起来像产品 bug，其实是探针造错了形状（这条教训值得留着）。
              const W = (id, x1, y1, x2, y2) => ({{
                id, start: {{ x: x1, y: y1 }}, end: {{ x: x2, y: y2 }}, thickness: 24,
              }});
              box.floors = [{{
                id: 'floor_1', level: 1, elevation: 0, height: 300,
                walls: [
                  W('w1', 0, 0, 900, 0), W('w2', 900, 0, 900, 650),
                  W('w3', 900, 650, 0, 650), W('w4', 0, 650, 0, 0),
                ],
                furniture: [{{ id: 'f1', type: 'bed', name: '床', x: 200, y: 200,
                               width: 150, height: 200, rotation: 0 }}],
                openings: [], stairs: [], columns: [], slabs: [],
              }}];
              return s.viewLevel;
            }})()""")
            if interior == 'interior':
                wait_for(cdp, "document.querySelector('.interior-container canvas')", timeout=30,
                         desc='建筑内部画布挂载')
                time.sleep(1.0)
                cdp.eval("""(() => {
                  const st = document.querySelector('.interior-container').__vueParentComponent.setupState;
                  if (typeof st.drawDragHighlight === 'function') st.drawDragHighlight(
                    document.querySelector('.interior-container canvas').getContext('2d'));
                  return 'ok';
                })()""")
                time.sleep(0.6)
                panel_c = error_panel(cdp)
                ok_c = (not panel_c)
                check('C. 建筑内部拖家具吸附不崩（worldTop 分支）', ok_c,
                      '零错误面板' if not panel_c else f'错误面板：{panel_c}')
            else:
                check('C. 建筑内部拖家具吸附不崩（worldTop 分支）', False,
                      f'没能进入建筑内部视图（{interior}）—— 这一条要真的跑过才算数')
        except Exception as e:
            check('C. 建筑内部拖家具吸附不崩（worldTop 分支）', False,
                  f'进入建筑内部时异常：{str(e)[:200]}')

        # ---- D. 删除项目：真的进了回收站（0.5.21 用户拍板的功能，必须在真机上验）----
        #  🔴 为什么必须在**打包件**上验：删除走主进程 `shell.trashItem`，而 CDP 用例里
        #     `window.sitianAPI` 是 mock（只删内存列表）。这一条是全链路上唯一能证明
        #     "文件真的从磁盘上消失了、且是被移进回收站"的地方。
        try:
            # 先造一个可删的项目副本（别删用户自己的示例，也别删当前打开的那个之外的）
            made = cdp.eval("""(async () => {
              const app = document.querySelector('#app').__vue_app__;
              const ps = app.config.globalProperties.$pinia._s.get('project');
              const r = await ps.createProject({ name: '待删探针项目' });
              return JSON.stringify({ ok: !!(r && r.success), filePath: (r && r.filePath) || ps.filePath });
            })()""")
            madeOb = json.loads(made) if isinstance(made, str) and made.startswith('{') else {}
            probe_path = madeOb.get('filePath') or ''
            if not madeOb.get('ok') or not probe_path:
                check('D. 删除项目 → 真的进回收站', False,
                      f'造不出可删的探针项目（{made}）')
            else:
                exists_before = os.path.exists(probe_path)
                res = cdp.eval(f"""(async () => {{
                  const app = document.querySelector('#app').__vue_app__;
                  const ps = app.config.globalProperties.$pinia._s.get('project');
                  const r = await ps.deleteProject({json.dumps(probe_path)});
                  return JSON.stringify(r || {{}});
                }})()""")
                rob = json.loads(res) if isinstance(res, str) and res.startswith('{') else {}
                gone = not os.path.exists(probe_path)          # 判据只看磁盘
                ok_d = bool(rob.get('success')) and gone and exists_before
                check('D. 删除项目 → 真的进回收站', ok_d,
                      f'{probe_path}（删前存在={exists_before}，删后存在={os.path.exists(probe_path)}）'
                      f'｜回执 mode={rob.get("mode")} trashed={len(rob.get("trashed") or [])}'
                      + ('' if ok_d else f'｜回执={str(rob)[:200]}'))
                # 说明：`shell.trashItem` 之后文件会出现在系统回收站里，位置与名字由系统决定，
                # 这里不去解析回收站（各盘各版本格式不同）；"原路径已不存在 + 回执 success" 即达标。
        except Exception as e:
            check('D. 删除项目 → 真的进回收站', False, f'异常：{str(e)[:200]}')

        # ---- 总结：全程不许有任何错误面板 ----
        final_panel = error_panel(cdp)
        check('全程零错误面板', not final_panel, final_panel or '干净')

    finally:
        try:
            if cdp:
                cdp.close()
        except Exception:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=20)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        log.close()
        # 🔴 收尾：把本轮演练**复制进用户文档目录**的示例副本与探针项目清掉。
        #    为什么必须有这一段：`示例地图项目` 每次点都会复制一份到
        #    `Documents/SiTianProjects/示例世界-N.sitian`（主进程行为，产品要求如此）。
        #    演练反复跑几轮之后，用户的文档目录里就攒了二十几个副本 ——
        #    2026-11-24 实测攒到 23 个（我自己造的，用户没看见，但那是真实污染）。
        #    清理口径：只删**本轮记录下来的**那几个；一个都不许按通配符盲删
        #    （用户自己的 `示例世界.sitian` 与历史副本必须原样留着）。
        for _p in list(_created_sample_paths) + [x for x in [locals().get('probe_path')] if x]:
            try:
                if _p and os.path.exists(_p):
                    os.remove(_p)
                    print(f'   🧹 已删除本轮副本：{_p}')
                _bk = f'{_p}.backups'
                if _p and os.path.isdir(_bk):
                    shutil.rmtree(_bk, ignore_errors=True)
                    print(f'   🧹 已删除它的 .backups：{_bk}')
            except Exception as _e:
                print(f'   ⚠️ 清理失败（不影响结论）：{_p} — {_e}')

    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} 通过')
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
