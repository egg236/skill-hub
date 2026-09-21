import fs from 'node:fs';
import { cursorIgnoreBytes } from './cursor-ignore.mjs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { payloadTarget, validateCursorRule } from './cursor-rules.mjs';
import { validateChoices, selectModule, choiceSelection } from './module-choices.mjs';

const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const start = '<!-- skill-hub:start -->';
const end = '<!-- skill-hub:end -->';
const lockPath = '.agents/skill-hub.lock.json';
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = data => createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fail = message => { throw new Error(message); };

function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      relative.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) {
    fail(`Недопустимый относительный путь: ${relative}`);
  }
  const result = path.resolve(root, relative);
  if (!result.startsWith(root + path.sep)) fail(`Путь выходит за границы: ${relative}`);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`Ссылки и junction не поддерживаются: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

function read(root, relative) {
  const file = contained(root, relative);
  try { return fs.readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function cursorIgnoreChanges(project) {
  const current = read(project, '.cursorignore');
  const data = cursorIgnoreBytes(current);
  return data ? [{ file: '.cursorignore', action: current ? 'update' : 'create', data }] : [];
}

function agentText(bytes) {
  if (!bytes) return '';
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('AGENTS.md должен быть в UTF-8. Преобразуй кодировку явно перед apply. Файл не изменён.'); }
  if (text.includes('\0')) fail('AGENTS.md содержит NUL (возможен UTF-16). Преобразуй его в UTF-8 перед apply.');
  return text;
}

function files(root, relative) {
  const directory = contained(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = `${relative}/${entry.name}`;
    contained(root, name);
    if (entry.isDirectory()) return files(root, name);
    if (!entry.isFile()) fail(`Ожидался обычный файл: ${name}`);
    return [name];
  });
}

// Folders organize the catalog; IDs remain stable in presets and project locks.
function moduleRoots(base, relative = 'modules') {
  const directory = contained(base, relative);
  if (fs.existsSync(contained(base, `${relative}/module.json`))) return [relative];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    contained(base, `${relative}/${entry.name}`);
    if (!entry.isDirectory()) return [];
    if (!identifier.test(entry.name)) fail(`Недопустимое имя каталога: ${entry.name}`);
    return moduleRoots(base, `${relative}/${entry.name}`);
  });
}

function catalog(base = hub) {
  const result = new Map();
  const families = new Map();
  for (const location of moduleRoots(base)) {
    const name = path.posix.basename(location);
    const root = contained(base, location);
    const manifest = json(contained(root, 'module.json'));
    const allowed = ['schema', 'id', 'version', 'description', 'family', 'choices'];
    if (Object.keys(manifest).some(key => !allowed.includes(key))) fail(`Неизвестное поле модуля ${name}`);
    if (manifest.schema !== 1 || manifest.id !== name || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
        typeof manifest.description !== 'string' || !manifest.description.trim() || /[\r\n]/.test(manifest.description) ||
        (manifest.family !== undefined && !identifier.test(manifest.family))) fail(`Неверный manifest: ${name}`);
    if (result.has(manifest.id)) fail(`Повторяющийся ID модуля: ${manifest.id}`);
    if (manifest.family) {
      const parent = path.posix.dirname(location);
      if (families.has(manifest.family) && families.get(manifest.family) !== parent) fail(`Варианты family ${manifest.family} должны лежать в общей папке`);
      families.set(manifest.family, parent);
    }
    const payload = [];
    for (const kind of ['rules', 'skills', 'agents']) {
      for (const source of files(root, kind)) {
        const relative = source.slice(kind.length + 1);
        if (kind === 'agents' && !/^[a-z0-9-]+\.md$/.test(relative)) fail(`Ожидался Markdown ${kind}: ${source}`);
        if (kind === 'rules' && !/^[a-z0-9-]+\.mdc?$/.test(relative)) fail(`Ожидался Cursor rule: ${source}`);
        if (kind === 'skills' && !identifier.test(relative.split('/')[0])) fail(`Неверное имя skill: ${source}`);
        const data = read(root, source);
        validateCursorRule(source, data);
        payload.push({ source, target: payloadTarget(manifest.id, source), data });
      }
    }
    if (!payload.length) fail(`Пустой модуль: ${name}`);
    const skills = [...new Set(payload.filter(file => file.source.startsWith('skills/')).map(file => file.source.split('/')[1]))];
    for (const skill of skills) {
      const entrypoint = payload.find(file => file.source === `skills/${skill}/SKILL.md`);
      const text = entrypoint?.data.toString('utf8').replace(/\r\n/g, '\n');
      if (!text?.startsWith('---\n') || !text.includes(`\nname: ${skill}\n`) || !/\ndescription: .+\n/.test(text) ||
          text.indexOf('\n---\n', 4) < 0) fail(`Некорректный SKILL.md: ${manifest.id}/${skill}`);
    }
    validateChoices({ ...manifest, payload });
    const segments = location.split('/');
    result.set(manifest.id, { ...manifest, root, location, group: segments.length > 2 ? segments[1] : 'ungrouped', payload });
  }
  return result;
}

function splitBlock(text) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 && b < 0) return { before: text, block: '', after: '' };
  if (a < 0 || b < a || text.indexOf(start, a + start.length) >= 0 || text.indexOf(end, b + end.length) >= 0) {
    fail('Повреждены маркеры skill-hub в AGENTS.md');
  }
  return { before: text.slice(0, a), block: text.slice(a, b + end.length), after: text.slice(b + end.length) };
}

function instructions(selected) {
  if (!selected.length) return '';
  const lines = [start, '## Подключённые модули skill-hub', '',
    'Cursor rules (.mdc) применяются по их alwaysApply, globs и description; ссылки ниже служат каталогом.',
    'Правила старых версий (.md) прочитай перед работой. Skills и роли читай при подходящей задаче.',
    'Роли здесь являются переносимыми инструкциями; делегирование зависит от возможностей среды и задачи.',
    'Установка модуля не даёт разрешения на внешние действия вне запроса пользователя.', ''];
  for (const module of selected) {
    lines.push(`### ${module.id}`, '', module.description, '');
    for (const file of module.payload) {
      if (file.source.startsWith('skills/') && !file.source.endsWith('/SKILL.md')) continue;
      lines.push(`- ${file.source.split('/')[0]}: [${file.source}](${file.target})`);
    }
    lines.push('');
  }
  lines.push(end);
  return lines.join('\n');
}

function loadLock(project) {
  const bytes = read(project, lockPath);
  if (!bytes) return null;
  const lock = JSON.parse(bytes.toString('utf8'));
  if (lock.schema !== 1 || !Array.isArray(lock.modules) || !lock.files || typeof lock.files !== 'object' ||
      !/^[a-f0-9]{64}$/.test(lock.blockHash)) fail('Повреждён skill-hub.lock.json');
  for (const [file, record] of Object.entries(lock.files)) {
    if ((!file.startsWith('.agents/skills/') && !file.startsWith('.agents/skill-hub/') && !file.startsWith('.cursor/rules/skill-hub/')) ||
        !record || !/^[a-f0-9]{64}$/.test(record.hash) || !identifier.test(record.module)) fail(`Неверная запись lock: ${file}`);
    contained(project, file);
  }
  return lock;
}

function selection(ids, available) {
  const families = new Map();
  return [...new Set(ids)].sort().map(id => {
    const module = available.get(id);
    if (!module) fail(`Неизвестный модуль: ${id}`);
    if (module.family && families.has(module.family)) fail(`Конфликт ${module.family}: ${families.get(module.family)} и ${id}`);
    if (module.family) families.set(module.family, id);
    return module;
  });
}

function plan(project, selected, adopted = new Map(), migrated = new Map()) {
  const lock = loadLock(project);
  selected = selected.map(module => selectModule(module, module.selectedChoices ?? choiceSelection(module, lock?.modules.find(item => item.id === module.id), lock?.files)));
  const wanted = new Map();
  const portableNames = new Set();
  for (const module of selected) {
    for (const file of module.payload) {
      const portable = file.target.toLowerCase();
      if (portableNames.has(portable)) fail(`Модули записывают один файл: ${file.target}`);
      portableNames.add(portable);
      wanted.set(file.target, { data: file.data, hash: hash(file.data), module: module.id });
    }
  }
  const previous = lock?.files ?? {};
  const changes = [];
  for (const file of [...new Set([...Object.keys(previous), ...wanted.keys()])].sort()) {
    const current = read(project, file);
    const old = previous[file];
    const next = wanted.get(file);
    if (old && current && hash(current) !== old.hash) fail(`Локальные правки: ${file}. Сохрани их отдельно или перенеси в модуль перед apply.`);
    if (!old && current && !(adopted.get(file) === hash(current) && next?.hash === hash(current)) && !(migrated.get(file)?.before === hash(current) && migrated.get(file)?.after === next?.hash)) fail(`Файл принадлежит проекту: ${file}. Автоматическая перезапись запрещена.`);
    if (next && (!current || hash(current) !== next.hash)) changes.push({ file, action: current ? 'update' : 'create', data: next.data });
    if (!next && current) changes.push({ file, action: 'remove', data: null });
  }
  const agents = read(project, 'AGENTS.md');
  const originalAgents = agentText(agents);
  const parts = splitBlock(originalAgents);
  if (lock && hash(parts.block) !== lock.blockHash) fail('Блок skill-hub в AGENTS.md изменён локально или удалён. Восстанови его перед apply.');
  if (!lock && parts.block) fail('Найден блок skill-hub без lock. Автоматически принимать его под управление нельзя.');
  const block = instructions(selected);
  const separator = !parts.block && parts.before && !parts.before.endsWith('\n\n') ? (parts.before.endsWith('\n') ? '\n' : '\n\n') : '';
  const previousSeparator = lock?.separator ?? '';
  if (!['', '\n', '\n\n'].includes(previousSeparator)) fail('Неверный separator в lock');
  const before = !block && previousSeparator && parts.before.endsWith(previousSeparator)
    ? parts.before.slice(0, -previousSeparator.length) : parts.before;
  const nextAgents = before + (block ? separator + block : '') + parts.after;
  if (nextAgents !== originalAgents) changes.push({ file: 'AGENTS.md', action: agents ? 'update' : 'create', data: Buffer.from(nextAgents) });
  const nextLock = {
    schema: 1,
    modules: selected.map(({ id, version, source, pinned, selectedChoices }) => ({ id, version, ...(source ? { source } : {}), ...(pinned ? { pinned: true } : {}), ...(selectedChoices ? { selection: selectedChoices } : {}) })),
    files: Object.fromEntries([...wanted].map(([file, record]) => [file, { hash: record.hash, module: record.module }])),
    blockHash: hash(block),
    separator: block ? (parts.block ? previousSeparator : separator) : '',
  };
  const nextBytes = Buffer.from(JSON.stringify(nextLock, null, 2) + '\n');
  const previousBytes = read(project, lockPath);
  if (!previousBytes || !isDeepStrictEqual(lock, nextLock)) changes.push({ file: lockPath, action: previousBytes ? 'update' : 'create', data: nextBytes });
  changes.push(...cursorIgnoreChanges(project));
  return changes;
}

function apply(project, changes) {
  const snapshots = changes.map(change => ({ ...change, original: read(project, change.file) }));
  const completed = [];
  try {
    for (const change of snapshots) {
      const target = contained(project, change.file);
      if (change.data === null) fs.unlinkSync(target);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        completed.push(change);
        fs.writeFileSync(target, change.data);
        continue;
      }
      completed.push(change);
    }
  } catch (error) {
    const failures = [];
    for (const change of completed.reverse()) {
      try {
        const target = contained(project, change.file);
        if (change.original === null) { if (fs.existsSync(target)) fs.unlinkSync(target); }
        else fs.writeFileSync(target, change.original);
      } catch (rollbackError) { failures.push(`${change.file}: ${rollbackError.message}`); }
    }
    if (failures.length) fail(`${error.message}\nНе удалось восстановить: ${failures.join('; ')}`);
    throw error;
  }
}

async function main(args) {
  const command = args.shift();
  if (!command || command === '--help') {
    console.log('node scripts/hub.mjs list | validate | status <project> | apply <project> <module...> [--preset <name>] [--choose module:group=option,option] [--dry-run] [--none]');
    return;
  }
  if (command === 'status') {
    if (args.length !== 1) fail('Укажи один путь проекта');
    const project = fs.realpathSync(args[0]);
    const lock = loadLock(project);
    if (!lock) { console.log('Модули не установлены'); return; }
    for (const module of lock.modules) console.log(`${module.id}@${module.version}`);
    let dirty = false;
    for (const [file, record] of Object.entries(lock.files)) {
      const current = read(project, file);
      if (!current || hash(current) !== record.hash) { console.log(`${current ? 'modified' : 'missing'} ${file}`); dirty = true; }
    }
    const block = splitBlock(agentText(read(project, 'AGENTS.md'))).block;
    if (hash(block) !== lock.blockHash) { console.log('modified AGENTS.md (skill-hub block)'); dirty = true; }
    if (dirty) process.exitCode = 1;
    return;
  }
  const available = catalog();
  if (command === 'list') {
    if (args.length) fail('list не принимает аргументы');
    for (const module of [...available.values()].sort((a, b) => a.location.localeCompare(b.location))) console.log(`${module.id}${module.family ? ` [${module.family}]` : ''} (${module.location}): ${module.description}`);
    return;
  }
  if (command === 'validate') {
    if (args.length) fail('validate не принимает аргументы');
    for (const preset of fs.readdirSync(path.join(hub, 'presets'))) {
      if (!preset.endsWith('.json')) continue;
      const config = json(contained(hub, `presets/${preset}`));
      if (!Array.isArray(config.modules)) fail(`Неверный preset: ${preset}`);
      selection(config.modules, available);
    }
    const { validateHistory } = await import('./module-history.mjs');
    const releases = validateHistory(hub);
    console.log(`OK: ${available.size} независимых модулей, manifests, skills, presets и ${releases} сохранённых версий`);
    return;
  }
  if (command !== 'apply') fail(`Неизвестная команда: ${command}`);
  const projectArg = args.shift();
  if (!projectArg || projectArg.startsWith('--')) fail('Укажи существующую папку проекта');
  const project = fs.realpathSync(projectArg);
  if (!fs.statSync(project).isDirectory()) fail('Project должен быть каталогом');
  if (project === hub || project.startsWith(hub + path.sep)) fail('Устанавливай модули в отдельный проект, вне каталога hub');
  let dryRun = false;
  let none = false;
  const ids = [];
  const choices = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--none') none = true;
    else if (args[i] === '--choose') {
      const match = /^([a-z0-9-]+):([a-z0-9-]+)=(.*)$/.exec(args[++i] || '');
      if (!match) fail('Формат выбора: --choose module:group=option,option');
      choices.push({ id: match[1], group: match[2], values: match[3] ? match[3].split(',') : [] });
    }
    else if (args[i] === '--preset') {
      const preset = args[++i];
      if (!identifier.test(preset ?? '')) fail('Укажи имя preset');
      const config = json(contained(hub, `presets/${preset}.json`));
      if (!Array.isArray(config.modules)) fail('Неверный preset');
      ids.push(...config.modules);
    } else if (args[i].startsWith('--')) fail(`Неизвестный флаг: ${args[i]}`);
    else ids.push(args[i]);
  }
  if ((!ids.length && !none) || (ids.length && none)) fail('Укажи полный набор модулей либо --none для отключения всех');
  const { resolveModules, history } = await import('./module-history.mjs');
  const selected = resolveModules(hub, project, ids);
  for (const choice of choices) {
    const index = selected.findIndex(module => module.id === choice.id);
    if (index < 0) fail(`Выбор указан для неподключённого модуля: ${choice.id}`);
    selected[index] = selectModule(selected[index], { ...selected[index].selectedChoices, [choice.group]: choice.values });
  }
  const changes = plan(project, selected);
  console.log(`Проект: ${project}\nИтоговый набор: ${selected.map(module => module.id).join(', ') || '(пусто)'}`);
  for (const change of changes) console.log(`${change.action} ${change.file}`);
  if (dryRun) console.log('Предпросмотр: файлы не изменены');
  else { for (const module of selected) if (module.source !== 'project') history(hub).checkpoint(module); apply(project, changes); console.log(changes.length ? 'Готово. Удалённые управляемые файлы можно вернуть повторным подключением модуля.' : 'Изменений нет'); }
}

export { hub, catalog, selection, plan, apply, loadLock, contained, files, read, hash, json, splitBlock, agentText };

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
}
