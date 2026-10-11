#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性修复脚本：给真实项目补回底图数据（高度图 / 海岸线 / 河流 / 道路 / 城镇）。

背景（2026-10-11 实测）：
  · `docs/mockups/desite.map` = 暮雨 FMG 1.151.2 的**原始导出**（seed 971546738），
    里面有高度图 9975 格 / 陆地轮廓 20 块 / 河流 160 / 道路 496 / 城镇 617；
  · 项目里的 `desite` 底图建于 2026-09-10，当时解析器还不读高度图 →
    少了高度图 / 陆地轮廓 / 河流 / 道路 / 城镇（415 块省份与归属**在**）。

做法：在**真机 Electron**里调与「刷新底图数据」按钮**同一个** store 接口
（`updateBaseMapData`，只补缺、不覆盖），然后走一次 `rebuildCoastline` 修海岸线。

安全（照 diag_t2_save.py 的模式）：
  · 跑前把真实项目与 desite.map 各复制一份到 backups/repair-<ts>/；
  · 应用**直接打开真实项目**（这样自动保存走真实路径与备份轮转），但——
  · 跑完显式调 `saveProject()` 并等到磁盘 mtime 变化才继续；
  · 无论成败都杀掉自己拉起的进程、还原 config.json；
  · 全程只调"只补缺"的接口，并逐项回报补了什么、跳过了什么。
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

# ⚠️ 本脚本在 `scripts/maint/` 下 → 需要**三层** dirname 才到仓库根。
#    中途踩过两次：先在 `scripts/` 下照抄了三层（ROOT 跑到 `E:\CODE\CangKu` → 找不到 .map），
#    改两层后又挪到 `scripts/maint/`（必须回到三层）。**改动本文件位置时先重数这一行。**
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

DEV_PORT = 5180
CDP_PORT = 9223
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
MAP_FILE = os.path.join(ROOT, 'docs', 'mockups', 'desite.map')


def log(msg=''):
    print(msg, flush=True)


def wait_http(url, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.5)
    return False


def wait_cdp(port=CDP_PORT, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/version' % port, timeout=1) as r:
                if json.loads(r.read().decode('utf-8')):
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def port_owner_pid(port):
    try:
        raw = subprocess.run(['netstat', '-ano'], capture_output=True, timeout=20).stdout
        out = raw.decode('utf-8', 'replace')
    except Exception:
        return None
    for line in out.splitlines():
        if (':%d' % port) in line and 'LISTENING' in line:
            try:
                return int(line.split()[-1])
            except Exception:
                continue
    return None


def kill_tree(pid):
    if not pid:
        return
    try:
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, timeout=25)
    except Exception:
        pass


def free_port(port, tries=3):
    for _ in range(tries):
        pid = port_owner_pid(port)
        if not pid:
            return True
        kill_tree(pid)
        time.sleep(1.2)
    return port_owner_pid(port) is None


def node_exe():
    for cand in ('node', r'C:\Users\muyu\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'):
        try:
            out = subprocess.run([cand, '-e', 'process.stdout.write(require("electron"))'],
                                 cwd=ROOT, capture_output=True, text=True, timeout=60)
            p = (out.stdout or '').strip()
            if p and os.path.exists(p):
                return cand, p
        except Exception:
            continue
    raise RuntimeError('找不到 node / electron')


def stat_of(p):
    try:
        st = os.stat(p)
        return {'size': st.st_size, 'mtime': int(st.st_mtime)}
    except Exception:
        return {'size': -1, 'mtime': 0}


def basemap_facts(path):
    """直接从磁盘上的项目文件数事实（不靠内存态）"""
    j = json.load(open(path, encoding='utf-8'))
    bms = (j.get('scenarios') or {}).get('baseMaps') or {}
    out = {}
    for k, b in bms.items():
        terr = b.get('terrain') or []
        verts = sum(len(p.get('points') or []) for p in terr)
        hm = b.get('heightmap')
        out[k] = {
            'provinces': len(terr),
            'vertices': verts,
            'heightmap_h': (len(hm.get('h') or []) if hm else 0),
            'landFeatures': (len(b.get('landFeatures') or []) if isinstance(b.get('landFeatures'), list) else 0),
            'rivers': len(b.get('rivers') or []),
            'routes': len(b.get('routes') or []),
            'burgs': len(b.get('burgs') or []),
        }
    return out


# 刷新：与「刷新底图数据」按钮同一条 store 接口
REFRESH_JS = r""" (async () => {
  const app = document.querySelector('#app').__vue_app__;
  if (!app || !app._instance) return { __err__: 'no __vue_app__._instance' };
  const pinia = app.config.globalProperties.$pinia;
  const g = (await import('/src/store/geodata.js')).useGeodataStore(pinia);
  const P = await import('/src/utils/azgaar-parser.js');
  const keys = Object.keys(g.baseMaps || {});
  if (!keys.length) return { __err__: '项目里没有底图' };
  window.confirm = () => true;
  const text = await (await fetch(__MAPURL__)).text();
  const parsed = P.parseMapFile(text);
  const bundle = {
    heightmap: parsed.heightmap,
    landFeatures: parsed.landFeatures,
    rivers: parsed.rivers,
    routes: parsed.routes,
    burgs: parsed.burgs,
    source: { file: 'desite.map', at: new Date().toISOString(), via: 'repair-script' },
  };
  const out = { keys, parsed: {
    heightmap_h: (parsed.heightmap && (parsed.heightmap.h || []).length) || 0,
    landFeatures: (parsed.landFeatures || []).length,
    rivers: (parsed.rivers || []).length,
    routes: (parsed.routes || []).length,
    burgs: (parsed.burgs || []).length,
  }, perKey: {} };
  for (const key of keys) {
    const r = await g.updateBaseMapData(key, bundle, {});
    out.perKey[key] = r && {
      ok: r.ok, changed: r.changed, added: r.added, skipped: r.skipped,
      blocked: r.blocked, message: r.message,
    };
  }
  return JSON.stringify(out);
})()"""

SAVE_JS = r""" (async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  const before = { dirty: ps.dirty, status: ps.saveStatus };
  const r = await ps.saveProject({ label: 'repair-flush' });
  return JSON.stringify({ before, result: r && { ok: r.ok, error: r.error },
    after: { dirty: ps.dirty, status: ps.saveStatus } });
})()"""

# 海岸线重建（0.2.7 的能力）：省 ∩ 新陆地
COAST_JS = r""" (async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const g = (await import('/src/store/geodata.js')).useGeodataStore(pinia);
  window.confirm = () => true;
  const keys = Object.keys(g.baseMaps || {});
  const out = {};
  for (const key of keys) {
    const r = await g.rebuildCoastlineFromBaseMap(key, {});
    out[key] = r && {
      ok: r.ok, changed: r.changed, emptied: r.emptied, drift: r.drift,
      skippedInside: r.skippedInside, rejected: r.rejected, message: r.message,
      perProvince: (r.perProvince || []).slice(0, 8),
    };
  }
  return JSON.stringify(out);
})()"""


def ck(label, cond, extra=None):
    log(('  [OK]   ' if cond else '  [FAIL] ') + label + ('' if extra is None else '  ' + str(extra)))
    return bool(cond)


def main():
    if not os.path.exists(APP_CFG):
        log('找不到应用配置：%s' % APP_CFG)
        return 2
    if not os.path.exists(MAP_FILE):
        log('找不到原始导出：%s' % MAP_FILE)
        return 2

    cfg_orig_text = open(APP_CFG, encoding='utf-8').read()
    cfg = json.loads(cfg_orig_text)
    real_proj = cfg.get('lastProjectPath', '')
    if not real_proj or not os.path.exists(real_proj):
        log('配置里的 lastProjectPath 不存在：%r' % real_proj)
        return 2

    ts = time.strftime('%Y%m%d-%H%M%S')
    bak = os.path.join(ROOT, 'backups', 'repair-basemap-' + ts)
    os.makedirs(bak, exist_ok=True)
    proj_backup = os.path.join(bak, os.path.basename(real_proj))
    map_backup = os.path.join(bak, 'desite.map')
    shutil.copy2(real_proj, proj_backup)
    shutil.copy2(MAP_FILE, map_backup)
    shutil.copy2(APP_CFG, os.path.join(bak, 'config.json'))

    log('=== 底图数据修复 ===')
    log('真实项目  ：%s' % real_proj)
    log('原始导出  ：%s' % MAP_FILE)
    log('备份目录  ：%s' % bak)
    log('  · 项目备份 %s (%d 字节)' % (os.path.basename(proj_backup), os.path.getsize(proj_backup)))
    log('  · 底图备份 desite.map (%d 字节)' % os.path.getsize(map_backup))
    log('')
    log('-- 修复前（直接读磁盘） --')
    before = basemap_facts(real_proj)
    for k, v in before.items():
        log('  [%s] %s' % (k, json.dumps(v, ensure_ascii=False)))
    f0 = stat_of(real_proj)

    dev = el = None
    ok_all = True
    try:
        node, exe = node_exe()
        free_port(DEV_PORT)
        devlog = open(os.path.join(bak, 'vite-dev.log'), 'a', encoding='utf-8')
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=devlog, stderr=devlog)
        if not wait_http('http://localhost:%d/' % DEV_PORT, timeout=90):
            log('vite dev server 未就绪（见 %s/vite-dev.log）' % bak)
            return 1
        log('vite dev server 就绪：http://localhost:%d' % DEV_PORT)

        free_port(CDP_PORT)
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        applog = open(os.path.join(bak, 'electron-dev.log'), 'a', encoding='utf-8')
        el = subprocess.Popen(
            [exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
             '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
             '--remote-allow-origins=*'],
            cwd=ROOT, env=env, stdout=applog, stderr=applog)
        if not wait_cdp(CDP_PORT, timeout=90):
            log('CDP 未就绪（见 %s/electron-dev.log）' % bak)
            return 1

        from lib.cdp import CDP, wait_for, eval_json
        cdp = CDP(port=CDP_PORT)
        try:
            wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='应用挂载')
            wait_for(cdp, "(async () => { try { const a = document.querySelector('#app').__vue_app__;"
                          " return !!(a && a._instance); } catch (e) { return false; } })()",
                     timeout=60, desc='__vue_app__._instance 可用')
            log('应用已挂载')
            # 等真实项目装载完（底图出现在 store 里）
            wait_for(cdp, "(async () => { const a = document.querySelector('#app').__vue_app__;"
                          " const g = (await import('/src/store/geodata.js'))"
                          ".useGeodataStore(a.config.globalProperties.$pinia);"
                          " return Object.keys(g.baseMaps || {}).length > 0; })()",
                     timeout=120, desc='真实项目与底图装载完成')
            log('项目与底图已装载')
            log('')

            log('-- ① 刷新底图数据（只补缺：高度图/海岸线/河流/道路/城镇） --')
            url = '/@fs/' + MAP_FILE.replace('\\', '/')
            okr, r = eval_json(cdp, REFRESH_JS.replace('__MAPURL__', json.dumps(url)), required=None, desc='刷新底图数据')
            if not okr:
                log('  探针异常：%s' % r)
                return 1
            log('  解析到的原始数据：%s' % json.dumps(r.get('parsed', {}), ensure_ascii=False))
            for k, v in (r.get('perKey') or {}).items():
                log('  [%s]' % k)
                log('     ok=%s changed=%s' % (v.get('ok'), v.get('changed')))
                log('     added=%s' % json.dumps(v.get('added'), ensure_ascii=False))
                log('     skipped=%s' % json.dumps(v.get('skipped'), ensure_ascii=False))
                if v.get('blocked'):
                    log('     blocked=%s' % json.dumps(v.get('blocked'), ensure_ascii=False))
                log('     message=%s' % v.get('message'))
                if not v.get('ok'):
                    ok_all = False
                if v.get('added', {}).get('heightmap') is not True:
                    log('     ⚠️ 高度图没被补上 —— 看上面 blocked/message')

            log('')
            log('-- ② 按新海岸线重建省份外环 --')
            okc, c = eval_json(cdp, COAST_JS, required=None, desc='重建海岸线')
            if not okc:
                log('  探针异常：%s' % c)
                c = {}
            for k, v in (c or {}).items():
                log('  [%s] ok=%s changed=%s emptied=%s drift=%s skippedInside=%s'
                    % (k, v.get('ok'), v.get('changed'), v.get('emptied'),
                       (round(v.get('drift'), 5) if isinstance(v.get('drift'), (int, float)) else v.get('drift')),
                       v.get('skippedInside')))
                log('     message=%s' % v.get('message'))
                if v.get('rejected'):
                    log('     ⚠️ 被拒：%s' % v.get('rejected'))

            log('')
            log('-- ③ 显式落盘 --')
            oks, sv = eval_json(cdp, SAVE_JS, required=None, desc='显式保存')
            log('  %s' % json.dumps(sv, ensure_ascii=False))

            log('')
            log('-- ④ 在应用内确认列表格 --')
            okm, mem = eval_json(cdp, (
                "(async () => { const a = document.querySelector('#app').__vue_app__;"
                " const g = (await import('/src/store/geodata.js'))"
                ".useGeodataStore(a.config.globalProperties.$pinia);"
                " const o = {}; for (const k of Object.keys(g.baseMaps||{})) { const b = g.baseMaps[k];"
                " o[k] = { terrain: (b.terrain||[]).length,"
                " heightmap: b.heightmap ? (b.heightmap.h||[]).length : 0,"
                " landFeatures: (b.landFeatures||[]).length, rivers: (b.rivers||[]).length,"
                " routes: (b.routes||[]).length, burgs: (b.burgs||[]).length }; } return JSON.stringify(o); })()"
            ), required=None, desc='应用内确认')
            log('  %s' % json.dumps(mem, ensure_ascii=False))
        finally:
            try:
                cdp.close()
            except Exception:
                pass

        # ⑤ 等磁盘真的变了（自动保存 800ms 防抖 + 显式保存已 await 过）
        for _ in range(25):
            if stat_of(real_proj)['mtime'] != f0['mtime']:
                break
            time.sleep(0.4)
        f1 = stat_of(real_proj)
        log('')
        log('-- ⑤ 磁盘核对 --')
        ok_all &= ck('项目文件已被写入（mtime 变化）', f1['mtime'] != f0['mtime'],
                     'mtime %d -> %d, size %d -> %d' % (f0['mtime'], f1['mtime'], f0['size'], f1['size']))

        log('')
        log('-- 修复后（直接读磁盘） --')
        after = basemap_facts(real_proj)
        for k, v in after.items():
            log('  [%s] %s' % (k, json.dumps(v, ensure_ascii=False)))
        for k in set(list(before.keys()) + list(after.keys())):
            b, a = before.get(k, {}), after.get(k, {})
            log('  [%s] 省份 %s → %s ；高度图 %s → %s ；海岸线 %s → %s ；河 %s → %s ；路 %s → %s ；镇 %s → %s'
                % (k, b.get('provinces'), a.get('provinces'),
                   b.get('heightmap_h'), a.get('heightmap_h'),
                   b.get('landFeatures'), a.get('landFeatures'),
                   b.get('rivers'), a.get('rivers'),
                   b.get('routes'), a.get('routes'),
                   b.get('burgs'), a.get('burgs')))
            ok_all &= ck('[%s] 省份数量没变（只补数据、不动省份）' % k,
                         b.get('provinces') == a.get('provinces'),
                         '%s -> %s' % (b.get('provinces'), a.get('provinces')))
            ok_all &= ck('[%s] 高度图补上了' % k, a.get('heightmap_h', 0) > 0,
                         a.get('heightmap_h'))
        return 0 if ok_all else 1
    finally:
        try:
            kill_tree(port_owner_pid(CDP_PORT))
        except Exception:
            pass
        try:
            if dev:
                kill_tree(dev.pid)
        except Exception:
            pass
        time.sleep(1.0)
        free_port(CDP_PORT)
        free_port(DEV_PORT)
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            f.write(cfg_orig_text)
        log('')
        log('已还原 config.json；证据与备份留在 %s' % bak)
        log('真实项目末态：%s' % json.dumps(stat_of(real_proj)))


if __name__ == '__main__':
    sys.exit(main())
