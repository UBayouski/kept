// Dependencies a note states: validation of the answer, and recording it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as m from '../src/model.js';
import * as r from '../src/review-data.js';
import * as c from '../src/capture.js';
import * as d from '../src/dependencies.js';

const { Database } = createRequire(import.meta.url)('@relate/relate');
function open() {
  const conn = Database.open(join(mkdtempSync(join(tmpdir(), 'kept-deps-')), 'store.rl')).connect();
  return (cypher, params) => conn.query(cypher, params ?? {}).rows;
}
const DEMO = { today: new Date('2026-11-25T12:00:00Z') };
const WHEN = { occurredAt: '2026-11-25T15:00:00Z', baseDate: '2026-11-25', now: '2026-11-25T15:05:00Z' };
const dep = (quote, waiting, waitsFor, newWhat = '', newOwner = '') => ({ quote, waiting, waitsFor, newWhat, newOwner });
const summaries = async (q) => (await r.reviewItems(q)).map((i) => i.summary);

test('a call is made only when the note has a word that states a dependency', () => {
  for (const note of ["I'll send it once Lee confirms pricing.", 'After Omar signs, I send it.', 'Waiting on Lee for the numbers.', 'Blocked by legal.']) {
    assert.equal(d.hasCue(note), true, note);
  }
  for (const note of ['Dana says Thursday is fine.', "I'll send Dana the invoice by Friday.", 'Lunch was nice.']) {
    assert.equal(d.hasCue(note), false, note);
  }
});

test('the prompt and schema name only the commitments given', () => {
  const list = [{ label: 'K7', what: 'Send the proposal', owner: 'me', to: 'Dana' }, { label: 'N1', what: 'Send the invoice', owner: 'me', to: 'Dana', isNew: true }];
  const prompt = d.buildPrompt('note text', list);
  assert.match(prompt, /\[K7\] Send the proposal\. Owner: me\. For: Dana\.\n\[N1\] Send the invoice\. Owner: me\. For: Dana\. \(New in this note\.\)/);
  const schema = d.buildSchema(list);
  assert.deepEqual(schema.properties.items.items.properties.waiting.enum, ['K7', 'N1']);
  assert.deepEqual(schema.properties.items.items.properties.waitsFor.enum, ['K7', 'N1', 'new']);
});

test('validation: labels, self-dependency, quotes, and what a new blocker needs', () => {
  const list = [{ label: 'K7', what: 'Send the proposal' }, { label: 'M5', what: 'Confirm pricing' }, { label: 'N1', what: 'Book the venue', isNew: true }];
  const note = "I'll send the proposal once Lee confirms pricing, and book the venue after Omar signs the contract.";
  const { ok, dependencies, problems } = d.readDependencies({ items: [
    dep('once Lee confirms pricing', 'K7', 'M5'),
    dep('once Lee confirms pricing', 'K7', 'M5'),
    dep('after Omar signs the contract', 'N1', 'new', 'Sign the contract', 'Omar'),
    dep('once Lee confirms pricing', 'K7', 'K7'),
    dep('once Lee confirms pricing', 'Z9', 'M5'),
    dep('when pigs fly', 'K7', 'M5'),
    dep('after Omar signs the contract', 'N1', 'new', '', 'Omar'),
    dep('after Omar signs the contract', 'N1', 'new', 'Sign the contract', ''),
    { ...dep('x', 'K7', 'M5'), extra: '' },
  ] }, { list, note });
  assert.equal(ok, true);
  assert.deepEqual(dependencies, [
    { quote: 'once Lee confirms pricing', waiting: 'K7', waitsFor: 'M5' },
    { quote: 'after Omar signs the contract', waiting: 'N1', waitsFor: 'new', newWhat: 'Sign the contract', newOwner: 'Omar' },
  ]);
  assert.deepEqual(problems.map((p) => p.reason), [
    'a repeated dependency was dropped',
    'a commitment cannot wait for itself',
    '"Z9" is not a commitment the model was given',
    'the quote is not in the note',
    'a new commitment to wait for does not say what it is',
    'a new commitment to wait for does not say who does it',
    'unknown field "extra"',
  ]);
  assert.equal(d.readDependencies({ nope: 1 }, { list, note }).ok, false);
});

test('"new" with the words of a commitment new in this note is that commitment', () => {
  const list = [{ label: 'K7', what: 'Send the proposal' }, { label: 'N1', what: 'Confirm pricing', isNew: true }];
  const { dependencies } = d.readDependencies({ items: [dep('once Lee confirms pricing', 'K7', 'new', 'confirm pricing', 'Lee')] },
    { list, note: "I'll send the proposal once Lee confirms pricing." });
  assert.deepEqual(dependencies, [{ quote: 'once Lee confirms pricing', waiting: 'K7', waitsFor: 'N1' }]);
});

test('a commitment cannot wait for a copy of itself, listed or new', () => {
  const list = [{ label: 'K7', what: 'Send the proposal' }, { label: 'N1', what: 'send the proposal', isNew: true }];
  const note = "I'll send Dana the proposal tomorrow, before lunch.";
  const { dependencies, problems } = d.readDependencies({ items: [
    dep('before lunch', 'K7', 'N1'),
    dep('before lunch', 'K7', 'new', 'Send the proposal', 'Me'),
  ] }, { list, note });
  assert.deepEqual(dependencies, []);
  // N1 is a copy of K7, so waiting for it is waiting for itself.
  assert.deepEqual(problems.map((p) => p.reason), ['a commitment cannot wait for itself', 'a commitment cannot wait for a copy of itself']);
  const listed = d.readDependencies({ items: [dep('before lunch', 'K7', 'new', 'Send the proposal', 'Me')] }, { list: [list[0]], note });
  assert.deepEqual(listed.problems.map((p) => p.reason), ['a commitment cannot wait for a copy of itself']);
});

// The demo store with "Send the proposal" no longer waiting on pricing, so a note can state it again.
async function storeWithoutDependency() {
  const q = open();
  await r.seedDemo(q, DEMO);
  await q('MATCH (:Commitment)-[b:BLOCKED_BY]->(:Commitment) DELETE b');
  await q("MATCH (ch:Change {kind: 'blocked'}) DETACH DELETE ch");
  return q;
}
const me = async (q) => (await r.people(q)).find((p) => p.isMe).id;

test('between two commitments already in the store: proposed at once, and answers "waiting on" once accepted', async () => {
  const q = await storeWithoutDependency();
  const text = 'I can only send the proposal once Lee confirms pricing.';
  const ready = await c.prepare(q, text);
  const out = await c.capture(q, { text, answer: { items: [] }, shape: 'v2', ...ready, ...WHEN });
  const list = c.dependencyList(ready.candidates, out.pending);
  const [proposal, pricing] = ['Send the proposal', 'Confirm pricing'].map((what) => list.find((x) => x.what === what).label);
  const deps = await c.addDependencies(q, out.session, { answer: { items: [dep('once Lee confirms pricing', proposal, pricing)] }, list, note: text, people: ready.people });

  assert.deepEqual(deps.pending, []);
  assert.equal(deps.recorded.added.length, 1);
  const item = (await r.reviewItems(q)).find((i) => i.kind === 'blocked');
  assert.equal(item.summary, '"Send the proposal" cannot be done until "Confirm pricing" is.');
  assert.deepEqual(await m.waitingOn(q, { personId: await me(q) }), [], 'nothing waits before it is accepted');
  assert.equal((await m.accept(q, item.changeId)).outcome, 'applied');
  assert.deepEqual((await m.waitingOn(q, { personId: await me(q) })).map((w) => [w.what, w.blockedBy, w.waitingOn]),
    [['Send the proposal', 'Confirm pricing', 'Lee']]);
});

test('the demo sentence into a store with nothing in it yet: two new commitments and the dependency between them', async () => {
  const q = open();
  await c.prepare(q, 'x');
  await c.addPerson(q, 'Dana');
  await c.addPerson(q, 'Lee');
  const text = "I'll send Dana the proposal Friday, once Lee confirms pricing.";
  const ready = await c.prepare(q, text);
  const ids = Object.fromEntries(ready.people.map((p) => [p.name, p.id]));
  // The linking call finds the promise; the dependency call names what it waits for.
  const out = await c.capture(q, { text, kind: 'meeting', shape: 'v2', ...ready, ...WHEN,
    answer: { items: [{ quote: "I'll send Dana the proposal Friday", about: 'new', change: 'new commitment', due: 'Friday', what: 'Send Dana the proposal' }] } });
  const list = c.dependencyList(ready.candidates, out.pending);
  assert.deepEqual(list.map((x) => [x.label, x.what, x.isNew]), [['N1', 'Send the proposal', true]]);

  const deps = await c.addDependencies(q, out.session, { list, note: text, people: ready.people,
    answer: { items: [dep('once Lee confirms pricing', 'N1', 'new', 'Confirm pricing', 'Lee')] } });
  assert.equal(deps.recorded, null, 'nothing is proposed while a side is not in the store');
  const [blocker, link] = deps.pending;
  assert.deepEqual([blocker.type, blocker.what, blocker.ownerId, blocker.toId], ['new', 'Confirm pricing', ids.Lee, ids.Me]);
  assert.deepEqual([link.type, link.waiting.what, link.waitsFor.what], ['dependency', 'Send the proposal', 'Confirm pricing']);

  await assert.rejects(async () => c.proposeDependency(q, out.session, link), /Propose the new commitment "Send the proposal" first/);
  await c.proposeNew(q, out.session, out.pending[0]);
  await assert.rejects(async () => c.proposeDependency(q, out.session, link), /"Confirm pricing" first/);
  await c.proposeNew(q, out.session, blocker);
  const made = await c.proposeDependency(q, out.session, link);
  assert.equal(made.added.length, 1);
  assert.equal(made.invalid.length, 0);

  assert.deepEqual((await summaries(q)).sort(), [
    '"Send the proposal" cannot be done until "Confirm pricing" is.',
    'New commitment: Lee owes "Confirm pricing" to Me.',
    'New commitment: Me owes "Send the proposal" to Dana, due Friday (2026-11-27).',
  ]);
  for (const item of await r.reviewItems(q)) if (item.kind === 'created') await m.accept(q, item.changeId);
  const link2 = (await r.reviewItems(q)).find((i) => i.kind === 'blocked');
  assert.equal((await m.accept(q, link2.changeId)).outcome, 'applied');
  assert.deepEqual((await m.waitingOn(q, { personId: ids.Me })).map((w) => [w.what, w.blockedBy, w.waitingOn, w.blockerDue]),
    [['Send the proposal', 'Confirm pricing', 'Lee', null]]);
});

test('what a note still needs is kept with the note and comes back with its session', async () => {
  const q = open();
  await c.prepare(q, 'x');
  await c.addPerson(q, 'Dana');
  await c.addPerson(q, 'Lee');
  const text = "I'll send Dana the proposal Friday, once Lee confirms pricing.";
  const ready = await c.prepare(q, text);
  const out = await c.capture(q, { text, shape: 'v2', ...ready, ...WHEN,
    answer: { items: [{ quote: "I'll send Dana the proposal Friday", about: 'new', change: 'new commitment', due: 'Friday', what: 'Send the proposal' }] } });
  const list = c.dependencyList(ready.candidates, out.pending);
  const deps = await c.addDependencies(q, out.session, { list, note: text, people: ready.people,
    answer: { items: [dep('once Lee confirms pricing', 'N1', 'new', 'Confirm pricing', 'Lee')] } });
  const items = [...out.pending, ...deps.pending];
  await c.savePending(q, out.session, items);
  assert.deepEqual(await c.loadPending(open()), [], 'another store has none');

  // As after a reload: everything comes from the store.
  const back = await c.loadPending(q);
  assert.deepEqual(back.map((e) => e.item.type), ['new', 'new', 'dependency']);
  assert.equal(back[0].noteText, text);
  assert.ok(back.every((e) => e.session === back[0].session), 'the cards of a note share one session');
  assert.ok(back[0].session.candidateIds instanceof Set);
  const session = back[0].session;
  await c.proposeNew(q, session, back[0].item);
  await c.proposeNew(q, session, back[1].item);
  assert.equal((await c.proposeDependency(q, session, back[2].item)).added.length, 1);

  // Saved again after a card is dealt with; nothing left clears it.
  await c.savePending(q, session, [back[2].item]);
  assert.equal((await c.loadPending(q)).length, 1);
  await c.savePending(q, session, []);
  assert.deepEqual(await c.loadPending(q), []);
});

test('a rejected new commitment cannot be waited for', async () => {
  const q = open();
  await c.prepare(q, 'x');
  await c.addPerson(q, 'Lee');
  const text = "I'll send the proposal once Lee confirms pricing.";
  const ready = await c.prepare(q, text);
  const out = await c.capture(q, { text, shape: 'v2', ...ready, ...WHEN,
    answer: { items: [{ quote: "I'll send the proposal", about: 'new', change: 'new commitment', due: '', what: 'Send the proposal' }] } });
  const list = c.dependencyList(ready.candidates, out.pending);
  const deps = await c.addDependencies(q, out.session, { list, note: text, people: ready.people,
    answer: { items: [dep('once Lee confirms pricing', 'N1', 'new', 'Confirm pricing', 'Lee')] } });
  const [blocker, link] = deps.pending;
  await c.proposeNew(q, out.session, out.pending[0]);
  await c.proposeNew(q, out.session, blocker);
  const created = (await r.reviewItems(q)).find((i) => i.kind === 'created' && i.commitment.what === 'Confirm pricing');
  await m.reject(q, created.changeId);
  const made = await c.proposeDependency(q, out.session, link);
  assert.deepEqual(made.invalid.map((x) => x.reason), ['blocker was rejected']);
});

test('a listed commitment that is someone else\'s action is not what the words wait for', async () => {
  const q = await storeWithoutDependency();
  // The demo store: "Confirm pricing" is Lee's. These words name Dana.
  const text = 'I can only send the proposal once Dana confirms pricing.';
  const ready = await c.prepare(q, text);
  const out = await c.capture(q, { text, answer: { items: [] }, shape: 'v2', ...ready, ...WHEN });
  const list = c.dependencyList(ready.candidates, out.pending);
  const [proposal, pricing] = ['Send the proposal', 'Confirm pricing'].map((what) => list.find((x) => x.what === what).label);
  const deps = await c.addDependencies(q, out.session, { answer: { items: [dep('once Dana confirms pricing', proposal, pricing)] }, list, note: text, people: ready.people });
  assert.equal(deps.recorded, null);
  assert.deepEqual(deps.pending, []);
  assert.match(deps.problems[0].reason, /not the action of the person the words name/);
});

test('a listed commitment is not what waits when the words make someone else wait', async () => {
  const q = await storeWithoutDependency();
  // "Send the proposal" is mine; in these words Dana is the one who waits. New sentence, not the evaluation's.
  const text = "Dana can't forward the proposal until Lee confirms pricing.";
  const ready = await c.prepare(q, text);
  const out = await c.capture(q, { text, answer: { items: [] }, shape: 'v2', ...ready, ...WHEN });
  const list = c.dependencyList(ready.candidates, out.pending);
  const [proposal, pricing] = ['Send the proposal', 'Confirm pricing'].map((what) => list.find((x) => x.what === what).label);
  const deps = await c.addDependencies(q, out.session, { answer: { items: [dep('until Lee confirms pricing', proposal, pricing)] }, list, note: text, people: ready.people });
  assert.equal(deps.recorded, null);
  assert.match(deps.problems[0].reason, /not the action of the person who waits/);
});

test('a listed commitment the words do not mention is not what waits, nor what is waited for', async () => {
  const q = await storeWithoutDependency();
  // The demo store has "Send the proposal" and "Confirm pricing". New sentences, not the evaluation's.
  const run = async (text, waitingWhat, blockerWhat) => {
    const ready = await c.prepare(q, text);
    const out = await c.capture(q, { text, answer: { items: [] }, shape: 'v2', ...ready, ...WHEN });
    const list = c.dependencyList(ready.candidates, out.pending);
    const label = (what) => list.find((x) => x.what === what).label;
    const quote = text.slice(text.search(/once|after|until/));
    return c.addDependencies(q, out.session, { answer: { items: [dep(quote.replace(/\.$/, ''), label(waitingWhat), label(blockerWhat))] }, list, note: text, people: ready.people });
  };
  // The live test on 2026-11-15: the note is about a contract, the model chose the proposal.
  const contract = await run("I'll send Dana the invoice on Monday, once Lee confirms pricing.", 'Send the proposal', 'Confirm pricing');
  assert.equal(contract.recorded, null);
  assert.match(contract.problems[0].reason, /do not mention "Send the proposal" as what waits/);
  const blocker = await run("I'll send Dana the proposal once Lee signs the lease.", 'Send the proposal', 'Confirm pricing');
  assert.match(blocker.problems[0].reason, /dependency do not mention "Confirm pricing"/);
  const right = await run("I'll send Dana the proposals once Lee confirms the pricing.", 'Send the proposal', 'Confirm pricing');
  assert.equal(right.recorded.added.length, 1, 'plural and "the" do not matter');
});

test('when the model picks a listed commitment the words do not mention, the one new commitment they do mention waits instead', async () => {
  const q = await storeWithoutDependency();
  // New sentence; the live test on 2026-11-15 had the same shape.
  const text = "I'll send Dana the invoice on Monday, once Lee confirms pricing.";
  const ready = await c.prepare(q, text);
  const out = await c.capture(q, { text, shape: 'v2', ...ready, ...WHEN,
    answer: { items: [{ quote: "I'll send Dana the invoice on Monday", about: 'new', change: 'new commitment', due: 'Monday', what: 'Send the invoice' }] } });
  const list = c.dependencyList(ready.candidates, out.pending);
  const label = (what) => list.find((x) => x.what === what).label;
  const deps = await c.addDependencies(q, out.session, { list, note: text, people: ready.people,
    answer: { items: [dep('once Lee confirms pricing', label('Send the proposal'), label('Confirm pricing'))] } });
  assert.equal(deps.recorded, null, 'nothing proposed at once: one side is new');
  const [card] = deps.pending;
  assert.deepEqual([card.type, card.waiting.what, card.waitsFor.what], ['dependency', 'Send the invoice', 'Confirm pricing']);
  assert.match(deps.problems[0].reason, /replaced by "Send the invoice"/);
});

test('device copies: a dependency on a listed commitment read again as new is on the listed one; the person named picks the twin', () => {
  const list = [
    { label: 'B1', what: 'Review the budget', owner: 'me', to: 'Priya' },
    { label: 'P1', what: 'Confirm pricing', owner: 'Lee', to: 'me' },
    { label: 'K7', what: 'Send the proposal', owner: 'me', to: 'Dana' },
    { label: 'L7', what: 'Send the proposal', owner: 'me', to: 'Lee' },
    { label: 'V1', what: 'Book the venue', owner: 'Omar', to: 'me' },
    { label: 'N1', what: 'budget review', owner: 'me', to: 'Priya', isNew: true },
  ];
  const copy = d.readDependencies({ items: [dep('once Lee confirms pricing', 'N1', 'P1')] },
    { list, note: "I'll send Priya the budget review once Lee confirms pricing." });
  assert.deepEqual(copy.dependencies.map((x) => [x.waiting, x.waitsFor]), [['B1', 'P1']]);
  const more = [...list.slice(0, 5), { label: 'N1', what: 'Send the budget review', owner: 'me', to: 'Priya', isNew: true }];
  const oneWord = d.readDependencies({ items: [dep('once Lee confirms pricing', 'N1', 'P1')] },
    { list: more, note: "I'll send Priya the budget review once Lee confirms pricing." });
  assert.deepEqual(oneWord.dependencies.map((x) => [x.waiting, x.waitsFor]), [['B1', 'P1']]);
  const noPerson = d.readDependencies({ items: [dep('once Lee confirms pricing', 'N1', 'P1')] },
    { list: [...list.slice(0, 5), { ...more[5], to: '' }], note: "I'll send the budget review once Lee confirms pricing." });
  assert.deepEqual(noPerson.dependencies.map((x) => [x.waiting, x.waitsFor]), [['N1', 'P1']]);

  const twin = d.readDependencies({ items: [dep('until Omar has booked the venue', 'K7', 'V1')] },
    { list, note: 'The proposal for Lee waits until Omar has booked the venue.' });
  assert.deepEqual(twin.dependencies.map((x) => [x.waiting, x.waitsFor]), [['L7', 'V1']]);

  const nobody = d.readDependencies({ items: [dep('until Omar has booked the venue', 'B1', 'V1')] },
    { list, note: 'The proposal for Lee waits until Omar has booked the venue.' });
  assert.deepEqual(nobody.dependencies, []);
});

test('"Priya\'s budget review has to wait": a possessive is not who does what waits', async () => {
  const { seedWorkspace } = await import('../src/evaluation.js');
  const q = open();
  await seedWorkspace(q);
  const text = "Priya's budget review has to wait until Omar books the venue.";
  const ready = await c.prepare(q, text);
  const out = await c.capture(q, { text, answer: { items: [] }, shape: 'v2', ...ready, ...WHEN });
  const list = c.dependencyList(ready.candidates, out.pending);
  const budget = list.find((x) => x.what === 'Review the budget');
  const venue = list.find((x) => x.what === 'Book the venue');
  assert.ok(budget && venue);
  const deps = await c.addDependencies(q, out.session, { answer: { items: [dep('until Omar books the venue', budget.label, venue.label)] }, list, note: text, people: ready.people });
  assert.deepEqual(deps.problems.map((p) => p.reason), []);
  assert.equal(deps.recorded.added.length, 1);
});

test('"Review Priya\'s budget" read as new is the listed "Review the budget" for Priya', () => {
  const list = [
    { label: 'B1', what: 'Review the budget', owner: 'me', to: 'Priya' },
    { label: 'P1', what: 'Confirm pricing', owner: 'Lee', to: 'me' },
    { label: 'N1', what: "Review Priya's budget", owner: 'me', to: 'Priya', isNew: true },
  ];
  const r = d.readDependencies({ items: [dep('once Lee confirms pricing', 'N1', 'P1')] }, { list, note: "I'll review Priya's budget once Lee confirms pricing." });
  assert.deepEqual(r.dependencies.map((x) => [x.waiting, x.waitsFor]), [['B1', 'P1']]);
});

test('a copy whose dependency moved to the listed one is reported, so its card can go', () => {
  const list = [
    { label: 'C1', what: 'Send the contract', owner: 'me', to: 'Dana' },
    { label: 'P1', what: 'Confirm pricing', owner: 'Lee', to: 'me' },
    { label: 'N1', what: 'send the contract', owner: 'me', to: 'Dana', isNew: true },
  ];
  const r = d.readDependencies({ items: [dep('once Lee confirms pricing', 'N1', 'P1')] }, { list, note: "I'll send Dana's contract once Lee confirms pricing." });
  assert.deepEqual([r.dependencies.map((x) => [x.waiting, x.waitsFor]), r.copies], [[['C1', 'P1']], ['N1']]);
});

test('"can wait until Monday" is a deadline, not a dependency on a new "Wait until Monday"', () => {
  const list = [{ label: 'L7', what: 'Send the proposal', owner: 'me', to: 'Lee' }];
  const r = d.readDependencies({ items: [dep("Lee's proposal can wait until Monday", 'L7', 'new', 'wait until Monday', 'me')] }, { list, note: "Lee's proposal can wait until Monday." });
  assert.deepEqual([r.dependencies, r.problems.map((p) => p.reason)], [[], ['what it waits for is only a time, not something to be done']]);
  const real = d.readDependencies({ items: [dep('after Priya approves the budget', 'L7', 'new', 'Approve the budget', 'Priya')] }, { list, note: "I'll send Lee the proposal after Priya approves the budget." });
  assert.equal(real.dependencies.length, 1);
});
