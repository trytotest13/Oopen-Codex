'use strict';
/** Shared task board state, stored in the workspace at .agent/tasks.json.
 *  The agent (web chat) manages tasks via tools; the IDE renders the live Kanban board. */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const fileops = require('./fileops');

const FILE = '.agent/tasks.json';
const STATUSES = ['todo', 'doing', 'done'];
const MAX_TASKS = 200;

function fileFor(root) { return fileops.safeJoin(root, FILE); }

async function load(root) {
  try {
    const j = JSON.parse(await fsp.readFile(fileFor(root), 'utf8'));
    if (Array.isArray(j.tasks)) return j.tasks.filter((t) => t && t.id && STATUSES.includes(t.status));
  } catch {}
  return [];
}

async function save(root, tasks) {
  const file = fileFor(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ tasks }, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return { tasks };
}

async function list(root) {
  const tasks = await load(root);
  return { tasks, statuses: STATUSES };
}

async function create(root, title, status = 'todo', notes = '') {
  if (!String(title || '').trim()) throw new Error('title is required');
  if (!STATUSES.includes(status)) throw new Error('status must be one of ' + STATUSES.join(', '));
  const tasks = await load(root);
  if (tasks.length >= MAX_TASKS) throw new Error('too many tasks (max ' + MAX_TASKS + ')');
  const now = new Date().toISOString();
  const task = {
    id: 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title: String(title).slice(0, 200),
    status,
    notes: String(notes || '').slice(0, 2000),
    created: now,
    updated: now,
  };
  tasks.push(task);
  await save(root, tasks);
  return task;
}

async function update(root, id, patch = {}) {
  const tasks = await load(root);
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error('no task with id ' + id);
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new Error('status must be one of ' + STATUSES.join(', '));
    t.status = patch.status;
  }
  if (patch.title !== undefined) t.title = String(patch.title).slice(0, 200);
  if (patch.notes !== undefined) t.notes = String(patch.notes).slice(0, 2000);
  t.updated = new Date().toISOString();
  await save(root, tasks);
  return t;
}

async function remove(root, id) {
  const tasks = await load(root);
  const next = tasks.filter((x) => x.id !== id);
  if (next.length === tasks.length) throw new Error('no task with id ' + id);
  await save(root, next);
  return { deleted: id };
}

module.exports = { list, create, update, remove, STATUSES };
