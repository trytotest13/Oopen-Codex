'use strict';
/**
 * Starts a cloudflared quick tunnel to expose the local MCP server with a public
 * HTTPS URL. Downloads cloudflared on demand (Windows) if not on PATH.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class TunnelManager {
  constructor({ getPort, onChange }) {
    this.getPort = getPort;
    this.onChange = onChange || (() => {});
    this.child = null;
    this.url = null;
    this.err = null;
  }

  status() { return { running: !!(this.child && !this.child.killed && this.url !== false), url: this.url || null, error: this.err, downloading: this.downloading || false }; }

  binPath() {
    const candidates = [];
    if (process.platform === 'win32') {
      candidates.push(path.join(this.userDataDir(), 'cloudflared.exe'));
    } else {
      candidates.push('/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared');
    }
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
    const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared']);
    if (lookup.status === 0) {
      const first = lookup.stdout.toString().split(/\r?\n/)[0].trim();
      if (first) return first;
    }
    return process.platform === 'win32' ? path.join(this.userDataDir(), 'cloudflared.exe') : 'cloudflared';
  }

  userDataDir() { const { app } = require('electron'); return app.getPath('userData'); }

  async download() {
    if (process.platform !== 'win32') throw new Error('cloudflared not found. Install it (brew install cloudflared / apt install cloudflared) and retry.');
    this.downloading = true;
    this.onChange();
    const dest = path.join(this.userDataDir(), 'cloudflared.exe');
    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    const { net } = require('electron');
    const res = await net.fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('cloudflared download failed: HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    this.downloading = false;
    this.onChange();
    return dest;
  }

  async start() {
    if (this.child) return this.status();
    this.err = null;
    this.url = null;
    let bin = this.binPath();
    if (!fs.existsSync(bin) && process.platform === 'win32') {
      try { bin = await this.download(); }
      catch (e) { this.err = String(e.message || e); this.onChange(); return this.status(); }
    }
    if (!fs.existsSync(bin)) {
      this.err = 'cloudflared is not installed. Install it and retry.';
      this.onChange();
      return this.status();
    }
    const args = ['tunnel', '--url', `http://127.0.0.1:${this.getPort()}`, '--no-autoupdate'];
    this.child = spawn(bin, args, { windowsHide: true });
    const scan = (d) => {
      const s = d.toString();
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !this.url) { this.url = m[0]; this.onChange(); }
      if (/failed|error/i.test(s) && !this.url) { this.err = s.trim().slice(0, 300); this.onChange(); }
    };
    this.child.stdout.on('data', scan);
    this.child.stderr.on('data', scan);
    this.child.on('exit', () => { this.child = null; this.url = null; this.onChange(); });
    this.onChange();
    return this.status();
  }

  stop() {
    if (this.child) { try { this.child.kill(); } catch {} }
    this.child = null;
    this.url = null;
    this.onChange();
    return this.status();
  }
}

module.exports = { TunnelManager };
