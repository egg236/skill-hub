import fs from 'node:fs';
import { cursorIgnoreChanges } from './hub.mjs';
import { projectInstruction } from './project-skills.mjs';
import { contained, read, hash, loadLock, apply, splitBlock } from './hub.mjs';
import { history, localModule, nextLocal, packModule, unpackModule, jsonBytes } from './module-history.mjs';

export function saveProjectSkill(base, project, repo, input) {
  const current = projectInstruction(project, input.path);
  if (current.revision !== input.revision) throw new Error('Скилл изменился после открытия. Открой его заново.');
  if (!Array.isArray(input.files) || input.files.length > 1000) throw new Error('Неверный список изменений скилла.');
  const changed = new Map();
  for (const edit of input.files) {
    const original = current.files.find(file => file.path === edit.path);
    if (!original || original.content === null || typeof edit.content !== 'string' || Buffer.byteLength(edit.content) > 500_000 || changed.has(edit.path)) throw new Error('Можно редактировать текстовые файлы открытого скилла до 500 КБ.');
    if (edit.content !== original.content) changed.set(edit.path, Buffer.from(edit.content));
  }
  if (!changed.size) return { ...current, unchanged: true };
  const payload = current.files.map(file => ({ file: file.path, data: changed.get(file.path) || read(project, file.path) }));
  const writes = [...changed].map(([file, data]) => ({ file, data }));
  const lock = loadLock(project);
  if (changed.has('AGENTS.md') && splitBlock(changed.get('AGENTS.md').toString('utf8')).block !== splitBlock(read(project, 'AGENTS.md').toString('utf8')).block) throw new Error('Служебный блок skill-hub в AGENTS.md сохраняется без изменений.');
  if (current.managed) {
    const record = lock.modules.find(module => module.id === current.module);
    const template = record.source === 'project' ? localModule(project, record.id, record.version) : history(base).get(record.id, record.version);
    const nextPayload = new Map(template.payload.map(file => [file.target, file]));
    const owns = file => file === current.path || file.startsWith(current.path + '/');
    for (const [file, entry] of Object.entries(lock.files)) if (entry.module === record.id && owns(file) && !payload.some(item => item.file === file)) nextPayload.delete(file);
    for (const file of payload) {
      const source = file.file.startsWith('.agents/skills/') ? file.file.slice('.agents/'.length) : nextPayload.get(file.file)?.source;
      if (!source) throw new Error('Не удалось определить путь ресурса в модуле.');
      nextPayload.set(file.file, { source, target: file.file, data: file.data });
    }
    const module = nextLocal(project, unpackModule(packModule({ ...template, payload: [...nextPayload.values()] })), repo);
    const nextLock = structuredClone(lock);
    nextLock.modules = nextLock.modules.map(item => item.id === record.id ? { ...item, version: module.version, source: 'project', pinned: true } : item);
    for (const [file, entry] of Object.entries(nextLock.files)) if (entry.module === record.id && owns(file)) delete nextLock.files[file];
    for (const file of payload) nextLock.files[file.file] = { module: record.id, hash: hash(file.data) };
    const snapshot = `.skill-hub/variants/${module.id}/${module.version}.json`;
    if (fs.existsSync(contained(project, snapshot))) throw new Error('Версия уже существует. Открой редактор заново.');
    apply(project, [...cursorIgnoreChanges(project), { file: snapshot, data: jsonBytes(packModule(module)) }, ...writes, { file: '.agents/skill-hub.lock.json', data: jsonBytes(nextLock) }]);
    return { ...projectInstruction(project, input.path), version: module.version, tag: `${repo} · ${module.version}` };
  }
  // Legacy skills remain in their original format and location. Each edit has an immutable recovery snapshot.
  const root = `.skill-hub/skill-history/${hash(current.path).slice(0, 24)}`;
  const directory = contained(project, root);
  const versions = fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => /^\d+\.json$/.test(file)).map(file => Number(file.slice(0, -5))) : [];
  const version = Math.max(0, ...versions) + 1;
  const snapshot = { schema: 1, path: current.path, repo, version, createdAt: new Date().toISOString(),
    before: current.files.map(file => ({ path: file.path, data: read(project, file.path).toString('base64') })),
    after: payload.map(file => ({ path: file.file, data: file.data.toString('base64') })) };
  apply(project, [...cursorIgnoreChanges(project), { file: `${root}/${version}.json`, data: jsonBytes(snapshot) }, ...writes]);
  return { ...projectInstruction(project, input.path), version, tag: `${repo} · ${current.kind}-r${version}` };
}
