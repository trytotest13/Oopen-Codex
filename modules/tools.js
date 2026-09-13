'use strict';
/** Single executor for every agent tool, shared by the MCP server and the Turbo bridge. */
const fileops = require('./fileops');
const skills = require('./skills');
const tasks = require('./tasks');

async function httpFetch(args) {
  const url = String(args.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
  const method = String(args.method || 'GET').toUpperCase();
  let headers;
  if (args.headers) {
    headers = typeof args.headers === 'string' ? JSON.parse(args.headers) : args.headers;
  }
  const timeout = Math.min(Math.max(Number(args.timeout_ms) || 15000, 1000), 30000);
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : String(args.body ?? ''),
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  const contentType = res.headers.get('content-type') || '';
  let body = '(not text or too large — not shown)';
  if (/text|json|xml|html|yaml/i.test(contentType)) {
    body = (await res.text()).slice(0, 100000);
  }
  return {
    status: res.status,
    ok: res.ok,
    contentType,
    body,
    note: 'Truncated to 100KB. Content-Type governs whether a body is included.',
  };
}

async function runTool(ctx, name, args = {}) {
  const root = ctx.getRoot();
  if (!root) throw new Error('No workspace folder is open in the IDE. Ask the user to open one.');
  switch (name) {
    case 'get_workspace_info': return fileops.workspaceInfo(root);
    case 'list_dir': return fileops.listDir(root, args.path || '.');
    case 'list_tree': return fileops.listTree(root, args.path || '.', Math.min(Number(args.depth) || 3, 6));
    case 'read_file': return fileops.readFile(root, args.path, args.max_bytes);
    case 'search_code': return fileops.search(root, args.query || '', args.glob);
    case 'write_file': {
      const r = await fileops.writeFile(root, args.path, args.content, { backupDir: ctx.getBackupDir() });
      if (ctx.audit) ctx.audit('write_file', { path: args.path, bytes: r.bytes }, r);
      return r;
    }
    case 'run_command': {
      if (!ctx.getToolFlags().run_command) throw new Error('run_command is disabled — ask the user to enable it in the IDE Bridge panel.');
      const r = await fileops.runCommand(root, args.command, args.timeout_ms);
      if (ctx.audit) ctx.audit('run_command', { command: args.command }, { exitCode: r.exitCode });
      return r;
    }
    case 'http_fetch': return httpFetch(args);
    case 'list_skills': return skills.listDetailed(root);
    case 'get_skill': return skills.read(root, String(args.name || ''));
    case 'task_list': return tasks.list(root);
    case 'task_create': {
      const r = await tasks.create(root, args.title, args.status, args.notes);
      if (ctx.audit) ctx.audit('task_create', { title: args.title, id: r.id }, r);
      return r;
    }
    case 'task_update': {
      const r = await tasks.update(root, String(args.id || ''), args);
      if (ctx.audit) ctx.audit('task_update', { id: args.id, status: args.status }, r);
      return r;
    }
    case 'task_delete': {
      const r = await tasks.remove(root, String(args.id || ''));
      if (ctx.audit) ctx.audit('task_delete', { id: args.id }, r);
      return r;
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

const TOOL_NAMES = [
  'get_workspace_info', 'list_dir', 'list_tree', 'read_file', 'search_code', 'write_file', 'run_command',
  'http_fetch', 'list_skills', 'get_skill', 'task_list', 'task_create', 'task_update', 'task_delete',
];

module.exports = { runTool, TOOL_NAMES };
