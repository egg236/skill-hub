import fs from 'node:fs';
import path from 'node:path';
import { contained, read, hash, loadLock, splitBlock } from './hub.mjs';
import { jsonBytes, localModule, localVersions } from './module-history.mjs';
import { projectInstruction } from './project-skills.mjs';
import { payloadFor } from './conversion-format.mjs';
import { sourceMatches } from './conversion-origin.mjs';

// Backups contain base64 in JSON, so no archived SKILL.md or rule is discoverable.
export function archiveSources(project, sources, includeAgents = false) {
  const unique = new Map();
  for (const file of sources) {
    if (file.file === 'AGENTS.md' && !includeAgents) continue;
    const previous = unique.get(file.file);
    if (previous && !previous.data.equals(file.data)) throw new Error('Исходник указан с разным содержимым: ' + file.file);
    unique.set(file.file, file);
  }
  const items = [...unique.values()].sort((a, b) => a.file.localeCompare(b.file));
  if (!items.length) return { writes: [], files: [], archive: null };
  const bytes = jsonBytes({ schema: 1, kind: 'instruction-migration', files: items.map(file => ({ path: file.file, data: file.data.toString('base64') })) });
  const archive = '.skill-hub/migration-backups/' + hash(bytes) + '.json';
  const existing = read(project, archive);
  if (existing && !existing.equals(bytes)) throw new Error('Резервный архив изменён: ' + archive);
  return { writes: existing ? [] : [{ file: archive, data: bytes }], files: items, archive };
}

function legacyMapping(project, module, item, source) {
  // Recover exact mappings from the original immutable conversion version.
  for (const version of localVersions(project, module.id).slice().reverse()) {
    const original = localModule(project, module.id, version);
    if (!original.origin?.importedFrom?.some(entry => entry.path === source.path && entry.revision === source.revision)) continue;
    const prefix = item.kind === 'skill' ? 'skills/' : item.kind === 'rule' ? 'rules/' : 'agents/';
    const names = [...new Set(original.payload.filter(file => file.source.startsWith(prefix)).map(file =>
      item.kind === 'skill' ? file.source.split('/')[1] : path.posix.basename(file.source).replace(/\.mdc?$/, '')))];
    for (const name of names) {
      const proposed = payloadFor(project, item, name, original.description);
      if (proposed.every(file => original.payload.some(saved => saved.source === file.source && saved.data.equals(file.data)))) {
        return proposed.map(file => ({ path: file.original, source: file.source }));
      }
    }
  }
  throw new Error('Не удалось подтвердить замену исходника в модуле: ' + item.path + '. Открой модуль и проверь состав.');
}

export function migrationSources(project, modules) {
  const lock = loadLock(project), sources = [], preserved = [], replacements = [], aliases = new Map();
  for (const module of modules) for (const source of module.origin?.importedFrom || []) {
    if (source.path === 'AGENTS.md') { preserved.push(source.path); continue; }
    const payload = module.allPayload || module.payload;
    for (const entry of source.files || []) {
      const target = payload.find(file => file.source === entry.source)?.target;
      if (target && entry.path !== target) aliases.set(entry.path, target);
    }
    const absolute = contained(project, source.path);
    if (!fs.existsSync(absolute)) continue;
    const item = projectInstruction(project, source.path);
    if (item.managed && item.module === module.id) continue;
    if (item.managed || item.files.some(file => lock?.files[file.path])) throw new Error('Исходник уже принадлежит другому модулю: ' + source.path);
    if (!sourceMatches(item, module, source)) throw new Error('Исходник изменился после преобразования: ' + source.path + '. Сохрани правки в модуле перед переносом.');
    const mapping = source.files || legacyMapping(project, module, item, source);
    for (const entry of mapping) {
      const target = payload.find(file => file.source === entry.source)?.target;
      if (target && entry.path !== target) aliases.set(entry.path, target);
    }
    if (mapping.length !== item.files.length || item.files.some(file => !mapping.some(entry => entry.path === file.path && payload.some(saved => saved.source === entry.source)))) {
      throw new Error('В модуле нет замены для всех файлов: ' + source.path + '. Исходники сохранены.');
    }
    for (const file of item.files) {
      const replacement = payload.find(saved => saved.source === mapping.find(entry => entry.path === file.path).source);
      const data = read(project, file.path);
      sources.push({ file: file.path, data, target: replacement.target });
      if (!replacement.data.equals(data)) replacements.push({ file: replacement.target, action: 'update', before: file.content,
        after: file.content === null ? null : replacement.data.toString('utf8') });
    }
  }
  return { ...archiveSources(project, sources), preserved: [...new Set(preserved)], replacements, aliases };
}

export function pruneSourceDirectories(project, files) {
  const root = fs.realpathSync(project);
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory !== '.' && directory.includes('/')) {
      const absolute = contained(root, directory);
      if (!absolute.startsWith(root + path.sep)) throw new Error('Папка вне проекта.');
      try {
        if (!fs.existsSync(absolute) || fs.readdirSync(absolute).length) break;
        fs.rmdirSync(absolute); // Empty directories only; never recursive.
      } catch { break; }
      directory = path.posix.dirname(directory);
    }
  }
}

export function redirectAgentLinks(project, migration, changes) {
  if (!migration.aliases.size) return;
  const original = read(project, 'AGENTS.md');
  if (!original) return;
  const change = changes.find(change => change.file === 'AGENTS.md');
  const text = (change?.data || original).toString('utf8');
  const parts = splitBlock(text);
  const rewrite = value => {
    // Match complete relative paths; never change a similar filename or the generated block.
    for (const [from, to] of [...migration.aliases].sort(([a], [b]) => b.length - a.length)) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      value = value.replace(new RegExp('(?<![\\w/.-])' + escaped + '(?![\\w/.-])', 'g'), () => to);
    }
    return value;
  };
  const before = parts.before + parts.after;
  const after = rewrite(parts.before) + rewrite(parts.after);
  if (before === after) return;
  const data = Buffer.from(rewrite(parts.before) + parts.block + rewrite(parts.after));
  if (change) change.data = data;
  else changes.push({ file: 'AGENTS.md', action: 'update', data });
  const backup = archiveSources(project, [{ file: 'AGENTS.md', data: original }], true);
  migration.writes.push(...backup.writes);
  migration.agentArchive = backup.archive;
  migration.agentLinks = { before, after };
}
