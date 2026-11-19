// Shows the graph in store/kept.rl: what it holds and what it answers.
// Usage: npm run graph            (or: npm run graph -- path/to/other.rl)
//
// Opens the store read-only through Relate's Node binding, so the file is
// never changed. To run your own Cypher: npm run query -- "MATCH (n) RETURN n LIMIT 5"

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { printRows } from './print-rows.mjs';

const { Database } = createRequire(import.meta.url)('@relate/relate');
const path = process.argv[2] ?? fileURLToPath(new URL('../store/kept.rl', import.meta.url));
if (!existsSync(path)) {
  console.error(`No store at ${path}. Build it with: npm run seed-store`);
  process.exit(1);
}
const conn = Database.open(path, { readOnly: true }).connect();
const q = (cypher) => conn.query(cypher, {}).rows;

const section = (title, cypher) => {
  console.log(`\n${title}`);
  printRows(q(cypher));
};

console.log(`Store: ${relative(process.cwd(), path) || path} (opened read-only)`);
section('Nodes', 'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS nodes ORDER BY label');
section('Relationships', 'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY type');
section('Commitments (accepted state)',
  `MATCH (o:Person)-[:OWES]->(c:Commitment) OPTIONAL MATCH (c)-[:TO]->(t:Person)
   RETURN c.what AS what, o.name AS owner, t.name AS for, coalesce(c.dueText, '') + CASE WHEN c.due IS NULL THEN '' ELSE ' (' + toString(c.due) + ')' END AS due,
          c.status AS status, c.review AS review ORDER BY what`);
section('Waiting on someone else (a quantified path over BLOCKED_BY)',
  `MATCH (c:Commitment {status: 'open'})-[:BLOCKED_BY]->+(b:Commitment) WHERE b.status <> 'done'
   MATCH (w:Person)-[:OWES]->(b)
   RETURN c.what AS what, b.what AS waits_for, w.name AS owed_by ORDER BY what`);
section('Why: each value points at the change that set it (ESTABLISHED_BY), with the words it rests on',
  `MATCH (c:Commitment)-[e:ESTABLISHED_BY]->(ch:Change)
   RETURN c.what AS commitment, CASE WHEN e.field STARTS WITH 'blocker:' THEN 'waits for' ELSE e.field END AS value,
          ch.kind AS set_by, ch.quote AS quote ORDER BY commitment, value`);
section('Waiting for review (proposals; nothing changes until accepted)',
  `MATCH (ch:Change {state: 'proposed'})-[:ON]->(c:Commitment) OPTIONAL MATCH (ch)-[:FROM]->(n:Note)
   RETURN c.what AS on, ch.kind AS change, coalesce(ch.dueText, '') AS to, ch.quote AS quote ORDER BY on`);
