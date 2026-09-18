import fs from 'node:fs';
import path from 'node:path';
import { contained, read, hash, loadLock } from './hub.mjs';

const roots = ['.agents/skills', '.cursor/skills', '.claude/skills'];
export function projectSkills(project, lock = loadLock(project)) {
  const skills = [], warnings = [];
  let count = 0;
  function walk(relative, depth = 0) {
    try {
      const directory = contained(project, relative);
      if (!fs.existsSync(directory)) return;
      if (depth > 8 || ++count > 2000) throw new Error('Слишком много папок или уровней вложенности.');
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      const entrypoint = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
      if (entrypoint) { add(relative, `${relative}/${entrypoint.name}`, 'SKILL.md'); return; }
      for (const entry of entries) {
        const file = `${relative}/${entry.name}`;
        if (entry.isSymbolicLink()) { warnings.push(`${file}: ссылка не открывается автоматически.`); continue; }
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (/\.mdc?$/i.test(entry.name)) add(file, file, 'Markdown');
      }
    } catch (error) { warnings.push(`${relative}: ${error.message}`); }
  }
  function add(relative, entrypoint, format) {
    const owner = lock?.files[entrypoint]?.module;
    skills.push({ path: relative, entrypoint, name: path.posix.basename(relative).replace(/\.mdc?$/i, ''), format,
      managed: !!owner, module: owner || null });
  }
  for (const root of roots) walk(root);
  return { skills: skills.sort((a, b) => a.path.localeCompare(b.path)), warnings };
}

export function projectSkill(project, relative) {
  const skill = projectSkills(project).skills.find(skill => skill.path === relative);
  if (!skill) throw new Error('Скилл проекта не найден. Обнови список.');
  return readInstruction(project, { ...skill, kind: 'skill' });
}
export function projectInstruction(project, relative) {
  const item = projectInstructions(project).instructions.find(item => item.path === relative);
  if (!item) throw new Error('Файл инструкций не найден. Обнови список.');
  return readInstruction(project, item);
}
function readInstruction(project, skill) {
  const relative = skill.path;
  const result = [];
  let total = 0;
  function visit(file) {
    const absolute = contained(project, file);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) visit(`${file}/${entry}`);
      return;
    }
    if (!stat.isFile()) throw new Error('Ожидался обычный файл скилла.');
    total += stat.size;
    if (result.length >= 2000 || total > 20 * 1024 * 1024) throw new Error('Скилл превышает 20 МБ или 2000 файлов.');
    const bytes = read(project, file);
    let content = null;
    if (bytes.length <= 500_000) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (content.includes('\0')) content = null; } catch {}
    }
    result.push({ path: file, size: bytes.length, content, hash: hash(bytes) });
  }
  visit(relative);
  result.sort((a, b) => a.path === skill.entrypoint ? -1 : b.path === skill.entrypoint ? 1 : a.path.localeCompare(b.path));
  return { ...skill, files: result, revision: hash(JSON.stringify(result.map(file => [file.path, file.hash]))) };
}

export function projectInstructions(project, lock = loadLock(project)) {
  const discovered = projectSkills(project, lock);
  const instructions = discovered.skills.map(item => ({ ...item, kind: 'skill' }));
  const warnings = [...discovered.warnings], seen = new Set(instructions.map(item => item.path.toLowerCase()));
  let visited = 0;
  function add(file, kind) {
    if (seen.has(file.toLowerCase())) return;
    seen.add(file.toLowerCase());
    const module = lock?.files[file]?.module;
    instructions.push({ path: file, entrypoint: file, kind, name: path.posix.basename(file).replace(/\.mdc?$/i, ''),
      format: file.endsWith('.mdc') ? 'Cursor MDC' : 'Markdown', managed: !!module, module: module || null });
  }
  function walk(root, kind, depth = 0) {
    try {
      if (++visited > 3000 || depth > 12) throw new Error('Слишком много папок инструкций.');
      const directory = contained(project, root);
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = root + '/' + entry.name;
        if (entry.isSymbolicLink()) { warnings.push(file + ': ссылка не открывается автоматически.'); continue; }
        if (entry.isDirectory()) walk(file, kind, depth + 1);
        else if (entry.isFile() && /\.mdc?$/i.test(entry.name)) add(file, kind);
      }
    } catch (error) { warnings.push(root + ': ' + error.message); }
  }
  for (const root of ['.cursor/rules', '.agents/rules', '.claude/rules']) walk(root, 'rule');
  for (const root of ['.agents/agents', '.agents/roles', '.cursor/agents', '.cursor/roles', '.claude/agents', 'agents', 'roles']) walk(root, 'role');
  for (const file of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    try { const absolute = contained(project, file); if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) add(file, 'rule'); }
    catch (error) { warnings.push(file + ': ' + error.message); }
  }
  // Include installed and historical hub layouts without scanning unrelated project directories.
  try {
    const root = contained(project, '.agents/skill-hub');
    if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      walk('.agents/skill-hub/' + entry.name + '/rules', 'rule');
      walk('.agents/skill-hub/' + entry.name + '/agents', 'role');
    }
  } catch (error) { warnings.push(error.message); }
  return { instructions: instructions.sort((a, b) => a.path.localeCompare(b.path)), warnings };
}
