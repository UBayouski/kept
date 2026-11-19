// Dedicated worker for the browser-build test run: Relate's WebAssembly build,
// one OPFS store per test store, as src/db.worker.js does for the app.
const engine = (file) => new URL(`/relate/${file}`, self.location.origin).href;
const loaded = (async () => {
  const relate = await import(engine('relate.js'));
  await relate.default();
  return relate;
})();
const stores = new Map();

self.onmessage = async ({ data: { id, store, statement, params } }) => {
  try {
    const relate = await loaded;
    if (!stores.has(store)) stores.set(store, relate.RelateDb.open(`opfs://${store}`));
    const db = await stores.get(store);
    const text = db.execute(statement, params ? JSON.stringify(params) : null);
    self.postMessage({ id, result: JSON.parse(text) });
  } catch (err) {
    self.postMessage({ id, thrown: String(err) });
  }
};
