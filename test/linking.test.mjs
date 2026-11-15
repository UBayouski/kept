// The scoring of the candidate-linking experiment. No model involved: these
// check that a right answer passes and each kind of wrong answer is caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases, candidates, candidateList, buildPrompt, buildSchema, score, summarise } from '../src/linking-cases.js';

const byId = (id) => cases.find((c) => c.id === id);
const L = Object.fromEntries(Object.entries(candidates).map(([name, c]) => [name, c.label]));
const update = (commitment, change, due = '') => ({ quote: '', commitment, change, due });
const answer = (updates = [], created = 0) => ({ updates, newCommitments: Array.from({ length: created }, () => ({ what: 'x' })) });

// The answer each case expects, built from its own expectation.
const ideal = (testCase) => answer(
  [
    ...testCase.expect.updates.map((u) => update(L[u.on], u.change, u.due ? `next ${u.due.toUpperCase()}` : '')),
    ...(testCase.expect.ambiguous ? [update('unclear', testCase.expect.ambiguous.change, (testCase.expect.ambiguous.due ?? '').toUpperCase())] : []),
  ],
  testCase.expect.new,
);

test('the expected answer passes every case, and an empty one only where the note says nothing', () => {
  for (const testCase of cases) {
    assert.equal(score(ideal(testCase), testCase).pass, true, testCase.id);
    const { updates, ambiguous } = testCase.expect;
    const saysNothing = updates.length === 0 && testCase.expect.new === 0 && !ambiguous;
    const empty = score(answer(), testCase);
    assert.deepEqual([empty.pass, empty.safe], [saysNothing, saysNothing], `${testCase.id} with an empty answer`);
  }
});

test('silence on an ambiguous note loses the change: not a pass, not safe', () => {
  const s = score(answer(), byId('ambiguous-it'));
  assert.deepEqual([s.pass, s.safe, s.dropped, s.guessed], [false, false, true, []]);
});

test('a question on an ambiguous note has to keep the change and offer every commitment it could mean', () => {
  const testCase = byId('ambiguous-it');
  const ask = (change, due, among) => score(answer([{ ...update('unclear', change, due), among }]), testCase);
  assert.deepEqual([ask('new deadline', 'Tuesday', [L.proposal, L.contract]).pass, ask('new deadline', 'Tuesday').pass], [true, true]);
  const wrongOperation = ask('done', '', [L.proposal, L.contract]);
  assert.deepEqual([wrongOperation.pass, wrongOperation.safe, wrongOperation.dropped], [false, false, true]);
  const wrongDate = ask('new deadline', 'Friday', [L.proposal, L.contract]);
  assert.deepEqual([wrongDate.safe, wrongDate.dropped], [false, true]);
  const oneMissing = ask('new deadline', 'Tuesday', [L.proposal, L.pricing]);
  assert.deepEqual([oneMissing.safe, oneMissing.dropped], [false, true]);
});

test('a question that offers the right commitment for the wrong operation or date is not safe', () => {
  const testCase = byId('deadline-proposal');
  const ask = (change, due) => score(answer([{ ...update('unclear', change, due), among: [L.proposal, L.contract] }]), testCase);
  assert.deepEqual([ask('new deadline', 'Tuesday').safe, ask('new deadline', 'Tuesday').pass], [true, false]);
  assert.deepEqual([ask('done', '').safe, ask('done', '').missed], [false, [L.proposal]]);
  assert.deepEqual([ask('new deadline', 'Friday').safe, ask('new deadline', '').safe], [false, false]);
});

test('one question covers two expected changes only if it offers "all"', () => {
  const testCase = byId('both-same');
  const two = answer([update(L.proposal, 'new deadline', 'Tuesday'), update(L.contract, 'new deadline', 'Tuesday')]);
  assert.equal(score(two, testCase).pass, true);
  const ask = (among) => score(answer([{ ...update('unclear', 'new deadline', 'Tuesday'), among }]), testCase);
  const whichOne = ask([L.proposal, L.contract]);
  assert.deepEqual([whichOne.safe, whichOne.missed], [false, [L.proposal, L.contract]]);
  const orBoth = ask([L.proposal, L.contract, 'all']);
  assert.deepEqual([orBoth.pass, orBoth.safe, orBoth.missed], [false, true, []]);
});

test('the held-out cases are a separate set with their own commitments', () => {
  const dev = cases.filter((c) => c.set === 'dev');
  const holdout = cases.filter((c) => c.set === 'holdout');
  assert.deepEqual([dev.length, holdout.length, cases.length], [17, 12, 29]);
  const names = (set) => new Set(set.flatMap((c) => c.list));
  for (const name of names(holdout)) assert.equal(names(dev).has(name), false, name);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.equal(new Set(Object.values(candidates).map((c) => c.label)).size, Object.keys(candidates).length);
});

test('the wrong commitment is caught', () => {
  const s = score(answer([update(L.contract, 'new deadline', 'Tuesday')]), byId('deadline-proposal'));
  assert.deepEqual([s.pass, s.wrong, s.missed], [false, [`${L.contract}: new deadline`], [L.proposal]]);
});

test('the right commitment with the wrong kind of change is caught', () => {
  const s = score(answer([update(L.contract, 'cancelled')]), byId('done-contract'));
  assert.deepEqual([s.pass, s.wrong.length, s.missed], [false, 1, [L.contract]]);
});

test('the right commitment with the wrong date is caught', () => {
  const s = score(answer([update(L.proposal, 'new deadline', 'Friday')]), byId('deadline-proposal'));
  assert.deepEqual([s.pass, s.badDue, s.wrong], [false, [L.proposal], []]);
});

test('an extra update beside the right one is caught', () => {
  const s = score(answer([update(L.proposal, 'new deadline', 'Tuesday'), update(L.pricing, 'done')]), byId('deadline-proposal'));
  assert.deepEqual([s.pass, s.right, s.wrong], [false, [L.proposal], [`${L.pricing}: done`]]);
});

test('picking one when the note is ambiguous counts as a guess', () => {
  const s = score(answer([update(L.proposal, 'new deadline', 'Tuesday')]), byId('ambiguous-it'));
  assert.deepEqual([s.pass, s.safe, s.guessed, s.wrong, s.dropped], [false, false, [L.proposal], [], false]);
});

test('"unclear" on a note that is not ambiguous is a needless question: safe if complete, never a pass', () => {
  // The model's own "unclear" has no options; the app would offer every listed commitment.
  const s = score(answer([update('unclear', 'new deadline', 'Tuesday')]), byId('deadline-proposal'));
  assert.deepEqual([s.pass, s.safe, s.unclear, s.missed], [false, true, 1, []]);
  const wrongOperation = score(answer([update('unclear', 'done', '')]), byId('deadline-proposal'));
  assert.deepEqual([wrongOperation.safe, wrongOperation.missed], [false, [L.proposal]]);
});

test('a new commitment reported as an update, or the reverse, is caught', () => {
  const asUpdate = score(answer([update(L.contract, 'new deadline', 'Friday')]), byId('none-new-similar'));
  assert.deepEqual([asUpdate.pass, asUpdate.wrong.length, asUpdate.newCount], [false, 1, 0]);
  const asNew = score(answer([], 1), byId('deadline-proposal'));
  assert.deepEqual([asNew.pass, asNew.missed, asNew.newCount], [false, [L.proposal], 1]);
});

test('the twin with the other recipient is the wrong commitment', () => {
  const s = score(answer([update(L.proposal, 'new deadline', 'Monday')]), byId('twin-lee'));
  assert.deepEqual([s.pass, s.wrong.length, s.missed], [false, 1, [L.proposalLee]]);
});

test('something that is not the expected shape is invalid, not a pass', () => {
  for (const bad of [null, {}, { updates: 'none', newCommitments: [] }]) {
    const s = score(bad, byId('nothing'));
    assert.deepEqual([s.pass, s.invalid], [false, true]);
  }
});

test('reversing the list changes its order and nothing else', () => {
  const testCase = byId('twin-lee');
  const listed = candidateList(testCase, 'listed');
  const reversed = candidateList(testCase, 'reversed');
  assert.deepEqual(reversed.map((c) => c.label), listed.map((c) => c.label).reverse());
  assert.deepEqual(buildSchema(reversed).properties.updates.items.properties.commitment.enum.slice().sort(),
    buildSchema(listed).properties.updates.items.properties.commitment.enum.slice().sort());
  const prompt = buildPrompt(testCase.note, listed);
  for (const c of listed) assert.ok(prompt.includes(`[${c.label}] ${c.what}`));
  assert.ok(prompt.endsWith(testCase.note));
});

test('the summary counts failures by kind and reports order sensitivity', () => {
  const testCase = byId('deadline-proposal');
  const rows = [
    { id: testCase.id, order: 'listed', score: score(ideal(testCase), testCase) },
    { id: testCase.id, order: 'reversed', score: score(answer([update(L.contract, 'new deadline', 'Tuesday')]), testCase) },
    { id: 'nothing', order: 'listed', score: score(null, byId('nothing')) },
  ];
  const s = summarise(rows);
  assert.deepEqual([s.runs, s.passed, s.invalidJson, s.wrongCommitment, s.missedUpdate, s.verdictChangedWithOrder, s.selectionChangedWithOrder],
    [3, 1, 1, 1, 1, [testCase.id], [testCase.id]]);
});

test('a case that fails in both orders but selects a different commitment in each is reported', () => {
  const testCase = byId('ambiguous-it');
  const rows = [
    { id: testCase.id, order: 'listed', score: score(answer([update(L.proposal, 'new deadline', 'Tuesday')]), testCase) },
    { id: testCase.id, order: 'reversed', score: score(answer([update(L.contract, 'new deadline', 'Tuesday')]), testCase) },
  ];
  const s = summarise(rows);
  assert.deepEqual([s.passed, s.verdictChangedWithOrder, s.selectionChangedWithOrder], [0, [], [testCase.id]]);
  // The same selection in another order of entries is not a change.
  const same = [
    { id: 'two-updates', score: score(answer([update(L.proposal, 'new deadline', 'Tuesday'), update(L.contract, 'new deadline', 'Thursday')]), byId('two-updates')) },
    { id: 'two-updates', score: score(answer([update(L.contract, 'new deadline', 'Thursday'), update(L.proposal, 'new deadline', 'Tuesday')]), byId('two-updates')) },
  ];
  assert.deepEqual(summarise(same).selectionChangedWithOrder, []);
});

// --- App rules, and the first device run replayed ---

import { applyRules, variants } from '../src/linking-cases.js';
import { rows as deviceRun, reported } from './fixtures/linking-device-run-1.mjs';
import { rows as deviceRun2, reported as reported2 } from './fixtures/linking-device-run-2.mjs';

const listOf = (id, order = 'listed') => candidateList(byId(id), order);
const created = (what, quote, to = 'Dana') => ({ quote, what, owner: 'me', to, due: '' });
const said = (commitment, change, due, quote) => ({ quote, commitment, change, due });

test('rule 1: a new commitment that restates an updated one becomes a question; the update stands', () => {
  const q = 'Dana agreed we can send the proposal Tuesday.';
  const ruled = applyRules({ updates: [said(L.proposal, 'new deadline', 'Tuesday', q)], newCommitments: [created('Send the proposal', 'send the proposal')] }, listOf('deadline-proposal'));
  assert.deepEqual(ruled.updates.map((u) => [u.commitment, u.among, u.restates]), [[L.proposal, undefined, undefined], ['unclear', ['new', 'same'], L.proposal]]);
  assert.deepEqual(ruled.newCommitments, []);
  const s = score(ruled, byId('deadline-proposal'));
  assert.deepEqual([s.pass, s.safe, s.right], [false, true, [L.proposal]]);
  // Same wording for someone else is not a restatement.
  const other = applyRules({ updates: [said(L.proposal, 'new deadline', 'Tuesday', q)], newCommitments: [created('Send the proposal', 'another one', 'Omar')] }, listOf('deadline-proposal'));
  assert.equal(other.newCommitments.length, 1);
});

test('rule 1 keeps a real new commitment that has the wording of a completed one', () => {
  const testCase = byId('done-and-new-same');
  const right = {
    updates: [said(L.contract, 'done', '', 'I sent Dana the contract this morning')],
    newCommitments: [{ ...created('Send the contract', 'I promised to send Dana another contract Friday'), due: 'Friday' }],
  };
  assert.equal(score(right, testCase).pass, true);
  const ruled = applyRules(right, candidateList(testCase, 'listed'));
  const question = ruled.updates.find((u) => u.commitment === 'unclear');
  assert.deepEqual([question.what, question.due, question.among, question.restates], ['Send the contract', 'Friday', ['new', 'same'], L.contract]);
  const s = score(ruled, testCase);
  // Nothing is lost: the completion stands and "new" is one of the answers. The cost is the question.
  assert.deepEqual([s.pass, s.safe, s.right, s.missed, s.unclear], [false, true, [L.contract], [], 1]);
});

test('rule 2: the same change from the same words on two commitments becomes one question', () => {
  const q = 'Dana moved it to Tuesday.';
  const ruled = applyRules({ updates: [said(L.proposal, 'new deadline', 'Tuesday', q), said(L.contract, 'new deadline', 'Tuesday', q)], newCommitments: [] }, listOf('ambiguous-it'));
  assert.deepEqual(ruled.updates.map((u) => [u.commitment, u.change, u.due, u.among]), [['unclear', 'new deadline', 'Tuesday', [L.proposal, L.contract, 'all']]]);
  assert.equal(score(ruled, byId('ambiguous-it')).pass, true);
});

test('rule 2 on a note that really changes both keeps both on offer, at the cost of a question', () => {
  const q = 'The proposal and the contract both move to Tuesday.';
  const both = { updates: [said(L.proposal, 'new deadline', 'Tuesday', q), said(L.contract, 'new deadline', 'Tuesday', q)], newCommitments: [] };
  assert.equal(score(both, byId('both-same')).pass, true);
  const ruled = applyRules(both, listOf('both-same'));
  assert.deepEqual(ruled.updates.map((u) => u.among), [[L.proposal, L.contract, 'all']]);
  const s = score(ruled, byId('both-same'));
  assert.deepEqual([s.pass, s.safe, s.missed], [false, true, []]);
});

test('rule 2 leaves two different changes from one sentence alone', () => {
  const q = 'The proposal goes to Dana on Tuesday and the contract on Thursday.';
  const answerTwo = { updates: [said(L.proposal, 'new deadline', 'Tuesday', q), said(L.contract, 'new deadline', 'Thursday', q)], newCommitments: [] };
  const ruled = applyRules(answerTwo, listOf('two-updates'));
  assert.deepEqual(ruled.updates.map((u) => u.commitment), [L.proposal, L.contract]);
  assert.equal(score(ruled, byId('two-updates')).pass, true);
});

test('rule 3: the same words as a change and as something new become one question with both options', () => {
  const q = "I'll send Dana the invoice by Friday.";
  const ruled = applyRules({ updates: [said(L.proposal, 'new deadline', 'Friday', q)], newCommitments: [created('send the invoice', "I'll send Dana the invoice")] }, listOf('none-new-similar'));
  assert.deepEqual(ruled.updates.map((u) => [u.commitment, u.among]), [['unclear', [L.proposal, 'new', 'all']]]);
  assert.deepEqual(ruled.newCommitments, []);
  const s = score(ruled, byId('none-new-similar'));
  assert.deepEqual([s.pass, s.safe, s.wrong], [false, true, []]);
});

test('the rules cannot rescue a wrong answer that does not contradict itself', () => {
  const ruled = applyRules({ updates: [said(L.proposal, 'new deadline', 'Thursday', "I'll book a room for Thursday's workshop with Dana.")], newCommitments: [] }, listOf('none-new-different'));
  const s = score(ruled, byId('none-new-different'));
  assert.deepEqual([s.pass, s.safe, s.wrong.length], [false, false, 1]);
});

test('a question that offers the right commitment is safe; one that does not is a miss', () => {
  const testCase = byId('deadline-contract');
  const offered = score({ updates: [{ ...said('unclear', 'new deadline', 'Wednesday', 'q'), among: [L.contract, L.proposal] }], newCommitments: [] }, testCase);
  assert.deepEqual([offered.pass, offered.safe, offered.missed], [false, true, []]);
  const notOffered = score({ updates: [{ ...said('unclear', 'new deadline', 'Wednesday', 'q'), among: [L.proposal, L.pricing] }], newCommitments: [] }, testCase);
  assert.deepEqual([notOffered.safe, notOffered.missed], [false, [L.contract]]);
});

test('variant 2 answers are read into the same shape', () => {
  const read = variants.v2.read({ items: [
    { quote: 'a', about: L.proposal, change: 'new deadline', due: 'Tuesday', what: '' },
    { quote: 'b', about: 'new', change: 'new commitment', due: 'Friday', what: 'Send the invoice' },
    { quote: 'c', about: 'unclear', change: 'new deadline', due: 'Monday', what: '' },
  ] });
  assert.deepEqual(read.updates.map((u) => u.commitment), [L.proposal, 'unclear']);
  assert.deepEqual(read.newCommitments.map((n) => n.what), ['Send the invoice']);
  assert.equal(variants.v2.read({ updates: [] }), null);
  const schema = variants.v2.buildSchema(listOf('twin-lee'));
  assert.deepEqual(schema.properties.items.items.properties.about.enum, [L.proposal, L.contract, L.pricing, L.proposalLee, 'new', 'unclear']);
});

test('errors are counted apart from invalid JSON', () => {
  const s = summarise([{ id: 'nothing', error: 'App Check', score: score(null, byId('nothing')) }, { id: 'nothing', score: score({}, byId('nothing')) }]);
  assert.deepEqual([s.errors, s.invalidJson, s.unsafe], [1, 1, 0]);
});

test('the first device run, replayed: the scorer reproduces the reported summary, and the rules change it', () => {
  const out = deviceRun.map((r) => {
    const testCase = byId(r.id);
    return { ...r, score: score(r.parsed, testCase), ruled: score(applyRules(r.parsed, candidateList(testCase, r.order)), testCase) };
  });
  const raw = summarise(out);
  for (const key of Object.keys(reported)) assert.equal(raw[key], reported[key], key);
  assert.deepEqual([raw.passed, raw.safeWithQuestion, raw.unsafe], [12, 2, 16]);
  const ruled = summarise(out, 'ruled');
  assert.deepEqual([ruled.passed, ruled.safeWithQuestion, ruled.unsafe], [17, 10, 3]);
  assert.deepEqual([raw.verdictChangedWithOrder.length, raw.selectionChangedWithOrder.length], [6, 9]);
  // The third is a question that lost the date the note gave ("next week").
  assert.deepEqual(out.filter((r) => !r.ruled.safe).map((r) => `${r.id} ${r.order}`),
    ['cancel-proposal listed', 'none-new-different reversed', 'twin-ambiguous listed']);
});

test('the second device run, replayed: one item per statement leaves the rules nothing to catch', () => {
  const out = deviceRun2.map((r) => {
    const testCase = byId(r.id);
    const read = variants.v2.read(r.parsed);
    return { ...r, score: score(read, testCase), ruled: score(applyRules(read, candidateList(testCase, r.order)), testCase) };
  });
  const raw = summarise(out);
  for (const key of Object.keys(reported2)) assert.equal(raw[key], reported2[key], key);
  assert.deepEqual(summarise(out, 'ruled'), raw);
  // One case changed its verdict with the order of the list; four changed what was selected.
  assert.deepEqual(raw.verdictChangedWithOrder, ['deadline-contract']);
  assert.deepEqual(raw.selectionChangedWithOrder, ['deadline-contract', 'ambiguous-it', 'ambiguous-both', 'twin-ambiguous']);
  // Every ambiguous note got one confident pick: the first fitting commitment in the list.
  const guesses = out.filter((r) => r.score.guessed.length).map((r) => [r.id, r.order, r.score.guessed[0]]);
  assert.equal(guesses.length, 6);
  for (const [id, order, picked] of guesses) {
    const options = byId(id).expect.ambiguous.among.map((name) => L[name]);
    const firstInList = candidateList(byId(id), order).map((c) => c.label).find((label) => options.includes(label));
    assert.equal(picked, firstInList, `${id} ${order}`);
  }
});
