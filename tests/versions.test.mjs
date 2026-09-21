import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { hub, catalog, plan, apply, loadLock } from '../scripts/hub.mjs';
import { createStore } from '../scripts/gui-store.mjs';
import { history, localModule, resolveModules, packModule, unpackModule, moduleRevision } from '../scripts/module-history.mjs';
import { createAgentJobs, resolveCursorAgent } from '../scripts/agent-jobs.mjs';
import { makeCursorRule } from '../scripts/cursor-rules.mjs';
import { createGuiServer } from '../scripts/gui.mjs';

const temp = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temp, 'hub-versions-test-'));
let serial = 0;
after(() => {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('hub-versions-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
function fixture() {
  const base = path.join(scratch, `hub-${++serial}`);
  fs.mkdirSync(base);
  fs.cpSync(path.join(hub, 'modules'), path.join(base, 'modules'), { recursive: true });
  fs.cpSync(path.join(hub, 'presets'), path.join(base, 'presets'), { recursive: true });
  fs.cpSync(path.join(hub, 'releases'), path.join(base, 'releases'), { recursive: true });
  const target = path.join(scratch, `repo-${serial}`);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'AGENTS.md'), '# Personal instructions\n');
  const store = createStore(base);
  const project = store.register({ name: 'my-repo', path: target });
  return { base, target, store, project };
}
function install(store, project, modules) {
  const preview = store.preview(project.id, modules);
  return store.apply(project.id, modules, preview.fingerprint);
}
function edit(store, id, content) {
  const module = store.module(id);
  const file = module.files.find(file => file.content !== null);
  return store.saveModule(id, { revision: module.revision, description: 'Updated description', files: [{ path: file.path, content }] });
}

test('module editor archives old contents, creates an immutable release and ignores no-op saves', () => {
  const { base, store } = fixture();
  const before = store.module('review');
  const next = edit(store, 'review', '# New review\n');
  assert.equal(next.version, '1.0.1');
  assert.equal(store.version('review', '1.0.0').files[0].content, before.files[0].content);
  assert.equal(store.version('review', '1.0.1').files[0].content, '# New review\n');
  assert.deepEqual(store.module('review').versions, ['1.0.1', '1.0.0']);
  assert.equal(store.saveModule('review', { revision: next.revision, files: [] }).version, '1.0.1');
  const modified = catalog(base).get('review');
  modified.payload[0].data = Buffer.from('Tampered');
  assert.throws(() => history(base).publish(modified), /уже сохранена/);
  assert.equal(store.version('review', '1.0.1').files[0].content, '# New review\n');
});

test('explicit versions are pinned, latest can be restored and family checks use selected releases', () => {
  const { base, target, store, project } = fixture();
  const original = store.module('review').files[0].content;
  edit(store, 'review', '# New reviewer\n');
  install(store, project, [{ id: 'review', version: '1.0.0' }]);
  assert.equal(loadLock(target).modules[0].pinned, true);
  assert.equal(fs.readFileSync(path.join(target, '.agents/skill-hub/review/agents/reviewer.md'), 'utf8'), original);
  edit(store, 'review', '# Newest reviewer\n');
  assert.equal(resolveModules(base, target, ['review'])[0].version, '1.0.0');
  assert.equal(resolveModules(base, target, ['review@1.0.1'])[0].version, '1.0.1');
  assert.deepEqual(plan(target, resolveModules(base, target, ['review'])), []);
  install(store, project, [{ id: 'review', version: 'latest' }]);
  assert.equal(loadLock(target).modules[0].version, '1.0.2');
  assert.equal(loadLock(target).modules[0].pinned, undefined);
  assert.throws(() => resolveModules(base, target, ['git-confirm-pr@1.0.0', 'git-auto-pr@1.0.0']), /Конфликт/);
});

test('project variants are isolated, can be installed and promoted with provenance', () => {
  const { base, target, store, project } = fixture();
  install(store, project, ['review']);
  const module = store.projectModule(project.id, 'review', { source: 'hub', version: '1.0.0' });
  const local = store.saveProjectModule(project.id, 'review', { source: 'hub', version: '1.0.0', revision: module.revision,
    files: [{ path: module.files[0].path, content: '# Rules for my repository\n' }] });
  assert.equal(local.version, '1.0.0-r1');
  assert.equal(local.tag, 'my-repo · 1.0.0-r1');
  assert.equal(store.module('review').version, '1.0.0');
  assert.notEqual(store.module('review').files[0].content, '# Rules for my repository\n');
  install(store, project, [{ id: 'review', source: 'project', version: local.version }]);
  assert.equal(loadLock(target).modules[0].source, 'project');
  assert.equal(resolveModules(base, target, ['review'])[0].version, '1.0.0-r1');
  const before = fs.readFileSync(path.join(target, '.agents/skill-hub/review/agents/reviewer.md'));
  const preview = store.promotePreview(project.id, 'review', { version: local.version });
  assert.ok(preview.changes.some(change => change.after === '# Rules for my repository\n'));
  const promoted = store.promote(project.id, 'review', { version: local.version, fingerprint: preview.fingerprint });
  assert.equal(promoted.version, '1.0.1');
  assert.equal(store.version('review', '1.0.1').origin.repo, 'my-repo');
  assert.equal(store.version('review', '1.0.1').origin.version, '1.0.0-r1');
  assert.deepEqual(fs.readFileSync(path.join(target, '.agents/skill-hub/review/agents/reviewer.md')), before);
  assert.equal(loadLock(target).modules[0].version, '1.0.0-r1');
});

test('custom modules start in a repository, support multiline rules and can enter the hub', () => {
  const { target, store, project } = fixture();
  const local = store.createProjectModule(project.id, { id: 'repo-rules', description: 'Repository-specific rules', instructions: '# Rules\n\nCheck migrations.\n' });
  assert.equal(local.source, 'project');
  assert.equal(local.version, '1.0.0-r1');
  assert.throws(() => store.module('repo-rules'), /не найден/);
  install(store, project, [{ id: local.id, source: 'project', version: local.version }]);
  assert.equal(fs.readFileSync(path.join(target, '.cursor/rules/skill-hub/repo-rules/module.mdc'), 'utf8'), makeCursorRule('Repository-specific rules', '# Rules\n\nCheck migrations.\n'));
  const preview = store.promotePreview(project.id, local.id, {});
  store.promote(project.id, local.id, { fingerprint: preview.fingerprint });
  assert.equal(store.module(local.id).version, '1.0.0');
  assert.equal(store.module(local.id).group, 'custom');
  assert.equal(store.projects().projects[0].available.find(module => module.id === local.id).local.tag, 'my-repo · 1.0.0-r1');
});

test('capturing repository edits includes additions, removals and binary resources, preserving other dirty modules', () => {
  const { base, target, store, project } = fixture();
  install(store, project, ['git-auto-pr', 'review']);
  const skill = path.join(target, '.agents/skills/git-workflow/SKILL.md');
  fs.appendFileSync(skill, '\nRepository addition.\n');
  const resource = path.join(target, '.agents/skills/git-workflow/assets/new.bin');
  fs.mkdirSync(path.dirname(resource), { recursive: true });
  fs.writeFileSync(resource, Buffer.from([0, 255, 3, 9]));
  fs.unlinkSync(path.join(target, '.cursor/rules/skill-hub/git-auto-pr/git-workflow.mdc'));
  const reviewer = path.join(target, '.agents/skill-hub/review/agents/reviewer.md');
  fs.appendFileSync(reviewer, '\nAnother local change.\n');
  const reviewerBefore = fs.readFileSync(reviewer);
  const agentsBefore = fs.readFileSync(path.join(target, 'AGENTS.md'));
  const preview = store.capturePreview(project.id, 'git-auto-pr');
  assert.ok(preview.changes.some(change => change.action === 'remove'));
  assert.ok(preview.changes.some(change => change.file.endsWith('new.bin') && change.binary));
  assert.throws(() => store.capture(project.id, 'git-auto-pr', { fingerprint: 'stale' }), /устарел/);
  const captured = store.capture(project.id, 'git-auto-pr', { fingerprint: preview.fingerprint });
  assert.equal(captured.version, '1.0.1-r1');
  const local = localModule(target, 'git-auto-pr');
  assert.deepEqual(local.payload.find(file => file.source.endsWith('new.bin')).data, Buffer.from([0, 255, 3, 9]));
  assert.deepEqual(fs.readFileSync(reviewer), reviewerBefore);
  assert.deepEqual(fs.readFileSync(path.join(target, 'AGENTS.md')), agentsBefore);
  assert.equal(store.projects().projects[0].problems.length, 1);
  assert.throws(() => store.preview(project.id, ['git-auto-pr', 'review']), /Локальные правки/);
  const reviewPreview = store.capturePreview(project.id, 'review');
  store.capture(project.id, 'review', { fingerprint: reviewPreview.fingerprint });
  install(store, project, ['git-auto-pr', 'review']);
  assert.equal(store.projects().projects[0].problems.length, 0);
  assert.equal(catalog(base).get('git-auto-pr').version, '1.0.1');
});

test('stale module edits and promotion previews cannot overwrite newer work', () => {
  const { store, project } = fixture();
  const original = store.module('review');
  const local = store.saveProjectModule(project.id, 'review', { source: 'hub', version: 'latest', revision: original.revision, files: [{ path: original.files[0].path, content: '# Local\n' }] });
  const preview = store.promotePreview(project.id, 'review', { version: local.version });
  edit(store, 'review', '# Hub changed while reviewing\n');
  assert.throws(() => store.promote(project.id, 'review', { version: local.version, fingerprint: preview.fingerprint }), /устарел/);
  assert.throws(() => store.saveModule('review', { revision: original.revision, description: 'Stale edit' }), /Модуль изменился/);
  assert.equal(store.module('review').files[0].content, '# Hub changed while reviewing\n');
});

test('invalid module editor changes and malformed snapshots cannot escape the module', () => {
  const { base, store } = fixture();
  const original = store.module('review');
  assert.throws(() => store.saveModule('review', { revision: original.revision, files: [{ path: '../../escape.md', content: 'No' }] }), /Неверный путь/);
  assert.equal(store.module('review').revision, original.revision);
  assert.throws(() => store.saveModule('review', { revision: original.revision, files: [{ path: original.files[0].path, content: null }] }), /Пустой модуль/);
  const snapshot = packModule(catalog(base).get('review'));
  snapshot.files.push(snapshot.files[0]);
  assert.throws(() => unpackModule(snapshot), /Повторяющийся файл/);
  assert.equal(store.module('review').version, '1.0.0');
});

test('agent job produces a validated draft without changing modules and can be cancelled', async () => {
  const fixturePath = path.join(scratch, 'fake-agent.mjs');
  fs.writeFileSync(fixturePath, `import fs from 'node:fs';
    let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
    const args=process.argv.slice(2);
    if (args[args.indexOf('--mode')+1] !== 'ask' || !args.includes('--print') || !args.includes('--trust') || args.includes('--yolo') || args.includes('--force') || args[args.indexOf('--output-format')+1] !== 'json') process.exit(4);
    if (prompt.includes('WAIT_FOREVER')) await new Promise(resolve => setTimeout(resolve, 60_000));
    else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({summary:'Updated draft',content:'---\\nname: test-skill\\ndescription: Check a task.\\n---\\n\\n# New content\\n'})}));`);
  const jobs = createAgentJobs({ resolveExecutable: () => ({ command: process.execPath, args: [fixturePath] }), timeoutMs: 10_000 });
  const { store } = fixture();
  const before = store.module('review').revision;
  const job = jobs.start({ name: 'test-skill', task: 'Improve the wording', content: 'Original text' });
  assert.throws(() => jobs.start({ name: 'test-skill', task: 'Parallel', content: 'Original' }), /уже выполняет/);
  for (let n = 0; jobs.get(job.id).status === 'running' && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(jobs.get(job.id).status, 'ready');
  assert.match(jobs.get(job.id).content, /New content/);
  assert.equal(store.module('review').revision, before);
  const cancelled = jobs.start({ name: 'test-skill', task: 'WAIT_FOREVER', content: 'Original' });
  assert.equal(jobs.cancel(cancelled.id).status, 'cancelled');
  jobs.close();
});

test('version, project editing and promotion APIs are exposed through authenticated routes', async t => {
  const { base, target } = fixture();
  const server = createGuiServer({ base });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(`${address}/api/session`).then(response => response.json());
  async function request(route, method = 'GET', body) {
    const response = await fetch(`${address}/api/${route}`, { method, headers: { 'X-Hub-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  const project = (await request('projects')).projects[0];
  const module = await request('modules/review');
  await request('modules/review', 'PUT', { revision: module.revision, description: 'From API' });
  assert.equal((await request('modules/review/versions/1.0.0')).description, module.description);
  const local = await request(`projects/${project.id}/modules`, 'POST', { id: 'custom-api', description: 'API module', instructions: '# API rules' });
  assert.equal((await request(`projects/${project.id}/modules/custom-api?source=project&version=${local.version}`)).tag, `my-repo · ${local.version}`);
  const preview = await request(`projects/${project.id}/modules/custom-api/promote-preview`, 'POST', {});
  await request(`projects/${project.id}/modules/custom-api/promote`, 'POST', { fingerprint: preview.fingerprint });
  assert.equal((await request('modules/custom-api')).version, '1.0.0');
  assert.ok((await fetch(`${address}/editors.js`)).ok);
  assert.equal(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), '# Personal instructions\n');
});

test('release snapshots round-trip multi-megabyte skill resources', () => {
  const resource = Buffer.alloc(3 * 1024 * 1024, 254);
  const module = { id: 'large-resource', version: '1.0.0', description: 'Binary resource test', group: 'custom', payload: [
    { source: 'skills/large-skill/SKILL.md', data: Buffer.from('---\nname: large-skill\ndescription: Uses an asset.\n---\n\n# Skill\n') },
    { source: 'skills/large-skill/assets/texture.bin', data: resource },
  ] };
  const restored = unpackModule(packModule(module));
  assert.deepEqual(restored.payload.find(file => file.source.endsWith('texture.bin')).data, resource);
  assert.equal(moduleRevision(restored), moduleRevision(module));
});

test('updating legacy rules installs native MDC, retains foreign rules and protects local edits', () => {
  const { base, target, store, project } = fixture();
  const archive = path.join(base, 'releases/git-confirm-pr/1.0.0.json');
  const archivedBytes = fs.readFileSync(archive);
  install(store, project, ['git-confirm-pr@1.0.0']);
  const oldPath = path.join(target, '.agents/skill-hub/git-confirm-pr/rules/git-workflow.md');
  const original = fs.readFileSync(oldPath);
  const foreignPath = path.join(target, '.cursor/rules/personal.mdc');
  fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
  fs.writeFileSync(foreignPath, makeCursorRule('Personal', '# Personal rule'));
  const foreign = fs.readFileSync(foreignPath);
  fs.appendFileSync(oldPath, '\nLocal adjustment.\n');
  assert.throws(() => store.preview(project.id, ['git-confirm-pr@latest']), /Локальные правки/);
  assert.equal(fs.existsSync(path.join(target, '.cursor/rules/skill-hub/git-confirm-pr/git-workflow.mdc')), false);
  fs.writeFileSync(oldPath, original);
  install(store, project, ['git-confirm-pr@latest']);
  assert.equal(fs.existsSync(oldPath), false);
  const rule = fs.readFileSync(path.join(target, '.cursor/rules/skill-hub/git-confirm-pr/git-workflow.mdc'), 'utf8');
  assert.match(rule, /^---\ndescription: .+\nglobs: ""\nalwaysApply: true\n---\n/);
  assert.ok(rule.includes(original.toString('utf8').replace(/\r\n/g, '\n').trim()));
  assert.deepEqual(fs.readFileSync(foreignPath), foreign);
  assert.deepEqual(fs.readFileSync(archive), archivedBytes);
  assert.deepEqual(store.preview(project.id, ['git-confirm-pr']).changes, []);
});

test('native rule metadata and added MDC files survive capture, project reinstall and promotion', () => {
  const { target, store, project } = fixture();
  install(store, project, ['git-auto-pr']);
  const directory = path.join(target, '.cursor/rules/skill-hub/git-auto-pr');
  const file = path.join(directory, 'git-workflow.mdc');
  const changed = fs.readFileSync(file, 'utf8').replace('alwaysApply: true', 'alwaysApply: false').replace('globs: ""', 'globs: "**/*.ts"');
  fs.writeFileSync(file, changed);
  fs.writeFileSync(path.join(directory, 'extra.mdc'), makeCursorRule('Extra', '# Repository rule'));
  const preview = store.capturePreview(project.id, 'git-auto-pr');
  assert.ok(preview.changes.some(change => change.file === 'rules/extra.mdc' && change.action === 'create'));
  const saved = store.capture(project.id, 'git-auto-pr', { fingerprint: preview.fingerprint });
  install(store, project, ['git-auto-pr']);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.equal(store.projects().projects[0].problems.length, 0);
  const editor = store.projectModule(project.id, 'git-auto-pr', { source: 'project', version: saved.version });
  assert.equal(store.saveProjectModule(project.id, 'git-auto-pr', { source: 'project', version: saved.version, revision: editor.revision, files: [] }).version, saved.version);
  const promotion = store.promotePreview(project.id, 'git-auto-pr', {});
  const promoted = store.promote(project.id, 'git-auto-pr', { fingerprint: promotion.fingerprint });
  assert.equal(promoted.version, '1.0.2');
  assert.equal(store.module('git-auto-pr').files.find(file => file.path === 'rules/git-workflow.mdc').content, changed);
  assert.equal(loadLock(target).modules[0].version, saved.version);
});

test('module edits reject invalid MDC frontmatter without changing the release or working files', () => {
  const { store } = fixture();
  const original = store.module('git-auto-pr');
  for (const content of ['# Missing metadata', '---\nalwaysApply: yes\n---\n# Invalid boolean', '---\nalwaysApply: true\n# Unclosed']) {
    assert.throws(() => store.saveModule('git-auto-pr', { revision: original.revision, files: [{ path: 'rules/git-workflow.mdc', content }] }), /Cursor rule/);
    assert.equal(store.module('git-auto-pr').revision, original.revision);
  }
});

test('Cursor discovery resolves Windows wrappers to the newest complete bundled runtime without shell', () => {
  const root = path.join(scratch, 'cursor-cli');
  fs.mkdirSync(root);
  const wrapper = path.join(root, 'agent.cmd');
  fs.writeFileSync(wrapper, '@echo off');
  for (const version of ['2026.07.01-old', '2026.07.23-new']) {
    const directory = path.join(root, 'versions', version);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.js'), '');
    fs.writeFileSync(path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'), '');
  }
  const previous = process.env.BRAIN_HUB_CURSOR_AGENT;
  try {
    process.env.BRAIN_HUB_CURSOR_AGENT = wrapper;
    const launch = resolveCursorAgent();
    assert.match(launch.command, /2026\.07\.23-new/);
    assert.equal(path.basename(launch.args[0]), 'index.js');
    process.env.BRAIN_HUB_CURSOR_AGENT = 'relative-agent';
    assert.throws(() => resolveCursorAgent(), /BRAIN_HUB_CURSOR_AGENT/);
  } finally {
    if (previous === undefined) delete process.env.BRAIN_HUB_CURSOR_AGENT;
    else process.env.BRAIN_HUB_CURSOR_AGENT = previous;
  }
});

test('Cursor failures, invalid skill drafts and timeouts return errors without applying content', async t => {
  const script = path.join(scratch, 'failing-cursor.mjs');
  fs.writeFileSync(script, [
    "let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;",
    "if (prompt.includes('TIMEOUT')) await new Promise(resolve => setTimeout(resolve, 60_000));",
    "else if (prompt.includes('EXIT_ERROR')) { console.error('Authentication required: agent login'); process.exitCode=1; }",
    "else console.log(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({summary:'Invalid',content:'# No SKILL frontmatter'})}));"
  ].join('\n'));
  for (const task of ['EXIT_ERROR', 'INVALID_SKILL', 'TIMEOUT']) {
    const jobs = createAgentJobs({ resolveExecutable: () => ({ command: process.execPath, args: [script] }), timeoutMs: task === 'TIMEOUT' ? 200 : 5000 });
    t.after(() => jobs.close());
    const job = jobs.start({ name: 'test-skill', task, content: 'Original' });
    for (let n = 0; jobs.get(job.id).status === 'running' && n < 120; n++) await new Promise(resolve => setTimeout(resolve, 50));
    const result = jobs.get(job.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.content, undefined);
    assert.match(result.error, task === 'EXIT_ERROR' ? /Authentication required/ : task === 'TIMEOUT' ? /не завершил/ : /SKILL.md/);
  }
});

test('promoting changes from a legacy project converts rules to MDC in the new hub version', () => {
  const { target, store, project } = fixture();
  install(store, project, ['git-confirm-pr@1.0.0']);
  const file = path.join(target, '.agents/skill-hub/git-confirm-pr/rules/git-workflow.md');
  fs.appendFileSync(file, '\n# A legacy repository adjustment\n');
  const bytes = fs.readFileSync(file);
  const capture = store.capturePreview(project.id, 'git-confirm-pr');
  store.capture(project.id, 'git-confirm-pr', { fingerprint: capture.fingerprint });
  const preview = store.promotePreview(project.id, 'git-confirm-pr', {});
  assert.ok(preview.changes.some(change => change.file === 'rules/git-workflow.mdc' && change.after.includes('legacy repository adjustment')));
  const promoted = store.promote(project.id, 'git-confirm-pr', { fingerprint: preview.fingerprint });
  assert.equal(promoted.version, '1.0.2');
  assert.deepEqual(store.module('git-confirm-pr').rules, ['rules/git-workflow.mdc']);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
