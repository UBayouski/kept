// The prefer-device decision of the demo workspace (src/hybrid.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hybridCall, readBy } from '../src/hybrid.js';

const calls = () => {
  const made = [];
  return {
    made,
    callDevice: async () => { made.push('device'); return { source: 'on_device', parsed: {} }; },
    callCloud: async () => { made.push('cloud'); return { source: 'in_cloud', parsed: {} }; },
  };
};

test('the device answers when its model is available, and the cloud is not called', async () => {
  const c = calls();
  const r = await hybridCall({ deviceState: 'available', ...c });
  assert.deepEqual([r.source, r.fallback, c.made], ['on_device', undefined, ['device']]);
});

test('the cloud answers at once when the device model is not there, and says why', async () => {
  for (const state of ['downloadable', 'downloading', 'unavailable']) {
    const c = calls();
    const r = await hybridCall({ deviceState: state, ...c });
    assert.deepEqual([r.source, r.fallback, c.made], ['in_cloud', `the device model is ${state}`, ['cloud']], state);
  }
});

test('a stuck device model is not tried', async () => {
  const c = calls();
  const r = await hybridCall({ deviceState: 'available', stuck: true, ...c });
  assert.deepEqual([r.source, r.fallback, c.made], ['in_cloud', 'the device model is stuck', ['cloud']]);
});

test('a device call that fails or times out is answered by the cloud', async () => {
  const c = calls();
  const r = await hybridCall({ deviceState: 'available', ...c, callDevice: async () => { c.made.push('device'); throw new Error('did not answer within 45 s'); } });
  assert.deepEqual([r.source, c.made], ['in_cloud', ['device', 'cloud']]);
  assert.match(r.fallback, /failed: did not answer within 45 s/);
});

test('a cloud failure is not hidden', async () => {
  await assert.rejects(hybridCall({ deviceState: 'unavailable', callDevice: async () => ({}), callCloud: async () => { throw new Error('429 quota'); } }), /429/);
});

test('the note records the model that actually answered', () => {
  assert.equal(readBy('on_device', 'gemini-x'), 'device');
  assert.equal(readBy('in_cloud', 'gemini-x'), 'cloud:gemini-x');
});
