import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { payloadTarget, validateCursorRule } from './cursor-rules.mjs';
import { validateChoices, choiceSelection, selectModule } from './module-choices.mjs';
import { catalog, contained, files, read, hash, json, loadLock, selection, apply, cursorIgnoreChanges } from './hub.mjs';

const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-r[1-9]\d*)?$/;
const fail = message => { throw new Error(message); };
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export function moduleManifest(module) {
  return { schema: 1, id: module.id, version: module.version, description: module.description, ...(module.family ? { family: module.family } : {}), ...(module.choices?.length ? { choices: module.choices } : {}) };
}
export function moduleRevision(module) {
  return hash(jsonBytes([moduleManifest(module), (module.allPayload || module.payload).map(file => [file.source, hash(file.data)]).sort((a, b) => a[0].localeCompare(b[0]))]));
}
export function packModule(module, origin = module.origin) {
  return { schema: 1, manifest: moduleManifest(module), group: module.group || 'custom', ...(origin ? { origin } : {}),
    files: (module.allPayload || module.payload).map(file => ({ path: file.source, data: file.data.toString('base64') })).sort((a, b) => a.path.localeCompare(b.path)) };
}
export function unpackModule(snapshot) {
  const manifest = snapshot?.manifest;
  if (snapshot?.schema !== 1 || !manifest || manifest.schema !== 1 || typeof manifest.id !== 'string' || !identifier.test(manifest.id) || typeof manifest.version !== 'string' || !versionPattern.test(manifest.version) ||
      typeof manifest.description !== 'string' || !manifest.description.trim() || /[\r\n\0]/.test(manifest.description) ||
      (manifest.family !== undefined && (typeof manifest.family !== 'string' || !identifier.test(manifest.family))) || typeof snapshot.group !== 'string' || !identifier.test(snapshot.group) || !Array.isArray(snapshot.files)) fail('Повреждён снимок модуля.');
  if (Object.keys(manifest).some(key => !['schema', 'id', 'version', 'description', 'family', 'choices'].includes(key))) fail('Неизвестные поля manifest.');
  const seen = new Set();
  let total = 0;
  const payload = snapshot.files.map(file => {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part)) ||
        !(/^(?:rules\/[a-z0-9-]+\.mdc?|agents\/[a-z0-9-]+\.md)$/.test(file.path) || /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/.+/.test(file.path))) fail(`Неверный путь модуля: ${file.path}`);
    if (seen.has(file.path.toLowerCase())) fail(`Повторяющийся файл: ${file.path}`);
    seen.add(file.path.toLowerCase());
    if (typeof file.data !== 'string' || file.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.data)) fail('Неверное содержимое снимка.');
    const data = Buffer.from(file.data, 'base64');
    if (data.toString('base64') !== file.data) fail('Неверное содержимое снимка.');
    total += data.length;
    if (total > 32 * 1024 * 1024 || seen.size > 4000) fail('Модуль превышает 32 МБ или 4000 файлов.');
    validateCursorRule(file.path, data);
    return { source: file.path, target: payloadTarget(manifest.id, file.path), data };
  });
  if (!payload.length) fail('Пустой модуль.');
  for (const skill of new Set(payload.filter(file => file.source.startsWith('skills/')).map(file => file.source.split('/')[1]))) {
    const text = payload.find(file => file.source === `skills/${skill}/SKILL.md`)?.data.toString('utf8').replace(/\r\n/g, '\n');
    if (!text?.startsWith('---\n') || !text.includes(`\nname: ${skill}\n`) || !/\ndescription: .+\n/.test(text) || text.indexOf('\n---\n', 4) < 0) fail(`Некорректный SKILL.md: ${skill}`);
  }
  validateChoices({ ...manifest, payload });
  return { ...manifest, group: snapshot.group, origin: snapshot.origin, payload, location: `modules/${snapshot.group}/${manifest.id}` };
}
function versionFile(root, folder, id, version) {
  if (!identifier.test(id) || !versionPattern.test(version)) fail('Неверный ID или номер версии.');
  return contained(root, `${folder}/${id}/${version}.json`);
}
function immutable(root, folder, module, origin) {
  const target = versionFile(root, folder, module.id, module.version);
  const snapshot = packModule(module, origin);
  unpackModule(snapshot);
  if (fs.existsSync(target)) {
    if (moduleRevision(unpackModule(json(target))) !== moduleRevision(module)) fail(`Версия ${module.id}@${module.version} уже сохранена с другим содержимым.`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = contained(root, `${folder}/${module.id}/.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, jsonBytes(snapshot), { flag: 'wx' });
    // Hard-link publication is atomic and refuses to overwrite an existing version.
    fs.linkSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function readVersion(root, folder, id, version) {
  const module = unpackModule(json(versionFile(root, folder, id, version)));
  if (module.id !== id || module.version !== version) fail('ID или версия не совпадают с именем снимка.');
  return module;
}
function ordered(versions) {
  return versions.sort((a, b) => {
    const parts = value => value.replace('-r', '.').split('.').map(Number);
    const left = parts(a), right = parts(b);
    for (let i = 0; i < 4; i++) { const delta = (right[i] || 0) - (left[i] || 0); if (delta) return delta; }
    return 0;
  });
}
function versionsAt(root, folder, id) {
  if (!identifier.test(id)) fail('Неверный ID.');
  const directory = contained(root, `${folder}/${id}`);
  if (!fs.existsSync(directory)) return [];
  return ordered(fs.readdirSync(directory).filter(file => file.endsWith('.json') && versionPattern.test(file.slice(0, -5))).map(file => file.slice(0, -5)));
}
export function history(base) {
  return {
    checkpoint(module) {
      // Unversioned hand edits in the working catalog must not overwrite a release.
      if (!fs.existsSync(versionFile(base, 'releases', module.id, module.version))) immutable(base, 'releases', module);
    },
    publish(module, origin) { immutable(base, 'releases', module, origin); },
    versions(id, current) {
      if (arguments.length < 2) current = catalog(base).get(id);
      return ordered([...new Set([...versionsAt(base, 'releases', id), ...(current ? [current.version] : [])])]);
    },
    get(id, version) {
      const file = versionFile(base, 'releases', id, version);
      if (fs.existsSync(file)) return readVersion(base, 'releases', id, version);
      const current = catalog(base).get(id);
      if (current?.version === version) return current;
      fail(`Версия ${id}@${version} не найдена.`);
    },
    next(module) {
      const latest = ordered([...versionsAt(base, 'releases', module.id), module.version])[0].split('.').map(Number);
      latest[2]++;
      return latest.join('.');
    },
  };
}

export function validateHistory(base) {
  const directory = contained(base, 'releases');
  if (!fs.existsSync(directory)) return 0;
  let count = 0;
  for (const file of files(base, 'releases')) {
    if (file.endsWith('.tmp')) continue;
    const parts = file.split('/');
    if (parts.length !== 3 || !/^\d+\.\d+\.\d+\.json$/.test(parts[2])) fail(`Неверный путь версии: ${file}`);
    readVersion(base, 'releases', parts[1], parts[2].slice(0, -5));
    count++;
  }
  return count;
}

export function localVersions(project, id) { return versionsAt(project, '.skill-hub/variants', id); }
export function localModule(project, id, version) {
  version ||= localVersions(project, id)[0];
  if (!version) fail(`Нет проектной версии ${id}.`);
  return { ...readVersion(project, '.skill-hub/variants', id, version), source: 'project', pinned: true };
}
export function localCatalog(project) {
  const root = contained(project, '.skill-hub/variants');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => localModule(project, entry.name));
}
export function nextLocal(project, module, repo) {
  const baseVersion = module.version.split('-r')[0];
  const revisions = localVersions(project, module.id).map(version => Number(version.split('-r')[1] || 0));
  return { ...module, source: 'project', pinned: true, version: `${baseVersion}-r${Math.max(0, ...revisions) + 1}`,
    origin: { repo, baseVersion, ...(Array.isArray(module.origin?.importedFrom) ? { importedFrom: structuredClone(module.origin.importedFrom) } : {}) } };
}
export function publishLocal(project, module) {
  const changes = cursorIgnoreChanges(project);
  const previous = changes.map(change => ({ file: change.file, data: read(project, change.file) }));
  apply(project, changes);
  try { immutable(project, '.skill-hub/variants', module); }
  catch (error) { apply(project, previous); throw error; }
}

export function resolveModules(base, project, inputs) {
  if (!Array.isArray(inputs)) fail('Нужен полный набор модулей.');
  const current = catalog(base);
  const releases = history(base);
  const lock = loadLock(project);
  const installed = lock?.modules || [];
  const selected = new Map();
  for (const input of inputs) {
    const explicit = typeof input === 'object' && input !== null;
    const [id, suffix] = typeof input === 'string' ? input.split('@') : [input?.id, undefined];
    if (!identifier.test(id) || (typeof input === 'string' && input.split('@').length > 2)) fail('Неверный ID модуля.');
    const previous = installed.find(module => module.id === id);
    const source = explicit ? (input.source || 'hub') : suffix ? 'hub' : (previous?.source || 'hub');
    const requested = explicit ? (input.version || 'latest') : suffix || (previous?.pinned ? previous.version : 'latest');
    if (!['hub', 'project'].includes(source)) fail('Неизвестный источник модуля.');
    let module;
    if (source === 'project') module = localModule(project, id, requested === 'latest' ? undefined : requested);
    else if (requested !== 'latest') module = { ...releases.get(id, requested), pinned: true };
    else module = current.get(id);
    if (!module) fail(`Неизвестный модуль: ${id}`);
    module = selectModule(module, explicit && input.selection !== undefined ? input.selection : choiceSelection(module, previous, lock?.files));
    if (selected.has(id) && (moduleRevision(selected.get(id)) !== moduleRevision(module) || JSON.stringify(selected.get(id).selectedChoices) !== JSON.stringify(module.selectedChoices))) fail(`Выбраны разные версии ${id}.`);
    selected.set(id, module);
  }
  return selection([...selected.keys()], selected);
}

export function installedModule(base, project, id) {
  const lock = loadLock(project);
  const record = lock?.modules.find(module => module.id === id);
  if (!record) fail('Модуль не установлен в проекте.');
  let template;
  try { template = record.source === 'project' ? localModule(project, id, record.version) : history(base).get(id, record.version); }
  catch { template = catalog(base).get(id); }
  if (!template) fail('Не найдены метаданные установленного модуля.');
  const owned = Object.entries(lock.files).filter(([, file]) => file.module === id).map(([file]) => file);
  const roots = new Set([`.agents/skill-hub/${id}`, `.cursor/rules/skill-hub/${id}`,
    ...owned.filter(file => file.startsWith('.agents/skills/')).map(file => file.split('/').slice(0, 3).join('/'))]);
  const paths = new Set(owned);
  for (const root of roots) for (const file of files(project, root)) paths.add(file);
  const settings = choiceSelection(template, record, lock.files);
  const payload = new Map(template.payload.map(file => [file.source, file]));
  for (const file of selectModule(template, settings).payload) payload.delete(file.source);
  for (const file of paths) {
    if (lock.files[file] && lock.files[file].module !== id) continue;
    const data = read(project, file);
    if (data === null) continue;
    const source = file.startsWith('.agents/skills/') ? file.slice('.agents/'.length)
      : file.startsWith(`.cursor/rules/skill-hub/${id}/`) ? `rules/${file.slice(`.cursor/rules/skill-hub/${id}/`.length)}`
      : file.slice(`.agents/skill-hub/${id}/`.length);
    payload.set(source, { source, target: file, data });
  }
  return { ...unpackModule(packModule({ ...template, version: record.version, payload: [...payload.values()] })), source: record.source || 'hub', pinned: record.pinned,
    ...(template.choices?.length ? { selectedChoices: settings } : {}) };
}

export function changesBetween(before, after) {
  const left = new Map(before?.payload.map(file => [file.source, file.data]) || []);
  const right = new Map(after.payload.map(file => [file.source, file.data]));
  const text = data => {
    if (!data) return null;
    try { const value = new TextDecoder('utf-8', { fatal: true }).decode(data); return value.includes('\0') || data.length > 200_000 ? null : value; }
    catch { return null; }
  };
  const result = [];
  for (const file of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(file), b = right.get(file);
    if (a && b && a.equals(b)) continue;
    result.push({ file, action: !a ? 'create' : !b ? 'remove' : 'update', before: text(a), after: text(b), binary: (a && text(a) === null) || (b && text(b) === null) });
  }
  return result;
}
export function capturePreview(base, project, id, repo) {
  const current = installedModule(base, project, id);
  const lock = loadLock(project);
  const record = lock.modules.find(module => module.id === id);
  let previous;
  try { previous = record.source === 'project' ? localModule(project, id, record.version) : history(base).get(id, record.version); } catch { /* Legacy installation without a release. */ }
  const module = nextLocal(project, current, repo);
  return { module, changes: changesBetween(previous, module), fingerprint: hash(jsonBytes([moduleRevision(module), lock, repo])) };
}
export function captureLocal(base, project, id, repo, expected) {
  const preview = capturePreview(base, project, id, repo);
  if (preview.fingerprint !== expected) fail('Предпросмотр устарел. Обнови изменения проекта.');
  const module = preview.module;
  const lock = loadLock(project);
  const next = structuredClone(lock);
  next.modules = next.modules.map(record => record.id === id ? { id, version: module.version, source: 'project', pinned: true, ...(module.selectedChoices ? { selection: module.selectedChoices } : {}) } : record);
  for (const [file, record] of Object.entries(next.files)) if (record.module === id) delete next.files[file];
  for (const file of selectModule(module, module.selectedChoices).payload) next.files[file.target] = { module: id, hash: hash(file.data) };
  publishLocal(project, module);
  // Explicit capture adopts only this module's reviewed files. Other local edits stay protected.
  apply(project, [{ file: '.agents/skill-hub.lock.json', data: jsonBytes(next) }]);
  return module;
}
