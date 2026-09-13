'use strict';
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', '.next', '.cache', '__pycache__', '.venv', 'venv']);
const MAX_SEARCH_FILE = 512 * 1024;
const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 20 * 1024 * 1024;

/* ---------- path safety ---------- */
function safeJoin(root, p) {
  if (!root) throw new Error('No workspace folder is open in the IDE.');
  const abs = path.resolve(root, p || '.');
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('Path escapes the workspace: ' + p);
  }
  return abs;
}
function isBlockedForWrite(root, p) {
  const rel = path.relative(root, path.resolve(root, p)).replace(/\\/g, '/');
  return /^\.env($|\.)|(^|\/)\.git(\/|$)|^\.opencodex|(^|\/)(id_rsa|id_ed25519)(\.|$)/i.test(rel) || /(^|\/)\.env$/i.test(rel);
}

/* ---------- listing / tree ---------- */
async function listDir(root, p) {
  const abs = safeJoin(root, p);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries.slice(0, 2000)) {
    let size = null;
    try { if (e.isFile()) size = (await fsp.stat(path.join(abs, e.name))).size; } catch {}
    out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: p || '.', entries: out };
}

async function listTree(root, p, depth = 3) {
  const lines = [];
  async function walk(dir, prefix, d) {
    if (d > depth || lines.length > 400) return;
    let entries = [];
    try { entries = (await listDir(root, path.relative(root, dir) || '.')).entries; } catch { return; }
    for (const e of entries.slice(0, 60)) {
      lines.push(prefix + e.name + (e.type === 'dir' ? '/' : ''));
      if (e.type === 'dir') await walk(path.join(dir, e.name), prefix + '  ', d + 1);
    }
  }
  const abs = safeJoin(root, p || '.');
  lines.push((p || '.') + '/');
  await walk(abs, '  ', 1);
  return { tree: lines.join('\n') };
}

async function workspaceInfo(root) {
  const top = await listDir(root, '.');
  return {
    root,
    name: path.basename(root),
    topLevel: top.entries.map((e) => e.name + (e.type === 'dir' ? '/' : '')),
    hint: 'Use list_dir / list_tree / search_code to map the project, read_file to inspect, write_file to edit (auto-backup is kept).',
  };
}

/* ---------- read / write ---------- */
function looksBinary(buf) { for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return true; return false; }

async function readFile(root, p, maxBytes = 200 * 1024) {
  const abs = safeJoin(root, p);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error('Not a file: ' + p);
  const cap = Math.min(maxBytes || MAX_READ, MAX_READ);
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, cap));
    await fh.read(buf, 0, buf.length, 0);
    if (looksBinary(buf)) return { path: p, binary: true, size: st.size, content: '(binary file — not shown)' };
    return {
      path: p, size: st.size, truncated: st.size > cap,
      content: buf.toString('utf8') + (st.size > cap ? `\n\n... [truncated ${st.size - cap} bytes]` : ''),
    };
  } finally { await fh.close(); }
}

async function backupFile(abs, backupDir, root) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rel = path.relative(root, abs).replace(/[\\/]/g, '__');
    const dir = path.join(backupDir, path.basename(root) || 'ws');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${stamp}__${rel}`);
    fs.copyFileSync(abs, dest);
    return dest;
  } catch { return null; }
}

async function writeFile(root, p, content, { backupDir } = {}) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (Buffer.byteLength(content) > MAX_WRITE) throw new Error('content too large (max 20MB)');
  const abs = safeJoin(root, p);
  if (isBlockedForWrite(root, p)) throw new Error(`Writes to "${p}" are blocked by guardrails (protected path).`);
  const backup = fs.existsSync(abs) && backupDir ? await backupFile(abs, backupDir, root) : null;
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return { path: p, bytes: Buffer.byteLength(content), backup: backup || null, note: 'Written. A backup copy was kept if the file existed.' };
}

async function createEntry(root, p, type) {
  const abs = safeJoin(root, p);
  if (isBlockedForWrite(root, p)) throw new Error('Blocked path.');
  if (type === 'dir') { await fsp.mkdir(abs, { recursive: true }); return { created: p }; }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, '', 'utf8');
  return { created: p };
}

async function deleteEntry(root, p) {
  const abs = safeJoin(root, p);
  if (isBlockedForWrite(root, p)) throw new Error('Blocked path.');
  await fsp.rm(abs, { recursive: true, force: false });
  return { deleted: p };
}

/* ---------- search ---------- */
function globToFilter(glob) {
  if (!glob) return null;
  const exts = String(glob).split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^\*+/, '').toLowerCase());
  return exts.length ? (name) => exts.some((e) => name.toLowerCase().endsWith(e)) : null;
}

async function search(root, query, glob) {
  if (!query) return { matches: [] };
  const needle = query.toLowerCase();
  const extFilter = globToFilter(glob);
  const matches = [];
  let visited = 0;
  async function walk(dir, rel, depth) {
    if (depth > 12 || visited > 20000 || matches.length >= 200) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (matches.length >= 200) return;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(abs, r, depth + 1); continue; }
      if (!e.isFile() || visited++ > 20000) continue;
      if (extFilter && !extFilter(e.name)) continue;
      let buf;
      try { if ((await fsp.stat(abs)).size > MAX_SEARCH_FILE) continue; buf = await fsp.readFile(abs); } catch { continue; }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: r, line: i + 1, text: lines[i].trim().slice(0, 160) });
          if (matches.length >= 200) return;
        }
      }
    }
  }
  await walk(root, '', 0);
  return { matches, truncated: matches.length >= 200 };
}

/* ---------- command execution (agent tool) ---------- */
async function runCommand(root, command, timeoutMs = 30000) {
  const abs = safeJoin(root, '.');
  const timeout = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);
  const isWin = process.platform === 'win32';
  const child = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
    cwd: abs, windowsHide: true, env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' },
  });
  let out = '', errOut = '', truncated = false;
  child.stdout.on('data', (d) => { if (out.length < 60000) out += d.toString('utf8'); else truncated = true; });
  child.stderr.on('data', (d) => { if (errOut.length < 60000) errOut += d.toString('utf8'); else truncated = true; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { truncated = true; try { child.kill(); } catch {} resolve(null); }, timeout);
    child.on('close', (c) => { clearTimeout(t); resolve(c); });
    child.on('error', (e) => { clearTimeout(t); errOut += String(e); resolve(-1); });
  });
  return { command, exitCode: code, timeoutReached: code === null, truncated, stdout: out.slice(0, 60000), stderr: errOut.slice(0, 60000) };
}

module.exports = { safeJoin, listDir, listTree, workspaceInfo, readFile, writeFile, createEntry, deleteEntry, search, runCommand };
