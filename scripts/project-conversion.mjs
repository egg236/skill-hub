import fs from 'node:fs';
import { cursorIgnoreChanges } from './hub.mjs';
import { catalog, hash, contained, read, apply, splitBlock, loadLock } from './hub.mjs';
import { projectInstruction } from './project-skills.mjs';
import { localCatalog, nextLocal, unpackModule, packModule, moduleManifest, jsonBytes } from './module-history.mjs';
import { itemName, payloadFor } from './conversion-format.mjs';
import { personalAgentText } from './conversion-origin.mjs';
import { archiveSources, pruneSourceDirectories } from './project-migration.mjs';
import { portableId, conversionPrompt, validateConversionPlan } from './conversion-plan.mjs';

function reservedIds(base, project) { return [...new Set([...catalog(base).keys(), ...localCatalog(project).map(module => module.id)])].sort(); }
export function conversionSelection(base, project, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 50 || new Set(paths).size !== paths.length) throw new Error('Выбери от 1 до 50 наборов инструкций без повторов.');
  const lock = loadLock(project);
  const items = paths.map(relative => {
    const item = projectInstruction(project, relative);
    if (item.managed || item.files.some(file => lock?.files[file.path])) throw new Error('Управляемые файлы уже входят в модули. Для них доступно сохранение правок в проектную версию.');
    const entry = item.files.find(file => file.path === item.entrypoint);
    if (entry?.content === null || !entry?.content) throw new Error('Не удалось прочитать текст инструкций: ' + relative);
    return item;
  });
  const reserved = reservedIds(base, project);
  const revision = hash(jsonBytes([items.map(item => [item.path, item.kind, item.revision]), reserved]));
  return { items, reserved, revision };
}
export function conversionInput(base, project, paths) {
  const selection = conversionSelection(base, project, paths);
  const content = JSON.stringify({ reservedIds: selection.reserved, selectedPaths: selection.items.map(item => item.path), items: selection.items.map(item => ({ path: item.path, kind: item.kind, name: item.name,
    text: item.path === 'AGENTS.md' ? personalAgentText(item.files[0].content) : item.files.find(file => file.path === item.entrypoint).content,
    resources: item.files.filter(file => file.path !== item.entrypoint).map(file => ({ path: file.path, size: file.size })) })) });
  if (content.length > 450_000) throw new Error('Слишком много текста для одного запроса. Выбери меньше файлов.');
  return { revision: selection.revision, input: { kind: 'module-plan', name: 'project-modules', task: conversionPrompt, content } };
}
export function conversionPreview(base, project, repo, input) {
  const selection = conversionSelection(base, project, input.paths);
  if (input.revision !== selection.revision) throw new Error('Файлы или список модулей изменились. Подготовь преобразование заново.');
  validateConversionPlan(input.modules, input.paths, selection.reserved);
  const names = new Map(), used = new Set();
  for (const item of selection.items) {
    let name = itemName(item);
    if (used.has(item.kind + '/' + name)) name += '-' + hash(item.path).slice(0, 8);
    used.add(item.kind + '/' + name); names.set(item.path, name);
  }
  const snapshots = [], modules = [];
  for (const proposed of input.modules) {
    const items = proposed.items.map(relative => selection.items.find(item => item.path === relative));
    const payload = items.flatMap(item => payloadFor(project, item, names.get(item.path), proposed.description));
    const module = nextLocal(project, unpackModule({ schema: 1, group: proposed.group,
      manifest: { schema: 1, id: proposed.id, version: '1.0.0', description: proposed.description },
      files: payload.map(file => ({ path: file.source, data: file.data.toString('base64') })) }), repo);
    module.origin = { ...module.origin, importedFrom: items.map(item => ({ path: item.path, revision: item.revision,
      ...(item.path === 'AGENTS.md' ? { personalHash: hash(personalAgentText(item.files[0].content)) } : {}),
      files: payload.filter(file => item.files.some(original => original.path === file.original)).map(file => ({ path: file.original, source: file.source })) })) };
    const snapshotPath = `.skill-hub/variants/${module.id}/${module.version}.json`;
    if (fs.existsSync(contained(project, snapshotPath))) throw new Error('Версия уже существует. Обнови предпросмотр.');
    snapshots.push({ file: snapshotPath, data: jsonBytes(packModule(module)) });
    modules.push({ id: module.id, group: module.group, description: module.description, version: module.version, source: 'project', tag: `${repo} · ${module.version}`, manifest: moduleManifest(module), items: proposed.items,
      files: payload.map(file => ({ source: file.original, target: file.source, changed: file.changed,
        before: file.changed ? file.before : undefined, after: file.changed ? file.data.toString('utf8') : undefined, binary: file.before === null })) });
  }
  const migration = archiveSources(project, selection.items.flatMap(item => item.files.map(file => ({ file: file.path, data: read(project, file.path) }))));
  const fingerprint = hash(jsonBytes([repo, selection.revision, snapshots.map(snapshot => [snapshot.file, hash(snapshot.data)]), migration.archive]));
  return { modules, fingerprint, snapshots, migration };
}
export function saveConversion(base, project, repo, input) {
  const preview = conversionPreview(base, project, repo, input);
  if (input.fingerprint !== preview.fingerprint) throw new Error('Предпросмотр устарел. Проверь преобразование ещё раз.');
  apply(project, [...cursorIgnoreChanges(project), ...preview.migration.writes, ...preview.snapshots, ...preview.migration.files.map(file => ({ file: file.file, data: null }))]);
  pruneSourceDirectories(project, preview.migration.files.map(file => file.file));
  return { modules: preview.modules, archive: preview.migration.archive };
}
