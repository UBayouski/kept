// The stuck device model: after a timeout, one short check decides whether
// later reads wait or fail at once with "restart Chrome".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeviceGuard, STUCK_MESSAGE } from '../src/device-guard.js';

test('a model that answers the check is not stuck; reads go on', async () => {
  const guard = makeDeviceGuard({ probe: async () => {} });
  assert.equal(await guard.afterTimeout(), true);
  assert.equal(guard.stuck, false);
  assert.doesNotThrow(() => guard.check());
});

test('a model that does not answer the check is stuck, and later reads fail at once', async () => {
  let aborted = false;
  const guard = makeDeviceGuard({
    probeMs: 20,
    probe: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })),
  });
  assert.equal(await guard.afterTimeout(), false);
  assert.equal(aborted, true);
  assert.equal(guard.stuck, true);
  assert.throws(() => guard.check(), { message: STUCK_MESSAGE });
  assert.match(STUCK_MESSAGE, /Restart Chrome/);
});

test('a check that fails outright also counts as stuck', async () => {
  const guard = makeDeviceGuard({ probe: async () => { throw new Error('model crashed'); } });
  assert.equal(await guard.afterTimeout(), false);
  assert.equal(guard.stuck, true);
});

test('a stuck model that answers a later check is used again', async () => {
  let up = false;
  const guard = makeDeviceGuard({ probe: async () => { if (!up) throw new Error('no answer'); } });
  await guard.afterTimeout();
  assert.equal(await guard.retry(), true);
  up = true;
  assert.equal(await guard.retry(), false);
  assert.doesNotThrow(() => guard.check());
});

test('only one later check runs at a time', async () => {
  let probes = 0;
  let release;
  const guard = makeDeviceGuard({ probe: () => { probes += 1; return probes === 1 ? Promise.reject(new Error('no answer')) : new Promise((resolve) => { release = resolve; }); } });
  await guard.afterTimeout();
  const first = guard.retry();
  assert.equal(await guard.retry(), true);
  release();
  assert.equal(await first, false);
  assert.equal(probes, 2);
});

test('the first read gets the long limit, a read after an answer the short one', () => {
  const guard = makeDeviceGuard({ probe: async () => {} });
  assert.equal(guard.limitMs, 45000);
  guard.answered();
  assert.equal(guard.limitMs, 20000);
});

test('after a timeout the next read gets the long limit again, unless the check answers', async () => {
  const guard = makeDeviceGuard({ probe: async () => { throw new Error('no answer'); } });
  guard.answered();
  await guard.afterTimeout();
  assert.equal(guard.limitMs, 45000);
  const fine = makeDeviceGuard({ probe: async () => {} });
  await fine.afterTimeout();
  assert.equal(fine.limitMs, 20000);
});

test('two timeouts during one check share it', async () => {
  let probes = 0;
  let release;
  const guard = makeDeviceGuard({ probe: () => { probes += 1; return new Promise((resolve) => { release = resolve; }); } });
  const first = guard.afterTimeout();
  const second = guard.afterTimeout();
  release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(probes, 1);
});
