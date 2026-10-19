/**
 * 方寸写入口（named pipe `\\.\pipe\tegula-mcp`）的最小客户端 —— **读写通用**。
 *
 * 为什么单独写一份而不是用 `desktop/dist/cli/tegula-mcp.js`：
 *   那个桥在 PowerShell 里调用要过管道/参数传递的多层 quoting，实测"没有输出"，
 *   而我需要的是**确定能跑**的东西（本轮要把决策投进方寸）。
 *   协议本身很简单：newline-delimited JSON-RPC，直连管道即可（见 `socket-server.ts`）。
 *
 * 用法：
 *   node scripts/tests/tools/_fangcun_pipe.mjs --list
 *   node scripts/tests/tools/_fangcun_pipe.mjs --call list_tasks '{"view":"active"}'
 *   node scripts/tests/tools/_fangcun_pipe.mjs --call create_task '{"title":"...","project":"sitian"}'
 *
 * ⚠️ 方寸**只支持一个 initialize**；`notifications/initialized` 会返回
 *   `Method not found`（不影响后续 tools/call，但别把它当失败）。
 */
import * as net from 'net';

const PIPE = process.env.TEGULA_PIPE || '\\\\.\\pipe\\tegula-mcp';
const args = process.argv.slice(2);
const mode = args[0] || '--list';
const toolName = args[1];
let toolArgs = {};
if (args[2]) {
  try { toolArgs = JSON.parse(args[2]); } catch (e) {
    console.error('参数不是合法 JSON:', args[2]);
    process.exit(2);
  }
}

const sock = net.createConnection(PIPE);
let buf = '';
const replies = new Map();
let done = false;

const finish = (code) => {
  if (done) return;
  done = true;
  try { sock.destroy(); } catch (_) { /* ignore */ }
  process.exit(code);
};

sock.on('connect', () => {
  sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sitian-agent', version: '1' } } }) + '\n');
  if (mode === '--list') {
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  } else if (mode === '--schema') {
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  } else {
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs } }) + '\n');
  }
});

sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    if (msg.id === 2) {
      replies.set(2, msg);
      const text = msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text;
      if (mode === '--list') {
        const tools = ((msg.result && msg.result.tools) || []).map((t) => t.name);
        console.log(JSON.stringify({ tools }, null, 1));
      } else if (mode === '--schema') {
        const want = toolName;
        const t = ((msg.result && msg.result.tools) || []).find((x) => x.name === want);
        console.log(JSON.stringify(t || { error: 'tool not found: ' + want }, null, 1));
      } else if (text !== undefined) {
        console.log(text);
      } else {
        console.log(JSON.stringify(msg, null, 1));
      }
      finish(0);
    }
  }
});

sock.on('error', (e) => {
  console.error('SOCKET ERROR:', e.code || '', e.message);
  finish(1);
});

setTimeout(() => { console.error('timeout: 方寸没回话'); finish(3); }, 15000);
