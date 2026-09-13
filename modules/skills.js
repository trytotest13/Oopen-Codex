'use strict';
/** Markdown "skills": project conventions the agent must follow. No coding — just .md files. */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const fileops = require('./fileops');

const SKILLS_DIR = '.agent/skills';
const MAX_SKILLS = 20;
const MAX_SKILL_BYTES = 32 * 1024;

function skillsRoot(root) { return fileops.safeJoin(root, SKILLS_DIR); }

function safeName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '').replace(/\s+/g, '-');
  if (!n) throw new Error('Skill name must contain letters or numbers.');
  return n;
}

async function list(root) {
  const dir = skillsRoot(root);
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return { skills: [] }; }
  const skills = [];
  for (const e of entries.filter((e) => e.isFile() && e.name.endsWith('.md')).slice(0, MAX_SKILLS)) {
    let size = 0;
    try { size = (await fsp.stat(path.join(dir, e.name))).size; } catch {}
    skills.push({ name: e.name.replace(/\.md$/, ''), file: SKILLS_DIR + '/' + e.name, size });
  }
  return { skills, dir: SKILLS_DIR };
}

async function read(root, name) {
  const n = safeName(name);
  const file = fileops.safeJoin(root, SKILLS_DIR + '/' + n + '.md');
  const content = await fsp.readFile(file, 'utf8');
  return { name: n, content };
}

async function listDetailed(root) {
  const { skills } = await list(root);
  const out = [];
  for (const s of skills) {
    let content = '';
    try { content = (await fsp.readFile(fileops.safeJoin(root, s.file), 'utf8')).slice(0, MAX_SKILL_BYTES); } catch {}
    out.push({ name: s.name, size: s.size, content });
  }
  return { skills: out, hint: 'Follow these user-authored conventions. Use get_skill(name) for the full text if truncated.' };
}

/** Compact section for the Turbo protocol / MCP instructions. '' when no skills exist. */
async function protocolSection(root) {
  let detailed;
  try { detailed = await listDetailed(root); } catch { return ''; }
  if (!detailed.skills.length) return '';
  let out = '\n\n## PROJECT SKILLS (user-authored rules — follow them strictly)\n';
  let budget = 6000;
  for (const s of detailed.skills) {
    if (budget <= 0) { out += `\n### ${s.name}\n(truncated — get_skill("${s.name}"))`; break; }
    const body = s.content.slice(0, Math.min(800, budget));
    out += `\n### ${s.name}\n${body}${s.content.length > body.length ? '\n(truncated — get_skill)' : ''}\n`;
    budget -= body.length;
  }
  return out;
}

const TEMPLATE = (name) => `---
description: What this skill teaches the agent
---

# ${name}

Write the rules the agent must follow for this project here, e.g.:

- Always use TypeScript strict mode
- Run \`npm test\` after every change
- Commit messages follow Conventional Commits
`;

async function create(root, name) {
  const n = safeName(name);
  const file = fileops.safeJoin(root, SKILLS_DIR + '/' + n + '.md');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, TEMPLATE(n), 'utf8');
  return { name: n, file: SKILLS_DIR + '/' + n + '.md' };
}

async function remove(root, name) {
  const n = safeName(name);
  const file = fileops.safeJoin(root, SKILLS_DIR + '/' + n + '.md');
  await fsp.rm(file, { force: true });
  return { deleted: n };
}

module.exports = { list, read, listDetailed, protocolSection, create, remove };
