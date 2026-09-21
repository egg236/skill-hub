import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cursorIgnoreBytes } from '../scripts/cursor-ignore.mjs';
import { cursorIgnoreChanges, apply, plan, hub, catalog, selection } from '../scripts/hub.mjs';

test('Cursor ignore preserves user bytes and line endings and is idempotent', () => {
  for (const original of ['', '# User\nprivate/\n', '\uFEFF# Моё\r\nprivate/', '# User\r\n!.skill-hub/**\r\n']) {
    const result = cursorIgnoreBytes(Buffer.from(original));
    assert.ok(result.toString().startsWith(original));
    assert.match(result.toString(), /\n\.skill-hub\//);
    assert.equal(cursorIgnoreBytes(result), null);
    assert.equal(result.toString().includes('.agents/'), false);
    assert.equal(result.toString().includes('.cursor/rules'), false);
    if (original.includes('\r\n')) assert.equal(result.toString().replaceAll('\r\n', '').includes('\n'), false);
  }
});

test('Cursor ignore updates only its block and restores exclusion after later negations', () => {
  const first = cursorIgnoreBytes(Buffer.from('private/\n'));
  const result = cursorIgnoreBytes(Buffer.from(first.toString() + '!**/*.json\n'));
  assert.ok(result.toString().startsWith('private/\n!**/*.json\n'));
  assert.equal(result.toString().split('# skill-hub:ignore:start').length, 2);
  assert.equal(cursorIgnoreBytes(result), null);
  assert.throws(() => cursorIgnoreBytes(Buffer.from('# skill-hub:ignore:start\n')), /Повреждён/);
  assert.throws(() => cursorIgnoreBytes(Buffer.from([0xff, 0xfe, 0, 0])), /UTF-8/);
});

test('CLI previews exclusion without writing, keeps it after disconnect, and rolls it back on write failure', t => {
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'hub-ignore-test-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), temp);
    assert.ok(path.basename(root).startsWith('hub-ignore-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const changes = plan(root, selection(['review'], catalog(hub)));
  assert.ok(changes.some(change => change.file === '.cursorignore'));
  assert.equal(fs.readdirSync(root).length, 0);
  apply(root, changes);
  assert.deepEqual(cursorIgnoreChanges(root), []);
  apply(root, plan(root, []));
  assert.ok(fs.readFileSync(path.join(root, '.cursorignore'), 'utf8').includes('.skill-hub/'));
  fs.writeFileSync(path.join(root, '.cursorignore'), 'private/\n');
  const writeFile = fs.writeFileSync;
  let ignoreWritten = false;
  fs.writeFileSync = (file, ...args) => {
    if (file === path.join(root, 'later.txt')) throw new Error('Simulated write failure');
    if (file === path.join(root, '.cursorignore')) ignoreWritten = true;
    return writeFile(file, ...args);
  };
  try {
    assert.throws(() => apply(root, [...cursorIgnoreChanges(root), { file: 'later.txt', data: Buffer.from('x') }]), /Simulated write failure/);
    assert.equal(ignoreWritten, true);
  } finally { fs.writeFileSync = writeFile; }
  assert.equal(fs.readFileSync(path.join(root, '.cursorignore'), 'utf8'), 'private/\n');
});
