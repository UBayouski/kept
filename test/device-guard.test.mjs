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
