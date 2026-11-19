// Prefer the device, fall back to the cloud: the decision, with no SDK or DOM,
// so it is tested on its own. Used by the demo workspace when the user turns
// on "read on this device when its model is ready" (ai.generatePreferDevice).
//
// The device is tried only when Chrome reports its model available and it is
// not known to be stuck; otherwise the call goes to the cloud at once. That is
// the same fallback the SDK makes in PREFER_ON_DEVICE, made here first so a
// click never starts a multi-gigabyte download, and so the reason is known.
// A device call that fails or times out is retried in the cloud.
//
// Returns the answer ({source, ms, parsed, ...}) and, when the cloud answered
// in place of the device, `fallback`: why.

import { STUCK_MESSAGE } from './device-guard.js';

const STUCK = 'the device model is stuck (restart Chrome to use it again)';

// The device error, as a reason for the cloud read: without "Nothing was sent
// anywhere", which is not true once the cloud has the note.
const reason = (message) => (message === STUCK_MESSAGE ? STUCK
  : `the device model failed: ${message.replace(/\s*Nothing was sent anywhere\.?\s*$/, '').replace(/\.$/, '')}`);

export async function hybridCall({ deviceState, stuck = false, callDevice, callCloud }) {
  if (stuck) return { ...(await callCloud()), fallback: STUCK };
  if (deviceState !== 'available') return { ...(await callCloud()), fallback: `the device model is ${deviceState}` };
  try {
    return await callDevice();
  } catch (err) {
    return { ...(await callCloud()), fallback: reason(err.message) };
  }
}

// Which model a note was read by, from the source the SDK reports.
export const readBy = (source, cloudModel) => (source === 'on_device' ? 'device' : `cloud:${cloudModel}`);
