import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function setup() {
  const nodes = new Map(), timers = [], calls = [], views = [], connections = [], intervals = new Set(), classes = new Set();
  const node = key => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); };
  const selected = [{ value: '.agents/skills/old', checked: true }];
  const modules = [{ id: 'legacy-ui', group: 'product', description: 'Existing UI', items: selected.map(item => item.value) }];
  const form = { querySelectorAll: () => selected };
  let submit;
  const ctx = vm.createContext({ $: node, dialogGeneration: 1, agentCleanup: null, cancel: '', state: {},
    dialog: { open: true, close() {}, querySelectorAll: () => [], classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }, escape: String,
    showDialog(title, subtitle, body, footer) { ctx.agentCleanup?.(); ctx.dialogGeneration++; views.push({ title, body, footer }); return form; },
    attempt: action => action(), connectProjectModules: async (project, ids) => { connections.push({ project, ids }); },
    migrationMarkup: () => '',
    bindSubmit(form, callback) { submit = callback; }, foldGroup: (id, title, body) => body, diffMarkup: () => '',
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {}, refresh: async () => {},
    setInterval: callback => { intervals.add(callback); return callback; }, clearInterval: callback => intervals.delete(callback), AbortSignal,
    api: async (route, method, body, options) => {
      calls.push({ route, method, body, options });
      if (route === 'conversion-prompt') return { prompt: 'Group selected instructions only.' };
      if (route.endsWith('/conversion-draft')) return { id: 'job', revision: 'source-revision' };
      if (route === 'agent/job') return { status: 'ready', modules };
      if (route.endsWith('/conversion-preview')) return { fingerprint: 'reviewed', modules: body.modules.map(module => ({ ...module, tag: 'Pet · 1.0.0-r1', files: [] })) };
      if (route.endsWith('/convert')) return { modules: body.modules };
      throw new Error('Unexpected route: ' + route);
    }, project: { id: 'pet', name: 'Pet', instructions: [{ kind: 'skill', path: selected[0].value, name: 'Old' }] },
  });
  vm.runInContext(fs.readFileSync(new URL('../gui/project-conversion.js', import.meta.url), 'utf8'), ctx);
  return { ctx, node, timers, calls, views, connections, intervals, classes, submit: () => submit };
}

test('conversion dialog reviews agent grouping and metadata changes before saving versions', async () => {
  const ui = setup();
  await vm.runInContext('convertProjectInstructions(project)', ui.ctx);
  await ui.node('#conversion-generate').onclick();
  await ui.timers.shift()();
  assert.equal(ui.calls.some(call => call.route.endsWith('/convert')), false);
  assert.equal(ui.calls.find(call => call.route.endsWith('/conversion-preview')).body.revision, 'source-revision');
  const fields = { 'module-id-0': 'renamed-ui', 'module-group-0': 'product', 'module-description-0': 'Existing UI' };
  await ui.submit()(fields);
  assert.equal(ui.calls.some(call => call.route.endsWith('/convert')), false);
  assert.ok(ui.views.at(-1).body.includes('renamed-ui'));
  await ui.submit()(fields);
  const saved = ui.calls.find(call => call.route.endsWith('/convert'));
  assert.equal(saved.body.fingerprint, 'reviewed');
  assert.equal(saved.body.modules[0].id, 'renamed-ui');
  assert.equal(ui.connections.length, 0);
  await ui.node('#connect-all-converted').onclick();
  assert.equal(ui.connections[0].ids.join(','), 'renamed-ui');
});

test('closing conversion dialog discards delayed agent results without preview or writes', async () => {
  const ui = setup();
  await vm.runInContext('convertProjectInstructions(project)', ui.ctx);
  await ui.node('#conversion-generate').onclick();
  ui.ctx.agentCleanup();
  await ui.timers.shift()();
  assert.equal(ui.calls.some(call => call.route.endsWith('/conversion-preview') || call.route.endsWith('/convert')), false);
  assert.ok(ui.calls.some(call => call.route === 'agent/job' && call.method === 'DELETE'));
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.classes.has('conversion-pending'), false);
});

test('long preparation shows elapsed status by the controls and clears progress on completion', async () => {
  const ui = setup(), api = ui.ctx.api;
  let running = true;
  ui.ctx.api = (route, ...args) => route === 'agent/job' && running ? { status: 'running' } : api(route, ...args);
  await vm.runInContext('convertProjectInstructions(project)', ui.ctx);
  assert.ok(ui.views[0].footer.includes('id="conversion-status"'));
  assert.ok(ui.views[0].footer.includes('role="alert"'));
  assert.equal(ui.classes.has('conversion-pending'), true);
  await ui.node('#conversion-generate').onclick();
  await ui.timers.shift()();
  assert.match(ui.node('#conversion-status').textContent, /Ожидаем ответ.*0:00/);
  assert.equal(ui.node('#conversion-generate').disabled, true);
  assert.equal(ui.node('#conversion-stop').hidden, false);
  assert.equal(ui.intervals.size, 1);
  running = false;
  await ui.timers.shift()();
  assert.equal(ui.views.at(-1).title, 'Проверить проектные модули');
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.classes.has('conversion-pending'), false);
  assert.ok(ui.calls.find(call => call.route.endsWith('/conversion-draft')).options.signal instanceof AbortSignal);
});

test('failed agent shows its error and enables another launch without saving files', async () => {
  const ui = setup(), api = ui.ctx.api;
  ui.ctx.api = (route, ...args) => route === 'agent/job' ? { status: 'failed', error: 'Агент не завершил задачу за 5 минут.' } : api(route, ...args);
  await vm.runInContext('convertProjectInstructions(project)', ui.ctx);
  await ui.node('#conversion-generate').onclick();
  await ui.timers.shift()();
  assert.equal(ui.node('#conversion-error').hidden, false);
  assert.match(ui.node('#conversion-error').textContent, /5 минут/);
  assert.equal(ui.node('#conversion-generate').disabled, false);
  assert.equal(ui.node('#conversion-stop').hidden, true);
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.calls.some(call => call.route.endsWith('/convert')), false);
});

test('automatic grouping correction is visible while keeping the same job active', async () => {
  const ui = setup(), api = ui.ctx.api;
  ui.ctx.api = async (route, ...args) => route === 'agent/job' ? { status: 'running', phase: 'repairing', attempt: 2 } : api(route, ...args);
  await vm.runInContext('convertProjectInstructions(project)', ui.ctx);
  await ui.node('#conversion-generate').onclick();
  await ui.timers.shift()();
  assert.match(ui.node('#conversion-status').textContent, /исправляет.*2 из 2/);
  assert.equal(ui.node('#conversion-generate').disabled, true);
  assert.equal(ui.calls.filter(call => call.route.endsWith('/conversion-draft')).length, 1);
  ui.ctx.agentCleanup();
  assert.equal(ui.intervals.size, 0);
});

test('lost polling responses can resume the same job without starting another agent', async () => {
  const ui = setup(), api = ui.ctx.api;
  let disconnected = true;
  ui.ctx.api = (route, ...args) => {
    if (route === 'agent/job' && disconnected) throw new TypeError('Failed to fetch');
    return api(route, ...args);
  };
  await vm.runInContext('convertProjectInstructions(project)', ui.ctx);
  await ui.node('#conversion-generate').onclick();
  for (let i = 0; i < 3; i++) await ui.timers.shift()();
  assert.equal(ui.node('#conversion-retry').hidden, false);
  assert.match(ui.node('#conversion-status').textContent, /мог продолжить/);
  assert.equal(ui.node('#conversion-stop').hidden, false);
  disconnected = false;
  await ui.node('#conversion-retry').onclick();
  assert.equal(ui.views.at(-1).title, 'Проверить проектные модули');
  assert.equal(ui.calls.filter(call => call.route.endsWith('/conversion-draft')).length, 1);
  assert.equal(ui.calls.some(call => call.method === 'DELETE' || call.route.endsWith('/convert')), false);
});

test('a failed preview can retry the prepared plan without regenerating it', async () => {
  const ui = setup(), api = ui.ctx.api;
  let unavailable = true;
  ui.ctx.api = (route, ...args) => {
    if (route.endsWith('/conversion-preview') && unavailable) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return api(route, ...args);
  };
  await vm.runInContext('convertProjectInstructions(project)', ui.ctx);
  await ui.node('#conversion-generate').onclick();
  await ui.timers.shift()();
  assert.match(ui.node('#conversion-status').textContent, /Ответ агента получен/);
  assert.match(ui.node('#conversion-error').textContent, /15 секунд/);
  assert.equal(ui.node('#conversion-retry').hidden, false);
  unavailable = false;
  await ui.node('#conversion-retry').onclick();
  assert.equal(ui.views.at(-1).title, 'Проверить проектные модули');
  assert.equal(ui.calls.filter(call => call.route.endsWith('/conversion-draft')).length, 1);
});
