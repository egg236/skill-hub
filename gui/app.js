const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const groupNames = { workflow: 'Рабочий процесс', engineering: 'Разработка', product: 'Продукт и дизайн', integrations: 'Интеграции', authoring: 'Создание и настройка', ungrouped: 'Без группы' };
const groupIcons = { workflow: '↗', engineering: '⌘', product: '◇', integrations: '⤧', authoring: '✳' };
const groupOrder = Object.keys(groupNames);
const state = { token: '', modules: [], presets: [], projects: [], view: 'modules', group: '', search: '', project: null, selected: new Set() };
const dialog = $('#dialog');
let dialogGeneration = 0;
let agentCleanup = null;
let pickerCleanup = null;
state.choices = new Map();

async function api(route, method = 'GET', body, { signal } = {}) {
  const response = await fetch(`/api/${route}`, { method, signal, headers: { 'X-Hub-Token': state.token, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Не удалось выполнить запрос.'); error.code = data.code; error.conflicts = data.conflicts; throw error; }
  return data;
}
function notify(message, error = false) {
  const target = $('#notice');
  target.textContent = message;
  target.className = `notice${error ? ' error' : ''}`;
  target.hidden = false;
}
async function attempt(action) {
  try { await action(); } catch (error) { notify(error.message, true); }
}
function groups(modules = state.modules) {
  return [...new Set(modules.map(module => module.group))].sort((a, b) => {
    const rank = item => groupOrder.includes(item) ? groupOrder.indexOf(item) : 99;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}
function setProject(id) {
  state.project = state.projects.find(project => project.id === id) || state.projects[0] || null;
  state.selected = new Set(state.project?.modules.map(module => module.id) || []);
  state.choices = new Map((state.project?.modules || []).map(module => [module.id, { id: module.id, source: module.source || 'hub', version: module.pinned || module.source === 'project' || state.project.available?.find(item => item.id === module.id)?.hasHub === false ? module.version : 'latest', ...(module.selection ? { selection: module.selection } : {}) }]));
}
async function refresh({ resetSelection = true } = {}) {
  const [catalog, projects] = await Promise.all([api('catalog'), api('projects')]);
  state.modules = catalog.modules;
  state.presets = catalog.presets;
  state.projects = projects.projects;
  if (resetSelection) setProject(state.project?.id);
  else state.project = state.projects.find(project => project.id === state.project?.id) || null;
  render();
}
function render() {
  $('#module-count').textContent = state.modules.length;
  $('#project-count').textContent = state.projects.length;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  const modules = state.view === 'modules';
  $('#page-title').textContent = modules ? 'Модули' : 'Проекты';
  $('#breadcrumb').textContent = `Библиотека / ${modules ? 'Модули' : 'Проекты'}`;
  $('#page-description').textContent = modules ? 'Собери нужные возможности для каждого проекта.' : 'Подключай модули и обновляй контекст своих проектов.';
  $('#primary-action').textContent = modules ? '+ Создать модуль' : '+ Зарегистрировать проект';
  $('#modules-view').hidden = !modules;
  $('#projects-view').hidden = modules;
  $('#group-nav').hidden = !modules;
  $('#group-nav').innerHTML = `<div class="nav-label">ГРУППЫ</div><button class="nav-item group-filter ${state.group ? '' : 'active'}" data-group=""><span>Все модули</span><span class="muted">${state.modules.length}</span></button>` + groups().map(group => `<button class="nav-item group-filter ${state.group === group ? 'active' : ''}" data-group="${escape(group)}"><span><i class="group-dot"></i>${escape(groupNames[group] || group)}</span><span class="muted">${state.modules.filter(module => module.group === group).length}</span></button>`).join('');
  renderCatalog();
  renderProjects();
}
function card(module) {
  return `<button class="module-card" data-module="${escape(module.id)}"><div class="card-heading"><span class="module-icon">${groupIcons[module.group] || '◇'}</span><span class="module-name">${escape(module.id)}</span></div><p>${escape(module.description)}</p><div class="card-meta">${module.skills.length ? `<span class="tag">${module.skills.length} скилл.</span>` : ''}${module.rules.length ? `<span>${module.rules.length} правил.</span>` : ''}${module.agents.length ? `<span>${module.agents.length} рол.</span>` : ''}${module.family ? `<span class="tag family">${escape(module.family)}</span>` : ''}</div></button>`;
}
function renderCatalog() {
  const query = state.search.toLowerCase();
  const filtered = state.modules.filter(module => (!state.group || state.group === module.group) && [module.id, module.description, module.family, ...module.skills].join(' ').toLowerCase().includes(query));
  $('#result-count').textContent = `${filtered.length} из ${state.modules.length} модулей`;
  $('#catalog').innerHTML = groups(filtered).map(group => {
    const modules = filtered.filter(module => module.group === group);
    const families = [...new Set(modules.map(module => module.family).filter(Boolean))];
    return `<details class="group-section"${foldAttributes(`catalog:${group}`)}><summary class="section-heading"><h2>${escape(groupNames[group] || group)}</h2><span class="muted">${escape(group)} / ${modules.length}</span></summary>${families.map(family => `<div class="family-box"><div class="family-heading"><strong>${escape(family)}</strong><span>Один вариант на проект</span></div><div class="cards">${modules.filter(module => module.family === family).map(card).join('')}</div></div>`).join('')}<div class="cards">${modules.filter(module => !module.family).map(card).join('')}</div></details>`;
  }).join('') || '<div class="empty"><div class="empty-icon">⌕</div><h2>Ничего не найдено</h2><p>Попробуй другое название или выбери все группы.</p></div>';
}
function showDialog(title, subtitle, body, footer, wide = false) {
  pickerCleanup?.();
  pickerCleanup = null;
  agentCleanup?.();
  agentCleanup = null;
  dialogGeneration++;
  dialog.classList.toggle('wide', wide);
  $('#dialog-content').innerHTML = `<div class="dialog-header"><div><h2>${escape(title)}</h2><p>${escape(subtitle)}</p></div><button class="close" data-close aria-label="Закрыть">×</button></div><form id="dialog-form"><div class="dialog-body"><div id="form-error" class="form-error" role="alert" hidden></div>${body}</div><div class="dialog-footer">${footer}</div></form>`;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector('input, textarea, select, [data-close]')?.focus());
  return $('#dialog-form');
}
function bindSubmit(form, action) {
  const generation = dialogGeneration;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const buttons = [...dialog.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    $('#form-error').hidden = true;
    try { await action(Object.fromEntries(new FormData(form))); }
    catch (error) {
      if (generation === dialogGeneration && dialog.open) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
      else notify(error.message, true);
    } finally { buttons.forEach(button => { button.disabled = false; }); }
  });
}
const cancel = '<button type="button" data-close>Отмена</button>';
function confirmAction(title, message, action, label = 'Удалить') {
  const form = showDialog(title, '', `<p>${escape(message)}</p>`, `${cancel}<button class="danger" type="submit">${escape(label)}</button>`);
  bindSubmit(form, async () => { await action(); dialog.close(); await refresh(); });
}
async function openModule(id) {
  const module = await api(`modules/${encodeURIComponent(id)}`);
  showDialog(module.id, module.location, `<span class="tag">v${escape(module.version)}</span> ${module.family ? `<span class="tag family">${escape(module.family)}</span>` : ''}<p class="detail-description">${escape(module.description)}</p><div class="detail-actions"><button type="button" class="primary" id="edit-module">Редактировать модуль</button>${module.id === 'ui-direction' ? '<button type="button" id="create-design">✳ Создать дизайн через агента</button>' : ''}</div><details class="version-history"><summary>История версий · ${module.versions.length}</summary><div class="history-list">${module.versions.map(version => `<button type="button" class="quiet" data-version="${escape(version)}">${escape(version)}${version === module.version ? ' · текущая' : ''}</button>`).join('')}</div></details><h3>Скиллы <span class="muted">${module.skills.length}</span></h3><div class="detail-actions"><button type="button" id="add-skill">+ Создать скилл</button><button type="button" id="import-skill">Импорт из папки</button></div>${module.skills.map(skill => `<div class="skill-row"><div><strong>${escape(skill)}</strong><small>${module.files.filter(file => file.path.startsWith(`skills/${skill}/`)).length} файл.</small></div><div class="actions"><button type="button" data-edit-skill="${escape(skill)}">Редактировать</button><button type="button" class="quiet danger" data-delete-skill="${escape(skill)}">Удалить</button></div></div>`).join('') || '<p class="muted">В этом модуле пока нет скиллов.</p>'}${moduleFileSections(module)}`, '<button type="button" class="danger" id="delete-module">Удалить модуль</button><button type="button" data-close>Готово</button>');
  $('#edit-module').onclick = () => moduleEditor(module);
  dialog.querySelectorAll('[data-module-file]').forEach(button => { button.onclick = () => moduleEditor(module, null, button.dataset.moduleFile); });
  const design = $('#create-design');
  if (design) design.onclick = () => createDesignDialog(module);
  dialog.querySelectorAll('[data-version]').forEach(button => { button.onclick = () => attempt(() => viewVersion(module.id, button.dataset.version)); });
  $('#add-skill').onclick = () => editSkill(module);
  $('#import-skill').onclick = () => importSkill(module);
  $('#delete-module').onclick = () => confirmAction(`Удалить ${module.id}?`, 'Модуль будет перенесён в .skill-hub/trash. Копии в подключённых проектах сохранятся до следующего применения их набора модулей.', async () => {
    const result = await api(`modules/${module.id}`, 'DELETE', { revision: module.revision });
    notify(`Модуль перемещён в ${result.archive}`);
  });
  dialog.querySelectorAll('[data-edit-skill]').forEach(button => { button.onclick = () => attempt(() => editSkill(module, button.dataset.editSkill)); });
  dialog.querySelectorAll('[data-delete-skill]').forEach(button => { button.onclick = () => confirmAction(`Удалить ${button.dataset.deleteSkill}?`, 'Скилл вместе с ресурсами будет перенесён в .skill-hub/trash. Версия модуля увеличится; подключённые проекты обновляются отдельно.', async () => {
    const result = await api(`modules/${module.id}/skills/${button.dataset.deleteSkill}`, 'DELETE', { revision: module.revision });
    notify(`Скилл перемещён в ${result.archive}`);
  }); });
}
function createModule() {
  const form = showDialog('Новый модуль', 'Отдельная возможность, которую можно подключать к проектам.', `<div class="form-grid"><div class="form-row"><label>ID модуля<input name="id" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="63" placeholder="database-review"></label><label>Группа<input name="group" list="groups" value="${escape(state.group || 'engineering')}" required pattern="[a-z0-9]+(-[a-z0-9]+)*"><datalist id="groups">${groups().map(group => `<option value="${escape(group)}">${escape(groupNames[group] || group)}</option>`).join('')}</datalist></label></div><label>Описание<input name="description" required placeholder="Что делает модуль и когда он нужен"></label><label>Family · необязательно<input name="family" list="families" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="Например, git-workflow"><datalist id="families">${[...new Set(state.modules.map(module => module.family).filter(Boolean))].map(family => `<option>${escape(family)}</option>`).join('')}</datalist><small>Взаимозаменяемые варианты будут в общей папке. В проекте выбирается один вариант family.</small></label><label>Начальные инструкции<textarea name="instructions" required rows="6" placeholder="Опиши правила, которые модуль добавит в проект."></textarea><small>Сохранятся в rules/module.mdc с метаданными Cursor. Скиллы можно добавить после создания.</small></label></div>`, `${cancel}<button class="primary" type="submit">Создать модуль</button>`);
  bindSubmit(form, async input => {
    const module = await api('modules', 'POST', input);
    await refresh();
    await openModule(module.id);
    notify(`Модуль ${module.id} создан.`);
  });
}
async function editSkill(module, skill) {
  if (skill) return editHubSkill(module, skill);
  const existing = skill ? await api(`modules/${module.id}/skills/${skill}`) : null;
  const template = '---\nname: my-skill\ndescription: Что делает скилл и когда его применять.\n---\n\n# Мой скилл\n\nОпиши входные данные, действия и ожидаемый результат.\n';
  const form = showDialog(skill ? `Редактировать ${skill}` : 'Новый скилл', `Модуль: ${module.id}`, `<div class="form-grid">${skill ? '' : '<label>Имя папки<input name="name" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="63" value="my-skill"><small>Должно совпадать с name в SKILL.md.</small></label>'}<label>SKILL.md<textarea class="editor" name="content" required spellcheck="false">${escape(existing?.content || template)}</textarea><small>Обязательны YAML-поля name и description. Ресурсы существующего скилла сохраняются.</small></label>${existing ? `<details><summary class="muted">Файлы скилла (${existing.files.length})</summary><ul class="file-list">${existing.files.map(file => `<li>${escape(file)}</li>`).join('')}</ul></details>` : ''}${agentPanel()}</div>`, `${cancel}<button class="primary" type="submit">Сохранить скилл</button>`, true);
  attachAgent(form.elements.content, () => skill || form.elements.name.value);
  if (!skill) form.elements.name.addEventListener('input', () => {
    form.elements.content.value = form.elements.content.value.replace(/^name: .*$/m, `name: ${form.elements.name.value}`);
  });
  bindSubmit(form, async input => {
    await api(`modules/${module.id}/skills${skill ? '/' + skill : ''}`, skill ? 'PUT' : 'POST', { ...input, revision: existing?.revision || module.revision });
    await refresh();
    await openModule(module.id);
    notify('Скилл сохранён. Для обновления проекта примени его набор модулей.');
  });
}
function importSkill(module) {
  const form = showDialog('Импорт скилла', `Модуль: ${module.id}`, pathPickerField('', 'D:/Skills/my-skill', 'Выбери папку скилла или SKILL.md. Ресурсы папки импортируются вместе с ним. До 20 МБ и 2000 файлов.', true), `${cancel}<button class="primary" type="submit">Импортировать</button>`);
  bindPathPicker(form);
  bindSubmit(form, async input => {
    await api(`modules/${module.id}/import`, 'POST', { ...input, revision: module.revision });
    await refresh();
    await openModule(module.id);
    notify('Скилл импортирован вместе с ресурсами.');
  });
}
function registerProject(record) {
  const form = showDialog(record ? 'Изменить проект' : 'Зарегистрировать проект', 'Список сохраняется в projects.local.json.', `<div class="form-grid"><label>Название<input name="name" value="${escape(record?.name)}" required placeholder="Мой проект"></label>${pathPickerField(record?.path, 'D:/Projects/my-app', 'Выбери существующую папку проекта. После регистрации можно открыть его скиллы и подключить модули.')}</div>`, `${cancel}<button class="primary" type="submit">${record ? 'Сохранить' : 'Зарегистрировать'}</button>`);
  bindPathPicker(form, { project: true });
  bindSubmit(form, async input => {
    const project = await api(`projects${record ? '/' + record.id : ''}`, record ? 'PUT' : 'POST', input);
    dialog.close();
    await refresh();
    setProject(project.id);
    render();
    notify(`Проект «${project.name}» сохранён в реестре.`);
  });
}
function renderProjects() {
  if (!state.projects.length) {
    $('#projects').innerHTML = '<div class="empty"><div class="empty-icon">▤</div><h2>Первый проект — начало</h2><p>Зарегистрируй папку проекта, чтобы подключать общие модули и создавать свои версии.</p><button class="primary" id="empty-register">+ Зарегистрировать проект</button></div>';
    $('#empty-register').onclick = () => registerProject();
    return;
  }
  const project = state.project;
  const available = project?.available || state.modules;
  const unknown = [...state.selected].filter(id => !available.some(module => module.id === id));
  function choice(module) {
    return state.choices.get(module.id) || { id: module.id, source: module.source === 'project' ? 'project' : 'hub', version: module.source === 'project' ? module.version : 'latest' };
  }
  function option(module) {
    const selected = choice(module);
    const installed = project.modules.some(item => item.id === module.id);
    const local = selected.source === 'project';
    const label = local ? `${project.name} · ${selected.version}` : selected.version !== 'latest' ? `Закреплена ${selected.version}` : 'Версия и настройки';
    const hubVersions = module.versions || [module.version];
    return `<div class="project-module"><label class="module-option"><input type="checkbox" data-select="${escape(module.id)}" ${state.selected.has(module.id) ? 'checked' : ''}><span><strong>${escape(module.id)}</strong><small>${escape(module.description)}</small></span><span class="tag">${installed ? 'Подключён' : 'Не подключён'}</span>${module.family ? `<span class="tag family">${escape(module.family)}</span>` : ''}</label><details class="module-settings"${foldAttributes(`project:${project.id}:settings:${module.id}`, false)}><summary data-choice-label="${escape(module.id)}" class="${local ? 'repo-tag' : ''}">${escape(label)}</summary><label>Источник и версия<select data-choice="${escape(module.id)}">${module.hasHub !== false && module.source !== 'project' ? '<option value="hub@latest">Хаб · актуальная версия</option>' : ''}${hubVersions.map(version => `<option value="hub@${escape(version)}">Хаб · ${escape(version)}</option>`).join('')}${(module.localVersions || []).map(version => `<option value="project@${escape(version)}">${escape(project.name)} · ${escape(version)}</option>`).join('')}</select><small>Выбранная версия остаётся закреплённой при последующих обновлениях.</small></label><div class="detail-actions">${!installed && module.local ? `<button type="button" data-connect-local="${escape(module.id)}">Подключить…</button>` : ''}<button type="button" data-project-edit="${escape(module.id)}">Редактировать для проекта</button>${installed ? `<button type="button" data-capture="${escape(module.id)}">Правки репозитория → версия</button>` : ''}${module.local ? `<button type="button" data-promote="${escape(module.id)}">Перенести версию в хаб</button>` : ''}</div></details><div data-choice-controls="${escape(module.id)}" ${state.selected.has(module.id) ? '' : 'hidden'}>${moduleChoiceControls(module, selected, project)}</div></div>`;
  }
  $('#projects').innerHTML = `<div class="project-layout"><div class="project-list">${state.projects.map(item => `<button class="project-item ${item.id === project?.id ? 'active' : ''}" data-project="${escape(item.id)}"><strong>${escape(item.name)}</strong><span class="path">${escape(item.path)}</span><span class="tag">${item.error ? 'Недоступен' : item.problems.length ? 'Локальные изменения' : `${item.modules.length} модул.`}</span></button>`).join('')}</div>${project ? `<div class="project-panel"><div class="project-panel-header"><div><h2>${escape(project.name)}</h2><p class="path muted">${escape(project.path)}</p></div><button id="edit-project" class="quiet">Изменить</button></div>${project.error ? `<div class="notice error">${escape(project.error)}</div>` : ''}${project.problems.length ? `<div class="notice error">Есть изменения в файлах проекта. Сохрани их через «Правки репозитория → версия» у соответствующего модуля.<ul>${project.problems.map(problem => `<li>${escape(problem.file)} · ${problem.state === 'missing' ? 'отсутствует' : 'изменён'}</li>`).join('')}</ul></div>` : ''}${projectSkillsMarkup(project)}<div class="project-tools"><select id="preset" aria-label="Выбор набора"><option value="">Выбрать preset…</option>${state.presets.map(preset => `<option value="${escape(preset.id)}">${escape(preset.id)}</option>`).join('')}</select><button id="use-preset">Заменить набор</button><button id="clear-selection" class="quiet">Снять все</button></div><div class="detail-actions"><button id="create-local-module">+ Модуль для репозитория</button></div><p class="muted">Галочки задают набор для следующего применения. Разделы «Подключённые» и «Неподключённые» отражают текущее состояние проекта.</p>${unknown.length ? `<div class="notice error">Эти модули отсутствуют в каталоге. Сними выбор для отключения.${unknown.map(id => `<label class="module-option"><input type="checkbox" data-select="${escape(id)}" checked><span>${escape(id)}</span></label>`).join('')}</div>` : ''}${projectModuleSections(project, available, option)}<div class="project-apply"><span class="muted" id="selection-count">Выбрано для применения: ${state.selected.size}. Подключено сейчас: ${project.modules.length}</span><button class="primary" id="preview" ${project.error ? 'disabled' : ''}>Просмотреть изменения →</button></div><button id="unregister" class="quiet danger">Убрать из реестра</button></div>` : ''}</div>`;
  document.querySelectorAll('[data-project]').forEach(button => { button.onclick = () => { setProject(button.dataset.project); renderProjects(); }; });
  if (!project) return;
  $('#edit-project').onclick = () => registerProject(project);
  document.querySelectorAll('[data-project-skill]').forEach(button => { button.onclick = () => attempt(() => openProjectSkill(project, button.dataset.projectSkill)); });
  $('#create-local-module').onclick = () => createLocalModule(project);
  const connectPending = $('#connect-pending-project-modules');
  if (connectPending) connectPending.onclick = () => attempt(() => connectProjectModules(project,
    available.filter(module => module.hasHub === false && module.local && !project.modules.some(item => item.id === module.id)).map(module => module.id)));
  $('#convert-project-instructions').onclick = () => attempt(() => convertProjectInstructions(project));
  const cleanupSources = $('#cleanup-migrated-sources');
  if (cleanupSources) cleanupSources.onclick = () => attempt(() => reviewProjectFiles(project, cleanupSourceIds(project), 'migration'));
  $('#unregister').onclick = () => confirmAction(`Убрать «${project.name}» из реестра?`, 'Запись будет удалена. Файлы проекта и его версии модулей сохранятся.', async () => {
    await api(`projects/${project.id}`, 'DELETE', {});
    notify('Запись проекта удалена из реестра.');
  }, 'Убрать из реестра');
  $('#use-preset').onclick = () => {
    const preset = state.presets.find(item => item.id === $('#preset').value);
    if (!preset) return;
    state.selected = new Set(preset.modules);
    state.choices = new Map(preset.modules.map(id => [id, { id, source: 'hub', version: 'latest' }]));
    renderProjects();
  };
  $('#clear-selection').onclick = () => { state.selected.clear(); renderProjects(); };
  function select(id, checked) {
    const module = available.find(module => module.id === id);
    if (checked) {
      if (module?.family) available.filter(item => item.family === module.family).forEach(item => state.selected.delete(item.id));
      state.selected.add(id);
      if (module && !state.choices.has(id)) state.choices.set(id, choice(module));
    } else state.selected.delete(id);
    document.querySelectorAll('[data-select]').forEach(box => { box.checked = state.selected.has(box.dataset.select); });
    document.querySelectorAll('[data-choice-controls]').forEach(panel => { panel.hidden = !state.selected.has(panel.dataset.choiceControls); });
    $('#selection-count').textContent = `Выбрано для применения: ${state.selected.size}. Подключено сейчас: ${project.modules.length}`;
  }
  document.querySelectorAll('[data-select]').forEach(input => { input.onchange = () => select(input.dataset.select, input.checked); });
  document.querySelectorAll('[data-choice]').forEach(input => {
    const selected = choice(available.find(module => module.id === input.dataset.choice));
    input.value = `${selected.source}@${selected.version}`;
    input.onchange = () => attempt(async () => {
      const [source, version] = input.value.split('@');
      const id = input.dataset.choice;
      state.choices.set(id, { id, source, version });
      select(id, true);
      const label = document.querySelector(`[data-choice-label="${id}"]`);
      label.textContent = source === 'project' ? `${project.name} · ${version}` : version === 'latest' ? 'Версия и настройки' : `Закреплена ${version}`;
      label.classList.toggle('repo-tag', source === 'project');
      const definition = await api(`projects/${project.id}/modules/${id}?${new URLSearchParams({ source, version })}`);
      choiceSchemas.set(choiceKey(id, { source, version }, project.id), definition.choices || []);
      if (state.project?.id === project.id && state.choices.get(id)?.source === source && state.choices.get(id)?.version === version) renderProjects();
    });
  });
  document.querySelectorAll('[data-module-option]').forEach(input => { input.onchange = () => {
    const id = input.dataset.moduleOption, module = available.find(module => module.id === id), selected = choice(module);
    const selection = selectedOptions(module, selected);
    selection[input.dataset.optionGroup] = [...document.querySelectorAll('[data-module-option]')].filter(item => item.dataset.moduleOption === id && item.dataset.optionGroup === input.dataset.optionGroup && item.checked && item.value).map(item => item.value);
    state.choices.set(id, { ...selected, selection });
  }; });
  document.querySelectorAll('[data-connect-local]').forEach(button => { button.onclick = () => attempt(() => connectProjectModule(project, button.dataset.connectLocal)); });
  document.querySelectorAll('[data-project-edit]').forEach(button => { button.onclick = () => attempt(async () => {
    const id = button.dataset.projectEdit;
    const selected = choice(available.find(module => module.id === id));
    const query = new URLSearchParams({ source: selected.source, version: selected.version });
    const module = await api(`projects/${project.id}/modules/${id}?${query}`);
    moduleEditor(module, project);
  }); });
  document.querySelectorAll('[data-capture]').forEach(button => { button.onclick = () => attempt(() => captureProjectModule(project, button.dataset.capture)); });
  document.querySelectorAll('[data-promote]').forEach(button => { button.onclick = () => attempt(() => promoteProjectModule(project, button.dataset.promote)); });
  $('#preview').onclick = () => attempt(previewProject);
}

async function previewProject() {
  const project = state.project;
  const modules = [...state.selected].map(id => {
    const choice = state.choices.get(id) || { id, source: 'hub', version: 'latest' };
    const module = (project.available || state.modules).find(module => module.id === id);
    return module ? { ...choice, selection: selectedOptions(module, choice) } : choice;
  });
  let preview;
  try { preview = await api(`projects/${project.id}/preview`, 'POST', { modules }); }
  catch (error) {
    if (error.code === 'EXISTING_PROJECT_FILES') return reviewProjectFiles(project, modules);
    throw error;
  }
  const labels = { create: 'Создать', update: 'Обновить', remove: 'Удалить' };
  const form = showDialog('Изменения в проекте', project.name, `<p class="muted">Итоговый набор: ${escape((preview.choices || preview.modules.map(id => ({ id }))).map(module => module.version ? `${module.id}@${module.version}` : module.id).join(', ') || 'пусто — отключить все модули')}.</p><div class="changes">${preview.changes.map(change => `<div class="change"><span class="tag change-${escape(change.action)}">${labels[change.action]}</span><code>${escape(change.file)}</code></div>`).join('') || '<p>Всё актуально. Изменений нет.</p>'}</div>`, `${cancel}${preview.changes.length ? '<button class="primary" type="submit">Применить изменения</button>' : ''}`, true);
  bindSubmit(form, async () => {
    await api(`projects/${project.id}/apply`, 'POST', { modules, fingerprint: preview.fingerprint });
    dialog.close();
    await refresh();
    notify(`Модули проекта «${project.name}» обновлены.`);
  });
}
document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => { state.view = button.dataset.view; render(); }; });
$('#group-nav').onclick = event => { const button = event.target.closest('[data-group]'); if (button) { state.group = button.dataset.group; render(); } };
$('#search').oninput = event => { state.search = event.target.value; renderCatalog(); };
$('#catalog').onclick = event => { const button = event.target.closest('[data-module]'); if (button) attempt(() => openModule(button.dataset.module)); };
$('#primary-action').onclick = () => state.view === 'modules' ? createModule() : registerProject();
$('#refresh').onclick = () => attempt(async () => { await refresh(); notify('Каталог и состояние проектов обновлены.'); });
dialog.addEventListener('click', event => { if (event.target.closest('[data-close]')) dialog.close(); });
dialog.addEventListener('close', () => { agentCleanup?.(); agentCleanup = null; pickerCleanup?.(); pickerCleanup = null; });
document.addEventListener('DOMContentLoaded', () => {
  attempt(async () => { state.token = (await api('session')).token; await refresh(); });
}, { once: true });
