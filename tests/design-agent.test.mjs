import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { after, test } from 'node:test';
import { hub, loadLock } from '../scripts/hub.mjs';
import { createStore } from '../scripts/gui-store.mjs';
import { createAgentJobs } from '../scripts/agent-jobs.mjs';
import { draftRequest, validateDraft } from '../scripts/agent-drafts.mjs';
import { createGuiServer } from '../scripts/gui.mjs';

const temp = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temp, 'hub-design-test-'));
let serial = 0;
after(() => {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('hub-design-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
function fixture() {
  const base = path.join(scratch, 'hub-' + ++serial), target = path.join(scratch, 'repo-' + serial);
  fs.mkdirSync(base); fs.mkdirSync(target);
  for (const folder of ['modules', 'presets', 'releases']) fs.cpSync(path.join(hub, folder), path.join(base, folder), { recursive: true });
  const store = createStore(base), project = store.register({ name: 'design-repo', path: target });
  return { base, target, store, project };
}
const bundle = [
  { path: 'DESIGN.md', content: '# Calm workspace\n\nFor a small appointment service. Spacious forms, compact calendar.\n\nUse [tokens](tokens.css) and [copy](COPY.md).\n\nUse --text on --background and show keyboard focus.\n' },
  { path: 'COPY.md', content: '# Copy\n\nClear and calm. Primary action: Book a visit.\nEmpty calendar: No visits yet.\nError: Choose an available time.\n' },
  { path: 'tokens.css', content: ':root { --background: #ffffff; --text: #172b4d; --accent: #0055aa; --focus: #0055aa; --space: 8px; --radius: 8px; --font: system-ui, sans-serif; }\n' },
];
const rule = '---\ndescription: "Review changes"\nglobs: "**/*.ts"\nalwaysApply: false\n---\n\n# Review\nCheck migrations.\n';
const fake = path.join(scratch, 'agent.mjs');
fs.writeFileSync(fake, `let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if (!process.argv.includes('ask')) process.exit(7);
let response;
if(prompt.includes('DESIGN_VALID')) { if(!prompt.includes(''))process.exit(8); response={summary:'New design',files:${JSON.stringify(bundle)}}; }
else if(prompt.includes('DESIGN_BAD'))response={summary:'Bad design',files:[{path:'../../outside',content:'bad'}]};
else if(prompt.includes('RULE_VALID'))response={summary:'Updated rule',content:${JSON.stringify(rule)}};
else if(prompt.includes('ROLE_VALID'))response={summary:'Updated role',content:${JSON.stringify('# Reviewer\n\nCheck database migrations.\n')}};
else response={summary:'Bad rule',content:'# Missing frontmatter'};
console.log(JSON.stringify({type:'result',is_error:false,result:JSON.stringify(response)}));`);
const agentOptions = { resolveExecutable: () => ({ command: process.execPath, args: [fake] }) };
async function ready(jobs, input) {
  const job = jobs.start(input);
  for (let n = 0; jobs.get(job.id).status === 'running' && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
  return jobs.get(job.id);
}

test('agent edits native Cursor rules and roles without requiring skill frontmatter', async t => {
  const jobs = createAgentJobs(agentOptions); t.after(() => jobs.close());
  const valid = await ready(jobs, { kind: 'rule', name: 'review', path: 'rules/review.mdc', task: 'RULE_VALID', content: rule });
  assert.equal(valid.status, 'ready', valid.error);
  assert.equal(valid.content, rule);
  const invalid = await ready(jobs, { kind: 'rule', name: 'review', path: 'rules/review.mdc', task: 'RULE_BAD', content: rule });
  assert.equal(invalid.status, 'failed'); assert.match(invalid.error, /Cursor rule/);
  const role = await ready(jobs, { kind: 'role', name: 'reviewer', path: 'agents/reviewer.md', task: 'ROLE_VALID', content: '# Reviewer' });
  assert.equal(role.status, 'ready'); assert.ok(role.content.startsWith('# Reviewer'));
  const input = { kind: 'text', name: 'tokens', path: 'skills/ui/tokens.css', content: ':root {}', task: 'Add focus' };
  assert.equal(validateDraft(input, draftRequest(input), { summary: 'Done', content: ':root { --focus: blue; }' }).content, ':root { --focus: blue; }');
});

test('design generation uses the hub skill and creates a draft without changing the catalog', async t => {
  const { store } = fixture();
  const before = store.module('ui-direction');
  const jobs = createAgentJobs(agentOptions); t.after(() => jobs.close());
  const input = store.designAgentInput(before.id, { revision: before.revision, name: 'calm-workspace', title: 'Calm workspace', task: 'DESIGN_VALID' });
  assert.ok(JSON.parse(input.content).sharedFiles.some(file => file.path.endsWith('ANTI_SLOP.md')));
  const result = await ready(jobs, input);
  assert.equal(result.status, 'ready', result.error); assert.deepEqual(result.files, bundle);
  assert.equal(store.module(before.id).revision, before.revision);
  const invalid = await ready(jobs, { ...input, task: 'DESIGN_BAD' });
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.files, undefined);
});

test('saving a reviewed design creates an optional bundle in an immutable version and installs only on selection', () => {
  const { store, target, project } = fixture();
  const before = store.module('ui-direction');
  const next = store.createDesign(before.id, { revision: before.revision, name: 'calm-workspace', title: 'Calm workspace', files: bundle });
  assert.notEqual(next.version, before.version);
  const old = store.version(before.id, before.version);
  assert.equal(old.choices[0].options.some(option => option.id === 'calm-workspace'), false);
  assert.deepEqual(next.choices[0].default, before.choices[0].default);
  const prefix = '.agents/skills/pet-ui-direction/assets/design/moods/calm-workspace/';
  let modules = ['ui-direction'];
  store.apply(project.id, modules, store.preview(project.id, modules).fingerprint);
  assert.equal(fs.existsSync(path.join(target, prefix)), false);
  modules = [{ id: 'ui-direction', selection: { moods: ['calm-workspace'] } }];
  store.apply(project.id, modules, store.preview(project.id, modules).fingerprint);
  for (const file of bundle) assert.equal(fs.readFileSync(path.join(target, prefix, file.path), 'utf8'), file.content);
  assert.deepEqual(loadLock(target).modules[0].selection, { moods: ['calm-workspace'] });
  assert.ok(fs.readFileSync(path.join(target, '.agents/skills/pet-ui-direction/SKILL.md'), 'utf8').includes('пользовательские наборы'));
});

test('design saving rejects stale revisions, duplicate names and escaping paths without changing the module', () => {
  const { store } = fixture();
  const before = store.module('ui-direction');
  const valid = { revision: before.revision, name: 'calm-workspace', title: 'Calm workspace', files: bundle };
  assert.throws(() => store.createDesign(before.id, { ...valid, revision: 'stale' }), /изменился/);
  assert.throws(() => store.createDesign(before.id, { ...valid, name: '../outside' }));
  assert.throws(() => store.createDesign(before.id, { ...valid, name: 'dark-tool' }), /существует/);
  assert.throws(() => store.createDesign(before.id, { ...valid, files: [{ path: '../../outside', content: 'bad' }, ...bundle.slice(1)] }));
  assert.equal(store.module(before.id).revision, before.revision);
});

test('authenticated design routes generate a draft and save reviewed files separately', async t => {
  const { base, store } = fixture();
  const server = createGuiServer({ base, agentOptions });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(address + '/api/session').then(r => r.json());
  const before = store.module('ui-direction');
  const input = { revision: before.revision, name: 'calm-workspace', title: 'Calm workspace', task: 'DESIGN_VALID' };
  const request = (route, data, authorized = true) => fetch(address + '/api/' + route, { method: data ? 'POST' : 'GET', headers: { ...(authorized ? { 'X-Hub-Token': token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await request('modules/ui-direction/design-draft', input, false)).status, 403);
  const response = await request('modules/ui-direction/design-draft', input);
  assert.equal(response.status, 200);
  let job = await response.json();
  for (let n = 0; job.status === 'running' && n < 100; n++) { await new Promise(resolve => setTimeout(resolve, 20)); job = await request('agent/' + job.id).then(r => r.json()); }
  assert.equal(job.status, 'ready', job.error);
  assert.equal(store.module(before.id).revision, before.revision);
  assert.equal((await request('modules/ui-direction/designs', { ...input, files: job.files })).status, 200);
  assert.equal(store.module(before.id).choices[0].options.length, before.choices[0].options.length + 1);
});

test('file editor sends rule targets to the agent and prevents inserting the result into another file', async () => {
  const nodes = new Map(), timers = [];
  const node = key => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); };
  let target = { kind: 'rule', name: 'review', path: 'rules/review.mdc' }, sent;
  const editor = { value: 'Original', dispatchEvent() {} };
  const ctx = vm.createContext({ $: node, dialogGeneration: 1, dialog: { open: true }, agentCleanup: null, Event: class {}, escape: value => String(value),
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    api: async (route, method, body) => { if (route === 'agent') { sent = body; return { id: 'job' }; } return { status: 'ready', summary: 'Done', content: rule }; }, editor, getTarget: () => target });
  vm.runInContext(fs.readFileSync(path.join(hub, 'gui/editors.js'), 'utf8'), ctx);
  node('#agent-task').value = 'Improve';
  vm.runInContext('attachAgent(editor, getTarget)', ctx);
  await node('#agent-start').onclick();
  assert.equal(sent.kind, 'rule'); assert.equal(sent.path, 'rules/review.mdc');
  await timers.shift()();
  target = { kind: 'role', name: 'reviewer', path: 'agents/reviewer.md' };
  node('#agent-accept').onclick(); assert.equal(editor.value, 'Original');
  target = { kind: 'rule', name: 'review', path: 'rules/review.mdc' };
  node('#agent-accept').onclick(); assert.equal(editor.value, rule);
});

test('design dialog lets the user edit generated files and saves only after explicit submission', async () => {
  const nodes = new Map(), timers = [];
  const node = key => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); };
  const fields = { designName: { value: 'calm-workspace' }, designTitle: { value: 'Calm workspace' }, designTask: { value: 'An appointment service' } };
  const form = { elements: fields, reportValidity: () => true };
  let submit, saved, closed = false;
  const ctx = vm.createContext({ $: node, dialogGeneration: 1, dialog: { open: true, close() { closed = true; } }, agentCleanup: null,
    cancel: '', showDialog: () => form, bindSubmit(form, callback) { submit = callback; },
    fileTreeMarkup: files => files.map(file => file.path).join(','),
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    refresh: async () => {}, openModule: async () => {}, notify() {},
    api: async (route, method, body) => {
      if (route.endsWith('/design-draft')) return { id: 'design-job' };
      if (route === 'agent/design-job') return { status: 'ready', summary: 'Created', files: bundle.map(file => ({ ...file })) };
      saved = body; return { version: '1.0.4' };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(hub, 'gui/editors.js'), 'utf8'), ctx);
  vm.runInContext("createDesignDialog({id:'ui-direction',revision:'original-revision'})", ctx);
  await node('#design-generate').onclick();
  assert.equal(saved, undefined);
  await timers.shift()();
  assert.equal(saved, undefined);
  assert.equal(node('#design-save').disabled, false);
  node('#design-tree').onclick({ target: { closest: () => ({ dataset: { treeFile: 'tokens.css' } }) } });
  node('#design-content').value = ':root { --focus: #123456; }';
  node('#design-content').oninput();
  fields.designTitle.value = 'Changed brief'; fields.designTitle.oninput();
  await assert.rejects(submit(), /Описание изменилось/);
  fields.designTitle.value = 'Calm workspace';
  await submit();
  assert.equal(saved.revision, 'original-revision');
  assert.equal(saved.files.find(file => file.path === 'tokens.css').content, ':root { --focus: #123456; }');
  assert.equal(saved.files.find(file => file.path === 'DESIGN.md').content, bundle[0].content);
  assert.equal(closed, true);
});
