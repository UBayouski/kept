// Chrome's on-device model answers one call at a time, and it can get stuck:
// a call never ends, and every later call waits behind it, in every tab, until
// Chrome is restarted. Stopping the call (the 45 s timeout in ai.js) does not
// always free it. After a timeout this checks with one short call; if that does
// not answer either, the model is reported stuck and later reads fail at once
// with that message instead of each waiting 45 s. While it is stuck, each read
// starts one more check in the background, so a model that comes back is used
// again without a page reload.

export const STUCK_MESSAGE = "Chrome's on-device model is stuck: it stopped answering, also to a short test. Restart Chrome (close every Chrome window), then reload this page. Nothing was sent anywhere.";

// probe(signal): resolves when the model answers a trivial prompt.
// The check is given 30 s: a cold model takes about 20 s to load (measured on
// the first call after a Chrome restart), and that is not being stuck.
export function makeDeviceGuard({ probe, probeMs = 30000, retryMs = 60000 }) {
  let stuck = false;
  let retrying = false;
  const answers = async (ms) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ms);
    try {
      await probe(stop.signal);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    get stuck() { return stuck; },
    // Throws at once when the model is known to be stuck.
    check() {
      if (stuck) throw new Error(STUCK_MESSAGE);
    },
    // After a timeout: true if the model still answers a short call.
    async afterTimeout() {
      stuck = !(await answers(probeMs));
      return !stuck;
    },
    // While stuck: checks again, one check at a time. Resolves to whether the
    // model is still stuck.
    async retry() {
      if (!stuck || retrying) return stuck;
      retrying = true;
      try {
        if (await answers(retryMs)) stuck = false;
      } finally {
        retrying = false;
      }
      return stuck;
    },
  };
}
