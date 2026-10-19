/**
 * Probe: talk to the 方寸 desktop MCP named pipe DIRECTLY (no CLI in between).
 *
 * Why: the bridge CLI (`desktop/dist/cli/tegula-mcp.js`) produced no output in this shell,
 * while the pipe exists and `python tegula.py mcp` (read-only, no desktop needed) works.
 * This probe distinguishes "pipe/server is broken" from "the CLI wrapper is broken".
 *
 * Protocol: the Electron side is an MCP server over a named pipe. MCP stdio framing is
 * newline-delimited JSON-RPC; this probe sends the same frames and prints every line back.
 *
 * Usage: node scripts/tests/tools/_probe_fangcun_pipe.mjs
 */
import * as net from 'net';

const PIPE = '\\\\.\\pipe\\tegula-mcp';
const sock = net.createConnection(PIPE);
let buf = '';
const lines = [];

const send = (obj) => { sock.write(JSON.stringify(obj) + '\n'); };

sock.on('connect', () => {
  console.log('connected to', PIPE);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-probe', version: '1' } } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
});

sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) lines.push(line);
  }
});

sock.on('error', (e) => {
  console.log('SOCKET ERROR:', e.code || '', e.message);
  finish();
});

const finish = () => {
  console.log('--- received', lines.length, 'line(s) ---');
  for (const l of lines) console.log(l.slice(0, 600));
  try { sock.destroy(); } catch (_) { /* ignore */ }
  process.exit(0);
};

setTimeout(finish, 6000);
