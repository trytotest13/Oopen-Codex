'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),

  chooseFolder: () => ipcRenderer.invoke('ws:choose'),
  openWorkspace: (dir) => ipcRenderer.invoke('ws:open', dir),

  readDir: (p) => ipcRenderer.invoke('fs:readDir', p),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p, content) => ipcRenderer.invoke('fs:write', p, content),
  createEntry: (p, type) => ipcRenderer.invoke('fs:create', p, type),
  deleteEntry: (p) => ipcRenderer.invoke('fs:delete', p),
  search: (q, glob) => ipcRenderer.invoke('fs:search', q, glob),

  onWorkspace: (cb) => ipcRenderer.on('ws:changed', (e, payload) => cb(payload)),
  onAgentEvent: (cb) => ipcRenderer.on('agent:event', (e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('status', (e, payload) => cb(payload)),
  onChatStatus: (cb) => ipcRenderer.on('chat:status', (e, { id, ok }) => cb(id, ok)),
  setLayout: (sidebarW, chatdockW) => ipcRenderer.send('ui:layout', sidebarW, chatdockW),

  chat: {
    setActive: (id) => ipcRenderer.send('chat:active', id),
    setBounds: (rect) => ipcRenderer.send('chat:bounds', rect),
    add: (name, url) => ipcRenderer.invoke('chat:add', name, url),
    remove: (id) => ipcRenderer.invoke('chat:remove', id),
    action: (id, act) => ipcRenderer.send('chat:action', { id, act }),
  },
  turbo: {
    toggle: (id, on) => ipcRenderer.invoke('turbo:toggle', id, on),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    create: (name) => ipcRenderer.invoke('skills:create', name),
    delete: (name) => ipcRenderer.invoke('skills:delete', name),
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (title) => ipcRenderer.invoke('tasks:create', title),
    update: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
  },

  bridge: {
    start: () => ipcRenderer.invoke('bridge:start'),
    stop: () => ipcRenderer.invoke('bridge:stop'),
    tunnelStart: () => ipcRenderer.invoke('tunnel:start'),
    tunnelStop: () => ipcRenderer.invoke('tunnel:stop'),
    toggleTool: (name, enabled) => ipcRenderer.invoke('bridge:toggleTool', name, enabled),
  },

  term: {
    write: (id, data) => ipcRenderer.send('term:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    rebuild: (id) => ipcRenderer.send('term:rebuild', { id }),
    onData: (cb) => ipcRenderer.on('term:data', (e, { id, chunk }) => cb(id, chunk)),
  },

  devtools: () => ipcRenderer.send('app:devtools'),
});
