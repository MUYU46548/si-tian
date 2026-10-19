#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""救回卡在 modal dialog 上的探针结果：先关掉对话框，再读 window.__JANK。"""
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
from lib.cdp import CDP   # noqa: E402


def main():
    cdp = CDP()
    try:
        cdp.ws.settimeout(20)
        cdp.send('Page.enable', {})
        try:
            cdp.send('Page.handleJavaScriptDialog', {'accept': True})
            print('dialog accepted')
        except Exception as e:
            print('no dialog / handle failed:', str(e)[:120])
        time.sleep(1.0)
        v = cdp.eval("JSON.stringify(window.__JANK || null)")
        if isinstance(v, str) and v and v != 'null':
            res = json.loads(v)
            p = os.path.join(ROOT, '.lab-jank.json')
            with open(p, 'w', encoding='utf-8') as f:
                json.dump(res, f, ensure_ascii=False, indent=1)
            print('stage =', res.get('stage'), 'fails =', res.get('fails'))
            print(json.dumps(res, ensure_ascii=False, indent=1))
        else:
            print('read failed:', str(v)[:300])
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
