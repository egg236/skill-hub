import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function ui() {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { classList: { toggle() {} }, addEventListener() {}, querySelectorAll: () => [] });
    return nodes.get(key);
  };
  const ctx = vm.createContext({ document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null }, URLSearchParams });
  for (const file of ['app.js', 'editors.js', 'workspace-ui.js']) vm.runInContext(fs.readFileSync(new URL('../gui/' + file, import.meta.url), 'utf8'), ctx);
  return { ctx, node };
}

test('project rendering separates unique IDs and installed status without treating pending selection as installed', () => {
  const { ctx, node } = ui();
  vm.runInContext(`
    const make = (id, hasHub) => ({ id, group: 'custom', hasHub, description: id, skills: [], rules: [], agents: [], choices: [],
      version: '1.0.0', source: hasHub ? 'hub' : 'project', localVersions: [], versions: hasHub ? ['1.0.0'] : [], local: hasHub ? null : { version: '1.0.0-r1' } });
    const available = [make('hub-connected', true), make('hub-idle', true), make('local-connected', false), make('local-idle', false)];
    state.modules = available.filter(m => m.hasHub);
    state.projects = [{ id: 'repo', name: 'Repo', available, modules: [{id:'hub-connected',source:'project'}, {id:'local-connected',source:'project'}], problems: [], instructions: [] }];
    setProject('repo'); state.selected.add('local-idle'); renderProjects();
  `, ctx);
  const html = node('#projects').innerHTML;
  const hub = html.slice(html.indexOf('data-module-source="hub"'), html.indexOf('data-module-source="project"'));
  const local = html.slice(html.indexOf('data-module-source="project"'));
  assert.match(hub, /hub-connected/); assert.match(hub, /hub-idle/); assert.doesNotMatch(hub, /local-connected|local-idle/);
  assert.match(local, /local-connected/); assert.match(local, /local-idle/);
  assert.ok(local.indexOf('local-connected') < local.indexOf('Неподключённые'));
  assert.ok(local.indexOf('local-idle') > local.indexOf('Неподключённые'));
  assert.match(local, /data-select="local-idle" checked/);
  assert.doesNotThrow(() => vm.runInContext('renderCatalog()', ctx));
});

test('packaged and managed instructions are collapsed while changed resources remain visible', () => {
  const { ctx } = ui();
  const html = vm.runInContext(`projectSkillsMarkup({ id:'repo', instructions: [
    {path:'free',entrypoint:'free/SKILL.md',kind:'skill',name:'Free'},
    {path:'changed',entrypoint:'changed/SKILL.md',kind:'skill',name:'Changed',packedChanged:true,packedAs:[{id:'local'}]},
    {path:'packed',entrypoint:'packed/SKILL.md',kind:'skill',name:'Packed',packedAs:[{id:'local'}]},
    {path:'rule',entrypoint:'rule.mdc',kind:'rule',name:'Managed',managed:true,module:'hub'}
  ]})`, ctx);
  const split = html.indexOf('data-fold="project:repo:disk-packaged"');
  assert.ok(split > 0);
  assert.match(html.slice(0, split), /Инструкции вне модулей · 2/);
  assert.match(html.slice(0, split), /data-project-skill="changed"/);
  assert.doesNotMatch(html.slice(0, split), /data-project-skill="packed"|data-project-skill="rule"/);
  assert.match(html.slice(split), /^data-fold="project:repo:disk-packaged"><summary>Уже в модулях · 2/);
});

test('connect shortcut preserves pending edits and requests a separate additive preview', async () => {
  const { ctx } = ui();
  vm.runInContext(`
    state.project = {id:'repo', available:[{id:'existing'}, {id:'converted', local:{version:'1.0.0-r1'}}]};
    state.selected.add('existing');
    let previewed = false;
    dialog.close = () => {};
    renderProjects = () => {};
    reviewProjectFiles = async (project, ids, connection) => { previewed = connection && ids.join(',') === 'converted'; };
  `, ctx);
  await vm.runInContext("connectProjectModule({id:'repo'}, 'converted')", ctx);
  assert.equal(vm.runInContext("state.selected.has('existing') && !state.selected.has('converted') && previewed", ctx), true);
  assert.equal(vm.runInContext("state.choices.has('converted')", ctx), false);
});

test('connection review submits the reviewed fingerprint only after the final button', async () => {
  const { ctx } = ui();
  vm.runInContext(`
    state.project = {id:'repo', name:'Repo', available:[{id:'converted', local:{version:'1.0.0-r1'}}]};
    let requests = [], submitConnection, footer, refreshed = false;
    api = async (route, method, body) => {
      requests.push({route, body});
      return { fingerprint:'reviewed', modules:[{id:'converted'}], preserved:['.agents/skills/existing/SKILL.md'], variants:[], changes:[] };
    };
    showDialog = (title, subtitle, body, buttons) => { footer = buttons; return {}; };
    bindSubmit = (form, callback) => { submitConnection = callback; };
    dialog.close = () => {};
    refresh = async () => { refreshed = true; };
  `, ctx);
  await vm.runInContext("connectProjectModules(state.project, ['converted'])", ctx);
  assert.equal(vm.runInContext('requests.length', ctx), 1);
  assert.match(vm.runInContext('footer', ctx), /Подключить и принять файлы под управление/);
  await vm.runInContext('submitConnection()', ctx);
  assert.equal(vm.runInContext('requests[1].route', ctx), 'projects/repo/connect');
  assert.equal(vm.runInContext('requests[1].body.fingerprint', ctx), 'reviewed');
  assert.equal(vm.runInContext('refreshed', ctx), true);
});
