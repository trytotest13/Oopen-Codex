/* Headless test: boots the agent MCP bridge with plain Node (no Electron),
   then speaks MCP streamable-HTTP to it: initialize → tools/list → tools/call. */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { createAgentBridge } = require('../modules/agentserver.js');

const TOKEN = 'testtoken';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-agent-test-'));
fs.writeFileSync(path.join(root, 'demo.txt'), 'hello world\nline two\n');
fs.mkdirSync(path.join(root, '.agent', 'skills'), { recursive: true });
fs.writeFileSync(path.join(root, '.agent', 'skills', 'code-style.md'), '# code-style\n- Always use TypeScript\n');

const events = [];
const app = createAgentBridge({
  getRoot: () => root,
  getToken: () => TOKEN,
  getToolFlags: () => ({ run_command: true }),
  getBackupDir: () => path.join(root, '.backups'),
  audit: (tool, args, result, error) => events.push({ tool, args, error }),
});

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mcp/${TOKEN}`;

let failures = 0;
async function rpc(body, expectOk = true) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {
    // SSE fallback: parse data lines
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (line) json = JSON.parse(line.slice(5).trim());
  }
  if (expectOk && (!json || json.error)) {
    failures++;
    console.error(`✗ ${body.method} failed: HTTP ${res.status}`, text.slice(0, 400));
    return null;
  }
  return json;
}

// 1. initialize
const init = await rpc({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } },
});
console.log('✓ initialize →', init?.result?.serverInfo?.name, 'proto', init?.result?.protocolVersion);
if ((init?.result?.instructions || '').includes('code-style')) console.log('✓ instructions include skills + board guidance');
else { failures++; console.error('✗ initialize instructions missing skills section'); }

// 2. initialized notification (no id, expect 202)
const res2 = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});
console.log('✓ initialized notification → HTTP', res2.status);

// 3. tools/list
const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const names = (list?.result?.tools || []).map((t) => t.name);
console.log('✓ tools/list →', names.length, 'tools:', names.join(', '));
const expected = ['get_workspace_info', 'list_dir', 'list_tree', 'read_file', 'search_code', 'write_file', 'run_command',
  'http_fetch', 'list_skills', 'get_skill', 'task_list', 'task_create', 'task_update', 'task_delete'];
for (const n of expected) if (!names.includes(n)) { failures++; console.error('✗ missing tool:', n); }
const instructions = list?.result ?? {};
if (list?.result?.tools?.length < expected.length) { failures++; console.error('✗ tool count mismatch'); }

// 3b. skills visible via tools
const sk = await rpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'list_skills', arguments: {} } });
const skText = sk?.result?.content?.[0]?.text || '';
if (!skText.includes('code-style') || !skText.includes('Always use TypeScript')) { failures++; console.error('✗ list_skills missing skill content'); }
else console.log('✓ list_skills → code-style with content');
const sk1 = await rpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_skill', arguments: { name: 'code-style' } } });
if (!(sk1?.result?.content?.[0]?.text || '').includes('TypeScript')) { failures++; console.error('✗ get_skill failed'); }
else console.log('✓ get_skill → full content');

// 3c. task board tools
const tc = await rpc({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'task_create', arguments: { title: 'Add dark mode', status: 'todo' } } });
const taskId = JSON.parse(tc?.result?.content?.[0]?.text || '{}').id;
if (!taskId) { failures++; console.error('✗ task_create returned no id'); } else console.log('✓ task_create →', taskId);
await rpc({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'task_update', arguments: { id: taskId, status: 'doing' } } });
const tl = await rpc({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'task_list', arguments: {} } });
const board = JSON.parse(tl?.result?.content?.[0]?.text || '{}');
const found = (board.tasks || []).find((t) => t.id === taskId);
if (!found || found.status !== 'doing') { failures++; console.error('✗ task board state wrong:', JSON.stringify(board).slice(0, 200)); }
else console.log('✓ task_update + task_list → status=doing');
if (!fs.existsSync(path.join(root, '.agent', 'tasks.json'))) { failures++; console.error('✗ tasks.json not persisted'); }

// 3d. http_fetch against the local server itself
const hf = await rpc({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'http_fetch', arguments: { url: `http://127.0.0.1:${port}/health` } } });
const hres = JSON.parse(hf?.result?.content?.[0]?.text || '{}');
if (!hres.ok || hres.status !== 200) { failures++; console.error('✗ http_fetch failed:', JSON.stringify(hres).slice(0, 200)); }
else console.log('✓ http_fetch → 200 ok');

// 4. tools/call: get_workspace_info
const info = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_workspace_info', arguments: {} } });
console.log('✓ get_workspace_info →', info?.result?.content?.[0]?.text?.slice(0, 120).replace(/\n/g, ' '));

// 5. write_file (agent edit path) + verify backup + read back
const write = await rpc({
  jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'write_file', arguments: { path: 'demo.txt', content: 'edited by agent\n' } },
});
const wrote = JSON.parse(write?.result?.content?.[0]?.text || '{}');
console.log('✓ write_file → backup kept:', !!wrote.backup, 'bytes:', wrote.bytes);
if (!wrote.backup) { failures++; console.error('✗ expected a backup file'); }

const read = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'demo.txt' } } });
const content = JSON.parse(read?.result?.content?.[0]?.text || '{}').content;
if (content !== 'edited by agent\n') { failures++; console.error('✗ read-back mismatch:', JSON.stringify(content)); }
else console.log('✓ read_file → content round-trips');

// 6. search_code
const search = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'search_code', arguments: { query: 'AGENT' } } });
const hits = JSON.parse(search?.result?.content?.[0]?.text || '{}').matches || [];
if (!hits.length) { failures++; console.error('✗ search found nothing'); } else console.log('✓ search_code →', hits.length, 'hit(s)');

// 7. run_command
const cmd = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'run_command', arguments: { command: process.platform === 'win32' ? 'echo cmdok' : 'echo shok' } } });
const cout = JSON.parse(cmd?.result?.content?.[0]?.text || '{}');
if (!(cout.stdout || '').toLowerCase().includes('ok')) { failures++; console.error('✗ run_command output:', JSON.stringify(cout).slice(0, 300)); }
else console.log('✓ run_command →', cout.stdout.trim());

// 8. guardrails: jail escape must fail
const jail = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'write_file', arguments: { path: '../outside.txt', content: 'nope' } } });
if (!jail?.result?.isError) { failures++; console.error('✗ jail escape was not blocked!'); } else console.log('✓ guardrail: ../ escape blocked');

// 9. bad token rejected
const bad = await fetch(`http://127.0.0.1:${port}/mcp/wrongtoken`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
if (bad.status !== 401) { failures++; console.error('✗ bad token not rejected:', bad.status); } else console.log('✓ auth: wrong token → 401');

server.close();
console.log('audit events:', events.length);
if (failures) { console.error(`AGENT_TEST_FAILED (${failures} failures)`); process.exit(1); }
console.log('AGENT_TEST_OK');
process.exit(0);
