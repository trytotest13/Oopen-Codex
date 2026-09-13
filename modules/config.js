'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let cfg = null;
let file = null;

const DEFAULTS = () => ({
  workspace: null,
  port: 8787,
  token: crypto.randomBytes(12).toString('hex'),
  activeChat: 'chatgpt',
  zoom: {},
  tools: { run_command: false },
  turbo: {},
  chats: [
    { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
    { id: 'claude', name: 'Claude', url: 'https://claude.ai/' },
    { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' },
  ],
});

function initConfig() {
  const { app } = require('electron');
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'config.json');
  let loaded = {};
  try { loaded = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  cfg = Object.assign(DEFAULTS(), loaded);
  cfg.tools = Object.assign({ run_command: false }, loaded.tools);
  if (!Array.isArray(cfg.chats) || cfg.chats.length === 0) cfg.chats = DEFAULTS().chats;
  saveConfig();
  return cfg;
}
function getConfig() { return cfg; }
function saveConfig() { try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch {} }

module.exports = { initConfig, getConfig, saveConfig };
