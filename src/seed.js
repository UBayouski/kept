// Demo scenario as Cypher, shared by the browser store and the store file in
// the repository, so both are built from one source.
// Three notes: a proposal owed to Dana, blocked by pricing owed by Lee,
// with the deadline moved from Nov 20 to Nov 24.

export const seedStatements = [
  {
    statement: `
      MERGE (me:Person {name: 'Me'})
      MERGE (dana:Person {name: 'Dana'})
      MERGE (lee:Person {name: 'Lee'})
      CREATE (proposal:Commitment {id: 'c-proposal', what: 'Send proposal', status: 'open'})
      CREATE (pricing:Commitment {id: 'c-pricing', what: 'Confirm pricing', status: 'open'})
      CREATE (me)-[:OWES]->(proposal)-[:TO]->(dana)
      CREATE (lee)-[:OWES]->(pricing)-[:TO]->(me)
      CREATE (proposal)-[:BLOCKED_BY]->(pricing)
      CREATE (d1:Deadline {due: date('2026-11-20')}), (d2:Deadline {due: date('2026-11-24')})
      CREATE (proposal)-[:HAS_DEADLINE]->(d2)-[:SUPERSEDES]->(d1)
      CREATE (e1:Evidence {id: 'e-1', capturedAt: datetime('2026-11-16T09:12:00Z'),
        text: "Call with Dana: I'll send her the proposal by Nov 20."})
      CREATE (e2:Evidence {id: 'e-2', capturedAt: datetime('2026-11-17T14:40:00Z'),
        text: "Can't finish the proposal until Lee confirms pricing. Lee said he'd get back to me."})
      CREATE (e3:Evidence {id: 'e-3', capturedAt: datetime('2026-11-18T11:05:00Z'),
        text: 'Dana is fine with the proposal moving to Nov 24.'})
      CREATE (proposal)-[:EVIDENCED_BY]->(e1), (d1)-[:EVIDENCED_BY]->(e1)
      CREATE (pricing)-[:EVIDENCED_BY]->(e2)
      CREATE (d2)-[:EVIDENCED_BY]->(e3)`,
  },
];

// "What needs my attention": commitments I owe that are not done, the current
// and superseded due dates, the blocker and who it is waiting on.
// Seeded deadlines carry a date in "due"; extracted ones carry the words of
// the note in "dueText" until a date is resolved.
export const attentionQuery = `
  MATCH (:Person {name: 'Me'})-[:OWES]->(c:Commitment) WHERE c.status <> 'done'
  OPTIONAL MATCH (c)-[:HAS_DEADLINE]->(d:Deadline)
  OPTIONAL MATCH (d)-[:SUPERSEDES]->(old:Deadline)
  OPTIONAL MATCH (c)-[:BLOCKED_BY]->(b:Commitment)
  OPTIONAL MATCH (b)<-[:OWES]-(w:Person)
  RETURN c.what AS what, c.status AS status,
         coalesce(toString(d.due), d.dueText) AS due,
         coalesce(toString(old.due), old.dueText) AS previouslyDue,
         b.what AS blockedBy, w.name AS waitingOn`;
