// Dedicated module worker that owns one Relate store.
// The engine is loaded by URL from /relate/ so the bundler never rewrites it.
// The page says which store to open in its first message; each workspace has its own.

const DEFAULT_STORE = 'opfs://kept';
const engine = (file) => new URL(`/relate/${file}`, self.location.origin).href;

let isWasmTrap = () => false;
let ready = null;

function open(store) {
  ready = (async () => {
    const relate = await import(/* @vite-ignore */ engine('relate.js'));
    await relate.default();
    ({ isWasmTrap } = await import(/* @vite-ignore */ engine('trap.js')));
    return relate.RelateDb.open(store);
  })();
  // Tell the page whether the store opened, so a lock or load failure is visible.
  ready.then(
    () => self.postMessage({ type: 'ready', store }),
    (err) => self.postMessage({ type: 'open-failed', error: String(err) }),
  );
}

self.onmessage = async (event) => {
  const { id, op, statement, params, store } = event.data;
  if (op === 'open') {
    if (!ready) open(store || DEFAULT_STORE);
    return;
  }
  try {
    if (!ready) throw new Error('The store has not been opened.');
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
