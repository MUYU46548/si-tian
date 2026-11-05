#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""示例世界生成器（发布门槛②，2026-11-05）

为什么用“真机驱动”而不是另写一个 Node 生成器：造陆 / 铺底 / 地形推演 / 河网 / 湖泊 /
地形注记 全在渲染层的 store 里（已经过 163 用例与真机演练），在 Node 里重写一份就是
**同一能力两份实现**——迟早漂移。这里起真实 Electron，点同样的 store 入口，再存盘。

产物：`sample/示例世界.sitian`（入库；随安装包发布）。
用法：python scripts/tests/tools/make_sample_world.py [--provinces 72] [--seed 20261105]
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.abspath(os.path.join(HERE, '..'))
sys.path.insert(0, TESTS)

from lib.cdp import CDP, wait_for                      # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT = os.path.abspath(os.path.join(TESTS, '..', '..'))
DEV_PORT = 5180
CDP_PORT = 9224
OUT_DIR = os.path.join(ROOT, 'sample')


def port_open(port):
    import socket
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_port(port, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.3)
    return False


def wait_http(url, timeout=90):
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def node_and_electron():
    node = 'node'
    out = subprocess.run([node, '-e', 'process.stdout.write(require("electron"))'],
                         cwd=ROOT, capture_output=True, text=True, timeout=60)
    exe = (out.stdout or '').strip()
    if not (exe and os.path.exists(exe)):
        raise RuntimeError('找不到 electron')
    return node, exe


# projectStore 是懒创建的：`pinia._s.get('project')` 在没打开过项目面板时是 undefined。
# harness 的写法是动态 import 模块 + `useProjectStore(pinia)`（见 lib/helpers.py 的 OPEN_HARNESS_JS），
# 这里照抄 —— 同一个入口，不另造钩子。
BOOT = """(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  window.__SAMPLE__ = {
    ps: useProjectStore(pinia),
    st: app._instance.setupState.store,
    KEY: 'sample_land',
  };
  return JSON.stringify({ ok: true, hasPs: !!window.__SAMPLE__.ps, hasSt: !!window.__SAMPLE__.st });
})()"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--provinces', type=int, default=72)
    ap.add_argument('--seed', type=int, default=20261105)
    ap.add_argument('--out', default='示例世界.sitian')
    args = ap.parse_args()

    for p in (DEV_PORT, CDP_PORT):
        if port_open(p):
            print('端口 %d 被占用 —— 先停掉正在跑的回归/演练' % p)
            return 2
    os.makedirs(OUT_DIR, exist_ok=True)
    target = os.path.join(OUT_DIR, args.out)
    # 旧示例先清掉：createProject 遇到同名会加 `-2` 后缀，残留文件会让“到底哪份是示例”失焦
    for old in os.listdir(OUT_DIR):
        if old.endswith('.sitian') or old.endswith('.sitian.backups'):
            full = os.path.join(OUT_DIR, old)
            try:
                shutil.rmtree(full) if os.path.isdir(full) else os.remove(full)
            except Exception:
                pass
    node, exe = node_and_electron()
    dev = el = None
    try:
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'], cwd=ROOT,
                               stdout=open(os.path.join(OUT_DIR, 'gen-vite.log'), 'a', encoding='utf-8'),
                               stderr=subprocess.STDOUT)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('vite 未就绪')
            return 1
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('ELECTRON_RUN_AS_NODE', None)
        # 🔴 用**干净 user-data-dir**：否则应用启动会恢复“上次的项目”（真实世界），
        #    新项目落盘时会把它的底图/剧本一起写进去（本轮实测：示例里混进 13 段真实剧本）。
        profile = os.path.join(ROOT, 'build', '.sample-profile')
        shutil.rmtree(profile, ignore_errors=True)
        # 🔴 开关必须在 app 路径（'.'）**之前**：放在后面会被当成 App 参数丢掉，
        #    隔离 profile 不生效 → 应用恢复上次项目 → 新文件里混进它的底图与剧本（本轮真踩）。
        el = subprocess.Popen([exe, '--user-data-dir=%s' % profile,
                               '--remote-debugging-port=%d' % CDP_PORT,
                               '--disable-gpu', '--remote-allow-origins=*', '.'],
                              cwd=ROOT, env=env,
                              stdout=open(os.path.join(OUT_DIR, 'gen-electron.log'), 'a', encoding='utf-8'),
                              stderr=subprocess.STDOUT)
        if not wait_port(CDP_PORT):
            print('Electron CDP 未就绪')
            return 1
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='应用挂载')
        print('应用已挂载')

        boot = cdp.eval(BOOT)
        print('store:', boot)

        # 1) 新建项目到 sample/
        res = cdp.eval("""(async () => {
          const r = await window.__SAMPLE__.ps.createProject({ name: '示例世界',
            dir: %s });
          return JSON.stringify(r);
        })()""" % json.dumps(OUT_DIR))
        print('createProject:', res)
        info = json.loads(res) if isinstance(res, str) else res
        if not (info and info.get('success', info.get('ok'))):
            print('新建项目失败')
            return 1
        file_path = info.get('filePath') or target
        opened = cdp.eval("""(async () => {
          const r = await window.__SAMPLE__.ps.openProject(%s);
          return JSON.stringify(r);
        })()""" % json.dumps(file_path))
        print('openProject:', opened)

        # 2) 造陆 + 铺底 + 地形 —— **先发起、再轮询**（CDP 单次读 15s，整段要 10~30s）
        started = cdp.eval("""(() => {
          const S = window.__SAMPLE__;
          window.__GEN__ = { state: 'running' };
          (async () => {
            try {
              S.st.addBaseMap(S.KEY, { name: '示例大陆' });
              const lm = await S.st.generateLandmass(S.KEY,
                { seed: %d, landRatio: 0.34, shape: 'continent', provinceCount: %d }, { force: true });
              const terr = S.st.synthesizeBaseMapTerrain(S.KEY, { seed: %d, force: true });
              window.__GEN__ = {
                state: 'done',
                lm: lm && { ok: lm.ok },
                terr: terr && { ok: terr.ok, cells: terr.cellCount },
                terrain: (S.st.baseMaps[S.KEY].terrain || []).length,
                rivers: (S.st.baseMaps[S.KEY].rivers || []).length,
              };
            } catch (e) {
              window.__GEN__ = { state: 'error', msg: String(e && e.message || e) };
            }
          })();
          return 'started';
        })()""" % (args.seed, args.provinces, args.seed))
        print('生成已发起:', started)
        gen = None
        t0 = time.time()
        while time.time() - t0 < 180:
            time.sleep(1.0)
            gen = cdp.eval('JSON.stringify(window.__GEN__ || {state:"missing"})')
            state = (gen or {}).get('state') if isinstance(gen, dict) else None
            if state in ('done', 'error'):
                break
        print('生成:', gen)
        gj = json.loads(gen) if isinstance(gen, str) else gen
        if not (gj and gj.get('state') == 'done' and gj.get('terrain')):
            print('造陆失败或超时')
            return 1

        # 3) 两段剧本（4 势力 / 第二段有易主）
        sc = cdp.eval("""(() => {
          const S = window.__SAMPLE__;
          const provs = (S.st.baseMaps[S.KEY].terrain || []).map((p) => p.id);
          const names = ['甲国', '乙国', '丙国', '丁国'];
          const colors = ['#c23b3b', '#3b6fc2', '#4aa06a', '#b08a3e'];
          const polities = names.map((n, i) => ({ id: 'P' + (i + 1), name: n, color: colors[i] }));
          const own1 = {}, own2 = {};
          provs.forEach((id, i) => {
            own1[id] = polities[i % 4].id;
            own2[id] = (i % 11 === 0) ? polities[(i + 2) % 4].id : own1[id];
          });
          S.st.createScenario(S.KEY + '/示例时代一', {
            ownerKey: S.KEY, name: '示例时代一', order: 1,
            era: { roman: 'I', label: '初', startYear: '100', endYear: '300' },
            polities, ownership: own1,
            labels: [{ text: '示例海', x: 320, y: 210 }],
          });
          S.st.createScenario(S.KEY + '/示例时代二', {
            ownerKey: S.KEY, name: '示例时代二', order: 2,
            era: { roman: 'II', label: '变', startYear: '300', endYear: '500' },
            polities, ownership: own2,
          });
          return JSON.stringify({ ok: true, provinces: provs.length,
            scenarios: Object.keys(S.st.scenarios || {}).length });
        })()""")
        print('剧本:', sc)

        # 4) 存盘
        saved = cdp.eval("""(async () => {
          const r = await window.__SAMPLE__.ps.saveProject({ label: '示例世界生成' });
          return JSON.stringify(r);
        })()""")
        print('保存:', saved)

        # 5) 进剧本视图、选中示例底图、适屏，再截一张图供人眼复核
        try:
            cdp.eval("""(() => {
              const b = Array.from(document.querySelectorAll('button'))
                .find((x) => (x.textContent || '').includes('历史剧本'));
              if (b) b.click();
              return 'clicked';
            })()""")
            time.sleep(1.5)
            cdp.eval("""(() => {
              const S = window.__SAMPLE__;
              const el = document.querySelector('.scenario-map-container');
              const sm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
              if (!sm) return 'no-scenario-map';
              sm.baseMapKey = S.KEY;
              if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
              if (typeof sm.fitToView === 'function') sm.fitToView();
              if (typeof sm.render === 'function') sm.render();
              return JSON.stringify({ ok: true, baseMapKey: sm.baseMapKey });
            })()""")
            time.sleep(1.5)
            # 隔离 profile = 首启 → 引导层会挡住整张图；截图前先点「跳过」
            cdp.eval("""(() => {
              const b = Array.from(document.querySelectorAll('button'))
                .find((x) => (x.textContent || '').trim() === '跳过');
              if (b) { b.click(); return 'skipped'; }
              return 'no-onboarding';
            })()""")
            time.sleep(1.2)
        except Exception as e:
            print('切视图失败（不影响产物）:', e)
        try:
            shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
            data = (shot.get('result') or {}).get('data') or (shot.get('data') if isinstance(shot, dict) else '')
            if data:
                with open(os.path.join(OUT_DIR, '示例世界-预览.png'), 'wb') as f:
                    f.write(base64.b64decode(data))
                print('预览图：sample/示例世界-预览.png')
        except Exception as e:
            print('截图失败（不影响产物）:', e)

        if os.path.exists(file_path):
            print('项目文件：%s（%.1f KB）' % (file_path, os.path.getsize(file_path) / 1024))
            # 🔴 污染检查：示例里只许有 sample_land；出现别的底图/剧本 = 又吃到了别的项目
            try:
                import json as _json
                with open(file_path, encoding='utf-8') as f:
                    proj = _json.load(f)
                bags = list(((proj.get('scenarios') or {}).get('baseMaps') or {}).keys())
                scs = list(((proj.get('scenarios') or {}).get('scenarios') or {}).keys())
                foreign = [b for b in bags if b != 'sample_land'] + [s for s in scs if not s.startswith('sample_land/')]
                if foreign:
                    print('🔴 示例被污染（混进别的项目的数据）：%r' % foreign[:6])
                    return 1
                print('干净：baseMaps=%r / scenarios=%d' % (bags, len(scs)))
            except Exception as e:
                print('污染检查失败：', e)
                return 1
            print('PROVINCES=%d' % gj.get('terrain', 0))
            return 0
        print('没有生成项目文件')
        return 1
    finally:
        for p in (el, dev):
            try:
                if p and p.poll() is None:
                    p.terminate()
            except Exception:
                pass
        time.sleep(1.0)


if __name__ == '__main__':
    sys.exit(main())
