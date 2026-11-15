// Builds the inspectable store file from the shared seed data.
// Usage: npm run seed-store   (rewrites store/kept.rl)

import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedStatements, attentionQuery } from '../src/seed.js';

const { Database } = createRequire(import.meta.url)('@relate/relate');

const storeDir = fileURLToPath(new URL('../store/', import.meta.url));
const storePath = storeDir + 'kept.rl';
mkdirSync(storeDir, { recursive: true });
rmSync(storePath, { force: true });

const db = Database.open(storePath);
const conn = db.connect();
for (const { statement, params } of seedStatements) conn.query(statement, params ?? {});
db.checkpoint();

console.log(`Wrote ${storePath}`);
console.table(conn.query(attentionQuery).rows);
console.table(conn.query('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS nodes ORDER BY label').rows);
db.close?.();
