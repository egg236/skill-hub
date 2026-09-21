import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { test } from 'node:test';
import { createPathPicker } from '../scripts/path-picker.mjs';
import { createGuiServer } from '../scripts/gui.mjs';

function fixture(options = {}) {
  const children = [];
  const picker = createPathPicker({ platform: 'win32', ...options, launch() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  } });
  return { children, picker };
}
test('a picker that never appears times out and can be reopened', async () => {
  const { picker, children } = fixture({ startupTimeoutMs: 20 });
  await assert.rejects(picker.pick({ kind: 'folder' }), /не появилось/);
  assert.equal(children[0].killed, true);
  const next = picker.pick({ kind: 'file' });
  children[1].stdout.write('{"cancelled":true,"path":null}');
  children[1].emit('close', 0);
  assert.deepEqual(await next, { cancelled: true, path: null });
});
test('visible-window acknowledgement clears the startup deadline and final output remains parseable', async () => {
  const { picker, children } = fixture({ startupTimeoutMs: 20, timeoutMs: 1000 });
  const pending = picker.pick({ kind: 'folder' });
  children[0].stdout.write('{"rea'); children[0].stdout.write('dy":true}\n');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(children[0].killed, undefined);
  children[0].stdout.write('{"cancelled":true,"path":null}\n');
  children[0].emit('close', 0);
  assert.equal((await pending).cancelled, true);
});
test('closing or replacing a picker releases the pending request and late exits cannot clear a newer picker', async () => {
  const { picker, children } = fixture();
  const old = picker.pick({ kind: 'folder' });
  const current = picker.pick({ kind: 'file' });
  assert.equal((await old).cancelled, true);
  assert.equal(children[0].killed, true);
  children[0].emit('close', 1);
  picker.close();
  assert.equal(children[1].killed, true);
  assert.equal((await current).cancelled, true);
});
test('aborting a request cancels only its own window; a visible window also has a maximum lifetime', async () => {
  const { picker, children } = fixture({ startupTimeoutMs: 1000, timeoutMs: 30 });
  const controller = new AbortController();
  const first = picker.pick({ kind: 'folder' }, { signal: controller.signal });
  const second = picker.pick({ kind: 'file' });
  controller.abort();
  assert.equal((await first).cancelled, true);
  assert.equal(children[1].killed, undefined);
  children[1].stdout.write('{"ready":true}\n');
  await assert.rejects(second, /по времени/);
  assert.equal(children[1].killed, true);
  const freshController = new AbortController();
  const third = picker.pick({ kind: 'folder' }, { signal: freshController.signal });
  freshController.abort();
  assert.equal((await third).cancelled, true);
  assert.equal(children[2].killed, true);
});
test('disconnecting the browser aborts its picker and permits the next request', async t => {
  let started, aborted = 0;
  const began = new Promise(resolve => { started = resolve; });
  const server = createGuiServer({ pathPicker: {
    close() {},
    pick(input, { signal }) {
      if (input.kind === 'file') return { cancelled: true, path: null };
      started();
      return new Promise(resolve => signal.addEventListener('abort', () => { aborted++; resolve({ cancelled: true, path: null }); }, { once: true }));
    },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(address + '/api/session').then(response => response.json());
  const request = http.request(address + '/api/picker', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token } });
  request.on('error', () => {});
  request.end(JSON.stringify({ kind: 'folder' }));
  await began;
  request.destroy();
  for (let n = 0; !aborted && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(aborted, 1);
  const next = await fetch(address + '/api/picker', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token }, body: JSON.stringify({ kind: 'file' }) });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).cancelled, true);
});
