'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, session, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { initConfig, saveConfig, getConfig } = require('./modules/config');
const fileops = require('./modules/fileops');
const { createAgentBridge } = require('./modules/agentserver');
const { ChatViewManager } = require('./modules/chatviews');
const { TunnelManager } = require('./modules/tunnel');
const { TerminalManager } = require('./modules/terminal');
const { TurboBridge } = require('./modules/turbo');

const skills = require('./modules/skills');
const tasks = require('./modules/tasks');

const APP_ROOT = __dirname;
const SMOKE_TEST = process.env.SMOKE_TEST === '1';
const SMOKE_TURBO = process.env.SMOKE_TURBO === '1';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
let chatMgr = null;
let tunnel = null;
let terminal = null;
let turbo = null;
let agentHttpServer = null;

function statusSnapshot() {
  const cfg = getConfig();
  return {
    workspace: cfg.workspace,
    bridge: { running: !!agentHttpServer, port: cfg.port, mcpLocal: `http://127.0.0.1:${cfg.port}/mcp/${cfg.token}` },
    tunnel: tunnel ? tunnel.status() : { running: false, url: null },
    runCommandEnabled: !!cfg.tools.run_command,
  };
}
function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function audit(tool, args, result, error) {
  const entry = { ts: new Date().toISOString(), tool, args: args || {}, error: error || null, result: result || null };
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'audit.jsonl'), JSON.stringify(entry) + '\n');
  } catch {}
  broadcast('agent:event', entry);
}

/* ---------- workspace ---------- */
async function chooseWorkspace() {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return setWorkspace(res.filePaths[0]);
}
function setWorkspace(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Not a folder: ' + dir);
  const cfg = getConfig();
  cfg.workspace = dir;
  saveConfig();
  broadcast('ws:changed', { root: dir });
  broadcast('status', statusSnapshot());
  return dir;
}

/* ---------- agent bridge lifecycle ---------- */
function startAgentBridge() {
  if (agentHttpServer) return statusSnapshot();
  const cfg = getConfig();
  const app_ = createAgentBridge({
    getRoot: () => getConfig().workspace,
    getToken: () => getConfig().token,
    getToolFlags: () => getConfig().tools,
    getBackupDir: () => path.join(app.getPath('userData'), 'backups'),
    audit,
  });
  agentHttpServer = app_.listen(cfg.port, '127.0.0.1', () => {
    broadcast('status', statusSnapshot());
  });
  agentHttpServer.on('error', (e) => {
    agentHttpServer = null;
    audit('bridge', {}, null, 'Agent server failed: ' + e.message);
    broadcast('status', statusSnapshot());
  });
  return statusSnapshot();
}
function stopAgentBridge() {
  if (tunnel && tunnel.status().running) tunnel.stop();
  if (agentHttpServer) {
    const s = agentHttpServer;
    agentHttpServer = null;
    s.close(() => {});
  }
  broadcast('status', statusSnapshot());
  return statusSnapshot();
}

/* ---------- app protocol: serves the UI + node_modules as app://app/... ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
function handleAppRequest(url) {
  const u = new URL(url);
  if (u.hostname !== 'app') return new Response('bad host', { status: 404 });
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(APP_ROOT, p);
  if (!file.startsWith(APP_ROOT)) return new Response('forbidden', { status: 403 });
  try {
    const data = fs.readFileSync(file);
    return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  } catch {
    return new Response('not found: ' + p, { status: 404 });
  }
}

/* ---------- window ---------- */
function createWindow() {
  const opts = {
    width: 1500, height: 950, minWidth: 980, minHeight: 600,
    backgroundColor: '#1e1f25',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  };
  if (process.platform === 'win32') {
    opts.titleBarStyle = 'hidden';
    opts.titleBarOverlay = { color: '#141419', symbolColor: '#b9bac4', height: 38 };
  } else if (process.platform === 'darwin') {
    opts.titleBarStyle = 'hiddenInset';
  }
  win = new BrowserWindow(opts);
  win.loadURL('app://app/index.html' + (SMOKE_TEST ? '?demo=1' : ''));
  win.webContents.on('did-finish-load', () => broadcast('status', statusSnapshot()));
  if (SMOKE_TEST || SMOKE_TURBO) {
    win.webContents.on('console-message', (e) => {
      console.log('[renderer]', e.level, String(e.message).slice(0, 300));
    });
  }
}

app.whenReady().then(async () => {
  initConfig();
  app.userAgentFallback = app.userAgentFallback.replace(/\s?Electron\/[\d.]+/g, '').replace(/\s?OpenCodexIDE?\/[\d.]+/g, '');

  protocol.handle('app', (req) => handleAppRequest(urlFromReq(req)));

  chatMgr = new ChatViewManager({
    getWin: () => win,
    onNewSession: (ses) => ses.protocol.handle('app', (req) => handleAppRequest(urlFromReq(req))),
    onStatus: (id, ok) => {
      broadcast('chat:status', { id, ok });
      if (ok && turbo && turbo.isEnabled(id)) turbo.ensureInjected(id);
    },
  });
  turbo = new TurboBridge({
    getView: (id) => (chatMgr ? chatMgr.getView(id) : null),
    getRoot: () => getConfig().workspace,
    getToolFlags: () => getConfig().tools,
    getBackupDir: () => path.join(app.getPath('userData'), 'backups'),
    getConfig: () => getConfig(),
    audit,
  });
  setInterval(() => {
    const t = getConfig().turbo || {};
    for (const id of Object.keys(t)) if (t[id]) turbo.tick(id);
  }, 1200);
  tunnel = new TunnelManager({ getPort: () => getConfig().port, onChange: () => broadcast('status', statusSnapshot()) });
  terminal = new TerminalManager({ getRoot: () => getConfig().workspace, onData: (id, chunk) => broadcast('term:data', { id, chunk }) });

  registerIpc();
  createWindow();

  if (SMOKE_TEST) {
    const prevWs = getConfig().workspace;
    if (!prevWs) setWorkspace(APP_ROOT);
    setTimeout(async () => {
      try {
        console.log('BOOT_STATE ' + (await win.webContents.executeJavaScript('JSON.stringify(window.__boot||null)')));
        // wait for the renderer demo to finish setting up before capturing
        await win.webContents.executeJavaScript('(async()=>{for(let i=0;i<200&&!window.__demoDone;i++)await new Promise(r=>setTimeout(r,200));})()');
        console.log('DEMO_READY');
        const shot = async (name) => {
          // capturePage fails with UnknownVizError when the window is occluded — retry a few times
          let lastErr;
          for (let i = 0; i < 6; i++) {
            try {
              win.show(); win.moveTop(); win.webContents.invalidate();
              const img = await win.webContents.capturePage();
              if (img && !img.isEmpty()) {
                fs.writeFileSync(path.join(APP_ROOT, name), img.toPNG());
                console.log('SCREENSHOT_SAVED ' + name);
                return;
              }
            } catch (e) { lastErr = e; }
            await new Promise((r) => setTimeout(r, 800));
          }
          throw lastErr || new Error('capture failed: empty image');
        };
        await shot('ui-screenshot.png');
        await win.webContents.executeJavaScript("window.__demo && window.__demo.switchView('tasks')");
        await new Promise((r) => setTimeout(r, 900));
        await shot('ui-screenshot-tasks.png');
        await win.webContents.executeJavaScript("window.__demo && window.__demo.switchView('skills')");
        await new Promise((r) => setTimeout(r, 900));
        await shot('ui-screenshot-skills.png');
      } catch (e) { console.log('BOOT_STATE_ERROR ' + e); }
      // leave the user's config exactly as we found it
      if (!prevWs) { getConfig().workspace = null; saveConfig(); }
      console.log('SMOKE_OK');
      app.exit(0);
    }, 15000);
  }

  if (SMOKE_TURBO) {
    const os = require('os');
    const prevWs = getConfig().workspace;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-turbo-'));
    setWorkspace(tmp);
    const cfg = getConfig();
    if (!cfg.chats.some((c) => c.id === 'mockchat')) cfg.chats.push({ id: 'mockchat', name: 'Mock', url: 'app://app/test-chat.html' });
    cfg.turbo = cfg.turbo || {};
    cfg.turbo.mockchat = true;
    saveConfig();
    setTimeout(async () => {
      let ok = false;
      try {
        chatMgr.setActive('mockchat', getConfig().chats);
        await new Promise((r) => setTimeout(r, 2500));
        await turbo.ensureInjected('mockchat');
        const view = chatMgr.getView('mockchat');
        const sent = await view.webContents.executeJavaScript(`window.__ocxUserSend(${JSON.stringify('Please create a file named turbo-test.txt')})`, true);
        console.log('TURBO_SENT ' + sent);
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (fs.existsSync(path.join(tmp, 'turbo-test.txt'))) { ok = true; break; }
        }
        console.log('TURBO_PAGE_TAIL ' + JSON.stringify((await view.webContents.executeJavaScript('document.body.innerText.slice(-500)')).slice(0, 500)));
        console.log('TURBO_FILE ' + JSON.stringify(fs.existsSync(path.join(tmp, 'turbo-test.txt')) ? fs.readFileSync(path.join(tmp, 'turbo-test.txt'), 'utf8') : null));
      } catch (e) { console.log('TURBO_ERROR ' + e); }
      if (prevWs) { setWorkspace(prevWs); console.log('TURBO_RESTORED ' + prevWs); }
      else { getConfig().workspace = null; saveConfig(); }
      // remove the mock chat tab again
      const cfg2 = getConfig();
      cfg2.chats = cfg2.chats.filter((c) => c.id !== 'mockchat');
      delete cfg2.turbo.mockchat;
      if (cfg2.activeChat === 'mockchat') cfg2.activeChat = cfg2.chats[0] && cfg2.chats[0].id;
      saveConfig();
      if (chatMgr) chatMgr.remove('mockchat');
      console.log(ok ? 'TURBO_TEST_OK' : 'TURBO_TEST_FAILED');
      app.exit(ok ? 0 : 1);
    }, 6000);
  }
});

function urlFromReq(req) {
  return typeof req.url === 'string' ? req.url : req.url.toString();
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !SMOKE_TEST) createWindow(); });

/* ---------- IPC ---------- */
function registerIpc() {
  ipcMain.handle('cfg:get', () => ({ config: getConfig(), status: statusSnapshot() }));

  ipcMain.handle('ws:choose', async () => { try { return { root: await chooseWorkspace() }; } catch (e) { return { error: String(e.message || e) }; } });
  ipcMain.handle('ws:open', (e, dir) => { try { return { root: setWorkspace(dir) }; } catch (err) { return { error: String(err.message || err) }; } });

  ipcMain.handle('fs:readDir', (e, p) => wrap(() => fileops.listDir(getConfig().workspace, p)));
  ipcMain.handle('fs:read', (e, p) => wrap(() => fileops.readFile(getConfig().workspace, p)));
  ipcMain.handle('fs:write', (e, p, content) => wrap(() => fileops.writeFile(getConfig().workspace, p, content, { backupDir: path.join(app.getPath('userData'), 'backups') })));
  ipcMain.handle('fs:create', (e, p, type) => wrap(() => fileops.createEntry(getConfig().workspace, p, type)));
  ipcMain.handle('fs:delete', (e, p) => wrap(() => fileops.deleteEntry(getConfig().workspace, p)));
  ipcMain.handle('fs:search', (e, q, glob) => wrap(() => fileops.search(getConfig().workspace, q, glob)));

  ipcMain.on('chat:active', (e, id) => {
    const cfg = getConfig();
    cfg.activeChat = id;
    saveConfig();
    chatMgr && chatMgr.setActive(id, cfg.chats);
  });
  ipcMain.on('chat:bounds', (e, rect) => chatMgr && chatMgr.setBounds(rect));
  ipcMain.handle('chat:add', (e, name, url) => wrap(() => {
    const cfg = getConfig();
    if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http(s)://');
    const id = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'chat') + '-' + crypto.randomBytes(2).toString('hex');
    cfg.chats.push({ id, name, url });
    saveConfig();
    return { id };
  }));
  ipcMain.handle('chat:remove', (e, id) => wrap(() => {
    const cfg = getConfig();
    cfg.chats = cfg.chats.filter((c) => c.id !== id);
    delete cfg.zoom[id];
    if (cfg.activeChat === id) cfg.activeChat = cfg.chats[0] && cfg.chats[0].id;
    saveConfig();
    chatMgr.remove(id);
    return { ok: true };
  }));
  ipcMain.on('chat:action', (e, { id, act }) => {
    const cfg = getConfig();
    if (!chatMgr) return;
    if (act === 'reload') chatMgr.reload(id);
    if (act === 'zoomIn' || act === 'zoomOut') {
      const lvl = chatMgr.adjustZoom(id, act === 'zoomIn' ? 0.5 : -0.5);
      cfg.zoom[id] = lvl; saveConfig();
    }
    if (act === 'external') {
      const chat = cfg.chats.find((c) => c.id === id);
      if (chat) shell.openExternal(chat.url);
    }
  });

  ipcMain.handle('bridge:start', async () => { startAgentBridge(); return statusSnapshot(); });
  ipcMain.handle('bridge:stop', async () => stopAgentBridge());
  ipcMain.handle('tunnel:start', async () => { startAgentBridge(); return tunnel.start(); });
  ipcMain.handle('tunnel:stop', async () => { tunnel.stop(); return statusSnapshot(); });
  ipcMain.handle('bridge:toggleTool', (e, name, enabled) => wrap(() => {
    const cfg = getConfig();
    cfg.tools[name] = !!enabled;
    saveConfig();
    broadcast('status', statusSnapshot());
    return { ok: true };
  }));

  ipcMain.on('term:write', (e, { id, data }) => terminal && terminal.write(id, data));
  ipcMain.on('term:resize', (e, { id, cols, rows }) => terminal && terminal.resize(id, cols, rows));
  ipcMain.on('term:rebuild', (e, { id }) => terminal && terminal.rebuild(id));

  ipcMain.on('ui:layout', (e, sidebarW, chatdockW) => {
    const cfg = getConfig();
    cfg.layout = cfg.layout || {};
    if (sidebarW) cfg.layout.sidebarW = sidebarW;
    if (chatdockW) cfg.layout.chatdockW = chatdockW;
    saveConfig();
  });

  ipcMain.handle('turbo:toggle', (e, id, on) => wrap(() => {
    const cfg = getConfig();
    cfg.turbo = cfg.turbo || {};
    if (on) cfg.turbo[id] = true; else delete cfg.turbo[id];
    saveConfig();
    if (on && turbo) turbo.ensureInjected(id);
    return { enabled: !!cfg.turbo[id] };
  }));

  ipcMain.handle('skills:list', () => wrap(() => skills.list(getConfig().workspace)));
  ipcMain.handle('skills:create', (e, name) => wrap(async () => {
    const r = await skills.create(getConfig().workspace, name);
    audit('skill_create', { name: r.name }, r);
    return r;
  }));
  ipcMain.handle('skills:delete', (e, name) => wrap(() => skills.delete(getConfig().workspace, name)));
  ipcMain.handle('tasks:list', () => wrap(() => tasks.list(getConfig().workspace)));
  ipcMain.handle('tasks:create', (e, title) => wrap(async () => {
    const r = await tasks.create(getConfig().workspace, title);
    audit('task_create', { title, id: r.id }, r);
    return r;
  }));
  ipcMain.handle('tasks:update', (e, id, patch) => wrap(async () => {
    const r = await tasks.update(getConfig().workspace, id, patch || {});
    audit('task_update', { id, ...patch }, r);
    return r;
  }));

  ipcMain.on('app:devtools', () => { if (win) win.webContents.openDevTools({ mode: 'detach' }); });
}

async function wrap(fn) {
  try { return { ok: true, data: await fn() }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}
