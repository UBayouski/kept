// Runs the capture evaluation (eval.html) in headless Chromium against the
// real cloud model and saves the raw report to eval/results/.
//
//   npm run eval
//
// Needs an App Check debug token registered in the Firebase console, in
// .env.local (never committed) as KEPT_APPCHECK_DEBUG_TOKEN=<uuid>.
// CHROME_PATH points at a Chromium if Playwright's own is not installed.

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = existsSync(join(root, '.env.local')) ? readFileSync(join(root, '.env.local'), 'utf8') : '';
const token = /KEPT_APPCHECK_DEBUG_TOKEN=(\S+)/.exec(env)?.[1];
if (!token) {
  console.error('No KEPT_APPCHECK_DEBUG_TOKEN in .env.local. Register a debug token in the Firebase console and put it there.');
  process.exit(1);
}

const server = await createServer({ root, server: { port: 5181, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('page error:', err.message));
  await page.addInitScript((t) => localStorage.setItem('kept.appCheckDebugToken', t), token);
  await page.goto('http://localhost:5181/eval.html');
  await page.waitForFunction(() => document.getElementById('progress').textContent === 'ready', null, { timeout: 30000 });
  await page.click('#run');
  // Progress as it goes, and a stop when it stalls: no note takes 3 minutes,
  // and the whole set takes about 5.
  const STALL_MS = 3 * 60 * 1000;
  const TOTAL_MS = 20 * 60 * 1000;
  const started = Date.now();
  let shown = '';
  let changedAt = Date.now();
  while (true) {
    const progress = await page.locator('#progress').innerText();
    if (progress !== shown) {
      console.log(`${Math.round((Date.now() - started) / 1000)} s: ${progress}`);
      shown = progress;
      changedAt = Date.now();
    }
    if (progress === 'done') break;
    if (Date.now() - changedAt > STALL_MS || Date.now() - started > TOTAL_MS) {
      console.error(`Stopped: no progress since "${progress}" for ${Math.round((Date.now() - changedAt) / 1000)} s.`);
      process.exitCode = 1;
      throw new Error('evaluation stalled');
    }
    await page.waitForTimeout(2000);
  }
  const report = await page.locator('#report').inputValue();
  const { ranAt, summary } = JSON.parse(report);
  mkdirSync(join(root, 'eval/results'), { recursive: true });
  const file = join(root, 'eval/results', `capture-${ranAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(JSON.parse(report), null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Saved ${file}`);
} finally {
  await browser.close();
  await server.close();
}
