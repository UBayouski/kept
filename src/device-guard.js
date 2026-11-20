// Chrome's on-device model answers one call at a time, and it can get stuck:
// a call never ends, and every later call waits behind it, in every tab, until
// Chrome is restarted. Stopping the call (the timeout in ai.js) does not
// always free it. After a timeout this checks with one short call; if that does
// not answer either, the model is reported stuck and later reads fail at once
// with that message instead of each waiting for the timeout. While it is stuck,
// each read starts one more check in the background, so a model that comes back
// is used again without a page reload.
//
// The guard also sets how long a read may take (limitMs). The first call on a
// page may have to load the model, about 20 s, so it gets 45 s. Once the model
// has answered, a read takes 1 to 6 s and gets 20 s. After a timeout the next
// read gets 45 s again: the model may have to load again.

export const STUCK_MESSAGE = "Chrome's on-device model is stuck: it stopped answering, also to a short test. Restart Chrome (close every Chrome window), then reload this page. Nothing was sent anywhere.";

// probe(signal): resolves when the model answers a trivial prompt.
// The check is given 30 s: a cold model takes about 20 s to load (measured on
// the first call after a Chrome restart), and that is not being stuck.
export function makeDeviceGuard({ probe, probeMs = 30000, retryMs = 60000, firstMs = 45000, warmMs = 20000 }) {
  let stuck = false;
  let retrying = false;
  let answered = false;
  let checking = null;
  const answers = async (ms) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ms);
    try {
      await probe(stop.signal);
      answered = true;
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
    // How long the next read may take.
    get limitMs() { return answered ? warmMs : firstMs; },
    // The model answered a call.
    answered() { answered = true; },
    // After a timeout: true if the model still answers a short call. One check
    // at a time: a second timeout during a check waits for the same answer.
    afterTimeout() {
      answered = false;
      checking ??= answers(probeMs).then((ok) => {
        stuck = !ok;
        checking = null;
        return ok;
      });
      return checking;
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
