import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { catalog } from '../scripts/hub.mjs';

const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helper = path.join(hub, 'scripts/hub.mjs');
const temp = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(temp, 'skill-hub-test-'));
const original = '\uFEFF# Project rules\r\n\r\nKeep user text.\r\n';
let counter = 0;

after(() => {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('skill-hub-test-'));
  fs.rmSync(resolved, { recursive: true });
});

function project() {
  const directory = path.join(scratch, `project-${++counter}`);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), original);
  return directory;
}

function run(...args) {
  const result = spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

function ok(...args) {
  const result = run(...args);
  assert.equal(result.code, 0, result.output);
  return result;
}

function snapshot(root) {
  const result = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(file)}`;
      else if (entry.isDirectory()) walk(file);
      else result[relative] = fs.readFileSync(file).toString('base64');
    }
  }
  walk(root);
  return result;
}

test('catalog and presets validate', () => {
  ok('validate');
  const listed = ok('list').output;
  assert.match(listed, /git-confirm-pr \[git-workflow\]/);
  assert.match(listed, /git-auto-pr \[git-workflow\]/);
  assert.match(listed, /go-ddd/);
  assert.match(listed, /skill-authoring/);
  assert.match(listed, /project-init/);
});

test('every module installs, runs status and removes independently', () => {
  const modules = [...catalog().keys()];
  assert.ok(modules.length >= 2);
  for (const module of modules) {
    const target = project();
    ok('apply', target, module);
    ok('status', target);
    ok('apply', target, '--none');
    assert.equal(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), original, module);
    ok('status', target);
  }
});

test('every preset installs', () => {
  for (const file of fs.readdirSync(path.join(hub, 'presets'))) {
    const target = project();
    ok('apply', target, '--preset', path.basename(file, '.json'));
    ok('status', target);
  }
});

test('dry-run and invalid selections leave project untouched', () => {
  const target = project();
  const before = snapshot(target);
  ok('apply', target, 'git-confirm-pr', 'go-ddd', '--dry-run');
  assert.deepEqual(snapshot(target), before);
  assert.equal(run('apply', target, 'unknown-module').code, 1);
  assert.equal(run('apply', target).code, 1);
  assert.deepEqual(snapshot(target), before);
});

test('repeated apply is idempotent; swapping set removes old module files', () => {
  const target = project();
  ok('apply', target, 'git-confirm-pr', 'go-ddd');
  const before = snapshot(target);
  assert.match(ok('apply', target, 'go-ddd', 'git-confirm-pr').output, /изменений нет|No changes|idempotent|без изменений|OK|applied|уже/i);
  // second apply with same set should be a no-op (empty plan message varies) — at least exit 0 and same tree
  ok('apply', target, 'git-confirm-pr', 'go-ddd');
  assert.deepEqual(snapshot(target), before);
  ok('apply', target, 'git-confirm-pr');
  const agents = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith(original));
  assert.ok(agents.includes('git-confirm-pr'));
  assert.ok(!agents.includes('go-ddd'));
  assert.ok(!fs.existsSync(path.join(target, '.cursor/rules/skill-hub/go-ddd/go-ddd.mdc')));
  ok('status', target);
});

test('local edits block update and removal before any writes', () => {
  const target = project();
  ok('apply', target, 'git-confirm-pr');
  fs.appendFileSync(path.join(target, '.agents/skills/git-workflow/SKILL.md'), '\nlocal edit');
  const before = snapshot(target);
  assert.equal(run('status', target).code, 1);
  assert.equal(run('apply', target, 'go-ddd').code, 1);
  assert.equal(run('apply', target, '--none').code, 1);
  assert.deepEqual(snapshot(target), before);
});

test('foreign files are never adopted or overwritten', () => {
  const target = project();
  const file = path.join(target, '.agents/skills/git-workflow/SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(catalog().get('git-confirm-pr').root, 'skills/git-workflow/SKILL.md'), file);
  const before = snapshot(target);
  assert.equal(run('apply', target, 'git-confirm-pr').code, 1);
  assert.deepEqual(snapshot(target), before);
});

test('removal preserves user additions and exact original AGENTS bytes', () => {
  const target = project();
  ok('apply', target, 'git-confirm-pr');
  const extra = path.join(target, '.agents/skills/git-workflow/user.txt');
  fs.writeFileSync(extra, 'keep');
  fs.appendFileSync(path.join(target, 'AGENTS.md'), '\n\n# User appendix\n');
  ok('apply', target, '--none');
  assert.equal(fs.readFileSync(extra, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), original + '\n\n# User appendix\n');
  ok('apply', target, 'go-ddd');
  assert.equal(fs.readFileSync(extra, 'utf8'), 'keep');
});

test('missing managed file is repaired; changed managed AGENTS block is refused', () => {
  const target = project();
  ok('apply', target, 'git-confirm-pr');
  const skill = path.join(target, '.agents/skills/git-workflow/SKILL.md');
  fs.unlinkSync(skill);
  assert.equal(run('status', target).code, 1);
  ok('apply', target, 'git-confirm-pr');
  assert.ok(fs.existsSync(skill));
  const agents = path.join(target, 'AGENTS.md');
  const text = fs.readFileSync(agents, 'utf8');
  fs.writeFileSync(agents, text.replace('git-confirm-pr', 'mutated'));
  const before = snapshot(target);
  assert.equal(run('apply', target, 'go-ddd').code, 1);
  assert.deepEqual(snapshot(target), before);
});

test('unsupported AGENTS encodings fail without changing any bytes', () => {
  const encodings = [
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('user text', 'utf16le')]),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('a\0b'),
  ];
  for (const bytes of encodings) {
    const target = project();
    fs.writeFileSync(path.join(target, 'AGENTS.md'), bytes);
    const before = snapshot(target);
    assert.equal(run('apply', target, 'git-confirm-pr').code, 1);
    assert.deepEqual(snapshot(target), before);
  }
});

test('dangling links and directory junctions cannot redirect writes', t => {
  const target = project();
  const outside = path.join(scratch, 'outside.md');
  fs.unlinkSync(path.join(target, 'AGENTS.md'));
  try { fs.symlinkSync(outside, path.join(target, 'AGENTS.md'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink permission unavailable'); return; } throw error; }
  assert.equal(run('apply', target, 'git-confirm-pr').code, 1);
  assert.equal(fs.existsSync(outside), false);
  const second = project();
  const outsideDirectory = path.join(scratch, 'outside-directory');
  fs.mkdirSync(outsideDirectory);
  fs.symlinkSync(outsideDirectory, path.join(second, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(run('apply', second, 'git-confirm-pr').code, 1);
  assert.deepEqual(fs.readdirSync(outsideDirectory), []);
});

test('ordinary mid-write failure rolls back installed and removed files', () => {
  const target = project();
  ok('apply', target, 'git-confirm-pr');
  const before = snapshot(target);
  const program = `
    import fs from 'node:fs';
    const originalWrite = fs.writeFileSync;
    let armed = true;
    fs.writeFileSync = (file, ...args) => {
      if (armed && file === ${JSON.stringify(path.join(target, 'AGENTS.md'))}) {
        armed = false;
        throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
      }
      return originalWrite(file, ...args);
    };
    process.argv = [process.execPath, ${JSON.stringify(helper)}, 'apply', ${JSON.stringify(target)}, 'go-ddd'];
    await import(${JSON.stringify(pathToFileURL(helper).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /injected write failure/);
  assert.deepEqual(snapshot(target), before);
  ok('status', target);
});
