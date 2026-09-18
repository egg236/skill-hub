import fs from 'node:fs';
import { cursorIgnoreChanges } from './hub.mjs';
import { sourceMatches } from './conversion-origin.mjs';
import { conversionInput, conversionPreview, saveConversion } from './project-conversion.mjs';
import { designAgentInput, designChanges } from './design-bundles.mjs';
import { makeCursorRule, upgradeCursorRules } from './cursor-rules.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectSkills, projectSkill, projectInstructions, projectInstruction } from './project-skills.mjs';
import { choiceSelection } from './module-choices.mjs';
import { saveProjectSkill } from './project-skill-edit.mjs';
import { projectConflicts, adoptionPreview, adoptProjectFiles, connectionPreview, connectProjectFiles } from './project-adoption.mjs';
import { history, moduleRevision, packModule, unpackModule, moduleManifest, jsonBytes, resolveModules, localCatalog, localModule, localVersions, nextLocal, publishLocal, installedModule, capturePreview, captureLocal, changesBetween } from './module-history.mjs';
import { catalog, selection, plan, apply, loadLock, contained, files, read, hash, json, splitBlock, agentText } from './hub.mjs';

const fail = message => { throw new Error(message); };
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function name(value) {
  if (typeof value !== 'string' || value.length > 63 || !identifier.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)) fail('Имя: до 63 латинских букв, цифр и дефисов, в нижнем регистре.');
  return value;
}
function line(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value) || value.length > 1000) fail(`Укажи ${label} одной строкой.`);
  return value.trim();
}
const revision = moduleRevision;
function summary(module) {
  return { id: module.id, description: module.description, version: module.version, family: module.family,
    group: module.group, location: module.location, revision: revision(module), source: module.source || 'hub', origin: module.origin,
    choices: module.choices || [], ...(module.selectedChoices ? { selection: module.selectedChoices } : {}),
    tag: module.source === 'project' ? `${module.origin?.repo || 'Проект'} · ${module.version}` : module.version,
    skills: [...new Set(module.payload.filter(file => file.source.startsWith('skills/')).map(file => file.source.split('/')[1]))],
    rules: module.payload.filter(file => file.source.startsWith('rules/')).map(file => file.source),
    agents: module.payload.filter(file => file.source.startsWith('agents/')).map(file => file.source) };
}

function detail(module) {
  return { ...summary(module), files: (module.allPayload || module.payload).map(file => {
    let content = null;
    if (file.data.length <= 500_000) {
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.data); if (content.includes('\u0000')) content = null; } catch {}
    }
    return { path: file.source, size: file.data.length, content };
  }) };
}
function editedModule(module, input) {
  const description = input.description === undefined ? module.description : line(input.description, 'описание');
  const payload = new Map(module.payload.map(file => [file.source, file]));
  if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 1000)) fail('Неверный список файлов.');
  const seen = new Set();
  for (const file of input.files || []) {
    if (!file || typeof file.path !== 'string' || seen.has(file.path)) fail('Неверный или повторяющийся путь файла.');
    seen.add(file.path);
    if (file.content === null) payload.delete(file.path);
    else {
      if (typeof file.content !== 'string' || file.content.length > 500_000) fail('Текст файла должен быть меньше 500 КБ.');
      payload.set(file.path, { source: file.path, data: Buffer.from(file.content) });
    }
  }
  return unpackModule(packModule(upgradeCursorRules({ ...module, allPayload: undefined, description, choices: input.choices ?? module.choices, payload: [...payload.values()] })));
}

export function createStore(base) {
  base = fs.realpathSync(base);
  const releases = history(base);
  const registryPath = () => contained(base, 'projects.local.json');
  function registry() {
    const data = fs.existsSync(registryPath()) ? json(registryPath()) : { schema: 1, projects: [] };
    if (data.schema !== 1 || !Array.isArray(data.projects)) fail('Неверный формат projects.local.json: нужны schema: 1 и projects: [].');
    const ids = new Set();
    for (const project of data.projects) {
      if (!project || typeof project.id !== 'string' || ids.has(project.id) ||
          typeof project.name !== 'string' || !project.name.trim() || typeof project.path !== 'string' || !path.isAbsolute(project.path)) fail('Повреждена запись в projects.local.json.');
      ids.add(project.id);
    }
    return data;
  }
  function saveRegistry(data) {
    const temporary = contained(base, `projects.local.json.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes(data), { flag: 'wx' });
      fs.renameSync(temporary, registryPath());
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function projectRoot(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) fail('Укажи абсолютный путь к существующей папке проекта.');
    const root = fs.realpathSync(input);
    if (!fs.statSync(root).isDirectory()) fail('Проект должен быть папкой.');
    const relative = path.relative(base, root);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) fail('Выбери проект вне папки хаба.');
    return root;
  }
  function project(id) {
    const record = registry().projects.find(item => item.id === id);
    if (!record) fail('Проект не зарегистрирован.');
    return { ...record, path: projectRoot(record.path) };
  }
  function status(record) {
    try {
      const root = projectRoot(record.path);
      const lock = loadLock(root);
      const problems = [];
      if (lock) {
        for (const [file, stored] of Object.entries(lock.files)) {
          const current = read(root, file);
          if (!current || hash(current) !== stored.hash) problems.push({ file, state: current ? 'modified' : 'missing' });
        }
        if (hash(splitBlock(agentText(read(root, 'AGENTS.md'))).block) !== lock.blockHash) problems.push({ file: 'AGENTS.md', state: 'modified' });
      }
      const discovered = projectSkills(root, lock);
      const instructions = projectInstructions(root, lock);
      const packed = localCatalog(root);
      for (const item of instructions.instructions) {
        const matches = packed.filter(module => Array.isArray(module.origin?.importedFrom) && module.origin.importedFrom.some(source => source.path === item.path));
        item.packedAs = matches.map(module => ({ id: module.id, version: module.version, tag: record.name + ' · ' + module.version }));
        if (matches.length && !item.managed) {
          try {
            const current = projectInstruction(root, item.path);
            item.packedChanged = !matches.some(module => module.origin.importedFrom.some(source => source.path === item.path && sourceMatches(current, module, source)));
          } catch (error) { item.packedChanged = true; instructions.warnings.push(item.path + ': ' + error.message); }
        }
      }
      return { ...record, modules: lock?.modules ?? [], problems, available: projectOptions(root, lock), skills: discovered.skills, skillWarnings: discovered.warnings, instructions: instructions.instructions, instructionWarnings: instructions.warnings };
    } catch (error) { return { ...record, modules: [], problems: [], error: error.message }; }
  }
  function projectOptions(root, lock = loadLock(root)) {
    const available = catalog(base);
    const hubIds = new Set(available.keys());
    function configuration(module) {
      const record = lock?.modules.find(item => item.id === module.id);
      let configured = module;
      if (record?.source === 'project') configured = localModule(root, module.id, record.version);
      else if (record?.pinned) configured = releases.get(module.id, record.version);
      return { source: record?.source || module.source || 'hub', version: record?.pinned || record?.source === 'project' ? record.version : module.source === 'project' ? module.version : 'latest',
        choices: configured.choices || [], selection: choiceSelection(configured, record, lock?.files) };
    }
    const local = new Map(localCatalog(root).map(module => [module.id, module]));
    for (const module of local.values()) if (!available.has(module.id)) available.set(module.id, module);
    for (const record of lock?.modules || []) if (!available.has(record.id)) {
      try { available.set(record.id, record.source === 'project' ? localModule(root, record.id, record.version) : releases.get(record.id, record.version)); } catch {}
    }
    return [...available.values()].map(module => ({ ...summary(module), configuration: configuration(module), hasHub: hubIds.has(module.id),
      versions: releases.versions(module.id, module.source === 'project' ? null : module),
      localVersions: localVersions(root, module.id),
      local: local.has(module.id) ? summary(local.get(module.id)) : null }));
  }
  function projectModule(record, id, input = {}) {
    if (input.source === 'project') return localModule(record.path, id, input.version === 'latest' ? undefined : input.version);
    if (input.source === 'hub') return input.version && input.version !== 'latest' ? releases.get(id, input.version) : moduleById(id);
    const installed = loadLock(record.path)?.modules.find(module => module.id === id);
    if (installed) return installedModule(base, record.path, id);
    if (localVersions(record.path, id).length) return localModule(record.path, id);
    return moduleById(id);
  }
  function promotion(projectId, id, input) {
    const record = project(projectId);
    const module = localModule(record.path, id, input.version);
    const current = catalog(base).get(id);
    const group = current?.group || name(input.group || module.group);
    const next = unpackModule(packModule(upgradeCursorRules({ ...module, version: current ? releases.next(current) : '1.0.0', group })));
    const origin = { repo: record.name, version: module.version };
    const fingerprint = hash(bytes([revision(module), current ? revision(current) : null, group, origin]));
    return { record, module: next, current, origin, fingerprint, changes: changesBetween(current, next),
      description: { before: current?.description || '', after: next.description }, choices: { before: current?.choices || [], after: next.choices || [] } };
  }
  function presets(available = catalog(base)) {
    return fs.readdirSync(contained(base, 'presets')).filter(file => file.endsWith('.json')).map(file => {
      const config = json(contained(base, `presets/${file}`));
      if (!Array.isArray(config.modules)) fail(`Неверный preset: ${file}`);
      selection(config.modules, available);
      return { id: path.basename(file, '.json'), ...config };
    });
  }
  function moduleById(id, expected) {
    const module = catalog(base).get(id);
    if (!module) fail('Модуль не найден. Обнови каталог.');
    if (arguments.length > 1 && revision(module) !== expected) fail('Модуль изменился после открытия. Обнови каталог и повтори действие.');
    return module;
  }
  function transact(root, changes, commit = () => {}) {
    const previous = changes.map(change => ({ file: change.file, data: read(root, change.file) }));
    const createdDirectories = new Set();
    for (const change of changes) {
      let directory = path.dirname(contained(root, change.file));
      while (directory === root || directory.startsWith(root + path.sep)) {
        if (!fs.existsSync(directory)) createdDirectories.add(directory);
        if (directory === root) break;
        directory = path.dirname(directory);
      }
    }
    let written = false;
    try {
      apply(root, changes);
      written = true;
      presets(catalog(base));
      commit();
    } catch (error) {
      if (written) apply(root, previous);
      for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
        if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      }
      throw error;
    }
  }
  function update(module, edits, description = module.description, origin, choices = module.choices) {
    if (!origin && description === module.description && JSON.stringify(choices || []) === JSON.stringify(module.choices || []) && edits.every(edit => {
      const current = read(module.root, edit.file);
      return edit.data === null ? current === null : current?.equals(edit.data);
    }) && module.payload.every(file => read(module.root, file.source)?.equals(file.data))) return summary(module);
    const manifest = moduleManifest({ ...module, description, choices, version: releases.next(module) });
    releases.checkpoint(module);
    const changes = [...edits, { file: 'module.json', data: bytes(manifest) }];
    transact(module.root, changes, () => releases.publish(moduleById(module.id), origin));
    return summary(moduleById(module.id));
  }
  function archive(root) {
    const relative = path.relative(base, root).split(path.sep).join('/');
    const source = contained(base, relative);
    const target = contained(base, `.skill-hub/trash/${Date.now()}-${randomUUID()}/${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return { source, target, path: path.relative(base, target).split(path.sep).join('/') };
  }
  function preview(id, ids) {
    const target = project(id);
    const selected = resolveModules(base, target.path, ids);
    const conflicts = projectConflicts(target.path, selected);
    if (conflicts.length) {
      const error = new Error(`В проекте уже есть файлы выбранных модулей (${conflicts.length}). Сравни их и подключи с сохранением файлов проекта.`);
      error.code = 'EXISTING_PROJECT_FILES'; error.conflicts = conflicts; throw error;
    }
    const changes = plan(target.path, selected);
    const fingerprint = hash(bytes([target.path, selected.map(module => [module.id, revision(module)]),
      changes.map(change => [change.file, change.action, change.data === null ? null : hash(change.data)]),
      read(target.path, 'AGENTS.md')?.toString('base64'), read(target.path, '.agents/skill-hub.lock.json')?.toString('base64')]));
    return { target, changes, fingerprint, modules: selected.map(module => module.id), choices: selected.map(module => ({ id: module.id, version: module.version, source: module.source || 'hub', ...(module.selectedChoices ? { selection: module.selectedChoices } : {}) })) };
  }
  return {
    catalog() { const available = catalog(base); return { modules: [...available.values()].map(summary), presets: presets(available) }; },
    projects() { return { projects: registry().projects.map(status), registry: 'projects.local.json' }; },
    conversionInput(projectId, paths) { const record = project(projectId); return conversionInput(base, record.path, paths); },
    conversionPreview(projectId, input) { const record = project(projectId); const result = conversionPreview(base, record.path, record.name, input); return { modules: result.modules, fingerprint: result.fingerprint, migration: { archive: result.migration.archive, files: result.migration.files.map(file => file.file), preserved: input.paths.includes('AGENTS.md') ? ['AGENTS.md'] : [] } }; },
    saveConversion(projectId, input) { const record = project(projectId); return saveConversion(base, record.path, record.name, input); },
    projectInstruction(projectId, relative) { return projectInstruction(project(projectId).path, relative); },
    projectSkill(projectId, relative) { return projectSkill(project(projectId).path, relative); },
    saveProjectSkill(projectId, input) { const record = project(projectId); return saveProjectSkill(base, record.path, record.name, input); },
    adoptPreview(projectId, inputs) {
      const record = project(projectId);
      const preview = adoptionPreview(base, record.path, record.name, inputs);
      return { fingerprint: preview.fingerprint, conflicts: preview.conflicts, preserved: [...preview.adopted.keys()],
        variants: preview.variants.map(({ module, differences }) => ({ ...summary(module), differences })),
        changes: preview.changes.map(({ file, action }) => ({ file, action })) };
    },
    connectionPreview(projectId, ids, cleanup = false) {
      const record = project(projectId);
      const preview = connectionPreview(base, record.path, record.name, ids, { cleanup });
      return { fingerprint: preview.fingerprint, modules: preview.selected.filter(module => ids.includes(module.id)).map(summary),
        migration: { archive: preview.migration.archive, files: preview.migration.files.map(file => file.file), preserved: preview.migration.preserved, agentLinks: preview.migration.agentLinks, agentArchive: preview.migration.agentArchive, replacements: preview.migration.replacements }, 
        preserved: [...preview.adopted.keys()], conflicts: preview.conflicts,
        variants: preview.variants.map(({ module, differences }) => ({ ...summary(module), differences })),
        changes: preview.changes.map(({ file, action }) => ({ file, action })) };
    },
    connect(projectId, ids, fingerprint, cleanup = false) {
      const record = project(projectId);
      connectProjectFiles(base, record.path, record.name, ids, fingerprint, { cleanup });
      return status(record);
    },
    adopt(projectId, inputs, fingerprint) {
      const record = project(projectId);
      adoptProjectFiles(base, record.path, record.name, inputs, fingerprint);
      return status(record);
    },
    register(input) {
      const data = registry();
      const root = projectRoot(input.path);
      const duplicate = data.projects.find(item => {
        try { return fs.realpathSync(item.path) === root; } catch { return item.path === root; }
      });
      if (duplicate && duplicate.id !== input.id) fail(`Эта папка уже зарегистрирована: ${duplicate.name}`);
      const record = { id: input.id || randomUUID(), name: line(input.name, 'название проекта'), path: root };
      if (input.id) {
        const index = data.projects.findIndex(item => item.id === input.id);
        if (index < 0) fail('Проект не найден.');
        data.projects[index] = record;
      } else data.projects.push(record);
      transact(root, cursorIgnoreChanges(root), () => saveRegistry(data));
      return status(record);
    },
    unregister(id) {
      const data = registry();
      if (!data.projects.some(item => item.id === id)) fail('Проект не найден.');
      data.projects = data.projects.filter(item => item.id !== id);
      saveRegistry(data);
      return { ok: true };
    },
    preview(id, ids) {
      const result = preview(id, ids);
      return { fingerprint: result.fingerprint, modules: result.modules, choices: result.choices,
        changes: result.changes.map(({ file, action }) => ({ file, action })) };
    },
    apply(id, ids, fingerprint) {
      const current = preview(id, ids);
      if (!fingerprint || fingerprint !== current.fingerprint) fail('Предпросмотр устарел. Проверь изменения ещё раз.');
      for (const module of resolveModules(base, current.target.path, ids)) if (module.source !== 'project') releases.checkpoint(module);
      apply(current.target.path, current.changes);
      return status(current.target);
    },
    module(id) {
      const module = moduleById(id);
      return { ...detail(module), versions: releases.versions(id, module) };
    },
    version(id, version) { return detail(releases.get(id, version)); },
    saveModule(id, input) {
      const current = moduleById(id, input.revision);
      const next = editedModule(current, input);
      const changes = changesBetween(current, next).map(change => ({ file: change.file,
        data: next.payload.find(file => file.source === change.file)?.data ?? null }));
      return update(current, changes, next.description, undefined, next.choices);
    },
    projectModule(projectId, id, input = {}) {
      const record = project(projectId);
      const module = projectModule(record, id, input);
      return { ...detail(module), projectId, repo: record.name };
    },
    saveProjectModule(projectId, id, input) {
      const record = project(projectId);
      const current = projectModule(record, id, input);
      if (revision(current) !== input.revision) fail('Модуль проекта изменился. Открой редактор заново.');
      const next = editedModule(current, input);
      if (revision(current) === revision(next) && current.source === 'project') return summary(current);
      const module = nextLocal(record.path, { ...next, ...(input.selection ? { selectedChoices: input.selection } : {}) }, record.name);
      publishLocal(record.path, module);
      return summary(module);
    },
    createProjectModule(projectId, input) {
      const record = project(projectId);
      const id = name(input.id);
      if (catalog(base).has(id) || localVersions(record.path, id).length) fail('Этот ID уже занят. Для настройки существующего модуля открой его редактор.');
      const module = unpackModule({ schema: 1, group: name(input.group || 'custom'),
        manifest: { schema: 1, id, version: '1.0.0', description: line(input.description, 'описание'), ...(input.family ? { family: name(input.family) } : {}) },
        files: [{ path: 'rules/module.mdc', data: Buffer.from(makeCursorRule(input.description, typeof input.instructions === 'string' && input.instructions.trim() ? input.instructions : input.description)).toString('base64') }] });
      const local = nextLocal(record.path, module, record.name);
      publishLocal(record.path, local);
      return summary(local);
    },
    capturePreview(projectId, id) {
      const record = project(projectId);
      const result = capturePreview(base, record.path, id, record.name);
      return { module: summary(result.module), changes: result.changes, fingerprint: result.fingerprint };
    },
    capture(projectId, id, input) {
      const record = project(projectId);
      return summary(captureLocal(base, record.path, id, record.name, input.fingerprint));
    },
    promotePreview(projectId, id, input) {
      const result = promotion(projectId, id, input);
      return { module: summary(result.module), changes: result.changes, description: result.description, choices: result.choices, fingerprint: result.fingerprint };
    },
    promote(projectId, id, input) {
      const result = promotion(projectId, id, input);
      if (result.fingerprint !== input.fingerprint) fail('Предпросмотр устарел. Сравни версии ещё раз.');
      const module = result.module;
      if (result.current) {
        if (result.current.family !== module.family) fail('Family проектной версии отличается от хаба. Сначала согласуй family в редакторе.');
        const edits = result.changes.map(change => ({ file: change.file, data: module.payload.find(file => file.source === change.file)?.data ?? null }));
        return update(result.current, edits, module.description, result.origin, module.choices);
      }
      const sibling = [...catalog(base).values()].find(item => module.family && item.family === module.family);
      const parent = sibling ? path.posix.dirname(sibling.location) : `modules/${module.group}${module.family ? '/' + module.family : ''}`;
      const root = contained(base, `${parent}/${id}`);
      if (fs.existsSync(root)) fail('Папка модуля уже существует.');
      const edits = [{ file: 'module.json', data: jsonBytes(moduleManifest(module)) }, ...module.payload.map(file => ({ file: file.source, data: file.data }))];
      transact(root, edits, () => releases.publish(moduleById(id), result.origin));
      return summary(moduleById(id));
    },
    designAgentInput(id, input) { return designAgentInput(moduleById(id, input.revision), input); },
    createDesign(id, input) {
      const module = moduleById(id, input.revision);
      const changes = designChanges(module, input);
      return update(module, changes.edits, module.description, undefined, changes.choices);
    },
    createModule(input) {
      const id = name(input.id);
      const group = name(input.group);
      const family = input.family ? name(input.family) : undefined;
      const available = catalog(base);
      if (available.has(id)) fail('Модуль с таким ID уже существует.');
      const sibling = [...available.values()].find(module => family && module.family === family);
      if (sibling && sibling.group !== group) fail(`Family ${family} находится в группе ${sibling.group}.`);
      const parent = sibling ? path.posix.dirname(sibling.location) : `modules/${group}${family ? '/' + family : ''}`;
      const location = `${parent}/${id}`;
      if ([...available.values()].some(module => location.startsWith(module.location + '/') || module.location.startsWith(location + '/'))) fail('Папка модуля не может содержать другой модуль.');
      const root = contained(base, location);
      if (fs.existsSync(root)) fail('Папка с таким именем уже существует.');
      const manifest = { schema: 1, id, version: '1.0.0', description: line(input.description, 'описание'), ...(family ? { family } : {}) };
      if (typeof input.instructions !== 'string' || !input.instructions.trim()) fail('Добавь начальные инструкции модуля.');
      const changes = [{ file: 'module.json', data: bytes(manifest) }, { file: 'rules/module.mdc', data: Buffer.from(makeCursorRule(manifest.description, input.instructions)) }];
      transact(root, changes, () => releases.publish(moduleById(id)));
      return summary(moduleById(id));
    },
    deleteModule(id, expected) {
      const module = moduleById(id, expected);
      const used = presets().filter(preset => preset.modules.includes(id));
      if (used.length) fail(`Модуль используется в presets: ${used.map(item => item.id).join(', ')}. Сначала убери его из этих списков.`);
      releases.checkpoint(module);
      const saved = archive(module.root);
      try { presets(catalog(base)); }
      catch (error) { fs.renameSync(saved.target, saved.source); throw error; }
      return { archive: saved.path };
    },
    skill(id, skill) {
      name(skill);
      const module = moduleById(id);
      const content = read(module.root, `skills/${skill}/SKILL.md`);
      if (!content) fail('Скилл не найден.');
      return { name: skill, content: content.toString('utf8'), revision: revision(module),
        files: module.payload.filter(file => file.source.startsWith(`skills/${skill}/`)).map(file => file.source) };
    },
    saveSkill(id, input) {
      const module = moduleById(id, input.revision);
      const skill = name(input.name);
      const file = `skills/${skill}/SKILL.md`;
      const existing = read(module.root, file);
      if (input.create ? fs.existsSync(contained(module.root, `skills/${skill}`)) : !existing) fail(input.create ? 'Скилл уже существует.' : 'Скилл не найден.');
      if (typeof input.content !== 'string' || !input.content.trim()) fail('Нужен текст SKILL.md.');
      if (existing?.equals(Buffer.from(input.content))) return summary(module);
      return update(module, [{ file, data: Buffer.from(input.content) }]);
    },
    importSkill(id, input) {
      const module = moduleById(id, input.revision);
      if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) fail('Укажи абсолютный путь к папке скилла.');
      if (fs.lstatSync(input.path).isSymbolicLink()) fail('Папка скилла не должна быть ссылкой или junction.');
      const selected = fs.realpathSync(input.path);
      if (fs.statSync(selected).isFile() && path.basename(selected) !== 'SKILL.md') fail('Выбери SKILL.md или папку с ним.');
      const source = fs.statSync(selected).isFile() ? path.dirname(selected) : selected;
      if (!fs.statSync(source).isDirectory()) fail('Выбери папку с SKILL.md.');
      const skill = name(path.basename(source));
      if (fs.existsSync(contained(module.root, `skills/${skill}`))) fail('Скилл уже существует.');
      const sources = files(path.dirname(source), skill);
      if (!sources.includes(`${skill}/SKILL.md`)) fail('В выбранной папке нет SKILL.md.');
      if (sources.length > 2000) fail('Слишком много файлов в скилле (максимум 2000).');
      let total = 0;
      const changes = sources.map(file => {
        const sourceFile = contained(path.dirname(source), file);
        total += fs.statSync(sourceFile).size;
        if (total > 20 * 1024 * 1024) fail('Скилл превышает 20 МБ.');
        return { file: `skills/${file}`, data: fs.readFileSync(sourceFile) };
      });
      return update(module, changes);
    },
    deleteSkill(id, skill, expected) {
      name(skill);
      const module = moduleById(id, expected);
      if (!read(module.root, `skills/${skill}/SKILL.md`)) fail('Скилл не найден.');
      if (module.payload.every(file => file.source.startsWith(`skills/${skill}/`))) fail('Это всё содержимое модуля. Удали модуль целиком или сначала добавь другой скилл.');
      const saved = archive(contained(module.root, `skills/${skill}`));
      try { update(module, []); }
      catch (error) { fs.renameSync(saved.target, saved.source); throw error; }
      return { archive: saved.path };
    },
  };
}
