// Builds the inspectable store file from the demonstration scenario, through
// the same rules the app uses (src/review-data.js -> src/model.js).
// Usage: npm run seed-store   (rewrites store/kept.rl)
//
// "Today" is fixed so the file is the same on every run: Wednesday 2026-11-25,
// so the scenario's Monday to Friday is 2026-11-16 to 2026-11-20.

import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as m from '../src/model.js';
import * as r from '../src/review-data.js';

const { Database } = createRequire(import.meta.url)('@relate/relate');

const TODAY = new Date('2026-11-25T12:00:00Z');
const storeDir = fileURLToPath(new URL('../store/', import.meta.url));
const storePath = storeDir + 'kept.rl';
mkdirSync(storeDir, { recursive: true });
rmSync(storePath, { force: true, recursive: true });

const db = Database.open(storePath);
const conn = db.connect();
const q = (cypher, params) => conn.query(cypher, params ?? {}).rows;

await r.seedDemo(q, { today: TODAY });
const me = (await r.people(q)).find((p) => p.isMe).id;

console.log(`Wrote ${storePath}\n`);
console.table(q('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS nodes ORDER BY label'));
console.table(q('MATCH ()-[e]->() RETURN type(e) AS relationship, count(*) AS edges ORDER BY relationship'));
console.log('What do I owe on or before Friday 2026-11-20?');
console.table(await m.owedBefore(q, { personId: me, date: '2026-11-20' }));
console.log('Which commitments are waiting on someone else?');
console.table(await m.waitingOn(q, { personId: me }));
console.log('To review:');
console.table((await r.reviewItems(q)).map(r.describe));
db.checkpoint();
db.close?.();
