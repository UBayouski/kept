// What the review screen shows and does, as functions over a store.
// No DOM here, so it runs against the Node binding in tests and against the
// worker in the browser. Every write goes through the rules in model.js.

import * as m from './model.js';

// The days of the demonstration scenario, relative to today: the Monday,
// Wednesday and Thursday of last week, that week's Friday, and the Monday and
// Tuesday after it. Everything the notes say has then already happened, as it
// would have in a real store: "the last meeting" exists, and what the user
// does now comes after it.
export function demoDates(today = new Date()) {
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  const monday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - sinceMonday - 7);
  const day = (offset) => new Date(monday + offset * 86400000).toISOString().slice(0, 10);
  return { monday: day(0), wednesday: day(2), thursday: day(3), friday: day(4), nextMonday: day(7), nextTuesday: day(8) };
}

// The demonstration scenario from docs/decisions.md, built through the rules:
// the Monday meeting is confirmed, the Wednesday and Thursday notes are still
// proposals. No model is involved; the notes are "read" by hand here.
// Does nothing if the store already has commitments. People already there
// (the user, made by a first capture, or Dana and Lee added by hand) are used,
// not made twice.
export async function seedDemo(q, { today = new Date() } = {}) {
  const [{ n }] = await q('MATCH (c:Commitment) RETURN count(c) AS n');
  if (n > 0) return false;
  const days = demoDates(today);
  const at = (day, time) => `${days[day]}T${time}:00Z`;
  const person = async (name, isMe = false) => {
    const [found] = await q(isMe ? 'MATCH (p:Person {isMe: true}) RETURN p.id AS id' : 'MATCH (p:Person {name: $name, isMe: false}) RETURN p.id AS id', { name });
    return found?.id ?? m.createPerson(q, { name, isMe });
  };
  const me = await person('Me', true);
  const dana = await person('Dana');
  const lee = await person('Lee');

  const monday = await m.createNote(q, {
    kind: 'meeting', text: "I'll send Dana the proposal Friday, once Lee confirms pricing.",
    occurredAt: at('monday', '17:00'), involves: [dana], now: at('monday', '17:30'),
  });
  const proposal = await m.addCommitment(q, {
    what: 'Send the proposal', ownerId: me, toId: dana, due: days.friday, dueText: 'Friday',
    quote: "I'll send Dana the proposal Friday", noteId: monday, now: at('monday', '17:30'),
  });
  const pricing = await m.addCommitment(q, {
    what: 'Confirm pricing', ownerId: lee, toId: me, quote: 'once Lee confirms pricing', noteId: monday, now: at('monday', '17:30'),
  });
  await m.accept(q, proposal.changeId, { now: at('monday', '17:35') });
  await m.accept(q, pricing.changeId, { now: at('monday', '17:35') });
  const blocked = await m.addChange(q, {
    commitmentId: proposal.commitmentId, kind: 'blocked', namesId: pricing.commitmentId,
    quote: 'once Lee confirms pricing', noteId: monday, now: at('monday', '17:30'),
  });
  await m.accept(q, blocked.changeId, { now: at('monday', '17:35') });

  const wednesday = await m.createNote(q, {
    kind: 'message', text: "Lee's pricing is delayed until Monday.",
    occurredAt: at('wednesday', '22:00'), involves: [lee], now: at('wednesday', '22:40'),
  });
  await m.addChange(q, {
    commitmentId: pricing.commitmentId, kind: 'deadline', due: days.nextMonday, dueText: 'Monday',
    quote: 'delayed until Monday', noteId: wednesday, now: at('wednesday', '22:40'),
  });
  const thursday = await m.createNote(q, {
    kind: 'meeting', text: 'Dana agreed we can send the proposal Tuesday.',
    occurredAt: at('thursday', '19:00'), involves: [dana], now: at('thursday', '19:05'),
  });
  await m.addChange(q, {
    commitmentId: proposal.commitmentId, kind: 'deadline', due: days.nextTuesday, dueText: 'Tuesday',
    quote: 'we can send the proposal Tuesday', noteId: thursday, now: at('thursday', '19:05'),
  });
  return true;
}

const date = (due, dueText) => (due && dueText ? `${dueText} (${due})` : due || dueText || 'no date');

// What accepting a proposal would do, in a sentence.
export function describe(item) {
  const c = item.commitment;
  switch (item.kind) {
    case 'created': return `New commitment: ${c.owner ?? 'someone'} owes "${c.what}"${c.to ? ` to ${c.to}` : ''}${c.due || c.dueText ? `, due ${date(c.due, c.dueText)}` : ''}.`;
    case 'deadline': return item.clear
      ? `Remove the deadline of "${c.what}" (now ${date(c.due, c.dueText)}).`
      : `Move the deadline of "${c.what}" from ${date(c.due, c.dueText)} to ${date(item.due, item.dueText)}.`;
    case 'owner': return `Make ${item.names} the owner of "${c.what}" instead of ${c.owner ?? 'nobody'}.`;
    case 'recipient': return item.clear ? `"${c.what}" is no longer owed to ${c.to ?? 'anyone'}.` : `"${c.what}" is owed to ${item.names} instead of ${c.to ?? 'nobody'}.`;
    case 'blocked': return `"${c.what}" cannot be done until "${item.names}" is.`;
    case 'unblocked': return `"${c.what}" no longer waits for "${item.names}".`;
    case 'completed': return `Mark "${c.what}" as done.`;
    case 'cancelled': return `Mark "${c.what}" as cancelled.`;
    case 'reopened': return `Reopen "${c.what}".`;
    case 'evidence': return `Another passage supporting "${c.what}".`;
    default: return `${item.kind} on "${c.what}".`;
  }
}

// Everything waiting for the user, oldest first. Each item has the proposal,
// the commitment as it stands now, the words it rests on, and whether it is
// stale (the value it was proposed against has changed) or in conflict with
// another proposal for the same value.
export async function reviewItems(q) {
  const flags = new Map((await m.reviewQueue(q)).map((row) => [row.changeId, row]));
  const rows = await q(
    `MATCH (ch:Change {state: 'proposed'})-[:ON]->(c:Commitment)
     OPTIONAL MATCH (ch)-[:FROM]->(n:Note)
     OPTIONAL MATCH (ch)-[:NAMES]->(named)
     OPTIONAL MATCH (o:Person)-[:OWES]->(c)
     OPTIONAL MATCH (c)-[:TO]->(t:Person)
     RETURN ch.id AS changeId, ch.kind AS kind, ch.clear AS clear, toString(ch.due) AS due, ch.dueText AS dueText,
            ch.quote AS quote, ch.source AS source, toString(ch.recordedAt) AS recordedAt,
            coalesce(named.name, named.what) AS names,
            c.id AS commitmentId, c.what AS what, c.status AS status, c.review AS review,
            toString(c.due) AS currentDue, c.dueText AS currentDueText, o.name AS owner, t.name AS recipient,
            n.id AS noteId, n.text AS noteText, n.kind AS noteKind, toString(n.occurredAt) AS occurredAt, n.extractedBy AS extractedBy
     ORDER BY recordedAt, changeId`,
  );
  return rows.map((r) => {
    const item = {
      changeId: r.changeId, kind: r.kind, clear: Boolean(r.clear), due: r.due, dueText: r.dueText, names: r.names,
      quote: r.quote, source: r.source,
      commitment: { id: r.commitmentId, what: r.what, status: r.status, review: r.review, due: r.currentDue, dueText: r.currentDueText, owner: r.owner, to: r.recipient },
      note: r.noteId ? { id: r.noteId, text: r.noteText, kind: r.noteKind, occurredAt: r.occurredAt, extractedBy: r.extractedBy } : null,
      stale: Boolean(flags.get(r.changeId)?.stale),
      conflicts: Boolean(flags.get(r.changeId)?.conflicts),
    };
    return { ...item, summary: describe(item) };
  });
}

// Every commitment that is not done or cancelled, with who is involved and
// how many proposals wait on it.
export function commitments(q) {
  return q(
    `MATCH (o:Person)-[:OWES]->(c:Commitment)
     OPTIONAL MATCH (c)-[:TO]->(t:Person)
     OPTIONAL MATCH (p:Change {state: 'proposed'})-[:ON]->(c) WHERE p.kind <> 'created'
     RETURN c.id AS id, c.what AS what, c.status AS status, c.review AS review, toString(c.due) AS due, c.dueText AS dueText,
            o.id AS ownerId, o.name AS owner, o.isMe AS mine, t.name AS to, count(p) AS pendingChanges
     ORDER BY status DESC, due, what, id`,
  );
}

// "What changed since": the changes the app learned after a point in time,
// each as a sentence. `since` and `baselineNoteId` come from m.meetingBaseline.
export async function changesWithCommitments(q, { since, baselineNoteId = null }) {
  const rows = await m.changesSince(q, { since, baselineNoteId });
  const said = (row) => {
    const what = `"${row.what}"`;
    switch (row.kind) {
      case 'created': return `New commitment: ${what}.`;
      case 'deadline': return row.clear ? `${what}: deadline removed.` : `${what}: deadline moved to ${date(row.due, row.dueText)}.`;
      case 'completed': return `${what}: done.`;
      case 'cancelled': return `${what}: cancelled.`;
      case 'reopened': return `${what}: reopened.`;
      case 'owner': return `${what}: owner changed.`;
      case 'recipient': return `${what}: recipient changed.`;
      case 'blocked': return `${what}: now waits for something else.`;
      case 'unblocked': return `${what}: no longer waits for something.`;
      default: return `${what}: ${row.kind}.`;
    }
  };
  return rows.map((row) => ({ ...row, summary: said(row) }));
}

export async function people(q) {
  return q('MATCH (p:Person) RETURN p.id AS id, p.name AS name, p.isMe AS isMe ORDER BY isMe DESC, name');
}

// Everyone in the workspace, with how many open commitments they owe and are
// owed, for the People line. Unconfirmed new commitments count too: they are
// on the screen already, waiting for review.
export function peopleSummary(q) {
  return q(
    `MATCH (p:Person)
     OPTIONAL MATCH (p)-[:OWES]->(o:Commitment {status: 'open'})
     WITH p, count(o) AS owes
     OPTIONAL MATCH (t:Commitment {status: 'open'})-[:TO]->(p)
     RETURN p.id AS id, p.name AS name, p.isMe AS isMe, owes, count(t) AS owed
     ORDER BY isMe DESC, name`,
  );
}

// The user says a proposal is about another commitment. That is the user's
// own decision about that commitment, so the change is applied there, keeping
// the note and the quote as its evidence and the note's time as when it
// happened, and the original proposal is rejected.
// Only the kinds that carry no reference to a third record can be moved.
const MOVABLE = ['deadline', 'completed', 'cancelled', 'reopened', 'evidence'];
export async function moveProposal(q, changeId, commitmentId, { now } = {}) {
  const [item] = (await reviewItems(q)).filter((i) => i.changeId === changeId);
  if (!item) return { outcome: 'missing' };
  if (!MOVABLE.includes(item.kind)) return { outcome: 'not-movable' };
  if (item.commitment.id === commitmentId) return { outcome: 'same-commitment' };
  const moved = await m.addChange(q, {
    commitmentId, kind: item.kind, source: 'manual', noteId: item.note?.id ?? null,
    quote: item.quote, due: item.due, dueText: item.dueText, clear: item.clear, asOfNote: true, ...(now ? { now } : {}),
  });
  await m.reject(q, changeId, now ? { now } : {});
  return { ...moved, movedFrom: item.commitment.id };
}
