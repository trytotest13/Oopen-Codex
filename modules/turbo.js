'use strict';
/**
 * "Turbo" bridge: injects a tool protocol into a chat WebContentsView, watches the
 * model's replies for tool-call blocks, executes them via the local agent, and types
 * the results back into the composer. Works with any chat UI (Gemini, ChatGPT, Claude).
 *
 * NOTE: automating the chat web UIs is against both providers' terms of use — this is
 * opt-in per chat tab. Prefer the MCP-connector path (ChatGPT / Claude) when available.
 */
const path = require('path');
const skills = require('./skills');
const { runTool } = require('./tools');

function ocxInstaller(PROTOCOL) {
  if (window.__ocxInstalled) { window.__ocxProtocol = PROTOCOL; window.__ocxOn = true; return 'reinstalled'; }
  window.__ocxInstalled = true;
  window.__ocxOn = true;
  window.__ocxProtocol = PROTOCOL;
  const queue = [];
  const seen = new Set();

  function isVisible(e) { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 10; }
  function composer() {
    const els = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'));
    return els.find(isVisible) || null;
  }
  function readText(c) { return (c.tagName === 'TEXTAREA' || c.tagName === 'INPUT') ? c.value : (c.innerText || c.textContent || ''); }
  function setText(c, text) {
    c.focus();
    if (c.tagName === 'TEXTAREA' || c.tagName === 'INPUT') {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), 'value');
      if (d && d.set) d.set.call(c, text); else c.value = text;
      c.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }
  }
  function sendButton() {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
    return btns.find((b) => /send|submit/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')))
      || btns.find((b) => b.getAttribute('type') === 'submit')
      || null;
  }
  function doSend() {
    const b = sendButton();
    if (b) { b.click(); return true; }
    const c = composer();
    if (c) {
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return true;
    }
    return false;
  }
  window.__ocxUserSend = function (text) {
    const c = composer(); if (!c) return false;
    setText(c, text + '\n\n' + window.__ocxProtocol);
    setTimeout(doSend, 150);
    return true;
  };
  window.__ocxSend = function (text) {
    const c = composer(); if (!c) return false;
    setText(c, text);
    setTimeout(doSend, 150);
    return true;
  };
  // append the protocol to the user's outgoing message (capture phase runs before the app's handlers)
  function maybeAugment(target) {
    const c = composer();
    if (!c) return;
    if (!(target === c || (target.contains && c.contains !== undefined && (target === c || c.contains(target))))) return;
    const t = readText(c);
    if (t.trim() && !t.includes('[TOOL PROTOCOL')) setText(c, t + '\n\n' + window.__ocxProtocol);
  }
  document.addEventListener('keydown', (e) => {
    if (!window.__ocxOn || e.key !== 'Enter' || e.shiftKey) return;
    maybeAugment(e.target);
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (!window.__ocxOn) return;
    const b = e.target.closest && e.target.closest('button, [role="button"]');
    if (!b) return;
    const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
    if (/send|submit/i.test(label) || b.getAttribute('type') === 'submit') maybeAugment(b);
  }, true);
  // watch assistant output for tool calls: rendered code blocks (fences stripped) and raw text
  function scan() {
    for (const el of document.querySelectorAll('pre, code')) {
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 200000 || seen.has(t)) continue;
      if (t.startsWith('{')) {
        try {
          const j = JSON.parse(t);
          if (j && typeof j.tool === 'string') { seen.add(t); queue.push(j); }
        } catch {}
      }
    }
    const raw = document.body ? (document.body.innerText || '') : '';
    const re = /```ocx\s*\n?([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const t = m[1].trim();
      if (!t || seen.has(t)) continue;
      try {
        const j = JSON.parse(t);
        if (j && typeof j.tool === 'string') { seen.add(t); queue.push(j); }
      } catch {}
    }
  }
  const mo = new MutationObserver(() => scan());
  function startMo() { mo.observe(document.body, { childList: true, subtree: true, characterData: true }); }
  if (document.body) startMo(); else document.addEventListener('DOMContentLoaded', startMo);
  setInterval(scan, 1200);
  window.__ocxDrain = function () { scan(); return queue.splice(0, queue.length); };
  return 'installed';
}

const TOOL_BLOCK_HELP = 'To call a tool, reply with EXACTLY ONE fenced code block tagged ocx containing JSON like {"tool":"read_file","args":{"path":"package.json"}} — the block must start with three backticks then the word ocx, and end with three backticks. Output nothing else in that reply, then STOP and wait: the IDE executes it and sends back a message starting with [TOOL RESULT]. Never invent tool results. For ANY file work (create, edit, read files) use your tools instead of printing code.';

async function buildProtocol(root) {
  const name = root ? path.basename(root) : '(no folder open)';
  let skillSection = '';
  try { skillSection = await skills.protocolSection(root); } catch {}
  return '[TOOL PROTOCOL] You are connected to the user\'s IDE agent. Their project folder "' + name
    + '" is open and you can run these tools on their machine: get_workspace_info(), list_dir(path), list_tree(path,depth), read_file(path), search_code(query,glob), write_file(path,content), run_command(command), http_fetch(url,method,headers,body), list_skills(), get_skill(name), task_list(), task_create(title,status,notes), task_update(id,status), task_delete(id).\n'
    + 'For multi-step work, create the steps as tasks first (task_create) and keep their statuses updated with task_update (todo→doing→done) — the user watches a live board.\n'
    + TOOL_BLOCK_HELP + skillSection;
}

async function execTool(deps, call) {
  return runTool(deps, String(call.tool), call.args || {});
}

class TurboBridge {
  constructor(deps) {
    this.deps = deps; // { getView, getRoot, getToolFlags, getBackupDir, getConfig, audit }
    this.busy = new Set();
  }
  isEnabled(chatId) { const t = this.deps.getConfig().turbo; return !!(t && t[chatId]); }
  async ensureInjected(chatId) {
    const view = this.deps.getView(chatId);
    if (!view || view.webContents.isDestroyed()) return false;
    const proto = await buildProtocol(this.deps.getRoot());
    try {
      await view.webContents.executeJavaScript(`(${ocxInstaller.toString()})(${JSON.stringify(proto)})`, true);
      await view.webContents.executeJavaScript(`window.__ocxOn = ${this.isEnabled(chatId)}`, true);
      return true;
    } catch { return false; }
  }
  async tick(chatId) {
    if (!this.isEnabled(chatId) || this.busy.has(chatId)) return;
    const view = this.deps.getView(chatId);
    if (!view || view.webContents.isDestroyed()) return;
    this.busy.add(chatId);
    try {
      let calls = null;
      try { calls = await view.webContents.executeJavaScript('window.__ocxDrain ? window.__ocxDrain() : null', true); } catch {}
      if (!Array.isArray(calls)) return;
      for (const call of calls) {
        let result;
        try { result = await execTool(this.deps, call); }
        catch (e) {
          result = { error: String(e.message || e) };
          this.deps.audit('turbo:' + (call && call.tool), call && call.args, null, String(e.message || e));
        }
        const payload = '[TOOL RESULT] ' + JSON.stringify(result).slice(0, 50000)
          + '\nContinue the task: output the next ocx tool block if you need more tools, otherwise give the final answer.';
        try { await view.webContents.executeJavaScript(`window.__ocxSend ? window.__ocxSend(${JSON.stringify(payload)}) : false`, true); } catch {}
      }
    } finally { this.busy.delete(chatId); }
  }
}

module.exports = { TurboBridge, buildProtocol };
