// The evaluation's workspace, observation and scoring, with answers written by
// hand in place of the model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as e from '../src/evaluation.js';
import * as pipeline from '../src/pipeline.js';

const { Database } = createRequire(import.meta.url)('@relate/relate');
function open() {
  const conn = Database.open(join(mkdtempSync(join(tmpdir(), 'kept-eval-')), 'store.rl')).connect();
  return (cypher, params) => conn.query(cypher, params ?? {}).rows;
}

// A fake model: answers by which prompt it is given. Labels are looked up by wording and recipient.
function fake({ linking, deps = { items: [] } }) {
  const calls = [];
  const generate = async (prompt) => {
    calls.push(prompt);
    const label = (what, to) => new RegExp(`\\[([A-Z0-9]+)\\] ${what}\\. Owner: [^.]+\\. For: ${to}\\.`).exec(prompt)?.[1];
    const answer = prompt.startsWith('Some commitments') ? deps : linking;
    return { parsed: typeof answer === 'function' ? answer(label) : answer, ms: 1, source: 'fake' };
  };
  return { generate, calls };
}

async function run(testCase, model) {
  const q = open();
  const ws = await e.seedWorkspace(q);
  const result = await pipeline.readNote(q, { text: testCase.note, ...e.NOTE_TIME, generate: model.generate });
  const observed = await e.observe(q, result, ws);
  return { observed, score: e.score(observed, testCase.expect) };
}
const byId = (id) => e.cases.find((x) => x.id === id);

test('the set: 40 notes, unique ids, every group present', () => {
  assert.equal(e.cases.length, 40);
  assert.equal(new Set(e.cases.map((x) => x.id)).size, 40);
  assert.deepEqual([...new Set(e.cases.map((x) => x.group))], ['deadline', 'status', 'new', 'nothing', 'ambiguous', 'several', 'dependency']);
});

test('a right deadline change passes; the same change on the twin commitment goes to the one the words name', async () => {
  const right = await run(byId('a3'), fake({ linking: (label) => ({ items: [
    { quote: 'Lee can wait until Tuesday for the proposal', about: label('Send the proposal', 'Lee'), change: 'new deadline', due: 'Tuesday', what: '' }] }) }));
  assert.equal(right.score.verdict, 'pass');
  // The words name Lee, not Dana: the proposal for Lee is meant.
  const twin = await run(byId('a3'), fake({ linking: (label) => ({ items: [
    { quote: 'Lee can wait until Tuesday for the proposal', about: label('Send the proposal', 'Dana'), change: 'new deadline', due: 'Tuesday', what: '' }] }) }));
  assert.equal(twin.score.verdict, 'pass');
  assert.deepEqual(twin.score.wrong, []);
});

test('a wrong date is unsafe; a note that says nothing passes only with nothing', async () => {
  const wrongDay = await run(byId('a1'), fake({ linking: (label) => ({ items: [
    { quote: 'getting the contract on Monday', about: label('Send the contract', 'Dana'), change: 'new deadline', due: 'Tuesday', what: '' }] }) }));
  assert.equal(wrongDay.score.verdict, 'unsafe');
  assert.equal((await run(byId('d1'), fake({ linking: { items: [] } }))).score.verdict, 'pass');
});

test('an ambiguous note: a question passes, a guess is held back, silence is safe but missed', async () => {
  const asked = await run(byId('e1'), fake({ linking: { items: [{ quote: 'Dana moved it to Monday', about: 'unclear', change: 'new deadline', due: 'Monday', what: '' }] } }));
  assert.equal(asked.score.verdict, 'pass');
  const guess = await run(byId('e1'), fake({ linking: (label) => ({ items: [
    { quote: 'Dana moved it to Monday', about: label('Send the proposal', 'Dana'), change: 'new deadline', due: 'Monday', what: '' }] }) }));
  // The words do not mention the proposal, so the app turns the guess into a
  // question, among everything owed to Dana: the question the note needs.
  assert.equal(guess.score.verdict, 'pass');
  assert.equal(guess.score.asked, true);
  assert.deepEqual(guess.score.guessed, []);
  const silent = await run(byId('e1'), fake({ linking: { items: [] } }));
  assert.equal(silent.score.verdict, 'safe');
});

test('a new commitment: the card filled in right passes, a wrong recipient is a card error, not unsafe', async () => {
  const good = await run(byId('c1'), fake({ linking: { items: [{ quote: "I'll send Sam the slides by Friday", about: 'new', change: 'new commitment', due: 'Friday', what: 'Send Sam the slides' }] } }));
  assert.equal(good.score.verdict, 'pass', JSON.stringify(good));
  assert.deepEqual(good.observed.created, [{ what: 'Send the slides', owner: 'Me', to: 'Sam', due: '2026-11-27', how: 'card' }]);
  const vague = await run(byId('c2'), fake({ linking: { items: [{ quote: 'Priya will email me the forecast on Monday', about: 'new', change: 'new commitment', due: 'Monday', what: 'Email the forecast' }] } }));
  assert.equal(vague.score.verdict, 'pass', JSON.stringify(vague.score));
});

test('dependencies: between listed commitments, and with new ones on both sides', async () => {
  const listed = await run(byId('g1'), fake({
    linking: { items: [] },
    deps: (label) => ({ items: [{ quote: 'once Lee confirms pricing', waiting: label('Send the contract', 'Dana'), waitsFor: label('Confirm pricing', 'me'), newWhat: '', newOwner: '' }] }),
  }));
  assert.equal(listed.score.verdict, 'pass', JSON.stringify(listed.score));

  const fresh = await run(byId('g3'), fake({
    linking: { items: [{ quote: "I'll send Sam the slides Friday", about: 'new', change: 'new commitment', due: 'Friday', what: 'Send the slides' }] },
    deps: { items: [{ quote: 'after Priya approves the budget', waiting: 'N1', waitsFor: 'new', newWhat: 'Approve the budget', newOwner: 'Priya' }] },
  }));
  assert.deepEqual(fresh.observed.deps, [{ waiting: 'new:Send the slides', on: 'new:Approve the budget' }]);
  assert.equal(fresh.score.verdict, 'pass', JSON.stringify(fresh.score));

  const invented = await run(byId('a1'), fake({
    linking: (label) => ({ items: [{ quote: 'getting the contract on Monday', about: label('Send the contract', 'Dana'), change: 'new deadline', due: 'Monday', what: '' }] }),
  }));
  assert.equal(invented.score.verdict, 'pass', 'no dependency call without a dependency word');
});

test('the summary counts verdicts by group', () => {
  const rows = [
    { group: 'new', score: { verdict: 'pass', wrong: [], guessed: [], missed: [], missedCreated: [], extraCreated: [], cardErrors: [], wrongDeps: [], missedDeps: [], needlessQuestions: 0 }, observed: { manual: [] } },
    { group: 'new', error: 'quota' },
  ];
  const s = e.summarise(rows);
  assert.deepEqual([s.notes, s.errors, s.pass], [2, 1, 1]);
  assert.deepEqual(s.byGroup.new, { notes: 2, pass: 1, safe: 0, unsafe: 0, error: 1 });
});

test('the device route: prompt v1 answers go through the same path', async () => {
  const q = open();
  const ws = await e.seedWorkspace(q);
  const calls = [];
  const generate = async (prompt) => {
    calls.push(prompt);
    const label = /\[([A-Z0-9]+)\] Send the contract\. Owner: me\. For: Dana\./.exec(prompt)?.[1];
    return { parsed: { updates: [{ quote: 'getting the contract on Monday', commitment: label, change: 'new deadline', due: 'Monday' }], newCommitments: [] }, ms: 1, source: 'on_device' };
  };
  const result = await pipeline.readNote(q, { text: byId('a1').note, ...e.NOTE_TIME, generate, shape: 'v1', extractedBy: 'device' });
  assert.match(calls[0], /"updates" has one entry/, 'the v1 prompt was used');
  const observed = await e.observe(q, result, ws);
  assert.equal(e.score(observed, byId('a1').expect).verdict, 'pass');
  const [note] = await q('MATCH (n:Note) RETURN n.extractedBy AS by');
  assert.equal(note.by, 'device');
});

test('a listed commitment said again as new, beside a dependency on it: no question about the copy', async () => {
  const testCase = e.round11.find((x) => x.id === 'r11-3');
  const model = fake({
    linking: { items: [{ quote: "I'll send Dana's contract", about: 'new', change: 'new commitment', due: '', what: 'Send the contract' }] },
    deps: (label) => ({ items: [{ quote: 'once Lee confirms pricing', waiting: label('Send the contract', 'Dana'), waitsFor: label('Confirm pricing', 'me'), newWhat: '', newOwner: '' }] }),
  });
  const r = await run(testCase, model);
  assert.deepEqual(r.observed.deps, [{ waiting: 'contract', on: 'pricing' }]);
  assert.deepEqual([r.observed.questions, r.observed.created], [[], []]);
  assert.equal(r.score.verdict, 'pass');
});

test('"after lunch" is not a dependency on something new the words do not mention', async () => {
  const testCase = e.round13.find((x) => x.id === 'r13-4');
  const model = fake({
    linking: (label) => ({ items: [{ quote: 'Sent Dana the contract after lunch', about: label('Send the contract', 'Dana'), change: 'done', due: '', what: '' }] }),
    deps: (label) => ({ items: [{ quote: 'after lunch', waiting: label('Send the contract', 'Dana'), waitsFor: 'new', newWhat: 'Send the proposal', newOwner: 'me' }] }),
  });
  const r = await run(testCase, model);
  assert.deepEqual([r.observed.deps, r.observed.created], [[], []]);
  assert.equal(r.score.verdict, 'pass');
});

test('a new card in the words of a listed commitment a dependency is on goes', async () => {
  const testCase = e.round18.find((x) => x.id === 'r18-10');
  const model = fake({
    linking: { items: [{ quote: "I'll send Dana the proposal", about: 'new', change: 'new commitment', due: '', what: 'Send the proposal' }] },
    deps: (label) => ({ items: [{ quote: 'after Lee confirms pricing', waiting: label('Send the proposal', 'Dana'), waitsFor: label('Confirm pricing', 'me'), newWhat: '', newOwner: '' }] }),
  });
  const r = await run(testCase, model);
  assert.deepEqual([r.observed.deps, r.observed.created, r.observed.questions], [[{ waiting: 'proposal', on: 'pricing' }], [], []]);
});

test('a refused "it is new" for the words of a dependency goes', async () => {
  const testCase = e.round18.find((x) => x.id === 'r18-10');
  const model = fake({
    linking: (label) => ({ items: [{ quote: "I'll send Dana the proposal after Lee confirms pricing", about: label('Send the proposal', 'Dana'), change: 'new commitment', due: '', what: 'Send the proposal after Lee confirms pricing' }] }),
    deps: (label) => ({ items: [{ quote: 'after Lee confirms pricing', waiting: label('Send the proposal', 'Dana'), waitsFor: label('Confirm pricing', 'me'), newWhat: '', newOwner: '' }] }),
  });
  const r = await run(testCase, model);
  assert.deepEqual([r.observed.deps, r.observed.created, r.observed.manual], [[{ waiting: 'proposal', on: 'pricing' }], [], []]);
});
