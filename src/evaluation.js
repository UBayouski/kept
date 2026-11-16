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

// Round 4: every kind of note, written on 2026-11-15 after the device-model run
// of round 2 and the fixes made because of it (rules 4 and 5, no waiting on a
// copy of itself), before any model saw them. A clean measure of both routes.
export const round4 = [
  { id: 'r4-1', group: 'deadline', note: 'Lee asked for the proposal by Monday.', expect: { changes: [c('proposalLee', 'deadline', '2026-11-30')] } },
  { id: 'r4-2', group: 'status', note: 'Omar got the venue booked this morning.', expect: { changes: [c('venue', 'completed')] } },
  { id: 'r4-3', group: 'new', note: "I'll send Omar the floor plan on Tuesday.", expect: { created: [n('Send the floor plan', 'Me', 'Omar', '2026-12-01')] } },
  { id: 'r4-4', group: 'nothing', note: "Dana mentioned she's travelling next week.", expect: {} },
  { id: 'r4-5', group: 'nothing', note: 'Remember that the contract for Dana is the priority.', expect: {} },
  { id: 'r4-6', group: 'dependency', note: "Dana's proposal has to wait until Lee confirms pricing.", expect: { deps: [{ waiting: 'proposal', on: 'pricing' }] } },
  { id: 'r4-7', group: 'dependency', note: 'I can only order the badges once Omar books the venue.',
    expect: { created: [n('Order the badges', 'Me')], deps: [{ waiting: 'new:badges', on: 'venue' }] } },
  { id: 'r4-8', group: 'dependency', note: "I can't finish Priya's budget review until Sam sends me the headcount.",
    expect: { created: [n('Send the headcount', 'Sam', 'Me')], deps: [{ waiting: 'budget', on: 'new:headcount' }] } },
  { id: 'r4-9', group: 'several', note: 'Sent Lee the proposal, and Dana gets hers on Thursday.',
    expect: { changes: [c('proposalLee', 'completed'), c('proposal', 'deadline', '2026-11-26')] } },
  { id: 'r4-10', group: 'status', note: 'Lee finally confirmed pricing.', expect: { changes: [c('pricing', 'completed')] } },
  { id: 'r4-11', group: 'dependency', note: "Once Lee confirms pricing, I'll send Dana the invoice by Tuesday.",
    expect: { created: [n('Send the invoice', 'Me', 'Dana', '2026-12-01')], deps: [{ waiting: 'new:invoice', on: 'pricing' }] } },
  { id: 'r4-12', group: 'status', note: "Omar doesn't need to book the venue anymore; we're going remote.", expect: { changes: [c('venue', 'cancelled')] } },
];

// Round 5: every kind of note, weighted to new commitments with and without a
// date, written on 2026-11-15 after the device-route fixes of 2e268ae (a change
// beside a new commitment said twice is dropped; "not set" is no date; a
// runaway answer is stopped at 45 s), before any model saw them.
export const round5 = [
  { id: 'r5-1', group: 'new', note: "I'll call Sam about the launch on Thursday.", expect: { created: [n('Call Sam about the launch', 'Me', 'Sam', '2026-11-26')] } },
  { id: 'r5-2', group: 'new', note: 'I promised Priya the slides.', expect: { created: [n('Send the slides', 'Me', 'Priya')] } },
  { id: 'r5-3', group: 'new', note: 'Omar will send me the catering quote by Friday.', expect: { created: [n('Send the catering quote', 'Omar', 'Me', '2026-11-27')] } },
  { id: 'r5-4', group: 'new', note: "I'll get Dana the signed NDA by Tuesday.", expect: { created: [n('Send the signed NDA', 'Me', 'Dana', '2026-12-01')] } },
  { id: 'r5-5', group: 'deadline', note: 'Priya wants the budget review by Monday now.', expect: { changes: [c('budget', 'deadline', '2026-11-30')] } },
  { id: 'r5-6', group: 'status', note: 'Dana has the contract; I sent it this morning.', expect: { changes: [c('contract', 'completed')] } },
  { id: 'r5-7', group: 'status', note: "Lee won't need the proposal after all.", expect: { changes: [c('proposalLee', 'cancelled')] } },
  { id: 'r5-8', group: 'nothing', note: 'Coffee with Sam; he just got back from holiday.', expect: {} },
  { id: 'r5-9', group: 'nothing', note: 'Omar thinks the venue is too small.', expect: {} },
  { id: 'r5-10', group: 'ambiguous', note: 'Dana wants it on Thursday instead.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'deadline', due: '2026-11-26' } } },
  { id: 'r5-11', group: 'several', note: "Lee confirmed pricing, so I'll send Sam the quote tomorrow.",
    expect: { changes: [c('pricing', 'completed')], created: [n('Send the quote', 'Me', 'Sam', '2026-11-26')] } },
  { id: 'r5-12', group: 'dependency', note: "I'll send Omar the guest list after Dana signs the contract.",
    expect: { created: [n('Send the guest list', 'Me', 'Omar'), n('Sign the contract', 'Dana', null)], deps: [{ waiting: 'new:guest list', on: 'new:sign contract' }] } },
];

// Round 6: every kind of note, weighted to done, cancelled and nothing to do,
// written on 2026-11-16 after the "done"/"cancelled" word rules (d4b1523,
// c23dcf8), before any model saw them. Run three times: one run of the device
// model varies too much to measure a small change.
export const round6 = [
  { id: 'r6-1', group: 'status', note: 'Priya has my budget comments now; I emailed them an hour ago.', expect: { changes: [c('budget', 'completed')] } },
  { id: 'r6-2', group: 'status', note: 'Omar sorted out the venue yesterday.', expect: { changes: [c('venue', 'completed')] } },
  { id: 'r6-3', group: 'status', note: 'The contract for Dana is off; she went with another supplier.', expect: { changes: [c('contract', 'cancelled')] } },
  { id: 'r6-4', group: 'status', note: 'Lee says pricing is not needed any more.', expect: { changes: [c('pricing', 'cancelled')] } },
  { id: 'r6-5', group: 'nothing', note: 'Dana liked the venue photos.', expect: {} },
  { id: 'r6-6', group: 'nothing', note: "Lee is worried the pricing will be high.", expect: {} },
  { id: 'r6-7', group: 'nothing', note: 'Priya asked how the budget review is going.', expect: {} },
  { id: 'r6-8', group: 'new', note: "I'll send Lee the case study by Monday.", expect: { created: [n('Send the case study', 'Me', 'Lee', '2026-11-30')] } },
  { id: 'r6-9', group: 'new', note: 'Sam promised me the logo files.', expect: { created: [n('Send the logo files', 'Sam', 'Me')] } },
  { id: 'r6-10', group: 'deadline', note: 'Omar now needs to book the venue by Friday.', expect: { changes: [c('venue', 'deadline', '2026-11-27')] } },
  { id: 'r6-11', group: 'ambiguous', note: 'Sent Dana the file this morning.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'completed' } } },
  { id: 'r6-12', group: 'several', note: 'Omar booked the venue, and Priya moved the budget review to Monday.',
    expect: { changes: [c('venue', 'completed'), c('budget', 'deadline', '2026-11-30')] } },
];

// Round 7: every kind of note, written on 2026-11-16 after the rules of
// 15ab92c to the cleanup of the "what" (empty deadlines dropped, rule 2 with
// one named commitment, a guess asking among the same person, "it" looking
// back, whole-sentence done/cancelled words), before any model saw them.
export const round7 = [
  { id: 'r7-1', group: 'status', note: 'Lee sent over the final pricing.', expect: { changes: [c('pricing', 'completed')] } },
  { id: 'r7-2', group: 'status', note: 'Priya has the budget review; I finished it last night.', expect: { changes: [c('budget', 'completed')] } },
  { id: 'r7-3', group: 'status', note: 'Omar called off the venue booking.', expect: { changes: [c('venue', 'cancelled')] } },
  { id: 'r7-4', group: 'deadline', note: 'Dana now wants the contract by Tuesday.', expect: { changes: [c('contract', 'deadline', '2026-12-01')] } },
  { id: 'r7-5', group: 'deadline', note: 'Lee would like the proposal by Friday.', expect: { changes: [c('proposalLee', 'deadline', '2026-11-27')] } },
  { id: 'r7-6', group: 'nothing', note: 'Omar loved the catering at the last event.', expect: {} },
  { id: 'r7-7', group: 'nothing', note: 'Dana mentioned the contract template looks dated.', expect: {} },
  { id: 'r7-8', group: 'nothing', note: 'Sam and I talked about holidays.', expect: {} },
  { id: 'r7-9', group: 'new', note: "I'll send Omar the menu options by Thursday.", expect: { created: [n('Send the menu options', 'Me', 'Omar', '2026-11-26')] } },
  { id: 'r7-10', group: 'new', note: 'Priya will introduce me to her new hire.', expect: { created: [n('Introduce me to her new hire', 'Priya', 'Me')] } },
  { id: 'r7-11', group: 'ambiguous', note: 'Dana got it yesterday.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'completed' } } },
  { id: 'r7-12', group: 'several', note: "I sent Lee the proposal and I'll call Sam on Friday.",
    expect: { changes: [c('proposalLee', 'completed')], created: [n('Call Sam', 'Me', 'Sam', '2026-11-27')] } },
];

// Round 8: every kind of note, written on 2026-11-16 after b90c010 (the person
// named decides between two of the same wording; "looks dated" is not done),
// before any model saw them.
export const round8 = [
  { id: 'r8-1', group: 'deadline', note: 'Dana would like her proposal on Monday.', expect: { changes: [c('proposal', 'deadline', '2026-11-30')] } },
  { id: 'r8-2', group: 'nothing', note: 'Omar says the venue seems overpriced.', expect: {} },
  { id: 'r8-3', group: 'nothing', note: 'Priya sounded stressed about the budget.', expect: {} },
  { id: 'r8-4', group: 'status', note: 'Omar finally booked the venue for the offsite.', expect: { changes: [c('venue', 'completed')] } },
  { id: 'r8-5', group: 'status', note: 'Lee had questions about the proposal; I answered them and sent it.', expect: { changes: [c('proposalLee', 'completed')] } },
  { id: 'r8-6', group: 'status', note: 'Priya dropped the budget review.', expect: { changes: [c('budget', 'cancelled')] } },
  { id: 'r8-7', group: 'new', note: "I'll send Priya the agenda on Monday.", expect: { created: [n('Send the agenda', 'Me', 'Priya', '2026-11-30')] } },
  { id: 'r8-8', group: 'new', note: 'Lee will share the contract draft with me tomorrow.', expect: { created: [n('Share the contract draft', 'Lee', 'Me', '2026-11-26')] } },
  { id: 'r8-9', group: 'ambiguous', note: 'Dana pushed it back to Monday.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'deadline', due: '2026-11-30' } } },
  { id: 'r8-10', group: 'nothing', note: "Sam's daughter started school this week.", expect: {} },
  { id: 'r8-11', group: 'several', note: 'Lee confirmed pricing and Dana wants the contract on Thursday.',
    expect: { changes: [c('pricing', 'completed'), c('contract', 'deadline', '2026-11-26')] } },
  { id: 'r8-12', group: 'dependency', note: "I'll send Dana the contract after Omar books the venue.", expect: { deps: [{ waiting: 'contract', on: 'venue' }] } },
];

// Round 9: every kind of note, a third of them dependencies, written on
// 2026-11-16 after d335cea and the dependency fixes (80bf35c, d3ab111), before
// any model saw them.
export const round9 = [
  { id: 'r9-1', group: 'deadline', note: 'Priya needs the budget review by Thursday.', expect: { changes: [c('budget', 'deadline', '2026-11-26')] } },
  { id: 'r9-2', group: 'status', note: 'Omar scrapped the venue booking.', expect: { changes: [c('venue', 'cancelled')] } },
  { id: 'r9-3', group: 'status', note: 'Lee wrapped up the pricing yesterday.', expect: { changes: [c('pricing', 'completed')] } },
  { id: 'r9-4', group: 'new', note: 'Sam will send me the budget template on Friday.', expect: { created: [n('Send the budget template', 'Sam', 'Me', '2026-11-27')] } },
  { id: 'r9-5', group: 'deadline', note: 'Lee wants his proposal by Thursday.', expect: { changes: [c('proposalLee', 'deadline', '2026-11-26')] } },
  { id: 'r9-6', group: 'nothing', note: 'Dana seems happy with the proposal so far.', expect: {} },
  { id: 'r9-7', group: 'nothing', note: 'Omar asked whether the venue has parking.', expect: {} },
  { id: 'r9-8', group: 'dependency', note: "I can't send Dana the proposal until Lee confirms pricing.", expect: { deps: [{ waiting: 'proposal', on: 'pricing' }] } },
  { id: 'r9-9', group: 'dependency', note: "Priya's budget review has to wait until Omar books the venue.", expect: { deps: [{ waiting: 'budget', on: 'venue' }] } },
  { id: 'r9-10', group: 'dependency', note: "I'll send Lee the proposal once Sam checks the figures.",
    expect: { created: [n('Check the figures', 'Sam', 'Me')], deps: [{ waiting: 'proposalLee', on: 'new:check figures' }] } },
  { id: 'r9-11', group: 'ambiguous', note: 'Sent it to Dana an hour ago.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'completed' } } },
  { id: 'r9-12', group: 'new', note: "I'll book the caterer for the offsite by Monday.", expect: { created: [n('Book the caterer', 'Me', null, '2026-11-30')] } },
];

// Round 10: every kind of note, weighted to people on no listed commitment
// and to possessives, written on 2026-11-16 after 8dd2ae8 (every known person
// counts for the person rule; "Priya's ..." is not who does what waits),
// before any model saw them.
export const round10 = [
  { id: 'r10-1', group: 'new', note: 'Sam will email me the venue options on Monday.', expect: { created: [n('Email the venue options', 'Sam', 'Me', '2026-11-30')] } },
  { id: 'r10-2', group: 'new', note: 'Sam will send me the pricing sheet tomorrow.', expect: { created: [n('Send the pricing sheet', 'Sam', 'Me', '2026-11-26')] } },
  { id: 'r10-3', group: 'dependency', note: "Dana's contract has to wait until Lee confirms pricing.", expect: { deps: [{ waiting: 'contract', on: 'pricing' }] } },
  { id: 'r10-4', group: 'dependency', note: "Omar's venue booking waits until I send the deposit.",
    expect: { created: [n('Send the deposit', 'Me', 'Omar')], deps: [{ waiting: 'venue', on: 'new:deposit' }] } },
  { id: 'r10-5', group: 'deadline', note: 'Priya moved the budget review to Tuesday.', expect: { changes: [c('budget', 'deadline', '2026-12-01')] } },
  { id: 'r10-6', group: 'status', note: 'Sent Lee his proposal this morning.', expect: { changes: [c('proposalLee', 'completed')] } },
  { id: 'r10-7', group: 'status', note: "Dana doesn't need the proposal anymore.", expect: { changes: [c('proposal', 'cancelled')] } },
  { id: 'r10-8', group: 'nothing', note: 'Lee looked tired on the call.', expect: {} },
  { id: 'r10-9', group: 'nothing', note: 'Sam asked about the offsite agenda.', expect: {} },
  { id: 'r10-10', group: 'ambiguous', note: 'Dana asked for it by Monday instead.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'deadline', due: '2026-11-30' } } },
  { id: 'r10-11', group: 'several', note: 'Omar booked the venue; Sam will send me the photos on Friday.',
    expect: { changes: [c('venue', 'completed')], created: [n('Send the photos', 'Sam', 'Me', '2026-11-27')] } },
  { id: 'r10-12', group: 'dependency', note: "I'll review Priya's budget once Lee confirms pricing.", expect: { deps: [{ waiting: 'budget', on: 'pricing' }] } },
];

// Round 11: every kind of note, weighted to someone else's new commitment and
// to dependencies with a person's name in them, written on 2026-11-16 after
// d19c279, before any model saw them.
export const round11 = [
  { id: 'r11-1', group: 'new', note: 'Sam will send me the budget numbers by Monday.', expect: { created: [n('Send the budget numbers', 'Sam', 'Me', '2026-11-30')] } },
  { id: 'r11-2', group: 'new', note: 'Sam will call me about the venue tomorrow.', expect: { created: [n('Call about the venue', 'Sam', 'Me', '2026-11-26')] } },
  { id: 'r11-3', group: 'dependency', note: "I'll send Dana's contract once Lee confirms pricing.", expect: { deps: [{ waiting: 'contract', on: 'pricing' }] } },
  { id: 'r11-4', group: 'dependency', note: "I'll send Lee's proposal after Omar books the venue.", expect: { deps: [{ waiting: 'proposalLee', on: 'venue' }] } },
  { id: 'r11-5', group: 'deadline', note: 'Dana needs the contract by Thursday.', expect: { changes: [c('contract', 'deadline', '2026-11-26')] } },
  { id: 'r11-6', group: 'status', note: 'Priya got my budget review this morning.', expect: { changes: [c('budget', 'completed')] } },
  { id: 'r11-7', group: 'status', note: 'Lee no longer needs to confirm pricing.', expect: { changes: [c('pricing', 'cancelled')] } },
  { id: 'r11-8', group: 'nothing', note: 'Omar sounded relaxed about the venue.', expect: {} },
  { id: 'r11-9', group: 'nothing', note: 'Sam mentioned the offsite might move.', expect: {} },
  { id: 'r11-10', group: 'ambiguous', note: 'Dana said it can wait until Tuesday.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'deadline', due: '2026-12-01' } } },
  { id: 'r11-11', group: 'several', note: 'Sent Priya the budget review, and Sam will send me the slides on Friday.',
    expect: { changes: [c('budget', 'completed')], created: [n('Send the slides', 'Sam', 'Me', '2026-11-27')] } },
  { id: 'r11-12', group: 'new', note: "I'll email Omar the guest list on Thursday.", expect: { created: [n('Email the guest list', 'Me', 'Omar', '2026-11-26')] } },
];

// Round 12: every kind of note, weighted to cancelled notes and dependencies on
// listed commitments, written on 2026-11-16 after c9f6f4c and 04e02f8, before
// any model saw them.
export const round12 = [
  { id: 'r12-1', group: 'status', note: 'Omar no longer has to book the venue.', expect: { changes: [c('venue', 'cancelled')] } },
  { id: 'r12-2', group: 'status', note: 'Dana dropped the contract; she found another supplier.', expect: { changes: [c('contract', 'cancelled')] } },
  { id: 'r12-3', group: 'status', note: 'Priya called off the budget review for this quarter.', expect: { changes: [c('budget', 'cancelled')] } },
  { id: 'r12-4', group: 'dependency', note: "I'll review the budget for Priya once Omar books the venue.", expect: { deps: [{ waiting: 'budget', on: 'venue' }] } },
  { id: 'r12-5', group: 'dependency', note: "I'll send Dana her proposal once Lee confirms pricing.", expect: { deps: [{ waiting: 'proposal', on: 'pricing' }] } },
  { id: 'r12-6', group: 'deadline', note: 'Lee needs his proposal by Monday.', expect: { changes: [c('proposalLee', 'deadline', '2026-11-30')] } },
  { id: 'r12-7', group: 'status', note: 'Omar booked the venue this afternoon.', expect: { changes: [c('venue', 'completed')] } },
  { id: 'r12-8', group: 'nothing', note: 'Priya seemed busy today.', expect: {} },
  { id: 'r12-9', group: 'nothing', note: 'Lee asked how the contract is going.', expect: {} },
  { id: 'r12-10', group: 'new', note: 'Sam will send me the floor plan on Thursday.', expect: { created: [n('Send the floor plan', 'Sam', 'Me', '2026-11-26')] } },
  { id: 'r12-11', group: 'ambiguous', note: 'Dana has it now; I sent it at noon.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'completed' } } },
  { id: 'r12-12', group: 'new', note: "I'll call Priya about the budget tomorrow.", expect: { created: [n('Call Priya about the budget', 'Me', 'Priya', '2026-11-26')] } },
];

// Round 13: every kind of note, weighted to listed commitments named only as
// what something is about, written on 2026-11-16 after 659c252, before any
// model saw them.
export const round13 = [
  { id: 'r13-1', group: 'new', note: "I'll email Lee about the proposal on Friday.", expect: { created: [n('Email Lee about the proposal', 'Me', 'Lee', '2026-11-27')] } },
  { id: 'r13-2', group: 'new', note: 'Omar will ring me about the venue tomorrow.', expect: { created: [n('Ring me about the venue', 'Omar', 'Me', '2026-11-26')] } },
  { id: 'r13-3', group: 'deadline', note: 'Priya wants the budget review by Friday.', expect: { changes: [c('budget', 'deadline', '2026-11-27')] } },
  { id: 'r13-4', group: 'status', note: 'Sent Dana the contract after lunch.', expect: { changes: [c('contract', 'completed')] } },
  { id: 'r13-5', group: 'status', note: 'Lee says the proposal is off for now.', expect: { changes: [c('proposalLee', 'cancelled')] } },
  { id: 'r13-6', group: 'nothing', note: 'Had a chat with Omar about the venue.', expect: {} },
  { id: 'r13-7', group: 'nothing', note: 'Dana talked about the contract at lunch.', expect: {} },
  { id: 'r13-8', group: 'dependency', note: 'The contract for Dana waits until Lee confirms pricing.', expect: { deps: [{ waiting: 'contract', on: 'pricing' }] } },
  { id: 'r13-9', group: 'new', note: 'Sam will send me the slides by Tuesday.', expect: { created: [n('Send the slides', 'Sam', 'Me', '2026-12-01')] } },
  { id: 'r13-10', group: 'ambiguous', note: 'Dana asked for it on Tuesday.', expect: { ambiguous: { among: ['proposal', 'contract'], kind: 'deadline', due: '2026-12-01' } } },
  { id: 'r13-11', group: 'several', note: "Omar booked the venue and I'll ask Priya about the budget tomorrow.",
    expect: { changes: [c('venue', 'completed')], created: [n('Ask Priya about the budget', 'Me', 'Priya', '2026-11-26')] } },
  { id: 'r13-12', group: 'status', note: 'Lee finally sent the pricing over.', expect: { changes: [c('pricing', 'completed')] } },
];

export const sets = { round1: cases, round2, round3, round4, round5, round6, round7, round8, round9, round10, round11, round12, round13 };

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
