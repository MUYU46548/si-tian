#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""019 底图重导 · **真机演练**（2026-10-25）

为什么需要它（而不是再加一条 CDP 用例）：
  `test_150` 守的是 019 的语义（冲突阻止 / 新底图 + 归属迁移 / 一条 undo），但它跑在
  **mock IPC + 两三个省的合成夹具**上 —— 到不了「真实 Electron → 真实 6.3MB 项目文件 →
  真实 800ms 防抖 → 真实磁盘」这条链，也没在 **415 省 / 13 段剧本** 这个规模上跑过。
  019 最贵的失效不是"报错"，是**半途写盘**：归属迁了一半、旧底图已被归档。

本演练用**真实 Electron（dev 构建，能读 store）+ 真实项目副本**，两个阶段：

  A. **原样重导真实 `__real_desite.map`**（415 省细分图 → 原始 200 省）
     → 期望：预检报「89 处并省冲突」，`reimportBasemapAsNew` **拒绝**，磁盘 sha256 **一个字节不变**。
     （这一阶段证明：真实数据下 019 不会替用户选，也不会写一半。）

  B. **id 直配**（同一批省、同 id 重导出，故意少 12 省）
     → 期望：预检零冲突 → 真的落盘（新 key、旧底图 archived、13 段剧本 ownerKey 迁移、
       未映射 12 省进 dropped 清单）→ 一次 Ctrl+Z **磁盘回到基线**。

判据一律**读磁盘**（项目文件 JSON），不看内存 —— 内存里"已经改了"说明不了落盘。

⚠️ 只在没有真实任务在跑时用（会开真实窗口 + Vite dev server 5180）。
⚠️ 全程操作**项目副本**；跑前备份配置，跑后还原配置、删副本、杀自己拉起的进程。

用法：
  python scripts/tests/drill_reimport_019.py
  python scripts/tests/drill_reimport_019.py --project "C:/Users/.../绒花计划.sitian"
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
from lib.cdp import CDP, eval_json, wait_for      # noqa: E402

CDP_PORT = 9224
VITE_PORT = 5180
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
DEFAULT_PROJECT = os.path.join(os.path.expanduser('~'), 'Documents', 'SiTianProjects', '绒花计划.sitian')
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

R = []


def ck(phase, name, ok, detail=''):
    R.append((phase, name, bool(ok), detail))
    print('  %s [%s] %s%s' % ('✅' if ok else '❌', phase, name, ('  — ' + str(detail)) if detail else ''))


# ---------------------------------------------------------------- 基础设施
def electron_exe():
    out = subprocess.run(['node', '-e', 'process.stdout.write(require("electron"))'],
                         cwd=ROOT, capture_output=True, text=True)
    p = (out.stdout or '').strip()
    if not p or not os.path.exists(p):
        raise RuntimeError('找不到 electron 可执行文件：%r' % p)
    return p


def port_open(port, timeout=1.0):
    # 🔴 Vite 在 Windows 上会绑到 [::1]（日志里也是 http://localhost:5180/）——
    #    只连 127.0.0.1 会永远"没就绪"，然后在异常里把 Vite 留在后台。
    for host in ('127.0.0.1', '::1'):
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            continue
    return False


def wait_port(port, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.4)
    return False


def wait_cdp(port, timeout=45):
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
    try:
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, timeout=20)
    except Exception:
        pass


def sha(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def read_project(proj):
    try:
        with open(proj, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def scenarios_of(doc):
    sc = doc.get('scenarios') or {}
    return (sc.get('baseMaps') or {}), (sc.get('scenarios') or {})


def wait_disk(proj, pred, timeout=25.0, interval=0.4):
    end = time.time() + timeout
    doc = {}
    while time.time() < end:
        doc = read_project(proj)
        try:
            if pred(doc):
                return True, doc
        except Exception:
            pass
        time.sleep(interval)
    return False, doc


def ctrl_z(cdp):
    for t in ('rawKeyDown', 'keyUp'):
        cdp.send('Input.dispatchKeyEvent', {
            'type': t, 'modifiers': 2, 'key': 'z', 'code': 'KeyZ',
            'windowsVirtualKeyCode': 90, 'nativeVirtualKeyCode': 90,
        })


class DevApp:
    """起 Vite(5180) + 真实 Electron（NODE_ENV=development，因此能读 store）。"""

    def __init__(self, project_path):
        self.project = project_path
        self.vite = None
        self.proc = None
        self.cdp = None

    def __enter__(self):
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        log = open(os.path.join(ROOT, 'backups', 'reimport-019-drill.log'), 'a', encoding='utf-8')
        self._log = log
        if not port_open(VITE_PORT):
            self.vite = subprocess.Popen(
                ['npm.cmd', 'run', 'dev'], cwd=ROOT, env=env, stdout=log, stderr=log,
                creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
            )
            if not wait_port(VITE_PORT, 90):
                # 不把 Vite 留在后台（否则下一轮 5180 被占，演练会莫名其妙连上旧实例）
                kill_tree(self.vite.pid)
                self.vite = None
                raise RuntimeError('Vite 5180 未就绪（见 backups/reimport-019-drill.log）')
        exe = electron_exe()
        if port_open(CDP_PORT):
            pid = port_owner_pid(CDP_PORT)
            if pid:
                kill_tree(pid)
            time.sleep(1.2)
        self.proc = subprocess.Popen(
            [exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
             '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
             '--remote-allow-origins=*'],
            cwd=ROOT, env=env, stdout=log, stderr=log,
        )
        if not wait_cdp(CDP_PORT):
            raise RuntimeError('CDP 端口未就绪（见 backups/reimport-019-drill.log）')
        self.cdp = CDP(port=CDP_PORT)
        wait_for(self.cdp, "!!document.querySelector('.app-layout')", timeout=60, desc='应用挂载')
        # 项目自动恢复（config.lastProjectPath）—— 判据：store 里有底图
        probe = ("(() => { try { const s = " + STORE + ";"
                 " return !!(s && s.baseMaps && Object.keys(s.baseMaps).length); } catch (e) { return false; } })()")
        wait_for(self.cdp, probe, timeout=60, desc='项目已恢复（store.baseMaps 非空）')
        return self

    def eval(self, js, desc='', timeout=None):
        r = eval_json(self.cdp, js, required=None, desc=desc)
        if isinstance(r, tuple) and r[0]:
            return r[1]
        return {'__err__': r}

    def __exit__(self, *a):
        try:
            if self.cdp:
                self.cdp.close()
        except Exception:
            pass
        for pid in {port_owner_pid(CDP_PORT), getattr(self.proc, 'pid', None)}:
            if pid:
                kill_tree(pid)
        if self.vite is not None and self.vite.poll() is None:
            kill_tree(self.vite.pid)
        time.sleep(0.8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', default=DEFAULT_PROJECT)
    ap.add_argument('--keep-copy', action='store_true')
    args = ap.parse_args()

    src = os.path.abspath(args.project)
    if not os.path.exists(src):
        print('项目不存在：%s' % src)
        return 2
    stamp = time.strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join(ROOT, 'backups', 'reimport-019-%s' % stamp)
    os.makedirs(bdir, exist_ok=True)
    copy = os.path.join(os.path.dirname(src), '__019_drill_%s.sitian' % stamp)
    shutil.copy2(src, copy)
    cfg_bak = os.path.join(bdir, 'config.json')
    cfg_existed = os.path.exists(APP_CFG)
    if cfg_existed:
        shutil.copy2(APP_CFG, cfg_bak)
    print('项目副本：%s' % copy)
    print('配置备份：%s' % (cfg_bak if cfg_existed else '(无配置文件)'))

    baseline_sha = sha(copy)
    base_doc = read_project(copy)
    bms, scens = scenarios_of(base_doc)
    old_key = max(bms, key=lambda k: len((bms[k].get('terrain') or [])))
    old_n = len(bms[old_key].get('terrain') or [])
    moved_ids = sorted([k for k, s in scens.items() if s.get('ownerKey') == old_key])
    base_own = {k: len((scens[k].get('ownership') or {})) for k in scens}
    print('旧底图 %s：%d 省 / 剧本 %d 段（ownerKey 命中 %d）' % (old_key, old_n, len(scens), len(moved_ids)))

    # 写配置：让应用自动恢复这份副本
    cfg = {}
    if cfg_existed:
        try:
            cfg = json.load(open(APP_CFG, encoding='utf-8'))
        except Exception:
            cfg = {}
    cfg['lastProjectPath'] = copy
    os.makedirs(os.path.dirname(APP_CFG), exist_ok=True)
    with open(APP_CFG, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

    ok_all = True
    try:
        with DevApp(copy) as app:
            cdp = app.cdp
            # 再确认一次：真实 store 里就是这份副本、就是 415 省
            info = app.eval("""(() => { const s = %s;
              const k = Object.keys(s.baseMaps).sort((a,b) => (s.baseMaps[b].terrain||[]).length - (s.baseMaps[a].terrain||[]).length)[0];
              return JSON.stringify({ keys: Object.keys(s.baseMaps), k, n: (s.baseMaps[k].terrain||[]).length,
                scen: Object.keys(s.scenarios||{}).length,
                path: (window.sitianAPI && window.sitianAPI.projectCurrentPath) ? 'has-api' : 'no-api' }); })()""" % STORE,
                            '读取真实 store')
            if info.get('__err__'):
                print('读取 store 失败：%s' % info)
                return 1
            print('真实 store：底图 %s / %d 省 / 剧本 %d 段' % (info.get('k'), info.get('n'), info.get('scen')))
            ck('p0', '真实应用里打开的就是这份副本（415 省 / 13 段剧本）',
               info.get('n') == old_n and info.get('scen') == len(scens), '%s 省 / %s 段' % (info.get('n'), info.get('scen')))

            # 记录"应用起来之后"的磁盘基线（启动可能改写 updatedAt）
            time.sleep(1.6)
            base_sha2 = sha(copy)

            # ── A：原样重导真实 .map → 必须被 89 处并省冲突阻止，且零写盘 ──────────
            pre = app.eval("""(async () => {
              const A = await import('/src/utils/azgaar-parser.js');
              const text = await (await fetch('/__real_desite.map')).text();
              const parsed = A.parseMapFile(text);
              const json = A.buildScenariosJson(parsed, 'real-desite', '当前');
              const b = json.baseMaps['real-desite'];
              window.__019_bundle = b;
              const s = %s;
              const p = s.previewReimportBasemap(%s, b);
              const r = s.reimportBasemapAsNew(%s, b, {});
              return JSON.stringify({ ok: !!p.ok, conflicts: (p.conflicts||[]).length,
                canApply: !!p.canApply, totalOld: p.totalOld, totalNew: p.totalNew,
                rejected: r.rejected || null, rOk: !!r.ok, keys: Object.keys(s.baseMaps).length,
                cells: (parsed.stats||{}).cells || 0 });
            })()""" % (STORE, json.dumps(old_key), json.dumps(old_key)), '原样重导（应被阻止）')
            if pre.get('__err__'):
                print('原样重导探针失败：%s' % pre)
                return 1
            ck('A', '预检：真实 .map 的省份比 415 省细分图少 → 报并省冲突',
               pre.get('conflicts', 0) > 0 and pre.get('canApply') is False,
               '冲突 %s / 旧 %s → 新 %s' % (pre.get('conflicts'), pre.get('totalOld'), pre.get('totalNew')))
            ck('A', '重导被拒绝（merge-conflicts），底图数量不变',
               pre.get('rOk') is False and pre.get('rejected') == 'merge-conflicts',
               'rejected=%s / baseMaps=%s' % (pre.get('rejected'), pre.get('keys')))
            time.sleep(1.8)   # 超过 300ms + 800ms 两层防抖
            ck('A', '磁盘 sha256 一个字节没变（阻止 = 真没写）', sha(copy) == base_sha2,
               '%s…' % sha(copy)[:12])

            # ── B：id 直配（同 id 重导出、少 12 省）→ 真落盘 → Ctrl+Z 回基线 ────────
            plan = app.eval("""(() => {
              const s = %s;
              const k = %s;
              const b = window.__019_bundle;
              const oldTerrain = s.baseMaps[k].terrain || [];
              const b2 = { ...b, terrain: oldTerrain.slice(12).map(p => ({ ...p })) };
              const p = s.previewReimportBasemap(k, b2);
              // 期望归属条数：每个旧省按其目标新省数复制
              const byOld = {}; (p && p.ok) ? null : null;
              return JSON.stringify({ ok: !!p.ok, exact: p.exact, conflicts: (p.conflicts||[]).length,
                canApply: !!p.canApply, unmappedOld: (p.unmappedOld||[]).length,
                oldN: oldTerrain.length, newN: b2.terrain.length,
                scen: Object.keys(s.scenarios||{}).filter(x => s.scenarios[x].ownerKey === k).length });
            })()""" % (STORE, json.dumps(old_key)), 'id 直配预检')
            if plan.get('__err__'):
                print('id 直配预检失败：%s' % plan)
                return 1
            ck('B', 'id 直配预检：403 省 1:1、零冲突、12 省未映射',
               plan.get('exact') == old_n - 12 and plan.get('conflicts') == 0 and plan.get('canApply') is True
               and plan.get('unmappedOld') == 12,
               'exact=%s / conflicts=%s / canApply=%s / unmappedOld=%s' % (
                   plan.get('exact'), plan.get('conflicts'), plan.get('canApply'), plan.get('unmappedOld')))

            applied = app.eval("""(() => {
              const s = %s; const k = %s;
              const b2 = { ...window.__019_bundle, terrain: s.baseMaps[k].terrain.slice(12).map(p => ({ ...p })) };
              const r = s.reimportBasemapAsNew(k, b2, {});
              if (!r || !r.ok) return JSON.stringify({ ok: false, msg: (r && r.message) || null, rejected: r && r.rejected });
              window.__019_newKey = r.newKey;
              return JSON.stringify({ ok: true, newKey: r.newKey, moved: r.movedScenarios,
                dropped: (r.droppedOldProvinces||[]).length,
                oldN: r.totalOld, newN: r.totalNew,
                ownKeys: Object.keys(s.baseMaps[r.newKey].terrain||[]).length,
                ownerKeys: Object.values(s.scenarios||{}).map(x => x.ownerKey).filter(x => x === r.newKey).length });
            })()""" % (STORE, json.dumps(old_key)), 'id 直配重导（应用）')
            if applied.get('__err__') or not applied.get('ok'):
                print('重导应用失败：%s' % applied)
                ok_all = False
                return 1
            new_key = applied.get('newKey')

            # 磁盘判据
            def disk_applied(doc):
                bms2, scens2 = scenarios_of(doc)
                if new_key not in bms2 or not (bms2.get(old_key) or {}).get('archived'):
                    return False
                if len(bms2[new_key].get('terrain') or []) != old_n - 12:
                    return False
                if any((s or {}).get('ownerKey') == old_key for s in scens2.values()):
                    return False
                if sum(1 for s in scens2.values() if (s or {}).get('ownerKey') == new_key) != len(moved_ids):
                    return False
                return True

            okd, doc = wait_disk(copy, disk_applied, timeout=30)
            bms2, scens2 = scenarios_of(doc)
            ck('B', '新底图 / 旧底图归档 / 剧本 ownerKey 迁移 全部落进磁盘', okd,
               'newKey=%s / 底图数 %s / 剧本 %s' % (new_key, len(bms2), len(scens2)))
            ck('B', '剧本 id 一个没变（外部引用不断）',
               set(scens2.keys()) == set(scens.keys()) and
               all(scens2[k].get('id') == scens[k].get('id') for k in scens if k in scens2),
               '%d 段' % len(scens2))
            ck('B', '归属键全部落在新底图省 id 上',
               all(k in {p.get('id') for p in (bms2[new_key].get('terrain') or [])}
                   for s in scens2.values() for k in ((s or {}).get('ownership') or {})),
               '新省 %d 个' % len(bms2[new_key].get('terrain') or []))
            ck('B', '旧归属没有整片消失（丢了 12 省的键，其余都在）',
               sum(len((s or {}).get('ownership') or {}) for s in scens2.values())
               >= sum(base_own[k] for k in base_own) - 13 * 12,
               '旧 %s → 新 %s' % (sum(base_own.values()),
                                 sum(len((s or {}).get('ownership') or {}) for s in scens2.values())))

            # 一条 Ctrl+Z 回基线
            ctrl_z(cdp)
            def disk_rolled_back(doc):
                bms3, scens3 = scenarios_of(doc)
                if new_key in bms3:
                    return False
                if (bms3.get(old_key) or {}).get('archived'):
                    return False
                if any((s or {}).get('ownerKey') == new_key for s in scens3.values()):
                    return False
                return all((s or {}).get('ownerKey') in (None, old_key, '底图 1') for s in scens3.values())

            okr, _ = wait_disk(copy, disk_rolled_back, timeout=30)
            ck('B', '一次 Ctrl+Z：磁盘回到基线（新底图消失、旧底图取消归档、ownerKey 复原）', okr, '')

            # 收尾：不给下次演练留隐患
            app.eval("(() => { try { delete window.__019_bundle; delete window.__019_newKey; } catch (e) {} return 'ok'; })()", '清临时全局')
    finally:
        if cfg_existed:
            shutil.copy2(cfg_bak, APP_CFG)
        else:
            try:
                os.remove(APP_CFG)
            except OSError:
                pass
        if not args.keep_copy:
            try:
                os.remove(copy)
            except OSError:
                pass
        print('\n已还原配置%s' % ('、删除项目副本' if not args.keep_copy else '（副本保留）'))

    failed = [r for r in R if not r[2]]
    print('\n=== 结果：%d/%d 通过 ===' % (len(R) - len(failed), len(R)))
    if failed:
        for r in failed:
            print('  ❌ [%s] %s — %s' % (r[0], r[1], r[3]))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
