// Loaded after app.js; shares its local UI state and dialog helpers.
function formError(error) {
  $('#form-error').textContent = error.message || String(error);
  $('#form-error').hidden = false;
}
function agentPanel() {
  return '<details class="agent-panel"><summary>✳ Попросить агента изменить файл</summary><label>Что изменить<textarea id="agent-task" rows="3" placeholder="Например: добавь проверку обратной совместимости"></textarea></label><div class="detail-actions"><button type="button" id="agent-start">Создать черновик</button><button type="button" id="agent-stop" hidden>Остановить</button></div><p id="agent-status" class="muted" role="status">Используется Cursor Agent. Результат можно проверить перед сохранением.</p><div id="agent-result" hidden><div id="agent-diff"></div><label>Предложенный файл<textarea id="agent-output" class="editor" readonly></textarea></label><button type="button" id="agent-accept">Вставить в редактор</button></div></details>';
}
function attachAgent(editor, getName, accept = content => { editor.value = content; editor.dispatchEvent(new Event('input')); }) {
  const generation = dialogGeneration;
  const currentTarget = () => { const value = getName(); return typeof value === 'string' ? { kind: 'skill', name: value } : value; };
  let jobId, timer, disposed = false;
  const alive = () => !disposed && dialog.open && generation === dialogGeneration;
  const start = $('#agent-start'), stop = $('#agent-stop'), status = $('#agent-status');
  const cleanup = () => {
    disposed = true;
    clearTimeout(timer);
    if (jobId) api(`agent/${jobId}`, 'DELETE', {}).catch(() => {});
  };
  agentCleanup = cleanup;
  stop.onclick = async () => {
    if (jobId) await api(`agent/${jobId}`, 'DELETE', {}).catch(error => { status.textContent = error.message; });
    clearTimeout(timer);
    jobId = null;
    stop.hidden = true;
    start.disabled = false;
    status.textContent = 'Задача остановлена. Текст редактора сохранён.';
  };
  start.onclick = async () => {
    try {
      const target = currentTarget();
      if (!target) throw new Error('Выбери текстовый файл в списке.');
      const task = $('#agent-task').value.trim();
      const originalContent = editor.value;
      if (!task) throw new Error('Опиши, что должен изменить агент.');
      start.disabled = true;
      $('#agent-result').hidden = true;
      status.textContent = 'Агент готовит черновик…';
      const job = await api('agent', 'POST', { ...target, task, content: originalContent });
      jobId = job.id;
      if (!alive()) { cleanup(); return; }
      stop.hidden = false;
      async function poll() {
        try {
          const result = await api(`agent/${jobId}`);
          if (!alive()) return;
          if (result.status === 'running') { timer = setTimeout(poll, 1200); return; }
          jobId = null;
          start.disabled = false;
          stop.hidden = true;
          if (result.status !== 'ready') throw new Error(result.error || 'Задача остановлена.');
          status.textContent = result.summary;
          $('#agent-output').value = result.content;
          $('#agent-diff').innerHTML = diffMarkup([{ file: target.path || target.name, action: 'update', before: originalContent, after: result.content }]);
          $('#agent-result').hidden = false;
          $('#agent-accept').onclick = () => {
            if (JSON.stringify(currentTarget()) !== JSON.stringify(target)) { status.textContent = 'Вернись к файлу, для которого подготовлен черновик.'; return; }
            if (editor.value !== originalContent) { status.textContent = 'Текст редактора изменился после запуска. Сравни черновик с текущим текстом и перенеси нужные правки.'; return; }
            accept(result.content);
            status.textContent = 'Черновик вставлен. Проверь текст и сохрани новую версию.';
          };
        } catch (error) { if (alive()) { status.textContent = error.message; start.disabled = false; stop.hidden = true; } }
      }
      timer = setTimeout(poll, 700);
    } catch (error) { if (alive()) { status.textContent = error.message; start.disabled = false; } }
  };
}
async function viewVersion(id, version) {
  const module = await api(`modules/${id}/versions/${version}`);
  showDialog(`${id} · ${version}`, module.origin?.repo ? `Источник: ${module.origin.repo} · ${module.origin.version || module.origin.baseVersion}` : 'Сохранённая версия хаба', `<p>${escape(module.description)}</p>${module.files.map(file => `<details class="version-file"><summary>${escape(file.path)} · ${file.size} байт</summary>${file.content === null ? '<p class="muted">Двоичный или большой файл.</p>' : `<pre class="source-view">${escape(file.content)}</pre>`}</details>`).join('')}`, '<button type="button" data-close>Закрыть</button>', true);
}
function moduleEditor(module, context, initialPath) {
  const draft = new Map(module.files.map(file => [file.path, { ...file, removed: false }]));
  let selected = initialPath || module.files[0]?.path;
  const form = showDialog(context ? `Настроить ${module.id} для проекта` : `Редактировать ${module.id}`,
    context ? `${context.name} · сохранение создаст версию проекта` : 'Сохранение создаст новую версию; предыдущая останется в истории.',
    `<div class="form-grid"><label>Описание модуля<input name="description" value="${escape(module.description)}" required></label><div class="file-toolbar"><span id="module-file-path" class="path"></span><button type="button" id="remove-module-file" class="danger">Удалить файл</button></div><div class="file-workspace"><nav id="module-file-tree" class="file-tree" aria-label="Файлы модуля"></nav><label id="module-file-label">Содержимое<textarea id="module-content" class="editor" spellcheck="false"></textarea><small id="binary-message" hidden>Двоичные и большие файлы сохраняются без изменений.</small></label></div><div class="new-file"><input id="new-module-path" aria-label="Путь нового файла" placeholder="rules/my-rule.mdc"><button type="button" id="new-module-file">+ Добавить файл</button></div>${foldGroup(`module-editor:${context?.id || 'hub'}:${module.id}:composition`, 'Обязательные файлы и варианты', '<div id="module-choice-editor"></div>', 'fold-group', false)}${agentPanel()}</div>`, `${cancel}<button type="submit" class="primary">Сохранить новую версию</button>`, true);
  const tree = $('#module-file-tree'), editor = $('#module-content');
  const scope = `module-editor:${context?.id || 'hub'}:${module.id}`;
  const getChoices = mountChoiceEditor($('#module-choice-editor'), module.choices, scope, () => [...draft.values()].filter(file => !file.removed).map(file => file.path));
  function choose() {
    const file = draft.get(selected);
    editor.disabled = !file || file.content === null;
    editor.value = file?.content || '';
    $('#module-file-path').textContent = selected || '';
    $('#binary-message').hidden = !(file && file.content === null);
    $('#remove-module-file').disabled = !file;
    $('#agent-start').disabled = !file || file.content === null;
  }
  function renderFiles() {
    const remaining = [...draft.values()].filter(file => !file.removed);
    if (!remaining.some(file => file.path === selected)) selected = remaining[0]?.path;
    tree.innerHTML = fileTreeMarkup(remaining, selected, scope);
    choose();
  }
  editor.oninput = () => { if (selected) draft.get(selected).content = editor.value; };
  tree.onclick = event => { const button = event.target.closest('[data-tree-file]'); if (button) { selected = button.dataset.treeFile; renderFiles(); } };
  $('#new-module-file').onclick = () => {
    const name = $('#new-module-path').value.trim();
    if (!name || (draft.has(name) && !draft.get(name).removed)) { formError(new Error('Укажи новый путь файла.')); return; }
    const content = /^rules\/.+\.mdc$/.test(name) ? '---\ndescription: ""\nglobs: ""\nalwaysApply: true\n---\n\n' : '';
    draft.set(name, { path: name, content, removed: false });
    selected = name;
    $('#new-module-path').value = '';
    renderFiles();
    editor.focus();
  };
  $('#remove-module-file').onclick = () => { draft.get(selected).removed = true; renderFiles(); };
  attachAgent(editor, () => editor.disabled ? null : agentFileTarget(selected));
  renderFiles();
  bindSubmit(form, async input => {
    const edits = [...draft.values()].flatMap(file => {
      const original = module.files.find(item => item.path === file.path);
      if (file.removed) return original ? [{ path: file.path, content: null }] : [];
      if (file.content === null || (original && original.content === file.content)) return [];
      return [{ path: file.path, content: file.content }];
    });
    const body = { description: input.description, files: edits, choices: getChoices(), revision: module.revision,
      ...(context ? { source: module.source, version: module.version } : {}) };
    const saved = await api(context ? `projects/${context.id}/modules/${module.id}` : `modules/${module.id}`, 'PUT', body);
    dialog.close();
    if (context) {
      await refresh({ resetSelection: false });
      state.selected.add(module.id);
      const previous = state.choices.get(module.id);
      state.choices.set(module.id, { id: module.id, source: 'project', version: saved.version, ...(previous?.selection ? { selection: previous.selection } : {}) });
      choiceSchemas.set(choiceKey(module.id, { source: 'project', version: saved.version }, context.id), saved.choices || []);
      renderProjects();
      notify(`Создана версия ${saved.tag}. Просмотри и примени изменения к проекту.`);
    } else {
      await refresh();
      await openModule(module.id);
      notify(`Сохранена версия ${saved.version}.`);
    }
  });
}
function diffMarkup(changes) {
  const names = { create: 'Добавить', update: 'Изменить', remove: 'Удалить' };
  return changes.map(change => `<details class="diff-file"><summary><span class="tag change-${escape(change.action)}">${names[change.action]}</span> ${escape(change.file)}</summary>${change.binary ? '<p class="muted">Двоичный или большой файл; будет перенесён целиком.</p>' : `<div class="diff-columns"><div><small>Было</small><pre>${escape(change.before ?? '—')}</pre></div><div><small>Станет</small><pre>${escape(change.after ?? '—')}</pre></div></div>`}</details>`).join('') || '<p class="muted">Содержимое файлов совпадает.</p>';
}
async function captureProjectModule(project, id) {
  const preview = await api(`projects/${project.id}/modules/${id}/capture-preview`, 'POST', {});
  const form = showDialog('Сохранить правки репозитория', `${project.name} · ${preview.module.version}`,
    `<p class="muted">Изменённые и добавленные файлы этого модуля войдут в версию проекта. Сохранённые правки станут новой исходной точкой для обновлений.</p>${diffMarkup(preview.changes)}`,
    `${cancel}<button class="primary" type="submit">Сохранить версию проекта</button>`, true);
  bindSubmit(form, async () => {
    const saved = await api(`projects/${project.id}/modules/${id}/capture`, 'POST', { fingerprint: preview.fingerprint });
    dialog.close();
    await refresh();
    notify(`Сохранено: ${saved.tag}. Теперь версию можно перенести в хаб.`);
  });
}
async function promoteProjectModule(project, id) {
  const choice = state.choices.get(id);
  const version = choice?.source === 'project' && choice.version !== 'latest' ? choice.version : undefined;
  const preview = await api(`projects/${project.id}/modules/${id}/promote-preview`, 'POST', { version });
  const form = showDialog(`Перенести ${id} в хаб`, `Новая общая версия: ${preview.module.version}`,
    `<p class="muted">Сравнение с текущим модулем хаба. Перенос создаст общую версию с содержимым проектной версии. Подключённые проекты обновляются отдельно.</p>${preview.description.before !== preview.description.after ? `<div class="description-diff"><small>Описание</small><p>${escape(preview.description.before || '—')} → ${escape(preview.description.after)}</p></div>` : ''}${diffMarkup(preview.changes)}${JSON.stringify(preview.choices.before) !== JSON.stringify(preview.choices.after) ? diffMarkup([{ file: 'Состав модуля: группы выбора', action: 'update', before: JSON.stringify(preview.choices.before, null, 2), after: JSON.stringify(preview.choices.after, null, 2) }]) : ''}`,
    `${cancel}<button class="primary" type="submit">Создать версию в хабе</button>`, true);
  bindSubmit(form, async () => {
    const saved = await api(`projects/${project.id}/modules/${id}/promote`, 'POST', { version, fingerprint: preview.fingerprint });
    dialog.close();
    await refresh({ resetSelection: false });
    notify(`В хабе создан ${saved.id}@${saved.version} из проекта «${project.name}».`);
  });
}
function createLocalModule(project) {
  const form = showDialog('Модуль для репозитория', project.name,
    '<div class="form-grid"><label>ID<input name="id" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="project-conventions"></label><label>Описание<input name="description" required></label><label>Группа<input name="group" value="custom" required></label><label>Family · необязательно<input name="family"></label><label>Инструкции<textarea name="instructions" rows="7" required></textarea></label></div>',
    `${cancel}<button class="primary" type="submit">Создать модуль проекта</button>`);
  bindSubmit(form, async input => {
    const module = await api(`projects/${project.id}/modules`, 'POST', input);
    dialog.close();
    await refresh({ resetSelection: false });
    state.selected.add(module.id);
    state.choices.set(module.id, { id: module.id, source: 'project', version: module.version });
    renderProjects();
    notify(`Создан ${module.tag}. Просмотри и примени изменения к проекту.`);
  });
}

function pathPickerField(value, placeholder, help, skill = false) {
  return '<label>Путь<div class="path-picker"><input name="path" value="' + escape(value) + '" required placeholder="' + escape(placeholder) + '"><button type="button" data-pick-path="folder">Выбрать папку…</button>' + (skill ? '<button type="button" data-pick-path="file">Выбрать SKILL.md…</button>' : '') + '<button type="button" data-cancel-picker hidden>Отменить выбор</button></div><small data-picker-status hidden role="status"></small><small>' + escape(help) + '</small></label>';
}
function bindPathPicker(form, options = {}) {
  const generation = dialogGeneration;
  const buttons = [...form.querySelectorAll('[data-pick-path]')];
  const cancelPicker = form.querySelector('[data-cancel-picker]');
  const status = form.querySelector('[data-picker-status]');
  for (const button of buttons) button.onclick = async () => {
    pickerCleanup?.();
    const controller = new AbortController();
    const cleanup = () => controller.abort();
    pickerCleanup = cleanup;
    try {
      buttons.forEach(button => { button.disabled = true; });
      cancelPicker.hidden = false;
      cancelPicker.onclick = cleanup;
      status.hidden = false;
      status.textContent = 'Открываем системное окно. Если оно не появилось, отмени выбор и попробуй ещё раз.';
      const input = { kind: button.dataset.pickPath };
      if (form.elements.path.value.trim()) input.initial = form.elements.path.value.trim();
      const result = await api('picker', 'POST', input, { signal: controller.signal });
      if (generation !== dialogGeneration || !dialog.open || result.cancelled) return;
      form.elements.path.value = result.path;
      if (options.project && !form.elements.name.value.trim()) form.elements.name.value = result.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      form.elements.path.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (error) {
      if (error.name !== 'AbortError' && generation === dialogGeneration && dialog.open) formError(error);
    } finally {
      if (pickerCleanup === cleanup) {
        pickerCleanup = null;
        buttons.forEach(button => { button.disabled = false; });
        cancelPicker.hidden = true;
        status.hidden = true;
      }
    }
  };
}

function projectSkillsMarkup(project) {
  const items = project.instructions || (project.skills || []).map(item => ({ ...item, kind: 'skill' }));
  const loose = items.filter(item => !item.managed && (!item.packedAs?.length || item.packedChanged));
  const archived = items.filter(item => item.managed || (item.packedAs?.length && !item.packedChanged));
  const types = [['skill', 'Скиллы'], ['rule', 'Правила'], ['role', 'Роли']];
  const row = item => '<div class="disk-skill"><div><strong>' + escape(item.name) + '</strong><small class="path">' + escape(item.entrypoint) + '</small>' +
    (item.packedChanged ? '<small class="source-changed">Изменён после упаковки — правки ещё не входят в модуль</small>' : '') +
    (item.packedAs || []).map(module => '<small>Упакован в ' + escape(module.id) + ' · <span class="repo-tag">' + escape(module.tag) + '</span></small>').join('') +
    '</div><span class="tag">' + escape(item.managed ? 'Модуль · ' + item.module : item.packedAs?.length ? 'Исходник' : 'Файл проекта') +
    '</span><button type="button" data-project-skill="' + escape(item.path) + '">Открыть и редактировать</button></div>';
  const body = (cleanupSourceIds(project).length ? '<button type="button" id="cleanup-migrated-sources">Убрать старые исходники подключённых модулей…</button>' : '') + '<p class="muted">Здесь остаются инструкции вне модулей и исходники с новыми правками.</p><div class="detail-actions"><button type="button" id="convert-project-instructions" ' +
    (items.some(item => !item.managed) ? '' : 'disabled') + '>✳ Превратить в проектные модули</button></div>' +
    (loose.length ? types.map(([kind, title]) => {
      const matching = loose.filter(item => item.kind === kind);
      return matching.length ? foldGroup('project:' + project.id + ':disk-kind:' + kind, title + ' · ' + matching.length, matching.map(row).join('')) : '';
    }).join('') : '<p class="muted">Все найденные инструкции уже входят в модули.</p>') +
    (archived.length ? foldGroup('project:' + project.id + ':disk-packaged', 'Уже в модулях · ' + archived.length,
      '<p class="muted">Сохранённые исходники и файлы подключённых модулей. Проектные версии находятся в списке модулей ниже.</p>' + archived.map(row).join(''), 'fold-group', false) : '') +
    ((project.instructionWarnings || project.skillWarnings || []).length ? '<details><summary>Не удалось прочитать часть файлов</summary><ul>' +
      (project.instructionWarnings || project.skillWarnings).map(message => '<li>' + escape(message) + '</li>').join('') + '</ul></details>' : '');
  return foldGroup('project:' + project.id + ':disk-skills', 'Инструкции вне модулей · ' + loose.length, body, 'project-disk-skills');
}
async function openProjectSkill(project, relative) {
  const skill = await api('projects/' + project.id + '/instruction?' + new URLSearchParams({ path: relative }));
  resourceEditor('Редактировать ' + skill.name, project.name + ' · изменения сохранятся в проекте с новой версией', skill.files,
    'project:' + project.id + ':skill:' + skill.path, skill.name, async files => {
      const saved = await api('projects/' + project.id + '/instruction', 'PUT', { path: relative, revision: skill.revision, files });
      dialog.close();
      await refresh();
      notify(saved.unchanged ? 'Изменений нет.' : 'Сохранено: ' + saved.tag);
    });
}
async function reviewProjectFiles(project, modules, connection = false) {
  const cleanup = connection === 'migration';
  const generation = dialogGeneration;
  const preview = await api('projects/' + project.id + (cleanup ? '/migration-preview' : connection ? '/connection-preview' : '/adopt-preview'), 'POST', { modules });
  if (connection && (state.project?.id !== project.id || generation !== dialogGeneration)) return;
  const form = showDialog(cleanup ? 'Убрать заменённые исходники' : connection ? 'Завершить подключение проектных модулей' : 'В проекте уже есть эти скиллы и файлы', project.name,
    (connection ? '<p>Подключаем: <strong>' + escape(preview.modules.map(module => module.id).join(', ')) + '</strong>.</p><p>Совпадающие файлы проекта сохранятся и перейдут под управление хаба; недостающие файлы модулей будут добавлены. Уже подключённые модули сохранят свои версии и настройки.</p>' :
      '<p>Эти файлы появились до подключения модуля через хаб. При подключении их содержимое сохранится в версии этого репозитория; недостающие файлы выбранного модуля будут добавлены.</p>') +
    migrationMarkup(preview.migration) +
    '<details><summary>Сохраняемые файлы · ' + preview.preserved.length + '</summary><ul class="file-list">' + preview.preserved.map(file => '<li>' + escape(file) + '</li>').join('') + '</ul></details>' +
    preview.variants.map(module => '<h3>' + escape(module.id) + ' · ' + escape(module.tag) + '</h3><p class="muted">Отличия файлов проекта от выбранной версии модуля:</p>' + diffMarkup(module.differences)).join('') +
    '<details><summary>Установка · ' + preview.changes.length + ' изменений</summary><ul class="file-list">' + preview.changes.map(change => '<li>' + escape(({ create: 'Добавить', update: 'Обновить', remove: 'Удалить' })[change.action]) + ' · ' + escape(change.file) + '</li>').join('') + '</ul></details>',
    cancel + '<button class="primary" type="submit">' + (cleanup ? 'Перенести исходники в резервный архив' : connection ? 'Подключить и принять файлы под управление' : 'Подключить, сохранив файлы проекта') + '</button>', true);
  bindSubmit(form, async () => {
    await api('projects/' + project.id + (cleanup ? '/migrate' : connection ? '/connect' : '/adopt'), 'POST', { modules, fingerprint: preview.fingerprint });
    dialog.close();
    await refresh();
    notify(cleanup ? 'Заменённые исходники перенесены в резервный архив.' : 'Модули подключены. Старые исходники перенесены в резервный архив, рабочие файлы управляются хабом.');
  });
}

function createDesignDialog(module) {
  const form = showDialog('Создать дизайн через агента', 'Новый выбираемый mood-набор для ui-direction',
    '<div class="form-grid"><div class="form-row"><label>ID дизайна<input name="designName" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="63" placeholder="calm-workspace"></label><label>Название<input name="designTitle" required maxlength="200" placeholder="Calm workspace"></label></div><label>Продукт и направление<textarea name="designTask" rows="5" required placeholder="Для кого продукт, основные экраны, настроение, плотность, цвета и ограничения"></textarea></label><div class="detail-actions"><button type="button" id="design-generate">Создать черновик</button><button type="button" id="design-stop" hidden>Остановить</button></div><p id="design-status" class="muted" role="status">Агент подготовит DESIGN.md, COPY.md и tokens.css. Перед сохранением их можно отредактировать.</p><div id="design-draft" hidden><div class="file-workspace"><nav id="design-tree" class="file-tree" aria-label="Файлы дизайна"></nav><label><span id="design-path"></span><textarea id="design-content" class="editor" spellcheck="false"></textarea></label></div></div></div>',
    cancel + '<button type="submit" class="primary" id="design-save" disabled>Сохранить дизайн в новой версии</button>', true);
  const generation = dialogGeneration, editor = $('#design-content'), tree = $('#design-tree'), status = $('#design-status');
  let jobId, timer, disposed = false, serial = 0, draft, spec, selected;
  const alive = () => !disposed && dialog.open && generation === dialogGeneration;
  const setBusy = busy => {
    $('#design-generate').disabled = busy;
    $('#design-stop').hidden = !busy;
    for (const field of ['designName', 'designTitle', 'designTask']) form.elements[field].disabled = busy;
  };
  const stop = () => {
    serial++; clearTimeout(timer);
    if (jobId) api('agent/' + jobId, 'DELETE', {}).catch(() => {});
    jobId = null;
  };
  agentCleanup = () => { disposed = true; stop(); };
  $('#design-stop').onclick = () => { stop(); setBusy(false); status.textContent = 'Генерация остановлена. Можно изменить задачу и повторить.'; };
  function choose() {
    tree.innerHTML = fileTreeMarkup(draft, selected, 'design-draft:' + module.id);
    $('#design-path').textContent = selected;
    editor.value = draft.find(file => file.path === selected).content;
  }
  editor.oninput = () => { draft.find(file => file.path === selected).content = editor.value; };
  tree.onclick = event => { const button = event.target.closest('[data-tree-file]'); if (button) { selected = button.dataset.treeFile; choose(); } };
  for (const field of ['designName', 'designTitle', 'designTask']) form.elements[field].oninput = () => {
    $('#design-save').disabled = true;
    if (draft) status.textContent = 'Описание изменилось. Создай черновик заново перед сохранением.';
  };
  $('#design-generate').onclick = async () => {
    if (!form.reportValidity()) return;
    stop();
    const run = serial;
    draft = null;
    spec = { name: form.elements.designName.value.trim(), title: form.elements.designTitle.value.trim(), task: form.elements.designTask.value.trim() };
    setBusy(true); $('#design-save').disabled = true; $('#design-draft').hidden = true;
    status.textContent = 'Агент создаёт дизайн-набор…';
    try {
      const job = await api('modules/' + module.id + '/design-draft', 'POST', { ...spec, revision: module.revision });
      if (!alive() || run !== serial) { api('agent/' + job.id, 'DELETE', {}).catch(() => {}); return; }
      jobId = job.id;
      async function poll() {
        try {
          const result = await api('agent/' + job.id);
          if (!alive() || run !== serial) return;
          if (result.status === 'running') { timer = setTimeout(poll, 1200); return; }
          jobId = null; setBusy(false);
          if (result.status !== 'ready') throw new Error(result.error || 'Генерация остановлена.');
          draft = result.files.map(file => ({ ...file }));
          selected = 'DESIGN.md'; choose();
          $('#design-draft').hidden = false; $('#design-save').disabled = false;
          status.textContent = result.summary + ' Проверь файлы. Новый набор будет необязательным.';
        } catch (error) { if (alive() && run === serial) { setBusy(false); status.textContent = error.message; } }
      }
      timer = setTimeout(poll, 700);
    } catch (error) { if (alive() && run === serial) { setBusy(false); status.textContent = error.message; } }
  };
  bindSubmit(form, async () => {
    if (!draft || !spec) throw new Error('Сначала создай черновик дизайна.');
    if (form.elements.designName.value.trim() !== spec.name || form.elements.designTitle.value.trim() !== spec.title || form.elements.designTask.value.trim() !== spec.task) throw new Error('Описание изменилось. Создай черновик заново.');
    const saved = await api('modules/' + module.id + '/designs', 'POST', { name: spec.name, title: spec.title, revision: module.revision, files: draft });
    dialog.close(); await refresh(); await openModule(module.id);
    notify('Дизайн «' + spec.title + '» сохранён в версии ' + saved.version + '. Его можно выбрать в составе подключения проекта.');
  });
}
