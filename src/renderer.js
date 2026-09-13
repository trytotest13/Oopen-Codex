/* OpenCodex IDE renderer */
/* Everything lives in an IIFE: contextBridge defines window.api as a read-only
   global property, so a top-level binding named `api` would collide with it. */
(() => {
'use strict';
const api = window.api;

const state = {
  cfg: null,
  status: null,
  root: null,
  openFiles: [],        // [{path, model}]
  activePath: null,
  dirty: new Set(),
  chats: [],
  activeChat: null,
  chatStatus: new Map(), // id -> 'on' | 'fail'
  expanded: new Set(),
  treeCache: new Map(), // relpath -> entries
  editor: null,
  monacoReady: false,
  pendingOpen: null,
  pendingReveal: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const icon = (name, cls = 'icon') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.appendChild(u); return s; };
const LANG = { js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'javascript', ts:'typescript', tsx:'typescript', json:'json', html:'html', htm:'html', css:'css', scss:'scss', less:'less', md:'markdown', py:'python', rb:'ruby', go:'go', rs:'rust', java:'java', c:'c', h:'c', cpp:'cpp', hpp:'cpp', cs:'csharp', php:'php', sh:'shell', bash:'shell', ps1:'shell', yml:'yaml', yaml:'yaml', xml:'xml', sql:'sql', lua:'lua', swift:'swift', kt:'kotlin', toml:'ini', ini:'ini' };
const EXT_COLOR = { js:'ext-js', jsx:'ext-js', mjs:'ext-js', cjs:'ext-js', ts:'ext-ts', tsx:'ext-ts', json:'ext-json', lock:'ext-lock', md:'ext-md', py:'ext-py', html:'ext-html', htm:'ext-html', css:'ext-css', scss:'ext-css', less:'ext-css', rs:'ext-rs', go:'ext-go', sh:'ext-sh', bash:'ext-sh', ps1:'ext-sh', gitignore:'ext-gitignore' };
const FAVICON = { chatgpt: ['fav-gpt', 'G'], claude: ['fav-claude', 'C'], gemini: ['fav-gemini', 'G'] };
const joinPath = (a, b) => (a === '.' || a === '' ? b : a + '/' + b);
const parentOf = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
const baseName = (p) => p.split('/').pop();

/* ================= toasts ================= */
function toast(msg, type = 'info', ms = 3200) {
  const host = $('#toasts');
  const t = el('div', 'toast ' + type);
  t.appendChild(icon(type === 'ok' ? 'check' : type === 'err' ? 'close' : 'zap', 'icon sm'));
  t.appendChild(el('span', '', msg));
  host.appendChild(t);
  setTimeout(() => { t.classList.add('gone'); setTimeout(() => t.remove(), 220); }, ms);
}

/* ================= sidebar views ================= */
function switchView(view) {
  document.querySelectorAll('.act-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.side-view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
  if (view === 'explorer') renderTree();
  if (view === 'tasks') refreshTasks();
  if (view === 'skills') refreshSkills();
}

/* ================= task board ================= */
let tasksRefreshing = false;
async function refreshTasks() {
  if (tasksRefreshing) return;
  tasksRefreshing = true;
  try {
    const res = await api.tasks.list();
    if (!res.ok) return;
    const byStatus = { todo: [], doing: [], done: [] };
    for (const t of res.data.tasks) (byStatus[t.status] || byStatus.todo).push(t);
    document.querySelectorAll('#board .col').forEach((col) => {
      const host = col.querySelector('.cards');
      host.innerHTML = '';
      const items = byStatus[col.dataset.status] || [];
      if (!items.length) host.appendChild(el('div', 'empty', '—'));
      for (const t of items) {
        const card = el('div', 'tcard ' + t.status, t.title);
        card.title = t.id + ' — click to cycle status';
        if (t.notes) card.appendChild(el('div', 'meta', t.notes));
        card.appendChild(el('div', 'meta', new Date(t.updated).toLocaleString()));
        card.addEventListener('click', async () => {
          const order = ['todo', 'doing', 'done'];
          const next = order[(order.indexOf(t.status) + 1) % 3];
          const r = await api.tasks.update(t.id, { status: next });
          if (!r.ok) toast(r.error, 'err');
          refreshTasks();
        });
        host.appendChild(card);
      }
    });
  } finally { tasksRefreshing = false; }
}
$('#btn-tasks-refresh').addEventListener('click', refreshTasks);
$('#btn-task-new').addEventListener('click', () => askText('New task', 'Add dark mode support', async (title) => {
  const r = await api.tasks.create(title);
  if (!r.ok) { toast(r.error, 'err'); return; }
  refreshTasks();
}));

/* ================= skills ================= */
async function refreshSkills() {
  const res = await api.skills.list();
  const host = $('#skills-list');
  host.innerHTML = '';
  if (!res.ok) { host.innerHTML = `<div class="empty">${res.error}</div>`; return; }
  const list = res.data.skills;
  if (!list.length) { host.innerHTML = '<div class="empty">No skills yet.<br>Create one — e.g. "code-style" — and the agent follows it.</div>'; return; }
  for (const s of list) {
    const item = el('div', 'skill-item');
    item.appendChild(icon('skills', 'icon sm'));
    item.appendChild(el('span', 'name', s.name));
    item.appendChild(el('span', 'size', (s.size / 1024).toFixed(1) + ' KB'));
    const del = el('button', 'del', '✕');
    del.title = 'Delete skill';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete skill "${s.name}"?`)) return;
      const r = await api.skills.delete(s.name);
      if (!r.ok) toast(r.error, 'err'); else toast('Skill deleted', 'ok');
      refreshSkills();
    });
    item.appendChild(del);
    item.addEventListener('click', () => openFile(s.file));
    host.appendChild(item);
  }
}
$('#btn-skills-refresh').addEventListener('click', refreshSkills);
$('#btn-skill-new').addEventListener('click', () => askText('New skill name', 'code-style', async (name) => {
  const r = await api.skills.create(name);
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast('Skill created in .agent/skills/', 'ok');
  await refreshSkills();
  openFile(r.data.file);
}));
document.querySelectorAll('.act-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view);
    if (btn.dataset.view === 'explorer') renderTree();
  });
});
$('#st-agent').addEventListener('click', () => switchView('agent'));
$('#st-bridge').addEventListener('click', () => switchView('bridge'));
$('#st-tunnel').addEventListener('click', () => switchView('bridge'));

/* ================= file tree ================= */
async function loadDir(rel) {
  const res = await api.readDir(rel);
  if (!res.ok) { console.error(res.error); return []; }
  state.treeCache.set(rel, res.data.entries);
  return res.data.entries;
}

async function renderTree() {
  if (state.root == null) { $('#filetree').innerHTML = '<div class="empty">No folder open.<br>Use 📂 below.</div>'; return; }
  if (!state.treeCache.has('.')) await loadDir('.');
  const host = $('#filetree');
  host.innerHTML = '';
  host.appendChild(buildLevel('.', 0));
}

function buildLevel(rel, depth) {
  const box = el('div');
  if (depth === 0) {
    const rootRow = el('div', 'tree-item');
    rootRow.appendChild(el('i', 'fdot fd-folder'));
    rootRow.appendChild(el('span', 'name mono small', state.root));
    box.appendChild(rootRow);
  }
  const entries = state.treeCache.get(rel) || [];
  for (const e of entries) {
    const childRel = joinPath(rel, e.name);
    const row = el('div', 'tree-item');
    row.dataset.path = childRel;
    row.dataset.type = e.type;
    if (e.type === 'dir') {
      const tw = el('span', 'twist');
      tw.appendChild(icon(state.expanded.has(childRel) ? 'chev-d' : 'chev-r', 'icon'));
      row.appendChild(tw);
      row.appendChild(el('i', 'fdot fd-folder'));
      row.appendChild(el('span', 'name', e.name));
    } else {
      row.appendChild(el('span', 'twist'));
      row.appendChild(el('i', 'fdot ' + (EXT_COLOR[e.name.split('.').pop().toLowerCase()] || '')));
      row.appendChild(el('span', 'name', e.name));
    }
    row.addEventListener('click', async () => {
      if (e.type === 'dir') {
        if (state.expanded.has(childRel)) state.expanded.delete(childRel);
        else { state.expanded.add(childRel); if (!state.treeCache.has(childRel)) await loadDir(childRel); }
        renderTree();
      } else openFile(childRel);
    });
    row.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      if (confirm(`Delete "${childRel}"?`)) {
        const res = await api.deleteEntry(childRel);
        if (!res.ok) alert(res.error);
        state.treeCache.clear();
        renderTree();
      }
    });
    box.appendChild(row);
    if (e.type === 'dir' && state.expanded.has(childRel)) box.appendChild(buildLevel(childRel, depth + 1));
  }
  return box;
}

async function refreshParentsOf(rel) {
  state.treeCache.delete(parentOf(rel));
  state.treeCache.delete('.');
  renderTree();
}

/* ================= monaco ================= */
function initMonaco() {
  window.MonacoEnvironment = {
    getWorkerUrl() {
      return URL.createObjectURL(new Blob([
        "self.MonacoEnvironment={baseUrl:'app://app/node_modules/monaco-editor/min/'};" +
        "importScripts('app://app/node_modules/monaco-editor/min/vs/base/worker/workerMain.js');",
      ], { type: 'text/javascript' }));
    },
  };
  require.config({ paths: { vs: 'app://app/node_modules/monaco-editor/min/vs' } });
  require(['vs/editor/editor.main'], () => {
    monaco.editor.defineTheme('opencodex', {
      base: 'vs-dark', inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1f25',
        'editorGutter.background': '#1e1f25',
        'editorLineNumber.foreground': '#4a4c58',
        'editorLineNumber.activeForeground': '#a2a4b1',
        'editor.selectionBackground': '#5b8cff40',
        'editor.lineHighlightBackground': '#ffffff08',
        'editorCursor.foreground': '#5b8cff',
        'editorIndentGuide.background1': '#2b2c34',
        'editorWidget.background': '#24252c',
        'editorSuggestWidget.background': '#24252c',
        'editorHoverWidget.background': '#24252c',
        'minimap.background': '#1e1f25',
        'scrollbarSlider.background': '#ffffff12',
        'scrollbarSlider.hoverBackground': '#ffffff26',
      },
    });
    state.monacoReady = true;
    state.editor = monaco.editor.create($('#editor-host'), {
      model: null, automaticLayout: true, theme: 'opencodex', fontSize: 13,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      minimap: { enabled: true, renderCharacters: false },
      smoothScrolling: true, cursorBlinking: 'smooth', padding: { top: 10 },
    });
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
    if (state.pendingOpen) { openFile(state.pendingOpen); state.pendingOpen = null; }
    if (state.pendingReveal) doReveal(state.pendingReveal);
    window.__boot = Object.assign(window.__boot || {}, { monaco: true });
  }, (err) => {
    window.__boot = Object.assign(window.__boot || {}, { monacoErr: JSON.stringify(err).slice(0, 400) });
  });
}

async function openFile(rel, revealLine) {
  if (!state.monacoReady) { state.pendingOpen = rel; return; }
  let entry = state.openFiles.find((f) => f.path === rel);
  if (!entry) {
    const res = await api.readFile(rel);
    if (!res.ok) { toast(res.error, 'err'); return; }
    const model = monaco.editor.createModel(res.data.content, LANG[rel.split('.').pop().toLowerCase()] || 'plaintext', monaco.Uri.parse('file:///ws/' + rel));
    model.onDidChangeContent(() => { state.dirty.add(rel); renderTabs(); });
    entry = { path: rel, model };
    state.openFiles.push(entry);
  }
  state.activePath = rel;
  state.editor.setModel(entry.model);
  $('#welcome').classList.add('hidden');
  renderTabs();
  markSelected(rel);
  if (revealLine) doReveal(revealLine);
}

function markSelected(rel) {
  document.querySelectorAll('.tree-item.selected').forEach((n) => n.classList.remove('selected'));
  const row = document.querySelector(`.tree-item[data-path="${CSS.escape(rel)}"]`);
  if (row) row.classList.add('selected');
}

function doReveal(line) {
  if (!state.monacoReady || !state.activePath) { state.pendingReveal = line; return; }
  state.editor.revealLineInCenter(line);
  state.editor.setPosition({ lineNumber: line, column: 1 });
  state.editor.focus();
}

function closeFile(rel) {
  const idx = state.openFiles.findIndex((f) => f.path === rel);
  if (idx === -1) return;
  if (state.dirty.has(rel) && !confirm(`${rel} has unsaved changes. Close anyway?`)) return;
  const [f] = state.openFiles.splice(idx, 1);
  state.dirty.delete(rel);
  f.model.dispose();
  if (state.activePath === rel) {
    state.activePath = state.openFiles[Math.max(0, idx - 1)]?.path || null;
    if (state.activePath) state.editor.setModel(state.openFiles.find((x) => x.path === state.activePath).model);
    else state.editor.setModel(null);
  }
  renderTabs();
}

function renderTabs() {
  const host = $('#tabs');
  host.innerHTML = '';
  for (const f of state.openFiles) {
    const t = el('div', 'tab' + (f.path === state.activePath ? ' active' : ''));
    t.appendChild(el('i', 'fdot ' + (EXT_COLOR[baseName(f.path).split('.').pop().toLowerCase()] || '')));
    t.appendChild(el('span', 'name', baseName(f.path)));
    if (state.dirty.has(f.path)) t.appendChild(el('span', 'dirty', '●'));
    const close = el('span', 'close');
    close.appendChild(icon('close', 'icon sm'));
    close.addEventListener('click', (e) => { e.stopPropagation(); closeFile(f.path); });
    t.appendChild(close);
    t.addEventListener('click', () => openFile(f.path));
    t.addEventListener('auxclick', (e) => { if (e.button === 1) closeFile(f.path); });
    host.appendChild(t);
  }
}

async function saveActive() {
  if (!state.activePath) return;
  const f = state.openFiles.find((x) => x.path === state.activePath);
  if (!f) return;
  const res = await api.writeFile(state.activePath, f.model.getValue());
  if (!res.ok) { toast('Save failed: ' + res.error, 'err'); return; }
  state.dirty.delete(state.activePath);
  renderTabs();
  toast('Saved ' + baseName(state.activePath), 'ok', 1800);
}

/* ================= search ================= */
$('#btn-search').addEventListener('click', async () => {
  const q = $('#search-input').value.trim();
  if (!q) return;
  const host = $('#search-results');
  host.innerHTML = '<div class="empty">Searching…</div>';
  const res = await api.search(q, $('#search-glob').value.trim());
  host.innerHTML = '';
  if (!res.ok) { host.textContent = res.error; return; }
  const matches = res.data.matches;
  if (!matches.length) { host.innerHTML = '<div class="empty">No matches.</div>'; return; }
  for (const m of matches) {
    const hit = el('div', 'search-hit');
    hit.appendChild(el('div', 'path', `${m.path}:${m.line}`));
    hit.appendChild(el('div', 'text', m.text));
    hit.addEventListener('click', () => openFile(m.path, m.line));
    host.appendChild(hit);
  }
  if (res.data.truncated) host.appendChild(el('div', 'muted small pad', 'Showing first 200 matches.'));
});

/* ================= modal (prompt replacement) ================= */
function askText(title, placeholder, cb) {
  const overlay = el('div', 'modal-overlay');
  const box = el('div', 'modal');
  box.appendChild(el('h3', '', title));
  const input = el('input'); input.type = 'text'; input.placeholder = placeholder || '';
  box.appendChild(input);
  const row = el('div', 'row');
  const ok = el('button', 'primary', 'OK'), cancel = el('button', '', 'Cancel');
  row.appendChild(ok); row.appendChild(cancel); box.appendChild(row);
  overlay.appendChild(box); document.body.appendChild(overlay);
  input.focus(); input.select();
  const done = (val) => { overlay.remove(); if (val) cb(val); };
  ok.addEventListener('click', () => done(input.value.trim()));
  cancel.addEventListener('click', () => done(null));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); });
}

$('#btn-new-file').addEventListener('click', () => askText('New file (relative path)', 'src/newfile.js', async (p) => {
  const res = await api.createEntry(p, 'file');
  if (!res.ok) { toast(res.error, 'err'); return; }
  await refreshParentsOf(p); openFile(p);
}));
$('#btn-new-folder').addEventListener('click', () => askText('New folder (relative path)', 'src/newfolder', async (p) => {
  const res = await api.createEntry(p, 'dir');
  if (!res.ok) { toast(res.error, 'err'); return; }
  await refreshParentsOf(p);
}));
$('#btn-refresh').addEventListener('click', () => { state.treeCache.clear(); renderTree(); });

/* ================= chat dock ================= */
function chatFavicon(c) {
  const [cls, letter] = FAVICON[c.id] || ['fav-custom', (c.name[0] || '?').toUpperCase()];
  return el('span', 'fav ' + cls, letter);
}

function renderChatTabs() {
  const host = $('#chat-tabs');
  host.innerHTML = '';
  for (const c of state.chats) {
    const t = el('div', 'chat-tab' + (c.id === state.activeChat ? ' active' : ''));
    t.appendChild(chatFavicon(c));
    t.appendChild(el('span', '', c.name));
    if (state.cfg && state.cfg.turbo && state.cfg.turbo[c.id]) {
      const z = icon('zap', 'icon sm');
      z.style.color = 'var(--warn)';
      z.title = 'Turbo mode on';
      t.appendChild(z);
    }
    const dot = el('span', 'dot ' + (state.chatStatus.get(c.id) || ''));
    dot.title = state.chatStatus.get(c.id) === 'on' ? 'Loaded' : state.chatStatus.get(c.id) === 'fail' ? 'Failed to load' : 'Not loaded yet';
    t.appendChild(dot);
    t.title = c.url + ' — double-click to remove';
    t.addEventListener('click', () => activateChat(c.id));
    t.addEventListener('dblclick', () => api.chat.remove(c.id).then(refreshChats));
    host.appendChild(t);
  }
  const tools = el('div', '', ''); tools.id = 'chat-tools';
  const mk = (name, title, fn) => { const b = el('button'); b.appendChild(icon(name, 'icon sm')); b.title = title; b.addEventListener('click', fn); return b; };
  tools.appendChild(mk('reload', 'Reload', () => state.activeChat && api.chat.action(state.activeChat, 'reload')));
  tools.appendChild(mk('minus', 'Zoom out', () => state.activeChat && api.chat.action(state.activeChat, 'zoomOut')));
  tools.appendChild(mk('plus', 'Zoom in', () => state.activeChat && api.chat.action(state.activeChat, 'zoomIn')));
  tools.appendChild(mk('external', 'Open in system browser', () => state.activeChat && api.chat.action(state.activeChat, 'external')));
  if (state.activeChat) {
    const turboOn = !!(state.cfg && state.cfg.turbo && state.cfg.turbo[state.activeChat]);
    const zb = mk('zap', 'Turbo mode: let this chat run IDE tools automatically (ToS risk — automated use of the web UI)', toggleTurbo);
    if (turboOn) zb.style.color = 'var(--warn)';
    tools.appendChild(zb);
  }
  host.appendChild(tools);
}

async function toggleTurbo() {
  const id = state.activeChat;
  if (!id) return;
  const on = !(state.cfg && state.cfg.turbo && state.cfg.turbo[id]);
  const res = await api.turbo.toggle(id, on);
  if (!res.ok) { toast(res.error, 'err'); return; }
  state.cfg.turbo = state.cfg.turbo || {};
  if (on) state.cfg.turbo[id] = true; else delete state.cfg.turbo[id];
  toast(on
    ? '⚡ Turbo ON — this chat can now create/edit files. Automating the web UI may violate its terms of use; prefer MCP connectors when available.'
    : 'Turbo OFF for this chat', on ? 'ok' : 'info', 6000);
  renderChatTabs();
}

function activateChat(id) {
  state.activeChat = id;
  renderChatTabs();
  $('#chat-host').querySelector('.hint')?.remove();
  api.chat.setActive(id);
}

async function refreshChats() {
  const res = await api.getConfig();
  state.cfg = res.config;
  state.chats = res.config.chats;
  state.activeChat = res.config.activeChat || state.chats[0]?.id;
  renderChatTabs();
  if (boundsSent && state.activeChat) activateChat(state.activeChat);
}

$('#btn-chat-add').addEventListener('click', async () => {
  const name = $('#chat-name').value.trim();
  const url = $('#chat-url').value.trim();
  if (!name || !url) { toast('Enter both a name and a URL.', 'err'); return; }
  const res = await api.chat.add(name, url);
  if (!res.ok) { toast(res.error, 'err'); return; }
  $('#chat-name').value = ''; $('#chat-url').value = '';
  refreshChats();
  toast('Added chat tab: ' + name, 'ok');
});

api.onChatStatus((id, ok) => {
  state.chatStatus.set(id, ok ? 'on' : 'fail');
  renderChatTabs();
});

/* bounds syncing: position the native WebContentsView over #chat-host */
let boundsSent = false;
let boundsScheduled = false;
function sendBounds() {
  const r = $('#chat-host').getBoundingClientRect();
  api.chat.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
  boundsSent = true;
}
new ResizeObserver(() => {
  if (boundsScheduled) return;
  boundsScheduled = true;
  requestAnimationFrame(() => { boundsScheduled = false; sendBounds(); if (state.activeChat) api.chat.setActive(state.activeChat); });
}).observe($('#chat-host'));

/* ================= resizers + layout persistence ================= */
function setupResizer(handle, apply) {
  let startX = 0, startW = 0, dragging = false;
  handle.addEventListener('mousedown', (e) => {
    dragging = true; startX = e.clientX; startW = apply.current(); handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    apply.resize(startW + (e.clientX - startX) * apply.dir);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging'); document.body.style.cursor = '';
    api.setLayout($('#app').classList.contains('sb-hidden') ? null : parseInt($('#sidebar').getBoundingClientRect().width),
                  $('#app').classList.contains('cd-hidden') ? null : parseInt($('#chatdock').getBoundingClientRect().width));
  });
}
setupResizer($('#rsb'), {
  dir: 1,
  current: () => parseInt($('#sidebar').getBoundingClientRect().width),
  resize: (w) => { document.documentElement.style.setProperty('--sw', Math.max(170, Math.min(460, w)) + 'px'); },
});
setupResizer($('#rsc'), {
  dir: -1,
  current: () => parseInt($('#chatdock').getBoundingClientRect().width),
  resize: (w) => { document.documentElement.style.setProperty('--cw', Math.max(300, Math.min(820, w)) + 'px'); },
});
function applyLayout(layout) {
  if (!layout) return;
  if (layout.sidebarW) document.documentElement.style.setProperty('--sw', layout.sidebarW + 'px');
  if (layout.chatdockW) document.documentElement.style.setProperty('--cw', layout.chatdockW + 'px');
}
function toggleSidebar() {
  const app = $('#app');
  app.classList.toggle('sb-hidden');
  app.classList.remove('cd-hidden');
}
function toggleChatDock() {
  const app = $('#app');
  app.classList.toggle('cd-hidden');
  app.classList.remove('sb-hidden');
}

/* ================= bridge panel ================= */
function renderStatus(st) {
  state.status = st;
  $('#set-workspace').textContent = st.workspace || 'none';
  $('#st-workspace').textContent = st.workspace ? baseName(st.workspace.replace(/\\/g, '/')) : 'no folder';
  const wsChip = $('#tb-ws');
  wsChip.textContent = st.workspace || 'no folder';
  wsChip.classList.remove('hidden');

  const b = st.bridge;
  const setPill = (id, on, label) => { const n = $(id); n.textContent = label; n.className = on ? 'ok' : 'err'; };
  setPill('#st-bridge', b.running, 'mcp: ' + (b.running ? 'on' : 'off'));
  const t = st.tunnel;
  setPill('#st-tunnel', t.running, 'tunnel: ' + (t.downloading ? 'starting…' : t.running ? 'on' : 'off'));
  if (t.error) $('#st-tunnel').textContent = 'tunnel: error';
  $('#chk-run-cmd').checked = !!st.runCommandEnabled;

  const host = $('#bridge-status');
  if (b.running) {
    const token = b.mcpLocal.split('/mcp/')[1];
    const publicUrl = t.url ? t.url + '/mcp/' + token : null;
    host.innerHTML = '';
    host.appendChild(el('div', '', '✅ Agent server running on port ' + b.port));
    host.appendChild(el('div', 'url mono small', 'Local: ' + b.mcpLocal));
    if (publicUrl) {
      host.appendChild(el('div', 'muted', 'MCP URL for connectors:'));
      const u = el('div', 'url mono small', publicUrl);
      const copy = el('button', 'primary wide', 'Copy MCP URL');
      copy.addEventListener('click', () => { navigator.clipboard.writeText(publicUrl); toast('MCP URL copied', 'ok'); });
      host.appendChild(u); host.appendChild(copy);
    } else {
      host.appendChild(el('div', 'muted', t.error ? 'Tunnel error: ' + t.error : 'Tunnel not running — start it to get the public MCP URL.'));
    }
  } else {
    host.textContent = 'Server stopped.';
  }
}

$('#btn-bridge-start').addEventListener('click', async () => { renderStatus(await api.bridge.start()); toast('Agent server started', 'ok'); });
$('#btn-bridge-stop').addEventListener('click', async () => { renderStatus(await api.bridge.stop()); toast('Agent server stopped'); });
$('#btn-tunnel-start').addEventListener('click', async () => { const st = await api.bridge.tunnelStart(); renderStatus(st); if (st.tunnel.error) toast(st.tunnel.error, 'err', 6000); });
$('#btn-tunnel-stop').addEventListener('click', async () => renderStatus(await api.bridge.tunnelStop()));
$('#chk-run-cmd').addEventListener('change', async (e) => {
  await api.bridge.toggleTool('run_command', e.target.checked);
  toast(e.target.checked ? 'run_command enabled — be careful' : 'run_command disabled');
});

/* ================= agent activity ================= */
function logAgentEvent(ev) {
  const host = $('#agent-log');
  host.querySelector('.empty')?.remove();
  const e = el('div', 'entry ' + (ev.error ? 'err' : 'ok'));
  const head = el('div', 't');
  head.appendChild(el('span', '', new Date(ev.ts).toLocaleTimeString()));
  head.appendChild(el('span', 'tool', ev.tool + (ev.error ? ' · ERROR' : '')));
  e.appendChild(head);
  if (ev.args && Object.keys(ev.args).length) e.appendChild(el('div', 'mono', JSON.stringify(ev.args).slice(0, 200)));
  if (ev.error) e.appendChild(el('div', 'mono', ev.error.slice(0, 300)));
  host.prepend(e);
  while (host.children.length > 100) host.lastChild.remove();
  const chip = $('#tb-agent');
  chip.classList.remove('hidden');
  chip.innerHTML = '';
  const dot = el('span', 'dot ' + (ev.error ? 'fail' : 'on'));
  chip.appendChild(dot);
  chip.appendChild(el('span', '', `${ev.tool}${ev.error ? ' failed' : ''}`));
  $('#st-agent').textContent = 'agent: ' + (ev.error ? ev.tool + ' failed' : ev.tool);
  $('#st-agent').className = ev.error ? 'err' : 'ok';
  if (!document.getElementById('view-tasks').classList.contains('hidden')) {
    clearTimeout(logAgentEvent._t);
    logAgentEvent._t = setTimeout(refreshTasks, 400);
  }
}
api.onAgentEvent(logAgentEvent);

/* ================= terminal ================= */
const term = new Terminal({
  fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12.5,
  theme: { background: '#191a20', foreground: '#e8e9ee', cursor: '#5b8cff', selectionBackground: '#5b8cff40', black: '#141419', green: '#3fd68f', yellow: '#e8b64c', red: '#ff6b7a', blue: '#5b8cff', magenta: '#b08cff', cyan: '#4dc3e8' },
  cursorBlink: true,
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open($('#pane-terminal'));
try { fitAddon.fit(); } catch {}
term.onData((d) => api.term.write('t1', d));
api.term.onData((id, chunk) => { if (id === 't1') term.write(chunk); });
new ResizeObserver(() => {
  try { fitAddon.fit(); const d = $('#pane-terminal').getBoundingClientRect(); api.term.resize('t1', Math.floor(d.width / 8), Math.floor(d.height / 17)); } catch {}
}).observe($('#pane-terminal'));
$('#btn-term-rebuild').addEventListener('click', () => { term.reset(); api.term.rebuild('t1'); });

/* ================= workspace / status events ================= */
api.onWorkspace(async ({ root }) => {
  state.root = root;
  state.treeCache.clear();
  $('#welcome').classList.add('hidden');
  renderTree();
  term.reset();
  api.term.rebuild('t1');
  toast('Workspace: ' + root, 'ok');
});

api.onStatus((st) => renderStatus(st));

/* ================= global buttons & keys ================= */
async function openFolderDialog() {
  const res = await api.chooseFolder();
  if (res && res.error) toast(res.error, 'err');
}
$('#btn-open-folder').addEventListener('click', openFolderDialog);
$('#btn-open-folder2').addEventListener('click', openFolderDialog);
$('#wcard-open').addEventListener('click', openFolderDialog);
$('#wcard-bridge').addEventListener('click', () => switchView('bridge'));
$('#wcard-chat').addEventListener('click', () => document.querySelector('.chat-tab')?.click());
$('#btn-devtools').addEventListener('click', () => api.devtools());

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === 's') { e.preventDefault(); saveActive(); }
  if (e.key === 'b') { e.preventDefault(); toggleSidebar(); sendBounds(); }
  if (e.key === 'j') { e.preventDefault(); $('#bottom-panel').classList.toggle('hidden'); try { fitAddon.fit(); } catch {} }
});

/* ================= boot ================= */
(async function boot() {
  const res = await api.getConfig();
  state.cfg = res.config;
  state.status = res.status;
  state.root = res.config.workspace;
  applyLayout(res.config.layout);
  renderStatus(res.status);
  initMonaco();
  if (state.root) { state.treeCache.clear(); renderTree(); $('#welcome').classList.add('hidden'); }
  await refreshChats();
  sendBounds();
  // demo mode (used by the smoke test to render a realistic UI)
  if (new URLSearchParams(location.search).get('demo') === '1' && state.root) {
    for (let i = 0; i < 100 && !state.monacoReady; i++) await new Promise((r) => setTimeout(r, 200));
    await openFile('README.md');
    await openFile('main.js');
    renderTree();
    if (!state.openFiles.length) console.error('demo: openFile produced no tabs — workspace root is probably invalid: ' + state.root);
    try {
      await api.skills.create('code-style');
      const existing = await api.tasks.list();
      if (!existing.ok || !existing.data.tasks.length) {
        await api.tasks.create('Add dark mode', 'todo');
        await api.tasks.create('Fix login redirect loop', 'doing', 'suspect middleware order');
        await api.tasks.create('Write README', 'done');
      }
    } catch {}
    window.__demoDone = true;
    window.__demo = { switchView };
  }
  window.__boot = Object.assign(window.__boot || {}, {
    term: typeof term !== 'undefined', chats: state.chats.length,
    activeChat: state.activeChat, boundsSent,
    tabs: document.getElementById('tabs').children.length,
    openFiles: state.openFiles.length,
  });
})();
})();
