// Evaluation of capture end to end: a note goes through the same path as on
// the review screen (pipeline.js), into a store holding a fixed workspace, and
// what comes out (proposals and cards) is compared with what the note means.
// See docs/evaluation.md.
//
// Written on 2026-11-15, before any model saw these notes. Nothing may be
// tuned against them; a change made because of a result here needs new notes
// to measure it.

import * as m from './model.js';
import * as capture from './capture.js';
import { norm } from './reading.js';

// Every note is from Wednesday 2026-11-25, 10:00 UTC. From that day "Friday" is
// 2026-11-27, "Monday" 2026-11-30, "Tuesday" 2026-12-01, "tomorrow" and
// "Thursday" 2026-11-26. "Wednesday" has no single reading and stays words.
export const NOTE_TIME = { occurredAt: '2026-11-25T10:00:00Z', baseDate: '2026-11-25' };

// The workspace every note is read against: confirmed commitments, two pairs
// of which are easy to confuse (same recipient; same wording).
export const WORKSPACE = {
  people: ['Dana', 'Lee', 'Priya', 'Omar', 'Sam'],
  commitments: {
    proposal: { what: 'Send the proposal', owner: 'Me', to: 'Dana', due: '2026-11-27', dueText: 'Friday' },
    contract: { what: 'Send the contract', owner: 'Me', to: 'Dana', due: '2026-11-27', dueText: 'Friday' },
    pricing: { what: 'Confirm pricing', owner: 'Lee', to: 'Me' },
    budget: { what: 'Review the budget', owner: 'Me', to: 'Priya', due: '2026-12-02', dueText: 'December 2' },
    venue: { what: 'Book the venue', owner: 'Omar', to: 'Me' },
    proposalLee: { what: 'Send the proposal', owner: 'Me', to: 'Lee', due: '2026-11-26', dueText: 'Thursday' },
  },
};

// Builds the workspace in an empty store. Returns {ids: key -> commitment id, people: name -> id}.
export async function seedWorkspace(q, { now = '2026-11-20T09:00:00Z' } = {}) {
  const people = { Me: await m.createPerson(q, { name: 'Me', isMe: true }) };
  for (const name of WORKSPACE.people) people[name] = await m.createPerson(q, { name });
  const ids = {};
  for (const [key, c] of Object.entries(WORKSPACE.commitments)) {
    const made = await m.addCommitment(q, {
      what: c.what, ownerId: people[c.owner], toId: c.to ? people[c.to] : null, due: c.due ?? null, dueText: c.dueText ?? null, now,
    });
    ids[key] = made.commitmentId;
  }
  return { ids, people };
}

// expect:
//   changes    [{on, kind: deadline | completed | cancelled, due}] proposed on listed commitments;
//              due is a date, or 'words' when the note's words have no single date
//   created    [{what, owner, to, due}] new commitments, as their cards should be filled in
//   deps       [{waiting, on}] a key of a listed commitment, or 'new:<words>' for one new in the note
//   ambiguous  {among: [keys], kind, due}: the note changes one of these and does not say which
const c = (on, kind, due) => ({ on, kind, ...(due ? { due } : {}) });
const n = (what, owner, to = null, due = null) => ({ what, owner, to, due });
export const cases = [
  // A. A new deadline on one listed commitment
  { id: 'a1', group: 'deadline', note: 'Dana is fine getting the contract on Monday instead.', expect: { changes: [c('contract', 'deadline', '2026-11-30')] } },
  { id: 'a2', group: 'deadline', note: 'Priya pushed the budget review to Friday.', expect: { changes: [c('budget', 'deadline', '2026-11-27')] } },
  { id: 'a3', group: 'deadline', note: 'Lee can wait until Tuesday for the proposal.', expect: { changes: [c('proposalLee', 'deadline', '2026-12-01')] } },
  { id: 'a4', group: 'deadline', note: 'Dana needs the proposal a day earlier, so tomorrow.', expect: { changes: [c('proposal', 'deadline', '2026-11-26')] } },
  { id: 'a5', group: 'deadline', note: 'Omar will have the venue booked by Monday.', expect: { changes: [c('venue', 'deadline', '2026-11-30')] } },
  { id: 'a6', group: 'deadline', note: 'Lee expects to confirm pricing on Friday.', expect: { changes: [c('pricing', 'deadline', '2026-11-27')] } },
  { id: 'a7', group: 'deadline', note: 'Dana asked for the contract by December 4.', expect: { changes: [c('contract', 'deadline', '2026-12-04')] } },
  { id: 'a8', group: 'deadline', note: 'Priya needs my budget comments by Thursday, not next week.', expect: { changes: [c('budget', 'deadline', '2026-11-26')] } },

  // B. Done or cancelled
  { id: 'b1', group: 'status', note: 'Sent Dana the proposal this morning.', expect: { changes: [c('proposal', 'completed')] } },
  { id: 'b2', group: 'status', note: 'Lee confirmed pricing on the call.', expect: { changes: [c('pricing', 'completed')] } },
  { id: 'b3', group: 'status', note: 'Omar booked the venue.', expect: { changes: [c('venue', 'completed')] } },
  { id: 'b4', group: 'status', note: 'Dana no longer needs the contract; legal handles it now.', expect: { changes: [c('contract', 'cancelled')] } },
  { id: 'b5', group: 'status', note: 'Priya called off the budget review.', expect: { changes: [c('budget', 'cancelled')] } },
  { id: 'b6', group: 'status', note: 'Sent Lee the proposal.', expect: { changes: [c('proposalLee', 'completed')] } },

  // C. Something new
  { id: 'c1', group: 'new', note: "I'll send Sam the slides by Friday.", expect: { created: [n('Send the slides', 'Me', 'Sam', '2026-11-27')] } },
  { id: 'c2', group: 'new', note: 'Priya will email me the forecast on Monday.', expect: { created: [n('Email the forecast', 'Priya', 'Me', '2026-11-30')] } },
  { id: 'c3', group: 'new', note: "I promised Omar I'd call the caterer tomorrow.", expect: { created: [n('Call the caterer', 'Me', 'Omar', '2026-11-26')] } },
  { id: 'c4', group: 'new', note: 'Dana asked me to draft the press release by Tuesday.', expect: { created: [n('Draft the press release', 'Me', 'Dana', '2026-12-01')] } },
  { id: 'c5', group: 'new', note: 'Lee will send me the signed NDA.', expect: { created: [n('Send the signed NDA', 'Lee', 'Me')] } },
  { id: 'c6', group: 'new', note: "I'll book flights for the offsite.", expect: { created: [n('Book flights for the offsite', 'Me')] } },
  { id: 'c7', group: 'new', note: 'Sam will review my draft by Thursday.', expect: { created: [n('Review the draft', 'Sam', 'Me', '2026-11-26')] } },
  { id: 'c8', group: 'new', note: 'I owe Priya a summary of the meeting.', expect: { created: [n('Send a summary of the meeting', 'Me', 'Priya')] } },

  // D. Nothing to do
  { id: 'd1', group: 'nothing', note: 'Long day. Dana seemed tired.', expect: {} },
  { id: 'd2', group: 'nothing', note: 'Lunch with Lee and Omar, mostly about football.', expect: {} },
  { id: 'd3', group: 'nothing', note: "Priya's team is growing; she hired two people.", expect: {} },
  { id: 'd4', group: 'nothing', note: 'Remember that Dana prefers email to calls.', expect: {} },

  // E. Ambiguous: the right answer is a question
  { id: 'e1', group: 'ambiguous', note: 'Dana moved it to Monday.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'deadline', due: '2026-11-30' } } },
  { id: 'e2', group: 'ambiguous', note: 'Sent Dana the document.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'completed' } } },
  { id: 'e3', group: 'ambiguous', note: 'The proposal slipped to next week.', expect: { ambiguous: { among: ['proposal', 'proposalLee'], kind: 'deadline', due: 'words' } } },
  { id: 'e4', group: 'ambiguous', note: 'Sent the proposal.', expect: { ambiguous: { among: ['proposal', 'proposalLee'], kind: 'completed' } } },

  // F. Several things in one note
  { id: 'f1', group: 'several', note: 'Dana wants both the proposal and the contract by Tuesday.',
    expect: { changes: [c('proposal', 'deadline', '2026-12-01'), c('contract', 'deadline', '2026-12-01')] } },
  { id: 'f2', group: 'several', note: 'Sent Dana the contract; the proposal now goes out Monday.',
    expect: { changes: [c('contract', 'completed'), c('proposal', 'deadline', '2026-11-30')] } },
  { id: 'f3', group: 'several', note: "Lee confirmed pricing, and I'll send Dana the invoice Friday.",
    expect: { changes: [c('pricing', 'completed')], created: [n('Send the invoice', 'Me', 'Dana', '2026-11-27')] } },
  { id: 'f4', group: 'several', note: "Omar booked the venue, so I'll send Priya the agenda by Thursday.",
    expect: { changes: [c('venue', 'completed')], created: [n('Send the agenda', 'Me', 'Priya', '2026-11-26')] } },

  // G. Dependencies
  { id: 'g1', group: 'dependency', note: 'I can only send Dana the contract once Lee confirms pricing.',
    expect: { deps: [{ waiting: 'contract', on: 'pricing' }] } },
  { id: 'g2', group: 'dependency', note: 'Waiting on Lee for pricing before the proposal goes to Dana.',
    expect: { deps: [{ waiting: 'proposal', on: 'pricing' }] } },
  { id: 'g3', group: 'dependency', note: "I'll send Sam the slides Friday, after Priya approves the budget.",
    expect: { created: [n('Send the slides', 'Me', 'Sam', '2026-11-27'), n('Approve the budget', 'Priya', 'Me')],
      deps: [{ waiting: 'new:slides', on: 'new:approve budget' }] } },
  { id: 'g4', group: 'dependency', note: "The venue can't be booked until Dana confirms the date.",
    expect: { created: [n('Confirm the date', 'Dana', 'Omar')], deps: [{ waiting: 'venue', on: 'new:confirm date' }] } },
  { id: 'g5', group: 'dependency', note: "Once Omar books the venue, I'll send out the invitations by Monday.",
    expect: { created: [n('Send out the invitations', 'Me', null, '2026-11-30')], deps: [{ waiting: 'new:invitations', on: 'venue' }] } },
  { id: 'g6', group: 'dependency', note: "I'll send Lee the proposal after Dana signs off on it.",
    expect: { created: [n('Sign off on the proposal', 'Dana', 'Me')], deps: [{ waiting: 'proposalLee', on: 'new:sign off' }] } },
];

// Round 2: dependencies only, written on 2026-11-15 after round 1 and after the
// dependency prompt and checks were changed because of it, before any model
// saw them. They measure that change; they must not be used to tune it.
export const round2 = [
  { id: 'r2-1', group: 'dependency', note: "I'll send Priya the budget review once Lee confirms pricing.",
    expect: { deps: [{ waiting: 'budget', on: 'pricing' }] } },
  { id: 'r2-2', group: 'dependency', note: "The contract can't go to Dana until Lee confirms pricing.",
    expect: { deps: [{ waiting: 'contract', on: 'pricing' }] } },
  { id: 'r2-3', group: 'dependency', note: "I won't send Lee the proposal until Dana reviews it.",
    expect: { created: [n('Review the proposal', 'Dana', 'Me')], deps: [{ waiting: 'proposalLee', on: 'new:review proposal' }] } },
  { id: 'r2-4', group: 'dependency', note: "After Priya reviews the budget, I'll send Dana the contract.",
    expect: { created: [n('Review the budget', 'Priya', 'Me')], deps: [{ waiting: 'contract', on: 'new:review budget' }] } },
  { id: 'r2-5', group: 'dependency', note: 'Omar can only book the venue once I send him the deposit.',
    expect: { created: [n('Send the deposit', 'Me', 'Omar')], deps: [{ waiting: 'venue', on: 'new:deposit' }] } },
  { id: 'r2-6', group: 'dependency', note: "Once the contract is out, I'll send Dana the proposal.",
    expect: { deps: [{ waiting: 'proposal', on: 'contract' }] } },
  { id: 'r2-7', group: 'dependency', note: "I'll send Dana the proposal tomorrow, before lunch.",
    expect: { changes: [c('proposal', 'deadline', '2026-11-26')] } },
  { id: 'r2-8', group: 'dependency', note: 'The budget review is blocked until Priya sends the numbers.',
    expect: { created: [n('Send the numbers', 'Priya', 'Me')], deps: [{ waiting: 'budget', on: 'new:numbers' }] } },
  { id: 'r2-9', group: 'dependency', note: "I can't book flights until Omar books the venue.",
    expect: { created: [n('Book flights', 'Me')], deps: [{ waiting: 'new:flights', on: 'venue' }] } },
  { id: 'r2-10', group: 'dependency', note: 'Sam will send me the mockups once Priya signs off the copy.',
    expect: { created: [n('Send the mockups', 'Sam', 'Me'), n('Sign off the copy', 'Priya', 'Sam')], deps: [{ waiting: 'new:mockups', on: 'new:sign off copy' }] } },
  { id: 'r2-11', group: 'dependency', note: "Dana can't sign the contract until Lee confirms pricing.",
    expect: { created: [n('Sign the contract', 'Dana', null)], deps: [{ waiting: 'new:sign contract', on: 'pricing' }] } },
  { id: 'r2-12', group: 'dependency', note: "The proposal for Lee waits until Omar has booked the venue.",
    expect: { deps: [{ waiting: 'proposalLee', on: 'venue' }] } },
];

// Round 3: written on 2026-11-15 after round 2, before the fixes made because
// of it were run, and before any model saw them. They measure those fixes.
export const round3 = [
  { id: 'r3-1', group: 'dependency', note: "Dana can't approve the proposal until Lee confirms pricing.",
    expect: { created: [n('Approve the proposal', 'Dana', null)], deps: [{ waiting: 'new:approve proposal', on: 'pricing' }] } },
  { id: 'r3-2', group: 'dependency', note: "I'll send Priya the budget review by Friday, once Lee confirms pricing.",
    expect: { changes: [c('budget', 'deadline', '2026-11-27')], deps: [{ waiting: 'budget', on: 'pricing' }] } },
  { id: 'r3-3', group: 'dependency', note: "After Omar books the venue, I'll send Dana the contract on Monday.",
    expect: { changes: [c('contract', 'deadline', '2026-11-30')], deps: [{ waiting: 'contract', on: 'venue' }] } },
  { id: 'r3-4', group: 'dependency', note: 'Lee will confirm pricing once I send him the volumes.',
    expect: { created: [n('Send the volumes', 'Me', 'Lee')], deps: [{ waiting: 'pricing', on: 'new:volumes' }] } },
  { id: 'r3-5', group: 'dependency', note: "I'll send the proposal to Lee when Dana has seen it.",
    expect: { created: [n('See the proposal', 'Dana', 'Me')], deps: [{ waiting: 'proposalLee', on: 'new:see proposal' }] } },
  { id: 'r3-6', group: 'dependency', note: "Sam can't start the design until Priya sends the brief.",
    expect: { created: [n('Start the design', 'Sam', null), n('Send the brief', 'Priya', 'Sam')], deps: [{ waiting: 'new:design', on: 'new:brief' }] } },
  { id: 'r3-7', group: 'dependency', note: "The contract waits for Lee's pricing.",
    expect: { deps: [{ waiting: 'contract', on: 'pricing' }] } },
  { id: 'r3-8', group: 'dependency', note: 'Dana will get the proposal tomorrow after lunch.',
    expect: { changes: [c('proposal', 'deadline', '2026-11-26')] } },
  { id: 'r3-9', group: 'dependency', note: 'Priya says the budget review can wait until next month.',
    expect: { changes: [c('budget', 'deadline', 'words')] } },
  { id: 'r3-10', group: 'dependency', note: 'Omar will book the venue as soon as Dana confirms the date, by Friday at the latest.',
    expect: { changes: [c('venue', 'deadline', '2026-11-27')], created: [n('Confirm the date', 'Dana', 'Omar')], deps: [{ waiting: 'venue', on: 'new:confirm date' }] } },
];

export const sets = { round1: cases, round2, round3 };

// --- What came out of one note ---

// Everything the note produced, by the workspace's keys and names.
//   result: pipeline.readNote's result; ids, people from seedWorkspace
export async function observe(q, result, { ids, people }) {
  const keyOf = new Map(Object.entries(ids).map(([key, id]) => [id, key]));
  const nameOf = new Map(Object.entries(people).map(([name, id]) => [id, name]));
  const noteId = result.out.session.noteId;
  const rows = await q(
    `MATCH (ch:Change {state: 'proposed'})-[:FROM]->(:Note {id: $noteId})
     MATCH (ch)-[:ON]->(c:Commitment)
     OPTIONAL MATCH (ch)-[:NAMES]->(b:Commitment)
     RETURN ch.kind AS kind, c.id AS id, c.what AS what, toString(ch.due) AS due, ch.dueText AS dueText, b.id AS blockerId, b.what AS blockerWhat`,
    { noteId },
  );
  const side = (id, what) => keyOf.get(id) ?? `new:${what}`;
  const changes = rows.filter((r) => ['deadline', 'completed', 'cancelled'].includes(r.kind))
    .map((r) => ({ on: side(r.id, r.what), kind: r.kind, due: r.kind === 'deadline' ? (r.due ?? 'words') : undefined, dueText: r.dueText ?? undefined }));
  const deps = rows.filter((r) => r.kind === 'blocked').map((r) => ({ waiting: side(r.id, r.what), on: side(r.blockerId, r.blockerWhat) }));
  const refWhat = new Map(result.pending.filter((p) => p.type === 'new' && p.ref).map((p) => [p.ref, p.what]));
  for (const p of result.pending.filter((x) => x.type === 'dependency')) {
    const name = (s) => (s.ref ? `new:${refWhat.get(s.ref) ?? s.what}` : keyOf.get(s.commitmentId) ?? `new:${s.what}`);
    deps.push({ waiting: name(p.waiting), on: name(p.waitsFor) });
  }
  const card = (p, how) => ({ what: p.what, owner: nameOf.get(p.ownerId) ?? null, to: nameOf.get(p.toId) ?? null, due: p.due ?? null, how });
  const created = [
    ...result.pending.filter((p) => p.type === 'new').map((p) => card(p, 'card')),
    // A refused entry whose reading is one click away still counts as found.
    ...result.pending.filter((p) => p.type === 'manual' && p.saidNew).map((p) => card(p.saidNew, 'refused, one click')),
  ];
  const questions = result.pending.filter((p) => p.type === 'question').map((p) => ({
    options: p.options.filter((o) => o.type === 'commitment').map((o) => ({ on: keyOf.get(o.commitmentId), kind: { 'new deadline': 'deadline', done: 'completed', cancelled: 'cancelled' }[o.change], due: o.change === 'new deadline' ? (capture.resolveDate(o.due, NOTE_TIME.baseDate) ?? 'words') : undefined })),
    offersAll: p.options.some((o) => o.type === 'all'),
    offersNew: p.options.some((o) => o.type === 'new'),
  }));
  const manual = result.pending.filter((p) => p.type === 'manual' && !p.saidNew).map((p) => p.reason);
  return { changes, created, deps, questions, manual, depsError: result.deps?.error ?? null };
}

// --- Scoring ---

const SMALL = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'on', 'my', 'out', 'off']);
const words = (text) => norm(text).split(' ').filter((w) => w && !SMALL.has(w));
// True when most of the expected words are there: wording varies, meaning should not.
export function sameThing(expected, got) {
  const want = words(expected);
  const have = new Set(words(got));
  return want.length > 0 && want.filter((w) => have.has(w) || have.has(w.replace(/s$/, '')) || have.has(`${w}s`)).length / want.length >= 0.5;
}
const sameSide = (want, got) => (want.startsWith('new:') ? got.startsWith('new:') && sameThing(want.slice(4), got.slice(4)) : want === got);

// The verdict for one note:
//   pass    exactly what the note means: every change on the right commitment with the
//           right date, every new commitment found with its card filled in right, every
//           dependency, the question an ambiguous note needs, and nothing else
//   safe    nothing wrong is proposed; something may be missed or asked about, and a card
//           may need correcting, but accepting what is proposed would not be a mistake
//   unsafe  a proposal that is wrong: wrong commitment, wrong kind, wrong date, a guess where
//           the note is ambiguous, or a dependency the note does not state
// Cards are not proposals: a card filled in wrong is counted (cardErrors), and the user
// corrects it before anything is proposed.
export function score(obs, expect) {
  const r = { wrong: [], missed: [], guessed: [], cardErrors: [], extraCreated: [], missedCreated: [], wrongDeps: [], missedDeps: [], needlessQuestions: 0, asked: false };
  const wantChanges = [...(expect.changes ?? [])];
  const amb = expect.ambiguous;
  const dueMatches = (want, got) => !want.due || want.due === got.due;

  for (const got of obs.changes) {
    const at = wantChanges.findIndex((w) => w.on === got.on && w.kind === got.kind && dueMatches(w, got));
    if (at >= 0) wantChanges.splice(at, 1);
    else if (amb && amb.among.includes(got.on)) r.guessed.push(`${got.on}: ${got.kind}`);
    else r.wrong.push(`${got.on}: ${got.kind}${got.due ? ` ${got.due}` : ''}`);
  }
  // A change not proposed but offered, complete, in a question is not missed.
  const complete = (w, o) => o.on === w.on && o.kind === w.kind && dueMatches(w, o);
  for (const w of wantChanges) {
    const offered = obs.questions.some((qn) => qn.options.some((o) => complete(w, o)));
    if (!offered) r.missed.push(`${w.on}: ${w.kind}`);
  }
  for (const qn of obs.questions) {
    if (amb && amb.among.every((key) => qn.options.some((o) => complete({ on: key, kind: amb.kind, due: amb.due }, o)))) r.asked = true;
  }
  r.needlessQuestions = Math.max(0, obs.questions.length - (amb && r.asked ? 1 : 0));
  if (amb && !r.asked && !r.guessed.length) r.missed.push('the ambiguous change was neither asked about nor guessed');

  const wantCreated = [...(expect.created ?? [])];
  for (const got of obs.created) {
    const at = wantCreated.findIndex((w) => sameThing(w.what, got.what));
    if (at < 0) { r.extraCreated.push(got.what); continue; }
    const w = wantCreated.splice(at, 1)[0];
    for (const field of ['owner', 'to', 'due']) {
      if ((w[field] ?? null) !== (got[field] ?? null)) r.cardErrors.push(`${w.what}: ${field} ${got[field] ?? 'none'}, expected ${w[field] ?? 'none'}`);
    }
  }
  r.missedCreated = wantCreated.map((w) => w.what);

  const wantDeps = [...(expect.deps ?? [])];
  for (const got of obs.deps) {
    const at = wantDeps.findIndex((w) => sameSide(w.waiting, got.waiting) && sameSide(w.on, got.on));
    if (at >= 0) wantDeps.splice(at, 1);
    else r.wrongDeps.push(`${got.waiting} waits for ${got.on}`);
  }
  r.missedDeps = wantDeps.map((w) => `${w.waiting} waits for ${w.on}`);

  const unsafe = r.wrong.length + r.guessed.length + r.wrongDeps.length > 0;
  const exact = !unsafe && !r.missed.length && !r.missedCreated.length && !r.extraCreated.length && !r.cardErrors.length
    && !r.missedDeps.length && !r.needlessQuestions && !obs.manual.length && (!amb || r.asked);
  r.verdict = exact ? 'pass' : unsafe ? 'unsafe' : 'safe';
  return r;
}

export function summarise(rows) {
  const count = (test) => rows.filter(test).length;
  const byGroup = {};
  for (const row of rows) {
    const g = (byGroup[row.group] ??= { notes: 0, pass: 0, safe: 0, unsafe: 0, error: 0 });
    g.notes += 1;
    g[row.error ? 'error' : row.score.verdict] += 1;
  }
  const scored = rows.filter((r) => !r.error);
  return {
    notes: rows.length,
    errors: count((r) => r.error),
    pass: count((r) => r.score?.verdict === 'pass'),
    safe: count((r) => r.score?.verdict === 'safe'),
    unsafe: count((r) => r.score?.verdict === 'unsafe'),
    wrongChange: count((r) => r.score?.wrong.length),
    guessed: count((r) => r.score?.guessed.length),
    missedChange: count((r) => r.score?.missed.length),
    missedNew: count((r) => r.score?.missedCreated.length),
    extraNew: count((r) => r.score?.extraCreated.length),
    cardErrors: scored.reduce((sum, r) => sum + r.score.cardErrors.length, 0),
    wrongDependency: count((r) => r.score?.wrongDeps.length),
    missedDependency: count((r) => r.score?.missedDeps.length),
    needlessQuestions: count((r) => r.score?.needlessQuestions),
    linkedByHand: count((r) => r.observed?.manual.length),
    byGroup,
  };
}
