// Capture: dates, people, candidates, and a note's answer becoming proposals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as m from '../src/model.js';
import * as r from '../src/review-data.js';
import * as c from '../src/capture.js';
import { openStore } from './store.mjs';

const open = () => openStore('kept-capture');
// Demo loaded on Wednesday Nov 25: last week runs Nov 16 to 20.
const DEMO = { today: new Date('2026-11-25T12:00:00Z') };
// A note taken on Wednesday Nov 25.
const WHEN = { occurredAt: '2026-11-25T15:00:00Z', baseDate: '2026-11-25', now: '2026-11-25T15:05:00Z' };
const summaries = async (q) => (await r.reviewItems(q)).map((i) => i.summary);

test('dates: a weekday is the next such day after the note', () => {
  const wednesday = '2026-11-25';
  assert.equal(c.resolveDate('Friday', wednesday), '2026-11-27');
  assert.equal(c.resolveDate('Tuesday', wednesday), '2026-12-01');
  assert.equal(c.resolveDate('by Friday', wednesday), '2026-11-27');
  assert.equal(c.resolveDate('on Thursday morning', wednesday), '2026-11-26');
  assert.equal(c.resolveDate('Thurs', wednesday), '2026-11-26');
  assert.equal(c.resolveDate('today', wednesday), '2026-11-25');
  assert.equal(c.resolveDate('tomorrow', wednesday), '2026-11-26');
});

test('dates: written dates, with the year or with the next one that fits', () => {
  assert.equal(c.resolveDate('2026-12-03', '2026-11-25'), '2026-12-03');
  assert.equal(c.resolveDate('Nov 30', '2026-11-25'), '2026-11-30');
  assert.equal(c.resolveDate('November 30th', '2026-11-25'), '2026-11-30');
  assert.equal(c.resolveDate('the 3rd of December', '2026-11-25'), '2026-12-03');
  assert.equal(c.resolveDate('3 March', '2026-11-25'), '2027-03-03');
  assert.equal(c.resolveDate('March 3 2026', '2026-11-25'), '2026-03-03');
});

test('dates: anything with more than one reading stays unresolved', () => {
  const wednesday = '2026-11-25';
  for (const text of ['Wednesday', 'next Friday', 'next week', 'next month', 'the 3rd', 'end of month', 'soon', '', 'Feb 30', '2026-02-30', 'Friday or Monday']) {
    assert.equal(c.resolveDate(text, wednesday), null, text);
  }
  assert.equal(c.resolveDate('Friday', null), null);
});

test('people: a name matches one person or nobody', () => {
  const people = [
    { id: 'me', name: 'Me', isMe: true, aliases: [] },
    { id: 'dana', name: 'Dana Whitfield', isMe: false, aliases: ['D.W.'] },
    { id: 'lee', name: 'Lee', isMe: false, aliases: [] },
    { id: 'sam1', name: 'Sam Ortiz', isMe: false, aliases: [] },
    { id: 'sam2', name: 'Sam Lind', isMe: false, aliases: [] },
  ];
  assert.equal(c.matchPerson('me', people), 'me');
  assert.equal(c.matchPerson('I', people), 'me');
  assert.equal(c.matchPerson('lee', people), 'lee');
  assert.equal(c.matchPerson('Dana', people), 'dana', 'a first name that only one person has');
  assert.equal(c.matchPerson('d.w.', people), 'dana', 'an alias');
  assert.equal(c.matchPerson('Sam', people), null, 'two people called Sam');
  assert.equal(c.matchPerson('Omar', people), null);
  assert.equal(c.matchPerson('', people), null);
  assert.deepEqual(c.peopleNamed("Lee's pricing goes to Dana Whitfield, says Lee.", people), ['lee', 'dana']);
  assert.deepEqual(c.peopleNamed('Leeds was rainy for me.', people), []);
});

test('people: who owes a new commitment to whom is guessed from the words', () => {
  const people = [
    { id: 'me', name: 'Me', isMe: true }, { id: 'dana', name: 'Dana', isMe: false }, { id: 'lee', name: 'Lee', isMe: false },
  ];
  assert.deepEqual(c.guessPeople("I'll send Dana the invoice by Friday", people), { ownerId: 'me', toId: 'dana' });
  assert.deepEqual(c.guessPeople('Lee will email me the figures', people), { ownerId: 'lee', toId: 'me' });
  assert.deepEqual(c.guessPeople('Lee will send Dana the figures', people), { ownerId: 'lee', toId: 'dana' });
  assert.deepEqual(c.guessPeople("I'll tell Dana and Lee", people), { ownerId: 'me', toId: null }, 'two people named: no guess');
  assert.deepEqual(c.guessPeople('The room gets booked', people), { ownerId: null, toId: null });
  // Fixed after the first evaluation run (docs/evaluation.md); these sentences are new, not the evaluation's.
  assert.deepEqual(c.guessPeople('Lee wants me to check the figures by Monday', people), { ownerId: 'me', toId: 'lee' });
  assert.deepEqual(c.guessPeople('Dana reminded us to file the expenses', people), { ownerId: 'me', toId: 'dana' });
  assert.deepEqual(c.guessPeople('Lee will proofread my report', people), { ownerId: 'lee', toId: 'me' });
  assert.deepEqual(c.guessPeople('Lee will send Dana my notes', people), { ownerId: 'lee', toId: 'dana' }, '"my" with two people named says nothing');
  assert.deepEqual(c.guessPeople("After Lee signs, I'll file the paperwork", people), { ownerId: 'me', toId: null });
  assert.deepEqual(c.guessPeople("Once Lee approves, I'll send Dana the brief", people), { ownerId: 'me', toId: 'dana' });
  // The quote the cloud model returned on 2026-11-15: Lee is who it waits for, not who it is for.
  assert.deepEqual(c.guessPeople("I'll send Dana the proposal Friday, once Lee confirms pricing", people), { ownerId: 'me', toId: 'dana' });
});

test('a new commitment\'s wording leaves out its recipient, who has a field of their own', () => {
  const dana = { id: 'dana', name: 'Dana', aliases: ['D.W.'] };
  assert.equal(c.withoutRecipient('Send Dana the invoice', dana), 'Send the invoice');
  assert.equal(c.withoutRecipient('send the invoice to Dana', dana), 'Send the invoice');
  assert.equal(c.withoutRecipient('Book a room for Dana', dana), 'Book a room');
  assert.equal(c.withoutRecipient('Email D.W. the figures', dana), 'Email the figures');
  assert.equal(c.withoutRecipient("Review Dana's draft", dana), "Review Dana's draft", 'a possessive is part of what it is');
  assert.equal(c.withoutRecipient('Send the invoice to Danae', dana), 'Send the invoice to Danae');
  assert.equal(c.withoutRecipient('Call Dana', dana), 'Call Dana', 'never shorter than a verb and an object');
  // Seen on the device: "Dana owes me a ticket to the Wizard of Oz" worded as the user sending it.
  assert.equal(c.withoutOwner('Send Dana a ticket to the Wizard of Oz', dana), 'Send a ticket to the Wizard of Oz');
  assert.equal(c.withoutOwner('Get a ticket for Dana', dana), 'Get a ticket');
  assert.equal(c.withoutOwner("Review Dana's draft", dana), "Review Dana's draft");
  assert.equal(c.withoutOwner('Send a ticket to the Wizard of Oz', dana), 'Send a ticket to the Wizard of Oz');
});

test("a wording keeps the note's preposition in front of the note's own words", () => {
  const note = 'Dana owes me a ticket to the Wizard of Oz';
  // Seen on the device, twice: "to" became "from".
  assert.equal(c.notesPrepositions('Get a ticket from the Wizard of Oz', note), 'Get a ticket to the Wizard of Oz');
  assert.equal(c.notesPrepositions('Get a ticket to the Wizard of Oz', note), 'Get a ticket to the Wizard of Oz');
  assert.equal(c.notesPrepositions('Book a room for the offsite', 'Lee will book a room at the offsite'), 'Book a room at the offsite');
  // One word after it is not enough to tell ("to Dana" in "send Dana the invoice").
  assert.equal(c.notesPrepositions('Send the invoice to Dana', "I'll send Dana the invoice"), 'Send the invoice to Dana');
  // Words the note does not have, or has after different prepositions, are left alone.
  assert.equal(c.notesPrepositions('Call about the venue', 'Sam will ring me tomorrow'), 'Call about the venue');
  assert.equal(c.notesPrepositions('Send notes to the team', 'notes from the team, then notes to the team'), 'Send notes to the team');
  assert.equal(c.notesPrepositions('Write up notes from the team', 'notes from the team, then notes to the team'), 'Write up notes from the team');
  assert.equal(c.withoutRecipient('Send Dana the invoice', null), 'Send Dana the invoice');
});

test('candidates: open commitments only, fixed labels, the relevant ones when there are too many', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const first = await c.prepare(q, 'Dana agreed we can send the proposal Tuesday.');
  assert.deepEqual(first.candidates.map((x) => [x.what, x.owner, x.to, x.due]), [
    ['Send the proposal', 'me', 'Dana', 'Friday'],
    ['Confirm pricing', 'Lee', 'me', ''],
  ]);
  assert.equal(first.leftOut, 0);
  assert.equal(new Set(first.candidates.map((x) => x.label)).size, 2);
  assert.match(first.candidates[0].label, /^[A-Z]\d$/);

  const cut = await c.prepare(q, "Lee's pricing is delayed.", { max: 1 });
  assert.deepEqual(cut.candidates.map((x) => x.what), ['Confirm pricing']);
  assert.equal(cut.leftOut, 1);
  const label = (list, what) => list.candidates.find((x) => x.what === what).label;
  assert.equal(label(cut, 'Confirm pricing'), label(first, 'Confirm pricing'), 'a label does not depend on the list');
});

test('an empty store gets the user as its first person', async () => {
  const q = open();
  const { people, candidates } = await c.prepare(q, 'Anything.');
  assert.deepEqual(people.map((p) => [p.name, p.isMe]), [['Me', true]]);
  assert.deepEqual(candidates, []);
  assert.equal((await c.prepare(q, 'Again.')).people.length, 1);
  assert.equal((await c.addPerson(q, ' Dana ')).outcome, 'added');
  assert.equal((await c.addPerson(q, 'dana')).outcome, 'exists');
  assert.equal((await c.addPerson(q, '  ')).outcome, 'empty');
});

test('a clean answer becomes a proposal with the date resolved, and accepted state is untouched', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'Dana says Thursday is fine for the proposal.';
  const ready = await c.prepare(q, text);
  const proposal = ready.candidates.find((x) => x.what === 'Send the proposal');
  const answer = { items: [{ quote: 'Thursday is fine for the proposal', about: proposal.label, change: 'new deadline', due: 'Thursday', what: '' }] };
  const result = await c.capture(q, { text, kind: 'message', answer, shape: 'v2', ...ready, ...WHEN });

  assert.equal(result.usable, true);
  assert.deepEqual(result.pending, []);
  assert.equal(result.recorded.added.length, 1);
  assert.ok((await summaries(q)).includes('Move the deadline of "Send the proposal" from Friday (2026-11-20) to Thursday (2026-11-26).'));
  const kept = (await r.commitments(q)).find((x) => x.what === 'Send the proposal');
  assert.equal(kept.due, '2026-11-20', 'nothing is applied before review');

  const [note] = await q('MATCH (n:Note {id: $id})-[:INVOLVES]->(p:Person) RETURN n.kind AS kind, n.extractedBy AS by, p.name AS name', { id: result.session.noteId });
  assert.deepEqual(note, { kind: 'message', by: 'model', name: 'Dana' });
});

test('a deadline whose words have no single date is proposed with the words alone', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'The proposal is pushed back to next week.';
  const ready = await c.prepare(q, text);
  const proposal = ready.candidates.find((x) => x.what === 'Send the proposal');
  const answer = { items: [{ quote: 'pushed back to next week', about: proposal.label, change: 'new deadline', due: 'next week', what: '' }] };
  await c.capture(q, { text, answer, shape: 'v2', ...ready, ...WHEN });
  assert.ok((await summaries(q)).includes('Move the deadline of "Send the proposal" from Friday (2026-11-20) to next week.'));
});

test('a new commitment waits for its people, then becomes a proposal', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = "I'll send Dana the invoice by Friday.";
  const ready = await c.prepare(q, text);
  // The wording the cloud model actually returned in the browser on 2026-11-15.
  const answer = { items: [{ quote: "I'll send Dana the invoice by Friday", about: 'new', change: 'new commitment', due: 'Friday', what: 'Send Dana the invoice' }] };
  const result = await c.capture(q, { text, answer, shape: 'v2', ...ready, ...WHEN });

  const ids = Object.fromEntries(ready.people.map((p) => [p.name, p.id]));
  assert.equal(result.pending.length, 1);
  const [item] = result.pending;
  assert.deepEqual([item.type, item.what, item.dueText, item.due, item.ownerId, item.toId],
    ['new', 'Send the invoice', 'Friday', '2026-11-27', ids.Me, ids.Dana]);
  assert.equal((await r.commitments(q)).length, 2, 'nothing is stored until the people are confirmed');

  const made = await c.proposeNew(q, result.session, item);
  assert.equal(made.added.length, 1);
  assert.ok((await summaries(q)).includes('New commitment: Me owes "Send the invoice" to Dana, due Friday (2026-11-27).'));
  const stored = (await r.commitments(q)).find((x) => x.what === 'Send the invoice');
  assert.equal(stored.review, 'unreviewed');

  await assert.rejects(async () => c.proposeNew(q, result.session, { ...item, ownerId: null }), /who owes/);
  await assert.rejects(async () => c.proposeNew(q, result.session, { ...item, what: ' ' }), /what is promised/);
});

test('names the model gives are matched to people; the guess fills in the rest', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'Lee will email me the figures by Monday. Omar will book the room.';
  const ready = await c.prepare(q, text);
  const answer = { updates: [], newCommitments: [
    { quote: 'Lee will email me the figures by Monday', what: 'Email the figures', owner: 'Lee', to: 'me', due: 'Monday' },
    { quote: 'Omar will book the room', what: 'Book the room', owner: 'Omar', to: '', due: '' },
  ] };
  const { pending } = await c.capture(q, { text, answer, shape: 'v1', ...ready, ...WHEN });
  const ids = Object.fromEntries(ready.people.map((p) => [p.name, p.id]));
  assert.deepEqual(pending.map((p) => [p.what, p.ownerId, p.toId, p.ownerName, p.due]), [
    ['Email the figures', ids.Lee, ids.Me, 'Lee', '2026-11-30'],
    ['Book the room', null, null, 'Omar', null],
  ]);
});

test('two new commitments with the same wording and owner, placed one after the other, stay two', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = "I'll send the report to Dana on Friday and to Lee on Monday.";
  const ready = await c.prepare(q, text);
  const answer = { items: [
    { quote: "I'll send the report to Dana on Friday", about: 'new', change: 'new commitment', due: 'Friday', what: 'Send the report' },
    { quote: 'to Lee on Monday', about: 'new', change: 'new commitment', due: 'Monday', what: 'Send the report' },
  ] };
  const { session, pending } = await c.capture(q, { text, answer, shape: 'v2', ...ready, ...WHEN });
  const ids = Object.fromEntries(ready.people.map((p) => [p.name, p.id]));
  await c.proposeNew(q, session, { ...pending[0], ownerId: ids.Me, toId: ids.Dana });
  const second = await c.proposeNew(q, session, { ...pending[1], ownerId: ids.Me, toId: ids.Lee });
  assert.equal(second.added.length, 1);
  assert.equal(second.skipped.length, 1, 'the first is recognised, not proposed again');
  const reports = (await r.commitments(q)).filter((x) => x.what === 'Send the report');
  assert.deepEqual(reports.map((x) => [x.to, x.due]).sort(), [['Dana', '2026-11-27'], ['Lee', '2026-11-30']]);
});

test('a question is answered with one of its options, and only then proposed', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'It moved to Thursday.';
  const ready = await c.prepare(q, text);
  const answer = { items: [{ quote: 'It moved to Thursday', about: 'unclear', change: 'new deadline', due: 'Thursday', what: '' }] };
  const before = (await summaries(q)).length;
  const { session, pending } = await c.capture(q, { text, answer, shape: 'v2', ...ready, ...WHEN });

  assert.equal((await summaries(q)).length, before, 'a question proposes nothing by itself');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, 'question');
  assert.deepEqual(pending[0].options.map((o) => o.type), ['commitment', 'commitment', 'new', 'all']);
  const blank = pending[0].options.find((o) => o.type === 'new');
  assert.deepEqual([blank.incomplete, blank.what, blank.due], [true, '', '2026-11-26']);

  const pricing = pending[0].options.find((o) => o.type === 'commitment' && ready.candidates.find((x) => x.id === o.commitmentId).what === 'Confirm pricing');
  const made = await c.proposeChange(q, session, [pricing]);
  assert.equal(made.added.length, 1);
  assert.ok((await summaries(q)).includes('Move the deadline of "Confirm pricing" from no date to Thursday (2026-11-26).'));
});

test('"all" proposes the change on every commitment offered', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'Both are done.';
  const ready = await c.prepare(q, text);
  const answer = { items: [{ quote: 'Both are done', about: 'unclear', change: 'done', due: '', what: '' }] };
  const { session, pending } = await c.capture(q, { text, answer, shape: 'v2', ...ready, ...WHEN });
  const made = await c.proposeChange(q, session, pending[0].options.filter((o) => o.type === 'commitment'));
  assert.equal(made.added.length, 2);
  const now = await summaries(q);
  assert.ok(now.includes('Mark "Send the proposal" as done.') && now.includes('Mark "Confirm pricing" as done.'));
});

test('an answer that cannot be used still stores the note, with the whole note to link by hand', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'Dana moved the proposal to Thursday.';
  const ready = await c.prepare(q, text);
  const before = await summaries(q);
  const { session, pending, usable } = await c.capture(q, { text, answer: { nonsense: true }, shape: 'v2', ...ready, ...WHEN });
  assert.equal(usable, false);
  assert.deepEqual(pending.map((p) => [p.type, p.quote]), [['manual', text]]);
  assert.deepEqual(await summaries(q), before);

  // Linked by hand: the user picks the commitment and the change.
  const proposal = ready.candidates.find((x) => x.what === 'Send the proposal');
  await c.proposeChange(q, session, [{ commitmentId: proposal.id, change: 'new deadline', due: 'Thursday', quote: text }]);
  assert.ok((await summaries(q)).includes('Move the deadline of "Send the proposal" from Friday (2026-11-20) to Thursday (2026-11-26).'));
  await assert.rejects(async () => c.proposeChange(q, session, [{ commitmentId: proposal.id, change: 'new commitment', due: '', quote: text }]), /not a change/);
});

test('a refused entry is linked by hand while the valid ones are proposed', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'Dana moved the proposal to Thursday. Lee confirmed the pricing.';
  const ready = await c.prepare(q, text);
  const [proposal, pricing] = ['Send the proposal', 'Confirm pricing'].map((what) => ready.candidates.find((x) => x.what === what));
  const answer = { items: [
    { quote: 'Dana moved the proposal to Thursday', about: proposal.label, change: 'new deadline', due: '', what: '' },
    { quote: 'Lee confirmed the pricing', about: pricing.label, change: 'done', due: '', what: '' },
  ] };
  const { pending, recorded } = await c.capture(q, { text, answer, shape: 'v2', ...ready, ...WHEN });
  assert.equal(recorded.added.length, 1);
  assert.deepEqual(pending.map((p) => [p.type, p.quote]), [['manual', 'Dana moved the proposal to Thursday']]);
  assert.ok((await summaries(q)).includes('Mark "Confirm pricing" as done.'));
});

test('a new commitment given a listed label is refused, but its reading is one click away', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = "I'll send Dana the invoice by Friday.";
  const ready = await c.prepare(q, text);
  const proposal = ready.candidates.find((x) => x.what === 'Send the proposal');
  // What the cloud model returned in the browser on 2026-11-15, on the second capture of this note.
  const answer = { items: [{ quote: "I'll send Dana the invoice by Friday", about: proposal.label, change: 'new commitment', due: 'Friday', what: 'Send Dana the invoice' }] };
  const before = await summaries(q);
  const { session, pending } = await c.capture(q, { text, answer, shape: 'v2', ...ready, ...WHEN });
  assert.deepEqual(await summaries(q), before, 'nothing is proposed from a contradictory entry');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, 'manual');
  const ids = Object.fromEntries(ready.people.map((p) => [p.name, p.id]));
  const said = pending[0].saidNew;
  assert.deepEqual([said.type, said.what, said.ownerId, said.toId, said.due], ['new', 'Send the invoice', ids.Me, ids.Dana, '2026-11-27']);
  await c.proposeNew(q, session, said);
  assert.ok((await summaries(q)).includes('New commitment: Me owes "Send the invoice" to Dana, due Friday (2026-11-27).'));
});

test('a captured meeting is the baseline for "what changed since"', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'Met Dana. Nothing new.';
  const ready = await c.prepare(q, text);
  await c.capture(q, { text, kind: 'meeting', answer: { items: [] }, shape: 'v2', ...ready, ...WHEN });
  const dana = ready.people.find((p) => p.name === 'Dana').id;
  const baseline = await m.meetingBaseline(q, { personId: dana, now: '2026-11-25T16:00:00Z' });
  assert.ok(baseline.since.startsWith('2026-11-25T15:00'));
});

test('dates: a meal or "at the latest" around a day does not stop it resolving', () => {
  assert.equal(c.resolveDate('tomorrow lunch', '2026-11-25'), '2026-11-26');
  assert.equal(c.resolveDate('Friday at the latest', '2026-11-25'), '2026-11-27');
});

test('a commitment owed to the user is not worded as the user sending it', async () => {
  const q = open();
  await r.seedDemo(q, DEMO);
  const text = 'Dana owes me a ticket to the Wizard of Oz';
  const ready = await c.prepare(q, text);
  // The device model's reading on 2026-11-18, on the user's own note.
  const answer = { items: [{ quote: text, about: 'new', change: 'new commitment', due: '', what: 'Send Dana a ticket to the Wizard of Oz' }] };
  const result = await c.capture(q, { text, answer, shape: 'v2', ...ready, ...WHEN });
  const ids = Object.fromEntries(ready.people.map((p) => [p.name, p.id]));
  const [item] = result.pending;
  assert.deepEqual([item.type, item.what, item.ownerId, item.toId], ['new', 'Send a ticket to the Wizard of Oz', ids.Dana, ids.Me]);
  // The second device reading of the same note.
  const again = await c.capture(q, { text, answer: { items: [{ ...answer.items[0], what: 'Get a ticket from the Wizard of Oz' }] }, shape: 'v2', ...ready, ...WHEN });
  assert.equal(again.pending[0].what, 'Get a ticket to the Wizard of Oz');
});
