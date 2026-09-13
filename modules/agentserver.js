'use strict';
/**
 * Local agent exposed as a remote MCP server over streamable HTTP (stateless).
 * Registered in ChatGPT (Developer Mode) and Claude (Custom Connectors) via a tunnel.
 * Electron-free on purpose so it can be tested headlessly with plain Node.
 */
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const skills = require('./skills');
const { runTool } = require('./tools');

function textResult(obj, isError = false) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }], isError };
}

async function buildAgentServer(ctx) {
  const instructions = await buildInstructions(ctx);
  const server = new McpServer({ name: 'opencodex-agent', version: '0.2.0' }, { capabilities: { tools: {} }, instructions });

  const tool = (name, opts, schema, fn) => {
    server.registerTool(name, {
      title: opts.title,
      description: opts.description + (opts.requires ? '' : ''),
      inputSchema: schema,
    }, async (args) => {
      try { return textResult(await fn(args || {})); }
      catch (e) { return textResult(String(e.message || e), true); }
    });
  };
  const S = z;

  tool('get_workspace_info', { title: 'Workspace info', description: 'Get the root path and top-level structure of the project open in the IDE. Call this FIRST to map the workspace.' },
    {}, (a) => runTool(ctx, 'get_workspace_info', a));

  tool('list_dir', { title: 'List directory', description: 'List the entries of a directory in the workspace.' },
    { path: S.string().optional().describe('Relative path, "." for workspace root') },
    (a) => runTool(ctx, 'list_dir', a));

  tool('list_tree', { title: 'List tree', description: 'Get a recursive tree view of a directory (default depth 3).' },
    { path: S.string().optional(), depth: S.number().optional() },
    (a) => runTool(ctx, 'list_tree', a));

  tool('read_file', { title: 'Read file', description: 'Read a text file from the workspace.' },
    { path: S.string().describe('Relative path of the file'), max_bytes: S.number().optional() },
    (a) => runTool(ctx, 'read_file', a));

  tool('search_code', { title: 'Search code', description: 'Search case-insensitive text across the workspace. glob filters file types, e.g. "*.ts" or "*.py,*.js".' },
    { query: S.string(), glob: S.string().optional() },
    (a) => runTool(ctx, 'search_code', a));

  tool('write_file', { title: 'Write file', description: 'Create or overwrite a file with the full new content. The IDE keeps a backup of the previous version and shows the user what changed.' },
    { path: S.string(), content: S.string() },
    (a) => runTool(ctx, 'write_file', a));

  tool('run_command', { title: 'Run command', description: 'Run a shell command in the workspace root (non-interactive) and return stdout/stderr. Disabled unless the user enables it in the IDE.' },
    { command: S.string(), timeout_ms: S.number().optional() },
    (a) => runTool(ctx, 'run_command', a));

  tool('http_fetch', { title: 'HTTP fetch', description: 'Make an HTTP request (APIs, docs, webhooks) and return status + text body (up to 100KB).' },
    {
      url: S.string().describe('Absolute http(s) URL'),
      method: S.string().optional().describe('GET (default), POST, PUT, PATCH, DELETE'),
      headers: S.any().optional().describe('Object or JSON string of headers'),
      body: S.string().optional(),
      timeout_ms: S.number().optional(),
    },
    (a) => runTool(ctx, 'http_fetch', a));

  tool('list_skills', { title: 'List skills', description: 'List the user-authored Markdown skills (project conventions) that you must follow.' },
    {}, (a) => runTool(ctx, 'list_skills', a));

  tool('get_skill', { title: 'Get skill', description: 'Read the full Markdown content of one skill.' },
    { name: S.string() }, (a) => runTool(ctx, 'get_skill', a));

  tool('task_list', { title: 'List tasks', description: 'List all tasks on the shared board the user is watching (statuses: todo, doing, done).' },
    {}, (a) => runTool(ctx, 'task_list', a));

  tool('task_create', { title: 'Create task', description: 'Create a task card on the user\'s live board. Use for multi-step work: create the steps first, then update statuses as you go.' },
    { title: S.string(), status: S.string().optional().describe('todo (default), doing, done'), notes: S.string().optional() },
    (a) => runTool(ctx, 'task_create', a));

  tool('task_update', { title: 'Update task', description: 'Update a task\'s status (todo→doing→done), title or notes. Keep the board live while you work.' },
    { id: S.string(), status: S.string().optional(), title: S.string().optional(), notes: S.string().optional() },
    (a) => runTool(ctx, 'task_update', a));

  tool('task_delete', { title: 'Delete task', description: 'Remove a task from the board.' },
    { id: S.string() }, (a) => runTool(ctx, 'task_delete', a));

  return server;
}

async function buildInstructions(ctx) {
  let skillSection = '';
  try { skillSection = await skills.protocolSection(ctx.getRoot()); } catch {}
  return 'You are the agent of the OpenCodex IDE, working inside the user\'s open project.'
    + ' Prefer tools over printing code: read/edit real files with read_file/write_file.'
    + ' For multi-step work, create task cards with task_create and keep their statuses updated (todo→doing→done) — the user watches a live board.'
    + ' Check list_skills for project conventions you must follow.'
    + skillSection;
}

function createAgentBridge({ getRoot, getToken, getToolFlags, audit, getBackupDir }) {
  const app = express();
  app.use(express.json({ limit: '64mb' }));

  app.get('/health', (req, res) => res.json({ ok: true, service: 'opencodex-agent' }));

  const deny = (req, res, next) => {
    if (req.params.token !== getToken()) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    next();
  };
  const mcpRoute = async (req, res) => {
    try {
      const server = await buildAgentServer({ getRoot, getToolFlags, audit, getBackupDir: getBackupDir || (() => null) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { try { transport.close(); server.close(); } catch {} });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String((e && e.message) || e) }, id: null });
    }
  };
  app.post('/mcp/:token', deny, mcpRoute);
  const notSupported = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  app.get('/mcp/:token', deny, notSupported);
  app.delete('/mcp/:token', deny, notSupported);

  return app;
}

module.exports = { createAgentBridge, buildAgentServer };
