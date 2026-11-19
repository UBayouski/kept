// Accepted-state rules, run against the Relate Node binding.
// Usage: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as m from '../src/model.js';
import { openStore } from './store.mjs';


const open = () => openStore('kept-model');

const at = (day, time = '09:00') => `2026-11-${day}T${time}:00Z`;

// Me owes "Send the proposal" to Dana, due Fri Nov 20, confirmed; blocked by
// Lee's "Confirm pricing". From a Monday Nov 16 meeting with Dana.
async function scenario() {
  const q = open();
  const me = await m.createPerson(q, { name: 'Me', isMe: true });
  const dana = await m.createPerson(q, { name: 'Dana' });
  const lee = await m.createPerson(q, { name: 'Lee' });
  const monday = await m.createNote(q, {
    kind: 'meeting', text: "I'll send Dana the proposal Friday, once Lee confirms pricing.",
    occurredAt: at(16), involves: [dana], now: at(16, '09:30'),
  });
  const proposal = await m.addCommitment(q, {
    what: 'Send the proposal', ownerId: me, toId: dana, due: '2026-11-20', dueText: 'Friday',
    quote: "I'll send Dana the proposal Friday", noteId: monday, now: at(16, '09:30'),
  });
  const pricing = await m.addCommitment(q, {
    what: 'Confirm pricing', ownerId: lee, toId: me, quote: 'once Lee confirms pricing', noteId: monday, now: at(16, '09:30'),
  });
  await m.accept(q, proposal.changeId, { now: at(16, '09:31') });
  await m.accept(q, pricing.changeId, { now: at(16, '09:31') });
  const blocked = await m.addChange(q, {
    commitmentId: proposal.commitmentId, kind: 'blocked', namesId: pricing.commitmentId,
    quote: 'once Lee confirms pricing', noteId: monday, now: at(16, '09:30'),
  });
  await m.accept(q, blocked.changeId, { now: at(16, '09:31') });
  return { q, me, dana, lee, monday, proposal: proposal.commitmentId, proposalCreated: proposal.changeId, pricing: pricing.commitmentId };
}

const friday = (s) => m.owedBefore(s.q, { personId: s.me, date: '2026-11-20' });
const state = async (q, id) => (await q(
  `MATCH (c:Commitment {id: $id}) OPTIONAL MATCH (p:Person)-[:OWES]->(c)
   RETURN c.status AS status, toString(c.due) AS due, c.review AS review, p.name AS owner`, { id }))[0];

test('an unreviewed deadline does not replace a confirmed one', async () => {
  const s = await scenario();
  const thursday = await m.createNote(s.q, { kind: 'meeting', text: 'Dana agreed we can send the proposal Tuesday.', occurredAt: at(19), involves: [s.dana], now: at(19, '11:05') });
  const change = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-24', dueText: 'Tuesday', quote: 'send the proposal Tuesday', noteId: thursday, now: at(19, '11:05') });
  assert.equal(change.outcome, 'proposed');

  let rows = await friday(s);
  assert.deepEqual(rows.map((r) => [r.id, r.due, r.pendingChanges]), [[s.proposal, '2026-11-20', 1]]);

  assert.equal((await m.accept(s.q, change.changeId, { now: at(19, '12:00') })).outcome, 'applied');
  rows = await friday(s);
  assert.deepEqual(rows, []);
  assert.equal((await state(s.q, s.proposal)).due, '2026-11-24');
});

test('an unreviewed "done" does not hide a commitment, and a rejected one changes nothing', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { kind: 'message', text: 'Proposal went out.', occurredAt: at(18), now: at(18) });
  const done = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'completed', quote: 'Proposal went out', noteId: note, now: at(18) });
  assert.equal((await friday(s)).length, 1);
  assert.equal((await m.reject(s.q, done.changeId)).outcome, 'rejected');
  assert.deepEqual(await state(s.q, s.proposal), { status: 'open', due: '2026-11-20', review: 'confirmed', owner: 'Me' });
  assert.equal((await friday(s))[0].pendingChanges, 0);
  assert.equal((await m.accept(s.q, done.changeId)).outcome, 'not-proposed');
});

test('"why is this mine" uses the change that set the owner, not a pending proposal', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { kind: 'message', text: 'Lee will send the proposal instead.', occurredAt: at(18), now: at(18) });
  const toLee = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'owner', namesId: s.lee, quote: 'Lee will send the proposal instead', noteId: note, now: at(18) });

  let why = await m.whyOwner(s.q, { commitmentId: s.proposal });
  assert.equal(why.current.owner, 'Me');
  assert.equal(why.current.quote, "I'll send Dana the proposal Friday");
  assert.equal(why.current.changeId, s.proposalCreated);
  assert.deepEqual(why.pending.map((p) => [p.proposedOwner, p.quote]), [['Lee', 'Lee will send the proposal instead']]);

  assert.equal((await m.accept(s.q, toLee.changeId, { now: at(18, '10:00') })).outcome, 'applied');
  why = await m.whyOwner(s.q, { commitmentId: s.proposal });
  assert.equal(why.current.owner, 'Lee');
  assert.equal(why.current.quote, 'Lee will send the proposal instead');
  assert.deepEqual(why.pending, []);
  assert.deepEqual(await friday(s), []);
});

test('a manual owner correction is the explanation, with no note', async () => {
  const s = await scenario();
  const fix = await m.addChange(s.q, { commitmentId: s.pricing, kind: 'owner', namesId: s.dana, now: at(17) });
  assert.equal(fix.outcome, 'applied');
  const why = await m.whyOwner(s.q, { commitmentId: s.pricing });
  assert.deepEqual([why.current.owner, why.current.source, why.current.basis, why.current.noteId], ['Dana', 'manual', 'owner', null]);
});

test('competing deadlines: accepting one makes the other stale', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { kind: 'meeting', text: 'Tuesday, or maybe Wednesday.', occurredAt: at(19), involves: [s.dana], now: at(19, '11:05') });
  const tue = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-24', dueText: 'Tuesday', noteId: note, now: at(19, '11:05') });
  const wed = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-25', dueText: 'Wednesday', noteId: note, now: at(19, '11:05') });

  let queue = await m.reviewQueue(s.q);
  assert.deepEqual(queue.map((r) => [r.due, r.stale, r.conflicts]).sort(), [['2026-11-24', false, true], ['2026-11-25', false, true]]);

  assert.equal((await m.accept(s.q, tue.changeId, { now: at(19, '12:00') })).outcome, 'applied');
  queue = await m.reviewQueue(s.q);
  assert.deepEqual(queue.map((r) => [r.due, r.stale, r.conflicts]), [['2026-11-25', true, false]]);

  const refused = await m.accept(s.q, wed.changeId, { now: at(19, '12:01') });
  assert.deepEqual(refused, { outcome: 'stale', currentChangeId: tue.changeId });
  assert.equal((await state(s.q, s.proposal)).due, '2026-11-24');

  assert.equal((await m.accept(s.q, wed.changeId, { now: at(19, '12:02'), confirmStale: true })).outcome, 'applied');
  assert.equal((await state(s.q, s.proposal)).due, '2026-11-25');

  const current = (await m.history(s.q, { commitmentId: s.proposal })).filter((h) => h.currentFor.includes('due'));
  assert.deepEqual(current.map((h) => h.changeId), [wed.changeId]);
});

test('a backdated note is recorded as history and does not replace the current value', async () => {
  const s = await scenario();
  const thursday = await m.createNote(s.q, { kind: 'meeting', text: 'Tuesday is fine.', occurredAt: at(19), involves: [s.dana], now: at(19, '11:05') });
  const tue = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-24', dueText: 'Tuesday', noteId: thursday, now: at(19, '11:05') });
  await m.accept(s.q, tue.changeId, { now: at(19, '12:00') });

  // An email from Nov 17, pasted in on Nov 21, says Thursday.
  const old = await m.createNote(s.q, { kind: 'message', text: 'Can you do Thursday instead?', occurredAt: at(17), now: at(21) });
  const thu = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-19', dueText: 'Thursday', noteId: old, now: at(21) });
  const result = await m.accept(s.q, thu.changeId, { now: at(21, '09:05') });
  assert.equal(result.outcome, 'recorded');
  assert.equal((await state(s.q, s.proposal)).due, '2026-11-24');

  const rows = await m.history(s.q, { commitmentId: s.proposal });
  const old19 = rows.find((h) => h.changeId === thu.changeId);
  assert.deepEqual([old19.state, old19.applied, old19.currentFor], ['accepted', false, []]);
  assert.deepEqual(rows.find((h) => h.changeId === tue.changeId).currentFor, ['due']);

  // It still shows up as newly learned, with its source date.
  const learned = await m.changesSince(s.q, { since: at(20) });
  assert.deepEqual(learned.map((c) => [c.changeId, c.applied, c.happened.slice(0, 10)]), [[thu.changeId, false, '2026-11-17']]);
});

test('a backdated change can replace the current value when the user says so', async () => {
  const s = await scenario();
  const old = await m.createNote(s.q, { kind: 'message', text: 'Thursday please.', occurredAt: at(10), now: at(21) });
  const thu = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-19', noteId: old, now: at(21) });
  assert.equal((await m.accept(s.q, thu.changeId, { replaceCurrent: true })).outcome, 'applied');
  assert.equal((await state(s.q, s.proposal)).due, '2026-11-19');
});

test('manual completion is ordered by when the user did it, and appears in the change feed', async () => {
  const s = await scenario();
  const done = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'completed', now: at(20, '15:00') });
  assert.equal(done.outcome, 'applied');
  assert.equal((await state(s.q, s.proposal)).status, 'done');
  assert.deepEqual(await friday(s), []);

  const feed = await m.changesSince(s.q, { since: at(20, '08:00') });
  assert.deepEqual(feed.map((c) => [c.kind, c.source, c.noteId, c.happened]), [['completed', 'manual', null, '2026-11-20T15:00:00Z']]);

  // A note from before the tick that says it was cancelled does not undo the tick.
  const old = await m.createNote(s.q, { kind: 'message', text: 'Forget the proposal.', occurredAt: at(18), now: at(21) });
  const cancel = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'cancelled', noteId: old, now: at(21) });
  assert.equal((await m.accept(s.q, cancel.changeId)).outcome, 'recorded');
  assert.equal((await state(s.q, s.proposal)).status, 'done');

  // An undated note has no known order: it applies when accepted.
  const undated = await m.createNote(s.q, { text: 'Proposal needs redoing.', now: at(22) });
  const reopen = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'reopened', noteId: undated, now: at(22) });
  assert.equal((await m.accept(s.q, reopen.changeId)).outcome, 'applied');
  assert.equal((await state(s.q, s.proposal)).status, 'open');
});

test('two commitments with the same wording stay separate rows', async () => {
  const s = await scenario();
  const twin = await m.addCommitment(s.q, { what: 'Send the proposal', ownerId: s.me, due: '2026-11-20', dueText: 'Friday', now: at(17) });
  const note = await m.createNote(s.q, { text: 'Move it.', occurredAt: at(18), now: at(18) });
  await m.addChange(s.q, { commitmentId: twin.commitmentId, kind: 'deadline', due: '2026-11-27', noteId: note, now: at(18) });
  const rows = await friday(s);
  assert.equal(rows.length, 2);
  const pending = Object.fromEntries(rows.map((r) => [r.id, r.pendingChanges]));
  assert.deepEqual(pending, { [s.proposal]: 0, [twin.commitmentId]: 1 });
});

test('a dependency chain stops at a done blocker', async () => {
  const s = await scenario();
  // proposal -> review (mine) -> pricing (Lee's)
  await m.addChange(s.q, { commitmentId: s.proposal, kind: 'unblocked', namesId: s.pricing, now: at(17) });
  const review = await m.addCommitment(s.q, { what: 'Review the draft', ownerId: s.me, now: at(17) });
  await m.addChange(s.q, { commitmentId: s.proposal, kind: 'blocked', namesId: review.commitmentId, now: at(17) });
  await m.addChange(s.q, { commitmentId: review.commitmentId, kind: 'blocked', namesId: s.pricing, now: at(17) });

  const waits = async () => (await m.waitingOn(s.q, { personId: s.me })).map((r) => [r.what, r.blockedBy, r.blockerStatus, r.waitingOn]).sort();
  assert.deepEqual(await waits(), [
    ['Review the draft', 'Confirm pricing', 'open', 'Lee'],
    ['Send the proposal', 'Confirm pricing', 'open', 'Lee'],
  ].sort());

  // The middle blocker is done: the proposal no longer waits on Lee.
  await m.addChange(s.q, { commitmentId: review.commitmentId, kind: 'completed', now: at(18) });
  assert.deepEqual(await waits(), []);
});

test('a cancelled blocker is reported, and nothing behind it is', async () => {
  const s = await scenario();
  const supplier = await m.createPerson(s.q, { name: 'Supplier' });
  const quote = await m.addCommitment(s.q, { what: 'Send the quote', ownerId: supplier, now: at(17) });
  await m.addChange(s.q, { commitmentId: s.pricing, kind: 'blocked', namesId: quote.commitmentId, now: at(17) });
  const waits = async () => (await m.waitingOn(s.q, { personId: s.me })).map((r) => [r.blockedBy, r.blockerStatus, r.waitingOn]).sort();
  assert.deepEqual(await waits(), [['Confirm pricing', 'open', 'Lee'], ['Send the quote', 'open', 'Supplier']]);

  await m.addChange(s.q, { commitmentId: s.pricing, kind: 'cancelled', now: at(18) });
  assert.deepEqual(await waits(), [['Confirm pricing', 'cancelled', 'Lee']]);
});

test('a dependency that would loop is refused', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Pricing depends on the proposal.', occurredAt: at(18), now: at(18) });
  const loop = await m.addChange(s.q, { commitmentId: s.pricing, kind: 'blocked', namesId: s.proposal, noteId: note, now: at(18) });
  assert.equal((await m.accept(s.q, loop.changeId)).outcome, 'cycle');
  const rels = await s.q('MATCH (:Commitment)-[r:BLOCKED_BY]->(:Commitment) RETURN count(r) AS n');
  assert.equal(rels[0].n, 1);
});

test('reading the same note again proposes nothing twice, and keeps decisions', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { kind: 'message', text: 'Proposal can go Tuesday. Also I will book the venue.', occurredAt: at(19), now: at(19) });
  const reading = [
    { kind: 'deadline', commitmentId: s.proposal, due: '2026-11-24', dueText: 'Tuesday', quote: 'Proposal can go Tuesday' },
    { kind: 'cancelled', commitmentId: s.pricing, quote: 'Proposal can go Tuesday' },
    { kind: 'created', what: 'Book the venue', ownerId: s.me, quote: 'I will book the venue' },
  ];
  const opts = { candidateIds: [s.proposal, s.pricing], now: at(19) };
  const firstRun = await m.recordExtraction(s.q, note, reading, opts);
  assert.equal(firstRun.added.length, 3);

  const [deadline, cancelled, venue] = ['deadline', 'cancelled', 'created'].map((kind) => firstRun.added.find((a) => a.key.startsWith(kind)));
  await m.accept(s.q, deadline.changeId, { now: at(19, '10:00') });
  await m.reject(s.q, cancelled.changeId, { now: at(19, '10:00') });
  await m.reject(s.q, venue.changeId, { now: at(19, '10:00') });
  assert.equal((await s.q("MATCH (c:Commitment {what: 'Book the venue'}) RETURN count(c) AS n"))[0].n, 0);

  const second = await m.recordExtraction(s.q, note, reading, opts);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.skipped.map((x) => x.state).sort(), ['accepted', 'rejected', 'rejected']);
  assert.deepEqual(await m.reviewQueue(s.q), []);
  assert.deepEqual(await state(s.q, s.pricing), { status: 'open', due: null, review: 'confirmed', owner: 'Lee' });
  assert.equal((await s.q("MATCH (c:Commitment {what: 'Book the venue'}) RETURN count(c) AS n"))[0].n, 0);
});

test('a second reading withdraws proposals it no longer makes', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Tuesday.', occurredAt: at(19), now: at(19) });
  const opts = { candidateIds: [s.proposal], now: at(19) };
  await m.recordExtraction(s.q, note, [{ kind: 'deadline', commitmentId: s.proposal, due: '2026-11-25' }, { kind: 'created', what: 'Call Dana', ownerId: s.me }], opts);
  const again = await m.recordExtraction(s.q, note, [{ kind: 'deadline', commitmentId: s.proposal, due: '2026-11-24' }], opts);
  assert.equal(again.withdrawn.length, 2);
  assert.deepEqual((await m.reviewQueue(s.q)).map((r) => r.due), ['2026-11-24']);
  assert.equal((await s.q("MATCH (c:Commitment {what: 'Call Dana'}) RETURN count(c) AS n"))[0].n, 0);
});

test('identical text in another conversation is its own note', async () => {
  const s = await scenario();
  const text = 'Can we move it to Tuesday?';
  const fromDana = await m.createNote(s.q, { kind: 'message', text, occurredAt: at(18), involves: [s.dana], now: at(18) });
  const similar = await m.findSimilarNotes(s.q, text);
  assert.deepEqual(similar.map((n) => n.id), [fromDana]);
  const fromLee = await m.createNote(s.q, { kind: 'message', text, occurredAt: at(19), involves: [s.lee], now: at(19) });
  assert.notEqual(fromDana, fromLee);

  const a = await m.recordExtraction(s.q, fromDana, [{ kind: 'deadline', commitmentId: s.proposal, due: '2026-11-24' }], { candidateIds: [s.proposal], now: at(18) });
  await m.reject(s.q, a.added[0].changeId);
  // The same words from Lee are about a different commitment and are proposed.
  const b = await m.recordExtraction(s.q, fromLee, [{ kind: 'deadline', commitmentId: s.pricing, due: '2026-11-24' }], { candidateIds: [s.pricing], now: at(19) });
  assert.equal(b.added.length, 1);
  // And the rejection of Dana's does not block the same assertion from another note.
  const c = await m.recordExtraction(s.q, fromLee, [{ kind: 'deadline', commitmentId: s.pricing, due: '2026-11-24' }, { kind: 'deadline', commitmentId: s.proposal, due: '2026-11-24' }], { candidateIds: [s.proposal, s.pricing], now: at(19) });
  assert.deepEqual([c.added.length, c.skipped.length], [1, 1]);
});

test('a commitment id the model was not given is refused', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Done.', now: at(19) });
  const r = await m.recordExtraction(s.q, note, [{ kind: 'completed', commitmentId: s.pricing }, { kind: 'completed', commitmentId: 'made-up' }], { candidateIds: [s.proposal] });
  assert.deepEqual([r.added.length, r.invalid.length], [0, 2]);
  assert.deepEqual(await m.reviewQueue(s.q), []);
});

test('meeting baseline: the latest meeting that has happened, or the one before', async () => {
  const s = await scenario();
  const thursday = await m.createNote(s.q, { kind: 'meeting', text: 'Tuesday is fine.', occurredAt: at(19, '11:00'), involves: [s.dana], now: at(19, '11:05') });
  // An email with Dana is not a meeting.
  await m.createNote(s.q, { kind: 'message', text: 'Thanks!', occurredAt: at(19, '15:00'), involves: [s.dana], now: at(19, '15:00') });

  assert.equal((await m.meetingBaseline(s.q, { personId: s.dana, now: at(18) })).noteId, s.monday);
  assert.equal((await m.meetingBaseline(s.q, { personId: s.dana, now: at(20) })).noteId, thursday);
  assert.equal((await m.meetingBaseline(s.q, { personId: s.dana, now: at(20), previous: true })).noteId, s.monday);
  assert.equal(await m.meetingBaseline(s.q, { personId: s.lee, now: at(20) }), null);
});

test('changes since a meeting: later the same day counts, the meeting\'s own content does not', async () => {
  const s = await scenario();
  const base = await m.meetingBaseline(s.q, { personId: s.dana, now: at(17) });
  assert.deepEqual([base.noteId, base.boundaryUncertain], [s.monday, false]);

  const later = await m.createNote(s.q, { kind: 'message', text: 'Pricing by Wednesday.', occurredAt: at(16, '16:00'), now: at(16, '16:05') });
  const due = await m.addChange(s.q, { commitmentId: s.pricing, kind: 'deadline', due: '2026-11-18', noteId: later, now: at(16, '16:05') });
  const evidence = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'evidence', quote: 'Pricing by Wednesday', noteId: later, now: at(16, '16:05') });
  await m.accept(s.q, evidence.changeId);

  const feed = await m.changesSince(s.q, { since: base.since, baselineNoteId: base.noteId });
  assert.deepEqual(feed.map((c) => [c.changeId, c.kind, c.state]), [[due.changeId, 'deadline', 'proposed']]);
});

test('a meeting known only to the day gives an uncertain, inclusive boundary', async () => {
  const s = await scenario();
  const morning = await m.createNote(s.q, { kind: 'message', text: 'Pricing by Wednesday.', occurredAt: at(19, '08:00'), now: at(19, '08:05') });
  const early = await m.addChange(s.q, { commitmentId: s.pricing, kind: 'deadline', due: '2026-11-18', noteId: morning, now: at(19, '08:05') });
  const meeting = await m.createNote(s.q, { kind: 'meeting', text: 'Met Dana.', occurredAt: at(19, '00:00'), precision: 'day', involves: [s.dana], now: at(21) });
  const evening = await m.createNote(s.q, { kind: 'message', text: 'Make it Thursday.', occurredAt: at(19, '18:00'), now: at(19, '18:05') });
  const late = await m.addChange(s.q, { commitmentId: s.pricing, kind: 'deadline', due: '2026-11-26', noteId: evening, now: at(19, '18:05') });

  const base = await m.meetingBaseline(s.q, { personId: s.dana, now: at(22) });
  assert.deepEqual([base.noteId, base.precision, base.boundaryUncertain], [meeting, 'day', true]);
  const feed = await m.changesSince(s.q, { since: base.since, baselineNoteId: base.noteId });
  assert.deepEqual(feed.map((c) => c.changeId).sort(), [early.changeId, late.changeId].sort());
});

test('a change from a note known only to the day is not treated as older on the same day', async () => {
  const s = await scenario();
  const timed = await m.createNote(s.q, { text: 'Tuesday.', occurredAt: at(19, '14:00'), now: at(19, '14:05') });
  const tue = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-24', noteId: timed, now: at(19, '14:05') });
  await m.accept(s.q, tue.changeId);
  const dayOnly = await m.createNote(s.q, { text: 'Wednesday.', occurredAt: at(19, '00:00'), precision: 'day', now: at(20) });
  const wed = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-25', noteId: dayOnly, now: at(20) });
  assert.equal((await m.accept(s.q, wed.changeId)).outcome, 'applied');
  assert.equal((await state(s.q, s.proposal)).due, '2026-11-25');
});

test('rejecting a new commitment removes it and what was proposed on it', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Book the venue once Lee confirms pricing.', occurredAt: at(18), now: at(18) });
  const venue = await m.addCommitment(s.q, { what: 'Book the venue', ownerId: s.me, noteId: note, now: at(18) });
  await m.addChange(s.q, { commitmentId: venue.commitmentId, kind: 'blocked', namesId: s.pricing, noteId: note, now: at(18) });
  assert.equal((await m.reviewQueue(s.q)).length, 2);
  const rejected = await m.reject(s.q, venue.changeId);
  assert.deepEqual([rejected.outcome, rejected.removedCommitment], ['rejected', true]);
  assert.deepEqual(await m.reviewQueue(s.q), []);
  assert.equal((await s.q('MATCH (c:Commitment) RETURN count(c) AS n'))[0].n, 2);
  assert.equal((await s.q("MATCH (ch:Change {state: 'rejected'}) RETURN count(ch) AS n"))[0].n, 2);
});

// --- Cases from the third review ---

const count = async (q, cypher, params) => (await q(cypher, params))[0].n;

test('re-reading a note does not delete a new commitment the user has already corrected', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Lee will book the venue.', occurredAt: at(18), now: at(18) });
  const opts = { candidateIds: [], now: at(18) };
  const firstRun = await m.recordExtraction(s.q, note, [{ kind: 'created', what: 'Book the venue', ownerId: s.lee }], opts);
  const venue = firstRun.added[0].commitmentId;
  const fix = await m.addChange(s.q, { commitmentId: venue, kind: 'owner', namesId: s.me, now: at(18, '10:00') });
  assert.equal(fix.outcome, 'applied');

  const again = await m.recordExtraction(s.q, note, [], opts);
  assert.deepEqual(again.withdrawn, []);
  assert.deepEqual(again.kept.map((k) => k.commitmentId), [venue]);
  assert.equal((await state(s.q, venue)).owner, 'Me');
  assert.equal((await m.whyOwner(s.q, { commitmentId: venue })).current.changeId, fix.changeId);
  assert.equal(await count(s.q, 'MATCH (ch:Change) WHERE NOT (ch)-[:ON]->(:Commitment) RETURN count(ch) AS n'), 0);
});

test('rejecting a provisional blocker that something depends on needs explicit confirmation', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Proposal also needs the legal review from Dana.', occurredAt: at(18), now: at(18) });
  const legal = await m.addCommitment(s.q, { what: 'Legal review', ownerId: s.dana, noteId: note, now: at(18) });
  const dep = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'blocked', namesId: legal.commitmentId, noteId: note, now: at(18) });
  assert.equal((await m.accept(s.q, dep.changeId, { now: at(18, '10:00') })).outcome, 'applied');
  const blockers = async () => (await m.waitingOn(s.q, { personId: s.me })).map((r) => r.blockedBy).sort();
  assert.deepEqual(await blockers(), ['Confirm pricing', 'Legal review']);

  const refused = await m.reject(s.q, legal.changeId, { now: at(19) });
  assert.equal(refused.outcome, 'needs-confirmation');
  assert.deepEqual(refused.dependents, [{ id: s.proposal, what: 'Send the proposal' }]);
  assert.deepEqual(await blockers(), ['Confirm pricing', 'Legal review']);
  assert.equal(await count(s.q, 'MATCH (c:Commitment {id: $id}) RETURN count(c) AS n', { id: legal.commitmentId }), 1);

  const done = await m.reject(s.q, legal.changeId, { now: at(19), confirmConsequences: true });
  assert.equal(done.outcome, 'rejected');
  assert.deepEqual(await blockers(), ['Confirm pricing']);
  const hist = await m.history(s.q, { commitmentId: s.proposal });
  const removal = hist.find((h) => h.kind === 'unblocked');
  assert.deepEqual([removal.state, removal.applied, removal.reason, removal.currentFor], ['accepted', true, 'blocker rejected', [`blocker:${legal.commitmentId}`]]);
  // The earlier acceptance of the dependency is still in the proposal's history.
  assert.equal(hist.find((h) => h.changeId === dep.changeId).state, 'accepted');
});

test('a confirmed rejection writes nothing if what depends on it changed after it was read', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Proposal also needs the legal review from Dana.', occurredAt: at(18), now: at(18) });
  const legal = await m.addCommitment(s.q, { what: 'Legal review', ownerId: s.dana, noteId: note, now: at(18) });
  const dep = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'blocked', namesId: legal.commitmentId, noteId: note, now: at(18) });
  await m.accept(s.q, dep.changeId, { now: at(18, '10:00') });

  // Between the read of the consequences and the write, another commitment
  // comes to depend on the one being rejected.
  const racing = (cypher, params) => {
    if (cypher.includes('DETACH DELETE c')) {
      s.q('MATCH (a:Commitment {id: $a}), (b:Commitment {id: $b}) CREATE (a)-[:BLOCKED_BY]->(b)', { a: s.pricing, b: legal.commitmentId });
    }
    return s.q(cypher, params);
  };
  const before = await count(s.q, 'MATCH (n) RETURN count(n) AS n');
  const done = await m.reject(racing, legal.changeId, { now: at(19), confirmConsequences: true });
  assert.equal(done.outcome, 'busy');
  assert.equal(await count(s.q, 'MATCH (c:Commitment {id: $id}) RETURN count(c) AS n', { id: legal.commitmentId }), 1);
  assert.equal(await count(s.q, 'MATCH (n) RETURN count(n) AS n'), before);
  assert.equal(await count(s.q, "MATCH (ch:Change {id: $id}) RETURN ch.state = 'proposed' AS n", { id: legal.changeId }), true);
  assert.equal(await count(s.q, 'MATCH (:Commitment {id: $id})-[r:BLOCKED_BY]->(:Commitment {id: $b}) RETURN count(r) AS n', { id: s.proposal, b: legal.commitmentId }), 1);
});

test('a manual decision on a new commitment also guards its rejection', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Book the venue.', occurredAt: at(18), now: at(18) });
  const venue = await m.addCommitment(s.q, { what: 'Book the venue', ownerId: s.lee, noteId: note, now: at(18) });
  await m.addChange(s.q, { commitmentId: venue.commitmentId, kind: 'deadline', due: '2026-11-30', now: at(18, '10:00') });
  const refused = await m.reject(s.q, venue.changeId);
  assert.deepEqual([refused.outcome, refused.decisions.map((d) => d.kind)], ['needs-confirmation', ['deadline']]);
  assert.equal((await m.reject(s.q, venue.changeId, { confirmConsequences: true })).outcome, 'rejected');
  assert.equal(await count(s.q, "MATCH (ch:Change) WHERE NOT (ch)-[:ON]->(:Commitment) AND ch.state <> 'rejected' RETURN count(ch) AS n"), 0);
});

async function twoDeadlines(s) {
  const note = await m.createNote(s.q, { text: 'Tuesday, or maybe Wednesday.', occurredAt: at(19), now: at(19) });
  const tue = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-24', noteId: note, now: at(19) });
  const wed = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', due: '2026-11-25', noteId: note, now: at(19) });
  return [tue.changeId, wed.changeId];
}
const currentDue = (s) => count(s.q, "MATCH (:Commitment {id: $id})-[e:ESTABLISHED_BY {field: 'due'}]->() RETURN count(e) AS n", { id: s.proposal });

test('two competing accepts at once: one applies, the other is stale', async () => {
  const s = await scenario();
  const [tue, wed] = await twoDeadlines(s);
  const outcomes = (await Promise.all([m.accept(s.q, tue), m.accept(s.q, wed)])).map((r) => r.outcome);
  assert.deepEqual(outcomes, ['applied', 'stale']);
  assert.equal((await state(s.q, s.proposal)).due, '2026-11-24');
  assert.equal(await currentDue(s), 1);
});

test('the same holds when the two accepts do not share a queue', async () => {
  const s = await scenario();
  const [tue, wed] = await twoDeadlines(s);
  // Two separate handles on one store: nothing serialises them, so the reads
  // interleave and only the check inside the write statement can stop the second.
  const one = (cypher, params) => s.q(cypher, params);
  const two = (cypher, params) => s.q(cypher, params);
  const outcomes = (await Promise.all([m.accept(one, tue), m.accept(two, wed)])).map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ['applied', 'stale']);
  assert.equal(await currentDue(s), 1);
  assert.equal(await count(s.q, "MATCH (ch:Change {state: 'accepted', kind: 'deadline'})-[:ON]->(:Commitment {id: $id}) RETURN count(ch) AS n", { id: s.proposal }), 1);
});

test('accepting the same change twice at once applies it once', async () => {
  const s = await scenario();
  const [tue] = await twoDeadlines(s);
  const one = (cypher, params) => s.q(cypher, params);
  const outcomes = (await Promise.all([m.accept(s.q, tue), m.accept(one, tue)])).map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ['applied', 'not-proposed']);
  assert.equal(await currentDue(s), 1);
});

test('a dependency proposal is stale once that dependency was added and removed by hand', async () => {
  const s = await scenario();
  const review = await m.addCommitment(s.q, { what: 'Review the draft', ownerId: s.lee, now: at(17) });
  const note = await m.createNote(s.q, { text: 'Proposal waits for the draft review.', occurredAt: at(17), now: at(17) });
  const proposal = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'blocked', namesId: review.commitmentId, noteId: note, now: at(17) });
  await m.addChange(s.q, { commitmentId: s.proposal, kind: 'blocked', namesId: review.commitmentId, now: at(18) });
  await m.addChange(s.q, { commitmentId: s.proposal, kind: 'unblocked', namesId: review.commitmentId, now: at(19) });
  const deps = () => count(s.q, 'MATCH (:Commitment {id: $a})-[r:BLOCKED_BY]->(:Commitment {id: $b}) RETURN count(r) AS n', { a: s.proposal, b: review.commitmentId });
  assert.equal(await deps(), 0);

  assert.equal((await m.reviewQueue(s.q)).find((r) => r.changeId === proposal.changeId).stale, true);
  assert.equal((await m.accept(s.q, proposal.changeId)).outcome, 'stale');
  assert.equal(await deps(), 0);
  // Confirmed against the current state, it is still older than the manual removal: history only.
  assert.equal((await m.accept(s.q, proposal.changeId, { confirmStale: true })).outcome, 'recorded');
  assert.equal(await deps(), 0);
});

test('a dependency from a note older than a manual removal does not come back', async () => {
  const s = await scenario();
  await m.addChange(s.q, { commitmentId: s.proposal, kind: 'unblocked', namesId: s.pricing, now: at(19) });
  const old = await m.createNote(s.q, { text: 'Still waiting for pricing.', occurredAt: at(17), now: at(20) });
  const back = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'blocked', namesId: s.pricing, noteId: old, now: at(20) });
  assert.equal((await m.accept(s.q, back.changeId)).outcome, 'recorded');
  assert.deepEqual(await m.waitingOn(s.q, { personId: s.me }), []);
  // A newer note can add it again.
  const fresh = await m.createNote(s.q, { text: 'Pricing is needed after all.', occurredAt: at(21), now: at(21) });
  const again = await m.addChange(s.q, { commitmentId: s.proposal, kind: 'blocked', namesId: s.pricing, noteId: fresh, now: at(21) });
  assert.equal((await m.accept(s.q, again.changeId)).outcome, 'applied');
  assert.equal((await m.waitingOn(s.q, { personId: s.me })).length, 1);
});

const contractNote = (s) => m.createNote(s.q, { text: 'I will send Dana the contract by the 24th.', occurredAt: at(18), now: at(18) });
const recipient = (s, id) => s.q('MATCH (:Commitment {id: $id})-[:TO]->(p:Person) RETURN p.name AS name', { id });

test('re-reading a new commitment with a different date refreshes an untouched proposal', async () => {
  const s = await scenario();
  const note = await contractNote(s);
  const opts = { candidateIds: [], now: at(18) };
  const item = { kind: 'created', what: 'Send the contract', ownerId: s.me, toId: s.lee, due: '2026-11-20', dueText: 'the 20th' };
  const firstRun = await m.recordExtraction(s.q, note, [item], opts);
  const contract = firstRun.added[0].commitmentId;

  const second = await m.recordExtraction(s.q, note, [{ ...item, toId: s.dana, due: '2026-11-24', dueText: 'the 24th' }], opts);
  assert.deepEqual([second.added.length, second.refreshed.length, second.skipped.length], [0, 1, 0]);
  assert.equal(await count(s.q, "MATCH (c:Commitment {what: 'Send the contract'}) RETURN count(c) AS n"), 1);
  assert.equal((await state(s.q, contract)).due, '2026-11-24');
  assert.deepEqual(await recipient(s, contract), [{ name: 'Dana' }]);
  assert.equal((await m.reviewQueue(s.q)).length, 1);
});

test('re-reading with a different date after the user confirmed proposes a correction', async () => {
  const s = await scenario();
  const note = await contractNote(s);
  const opts = { candidateIds: [], now: at(18) };
  const item = { kind: 'created', what: 'Send the contract', ownerId: s.me, toId: s.lee, due: '2026-11-20', dueText: 'the 20th' };
  const firstRun = await m.recordExtraction(s.q, note, [item], opts);
  const contract = firstRun.added[0].commitmentId;
  await m.accept(s.q, firstRun.added[0].changeId, { now: at(18, '10:00') });

  const corrected = { ...item, toId: s.dana, due: '2026-11-24', dueText: 'the 24th' };
  const second = await m.recordExtraction(s.q, note, [corrected], opts);
  assert.deepEqual(second.corrected.map((c) => c.key.split('|')[0]).sort(), ['deadline', 'recipient']);
  // Nothing moves until the corrections are accepted.
  assert.equal((await state(s.q, contract)).due, '2026-11-20');
  assert.deepEqual(await recipient(s, contract), [{ name: 'Lee' }]);
  assert.deepEqual((await m.reviewQueue(s.q)).map((r) => r.kind).sort(), ['deadline', 'recipient']);

  // A third identical reading proposes nothing more and withdraws nothing.
  const third = await m.recordExtraction(s.q, note, [corrected], opts);
  assert.deepEqual([third.added.length, third.corrected.length, third.withdrawn.length, third.skipped.length], [0, 0, 0, 2]);

  for (const c of second.corrected) assert.equal((await m.accept(s.q, c.changeId, { now: at(18, '11:00') })).outcome, 'applied');
  assert.equal((await state(s.q, contract)).due, '2026-11-24');
  assert.deepEqual(await recipient(s, contract), [{ name: 'Dana' }]);
});

test('re-reading with a different date after a manual edit proposes a correction, not an overwrite', async () => {
  const s = await scenario();
  const note = await contractNote(s);
  const opts = { candidateIds: [], now: at(18) };
  const item = { kind: 'created', what: 'Send the contract', ownerId: s.me, due: '2026-11-20' };
  const firstRun = await m.recordExtraction(s.q, note, [item], opts);
  const contract = firstRun.added[0].commitmentId;
  await m.addChange(s.q, { commitmentId: contract, kind: 'deadline', due: '2026-11-27', now: at(18, '10:00') });

  const second = await m.recordExtraction(s.q, note, [{ ...item, due: '2026-11-24' }], opts);
  assert.deepEqual([second.refreshed.length, second.corrected.length], [0, 1]);
  assert.equal((await state(s.q, contract)).due, '2026-11-27');
});

// --- Cases from the fourth review ---

test('re-reading with different deadline words and no resolved date is not ignored', async () => {
  const s = await scenario();
  const note = await contractNote(s);
  const opts = { candidateIds: [], now: at(18) };
  const item = { kind: 'created', what: 'Send the contract', ownerId: s.me, dueText: 'Friday' };
  const firstRun = await m.recordExtraction(s.q, note, [item], opts);
  const contract = firstRun.added[0].commitmentId;
  const dueText = async () => (await s.q('MATCH (c:Commitment {id: $id}) RETURN c.dueText AS t', { id: contract }))[0].t;

  // Untouched: refreshed in place.
  const second = await m.recordExtraction(s.q, note, [{ ...item, dueText: 'Tuesday' }], opts);
  assert.deepEqual([second.refreshed.length, second.skipped.length], [1, 0]);
  assert.equal(await dueText(), 'Tuesday');
  // The same words again, differently capitalised, are the same reading.
  const same = await m.recordExtraction(s.q, note, [{ ...item, dueText: 'tuesday' }], opts);
  assert.deepEqual([same.refreshed.length, same.skipped.length], [0, 1]);

  // Confirmed: a correction is proposed and nothing moves until it is accepted.
  await m.accept(s.q, firstRun.added[0].changeId);
  const third = await m.recordExtraction(s.q, note, [{ ...item, dueText: 'Thursday' }], opts);
  assert.deepEqual(third.corrected.map((c) => c.key), [`deadline|${contract}|thursday`]);
  assert.equal(await dueText(), 'Tuesday');
  assert.equal((await m.accept(s.q, third.corrected[0].changeId)).outcome, 'applied');
  assert.equal(await dueText(), 'Thursday');
});

test('re-reading can propose removing a confirmed recipient and deadline', async () => {
  const s = await scenario();
  const note = await contractNote(s);
  const opts = { candidateIds: [], now: at(18) };
  const item = { kind: 'created', what: 'Send the contract', ownerId: s.me, toId: s.dana, due: '2026-11-24', dueText: 'the 24th' };
  const firstRun = await m.recordExtraction(s.q, note, [item], opts);
  const contract = firstRun.added[0].commitmentId;
  await m.accept(s.q, firstRun.added[0].changeId);

  const bare = { kind: 'created', what: 'Send the contract', ownerId: s.me };
  const second = await m.recordExtraction(s.q, note, [bare], opts);
  assert.deepEqual(second.corrected.map((c) => c.key).sort(), [`deadline|${contract}|none`, `recipient|${contract}|none`]);
  // Still Dana, still the 24th, until the removals are reviewed.
  assert.deepEqual(await recipient(s, contract), [{ name: 'Dana' }]);
  assert.equal((await state(s.q, contract)).due, '2026-11-24');
  const queue = await m.reviewQueue(s.q);
  assert.deepEqual(queue.map((r) => [r.kind, r.clear]).sort(), [['deadline', true], ['recipient', true]]);

  // Read the same way again: nothing new.
  const third = await m.recordExtraction(s.q, note, [bare], opts);
  assert.deepEqual([third.corrected.length, third.withdrawn.length, third.skipped.length], [0, 0, 2]);

  for (const c of second.corrected) assert.equal((await m.accept(s.q, c.changeId)).outcome, 'applied');
  assert.deepEqual(await recipient(s, contract), []);
  const after = (await s.q('MATCH (c:Commitment {id: $id}) RETURN toString(c.due) AS due, c.dueText AS dueText', { id: contract }))[0];
  assert.deepEqual(after, { due: null, dueText: null });
  const current = (await m.history(s.q, { commitmentId: contract })).filter((h) => h.currentFor.length);
  assert.deepEqual(current.flatMap((h) => h.currentFor).sort(), ['due', 'owner', 'status', 'to']);
});

test('a rejected removal leaves the recipient, and is not proposed again', async () => {
  const s = await scenario();
  const note = await contractNote(s);
  const opts = { candidateIds: [], now: at(18) };
  const firstRun = await m.recordExtraction(s.q, note, [{ kind: 'created', what: 'Send the contract', ownerId: s.me, toId: s.dana }], opts);
  const contract = firstRun.added[0].commitmentId;
  await m.accept(s.q, firstRun.added[0].changeId);
  const bare = { kind: 'created', what: 'Send the contract', ownerId: s.me };
  const second = await m.recordExtraction(s.q, note, [bare], opts);
  await m.reject(s.q, second.corrected[0].changeId);
  const third = await m.recordExtraction(s.q, note, [bare], opts);
  assert.deepEqual([third.corrected.length, third.skipped.map((x) => x.state)], [0, ['rejected']]);
  assert.deepEqual(await recipient(s, contract), [{ name: 'Dana' }]);
});

test('the user can clear a recipient or deadline by hand; an owner cannot be cleared', async () => {
  const s = await scenario();
  assert.equal((await m.addChange(s.q, { commitmentId: s.proposal, kind: 'recipient', clear: true, now: at(18) })).outcome, 'applied');
  assert.deepEqual(await recipient(s, s.proposal), []);
  assert.equal((await m.addChange(s.q, { commitmentId: s.proposal, kind: 'deadline', clear: true, now: at(18) })).outcome, 'applied');
  assert.equal((await state(s.q, s.proposal)).due, null);
  await assert.rejects(m.addChange(s.q, { commitmentId: s.proposal, kind: 'owner', clear: true }));
  await assert.rejects(m.addChange(s.q, { commitmentId: s.proposal, kind: 'recipient' }));
  assert.equal((await state(s.q, s.proposal)).owner, 'Me');
});

test('a blocker the model was not given is refused', async () => {
  const s = await scenario();
  const other = await m.addCommitment(s.q, { what: 'Unrelated task', ownerId: s.lee, now: at(17) });
  const note = await m.createNote(s.q, { text: 'Proposal waits on something.', occurredAt: at(18), now: at(18) });
  const r = await m.recordExtraction(s.q, note, [
    { kind: 'blocked', commitmentId: s.proposal, namesId: other.commitmentId },
    { kind: 'unblocked', commitmentId: s.proposal, namesId: s.pricing },
    { kind: 'blocked', commitmentId: s.proposal, namesId: 'made-up' },
  ], { candidateIds: [s.proposal], now: at(18) });
  assert.equal(r.added.length, 0);
  assert.deepEqual(r.invalid.map((i) => i.reason), ['unknown blocker', 'unknown blocker', 'unknown blocker']);
  assert.deepEqual(await m.reviewQueue(s.q), []);
  assert.equal(await count(s.q, 'MATCH (:Commitment {id: $id})-[r:BLOCKED_BY]->() RETURN count(r) AS n', { id: s.proposal }), 1);

  // With the blocker in the list it is proposed.
  const ok = await m.recordExtraction(s.q, note, [{ kind: 'blocked', commitmentId: s.proposal, namesId: other.commitmentId }],
    { candidateIds: [s.proposal, other.commitmentId], now: at(18) });
  assert.equal(ok.added.length, 1);
});

test('a change can refer to a new commitment of the same reading, in any order', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'I will book the venue once Lee sends the budget.', occurredAt: at(18), now: at(18) });
  const reading = [
    { kind: 'blocked', commitmentRef: 'venue', namesRef: 'budget', quote: 'once Lee sends the budget' },
    { kind: 'created', ref: 'venue', what: 'Book the venue', ownerId: s.me },
    { kind: 'created', ref: 'budget', what: 'Send the budget', ownerId: s.lee, toId: s.me },
    { kind: 'blocked', commitmentRef: 'venue', namesRef: 'nowhere' },
    { kind: 'deadline', commitmentRef: 'nowhere', due: '2026-11-30' },
  ];
  const opts = { candidateIds: [], now: at(18) };
  const r = await m.recordExtraction(s.q, note, reading, opts);
  assert.deepEqual(r.added.map((a) => a.key.split('|')[0]), ['created', 'created', 'blocked']);
  assert.deepEqual(r.invalid.map((i) => i.reason), ['unknown blocker ref', 'unknown commitment ref']);

  const dep = r.added[2];
  assert.equal((await m.accept(s.q, dep.changeId)).outcome, 'applied');
  const waits = (await m.waitingOn(s.q, { personId: s.me })).map((w) => [w.what, w.blockedBy, w.waitingOn]).sort();
  assert.deepEqual(waits, [['Book the venue', 'Send the budget', 'Lee'], ['Send the proposal', 'Confirm pricing', 'Lee']]);

  // Read again: the refs resolve to the same commitments and nothing is added.
  const again = await m.recordExtraction(s.q, note, reading.slice(0, 3), opts);
  assert.deepEqual([again.added.length, again.skipped.length, again.withdrawn.length], [0, 3, 0]);
  assert.equal(await count(s.q, 'MATCH (c:Commitment) RETURN count(c) AS n'), 4);
});

test('a change that refers to a rejected new commitment is refused, not applied elsewhere', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'I will book the venue by Friday.', occurredAt: at(18), now: at(18) });
  const opts = { candidateIds: [], now: at(18) };
  const firstRun = await m.recordExtraction(s.q, note, [{ kind: 'created', ref: 'venue', what: 'Book the venue', ownerId: s.me }], opts);
  await m.reject(s.q, firstRun.added[0].changeId);
  const second = await m.recordExtraction(s.q, note, [
    { kind: 'created', ref: 'venue', what: 'Book the venue', ownerId: s.me },
    { kind: 'deadline', commitmentRef: 'venue', due: '2026-11-20' },
  ], opts);
  assert.deepEqual([second.added.length, second.invalid.map((i) => i.reason)], [0, ['commitment was rejected']]);
});

test('an unknown person in a reading is refused before anything is written', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Someone will do something.', occurredAt: at(18), now: at(18) });
  const before = await count(s.q, 'MATCH (n) RETURN count(n) AS n');
  const r = await m.recordExtraction(s.q, note, [
    { kind: 'created', what: 'Do something', ownerId: 'nobody' },
    { kind: 'created', what: 'Do something else', ownerId: s.me, toId: 'nobody' },
    { kind: 'owner', commitmentId: s.proposal, namesId: 'nobody' },
    { kind: 'recipient', commitmentId: s.proposal, namesId: 'nobody' },
  ], { candidateIds: [s.proposal], now: at(18) });
  assert.deepEqual(r.invalid.map((i) => i.reason), ['unknown owner', 'unknown recipient', 'unknown person', 'unknown person']);
  assert.equal(await count(s.q, 'MATCH (n) RETURN count(n) AS n'), before);
});

// --- Cases from the fifth review ---

const reports = (s) => s.q(
  `MATCH (c:Commitment {what: 'Send report'}) OPTIONAL MATCH (c)-[:TO]->(p:Person)
   RETURN c.id AS id, p.name AS to, toString(c.due) AS due ORDER BY due`,
);

test('two new commitments with the same wording and owner stay two commitments', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Send report to Dana Friday, then send report to Lee Monday.', occurredAt: at(18), now: at(18) });
  const reading = [
    { kind: 'created', ref: 'a', what: 'Send report', ownerId: s.me, toId: s.dana, due: '2026-11-20' },
    { kind: 'created', ref: 'b', what: 'Send report', ownerId: s.me, toId: s.lee, due: '2026-11-23' },
    { kind: 'blocked', commitmentRef: 'b', namesRef: 'a' },
  ];
  const opts = { candidateIds: [], now: at(18) };
  const r = await m.recordExtraction(s.q, note, reading, opts);
  assert.equal(r.added.length, 3);
  const rows = await reports(s);
  assert.deepEqual(rows.map((x) => [x.to, x.due]), [['Dana', '2026-11-20'], ['Lee', '2026-11-23']]);
  const [first, second] = rows.map((x) => x.id);
  assert.notEqual(first, second);

  // The dependency joins the two, and is not a loop.
  const dep = r.added.find((a) => a.key.startsWith('blocked'));
  assert.equal(dep.key, `blocked|${second}|${first}`);
  assert.equal((await m.accept(s.q, dep.changeId)).outcome, 'applied');
  assert.equal(await count(s.q, 'MATCH (a:Commitment {id: $a})-[r:BLOCKED_BY]->(b:Commitment {id: $b}) RETURN count(r) AS n', { a: second, b: first }), 1);

  // Read again, in the other order: the same two, nothing added or changed.
  const again = await m.recordExtraction(s.q, note, [reading[1], reading[0], reading[2]], opts);
  assert.deepEqual([again.added.length, again.refreshed.length, again.corrected.length, again.withdrawn.length, again.skipped.length], [0, 0, 0, 0, 3]);
  assert.deepEqual((await reports(s)).map((x) => [x.id, x.to, x.due]), rows.map((x) => [x.id, x.to, x.due]));
});

test('re-reading two same-worded commitments changes the right one', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Send report to Dana Friday, then send report to Lee Monday.', occurredAt: at(18), now: at(18) });
  const a = { kind: 'created', what: 'Send report', ownerId: s.me, toId: s.dana, due: '2026-11-20' };
  const b = { kind: 'created', what: 'Send report', ownerId: s.me, toId: s.lee, due: '2026-11-23' };
  const opts = { candidateIds: [], now: at(18) };
  await m.recordExtraction(s.q, note, [a, b], opts);
  const before = await reports(s);

  // Lee's moves to Tuesday; listed first this time.
  const second = await m.recordExtraction(s.q, note, [{ ...b, due: '2026-11-24' }, a], opts);
  assert.deepEqual([second.added.length, second.refreshed.length, second.skipped.length], [0, 1, 1]);
  const after = await reports(s);
  assert.deepEqual(after.map((x) => [x.id, x.to, x.due]), [[before[0].id, 'Dana', '2026-11-20'], [before[1].id, 'Lee', '2026-11-24']]);

  // A third one appears, one is dropped.
  const third = await m.recordExtraction(s.q, note, [a, { ...a, toId: null, due: '2026-11-27' }, { ...a, toId: null, due: '2026-11-30' }], opts);
  assert.equal(third.added.length, 1);
  assert.equal((await reports(s)).length, 3);
  assert.deepEqual((await reports(s)).map((x) => x.to), ['Dana', null, null]);
});

test('a rejected one of two same-worded commitments stays rejected and the other stays', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Send report to Dana, send report to Lee.', occurredAt: at(18), now: at(18) });
  const a = { kind: 'created', what: 'Send report', ownerId: s.me, toId: s.dana };
  const b = { kind: 'created', what: 'Send report', ownerId: s.me, toId: s.lee };
  const opts = { candidateIds: [], now: at(18) };
  const firstRun = await m.recordExtraction(s.q, note, [a, b], opts);
  await m.reject(s.q, firstRun.added[0].changeId);
  const again = await m.recordExtraction(s.q, note, [a, b], opts);
  assert.deepEqual([again.added.length, again.skipped.map((x) => x.state).sort()], [0, ['proposed', 'rejected']]);
  assert.deepEqual((await reports(s)).map((x) => x.to), ['Lee']);
});

test('two new commitments cannot claim the same ref', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'Two things.', occurredAt: at(18), now: at(18) });
  const r = await m.recordExtraction(s.q, note, [
    { kind: 'created', ref: 'x', what: 'First thing', ownerId: s.me },
    { kind: 'created', ref: 'x', what: 'Second thing', ownerId: s.me },
  ], { candidateIds: [], now: at(18) });
  assert.deepEqual([r.added.length, r.invalid.map((i) => i.reason)], [1, ['duplicate ref']]);
});

test('an invalid re-reading does not delete an earlier valid proposal', async () => {
  const s = await scenario();
  const note = await m.createNote(s.q, { text: 'I will book the venue. Proposal moves to Tuesday.', occurredAt: at(18), now: at(18) });
  const opts = { candidateIds: [s.proposal], now: at(18) };
  const firstRun = await m.recordExtraction(s.q, note, [
    { kind: 'created', what: 'Book venue', ownerId: s.me },
    { kind: 'deadline', commitmentId: s.proposal, due: '2026-11-24' },
  ], opts);
  assert.equal(firstRun.added.length, 2);
  const venue = firstRun.added[0].commitmentId;

  // The same note read again with an owner that does not exist and a made-up commitment.
  const bad = await m.recordExtraction(s.q, note, [
    { kind: 'created', what: 'Book venue', ownerId: 'nobody' },
    { kind: 'deadline', commitmentId: 'made-up', due: '2026-11-24' },
  ], opts);
  assert.deepEqual(bad.invalid.map((i) => i.reason), ['unknown owner', 'unknown commitment']);
  assert.deepEqual(bad.withdrawn, []);
  assert.deepEqual(bad.kept.map((k) => k.reason), ['the reading had invalid assertions', 'the reading had invalid assertions']);
  assert.equal(await count(s.q, 'MATCH (c:Commitment {id: $id}) RETURN count(c) AS n', { id: venue }), 1);
  assert.equal((await m.reviewQueue(s.q)).length, 2);

  // A clean reading that really omits them withdraws them.
  const clean = await m.recordExtraction(s.q, note, [], opts);
  assert.equal(clean.withdrawn.length, 2);
  assert.equal(await count(s.q, 'MATCH (c:Commitment {id: $id}) RETURN count(c) AS n', { id: venue }), 0);
});
