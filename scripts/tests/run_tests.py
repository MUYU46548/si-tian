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
REAL_GEODATA = r'E:/图书馆/ROSA/.sitian/geodata.json'
REAL_MAPDATA = r'E:/图书馆/ROSA/.sitian/mapdata.json'
EDGE_EXE = r'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

MOCK_SCRIPT = """<script>
    window.__SITIAN_MOCK__ = true;
    (async () => {
      const geodata = await (await fetch('/mock-data/geodata.json')).json();
      const mapdata = await (await fetch('/mock-data/mapdata.json')).json();
      window.sitianAPI = {
        getGeodata: async () => ({ success: true, data: geodata }),
        reextractGeodata: async () => ({ success: true }),
        saveGeodata: async () => ({ success: true }),
        getVaultPath: async () => 'E:/图书馆/ROSA',
        selectVaultPath: async () => ({ success: false, canceled: true }),
        setVaultPath: async () => ({ success: false, canceled: true }),
        getMapData: async (planetId) => ({ success: true, data: mapdata[planetId] || null }),
        saveMapData: async () => ({ success: true }),
        backupSitianCache: async () => ({ success: true, backupDir: 'mock/backups', count: 0, files: [] }),
        selectReferenceImage: async () => ({ success: false, canceled: true }),
        saveExportFile: async () => ({ success: false, canceled: true }),
        readObsidianNote: async () => ({ success: true, content: '' }),
        revealInExplorer: async () => ({ success: true }),
        openExternal: async () => ({ success: true }),
        onNodeUpdated: () => () => {},
        onNodeRemoved: () => () => {},
        clearCoordinateCache: async () => ({ success: true }),
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
    case_names = sys.argv[1:]
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
            '--no-first-run', '--no-default-browser-check', 'about:blank',
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
