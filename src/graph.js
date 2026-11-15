// Turns an extraction result into graph writes, and reads the answer back.
// The model proposes; everything it produced is stored as 'unreviewed' and
// tied to the note it came from.

import * as db from './db.js';
import { seedStatements, attentionQuery } from './seed.js';

// One statement, so a note's evidence and all its commitments land together.
const saveStatement = `
  CREATE (e:Evidence {id: $evidenceId, text: $text, capturedAt: datetime($now), extractedBy: $source})
  WITH e
  UNWIND $commitments AS item
  MERGE (owner:Person {name: item.owner})
  CREATE (c:Commitment {id: item.id, what: item.what, status: 'unreviewed'})
  CREATE (owner)-[:OWES]->(c)
  CREATE (c)-[:EVIDENCED_BY]->(e)
  FOREACH (name IN CASE WHEN item.to <> '' THEN [item.to] ELSE [] END |
    MERGE (p:Person {name: name}) CREATE (c)-[:TO]->(p))
  FOREACH (due IN CASE WHEN item.due <> '' THEN [item.due] ELSE [] END |
    CREATE (c)-[:HAS_DEADLINE]->(d:Deadline {dueText: due})-[:EVIDENCED_BY]->(e))
  FOREACH (what IN CASE WHEN item.blockedBy <> '' THEN [item.blockedBy] ELSE [] END |
    CREATE (c)-[:BLOCKED_BY]->(b:Commitment {id: item.blockerId, what: what, status: 'unreviewed'})-[:EVIDENCED_BY]->(e)
    FOREACH (name IN CASE WHEN item.waitingOn <> '' THEN [item.waitingOn] ELSE [] END |
      MERGE (w:Person {name: name}) CREATE (w)-[:OWES]->(b)-[:TO]->(owner)))
  RETURN count(c) AS saved`;

// The device model sometimes fills an empty field with a stray quote; a value
// with no letter or digit counts as empty.
const clean = (value) => (typeof value === 'string' && /[\p{L}\p{N}]/u.test(value) ? value.trim() : '');

// The note writer is one person in the graph, however the model spells them.
const person = (value) => (/^(me|i|myself)$/i.test(clean(value)) ? 'Me' : clean(value));

export function normalise(commitments) {
  return (commitments ?? [])
    .filter((item) => clean(item.what))
    .map((item) => {
      const waitingOn = person(item.waitingOn);
      return {
        id: crypto.randomUUID(),
        blockerId: crypto.randomUUID(),
        what: clean(item.what),
        owner: person(item.owner) || 'Me',
        to: person(item.to),
        due: clean(item.due),
        waitingOn,
        // A person to wait on with no stated action still blocks the commitment.
        blockedBy: clean(item.blockedBy) || (waitingOn ? `Action from ${waitingOn}` : ''),
      };
    });
}

export async function saveExtraction(note, extraction) {
  const commitments = normalise(extraction.parsed?.commitments);
  if (commitments.length === 0) return 0;
  const [{ saved }] = await db.query(saveStatement, {
    evidenceId: crypto.randomUUID(),
    text: note,
    now: new Date().toISOString(),
    source: extraction.source,
    commitments,
  });
  return saved;
}

export async function loadSeed() {
  for (const { statement, params } of seedStatements) await db.query(statement, params);
}

export const attention = () => db.query(attentionQuery);
