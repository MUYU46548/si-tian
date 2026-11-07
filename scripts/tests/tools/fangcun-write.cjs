#!/usr/bin/env node
/**
 * 方寸（tegula）**写入口**小客户端 —— 给“会话只挂了只读入口”的时候用（2026-11-07）
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * 方寸有两套 MCP 入口（见 skill `fangcun-bridge`）：
 *   入口 B · `python tegula.py mcp` —— **只读**，14 个工具（list_tasks / get_task / search_tasks …），
 *            方寸没开也能跑；不占端口。
 *   入口 A · 桌面版命名管道 `\\.\pipe\tegula-mcp` —— **全量 32 个工具**（含 update_task /
 *            move_status / create_task / intake_task …）。
 * 如果客户端配置挂的是入口 B，写工具在那边**根本没注册**（调用会报 `unknown tool`），
 * 看起来像“方寸没开 / 未连接”—— 实际上方寸开着、管道也在，只是这一根管子只读。
 * 本脚本直接按入口 A 起桥（`ELECTRON_RUN_AS_NODE=1 <方寸.exe> <app.asar>/dist/main/mcp/bridge-standalone.js`），
 * 说 stdio 上的 MCP，比等客户端重配快。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node scripts/tests/tools/fangcun-write.cjs <calls.json> [--exe <方寸.exe 路径>]
 *
 *   calls.json = { "calls": [ { "name": "update_task", "arguments": { "id": "...", "fields": {...} } },
 *                             { "name": "move_status", "arguments": { "id": "...", "status": "待验收" } } ] }
 *
 *   环境变量 `FC_EXE` 可代替 `--exe`；桥脚本路径默认取 `<exe 同目录>/resources/app.asar/dist/main/mcp/bridge-standalone.js`。
 *   结果落到 `build/_fangcun-call-result.json`（**全文**，不截断 —— 正文要靠它回读）。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 * ① **别用一次性管道自检**（`echo '{...}' | 方寸.exe --mcp-bridge`）：exe 启动要 300ms+，
 *    stdin 先 EOF，消息直接丢，看起来像"桥坏了"。必须像本脚本这样保持连接。
 * ② **写操作前先 `get_task` 读正文**：`update_task` 是整段覆盖，方寸的 `expected_update`
 *    乐观锁比的是 frontmatter 里一个 MCP 建的卡没有的字段，传了必冲突 —— 防覆盖只能靠"先读再写"。
 * ③ **状态最多到「待验收」**：`完成 / 驳回` 是用户的签字动作，方寸会硬拒（别绕）。
 *
 * ⚠️ 本脚本只做“调用转发”，不做任何业务判断；判据与文案仍由 agent 自己写。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const argv = process.argv.slice(2);
const callsFile = argv.find((a) => !a.startsWith('--'));
const exeArgIdx = argv.indexOf('--exe');
const EXE = (exeArgIdx >= 0 ? argv[exeArgIdx + 1] : '') || process.env.FC_EXE || '';
const RESULT = path.join('build', '_fangcun-call-result.json');
const TIMEOUT_MS = 120000;

if (!callsFile) {
  console.error('用法：node scripts/tests/tools/fangcun-write.cjs <calls.json> [--exe <方寸.exe>]');
  process.exit(2);
}
if (!EXE) {
  console.error('缺少方寸 exe 路径：用 --exe 指定，或设环境变量 FC_EXE（Windows 上可从');
  console.error('  `Get-Process 方寸 | Select-Object -First 1 -ExpandProperty Path` 拿到）。');
  process.exit(2);
}

const BRIDGE = process.env.FC_BRIDGE
  || path.join(path.dirname(EXE), 'resources', 'app.asar', 'dist', 'main', 'mcp', 'bridge-standalone.js');

const { calls = [] } = JSON.parse(fs.readFileSync(callsFile, 'utf8').replace(/^\uFEFF/, ''));

const child = spawn(EXE, [BRIDGE], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch (_) { return; }
  if (msg.id && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

child.stderr.on('data', (d) => {
  const s = String(d).trim();
  if (s && !/Warning|trace-warnings|UNDICI/.test(s)) console.error('[bridge] ' + s.slice(0, 400));
});

const hardTimer = setTimeout(() => {
  console.error(`🔴 超时：桥在 ${TIMEOUT_MS}ms 内没响应（方寸没在运行？管道不通？）`);
  try { child.kill(); } catch (_) {}
  process.exit(3);
}, TIMEOUT_MS);

(async () => {
  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sitian-agent', version: '1.0.0' },
    });
    if (init.error) throw new Error('initialize 失败：' + JSON.stringify(init.error));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await request('tools/list', {});
    const names = ((list.result && list.result.tools) || []).map((t) => t.name);
    const writeTools = ['update_task', 'move_status', 'create_task', 'intake_task'];
    const missing = writeTools.filter((n) => !names.includes(n));
    console.log(`工具数 ${names.length}；写工具在位：`
      + writeTools.map((n) => `${n}=${names.includes(n)}`).join(' '));
    if (missing.length) {
      console.warn(`⚠️ 这些写工具不在：${missing.join(', ')} —— 可能连到了只读入口（或方寸版本更老）`);
    }

    const out = [];
    for (const c of calls) {
      const r = await request('tools/call', { name: c.name, arguments: c.arguments || {} });
      const text = ((r.result && r.result.content) || []).map((x) => x.text).join('\n');
      const ok = !r.error && !(r.result && r.result.isError);
      out.push({ name: c.name, ok, id: (c.arguments || {}).id, error: r.error || null, text });
      const head = text.replace(/\s+/g, ' ').slice(0, 160);
      console.log(`${ok ? '✅' : '❌'} ${c.name}${(c.arguments || {}).id ? ' ' + c.arguments.id : ''} — ${head}`);
    }
    fs.mkdirSync('build', { recursive: true });
    fs.writeFileSync(RESULT, JSON.stringify(out, null, 2), 'utf8');
    console.log(`\n结果全文：${RESULT}（${out.length} 条，${out.filter((x) => x.ok).length} 成功）`);
    clearTimeout(hardTimer);
    child.kill();
    process.exit(out.every((x) => x.ok) ? 0 : 1);
  } catch (e) {
    console.error('🔴 ' + ((e && e.message) || e));
    try { child.kill(); } catch (_) {}
    clearTimeout(hardTimer);
    process.exit(1);
  }
})();
