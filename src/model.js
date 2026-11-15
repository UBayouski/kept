// Commitment model: accepted state on the commitment, every change as a record.
// See docs/data-model.md.
//
// Every function takes `q`, a function (cypher, params) -> rows (or a promise
// of rows), so the same rules run against the browser worker and the Node
// binding. Times are ISO strings.
//
// Two things keep a decision from being applied on top of state it did not see:
//   - write operations on the same `q` run one after another, start to finish
//   - the statement that applies a change also checks, inside the statement,
//     that the change is still proposed and that the current value is still
//     the one the decision was made against

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const first = async (q, cypher, params = {}) => (await q(cypher, params))[0];
const norm = (text) => (text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const queues = new WeakMap();
function serial(q, work) {
  const result = (queues.get(q) ?? Promise.resolve()).then(work);
  queues.set(q, result.catch(() => {}));
  return result;
}

// Which current value a change kind replaces. A dependency is tracked per
// pair of commitments, removals included. Kinds not listed replace nothing.
const FIELD = { deadline: 'due', owner: 'owner', recipient: 'to', completed: 'status', cancelled: 'status', reopened: 'status' };
const STATUS = { completed: 'done', cancelled: 'cancelled', reopened: 'open' };
const isDependency = (kind) => kind === 'blocked' || kind === 'unblocked';
const fieldOf = (kind, namesId) => (isDependency(kind) ? `blocker:${namesId}` : FIELD[kind] ?? null);

// FNV-1a. Used only to spot a note that may have been captured before; it is
// never the identity of a note.
export function textHash(text) {
  let h = 0x811c9dc5;
  for (const ch of norm(text)) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}

// True only when `a` is known to come before `b`. With a time known only to
// the day, the same day is not "before".
function isBefore(a, b) {
  if (!a?.at || !b?.at) return false;
  if (a.precision === 'day' || b.precision === 'day') return a.at.slice(0, 10) < b.at.slice(0, 10);
  return Date.parse(a.at) < Date.parse(b.at);
}

// --- People and notes ---

export async function createPerson(q, { name, isMe = false, id = uid() }) {
  await q('CREATE (:Person {id: $id, name: $name, aliases: [], isMe: $isMe})', { id, name, isMe });
  return id;
}

// Every capture is its own note, even when the text is identical to another.
// occurredAt is optional; precision 'day' means the time of day is unknown and
// occurredAt holds the start of that day.
export async function createNote(q, { kind = 'note', text, occurredAt = null, precision = 'time', involves = [],
  extractedBy = 'manual', sourceUrl = null, now = nowIso(), id = uid() }) {
  await q(
    `CREATE (n:Note {id: $id, kind: $kind, text: $text, textHash: $hash, capturedAt: datetime($now),
       occurredAt: datetime($occurredAt), occurredPrecision: $precision, extractedBy: $extractedBy, sourceUrl: $sourceUrl})`,
    { id, kind, text, hash: textHash(text), now, occurredAt, precision: occurredAt ? precision : null, extractedBy, sourceUrl },
  );
  for (const person of involves) {
    await q('MATCH (n:Note {id: $id}), (p:Person {id: $person}) CREATE (n)-[:INVOLVES]->(p)', { id, person });
  }
  return id;
}

// Notes with the same text, for a "you may have captured this already" prompt.
export function findSimilarNotes(q, text) {
  return q(
    `MATCH (n:Note {textHash: $hash})
     RETURN n.id AS id, n.kind AS kind, toString(n.capturedAt) AS capturedAt, toString(n.occurredAt) AS occurredAt`,
    { hash: textHash(text) },
  );
}

async function noteTime(q, noteId) {
  if (!noteId) return null;
  const row = await first(q, 'MATCH (n:Note {id: $noteId}) RETURN toString(n.occurredAt) AS at, n.occurredPrecision AS precision', { noteId });
  if (!row) throw new Error(`No note ${noteId}`);
  return row;
}

// --- Writing assertions ---

// A new commitment. Extracted: stored as read, unreviewed, with a proposed
// 'created' change. Manual: confirmed at once.
export const addCommitment = (q, args) => serial(q, () => addCommitmentNow(q, args));

async function addCommitmentNow(q, { what, ownerId, toId = null, due = null, dueText = null, quote = null,
  noteId = null, source = noteId ? 'extracted' : 'manual', issues = [], key = null, now = nowIso() }) {
  const time = source === 'manual' ? { at: now, precision: 'time' } : await noteTime(q, noteId);
  const manual = source === 'manual';
  const ids = { commitmentId: uid(), changeId: uid() };
  const rows = await q(
    `MATCH (owner:Person {id: $ownerId})
     OPTIONAL MATCH (n:Note {id: $noteId})
     OPTIONAL MATCH (to:Person {id: $toId})
     CREATE (c:Commitment {id: $commitmentId, what: $what, status: 'open', review: $review,
       due: date($due), dueText: $dueText, issues: $issues})
     CREATE (ch:Change {id: $changeId, kind: 'created', state: $state, applied: true, source: $source, key: $key,
       quote: $quote, due: date($due), dueText: $dueText, toId: $toId,
       recordedAt: datetime($now), decidedAt: datetime($decidedAt),
       effectiveAt: datetime($effectiveAt), effectivePrecision: $effectivePrecision})
     CREATE (owner)-[:OWES]->(c)
     CREATE (ch)-[:ON]->(c)
     CREATE (ch)-[:NAMES]->(owner)
     CREATE (c)-[:ESTABLISHED_BY {field: 'owner'}]->(ch)
     CREATE (c)-[:ESTABLISHED_BY {field: 'to'}]->(ch)
     CREATE (c)-[:ESTABLISHED_BY {field: 'due'}]->(ch)
     CREATE (c)-[:ESTABLISHED_BY {field: 'status'}]->(ch)
     FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | CREATE (ch)-[:FROM]->(x))
     FOREACH (x IN CASE WHEN to IS NULL THEN [] ELSE [to] END | CREATE (c)-[:TO]->(x))
     RETURN c.id AS id`,
    {
      ...ids, ownerId, toId, noteId, what, due, dueText, quote, issues, source, now,
      key: key ?? `${createdKey({ what, ownerId })}|0`,
      review: manual ? 'confirmed' : 'unreviewed',
      state: manual ? 'accepted' : 'proposed',
      decidedAt: manual ? now : null,
      effectiveAt: time?.at ?? null,
      effectivePrecision: time?.precision ?? null,
    },
  );
  if (rows.length !== 1) throw new Error(`Owner ${ownerId} not found`);
  return ids;
}

// A change to an existing commitment. Extracted changes stay proposed and do
// not touch the commitment. Manual changes are the user's own action and are
// applied at once; they are ordered by the time of that action.
//   kind: deadline (due, dueText, or clear) | owner (namesId = person) | recipient (namesId = person, or clear)
//         | blocked, unblocked (namesId = commitment) | completed | cancelled | reopened | evidence
export const addChange = (q, args) => serial(q, () => addChangeNow(q, args));

async function addChangeNow(q, { commitmentId, kind, noteId = null, source = noteId ? 'extracted' : 'manual',
  quote = null, due = null, dueText = null, namesId = null, clear = false, key = null, now = nowIso() }) {
  // clear: the change removes the value. Only a deadline or a recipient can be cleared.
  if (clear && kind !== 'deadline' && kind !== 'recipient') throw new Error(`A ${kind} change cannot clear a value`);
  if ((kind === 'owner' || isDependency(kind) || (kind === 'recipient' && !clear)) && !namesId) {
    throw new Error(`A ${kind} change has to name who or what it refers to`);
  }
  if (clear) { due = null; dueText = null; namesId = null; }
  const field = fieldOf(kind, namesId);
  const time = source === 'manual' ? { at: now, precision: 'time' } : await noteTime(q, noteId);
  const changeId = uid();
  const rows = await q(
    `MATCH (c:Commitment {id: $commitmentId})
     OPTIONAL MATCH (c)-[:ESTABLISHED_BY {field: $field}]->(cur:Change)
     OPTIONAL MATCH (n:Note {id: $noteId})
     OPTIONAL MATCH (named {id: $namesId}) WHERE named:Person OR named:Commitment
     WITH c, cur, n, named WHERE $namesId IS NULL OR named IS NOT NULL
     CREATE (ch:Change {id: $changeId, kind: $kind, field: $field, state: 'proposed', applied: false, source: $source,
       key: $key, quote: $quote, due: date($due), dueText: $dueText, clear: $clear, basedOn: cur.id,
       recordedAt: datetime($now), effectiveAt: datetime($effectiveAt), effectivePrecision: $effectivePrecision})
     CREATE (ch)-[:ON]->(c)
     FOREACH (x IN CASE WHEN n IS NULL THEN [] ELSE [n] END | CREATE (ch)-[:FROM]->(x))
     FOREACH (x IN CASE WHEN named IS NULL THEN [] ELSE [named] END | CREATE (ch)-[:NAMES]->(x))
     RETURN ch.id AS id`,
    {
      commitmentId, changeId, kind, field, noteId, namesId, source, quote, due, dueText, clear, now,
      key: key ?? changeKey({ kind, commitmentId, due, dueText, namesId, quote }),
      effectiveAt: time?.at ?? null,
      effectivePrecision: time?.precision ?? null,
    },
  );
  if (rows.length !== 1) throw new Error(`Commitment ${commitmentId} or what the change names was not found`);
  if (source !== 'manual') return { changeId, outcome: 'proposed' };
  return { changeId, ...(await acceptNow(q, changeId, { now })) };
}

// What makes two assertions from the same note "the same assertion". The key
// names the thing asserted; values that can be corrected on a later reading
// (a new commitment's deadline and recipient) are compared separately.
// A new commitment's key is its wording and owner plus a number, because one
// reading can hold several commitments with the same wording and owner.
const createdKey = ({ what, ownerId }) => `created|${norm(what)}|${ownerId}`;
function changeKey({ kind, commitmentId, due, dueText, namesId, quote }) {
  if (kind === 'deadline') return `deadline|${commitmentId}|${due ?? (norm(dueText) || 'none')}`;
  if (kind === 'owner' || kind === 'recipient' || isDependency(kind)) return `${kind}|${commitmentId}|${namesId ?? 'none'}`;
  if (kind === 'evidence') return `evidence|${commitmentId}|${norm(quote)}`;
  return `${kind}|${commitmentId}`;
}

// --- Review ---

// Accept a proposed change. Outcomes:
//   applied  - the commitment now carries the change, and points at it as the source of that value
//   recorded - accepted as true, with no current value to replace (evidence), or older than the
//              current value (a backdated note) and kept as history only
//   stale    - the value it was proposed against has since been replaced; nothing changed.
//              Call again with confirmStale once the user has seen the current value
//   cycle    - the dependency would loop; nothing changed
//   not-proposed, missing, busy - nothing changed
// replaceCurrent applies a backdated change over a newer current value.
export const accept = (q, changeId, options) => serial(q, () => acceptNow(q, changeId, options));

async function acceptNow(q, changeId, { now = nowIso(), confirmStale = false, replaceCurrent = false } = {}) {
  // The write checks what the decision was based on. If that moved between the
  // read and the write, nothing is written and the decision is made again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const ch = await first(
      q,
      `MATCH (ch:Change {id: $changeId})
       OPTIONAL MATCH (ch)-[:ON]->(c:Commitment)
       OPTIONAL MATCH (c)-[:ESTABLISHED_BY {field: ch.field}]->(cur:Change)
       OPTIONAL MATCH (ch)-[:NAMES]->(named)
       RETURN ch.kind AS kind, ch.state AS state, ch.field AS field, ch.basedOn AS basedOn, ch.clear AS clear,
              toString(ch.effectiveAt) AS at, ch.effectivePrecision AS precision,
              c.id AS commitmentId, named.id AS namesId,
              cur.id AS currentId, toString(cur.effectiveAt) AS currentAt, cur.effectivePrecision AS currentPrecision`,
      { changeId },
    );
    if (!ch || !ch.commitmentId) return { outcome: 'missing' };
    if (ch.state !== 'proposed') return { outcome: 'not-proposed' };
    const params = { changeId, now };
    const proposed = "MATCH (ch:Change {id: $changeId, state: 'proposed'})";

    if (ch.kind === 'created') {
      const done = await q(`${proposed}-[:ON]->(c:Commitment)
        SET c.review = 'confirmed', ch.state = 'accepted', ch.decidedAt = datetime($now) RETURN ch.id AS id`, params);
      if (done.length) return { outcome: 'applied' };
      continue;
    }
    if (ch.kind === 'evidence') {
      const done = await q(`${proposed}
        SET ch.state = 'accepted', ch.applied = false, ch.decidedAt = datetime($now) RETURN ch.id AS id`, params);
      if (done.length) return { outcome: 'recorded' };
      continue;
    }

    // Kinds that replace one current value: deadline, owner, recipient, status, one dependency.
    const named = isDependency(ch.kind) || ch.kind === 'owner' || (ch.kind === 'recipient' && !ch.clear);
    if (named && !ch.namesId) return { outcome: 'missing' };
    const expected = ch.currentId ?? '';
    if (expected !== (ch.basedOn ?? '') && !confirmStale) return { outcome: 'stale', currentChangeId: ch.currentId };

    const guard = `${proposed}-[:ON]->(c:Commitment)
      OPTIONAL MATCH (c)-[old:ESTABLISHED_BY {field: $field}]->(cur:Change)
      WITH ch, c, old, cur WHERE coalesce(cur.id, '') = $expected`;
    const p = { ...params, field: ch.field, expected };

    const backdated = isBefore({ at: ch.at, precision: ch.precision }, { at: ch.currentAt, precision: ch.currentPrecision });
    if (backdated && !replaceCurrent) {
      const done = await q(`${guard}
        SET ch.state = 'accepted', ch.applied = false, ch.decidedAt = datetime($now) RETURN ch.id AS id`, p);
      if (done.length) return { outcome: 'recorded', reason: 'older than the current value' };
      continue;
    }

    if (ch.kind === 'blocked') {
      const { loops } = await first(
        q,
        `MATCH (c:Commitment {id: $commitmentId}), (b:Commitment {id: $namesId})
         RETURN c.id = b.id OR EXISTS { (b)-[:BLOCKED_BY]->+(c) } AS loops`,
        ch,
      );
      if (loops) return { outcome: 'cycle' };
    }

    const establish = `CREATE (c)-[:ESTABLISHED_BY {field: $field}]->(ch)
      SET ch.state = 'accepted', ch.applied = true, ch.decidedAt = datetime($now)
      RETURN ch.id AS id`;
    const apply = {
      deadline: `DELETE old SET c.due = ch.due, c.dueText = ch.dueText`,
      owner: `MATCH (ch)-[:NAMES]->(p:Person)
              OPTIONAL MATCH (:Person)-[o:OWES]->(c)
              DELETE old, o
              CREATE (p)-[:OWES]->(c)`,
      recipient: ch.clear
        ? `OPTIONAL MATCH (c)-[t:TO]->(:Person)
              DELETE old, t`
        : `MATCH (ch)-[:NAMES]->(p:Person)
              OPTIONAL MATCH (c)-[t:TO]->(:Person)
              DELETE old, t
              CREATE (c)-[:TO]->(p)`,
      blocked: `MATCH (ch)-[:NAMES]->(b:Commitment)
              WHERE b.id <> c.id AND NOT EXISTS { (b)-[:BLOCKED_BY]->+(c) }
              DELETE old
              MERGE (c)-[r:BLOCKED_BY]->(b)
              SET r.setBy = ch.id`,
      unblocked: `MATCH (ch)-[:NAMES]->(b:Commitment)
              OPTIONAL MATCH (c)-[r:BLOCKED_BY]->(b)
              DELETE old, r`,
    }[ch.kind] ?? `DELETE old SET c.status = $status`;
    const done = await q(`${guard} ${apply} ${establish}`, { ...p, status: STATUS[ch.kind] ?? null });
    if (done.length) return { outcome: 'applied' };
  }
  return { outcome: 'busy' };
}

// What removing a never-confirmed commitment would take with it: decisions the
// user already made on it, and other commitments that depend on it.
async function removalConsequences(q, commitmentId) {
  const decisions = await q(
    `MATCH (ch:Change {state: 'accepted'})-[:ON]->(:Commitment {id: $commitmentId}) WHERE ch.kind <> 'created'
     RETURN ch.id AS changeId, ch.kind AS kind, ch.source AS source ORDER BY changeId`,
    { commitmentId },
  );
  const dependents = await q(
    `MATCH (a:Commitment)-[:BLOCKED_BY]->(:Commitment {id: $commitmentId})
     RETURN a.id AS id, a.what AS what ORDER BY id`,
    { commitmentId },
  );
  return { decisions, dependents, any: decisions.length + dependents.length > 0 };
}

// Reject a proposed change. It is kept as rejected, so the same assertion from
// the same note is not proposed again.
//
// Rejecting a 'created' change removes the commitment, which was never
// confirmed. If the user has already made decisions on it, or another
// commitment depends on it, nothing is removed and the outcome is
// 'needs-confirmation' with those consequences listed. Called again with
// confirmConsequences, each dependent gets an 'unblocked' change in its own
// history saying why, and the commitment and the decisions on it are removed.
// That path is several statements and is not atomic.
export const reject = (q, changeId, options) => serial(q, () => rejectNow(q, changeId, options));

async function rejectNow(q, changeId, { now = nowIso(), confirmConsequences = false } = {}) {
  const ch = await first(
    q,
    `MATCH (ch:Change {id: $changeId}) OPTIONAL MATCH (ch)-[:ON]->(c:Commitment)
     RETURN ch.kind AS kind, ch.state AS state, c.id AS commitmentId, c.what AS what`,
    { changeId },
  );
  if (!ch) return { outcome: 'missing' };
  if (ch.state !== 'proposed') return { outcome: 'not-proposed' };
  if (ch.kind !== 'created') {
    const done = await q(
      `MATCH (ch:Change {id: $changeId, state: 'proposed'})
       SET ch.state = 'rejected', ch.decidedAt = datetime($now) RETURN ch.id AS id`,
      { changeId, now },
    );
    return { outcome: done.length ? 'rejected' : 'not-proposed' };
  }

  const consequences = await removalConsequences(q, ch.commitmentId);
  if (consequences.any && !confirmConsequences) {
    return { outcome: 'needs-confirmation', decisions: consequences.decisions, dependents: consequences.dependents };
  }
  for (const dependent of consequences.dependents) {
    await q(
      `MATCH (a:Commitment {id: $dependentId})-[r:BLOCKED_BY]->(:Commitment {id: $commitmentId})
       OPTIONAL MATCH (a)-[old:ESTABLISHED_BY {field: $field}]->(:Change)
       DELETE r, old
       CREATE (u:Change {id: $id, kind: 'unblocked', field: $field, state: 'accepted', applied: true, source: 'manual',
         reason: 'blocker rejected', namedWhat: $what, recordedAt: datetime($now), decidedAt: datetime($now),
         effectiveAt: datetime($now), effectivePrecision: 'time'})
       CREATE (u)-[:ON]->(a)
       CREATE (a)-[:ESTABLISHED_BY {field: $field}]->(u)`,
      { dependentId: dependent.id, commitmentId: ch.commitmentId, field: `blocker:${ch.commitmentId}`, id: uid(), what: ch.what, now },
    );
  }
  await q(
    `MATCH (:Change {id: $changeId})-[:ON]->(c:Commitment)
     OPTIONAL MATCH (decided:Change {state: 'accepted'})-[:ON]->(c)
     DETACH DELETE decided`,
    { changeId },
  );
  await q(
    `MATCH (ch:Change {id: $changeId})-[:ON]->(c:Commitment)
     OPTIONAL MATCH (other:Change {state: 'proposed'})-[:ON|NAMES]->(c)
     SET other.state = 'rejected', other.decidedAt = datetime($now)
     WITH DISTINCT c
     DETACH DELETE c`,
    { changeId, now },
  );
  return { outcome: 'rejected', removedCommitment: true, decisions: consequences.decisions, dependents: consequences.dependents };
}

// Remove a proposal as if it had never been made (used when a note is read
// again). A new commitment that the user has already acted on, or that another
// commitment depends on, is never removed this way; returns false then.
async function withdraw(q, change) {
  if (change.kind === 'created' && change.commitmentId) {
    if ((await removalConsequences(q, change.commitmentId)).any) return false;
    await q(
      `MATCH (ch:Change {id: $id, state: 'proposed'})-[:ON]->(c:Commitment)
       OPTIONAL MATCH (other:Change {state: 'proposed'})-[:ON|NAMES]->(c) WHERE other.id <> ch.id
       DETACH DELETE other
       WITH DISTINCT c
       DETACH DELETE c`,
      change,
    );
  }
  await q("MATCH (ch:Change {id: $id, state: 'proposed'}) DETACH DELETE ch", change);
  return true;
}

// Store what a model read from one note. Safe to run again for the same note.
//
// Assertions are new commitments
//   { kind: 'created', ref, what, ownerId, toId, due, dueText, quote }
// or changes to commitments
//   { kind, commitmentId | commitmentRef, namesId | namesRef, due, dueText, quote, clear }
// Every commitment an assertion refers to, as its subject or as a blocker, has
// to be either in candidateIds (the list the model was given) or a new
// commitment of this same reading, named by its `ref`. Anything else is refused.
// People are checked too, so a bad id cannot fail halfway through.
//
//   added     - a new proposal
//   skipped   - the same assertion was already made from this note, whatever was
//               decided about it; decisions stand and nothing is proposed twice
//   refreshed - the note was read differently and nobody has acted on the earlier
//               proposal, so the proposal now carries the new reading
//   corrected - the note was read differently and the user has already decided
//               on the earlier reading: the difference is proposed as a change,
//               including the removal of a deadline or recipient
//   withdrawn - a proposal the new reading no longer makes. Nothing is withdrawn
//               when the reading had an invalid assertion, or when the caller
//               passes complete: false because the assertions are only part of
//               what the note says
//   kept      - a proposal the new reading no longer makes, left in place, with
//               the reason: the user acted on it or something depends on it, or
//               the reading had invalid assertions
//   invalid   - refers to something it may not; each entry says why
export const recordExtraction = (q, noteId, assertions, options) =>
  serial(q, () => recordExtractionNow(q, noteId, assertions, options));

// The deadline a reading asserts: the resolved date, else the words, else none.
const sameDeadline = (a, b) => (a.due ?? null) === (b.due ?? null)
  && ((a.due ?? null) !== null || norm(a.dueText) === norm(b.dueText));

async function recordExtractionNow(q, noteId, assertions, { candidateIds = [], complete = true, now = nowIso() } = {}) {
  const existing = await q(
    `MATCH (ch:Change)-[:FROM]->(:Note {id: $noteId})
     OPTIONAL MATCH (ch)-[:ON]->(c:Commitment)
     RETURN ch.id AS id, ch.key AS key, ch.state AS state, ch.kind AS kind, c.id AS commitmentId,
            toString(ch.due) AS due, ch.dueText AS dueText, ch.quote AS quote, ch.toId AS toId`,
    { noteId },
  );
  const known = new Map(existing.map((row) => [row.key, row]));
  const allowed = new Set(candidateIds);
  const result = { added: [], skipped: [], refreshed: [], corrected: [], withdrawn: [], kept: [], invalid: [] };
  const seen = new Set();
  const refuse = (item, reason) => result.invalid.push({ ...item, reason });

  const personIds = [...new Set(assertions.flatMap((item) => (item.kind === 'created'
    ? [item.ownerId, item.toId]
    : item.kind === 'owner' || item.kind === 'recipient' ? [item.namesId] : [])).filter(Boolean))];
  const people = new Set((await q('MATCH (p:Person) WHERE p.id IN $personIds RETURN p.id AS id', { personIds })).map((r) => r.id));

  const propose = async (item, key, list) => {
    const made = item.kind === 'created'
      ? await addCommitmentNow(q, { ...item, noteId, source: 'extracted', key, now })
      : await addChangeNow(q, { ...item, noteId, source: 'extracted', key, now });
    const row = { id: made.changeId, key, state: 'proposed', kind: item.kind, commitmentId: made.commitmentId ?? item.commitmentId,
      due: item.due ?? null, dueText: item.dueText ?? null, quote: item.quote ?? null, toId: item.toId ?? null };
    known.set(key, row);
    list.push({ key, ...made });
    return row;
  };

  // New commitments first, so that changes in the same reading can refer to them.
  // Each one in a reading is its own commitment, even when two share wording
  // and owner. Across readings of the note they are matched within the same
  // wording and owner: first to an earlier one with the same recipient and
  // deadline, then to the closest remaining one (recipient counts for more
  // than deadline), in reading order. One left over is new.
  const refs = new Map();
  const groups = new Map();
  for (const item of assertions.filter((a) => a.kind === 'created')) {
    if (!item.what || !people.has(item.ownerId)) { refuse(item, 'unknown owner'); continue; }
    if (item.toId && !people.has(item.toId)) { refuse(item, 'unknown recipient'); continue; }
    if (item.ref) {
      if (refs.has(item.ref)) { refuse(item, 'duplicate ref'); continue; }
      refs.set(item.ref, null);
    }
    const base = createdKey(item);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(item);
  }
  const baseOf = (key) => key.slice(0, key.lastIndexOf('|'));
  const closeness = (item, prior) => ((item.toId ?? null) === (prior.toId ?? null) ? 2 : 0) + (sameDeadline(item, prior) ? 1 : 0);
  for (const [base, items] of groups) {
    const priors = existing.filter((row) => row.kind === 'created' && baseOf(row.key) === base);
    const free = new Set(priors);
    const matched = new Map();
    for (const wanted of [3, 2, 1, 0]) {
      for (const item of items) {
        if (matched.has(item)) continue;
        const prior = [...free].find((candidate) => closeness(item, candidate) === wanted);
        if (prior) {
          matched.set(item, prior);
          free.delete(prior);
        }
      }
    }
    const taken = new Set(priors.map((row) => row.key));
    for (const item of items) {
      let prior = matched.get(item);
      if (prior) {
        seen.add(prior.key);
        await readAgain(item, prior.key, prior);
      } else {
        let n = 0;
        while (taken.has(`${base}|${n}`)) n++;
        const key = `${base}|${n}`;
        taken.add(key);
        seen.add(key);
        prior = await propose(item, key, result.added);
      }
      if (item.ref) refs.set(item.ref, prior.state === 'rejected' ? null : prior.commitmentId);
    }
  }

  // The same new commitment, read again. Its deadline and recipient may differ.
  async function readAgain(item, key, prior) {
    const due = item.due ?? null;
    const toId = item.toId ?? null;
    const dueDiffers = !sameDeadline(item, prior);
    const toDiffers = toId !== (prior.toId ?? null);
    if (prior.state === 'rejected' || !prior.commitmentId || (!dueDiffers && !toDiffers)) {
      result.skipped.push({ key, state: prior.state });
      return;
    }
    const untouched = prior.state === 'proposed' && !(await removalConsequences(q, prior.commitmentId)).decisions.length;
    if (untouched) {
      await q(
        `MATCH (ch:Change {id: $id, state: 'proposed'})-[:ON]->(c:Commitment)
         OPTIONAL MATCH (c)-[t:TO]->(:Person)
         OPTIONAL MATCH (to:Person {id: $toId})
         DELETE t
         SET c.due = date($due), c.dueText = $dueText,
             ch.due = date($due), ch.dueText = $dueText, ch.toId = $toId, ch.quote = $quote
         FOREACH (x IN CASE WHEN to IS NULL THEN [] ELSE [to] END | CREATE (c)-[:TO]->(x))`,
        { id: prior.id, due, dueText: item.dueText ?? null, toId, quote: item.quote ?? prior.quote },
      );
      Object.assign(prior, { due, toId, dueText: item.dueText ?? null });
      result.refreshed.push({ key, changeId: prior.id, commitmentId: prior.commitmentId });
      return;
    }
    // The user has decided on the earlier reading: propose the difference,
    // which may be that there is no deadline or no recipient after all.
    const base = { commitmentId: prior.commitmentId, quote: item.quote ?? null };
    const corrections = [];
    if (dueDiffers) {
      corrections.push(due || item.dueText
        ? { ...base, kind: 'deadline', due, dueText: item.dueText ?? null }
        : { ...base, kind: 'deadline', clear: true });
    }
    if (toDiffers) {
      corrections.push(toId ? { ...base, kind: 'recipient', namesId: toId } : { ...base, kind: 'recipient', clear: true });
    }
    for (const correction of corrections) {
      const correctionKey = changeKey(correction);
      seen.add(correctionKey);
      if (known.has(correctionKey)) result.skipped.push({ key: correctionKey, state: known.get(correctionKey).state });
      else await propose(correction, correctionKey, result.corrected);
    }
  }

  // A commitment an assertion points at: by ref to a new one of this reading,
  // or by id from the candidate list. Returns the id, or a reason it is refused.
  const resolve = (id, ref, what) => {
    if (ref !== undefined && ref !== null) {
      if (!refs.has(ref)) return { reason: `unknown ${what} ref` };
      return refs.get(ref) ? { id: refs.get(ref) } : { reason: `${what} was rejected` };
    }
    return allowed.has(id) ? { id } : { reason: `unknown ${what}` };
  };

  for (const original of assertions.filter((a) => a.kind !== 'created')) {
    const subject = resolve(original.commitmentId, original.commitmentRef, 'commitment');
    if (subject.reason) { refuse(original, subject.reason); continue; }
    const item = { ...original, commitmentId: subject.id };
    if (isDependency(item.kind)) {
      const blocker = resolve(original.namesId, original.namesRef, 'blocker');
      if (blocker.reason) { refuse(original, blocker.reason); continue; }
      item.namesId = blocker.id;
    } else if (item.kind === 'owner' || (item.kind === 'recipient' && !item.clear)) {
      if (!people.has(item.namesId)) { refuse(original, 'unknown person'); continue; }
    }
    const key = changeKey(item);
    seen.add(key);
    const prior = known.get(key);
    if (!prior) {
      await propose(item, key, result.added);
      continue;
    }
    // Same assertion. An undecided proposal takes the wording of the new reading.
    const reworded = (item.quote ?? null) !== prior.quote || (item.dueText ?? null) !== prior.dueText;
    if (prior.state === 'proposed' && reworded) {
      await q("MATCH (ch:Change {id: $id, state: 'proposed'}) SET ch.quote = $quote, ch.dueText = $dueText",
        { id: prior.id, quote: item.quote ?? null, dueText: item.dueText ?? null });
      result.refreshed.push({ key, changeId: prior.id });
    } else {
      result.skipped.push({ key, state: prior.state });
    }
  }

  // Leaving something out withdraws it only when the assertions are known to
  // be the whole reading. They are not when the caller says so (`complete:
  // false`: part of the answer was refused upstream, or is waiting on the
  // user), or when an assertion was refused here: the reading may have meant
  // an earlier proposal and got a reference wrong.
  const incomplete = !complete || result.invalid.length > 0;
  const whyKept = result.invalid.length > 0 ? 'the reading had invalid assertions' : 'the reading was incomplete';
  for (const row of existing) {
    if (row.state !== 'proposed' || seen.has(row.key)) continue;
    const kept = { key: row.key, commitmentId: row.commitmentId };
    if (incomplete) result.kept.push({ ...kept, reason: whyKept });
    else if (await withdraw(q, row)) result.withdrawn.push(row.key);
    else result.kept.push({ ...kept, reason: 'acted on or depended on' });
  }
  return result;
}

// --- Questions ---

// 1. What a person owes on or before a date. Commitments with no resolved date are included.
export function owedBefore(q, { personId, date }) {
  return q(
    `MATCH (:Person {id: $personId})-[:OWES]->(c:Commitment {status: 'open'})
     WHERE c.due <= date($date) OR c.due IS NULL
     OPTIONAL MATCH (p:Change {state: 'proposed'})-[:ON]->(c) WHERE p.kind <> 'created'
     RETURN c.id AS id, c.what AS what, toString(c.due) AS due, c.dueText AS dueText, c.review AS review,
            count(p) AS pendingChanges
     ORDER BY due, id`,
    { personId, date },
  );
}

// 2. Open commitments of a person that wait on someone else. A chain is
// followed only through blockers that are still open: a done blocker no longer
// blocks, and a cancelled one is reported itself, not what lay behind it.
export function waitingOn(q, { personId }) {
  return q(
    `MATCH (:Person {id: $personId})-[:OWES]->(c:Commitment {status: 'open'})
     MATCH path = (c)-[:BLOCKED_BY]->+(b:Commitment)
     WHERE b.status <> 'done' AND all(step IN nodes(path)[1..-1] WHERE step.status = 'open')
     MATCH (w:Person)-[:OWES]->(b) WHERE w.id <> $personId
     RETURN DISTINCT c.id AS id, c.what AS what, c.review AS review,
            b.id AS blockerId, b.what AS blockedBy, b.status AS blockerStatus, b.review AS blockerReview,
            toString(b.due) AS blockerDue, w.id AS waitingOnId, w.name AS waitingOn
     ORDER BY id, blockerId`,
    { personId },
  );
}

// 3a. The meeting to measure "since" from: the latest one with this person that
// had happened by `now`, or the one before it. When only its day is known the
// boundary is the start of that day and boundaryUncertain is true: the answer
// then includes everything learned that day, and the UI must say so.
export async function meetingBaseline(q, { personId, now = nowIso(), previous = false }) {
  const row = await first(
    q,
    `MATCH (n:Note {kind: 'meeting'})-[:INVOLVES]->(:Person {id: $personId})
     WHERE n.occurredAt <= datetime($now)
     WITH n ORDER BY n.occurredAt DESC SKIP $skip LIMIT 1
     RETURN n.id AS noteId, toString(n.occurredAt) AS since, n.occurredPrecision AS precision`,
    { personId, now, skip: previous ? 1 : 0 },
  );
  return row ? { ...row, boundaryUncertain: row.precision === 'day' } : null;
}

// 3b. What the app learned after a point in time, leaving out the baseline
// note's own content. "learned" is when the app recorded it; "happened" is the
// source time, which may be missing. Supporting evidence is not a change.
export function changesSince(q, { since, baselineNoteId = null }) {
  return q(
    `MATCH (ch:Change)-[:ON]->(c:Commitment)
     WHERE ch.recordedAt > datetime($since) AND ch.state <> 'rejected' AND ch.kind <> 'evidence'
     OPTIONAL MATCH (ch)-[:FROM]->(n:Note)
     WITH ch, c, n WHERE n IS NULL OR $baselineNoteId IS NULL OR n.id <> $baselineNoteId
     RETURN ch.id AS changeId, c.id AS id, c.what AS what, ch.kind AS kind, ch.state AS state, ch.applied AS applied,
            ch.source AS source, toString(ch.due) AS due, ch.dueText AS dueText, ch.clear AS clear, ch.quote AS quote, n.id AS noteId,
            toString(ch.recordedAt) AS learned, toString(ch.effectiveAt) AS happened, ch.effectivePrecision AS happenedPrecision
     ORDER BY learned, changeId`,
    { since, baselineNoteId },
  );
}

// 4. Why a commitment is this person's: the change that established the
// current owner, and separately any ownership proposals still waiting.
export async function whyOwner(q, { commitmentId }) {
  const current = await first(
    q,
    `MATCH (p:Person)-[:OWES]->(c:Commitment {id: $commitmentId})-[:ESTABLISHED_BY {field: 'owner'}]->(ch:Change)
     OPTIONAL MATCH (ch)-[:FROM]->(n:Note)
     RETURN c.id AS id, p.id AS ownerId, p.name AS owner, ch.id AS changeId, ch.kind AS basis, ch.source AS source,
            ch.state AS state, ch.quote AS quote, n.id AS noteId, n.text AS note, toString(n.occurredAt) AS said`,
    { commitmentId },
  );
  const pending = await q(
    `MATCH (ch:Change {state: 'proposed', kind: 'owner'})-[:ON]->(:Commitment {id: $commitmentId})
     MATCH (ch)-[:NAMES]->(p:Person)
     OPTIONAL MATCH (ch)-[:FROM]->(n:Note)
     RETURN ch.id AS changeId, p.id AS proposedOwnerId, p.name AS proposedOwner, ch.quote AS quote, n.id AS noteId
     ORDER BY changeId`,
    { commitmentId },
  );
  return { current: current ?? null, pending };
}

// Everything waiting for the user. stale: the value it was proposed against has
// been replaced since. conflicts: another proposal wants the same value.
export function reviewQueue(q) {
  return q(
    `MATCH (ch:Change {state: 'proposed'})-[:ON]->(c:Commitment)
     OPTIONAL MATCH (c)-[:ESTABLISHED_BY {field: ch.field}]->(cur:Change)
     OPTIONAL MATCH (other:Change {state: 'proposed'})-[:ON]->(c) WHERE other.id <> ch.id AND other.field = ch.field
     RETURN ch.id AS changeId, c.id AS id, c.what AS what, ch.kind AS kind, toString(ch.due) AS due, ch.dueText AS dueText,
            ch.clear AS clear, ch.quote AS quote,
            ch.kind <> 'created' AND ch.field IS NOT NULL AND coalesce(cur.id, '') <> coalesce(ch.basedOn, '') AS stale,
            count(other) > 0 AS conflicts
     ORDER BY id, changeId`,
  );
}

// The changes a commitment has had, with the ones that set a current value marked.
export function history(q, { commitmentId }) {
  return q(
    `MATCH (ch:Change)-[:ON]->(c:Commitment {id: $commitmentId})
     OPTIONAL MATCH (c)-[e:ESTABLISHED_BY]->(ch)
     RETURN ch.id AS changeId, ch.kind AS kind, ch.state AS state, ch.applied AS applied, ch.source AS source,
            ch.reason AS reason, toString(ch.due) AS due, toString(ch.recordedAt) AS learned,
            toString(ch.effectiveAt) AS happened, collect(e.field) AS currentFor
     ORDER BY learned, changeId`,
    { commitmentId },
  );
}
