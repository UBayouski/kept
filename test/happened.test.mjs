// The second look at "done" and "cancelled": it holds a reading back or turns
// it into a question, and never proposes by itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../src/happened.js';
import { readNote } from '../src/reading.js';

const candidates = [
  { label: 'K7', id: 'id-proposal', what: 'Send the proposal', owner: 'me', to: 'Dana' },
  { label: 'Q4', id: 'id-venue', what: 'Book the venue', owner: 'Omar', to: 'me' },
  { label: 'P9', id: 'id-pricing', what: 'Confirm pricing', owner: 'Lee', to: 'me' },
];
const up = (commitment, change, quote) => ({ quote, commitment, change, due: '' });
const read = (u, note, verdict) => readNote({ updates: [u], newCommitments: [] },
  { shape: 'v1', candidates, note, happened: verdict ? new Map([[h.keyOf(u.commitment, u.quote), verdict]]) : null });

test('the answer is read by id; anything not understood is left out', () => {
  const items = [{ id: 'S1', key: 'K7|x' }, { id: 'S2', key: 'Q4|y' }];
  const m = h.readAnswer({ items: [{ id: 'S1', answer: 'happened' }, { id: 'S2', answer: 'maybe' }, { id: 'S9', answer: 'off' }] }, items);
  assert.deepEqual([...m], [['K7|x', 'happened']]);
  assert.equal(h.readAnswer({ updates: [] }, items).size, 0);
});

test('"neither" holds back a done the words seemed to support', () => {
  const note = 'Dana and I went over the proposal.';
  assert.equal(read(up('K7', 'done', note), note, null).proposals.length, 0, 'held back by the words already');
  const sorted = 'Omar sorted the venue photos.';
  assert.equal(read(up('Q4', 'done', sorted), sorted, null).proposals.length, 1, 'the words alone let it through');
  const r = read(up('Q4', 'done', sorted), sorted, 'neither');
  assert.deepEqual([r.proposals, r.manual.length], [[], 1]);
});

test('"happened" for words not on the list asks, one click; it does not propose', () => {
  const note = "Lee's pricing came through this morning.";
  assert.deepEqual(read(up('P9', 'done', note), note, null).questions, [], 'without the second look it is held back');
  const r = read(up('P9', 'done', note), note, 'happened');
  assert.deepEqual([r.proposals, r.questions[0].options.map((o) => [o.label ?? o.type, o.change])], [[], [['P9', 'done'], ['new', undefined]]]);
});

test('"happened" with words that agree changes nothing; the proposal stands', () => {
  const note = 'Omar booked the venue.';
  assert.equal(read(up('Q4', 'done', note), note, 'happened').proposals.length, 1);
});
