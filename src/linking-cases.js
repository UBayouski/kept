// Candidate-linking experiment: does the model attach a new note to the right
// existing commitment? Pure data and functions, so the scoring can be tested
// without a browser. See docs/linking-experiment.md.

// The app rules live with the rest of the path from answer to proposal.
import { applyRules, wellFormed } from './reading.js';

export { applyRules };

// Labels are short and fixed per commitment, not positional, so the list can
// be reordered without changing what a label means.
export const candidates = {
  proposal: { label: 'K7', what: 'Send the proposal', owner: 'me', to: 'Dana', due: 'Friday' },
  contract: { label: 'R2', what: 'Send the contract', owner: 'me', to: 'Dana', due: 'Friday' },
  pricing: { label: 'M5', what: 'Confirm pricing', owner: 'Lee', to: 'me', due: '' },
  proposalLee: { label: 'T9', what: 'Send the proposal', owner: 'me', to: 'Lee', due: 'Thursday' },
  // Held-out set: other people, other work.
  budget: { label: 'H3', what: 'Review the budget', owner: 'me', to: 'Priya', due: 'Wednesday' },
  forecast: { label: 'J8', what: 'Review the forecast', owner: 'me', to: 'Priya', due: 'Wednesday' },
  venue: { label: 'Q4', what: 'Book the venue', owner: 'Omar', to: 'me', due: '' },
  budgetOmar: { label: 'W6', what: 'Review the budget', owner: 'me', to: 'Omar', due: 'Monday' },
};

const similar = ['proposal', 'contract', 'pricing'];
const twins = ['proposal', 'contract', 'pricing', 'proposalLee'];
const reviews = ['budget', 'forecast', 'venue'];
const reviewTwins = ['budget', 'forecast', 'venue', 'budgetOmar'];

// expect.updates: every change the note makes to a listed commitment.
// expect.new: how many commitments the note makes that are not in the list.
// expect.ambiguous: a change the note makes to one of several commitments
//   without saying which. The right answer is a question that keeps the change
//   (its kind and date) and offers all of those commitments. Picking one is a
//   guess; saying nothing loses the change.
//
// Two sets. 'dev' is what the prompts and the app rules were written against.
// 'holdout' was written on 2026-11-15 before any model saw it and must not be
// used to tune anything: it is there to show whether the rest generalises.
const devCases = [
  { id: 'deadline-proposal', list: similar, note: 'Dana agreed we can send the proposal Tuesday.',
    expect: { updates: [{ on: 'proposal', change: 'new deadline', due: 'tuesday' }], new: 0 } },
  { id: 'deadline-contract', list: similar, note: 'Dana says the contract can wait until Wednesday.',
    expect: { updates: [{ on: 'contract', change: 'new deadline', due: 'wednesday' }], new: 0 } },
  { id: 'done-contract', list: similar, note: 'Sent Dana the contract this morning.',
    expect: { updates: [{ on: 'contract', change: 'done' }], new: 0 } },
  { id: 'deadline-pricing', list: similar, note: "Lee's pricing is delayed until Monday.",
    expect: { updates: [{ on: 'pricing', change: 'new deadline', due: 'monday' }], new: 0 } },
  { id: 'done-pricing', list: similar, note: 'Lee confirmed the pricing today.',
    expect: { updates: [{ on: 'pricing', change: 'done' }], new: 0 } },
  { id: 'cancel-proposal', list: similar, note: "Dana doesn't need the proposal any more.",
    expect: { updates: [{ on: 'proposal', change: 'cancelled' }], new: 0 } },
  { id: 'two-updates', list: similar, note: 'The proposal goes to Dana on Tuesday and the contract on Thursday.',
    expect: { updates: [{ on: 'proposal', change: 'new deadline', due: 'tuesday' }, { on: 'contract', change: 'new deadline', due: 'thursday' }], new: 0 } },
  { id: 'none-new-similar', list: similar, note: "I'll send Dana the invoice by Friday.",
    expect: { updates: [], new: 1 } },
  { id: 'none-new-different', list: similar, note: "I'll book a room for Thursday's workshop with Dana.",
    expect: { updates: [], new: 1 } },
  { id: 'nothing', list: similar, note: 'Lunch with Dana was nice. The weather was awful.',
    expect: { updates: [], new: 0 } },
  { id: 'ambiguous-it', list: similar, note: 'Dana moved it to Tuesday.',
    expect: { updates: [], new: 0, ambiguous: { among: ['proposal', 'contract'], change: 'new deadline', due: 'tuesday' } } },
  { id: 'ambiguous-both', list: similar, note: 'Dana wants the document on Wednesday now.',
    expect: { updates: [], new: 0, ambiguous: { among: ['proposal', 'contract'], change: 'new deadline', due: 'wednesday' } } },
  { id: 'both-same', list: similar, note: 'The proposal and the contract both move to Tuesday.',
    expect: { updates: [{ on: 'proposal', change: 'new deadline', due: 'tuesday' }, { on: 'contract', change: 'new deadline', due: 'tuesday' }], new: 0 } },
  { id: 'done-and-new-same', list: similar, note: 'I sent Dana the contract this morning; I promised to send Dana another contract Friday.',
    expect: { updates: [{ on: 'contract', change: 'done' }], new: 1 } },
  { id: 'twin-lee', list: twins, note: 'Lee needs the proposal by Monday.',
    expect: { updates: [{ on: 'proposalLee', change: 'new deadline', due: 'monday' }], new: 0 } },
  { id: 'twin-dana', list: twins, note: 'Dana agreed the proposal can come Tuesday.',
    expect: { updates: [{ on: 'proposal', change: 'new deadline', due: 'tuesday' }], new: 0 } },
  { id: 'twin-ambiguous', list: twins, note: 'The proposal is pushed back to next week.',
    expect: { updates: [], new: 0, ambiguous: { among: ['proposal', 'proposalLee'], change: 'new deadline', due: 'next week' } } },
];

const holdoutCases = [
  { id: 'h-deadline-forecast', list: reviews, note: 'Priya is happy to get the forecast review on Friday.',
    expect: { updates: [{ on: 'forecast', change: 'new deadline', due: 'friday' }], new: 0 } },
  { id: 'h-done-budget', list: reviews, note: 'I finished reviewing the budget and sent Priya my comments.',
    expect: { updates: [{ on: 'budget', change: 'done' }], new: 0 } },
  { id: 'h-done-venue', list: reviews, note: 'Omar booked the venue for the 3rd.',
    expect: { updates: [{ on: 'venue', change: 'done' }], new: 0 } },
  { id: 'h-cancel-venue', list: reviews, note: "Omar says the venue booking is off, we're meeting online.",
    expect: { updates: [{ on: 'venue', change: 'cancelled' }], new: 0 } },
  { id: 'h-mixed', list: reviews, note: 'The budget review is done; the forecast one moves to Friday.',
    expect: { updates: [{ on: 'budget', change: 'done' }, { on: 'forecast', change: 'new deadline', due: 'friday' }], new: 0 } },
  { id: 'h-both-same', list: reviews, note: 'Priya moved both reviews to Thursday.',
    expect: { updates: [{ on: 'budget', change: 'new deadline', due: 'thursday' }, { on: 'forecast', change: 'new deadline', due: 'thursday' }], new: 0 } },
  { id: 'h-new', list: reviews, note: "I told Priya I'd draft the agenda by Tuesday.",
    expect: { updates: [], new: 1 } },
  { id: 'h-nothing', list: reviews, note: 'Omar was late again. Priya brought cake.',
    expect: { updates: [], new: 0 } },
  { id: 'h-ambiguous-due', list: reviews, note: 'The review is now due Friday.',
    expect: { updates: [], new: 0, ambiguous: { among: ['budget', 'forecast'], change: 'new deadline', due: 'friday' } } },
  { id: 'h-ambiguous-done', list: reviews, note: 'Sent Priya my review this morning.',
    expect: { updates: [], new: 0, ambiguous: { among: ['budget', 'forecast'], change: 'done' } } },
  { id: 'h-twin-omar', list: reviewTwins, note: 'Omar wants the budget review by Friday.',
    expect: { updates: [{ on: 'budgetOmar', change: 'new deadline', due: 'friday' }], new: 0 } },
  { id: 'h-twin-ambiguous', list: reviewTwins, note: 'The budget review slipped to next month.',
    expect: { updates: [], new: 0, ambiguous: { among: ['budget', 'budgetOmar'], change: 'new deadline', due: 'next month' } } },
];

export const cases = [
  ...devCases.map((c) => ({ ...c, set: 'dev' })),
  ...holdoutCases.map((c) => ({ ...c, set: 'holdout' })),
];

export const orders = ['listed', 'reversed'];

export function candidateList(testCase, order) {
  const names = order === 'reversed' ? [...testCase.list].reverse() : testCase.list;
  return names.map((name) => candidates[name]);
}

const listLines = (list) => list.map((c) =>
  `[${c.label}] ${c.what}. Owner: ${c.owner}. For: ${c.to}. Due: ${c.due || 'not set'}.`).join('\n');
const text = { type: 'string' };

// --- Variant 1: two lists, updates and new commitments ---

function promptV1(note, list) {
  return `You keep a list of commitments up to date. Read the note and decide what it changes.

Existing commitments:
${listLines(list)}

Rules:
- "updates" has one entry for each existing commitment the note changes. "commitment" is its label. "change" is "new deadline", "done" or "cancelled". "due" is the new date in the words of the note, or "" if there is none.
- Choose the commitment by what it is about and who it is for. The order of the list means nothing.
- If the note changes something but it could be more than one commitment in the list, use "unclear" as the commitment. Never guess.
- "newCommitments" has one entry for each thing someone promises in the note that is not in the list. Do not repeat an existing commitment there.
- If the note changes nothing and promises nothing, both lists are empty.
- "quote" is the exact words of the note that say so.

Note:
${note}`;
}

// The labels are an enum in the schema, so the model cannot return an id it was not given.
function schemaV1(list) {
  return {
    type: 'object',
    properties: {
      updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            quote: text,
            commitment: { type: 'string', enum: [...list.map((c) => c.label), 'unclear'] },
            change: { type: 'string', enum: ['new deadline', 'done', 'cancelled'] },
            due: text,
          },
          required: ['quote', 'commitment', 'change', 'due'],
        },
      },
      newCommitments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { quote: text, what: text, owner: text, to: text, due: text },
          required: ['quote', 'what', 'owner', 'to', 'due'],
        },
      },
    },
    required: ['updates', 'newCommitments'],
  };
}

// --- Variant 2: one list, one decision per statement ---
// Each statement is about exactly one thing: one listed commitment, something
// new, or unclear. The shape itself rules out "an update and a new commitment
// from the same words". The examples use a different list, so they cannot leak
// an answer.

function promptV2(note, list) {
  return `You keep a list of commitments up to date. Read the note and list what it says.

Existing commitments:
${listLines(list)}

Add one item for each statement in the note that promises something or changes a commitment:
- "quote": the exact words of the note.
- "about": the label of the one existing commitment the statement changes. "new" if it promises something that is not in the list. "unclear" if it could mean more than one commitment in the list.
- "change": "new deadline", "done" or "cancelled" for an existing commitment. "new commitment" for a new one.
- "due": the date in the words of the note, or "".
- "what": for a new commitment, what is promised, as a short phrase. Otherwise "".

Rules:
- One statement gives one item. Never put the same statement under two commitments: if you cannot tell which one it means, "about" is "unclear".
- A promise about something that is not in the list is "new", even when it involves the same people.
- Choose by what the commitment is about and who it is for. The order of the list means nothing.
- A note that promises nothing and changes nothing gives an empty list.

Examples. They use a different list:
[A1] Fix the login bug. Owner: me. For: Sam. Due: Friday.
[B2] Fix the signup bug. Owner: me. For: Sam. Due: Friday.
[C3] Order the banner. Owner: Priya. For: me. Due: not set.
Note: Sam says the login fix can wait until Thursday.
{"items":[{"quote":"the login fix can wait until Thursday","about":"A1","change":"new deadline","due":"Thursday","what":""}]}
Note: Sam needs the fix by Monday.
{"items":[{"quote":"Sam needs the fix by Monday","about":"unclear","change":"new deadline","due":"Monday","what":""}]}
Note: I'll write the release notes for Sam by Friday.
{"items":[{"quote":"I'll write the release notes for Sam by Friday","about":"new","change":"new commitment","due":"Friday","what":"Write the release notes"}]}
Note: Priya's banner arrived.
{"items":[{"quote":"Priya's banner arrived","about":"C3","change":"done","due":"","what":""}]}
Note: Good chat with Sam about the weekend.
{"items":[]}

Note:
${note}`;
}

function schemaV2(list) {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            quote: text,
            about: { type: 'string', enum: [...list.map((c) => c.label), 'new', 'unclear'] },
            change: { type: 'string', enum: ['new deadline', 'done', 'cancelled', 'new commitment'] },
            due: text,
            what: text,
          },
          required: ['quote', 'about', 'change', 'due', 'what'],
        },
      },
    },
    required: ['items'],
  };
}

// Variant 2's answer in the shape the scorer reads.
function readV2(parsed) {
  if (!parsed || !Array.isArray(parsed.items)) return null;
  const updates = [];
  const newCommitments = [];
  for (const item of parsed.items) {
    if (item.about === 'new') newCommitments.push({ quote: item.quote, what: item.what, owner: '', to: '', due: item.due });
    else updates.push({ quote: item.quote, commitment: item.about, change: item.change, due: item.due });
  }
  return { updates, newCommitments };
}

export const variants = {
  v1: { name: 'v1: two lists', buildPrompt: promptV1, buildSchema: schemaV1, read: (parsed) => parsed },
  v2: { name: 'v2: one decision per statement, with examples', buildPrompt: promptV2, buildSchema: schemaV2, read: readV2 },
};
export const buildPrompt = promptV1;
export const buildSchema = schemaV1;

// Compares what the model returned with what the note means. The verdict is
// about which commitment was selected and what would be done to it, not about
// the JSON being valid.
//   right     - expected updates the model made, on the right commitment
//   wrong     - updates on a commitment the note does not change, or with the wrong kind of change
//   missed    - expected updates neither made nor fully offered in a question
//   guessed   - in an ambiguous case, a commitment picked instead of asking
//   dropped   - in an ambiguous case, the change was neither asked about nor guessed: it is lost
//   badDue    - right commitment, wrong new date
//   newCount  - commitments reported as new, against the expected number
//   unclear   - questions; needless when the note is not ambiguous
//
// A question covers an expected change only when it is complete: it offers that
// commitment, with the right kind of change and the right date. Offering the
// right commitment for the wrong operation is not safe. A question from the
// model itself has no options; the app would offer every listed commitment.
// One question covers several expected changes only if it offers 'all'.
//
// pass: exactly the expected answer. For an ambiguous note that is one
//       complete question offering all the commitments it could mean.
// safe: nothing wrong would be proposed and nothing is lost; at worst the user
//       is asked a question that contains the right answer.
export function score(parsed, testCase) {
  const expect = testCase.expect;
  const result = { right: [], wrong: [], missed: [], guessed: [], badDue: [], dropped: false, unclear: 0, newCount: 0, newExpected: expect.new, pass: false, safe: false };
  if (!wellFormed(parsed)) return { ...result, invalid: true };
  const labelOf = (name) => candidates[name].label;
  const listed = testCase.list.map(labelOf);
  const dueOk = (wantDue, got) => !wantDue || String(got ?? '').toLowerCase().includes(wantDue);
  const ambiguous = expect.ambiguous ? { ...expect.ambiguous, labels: expect.ambiguous.among.map(labelOf) } : null;
  const wanted = new Map(expect.updates.map((u) => [labelOf(u.on), u]));
  const found = new Set();
  const questions = [];

  for (const update of parsed.updates) {
    if (update.commitment === 'unclear') {
      result.unclear += 1;
      questions.push(update);
      continue;
    }
    const want = wanted.get(update.commitment);
    if (want && want.change === update.change && !found.has(update.commitment)) {
      found.add(update.commitment);
      if (dueOk(want.due, update.due)) result.right.push(update.commitment);
      else result.badDue.push(update.commitment);
    } else if (ambiguous && ambiguous.labels.includes(update.commitment)) {
      result.guessed.push(update.commitment);
    } else {
      result.wrong.push(`${update.commitment}: ${update.change}`);
    }
  }

  const covered = new Set();
  let newOffered = 0;
  let asked = false;
  for (const question of questions) {
    const options = question.among ?? listed;
    const complete = (want) => question.change === want.change && dueOk(want.due, question.due);
    const covers = [...wanted].filter(([label, want]) => !found.has(label) && options.includes(label) && complete(want)).map(([label]) => label);
    if (covers.length === 1 || options.includes('all')) for (const label of covers) covered.add(label);
    if (options.includes('new')) newOffered += 1;
    if (ambiguous && complete(ambiguous) && ambiguous.labels.every((label) => options.includes(label))) asked = true;
  }
  for (const label of wanted.keys()) if (!found.has(label) && !covered.has(label)) result.missed.push(label);
  result.newCount = parsed.newCommitments.length;
  // What the answer selected, whatever the verdict: used to compare two runs of a case.
  result.selected = [
    ...parsed.updates.map((u) => `${u.commitment === 'unclear' ? `ask(${(u.among ?? ['any']).join('|')})` : u.commitment}: ${u.change}`),
    ...(result.newCount ? [`new x${result.newCount}`] : []),
  ].sort().join(', ');
  result.dropped = Boolean(ambiguous) && !asked && result.guessed.length === 0;

  const clean = !result.wrong.length && !result.missed.length && !result.guessed.length && !result.badDue.length && !result.dropped;
  const exact = clean && found.size === wanted.size && result.newCount === expect.new;
  result.pass = exact && (ambiguous ? asked && result.unclear === 1 : result.unclear === 0);
  const newCovered = result.newCount === expect.new || (result.newCount < expect.new && newOffered > 0);
  result.safe = clean && newCovered;
  return result;
}

export function summarise(rows, key = 'score') {
  const of = (r) => r[key];
  const count = (test) => rows.filter(test).length;
  const scored = (r) => !r.error && !of(r).invalid;
  const differs = (what) => [...new Set(rows.map((r) => r.id))].filter((id) =>
    new Set(rows.filter((r) => r.id === id && !r.error).map(what)).size > 1);
  return {
    runs: rows.length,
    errors: count((r) => Boolean(r.error)),
    invalidJson: count((r) => !r.error && of(r).invalid),
    passed: count((r) => of(r).pass),
    safeWithQuestion: count((r) => scored(r) && of(r).safe && !of(r).pass),
    unsafe: count((r) => scored(r) && !of(r).safe),
    wrongCommitment: count((r) => of(r).wrong.length > 0),
    guessedWhenAmbiguous: count((r) => of(r).guessed.length > 0),
    droppedWhenAmbiguous: count((r) => scored(r) && of(r).dropped),
    missedUpdate: count((r) => of(r).missed.length > 0),
    wrongDate: count((r) => of(r).badDue.length > 0),
    wrongNewCount: count((r) => scored(r) && of(r).newCount !== of(r).newExpected),
    // Two ways the order of the list can matter. A case can fail in both
    // orders and still select a different commitment in each, so the second
    // is the one that measures order sensitivity.
    verdictChangedWithOrder: differs((r) => of(r).pass),
    selectionChangedWithOrder: differs((r) => of(r).selected ?? (r.error ? 'error' : 'invalid')),
  };
}
