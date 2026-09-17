#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
回归测试编排器（阶段 2：回归测试基线，2026-08-16）

用法（在 SiTian 项目根目录）：
    python scripts/tests/run_tests.py [用例名...]

流程：
    1. 备份 index.html + 注入 mock sitianAPI + 复制真实数据到 mock-data/
    2. 启动 Vite dev server（5180）+ Edge headless（9222）
    3. 顺序执行 scripts/tests/cases/test_*.py（每个导出 run(cdp) -> (bool, detail)）
    4. 汇总报告（✅/❌ + 失败详情）
    5. 清理：还原 index.html、删除 mock-data、杀进程、释放端口

注意：mock 的 saveMapData 不写盘 → 测试对真实 .sitian/ 数据零污染。
"""
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
from lib.cdp import find_page_ws, wait_for  # noqa: E402

DEV_PORT = 5180
CDP_PORT = 9222
INDEX_HTML = os.path.join(ROOT, 'src', 'renderer', 'index.html')
MOCK_DATA_DIR = os.path.join(ROOT, 'src', 'renderer', 'mock-data')
# 环境相关常量：可用环境变量覆盖（SITIAN_VAULT / SITIAN_EDGE_EXE），也可用 --vault / --edge 覆盖
# 例：python scripts/tests/run_tests.py --vault D:/MyVault --edge "C:/path/to/msedge.exe"
VAULT = os.environ.get('SITIAN_VAULT', r'E:/图书馆/ROSA')
EDGE_EXE = os.environ.get('SITIAN_EDGE_EXE', r'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
_args = sys.argv[1:]
_case_names = []
_i = 0
while _i < len(_args):
    if _args[_i] == '--vault' and _i + 1 < len(_args):
        VAULT = _args[_i + 1]; _i += 2
    elif _args[_i] == '--edge' and _i + 1 < len(_args):
        EDGE_EXE = _args[_i + 1]; _i += 2
    else:
        _case_names.append(_args[_i]); _i += 1
REAL_GEODATA = os.path.join(VAULT, '.sitian', 'geodata.json').replace('\\', '/')
REAL_MAPDATA = os.path.join(VAULT, '.sitian', 'mapdata.json').replace('\\', '/')

MOCK_SCRIPT = """<script>
    window.__SITIAN_MOCK__ = true;
    // ⚠️ 必须**同步**安装 sitianAPI（同步 XHR 阻塞解析）：
    // 本 <script> 之后的 <script type="module"> 是 defer 执行，只要这里的安装是同步的，
    // 应用 mount 时 sitianAPI 必然已存在。历史 bug：原来用 async fetch → 若 fetch 解析
    // 慢于应用 mount，`await store.loadGeodata()` 抛 TypeError → store.nodes 恒为 0 →
    // 用例报「no-world / 树节点未渲染 / 地理数据加载超时」这类**假失败**（跨多个会话反复出现）。
    (function () {
      const loadJson = (url) => {
        const x = new XMLHttpRequest();
        x.open('GET', url, false); // false = 同步，锁死安装顺序
        x.send(null);
        return JSON.parse(x.responseText);
      };
      let geodata = null, mapdata = {};
      try {
        geodata = loadJson('/mock-data/geodata.json');
        mapdata = loadJson('/mock-data/mapdata.json');
      } catch (e) {
        console.error('[mock] 数据加载失败', e);
      }
      const noop = () => () => {};
      window.sitianAPI = {
        getGeodata: async () => ({ success: true, data: geodata }),
        reextractGeodata: async () => ({ success: true }),
        saveGeodata: async () => ({ success: true }),
        getVaultPath: async () => 'E:/图书馆/ROSA',
        selectVaultPath: async () => ({ success: false, canceled: true }),
        setVaultPath: async () => ({ success: false, canceled: true }),
        getMapData: async (planetId) => ({ success: true, data: mapdata[planetId] ?? mapdata[String(planetId).split('/').pop()] ?? null }),
        saveMapData: async () => ({ success: true }),
        saveScenarios: async () => ({ success: true }),
        loadScenarios: async () => ({ success: true, data: { version: 2, baseMaps: {}, scenarios: {} } }),
        backupSitianCache: async () => ({ success: true, backupDir: 'mock/backups', count: 0, files: [] }),
        batchImportNotes: async (payload) => ({ success: true, targetDir: 'mock', created: (payload?.names || []).map(n => ({ name: n, path: `mock/${n}.md` })), skipped: [], errors: [] }),
        createObsidianNote: async (payload) => {
          const nm = String(payload?.name || '未命名').replace(/[\\/:*?"<>|]/g, '_');
          return { success: true, path: `mock/${nm}.md`, filename: nm };
        },
        selectReferenceImage: async () => ({ success: false, canceled: true }),
        saveExportFile: async () => ({ success: false, canceled: true }),
        saveTextFile: async (opts) => {
          // 记录最近一次导出内容供断言（不写盘 → 零污染）
          window.__LAST_TEXT_EXPORT__ = opts || null;
          return { success: true, path: '/mock/' + ((opts && opts.defaultName) || 'export.txt') };
        },
        readObsidianNote: async () => ({ success: true, data: { frontmatter: { publish: true, tags: ['测试'], 层级: '星系' }, content: '测试笔记正文。', wikilinks: [] } }),
        revealInExplorer: async () => ({ success: true }),
        openExternal: async () => ({ success: true }),
        onNodeUpdated: () => () => {},
        onNodeRemoved: () => () => {},
        clearCoordinateCache: async () => ({ success: true }),
        // 以下 API 应用侧**无 ?. 守卫**，缺失会让 onMounted 抛错（进而中断挂载链路）→ 必须提供
        onOpenSettings: noop,
        onOpenAbout: noop,
        reportError: async () => ({ success: true }),
        getCurrentBaseMapKey: async () => '',
        setCurrentBaseMapKey: async () => ({ success: true }),
        // .sitian/config/*.json（P0-2 标签预设 / P1-4 标记类型）：内存态，不落盘
        getSitianConfig: async (name) => ({ success: true, data: (window.__uiConfig || {})[name] ?? null }),
        setSitianConfig: async (name, data) => {
          window.__uiConfig = window.__uiConfig || {};
          window.__uiConfig[name] = data;
          return { success: true };
        },
        getWindowMode: async () => 'default',
        setWindowMode: async () => ({ success: true }),
        getCloseQuitsApp: async () => false,
        setCloseQuitsApp: async () => ({ success: true }),
        uninstallApp: async () => ({ success: false, dev: true }),
        version: '0.0.0-mock',
        // 自动更新通道（UpdateNotification 用 ?. 调用，这里给全以免测试环境报错）
        onUpdateAvailable: noop, onUpdateCheckManual: noop, onUpdateNotAvailable: noop,
        onUpdateProgress: noop, onUpdateDownloaded: noop, onUpdateError: noop,
        checkForUpdates: async () => ({ success: false, error: 'mock' }),
        downloadUpdate: async () => ({ success: false, error: 'mock' }),
        installUpdate: async () => ({ success: false, error: 'mock' }),
        platform: 'browser',
      };
      window.dispatchEvent(new CustomEvent('sitian-mock-ready'));
    })();
  </script>"""



class ProcessHandle:
    def __init__(self, proc, name):
        self.proc = proc
        self.name = name

    def stop(self):
        try:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        except Exception:
            pass


def wait_port(port, timeout=40):
    """等待端口就绪（Vite 可能只监听 IPv6 ::1，CDP 监听 IPv4 → 双栈尝试）"""
    candidates = [f'http://localhost:{port}/', f'http://127.0.0.1:{port}/']
    if port == CDP_PORT:
        candidates = [f'http://127.0.0.1:{port}/json', f'http://localhost:{port}/json']
    deadline = time.time() + timeout
    while time.time() < deadline:
        for url in candidates:
            try:
                with urllib.request.urlopen(url, timeout=1):
                    return True
            except Exception:
                pass
        time.sleep(0.5)
    return False


def free_port(port):
    """释放指定端口（Windows taskkill；netstat 输出是 GBK 编码）"""
    try:
        out = subprocess.run(
            ['netstat', '-ano'], capture_output=True, text=True,
            encoding='gbk', errors='replace', timeout=10).stdout
        pids = set()
        for line in out.splitlines():
            if f':{port}' in line and 'LISTENING' in line:
                parts = line.split()
                if parts:
                    pids.add(parts[-1])
        for pid in pids:
            subprocess.run(['taskkill', '/PID', pid, '/F'], capture_output=True, timeout=10)
    except Exception:
        pass


def setup_mock():
    """备份 index.html、注入 mock、复制数据"""
    shutil.copy(INDEX_HTML, INDEX_HTML + '.bak')
    os.makedirs(MOCK_DATA_DIR, exist_ok=True)
    shutil.copy(REAL_GEODATA, os.path.join(MOCK_DATA_DIR, 'geodata.json'))
    shutil.copy(REAL_MAPDATA, os.path.join(MOCK_DATA_DIR, 'mapdata.json'))
    with open(INDEX_HTML, 'r', encoding='utf-8') as f:
        html = f.read()
    html = html.replace('<div id="app"></div>', MOCK_SCRIPT + '\n  <div id="app"></div>')
    with open(INDEX_HTML, 'w', encoding='utf-8') as f:
        f.write(html)


def teardown_mock():
    """还原 index.html、删除 mock-data"""
    if os.path.exists(INDEX_HTML + '.bak'):
        shutil.move(INDEX_HTML + '.bak', INDEX_HTML)
    if os.path.isdir(MOCK_DATA_DIR):
        shutil.rmtree(MOCK_DATA_DIR, ignore_errors=True)


def load_case(path):
    spec = importlib.util.spec_from_file_location(
        os.path.splitext(os.path.basename(path))[0], path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    # 用例过滤参数（--vault/--edge 已在常量解析阶段从 argv 剥离）
    case_names = _case_names
    cases_dir = os.path.join(ROOT, 'scripts', 'tests', 'cases')
    case_files = sorted(f for f in os.listdir(cases_dir) if f.startswith('test_') and f.endswith('.py'))
    if case_names:
        case_files = [f for f in case_files if any(n in f for n in case_names)]
        if not case_files:
            print('未找到匹配用例:', case_names)
            return 2

    print('=== SiTian 回归测试 ===')
    print(f'用例: {len(case_files)} 个')

    handles = []
    try:
        print('1/5 注入 mock 数据...')
        setup_mock()

        print('2/5 启动 Vite dev server...')
        free_port(DEV_PORT)
        dev = subprocess.Popen(
            ['cmd', '/c', 'npm', 'run', 'dev'], cwd=ROOT,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handles.append(ProcessHandle(dev, 'dev'))
        if not wait_port(DEV_PORT):
            raise RuntimeError('Vite dev server 启动超时')

        print('3/5 启动 Edge headless...')
        free_port(CDP_PORT)
        edge = subprocess.Popen([
            EDGE_EXE, '--headless=new', '--disable-gpu',
            '--remote-debugging-port=%d' % CDP_PORT,
            '--remote-allow-origins=*',
            '--user-data-dir=%s' % os.path.join(ROOT, '.test-edge-profile'),
            '--no-first-run', '--no-default-browser-check',
            '--disable-sync', '--disable-features=SyncConsentUI,SigninCheckoutFlow',
            '--no-sandbox', 'about:blank',
        ])
        handles.append(ProcessHandle(edge, 'edge'))
        if not wait_port(CDP_PORT):
            raise RuntimeError('Edge CDP 启动超时')

        print('4/5 运行用例...')
        from lib.cdp import CDP
        cdp = CDP()
        # 首个用例前必须导航（Edge 新 profile 停在 about:blank / 首启页）
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='首次导航')
        # 首启引导层（.onboarding-overlay）会挡住数据加载：此时 store.nodes 恒为 0，
        # 第一个用例必然看到空数据（test_01 历史上因此红）。先把首启标记写掉再重载。
        try:
            cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
            cdp.navigate()
            wait_for(cdp, "!!document.querySelector('.app-layout')", desc='跳过首启引导后重载')
            wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层已关闭')
        except Exception as e:
            print(f'  ⚠️ 跳过首启引导失败（首个用例可能看到空数据）：{e}')
        # 首个用例前同样等数据就绪（见下方循环内同款说明）
        try:
            wait_for(cdp,
                     "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                     timeout=30, desc='首个用例前数据就绪')
        except Exception:
            print('  ⚠️ 首个用例前置数据未就绪（30s 内 store.nodes 仍为 0）')
        passed, failed = 0, []
        for cf in case_files:
            name = os.path.splitext(cf)[0]
            try:
                mod = load_case(os.path.join(cases_dir, cf))
                ok, detail = mod.run(cdp)
                if ok:
                    passed += 1
                    print(f'  ✅ {name} — {detail}')
                else:
                    failed.append((name, detail))
                    print(f'  ❌ {name} — {detail}')
            except Exception as e:
                failed.append((name, f'异常: {e}'))
                print(f'  ❌ {name} — 异常: {e}')
            # 每个用例后刷新页面（隔离状态）
            try:
                cdp.navigate()
                wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载')
                # 用例前统一等数据就绪：mock 是异步注入的（geodata + 2MB mapdata），
                # 只等 .app-layout 会让下一个用例的首个断言撞上空 store，报「no-world /
                # 树节点未渲染 / 地理数据加载超时」这类**假失败**（历史上曾据此误判
                # test_07/test_12 为回归失败）。超时只告警不中断：由用例自己给出有意义的失败原因。
                try:
                    wait_for(cdp,
                             "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                             timeout=30, desc='用例前数据就绪')
                except Exception:
                    print('  ⚠️ 前置数据未就绪（30s 内 store.nodes 仍为 0，冷启动抖动？）')
                time.sleep(0.5)
            except Exception:
                pass
        cdp.close()

        total = passed + len(failed)
        print(f'\n5/5 清理环境...')
        print(f'=== 结果: {passed}/{total} 通过 ===')
        if failed:
            print('失败用例:')
            for name, detail in failed:
                print(f'  - {name}: {detail}')
            return 1
        return 0
    finally:
        for h in handles:
            h.stop()
        free_port(DEV_PORT)
        free_port(CDP_PORT)
        teardown_mock()
        shutil.rmtree(os.path.join(ROOT, '.test-edge-profile'), ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
