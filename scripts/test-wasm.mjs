// Runs the whole test suite on Relate's browser build (WebAssembly in a
// dedicated worker on OPFS, in headless Chromium). See test/store.mjs.
//   npm run test:wasm
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync('test').filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`);
const { status } = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit', env: { ...process.env, RELATE_ENGINE: 'wasm' },
});
process.exit(status ?? 1);
