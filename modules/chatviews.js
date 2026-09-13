'use strict';
const { WebContentsView, BrowserWindow, session, shell } = require('electron');

const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media', 'audioCapture', 'videoCapture']);

class ChatViewManager {
  constructor({ getWin, onStatus, onNewSession }) {
    this.getWin = getWin;
    this.onStatus = onStatus || (() => {});
    this.onNewSession = onNewSession || (() => {});
    this.sessionsDone = new Set();
    this.views = new Map(); // id -> WebContentsView
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.activeId = null;
  }

  ensure(chat) {
    let view = this.views.get(chat.id);
    if (view && !view.webContents.isDestroyed()) return view;
    view = new WebContentsView({
      webPreferences: {
        partition: `persist:chat-${chat.id}`,
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    const ses = view.webContents.session;
    if (!this.sessionsDone.has(ses)) {
      this.sessionsDone.add(ses);
      ses.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
      this.onNewSession(ses); // register custom protocols (app://) on this partition too
    }
    // OAuth popups need the same session; open everything else in the user's browser
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        const w = new BrowserWindow({ autoHideMenuBar: true, width: 520, height: 700, webPreferences: { partition: `persist:chat-${chat.id}`, sandbox: true } });
        w.loadURL(url);
      } else {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    view.webContents.on('did-finish-load', () => this.onStatus(chat.id, true));
    view.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) this.onStatus(chat.id, false); });
    view.webContents.loadURL(chat.url).catch(() => {});
    this.views.set(chat.id, view);
    return view;
  }

  setActive(id, chats) {
    const win = this.getWin();
    if (!win) return;
    const chat = (chats || []).find((c) => c.id === id);
    if (!chat) return;
    if (this.activeId && this.activeId !== id) {
      const prev = this.views.get(this.activeId);
      try { win.contentView.removeChildView(prev); } catch {}
    }
    this.activeId = id;
    const view = this.ensure(chat);
    win.contentView.addChildView(view);
    this.applyBounds();
  }

  setBounds(rect) {
    this.bounds = rect || { x: 0, y: 0, width: 0, height: 0 };
    this.applyBounds();
  }

  applyBounds() {
    const win = this.getWin();
    if (!win) return;
    const view = this.activeId && this.views.get(this.activeId);
    const b = this.bounds;
    if (!view) return;
    if (!b || b.width <= 1 || b.height <= 1) {
      try { win.contentView.removeChildView(view); } catch {}
      return;
    }
    try {
      win.contentView.addChildView(view);
      view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
      view.setVisible(true);
    } catch {}
  }

  getView(id) { return this.views.get(id) || null; }

  reload(id) {
    const v = this.views.get(id);
    if (v && !v.webContents.isDestroyed()) v.webContents.reload();
  }

  adjustZoom(id, delta) {
    const v = this.views.get(id);
    if (!v || v.webContents.isDestroyed()) return 0;
    const lvl = Math.max(-5, Math.min(5, v.webContents.getZoomLevel() + delta));
    v.webContents.setZoomLevel(lvl);
    return lvl;
  }

  applyZoom(id, level) {
    const v = this.views.get(id);
    if (v && !v.webContents.isDestroyed()) v.webContents.setZoomLevel(level);
  }

  remove(id) {
    const win = this.getWin();
    const v = this.views.get(id);
    if (win && v) { try { win.contentView.removeChildView(v); } catch {} }
    this.views.delete(id);
    if (this.activeId === id) this.activeId = null;
  }
}

module.exports = { ChatViewManager };
