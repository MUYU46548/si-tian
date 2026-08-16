#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
回归测试 CDP 客户端框架（阶段 2：回归测试基线，2026-08-16）
基于 Edge headless + Chrome DevTools Protocol，供测试用例共享。
用法：from lib.cdp import CDP, wait_for
"""
import json
import time
import urllib.request

import websocket

CDP_PORT = 9222
APP_URL = 'http://localhost:5180/'


def find_page_ws(port=CDP_PORT, timeout=30):
    """通过 /json 获取第一个 page target 的 webSocketDebuggerUrl"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json') as resp:
                targets = json.loads(resp.read().decode())
            for t in targets:
                if t.get('type') == 'page':
                    return t['webSocketDebuggerUrl']
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError('CDP target not found')


class CDP:
    def __init__(self, ws_url=None, port=CDP_PORT):
        self.ws = websocket.create_connection(ws_url or find_page_ws(port), timeout=15)
        self.mid = 0

    def send(self, method, params=None):
        self.mid += 1
        self.ws.send(json.dumps({'id': self.mid, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self.mid:
                if 'error' in msg:
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})

    def eval(self, expr):
        """执行 JS，返回 value（异常时返回 {'__err__': ...}）"""
        result = self.send('Runtime.evaluate', {
            'expression': expr,
            'returnByValue': True,
            'awaitPromise': True,
        })
        if 'exceptionDetails' in result:
            return {'__err__': str(result['exceptionDetails'])[:300]}
        return result.get('result', {}).get('value')

    def navigate(self, url=APP_URL):
        self.send('Page.navigate', {'url': url})

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def wait_for(cdp, expr, timeout=10, desc=''):
    """轮询等待 JS 表达式为真，超时抛异常"""
    start = time.time()
    while time.time() - start < timeout:
        v = cdp.eval(expr)
        if v:
            return v
        time.sleep(0.3)
    raise RuntimeError(f'等待超时: {desc} | {expr}')


def skip_onboarding(cdp):
    """跳过首次引导（Onboarding overlay 全屏拦截点击）"""
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '跳过'); if (b) b.click(); return !!b; })()")
    time.sleep(0.5)
