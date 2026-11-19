// Runs one Cypher query against store/kept.rl, read-only.
// Usage: npm run query -- "MATCH (c:Commitment)-[:BLOCKED_BY]->(b) RETURN c.what, b.what"
//        npm run query -- "<cypher>" path/to/other.rl

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { printRows } from './print-rows.mjs';

const { Database } = createRequire(import.meta.url)('@relate/relate');
const [cypher, other] = process.argv.slice(2);
if (!cypher) {
  console.error('Usage: npm run query -- "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS nodes"');
  process.exit(2);
}
const path = other ?? fileURLToPath(new URL('../store/kept.rl', import.meta.url));
if (!existsSync(path)) {
  console.error(`No store at ${path}. Build it with: npm run seed-store`);
  process.exit(1);
}
try {
  printRows(Database.open(path, { readOnly: true }).connect().query(cypher, {}).rows);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
