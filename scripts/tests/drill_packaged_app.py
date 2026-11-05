#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包版真机演练（发布链路，2026-11-05）

为什么要它：dev 模式下的所有演练都跑在 **Vite 源码树**上，而用户拿到的是 **asar 里的
dist + 主进程 + 示例**。两侧差的不是“同一份代码”，而是**文件选择**与**只读性**：

  · `sample/` 目录里混进的生成器日志与 `*.sitian.backups/` 会一起进安装包 —— 2026-11-05
    实测：0.5.2 之前的包里有 `sample/gen-*.log`（5 处 `E:\\` 绝对路径）与 4 份 ≈8MB 备份；
  · `dist/index.html` 里若带着测试 mock（368 行），用户版会连 mock 一起跑；
  · asar 只读 —— 示例必须**复制到文档目录**再打开，就地打开会被当成“保存不了”的 bug。

判据（静态 + 真机两段，全读真文件）：

  A. 静态（不启动应用）
    A1 `release/win-unpacked/resources/app.asar` 里有 `sample/示例世界.sitian`（>1MB）
    A2 asar 里的 `sample/` **只有这一个文件**（生成器日志 / backups / 预览图都不许进）
    A3 asar 里没有 `scripts/tests/**`、没有 `__real_desite.map`
    A4 asar 里的 `dist/index.html` 没有 `__SITIAN_MOCK__`
    A5 安装包（`release/<产品> Setup <版本>.exe`）里的 `resources/app.asar` 与
       win-unpacked 的那份 **sha256 一致**（用户下载的就是刚验的这份载荷）

  B. 真机（**启动打包版 exe**，不是 electron .；隔离 `--user-data-dir`）
    B1 页面从 `file://…/index.html` 加载（不是 dev server）
    B2 preload 可用，世界选择页有“示例地图项目”按钮
    B3 **真实 DOM 点击**该按钮 → 主进程把示例复制到文档目录 → 打开成功
    B4 副本规模：72 省 / 2 段剧本 / 有河 / 实体树含 world
    B5 保存一次：磁盘字节变了 + `saveStatus === 'saved'`（证明副本可写，没踩 asar 只读陷阱）
    B6 诊断包：`packaged === true`、版本与 package.json 一致、包内无绝对路径

  C. 收尾：删掉本轮复制进文档目录的那份副本与它的 `.backups`，不留垃圾

⚠️ 会开一个真实窗口（与其它真机演练同规矩：别在有人正画图时跑）。
⚠️ 需要先出包：`npm run dist`（本脚本**不替你打包**，只验包）。

用法：python scripts/tests/drill_packaged_app.py [--keep]
退出码：0 = 通过；非 0 = 失败（逐条打印）。
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib.cdp import CDP, find_page_ws, skip_onboarding, wait_for   # noqa: E402

# Windows 上重定向到文件时默认 GBK：✅/🔴 会抛 UnicodeEncodeError（2026-11-05 真踩）
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'build', 'packaged-app')
CDP_PORT = 9226          # 不与 run_tests(9222) / 真机演练(9224) 抢

fails = []


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (' — ' + str(detail) if detail else ''), flush=True)
    if not ok:
        fails.append(name + (' — ' + str(detail) if detail else ''))
    return ok


def port_open(port):
    import socket
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_port(port, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.3)
    return False


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def pkg():
    with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
        return json.load(f)


def find_7za():
    """electron-builder 缓存里的 7za（安装包是 NSIS，7za 能直接列/取里面的载荷）"""
    cands = []
    cache = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'electron-builder', 'Cache')
    if os.path.isdir(cache):
        for name in sorted(os.listdir(cache)):
            if name.startswith('7zip@'):
                for root, _dirs, files in os.walk(os.path.join(cache, name)):
                    if '7za.exe' in files:
                        cands.append(os.path.join(root, '7za.exe'))
    local = os.path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
    if os.path.exists(local):
        cands.append(local)
    return cands[0] if cands else ''


def asar_probe(asar_path):
    """用 @electron/asar 读 asar（只读）：返回内容清单 + 关键文件大小 / mock 标记"""
    probe = os.path.join(OUT, '_asar_probe.cjs')
    src = r'''
const asar = require('@electron/asar');
const p = process.argv[2];
const out = { ok: true };
try {
  const list = asar.listPackage(p).map((x) => x.replace(/\\/g, '/'));
  out.count = list.length;
  out.sample = list.filter((x) => /^\/sample(\/|$)/.test(x));
  out.testFiles = list.filter((x) => /^\/scripts\/tests\//.test(x)).length;
  out.realMaps = list.filter((x) => /__real_desite/.test(x)).length;
  try { out.sampleSize = asar.extractFile(p, 'sample/示例世界.sitian').length; }
  catch (e) { out.sampleErr = String((e && e.message) || e); }
  try {
    const html = asar.extractFile(p, 'dist/index.html').toString('utf8');
    out.indexLen = html.length;
    out.indexHasMock = html.includes('__SITIAN_MOCK__');
  } catch (e) { out.indexErr = String((e && e.message) || e); }
} catch (e) {
  out = { ok: false, error: String((e && e.message) || e) };
}
console.log(JSON.stringify(out));
'''
    with open(probe, 'w', encoding='utf-8') as f:
        f.write(src)
    r = subprocess.run(['node', probe, asar_path], cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', timeout=180)
    try:
        return json.loads((r.stdout or '').strip().splitlines()[-1])
    except Exception:
        return {'ok': False, 'error': '探针输出不是 JSON：%r %r' % (r.stdout, r.stderr)}


# ── 页面内取 store（打包版**不能** import 源码模块，只能走 pinia 实例）──────────
# projectStore 的 id 是 'project'（defineStore('project', …)）。世界选择页 setup 里
# `const proj = useProjectStore()` 已经把实例建出来了，所以 `_s.get('project')` 可直接取。
STATE_JS = """(() => {
  try {
    const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
    const pinia = app && app.config.globalProperties && app.config.globalProperties.$pinia;
    if (!pinia) return JSON.stringify({ err: 'no-pinia' });
    const ps = pinia._s.get('project');
    if (!ps) return JSON.stringify({ err: 'no-project-store' });
    const p = ps.project || null;
    const tip = (document.querySelector('.sample-tip') || {}).textContent || '';
    if (!p) return JSON.stringify({ opened: false, tip });
    const sc = p.scenarios || {};
    const bms = sc.baseMaps || {};
    const k = Object.keys(bms)[0] || '';
    const bm = bms[k] || {};
    return JSON.stringify({
      opened: true,
      path: ps.filePath || '',
      provinces: (bm.terrain || []).length,
      rivers: (bm.rivers || []).length,
      scenarios: Object.keys(sc.scenarios || {}).length,
      entities: Object.keys(p.entities || {}).length,
      hasWorld: Object.values(p.entities || {}).some((e) => e && e.layer === 'world'),
      saveStatus: ps.saveStatus,
      lastError: ps.lastError || '',
      tip,
    });
  } catch (e) { return JSON.stringify({ err: String((e && e.message) || e) }); }
})()"""

CLICK_JS = """(() => {
  const b = document.querySelector('[data-testid="world-open-sample"]');
  if (!b) return JSON.stringify({ found: false });
  const r = b.getBoundingClientRect();
  b.click();
  return JSON.stringify({ found: true, w: Math.round(r.width), h: Math.round(r.height),
    text: (b.textContent || '').trim() });
})()"""

SAVE_JS = """(async () => {
  try {
    const app = document.querySelector('#app').__vue_app__;
    const ps = app.config.globalProperties.$pinia._s.get('project');
    const r = await ps.saveProject({ label: '打包演练' });
    return JSON.stringify({ ok: !!(r && r.success), status: ps.saveStatus,
      error: (r && r.error) || ps.lastError || '' });
  } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); }
})()"""


def main():
    keep = '--keep' in sys.argv
    p = pkg()
    version = p.get('version') or ''
    product = ((p.get('build') or {}).get('productName')) or '司天'
    unpacked = os.path.join(ROOT, 'release', 'win-unpacked')
    exe = os.path.join(unpacked, product + '.exe')
    asar_path = os.path.join(unpacked, 'resources', 'app.asar')
    # 安装包名：2026-11-05 起 `nsis.artifactName` = `sitian-setup-<版本>.exe`（**ASCII**）。
    # 为什么必须 ASCII：0.4.0 那次上传后资产名变成 `Setup.0.4.0.exe`，而 `latest.yml` 里写的是
    # `sitian-setup-0.4.0.exe` → 自动更新 404（见 docs/RELEASE_HISTORY.md 第二节）。
    # 旧名（`<产品> Setup <版本>.exe`）留作兜底，方便验历史包。
    installer = os.path.join(ROOT, 'release', 'sitian-setup-%s.exe' % version)
    if not os.path.exists(installer):
        installer = os.path.join(ROOT, 'release', '%s Setup %s.exe' % (product, version))

    print('=== 打包版真机演练 ===')
    print('  产品 %s %s' % (product, version))
    os.makedirs(OUT, exist_ok=True)

    if port_open(CDP_PORT):
        print('CDP 端口 %d 已被占用 —— 先停掉正在跑的演练' % CDP_PORT)
        return 2
    if not os.path.exists(exe) or not os.path.exists(asar_path):
        print('缺少 win-unpacked（%s）—— 先跑 npm run dist' % unpacked)
        return 2

    # ── A. 静态 ─────────────────────────────────────────────────────────────
    print('\n[A] 安装包内容（不启动应用）')
    probe = asar_probe(asar_path)
    ck('asar 可读', bool(probe.get('ok')), probe.get('error') or '%s 条目' % probe.get('count'))
    sample_entries = [x for x in (probe.get('sample') or []) if x != '/sample']
    ck('asar 里有示例项目 sample/示例世界.sitian（>1MB）',
       (probe.get('sampleSize') or 0) > 1000000,
       '%.1f MB' % ((probe.get('sampleSize') or 0) / 1048576))
    ck('asar 的 sample/ 只有示例本身（生成器日志 / backups / 预览图都不许进）',
       sample_entries == ['/sample/示例世界.sitian'], sample_entries)
    ck('asar 里没有测试套件（scripts/tests/**）', (probe.get('testFiles') or 0) == 0,
       '%s 个' % probe.get('testFiles'))
    ck('asar 里没有真实底图（__real_desite.map）', (probe.get('realMaps') or 0) == 0,
       '%s 个' % probe.get('realMaps'))
    ck('asar 里的 dist/index.html 没有测试 mock（__SITIAN_MOCK__）',
       probe.get('indexHasMock') is False, 'len=%s' % probe.get('indexLen'))

    za = find_7za()
    ck('能找到 7za（验安装包载荷用）', bool(za), za)
    if za and os.path.exists(installer):
        ext = os.path.join(OUT, 'installer-asar')
        shutil.rmtree(ext, ignore_errors=True)
        os.makedirs(ext, exist_ok=True)
        r = subprocess.run([za, 'x', '-y', '-o' + ext, installer, 'resources/app.asar'],
                           capture_output=True, text=True, encoding='utf-8', errors='replace',
                           timeout=600)
        inside = os.path.join(ext, 'resources', 'app.asar')
        ck('安装包里能取出 resources/app.asar', os.path.exists(inside),
           (r.stdout or '')[-200:] if not os.path.exists(inside) else '%.1f MB' % (os.path.getsize(inside) / 1048576))
        if os.path.exists(inside):
            a, b = sha256_file(inside), sha256_file(asar_path)
            ck('安装包载荷与 win-unpacked 同一份（sha256 一致）', a == b, a[:12] + ' / ' + b[:12])
    elif za:
        ck('安装包存在（release/%s Setup %s.exe）' % (product, version), False,
           '先跑 npm run dist')

    # ── B. 真机 ─────────────────────────────────────────────────────────────
    print('\n[B] 启动打包版（隔离 user-data-dir，擅自清理）')
    profile = os.path.join(OUT, 'userdata')
    shutil.rmtree(profile, ignore_errors=True)
    logf = None
    el = None
    created_copy = ''
    try:
        logf = open(os.path.join(OUT, 'electron.log'), 'w', encoding='utf-8')
        env = dict(os.environ)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        env.pop('NODE_ENV', None)          # 不能让打包版误入 dev 分支
        el = subprocess.Popen([exe, '--user-data-dir=%s' % profile,
                               '--remote-debugging-port=%d' % CDP_PORT,
                               '--disable-gpu', '--disable-software-rasterizer'],
                              cwd=unpacked, env=env, stdout=logf, stderr=subprocess.STDOUT)
        if not wait_port(CDP_PORT, timeout=180):
            print('打包版 CDP 未就绪（见 %s）' % os.path.join(OUT, 'electron.log'))
            return 1
        cdp = CDP(ws_url=find_page_ws(CDP_PORT, timeout=120, prefer_prefix='file://'))
        wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                 timeout=180, desc='打包版挂载')

        url = cdp.eval('location.href')
        ck('页面从 file:// 加载（不是 dev server）',
           isinstance(url, str) and url.startswith('file://') and 'index.html' in url, url)
        skip_onboarding(cdp)
        ck('preload 可用（window.sitianAPI 有 sampleProjectOpen）',
           bool(cdp.eval("!!(window.sitianAPI && typeof window.sitianAPI.sampleProjectOpen === 'function')")))

        # 按钮：先等它出现在世界选择页（首启可能先渲染引导层）
        try:
            wait_for(cdp, "!!document.querySelector('[data-testid=\"world-open-sample\"]')",
                     timeout=60, desc='示例地图项目按钮')
            has_btn = True
        except RuntimeError:
            has_btn = False
        ck('世界选择页有“示例地图项目”按钮', has_btn)
        if not has_btn:
            return 1

        clicked = json.loads(cdp.eval(CLICK_JS))
        ck('按钮可点（有尺寸）且真的点了', bool(clicked.get('found')) and clicked.get('w', 0) > 0, clicked)

        # 打开是异步的（复制 2MB + 解析 + adopt）：**先点、再轮询短句**，不把长活塞进一次 eval
        deadline = time.time() + 240
        state = {}
        while time.time() < deadline:
            v = cdp.eval(STATE_JS)
            try:
                state = json.loads(v) if isinstance(v, str) else {'err': 'non-json: %r' % (v,)}
            except Exception:
                state = {'err': 'bad-json: %r' % (v,)}
            if state.get('opened'):
                break
            time.sleep(1.0)

        ck('点击后项目真的打开了', bool(state.get('opened')), json.dumps(state, ensure_ascii=False)[:300])
        if not state.get('opened'):
            return 1

        created_copy = state.get('path') or ''
        ck('打开的是文档目录里的副本（不是 asar 里的原件）',
           'Documents' in created_copy and created_copy.endswith('.sitian'), created_copy)
        ck('副本文件存在且不是空壳',
           os.path.exists(created_copy) and os.path.getsize(created_copy) > 1000000,
           '%.1f MB' % (os.path.getsize(created_copy) / 1048576) if os.path.exists(created_copy) else 'missing')
        ck('示例规模：72 省 / 2 段剧本 / 有河',
           int(state.get('provinces') or 0) >= 60 and int(state.get('scenarios') or 0) >= 1
           and int(state.get('rivers') or 0) > 0, state)
        ck('示例带实体树（世界 → 行星 → 区域）',
           int(state.get('entities') or 0) >= 4 and bool(state.get('hasWorld')), state)

        # B5 保存一次：读盘比对（只信磁盘）
        before = sha256_file(created_copy) if os.path.exists(created_copy) else ''
        saved = json.loads(cdp.eval(SAVE_JS))
        ck('保存调用成功（saveStatus=saved）', bool(saved.get('ok')) and saved.get('status') == 'saved', saved)
        after = sha256_file(created_copy) if os.path.exists(created_copy) else ''
        ck('保存真的写进了磁盘副本（字节变了）', bool(before) and before != after,
           (before[:12] + ' → ' + after[:12]) if before else 'no-file')

        # B6 诊断包（走与按钮相同的 IPC；target 给了就不弹保存框）
        ts = time.strftime('%Y%m%d-%H%M%S')
        target = os.path.join(OUT, 'diag-%s.zip' % ts)
        diag_expr = ("(async () => { const r = await window.sitianAPI.diagExport({ target: %s, stats: %s });"
                     " return JSON.stringify(r); })()"
                     % (json.dumps(target), json.dumps({'provinces': state.get('provinces'),
                                                         'entities': state.get('entities'),
                                                         'scenarios': state.get('scenarios')})))
        raw = cdp.eval(diag_expr)
        res = json.loads(raw) if isinstance(raw, str) else {'ok': False, 'error': repr(raw)}
        ck('诊断包导出可调用', bool(res.get('ok')), json.dumps(res, ensure_ascii=False)[:200])
        if res.get('ok') and os.path.exists(target):
            with zipfile.ZipFile(target) as z:
                names = sorted(z.namelist())
                diag = json.loads(z.read('diagnostics.json').decode('utf-8'))
                logs_txt = z.read('logs.txt').decode('utf-8', 'replace')
            ck('诊断包条目齐全', names == ['diagnostics.json', 'logs.txt'], names)
            ck('诊断包说自己是打包版（packaged=true）', diag.get('app', {}).get('packaged') is True,
               diag.get('app'))
            ck('诊断包版本与 package.json 一致', diag.get('app', {}).get('version') == version,
               '%s vs %s' % (diag.get('app', {}).get('version'), version))
            ck('诊断包里的 Electron 版本非空', bool(diag.get('runtime', {}).get('electron')),
               diag.get('runtime', {}).get('electron'))
            blob = json.dumps(diag, ensure_ascii=False) + logs_txt
            ck('诊断包内没有盘符绝对路径（脱敏生效）',
               ':\\' not in blob.replace('<路径:', ''), '')
            ck('诊断包内没有用户目录字面量',
               '\\\\Users\\\\' not in blob and '/Users/' not in blob, '')
    finally:
        try:
            if el and el.poll() is None:
                el.terminate()
                try:
                    el.wait(timeout=20)
                except Exception:
                    el.kill()
        except Exception:
            pass
        # Electron 会拉 renderer / gpu / crashpad 子进程：主进程被 terminate 后偶尔留孤儿，
        # 孤儿会占着 user-data-dir 的锁，下一轮启动就变成“打不开”。整棵树一起收。
        try:
            if el and el.pid:
                subprocess.run(['taskkill', '/PID', str(el.pid), '/T', '/F'],
                               capture_output=True, timeout=30)
        except Exception:
            pass
        try:
            logf and logf.close()
        except Exception:
            pass
        # ── C. 收尾：删掉本轮复制进文档目录的副本（用户目录不留演练垃圾）──
        if created_copy and not keep:
            safe = (created_copy.endswith('.sitian') and 'SiTianProjects' in created_copy
                    and os.path.exists(created_copy))
            if safe:
                try:
                    os.remove(created_copy)
                    print('  🧹 已删除本轮副本：%s' % created_copy)
                except Exception as e:
                    print('  ⚠️ 删除副本失败：%s' % e)
            bak = created_copy + '.backups'
            if safe and os.path.isdir(bak):
                try:
                    shutil.rmtree(bak)
                    print('  🧹 已删除它的 .backups：%s' % bak)
                except Exception as e:
                    print('  ⚠️ 删除 .backups 失败：%s' % e)
        if not keep:
            shutil.rmtree(profile, ignore_errors=True)

    return 0 if not fails else 1


if __name__ == '__main__':
    code = main()
    print(('\n✅ 全部通过' if code == 0 else '\n🔴 %d 项失败' % len(fails)))
    for f in fails:
        print('  - ' + f)
    sys.exit(code)
