import fs from 'node:fs';
import { migrationSources, pruneSourceDirectories, redirectAgentLinks } from './project-migration.mjs';
import { selectModule } from './module-choices.mjs';
import { contained, files, read, hash, loadLock, plan, apply } from './hub.mjs';
import { resolveModules, moduleRevision, packModule, unpackModule, nextLocal, changesBetween, jsonBytes, history, localModule } from './module-history.mjs';

export function projectConflicts(project, selected) {
  const lock = loadLock(project);
  return selected.flatMap(module => module.payload.flatMap(file => {
    if (lock?.files[file.target]) return [];
    const current = read(project, file.target);
    return current === null ? [] : [{ module: module.id, file: file.target, identical: current.equals(file.data) }];
  }));
}

export function adoptionPreview(base, project, repo, inputs, { keepInstalled = false, allowNoConflicts = false, migrateIds = [] } = {}) {
  const lock = loadLock(project);
  const original = resolveModules(base, project, inputs).map(module => {
    const previous = keepInstalled && lock?.modules.find(item => item.id === module.id);
    return previous ? { ...module, source: previous.source, pinned: previous.pinned } : module;
  });
  const migration = migrationSources(project, original.filter(module => migrateIds.includes(module.id)));
  const migrating = new Set(migration.files.map(file => file.file));
  const conflicts = projectConflicts(project, original).filter(file => !migrating.has(file.file));
  if (!conflicts.length && !allowNoConflicts) throw new Error('Совпадений с файлами проекта больше нет. Обнови предпросмотр.');
  const conflictingIds = new Set(conflicts.map(item => item.module));
  const adopted = new Map();
  const variants = [];
  const selected = original.map(module => {
    if (!conflictingIds.has(module.id)) return module;
    const payload = new Map((module.allPayload || module.payload).map(file => [file.source, file]));
    const roots = new Map();
    for (const file of module.payload) {
      if (file.target.startsWith(`.cursor/rules/skill-hub/${module.id}/`)) roots.set(`.cursor/rules/skill-hub/${module.id}`, 'rules/');
      else if (file.target.startsWith(`.agents/skill-hub/${module.id}/`)) roots.set(`.agents/skill-hub/${module.id}`, '');
    }
    for (const file of module.payload) if (file.source.startsWith('skills/')) {
      const skill = file.source.split('/')[1];
      roots.set(`.agents/skills/${skill}`, `skills/${skill}/`);
    }
    for (const [root, sourcePrefix] of roots) for (const file of files(project, root)) {
      if (lock?.files[file] || migrating.has(file)) continue;
      const data = read(project, file);
      const source = sourcePrefix + file.slice(root.length + 1);
      payload.set(source, { source, target: file, data });
      adopted.set(file, hash(data));
    }
    const merged = unpackModule(packModule({ ...module, allPayload: undefined, payload: [...payload.values()] }));
    const local = selectModule(nextLocal(project, merged, repo), module.selectedChoices);
    variants.push({ module: local, differences: changesBetween(module, local) });
    return local;
  });
  // Ordinary adoption keeps identical bytes. Migration permits only reviewed before/after hashes backed by an archive.
  const targets = new Map(selected.flatMap(module => module.payload.map(file => [file.target, hash(file.data)])));
  const migrated = new Map(migration.files.filter(file => targets.has(file.file)).map(file => [file.file, { before: hash(file.data), after: targets.get(file.file) }]));
  const changes = plan(project, selected, adopted, migrated);
  for (const file of migration.files) if (!targets.has(file.file)) changes.push({ file: file.file, action: 'remove', data: null });
  redirectAgentLinks(project, migration, changes);
  const snapshots = variants.map(({ module }) => {
    const file = `.skill-hub/variants/${module.id}/${module.version}.json`;
    if (fs.existsSync(contained(project, file))) throw new Error('Версия проекта уже существует. Обнови предпросмотр.');
    return { file, action: 'create', data: jsonBytes(packModule(module)) };
  });
  const fingerprint = hash(jsonBytes([project, repo, selected.map(moduleRevision), [...adopted],
    read(project, '.agents/skill-hub.lock.json')?.toString('base64'), read(project, 'AGENTS.md')?.toString('base64'),
    migration.files.map(file => [file.file, hash(file.data)]), migration.archive,
    [...snapshots, ...changes].map(change => [change.file, change.action, change.data === null ? null : hash(change.data)])]));
  return { selected, variants, conflicts, adopted, changes, snapshots, fingerprint, migration };
}

export function adoptProjectFiles(base, project, repo, inputs, fingerprint) {
  const preview = adoptionPreview(base, project, repo, inputs);
  if (!fingerprint || fingerprint !== preview.fingerprint) throw new Error('Предпросмотр устарел. Сравни файлы ещё раз.');
  for (const module of preview.selected) if (module.source !== 'project') history(base).checkpoint(module);
  apply(project, [...preview.migration.writes, ...preview.snapshots, ...preview.changes]);
  pruneSourceDirectories(project, preview.migration.files.map(file => file.file));
}

export function connectionPreview(base, project, repo, ids, { cleanup = false } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Выбери от 1 до 50 проектных модулей без повторов.');
  const installed = loadLock(project)?.modules || [];
  const additions = ids.map(id => {
    if (installed.some(module => module.id === id)) {
      if (cleanup) return null;
      throw new Error('Модуль уже подключён: ' + id + '. Обнови список.');
    }
    if (cleanup) throw new Error('Сначала подключи модуль: ' + id);
    const module = localModule(project, id);
    return { id, source: 'project', version: module.version };
  });
  // Exact installed versions and pin settings survive this additive operation.
  return adoptionPreview(base, project, repo, [...installed, ...additions.filter(Boolean)], { keepInstalled: true, allowNoConflicts: true, migrateIds: ids });
}

export function connectProjectFiles(base, project, repo, ids, fingerprint, options) {
  const preview = connectionPreview(base, project, repo, ids, options);
  if (!fingerprint || fingerprint !== preview.fingerprint) throw new Error('Предпросмотр устарел. Сравни файлы ещё раз.');
  apply(project, [...preview.migration.writes, ...preview.snapshots, ...preview.changes]);
  pruneSourceDirectories(project, preview.migration.files.map(file => file.file));
}
