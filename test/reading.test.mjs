// Runtime validation of a model's answer, and the path from answer to
// proposals. The malformed answers here are ones a model actually returned
// in the linking experiment (docs/linking-experiment.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateReading, readNote, toExtraction } from '../src/reading.js';
import * as m from '../src/model.js';

const candidates = [
  { label: 'K7', id: 'id-proposal', what: 'Send the proposal', owner: 'me', to: 'Dana' },
  { label: 'R2', id: 'id-contract', what: 'Send the contract', owner: 'me', to: 'Dana' },
  { label: 'Q4', id: 'id-venue', what: 'Book the venue', owner: 'Omar', to: 'me' },
];
const note = 'Dana agreed we can send the proposal Tuesday. Omar booked the venue for the 3rd.';
const v1 = (answer, text = note) => validateReading(answer, { shape: 'v1', candidates, note: text });
const v2 = (answer, text = note) => validateReading(answer, { shape: 'v2', candidates, note: text });
const up = (commitment, change, due, quote) => ({ quote, commitment, change, due });
const item = (about, change, due, quote, what = '') => ({ quote, about, change, due, what });
const reasons = (result) => result.problems.map((p) => p.reason);

test('a good answer passes in either shape, and comes out in one shape', () => {
  const a = v1({ updates: [up('K7', 'new deadline', 'Tuesday', 'send the proposal Tuesday'), up('Q4', 'done', '', 'Omar booked the venue')], newCommitments: [] });
  const b = v2({ items: [item('K7', 'new deadline', 'Tuesday', 'send the proposal Tuesday'), item('Q4', 'done', '', 'Omar booked the venue')] });
  assert.deepEqual([a.ok, a.problems, a.manual], [true, [], []]);
  assert.deepEqual(a.updates, b.updates);
  assert.deepEqual(a.updates.map((u) => [u.commitment, u.change, u.due]), [['K7', 'new deadline', 'Tuesday'], ['Q4', 'done', '']]);
});

test('an answer that is not the expected shape is unusable, and the whole note goes to manual linking', () => {
  for (const bad of [null, 'text', [], {}, { updates: [] }, { updates: 'none', newCommitments: [] }]) {
    const r = v1(bad);
    assert.deepEqual([r.ok, r.updates, r.manual.length, r.manual[0].quote], [false, [], 1, note]);
  }
  assert.equal(v2({ updates: [], newCommitments: [] }).ok, false);
});

test('an unknown key at the top is ignored and noted; inside an entry it refuses the entry', () => {
  // Seen: the schema's own "required" copied into the answer.
  const leak = v1({ updates: [up('K7', 'new deadline', 'Tuesday', 'send the proposal Tuesday')], newCommitments: [], required: ['updates', 'newCommitments'] });
  assert.deepEqual([leak.ok, leak.updates.length, reasons(leak)], [true, 1, ['ignored unknown key "required" in the answer']]);
  // Seen: keys that are not in the schema, beside a broken value.
  const broken = v1({ updates: [{ quote: 'Omar booked the venue for the 3rd.', commitment: 'Q4', change: 'cancelled', due: '},{', commitment_id: 'Q4', change_description: 'x' }], newCommitments: [] });
  assert.deepEqual([broken.updates, broken.manual.length], [[], 1]);
  assert.match(reasons(broken)[0], /unknown field "commitment_id"/);
});

test('a missing field, or one that is not text, refuses the entry', () => {
  const r = v1({ updates: [{ quote: 'send the proposal Tuesday', commitment: 'K7', change: 'new deadline' }, { quote: 'x', commitment: 'K7', change: 'done', due: 3 }, 'K7'], newCommitments: [] });
  assert.deepEqual([r.updates, r.manual.length], [[], 3]);
  assert.deepEqual(reasons(r), ['"due" is missing or not text', '"due" is missing or not text', 'not an object']);
});

test('a commitment the model was not given is refused', () => {
  const r = v2({ items: [item('Z9', 'done', '', 'Omar booked the venue'), item('id-venue', 'done', '', 'Omar booked the venue')] });
  assert.deepEqual([r.updates, r.manual.length], [[], 2]);
  assert.match(reasons(r)[0], /"Z9" is not a commitment the model was given/);
});

test('the kind of change has to fit what it is about', () => {
  // Seen: a listed commitment with the change "new commitment".
  const r = v2({ items: [
    item('Q4', 'new commitment', '', 'Omar booked the venue', 'Meeting online'),
    item('new', 'done', '', 'Omar booked the venue', 'Book something'),
    item('unclear', 'new commitment', '', 'Omar booked the venue'),
    item('K7', 'postponed', 'Tuesday', 'send the proposal Tuesday'),
  ] });
  assert.deepEqual([r.updates, r.newCommitments, r.manual.length], [[], [], 4]);
  assert.deepEqual(reasons(r), [
    'an existing commitment cannot be "new commitment"', 'something new cannot be "done"',
    'an existing commitment cannot be "new commitment"', 'an existing commitment cannot be "postponed"',
  ]);
});

test('a new deadline needs a date, and a new commitment has to say what it is', () => {
  const r = v2({ items: [item('K7', 'new deadline', ' ', 'send the proposal Tuesday'), item('new', 'new commitment', 'Friday', 'Omar booked the venue', '  ')] });
  assert.deepEqual(reasons(r), ['a new deadline has no date', 'a new commitment does not say what it is']);
  // The refused entry keeps its own words for the user, since they are in the note.
  assert.deepEqual(r.manual.map((x) => x.quote), ['send the proposal Tuesday', 'Omar booked the venue']);
});

test('the quote has to be in the note', () => {
  const r = v1({ updates: [up('K7', 'new deadline', 'Tuesday', 'Dana wants the proposal on Tuesday'), up('Q4', 'done', '', '')],
    newCommitments: [{ quote: '', what: 'send the invoice', owner: '', to: 'Dana', due: '' }] });
  assert.deepEqual([r.updates, r.newCommitments], [[], []]);
  assert.deepEqual(reasons(r), ['the quote is not in the note', 'there is no quote', 'there is no quote']);
  // With no usable quote, the user is shown the whole note.
  assert.deepEqual(r.manual.map((x) => x.quote), [note, note, note]);
  // Case and punctuation do not matter.
  assert.equal(v2({ items: [item('K7', 'new deadline', 'Tuesday', 'SEND the proposal, Tuesday!')] }).updates.length, 1);
});

test('a date on "done" or "cancelled" is dropped', () => {
  // Seen: "Sent Dana the contract this morning" returned as done with due "morning".
  const r = v2({ items: [item('Q4', 'done', '3rd', 'Omar booked the venue for the 3rd')] });
  assert.deepEqual(r.updates, [{ quote: 'Omar booked the venue for the 3rd', commitment: 'Q4', change: 'done', due: '' }]);
});

test('the same entry twice is one entry', () => {
  // Seen: the same "done" for the venue returned twice.
  const r = v1({ updates: [up('Q4', 'done', '3rd', 'Omar booked the venue for the 3rd.'), up('Q4', 'done', '3rd', 'Omar booked the venue for the 3rd.')], newCommitments: [] });
  assert.deepEqual([r.updates.length, r.manual, reasons(r)], [1, [], ['1 repeated entries dropped']]);
});

test('two different changes to one commitment are a conflict: neither is proposed', () => {
  // Seen: one commitment returned as a new deadline, done and cancelled from the same sentence.
  const q = 'Omar booked the venue for the 3rd.';
  const r = v1({ updates: [up('Q4', 'new deadline', '3rd', q), up('Q4', 'done', '', q), up('Q4', 'cancelled', '', q), up('Q4', 'done', '', q), up('K7', 'new deadline', 'Tuesday', 'send the proposal Tuesday')], newCommitments: [] });
  assert.deepEqual(r.updates.map((u) => u.commitment), ['K7']);
  assert.equal(r.manual.length, 1);
  assert.deepEqual([r.manual[0].commitment, r.manual[0].options.map((o) => o.change)], ['Q4', ['new deadline', 'done', 'cancelled']]);
  // Two different dates are a conflict too.
  const dates = v2({ items: [item('K7', 'new deadline', 'Tuesday', 'send the proposal Tuesday'), item('K7', 'new deadline', 'Wednesday', 'the proposal Tuesday')] });
  assert.deepEqual([dates.updates, dates.manual[0].options.map((o) => o.due)], [[], ['Tuesday', 'Wednesday']]);
});

test('an answer with far too many entries for one note is unusable', () => {
  const many = { updates: Array.from({ length: 13 }, (_, i) => up('Q4', 'done', '', `Omar booked the venue ${i}`)), newCommitments: [] };
  const r = v1(many);
  assert.deepEqual([r.ok, r.updates, r.manual[0].quote], [false, [], note]);
});

test('readNote: a clean proposal still carries the alternatives', () => {
  const r = readNote({ items: [item('K7', 'new deadline', 'Tuesday', 'send the proposal Tuesday')] }, { shape: 'v2', candidates, note });
  assert.deepEqual(r.proposals.map((p) => [p.commitmentId, p.change, p.due]), [['id-proposal', 'new deadline', 'Tuesday']]);
  assert.deepEqual(r.proposals[0].alternatives.map((a) => a.label), ['R2', 'Q4']);
  assert.deepEqual([r.questions, r.manual], [[], []]);
});

test('readNote: a question the model asks offers every commitment, "new" and "all"', () => {
  const r = readNote({ items: [item('unclear', 'new deadline', 'Tuesday', 'send the proposal Tuesday')] }, { shape: 'v2', candidates, note });
  assert.deepEqual(r.proposals, []);
  assert.deepEqual(r.questions.map((q) => [q.from, q.options.map((o) => o.label ?? o.type)]), [['model', ['K7', 'R2', 'Q4', 'new', 'all']]]);
  const [first] = r.questions[0].options;
  assert.deepEqual(first, { type: 'commitment', commitmentId: 'id-proposal', label: 'K7', change: 'new deadline', due: 'Tuesday', quote: 'send the proposal Tuesday' });
  // The model named nothing new, so that option is for the user to fill in.
  assert.deepEqual(r.questions[0].options.find((o) => o.type === 'new').incomplete, true);
});

test('readNote: the app rules turn the same change on two commitments into one question', () => {
  const text = 'Dana moved it to Tuesday.';
  const r = readNote({ updates: [up('K7', 'new deadline', 'Tuesday', text), up('R2', 'new deadline', 'Tuesday', text)], newCommitments: [] }, { shape: 'v1', candidates, note: text });
  assert.deepEqual(r.proposals, []);
  assert.deepEqual(r.questions.map((q) => [q.from, q.options.map((o) => o.commitmentId ?? o.type)]), [['app rule', ['id-proposal', 'id-contract', 'all']]]);
});

test('readNote: an unusable answer gives nothing but the note to link by hand', () => {
  const r = readNote({ items: 'none' }, { shape: 'v2', candidates, note });
  assert.deepEqual([r.ok, r.proposals, r.created, r.questions, r.manual.length], [false, [], [], [], 1]);
});

test('validated proposals reach the store as proposals: nothing accepted changes', async () => {
  const { Database } = createRequire(import.meta.url)('@relate/relate');
  const conn = Database.open(join(mkdtempSync(join(tmpdir(), 'kept-reading-')), 'store.rl')).connect();
  const q = (cypher, params) => conn.query(cypher, params ?? {}).rows;
  const me = await m.createPerson(q, { name: 'Me', isMe: true });
  const proposal = await m.addCommitment(q, { what: 'Send the proposal', ownerId: me, due: '2026-11-20', dueText: 'Friday' });
  const contract = await m.addCommitment(q, { what: 'Send the contract', ownerId: me, due: '2026-11-20', dueText: 'Friday' });
  const stored = [{ label: 'K7', id: proposal.commitmentId, what: 'Send the proposal', to: '' }, { label: 'R2', id: contract.commitmentId, what: 'Send the contract', to: '' }];
  const text = 'Dana agreed we can send the proposal Tuesday. The contract went out this morning.';
  const noteId = await m.createNote(q, { text, occurredAt: '2026-11-19T09:00:00Z' });

  // A v1 answer with one good update, one refused, and one conflict.
  const reading = readNote({
    updates: [
      up('K7', 'new deadline', 'Tuesday', 'send the proposal Tuesday'),
      up('Z9', 'done', '', 'The contract went out this morning'),
      up('R2', 'done', '', 'The contract went out this morning'),
      up('R2', 'cancelled', '', 'The contract went out this morning'),
    ],
    newCommitments: [],
  }, { shape: 'v1', candidates: stored, note: text });
  assert.deepEqual([reading.proposals.length, reading.manual.length], [1, 2]);

  const { assertions, complete } = toExtraction(reading);
  assert.equal(complete, false);
  const result = await m.recordExtraction(q, noteId, assertions, { candidateIds: stored.map((c) => c.id), complete });
  assert.deepEqual([result.added.length, result.invalid.length], [1, 0]);
  const queue = await m.reviewQueue(q);
  assert.deepEqual(queue.map((r) => [r.id, r.kind, r.dueText]), [[proposal.commitmentId, 'deadline', 'Tuesday']]);
  // The accepted state is untouched: both still open and due Friday.
  const state = await q('MATCH (c:Commitment) RETURN c.what AS what, c.status AS status, toString(c.due) AS due ORDER BY what');
  assert.deepEqual(state, [
    { what: 'Send the contract', status: 'open', due: '2026-11-20' },
    { what: 'Send the proposal', status: 'open', due: '2026-11-20' },
  ]);
});

// --- Cases from the review of the validation boundary ---

function store() {
  const { Database } = createRequire(import.meta.url)('@relate/relate');
  const conn = Database.open(join(mkdtempSync(join(tmpdir(), 'kept-reading-')), 'store.rl')).connect();
  return (cypher, params) => conn.query(cypher, params ?? {}).rows;
}

test('an invalid re-reading does not withdraw the proposal an earlier reading made', async () => {
  const q = store();
  const me = await m.createPerson(q, { name: 'Me', isMe: true });
  const proposal = await m.addCommitment(q, { what: 'Send the proposal', ownerId: me, due: '2026-11-20', dueText: 'Friday' });
  const stored = [{ label: 'K7', id: proposal.commitmentId, what: 'Send the proposal', to: '' }];
  const text = 'Dana agreed we can send the proposal Tuesday.';
  const noteId = await m.createNote(q, { text, occurredAt: '2026-11-19T09:00:00Z' });
  const options = { shape: 'v2', candidates: stored, note: text };
  const write = (reading) => {
    const { assertions, complete } = toExtraction(reading);
    return m.recordExtraction(q, noteId, assertions, { candidateIds: [proposal.commitmentId], complete });
  };

  const good = readNote({ items: [item('K7', 'new deadline', 'Tuesday', 'send the proposal Tuesday')] }, options);
  assert.deepEqual([toExtraction(good).complete, toExtraction(good).withheld], [true, []]);
  assert.equal((await write(good)).added.length, 1);

  // Read again, and this time the entry is malformed: no date.
  const bad = readNote({ items: [item('K7', 'new deadline', '', 'send the proposal Tuesday')] }, options);
  assert.deepEqual([bad.proposals, bad.manual.length], [[], 1]);
  const extraction = toExtraction(bad);
  assert.deepEqual([extraction.assertions, extraction.complete, extraction.withheld], [[], false, ['1 to link by hand']]);
  const second = await write(bad);
  assert.deepEqual([second.withdrawn, second.kept.map((k) => k.reason)], [[], ['the reading was incomplete']]);
  assert.deepEqual((await m.reviewQueue(q)).map((r) => [r.kind, r.dueText]), [['deadline', 'Tuesday']]);

  // The same holds when the re-reading turns into a question, or is unusable.
  const asked = readNote({ items: [item('unclear', 'new deadline', 'Tuesday', 'send the proposal Tuesday')] }, options);
  assert.equal(toExtraction(asked).complete, false);
  assert.deepEqual((await write(asked)).withdrawn, []);
  const unusable = readNote({ items: 'none' }, options);
  assert.deepEqual([toExtraction(unusable).complete, (await write(unusable)).withdrawn], [false, []]);
  assert.equal((await m.reviewQueue(q)).length, 1);

  // A complete reading that really says nothing does withdraw it.
  const nothing = readNote({ items: [] }, options);
  assert.equal(toExtraction(nothing).complete, true);
  assert.equal((await write(nothing)).withdrawn.length, 1);
  assert.deepEqual(await m.reviewQueue(q), []);
});

test('a reading with a new commitment is not complete: the new commitment is not among the assertions', () => {
  const text = "I'll send Dana the invoice by Friday.";
  const r = readNote({ items: [item('new', 'new commitment', 'Friday', text, 'Send the invoice')] }, { shape: 'v2', candidates, note: text });
  assert.deepEqual([r.created.length, toExtraction(r).complete, toExtraction(r).withheld], [1, false, ['1 new commitment(s) not yet matched to people']]);
});

test('two new commitments that differ only in the owner stay two', () => {
  const text = 'Lee and Sam will each send Dana the report Friday.';
  const one = (owner) => ({ quote: text, what: 'Send the report', owner, to: 'Dana', due: 'Friday' });
  const r = readNote({ updates: [], newCommitments: [one('Lee'), one('Sam'), one('Sam')] }, { shape: 'v1', candidates, note: text });
  assert.deepEqual(r.created.map((n) => n.owner), ['Lee', 'Sam']);
  // The same holds for the recipient and the date.
  const others = validateReading({ updates: [], newCommitments: [one('Lee'), { ...one('Lee'), to: 'Omar' }, { ...one('Lee'), due: 'Monday' }] }, { shape: 'v1', candidates, note: text });
  assert.equal(others.newCommitments.length, 3);
});

test('a question keeps the complete new commitment behind its "new" option', () => {
  // The sentence mentions the proposal, so the change is not dropped as the new commitment said twice.
  const text = "I'll send Dana the invoice with the proposal by Friday.";
  const invoice = { quote: "I'll send Dana the invoice", what: 'Send invoice', owner: 'me', to: 'Dana', due: 'Friday' };
  const r = readNote({ updates: [up('K7', 'new deadline', 'Friday', text)], newCommitments: [invoice] }, { shape: 'v1', candidates, note: text });
  assert.deepEqual([r.proposals, r.created, r.questions.length], [[], [], 1]);
  const [question] = r.questions;
  assert.deepEqual(question.options.map((o) => o.type), ['commitment', 'new', 'all']);
  // Choosing the commitment gives the whole update; choosing "new" gives the whole new commitment.
  assert.deepEqual(question.options[0], { type: 'commitment', commitmentId: 'id-proposal', label: 'K7', change: 'new deadline', due: 'Friday', quote: text });
  assert.deepEqual(question.options[1], { type: 'new', ...invoice });
});

test('device route: a change that mentions none of its commitments, beside a new commitment from the same words, is dropped', () => {
  // New sentences; round 1 on the device model had this shape with slides and a forecast.
  const text = "I'll send Omar the seating chart by Monday.";
  const chart = { quote: "I'll send Omar the seating chart", what: 'Send the seating chart', owner: 'me', to: 'Omar', due: 'Monday' };
  for (const update of [up('K7', 'new deadline', 'Monday', text), up('unclear', 'new deadline', 'Monday', text)]) {
    const r = readNote({ updates: [update], newCommitments: [chart] }, { shape: 'v1', candidates, note: text });
    assert.deepEqual([r.proposals, r.questions, r.created.map((n) => n.what)], [[], [], ['Send the seating chart']], update.commitment);
  }
  // Without a new commitment from the same words, it is still asked about.
  const alone = readNote({ updates: [up('K7', 'new deadline', 'Monday', text)], newCommitments: [] }, { shape: 'v1', candidates, note: text });
  assert.equal(alone.questions.length, 1);
});

test('a placeholder date is no date: a dependency read as a deadline is not proposed', () => {
  // New sentence; round 4 on the device model gave "not set" as the date.
  const text = 'I can only print the menus once Dana confirms the wine.';
  for (const due of ['not set', 'None', 'n/a']) {
    const r = readNote({ updates: [up('K7', 'new deadline', due, text)], newCommitments: [] }, { shape: 'v1', candidates, note: text });
    assert.deepEqual([r.proposals, r.questions, r.manual], [[], [], []], due);
  }
});

test('two new commitments folded into one question are both kept', () => {
  const text = 'The proposal goes to Dana on Tuesday and the contract on Thursday.';
  const r = readNote({
    updates: [up('K7', 'new deadline', 'Tuesday', text)],
    newCommitments: [{ quote: text, what: 'Proposal to go to Dana', owner: 'me', to: 'Dana', due: 'Tuesday' }, { quote: text, what: 'Contract to go', owner: 'me', to: 'Dana', due: 'Thursday' }],
  }, { shape: 'v1', candidates, note: text });
  assert.deepEqual(r.questions[0].options.filter((o) => o.type === 'new').map((o) => [o.what, o.due]), [['Proposal to go to Dana', 'Tuesday'], ['Contract to go', 'Thursday']]);
});

test('rule 1 keeps the owner and recipient of the commitment it asks about', () => {
  const text = 'I sent Dana the contract this morning; I promised to send Dana another contract Friday.';
  const another = { quote: 'I promised to send Dana another contract Friday', what: 'Send the contract', owner: 'me', to: 'Dana', due: 'Friday' };
  const r = readNote({ updates: [up('R2', 'done', '', 'I sent Dana the contract this morning')], newCommitments: [another] }, { shape: 'v1', candidates, note: text });
  // The completion stands as a proposal; the possible repeat is a question.
  assert.deepEqual(r.proposals.map((p) => [p.label, p.change]), [['R2', 'done']]);
  assert.deepEqual(r.questions[0].options, [{ type: 'new', ...another }, { type: 'same', commitmentId: 'id-contract', label: 'R2' }]);
});

test('done or cancelled is not proposed when the words say it waits', async () => {
  const { readNote } = await import('../src/reading.js');
  const candidates = [{ id: 'v', label: 'B3', what: 'Book the venue' }, { id: 'c', label: 'R2', what: 'Send the contract' }];
  // Not the evaluation's sentences: those found the problem, these test the rule.
  const note = "Omar won't book the venue before Lee pays. Sent the contract after lunch.";
  const r = readNote({ items: [
    { quote: "Omar won't book the venue before Lee pays", about: 'B3', change: 'cancelled', due: '', what: '' },
    { quote: 'Sent the contract after lunch', about: 'R2', change: 'done', due: '', what: '' },
  ] }, { shape: 'v2', candidates, note });
  assert.deepEqual(r.proposals.map((p) => [p.label, p.change]), [['R2', 'done']], '"after" alone is not waiting');
  assert.equal(r.manual.length, 1);
  assert.match(r.manual[0].reason, /waits for something/);
});

test('a deadline that is really a dependency: the date part is kept, a bare dependency is left to the dependency reading', async () => {
  const { readNote } = await import('../src/reading.js');
  const candidates = [{ id: 'r', label: 'R1', what: 'Send the report' }, { id: 'm', label: 'M2', what: 'Send the memo' }];
  // New sentences, not the evaluation's.
  const note = 'The report goes out Monday after the board meets. I send the memo once Sam is back.';
  const r = readNote({ items: [
    { quote: 'The report goes out Monday after the board meets', about: 'R1', change: 'new deadline', due: 'Monday after the board meets', what: '' },
    { quote: 'I send the memo once Sam is back', about: 'M2', change: 'new deadline', due: 'once Sam is back', what: '' },
  ] }, { shape: 'v2', candidates, note });
  assert.deepEqual(r.proposals.map((p) => [p.label, p.due]), [['R1', 'Monday']]);
  assert.deepEqual(r.manual, [], 'the bare dependency is not a card');
  assert.match(r.problems.map((p) => p.reason).join(), /left to the dependency reading/);

  // Without a dependency word in the note, a deadline with no date is still refused and linked by hand.
  const plain = readNote({ items: [{ quote: 'The memo moves', about: 'M2', change: 'new deadline', due: '', what: '' }] },
    { shape: 'v2', candidates, note: 'The memo moves.' });
  assert.equal(plain.manual.length, 1);
});

test('the future, or waiting, is not done or cancelled', async () => {
  const { readNote } = await import('../src/reading.js');
  const candidates = [{ id: 'x', label: 'X1', what: 'File the expenses' }, { id: 'y', label: 'Y2', what: 'Print the badges' }, { id: 'z', label: 'Z3', what: 'Order the chairs' }];
  // New sentences, not the evaluation's.
  const note = "Sam will file the expenses once the receipts arrive. The badges are blocked on the logo. I'll drop the memo. Ordered the chairs.";
  const r = readNote({ items: [
    { quote: 'Sam will file the expenses once the receipts arrive', about: 'X1', change: 'done', due: '', what: '' },
    { quote: 'The badges are blocked on the logo', about: 'Y2', change: 'cancelled', due: '', what: '' },
    { quote: 'Ordered the chairs', about: 'Z3', change: 'done', due: '', what: '' },
  ] }, { shape: 'v2', candidates, note });
  assert.deepEqual(r.proposals.map((p) => [p.label, p.change]), [['Z3', 'done']]);
  assert.equal(r.manual.length, 2);
});

test('words that follow "until" or "once" are a condition, not news', async () => {
  const { readNote } = await import('../src/reading.js');
  const candidates = [{ id: 'k', label: 'K1', what: 'Sign the lease' }, { id: 'p', label: 'P2', what: 'Pay the deposit' }];
  // New sentences, not the evaluation's.
  const note = 'Movers come once Sam signs the lease. Paid the deposit.';
  const r = readNote({ items: [
    { quote: 'Sam signs the lease', about: 'K1', change: 'done', due: '', what: '' },
    { quote: 'Paid the deposit', about: 'P2', change: 'done', due: '', what: '' },
  ] }, { shape: 'v2', candidates, note });
  assert.deepEqual(r.proposals.map((p) => p.label), ['P2']);
  assert.equal(r.manual.length, 1);
});

test('a change whose words do not mention the commitment becomes a question: that one, or new', async () => {
  const { readNote } = await import('../src/reading.js');
  const candidates = [{ id: 'p', label: 'P1', what: 'Send the proposal' }, { id: 'b', label: 'B2', what: 'Review the budget' }];
  // New sentences: the live test on 2026-11-15 had this shape with a contract.
  const note = "I'll send Dana the invoice on Monday. Priya moved the budget review to Friday.";
  const r = readNote({ items: [
    { quote: "I'll send Dana the invoice on Monday", about: 'P1', change: 'new deadline', due: 'Monday', what: '' },
    { quote: 'Priya moved the budget review to Friday', about: 'B2', change: 'new deadline', due: 'Friday', what: '' },
  ] }, { shape: 'v2', candidates, note });
  assert.deepEqual(r.proposals.map((p) => p.label), ['B2']);
  assert.equal(r.questions.length, 1);
  assert.deepEqual(r.questions[0].options.map((o) => [o.type, o.label ?? '', o.due ?? '']), [['commitment', 'P1', 'Monday'], ['new', '', 'Monday']]);
});

test('a refused new commitment that repeats a commitment the reading updates is not a card', async () => {
  const { readNote } = await import('../src/reading.js');
  const candidates = [{ id: 'r', label: 'R1', what: 'Send the report', to: 'Sam' }, { id: 'q', label: 'R2', what: 'Send the report', to: 'Omar' }];
  // New sentence; round 4 (device) had this shape with the proposal.
  const note = 'Sam wants the report by Tuesday.';
  const answer = (to) => ({ updates: [{ quote: note, commitment: 'R1', change: 'new deadline', due: 'Tuesday' }],
    newCommitments: [{ quote: 'send the report', what: 'send the report', owner: 'me', to, due: 'Tuesday' }] });
  const r = readNote(answer('Sam'), { shape: 'v1', candidates, note });
  assert.deepEqual(r.proposals.map((p) => p.label), ['R1']);
  assert.deepEqual(r.manual, []);
  // The same wording for someone else is not that commitment: still offered.
  assert.equal(readNote(answer('Priya'), { shape: 'v1', candidates, note }).manual.length, 1);
});

test('a refused new commitment that repeats a valid one is not a card', async () => {
  const { readNote } = await import('../src/reading.js');
  const candidates = [{ id: 'p', label: 'P1', what: 'Send the proposal' }];
  // New sentence; the live test on 2026-11-15 had this shape with a contract.
  const note = "I'll send Sam the invoice on Monday, once Lee confirms pricing.";
  const r = readNote({ items: [
    { quote: "I'll send Sam the invoice on Monday", about: 'new', change: 'new commitment', due: 'Monday', what: 'Send the invoice' },
    { quote: "I'll send Sam the invoice on Monday, once Lee confirms pricing", about: 'P1', change: 'new commitment', due: 'Monday', what: 'Send the invoice' },
  ] }, { shape: 'v2', candidates, note });
  assert.equal(r.created.length, 1);
  assert.deepEqual(r.manual, []);
  // On its own, the contradictory entry is still refused and offered with one click.
  const alone = readNote({ items: [
    { quote: "I'll send Sam the invoice on Monday", about: 'P1', change: 'new commitment', due: 'Monday', what: 'Send the invoice' },
  ] }, { shape: 'v2', candidates, note });
  assert.equal(alone.manual.length, 1);
  assert.equal(alone.manual[0].saidNew.what, 'Send the invoice');
  assert.equal(alone.manual[0].newLike, undefined);
});
