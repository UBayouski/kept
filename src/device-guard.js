// Chrome's on-device model answers one call at a time, and it can get stuck:
// a call never ends, and every later call waits behind it, in every tab, until
// Chrome is restarted. Stopping the call (the 45 s timeout in ai.js) does not
// always free it. After a timeout this checks with one short call; if that does
// not answer either, the model is reported stuck and later reads fail at once
// with that message instead of each waiting 45 s.

export const STUCK_MESSAGE = "Chrome's on-device model is stuck: it stopped answering, also to a short test. Restart Chrome (close every Chrome window), then reload this page. Nothing was sent anywhere.";

// probe(signal): resolves when the model answers a trivial prompt.
export function makeDeviceGuard({ probe, probeMs = 15000 }) {
  let stuck = false;
  return {
    get stuck() { return stuck; },
    // Throws at once when the model is known to be stuck.
    check() {
      if (stuck) throw new Error(STUCK_MESSAGE);
    },
    // After a timeout: true if the model still answers a short call.
    async afterTimeout() {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), probeMs);
      try {
        await probe(stop.signal);
        return true;
      } catch {
        stuck = true;
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
