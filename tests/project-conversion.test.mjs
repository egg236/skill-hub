import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { hub, loadLock, splitBlock, apply } from '../scripts/hub.mjs';
import { createStore } from '../scripts/gui-store.mjs';
import { projectInstruction, projectInstructions } from '../scripts/project-skills.mjs';
import { localModule } from '../scripts/module-history.mjs';
import { draftRequest, validateDraft } from '../scripts/agent-drafts.mjs';
import { createGuiServer } from '../scripts/gui.mjs';
import { conversionPreview as rawConversionPreview } from '../scripts/project-conversion.mjs';

const temp = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temp, 'hub-conversion-test-'));
let serial = 0;
after(() => {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('hub-conversion-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
function write(root, relative, data) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function fixture() {
  const base = path.join(scratch, 'hub-' + ++serial), target = path.join(scratch, 'repo-' + serial);
  fs.mkdirSync(base); fs.mkdirSync(target);
  for (const folder of ['modules', 'presets', 'releases']) fs.cpSync(path.join(hub, folder), path.join(base, folder), { recursive: true });
  const store = createStore(base), project = store.register({ name: 'Pet example', path: target });
  store.saveLegacyConversion = (id, input) => {
    const result = rawConversionPreview(base, target, project.name, input);
    apply(target, result.snapshots.map(snapshot => {
      const value = JSON.parse(snapshot.data);
      for (const source of value.origin.importedFrom) { delete source.files; delete source.personalHash; }
      return { ...snapshot, data: Buffer.from(JSON.stringify(value)) };
    }));
  };
  return { base, target, store, project };
}
const paths = ['.agents/skills/Old Skill', '.cursor/rules/ui.mdc', '.claude/agents/designer.md'];
const original = '# Existing UI direction\n\nKeep this text exactly. Use [reference](assets/reference.md).\n';
const rule = '---\ndescription: "UI checks"\nglobs: "**/*.tsx"\nalwaysApply: false\n---\n\nRespect existing UI.\n';
function prepare(target) {
  write(target, paths[0] + '/SKILL.md', original);
  write(target, paths[0] + '/assets/reference.md', '# Original reference\n');
  write(target, paths[0] + '/assets/image.bin', Buffer.from([0, 255, 7]));
  write(target, paths[1], rule);
  write(target, paths[2], '---\nname: designer\ndescription: Original role\n---\n\n# Designer\nKeep design decisions.\n');
}
function proposal(store, project, modules = [{ id: 'legacy-ui', group: 'product', description: 'Existing UI instructions', items: paths }], selected = paths) {
  return { paths: selected, revision: store.conversionInput(project.id, selected).revision, modules };
}

test('disk inventory discovers skills, rules and roles in legacy and managed layouts', () => {
  const { store, project, target } = fixture(); prepare(target);
  write(target, 'AGENTS.md', '# Project policy\n');
  write(target, '.cursorrules', 'Old Cursor rules');
  write(target, 'roles/architect.md', '# Architect');
  store.apply(project.id, ['review'], store.preview(project.id, ['review']).fingerprint);
  const inventory = store.projects().projects[0].instructions;
  for (const [relative, kind] of [[paths[0], 'skill'], [paths[1], 'rule'], [paths[2], 'role'], ['AGENTS.md', 'rule'], ['roles/architect.md', 'role']]) {
    assert.equal(inventory.find(item => item.path === relative).kind, kind);
    assert.ok(store.projectInstruction(project.id, relative).files.length);
  }
  const managed = inventory.find(item => item.path === '.agents/skill-hub/review/agents/reviewer.md');
  assert.equal(managed.managed, true); assert.equal(managed.kind, 'role');
  assert.throws(() => store.conversionInput(project.id, [managed.path]), /Управляемые/);
  assert.throws(() => projectInstruction(target, '../outside'), /не найден/);
});

test('managed roles and legacy rules can be edited, while the generated AGENTS block stays protected', () => {
  const { store, project, target } = fixture();
  write(target, 'AGENTS.md', '# Personal policy\n');
  write(target, '.cursor/rules/legacy.md', '# Original legacy rule');
  store.apply(project.id, ['review'], store.preview(project.id, ['review']).fingerprint);
  const file = '.agents/skill-hub/review/agents/reviewer.md';
  const before = store.projectInstruction(project.id, file);
  const saved = store.saveProjectSkill(project.id, { path: file, revision: before.revision, files: [{ path: file, content: '# Project reviewer\n' }] });
  assert.match(saved.version, /-r1$/); assert.equal(loadLock(target).modules[0].source, 'project');
  const agents = store.projectInstruction(project.id, 'AGENTS.md');
  const changed = agents.files[0].content.replace('# Personal policy', '# Updated personal policy');
  store.saveProjectSkill(project.id, { path: 'AGENTS.md', revision: agents.revision, files: [{ path: 'AGENTS.md', content: changed }] });
  assert.equal(splitBlock(changed).block, splitBlock(agents.files[0].content).block);
  const updated = store.projectInstruction(project.id, 'AGENTS.md');
  assert.throws(() => store.saveProjectSkill(project.id, { path: 'AGENTS.md', revision: updated.revision, files: [{ path: 'AGENTS.md', content: '# No generated block' }] }), /Служебный блок/);
  const legacy = store.projectInstruction(project.id, '.cursor/rules/legacy.md');
  const edited = store.saveProjectSkill(project.id, { path: legacy.path, revision: legacy.revision, files: [{ path: legacy.path, content: '# Edited legacy rule' }] });
  assert.equal(edited.tag, 'Pet example · rule-r1');
});

test('conversion archives original bytes and resources, creates project tags and promotes to a regular hub version', () => {
  const { store, project, target } = fixture(); prepare(target);
  const input = proposal(store, project);
  const preview = store.conversionPreview(project.id, input);
  assert.equal(fs.existsSync(path.join(target, '.skill-hub')), false);
  assert.equal(preview.modules[0].tag, 'Pet example · 1.0.0-r1');
  assert.ok(preview.modules[0].files.some(file => file.changed && file.target === 'skills/old-skill/SKILL.md'));
  store.saveConversion(project.id, { ...input, fingerprint: preview.fingerprint });
  assert.equal(fs.existsSync(path.join(target, paths[0])), false);
  assert.equal(fs.existsSync(path.join(target, paths[1])), false);
  const archive = JSON.parse(fs.readFileSync(path.join(target, preview.migration.archive)));
  assert.equal(Buffer.from(archive.files.find(file => file.path === paths[0] + '/SKILL.md').data, 'base64').toString(), original);
  assert.equal(loadLock(target), null);
  const local = localModule(target, 'legacy-ui');
  assert.ok(local.payload.find(file => file.source === 'skills/old-skill/SKILL.md').data.toString('utf8').endsWith(original));
  assert.deepEqual(local.payload.find(file => file.source.endsWith('image.bin')).data, Buffer.from([0, 255, 7]));
  assert.equal(local.payload.find(file => file.source === 'rules/ui.mdc').data.toString(), rule);
  assert.throws(() => store.module('legacy-ui'), /не найден/);
  const status = store.projects().projects[0];
  assert.equal(status.available.find(module => module.id === 'legacy-ui').local.tag, 'Pet example · 1.0.0-r1');
  assert.equal(status.instructions.some(item => item.path === paths[0]), false);
  const editor = store.projectModule(project.id, 'legacy-ui', { source: 'project', version: 'latest' });
  store.saveProjectModule(project.id, 'legacy-ui', { source: 'project', version: editor.version, revision: editor.revision, description: 'Updated module description' });
  assert.equal(localModule(target, 'legacy-ui').origin.importedFrom[0].path, paths[0]);
  const promotion = store.promotePreview(project.id, 'legacy-ui', {});
  const promoted = store.promote(project.id, 'legacy-ui', { fingerprint: promotion.fingerprint });
  assert.equal(promoted.source, 'hub'); assert.equal(promoted.tag, '1.0.0');
  assert.equal(localModule(target, 'legacy-ui').source, 'project');
});

test('agent plans cannot omit, duplicate, invent or rewrite selected sources', () => {
  const { store, project, target } = fixture(); prepare(target);
  const prepared = store.conversionInput(project.id, paths);
  const request = draftRequest(prepared.input);
  const valid = proposal(store, project).modules;
  assert.deepEqual(validateDraft(prepared.input, request, { summary: 'Grouped', modules: valid }).modules, valid);
  for (const items of [paths.slice(1), [...paths, 'outside.md'], [...paths, paths[0]]]) {
    assert.throws(() => validateDraft(prepared.input, request, { summary: 'Bad', modules: [{ ...valid[0], items }] }));
  }
  assert.throws(() => validateDraft(prepared.input, request, { summary: 'Bad', modules: [{ ...valid[0], files: [{ path: 'rule.md', content: 'New instructions' }] }] }));
  assert.throws(() => store.conversionPreview(project.id, { ...proposal(store, project), modules: [{ ...valid[0], id: 'review' }] }), /ID/);
});

test('changed source resources invalidate preview and failed writes roll back all new versions', () => {
  const { store, project, target } = fixture(); prepare(target);
  const modules = [{ id: 'legacy-skills', group: 'custom', description: 'Skills', items: [paths[0]] }, { id: 'legacy-roles', group: 'custom', description: 'Rules and roles', items: paths.slice(1) }];
  let input = proposal(store, project, modules), preview = store.conversionPreview(project.id, input);
  write(target, paths[0] + '/assets/new.txt', 'Added after preview');
  assert.throws(() => store.saveConversion(project.id, { ...input, fingerprint: preview.fingerprint }), /изменились/);
  input = proposal(store, project, modules); preview = store.conversionPreview(project.id, input);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (String(file) === path.join(target, '.skill-hub/variants/legacy-roles/1.0.0-r1.json')) throw new Error('Disk failure');
    return originalWrite.call(this, file, ...args);
  };
  try { assert.throws(() => store.saveConversion(project.id, { ...input, fingerprint: preview.fingerprint }), /Disk failure/); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(fs.existsSync(path.join(target, '.skill-hub/variants/legacy-skills/1.0.0-r1.json')), false);
  assert.equal(fs.readFileSync(path.join(target, paths[0], 'SKILL.md'), 'utf8'), original);
});

test('root AGENTS conversion excludes the generated module block and retains personal instructions', () => {
  const { store, project, target } = fixture();
  write(target, 'AGENTS.md', '# Personal policy\n');
  store.apply(project.id, ['review'], store.preview(project.id, ['review']).fingerprint);
  const selected = ['AGENTS.md'];
  const input = proposal(store, project, [{ id: 'personal-rules', group: 'custom', description: 'Personal policy', items: selected }], selected);
  const preview = store.conversionPreview(project.id, input);
  const content = preview.modules[0].files[0].after;
  assert.ok(content.includes('# Personal policy'));
  assert.ok(!content.includes('skill-hub:begin'));
  assert.equal(splitBlock(content).block, '');
});

test('authenticated API generates, previews and saves the selected inventory through separate steps', async t => {
  const { store, project, target, base } = fixture(); prepare(target);
  const script = path.join(scratch, 'fake-conversion-agent.mjs');
  const modules = proposal(store, project).modules;
  fs.writeFileSync(script, `let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if(!process.argv.includes('--trust')||!prompt.includes('module-plan')&&!prompt.includes('module grouping plan'))process.exit(7);
console.log(JSON.stringify({type:'result',is_error:false,result:JSON.stringify(${JSON.stringify({ summary: 'Grouped', modules })})}));`);
  const server = createGuiServer({ base, agentOptions: { resolveExecutable: () => ({ command: process.execPath, args: [script] }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(address + '/api/session').then(r => r.json());
  const request = (route, body, auth = true) => fetch(address + '/api/' + route, { method: body ? 'POST' : 'GET', headers: { ...(auth ? { 'X-Hub-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const route = 'projects/' + project.id;
  assert.equal((await request(route + '/instruction?' + new URLSearchParams({ path: paths[1] }))).status, 200);
  assert.equal((await request(route + '/conversion-draft', { paths }, false)).status, 403);
  const started = await request(route + '/conversion-draft', { paths }).then(r => r.json());
  let result = started;
  for (let n = 0; result.status === 'running' && n < 100; n++) { await new Promise(resolve => setTimeout(resolve, 20)); result = await request('agent/' + started.id).then(r => r.json()); }
  assert.equal(result.status, 'ready', result.error);
  assert.equal(fs.existsSync(path.join(target, '.skill-hub')), false);
  const input = { paths, revision: started.revision, modules: result.modules };
  const preview = await request(route + '/conversion-preview', input).then(r => r.json());
  assert.equal((await request(route + '/convert', { ...input, fingerprint: preview.fingerprint })).status, 200);
  assert.equal(localModule(target, 'legacy-ui').source, 'project');
});

test('converted manifests install as project modules and resource edits return originals to attention', () => {
  const { store, project, target } = fixture(); prepare(target);
  const input = proposal(store, project), preview = store.conversionPreview(project.id, input);
  assert.deepEqual(preview.modules[0].manifest, { schema: 1, id: 'legacy-ui', version: '1.0.0-r1', description: 'Existing UI instructions' });
  store.saveLegacyConversion(project.id, { ...input, fingerprint: preview.fingerprint });
  const item = () => store.projects().projects[0].instructions.find(item => item.path === paths[0]);
  assert.equal(item().packedChanged, false);
  write(target, paths[0] + '/assets/reference.md', '# Edited reference');
  assert.equal(item().packedChanged, true);
  write(target, paths[0] + '/assets/reference.md', '# Original reference\n');
  assert.equal(item().packedChanged, false);
  const modules = [{ id: 'legacy-ui', source: 'project', version: '1.0.0-r1' }];
  store.apply(project.id, modules, store.preview(project.id, modules).fingerprint);
  assert.equal(loadLock(target).modules[0].source, 'project');
  assert.equal(store.projects().projects[0].problems.length, 0);
  assert.ok(fs.readFileSync(path.join(target, '.agents/skills/old-skill/SKILL.md'), 'utf8').endsWith(original));
  assert.equal(fs.readFileSync(path.join(target, '.cursor/rules/skill-hub/legacy-ui/ui.mdc'), 'utf8'), rule);
  assert.ok(fs.existsSync(path.join(target, '.agents/skill-hub/legacy-ui/agents/designer.md')));
});

test('converted skills already at their installed paths use reviewed adoption and keep the valid manifest', () => {
  const { store, project, target } = fixture();
  const selected = ['.agents/skills/existing'];
  const text = '---\nname: existing\ndescription: Existing skill\n---\n\nKeep instructions.\n';
  write(target, selected[0] + '/SKILL.md', text);
  const input = proposal(store, project, [{ id: 'existing-module', group: 'custom', description: 'Existing', items: selected }], selected);
  store.saveLegacyConversion(project.id, { ...input, fingerprint: store.conversionPreview(project.id, input).fingerprint });
  const modules = [{ id: 'existing-module', source: 'project', version: '1.0.0-r1' }];
  const review = store.adoptPreview(project.id, modules);
  store.adopt(project.id, modules, review.fingerprint);
  assert.equal(store.projects().projects[0].problems.length, 0);
  assert.equal(fs.readFileSync(path.join(target, selected[0], 'SKILL.md'), 'utf8'), text);
  assert.equal(loadLock(target).modules[0].source, 'project');
});

test('connection completion preserves existing versions and pin settings while adopting converted skills', () => {
  const { store, project, target } = fixture();
  const installed = ['review', 'ui-direction'];
  store.apply(project.id, installed, store.preview(project.id, installed).fingerprint);
  const originalLock = loadLock(target);
  const reviewer = fs.readFileSync(path.join(target, '.agents/skill-hub/review/agents/reviewer.md'));
  const hubReview = store.module('review');
  store.saveModule('review', { revision: hubReview.revision, files: [{ path: 'agents/reviewer.md', content: '# New shared reviewer\n' }] });
  const selected = ['.agents/skills/existing'];
  const skillText = '---\nname: existing\ndescription: Existing\n---\n\n# Original\n';
  write(target, selected[0] + '/SKILL.md', skillText);
  write(target, selected[0] + '/image.bin', Buffer.from([0, 255]));
  const input = proposal(store, project, [{ id: 'converted', group: 'custom', description: 'Converted', items: selected }], selected);
  store.saveLegacyConversion(project.id, { ...input, fingerprint: store.conversionPreview(project.id, input).fingerprint });
  const preview = store.connectionPreview(project.id, ['converted']);
  assert.equal(loadLock(target).modules.length, 2);
  assert.ok(preview.migration.files.includes(selected[0] + '/SKILL.md'));
  assert.ok(!preview.changes.some(change => change.file.endsWith('reviewer.md')));
  const status = store.connect(project.id, ['converted'], preview.fingerprint);
  assert.equal(status.modules.length, 3);
  assert.deepEqual(loadLock(target).modules.filter(item => item.id !== 'converted'), originalLock.modules);
  assert.deepEqual(fs.readFileSync(path.join(target, '.agents/skill-hub/review/agents/reviewer.md')), reviewer);
  assert.equal(fs.readFileSync(path.join(target, selected[0], 'SKILL.md'), 'utf8'), skillText);
  assert.equal(loadLock(target).files[selected[0] + '/SKILL.md'].module, 'converted');
  assert.equal(status.problems.length, 0);
});

test('connection without collisions works and stale previews cannot accept later disk changes', () => {
  const { store, project, target } = fixture(); prepare(target);
  const input = proposal(store, project);
  store.saveConversion(project.id, { ...input, fingerprint: store.conversionPreview(project.id, input).fingerprint });
  let preview = store.connectionPreview(project.id, ['legacy-ui']);
  assert.equal(preview.preserved.length, 0);
  write(target, 'AGENTS.md', '# Added personal policy\n');
  assert.throws(() => store.connect(project.id, ['legacy-ui'], preview.fingerprint), /устарел/);
  assert.equal(loadLock(target), null);
  preview = store.connectionPreview(project.id, ['legacy-ui']);
  store.connect(project.id, ['legacy-ui'], preview.fingerprint);
  assert.equal(loadLock(target).modules[0].id, 'legacy-ui');
  assert.throws(() => store.connectionPreview(project.id, ['legacy-ui']), /уже подключён/);
});

test('connection endpoint requires authentication and applies only after a reviewed request', async t => {
  const { store, project, target, base } = fixture(); prepare(target);
  const input = proposal(store, project);
  store.saveConversion(project.id, { ...input, fingerprint: store.conversionPreview(project.id, input).fingerprint });
  const server = createGuiServer({ base });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = 'http://127.0.0.1:' + server.address().port;
  const { token } = await fetch(address + '/api/session').then(r => r.json());
  const request = (action, body, auth = true) => fetch(address + '/api/projects/' + project.id + '/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Hub-Token': token } : {}) }, body: JSON.stringify(body)
  });
  assert.equal((await request('connect', { modules: ['legacy-ui'] }, false)).status, 403);
  const preview = await request('connection-preview', { modules: ['legacy-ui'] }).then(r => r.json());
  assert.equal(loadLock(target), null);
  const connected = await request('connect', { modules: ['legacy-ui'], fingerprint: preview.fingerprint });
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).modules[0].source, 'project');
});

test('converted modules leave no active source artifacts while disabled, including binary skill resources', () => {
  const { store, project, target } = fixture(); prepare(target);
  const input = proposal(store, project), preview = store.conversionPreview(project.id, input);
  store.saveConversion(project.id, { ...input, fingerprint: preview.fingerprint });
  assert.equal(projectInstructions(target).instructions.length, 0);
  const backup = JSON.parse(fs.readFileSync(path.join(target, preview.migration.archive)));
  assert.deepEqual(Buffer.from(backup.files.find(file => file.path.endsWith('image.bin')).data, 'base64'), Buffer.from([0, 255, 7]));
  const connect = store.connectionPreview(project.id, ['legacy-ui']);
  store.connect(project.id, ['legacy-ui'], connect.fingerprint);
  assert.equal(projectInstructions(target).instructions.filter(item => item.path !== 'AGENTS.md').every(item => item.managed), true);
  store.apply(project.id, [], store.preview(project.id, []).fingerprint);
  assert.equal(projectInstructions(target).instructions.filter(item => item.path !== 'AGENTS.md').length, 0);
  assert.ok(fs.existsSync(path.join(target, '.skill-hub/variants/legacy-ui/1.0.0-r1.json')));
  assert.ok(fs.existsSync(path.join(target, preview.migration.archive)));
});

test('legacy connections migrate originals and normalize a same-path legacy skill without losing its bytes', () => {
  const { store, project, target } = fixture();
  const selected = ['.agents/skills/existing', '.agents/agents/designer.md', '.agents/rules/ui.md'];
  const originalSkill = '# Old skill without frontmatter\n';
  write(target, selected[0] + '/SKILL.md', originalSkill);
  write(target, selected[0] + '/asset.bin', Buffer.from([0, 128, 255]));
  write(target, selected[1], '# Original role\n'); write(target, selected[2], '# Original rule\n');
  const input = proposal(store, project, [{ id: 'legacy-migration', group: 'custom', description: 'Legacy', items: selected }], selected);
  store.saveLegacyConversion(project.id, input);
  const preview = store.connectionPreview(project.id, ['legacy-migration']);
  assert.equal(preview.migration.files.length, 4);
  store.connect(project.id, ['legacy-migration'], preview.fingerprint);
  assert.equal(fs.existsSync(path.join(target, selected[1])), false);
  assert.equal(fs.existsSync(path.join(target, selected[2])), false);
  assert.ok(fs.readFileSync(path.join(target, selected[0], 'SKILL.md'), 'utf8').endsWith(originalSkill));
  const backup = JSON.parse(fs.readFileSync(path.join(target, preview.migration.archive)));
  assert.equal(Buffer.from(backup.files.find(file => file.path.endsWith('SKILL.md')).data, 'base64').toString(), originalSkill);
  assert.equal(store.projects().projects[0].problems.length, 0);
  store.apply(project.id, [], store.preview(project.id, []).fingerprint);
  assert.equal(fs.existsSync(path.join(target, selected[0], 'SKILL.md')), false);
});

test('legacy cleanup removes only replaced originals and preserves installed state and unrelated files', () => {
  const { store, project, target } = fixture(); prepare(target);
  const input = proposal(store, project);
  store.saveLegacyConversion(project.id, input);
  const modules = [{ id: 'legacy-ui', source: 'project', version: '1.0.0-r1' }];
  store.apply(project.id, modules, store.preview(project.id, modules).fingerprint);
  const before = loadLock(target);
  write(target, '.agents/rules/unrelated.md', '# Unrelated policy');
  const preview = store.connectionPreview(project.id, ['legacy-ui'], true);
  store.connect(project.id, ['legacy-ui'], preview.fingerprint, true);
  assert.deepEqual(loadLock(target), before);
  for (const source of paths) assert.equal(fs.existsSync(path.join(target, source)), false);
  assert.equal(fs.readFileSync(path.join(target, '.agents/rules/unrelated.md'), 'utf8'), '# Unrelated policy');
});

test('changed resources and missing module replacements block archival before any write', () => {
  const { store, project, target } = fixture(); prepare(target);
  const input = proposal(store, project); store.saveLegacyConversion(project.id, input);
  const preview = store.connectionPreview(project.id, ['legacy-ui']);
  write(target, paths[0] + '/assets/added.txt', 'Unpacked new resource');
  assert.throws(() => store.connect(project.id, ['legacy-ui'], preview.fingerprint), /изменился/);
  assert.equal(fs.existsSync(path.join(target, preview.migration.archive)), false);
  fs.unlinkSync(path.join(target, paths[0], 'assets/added.txt'));
  const editor = store.projectModule(project.id, 'legacy-ui', { source: 'project' });
  store.saveProjectModule(project.id, 'legacy-ui', { source: 'project', revision: editor.revision, files: [{ path: 'skills/old-skill/assets/image.bin', content: null }] });
  assert.throws(() => store.connectionPreview(project.id, ['legacy-ui']), /нет замены/);
  assert.equal(fs.existsSync(path.join(target, paths[0], 'assets/image.bin')), true);
});

test('a deletion failure rolls back archive, versions and every removed original', () => {
  const { store, project, target } = fixture(); prepare(target);
  const input = proposal(store, project), preview = store.conversionPreview(project.id, input);
  const originalUnlink = fs.unlinkSync;
  let failed = false;
  fs.unlinkSync = function(file, ...args) {
    if (!failed && String(file) === path.join(target, paths[1])) { failed = true; throw new Error('Delete failure'); }
    return originalUnlink.call(this, file, ...args);
  };
  try { assert.throws(() => store.saveConversion(project.id, { ...input, fingerprint: preview.fingerprint }), /Delete failure/); }
  finally { fs.unlinkSync = originalUnlink; }
  assert.equal(fs.readFileSync(path.join(target, paths[0], 'SKILL.md'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(target, paths[1]), 'utf8'), rule);
  assert.equal(fs.existsSync(path.join(target, preview.migration.archive)), false);
  assert.equal(fs.existsSync(path.join(target, '.skill-hub/variants/legacy-ui/1.0.0-r1.json')), false);
});

test('generated AGENTS changes never mark personal text changed in new or legacy conversions', () => {
  for (const legacy of [false, true]) {
    const { store, project, target } = fixture();
    write(target, 'AGENTS.md', '# Personal policy\n');
    const selected = ['AGENTS.md'];
    const input = proposal(store, project, [{ id: 'personal', group: 'custom', description: 'Personal', items: selected }], selected);
    if (legacy) store.saveLegacyConversion(project.id, input);
    else store.saveConversion(project.id, { ...input, fingerprint: store.conversionPreview(project.id, input).fingerprint });
    store.apply(project.id, ['review'], store.preview(project.id, ['review']).fingerprint);
    assert.equal(store.projects().projects[0].instructions.find(item => item.path === 'AGENTS.md').packedChanged, false);
    const agents = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
    write(target, 'AGENTS.md', agents.replace('# Personal policy', '# Changed personal policy'));
    assert.equal(store.projects().projects[0].instructions.find(item => item.path === 'AGENTS.md').packedChanged, true);
  }
});

test('migration redirects only exact AGENTS source links and backs up the original personal file', () => {
  for (const legacy of [false, true]) {
    const { store, project, target } = fixture();
    const source = '.agents/rules/ui.md';
    const agents = '# Personal\nRead [' + source + '](' + source + '). Keep ' + source + '-other.\n';
    write(target, 'AGENTS.md', agents); write(target, source, '# UI policy\n');
    const input = proposal(store, project, [{ id:'redirected', group:'custom', description:'UI policy', items:[source] }], [source]);
    if (legacy) store.saveLegacyConversion(project.id, input);
    else store.saveConversion(project.id, { ...input, fingerprint: store.conversionPreview(project.id, input).fingerprint });
    const preview = store.connectionPreview(project.id, ['redirected']);
    assert.ok(preview.migration.agentLinks.after.includes('.cursor/rules/skill-hub/redirected/ui.mdc'));
    assert.ok(preview.migration.agentLinks.after.includes(source + '-other'));
    store.connect(project.id, ['redirected'], preview.fingerprint);
    const backup = JSON.parse(fs.readFileSync(path.join(target, preview.migration.agentArchive)));
    assert.equal(Buffer.from(backup.files[0].data, 'base64').toString(), agents);
    assert.equal(store.projects().projects[0].problems.length, 0);
    assert.equal(fs.existsSync(path.join(target, source)), false);
  }
});
