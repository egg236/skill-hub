import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { hub, catalog, loadLock } from '../scripts/hub.mjs';
import { createStore } from '../scripts/gui-store.mjs';
import { createGuiServer } from '../scripts/gui.mjs';
import { history, localModule, packModule, unpackModule, resolveModules } from '../scripts/module-history.mjs';
import { selectModule, validateChoices } from '../scripts/module-choices.mjs';

const temp = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temp, 'hub-choices-test-'));
let serial = 0;
after(() => {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('hub-choices-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
function write(root, relative, data) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function fixture() {
  const base = path.join(scratch, `hub-${++serial}`), target = path.join(scratch, `repo-${serial}`);
  fs.mkdirSync(base); fs.mkdirSync(target);
  for (const folder of ['modules', 'presets', 'releases']) fs.cpSync(path.join(hub, folder), path.join(base, folder), { recursive: true });
  const store = createStore(base), project = store.register({ name: 'my-repo', path: target });
  return { base, target, store, project };
}
const skill = '.agents/skills/pet-ui-direction';
const mood = name => `${skill}/assets/design/moods/${name}/DESIGN.md`;
const choice = (...moods) => ({ id: 'ui-direction', selection: { moods } });
function install(store, project, modules) {
  const preview = store.preview(project.id, modules);
  return store.apply(project.id, modules, preview.fingerprint);
}

test('shared files always install; multiple choices persist, can be removed, and keep dirty files protected', () => {
  const { target, store, project } = fixture();
  install(store, project, ['ui-direction']);
  assert.ok(fs.existsSync(path.join(target, skill, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(target, skill, 'assets/design/templates/PET_DESIGN.md')));
  assert.equal(fs.existsSync(path.join(target, mood('dark-tool'))), false);
  install(store, project, [choice('dark-tool', 'warm-editorial')]);
  assert.ok(fs.existsSync(path.join(target, mood('dark-tool'))));
  assert.ok(fs.existsSync(path.join(target, mood('warm-editorial'))));
  assert.equal(fs.existsSync(path.join(target, mood('ops-dense'))), false);
  assert.deepEqual(store.preview(project.id, ['ui-direction']).changes, []);
  const dark = fs.readFileSync(path.join(target, mood('dark-tool')));
  write(target, mood('dark-tool'), 'Personal edits');
  assert.throws(() => store.preview(project.id, [choice()]), /изменён|изменен|правк/i);
  assert.equal(fs.readFileSync(path.join(target, mood('dark-tool')), 'utf8'), 'Personal edits');
  write(target, mood('dark-tool'), dark);
  install(store, project, [choice()]);
  assert.equal(fs.existsSync(path.join(target, mood('dark-tool'))), false);
  assert.deepEqual(loadLock(target).modules[0].selection, { moods: [] });
});

test('selected payload never truncates an archived release and old installs infer their installed moods', () => {
  const { base, target, store, project } = fixture();
  const full = catalog(base).get('ui-direction');
  const selected = selectModule(full, { moods: ['dark-tool'] });
  assert.ok(selected.payload.length < full.payload.length);
  assert.equal(unpackModule(packModule(selected)).payload.length, full.payload.length);
  history(base).checkpoint(selected);
  assert.equal(history(base).get(full.id, full.version).payload.length, full.payload.length);
  install(store, project, ['ui-direction@1.0.1']);
  assert.equal(loadLock(target).modules[0].selection, undefined);
  install(store, project, ['ui-direction@latest']);
  assert.equal(loadLock(target).modules[0].selection.moods.length, 4);
  assert.ok(fs.existsSync(path.join(target, mood('dark-tool'))));
});

test('choice definitions create immutable versions and reject overlapping paths, invalid defaults and orphan resources', () => {
  const { base, store } = fixture();
  const before = store.module('ui-direction');
  const choices = structuredClone(before.choices);
  choices[0].multiple = false;
  choices[0].default = ['dark-tool'];
  const next = store.saveModule(before.id, { revision: before.revision, files: [], choices });
  assert.notEqual(next.version, before.version);
  assert.equal(store.version(before.id, before.version).choices[0].multiple, true);
  assert.deepEqual(store.version(before.id, next.version).choices[0].default, ['dark-tool']);
  const module = catalog(base).get(before.id);
  assert.throws(() => selectModule(module, { moods: ['dark-tool', 'ops-dense'] }));
  assert.throws(() => selectModule(module, { unknown: [] }));
  assert.throws(() => selectModule(module, { moods: ['unknown'] }));
  const overlap = structuredClone(module);
  overlap.choices[0].options[0].paths = ['skills/pet-ui-direction/assets/design/moods/'];
  assert.throws(() => validateChoices(overlap), /несколько/);
  const orphan = structuredClone(module);
  orphan.choices[0].options[0].paths = ['skills/pet-ui-direction/SKILL.md'];
  assert.throws(() => validateChoices(orphan), /Ресурсы/);
  const invalid = structuredClone(choices);
  invalid[0].default = ['unknown'];
  assert.throws(() => store.saveModule(before.id, { revision: next.revision, files: [], choices: invalid }));
  assert.equal(store.module(before.id).revision, next.revision);
});

test('editing a managed project skill saves a project version, retains inactive bundles and protects other dirty files', () => {
  const { base, target, store, project } = fixture();
  install(store, project, [choice('dark-tool'), 'review']);
  const reviewer = '.agents/skill-hub/review/agents/reviewer.md';
  const rule = '.cursor/rules/skill-hub/ui-direction/ui-direction.mdc';
  fs.appendFileSync(path.join(target, reviewer), '\nDirty review\n');
  fs.appendFileSync(path.join(target, rule), '\nDirty same-module rule\n');
  const current = store.projectSkill(project.id, skill);
  const file = current.files.find(file => file.path === mood('dark-tool'));
  const saved = store.saveProjectSkill(project.id, { path: skill, revision: current.revision, files: [{ path: file.path, content: file.content + '\nRepository direction\n' }] });
  assert.match(saved.version, /-r1$/);
  const lock = loadLock(target), record = lock.modules.find(item => item.id === 'ui-direction');
  assert.equal(record.source, 'project');
  assert.deepEqual(record.selection, { moods: ['dark-tool'] });
  const snapshot = localModule(target, record.id, record.version);
  assert.ok(snapshot.payload.some(file => file.target === mood('ops-dense')));
  assert.equal(lock.files[mood('ops-dense')], undefined);
  assert.equal(fs.existsSync(path.join(target, mood('ops-dense'))), false);
  assert.equal(store.projects().projects[0].problems.length, 2);
  assert.throws(() => store.saveProjectSkill(project.id, { path: skill, revision: current.revision, files: [] }), /изменился/);
  assert.equal(store.saveProjectSkill(project.id, { path: skill, revision: saved.revision, files: [] }).unchanged, true);
  assert.ok(!history(base).get(record.id, '1.0.2').payload.find(item => item.target === file.path).data.toString().includes('Repository direction'));
});

test('capture and promotion preserve choice definitions and inactive resources', () => {
  const { target, store, project } = fixture();
  install(store, project, [choice('dark-tool')]);
  fs.appendFileSync(path.join(target, mood('dark-tool')), '\nA local change\n');
  const preview = store.capturePreview(project.id, 'ui-direction');
  assert.equal(preview.changes.length, 1);
  const saved = store.capture(project.id, 'ui-direction', { fingerprint: preview.fingerprint });
  assert.equal(localModule(target, 'ui-direction', saved.version).choices[0].options.length, 4);
  assert.equal(loadLock(target).files[mood('ops-dense')], undefined);
  assert.deepEqual(store.preview(project.id, ['ui-direction']).changes, []);
  const promotion = store.promotePreview(project.id, 'ui-direction', {});
  assert.equal(promotion.changes.length, 1);
  const promoted = store.promote(project.id, 'ui-direction', { fingerprint: promotion.fingerprint });
  assert.equal(promoted.choices[0].options.length, 4);
  assert.ok(store.module(promoted.id).files.some(file => file.path.includes('moods/ops-dense/DESIGN.md')));
  install(store, project, [{ id: 'ui-direction', source: 'project', version: saved.version, selection: { moods: ['ops-dense'] } }]);
  assert.ok(fs.existsSync(path.join(target, mood('ops-dense'))));
  assert.equal(fs.existsSync(path.join(target, mood('dark-tool'))), false);
});

test('legacy project edits preserve arbitrary format and resources with immutable recovery snapshots', () => {
  const { target, store, project } = fixture();
  const relative = '.cursor/skills/Old Skill';
  write(target, relative + '/SKILL.md', '# No YAML, old instructions\n');
  write(target, relative + '/assets/example.bin', Buffer.from([0, 255, 2]));
  const before = store.projectSkill(project.id, relative);
  const saved = store.saveProjectSkill(project.id, { path: relative, revision: before.revision, files: [{ path: relative + '/SKILL.md', content: '# New instructions without YAML\n' }] });
  assert.equal(saved.managed, false);
  assert.equal(saved.version, 1);
  assert.equal(loadLock(target), null);
  const directory = path.join(target, '.skill-hub/skill-history');
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0], '1.json')));
  assert.equal(Buffer.from(snapshot.before.find(file => file.path.endsWith('/SKILL.md')).data, 'base64').toString(), '# No YAML, old instructions\n');
  assert.deepEqual(fs.readFileSync(path.join(target, relative, 'assets/example.bin')), Buffer.from([0, 255, 2]));
  assert.throws(() => store.saveProjectSkill(project.id, { path: relative, revision: saved.revision, files: [{ path: '../outside', content: 'bad' }] }));
});

test('failed project skill write rolls back the version and the skill', () => {
  const { target, store, project } = fixture();
  install(store, project, [choice('dark-tool')]);
  const before = store.projectSkill(project.id, skill), lock = loadLock(target);
  const file = before.files.find(file => file.path.endsWith('/SKILL.md'));
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (String(file) === path.join(target, '.agents/skill-hub.lock.json')) throw new Error('Disk failure');
    return originalWrite.call(this, file, ...args);
  };
  try { assert.throws(() => store.saveProjectSkill(project.id, { path: skill, revision: before.revision, files: [{ path: file.path, content: file.content + '\nNew\n' }] }), /Disk failure/); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(store.projectSkill(project.id, skill).revision, before.revision);
  assert.deepEqual(loadLock(target), lock);
  assert.equal(fs.existsSync(path.join(target, '.skill-hub/variants/ui-direction', lock.modules[0].version + '-r1.json')), false);
});

test('authenticated project skill update endpoint saves edits and denies unauthorized writes', async t => {
  const { base, target, store, project } = fixture();
  write(target, '.cursor/skills/legacy.md', '# Old');
  const skill = store.projectSkill(project.id, '.cursor/skills/legacy.md');
  const server = createGuiServer({ base });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(address + '/api/session').then(r => r.json());
  const body = JSON.stringify({ path: skill.path, revision: skill.revision, files: [{ path: skill.path, content: '# Edited' }] });
  const url = address + `/api/projects/${project.id}/skill`;
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token }, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).files[0].content, '# Edited');
});

test('CLI explicit choice supports shared-only and multiple options without changing project on dry-run', () => {
  const target = path.join(scratch, 'cli-project'); fs.mkdirSync(target);
  const run = value => spawnSync(process.execPath, ['scripts/hub.mjs', 'apply', target, 'ui-direction', '--choose', value, '--dry-run'], { cwd: hub, encoding: 'utf8' });
  const shared = run('ui-direction:moods=');
  assert.equal(shared.status, 0, shared.stderr);
  assert.ok(!shared.stdout.includes('moods/dark-tool'));
  const two = run('ui-direction:moods=dark-tool,warm-editorial');
  assert.equal(two.status, 0, two.stderr);
  assert.ok(two.stdout.includes('moods/dark-tool'));
  assert.ok(two.stdout.includes('moods/warm-editorial'));
  assert.equal(run('review:moods=dark-tool').status, 1);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('folder and group collapse state persists across browser contexts and stays scoped to each project', () => {
  const source = fs.readFileSync(path.join(hub, 'gui/workspace-ui.js'), 'utf8');
  const storage = new Map();
  function context() {
    let toggle;
    const ctx = vm.createContext({ localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      document: { addEventListener(name, listener, capture) { assert.equal(name, 'toggle'); assert.equal(capture, true); toggle = listener; } },
      escape: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;') });
    vm.runInContext(source, ctx);
    return { ctx, toggle };
  }
  const first = context();
  first.toggle({ target: { matches: () => true, isConnected: true, dataset: { fold: 'project:one:folder:/assets' }, open: false } });
  const second = context();
  assert.ok(!vm.runInContext("foldAttributes('project:one:folder:/assets')", second.ctx).includes(' open'));
  assert.ok(vm.runInContext("foldAttributes('project:two:folder:/assets')", second.ctx).includes(' open'));
  const markup = vm.runInContext("fileTreeMarkup([{path:'SKILL.md'},{path:'assets/example.md'}], 'assets/example.md', 'project:one')", second.ctx);
  assert.match(markup, /class="tree-folder" data-fold="project:one:folder:\/assets">/);
  assert.match(markup, /class="tree-file active" data-tree-file="assets\/example.md"/);
  assert.match(markup, /data-tree-file="SKILL.md"/);
});

test('adoption preserves project resources and the complete optional-bundle snapshot', () => {
  const { target, store, project } = fixture();
  const original = '---\nname: pet-ui-direction\ndescription: Personal direction.\n---\n\n# Existing direction\n';
  write(target, skill + '/SKILL.md', original);
  const modules = [choice('dark-tool')];
  const preview = store.adoptPreview(project.id, modules);
  store.adopt(project.id, modules, preview.fingerprint);
  const record = loadLock(target).modules[0];
  assert.deepEqual(record.selection, { moods: ['dark-tool'] });
  assert.equal(fs.readFileSync(path.join(target, skill, 'SKILL.md'), 'utf8'), original);
  assert.ok(localModule(target, record.id, record.version).payload.some(file => file.target === mood('ops-dense')));
  assert.equal(fs.existsSync(path.join(target, mood('ops-dense'))), false);
  assert.deepEqual(store.preview(project.id, ['ui-direction']).changes, []);
});

test('promoting a configuration-only edit previews and versions the changed group settings', () => {
  const { store, project } = fixture();
  const before = store.projectModule(project.id, 'ui-direction', { source: 'hub', version: 'latest' });
  const choices = structuredClone(before.choices);
  choices[0].default = ['dark-tool'];
  const saved = store.saveProjectModule(project.id, 'ui-direction', { source: 'hub', version: before.version, revision: before.revision, files: [], choices });
  const preview = store.promotePreview(project.id, 'ui-direction', { version: saved.version });
  assert.deepEqual(preview.changes, []);
  assert.deepEqual(preview.choices.before[0].default, []);
  assert.deepEqual(preview.choices.after[0].default, ['dark-tool']);
  store.promote(project.id, 'ui-direction', { version: saved.version, fingerprint: preview.fingerprint });
  assert.deepEqual(store.module('ui-direction').choices[0].default, ['dark-tool']);
});

test('resource editor lets users switch files, retains all text drafts and leaves binary data untouched', async () => {
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); };
  let submit, saved, agentName;
  const ctx = vm.createContext({ document: { addEventListener() {} }, localStorage: { getItem() {} },
    escape: value => String(value ?? ''), $: node, cancel: '', showDialog: () => ({}), agentPanel: () => '',
    attachAgent(editor, getName) { agentName = getName; }, bindSubmit(form, callback) { submit = callback; } });
  vm.runInContext(fs.readFileSync(path.join(hub, 'gui/workspace-ui.js'), 'utf8'), ctx);
  ctx.save = edits => { saved = edits; };
  vm.runInContext("resourceEditor('Title', '', [{path:'SKILL.md',content:'Original'}, {path:'assets/design.md',content:'Design'}, {path:'assets/image.bin',content:null}], 'hub:test', 'test-skill', save)", ctx);
  assert.equal(node('#resource-content').value, 'Original');
  assert.equal(agentName().kind, 'skill');
  assert.equal(agentName().name, 'test-skill');
  node('#resource-content').value = 'Changed instructions';
  node('#resource-content').oninput();
  const choose = path => node('#resource-tree').onclick({ target: { closest: () => ({ dataset: { treeFile: path } }) } });
  choose('assets/design.md');
  assert.equal(node('#resource-content').value, 'Design');
  assert.equal(agentName().kind, 'text');
  assert.equal(agentName().path, 'assets/design.md');
  node('#resource-content').value = 'Changed design';
  node('#resource-content').oninput();
  choose('assets/image.bin');
  assert.equal(node('#resource-content').disabled, true);
  choose('SKILL.md');
  assert.equal(node('#resource-content').value, 'Changed instructions');
  await submit();
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ path: 'SKILL.md', content: 'Changed instructions' }, { path: 'assets/design.md', content: 'Changed design' }]);
});

test('choice schemas are isolated across repositories and latest hub definitions bypass old caches', () => {
  const ctx = vm.createContext({ document: { addEventListener() {} }, localStorage: { getItem() {} },
    state: { project: { id: 'first' } } });
  vm.runInContext(fs.readFileSync(path.join(hub, 'gui/workspace-ui.js'), 'utf8'), ctx);
  vm.runInContext("choiceSchemas.set(choiceKey('ui-direction', {source:'project',version:'1.0.2-r1'}), [{id:'first'}]); state.project.id='second'; choiceSchemas.set(choiceKey('ui-direction', {source:'project',version:'1.0.2-r1'}), [{id:'second'}]);", ctx);
  assert.equal(vm.runInContext("choiceSchema({id:'ui-direction'}, {source:'project',version:'1.0.2-r1'})[0].id", ctx), 'second');
  vm.runInContext("state.project.id='first'", ctx);
  assert.equal(vm.runInContext("choiceSchema({id:'ui-direction'}, {source:'project',version:'1.0.2-r1'})[0].id", ctx), 'first');
  vm.runInContext("choiceSchemas.set(choiceKey('ui-direction', {source:'hub',version:'latest'}), [{id:'stale'}]);", ctx);
  assert.equal(vm.runInContext("choiceSchema({id:'ui-direction',choices:[{id:'current'}]}, {source:'hub',version:'latest'})[0].id", ctx), 'current');
});
