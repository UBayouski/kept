// Dedicated module worker that owns the Relate store.
// The engine is loaded by URL from /relate/ so the bundler never rewrites it.

const STORE = 'opfs://kept';
const engine = (file) => new URL(`/relate/${file}`, self.location.origin).href;

let isWasmTrap = () => false;

const ready = (async () => {
  const relate = await import(/* @vite-ignore */ engine('relate.js'));
  await relate.default();
  ({ isWasmTrap } = await import(/* @vite-ignore */ engine('trap.js')));
  return relate.RelateDb.open(STORE);
})();

// Tell the page whether the store opened, so a lock or load failure is visible.
ready.then(
  () => self.postMessage({ type: 'ready', store: STORE }),
  (err) => self.postMessage({ type: 'open-failed', error: String(err) }),
);

self.onmessage = async (event) => {
  const { id, op, statement, params } = event.data;
  try {
    const db = await ready;
    if (op === 'reset') {
      await db.reset();
      self.postMessage({ id, result: { rows: [], error: null } });
      return;
    }
    const text = db.execute(statement, params ? JSON.stringify(params) : null);
    self.postMessage({ id, result: JSON.parse(text) });
  } catch (err) {
    self.postMessage({ id, trap: isWasmTrap(err), thrown: String(err) });
  }
};
