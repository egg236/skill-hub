async function convertProjectInstructions(project) {
  const { prompt } = await api('conversion-prompt');
  const candidates = (project.instructions || []).filter(item => !item.managed);
  const labels = { skill: 'Скилл', rule: 'Правило', role: 'Роль' };
  const form = showDialog('Превратить инструкции в модули', project.name,
    '<p>Выбери исходники. Агент предложит независимые модули, а хаб упакует их текст и ресурсы в версии этого проекта.</p>' +
    '<p class="muted">После сохранения старые инструкции будут убраны из рабочих папок в резервный архив. Пока модули не подключены, их инструкции не активны. Корневой AGENTS.md сохраняется.</p>' +
    '<div class="conversion-items">' + candidates.map(item => '<label class="module-option"><input type="checkbox" data-convert-item value="' + escape(item.path) + '" ' + (item.packedAs?.length && !item.packedChanged ? '' : 'checked') + '><span><strong>' + labels[item.kind] + ' · ' + escape(item.name) + '</strong><small class="path">' + escape(item.path) + (item.packedChanged ? ' · изменён после упаковки' : item.packedAs?.length ? ' · уже упакован в проектный модуль' : '') + '</small></span></label>').join('') + '</div>' +
    '<details><summary>Готовая инструкция для агента</summary><pre class="source-view">' + escape(prompt) + '</pre></details>',
    '<div class="conversion-progress"><p id="conversion-status" role="status" aria-live="polite">Подготовка ещё не запущена. Обработка может занять несколько минут; предел — 5 минут. Закрытие окна остановит агента.</p><p id="conversion-error" class="form-error" role="alert" hidden></p></div>' +
    cancel + '<button type="button" id="conversion-stop" hidden>Остановить</button><button type="button" id="conversion-retry" hidden>Проверить результат</button><button type="button" class="primary" id="conversion-generate">Подготовить модули через агента</button>', true);
  dialog.classList.add('conversion-pending');
  const generation = dialogGeneration;
  let jobId, timer, clock, disposed = false, serial = 0, startedAt, phase, resume;
  const alive = () => !disposed && dialog.open && generation === dialogGeneration;
  const status = $('#conversion-status');
  const errorBox = $('#conversion-error');
  const retry = $('#conversion-retry');
  const tick = () => {
    if (!alive()) return;
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    status.textContent = phase + ' · ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  };
  const progress = message => {
    phase = message; errorBox.hidden = true; retry.hidden = true;
    clearInterval(clock); tick(); clock = setInterval(tick, 1000);
  };
  const request = (route, method = 'GET', body) => api(route, method, body, { signal: AbortSignal.timeout(15_000) });
  const errorText = error => error.name === 'TimeoutError' || error.name === 'AbortError'
    ? 'Хаб не ответил за 15 секунд. Проверь, что сервер работает.' : error.message;
  const busy = value => {
    $('#conversion-generate').disabled = value;
    $('#conversion-generate').textContent = value ? 'Подготовка…' : 'Подготовить модули через агента';
    $('#conversion-stop').hidden = !value && !jobId;
    form.querySelectorAll('[data-convert-item]').forEach(input => { input.disabled = value || !!resume; });
  };
  const failure = (message, error, retryAction) => {
    clearInterval(clock); resume = retryAction;
    busy(false); status.textContent = message;
    errorBox.textContent = errorText(error); errorBox.hidden = false;
    retry.hidden = !resume;
  };
  const stop = () => {
    serial++; clearTimeout(timer); clearInterval(clock); resume = null; retry.hidden = true;
    if (jobId) api('agent/' + jobId, 'DELETE', {}).catch(() => {});
    jobId = null;
  };
  agentCleanup = () => { disposed = true; stop(); dialog.classList.remove('conversion-pending'); };
  $('#conversion-stop').onclick = () => { stop(); busy(false); errorBox.hidden = true; status.textContent = 'Подготовка остановлена. Исходные файлы сохранены.'; };
  retry.onclick = async () => { const action = resume; if (action) { busy(true); await action(); } };
  $('#conversion-generate').onclick = async () => {
    const paths = [...form.querySelectorAll('[data-convert-item]:checked')].map(input => input.value);
    if (!paths.length || paths.length > 50) { failure('Подготовка не запущена.', new Error('Выбери от 1 до 50 наборов инструкций.')); return; }
    stop(); const run = serial;
    startedAt = Date.now(); busy(true); progress('Запускаем агента');
    try {
      const job = await request('projects/' + project.id + '/conversion-draft', 'POST', { paths });
      if (!alive() || run !== serial) { api('agent/' + job.id, 'DELETE', {}).catch(() => {}); return; }
      jobId = job.id;
      startedAt = Date.parse(job.startedAt) || startedAt;
      progress('Агент группирует инструкции. Ожидаем ответ, максимум 5 минут');
      let failures = 0;
      let waiting = 'Агент группирует инструкции. Ожидаем ответ, максимум 5 минут';
      async function poll() {
        if (!alive() || run !== serial) return;
        progress(waiting);
        let result;
        try {
          result = await request('agent/' + job.id);
        } catch (error) {
          if (!alive() || run !== serial) return;
          if (++failures < 3) {
            progress('Не удалось получить статус. Повторяем проверку (' + failures + '/3)');
            timer = setTimeout(poll, 1500); return;
          }
          failure('Статус недоступен; агент мог продолжить работу. Можно проверить тот же запуск.', error, () => { failures = 0; return poll(); });
          return;
        }
        if (!alive() || run !== serial) return;
        failures = 0;
        if (result.status === 'running') {
          if (result.phase === 'repairing') {
            waiting = 'Агент исправляет состав модулей · попытка 2 из 2';
            progress(waiting);
          }
          timer = setTimeout(poll, 1200); return;
        }
        jobId = null;
        if (result.status !== 'ready') {
          failure('Агент не подготовил модули. Исходные файлы сохранены.', new Error(result.error || 'Подготовка остановлена.'));
          return;
        }
        const proposal = { paths, revision: job.revision, modules: result.modules };
        async function previewResult() {
          progress('Агент подготовил модули. Проверяем состав и форматы файлов');
          try {
            const preview = await request('projects/' + project.id + '/conversion-preview', 'POST', proposal);
            if (alive() && run === serial) showConversionReview(project, proposal, preview);
          } catch (error) {
            if (alive() && run === serial) failure('Ответ агента получен, но проверка модулей не завершилась.', error, previewResult);
          }
        }
        await previewResult();
      }
      timer = setTimeout(poll, 700);
    } catch (error) { if (alive() && run === serial) failure('Не удалось получить подтверждение запуска подготовки.', error); }
  };
}

function showConversionReview(project, proposal, preview) {
  const form = showDialog('Проверить проектные модули', project.name,
    '<p>Проверь названия, состав и изменения формата. Содержимое ресурсов переносится целиком; ссылки на файлы вне выбранных наборов нужно проверить отдельно.</p>' +
    preview.modules.map((module, index) => '<section class="conversion-module"><span class="repo-tag">' + escape(module.tag) + '</span><div class="form-row"><label>ID модуля<input name="module-id-' + index + '" value="' + escape(module.id) + '" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="63"></label><label>Группа<input name="module-group-' + index + '" value="' + escape(module.group) + '" required></label></div><label>Описание<input name="module-description-' + index + '" value="' + escape(module.description) + '" required></label>' +
      foldGroup('conversion:' + project.id + ':' + module.id + ':manifest', 'Формат модуля проверен · manifest JSON', '<pre class="source-view">' + escape(JSON.stringify(module.manifest, null, 2)) + '</pre>', 'fold-group', false) +
      foldGroup('conversion:' + project.id + ':' + module.id + ':files', 'Файлы · ' + module.files.length,
        '<ul class="file-list">' + module.files.map(file => '<li><span class="path">' + escape(file.source) + '</span> → <span class="path">' + escape(file.target) + '</span>' + (file.binary ? ' · двоичный ресурс' : '') + '</li>').join('') + '</ul>') +
      diffMarkup(module.files.filter(file => file.changed).map(file => ({ file: file.target, action: 'update', before: file.before, after: file.after }))) + '</section>').join('') +
    migrationMarkup(preview.migration) + '<p class="muted">Создаются проектные версии. Исходники из списка выше уйдут в резервный архив. Подключённые модули сохранятся; новые нужно подключить следующим шагом.</p>',
    cancel + '<button class="primary" type="submit">Создать версии и перенести исходники</button>', true);
  const generation = dialogGeneration;
  bindSubmit(form, async input => {
    const modules = proposal.modules.map((module, index) => ({ ...module, id: input['module-id-' + index].trim(), group: input['module-group-' + index].trim(), description: input['module-description-' + index].trim() }));
    const updated = { ...proposal, modules };
    if (JSON.stringify(modules) !== JSON.stringify(proposal.modules)) {
      const refreshed = await api('projects/' + project.id + '/conversion-preview', 'POST', updated);
      if (generation === dialogGeneration && dialog.open) showConversionReview(project, updated, refreshed);
      return;
    }
    const result = await api('projects/' + project.id + '/convert', 'POST', { ...updated, fingerprint: preview.fingerprint });
    dialog.close(); await refresh({ resetSelection: false });
    showDialog('Завершить преобразование · подключение', project.name,
      '<p>Проектные версии созданы, старые исходники перенесены в резервный архив. Остался шаг подключения: проверь установку рабочих файлов под управление хаба. После применения модули появятся среди подключённых.</p>' + result.modules.map(module => '<div class="skill-row"><div><strong>' + escape(module.id) + '</strong><small class="repo-tag">' + escape(module.tag) + '</small></div><div class="actions"><button type="button" data-connect-converted="' + escape(module.id) + '">Подключить…</button><button type="button" data-open-converted="' + escape(module.id) + '">Открыть</button><button type="button" data-promote-converted="' + escape(module.id) + '">Перенести в хаб</button></div></div>').join(''), '<button type="button" data-close>Подключить позже</button><button type="button" class="primary" id="connect-all-converted">Подключить и принять файлы под управление…</button>', true);
    $('#connect-all-converted').onclick = () => attempt(() => connectProjectModules(project, result.modules.map(module => module.id)));
    dialog.querySelectorAll('[data-connect-converted]').forEach(button => { button.onclick = () => attempt(() => connectProjectModule(project, button.dataset.connectConverted)); });
    dialog.querySelectorAll('[data-open-converted]').forEach(button => { button.onclick = () => attempt(async () => {
      const module = await api('projects/' + project.id + '/modules/' + button.dataset.openConverted + '?source=project&version=latest');
      moduleEditor(module, state.project || project);
    }); });
    dialog.querySelectorAll('[data-promote-converted]').forEach(button => { button.onclick = () => attempt(() => promoteProjectModule(state.project || project, button.dataset.promoteConverted)); });
  });
}
