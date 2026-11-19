// Copies Relate's browser build into public/relate/, which Vite and Hosting
// serve at /relate/ (the worker loads the engine from there).
// Runs after `npm install` (postinstall). Plain Node, so it works the same on
// Windows, macOS and Linux.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const from = `${root}node_modules/@relate/relate-wasm/`;
const to = `${root}public/relate/`;

mkdirSync(to, { recursive: true });
for (const file of ['relate.js', 'relate_bg.wasm', 'trap.js', 'snippets']) {
  cpSync(from + file, to + file, { recursive: true });
}
console.log("Copied Relate's browser build to public/relate/");
