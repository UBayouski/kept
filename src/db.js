// Page-side client for the Relate worker: Cypher in, rows out.
// One worker owns the store. If the engine traps, the worker is replaced;
// the OPFS store keeps every write it acknowledged.

let worker;
let nextId = 1;
const pending = new Map();
let onStatus = () => {};

function start() {
  worker = new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'ready' || msg.type === 'open-failed') {
      onStatus(msg);
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.thrown) {
      if (msg.trap) restart();
      waiter.reject(new Error(msg.thrown));
    } else if (msg.result.error !== null) {
      waiter.reject(new Error(msg.result.error));
    } else {
      waiter.resolve(msg.result);
    }
  };
}

function send(message) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
}

export function restart() {
  worker?.terminate();
  for (const waiter of pending.values()) waiter.reject(new Error('worker restarted'));
  pending.clear();
  start();
}

export function init(statusCallback) {
  onStatus = statusCallback;
  start();
}

export async function query(statement, params) {
  const result = await send({ op: 'execute', statement, params });
  return result.rows;
}

export function reset() {
  return send({ op: 'reset' });
}
