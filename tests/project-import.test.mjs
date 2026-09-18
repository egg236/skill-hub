import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { hub, catalog, plan, apply, loadLock, hash } from '../scripts/hub.mjs';
import { createStore } from '../scripts/gui-store.mjs';
import { createGuiServer } from '../scripts/gui.mjs';
import { createPathPicker } from '../scripts/path-picker.mjs';

const temp = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temp, 'hub-project-import-'));
let serial = 0;
after(() => {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('hub-project-import-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function fixture() {
  const base = path.join(scratch, `hub-${++serial}`);
  fs.mkdirSync(base);
  fs.cpSync(path.join(hub, 'modules'), path.join(base, 'modules'), { recursive: true });
  fs.cpSync(path.join(hub, 'presets'), path.join(base, 'presets'), { recursive: true });
  const target = path.join(scratch, `Проект ${serial}`);
  fs.mkdirSync(target);
  write(target, 'AGENTS.md', '# User instructions\n');
  const store = createStore(base);
  const project = store.register({ name: 'Pet project', path: target });
  return { base, target, store, project };
}

test('projects discover unmanaged skills and open legacy content without module manifests or valid frontmatter', () => {
  const { target, store, project } = fixture();
  write(target, '.agents/skills/Old Skill/SKILL.md', '# Older skill without frontmatter\n');
  write(target, '.agents/skills/Old Skill/assets/example.txt', 'Resource');
  write(target, '.cursor/skills/custom.md', '---\nmalformed yaml\n# Still readable');
  write(target, '.claude/skills/another/skill.md', '# Lowercase entrypoint');
  const status = store.projects().projects[0];
  assert.equal(status.skills.length, 3);
  assert.ok(status.skills.every(skill => !skill.managed));
  const skill = store.projectSkill(project.id, '.agents/skills/Old Skill');
  assert.equal(skill.files[0].content, '# Older skill without frontmatter\n');
  assert.equal(skill.files.length, 2);
  assert.throws(() => store.projectSkill(project.id, '../../outside'), /не найден/);
  assert.equal(fs.existsSync(path.join(target, '.agents/skill-hub.lock.json')), false);
});

test('import accepts SKILL.md selected from disk and includes sibling resources', () => {
  const { store } = fixture();
  const directory = path.join(scratch, 'disk-skill');
  fs.mkdirSync(directory);
  write(directory, 'SKILL.md', '---\nname: disk-skill\ndescription: Read a disk skill.\n---\n\n# Disk\n');
  write(directory, 'assets/example.bin', Buffer.from([0, 255, 1]));
  const before = store.module('review');
  store.importSkill('review', { revision: before.revision, path: path.join(directory, 'SKILL.md') });
  assert.ok(store.skill('review', 'disk-skill').files.includes('skills/disk-skill/assets/example.bin'));
});

test('conflict adoption preserves project skills and resources in a pinned repository version', () => {
  const { base, target, store, project } = fixture();
  const selected = ['notion', 'ui-direction'];
  const before = store.module('ui-direction');
  const skillPath = '.agents/skills/pet-ui-direction/SKILL.md';
  const original = '---\nname: pet-ui-direction\ndescription: Existing pet policy.\n---\n\n# My original instructions\n';
  write(target, skillPath, original);
  write(target, '.agents/skills/pet-ui-direction/assets/personal.bin', Buffer.from([7, 0, 255]));
  write(target, '.agents/skills/unrelated/SKILL.md', '# Unrelated legacy skill');
  assert.throws(() => store.preview(project.id, selected), error => error.code === 'EXISTING_PROJECT_FILES');
  const preview = store.adoptPreview(project.id, selected);
  assert.ok(preview.preserved.includes(skillPath));
  assert.ok(preview.preserved.includes('.agents/skills/pet-ui-direction/assets/personal.bin'));
  assert.ok(preview.variants[0].differences.some(change => change.after === original));
  assert.equal(fs.existsSync(path.join(target, '.skill-hub')), false);
  const status = store.adopt(project.id, selected, preview.fingerprint);
  assert.equal(fs.readFileSync(path.join(target, skillPath), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(target, '.agents/skills/unrelated/SKILL.md'), 'utf8'), '# Unrelated legacy skill');
  assert.deepEqual(fs.readFileSync(path.join(target, '.agents/skills/pet-ui-direction/assets/personal.bin')), Buffer.from([7, 0, 255]));
  const record = loadLock(target).modules.find(module => module.id === 'ui-direction');
  assert.equal(record.source, 'project');
  assert.equal(record.pinned, true);
  assert.equal(status.skills.find(skill => skill.name === 'pet-ui-direction').module, 'ui-direction');
  assert.equal(status.problems.length, 0);
  assert.equal(store.module('ui-direction').revision, before.revision);
  assert.deepEqual(store.preview(project.id, selected).changes, []);
  assert.ok(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8').startsWith('# User instructions\n'));
});

test('adoption preview is invalidated by changed or newly added project resources', () => {
  const { target, store, project } = fixture();
  write(target, '.agents/skills/pet-ui-direction/SKILL.md', '---\nname: pet-ui-direction\ndescription: Existing.\n---\n\n# Existing\n');
  const preview = store.adoptPreview(project.id, ['ui-direction']);
  write(target, '.agents/skills/pet-ui-direction/new.txt', 'Changed while comparing');
  assert.throws(() => store.adopt(project.id, ['ui-direction'], preview.fingerprint), /устарел/);
  assert.equal(fs.existsSync(path.join(target, '.skill-hub')), false);
  assert.equal(fs.existsSync(path.join(target, '.agents/skill-hub.lock.json')), false);
});

test('adoption exception cannot overwrite mismatched bytes and rolls back snapshots with a failed install', () => {
  const { base, target, store, project } = fixture();
  const module = catalog(base).get('review');
  const file = module.payload[0];
  write(target, file.target, 'Existing reviewer');
  assert.throws(() => plan(target, [module], new Map([[file.target, hash(Buffer.from('Existing reviewer'))]])), /принадлежит проекту/);
  const preview = store.adoptPreview(project.id, ['review']);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    if (String(file) === path.join(target, '.agents/skill-hub.lock.json')) throw new Error('Simulated disk failure');
    return originalWrite.call(this, file, ...args);
  };
  try { assert.throws(() => store.adopt(project.id, ['review'], preview.fingerprint), /Simulated disk failure/); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(fs.readFileSync(path.join(target, file.target), 'utf8'), 'Existing reviewer');
  assert.equal(fs.existsSync(path.join(target, '.skill-hub/variants/review', preview.variants[0].version + '.json')), false);
  assert.equal(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), '# User instructions\n');
});

test('native picker passes user paths as data, handles cancellation and replaces abandoned dialogs', async () => {
  let child, options;
  const picker = createPathPicker({ platform: 'win32', launch(command, args, input) {
    options = input;
    assert.ok(args.includes('-STA'));
    assert.equal(input.shell, false);
    assert.equal(args.join(' ').includes('$(danger)'), false);
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('close', 1);
    return child;
  } });
  const promise = picker.pick({ kind: 'folder', initial: path.join(scratch, '$(danger)') });
  assert.match(options.env.BRAIN_HUB_PICKER_INITIAL, /\$\(danger\)/);
  child.stdout.end(JSON.stringify({ cancelled: false, path: scratch })); child.emit('close', 0);
  assert.equal((await promise).path, scratch);
  const cancelled = picker.pick({ kind: 'file' });
  child.stdout.end('{"cancelled":true,"path":null}'); child.emit('close', 0);
  assert.deepEqual(await cancelled, { cancelled: true, path: null });
  const abandoned = picker.pick({ kind: 'folder' });
  const replacement = picker.pick({ kind: 'file' });
  assert.deepEqual(await abandoned, { cancelled: true, path: null });
  picker.close();
  assert.deepEqual(await replacement, { cancelled: true, path: null });
});

test('authenticated API exposes file picker, project skills and the explicit adoption flow', async t => {
  const { base, target, project } = fixture();
  write(target, '.agents/skills/pet-ui-direction/SKILL.md', '---\nname: pet-ui-direction\ndescription: Legacy.\n---\n\n# Legacy\n');
  let picks = 0;
  const server = createGuiServer({ base, pathPicker: { pick: async () => { picks++; return { cancelled: false, path: target }; }, close() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(address + '/api/session').then(r => r.json());
  async function request(route, body, authorized = true) {
    const response = await fetch(address + '/api/' + route, { method: body ? 'POST' : 'GET', headers: { ...(authorized ? { 'X-Hub-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await request('picker', { kind: 'folder' }, false)).status, 403);
  assert.equal(picks, 0);
  assert.equal((await request('picker', { kind: 'folder' })).data.path, target);
  const skill = await request(`projects/${project.id}/skill?` + new URLSearchParams({ path: '.agents/skills/pet-ui-direction' }));
  assert.equal(skill.status, 200);
  const collision = await request(`projects/${project.id}/preview`, { modules: ['ui-direction'] });
  assert.equal(collision.data.code, 'EXISTING_PROJECT_FILES');
  const preview = await request(`projects/${project.id}/adopt-preview`, { modules: ['ui-direction'] });
  assert.equal(preview.status, 200);
  const applied = await request(`projects/${project.id}/adopt`, { modules: ['ui-direction'], fingerprint: preview.data.fingerprint });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.modules[0].source, 'project');
});
