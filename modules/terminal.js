'use strict';
/**
 * Simple line-mode terminal: PowerShell/cmd via stdin pipe (no node-pty dependency).
 * Interactive TUIs won't work, but everyday commands do.
 */
const { spawn } = require('child_process');
const os = require('os');

class TerminalManager {
  constructor({ getRoot, onData }) {
    this.getRoot = getRoot;
    this.onData = onData;
    this.terms = new Map(); // id -> { child, line }
  }

  spawn(id) {
    this.kill(id);
    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const args = isWin ? ['-NoLogo', '-NoProfile', '-Command', '-'] : ['--norc', '-i'];
    const child = spawn(shellCmd, args, {
      cwd: this.getRoot() || os.homedir(),
      windowsHide: true,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'xterm-256color', NO_COLOR: '1' },
    });
    const term = { child, line: '' };
    this.terms.set(id, term);
    const push = (chunk) => this.onData(id, chunk);
    child.stdout.on('data', (d) => push(d.toString('utf8')));
    child.stderr.on('data', (d) => push(d.toString('utf8')));
    child.on('exit', (code) => { if (this.terms.get(id) === term) { push(`\r\n[process exited with code ${code}]\r\n`); this.terms.delete(id); } });
    push(isWin
      ? 'OpenCodex terminal (PowerShell line mode). Type a command and press Enter. Ctrl+Enter rebuilds.\r\n'
      : 'OpenCodex terminal (shell line mode).\r\n');
    return term;
  }

  write(id, data) {
    let term = this.terms.get(id);
    if (!term || term.child.killed) term = this.spawn(id);
    for (const ch of String(data)) {
      if (ch === '\r') {
        this.onData(id, '\r\n');
        const line = term.line;
        term.line = '';
        if (line.trim()) { try { term.child.stdin.write(line + '\n'); } catch {} }
      } else if (ch === '\x7f') {
        if (term.line.length) { term.line = term.line.slice(0, -1); this.onData(id, '\b \b'); }
      } else if (ch === '\x03') {
        term.line = '';
        this.onData(id, '^C\r\n');
      } else if (ch >= ' ' || ch === '\t') {
        term.line += ch;
        this.onData(id, ch);
      }
    }
  }

  resize(id, cols, rows) {
    // the fit observer fires on boot — use it as the eager spawn trigger
    if (!this.terms.get(id)) this.spawn(id);
  }
  rebuild(id) { this.spawn(id); }
  kill(id) {
    const t = this.terms.get(id);
    if (t) { try { t.child.kill(); } catch {} this.terms.delete(id); }
  }
  dispose() { for (const id of [...this.terms.keys()]) this.kill(id); }
}

module.exports = { TerminalManager };
