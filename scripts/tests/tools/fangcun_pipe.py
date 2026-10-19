#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方寸 named pipe 客户端（读写通用）——**不经 Node 桥**，直接连管道。

为什么要这一份：`desktop/dist/cli/tegula-mcp.js` 在 PowerShell 里调用时有管道/quoting 的坑
（实测"没有输出"），而我要的是**确定能跑**的投递手段。协议本身极简
（见方寸 `desktop/src/main/mcp/socket-server.ts`）：newline-delimited JSON-RPC。

用法：
  python scripts/tests/tools/fangcun_pipe.py --list
  python scripts/tests/tools/fangcun_pipe.py --schema create_task
  python scripts/tests/tools/fangcun_pipe.py --call list_tasks '{"view":"all"}'
  python scripts/tests/tools/fangcun_pipe.py --call create_task @file.json    # 参数从文件读（长正文用这个）

⚠️ 方寸只认一个 initialize；`notifications/initialized` 会回 `Method not found`（无害，已不复用）。
⚠️ 自检必须用真实连接：`Test-Path -LiteralPath '\\\\.\\pipe\\tegula-mcp'` 为真才继续；
   不带 `-LiteralPath` 的 `Test-Path` 是**假阳性**（只判路径字符串形式合法）。
"""
import json
import sys
import time

PIPE = r'\\.\pipe\tegula-mcp'


def call(tool, args, timeout=20.0):
    with open(PIPE, 'r+b', buffering=0) as f:
        def send(obj):
            f.write((json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8'))

        send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
              'params': {'protocolVersion': '2024-11-05', 'capabilities': {},
                         'clientInfo': {'name': 'sitian-agent', 'version': '1'}}})
        if tool == '__tools_list__':
            send({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
        else:
            send({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                  'params': {'name': tool, 'arguments': args}})
        buf = ''
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = f.read(65536)
            if not chunk:
                time.sleep(0.05)
                continue
            buf += chunk.decode('utf-8', 'replace')
            while '\n' in buf:
                line, buf = buf.split('\n', 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                if msg.get('id') == 2:
                    return msg
    raise TimeoutError('方寸没在规定时间内回话')


def main():
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        return 2
    mode = argv[0]
    try:
        if mode == '--list':
            r = call('__tools_list__', {})
            tools = [t['name'] for t in (r.get('result', {}).get('tools') or [])]
            print(json.dumps({'tools': tools}, ensure_ascii=False, indent=1))
            return 0
        if mode == '--schema':
            r = call('__tools_list__', {})
            want = argv[1]
            t = next((x for x in (r.get('result', {}).get('tools') or []) if x['name'] == want), None)
            print(json.dumps(t or {'error': 'tool not found: ' + want}, ensure_ascii=False, indent=1))
            return 0
        if mode == '--call':
            tool = argv[1]
            raw = argv[2] if len(argv) > 2 else '{}'
            if raw.startswith('@'):
                with open(raw[1:], encoding='utf-8') as fh:
                    raw = fh.read()
            args = json.loads(raw)
            r = call(tool, args)
        else:
            print('unknown mode', mode)
            return 2
    except Exception as e:                      # noqa: BLE001
        print(json.dumps({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}, ensure_ascii=False))
        return 1
    res = r.get('result') or r.get('error') or r
    content = None
    if isinstance(res, dict) and isinstance(res.get('content'), list) and res['content']:
        content = res['content'][0].get('text')
    print(content if content is not None else json.dumps(res, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
