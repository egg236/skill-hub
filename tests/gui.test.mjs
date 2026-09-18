import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { catalog, hub, selection, plan, apply } from '../scripts/hub.mjs';
import { createStore } from '../scripts/gui-store.mjs';
import { createGuiServer } from '../scripts/gui.mjs';
import { history } from '../scripts/module-history.mjs';

const temp = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temp, 'skill-hub-gui-test-'));
let counter = 0;
after(() => {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('skill-hub-gui-test-'));
  fs.rmSync(resolved, { recursive: true });
});

const skillText = name => `---\nname: ${name}\ndescription: Temporary validation skill.\n---\n\n# Check\n\nValidate the input folder.\n`;
function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function fixture() {
  const base = path.join(scratch, `hub-${++counter}`);
  fs.mkdirSync(base);
  fs.cpSync(path.join(hub, 'modules'), path.join(base, 'modules'), { recursive: true });
  fs.cpSync(path.join(hub, 'presets'), path.join(base, 'presets'), { recursive: true });
  if (fs.existsSync(path.join(hub, 'releases'))) fs.cpSync(path.join(hub, 'releases'), path.join(base, 'releases'), { recursive: true });
  else fs.mkdirSync(path.join(base, 'releases'));
  const target = path.join(scratch, `project-${counter}`);
  fs.mkdirSync(target);
  write(target, 'AGENTS.md', '# Local instructions\n');
  return { base, target, store: createStore(base) };
}
function snapshot(root) {
  const result = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  walk(root);
  return result;
}
function addFamilyPair(base) {
  const parent = path.join(base, 'modules/workflow/demo-family');
  for (const [id, description] of [['demo-a', 'Family demo A.'], ['demo-b', 'Family demo B.']]) {
    const root = path.join(parent, id);
    write(root, 'module.json', JSON.stringify({ schema: 1, id, version: '1.0.0', description, family: 'demo-family' }, null, 2) + '\n');
    write(root, `skills/${id}/SKILL.md`, skillText(id));
    write(root, `rules/${id}.mdc`, `---\ndescription: "${description}"\nglobs: ""\nalwaysApply: true\n---\n\n# ${id}\n`);
  }
}

test('catalog lists demo modules with stable ids', () => {
  const { base, store } = fixture();
  const available = catalog(base);
  assert.ok(available.has('git-confirm-pr'));
  assert.ok(available.has('git-auto-pr'));
  assert.ok(available.has('go-ddd'));
  assert.equal(store.module('git-confirm-pr').group, 'workflow');
  assert.equal(store.module('git-confirm-pr').family, 'git-workflow');
  assert.equal(store.module('go-ddd').group, 'engineering');
});

test('grouped catalog preserves flat IDs; moving folders does not change installed files', () => {
  const { base, target, store } = fixture();
  const available = catalog(base);
  const modules = selection(['git-confirm-pr', 'go-ddd'], available);
  apply(target, plan(target, modules));
  const before = snapshot(target);
  const go = available.get('go-ddd');
  const moved = path.join(base, 'modules/extra/go-ddd');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(go.root, moved);
  assert.equal(store.module('go-ddd').group, 'extra');
  assert.deepEqual(plan(target, selection(['git-confirm-pr', 'go-ddd'], catalog(base))), []);
  assert.deepEqual(snapshot(target), before);
});

test('catalog rejects duplicate IDs, separated families and directory junctions', t => {
  const { base } = fixture();
  const duplicate = path.join(base, 'modules/extra/go-ddd');
  fs.cpSync(catalog(base).get('go-ddd').root, duplicate, { recursive: true });
  assert.throws(() => catalog(base), /дублирующ|Duplicate|ID/i);
  fs.rmSync(path.join(base, 'modules/extra'), { recursive: true, force: true });
  addFamilyPair(base);
  const first = catalog(base).get('demo-a');
  fs.renameSync(first.root, path.join(base, 'modules/workflow/demo-a'));
  assert.throws(() => catalog(base), /одной папке|family|семей/i);
  fs.renameSync(path.join(base, 'modules/workflow/demo-a'), first.root);
  try { fs.symlinkSync(path.join(base, 'modules/engineering'), path.join(base, 'modules/link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Symlink permission unavailable'); return; } throw error; }
  assert.throws(() => catalog(base), /ссылк|junction|symlink/i);
});

test('registration persists projects and adds Cursor exclusion while preserving existing project files', () => {
  const { base, target, store } = fixture();
  const before = snapshot(target);
  assert.deepEqual(store.projects().projects, []);
  const project = store.register({ name: 'Example', path: target });
  before['.cursorignore'] = fs.readFileSync(path.join(target, '.cursorignore')).toString('base64');
  assert.match(fs.readFileSync(path.join(target, '.cursorignore'), 'utf8'), /\.skill-hub\//);
  assert.throws(() => store.register({ name: 'Dup', path: target + path.sep + '.' }), /уже зарегистрирован|already/i);
  assert.throws(() => store.register({ name: 'Hub', path: base }), /сам каталог хаба|hub itself|хаб/i);
  assert.throws(() => store.register({ name: 'Missing', path: path.join(scratch, 'missing') }));
  assert.equal(createStore(base).projects().projects[0].id, project.id);
  store.register({ id: project.id, name: 'Renamed', path: target });
  assert.equal(store.projects().projects[0].name, 'Renamed');
  store.unregister(project.id);
  assert.deepEqual(store.projects().projects, []);
  assert.deepEqual(snapshot(target), before);
});

test('project preview, apply, set switching, stale previews and local edits', () => {
  const { target, store } = fixture();
  const project = store.register({ name: 'Demo', path: target });
  const preview = store.preview(project.id, ['git-confirm-pr', 'go-ddd']);
  assert.ok(preview.changes.length > 0);
  store.apply(project.id, ['git-confirm-pr', 'go-ddd'], preview.fingerprint);
  assert.ok(fs.existsSync(path.join(target, '.agents/skills/git-workflow/SKILL.md')));
  assert.ok(fs.existsSync(path.join(target, '.agents/skills/go-ddd/SKILL.md')));
  const next = store.preview(project.id, ['git-confirm-pr']);
  store.apply(project.id, ['git-confirm-pr'], next.fingerprint);
  assert.ok(!fs.existsSync(path.join(target, '.agents/skills/go-ddd/SKILL.md')));
  fs.appendFileSync(path.join(target, '.agents/skills/git-workflow/SKILL.md'), '\nedit');
  assert.throws(() => store.preview(project.id, ['go-ddd']), /локальн|local|изменен|изменён|файл|status|редактир/i);
});

test('family variants conflict until one remains', () => {
  const { base, target, store } = fixture();
  addFamilyPair(base);
  const available = catalog(base);
  assert.throws(() => selection(['demo-a', 'demo-b'], available), /семей|family|конфликт|conflict|вариант/i);
  const project = store.register({ name: 'Family', path: target });
  const preview = store.preview(project.id, ['demo-a']);
  store.apply(project.id, ['demo-a'], preview.fingerprint);
  assert.ok(fs.existsSync(path.join(target, '.agents/skills/demo-a/SKILL.md')));
});

test('HTTP API serves UI, enforces local origin and token, and completes project lifecycle', async () => {
  const { base, target } = fixture();
  const server = createGuiServer({ base });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (url, headers = {}) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: url, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  const post = (url, body, headers = {}) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  try {
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.body, /skill-hub/i);
    const session = JSON.parse((await get('/api/session')).body);
    assert.ok(session.token);
    const denied = await get('/api/catalog');
    assert.equal(denied.status, 403);
    const catalogResponse = await get('/api/catalog', { 'x-hub-token': session.token });
    assert.equal(catalogResponse.status, 200);
    const payload = JSON.parse(catalogResponse.body);
    assert.ok(payload.modules.some(module => module.id === 'git-confirm-pr'));
    assert.ok(payload.modules.some(module => module.id === 'git-auto-pr'));
    assert.ok(payload.presets.length >= 1);
    const created = JSON.parse((await post('/api/projects', { name: 'API', path: target }, { 'x-hub-token': session.token })).body);
    assert.ok(created.id);
    const preview = JSON.parse((await post(`/api/projects/${created.id}/preview`, { modules: ['git-confirm-pr'] }, { 'x-hub-token': session.token })).body);
    assert.ok(preview.fingerprint);
    assert.ok(Array.isArray(preview.changes));
    assert.ok(preview.changes.length > 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('releases history can publish current catalog versions', () => {
  const { base } = fixture();
  const releases = history(base);
  const module = catalog(base).get('git-auto-pr');
  releases.publish(module);
  assert.ok(fs.existsSync(path.join(base, 'releases/git-auto-pr/1.0.0.json')));
  assert.equal(releases.versions('git-auto-pr')[0], '1.0.0');
});
