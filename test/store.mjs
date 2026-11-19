// A fresh Relate store for a test, as q(cypher, params) -> rows.
//
//   npm test           the Node binding (@relate/relate), synchronous
//   npm run test:wasm  the browser build: Relate's WebAssembly engine in a
//                      dedicated worker on an OPFS store, in headless Chromium,
//                      the same path the app uses (src/db.worker.js)
//
// The rules in src/model.js accept rows or a promise of rows, so the same tests
// run on both.

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { after } from 'node:test';

export const ENGINE = process.env.RELATE_ENGINE === 'wasm' ? 'wasm' : 'node';

export function openStore(prefix = 'kept') {
  return ENGINE === 'wasm' ? wasmStore() : nodeStore(prefix);
}

function nodeStore(prefix) {
  const { Database } = createRequire(import.meta.url)('@relate/relate');
  const conn = Database.open(join(mkdtempSync(join(tmpdir(), `${prefix}-`)), 'store.rl')).connect();
  return (cypher, params) => conn.query(cypher, params ?? {}).rows;
}

// --- The browser build ---

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
let page = null;
let stores = 0;
let chrome = null;
let server = null;
// Registered when the file loads, so it runs once after all its tests,
// not after whichever test happened to open the first store.
if (ENGINE === 'wasm') after(async () => { await chrome?.close(); server?.close(); });

async function browser() {
  if (!existsSync(join(root, 'public/relate/relate.js'))) {
    throw new Error('public/relate/ is missing: run npm run copy-relate first.');
  }
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = normalize(join(root, path.startsWith('/relate/') ? join('public', path) : path));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const { chromium } = await import('playwright');
  chrome = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const p = await chrome.newPage();
  p.on('pageerror', (err) => console.error('page error:', err.message));
  // localhost, so OPFS is available (a secure context).
  await p.goto(`http://localhost:${server.address().port}/test/browser/index.html`);
  await p.waitForFunction(() => window.ready === true);
  return p;
}

function wasmStore() {
  page ??= browser();
  const store = `t${process.pid}-${++stores}`;
  return async (cypher, params) => {
    const { result, thrown } = await (await page).evaluate(([s, c, p]) => window.run(s, c, p), [store, cypher, params ?? null]);
    if (thrown) throw new Error(thrown);
    if (result.error !== null) throw new Error(result.error);
    return result.rows;
  };
}
