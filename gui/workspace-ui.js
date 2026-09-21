// Collapse state is local to this browser; project IDs and module IDs keep views independent.
let foldState;
try { foldState = JSON.parse(localStorage.getItem('skill-hub.folds') || '{}'); } catch { foldState = {}; }
if (!foldState || typeof foldState !== 'object' || Array.isArray(foldState)) foldState = {};
function foldAttributes(key, initiallyOpen = true) {
  return ` data-fold="${escape(key)}"${(Object.hasOwn(foldState, key) ? foldState[key] : initiallyOpen) ? ' open' : ''}`;
}
document.addEventListener('toggle', event => {
  const target = event.target;
  if (!target.matches?.('details[data-fold]') || !target.isConnected) return;
  foldState[target.dataset.fold] = target.open;
  try { localStorage.setItem('skill-hub.folds', JSON.stringify(foldState)); } catch { /* In-memory state still works when storage is disabled. */ }
}, true);
function foldGroup(key, title, body, className = 'fold-group', initiallyOpen = true) {
  return `<details class="${className}"${foldAttributes(key, initiallyOpen)}><summary>${title}</summary><div class="fold-content">${body}</div></details>`;
}
function fileTreeMarkup(files, selected, scope, prefix = '') {
  const root = { directories: new Map(), files: [] };
  for (const file of files) {
    const display = prefix && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
    const parts = display.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.directories.has(part)) node.directories.set(part, { directories: new Map(), files: [] });
      node = node.directories.get(part);
    }
    node.files.push({ ...file, label: parts.at(-1) });
  }
  function render(node, directory) {
    return node.files.map(file => `<button type="button" class="tree-file${file.path === selected ? ' active' : ''}" data-tree-file="${escape(file.path)}" title="${escape(file.path)}">${escape(file.label)}</button>`).join('') +
      [...node.directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => foldGroup(`${scope}:folder:${directory}/${name}`, escape(name), render(child, `${directory}/${name}`), 'tree-folder')).join('');
  }
  return render(root, '');
}
function resourceEditor(title, subtitle, files, scope, skillName, save) {
  const draft = new Map(files.map(file => [file.path, { ...file }]));
  let selected = files.find(file => /(?:^|\/)SKILL\.md$/i.test(file.path))?.path || files[0]?.path;
  const form = showDialog(title, subtitle,
    `<div class="file-workspace"><nav id="resource-tree" class="file-tree" aria-label="Файлы инструкций"></nav><div class="file-pane"><label><span id="resource-path"></span><textarea id="resource-content" class="editor" spellcheck="false"></textarea></label><p id="resource-binary" class="muted" hidden>Двоичный или большой файл сохраняется без изменений.</p></div></div>${agentPanel()}`,
    `${cancel}<button type="submit" class="primary">Сохранить новую версию</button>`, true);
  const tree = $('#resource-tree'), editor = $('#resource-content');
  function choose() {
    const file = draft.get(selected);
    $('#resource-path').textContent = selected || '';
    editor.value = file?.content ?? '';
    editor.disabled = !file || file.content === null;
    $('#resource-binary').hidden = file?.content !== null;
    $('#agent-start').disabled = !file || file.content === null;
    tree.innerHTML = fileTreeMarkup([...draft.values()], selected, scope);
  }
  tree.onclick = event => { const button = event.target.closest('[data-tree-file]'); if (button) { selected = button.dataset.treeFile; choose(); } };
  editor.oninput = () => { if (selected) draft.get(selected).content = editor.value; };
  attachAgent(editor, () => editor.disabled ? null : agentFileTarget(selected, skillName));
  choose();
  bindSubmit(form, async () => {
    const edits = [...draft.values()].filter(file => file.content !== null && file.content !== files.find(original => original.path === file.path).content).map(({ path, content }) => ({ path, content }));
    await save(edits);
  });
}
async function editHubSkill(module, skill) {
  const files = module.files.filter(file => file.path.startsWith(`skills/${skill}/`));
  resourceEditor(`Редактировать ${skill}`, `Модуль ${module.id} · изменения создадут версию хаба`, files, `hub:${module.id}:${skill}`, skill, async edits => {
    const saved = await api(`modules/${module.id}`, 'PUT', { revision: module.revision, files: edits });
    dialog.close();
    await refresh();
    await openModule(module.id);
    notify(`Сохранена версия ${saved.version}.`);
  });
}

const choiceSchemas = new Map();
const choiceKey = (id, choice, projectId = state.project?.id) => `${choice.source === 'project' ? projectId + ':' : ''}${id}:${choice.source}:${choice.version}`;
function choiceSchema(module, choice) {
  if (module.configuration?.source === choice.source && module.configuration?.version === choice.version) return module.configuration.choices || [];
  if (choice.source === 'hub' && choice.version === 'latest') return module.choices || [];
  return choiceSchemas.get(choiceKey(module.id, choice)) || [];
}
function selectedOptions(module, choice) {
  const schema = choiceSchema(module, choice);
  const saved = choice.selection ?? (module.configuration?.source === choice.source && module.configuration?.version === choice.version ? module.configuration.selection : undefined);
  return Object.fromEntries(schema.map(group => [group.id, (saved?.[group.id] ?? group.default).filter(id => group.options.some(option => option.id === id))]));
}
function moduleChoiceControls(module, choice, project) {
  const schema = choiceSchema(module, choice);
  if (!schema.length) return '';
  const selection = selectedOptions(module, choice);
  return foldGroup(`project:${project.id}:parts:${module.id}`, 'Состав подключения', '<p class="muted">Общие файлы подключаются всегда. Дополнительные наборы:</p>' + schema.map(group =>
    `<fieldset class="install-options"><legend>${escape(group.title)}</legend>${group.options.map(option => `<label><input type="${group.multiple ? 'checkbox' : 'radio'}" name="option-${escape(module.id)}-${escape(group.id)}" data-module-option="${escape(module.id)}" data-option-group="${escape(group.id)}" value="${escape(option.id)}" ${selection[group.id].includes(option.id) ? 'checked' : ''}> ${escape(option.title)}</label>`).join('')}${!group.multiple ? `<label><input type="radio" name="option-${escape(module.id)}-${escape(group.id)}" data-module-option="${escape(module.id)}" data-option-group="${escape(group.id)}" value="" ${!selection[group.id].length ? 'checked' : ''}> Только общие файлы</label>` : ''}</fieldset>`).join(''));
}
function mountChoiceEditor(container, original, scope, getPaths) {
  let choices = structuredClone(original || []);
  const freshId = (prefix, items) => { let n = 1; while (items.some(item => item.id === `${prefix}-${n}`)) n++; return `${prefix}-${n}`; };
  function render() {
    const paths = new Set();
    for (const path of getPaths()) { paths.add(path); const parts = path.split('/'); for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/') + '/'); }
    container.innerHTML = '<p class="muted">Все файлы вне вариантов подключаются всегда. В варианте можно указать файл или папку с завершающим /.</p><datalist id="module-option-paths">' + [...paths].sort().map(path => `<option value="${escape(path)}">`).join('') + '</datalist>' +
      choices.map((group, gi) => foldGroup(`${scope}:choices:${group.id}`, escape(group.title),
        `<div class="form-row"><label>Название группы<input data-group-title="${gi}" value="${escape(group.title)}"></label><label>Выбор<select data-group-mode="${gi}"><option value="many" ${group.multiple ? 'selected' : ''}>Несколько вариантов</option><option value="one" ${!group.multiple ? 'selected' : ''}>Один вариант</option></select></label></div>` +
        group.options.map((option, oi) => `<div class="choice-option-editor"><label>Название варианта<input data-option-title="${gi}:${oi}" value="${escape(option.title)}"></label><label>Файлы и папки · по одному на строку<textarea rows="2" data-option-paths="${gi}:${oi}">${escape(option.paths.join('\n'))}</textarea></label><div class="path-picker"><input list="module-option-paths" data-option-add-path="${gi}:${oi}" placeholder="Выбрать путь из модуля"><button type="button" data-add-option-path="${gi}:${oi}">Добавить путь</button></div><label class="inline-check"><input type="checkbox" data-option-default="${gi}:${oi}" ${group.default.includes(option.id) ? 'checked' : ''}> Подключать по умолчанию</label><button type="button" class="quiet danger" data-remove-option="${gi}:${oi}">Убрать вариант</button></div>`).join('') +
        `<button type="button" data-add-option="${gi}">+ Вариант</button> <button type="button" class="quiet danger" data-remove-group="${gi}">Убрать группу выбора</button>`, 'choice-group')).join('') + '<button type="button" id="add-choice-group">+ Группа выбора</button>';
  }
  container.oninput = event => {
    const element = event.target;
    if (element.dataset.groupTitle !== undefined) choices[Number(element.dataset.groupTitle)].title = element.value;
    for (const [key, property] of [['optionTitle', 'title'], ['optionPaths', 'paths']]) if (element.dataset[key] !== undefined) {
      const [gi, oi] = element.dataset[key].split(':').map(Number);
      choices[gi].options[oi][property] = property === 'paths' ? element.value.split('\n').map(line => line.trim()).filter(Boolean) : element.value;
    }
  };
  container.onchange = event => {
    const element = event.target;
    if (element.dataset.groupMode !== undefined) { const group = choices[Number(element.dataset.groupMode)]; group.multiple = element.value === 'many'; if (!group.multiple) group.default = group.default.slice(0, 1); render(); }
    if (element.dataset.optionDefault !== undefined) {
      const [gi, oi] = element.dataset.optionDefault.split(':').map(Number), group = choices[gi], id = group.options[oi].id;
      group.default = element.checked ? group.multiple ? [...new Set([...group.default, id])] : [id] : group.default.filter(item => item !== id); render();
    }
  };
  container.onclick = event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.id === 'add-choice-group') choices.push({ id: freshId('group', choices), title: 'Новая группа', multiple: true, default: [], options: [{ id: 'option-1', title: 'Новый вариант', paths: [] }] });
    else if (button.dataset.addOption !== undefined) { const group = choices[Number(button.dataset.addOption)]; group.options.push({ id: freshId('option', group.options), title: 'Новый вариант', paths: [] }); }
    else if (button.dataset.removeGroup !== undefined) choices.splice(Number(button.dataset.removeGroup), 1);
    else if (button.dataset.removeOption !== undefined) { const [gi, oi] = button.dataset.removeOption.split(':').map(Number); const group = choices[gi]; group.default = group.default.filter(id => id !== group.options[oi].id); group.options.splice(oi, 1); }
    else if (button.dataset.addOptionPath !== undefined) { const [gi, oi] = button.dataset.addOptionPath.split(':').map(Number); const input = container.querySelector(`[data-option-add-path="${gi}:${oi}"]`); if (input.value.trim()) choices[gi].options[oi].paths = [...new Set([...choices[gi].options[oi].paths, input.value.trim()])]; }
    else return;
    render();
  };
  render();
  return () => choices;
}

function agentFileTarget(file, skillName) {
  if (!file) return null;
  const skill = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i.exec(file);
  if (/(?:^|\/)SKILL\.md$/i.test(file)) {
    const name = skillName || skill?.[1];
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || '')) return { kind: 'skill', name, path: file };
  }
  const name = file.split('/').at(-1).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63).replace(/-$/, '') || 'resource';
  const inSkill = /(?:^|\/)skills\//.test(file);
  const rule = !inSkill && (/(?:^|\/)rules\//.test(file) || ['AGENTS.md', 'CLAUDE.md', '.cursorrules'].includes(file));
  const role = !inSkill && /(?:^|\/)(?:agents|roles)\//.test(file);
  return { kind: rule ? 'rule' : role ? 'role' : 'text', name, path: file };
}
function moduleFileSections(module) {
  const sections = [['Правила Cursor', module.rules], ['Роли', module.agents]];
  return sections.map(([title, files]) => foldGroup('hub:' + module.id + ':' + title, escape(title) + ' · ' + files.length,
    files.map(file => '<div class="skill-row"><strong class="path">' + escape(file) + '</strong><button type="button" data-module-file="' + escape(file) + '">Открыть и редактировать</button></div>').join('') || '<p class="muted">Пока нет файлов.</p>')).join('') +
    foldGroup('hub:' + module.id + ':composition-help', 'Как подключаются файлы', '<p>Файлы вне вариантов подключаются всегда. Варианты выбираются в проекте, в разделе «Состав подключения».</p><p>Чтобы создать такой модуль: добавь файлы через «Редактировать модуль», затем раскрой «Обязательные файлы и варианты», создай группу и укажи файлы или папки её вариантов. Сохранение создаст новую версию.</p>', 'fold-group', false);
}

function projectModuleSections(project, available, option) {
  const installed = new Set(project.modules.map(module => module.id));
  const sources = [
    ['hub', 'Модули из хаба', available.filter(module => module.hasHub !== false)],
    ['project', 'Уникальные проектные', available.filter(module => module.hasHub === false)]
  ];
  return sources.map(([source, title, modules]) => '<section class="project-module-source" data-module-source="' + source + '"><h3>' + title + ' <span class="tag">' + modules.length + '</span></h3>' +
    (source === 'hub' ? '<p class="muted">Общие модули и их настроенные для этого проекта версии.</p>' : '<p class="muted">Модули, которых пока нет в общем каталоге хаба.</p>') +
    (source === 'project' && modules.some(module => module.local && !installed.has(module.id)) ? '<button type="button" class="primary" id="connect-pending-project-modules">Подключить проектные модули…</button>' : '') +
    [[true, 'Подключённые'], [false, 'Неподключённые']].map(([connected, label]) => {
      const matching = modules.filter(module => installed.has(module.id) === connected);
      return foldGroup('project:' + project.id + ':source:' + source + ':' + (connected ? 'connected' : 'available'), label + ' · ' + matching.length,
        matching.length ? groups(matching).map(group => foldGroup('project:' + project.id + ':source:' + source + ':' + connected + ':group:' + group,
          escape(groupNames[group] || group), matching.filter(module => module.group === group).map(option).join(''))).join('') : '<p class="muted">Пока нет модулей.</p>');
    }).join('') + '</section>').join('');
}

async function connectProjectModule(project, id) {
  return connectProjectModules(project, [id]);
}

async function connectProjectModules(project, ids) {
  if (state.project?.id !== project.id) throw new Error('Открой нужный проект перед подключением.');
  if (!Array.isArray(ids) || !ids.length) throw new Error('Нет неподключённых проектных модулей.');
  for (const id of ids) {
    const module = state.project.available.find(item => item.id === id);
    if (!module?.local) throw new Error('Проектная версия не найдена. Обнови список.');
  }
  // The server builds an additive set from the lock; pending checkboxes are untouched.
  await reviewProjectFiles(project, ids, true);
}

function migrationMarkup(migration) {
  if (!migration) return '';
  return (migration.files?.length ? '<details open><summary>Перенос исходников в резервный архив · ' + migration.files.length + '</summary><p>Эти старые файлы будут убраны из рабочих папок. Резервная копия хранится в JSON и не подключается как инструкции.</p><p class="path">' + escape(migration.archive) + '</p><ul class="file-list">' + migration.files.map(file => '<li>' + escape(file) + '</li>').join('') + '</ul></details>' : '') +
    (migration.replacements?.length ? '<p>Отличия устанавливаемых файлов от исходников:</p>' + diffMarkup(migration.replacements) : '') +
    (migration.agentLinks ? '<p>В AGENTS.md обновляются только ссылки на перенесённые файлы. Копия исходного файла: <span class="path">' + escape(migration.agentArchive) + '</span></p>' + diffMarkup([{ file: 'AGENTS.md · ссылки', action: 'update', before: migration.agentLinks.before, after: migration.agentLinks.after }]) : migration.preserved?.includes('AGENTS.md') ? '<p class="muted">Корневой AGENTS.md сохраняется; хаб обновляет только свой служебный блок.</p>' : '');
}
function cleanupSourceIds(project) {
  const installed = new Set((project.modules || []).map(module => module.id));
  return [...new Set((project.instructions || []).filter(item => item.path !== 'AGENTS.md' && !item.managed)
    .flatMap(item => (item.packedAs || []).filter(module => installed.has(module.id)).map(module => module.id)))];
}
