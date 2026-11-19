// What the review screen shows and does, against a Relate store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as m from '../src/model.js';
import * as r from '../src/review-data.js';
import { openStore } from './store.mjs';

const open = () => openStore('kept-review');
// A fixed "today" for the demo: Wednesday Nov 25, so last week runs Nov 16 to 20.
const DEMO = { today: new Date('2026-11-25T12:00:00Z') };
const meOf = async (q) => (await r.people(q)).find((p) => p.isMe).id;
const friday = async (q) => m.owedBefore(q, { personId: await meOf(q), date: '2026-11-20' });

test('the demo scenario: Monday is confirmed, Wednesday and Thursday wait for review', async () => {
  const q = open();
  assert.equal(await r.seedDemo(q, DEMO), true);
  assert.equal(await r.seedDemo(q, DEMO), false, 'loading it twice adds nothing');
  assert.deepEqual((await r.people(q)).map((p) => p.name), ['Me', 'Dana', 'Lee']);

  const list = await r.commitments(q);
  assert.deepEqual(list.map((c) => [c.what, c.owner, c.to, c.due, c.review, c.pendingChanges]), [
    ['Send the proposal', 'Me', 'Dana', '2026-11-20', 'confirmed', 1],
    ['Confirm pricing', 'Lee', 'Me', null, 'confirmed', 1],
  ]);

  const items = await r.reviewItems(q);
  assert.deepEqual(items.map((i) => i.summary), [
    'Move the deadline of "Confirm pricing" from no date to Monday (2026-11-23).',
    'Move the deadline of "Send the proposal" from Friday (2026-11-20) to Tuesday (2026-11-24).',
  ]);
  assert.deepEqual(items.map((i) => [i.quote, i.note.kind, i.note.text, i.stale, i.conflicts]), [
    ['delayed until Monday', 'message', "Lee's pricing is delayed until Monday.", false, false],
    ['we can send the proposal Tuesday', 'meeting', 'Dana agreed we can send the proposal Tuesday.', false, false],
  ]);
});

test('the demo scenario loads into a store that has people but no commitments, without making them twice', async () => {
  const q = open();
  const me = await m.createPerson(q, { name: 'Me', isMe: true });
  await m.createPerson(q, { name: 'Dana' });
  assert.equal(await r.seedDemo(q, DEMO), true);
  const people = await r.people(q);
  assert.deepEqual(people.map((p) => p.name), ['Me', 'Dana', 'Lee']);
  assert.equal(people[0].id, me);
  assert.equal((await r.commitments(q)).length, 2);
});

test('the demo question: before review the proposal is due Friday, after it is not', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  assert.deepEqual((await friday(q)).map((c) => [c.what, c.due, c.pendingChanges]), [['Send the proposal', '2026-11-20', 1]]);
  const waits = await m.waitingOn(q, { personId: await meOf(q) });
  assert.deepEqual(waits.map((w) => [w.what, w.blockedBy, w.waitingOn, w.blockerDue]), [['Send the proposal', 'Confirm pricing', 'Lee', null]]);

  for (const item of await r.reviewItems(q)) assert.equal((await m.accept(q, item.changeId)).outcome, 'applied');
  assert.deepEqual(await r.reviewItems(q), []);
  assert.deepEqual(await friday(q), []);
  const after = await m.waitingOn(q, { personId: await meOf(q) });
  assert.deepEqual(after.map((w) => [w.what, w.waitingOn, w.blockerDue]), [['Send the proposal', 'Lee', '2026-11-23']]);
  const why = await m.whyOwner(q, { commitmentId: after[0].id });
  assert.deepEqual([why.current.owner, why.current.quote], ['Me', "I'll send Dana the proposal Friday"]);
});

test('the demo is always last week, whatever today is', () => {
  const expected = { monday: '2026-11-16', wednesday: '2026-11-18', thursday: '2026-11-19', friday: '2026-11-20', nextMonday: '2026-11-23', nextTuesday: '2026-11-24' };
  for (const today of ['2026-11-23T00:00:00Z', '2026-11-25T12:00:00Z', '2026-11-29T23:59:00Z']) {
    assert.deepEqual(r.demoDates(new Date(today)), expected, today);
  }
  // A Sunday belongs to the week that is ending, and a month boundary is crossed cleanly.
  assert.equal(r.demoDates(new Date('2026-11-15T08:00:00Z')).monday, '2026-11-02');
  assert.deepEqual([r.demoDates(new Date('2026-12-03T08:00:00Z')).monday, r.demoDates(new Date('2026-12-03T08:00:00Z')).nextTuesday], ['2026-11-23', '2026-12-01']);
});

test('loaded today, everything in the demo has already happened and a manual change applies', async () => {
  const q = open();
  await r.seedDemo(q);
  const people = await r.people(q);
  const dana = people.find((p) => p.name === 'Dana').id;
  // The last meeting with Dana exists as of now.
  const baseline = await m.meetingBaseline(q, { personId: dana });
  assert.ok(baseline, 'a meeting with Dana that has already happened');
  // "It is about another commitment", done now, is applied and not set aside as older than the current value.
  const [pricingDue] = await r.reviewItems(q);
  const proposal = (await r.commitments(q)).find((c) => c.what === 'Send the proposal');
  const moved = await r.moveProposal(q, pricingDue.changeId, proposal.id);
  assert.equal(moved.outcome, 'applied');
  assert.equal((await r.commitments(q)).find((c) => c.what === 'Send the proposal').due, r.demoDates().nextMonday);
});

test('a rejected proposal leaves the queue and changes nothing', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const [, tuesday] = await r.reviewItems(q);
  assert.equal((await m.reject(q, tuesday.changeId)).outcome, 'rejected');
  assert.deepEqual((await r.reviewItems(q)).map((i) => i.commitment.what), ['Confirm pricing']);
  assert.deepEqual((await friday(q)).map((c) => [c.due, c.pendingChanges]), [['2026-11-20', 0]]);
});

test('a proposal on the wrong commitment can be moved to the right one', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const me = await meOf(q);
  const contract = await m.addCommitment(q, { what: 'Send the contract', ownerId: me, due: '2026-11-20', dueText: 'Friday' });
  const [, tuesday] = await r.reviewItems(q);
  assert.equal(tuesday.commitment.what, 'Send the proposal');

  const moved = await r.moveProposal(q, tuesday.changeId, contract.commitmentId, { now: '2026-11-26T09:00:00Z' });
  assert.equal(moved.outcome, 'applied');
  const due = Object.fromEntries((await r.commitments(q)).map((c) => [c.what, c.due]));
  assert.deepEqual([due['Send the proposal'], due['Send the contract']], ['2026-11-20', '2026-11-24']);
  // The original is rejected, and the move keeps the note and the quote as evidence.
  assert.deepEqual((await r.reviewItems(q)).map((i) => i.commitment.what), ['Confirm pricing']);
  const history = await m.history(q, { commitmentId: contract.commitmentId });
  const change = history.find((h) => h.kind === 'deadline');
  assert.deepEqual([change.source, change.applied, change.currentFor], ['manual', true, ['due']]);
  // It happened when the note did, and was learned when the user moved it.
  assert.equal(change.happened, '2026-11-19T19:00:00Z');
  assert.equal(change.learned, '2026-11-26T09:00:00Z');
  const [evidence] = await q('MATCH (ch:Change {id: $id})-[:FROM]->(n:Note) RETURN ch.quote AS quote, n.text AS text', { id: change.changeId });
  assert.deepEqual(evidence, { quote: 'we can send the proposal Tuesday', text: 'Dana agreed we can send the proposal Tuesday.' });

  assert.equal((await r.moveProposal(q, 'no-such-change', contract.commitmentId)).outcome, 'missing');
});

test('a moved proposal applies even over a value set after its note', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const list = await r.commitments(q);
  const proposal = list.find((c) => c.what === 'Send the proposal').id;
  // The user set the proposal's date by hand, after both notes.
  await m.addChange(q, { commitmentId: proposal, kind: 'deadline', due: '2026-11-27', now: '2026-11-21T09:00:00Z' });
  const [pricingDue] = await r.reviewItems(q);
  const moved = await r.moveProposal(q, pricingDue.changeId, proposal, { now: '2026-11-22T09:00:00Z' });
  // An ordinary proposal from that older note would be kept as history only; this is the user's decision.
  assert.equal(moved.outcome, 'applied');
  assert.equal((await r.commitments(q)).find((c) => c.id === proposal).due, '2026-11-23');
});

test('a proposal cannot be moved onto its own commitment, and a dependency cannot be moved', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const [pricingDue] = await r.reviewItems(q);
  assert.equal((await r.moveProposal(q, pricingDue.changeId, pricingDue.commitment.id)).outcome, 'same-commitment');
  const list = await r.commitments(q);
  const proposal = list.find((c) => c.what === 'Send the proposal');
  const pricing = list.find((c) => c.what === 'Confirm pricing');
  const note = await m.createNote(q, { text: 'Pricing waits for the proposal.', occurredAt: '2026-11-20T09:00:00Z' });
  const dep = await m.addChange(q, { commitmentId: pricing.id, kind: 'blocked', namesId: proposal.id, noteId: note });
  assert.equal((await r.moveProposal(q, dep.changeId, proposal.id)).outcome, 'not-movable');
  assert.equal((await r.reviewItems(q)).length, 3);
});

test('every kind of proposal reads as a sentence', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const me = await meOf(q);
  const [dana, lee] = (await r.people(q)).filter((p) => !p.isMe).map((p) => p.id);
  const list = await r.commitments(q);
  const proposal = list.find((c) => c.what === 'Send the proposal').id;
  const pricing = list.find((c) => c.what === 'Confirm pricing').id;
  const note = await m.createNote(q, { text: 'Assorted.', occurredAt: '2026-11-20T09:00:00Z' });
  const add = (args) => m.addChange(q, { noteId: note, ...args });
  await m.addCommitment(q, { what: 'Book a room', ownerId: me, toId: dana, dueText: 'Thursday', noteId: note });
  await add({ commitmentId: proposal, kind: 'completed' });
  await add({ commitmentId: proposal, kind: 'cancelled' });
  await add({ commitmentId: proposal, kind: 'owner', namesId: lee });
  await add({ commitmentId: proposal, kind: 'recipient', namesId: lee });
  await add({ commitmentId: proposal, kind: 'recipient', clear: true });
  await add({ commitmentId: proposal, kind: 'deadline', clear: true });
  await add({ commitmentId: proposal, kind: 'unblocked', namesId: pricing });
  const summaries = (await r.reviewItems(q)).map((i) => i.summary);
  for (const expected of [
    'New commitment: Me owes "Book a room" to Dana, due Thursday.',
    'Mark "Send the proposal" as done.',
    'Mark "Send the proposal" as cancelled.',
    'Make Lee the owner of "Send the proposal" instead of Me.',
    '"Send the proposal" is owed to Lee instead of Dana.',
    '"Send the proposal" is no longer owed to Dana.',
    'Remove the deadline of "Send the proposal" (now Friday (2026-11-20)).',
    '"Send the proposal" no longer waits for "Confirm pricing".',
  ]) assert.ok(summaries.includes(expected), `${expected}\n  got: ${summaries.join('\n       ')}`);
  // Proposals for the same value are marked as conflicting.
  const flagged = (await r.reviewItems(q)).filter((i) => i.conflicts).map((i) => i.kind).sort();
  assert.deepEqual(flagged, ['cancelled', 'completed', 'deadline', 'deadline', 'recipient', 'recipient']);
});

test('what changed since the last meeting, as sentences', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const dana = (await r.people(q)).find((p) => p.name === 'Dana').id;
  // Asked on the Wednesday, the last meeting with Dana is Monday's.
  const monday = await m.meetingBaseline(q, { personId: dana, now: '2026-11-18T20:00:00Z' });
  const sinceMonday = await r.changesWithCommitments(q, { since: monday.since, baselineNoteId: monday.noteId });
  assert.deepEqual(sinceMonday.map((c) => [c.summary, c.state]), [
    ['"Confirm pricing": deadline moved to Monday (2026-11-23).', 'proposed'],
    ['"Send the proposal": deadline moved to Tuesday (2026-11-24).', 'proposed'],
  ]);
  // Asked later, it is Thursday's, and that meeting's own content is left out.
  const thursday = await m.meetingBaseline(q, { personId: dana, now: '2026-11-21T09:00:00Z' });
  assert.deepEqual(await r.changesWithCommitments(q, { since: thursday.since, baselineNoteId: thursday.noteId }), []);
  // Something done by hand afterwards shows up.
  const proposal = (await r.commitments(q)).find((c) => c.what === 'Send the proposal').id;
  await m.addChange(q, { commitmentId: proposal, kind: 'completed', now: '2026-11-21T10:00:00Z' });
  const after = await r.changesWithCommitments(q, { since: thursday.since, baselineNoteId: thursday.noteId });
  assert.deepEqual(after.map((c) => [c.summary, c.source, c.applied]), [['"Send the proposal": done.', 'manual', true]]);
});

test('the People line: everyone, with the open commitments they owe and are owed', async () => {
  const q = open();
  assert.deepEqual(await r.peopleSummary(q), []);
  await r.seedDemo(q, DEMO);
  assert.deepEqual((await r.peopleSummary(q)).map((p) => [p.name, p.isMe, p.owes, p.owed]), [
    ['Me', true, 1, 1], ['Dana', false, 0, 1], ['Lee', false, 1, 0],
  ]);
  const done = await m.addChange(q, { commitmentId: (await r.commitments(q)).find((c) => c.what === 'Confirm pricing').id, kind: 'completed' });
  assert.equal(done.outcome, 'applied');
  assert.deepEqual((await r.peopleSummary(q)).map((p) => [p.name, p.owes, p.owed]), [['Me', 1, 0], ['Dana', 0, 1], ['Lee', 0, 0]]);
});

test('"What do others owe me?": open commitments to the user, with what each one holds up', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const me = await meOf(q);
  assert.deepEqual((await m.owedTo(q, { personId: me })).map((c) => [c.what, c.owedBy, c.due, c.holdsUp, c.pendingChanges]),
    [['Confirm pricing', 'Lee', null, ['Send the proposal'], 1]]);
  // The user's own commitments are not in it, nor what is done.
  const pricing = (await r.commitments(q)).find((c) => c.what === 'Confirm pricing').id;
  await m.addChange(q, { commitmentId: pricing, kind: 'completed' });
  assert.deepEqual(await m.owedTo(q, { personId: me }), []);
});

test('"Why?" history: every change with its words, its note and what was decided, oldest first', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const pricing = (await r.commitments(q)).find((c) => c.what === 'Confirm pricing').id;
  const note = await m.createNote(q, { text: 'Lee confirmed the pricing.', occurredAt: '2026-11-25T10:00:00Z', now: '2026-11-25T10:05:00Z' });
  const done = await m.addChange(q, { commitmentId: pricing, kind: 'completed', quote: 'Lee confirmed the pricing', noteId: note, now: '2026-11-25T10:05:00Z' });
  await m.accept(q, done.changeId, { now: '2026-11-25T10:06:00Z' });
  const past = await r.historyItems(q, pricing);
  assert.deepEqual(past.map((h) => h.summary), ['Created', 'Deadline set to Monday (2026-11-23)', 'Marked done']);
  const last = past.at(-1);
  assert.deepEqual([last.state, last.applied, last.quote, last.note], ['accepted', true, 'Lee confirmed the pricing', 'Lee confirmed the pricing.']);
});
